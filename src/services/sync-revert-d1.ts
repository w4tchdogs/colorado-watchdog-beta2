import {
  MAX_SYNC_ITEMS_BY_SIZE,
  MAX_SYNC_RESULT_BYTES,
  type SyncEntity,
} from "../contracts/sync.js";
import type {
  AsyncD1Database,
  D1BatchStatement,
  D1Value,
} from "../database/d1.js";
import type { TrustedPrincipal } from "./security.js";
import type { D1SyncAuthorizer } from "./sync-commit-d1.js";

const MAX_ITEMS = MAX_SYNC_ITEMS_BY_SIZE;
const PAGE_ROWS = 1_000;
const MAX_KEY = 128;
const SAFE_FAILURE =
  "The batch could not be safely reversed; no changes were applied.";
const MUTABLE: Readonly<Record<SyncEntity, readonly string[]>> = {
  organizations: [
    "name",
    "organization_type",
    "county_fips",
    "parent_organization_id",
    "parent_relationship",
  ],
  organization_county_affiliations: [
    "organization_id",
    "county_fips",
    "relationship_type",
  ],
  people: [
    "display_name",
    "first_name",
    "middle_name",
    "last_name",
    "name_prefix",
    "name_suffix",
    "preferred_first_name",
  ],
  positions: ["organization_id", "title"],
  role_sources: ["url", "title", "source_type", "publisher_classification"],
  person_roles: [
    "person_id",
    "position_id",
    "source_id",
    "start_date",
    "end_date",
    "source_checked_at",
    "county_fips",
    "published_office",
    "published_title",
    "job_description",
  ],
  profile_names: [
    "person_id",
    "name_type",
    "first_name",
    "middle_name",
    "last_name",
    "name_prefix",
    "name_suffix",
    "published_name",
    "applies_from",
    "applies_until",
  ],
};

interface Inverse {
  itemIndex: number;
  clientRef: string;
  entity: SyncEntity;
  targetId: string;
  outcome: "created" | "updated" | "reused";
  previousVersion: number | null;
  committedVersion: number;
  changedFields: Record<string, string | number | null>;
  dependencies: string[];
}

export type D1SyncReversalResult =
  | {
      status: "reverted";
      batchId: string;
      reversalId: string;
      reversedAt: string;
      replayed: boolean;
    }
  | {
      status: "already_reverted";
      batchId: string;
      reversedAt: string;
      replayed: false;
    }
  | {
      status: "reversal_blocked";
      batchId: string;
      replayed: false;
      message: string;
    };

/** Internal default-deny D1 counterpart to SQL.js reverseSyncBatch. */
export async function reverseSyncBatchD1(
  db: AsyncD1Database,
  principal: TrustedPrincipal,
  batchId: string,
  idempotencyKey: string,
  options: { authorize?: D1SyncAuthorizer; now?: () => Date } = {},
): Promise<D1SyncReversalResult> {
  const blocked = (): D1SyncReversalResult => ({
    status: "reversal_blocked",
    batchId,
    replayed: false,
    message: SAFE_FAILURE,
  });
  if (
    !options.authorize ||
    !(await options.authorize(principal, "sync.revert"))
  )
    throw new Error(
      "The trusted Website principal cannot reverse synchronization",
    );
  if (
    !validId(batchId) ||
    !validId(idempotencyKey) ||
    idempotencyKey.length > MAX_KEY
  )
    return blocked();
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const fingerprint = await digest(
    JSON.stringify({ domain: "m2-sync-reversal/v1", batchId }),
  );
  const gen = await db.readDependencyGeneration();
  if (!(await active(db, principal, options.authorize, now())))
    throw new Error(
      "The trusted Website principal cannot reverse synchronization",
    );

  const key = await db.first<{
    batch_id: unknown;
    request_fingerprint: unknown;
    result_json: unknown;
  }>(
    "SELECT batch_id, request_fingerprint, result_json FROM sync_batch_reversals WHERE actor_account_id = ? AND idempotency_key = ?",
    [principal.accountId, idempotencyKey],
  );
  if (key) {
    if (key.batch_id !== batchId || key.request_fingerprint !== fingerprint)
      return blocked();
    return replay(key.result_json, batchId);
  }
  const batch = await db.first<{ id: unknown; result_json: unknown }>(
    "SELECT id, result_json FROM sync_batches WHERE id = ? AND actor_account_id = ? AND status = 'committed'",
    [batchId, principal.accountId],
  );
  if (!batch) return blocked();
  const prior = await db.first<{ reversed_at: unknown }>(
    "SELECT reversed_at FROM sync_batch_reversals WHERE batch_id = ?",
    [batchId],
  );
  if (typeof prior?.reversed_at === "string")
    return {
      status: "already_reverted",
      batchId,
      reversedAt: prior.reversed_at,
      replayed: false,
    };
  // D1 reads are bounded per statement, so a batch of any size is read in pages.
  const rows: Record<string, unknown>[] = [];
  for (let after = -1; rows.length <= MAX_ITEMS; ) {
    const page = await db.all<Record<string, unknown>>(
      `SELECT item_index, client_ref, entity, target_id, outcome, previous_version, committed_version, inverse_json
       FROM sync_batch_items WHERE batch_id = ? AND item_index > ? ORDER BY item_index`,
      PAGE_ROWS,
      [batchId, after],
    );
    rows.push(...page);
    const last = page.at(-1);
    if (page.length < PAGE_ROWS || !last) break;
    after = Number(last.item_index);
  }
  try {
    if (!rows.length || rows.length > MAX_ITEMS) return blocked();
    const expectedCount = committedItemCount(batch.result_json);
    if (expectedCount !== rows.length) return blocked();
    const items = rows.map((row) => parseInverse(row));
    if (
      items.some(
        (item, index) =>
          item.itemIndex !== index ||
          (item.outcome === "updated" &&
            Object.keys(item.changedFields).length === 0) ||
          (item.outcome !== "updated" &&
            Object.keys(item.changedFields).length !== 0) ||
          Object.values(item.changedFields).some(
            (value) =>
              value !== null &&
              typeof value !== "string" &&
              typeof value !== "number",
          ),
      )
    )
      return blocked();
    // Set-based checks: a few queries per entity instead of one per item, so
    // the CPU and query cost of a reversal does not grow with batch size.
    const reused = new Map<SyncEntity, Set<string>>();
    for (const item of items)
      if (item.outcome === "reused") {
        const ids = reused.get(item.entity) ?? new Set<string>();
        ids.add(item.targetId);
        reused.set(item.entity, ids);
      }
    for (const [entity, ids] of reused) {
      const found = await db.first<{ n: unknown }>(
        `SELECT COUNT(DISTINCT id) AS n FROM "${entity}" WHERE id IN (
           SELECT target_id FROM sync_batch_items
           WHERE batch_id = ? AND entity = ? AND outcome = 'reused')`,
        [batchId, entity],
      );
      if (found?.n !== ids.size) return blocked();
    }
    const created = new Set(
      items
        .filter((x) => x.outcome === "created")
        .map((x) => `${x.entity}:${x.targetId}`),
    );
    const statements: D1BatchStatement[] = [];
    const checkId = `reverse:${crypto.randomUUID()}`;
    statements.push(
      db.prepare(
        "INSERT INTO website_write_assertions (id, valid) SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM sync_batches WHERE id = ? AND actor_account_id = ? AND status = 'committed') THEN 1 ELSE 0 END",
        [checkId, batchId, principal.accountId],
      ),
    );
    for (const item of items) {
      if (item.outcome === "reused") continue;
      statements.push(
        db.prepare(
          `INSERT INTO website_write_assertions (id, valid) SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM "${item.entity}" WHERE id = ? AND version = ?) THEN 1 ELSE 0 END`,
          [
            `${checkId}:${item.itemIndex}`,
            item.targetId,
            item.committedVersion,
          ],
        ),
      );
    }
    const flagRows = await db.all<{ id: string }>(
      "SELECT id FROM person_duplicate_flags WHERE origin_batch_id = ? AND status = 'open'",
      100,
      [batchId],
    );
    const observations = await db.first<{ found: unknown }>(
      `SELECT 1 AS found FROM person_duplicate_flag_observations o
       JOIN person_duplicate_flags f ON f.id=o.duplicate_flag_id
       LEFT JOIN sync_batch_reversals r ON r.batch_id=o.batch_id
       WHERE f.origin_batch_id=? AND o.batch_id<>? AND r.batch_id IS NULL LIMIT 1`,
      [batchId, batchId],
    );
    const decidedFlags = await db.first<{ found: unknown }>(
      "SELECT 1 AS found FROM person_duplicate_flags WHERE origin_batch_id = ? AND status <> 'open' LIMIT 1",
      [batchId],
    );
    if (observations || decidedFlags) return blocked();
    const createdIds = `SELECT target_id FROM sync_batch_items WHERE batch_id = ? AND outcome = 'created'`;
    if (created.size) {
      const laterFlagRef = await db.first<{ found: unknown }>(
        `SELECT 1 AS found FROM person_duplicate_flag_observations o
         LEFT JOIN sync_batch_reversals r ON r.batch_id = o.batch_id
         WHERE r.batch_id IS NULL AND o.batch_id <> ?
           AND (o.pair_low_id IN (${createdIds})
             OR o.pair_high_id IN (${createdIds})
             OR EXISTS (SELECT 1 FROM json_each(o.evidence_source_ids_json) j
                        WHERE j.value IN (${createdIds})))
         LIMIT 1`,
        [batchId, batchId, batchId, batchId],
      );
      if (laterFlagRef) return blocked();
    }
    const createdEntities = new Set(
      items.filter((x) => x.outcome === "created").map((x) => x.entity),
    );
    for (const entity of createdEntities) {
      for (const [child, column] of dependents[entity] ?? []) {
        // A row outside this batch that references a created row blocks reversal.
        const outside = await db.first<{ found: unknown }>(
          `SELECT 1 AS found FROM "${child}" c
           WHERE c."${column}" IN (
               SELECT target_id FROM sync_batch_items
               WHERE batch_id = ? AND entity = ? AND outcome = 'created')
             AND c.id NOT IN (
               SELECT target_id FROM sync_batch_items
               WHERE batch_id = ? AND entity = ? AND outcome = 'created')
           LIMIT 1`,
          [batchId, entity, batchId, child],
        );
        if (outside) return blocked();
      }
    }
    for (const flag of flagRows)
      statements.push(
        db.prepare(
          "DELETE FROM person_duplicate_flags WHERE id = ? AND status = 'open'",
          [flag.id],
        ),
      );
    for (const item of [...items].reverse()) {
      if (item.outcome === "reused") continue;
      if (item.outcome === "created") {
        // A hidden-at-creation Profile carries a visibility row that would
        // otherwise block deleting the Profile it describes.
        if (item.entity === "people")
          statements.push(
            db.prepare("DELETE FROM person_visibility WHERE person_id = ?", [
              item.targetId,
            ]),
          );
        statements.push(
          db.prepare(
            `DELETE FROM "${item.entity}" WHERE id = ? AND version = ?`,
            [item.targetId, item.committedVersion],
          ),
        );
      } else {
        const fields = Object.keys(item.changedFields);
        if (
          !fields.length ||
          fields.some((field) => !MUTABLE[item.entity].includes(field))
        )
          return blocked();
        const sets = [
          ...fields.map((field) => `"${field}" = ?`),
          "version = version + 1",
          "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        ];
        const values: D1Value[] = fields.map((field) => {
          const value = item.changedFields[field];
          if (
            value !== null &&
            typeof value !== "string" &&
            typeof value !== "number"
          )
            throw new Error("unsafe inverse");
          return value;
        });
        values.push(item.targetId, item.committedVersion);
        statements.push(
          db.prepare(
            `UPDATE "${item.entity}" SET ${sets.join(", ")} WHERE id = ? AND version = ?`,
            values,
          ),
        );
      }
    }
    const reversalId = crypto.randomUUID();
    const result: D1SyncReversalResult = {
      status: "reverted",
      batchId,
      reversalId,
      reversedAt: at,
      replayed: false,
    };
    statements.push(
      db.prepare(
        `INSERT INTO sync_batch_reversals (id, actor_account_id, batch_id, idempotency_key, request_fingerprint, reversed_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          reversalId,
          principal.accountId,
          batchId,
          idempotencyKey,
          fingerprint,
          at,
          JSON.stringify(result),
        ],
      ),
    );
    statements.push(
      db.prepare(
        `INSERT INTO audit_events (id, actor_account_id, operation_id, action, target_type, target_id, summary, details_json)
       VALUES (?, ?, NULL, 'sync.batch.reverse', 'sync_batch', ?, 'Reversed a Website synchronization batch', ?)`,
        [
          crypto.randomUUID(),
          principal.accountId,
          batchId,
          JSON.stringify({
            itemCount: items.length,
            reversalId,
            flagsRemoved: flagRows.length,
          }),
        ],
      ),
    );
    statements.push(db.prepare("DELETE FROM website_write_assertions"));
    await db.guardedBatch(gen, principal, statements);
    return result;
  } catch {
    const winner = await db.first<{
      batch_id: unknown;
      request_fingerprint: unknown;
      result_json: unknown;
    }>(
      "SELECT batch_id, request_fingerprint, result_json FROM sync_batch_reversals WHERE actor_account_id = ? AND idempotency_key = ?",
      [principal.accountId, idempotencyKey],
    );
    if (
      winner?.batch_id === batchId &&
      winner.request_fingerprint === fingerprint
    )
      return replay(winner.result_json, batchId);
    return blocked();
  }
}

const dependents: Partial<Record<SyncEntity, readonly [SyncEntity, string][]>> =
  {
    organizations: [
      ["positions", "organization_id"],
      ["organization_county_affiliations", "organization_id"],
      ["organizations", "parent_organization_id"],
    ],
    people: [
      ["person_roles", "person_id"],
      ["profile_names", "person_id"],
    ],
    positions: [["person_roles", "position_id"]],
    role_sources: [["person_roles", "source_id"]],
  };

function parseInverse(row: Record<string, unknown>): Inverse {
  if (typeof row.inverse_json !== "string" || row.inverse_json.length > 32768)
    throw new Error("unsafe");
  const v = JSON.parse(row.inverse_json) as Record<string, unknown>;
  if (
    !Number.isInteger(v.itemIndex) ||
    v.itemIndex !== row.item_index ||
    !validEntity(v.entity) ||
    v.entity !== row.entity ||
    v.targetId !== row.target_id ||
    v.clientRef !== row.client_ref ||
    v.outcome !== row.outcome ||
    v.committedVersion !== row.committed_version ||
    v.previousVersion !== row.previous_version ||
    !Number.isInteger(v.committedVersion) ||
    (v.committedVersion as number) < 1 ||
    !Array.isArray(v.dependencies) ||
    !v.dependencies.every((x) => typeof x === "string") ||
    !isRecord(v.changedFields) ||
    !["created", "updated", "reused"].includes(String(v.outcome))
  )
    throw new Error("unsafe");
  if (
    v.outcome === "updated" &&
    (!Number.isInteger(v.previousVersion) ||
      (v.previousVersion as number) + 1 !== v.committedVersion)
  )
    throw new Error("unsafe");
  if (v.outcome !== "updated" && Object.keys(v.changedFields).length)
    throw new Error("unsafe");
  return v as unknown as Inverse;
}
function committedItemCount(value: unknown): number | null {
  if (typeof value !== "string" || value.length > MAX_SYNC_RESULT_BYTES)
    return null;
  try {
    const result = JSON.parse(value) as { status?: unknown; items?: unknown };
    return result.status === "committed" &&
      Array.isArray(result.items) &&
      result.items.length >= 1 &&
      result.items.length <= MAX_ITEMS
      ? result.items.length
      : null;
  } catch {
    return null;
  }
}
function validEntity(value: unknown): value is SyncEntity {
  return [
    "organizations",
    "organization_county_affiliations",
    "people",
    "positions",
    "role_sources",
    "person_roles",
    "profile_names",
  ].includes(String(value));
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function active(
  db: AsyncD1Database,
  p: TrustedPrincipal,
  auth: D1SyncAuthorizer,
  at: Date,
): Promise<boolean> {
  if (!(await auth(p, "sync.revert"))) return false;
  const row = await db.first<{ kind: unknown; role: unknown }>(
    `SELECT a.kind, a.role FROM accounts a JOIN identities i ON i.account_id=a.id
     WHERE a.id=? AND i.id=? AND i.provider=? AND a.status='active' AND i.revoked_at IS NULL
       AND (i.expires_at IS NULL OR i.expires_at>?)`,
    [p.accountId, p.identityId, p.provider, at.toISOString()],
  );
  return row?.kind === p.kind && row.role === p.role;
}
function replay(value: unknown, batchId: string): D1SyncReversalResult {
  try {
    if (typeof value !== "string" || value.length > 16384) throw new Error();
    const result = JSON.parse(value) as D1SyncReversalResult;
    if (
      result.status !== "reverted" ||
      result.batchId !== batchId ||
      typeof result.reversalId !== "string" ||
      typeof result.reversedAt !== "string"
    )
      throw new Error();
    return { ...result, replayed: true };
  } catch {
    return {
      status: "reversal_blocked",
      batchId,
      replayed: false,
      message: SAFE_FAILURE,
    };
  }
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

import type { SyncEntity } from "../contracts/sync.js";
import type { WebsiteDatabase } from "../database/sqlite.js";
import { insertAuditEvent } from "./audit.js";
import {
  assertBatchDuplicateFlagsReversible,
  removeBatchDuplicateFlags,
} from "./duplicate-flags.js";
import { hasCapability, newId, type TrustedPrincipal } from "./security.js";

const MAX_BATCH_ITEMS = 200;
const MAX_KEY_LENGTH = 128;
const SAFE_FAILURE =
  "The batch could not be safely reversed; no changes were applied.";
const MUTABLE_FIELDS: Readonly<Record<SyncEntity, readonly string[]>> = {
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
  people: ["display_name"],
  positions: ["organization_id", "title"],
  role_sources: ["url", "title", "source_type", "publisher_classification"],
  person_roles: [
    "person_id",
    "position_id",
    "source_id",
    "start_date",
    "end_date",
    "source_checked_at",
  ],
};

export type SyncBatchLookup = {
  readonly status: "committed" | "reverted";
  readonly batchId: string;
  readonly committedAt: string;
  readonly reversedAt: string | null;
  readonly items: readonly {
    readonly itemIndex: number;
    readonly clientRef: string;
    readonly entity: SyncEntity;
    readonly websiteId: string;
    readonly outcome: "created" | "updated" | "reused";
    readonly version: number;
  }[];
};

export type SyncBatchReversalResult =
  | {
      readonly status: "reverted";
      readonly batchId: string;
      readonly reversalId: string;
      readonly reversedAt: string;
      readonly replayed: boolean;
    }
  | {
      readonly status: "already_reverted";
      readonly batchId: string;
      readonly reversedAt: string;
      readonly replayed: false;
    }
  | {
      readonly status: "reversal_blocked";
      readonly batchId: string;
      readonly replayed: false;
      readonly message: string;
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

export function lookupSyncBatch(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  lookup: { readonly batchId?: string; readonly idempotencyKey?: string },
): SyncBatchLookup | null {
  assertActive(database, principal);
  const byId = typeof lookup.batchId === "string" && lookup.batchId.length > 0;
  const byKey =
    typeof lookup.idempotencyKey === "string" &&
    lookup.idempotencyKey.length > 0;
  if (
    byId === byKey ||
    (byId && !validId(lookup.batchId)) ||
    (byKey && !validKey(lookup.idempotencyKey))
  ) {
    throw new Error("Provide one valid batch ID or idempotency key");
  }
  const batchId = typeof lookup.batchId === "string" ? lookup.batchId : "";
  const idempotencyKey =
    typeof lookup.idempotencyKey === "string" ? lookup.idempotencyKey : "";
  const batch = byId
    ? database
        .prepare(
          "SELECT id, committed_at, result_json FROM sync_batches WHERE id = ? AND actor_account_id = ?",
        )
        .get(batchId, principal.accountId)
    : database
        .prepare(
          "SELECT id, committed_at, result_json FROM sync_batches WHERE idempotency_key = ? AND actor_account_id = ?",
        )
        .get(idempotencyKey, principal.accountId);
  if (
    !batch ||
    typeof batch.id !== "string" ||
    typeof batch.committed_at !== "string"
  )
    return null;
  const parsed = parseResult(batch.result_json);
  if (!parsed) return null;
  const items = database
    .prepare(
      `SELECT item_index, client_ref, entity, target_id, outcome, committed_version
     FROM sync_batch_items WHERE batch_id = ? ORDER BY item_index LIMIT ?`,
    )
    .all(batch.id, MAX_BATCH_ITEMS);
  if (items.length !== parsed.items.length) return null;
  const reversal = database
    .prepare(
      "SELECT reversed_at FROM sync_batch_reversals WHERE batch_id = ? AND actor_account_id = ?",
    )
    .get(batch.id, principal.accountId);
  return {
    status: reversal ? "reverted" : "committed",
    batchId: batch.id,
    committedAt: batch.committed_at,
    reversedAt:
      reversal && typeof reversal.reversed_at === "string"
        ? reversal.reversed_at
        : null,
    items: items.map((item) => ({
      itemIndex: number(item.item_index),
      clientRef: string(item.client_ref),
      entity: entity(item.entity),
      websiteId: string(item.target_id),
      outcome: outcome(item.outcome),
      version: number(item.committed_version),
    })),
  };
}

export async function reverseSyncBatch(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  batchId: string,
  idempotencyKey: string,
  now: () => Date = () => new Date(),
): Promise<SyncBatchReversalResult> {
  assertActive(database, principal);
  if (!validId(batchId) || !validKey(idempotencyKey)) return blocked(batchId);
  const fingerprint = await sha256(
    JSON.stringify({ domain: "m2-sync-reversal/v1", batchId }),
  );
  const existingKey = database
    .prepare(
      "SELECT batch_id, request_fingerprint, result_json FROM sync_batch_reversals WHERE actor_account_id = ? AND idempotency_key = ?",
    )
    .get(principal.accountId, idempotencyKey);
  if (existingKey) {
    if (
      existingKey.batch_id !== batchId ||
      existingKey.request_fingerprint !== fingerprint
    )
      return blocked(batchId);
    return parseReversal(existingKey.result_json, true) ?? blocked(batchId);
  }
  const batch = database
    .prepare(
      "SELECT id FROM sync_batches WHERE id = ? AND actor_account_id = ? AND status = 'committed'",
    )
    .get(batchId, principal.accountId);
  if (!batch) return blocked(batchId);
  const prior = database
    .prepare("SELECT reversed_at FROM sync_batch_reversals WHERE batch_id = ?")
    .get(batchId);
  if (prior && typeof prior.reversed_at === "string")
    return {
      status: "already_reverted",
      batchId,
      reversedAt: prior.reversed_at,
      replayed: false,
    };

  const reversalId = newId();
  const reversedAt = now().toISOString();
  try {
    const transact = database.transaction(() => {
      assertActive(database, principal);
      const raced = database
        .prepare(
          "SELECT batch_id, request_fingerprint, result_json FROM sync_batch_reversals WHERE actor_account_id = ? AND idempotency_key = ?",
        )
        .get(principal.accountId, idempotencyKey);
      if (raced) {
        if (
          raced.batch_id !== batchId ||
          raced.request_fingerprint !== fingerprint
        )
          throw new Error("key_mismatch");
        return parseReversal(raced.result_json, true) ?? blocked(batchId);
      }
      if (
        database
          .prepare(
            "SELECT 1 AS found FROM sync_batch_reversals WHERE batch_id = ?",
          )
          .get(batchId)
      )
        return {
          status: "already_reverted",
          batchId,
          reversedAt: string(
            database
              .prepare(
                "SELECT reversed_at FROM sync_batch_reversals WHERE batch_id = ?",
              )
              .get(batchId)?.reversed_at,
          ),
          replayed: false,
        } as const;
      const rows = database
        .prepare(
          `SELECT item_index, client_ref, entity, target_id, outcome,
                  previous_version, committed_version, inverse_json
           FROM sync_batch_items WHERE batch_id = ? ORDER BY item_index`,
        )
        .all(batchId);
      if (rows.length < 1 || rows.length > MAX_BATCH_ITEMS)
        throw new Error("unsafe_inverse");
      const inverses = rows.map((row) =>
        parseInverse(row.inverse_json, row.item_index),
      );
      if (inverses.some((item) => item === null))
        throw new Error("unsafe_inverse");
      const items = inverses as Inverse[];
      for (const [index, item] of items.entries()) {
        const stored = rows[index];
        if (
          !stored ||
          stored.client_ref !== item.clientRef ||
          stored.entity !== item.entity ||
          stored.target_id !== item.targetId ||
          stored.outcome !== item.outcome ||
          stored.committed_version !== item.committedVersion ||
          stored.previous_version !== item.previousVersion
        )
          throw new Error("unsafe_inverse");
      }
      validateWholeBatch(database, items);
      assertBatchDuplicateFlagsReversible(
        database,
        batchId,
        items
          .filter(
            (item) => item.outcome === "created" && item.entity === "people",
          )
          .map((item) => item.targetId),
        items
          .filter(
            (item) =>
              item.outcome === "created" && item.entity === "role_sources",
          )
          .map((item) => item.targetId),
      );
      const flagsRemoved = removeBatchDuplicateFlags(
        database,
        principal,
        batchId,
      );
      for (const item of [...items].reverse()) applyInverse(database, item);
      const result: SyncBatchReversalResult = {
        status: "reverted",
        batchId,
        reversalId,
        reversedAt,
        replayed: false,
      };
      database
        .prepare(`INSERT INTO sync_batch_reversals
        (id, actor_account_id, batch_id, idempotency_key, request_fingerprint, reversed_at, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          reversalId,
          principal.accountId,
          batchId,
          idempotencyKey,
          fingerprint,
          reversedAt,
          JSON.stringify(result),
        );
      insertAuditEvent(
        database,
        { principal },
        {
          action: "sync.batch.reverse",
          targetType: "sync_batch",
          targetId: batchId,
          summary: "Reversed a Website synchronization batch",
          details: { itemCount: items.length, reversalId, flagsRemoved },
        },
      );
      return result;
    });
    return transact();
  } catch (cause) {
    if (cause instanceof Error && cause.message === "key_mismatch")
      return blocked(batchId);
    return blocked(batchId);
  }
}

function validateWholeBatch(
  database: WebsiteDatabase,
  items: readonly Inverse[],
): void {
  const created = new Map(
    items
      .filter((item) => item.outcome === "created")
      .map((item) => [`${item.entity}:${item.targetId}`, item]),
  );
  for (const item of items) {
    const row = database
      .prepare(`SELECT * FROM "${item.entity}" WHERE id = ?`)
      .get(item.targetId);
    if (item.outcome === "reused") {
      if (!row) throw new Error("unsafe_inverse");
      continue;
    }
    if (!row || row.version !== item.committedVersion)
      throw new Error("unsafe_inverse");
    if (item.outcome === "updated") {
      for (const key of Object.keys(item.changedFields))
        if (!Object.hasOwn(row, key)) throw new Error("unsafe_inverse");
    }
  }
  for (const item of items) {
    if (item.outcome !== "created") continue;
    const dependents = externalDependents(database, item.entity, item.targetId);
    if (dependents.some((dependent) => !created.has(dependent)))
      throw new Error("unsafe_inverse");
  }
}

function externalDependents(
  database: WebsiteDatabase,
  table: SyncEntity,
  id: string,
): string[] {
  const refs: Partial<Record<SyncEntity, readonly [string, string][]>> = {
    organizations: [
      ["positions", "organization_id"],
      ["organization_county_affiliations", "organization_id"],
      ["organizations", "parent_organization_id"],
    ],
    people: [["person_roles", "person_id"]],
    positions: [["person_roles", "position_id"]],
    role_sources: [["person_roles", "source_id"]],
  };
  return (refs[table] ?? []).flatMap(([child, column]) =>
    database
      .prepare(`SELECT id FROM "${child}" WHERE "${column}" = ?`)
      .all(id)
      .map((row) => `${child}:${string(row.id)}`),
  );
}

function applyInverse(database: WebsiteDatabase, item: Inverse): void {
  if (item.outcome === "reused") return;
  if (item.outcome === "created") {
    database
      .prepare(`DELETE FROM "${item.entity}" WHERE id = ? AND version = ?`)
      .run(item.targetId, item.committedVersion);
    if (
      database
        .prepare(`SELECT id FROM "${item.entity}" WHERE id = ?`)
        .get(item.targetId)
    )
      throw new Error("unsafe_inverse");
    return;
  }
  if (
    !item.changedFields ||
    Object.keys(item.changedFields).length === 0 ||
    Object.keys(item.changedFields).some(
      (key) => !MUTABLE_FIELDS[item.entity].includes(key),
    ) ||
    Object.values(item.changedFields).some(
      (value) =>
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number",
    )
  )
    throw new Error("unsafe_inverse");
  const assignments = Object.keys(item.changedFields)
    .map((key) => `"${key}" = ?`)
    .concat([
      `version = version + 1`,
      `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ])
    .join(", ");
  const values = Object.keys(item.changedFields).map(
    (key) => item.changedFields[key] as string | number | null,
  );
  database
    .prepare(
      `UPDATE "${item.entity}" SET ${assignments} WHERE id = ? AND version = ?`,
    )
    .run(...values, item.targetId, item.committedVersion);
  if (
    database
      .prepare(`SELECT version FROM "${item.entity}" WHERE id = ?`)
      .get(item.targetId)?.version !==
    item.committedVersion + 1
  )
    throw new Error("unsafe_inverse");
}

function parseInverse(value: unknown, expectedIndex: unknown): Inverse | null {
  if (typeof value !== "string" || value.length > 32768) return null;
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (
      v.itemIndex !== expectedIndex ||
      !Number.isInteger(v.itemIndex) ||
      !validEntity(v.entity) ||
      typeof v.targetId !== "string" ||
      !v.targetId ||
      !validOutcome(v.outcome) ||
      !Number.isInteger(v.committedVersion) ||
      (v.committedVersion as number) < 1 ||
      !Array.isArray(v.dependencies) ||
      !v.dependencies.every((x) => typeof x === "string") ||
      typeof v.clientRef !== "string"
    )
      return null;
    if (
      v.outcome === "updated" &&
      (!Number.isInteger(v.previousVersion) ||
        (v.previousVersion as number) < 1 ||
        (v.previousVersion as number) !== (v.committedVersion as number) - 1 ||
        !isRecord(v.changedFields) ||
        Object.keys(v.changedFields).length === 0)
    )
      return null;
    if (
      v.outcome !== "updated" &&
      (!isRecord(v.changedFields) || Object.keys(v.changedFields).length !== 0)
    )
      return null;
    return v as unknown as Inverse;
  } catch {
    return null;
  }
}

function parseResult(value: unknown): { items: unknown[] } | null {
  if (typeof value !== "string" || value.length > 65536) return null;
  try {
    const result = JSON.parse(value) as { status?: unknown; items?: unknown };
    return result.status === "committed" &&
      Array.isArray(result.items) &&
      result.items.length <= MAX_BATCH_ITEMS
      ? (result as { items: unknown[] })
      : null;
  } catch {
    return null;
  }
}
function parseReversal(
  value: unknown,
  replayed: boolean,
): SyncBatchReversalResult | null {
  if (typeof value !== "string" || value.length > 16384) return null;
  try {
    const result = JSON.parse(value) as SyncBatchReversalResult;
    return result.status === "reverted" ? { ...result, replayed } : null;
  } catch {
    return null;
  }
}
function blocked(batchId: string): SyncBatchReversalResult {
  return {
    status: "reversal_blocked",
    batchId,
    replayed: false,
    message: SAFE_FAILURE,
  };
}
function assertActive(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
): void {
  if (!hasCapability(database, principal, "checkpoint.read"))
    throw new Error("The trusted Website principal is not active");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
function validKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_KEY_LENGTH &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value)
  );
}
function validEntity(value: unknown): value is SyncEntity {
  return [
    "organizations",
    "organization_county_affiliations",
    "people",
    "positions",
    "role_sources",
    "person_roles",
  ].includes(String(value));
}
function entity(value: unknown): SyncEntity {
  if (!validEntity(value)) throw new Error("Invalid sync batch record");
  return value;
}
function validOutcome(
  value: unknown,
): value is "created" | "updated" | "reused" {
  return value === "created" || value === "updated" || value === "reused";
}
function outcome(value: unknown): "created" | "updated" | "reused" {
  if (!validOutcome(value)) throw new Error("Invalid sync batch record");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid sync batch record");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("Invalid sync batch record");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

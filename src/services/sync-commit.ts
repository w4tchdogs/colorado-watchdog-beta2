import type {
  PlannedSyncItem,
  SyncChange,
  SyncChangeSetRequest,
  SyncEntity,
  SyncPlanError,
} from "../contracts/sync.js";
import {
  MAX_SYNC_CHANGES,
  MAX_SYNC_CITATIONS,
  MAX_SYNC_DUPLICATE_FLAGS,
  MAX_SYNC_ITEM_BYTES,
  MAX_SYNC_REQUEST_BYTES,
} from "../contracts/sync.js";
import type { WebsiteDatabase } from "../database/sqlite.js";
import {
  StaleVersionError,
  updateVersionedRow,
  type VersionedTable,
  type VersionedValue,
} from "../database/versioned-writes.js";
import { insertAuditEvent } from "./audit.js";
import { insertBatchDuplicateFlags } from "./duplicate-flags.js";
import { hasCapability, newId, type TrustedPrincipal } from "./security.js";
import { planSyncChangeset } from "./sync-planner.js";

export type SyncCommitResult =
  | {
      readonly status: "committed";
      readonly batchId: string;
      readonly requestId: string;
      readonly committedAt: string;
      readonly replayed: boolean;
      readonly items: readonly SyncCommitItem[];
      readonly errors: readonly [];
    }
  | {
      readonly status: "rejected";
      readonly requestId: string | null;
      readonly replayed: false;
      readonly items: readonly [];
      readonly errors: readonly SyncPlanError[];
    };

export interface SyncCommitItem {
  readonly itemIndex: number;
  readonly clientRef?: string;
  readonly entity: SyncEntity;
  readonly websiteId: string;
  readonly version: number;
  readonly outcome: "created" | "updated" | "reused";
}

interface StoredResult {
  readonly status: "committed";
  readonly batchId: string;
  readonly requestId: string;
  readonly committedAt: string;
  readonly items: readonly SyncCommitItem[];
}

interface ItemInverse {
  readonly itemIndex: number;
  readonly clientRef: string;
  readonly entity: SyncEntity;
  readonly operation: string;
  readonly targetId: string;
  readonly outcome: "created" | "updated" | "reused";
  readonly previousVersion: number | null;
  readonly committedVersion: number;
  readonly changedFields: Readonly<Record<string, VersionedValue>>;
  readonly dependencies: readonly string[];
}

const SAFE_ERRORS: Readonly<Record<string, string>> = {
  invalid_request: "The changeset structure is invalid.",
  request_too_large: "The request exceeds the 512 KiB limit.",
  too_many_changes: "A changeset must contain from 1 through 200 changes.",
  item_too_large: "A change exceeds the 32 KiB item limit.",
  too_many_citations: "A request may contain at most 25 source citations.",
  too_many_duplicate_flags: "A request may contain at most 20 duplicate flags.",
  invalid_idempotency_key: "The idempotency key is invalid.",
  idempotency_mismatch:
    "This idempotency key is already associated with a different request.",
  commit_conflict:
    "The changeset conflicted with current Website data; no changes were applied.",
};

/** Internal local commit engine. Deliberately not registered with ApplicationServices or a transport. */
export async function commitSyncChangeset(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  idempotencyKey: string,
  request: SyncChangeSetRequest,
  now: () => Date = () => new Date(),
): Promise<SyncCommitResult> {
  const requestId =
    isRecord(request) && typeof request.requestId === "string"
      ? request.requestId
      : null;
  if (!hasCapability(database, principal, "checkpoint.read")) {
    throw new Error("The trusted Website principal is not active");
  }
  const structural = validateStructure(request, idempotencyKey);
  if (structural) return rejected(requestId, structural);

  const fingerprint = await fingerprintRequest(request);
  const existing = database
    .prepare(
      `SELECT id, request_fingerprint, result_json
       FROM sync_batches WHERE actor_account_id = ? AND idempotency_key = ?`,
    )
    .get(principal.accountId, idempotencyKey);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) {
      return rejected(request.requestId, error("idempotency_mismatch"));
    }
    return replay(existing.result_json);
  }

  const plan = planSyncChangeset(
    database,
    { ...request, intent: "dry_run" },
    now,
  );
  if (!plan.eligible) {
    return {
      status: "rejected",
      requestId: request.requestId,
      replayed: false,
      items: [],
      errors: plan.errors,
    };
  }

  const batchId = newId();
  const committedAt = now().toISOString();
  try {
    const result = database.transaction(() => {
      if (!hasCapability(database, principal, "checkpoint.read")) {
        throw new Error("principal_inactive");
      }
      const raced = database
        .prepare(
          `SELECT request_fingerprint, result_json FROM sync_batches
           WHERE actor_account_id = ? AND idempotency_key = ?`,
        )
        .get(principal.accountId, idempotencyKey);
      if (raced) {
        if (raced.request_fingerprint !== fingerprint) {
          throw new Error("idempotency_mismatch");
        }
        return { replayedResult: replay(raced.result_json) };
      }

      const currentPlan = planSyncChangeset(
        database,
        { ...request, intent: "dry_run" },
        now,
      );
      if (!currentPlan.eligible) throw new Error("state_changed");
      const items = applyPlan(database, request.changes, currentPlan.items);
      const stored: StoredResult = {
        status: "committed",
        batchId,
        requestId: request.requestId,
        committedAt,
        items,
      };
      database
        .prepare(
          `INSERT INTO sync_batches
           (id, actor_account_id, idempotency_key, request_fingerprint,
            contract_version, request_id, status, committed_at, result_json)
           VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?)`,
        )
        .run(
          batchId,
          principal.accountId,
          idempotencyKey,
          fingerprint,
          request.contractVersion,
          request.requestId,
          committedAt,
          JSON.stringify(stored),
        );
      persistItems(
        database,
        batchId,
        request.changes,
        currentPlan.items,
        items,
      );
      const flags = insertBatchDuplicateFlags(
        database,
        principal,
        batchId,
        request.duplicateFlags,
        new Map(
          items.flatMap((item) =>
            item.clientRef ? [[item.clientRef, item.websiteId] as const] : [],
          ),
        ),
        committedAt,
      );
      insertAuditEvent(
        database,
        { principal },
        {
          action: "sync.batch.commit",
          targetType: "sync_batch",
          targetId: batchId,
          summary: "Committed a Website synchronization batch",
          details: {
            itemCount: items.length,
            requestId: request.requestId,
            duplicateFlagsCreated: flags.created,
            duplicateFlagsExisting: flags.existing,
          },
        },
      );
      return { committed: stored };
    })();

    if ("replayedResult" in result && result.replayedResult)
      return result.replayedResult;
    return { ...result.committed, replayed: false, errors: [] };
  } catch (cause) {
    if (cause instanceof Error && cause.message === "idempotency_mismatch") {
      return rejected(request.requestId, error("idempotency_mismatch"));
    }
    if (cause instanceof Error && cause.message === "principal_inactive") {
      throw new Error("The trusted Website principal is not active");
    }
    if (cause instanceof Error && cause.message === "state_changed") {
      const refreshed = planSyncChangeset(
        database,
        { ...request, intent: "dry_run" },
        now,
      );
      if (!refreshed.eligible) {
        return {
          status: "rejected",
          requestId: request.requestId,
          replayed: false,
          items: [],
          errors: refreshed.errors,
        };
      }
    }
    const winner = database
      .prepare(
        `SELECT request_fingerprint, result_json FROM sync_batches
         WHERE actor_account_id = ? AND idempotency_key = ?`,
      )
      .get(principal.accountId, idempotencyKey);
    if (winner && winner.request_fingerprint === fingerprint) {
      return replay(winner.result_json);
    }
    return rejected(request.requestId, error("commit_conflict"));
  }
}

function validateStructure(
  request: SyncChangeSetRequest,
  key: string,
): SyncPlanError | null {
  if (
    !isRecord(request) ||
    request.contractVersion !== "m2-sync/v1" ||
    request.intent !== "commit" ||
    !validRequestId(request.requestId) ||
    !Array.isArray(request.changes) ||
    Object.keys(request).some(
      (key) =>
        ![
          "contractVersion",
          "requestId",
          "intent",
          "changes",
          "duplicateFlags",
        ].includes(key),
    ) ||
    request.changes.some(
      (change) =>
        !isRecord(change) ||
        Object.keys(change).some(
          (key) =>
            ![
              "op",
              "entity",
              "clientRef",
              "targetId",
              "expectedVersion",
              "fields",
            ].includes(key),
        ),
    )
  )
    return error("invalid_request");
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  } catch {
    return error("invalid_request");
  }
  if (size > MAX_SYNC_REQUEST_BYTES) return error("request_too_large");
  if (request.changes.length < 1 || request.changes.length > MAX_SYNC_CHANGES)
    return error("too_many_changes");
  let citations = 0;
  try {
    for (const change of request.changes) {
      if (
        new TextEncoder().encode(JSON.stringify(change)).byteLength >
        MAX_SYNC_ITEM_BYTES
      )
        return error("item_too_large");
      if (isRecord(change) && change.op === "register_source") citations += 1;
    }
  } catch {
    return error("invalid_request");
  }
  if (citations > MAX_SYNC_CITATIONS) return error("too_many_citations");
  if (
    request.duplicateFlags !== undefined &&
    (!Array.isArray(request.duplicateFlags) ||
      request.duplicateFlags.length > MAX_SYNC_DUPLICATE_FLAGS)
  )
    return error("too_many_duplicate_flags");
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    return error("invalid_idempotency_key");
  return null;
}

async function fingerprintRequest(
  request: SyncChangeSetRequest,
): Promise<string> {
  const material = canonical({
    domain: "colorado-watchdog-website-sync-commit/v1",
    contractVersion: request.contractVersion,
    changes: request.changes,
    duplicateFlags: request.duplicateFlags ?? [],
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function applyPlan(
  database: WebsiteDatabase,
  changes: readonly SyncChange[],
  planned: readonly PlannedSyncItem[],
): SyncCommitItem[] {
  const mapped = new Map<string, string>();
  const result: SyncCommitItem[] = [];
  for (const item of planned) {
    const change = changes[item.itemIndex];
    if (!change) throw new Error("invalid_plan");
    const ref = "clientRef" in change ? change.clientRef : undefined;
    if (item.action === "would_reuse") {
      if (!item.websiteId) throw new Error("invalid_plan");
      const version = readVersion(database, item.entity, item.websiteId);
      if (ref) mapped.set(ref, item.websiteId);
      result.push({
        itemIndex: item.itemIndex,
        ...(ref ? { clientRef: ref } : {}),
        entity: item.entity,
        websiteId: item.websiteId,
        version,
        outcome: "reused",
      });
      continue;
    }
    if (item.action === "would_create") {
      if (!ref) throw new Error("invalid_plan");
      const id = newId();
      const fields = resolveFields(change, mapped);
      insertEntity(database, item.entity, id, fields);
      mapped.set(ref, id);
      result.push({
        itemIndex: item.itemIndex,
        clientRef: ref,
        entity: item.entity,
        websiteId: id,
        version: 1,
        outcome: "created",
      });
      continue;
    }
    if (item.action === "would_update") {
      if (
        !item.targetId ||
        item.expectedVersion === undefined ||
        !("fields" in change)
      )
        throw new Error("invalid_plan");
      const before = database
        .prepare(`SELECT * FROM "${item.entity}" WHERE id = ?`)
        .get(item.targetId);
      if (!before) throw new StaleVersionError();
      const fields = { ...change.fields } as Record<string, VersionedValue>;
      const previous = Object.fromEntries(
        Object.keys(fields).map((key) => [key, before[key] as VersionedValue]),
      );
      const version = updateVersionedRow(
        database,
        item.entity as VersionedTable,
        item.targetId,
        item.expectedVersion,
        fields,
      );
      result.push({
        itemIndex: item.itemIndex,
        entity: item.entity,
        websiteId: item.targetId,
        version,
        outcome: "updated",
      });
      Object.defineProperty(result[result.length - 1], "previous", {
        value: previous,
        enumerable: false,
      });
      continue;
    }
    throw new Error("invalid_plan");
  }
  return result;
}

function resolveFields(
  change: SyncChange,
  mapped: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const fields = { ...change.fields } as Record<string, unknown>;
  for (const [refKey, idKey] of [
    ["parent_organization_ref", "parent_organization_id"],
    ["organization_ref", "organization_id"],
    ["person_ref", "person_id"],
    ["position_ref", "position_id"],
    ["source_ref", "source_id"],
  ] as const) {
    const ref = fields[refKey];
    if (typeof ref === "string") {
      const id = mapped.get(ref);
      if (!id) throw new Error("invalid_plan");
      fields[idKey] = id;
      delete fields[refKey];
    }
  }
  return fields;
}

function insertEntity(
  database: WebsiteDatabase,
  entity: SyncEntity,
  id: string,
  fields: Record<string, unknown>,
): void {
  const allowed: Readonly<Record<SyncEntity, readonly string[]>> = {
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
    role_sources: ["url", "title", "source_type"],
    person_roles: [
      "person_id",
      "position_id",
      "source_id",
      "start_date",
      "end_date",
      "source_checked_at",
    ],
  };
  const columns = allowed[entity].filter((column) =>
    Object.hasOwn(fields, column),
  );
  const names = ["id", ...columns].map((column) => `"${column}"`).join(", ");
  const values = [
    id,
    ...columns.map((column) => fields[column] as string | number | null),
  ];
  database
    .prepare(
      `INSERT INTO "${entity}" (${names}) VALUES (${values.map(() => "?").join(", ")})`,
    )
    .run(...values);
}

function persistItems(
  database: WebsiteDatabase,
  batchId: string,
  changes: readonly SyncChange[],
  planned: readonly PlannedSyncItem[],
  items: readonly SyncCommitItem[],
): void {
  const insert = database.prepare(`INSERT INTO sync_batch_items
    (batch_id, item_index, client_ref, entity, operation, target_id, outcome,
     previous_version, committed_version, inverse_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of items) {
    const change = changes[item.itemIndex];
    const plan = planned[item.itemIndex];
    if (!change || !plan) throw new Error("invalid_plan");
    const ref =
      "clientRef" in change ? change.clientRef : `item-${item.itemIndex}`;
    const extended = item as SyncCommitItem & {
      previous?: Record<string, VersionedValue>;
    };
    const previousVersion =
      item.outcome === "updated" ? item.version - 1 : null;
    const inverse: ItemInverse = {
      itemIndex: item.itemIndex,
      clientRef: ref,
      entity: item.entity,
      operation: change.op,
      targetId: item.websiteId,
      outcome: item.outcome,
      previousVersion,
      committedVersion: item.version,
      changedFields: extended.previous ?? {},
      dependencies: plan.dependencies,
    };
    insert.run(
      batchId,
      item.itemIndex,
      ref,
      item.entity,
      change.op,
      item.websiteId,
      item.outcome,
      previousVersion,
      item.version,
      JSON.stringify(inverse),
    );
  }
}

function readVersion(
  database: WebsiteDatabase,
  entity: SyncEntity,
  id: string,
): number {
  const row = database
    .prepare(`SELECT version FROM "${entity}" WHERE id = ?`)
    .get(id);
  if (!row || typeof row.version !== "number") throw new Error("invalid_plan");
  return row.version;
}

function replay(json: unknown): SyncCommitResult {
  if (typeof json !== "string") return rejected(null, error("commit_conflict"));
  try {
    const result = JSON.parse(json) as StoredResult;
    if (result.status !== "committed" || !Array.isArray(result.items))
      throw new Error();
    return { ...result, replayed: true, errors: [] };
  } catch {
    return rejected(null, error("commit_conflict"));
  }
}

function rejected(
  requestId: string | null,
  item: SyncPlanError,
): SyncCommitResult {
  return {
    status: "rejected",
    requestId,
    replayed: false,
    items: [],
    errors: [item],
  };
}

function error(code: string): SyncPlanError {
  return {
    code: code as SyncPlanError["code"],
    message: SAFE_ERRORS[code] ?? "The changeset was rejected.",
  };
}

function validRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

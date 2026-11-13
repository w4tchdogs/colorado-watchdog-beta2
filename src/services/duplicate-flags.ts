import type { WebsiteDatabase } from "../database/sqlite.js";
import { insertAuditEvent } from "./audit.js";
import { hasCapability, newId, type TrustedPrincipal } from "./security.js";

/**
 * Internal possible-duplicate flag persistence and lifecycle (M2-E).
 *
 * Flags are advisory research leads. Nothing here matches, merges, deletes or
 * rewrites people, and no name or nickname comparison is ever performed.
 * Not exported through src/services/index.ts and not reachable from a transport.
 */

export type DuplicateFlagStatus = "open" | "dismissed" | "resolved";

export interface DuplicateFlag {
  readonly id: string;
  readonly personId: string;
  readonly possibleDuplicateOfPersonId: string;
  readonly category: "possible_match";
  readonly reason: string;
  readonly nonblocking: true;
  readonly evidenceSourceIds: readonly string[];
  readonly originBatchId: string;
  readonly status: DuplicateFlagStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusChangedAt: string;
  readonly statusChangedByAccountId: string;
}

export type DuplicateFlagTransitionResult =
  | { readonly status: "transitioned"; readonly flag: DuplicateFlag }
  | { readonly status: "not_found" }
  | { readonly status: "stale_version"; readonly currentVersion: number }
  | { readonly status: "invalid_transition" }
  | { readonly status: "invalid_request" };

export interface DuplicateFlagFilter {
  readonly status?: DuplicateFlagStatus;
  readonly batchId?: string;
  readonly personId?: string;
  readonly limit?: number;
}

export interface DuplicateFlagObservation {
  readonly id: string;
  readonly duplicateFlagId: string;
  readonly personIds: readonly [string, string];
  readonly batchId: string;
  readonly reportPosition: number;
  readonly reason: string;
  readonly evidenceSourceIds: readonly string[];
  readonly observedAt: string;
}

const STATUSES: readonly string[] = ["open", "dismissed", "resolved"];
const MAX_LIST = 100;
const MAX_FLAGS_PER_BATCH = 20;
const MAX_EVIDENCE = 25;
const MAX_REASON_BYTES = 500;

/**
 * Persists validated flags inside the caller's transaction. The caller must
 * already have run the M2-B planner against the same request, so references
 * are known to be well formed; this function still resolves and re-checks them.
 * A pair that already has a flag keeps its lifecycle row unchanged; every
 * report still adds its own observation in the caller's transaction.
 */
export function insertBatchDuplicateFlags(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  batchId: string,
  rawFlags: unknown,
  mapped: ReadonlyMap<string, string>,
  now: string,
): {
  readonly created: number;
  readonly existing: number;
  readonly observations: number;
} {
  if (rawFlags === undefined)
    return { created: 0, existing: 0, observations: 0 };
  if (!Array.isArray(rawFlags) || rawFlags.length > MAX_FLAGS_PER_BATCH)
    throw new Error("invalid_flag");
  let created = 0;
  let existing = 0;
  let observations = 0;
  for (const [reportPosition, raw] of rawFlags.entries()) {
    if (!isRecord(raw)) throw new Error("invalid_flag");
    const { targetRef, possibleDuplicateOf, reason, evidenceSourceRefs } = raw;
    if (
      raw.category !== "possible_match" ||
      raw.nonblocking !== true ||
      typeof targetRef !== "string" ||
      typeof possibleDuplicateOf !== "string" ||
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      new TextEncoder().encode(reason).byteLength > MAX_REASON_BYTES
    )
      throw new Error("invalid_flag");
    const personId = mapped.get(targetRef) ?? targetRef;
    const otherId = possibleDuplicateOf;
    if (
      personId === otherId ||
      !rowExists(database, "people", personId) ||
      !rowExists(database, "people", otherId)
    )
      throw new Error("invalid_flag");
    const evidence: string[] = [];
    if (evidenceSourceRefs !== undefined) {
      if (
        !Array.isArray(evidenceSourceRefs) ||
        evidenceSourceRefs.length > MAX_EVIDENCE
      )
        throw new Error("invalid_flag");
      for (const ref of evidenceSourceRefs) {
        if (typeof ref !== "string") throw new Error("invalid_flag");
        const sourceId = mapped.get(ref) ?? ref;
        if (!rowExists(database, "role_sources", sourceId))
          throw new Error("invalid_flag");
        if (!evidence.includes(sourceId)) evidence.push(sourceId);
      }
    }
    const [low, high] =
      personId < otherId ? [personId, otherId] : [otherId, personId];
    const prior = database
      .prepare(
        "SELECT id FROM person_duplicate_flags WHERE pair_low_id = ? AND pair_high_id = ?",
      )
      .get(low, high);
    const id = prior ? string(prior.id) : newId();
    if (prior) existing += 1;
    else {
      database
        .prepare(
          `INSERT INTO person_duplicate_flags
         (id, person_id, possible_duplicate_person_id, pair_low_id, pair_high_id,
          category, reason, nonblocking, evidence_source_ids_json, origin_batch_id,
          origin_actor_account_id, status, version, created_at, updated_at,
          status_changed_at, status_changed_by_account_id)
         VALUES (?, ?, ?, ?, ?, 'possible_match', ?, 1, ?, ?, ?, 'open', 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          personId,
          otherId,
          low,
          high,
          reason,
          JSON.stringify(evidence),
          batchId,
          principal.accountId,
          now,
          now,
          now,
          principal.accountId,
        );
      insertAuditEvent(
        database,
        { principal },
        {
          action: "duplicate_flag.create",
          targetType: "duplicate_flag",
          targetId: id,
          summary: "Created an advisory possible-duplicate flag",
          details: { batchId, status: "open" },
        },
      );
      created += 1;
    }
    database
      .prepare(
        `INSERT INTO person_duplicate_flag_observations
         (id, duplicate_flag_id, pair_low_id, pair_high_id, batch_id,
          actor_account_id, report_position, reason, evidence_source_ids_json,
          observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        id,
        low,
        high,
        batchId,
        principal.accountId,
        reportPosition,
        reason,
        JSON.stringify(evidence),
        now,
      );
    observations += 1;
  }
  return { created, existing, observations };
}

/**
 * Reversal pre-check, run inside the reversal transaction. Throws
 * "unsafe_inverse" (the existing fail-closed signal) when reversing the batch
 * would orphan a flag or discard a recorded human decision.
 */
export function assertBatchDuplicateFlagsReversible(
  database: WebsiteDatabase,
  batchId: string,
  createdPersonIds: readonly string[],
  createdSourceIds: readonly string[],
): void {
  const decided = database
    .prepare(
      "SELECT 1 AS found FROM person_duplicate_flags WHERE origin_batch_id = ? AND status <> 'open' LIMIT 1",
    )
    .get(batchId);
  if (decided) throw new Error("unsafe_inverse");
  const laterObservation = database
    .prepare(
      `SELECT 1 AS found FROM person_duplicate_flag_observations o
       JOIN person_duplicate_flags f ON f.id = o.duplicate_flag_id
       LEFT JOIN sync_batch_reversals r ON r.batch_id = o.batch_id
       WHERE f.origin_batch_id = ? AND o.batch_id <> ? AND r.batch_id IS NULL
       LIMIT 1`,
    )
    .get(batchId, batchId);
  if (laterObservation) throw new Error("unsafe_inverse");
  for (const personId of createdPersonIds) {
    const foreign = database
      .prepare(
        `SELECT 1 AS found FROM person_duplicate_flag_observations o
         LEFT JOIN sync_batch_reversals r ON r.batch_id = o.batch_id
         WHERE r.batch_id IS NULL AND o.batch_id <> ?
           AND (o.pair_low_id = ? OR o.pair_high_id = ?) LIMIT 1`,
      )
      .get(batchId, personId, personId);
    if (foreign) throw new Error("unsafe_inverse");
  }
  for (const sourceId of createdSourceIds) {
    const foreign = database
      .prepare(
        `SELECT 1 AS found FROM person_duplicate_flag_observations o,
                json_each(o.evidence_source_ids_json) j
         LEFT JOIN sync_batch_reversals r ON r.batch_id = o.batch_id
         WHERE r.batch_id IS NULL AND o.batch_id <> ? AND j.value = ? LIMIT 1`,
      )
      .get(batchId, sourceId);
    if (foreign) throw new Error("unsafe_inverse");
  }
}

/** Returns only this actor's bounded observation history, including reversed reports. */
export function listDuplicateFlagObservations(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  filter: { readonly limit?: number } = {},
): readonly DuplicateFlagObservation[] {
  assertActive(database, principal);
  const limit = filter.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST)
    throw new Error("Invalid duplicate flag observation filter");
  return database
    .prepare(
      `SELECT id, duplicate_flag_id, pair_low_id, pair_high_id, batch_id,
              report_position, reason, evidence_source_ids_json, observed_at
       FROM person_duplicate_flag_observations
       WHERE actor_account_id = ?
       ORDER BY observed_at,
         (SELECT rowid FROM sync_batches b WHERE b.id = batch_id), report_position
       LIMIT ?`,
    )
    .all(principal.accountId, limit)
    .map((row) => {
      const evidence = JSON.parse(
        string(row.evidence_source_ids_json),
      ) as unknown;
      if (
        !Array.isArray(evidence) ||
        evidence.some((x) => typeof x !== "string")
      )
        throw new Error("Invalid duplicate flag observation");
      return {
        id: string(row.id),
        duplicateFlagId: string(row.duplicate_flag_id),
        personIds: [string(row.pair_low_id), string(row.pair_high_id)] as const,
        batchId: string(row.batch_id),
        reportPosition: number(row.report_position),
        reason: string(row.reason),
        evidenceSourceIds: evidence as string[],
        observedAt: string(row.observed_at),
      };
    });
}

/** Removes the still-open flags a batch created. Runs inside the reversal transaction. */
export function removeBatchDuplicateFlags(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  batchId: string,
): number {
  const rows = database
    .prepare(
      "SELECT id FROM person_duplicate_flags WHERE origin_batch_id = ? AND status = 'open' ORDER BY id",
    )
    .all(batchId);
  for (const row of rows) {
    const id = string(row.id);
    database.prepare("DELETE FROM person_duplicate_flags WHERE id = ?").run(id);
    insertAuditEvent(
      database,
      { principal },
      {
        action: "duplicate_flag.remove",
        targetType: "duplicate_flag",
        targetId: id,
        summary: "Removed a possible-duplicate flag while reversing its batch",
        details: { batchId },
      },
    );
  }
  if (
    database
      .prepare(
        "SELECT 1 AS found FROM person_duplicate_flags WHERE origin_batch_id = ? LIMIT 1",
      )
      .get(batchId)
  )
    throw new Error("unsafe_inverse");
  return rows.length;
}

export function getDuplicateFlag(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  flagId: string,
): DuplicateFlag | null {
  assertActive(database, principal);
  if (!validId(flagId)) return null;
  const row = database
    .prepare(
      "SELECT * FROM person_duplicate_flags WHERE id = ? AND origin_actor_account_id = ?",
    )
    .get(flagId, principal.accountId);
  return row ? toFlag(row) : null;
}

export function listDuplicateFlags(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  filter: DuplicateFlagFilter = {},
): readonly DuplicateFlag[] {
  assertActive(database, principal);
  const limit = filter.limit ?? 50;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST ||
    (filter.status !== undefined && !STATUSES.includes(filter.status)) ||
    (filter.batchId !== undefined && !validId(filter.batchId)) ||
    (filter.personId !== undefined && !validId(filter.personId))
  )
    throw new Error("Invalid duplicate flag filter");
  const where = ["origin_actor_account_id = ?"];
  const values: (string | number)[] = [principal.accountId];
  if (filter.status !== undefined) {
    where.push("status = ?");
    values.push(filter.status);
  }
  if (filter.batchId !== undefined) {
    where.push("origin_batch_id = ?");
    values.push(filter.batchId);
  }
  if (filter.personId !== undefined) {
    where.push("(person_id = ? OR possible_duplicate_person_id = ?)");
    values.push(filter.personId, filter.personId);
  }
  return database
    .prepare(
      `SELECT * FROM person_duplicate_flags WHERE ${where.join(" AND ")}
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(...values, limit)
    .map(toFlag);
}

/**
 * Explicit, attributed, version-checked status change. Any status may move to
 * any other status, so a dismissal or resolution can be reopened deliberately.
 * Only the account whose batch created the flag can read or change it.
 */
export function transitionDuplicateFlag(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  change: {
    readonly flagId: string;
    readonly expectedVersion: number;
    readonly toStatus: DuplicateFlagStatus;
  },
  now: () => Date = () => new Date(),
): DuplicateFlagTransitionResult {
  assertActive(database, principal);
  if (
    !isRecord(change) ||
    !validId(change.flagId) ||
    !Number.isInteger(change.expectedVersion) ||
    change.expectedVersion < 1 ||
    !STATUSES.includes(change.toStatus)
  )
    return { status: "invalid_request" };
  const at = now().toISOString();
  return database.transaction((): DuplicateFlagTransitionResult => {
    assertActive(database, principal);
    const row = database
      .prepare(
        "SELECT * FROM person_duplicate_flags WHERE id = ? AND origin_actor_account_id = ?",
      )
      .get(change.flagId, principal.accountId);
    if (!row) return { status: "not_found" };
    const version = number(row.version);
    if (version !== change.expectedVersion)
      return { status: "stale_version", currentVersion: version };
    const from = string(row.status);
    if (from === change.toStatus) return { status: "invalid_transition" };
    database
      .prepare(
        `UPDATE person_duplicate_flags
         SET status = ?, version = version + 1, updated_at = ?,
             status_changed_at = ?, status_changed_by_account_id = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        change.toStatus,
        at,
        at,
        principal.accountId,
        change.flagId,
        change.expectedVersion,
      );
    const updated = database
      .prepare("SELECT * FROM person_duplicate_flags WHERE id = ?")
      .get(change.flagId);
    if (!updated || number(updated.version) !== version + 1)
      throw new Error("flag_transition_failed");
    insertAuditEvent(
      database,
      { principal },
      {
        action: "duplicate_flag.transition",
        targetType: "duplicate_flag",
        targetId: change.flagId,
        summary: "Changed a possible-duplicate flag status",
        details: {
          from,
          to: change.toStatus,
          version: version + 1,
          batchId: string(row.origin_batch_id),
        },
      },
    );
    return { status: "transitioned", flag: toFlag(updated) };
  })();
}

function toFlag(row: Record<string, unknown>): DuplicateFlag {
  const status = string(row.status);
  if (!STATUSES.includes(status)) throw new Error("Invalid duplicate flag");
  const evidence = JSON.parse(string(row.evidence_source_ids_json)) as unknown;
  if (!Array.isArray(evidence) || evidence.some((x) => typeof x !== "string"))
    throw new Error("Invalid duplicate flag");
  return {
    id: string(row.id),
    personId: string(row.person_id),
    possibleDuplicateOfPersonId: string(row.possible_duplicate_person_id),
    category: "possible_match",
    reason: string(row.reason),
    nonblocking: true,
    evidenceSourceIds: evidence as string[],
    originBatchId: string(row.origin_batch_id),
    status: status as DuplicateFlagStatus,
    version: number(row.version),
    createdAt: string(row.created_at),
    updatedAt: string(row.updated_at),
    statusChangedAt: string(row.status_changed_at),
    statusChangedByAccountId: string(row.status_changed_by_account_id),
  };
}

function rowExists(
  database: WebsiteDatabase,
  table: "people" | "role_sources",
  id: string,
): boolean {
  return Boolean(
    database.prepare(`SELECT 1 AS found FROM "${table}" WHERE id = ?`).get(id),
  );
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid duplicate flag");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("Invalid duplicate flag");
  return value;
}

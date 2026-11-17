import type {
  PlannedSyncItem,
  SyncChange,
  SyncChangeSetRequest,
  SyncEntity,
  SyncPlanError,
} from "../contracts/sync.js";
import {
  MAX_SYNC_DUPLICATE_FLAGS,
  MAX_SYNC_ITEM_BYTES,
  MAX_SYNC_REQUEST_BYTES,
} from "../contracts/sync.js";
import type {
  AsyncD1Database,
  D1BatchStatement,
  D1Value,
} from "../database/d1.js";
import type { TrustedPrincipal } from "./security.js";
import { SyncPlanReads } from "./sync-plan-reads-d1.js";
import { planSyncChangesetD1 } from "./sync-planner-d1.js";

export interface D1SyncCommitItem {
  readonly itemIndex: number;
  readonly clientRef?: string;
  readonly entity: SyncEntity;
  readonly websiteId: string;
  readonly version: number;
  readonly outcome: "created" | "updated" | "reused";
}

export type D1SyncCommitResult =
  | {
      readonly status: "committed";
      readonly batchId: string;
      readonly requestId: string;
      readonly committedAt: string;
      readonly replayed: boolean;
      readonly items: readonly D1SyncCommitItem[];
      readonly errors: readonly [];
    }
  | {
      readonly status: "rejected";
      readonly requestId: string | null;
      readonly replayed: false;
      readonly items: readonly [];
      readonly errors: readonly SyncPlanError[];
    };

/**
 * Safe operator diagnostic for one commit: counts and timings only, never request
 * content, record values or credentials.
 */
export interface D1SyncCommitDiagnostic {
  readonly outcome: string;
  readonly operations: number;
  readonly planReads: number;
  readonly finalPlanReads: number;
  readonly milliseconds: {
    readonly plan: number;
    readonly prepare: number;
    readonly finalPlan: number;
    readonly write: number;
    readonly total: number;
  };
  readonly statements: number;
}

export type D1SyncAuthorizer = (
  principal: TrustedPrincipal,
  capability: "sync.apply" | "sync.revert",
) => Promise<boolean>;

interface StoredResult {
  readonly status: "committed";
  readonly batchId: string;
  readonly requestId: string;
  readonly committedAt: string;
  readonly items: readonly D1SyncCommitItem[];
}

interface PlannedCommit {
  readonly item: PlannedSyncItem;
  readonly change: SyncChange;
  readonly websiteId: string;
  readonly version: number;
  readonly outcome: "created" | "updated" | "reused";
  readonly previous: Readonly<Record<string, D1Value>>;
  readonly sourceCheckedAt?: string;
}

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_request: "The changeset structure is invalid.",
  request_too_large: "The request exceeds the 8 MiB limit.",
  no_changes: "A changeset must contain at least one change.",
  item_too_large: "A change exceeds the 32 KiB item limit.",
  too_many_duplicate_flags: "A request may contain at most 20 duplicate flags.",
  invalid_idempotency_key: "The idempotency key is invalid.",
  idempotency_mismatch:
    "This idempotency key is already associated with a different request.",
  commit_conflict:
    "The changeset conflicted with current Website data; no changes were applied.",
};

const ENTITY_COLUMNS: Readonly<Record<SyncEntity, readonly string[]>> = {
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
    "county_fips",
    "published_office",
    "published_title",
    "job_description",
  ],
};

const UPDATE_COLUMNS: Readonly<Record<SyncEntity, readonly string[]>> = {
  organizations: [
    "name",
    "organization_type",
    "county_fips",
    "parent_organization_id",
    "parent_relationship",
  ],
  organization_county_affiliations: [],
  people: ["display_name"],
  positions: ["title"],
  role_sources: ["title"],
  person_roles: ["start_date", "end_date", "source_checked_at", "source_id"],
};

/**
 * Internal, default-deny asynchronous D1 commit engine. No route or service
 * registry calls this implementation. The D1 batch is the only write boundary.
 */
export async function commitSyncChangesetD1(
  database: AsyncD1Database,
  principal: TrustedPrincipal,
  idempotencyKey: string,
  request: SyncChangeSetRequest,
  options: {
    authorize?: D1SyncAuthorizer;
    now?: () => Date;
    diagnostic?: (value: D1SyncCommitDiagnostic) => void;
  } = {},
): Promise<D1SyncCommitResult> {
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const marks = { plan: 0, prepare: 0, finalPlan: 0, write: 0 };
  let planReads = 0;
  let finalPlanReads = 0;
  let statementCount = 0;
  const report = (outcome: string) => {
    try {
      options.diagnostic?.({
        outcome,
        operations: Array.isArray(request?.changes)
          ? request.changes.length
          : 0,
        planReads,
        finalPlanReads,
        milliseconds: { ...marks, total: Date.now() - started },
        statements: statementCount,
      });
    } catch {
      // A diagnostic never changes the commit result.
    }
  };
  const requestId =
    isRecord(request) && typeof request.requestId === "string"
      ? request.requestId
      : null;
  if (!(await canApply(database, principal, options.authorize, now()))) {
    throw new Error(
      "The trusted Website principal cannot apply synchronization",
    );
  }
  const structural = validateStructure(request, idempotencyKey);
  if (structural) return rejected(requestId, structural);

  const fingerprint = await fingerprintRequest(request);
  const generation = await database.readDependencyGeneration();
  // Recheck after the generation snapshot. A later authorization write makes
  // the guarded batch stale, and this read catches changes that preceded it.
  if (!(await canApply(database, principal, options.authorize, now()))) {
    throw new Error(
      "The trusted Website principal cannot apply synchronization",
    );
  }
  const existing = await findIdempotency(
    database,
    principal.accountId,
    idempotencyKey,
  );
  if (existing) {
    if (existing.request_fingerprint !== fingerprint)
      return rejected(request.requestId, error("idempotency_mismatch"));
    return replay(existing.result_json);
  }

  const dryRun = { ...request, intent: "dry_run" as const };
  // One set-based read of everything the request names. It is taken after the
  // generation snapshot above, and every table it reads advances that generation
  // on write, so the guarded batch fails if any of it changes before the write.
  // That is what lets the final plan and commit preparation reuse it.
  let phase = Date.now();
  const reads = new SyncPlanReads(database);
  await reads.prefetch(dryRun);
  const plan = await planSyncChangesetD1(database, dryRun, now, reads);
  planReads = reads.queries;
  marks.plan = Date.now() - phase;
  if (!plan.eligible) {
    report("rejected_plan");
    return {
      status: "rejected",
      requestId: request.requestId,
      replayed: false,
      items: [],
      errors: plan.errors,
    };
  }

  phase = Date.now();
  const batchId = newId();
  const committedAt = now().toISOString();
  const itemPlans = await prepareItems(reads, request.changes, plan.items);
  const resultItems = itemPlans.map(
    ({ item, change, websiteId, version, outcome }) =>
      ({
        itemIndex: item.itemIndex,
        ...("clientRef" in change && typeof change.clientRef === "string"
          ? { clientRef: change.clientRef }
          : {}),
        entity: item.entity,
        websiteId,
        version,
        outcome,
      }) satisfies D1SyncCommitItem,
  );
  const mapped = new Map<string, string>();
  for (const item of resultItems)
    if (item.clientRef) mapped.set(item.clientRef, item.websiteId);

  const statements: D1BatchStatement[] = [];
  for (const planned of itemPlans) {
    if (planned.outcome !== "updated") continue;
    const expected = Number(planned.version) - 1;
    statements.push(
      database.prepare(
        `INSERT INTO website_write_assertions (id, valid)
       SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM "${planned.item.entity}" WHERE id = ? AND version = ?) THEN 1 ELSE 0 END`,
        [`${batchId}:${planned.item.itemIndex}`, planned.websiteId, expected],
      ),
    );
  }

  for (const planned of itemPlans) {
    if (planned.item.entity === "person_roles" && planned.sourceCheckedAt) {
      statements.push(
        database.prepare(
          `INSERT INTO website_write_assertions (id, valid)
       SELECT ?, CASE WHEN julianday(?) <= julianday('now', '+5 minutes') THEN 1 ELSE 0 END`,
          [
            `${batchId}:${planned.item.itemIndex}:source-checked-at`,
            planned.sourceCheckedAt,
          ],
        ),
      );
    }
  }

  for (const planned of itemPlans) {
    if (planned.outcome === "created") {
      statements.push(
        insertEntityStatement(
          database,
          planned.item.entity,
          planned.websiteId,
          resolveFields(planned.change, mapped),
        ),
      );
    } else if (planned.outcome === "updated") {
      statements.push(updateEntityStatement(database, planned));
    }
  }

  const stored: StoredResult = {
    status: "committed",
    batchId,
    requestId: request.requestId,
    committedAt,
    items: resultItems,
  };
  statements.push(
    database.prepare(
      `INSERT INTO sync_batches
     (id, actor_account_id, idempotency_key, request_fingerprint, contract_version,
      request_id, status, committed_at, result_json)
     VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?)`,
      [
        batchId,
        principal.accountId,
        idempotencyKey,
        fingerprint,
        request.contractVersion,
        request.requestId,
        committedAt,
        JSON.stringify(stored),
      ],
    ),
  );
  for (const planned of itemPlans) {
    const operation = planned.change.op;
    const clientRef =
      "clientRef" in planned.change &&
      typeof planned.change.clientRef === "string"
        ? planned.change.clientRef
        : `item-${planned.item.itemIndex}`;
    const previousVersion =
      planned.outcome === "updated" ? planned.version - 1 : null;
    const inverse = {
      itemIndex: planned.item.itemIndex,
      clientRef,
      entity: planned.item.entity,
      operation,
      targetId: planned.websiteId,
      outcome: planned.outcome,
      previousVersion,
      committedVersion: planned.version,
      changedFields: planned.previous,
      dependencies: planned.item.dependencies,
    };
    statements.push(
      database.prepare(
        `INSERT INTO sync_batch_items
      (batch_id, item_index, client_ref, entity, operation, target_id, outcome,
       previous_version, committed_version, inverse_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          planned.item.itemIndex,
          clientRef,
          planned.item.entity,
          operation,
          planned.websiteId,
          planned.outcome,
          previousVersion,
          planned.version,
          JSON.stringify(inverse),
        ],
      ),
    );
  }
  const flagCounts = await prepareDuplicateFlags(
    database,
    principal,
    batchId,
    request.duplicateFlags,
    mapped,
    committedAt,
    statements,
  );
  statements.push(
    auditStatement(
      database,
      principal.accountId,
      "sync.batch.commit",
      "sync_batch",
      batchId,
      "Committed a Website synchronization batch",
      {
        itemCount: resultItems.length,
        requestId: request.requestId,
        duplicateFlagsCreated: flagCounts.created,
        duplicateFlagsExisting: flagCounts.existing,
        duplicateFlagObservations: flagCounts.observations,
      },
    ),
  );

  marks.prepare = Date.now() - phase;
  // Revalidate clock-sensitive rules immediately before the write. Database
  // state remains protected by the captured generation assertion, so the final
  // plan reuses the same reads and only reads anything it did not already hold.
  phase = Date.now();
  const before = reads.queries;
  const finalPlan = await planSyncChangesetD1(database, dryRun, now, reads);
  finalPlanReads = reads.queries - before;
  marks.finalPlan = Date.now() - phase;
  if (!finalPlan.eligible) {
    report("rejected_final_plan");
    return {
      status: "rejected",
      requestId: request.requestId,
      replayed: false,
      items: [],
      errors: finalPlan.errors,
    };
  }
  if (!(await canApply(database, principal, options.authorize, now()))) {
    throw new Error(
      "The trusted Website principal cannot apply synchronization",
    );
  }

  statementCount = statements.length;
  phase = Date.now();
  try {
    await database.guardedBatch(generation, principal, statements);
    marks.write = Date.now() - phase;
    report("committed");
    return { ...stored, replayed: false, errors: [] };
  } catch {
    marks.write = Date.now() - phase;
    report("write_failed");
    const winner = await findIdempotency(
      database,
      principal.accountId,
      idempotencyKey,
    );
    if (winner) {
      if (winner.request_fingerprint !== fingerprint)
        return rejected(request.requestId, error("idempotency_mismatch"));
      return replay(winner.result_json);
    }
    return rejected(request.requestId, error("commit_conflict"));
  }
}

async function canApply(
  db: AsyncD1Database,
  principal: TrustedPrincipal,
  authorize: D1SyncAuthorizer | undefined,
  at: Date,
): Promise<boolean> {
  if (!authorize || !(await authorize(principal, "sync.apply"))) return false;
  const row = await db.first<{ kind: unknown; role: unknown }>(
    `SELECT a.kind, a.role FROM accounts a JOIN identities i ON i.account_id = a.id
     WHERE a.id = ? AND i.id = ? AND i.provider = ? AND a.status = 'active'
       AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ?)`,
    [
      principal.accountId,
      principal.identityId,
      principal.provider,
      at.toISOString(),
    ],
  );
  return row?.kind === principal.kind && row.role === principal.role;
}

async function findIdempotency(
  db: AsyncD1Database,
  actor: string,
  key: string,
) {
  return db.first<{ request_fingerprint: unknown; result_json: unknown }>(
    `SELECT request_fingerprint, result_json FROM sync_batches
     WHERE actor_account_id = ? AND idempotency_key = ?`,
    [actor, key],
  );
}

async function prepareItems(
  db: SyncPlanReads,
  changes: readonly SyncChange[],
  items: readonly PlannedSyncItem[],
): Promise<PlannedCommit[]> {
  const prepared: PlannedCommit[] = [];
  for (const item of items) {
    const change = changes[item.itemIndex];
    if (!change || item.action === "invalid") throw new Error("invalid_plan");
    if (item.action === "would_reuse") {
      if (!item.websiteId) throw new Error("invalid_plan");
      const row = await db.row(item.entity, item.websiteId);
      if (!row || typeof row.version !== "number")
        throw new Error("invalid_plan");
      prepared.push({
        item,
        change,
        websiteId: item.websiteId,
        version: row.version,
        outcome: "reused",
        previous: {},
      });
    } else if (item.action === "would_create") {
      if (!("clientRef" in change) || typeof change.clientRef !== "string")
        throw new Error("invalid_plan");
      const id = newId();
      const createSourceCheckedAt =
        item.entity === "person_roles" && "fields" in change
          ? (change.fields as Readonly<Record<string, unknown>>)
              .source_checked_at
          : undefined;
      prepared.push({
        item,
        change,
        websiteId: id,
        version: 1,
        outcome: "created",
        previous: {},
        ...(typeof createSourceCheckedAt === "string"
          ? { sourceCheckedAt: createSourceCheckedAt }
          : {}),
      });
    } else if (item.action === "would_update") {
      if (
        !item.targetId ||
        item.expectedVersion === undefined ||
        !("fields" in change)
      )
        throw new Error("invalid_plan");
      const before = await db.row(item.entity, item.targetId);
      if (!before || before.version !== item.expectedVersion)
        throw new Error("stale_plan");
      const previous: Record<string, D1Value> = {};
      for (const key of Object.keys(updateFields(change)))
        previous[key] = asD1Value(before[key]);
      prepared.push({
        item,
        change,
        websiteId: item.targetId,
        version: item.expectedVersion + 1,
        outcome: "updated",
        previous,
        ...(item.entity === "person_roles" &&
        typeof before.source_checked_at === "string"
          ? { sourceCheckedAt: before.source_checked_at }
          : {}),
      });
    }
  }
  return prepared;
}

function insertEntityStatement(
  db: AsyncD1Database,
  entity: SyncEntity,
  id: string,
  fields: Record<string, unknown>,
): D1BatchStatement {
  const columns = ENTITY_COLUMNS[entity].filter((column) =>
    Object.hasOwn(fields, column),
  );
  const names = ["id", ...columns].map((column) => `"${column}"`).join(", ");
  const values: D1Value[] = [
    id,
    ...columns.map((column) => asD1Value(fields[column])),
  ];
  return db.prepare(
    `INSERT INTO "${entity}" (${names}) VALUES (${values.map(() => "?").join(", ")})`,
    values,
  );
}

function updateFields(change: SyncChange): Record<string, unknown> {
  if (!("fields" in change)) throw new Error("invalid_plan");
  const fields = { ...change.fields } as Record<string, unknown>;
  if (
    change.entity === "person_roles" &&
    Object.hasOwn(fields, "source_id") &&
    !Object.hasOwn(fields, "source_checked_at")
  ) {
    fields.source_checked_at = null;
  }
  return fields;
}

function updateEntityStatement(
  db: AsyncD1Database,
  planned: PlannedCommit,
): D1BatchStatement {
  const fields = updateFields(planned.change);
  const keys = Object.keys(fields).sort();
  if (
    keys.length === 0 ||
    keys.some((key) => !UPDATE_COLUMNS[planned.item.entity].includes(key))
  )
    throw new Error("invalid_plan");
  const assignments = keys
    .map((key) => `"${key}" = ?`)
    .concat([
      `"version" = "version" + 1`,
      `"updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ]);
  const values: D1Value[] = keys.map((key) => asD1Value(fields[key]));
  values.push(planned.websiteId, planned.version - 1);
  return db.prepare(
    `UPDATE "${planned.item.entity}" SET ${assignments.join(", ")} WHERE id = ? AND version = ?`,
    values,
  );
}

async function prepareDuplicateFlags(
  db: AsyncD1Database,
  principal: TrustedPrincipal,
  batchId: string,
  rawFlags: unknown,
  mapped: ReadonlyMap<string, string>,
  at: string,
  statements: D1BatchStatement[],
): Promise<{ created: number; existing: number; observations: number }> {
  if (rawFlags === undefined)
    return { created: 0, existing: 0, observations: 0 };
  if (!Array.isArray(rawFlags) || rawFlags.length > MAX_SYNC_DUPLICATE_FLAGS)
    throw new Error("invalid_flag");
  let created = 0;
  let existing = 0;
  for (const [position, raw] of rawFlags.entries()) {
    if (!isRecord(raw)) throw new Error("invalid_flag");
    const personId = mapped.get(String(raw.targetRef)) ?? String(raw.targetRef);
    const otherId = String(raw.possibleDuplicateOf);
    if (personId === otherId) throw new Error("invalid_flag");
    const [low, high] =
      personId < otherId ? [personId, otherId] : [otherId, personId];
    const prior = await db.first<{ id: string }>(
      "SELECT id FROM person_duplicate_flags WHERE pair_low_id = ? AND pair_high_id = ?",
      [low, high],
    );
    const flagId = prior?.id ?? newId();
    if (prior) existing += 1;
    else {
      const evidence = Array.isArray(raw.evidenceSourceRefs)
        ? raw.evidenceSourceRefs.map(
            (value) => mapped.get(String(value)) ?? String(value),
          )
        : [];
      statements.push(
        db.prepare(
          `INSERT INTO person_duplicate_flags
        (id, person_id, possible_duplicate_person_id, pair_low_id, pair_high_id,
         category, reason, nonblocking, evidence_source_ids_json, origin_batch_id,
         origin_actor_account_id, status, version, created_at, updated_at,
         status_changed_at, status_changed_by_account_id)
        VALUES (?, ?, ?, ?, ?, 'possible_match', ?, 1, ?, ?, ?, 'open', 1, ?, ?, ?, ?)`,
          [
            flagId,
            personId,
            otherId,
            low,
            high,
            String(raw.reason),
            JSON.stringify(evidence),
            batchId,
            principal.accountId,
            at,
            at,
            at,
            principal.accountId,
          ],
        ),
      );
      statements.push(
        auditStatement(
          db,
          principal.accountId,
          "duplicate_flag.create",
          "duplicate_flag",
          flagId,
          "Created an advisory possible-duplicate flag",
          { batchId, status: "open" },
        ),
      );
      created += 1;
    }
    const evidenceIds = Array.isArray(raw.evidenceSourceRefs)
      ? [
          ...new Set(
            raw.evidenceSourceRefs.map(
              (value) => mapped.get(String(value)) ?? String(value),
            ),
          ),
        ]
      : [];
    statements.push(
      db.prepare(
        `INSERT INTO person_duplicate_flag_observations
      (id, duplicate_flag_id, pair_low_id, pair_high_id, batch_id, actor_account_id,
       report_position, reason, evidence_source_ids_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          flagId,
          low,
          high,
          batchId,
          principal.accountId,
          position,
          String(raw.reason),
          JSON.stringify(evidenceIds),
          at,
        ],
      ),
    );
  }
  return { created, existing, observations: rawFlags.length };
}

function auditStatement(
  db: AsyncD1Database,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  summary: string,
  details: Readonly<Record<string, string | number | boolean | null>>,
): D1BatchStatement {
  const encoded = JSON.stringify(details);
  if (/cwa_[A-Za-z0-9_-]{43}/.test(encoded))
    throw new Error("Audit data cannot contain credentials");
  return db.prepare(
    `INSERT INTO audit_events
    (id, actor_account_id, operation_id, action, target_type, target_id, summary, details_json)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    [newId(), actor, action, targetType, targetId, summary, encoded],
  );
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
      (field) =>
        ![
          "contractVersion",
          "requestId",
          "intent",
          "changes",
          "duplicateFlags",
        ].includes(field),
    ) ||
    request.changes.some(
      (change) =>
        !isRecord(change) ||
        Object.keys(change).some(
          (field) =>
            ![
              "op",
              "entity",
              "clientRef",
              "targetId",
              "expectedVersion",
              "fields",
            ].includes(field),
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
  if (request.changes.length < 1) return error("no_changes");
  try {
    for (const change of request.changes) {
      if (
        new TextEncoder().encode(JSON.stringify(change)).byteLength >
        MAX_SYNC_ITEM_BYTES
      )
        return error("item_too_large");
    }
  } catch {
    return error("invalid_request");
  }
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
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function replay(json: unknown): D1SyncCommitResult {
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
  issue: SyncPlanError,
): D1SyncCommitResult {
  return {
    status: "rejected",
    requestId,
    replayed: false,
    items: [],
    errors: [issue],
  };
}

function error(code: string): SyncPlanError {
  return {
    code: code as SyncPlanError["code"],
    message: SAFE_MESSAGES[code] ?? "The changeset was rejected.",
  };
}

function newId(): string {
  return crypto.randomUUID();
}
function validRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asD1Value(value: unknown): D1Value {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array
  )
    return value;
  throw new Error("Unsupported D1 binding value");
}

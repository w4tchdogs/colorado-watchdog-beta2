import {
  IMPORT_REF,
  IMPORT_REF_PREFIX,
  type ImportIssue,
  type ImportRowReport,
  type ImportVisibility,
  PROFILE_FILE,
  PROFILES_IMPORT_CONTRACT,
  PROFILES_IMPORT_MAX_BYTES,
  PROFILES_IMPORT_MAX_REPORT_ROWS,
  type ProfilesImportCounts,
  type ProfilesImportFiles,
  type ProfilesImportPreview,
  type ProfilesImportReceipt,
  type ProfilesImportReversal,
  ROLE_FILE,
} from "../contracts/profiles-import.js";
import {
  SYNC_CONTRACT_VERSION,
  type SyncChange,
  type SyncChangeSetRequest,
} from "../contracts/sync.js";
import type { AsyncD1Database, D1Value } from "../database/d1.js";
import {
  type ProfileRecord,
  parseImportFile,
  type RoleRecord,
  validateProfileRows,
  validateRoleRows,
} from "./profiles-import-csv.js";
import { AuthorizationError, type TrustedPrincipal } from "./security.js";
import {
  commitSyncChangesetD1,
  IMPORTER_BATCH_KEY_PREFIX,
} from "./sync-commit-d1.js";
import { planSyncChangesetD1 } from "./sync-planner-d1.js";
import { reverseSyncBatchD1 } from "./sync-revert-d1.js";

/**
 * Owner dashboard Profiles import over the asynchronous Website D1 (SYNC-1).
 *
 * Preview is read-only. Commit recomputes the plan, refuses when it differs
 * from the one the owner reviewed, and then writes through the shared sync
 * commit engine in one atomic batch: Website-assigned IDs, expected versions,
 * a retry-safe receipt, audit events and reversal all come from that engine.
 * New Profiles are created hidden in the same batch. Existing Profiles, their
 * visibility, owner edits and every record the file does not mention are left
 * alone. Stable keys persist as namespaced client references on the committed
 * sync items, so no new table is needed.
 */
export class ImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportInputError";
  }
}
export class ImportValidationError extends Error {
  constructor(readonly issues: readonly ImportIssue[]) {
    super("The import has blocking issues");
    this.name = "ImportValidationError";
  }
}
export class ImportStalePreviewError extends Error {
  constructor() {
    super("The Website or the files changed since this preview");
    this.name = "ImportStalePreviewError";
  }
}
export class ImportIdempotencyError extends Error {
  constructor() {
    super("The idempotency key was already used for a different import");
    this.name = "ImportIdempotencyError";
  }
}
export class ImportReversalBlockedError extends Error {
  constructor() {
    super("The import cannot be reversed");
    this.name = "ImportReversalBlockedError";
  }
}

export interface ProfilesImportService {
  preview(
    principal: TrustedPrincipal,
    input: unknown,
  ): Promise<ProfilesImportPreview>;
  commit(
    principal: TrustedPrincipal,
    idempotencyKey: string,
    input: unknown,
  ): Promise<ProfilesImportReceipt>;
  reverse(
    principal: TrustedPrincipal,
    batchId: string,
    idempotencyKey: string,
  ): Promise<ProfilesImportReversal>;
}

export interface ProfilesImportOptions {
  /** Must resolve true only for a current principal holding `profile.manage`. */
  readonly authorize: (principal: TrustedPrincipal) => Promise<boolean>;
  readonly now?: () => Date;
}

interface Mapped {
  readonly websiteId: string;
  readonly baselineVersion: number;
}
interface Origin {
  readonly kind: "profile" | "role" | "source";
  readonly key: string;
  readonly line: number;
}
interface Plan {
  readonly preview: ProfilesImportPreview;
  readonly request: SyncChangeSetRequest | null;
  readonly origins: readonly Origin[];
  readonly changeCount: number;
}

/**
 * Every importer batch is stored under this idempotency key prefix. Mapping
 * and baseline lookups read only such batches, so a batch from any other sync
 * client can never supply, shadow or move a stable mapping, even when it uses
 * a client reference in the importer's namespace.
 */
const IMPORT_KEY_PREFIX = IMPORTER_BATCH_KEY_PREFIX;
const MAX_USER_KEY = 128 - IMPORT_KEY_PREFIX.length;
const CHUNK = 80;
const emptyCounts = (): Record<keyof ProfilesImportCounts, number> => ({
  add: 0,
  update: 0,
  unchanged: 0,
  conflict: 0,
  blocked: 0,
});

export function createD1ProfilesImportService(
  database: AsyncD1Database,
  options: ProfilesImportOptions,
): ProfilesImportService {
  const now = options.now ?? (() => new Date());

  async function guard(principal: TrustedPrincipal): Promise<void> {
    if (
      principal.kind !== "human" ||
      (await options.authorize(principal)) !== true
    )
      throw new AuthorizationError();
  }

  async function plan(input: unknown): Promise<Plan> {
    const files = parseFiles(input);
    return buildPlan(database, files, now);
  }

  return {
    async preview(principal, input) {
      await guard(principal);
      return (await plan(input)).preview;
    },

    async commit(principal, key, input) {
      await guard(principal);
      if (
        typeof key !== "string" ||
        key.length < 8 ||
        key.length > MAX_USER_KEY ||
        !/^[A-Za-z0-9._:-]+$/.test(key)
      )
        throw new ImportInputError("The idempotency key is invalid");
      const digest = readDigest(input);
      const requestId = requestIdFor(digest);
      const storedKey = `${IMPORT_KEY_PREFIX}${key}`;
      // A retry with the same key answers from the stored receipt, even though
      // the Website no longer matches the original plan after the first commit.
      const existing = await database.first<{
        request_id: unknown;
        result_json: unknown;
      }>(
        "SELECT request_id, result_json FROM sync_batches WHERE actor_account_id = ? AND idempotency_key = ?",
        [principal.accountId, storedKey],
      );
      if (existing) {
        if (existing.request_id !== requestId)
          throw new ImportIdempotencyError();
        return receiptFromStored(String(existing.result_json), true);
      }
      // Sampled before any read the plan depends on. The shared write fails
      // if the Website changes after this point, so two commits built from
      // the same preview cannot both apply.
      const generation = await database.readDependencyGeneration();
      const planned = await plan(input);
      if (planned.preview.digest !== digest)
        throw new ImportStalePreviewError();
      if (!planned.preview.canCommit)
        throw new ImportValidationError(planned.preview.issues);
      if (planned.changeCount === 0 || !planned.request) return emptyReceipt();
      const result = await commitSyncChangesetD1(
        database,
        principal,
        storedKey,
        { ...planned.request, intent: "commit" },
        {
          authorize: () => options.authorize(principal),
          now,
          createdPeopleHidden: true,
          importerBatch: true,
          expectedGeneration: generation,
        },
      );
      if (result.status === "rejected") {
        const codes = result.errors.map((error) => error.code);
        if (codes.includes("idempotency_mismatch"))
          throw new ImportIdempotencyError();
        if (
          codes.includes("commit_conflict") ||
          codes.includes("stale_version")
        )
          throw new ImportStalePreviewError();
        throw new ImportValidationError(
          result.errors.map((error) => issueFor(error, planned.origins)),
        );
      }
      return receiptFromResult(result, result.replayed);
    },

    async reverse(principal, batchId, key) {
      await guard(principal);
      if (typeof batchId !== "string" || typeof key !== "string")
        throw new ImportInputError(
          "A batch ID and idempotency key are required",
        );
      // Only a batch this importer committed can be reversed from here.
      const owned = await database.first(
        `SELECT 1 AS found FROM sync_batches
         WHERE id = ? AND actor_account_id = ?
           AND substr(idempotency_key, 1, ${IMPORT_KEY_PREFIX.length}) = ?`,
        [batchId, principal.accountId, IMPORT_KEY_PREFIX],
      );
      if (!owned) throw new ImportReversalBlockedError();
      const result = await reverseSyncBatchD1(
        database,
        principal,
        batchId,
        key,
        {
          authorize: () => options.authorize(principal),
          now,
        },
      );
      if (result.status === "reversal_blocked")
        throw new ImportReversalBlockedError();
      return {
        status: result.status,
        batchId,
        reversedAt: result.reversedAt,
      };
    },
  };
}

function parseFiles(input: unknown): ProfilesImportFiles {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ImportInputError("The request needs a files object");
  const body = input as Record<string, unknown>;
  const files = body.files;
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new ImportInputError("The request needs a files object");
  const f = files as Record<string, unknown>;
  for (const name of Object.keys(f))
    if (name !== "profile" && name !== "profileRole")
      throw new ImportInputError(`Unexpected file "${name}"`);
  if (typeof f.profile !== "string" || f.profile.trim() === "")
    throw new ImportInputError("profile.csv is required");
  if (f.profileRole !== undefined && typeof f.profileRole !== "string")
    throw new ImportInputError("profile_role.csv must be text");
  const bytes =
    new TextEncoder().encode(f.profile).byteLength +
    (typeof f.profileRole === "string"
      ? new TextEncoder().encode(f.profileRole).byteLength
      : 0);
  if (bytes > PROFILES_IMPORT_MAX_BYTES)
    throw new ImportInputError("The files are too large");
  return {
    profile: f.profile,
    ...(typeof f.profileRole === "string" && f.profileRole.trim() !== ""
      ? { profileRole: f.profileRole }
      : {}),
  };
}

function readDigest(input: unknown): string {
  const digest = (input as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    throw new ImportInputError(
      "The commit needs the digest of the preview the owner reviewed",
    );
  return digest;
}

/** The sync contract wants a UUID. It is derived from the reviewed digest. */
const requestIdFor = (digest: string) =>
  `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
function chunks<T>(values: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    out.push(values.slice(i, i + size));
  return out;
}
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readMappings(db: AsyncD1Database): Promise<Map<string, Mapped>> {
  const refs = new Map<string, { id: string; entity: string }>();
  for (let offset = 0; ; offset += 1000) {
    const rows = await db.all<{ ref: string; id: string; entity: string }>(
      `SELECT i.client_ref AS ref, i.target_id AS id, i.entity AS entity
       FROM sync_batch_items i
       JOIN sync_batches b ON b.id = i.batch_id
       LEFT JOIN sync_batch_reversals r ON r.batch_id = i.batch_id
       WHERE r.batch_id IS NULL AND i.outcome IN ('created', 'reused')
         AND substr(b.idempotency_key, 1, ${IMPORT_KEY_PREFIX.length}) = '${IMPORT_KEY_PREFIX}'
         AND i.client_ref >= '${IMPORT_REF_PREFIX}' AND i.client_ref < 'dash;'
       ORDER BY b.committed_at, i.batch_id, i.item_index
       LIMIT 1000 OFFSET ${offset}`,
      1000,
    );
    for (const row of rows)
      if (!refs.has(row.ref))
        refs.set(row.ref, { id: row.id, entity: row.entity });
    if (rows.length < 1000) break;
  }
  const baselines = new Map<string, number>();
  const ids = [...new Set([...refs.values()].map((r) => r.id))];
  for (const part of chunks(ids)) {
    const rows = await db.all<{ entity: string; id: string; version: number }>(
      `SELECT i.entity AS entity, i.target_id AS id, MAX(i.committed_version) AS version
       FROM sync_batch_items i
       JOIN sync_batches b ON b.id = i.batch_id
       LEFT JOIN sync_batch_reversals r ON r.batch_id = i.batch_id
       WHERE r.batch_id IS NULL
         AND substr(b.idempotency_key, 1, ${IMPORT_KEY_PREFIX.length}) = '${IMPORT_KEY_PREFIX}'
         AND i.target_id IN (${marks(part.length)})
       GROUP BY i.entity, i.target_id`,
      1000,
      part,
    );
    for (const row of rows)
      baselines.set(`${row.entity}:${row.id}`, row.version);
  }
  const out = new Map<string, Mapped>();
  for (const [ref, { id, entity }] of refs)
    out.set(ref, {
      websiteId: id,
      baselineVersion: baselines.get(`${entity}:${id}`) ?? 1,
    });
  return out;
}

async function readRows<Row>(
  db: AsyncD1Database,
  table: string,
  columns: string,
  ids: readonly string[],
): Promise<Map<string, Row & { id: string }>> {
  const out = new Map<string, Row & { id: string }>();
  for (const part of chunks([...new Set(ids)])) {
    const rows = await db.all<Row & { id: string }>(
      `SELECT ${columns} FROM ${table} WHERE id IN (${marks(part.length)})`,
      1000,
      part,
    );
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

const sameInstant = (a: string | null, b: string) =>
  a === b || (a !== null && Date.parse(a) === Date.parse(b));

async function buildPlan(
  db: AsyncD1Database,
  files: ProfilesImportFiles,
  now: () => Date,
): Promise<Plan> {
  const issues: ImportIssue[] = [];
  const rows: ImportRowReport[] = [];
  const notes: string[] = [];
  const ignored: {
    file: typeof PROFILE_FILE | typeof ROLE_FILE;
    columns: readonly string[];
  }[] = [];

  const profileParsed = parseImportFile(PROFILE_FILE, files.profile);
  issues.push(...profileParsed.issues);
  if (profileParsed.ignoredColumns.length)
    ignored.push({ file: PROFILE_FILE, columns: profileParsed.ignoredColumns });
  const profileChecked = validateProfileRows(profileParsed);
  issues.push(...profileChecked.issues);
  const profiles: readonly ProfileRecord[] = profileChecked.records;

  let roles: readonly RoleRecord[] = [];
  if (files.profileRole !== undefined) {
    const roleParsed = parseImportFile(ROLE_FILE, files.profileRole);
    issues.push(...roleParsed.issues);
    if (roleParsed.ignoredColumns.length)
      ignored.push({ file: ROLE_FILE, columns: roleParsed.ignoredColumns });
    const roleChecked = validateRoleRows(roleParsed);
    issues.push(...roleChecked.issues);
    roles = roleChecked.records;
  } else {
    notes.push(
      "No profile_role.csv was uploaded. Only Profiles are previewed.",
    );
  }

  const mappings = await readMappings(db);
  const mapOf = (prefix: string, id: string) => mappings.get(`${prefix}${id}`);
  const invalidProfileIds = new Set(
    profileChecked.issues
      .map((i) => i.key)
      .filter((k): k is string => typeof k === "string"),
  );
  const fileProfileIds = new Set(profiles.map((p) => p.profileId));

  const mappedProfileIds = profiles.flatMap(
    (p) => mapOf(IMPORT_REF.profile, p.profileId)?.websiteId ?? [],
  );
  const mappedRoleIds = roles.flatMap(
    (r) => mapOf(IMPORT_REF.role, r.roleId)?.websiteId ?? [],
  );
  const sourceIds = [...new Set(roles.map((r) => r.sourceId))];
  const mappedSourceIds = sourceIds.flatMap(
    (s) => mapOf(IMPORT_REF.source, s)?.websiteId ?? [],
  );
  const referencedProfileIds = roles.flatMap(
    (r) => mapOf(IMPORT_REF.profile, r.profileId)?.websiteId ?? [],
  );

  const people = await readRows<{ display_name: string; version: number }>(
    db,
    "people",
    "id, display_name, version",
    [...mappedProfileIds, ...referencedProfileIds],
  );
  const roleRows = await readRows<{
    person_id: string;
    source_id: string;
    version: number;
    county_fips: string | null;
    start_date: string | null;
    end_date: string | null;
    source_checked_at: string | null;
    published_office: string | null;
    published_title: string | null;
    job_description: string | null;
  }>(
    db,
    "person_roles",
    "id, person_id, source_id, version, county_fips, start_date, end_date, source_checked_at, published_office, published_title, job_description",
    mappedRoleIds,
  );
  const sourceRows = await readRows<{
    url: string;
    title: string;
    version: number;
  }>(db, "role_sources", "id, url, title, version", mappedSourceIds);
  const hidden = new Set<string>();
  const hiddenRows: string[] = [...new Set(mappedProfileIds)];
  for (const part of chunks(hiddenRows)) {
    const found = await db.all<{ person_id: string }>(
      `SELECT person_id FROM person_visibility WHERE visible = 0 AND person_id IN (${marks(part.length)})`,
      1000,
      part,
    );
    for (const row of found) hidden.add(row.person_id);
  }

  const changes: SyncChange[] = [];
  const updates: SyncChange[] = [];
  const origins: Origin[] = [];
  const addChange = (
    change: SyncChange,
    origin: Origin,
    list: SyncChange[] = changes,
  ) => {
    list.push(change);
    if (list === changes) origins.push(origin);
    return origin;
  };
  // Origins are recorded in change order. Updates are appended after creates.
  const updateOrigins: Origin[] = [];

  // Sources first so a role can refer to the one registered earlier.
  const sourceFirstRow = new Map<string, RoleRecord>();
  for (const role of roles)
    if (!sourceFirstRow.has(role.sourceId))
      sourceFirstRow.set(role.sourceId, role);
  const sourceBlocked = new Set<string>();
  for (const [sourceId, role] of sourceFirstRow) {
    const origin = { kind: "source" as const, key: sourceId, line: role.line };
    const mapped = mapOf(IMPORT_REF.source, sourceId);
    if (!mapped) {
      addChange(
        {
          op: "register_source",
          entity: "role_sources",
          clientRef: IMPORT_REF.source + sourceId,
          fields: {
            url: role.sourceUrl,
            title: role.sourceTitle,
            publisher_classification: role.publisherClassification,
            source_type: role.sourceType,
          },
        },
        origin,
      );
      rows.push({
        kind: "source",
        key: sourceId,
        line: role.line,
        label: role.sourceTitle,
        action: "add",
        visibility: "not_applicable",
      });
      continue;
    }
    const current = sourceRows.get(mapped.websiteId);
    if (!current || current.url !== role.sourceUrl) {
      sourceBlocked.add(sourceId);
      const reason = !current
        ? "The mapped Website source no longer exists."
        : "A source URL cannot change through import. Register the new source under a new source_id.";
      rows.push({
        kind: "source",
        key: sourceId,
        line: role.line,
        label: role.sourceTitle,
        action: "blocked",
        websiteId: mapped.websiteId,
        visibility: "not_applicable",
        reason,
      });
      issues.push({
        file: ROLE_FILE,
        line: role.line,
        key: sourceId,
        code: "source_unusable",
        message: reason,
      });
    } else if (current.title === role.sourceTitle) {
      rows.push({
        kind: "source",
        key: sourceId,
        line: role.line,
        label: role.sourceTitle,
        action: "unchanged",
        websiteId: mapped.websiteId,
        visibility: "not_applicable",
      });
    } else if (current.version === mapped.baselineVersion) {
      addChange(
        {
          op: "update_record",
          entity: "role_sources",
          targetId: mapped.websiteId,
          expectedVersion: current.version,
          fields: { title: role.sourceTitle },
        },
        origin,
        updates,
      );
      updateOrigins.push(origin);
      rows.push({
        kind: "source",
        key: sourceId,
        line: role.line,
        label: role.sourceTitle,
        action: "update",
        websiteId: mapped.websiteId,
        visibility: "not_applicable",
        fields: [
          {
            field: "title",
            current: current.title,
            proposed: role.sourceTitle,
          },
        ],
      });
    } else {
      rows.push({
        kind: "source",
        key: sourceId,
        line: role.line,
        label: role.sourceTitle,
        action: "conflict",
        websiteId: mapped.websiteId,
        visibility: "not_applicable",
        reason:
          "The source title was edited on the Website after the last import. The Website value is kept.",
        fields: [
          {
            field: "title",
            current: current.title,
            proposed: role.sourceTitle,
          },
        ],
      });
    }
  }

  // Profiles.
  const duplicateNameCandidates: ProfileRecord[] = [];
  for (const profile of profiles) {
    const origin = {
      kind: "profile" as const,
      key: profile.profileId,
      line: profile.line,
    };
    const mapped = mapOf(IMPORT_REF.profile, profile.profileId);
    if (!mapped) {
      addChange(
        {
          op: "create_person",
          entity: "people",
          clientRef: IMPORT_REF.profile + profile.profileId,
          fields: { display_name: profile.displayName },
        },
        origin,
      );
      rows.push({
        kind: "profile",
        key: profile.profileId,
        line: profile.line,
        label: profile.displayName,
        action: "add",
        visibility: "hidden_on_create",
      });
      duplicateNameCandidates.push(profile);
      continue;
    }
    const current = people.get(mapped.websiteId);
    const visibility: ImportVisibility = hidden.has(mapped.websiteId)
      ? "stays_hidden"
      : "stays_visible";
    if (!current) {
      const message = "The mapped Website Profile no longer exists.";
      rows.push({
        kind: "profile",
        key: profile.profileId,
        line: profile.line,
        label: profile.displayName,
        action: "blocked",
        websiteId: mapped.websiteId,
        visibility,
        reason: message,
      });
      issues.push({
        file: PROFILE_FILE,
        line: profile.line,
        key: profile.profileId,
        code: "mapped_record_missing",
        message,
      });
    } else if (current.display_name === profile.displayName) {
      rows.push({
        kind: "profile",
        key: profile.profileId,
        line: profile.line,
        label: profile.displayName,
        action: "unchanged",
        websiteId: mapped.websiteId,
        visibility,
      });
    } else if (current.version === mapped.baselineVersion) {
      addChange(
        {
          op: "update_record",
          entity: "people",
          targetId: mapped.websiteId,
          expectedVersion: current.version,
          fields: { display_name: profile.displayName },
        },
        origin,
        updates,
      );
      updateOrigins.push(origin);
      rows.push({
        kind: "profile",
        key: profile.profileId,
        line: profile.line,
        label: profile.displayName,
        action: "update",
        websiteId: mapped.websiteId,
        visibility,
        fields: [
          {
            field: "display_name",
            current: current.display_name,
            proposed: profile.displayName,
          },
        ],
      });
    } else {
      rows.push({
        kind: "profile",
        key: profile.profileId,
        line: profile.line,
        label: profile.displayName,
        action: "conflict",
        websiteId: mapped.websiteId,
        visibility,
        reason:
          "The name was edited on the Website after the last import. The Website value is kept.",
        fields: [
          {
            field: "display_name",
            current: current.display_name,
            proposed: profile.displayName,
          },
        ],
      });
    }
  }

  // Roles.
  for (const role of roles) {
    const origin = { kind: "role" as const, key: role.roleId, line: role.line };
    const label =
      role.publishedOffice ??
      role.publishedTitle ??
      role.jobDescription ??
      role.roleId;
    const blockedRow = (reason: string, code: string) => {
      rows.push({
        kind: "role",
        key: role.roleId,
        line: role.line,
        label,
        action: "blocked",
        visibility: "not_applicable",
        reason,
      });
      issues.push({
        file: ROLE_FILE,
        line: role.line,
        key: role.roleId,
        code,
        message: reason,
      });
    };
    const mappedProfile = mapOf(IMPORT_REF.profile, role.profileId);
    const profileInFile = fileProfileIds.has(role.profileId);
    if (!mappedProfile && !profileInFile) {
      blockedRow(
        invalidProfileIds.has(role.profileId)
          ? `Profile ${role.profileId} has an invalid row in profile.csv.`
          : `Profile ${role.profileId} is neither in profile.csv nor already imported.`,
        "missing_profile",
      );
      continue;
    }
    if (sourceBlocked.has(role.sourceId)) {
      blockedRow(
        `Source ${role.sourceId} cannot be used. See its row.`,
        "source_unusable_for_role",
      );
      continue;
    }
    const mappedRole = mapOf(IMPORT_REF.role, role.roleId);
    if (!mappedRole) {
      const mappedSource = mapOf(IMPORT_REF.source, role.sourceId);
      addChange(
        {
          op: "create_person_role",
          entity: "person_roles",
          clientRef: IMPORT_REF.role + role.roleId,
          fields: {
            county_fips: role.countyFips,
            ...(role.publishedOffice
              ? { published_office: role.publishedOffice }
              : {}),
            ...(role.publishedTitle
              ? { published_title: role.publishedTitle }
              : {}),
            ...(role.jobDescription
              ? { job_description: role.jobDescription }
              : {}),
            ...(role.startDate ? { start_date: role.startDate } : {}),
            ...(role.endDate ? { end_date: role.endDate } : {}),
            ...(role.sourceCheckedAt
              ? { source_checked_at: role.sourceCheckedAt }
              : {}),
            ...(mappedProfile
              ? { person_id: mappedProfile.websiteId }
              : { person_ref: IMPORT_REF.profile + role.profileId }),
            ...(mappedSource
              ? { source_id: mappedSource.websiteId }
              : { source_ref: IMPORT_REF.source + role.sourceId }),
          },
        } as SyncChange,
        origin,
      );
      rows.push({
        kind: "role",
        key: role.roleId,
        line: role.line,
        label,
        action: "add",
        visibility: "not_applicable",
      });
      continue;
    }
    const current = roleRows.get(mappedRole.websiteId);
    if (!current) {
      blockedRow(
        "The mapped Website role no longer exists.",
        "mapped_record_missing",
      );
      continue;
    }
    const expectedPerson = mappedProfile?.websiteId;
    const fixed: { field: string; current: string | null; proposed: string }[] =
      [];
    if (expectedPerson && current.person_id !== expectedPerson)
      fixed.push({
        field: "profile",
        current: current.person_id,
        proposed: expectedPerson,
      });
    if (current.county_fips !== null && current.county_fips !== role.countyFips)
      fixed.push({
        field: "county_fips",
        current: current.county_fips,
        proposed: role.countyFips,
      });
    for (const [field, value, now_] of [
      ["published_office", role.publishedOffice, current.published_office],
      ["published_title", role.publishedTitle, current.published_title],
      ["job_description", role.jobDescription, current.job_description],
    ] as const)
      if (value !== undefined && value !== now_)
        fixed.push({ field, current: now_, proposed: value });
    const mappedSource = mapOf(IMPORT_REF.source, role.sourceId);
    if (mappedSource && current.source_id !== mappedSource.websiteId)
      fixed.push({
        field: "source",
        current: current.source_id,
        proposed: mappedSource.websiteId,
      });
    if (fixed.length) {
      rows.push({
        kind: "role",
        key: role.roleId,
        line: role.line,
        label,
        action: "conflict",
        websiteId: mappedRole.websiteId,
        visibility: "not_applicable",
        reason:
          "These fields cannot change through import. Edit them in the Profiles sheet. The Website values are kept.",
        fields: fixed,
      });
      continue;
    }
    const diffs: {
      field: "start_date" | "end_date" | "source_checked_at";
      current: string | null;
      proposed: string;
    }[] = [];
    if (role.startDate && role.startDate !== current.start_date)
      diffs.push({
        field: "start_date",
        current: current.start_date,
        proposed: role.startDate,
      });
    if (role.endDate && role.endDate !== current.end_date)
      diffs.push({
        field: "end_date",
        current: current.end_date,
        proposed: role.endDate,
      });
    if (
      role.sourceCheckedAt &&
      !sameInstant(current.source_checked_at, role.sourceCheckedAt)
    )
      diffs.push({
        field: "source_checked_at",
        current: current.source_checked_at,
        proposed: role.sourceCheckedAt,
      });
    if (diffs.length === 0) {
      rows.push({
        kind: "role",
        key: role.roleId,
        line: role.line,
        label,
        action: "unchanged",
        websiteId: mappedRole.websiteId,
        visibility: "not_applicable",
      });
    } else if (current.version === mappedRole.baselineVersion) {
      addChange(
        {
          op: "update_record",
          entity: "person_roles",
          targetId: mappedRole.websiteId,
          expectedVersion: current.version,
          fields: Object.fromEntries(diffs.map((d) => [d.field, d.proposed])),
        } as SyncChange,
        origin,
        updates,
      );
      updateOrigins.push(origin);
      rows.push({
        kind: "role",
        key: role.roleId,
        line: role.line,
        label,
        action: "update",
        websiteId: mappedRole.websiteId,
        visibility: "not_applicable",
        fields: diffs,
      });
    } else {
      rows.push({
        kind: "role",
        key: role.roleId,
        line: role.line,
        label,
        action: "conflict",
        websiteId: mappedRole.websiteId,
        visibility: "not_applicable",
        reason:
          "The role was edited on the Website after the last import. The Website values are kept.",
        fields: diffs,
      });
    }
  }

  // Origins follow change order: creates, then updates.
  const allChanges = [...changes, ...updates];
  const allOrigins = [...origins, ...updateOrigins];

  // Optional readability note: new Profiles that share a name with an existing one.
  if (
    duplicateNameCandidates.length > 0 &&
    duplicateNameCandidates.length <= 1500
  ) {
    let shared = 0;
    const names = [
      ...new Set(duplicateNameCandidates.map((p) => p.displayName)),
    ];
    for (const part of chunks(names)) {
      const found = await db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM people WHERE display_name COLLATE NOCASE IN (${marks(part.length)})`,
        1,
        part as D1Value[],
      );
      shared += Number(found[0]?.n ?? 0);
    }
    if (shared > 0)
      notes.push(
        `${shared} existing Website Profile(s) share a name with a new Profile. New Profiles are created hidden, so review possible duplicates before publishing.`,
      );
  } else if (duplicateNameCandidates.length > 1500) {
    notes.push("The duplicate name check was skipped for a file this large.");
  }

  let request: SyncChangeSetRequest | null = null;
  const blocking = issues.length > 0;
  const digestBase = {
    files: [
      await sha256Hex(files.profile),
      await sha256Hex(files.profileRole ?? ""),
    ],
  };
  if (allChanges.length > 0) {
    // The id carries the content digest of the changes so a retry is recognized.
    const changesDigest = await sha256Hex(
      JSON.stringify([digestBase, allChanges]),
    );
    request = {
      contractVersion: SYNC_CONTRACT_VERSION,
      requestId: requestIdFor(changesDigest),
      intent: "dry_run",
      changes: allChanges,
    };
  }
  if (request && !blocking) {
    const dryRun = await planSyncChangesetD1(db, request, now);
    for (const error of dryRun.errors) issues.push(issueFor(error, allOrigins));
  }

  const counts = (
    kind: "profile" | "role" | "source",
  ): ProfilesImportCounts => {
    const c = emptyCounts();
    for (const row of rows) if (row.kind === kind) c[row.action]++;
    return c;
  };
  const profileCounts = counts("profile");
  const roleCounts = counts("role");
  const totalPeople = Number(
    (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM people"))?.n ?? 0,
  );
  const totalRoles = Number(
    (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM person_roles"))
      ?.n ?? 0,
  );

  const base = {
    changes: allChanges,
    digestBase,
    rows: rows.map((r) => [
      r.kind,
      r.key,
      r.action,
      r.websiteId ?? null,
      r.fields ?? null,
    ]),
    issues: issues.map((i) => [i.file, i.line, i.code, i.key ?? null]),
  };
  const digest = await sha256Hex(JSON.stringify(base));
  // The request id is tied to the final digest so commit and retry agree.
  const finalRequest = request
    ? { ...request, requestId: requestIdFor(digest) }
    : null;

  const order = {
    blocked: 0,
    conflict: 1,
    add: 2,
    update: 3,
    unchanged: 4,
  } as const;
  const reported = [...rows].sort(
    (a, b) => order[a.action] - order[b.action] || a.line - b.line,
  );
  return {
    preview: {
      contract: PROFILES_IMPORT_CONTRACT,
      digest,
      canCommit: issues.length === 0,
      profiles: profileCounts,
      roles: roleCounts,
      sources: counts("source"),
      newProfilesHidden: profileCounts.add,
      rows: reported.slice(0, PROFILES_IMPORT_MAX_REPORT_ROWS),
      rowsTruncated: reported.length > PROFILES_IMPORT_MAX_REPORT_ROWS,
      issues: issues.slice(0, 200),
      ignoredColumns: ignored,
      notes,
      untouchedProfiles: Math.max(
        0,
        totalPeople - [...new Set(mappedProfileIds)].length,
      ),
      untouchedRoles: Math.max(
        0,
        totalRoles - [...new Set(mappedRoleIds)].length,
      ),
    },
    request: finalRequest,
    origins: allOrigins,
    changeCount: allChanges.length,
  };
}

function issueFor(
  error: {
    code: string;
    itemIndex?: number;
    clientRef?: string;
    message: string;
  },
  origins: readonly Origin[],
): ImportIssue {
  const origin =
    error.itemIndex === undefined ? undefined : origins[error.itemIndex];
  return {
    file:
      origin?.kind === "profile"
        ? PROFILE_FILE
        : origin
          ? ROLE_FILE
          : "request",
    line: origin?.line ?? null,
    ...(origin ? { key: origin.key } : {}),
    code: error.code,
    message: error.message,
  };
}

interface StoredResult {
  readonly batchId: string;
  readonly committedAt: string;
  readonly items: readonly {
    readonly clientRef?: string;
    readonly entity: string;
    readonly websiteId: string;
    readonly outcome: "created" | "updated" | "reused";
  }[];
}

function receiptFromResult(
  result: StoredResult,
  replayed: boolean,
): ProfilesImportReceipt {
  const created = { profiles: 0, roles: 0, sources: 0, reusedSources: 0 };
  const updated = { profiles: 0, roles: 0 };
  const createdProfiles: { key: string; profileId: string; hidden: true }[] =
    [];
  for (const item of result.items) {
    if (item.entity === "people" && item.outcome === "created") {
      created.profiles++;
      createdProfiles.push({
        key: (item.clientRef ?? "").slice(IMPORT_REF.profile.length),
        profileId: item.websiteId,
        hidden: true,
      });
    } else if (item.entity === "person_roles" && item.outcome === "created")
      created.roles++;
    else if (item.entity === "role_sources" && item.outcome === "created")
      created.sources++;
    else if (item.entity === "role_sources" && item.outcome === "reused")
      created.reusedSources++;
    else if (item.entity === "people" && item.outcome === "updated")
      updated.profiles++;
    else if (item.entity === "person_roles" && item.outcome === "updated")
      updated.roles++;
  }
  return {
    status: "committed",
    batchId: result.batchId,
    committedAt: result.committedAt,
    replayed,
    created,
    updated,
    newProfilesHidden: created.profiles,
    createdProfiles,
  };
}

function receiptFromStored(
  json: string,
  replayed: boolean,
): ProfilesImportReceipt {
  return receiptFromResult(JSON.parse(json) as StoredResult, replayed);
}

function emptyReceipt(): ProfilesImportReceipt {
  return {
    status: "nothing_to_commit",
    replayed: false,
    created: { profiles: 0, roles: 0, sources: 0, reusedSources: 0 },
    updated: { profiles: 0, roles: 0 },
    newProfilesHidden: 0,
    createdProfiles: [],
  };
}

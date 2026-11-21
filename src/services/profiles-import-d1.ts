import {
  IMPORT_REF,
  IMPORT_REF_PREFIX,
  type ImportIssue,
  type ImportRowReport,
  type ImportVisibility,
  NAME_FILE,
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
import type { PersonNameComponentField } from "../contracts/sync.js";
import {
  SYNC_CONTRACT_VERSION,
  type SyncChange,
  type SyncChangeSetRequest,
} from "../contracts/sync.js";
import type { AsyncD1Database, D1Value } from "../database/d1.js";
import {
  type NameRecord,
  type ProfileRecord,
  parseImportFile,
  type RoleRecord,
  validateNameRows,
  validateProfileRows,
  validateRoleRows,
} from "./profiles-import-csv.js";
import {
  ProfilesWorkbookError,
  readProfilesWorkbook,
} from "./profiles-import-xlsx.js";
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
  constructor(
    readonly code:
      | "reversal_blocked"
      | "reversal_profile_deleted" = "reversal_blocked",
  ) {
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
  /** Enabled only for the persistent, loopback Website draft database. */
  readonly privateDraftReview?: boolean;
}

interface Mapped {
  readonly websiteId: string;
  readonly baselineVersion: number;
  readonly deletedFor: string | null;
}
interface Origin {
  readonly kind: "profile" | "role" | "name";
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
const DRAFT_WORKBOOK_IMPORT_MAX_BYTES = 24 * 1024 * 1024;
const DRAFT_WORKBOOK_CHANGESET_MAX_BYTES = 48 * 1024 * 1024;
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

  async function plan(input: unknown) {
    const draftWorkbook =
      options.privateDraftReview === true &&
      input !== null &&
      typeof input === "object" &&
      Object.hasOwn(input, "workbook");
    const files = await parseFiles(
      input,
      draftWorkbook
        ? DRAFT_WORKBOOK_IMPORT_MAX_BYTES
        : PROFILES_IMPORT_MAX_BYTES,
    );
    const readd = (input as { readdProfileId?: unknown }).readdProfileId;
    if (
      readd !== undefined &&
      (typeof readd !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(readd))
    )
      throw new ImportInputError("Choose one deleted CSV Profile ID to re-add");
    const maxRequestBytes = draftWorkbook
      ? DRAFT_WORKBOOK_CHANGESET_MAX_BYTES
      : undefined;
    const planned = await buildPlan(
      database,
      files,
      now,
      readd,
      maxRequestBytes,
    );
    return { ...planned, maxRequestBytes };
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
          maxImporterRequestBytes: planned.maxRequestBytes,
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
      const deleted = await database.first(
        `SELECT 1 AS found FROM sync_batch_items i
         JOIN profile_deleted_targets d ON d.entity = i.entity AND d.target_id = i.target_id
         WHERE i.batch_id = ? LIMIT 1`,
        [batchId],
      );
      if (deleted)
        throw new ImportReversalBlockedError("reversal_profile_deleted");
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

async function parseFiles(
  input: unknown,
  maxBytes: number,
): Promise<ProfilesImportFiles> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ImportInputError("The request needs a files object");
  const body = input as Record<string, unknown>;
  const hasWorkbook = Object.hasOwn(body, "workbook");
  let files = body.files;
  if (hasWorkbook) {
    if (Object.hasOwn(body, "files") || typeof body.workbook !== "string")
      throw new ProfilesWorkbookError(
        "Choose one Excel workbook or CSV files.",
      );
    files = await readProfilesWorkbook(body.workbook);
  }
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new ImportInputError("The request needs a files object");
  const f = files as Record<string, unknown>;
  for (const name of Object.keys(f))
    if (name !== "profile" && name !== "profileRole" && name !== "profileName")
      throw new ImportInputError(`Unexpected file "${name}"`);
  if (typeof f.profile !== "string" || f.profile.trim() === "")
    throw new ImportInputError("profile.csv is required");
  if (f.profileRole !== undefined && typeof f.profileRole !== "string")
    throw new ImportInputError("profile_role.csv must be text");
  if (f.profileName !== undefined && typeof f.profileName !== "string")
    throw new ImportInputError("profile_name.csv must be text");
  const size = (text: unknown) =>
    typeof text === "string" ? new TextEncoder().encode(text).byteLength : 0;
  const bytes = size(f.profile) + size(f.profileRole) + size(f.profileName);
  if (bytes > maxBytes && hasWorkbook)
    throw new ProfilesWorkbookError(
      `The workbook's import data exceeds ${maxBytes / 1024 / 1024} MiB. Preview a smaller set of rows.`,
    );
  if (bytes > maxBytes) throw new ImportInputError("The files are too large");
  return {
    profile: f.profile,
    ...(typeof f.profileRole === "string" && f.profileRole.trim() !== ""
      ? { profileRole: f.profileRole }
      : {}),
    ...(typeof f.profileName === "string" && f.profileName.trim() !== ""
      ? { profileName: f.profileName }
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
  const refs = new Map<
    string,
    { id: string; entity: string; deletedFor: string | null }
  >();
  for (let offset = 0; ; offset += 1000) {
    const rows = await db.all<{
      ref: string;
      id: string;
      entity: string;
      deleted_for: string | null;
    }>(
      `SELECT i.client_ref AS ref, i.target_id AS id, i.entity AS entity, d.profile_id AS deleted_for
       FROM sync_batch_items i
       JOIN sync_batches b ON b.id = i.batch_id
       LEFT JOIN sync_batch_reversals r ON r.batch_id = i.batch_id
       LEFT JOIN profile_deleted_targets d ON d.entity = i.entity AND d.target_id = i.target_id
       WHERE r.batch_id IS NULL AND i.outcome IN ('created', 'reused')
         AND substr(b.idempotency_key, 1, ${IMPORT_KEY_PREFIX.length}) = '${IMPORT_KEY_PREFIX}'
         AND i.client_ref >= '${IMPORT_REF_PREFIX}' AND i.client_ref < 'dash;'
       ORDER BY d.deletion_generation DESC NULLS FIRST, b.committed_at, i.batch_id, i.item_index
       LIMIT 1000 OFFSET ${offset}`,
      1000,
    );
    for (const row of rows)
      if (!refs.has(row.ref))
        refs.set(row.ref, {
          id: row.id,
          entity: row.entity,
          deletedFor: row.deleted_for,
        });
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
      deletedFor: refs.get(ref)?.deletedFor ?? null,
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

const nameIdentity = (
  personId: string,
  type: string,
  published: string,
  from: string | null,
  until: string | null,
) =>
  [
    personId,
    type,
    published.trim().toLowerCase(),
    from ?? "",
    until ?? "",
  ].join("|");

async function buildPlan(
  db: AsyncD1Database,
  files: ProfilesImportFiles,
  now: () => Date,
  readdProfileId?: string,
  maxRequestBytes?: number,
): Promise<Plan> {
  const issues: ImportIssue[] = [];
  const rows: ImportRowReport[] = [];
  const notes: string[] = [];
  const ignored: {
    file: typeof PROFILE_FILE | typeof ROLE_FILE | typeof NAME_FILE;
    columns: readonly string[];
  }[] = [];

  const profileParsed = parseImportFile(PROFILE_FILE, files.profile);
  issues.push(...profileParsed.issues);
  if (profileParsed.ignoredColumns.length)
    ignored.push({ file: PROFILE_FILE, columns: profileParsed.ignoredColumns });
  const profileChecked = validateProfileRows(profileParsed);
  issues.push(...profileChecked.issues);
  let profiles: readonly ProfileRecord[] = profileChecked.records;

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

  let nameRecords: readonly NameRecord[] = [];
  if (files.profileName !== undefined) {
    const nameParsed = parseImportFile(NAME_FILE, files.profileName);
    issues.push(...nameParsed.issues);
    if (nameParsed.ignoredColumns.length)
      ignored.push({ file: NAME_FILE, columns: nameParsed.ignoredColumns });
    const nameChecked = validateNameRows(nameParsed);
    issues.push(...nameChecked.issues);
    nameRecords = nameChecked.records;
  }

  const mappings = await readMappings(db);
  const profileMapping = (key: string) =>
    mappings.get(`${IMPORT_REF.profile}${key}`);
  const readdTarget = readdProfileId
    ? profileMapping(readdProfileId)?.deletedFor
    : null;
  if (
    readdProfileId &&
    (!readdTarget || !profiles.some((p) => p.profileId === readdProfileId))
  )
    throw new ImportInputError(
      "The selected deleted Profile must appear in profile.csv",
    );

  const omittedProfiles = new Set(
    profiles
      .filter(
        (p) =>
          profileMapping(p.profileId)?.deletedFor &&
          p.profileId !== readdProfileId,
      )
      .map((p) => p.profileId),
  );
  const skipDeleted = (
    kind: "profile" | "role" | "name",
    key: string,
    line: number,
    label: string,
  ) => {
    rows.push({
      kind,
      key,
      line,
      label,
      action: "unchanged",
      deletedOnWebsite: true,
      visibility: "not_applicable",
      reason: "Deleted on Website. Omitted from this import.",
    });
    return false;
  };
  const keepDependent = (profileId: string, prefix: string, id: string) => {
    const owner = profileMapping(profileId);
    const deletedFor = mappings.get(`${prefix}${id}`)?.deletedFor;
    if (owner?.deletedFor && profileId !== readdProfileId) return false;
    return (
      !deletedFor ||
      (profileId === readdProfileId && deletedFor === readdTarget)
    );
  };
  profiles = profiles.filter(
    (p) =>
      !omittedProfiles.has(p.profileId) ||
      skipDeleted("profile", p.profileId, p.line, p.displayName),
  );
  roles = roles.filter(
    (r) =>
      keepDependent(r.profileId, IMPORT_REF.role, r.roleId) ||
      skipDeleted("role", r.roleId, r.line, r.roleId),
  );
  nameRecords = nameRecords.filter(
    (n) =>
      keepDependent(n.profileId, IMPORT_REF.name, n.nameId) ||
      skipDeleted("name", n.nameId, n.line, n.publishedName),
  );
  if (readdTarget) {
    // Use the new creation operations only for the explicitly selected Profile.
    // Historical rows stay in receipts for replay and reversal checks.
    for (const [ref, mapped] of mappings) {
      if (mapped.deletedFor === readdTarget) mappings.delete(ref);
    }
  }
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
  const referencedProfileIds = roles.flatMap(
    (r) => mapOf(IMPORT_REF.profile, r.profileId)?.websiteId ?? [],
  );

  const nameProfileIds = nameRecords.flatMap(
    (n) => mapOf(IMPORT_REF.profile, n.profileId)?.websiteId ?? [],
  );
  const mappedNameIds = nameRecords.flatMap(
    (n) => mapOf(IMPORT_REF.name, n.nameId)?.websiteId ?? [],
  );
  const people = await readRows<
    {
      display_name: string;
      version: number;
    } & Record<PersonNameComponentField, string | null>
  >(
    db,
    "people",
    "id, display_name, version, first_name, middle_name, last_name, name_prefix, name_suffix, preferred_first_name",
    [...mappedProfileIds, ...referencedProfileIds],
  );
  const nameRows = await readRows<{
    person_id: string;
    name_type: string;
    published_name: string;
    first_name: string | null;
    middle_name: string | null;
    last_name: string | null;
    name_prefix: string | null;
    name_suffix: string | null;
    applies_from: string | null;
    applies_until: string | null;
    public_display: number;
    removed_at: string | null;
    version: number;
  }>(
    db,
    "profile_names",
    "id, person_id, name_type, published_name, first_name, middle_name, last_name, name_prefix, name_suffix, applies_from, applies_until, public_display, removed_at, version",
    mappedNameIds,
  );
  // Active names already on mapped Profiles, so a new row that repeats one is
  // reported before commit instead of failing the unique index.
  const activeNames = new Map<string, string>();
  for (const part of chunks([...new Set(nameProfileIds)])) {
    const found = await db.all<{
      id: string;
      person_id: string;
      name_type: string;
      published_name: string;
      applies_from: string | null;
      applies_until: string | null;
    }>(
      `SELECT id, person_id, name_type, published_name, applies_from, applies_until
       FROM profile_names WHERE removed_at IS NULL AND person_id IN (${marks(part.length)})`,
      1000,
      part,
    );
    for (const row of found)
      activeNames.set(
        nameIdentity(
          row.person_id,
          row.name_type,
          row.published_name,
          row.applies_from,
          row.applies_until,
        ),
        row.id,
      );
  }
  const roleRows = await readRows<{
    person_id: string;
    version: number;
    county_fips: string | null;
    start_date: string | null;
    end_date: string | null;
    published_office: string | null;
    published_title: string | null;
    job_description: string | null;
  }>(
    db,
    "person_roles",
    "id, person_id, version, county_fips, start_date, end_date, published_office, published_title, job_description",
    mappedRoleIds,
  );
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
          fields: {
            display_name: profile.displayName,
            ...Object.fromEntries(
              Object.entries(profile.components).filter(
                ([, value]) => value !== null,
              ),
            ),
          },
        } as SyncChange,
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
    } else {
      const diffs: {
        field: string;
        current: string | null;
        proposed: string | null;
      }[] = [];
      if (current.display_name !== profile.displayName)
        diffs.push({
          field: "display_name",
          current: current.display_name,
          proposed: profile.displayName,
        });
      for (const [field, proposed] of Object.entries(profile.components)) {
        const now_ = current[field as PersonNameComponentField] ?? null;
        if (now_ !== proposed) diffs.push({ field, current: now_, proposed });
      }
      const base = {
        kind: "profile" as const,
        key: profile.profileId,
        line: profile.line,
        label: profile.displayName,
        websiteId: mapped.websiteId,
        visibility,
      };
      if (diffs.length === 0) {
        rows.push({ ...base, action: "unchanged" });
      } else if (current.version === mapped.baselineVersion) {
        addChange(
          {
            op: "update_record",
            entity: "people",
            targetId: mapped.websiteId,
            expectedVersion: current.version,
            fields: Object.fromEntries(diffs.map((d) => [d.field, d.proposed])),
          } as SyncChange,
          origin,
          updates,
        );
        updateOrigins.push(origin);
        rows.push({ ...base, action: "update", fields: diffs });
      } else {
        rows.push({
          ...base,
          action: "conflict",
          reason:
            "The name was edited on the Website after the last import. The Website values are kept.",
          fields: diffs,
        });
      }
    }
  }

  // Typed alternate names. Always private and pending review when created.
  let namesPublishRequested = 0;
  for (const name of nameRecords) {
    const origin = { kind: "name" as const, key: name.nameId, line: name.line };
    if (name.requestedPublic || name.requestedConfirmed)
      namesPublishRequested++;
    const blockedRow = (reason: string, code: string, websiteId?: string) => {
      rows.push({
        kind: "name",
        key: name.nameId,
        line: name.line,
        label: name.publishedName,
        action: "blocked",
        ...(websiteId ? { websiteId } : {}),
        visibility: "not_applicable",
        reason,
      });
      issues.push({
        file: NAME_FILE,
        line: name.line,
        key: name.nameId,
        code,
        message: reason,
      });
    };
    const mappedProfile = mapOf(IMPORT_REF.profile, name.profileId);
    if (!mappedProfile && !fileProfileIds.has(name.profileId)) {
      blockedRow(
        invalidProfileIds.has(name.profileId)
          ? `Profile ${name.profileId} has an invalid row in profile.csv.`
          : `Profile ${name.profileId} is neither in profile.csv nor already imported.`,
        "missing_profile",
      );
      continue;
    }
    const nameFields = {
      name_type: name.nameType,
      published_name: name.publishedName,
      ...name.components,
      applies_from: name.appliesFrom,
      applies_until: name.appliesUntil,
    };
    const mappedName = mapOf(IMPORT_REF.name, name.nameId);
    if (!mappedName) {
      const duplicate = mappedProfile
        ? activeNames.get(
            nameIdentity(
              mappedProfile.websiteId,
              name.nameType,
              name.publishedName,
              name.appliesFrom,
              name.appliesUntil,
            ),
          )
        : undefined;
      if (duplicate) {
        blockedRow(
          "This Profile already has this name, type and dates on the Website. Use its existing profile_name_id or remove the row.",
          "duplicate_name",
          duplicate,
        );
        continue;
      }
      addChange(
        {
          op: "create_profile_name",
          entity: "profile_names",
          clientRef: IMPORT_REF.name + name.nameId,
          fields: {
            ...Object.fromEntries(
              Object.entries(nameFields).filter(([, value]) => value !== null),
            ),
            ...(mappedProfile
              ? { person_id: mappedProfile.websiteId }
              : { person_ref: IMPORT_REF.profile + name.profileId }),
          },
        } as SyncChange,
        origin,
      );
      rows.push({
        kind: "name",
        key: name.nameId,
        line: name.line,
        label: name.publishedName,
        action: "add",
        visibility: "private_pending_review",
      });
      continue;
    }
    const current = nameRows.get(mappedName.websiteId);
    if (!current) {
      blockedRow(
        "The mapped Website name no longer exists.",
        "mapped_record_missing",
        mappedName.websiteId,
      );
      continue;
    }
    const visibility: ImportVisibility =
      current.public_display === 1 ? "stays_public" : "stays_private";
    const base = {
      kind: "name" as const,
      key: name.nameId,
      line: name.line,
      label: name.publishedName,
      websiteId: mappedName.websiteId,
      visibility,
    };
    if (current.removed_at !== null) {
      rows.push({
        ...base,
        action: "conflict",
        reason:
          "The name was removed on the Website. It stays removed. Restore it in the Names editor first.",
      });
      continue;
    }
    if (mappedProfile && current.person_id !== mappedProfile.websiteId) {
      rows.push({
        ...base,
        action: "conflict",
        reason:
          "A name cannot move to another Profile through import. The Website value is kept.",
      });
      continue;
    }
    const diffs: {
      field: string;
      current: string | null;
      proposed: string | null;
    }[] = [];
    for (const [field, proposed] of Object.entries(nameFields)) {
      const now_ = (current as unknown as Record<string, string | null>)[field];
      if ((now_ ?? null) !== proposed)
        diffs.push({ field, current: now_ ?? null, proposed });
    }
    if (diffs.length === 0) {
      rows.push({ ...base, action: "unchanged" });
    } else if (current.public_display === 1) {
      rows.push({
        ...base,
        action: "conflict",
        reason:
          "This name is public. A change to it goes through the owner's Names editor and its review. The public value is kept.",
        fields: diffs,
      });
    } else if (current.version === mappedName.baselineVersion) {
      addChange(
        {
          op: "update_record",
          entity: "profile_names",
          targetId: mappedName.websiteId,
          expectedVersion: current.version,
          fields: Object.fromEntries(diffs.map((d) => [d.field, d.proposed])),
        } as SyncChange,
        origin,
        updates,
      );
      updateOrigins.push(origin);
      rows.push({ ...base, action: "update", fields: diffs });
    } else {
      rows.push({
        ...base,
        action: "conflict",
        reason:
          "The name was edited or reviewed on the Website after the last import. The Website value is kept.",
        fields: diffs,
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
    const mappedRole = mapOf(IMPORT_REF.role, role.roleId);
    if (!mappedRole) {
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
            ...(mappedProfile
              ? { person_id: mappedProfile.websiteId }
              : { person_ref: IMPORT_REF.profile + role.profileId }),
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
      field: "start_date" | "end_date";
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
    ...(readdProfileId ? { readdProfileId } : {}),
    files: [
      await sha256Hex(files.profile),
      await sha256Hex(files.profileRole ?? ""),
      await sha256Hex(files.profileName ?? ""),
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
    const dryRun = await planSyncChangesetD1(db, request, now, undefined, {
      maxRequestBytes,
      allowRolesWithoutSource: true,
    });
    for (const error of dryRun.errors) issues.push(issueFor(error, allOrigins));
  }

  const counts = (kind: "profile" | "role" | "name"): ProfilesImportCounts => {
    const c = emptyCounts();
    for (const row of rows) if (row.kind === kind) c[row.action]++;
    return c;
  };
  const deletedRows = rows.filter((row) => row.deletedOnWebsite).length;
  if (deletedRows > 0)
    notes.push(
      `${deletedRows} rows marked Deleted on Website will be omitted.`,
    );
  const profileCounts = counts("profile");
  const roleCounts = counts("role");
  const nameCounts = counts("name");
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
      ...(r.deletedOnWebsite ? [true] : []),
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
    (a, b) =>
      Number(!!b.deletedOnWebsite) - Number(!!a.deletedOnWebsite) ||
      order[a.action] - order[b.action] ||
      a.line - b.line,
  );
  return {
    preview: {
      contract: PROFILES_IMPORT_CONTRACT,
      digest,
      canCommit: issues.length === 0,
      profiles: profileCounts,
      roles: roleCounts,
      sources: emptyCounts(),
      names: nameCounts,
      newProfilesHidden: profileCounts.add,
      newNamesPrivate: nameCounts.add,
      namesPublishRequested,
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
        : origin?.kind === "name"
          ? NAME_FILE
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
  const created = {
    profiles: 0,
    roles: 0,
    sources: 0,
    reusedSources: 0,
    names: 0,
  };
  const updated = { profiles: 0, roles: 0, names: 0 };
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
    else if (item.entity === "profile_names" && item.outcome === "created")
      created.names++;
    else if (item.entity === "profile_names" && item.outcome === "updated")
      updated.names++;
  }
  return {
    status: "committed",
    batchId: result.batchId,
    committedAt: result.committedAt,
    replayed,
    created,
    updated,
    newNamesPrivate: created.names,
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
    created: { profiles: 0, roles: 0, sources: 0, reusedSources: 0, names: 0 },
    updated: { profiles: 0, roles: 0, names: 0 },
    newNamesPrivate: 0,
    newProfilesHidden: 0,
    createdProfiles: [],
  };
}

import {
  ALTERNATE_NAME_STATUSES,
  ALTERNATE_NAME_TYPES,
  type AlternateNameChange,
  type AlternateNameFields,
  type AlternateNameList,
  type AlternateNameRecord,
  type MatchingProfileVisibilityPreview,
  type MatchingProfileVisibilityReceipt,
  PROFILE_FIELDS,
  PROFILE_NO_COUNTY,
  PROFILE_NAME_COMPONENT_COLUMNS,
  PROFILE_SORT_FIELDS,
  PROFILES_DEFAULT_PAGE_SIZE,
  PROFILES_MAX_CHANGES,
  PROFILES_MAX_NAME_AFFIX_LENGTH,
  PROFILES_MAX_NAME_COMPONENT_LENGTH,
  PROFILES_MAX_NAME_LENGTH,
  PROFILES_MAX_PAGE,
  PROFILES_MAX_PAGE_SIZE,
  PROFILES_MAX_QUERY_LENGTH,
  PROFILES_MAX_SELECT_ALL,
  type ProfileChange,
  type ProfileChangeIssue,
  type ProfileFacets,
  type ProfileImpact,
  type ProfileNameReview,
  type ProfilePage,
  type ProfilePreview,
  type ProfilePreviewItem,
  type ProfileQuery,
  type ProfileRow,
  type ProfileSaveResult,
  type ProfileSelectionEntry,
  type ProfileUnitLink,
  type ProfileUnitLinkPreview,
  type ProfileUnitLinkReceipt,
  type ProfileUnitSuggestions,
} from "../contracts/profiles.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { assertCredentialFree } from "./audit.js";
import {
  createProfileUnitLinks,
  readProfileUnitLinks,
} from "./profile-unit-links.js";
import { createProfilesDelete } from "./profiles-delete-d1.js";
import { AuthorizationError, type TrustedPrincipal } from "./security.js";
import { IMPORTER_BATCH_KEY_PREFIX } from "./sync-commit-d1.js";
import { SYNC_UPDATE_FIELDS } from "./sync-planner.js";

/**
 * Owner Profiles sheet service over the asynchronous Website D1 (PROFILES-1).
 *
 * Reads are bounded, server-side sorted, filtered and paged over the whole
 * dataset. Writes are staged by the browser and committed here in one atomic
 * `guardedBatch`: every changed row is guarded by its expected version, the
 * audit events and the retry-safe receipt are part of the same batch, and a
 * stale target aborts everything so nothing is half applied.
 *
 * Field writes use a fixed entity and column allowlist that must also be
 * inside the Profiles sync allowlist, so this module can never write a field a
 * reviewed sync could not. Visibility is stored apart from the people row, so
 * hiding or restoring a Profile never advances `people.version`.
 */
export class ProfilesValidationError extends Error {
  constructor(readonly issues: readonly ProfileChangeIssue[]) {
    super("The Profiles changes are not valid");
    this.name = "ProfilesValidationError";
  }
}

export class ProfilesConflictError extends Error {
  constructor(readonly issues: readonly ProfileChangeIssue[]) {
    super("A Profile or role changed since it was read");
    this.name = "ProfilesConflictError";
  }
}

export class ProfilesIdempotencyError extends Error {
  constructor() {
    super("The idempotency key was already used for a different request");
    this.name = "ProfilesIdempotencyError";
  }
}

export class ProfilesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilesInputError";
  }
}

type Row = Record<string, unknown>;

/**
 * Writable columns. The reviewed sync can replace `display_name`, so that
 * column must stay inside the sync allowlist. The primary-name components are
 * Website-only until the Profiles import extends the sync allowlist, so no
 * sync reads or writes them and they are not asserted against it.
 */
const NAME_COMPONENT_WRITES = Object.values(
  PROFILE_NAME_COMPONENT_COLUMNS,
) as readonly string[];
const FIELD_WRITES: Readonly<
  Record<"people" | "person_roles", readonly string[]>
> = {
  people: ["display_name", ...NAME_COMPONENT_WRITES],
  person_roles: ["start_date", "end_date", "source_checked_at"],
};
for (const [entity, columns] of Object.entries(FIELD_WRITES)) {
  for (const column of columns) {
    if (entity === "people" && NAME_COMPONENT_WRITES.includes(column)) continue;
    if (!SYNC_UPDATE_FIELDS[entity]?.includes(column)) {
      throw new Error(`Profiles field ${entity}.${column} is not syncable`);
    }
  }
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  display_name: "Display Name",
  first_name: "First Name",
  middle_name: "Middle Name",
  last_name: "Last Name",
  preferred_first_name: "Preferred First Name",
  name_prefix: "Name Prefix",
  name_suffix: "Name Suffix",
  start_date: "Employment Start",
  end_date: "Employment End",
  source_checked_at: "Date Reviewed",
};

/** Optional components may be cleared. `display_name` is always required. */
const COMPONENT_LIMITS: Readonly<Record<string, number>> = {
  first_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  middle_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  last_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  preferred_first_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  name_prefix: PROFILES_MAX_NAME_AFFIX_LENGTH,
  name_suffix: PROFILES_MAX_NAME_AFFIX_LENGTH,
};

/** D1 caps a result set at 1000 rows. */
const PROFILES_NAME_LOAD_LIMIT = 1000;
/** Names one editor response carries. One more row is read to detect overflow. */
const PROFILES_NAME_PAGE_LIMIT = 500;

const COUNTY_EXPRESSION = "COALESCE(pr.county_fips, o.county_fips)";
const OFFICE_EXPRESSION = "COALESCE(pr.published_office, o.name)";
const POSITION_EXPRESSION = "COALESCE(pr.published_title, pos.title)";

/**
 * Last Uploaded: the commit time of the latest dashboard Profiles import
 * (`pi:` batch, committed, not reversed) that created or updated the Profile,
 * one of its roles or one of its alternate names. Previews, failed commits,
 * same-key retries and unchanged rows write no created or updated item, so
 * they never move the date.
 */
const LAST_UPLOAD_SQL = `
  SELECT person_id, MAX(committed_at) AS last_uploaded FROM (
    SELECT CASE i.entity
             WHEN 'people' THEN i.target_id
             WHEN 'person_roles' THEN (SELECT ur.person_id FROM person_roles ur WHERE ur.id = i.target_id)
             WHEN 'profile_names' THEN (SELECT un.person_id FROM profile_names un WHERE un.id = i.target_id)
           END AS person_id,
           b.committed_at
    FROM sync_batch_items i
    JOIN sync_batches b ON b.id = i.batch_id
    LEFT JOIN sync_batch_reversals rv ON rv.batch_id = b.id
    WHERE rv.batch_id IS NULL AND b.status = 'committed'
      AND substr(b.idempotency_key, 1, ${IMPORTER_BATCH_KEY_PREFIX.length}) = '${IMPORTER_BATCH_KEY_PREFIX}'
      AND i.outcome IN ('created', 'updated')
      AND i.entity IN ('people', 'person_roles', 'profile_names')
  ) WHERE person_id IS NOT NULL GROUP BY person_id`;

/** Publication rule (migration 0037): the one definition is the view. */
const READY_SQL =
  "EXISTS (SELECT 1 FROM profile_publication_ready rd WHERE rd.person_id = p.id)";
const ROLE_COUNTY_SQL = `(COALESCE(xr.county_fips, xo.county_fips) IS NOT NULL
  OR EXISTS (SELECT 1 FROM organization_county_affiliations xa WHERE xa.organization_id = xo.id))`;
const ROLE_DETAIL_SQL = `(xr.position_id IS NOT NULL OR xr.published_office IS NOT NULL
  OR xr.published_title IS NOT NULL OR xr.job_description IS NOT NULL)`;
const ROLE_FROM_SQL = `FROM person_roles xr
  LEFT JOIN positions xp ON xp.id = xr.position_id
  LEFT JOIN organizations xo ON xo.id = xp.organization_id
  WHERE xr.person_id = p.id`;
const READINESS_COLUMNS = `
  ${READY_SQL} AS publication_ready,
  (SELECT COUNT(*) FROM person_roles xr WHERE xr.person_id = p.id) AS role_count,
  EXISTS (SELECT 1 ${ROLE_FROM_SQL} AND ${ROLE_COUNTY_SQL}) AS any_county,
  EXISTS (SELECT 1 ${ROLE_FROM_SQL} AND ${ROLE_DETAIL_SQL}) AS any_detail`;

const ROLE_JOINS = `
  FROM people p
  LEFT JOIN person_roles pr ON pr.person_id = p.id
  LEFT JOIN person_visibility pv ON pv.person_id = p.id
  LEFT JOIN positions pos ON pos.id = pr.position_id
  LEFT JOIN organizations o ON o.id = pos.organization_id`;

const FROM_CLAUSE = `${ROLE_JOINS}
  LEFT JOIN (${LAST_UPLOAD_SQL}) lu ON lu.person_id = p.id
  LEFT JOIN organizations parent ON parent.id = o.parent_organization_id
  LEFT JOIN counties c ON c.fips = ${COUNTY_EXPRESSION}`;

const ALT_COUNT_SQL =
  "SELECT COUNT(*) FROM profile_names an WHERE an.person_id = p.id AND an.removed_at IS NULL";
const ALT_PENDING_SQL =
  "SELECT COUNT(*) FROM profile_names an WHERE an.person_id = p.id AND an.removed_at IS NULL AND an.verification_status = 'requires_review'";

const SORT_EXPRESSIONS: Readonly<Record<string, string>> = {
  profileId: "p.id",
  displayName: "p.display_name COLLATE NOCASE",
  firstName: "p.first_name COLLATE NOCASE",
  middleName: "p.middle_name COLLATE NOCASE",
  lastName: "p.last_name COLLATE NOCASE",
  preferredFirstName: "p.preferred_first_name COLLATE NOCASE",
  namePrefix: "p.name_prefix COLLATE NOCASE",
  nameSuffix: "p.name_suffix COLLATE NOCASE",
  alternateNameCount: `(${ALT_COUNT_SQL})`,
  visible: "COALESCE(pv.visible, 1)",
  createdOn: "p.created_at",
  lastUploaded: "lu.last_uploaded",
  county: "c.name COLLATE NOCASE",
  officeDepartment: `${OFFICE_EXPRESSION} COLLATE NOCASE`,
  position: `${POSITION_EXPRESSION} COLLATE NOCASE`,
  employmentStart: "pr.start_date",
  employmentEnd: "pr.end_date",
  dateReviewed: "pr.source_checked_at",
  roleId: "pr.id",
};

const ROW_COLUMNS = `
  pr.id AS role_id, p.id AS profile_id, p.version AS profile_version,
  pr.version AS role_version, COALESCE(pv.version, 0) AS visibility_version,
  p.display_name, p.first_name, p.middle_name, p.last_name,
  p.preferred_first_name, p.name_prefix, p.name_suffix,
  (${ALT_COUNT_SQL}) AS alternate_name_count,
  (${ALT_PENDING_SQL}) AS alternate_names_pending,
  COALESCE(pv.visible, 1) AS visible, p.created_at AS created_on,
  pv.hidden_reason, lu.last_uploaded, ${READINESS_COLUMNS},
  ${COUNTY_EXPRESSION} AS county_fips, c.name AS county,
  parent.name AS county_unit,
  CASE WHEN parent.id IS NOT NULL THEN o.name END AS county_sub_unit,
  ${OFFICE_EXPRESSION} AS office, ${POSITION_EXPRESSION} AS position,
  pr.job_description, pr.start_date, pr.end_date,
  CASE WHEN o.id IS NULL THEN NULL
       ELSE COALESCE(
         (SELECT GROUP_CONCAT(relationship_type, ', ') FROM (
            SELECT relationship_type FROM organization_county_affiliations a
            WHERE a.organization_id = o.id AND a.county_fips = ${COUNTY_EXPRESSION}
            ORDER BY relationship_type)
         ),
         CASE WHEN o.county_fips IS NOT NULL THEN 'direct' END) END AS affiliation,
  pr.source_checked_at, pr.created_at AS role_created_on,
  pr.updated_at AS role_updated_on, p.updated_at AS profile_updated_on`;

export interface ProfilesServiceOptions {
  /** Must resolve true only for a current principal holding `profile.manage`. */
  readonly authorize: (principal: TrustedPrincipal) => Promise<boolean>;
  readonly now?: () => Date;
}

export interface ProfilesService
  extends ReturnType<typeof createProfilesDelete> {
  listRows(principal: TrustedPrincipal, input: unknown): Promise<ProfilePage>;
  suggestUnits(
    principal: TrustedPrincipal,
    input: unknown,
  ): Promise<ProfileUnitSuggestions>;
  linkSuggestedUnit(
    principal: TrustedPrincipal,
    key: string,
    input: unknown,
  ): Promise<ProfileUnitLinkReceipt>;
  previewUnitLinks(
    principal: TrustedPrincipal,
    input: unknown,
  ): Promise<ProfileUnitLinkPreview>;
  commitUnitLinks(
    principal: TrustedPrincipal,
    key: string,
    input: unknown,
  ): Promise<ProfileUnitLinkReceipt>;
  facets(
    principal: TrustedPrincipal,
    after?: string | null,
  ): Promise<ProfileFacets>;
  selectAll(
    principal: TrustedPrincipal,
    input: unknown,
  ): Promise<{
    readonly entries: readonly ProfileSelectionEntry[];
    readonly truncated: boolean;
  }>;
  previewMatchingVisibility(
    principal: TrustedPrincipal,
    input: unknown,
  ): Promise<MatchingProfileVisibilityPreview>;
  saveMatchingVisibility(
    principal: TrustedPrincipal,
    idempotencyKey: string,
    input: unknown,
  ): Promise<MatchingProfileVisibilityReceipt>;
  /** Every alternate name of one Profile, removed ones included and flagged. */
  alternateNames(
    principal: TrustedPrincipal,
    profileId: string,
  ): Promise<AlternateNameList | null>;
  preview(
    principal: TrustedPrincipal,
    changes: unknown,
  ): Promise<ProfilePreview>;
  save(
    principal: TrustedPrincipal,
    idempotencyKey: string,
    changes: unknown,
  ): Promise<ProfileSaveResult>;
}

export function createD1ProfilesService(
  database: AsyncD1Database,
  options: ProfilesServiceOptions,
): ProfilesService {
  const now = options.now ?? (() => new Date());
  const unitLinks = createProfileUnitLinks(database);

  async function require(principal: TrustedPrincipal): Promise<void> {
    let allowed = false;
    try {
      allowed =
        principal.kind === "human" &&
        (await options.authorize(principal)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new AuthorizationError();
  }

  function filterClause(query: ProfileQuery): {
    readonly where: string;
    readonly values: (string | number)[];
  } {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (query.query) {
      const pattern = `%${query.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      conditions.push(
        `(p.display_name LIKE ? ESCAPE '\\'
          OR p.first_name LIKE ? ESCAPE '\\'
          OR p.last_name LIKE ? ESCAPE '\\'
          OR p.preferred_first_name LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM profile_names sn
            WHERE sn.person_id = p.id AND sn.removed_at IS NULL
              AND (sn.published_name LIKE ? ESCAPE '\\'
                   OR sn.first_name LIKE ? ESCAPE '\\'
                   OR sn.last_name LIKE ? ESCAPE '\\'))
          OR ${OFFICE_EXPRESSION} LIKE ? ESCAPE '\\'
          OR ${POSITION_EXPRESSION} LIKE ? ESCAPE '\\'
          OR pr.job_description LIKE ? ESCAPE '\\')`,
      );
      values.push(
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      );
    }
    if (query.countyFips === PROFILE_NO_COUNTY) {
      conditions.push(`${COUNTY_EXPRESSION} IS NULL`);
    } else if (query.countyFips) {
      conditions.push(`${COUNTY_EXPRESSION} = ?`);
      values.push(query.countyFips);
    }
    if (query.office) {
      conditions.push(`${OFFICE_EXPRESSION} = ?`);
      values.push(query.office);
    }
    if (query.visibility === "visible")
      conditions.push("COALESCE(pv.visible, 1) = 1");
    if (query.visibility === "hidden")
      conditions.push("COALESCE(pv.visible, 1) = 0");
    if (query.visibility === "incomplete") conditions.push(`NOT ${READY_SQL}`);
    if (query.unitLink === "unlinked" || query.unitLink === "linked") {
      conditions.push(`pr.id IS NOT NULL AND ${query.unitLink === "unlinked" ? "NOT " : ""}EXISTS (
        SELECT 1 FROM county_role_display d WHERE d.person_role_id = pr.id AND d.listing = 'home'
      )`);
    }
    return {
      where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
      values,
    };
  }

  function orderClause(query: ProfileQuery): string {
    const expression =
      SORT_EXPRESSIONS[query.sort] ?? SORT_EXPRESSIONS.displayName;
    const direction = query.direction === "desc" ? "DESC" : "ASC";
    return `ORDER BY ${expression} ${direction}, p.id COLLATE BINARY ASC, pr.id COLLATE BINARY ASC`;
  }

  function toRow(
    row: Row,
    unitLink: ProfileUnitLink | null = null,
  ): ProfileRow {
    const roleId = nullable(row.role_id);
    const missing = missingForPublication(row);
    const visible = num(row.visible) === 1;
    return {
      rowKey: roleId ?? `profile:${str(row.profile_id)}`,
      roleId,
      profileId: str(row.profile_id),
      profileVersion: num(row.profile_version),
      roleVersion: roleId ? num(row.role_version) : 0,
      visibilityVersion: num(row.visibility_version),
      displayName: str(row.display_name),
      firstName: nullable(row.first_name),
      middleName: nullable(row.middle_name),
      lastName: nullable(row.last_name),
      preferredFirstName: nullable(row.preferred_first_name),
      namePrefix: nullable(row.name_prefix),
      nameSuffix: nullable(row.name_suffix),
      alternateNameCount: num(row.alternate_name_count),
      alternateNamesPendingReview: num(row.alternate_names_pending),
      nameReview: nameReview(row),
      visible,
      publicationReady: missing.length === 0,
      missingForPublication: missing,
      hiddenReason: row.hidden_reason === "incomplete" ? "incomplete" : null,
      publicationStatus: publicationStatus(visible, missing, row.hidden_reason),
      createdOn: str(row.created_on),
      lastUploaded: nullable(row.last_uploaded),
      countyFips: nullable(row.county_fips),
      county: nullable(row.county),
      countyUnit: nullable(row.county_unit),
      countySubUnit: nullable(row.county_sub_unit),
      officeDepartment: nullable(row.office),
      unitLink,
      position: nullable(row.position),
      roleDuties: nullable(row.job_description),
      employmentStart: nullable(row.start_date),
      employmentEnd: nullable(row.end_date),
      affiliation: nullable(row.affiliation),
      dateReviewed: nullable(row.source_checked_at),
      roleCreatedOn: nullable(row.role_created_on),
      roleUpdatedOn: nullable(row.role_updated_on),
      profileUpdatedOn: str(row.profile_updated_on),
    };
  }

  async function loadFieldTargets(changes: readonly ProfileChange[]): Promise<{
    people: Map<string, Row>;
    roles: Map<string, Row>;
    visibility: Map<string, Row>;
    impact: Map<string, { roles: number; counties: string[] }>;
    altNames: Map<string, Row>;
    altByPerson: Map<string, Row[]>;
  }> {
    const personIds = new Set<string>();
    const roleIds = new Set<string>();
    const visibilityIds = new Set<string>();
    const altPersonIds = new Set<string>();
    const altNameIds = new Set<string>();
    for (const change of changes) {
      if (change.kind === "visibility") visibilityIds.add(change.personId);
      else if (change.kind === "alternate_name") {
        altPersonIds.add(change.personId);
        if (change.op !== "add") altNameIds.add(change.nameId);
      } else if (change.entity === "people") personIds.add(change.targetId);
      else roleIds.add(change.targetId);
    }
    const people = new Map<string, Row>();
    const roles = new Map<string, Row>();
    const visibility = new Map<string, Row>();
    const impact = new Map<string, { roles: number; counties: string[] }>();
    if (roleIds.size) {
      const rows = await database.all<Row>(
        `SELECT r.id, r.person_id, r.start_date, r.end_date, r.source_checked_at,
                r.version FROM person_roles r
         WHERE r.id IN (SELECT value FROM json_each(?))`,
        PROFILES_MAX_CHANGES + 1,
        [JSON.stringify([...roleIds])],
      );
      for (const row of rows) roles.set(str(row.id), row);
    }
    const profileIds = new Set<string>([
      ...personIds,
      ...visibilityIds,
      ...altPersonIds,
    ]);
    if (profileIds.size) {
      const list = JSON.stringify([...profileIds]);
      const rows = await database.all<Row>(
        `SELECT p.id, p.display_name, p.first_name, p.middle_name, p.last_name,
                p.preferred_first_name, p.name_prefix, p.name_suffix, p.version,
                COALESCE(pv.visible, 1) AS visible,
                COALESCE(pv.version, 0) AS visibility_version,
                ${READINESS_COLUMNS}
         FROM people p LEFT JOIN person_visibility pv ON pv.person_id = p.id
         WHERE p.id IN (SELECT value FROM json_each(?))`,
        PROFILES_MAX_CHANGES + 1,
        [list],
      );
      for (const row of rows) {
        people.set(str(row.id), row);
        visibility.set(str(row.id), row);
      }
      const counts = await database.all<Row>(
        `SELECT r.person_id, COUNT(*) AS roles,
                GROUP_CONCAT(DISTINCT c.name) AS counties
         FROM person_roles r
         LEFT JOIN positions ps ON ps.id = r.position_id
         LEFT JOIN organizations o ON o.id = ps.organization_id
         LEFT JOIN counties c ON c.fips = COALESCE(r.county_fips, o.county_fips)
         WHERE r.person_id IN (SELECT value FROM json_each(?))
         GROUP BY r.person_id`,
        PROFILES_MAX_CHANGES + 1,
        [list],
      );
      for (const row of counts)
        impact.set(str(row.person_id), {
          roles: num(row.roles),
          counties: nullable(row.counties)?.split(",").sort() ?? [],
        });
    }
    const altNames = new Map<string, Row>();
    const altByPerson = new Map<string, Row[]>();
    if (altPersonIds.size) {
      const rows = await database.all<Row>(
        `SELECT id, person_id, name_type, first_name, middle_name, last_name,
                name_prefix, name_suffix, published_name, applies_from,
                applies_until, verification_status, public_display,
                removed_at, version
         FROM profile_names WHERE person_id IN (SELECT value FROM json_each(?))
         ORDER BY person_id, id LIMIT ${PROFILES_NAME_LOAD_LIMIT}`,
        PROFILES_NAME_LOAD_LIMIT,
        [JSON.stringify([...altPersonIds])],
      );
      for (const row of rows) {
        altNames.set(str(row.id), row);
        const list = altByPerson.get(str(row.person_id)) ?? [];
        list.push(row);
        altByPerson.set(str(row.person_id), list);
      }
      // A name the load cap cut off is still read by ID for its own change.
      const missing = [...altNameIds].filter((id) => !altNames.has(id));
      if (missing.length) {
        const extra = await database.all<Row>(
          `SELECT id, person_id, name_type, first_name, middle_name, last_name,
                  name_prefix, name_suffix, published_name, applies_from,
                  applies_until, verification_status, public_display,
                  removed_at, version
           FROM profile_names WHERE id IN (SELECT value FROM json_each(?))`,
          PROFILES_MAX_CHANGES + 1,
          [JSON.stringify(missing)],
        );
        for (const row of extra) altNames.set(str(row.id), row);
      }
    }
    return {
      people,
      roles,
      visibility,
      impact,
      altNames,
      altByPerson,
    };
  }

  async function validate(input: unknown): Promise<{
    readonly changes: readonly ProfileChange[];
    readonly preview: ProfilePreview;
    readonly stale: readonly ProfileChangeIssue[];
    readonly targets: AlternateTargets | null;
  }> {
    const parsed = parseChanges(input);
    if (parsed.issues.length)
      return {
        changes: [],
        preview: { ok: false, items: [], issues: parsed.issues },
        stale: [],
        targets: null,
      };
    const changes = parsed.changes;
    const targets = await loadFieldTargets(changes);
    const issues: ProfileChangeIssue[] = [];
    const stale: ProfileChangeIssue[] = [];
    const items: ProfilePreviewItem[] = [];
    // Merge the proposed role dates so the order check sees the final state.
    const proposed = new Map<string, Record<string, string | null>>();
    for (const change of changes) {
      if (change.kind === "field" && change.entity === "person_roles") {
        const current = proposed.get(change.targetId) ?? {};
        current[change.field] = change.value;
        proposed.set(change.targetId, current);
      }
    }
    // The display name each Profile ends with, so publication is checked
    // against the final state of a combined edit.
    const finalDisplayName = new Map<string, string>();
    for (const change of changes)
      if (
        change.kind === "field" &&
        change.entity === "people" &&
        change.field === "display_name"
      )
        finalDisplayName.set(change.targetId, change.value ?? "");
    const duplicateIssues = alternateDuplicateIssues(changes, targets);
    const checkedAt = now();
    changes.forEach((change, index) => {
      if (change.kind === "alternate_name") {
        validateAlternate(
          change,
          index,
          targets,
          duplicateIssues.get(index),
          issues,
          stale,
          items,
        );
        return;
      }
      if (change.kind === "visibility") {
        const row = targets.visibility.get(change.personId);
        if (!row) {
          issues.push(
            issue(index, "not_found", "That Profile no longer exists."),
          );
          return;
        }
        const current = num(row.visible) === 1;
        const currentVersion = num(row.visibility_version);
        if (currentVersion !== change.expectedVersion) {
          const entry = {
            ...issue(
              index,
              "stale_version",
              "Visibility changed since it was read.",
            ),
            currentVersion,
            currentValue: current,
          };
          issues.push(entry);
          stale.push(entry);
          return;
        }
        if (current === change.visible) {
          issues.push(
            issue(
              index,
              "no_change",
              change.visible
                ? "The Profile is already visible."
                : "The Profile is already hidden.",
            ),
          );
          return;
        }
        const missing = missingForPublication(row);
        const finalName = finalDisplayName.get(change.personId);
        if (finalName !== undefined && finalName.trim() === "")
          missing.unshift("display name");
        if (change.visible && missing.length > 0) {
          issues.push(
            issue(
              index,
              "not_eligible",
              `This Profile cannot be visible yet. Missing ${missing.join(", ")}. A Profile needs a display name and at least one role with a county and an office, position or duties.`,
            ),
          );
          return;
        }
        const detail = targets.impact.get(change.personId) ?? {
          roles: 0,
          counties: [],
        };
        items.push({
          index,
          label: "Visible on Website",
          field: "visible",
          targetId: change.personId,
          before: current,
          after: change.visible,
          impact: {
            shared: true,
            profileId: change.personId,
            roleRows: detail.roles,
            counties: detail.counties,
            summary: change.visible
              ? `Restores this Profile and its ${detail.roles} role ${plural(detail.roles, "row")} to public directories, search, listings, county counts and its own page.`
              : `Removes this Profile and its ${detail.roles} role ${plural(detail.roles, "row")} from public directories, search, listings and county counts. Its own page and API answer 404.`,
          },
        });
        return;
      }
      const label = FIELD_LABELS[change.field] ?? change.field;
      if (change.entity === "people") {
        const row = targets.people.get(change.targetId);
        if (!row) {
          issues.push(
            issue(index, "not_found", "That Profile no longer exists."),
          );
          return;
        }
        const currentVersion = num(row.version);
        const currentValue = nullable(row[change.field]);
        if (currentVersion !== change.expectedVersion) {
          const entry = {
            ...issue(
              index,
              "stale_version",
              `${label} changed since it was read.`,
            ),
            currentVersion,
            currentValue,
          };
          issues.push(entry);
          stale.push(entry);
          return;
        }
        const required = change.field === "display_name";
        const limit = required
          ? PROFILES_MAX_NAME_LENGTH
          : (COMPONENT_LIMITS[change.field] ?? 0);
        const value = change.value === null ? "" : change.value.trim();
        if (
          (required && !value) ||
          value.length > limit ||
          // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
          /[\u0000-\u001f\u007f]/.test(value)
        ) {
          issues.push(
            issue(
              index,
              "invalid_value",
              required
                ? `${label} must be 1 to ${limit} characters with no control characters.`
                : `${label} must be at most ${limit} characters with no control characters, or blank.`,
            ),
          );
          return;
        }
        const normalized = value === "" ? null : value;
        if (normalized === currentValue) {
          issues.push(issue(index, "no_change", `${label} is unchanged.`));
          return;
        }
        const detail = targets.impact.get(change.targetId) ?? {
          roles: 0,
          counties: [],
        };
        const where = `${detail.roles} role ${plural(detail.roles, "row")}${
          detail.counties.length ? ` in ${detail.counties.join(", ")}` : ""
        }`;
        items.push({
          index,
          label,
          field: change.field,
          targetId: change.targetId,
          before: currentValue,
          after: normalized,
          impact: {
            shared: true,
            profileId: change.targetId,
            roleRows: detail.roles,
            counties: detail.counties,
            summary: required
              ? `The display name is shared by this Profile's ${where} and by every public page that shows the person. The private reviewed Profiles record is not changed.`
              : `This is a person-level name part shared by this Profile's ${where}. It changes the Profile, never one role row, and does not change the display name or any public page. The private reviewed Profiles record is not changed.`,
          },
        });
        return;
      }
      const row = targets.roles.get(change.targetId);
      if (!row) {
        issues.push(issue(index, "not_found", "That role no longer exists."));
        return;
      }
      const currentVersion = num(row.version);
      const currentValue = nullable(row[change.field]);
      if (currentVersion !== change.expectedVersion) {
        const entry = {
          ...issue(
            index,
            "stale_version",
            `${label} changed since it was read.`,
          ),
          currentVersion,
          currentValue,
        };
        issues.push(entry);
        stale.push(entry);
        return;
      }
      const value = change.value === null ? null : change.value.trim();
      if (change.field === "source_checked_at") {
        if (value !== null && !validDate(value) && !validUtc(value)) {
          issues.push(
            issue(
              index,
              "invalid_value",
              `${label} must be a date such as 2026-03-14, or blank.`,
            ),
          );
          return;
        }
        if (value && Date.parse(value) > checkedAt.getTime() + 300_000) {
          issues.push(
            issue(index, "invalid_value", `${label} cannot be in the future.`),
          );
          return;
        }
      } else if (value !== null && !validDate(value)) {
        issues.push(
          issue(
            index,
            "invalid_value",
            `${label} must be a date such as 2026-03-14, or blank.`,
          ),
        );
        return;
      }
      const merged = proposed.get(change.targetId) ?? {};
      const start =
        "start_date" in merged ? merged.start_date : nullable(row.start_date);
      const end =
        "end_date" in merged ? merged.end_date : nullable(row.end_date);
      if (
        (change.field === "start_date" || change.field === "end_date") &&
        start &&
        end &&
        validDate(start) &&
        validDate(end) &&
        end < start
      ) {
        issues.push(
          issue(
            index,
            "date_order",
            "Employment End cannot be before Employment Start.",
          ),
        );
        return;
      }
      if (value === currentValue) {
        issues.push(issue(index, "no_change", `${label} is unchanged.`));
        return;
      }
      items.push({
        index,
        label,
        field: change.field,
        targetId: change.targetId,
        before: currentValue,
        after: value,
        impact: {
          shared: false,
          profileId: nullable(row.person_id),
          roleRows: 1,
          counties: [],
          summary:
            "Changes this one role row only. The person's other roles are not touched.",
        },
      });
    });
    return {
      changes,
      preview: { ok: issues.length === 0, items, issues },
      stale,
      targets,
    };
  }

  async function savedResult<Result = ProfileSaveResult>(
    actorId: string,
    key: string,
  ): Promise<{ fingerprint: string; response: Result } | null> {
    const row = await database.first<Row>(
      `SELECT request_fingerprint, response_json FROM profile_write_receipts
       WHERE actor_account_id = ? AND idempotency_key = ?`,
      [actorId, key],
    );
    if (!row) return null;
    return {
      fingerprint: str(row.request_fingerprint),
      response: JSON.parse(str(row.response_json)) as Result,
    };
  }

  function readVisibilityScope(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ProfilesInputError(
        "Choose the matching Profiles and visibility.",
      );
    const { filters, visible, digest } = input as Record<string, unknown>;
    if (
      !filters ||
      typeof filters !== "object" ||
      Array.isArray(filters) ||
      Object.keys(filters).some(
        (key) =>
          !["query", "county", "office", "visibility", "unitLink"].includes(
            key,
          ),
      ) ||
      typeof visible !== "boolean"
    )
      throw new ProfilesInputError("Choose valid filters and visibility.");
    return { query: parseQuery(filters), visible, digest };
  }

  function matchingProfiles(query: ProfileQuery) {
    const { where, values } = filterClause(query);
    // The grid is one row per role. Deduplicate before counting or changing
    // Profiles, without paging or depending on the display order.
    return {
      sql: `SELECT DISTINCT p.id AS person_id ${FROM_CLAUSE} ${where}`,
      values,
    };
  }

  async function reviewMatchingVisibility(
    query: ProfileQuery,
    visible: boolean,
  ) {
    const { sql, values } = matchingProfiles(query);
    const row = await database.first<Row>(
      `WITH matching AS (${sql})
       SELECT (SELECT generation FROM website_dependency_generation WHERE id = 1) AS generation,
              (SELECT COUNT(*) FROM profile_write_receipts) AS profile_writes,
              COUNT(*) AS matched,
              COUNT(CASE WHEN COALESCE(v.visible, 1) = ?
                         AND (? = 0 OR ready.person_id IS NOT NULL) THEN 1 END) AS already_set,
              COUNT(CASE WHEN ? = 1 AND ready.person_id IS NULL THEN 1 END) AS incomplete
       FROM matching m
       LEFT JOIN person_visibility v ON v.person_id = m.person_id
       LEFT JOIN profile_publication_ready ready ON ready.person_id = m.person_id`,
      [...values, Number(visible), Number(visible), Number(visible)],
    );
    const generation = row?.generation;
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    )
      throw new StorageUnavailableError();
    const matched = num(row?.matched);
    const profileWrites = num(row?.profile_writes);
    const alreadySet = num(row?.already_set);
    const incomplete = num(row?.incomplete);
    const digest = await sha256Hex(
      JSON.stringify([
        "matching-profile-visibility",
        query,
        visible,
        generation,
        profileWrites,
        matched,
        alreadySet,
        incomplete,
      ]),
    );
    return {
      generation,
      profileWrites,
      preview: {
        matched,
        alreadySet,
        incomplete,
        willChange: matched - alreadySet - incomplete,
        digest,
      },
    };
  }

  function visibilityScopeChanged(): ProfilesConflictError {
    return new ProfilesConflictError([
      issue(
        0,
        "stale_version",
        "The Website changed since this preview. Review the matching Profiles again.",
      ),
    ]);
  }

  function unitLinkScope(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ProfilesInputError("Choose the matching role rows.");
    const { filters, digest } = input as Record<string, unknown>;
    if (
      !filters ||
      typeof filters !== "object" ||
      Array.isArray(filters) ||
      Object.keys(filters).some(
        (key) =>
          !["query", "county", "office", "visibility", "unitLink"].includes(
            key,
          ),
      )
    )
      throw new ProfilesInputError("Choose valid role filters.");
    const { where, values } = filterClause(parseQuery(filters));
    return {
      digest,
      scope: {
        sql: `SELECT pr.id AS role_id, ${COUNTY_EXPRESSION} AS county_fips,
         ${OFFICE_EXPRESSION} AS office ${ROLE_JOINS}
         ${where ? `${where} AND` : "WHERE"} pr.id IS NOT NULL`,
        values,
      },
    };
  }

  return {
    ...createProfilesDelete(database, require, now),
    async suggestUnits(principal, input) {
      await require(principal);
      const { roleId } = (input ?? {}) as Record<string, unknown>;
      if (typeof roleId !== "string" || !ID.test(roleId))
        throw new ProfilesInputError("Choose a role.");
      return unitLinks.suggest(principal, roleId);
    },
    async linkSuggestedUnit(principal, key, input) {
      await require(principal);
      const { roleId, unitId, digest } = (input ?? {}) as Record<
        string,
        unknown
      >;
      if (
        typeof roleId !== "string" ||
        !ID.test(roleId) ||
        typeof unitId !== "string" ||
        !ID.test(unitId) ||
        typeof digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(digest) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(key)
      )
        throw new ProfilesInputError(
          "A reviewed suggestion and idempotency key are required.",
        );
      return unitLinks.choose(principal, roleId, unitId, digest, key);
    },
    async previewUnitLinks(principal, input) {
      await require(principal);
      return unitLinks.preview(principal, unitLinkScope(input).scope);
    },
    async commitUnitLinks(principal, key, input) {
      await require(principal);
      const { digest, scope } = unitLinkScope(input);
      if (
        typeof digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(digest) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(key)
      )
        throw new ProfilesInputError(
          "An exact match preview and idempotency key are required.",
        );
      return unitLinks.commit(principal, scope, digest, key);
    },
    async listRows(principal, input) {
      await require(principal);
      const query = parseQuery(input);
      const { where, values } = filterClause(query);
      const countRow = await database.first<Row>(
        `SELECT COUNT(*) AS total ${FROM_CLAUSE} ${where}`,
        values,
      );
      const total = num(countRow?.total);
      const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, lastPage);
      const rows = await database.all<Row>(
        `SELECT ${ROW_COLUMNS} ${FROM_CLAUSE} ${where} ${orderClause(query)}
         LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}`,
        query.pageSize,
        values,
      );
      const links = await readProfileUnitLinks(
        database,
        rows.flatMap((row) =>
          typeof row.role_id === "string"
            ? [
                {
                  roleId: row.role_id,
                  countyFips: nullable(row.county_fips),
                  office: nullable(row.office),
                },
              ]
            : [],
        ),
      );
      return {
        rows: rows.map((row) =>
          toRow(row, links.get(str(row.role_id)) ?? null),
        ),
        total,
        page,
        pageSize: query.pageSize,
        lastPage,
      };
    },
    async facets(principal, after) {
      await require(principal);
      let cursor: [string, string] = ["", ""];
      if (after !== null && after !== undefined) {
        try {
          if (after.length > 3100) throw new Error();
          const pair = JSON.parse(after);
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== "string" ||
            (pair[0] !== "" && !FIPS.test(pair[0])) ||
            typeof pair[1] !== "string" ||
            pair[1].length > 500
          )
            throw new Error();
          cursor = [pair[0], pair[1]];
        } catch {
          throw new ProfilesInputError("Invalid office continuation");
        }
      }
      const counties = await database.all<Row>(
        "SELECT fips, name FROM counties ORDER BY name COLLATE NOCASE",
        100,
      );
      const pageSize = 500;
      const matches = await database.all<{ county: string; name: string }>(
        `WITH offices AS (
             SELECT DISTINCT COALESCE(${COUNTY_EXPRESSION}, '') AS county,
               ${OFFICE_EXPRESSION} AS name
             FROM person_roles pr
             LEFT JOIN positions pos ON pos.id = pr.position_id
             LEFT JOIN organizations o ON o.id = pos.organization_id
             WHERE ${OFFICE_EXPRESSION} IS NOT NULL
           )
           SELECT county, name FROM offices
           WHERE (county, name) > (?, ?) ORDER BY county, name`,
        pageSize + 1,
        cursor,
      );
      const page = matches.slice(0, pageSize);
      const last = page.at(-1);
      return {
        counties: counties.map((row) => ({
          fips: str(row.fips),
          name: str(row.name),
        })),
        offices: page.map((row) => ({
          name: row.name,
          countyFips: row.county || null,
        })),
        nextOfficeCursor:
          matches.length > pageSize && last
            ? JSON.stringify([last.county, last.name])
            : null,
      };
    },
    async selectAll(principal, input) {
      await require(principal);
      const query = parseQuery(input);
      const { where, values } = filterClause(query);
      const countRow = await database.first<Row>(
        `SELECT COUNT(*) AS total ${FROM_CLAUSE} ${where}`,
        values,
      );
      // D1 caps one result set at 1000 rows, so truncation comes from the count.
      const rows = await database.all<Row>(
        `SELECT ${ROW_COLUMNS} ${FROM_CLAUSE} ${where}
         ${orderClause(query)} LIMIT ${PROFILES_MAX_SELECT_ALL}`,
        PROFILES_MAX_SELECT_ALL,
        values,
      );
      return {
        entries: rows.map((row) => {
          const entry = toRow(row);
          return {
            rowKey: entry.rowKey,
            roleId: entry.roleId,
            profileId: entry.profileId,
            profileVersion: entry.profileVersion,
            roleVersion: entry.roleVersion,
            visibilityVersion: entry.visibilityVersion,
            visible: entry.visible,
            publicationReady: entry.publicationReady,
            displayName: entry.displayName,
            employmentStart: entry.employmentStart,
            employmentEnd: entry.employmentEnd,
            dateReviewed: entry.dateReviewed,
          };
        }),
        truncated: num(countRow?.total) > PROFILES_MAX_SELECT_ALL,
      };
    },
    async previewMatchingVisibility(principal, input) {
      await require(principal);
      const { query, visible } = readVisibilityScope(input);
      return (await reviewMatchingVisibility(query, visible)).preview;
    },
    async saveMatchingVisibility(principal, key, input) {
      await require(principal);
      const { query, visible, digest } = readVisibilityScope(input);
      if (
        !/^[A-Za-z0-9_.:-]{8,128}$/.test(key) ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        throw new ProfilesInputError(
          "A reviewed preview and idempotency key are required.",
        );
      const fingerprint = await sha256Hex(
        JSON.stringify(["matching-profile-visibility", query, visible, digest]),
      );
      const replay = async () => {
        const prior = await savedResult<MatchingProfileVisibilityReceipt>(
          principal.accountId,
          key,
        );
        if (!prior) return null;
        if (prior.fingerprint !== fingerprint)
          throw new ProfilesIdempotencyError();
        return { ...prior.response, replayed: true };
      };
      const prior = await replay();
      if (prior) return prior;

      const { generation, profileWrites, preview } =
        await reviewMatchingVisibility(query, visible);
      if (preview.digest !== digest) throw visibilityScopeChanged();
      const response = { applied: preview.willChange, replayed: false };
      if (!response.applied) return response;
      const { sql, values } = matchingProfiles(query);
      const affected = `WITH matching AS (${sql}), affected AS MATERIALIZED (
        SELECT m.person_id FROM matching m
        LEFT JOIN person_visibility v ON v.person_id = m.person_id
        WHERE COALESCE(v.visible, 1) <> ?
          AND (? = 0 OR EXISTS (
            SELECT 1 FROM profile_publication_ready ready WHERE ready.person_id = m.person_id
          ))
      )`;
      const parameters = [...values, Number(visible), Number(visible)];
      try {
        await database.guardedBatch(generation, principal, [
          // Grid visibility and name edits write a receipt without advancing
          // the sync generation. Both can change this filter scope.
          database.prepare(
            "INSERT INTO website_write_assertions (id, valid) SELECT ?, COUNT(*) = ? FROM profile_write_receipts",
            [crypto.randomUUID(), profileWrites],
          ),
          database.prepare(
            `${affected}
             INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json)
             SELECT lower(hex(randomblob(16))), ?, ?, 'person', person_id, ?,
                    json_object('profileId', person_id, 'visible', json(?)) FROM affected`,
            [
              ...parameters,
              principal.accountId,
              visible ? "profile.restore" : "profile.hide",
              visible
                ? "Restored a Profile to the public Website"
                : "Hid a Profile from the public Website",
              JSON.stringify(visible),
            ],
          ),
          database.prepare(
            `${affected}
             INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
             SELECT person_id, ?, ? FROM affected WHERE TRUE
             ON CONFLICT (person_id) DO UPDATE SET
               visible = excluded.visible, version = person_visibility.version + 1,
               changed_by_account_id = excluded.changed_by_account_id, hidden_reason = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
            [...parameters, Number(visible), principal.accountId],
          ),
          database.prepare(
            "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes() = ?)",
            [crypto.randomUUID(), response.applied],
          ),
          database.prepare(
            `INSERT INTO profile_write_receipts (actor_account_id, idempotency_key, request_fingerprint, response_json)
             VALUES (?, ?, ?, ?)`,
            [principal.accountId, key, fingerprint, JSON.stringify(response)],
          ),
        ]);
      } catch (error) {
        await require(principal);
        const winner = await replay();
        if (winner) return winner;
        if (
          (await reviewMatchingVisibility(query, visible)).preview.digest !==
          digest
        )
          throw visibilityScopeChanged();
        throw error;
      }
      return response;
    },
    async alternateNames(principal, profileId) {
      await require(principal);
      if (typeof profileId !== "string" || !ID.test(profileId))
        throw new ProfilesInputError("Invalid profileId");
      const person = await database.first<Row>(
        "SELECT id, display_name, version FROM people WHERE id = ?",
        [profileId],
      );
      if (!person) return null;
      const rows = await database.all<Row>(
        `SELECT id, person_id, name_type, first_name, middle_name, last_name,
                name_prefix, name_suffix, published_name, applies_from,
                applies_until, verification_status, public_display,
                removed_at, version, created_at, updated_at
         FROM profile_names WHERE person_id = ?
         ORDER BY (removed_at IS NOT NULL), created_at, id COLLATE BINARY
         LIMIT ${PROFILES_NAME_PAGE_LIMIT + 1}`,
        PROFILES_NAME_PAGE_LIMIT + 1,
        [profileId],
      );
      const truncated = rows.length > PROFILES_NAME_PAGE_LIMIT;
      const page = rows.slice(0, PROFILES_NAME_PAGE_LIMIT);
      const names: AlternateNameRecord[] = page.map((row) => ({
        ...rowToFields(row),
        id: str(row.id),
        personId: str(row.person_id),
        version: num(row.version),
        removed: row.removed_at !== null && row.removed_at !== undefined,
        removedAt: nullable(row.removed_at),
        createdAt: str(row.created_at),
        updatedAt: str(row.updated_at),
      }));
      return {
        profileId: str(person.id),
        displayName: str(person.display_name),
        profileVersion: num(person.version),
        names,
        truncated,
      };
    },
    async preview(principal, changes) {
      await require(principal);
      return (await validate(changes)).preview;
    },
    async save(principal, idempotencyKey, input) {
      await require(principal);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey))
        throw new ProfilesInputError("A valid idempotency key is required");
      const checked = await validate(input);
      const fingerprint = await sha256Hex(
        JSON.stringify(
          canonical(checked.changes.length ? checked.changes : []),
        ),
      );
      const prior = await savedResult(principal.accountId, idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ProfilesIdempotencyError();
        return { ...prior.response, replayed: true };
      }
      if (!checked.preview.ok) {
        if (checked.stale.length)
          throw new ProfilesConflictError(checked.preview.issues);
        throw new ProfilesValidationError(checked.preview.issues);
      }
      if (checked.preview.items.length === 0)
        throw new ProfilesValidationError([
          issue(0, "no_change", "There is nothing to save."),
        ]);

      const changes = checked.changes;
      const statements: D1BatchStatement[] = [];
      const results: {
        index: number;
        entity:
          | "people"
          | "person_roles"
          | "person_visibility"
          | "profile_names";
        targetId: string;
        field: string;
        newVersion: number;
      }[] = [];
      const assertion = () =>
        database.prepare(
          "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes())",
          [crypto.randomUUID()],
        );
      const audit = (
        action: string,
        targetType: string,
        targetId: string,
        summary: string,
        details: Record<string, string | number | boolean | null>,
      ) => {
        const record = { action, targetType, targetId, summary, details };
        assertCredentialFree(record);
        return database.prepare(
          `INSERT INTO audit_events
             (id, actor_account_id, action, target_type, target_id, summary, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            principal.accountId,
            action,
            targetType,
            targetId,
            summary,
            JSON.stringify(details),
          ],
        );
      };

      const previewIndexes = new Set(
        checked.preview.items.map((item) => item.index),
      );
      const nameEvent = (
        personId: string,
        nameId: string | null,
        action: string,
        before: unknown,
        after: unknown,
      ) =>
        database.prepare(
          `INSERT INTO profile_name_events
             (id, person_id, profile_name_id, action, actor_account_id, before_json, after_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            personId,
            nameId,
            action,
            principal.accountId,
            before === null ? null : JSON.stringify(before),
            after === null ? null : JSON.stringify(after),
          ],
        );
      const nameColumnsSql = `name_type, first_name, middle_name, last_name,
        name_prefix, name_suffix, published_name, applies_from, applies_until,
        verification_status, public_display`;
      const nameValues = (
        f: AlternateNameFields,
      ): (string | number | null)[] => [
        f.nameType,
        f.firstName,
        f.middleName,
        f.lastName,
        f.namePrefix,
        f.nameSuffix,
        f.publishedName,
        f.appliesFrom,
        f.appliesUntil,
        f.verificationStatus,
        f.publicDisplay ? 1 : 0,
      ];
      const personGroups = new Map<
        string,
        {
          expected: number;
          columns: [string, string | null][];
          indexes: number[];
        }
      >();
      // One UPDATE per role row so its version advances once per save.
      const roleGroups = new Map<
        string,
        {
          expected: number;
          columns: [string, string | null][];
          indexes: number[];
        }
      >();
      changes.forEach((change, index) => {
        if (!previewIndexes.has(index)) return;
        if (change.kind === "visibility") {
          const restoring = change.visible;
          if (change.expectedVersion === 0) {
            // No row means visible, so only a hide can create the row. A
            // concurrent first hide hits the primary key and aborts the batch.
            statements.push(
              database.prepare(
                `INSERT INTO person_visibility (person_id, visible, version, changed_by_account_id)
                 VALUES (?, ?, 1, ?)`,
                [change.personId, change.visible ? 1 : 0, principal.accountId],
              ),
            );
          } else {
            if (restoring) {
              statements.push(
                database.prepare(
                  `INSERT INTO website_write_assertions (id, valid)
                   SELECT ?, CASE WHEN EXISTS (
                     SELECT 1 FROM profile_publication_ready WHERE person_id = ?
                   ) THEN 1 ELSE 0 END`,
                  [crypto.randomUUID(), change.personId],
                ),
              );
            }
            statements.push(
              database.prepare(
                `UPDATE person_visibility
                 SET visible = ?, version = version + 1, changed_by_account_id = ?,
                     hidden_reason = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE person_id = ? AND version = ?`,
                [
                  change.visible ? 1 : 0,
                  principal.accountId,
                  change.personId,
                  change.expectedVersion,
                ],
              ),
              assertion(),
            );
          }
          statements.push(
            audit(
              change.visible ? "profile.restore" : "profile.hide",
              "person",
              change.personId,
              change.visible
                ? "Restored a Profile to the public Website"
                : "Hid a Profile from the public Website",
              { profileId: change.personId, visible: change.visible },
            ),
          );
          results.push({
            index,
            entity: "person_visibility",
            targetId: change.personId,
            field: "visible",
            newVersion: change.expectedVersion + 1,
          });
          return;
        }
        if (change.kind === "alternate_name") {
          const idNow = (): string => `pn_${crypto.randomUUID()}`;
          if (change.op === "add") {
            const fields = normalizeAlternateFields(change.fields);
            const nameId = idNow();
            statements.push(
              database.prepare(
                `INSERT INTO profile_names (id, person_id, ${nameColumnsSql}, created_by_account_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  nameId,
                  change.personId,
                  ...nameValues(fields),
                  principal.accountId,
                ],
              ),
              nameEvent(change.personId, nameId, "alternate_add", null, fields),
              audit(
                "profile.name_add",
                "person",
                change.personId,
                "Added an alternate name to a Profile",
                {
                  profileId: change.personId,
                  nameId,
                  nameType: fields.nameType,
                },
              ),
            );
            results.push({
              index,
              entity: "profile_names",
              targetId: nameId,
              field: "alternate_name",
              newVersion: 1,
            });
            return;
          }
          const row = checked.targets?.altNames.get(change.nameId);
          const before = row ? rowToFields(row) : null;
          if (change.op === "update") {
            const fields = normalizeAlternateFields(change.fields);
            statements.push(
              database.prepare(
                `UPDATE profile_names SET
                   name_type = ?, first_name = ?, middle_name = ?, last_name = ?,
                   name_prefix = ?, name_suffix = ?, published_name = ?,
                   applies_from = ?, applies_until = ?, verification_status = ?,
                   public_display = ?, version = version + 1,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ? AND person_id = ? AND version = ? AND removed_at IS NULL`,
                [
                  ...nameValues(fields),
                  change.nameId,
                  change.personId,
                  change.expectedVersion,
                ],
              ),
              assertion(),
              nameEvent(
                change.personId,
                change.nameId,
                "alternate_update",
                before,
                fields,
              ),
              audit(
                "profile.name_update",
                "person",
                change.personId,
                "Edited an alternate name on a Profile",
                {
                  profileId: change.personId,
                  nameId: change.nameId,
                  nameType: fields.nameType,
                },
              ),
            );
          } else {
            const removing = change.op === "remove";
            statements.push(
              database.prepare(
                removing
                  ? `UPDATE profile_names SET
                       removed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                       removed_by_account_id = ?, public_display = 0,
                       version = version + 1,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE id = ? AND person_id = ? AND version = ? AND removed_at IS NULL`
                  : `UPDATE profile_names SET
                       removed_at = NULL, removed_by_account_id = NULL,
                       public_display = 0, version = version + 1,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE id = ? AND person_id = ? AND version = ? AND removed_at IS NOT NULL`,
                removing
                  ? [
                      principal.accountId,
                      change.nameId,
                      change.personId,
                      change.expectedVersion,
                    ]
                  : [change.nameId, change.personId, change.expectedVersion],
              ),
              assertion(),
              nameEvent(
                change.personId,
                change.nameId,
                removing ? "alternate_remove" : "alternate_restore",
                before,
                removing
                  ? null
                  : before
                    ? { ...before, publicDisplay: false }
                    : null,
              ),
              audit(
                removing ? "profile.name_remove" : "profile.name_restore",
                "person",
                change.personId,
                removing
                  ? "Removed an alternate name from a Profile"
                  : "Restored an alternate name on a Profile",
                { profileId: change.personId, nameId: change.nameId },
              ),
            );
          }
          results.push({
            index,
            entity: "profile_names",
            targetId: change.nameId,
            field: "alternate_name",
            newVersion: change.expectedVersion + 1,
          });
          return;
        }
        if (change.entity === "people") {
          const group = personGroups.get(change.targetId) ?? {
            expected: change.expectedVersion,
            columns: [],
            indexes: [],
          };
          const text = (change.value ?? "").trim();
          group.columns.push([change.field, text === "" ? null : text]);
          group.indexes.push(index);
          personGroups.set(change.targetId, group);
          return;
        }
        const group = roleGroups.get(change.targetId) ?? {
          expected: change.expectedVersion,
          columns: [],
          indexes: [],
        };
        group.columns.push([
          change.field,
          change.value === null ? null : change.value.trim(),
        ]);
        group.indexes.push(index);
        roleGroups.set(change.targetId, group);
      });
      for (const [personId, group] of personGroups) {
        const columns = [...group.columns].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        for (const [column] of columns)
          if (!FIELD_WRITES.people.includes(column))
            throw new ProfilesInputError("Unsupported field");
        const row = checked.targets?.people.get(personId);
        const beforeValues: Record<string, string | null> = {};
        const afterValues: Record<string, string | null> = {};
        for (const [column, value] of columns) {
          beforeValues[column] = nullable(row?.[column]);
          afterValues[column] = value;
        }
        const only = columns.length === 1 ? columns[0]?.[0] : undefined;
        statements.push(
          database.prepare(
            `UPDATE people SET ${columns
              .map(([column]) => `"${column}" = ?`)
              .join(", ")}, version = version + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ? AND version = ?`,
            [...columns.map(([, value]) => value), personId, group.expected],
          ),
          assertion(),
          audit(
            "profile.update",
            "person",
            personId,
            only === "display_name"
              ? "Edited a Profile display name"
              : "Edited Profile name fields",
            {
              profileId: personId,
              field: columns.map(([column]) => column).join(","),
            },
          ),
          nameEvent(
            personId,
            null,
            "primary_update",
            beforeValues,
            afterValues,
          ),
        );
        for (const [position, index] of group.indexes.entries()) {
          results.push({
            index,
            entity: "people",
            targetId: personId,
            field: group.columns[position]?.[0] ?? "",
            newVersion: group.expected + 1,
          });
        }
      }
      for (const [roleId, group] of roleGroups) {
        const columns = [...group.columns].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        for (const [column] of columns)
          if (!FIELD_WRITES.person_roles.includes(column))
            throw new ProfilesInputError("Unsupported field");
        statements.push(
          database.prepare(
            `UPDATE person_roles SET ${columns
              .map(([column]) => `"${column}" = ?`)
              .join(", ")}, version = version + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ? AND version = ?`,
            [...columns.map(([, value]) => value), roleId, group.expected],
          ),
          assertion(),
          audit(
            "profile.role_update",
            "person_role",
            roleId,
            "Edited a Profile role",
            {
              roleId,
              fields: columns.map(([column]) => column).join(","),
            },
          ),
        );
        for (const [position, index] of group.indexes.entries()) {
          const column = group.columns[position]?.[0] ?? "";
          results.push({
            index,
            entity: "person_roles",
            targetId: roleId,
            field: column,
            newVersion: group.expected + 1,
          });
        }
      }
      // Final state: after every change in this batch, each Profile it
      // publishes must still meet the publication rule, so a combined edit
      // cannot publish an incomplete Profile.
      for (const change of changes)
        if (change.kind === "visibility" && change.visible)
          statements.push(
            database.prepare(
              `INSERT INTO website_write_assertions (id, valid)
               SELECT ?, CASE WHEN EXISTS (
                 SELECT 1 FROM profile_publication_ready r
                 JOIN person_visibility v ON v.person_id = r.person_id AND v.visible = 1
                 WHERE r.person_id = ?
               ) THEN 1 ELSE 0 END`,
              [crypto.randomUUID(), change.personId],
            ),
          );
      results.sort((a, b) => a.index - b.index);
      const response: ProfileSaveResult = {
        applied: results.length,
        replayed: false,
        items: results,
      };
      statements.push(
        database.prepare(
          `INSERT INTO profile_write_receipts
             (actor_account_id, idempotency_key, request_fingerprint, response_json)
           VALUES (?, ?, ?, ?)`,
          [
            principal.accountId,
            idempotencyKey,
            fingerprint,
            JSON.stringify(response),
          ],
        ),
      );
      const generation = await database.readDependencyGeneration();
      try {
        await database.guardedBatch(generation, principal, statements);
      } catch {
        // Classify a retry that won the race, a stale row or a revoked identity.
        await require(principal);
        const replay = await savedResult(principal.accountId, idempotencyKey);
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            throw new ProfilesIdempotencyError();
          return { ...replay.response, replayed: true };
        }
        const again = await validate(input);
        if (!again.preview.ok) {
          if (again.stale.length)
            throw new ProfilesConflictError(again.preview.issues);
          throw new ProfilesValidationError(again.preview.issues);
        }
        throw new StorageUnavailableError();
      }
      return response;
    },
  };
}

interface AlternateTargets {
  readonly people: Map<string, Row>;
  readonly altNames: Map<string, Row>;
  readonly altByPerson: Map<string, Row[]>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** What a Profile still needs before it may be visible, in plain words. */
function missingForPublication(row: Row): string[] {
  if (num(row.publication_ready) === 1) return [];
  const missing: string[] = [];
  if (String(row.display_name ?? "").trim() === "")
    missing.push("display name");
  if (num(row.role_count) === 0) {
    missing.push("role");
    return missing;
  }
  if (num(row.any_county) !== 1) missing.push("county");
  if (num(row.any_detail) !== 1) missing.push("office, position or duties");
  if (missing.length === 0)
    missing.push(
      "one role with a county and an office, position or duties together",
    );
  return missing;
}

function publicationStatus(
  visible: boolean,
  missing: readonly string[],
  hiddenReason: unknown,
): string {
  if (visible && missing.length === 0) return "Visible";
  if (missing.length === 0)
    return hiddenReason === "incomplete"
      ? "Hidden · Ready to publish"
      : "Hidden";
  const label = `Missing ${missing.join(", ")}`;
  return `Hidden · ${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function nameReview(row: Row): ProfileNameReview {
  if (num(row.alternate_names_pending) > 0) return "alternate_names_pending";
  const hasComponent = [
    row.first_name,
    row.middle_name,
    row.last_name,
    row.preferred_first_name,
    row.name_prefix,
    row.name_suffix,
  ].some((value) => value !== null && value !== undefined && value !== "");
  return hasComponent ? "components_entered" : "display_only";
}

/**
 * Trims every alternate-name text field and turns a blank optional component
 * or date into null. It never splits, merges or rewrites the text, so accents,
 * punctuation and Unicode are kept exactly as entered.
 */
export function normalizeAlternateFields(
  fields: AlternateNameFields,
): AlternateNameFields {
  const optional = (value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  };
  return {
    nameType: fields.nameType,
    firstName: optional(fields.firstName),
    middleName: optional(fields.middleName),
    lastName: optional(fields.lastName),
    namePrefix: optional(fields.namePrefix),
    nameSuffix: optional(fields.nameSuffix),
    publishedName: fields.publishedName.trim(),
    appliesFrom: optional(fields.appliesFrom),
    appliesUntil: optional(fields.appliesUntil),
    verificationStatus: fields.verificationStatus,
    publicDisplay: fields.publicDisplay,
  };
}

/** The first problem with normalized alternate-name values, or null. */
function alternateFieldProblem(fields: AlternateNameFields): {
  readonly code: ProfileChangeIssue["code"];
  readonly message: string;
} | null {
  if (!(ALTERNATE_NAME_TYPES as readonly string[]).includes(fields.nameType))
    return { code: "invalid_value", message: "Choose a supported name type." };
  if (
    !(ALTERNATE_NAME_STATUSES as readonly string[]).includes(
      fields.verificationStatus,
    )
  )
    return {
      code: "invalid_value",
      message: "Choose Confirmed or Requires review.",
    };
  const text: [string, string | null, number, boolean][] = [
    ["Name as published", fields.publishedName, PROFILES_MAX_NAME_LENGTH, true],
    ["First Name", fields.firstName, PROFILES_MAX_NAME_COMPONENT_LENGTH, false],
    [
      "Middle Name",
      fields.middleName,
      PROFILES_MAX_NAME_COMPONENT_LENGTH,
      false,
    ],
    ["Last Name", fields.lastName, PROFILES_MAX_NAME_COMPONENT_LENGTH, false],
    ["Name Prefix", fields.namePrefix, PROFILES_MAX_NAME_AFFIX_LENGTH, false],
    ["Name Suffix", fields.nameSuffix, PROFILES_MAX_NAME_AFFIX_LENGTH, false],
  ];
  for (const [label, value, limit, required] of text) {
    if (
      (required && !value) ||
      (value !== null &&
        (value.length > limit || CONTROL_CHARACTERS.test(value)))
    )
      return {
        code: "invalid_value",
        message: required
          ? `${label} must be 1 to ${limit} characters with no control characters.`
          : `${label} must be at most ${limit} characters with no control characters, or blank.`,
      };
  }
  for (const [label, value] of [
    ["Applies From", fields.appliesFrom],
    ["Applies Until", fields.appliesUntil],
  ] as const) {
    if (value !== null && !validDate(value))
      return {
        code: "invalid_value",
        message: `${label} must be a date such as 2026-03-14, or blank.`,
      };
  }
  if (
    fields.appliesFrom &&
    fields.appliesUntil &&
    fields.appliesUntil < fields.appliesFrom
  )
    return {
      code: "date_order",
      message: "Applies Until cannot be before Applies From.",
    };
  if (fields.publicDisplay && fields.verificationStatus !== "confirmed")
    return {
      code: "public_not_allowed",
      message:
        "Only a confirmed name can be shown publicly. Mark it Confirmed first.",
    };
  return null;
}

function nameKey(
  type: string,
  publishedName: string,
  from: string | null,
  until: string | null,
): string {
  return JSON.stringify([
    type,
    publishedName.toLowerCase(),
    from ?? "",
    until ?? "",
  ]);
}

/**
 * Applies the requested operations in order to each Profile's active names and
 * reports a name that would collide with another. The unique index is the
 * final guard. This pass gives the owner the reason before anything is sent.
 */
function alternateDuplicateIssues(
  changes: readonly ProfileChange[],
  targets: AlternateTargets,
): Map<number, ProfileChangeIssue> {
  const found = new Map<number, ProfileChangeIssue>();
  const state = new Map<string, Map<string, string>>();
  const known = (personId: string): Map<string, string> => {
    let keys = state.get(personId);
    if (!keys) {
      keys = new Map();
      for (const row of targets.altByPerson.get(personId) ?? []) {
        if (row.removed_at !== null && row.removed_at !== undefined) continue;
        keys.set(
          nameKey(
            str(row.name_type),
            str(row.published_name),
            nullable(row.applies_from),
            nullable(row.applies_until),
          ),
          str(row.id),
        );
      }
      state.set(personId, keys);
    }
    return keys;
  };
  const drop = (keys: Map<string, string>, id: string) => {
    for (const [key, owner] of keys) if (owner === id) keys.delete(key);
  };
  changes.forEach((change, index) => {
    if (change.kind !== "alternate_name") return;
    const keys = known(change.personId);
    let owner = `add:${index}`;
    let key: string | null = null;
    if (change.op === "add" || change.op === "update") {
      const fields = normalizeAlternateFields(change.fields);
      if (alternateFieldProblem(fields)) return;
      key = nameKey(
        fields.nameType,
        fields.publishedName,
        fields.appliesFrom,
        fields.appliesUntil,
      );
      if (change.op === "update") {
        owner = change.nameId;
        drop(keys, owner);
      }
    } else if (change.op === "remove") {
      drop(keys, change.nameId);
      return;
    } else {
      const row = targets.altNames.get(change.nameId);
      if (!row) return;
      owner = change.nameId;
      key = nameKey(
        str(row.name_type),
        str(row.published_name),
        nullable(row.applies_from),
        nullable(row.applies_until),
      );
    }
    const existing = keys.get(key);
    if (existing !== undefined && existing !== owner) {
      found.set(
        index,
        issue(
          index,
          "duplicate_name",
          "This Profile already has that name with the same type and dates.",
        ),
      );
      return;
    }
    keys.set(key, owner);
  });
  return found;
}

function describeAlternate(fields: AlternateNameFields): string {
  return `${fields.nameType}: ${fields.publishedName} (${
    fields.verificationStatus === "confirmed" ? "confirmed" : "requires review"
  }, ${fields.publicDisplay ? "public" : "private"})`;
}

function rowToFields(row: Row): AlternateNameFields {
  return {
    nameType: str(row.name_type) as AlternateNameFields["nameType"],
    firstName: nullable(row.first_name),
    middleName: nullable(row.middle_name),
    lastName: nullable(row.last_name),
    namePrefix: nullable(row.name_prefix),
    nameSuffix: nullable(row.name_suffix),
    publishedName: str(row.published_name),
    appliesFrom: nullable(row.applies_from),
    appliesUntil: nullable(row.applies_until),
    verificationStatus: str(
      row.verification_status,
    ) as AlternateNameFields["verificationStatus"],
    publicDisplay: num(row.public_display) === 1,
  };
}

function sameFields(a: AlternateNameFields, b: AlternateNameFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function publicSummary(fields: AlternateNameFields, removed: boolean): string {
  if (removed)
    return "Removes this name from the Profile. It is hidden from every public page and search. The record is kept and can be restored.";
  return fields.publicDisplay
    ? "Shows this confirmed name on the public Profile page and in public name search, while the Profile is visible."
    : "Private. Not shown on any public page or in public search. Internal reviewers can still search and inspect it.";
}

function validateAlternate(
  change: AlternateNameChange,
  index: number,
  targets: AlternateTargets,
  duplicate: ProfileChangeIssue | undefined,
  issues: ProfileChangeIssue[],
  stale: ProfileChangeIssue[],
  items: ProfilePreviewItem[],
): void {
  const person = targets.people.get(change.personId);
  if (!person) {
    issues.push(issue(index, "not_found", "That Profile no longer exists."));
    return;
  }
  const impact = (fields: AlternateNameFields | null, removed: boolean) => ({
    shared: true,
    profileId: change.personId,
    roleRows: 0,
    counties: [] as string[],
    summary: fields
      ? publicSummary(fields, removed)
      : publicSummary(
          {
            nameType: "other",
            firstName: null,
            middleName: null,
            lastName: null,
            namePrefix: null,
            nameSuffix: null,
            publishedName: "",
            appliesFrom: null,
            appliesUntil: null,
            verificationStatus: "requires_review",
            publicDisplay: false,
          },
          removed,
        ),
  });
  if (change.op === "add") {
    const fields = normalizeAlternateFields(change.fields);
    const problem = alternateFieldProblem(fields);
    if (problem) {
      issues.push(issue(index, problem.code, problem.message));
      return;
    }
    if (duplicate) {
      issues.push(duplicate);
      return;
    }
    items.push({
      index,
      label: "Alternate name (add)",
      field: "alternate_name",
      targetId: change.personId,
      before: null,
      after: describeAlternate(fields),
      impact: impact(fields, false),
    });
    return;
  }
  const row = targets.altNames.get(change.nameId);
  if (!row || str(row.person_id) !== change.personId) {
    issues.push(
      issue(index, "not_found", "That alternate name no longer exists."),
    );
    return;
  }
  const currentVersion = num(row.version);
  const current = rowToFields(row);
  if (currentVersion !== change.expectedVersion) {
    const entry = {
      ...issue(
        index,
        "stale_version",
        "This alternate name changed since it was read.",
      ),
      currentVersion,
      currentValue: current.publishedName,
    };
    issues.push(entry);
    stale.push(entry);
    return;
  }
  const removed = row.removed_at !== null && row.removed_at !== undefined;
  if (change.op === "remove") {
    if (removed) {
      issues.push(issue(index, "no_change", "That name is already removed."));
      return;
    }
    items.push({
      index,
      label: "Alternate name (remove)",
      field: "alternate_name",
      targetId: change.nameId,
      before: describeAlternate(current),
      after: null,
      impact: impact(current, true),
    });
    return;
  }
  if (change.op === "restore") {
    if (!removed) {
      issues.push(issue(index, "no_change", "That name is not removed."));
      return;
    }
    if (duplicate) {
      issues.push(duplicate);
      return;
    }
    items.push({
      index,
      label: "Alternate name (restore)",
      field: "alternate_name",
      targetId: change.nameId,
      before: null,
      after: describeAlternate({ ...current, publicDisplay: false }),
      impact: impact({ ...current, publicDisplay: false }, false),
    });
    return;
  }
  if (removed) {
    issues.push(
      issue(index, "invalid_value", "Restore the name before editing it."),
    );
    return;
  }
  if (change.op !== "update") return;
  const fields = normalizeAlternateFields(change.fields);
  const problem = alternateFieldProblem(fields);
  if (problem) {
    issues.push(issue(index, problem.code, problem.message));
    return;
  }
  if (sameFields(fields, current)) {
    issues.push(issue(index, "no_change", "The alternate name is unchanged."));
    return;
  }
  if (duplicate) {
    issues.push(duplicate);
    return;
  }
  items.push({
    index,
    label: "Alternate name (edit)",
    field: "alternate_name",
    targetId: change.nameId,
    before: describeAlternate(current),
    after: describeAlternate(fields),
    impact: impact(fields, false),
  });
}

function issue(
  index: number,
  code: ProfileChangeIssue["code"],
  message: string,
): ProfileChangeIssue {
  return { index, code, message };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIPS = /^08\d{3}$/;

export function parseQuery(input: unknown): ProfileQuery {
  const source = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string, max: number): string => {
    const value = source[key];
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string" || value.length > max)
      throw new ProfilesInputError(`Invalid ${key}`);
    return value.trim();
  };
  const query = text("query", PROFILES_MAX_QUERY_LENGTH);
  const county = text("county", 5);
  if (county && county !== PROFILE_NO_COUNTY && !FIPS.test(county))
    throw new ProfilesInputError("Invalid county");
  const office = text("office", 500);
  const visibility = text("visibility", 12) || "all";
  if (!["all", "visible", "hidden", "incomplete"].includes(visibility))
    throw new ProfilesInputError("Invalid visibility");
  const unitLink = text("unitLink", 8) || "all";
  if (unitLink !== "all" && unitLink !== "unlinked" && unitLink !== "linked")
    throw new ProfilesInputError("Invalid unit link filter");
  const sort = text("sort", 40) || "displayName";
  if (!PROFILE_SORT_FIELDS.includes(sort))
    throw new ProfilesInputError("Invalid sort");
  const direction = text("direction", 4) || "asc";
  if (direction !== "asc" && direction !== "desc")
    throw new ProfilesInputError("Invalid direction");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = source[key];
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      throw new ProfilesInputError(`Invalid ${key}`);
    return parsed;
  };
  return {
    query,
    countyFips: county || null,
    office: office || null,
    visibility: visibility as ProfileQuery["visibility"],
    unitLink,
    sort,
    direction: direction as ProfileQuery["direction"],
    page: integer("page", 1, 1, PROFILES_MAX_PAGE),
    pageSize: integer(
      "pageSize",
      PROFILES_DEFAULT_PAGE_SIZE,
      1,
      PROFILES_MAX_PAGE_SIZE,
    ),
  };
}

export function parseChanges(input: unknown): {
  readonly changes: ProfileChange[];
  readonly issues: ProfileChangeIssue[];
} {
  const issues: ProfileChangeIssue[] = [];
  if (!Array.isArray(input) || input.length === 0) {
    return {
      changes: [],
      issues: [issue(0, "invalid_value", "Send at least one change.")],
    };
  }
  if (input.length > PROFILES_MAX_CHANGES) {
    return {
      changes: [],
      issues: [
        issue(
          0,
          "invalid_value",
          `Send at most ${PROFILES_MAX_CHANGES} changes at a time.`,
        ),
      ],
    };
  }
  const changes: ProfileChange[] = [];
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    const entry = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(entry);
    const version = entry.expectedVersion;
    const versionOk = Number.isInteger(version) && (version as number) >= 0;
    if (entry.kind === "visibility") {
      const allowed = ["kind", "personId", "expectedVersion", "visible"];
      if (
        keys.some((key) => !allowed.includes(key)) ||
        typeof entry.personId !== "string" ||
        !ID.test(entry.personId) ||
        typeof entry.visible !== "boolean" ||
        !versionOk
      ) {
        issues.push(
          issue(index, "invalid_value", "Invalid visibility change."),
        );
        return;
      }
      const key = `visibility:${entry.personId}`;
      if (seen.has(key)) {
        issues.push(
          issue(index, "duplicate_target", "That Profile is already changed."),
        );
        return;
      }
      seen.add(key);
      changes.push({
        kind: "visibility",
        personId: entry.personId,
        expectedVersion: version as number,
        visible: entry.visible,
      });
      return;
    }
    if (entry.kind === "alternate_name") {
      const op = entry.op;
      const personOk =
        typeof entry.personId === "string" && ID.test(entry.personId);
      const parsedFields =
        op === "add" || op === "update"
          ? parseAlternateFields(entry.fields)
          : null;
      const nameOk = typeof entry.nameId === "string" && ID.test(entry.nameId);
      let allowedKeys: string[] = [];
      if (op === "add") allowedKeys = ["kind", "op", "personId", "fields"];
      else if (op === "update")
        allowedKeys = [
          "kind",
          "op",
          "personId",
          "nameId",
          "expectedVersion",
          "fields",
        ];
      else if (op === "remove" || op === "restore")
        allowedKeys = ["kind", "op", "personId", "nameId", "expectedVersion"];
      const needsName = op === "update" || op === "remove" || op === "restore";
      if (
        allowedKeys.length === 0 ||
        keys.some((key) => !allowedKeys.includes(key)) ||
        !personOk ||
        (needsName &&
          (!nameOk || !Number.isInteger(version) || (version as number) < 1)) ||
        ((op === "add" || op === "update") && !parsedFields)
      ) {
        issues.push(
          issue(index, "invalid_value", "Invalid alternate-name change."),
        );
        return;
      }
      if (needsName) {
        const key = `alternate_name:${entry.nameId as string}`;
        if (seen.has(key)) {
          issues.push(
            issue(index, "duplicate_target", "That name is already changed."),
          );
          return;
        }
        seen.add(key);
      }
      if (op === "add" && parsedFields) {
        changes.push({
          kind: "alternate_name",
          op: "add",
          personId: entry.personId as string,
          fields: parsedFields,
        });
      } else if (op === "update" && parsedFields) {
        changes.push({
          kind: "alternate_name",
          op: "update",
          personId: entry.personId as string,
          nameId: entry.nameId as string,
          expectedVersion: version as number,
          fields: parsedFields,
        });
      } else {
        changes.push({
          kind: "alternate_name",
          op: op as "remove" | "restore",
          personId: entry.personId as string,
          nameId: entry.nameId as string,
          expectedVersion: version as number,
        });
      }
      return;
    }
    const allowed = [
      "kind",
      "entity",
      "targetId",
      "field",
      "expectedVersion",
      "value",
    ];
    if (
      entry.kind !== "field" ||
      keys.some((key) => !allowed.includes(key)) ||
      (entry.entity !== "people" && entry.entity !== "person_roles") ||
      typeof entry.targetId !== "string" ||
      !ID.test(entry.targetId) ||
      typeof entry.field !== "string" ||
      !(
        entry.value === null ||
        (typeof entry.value === "string" && entry.value.length <= 1000)
      ) ||
      !Number.isInteger(version) ||
      (version as number) < 1
    ) {
      issues.push(issue(index, "invalid_value", "Invalid field change."));
      return;
    }
    const entity = entry.entity;
    if (!FIELD_WRITES[entity].includes(entry.field)) {
      issues.push(
        issue(index, "unsupported_field", "That field cannot be edited here."),
      );
      return;
    }
    const key = `${entity}:${entry.targetId}:${entry.field}`;
    if (seen.has(key)) {
      issues.push(
        issue(index, "duplicate_target", "That field is already changed."),
      );
      return;
    }
    seen.add(key);
    changes.push({
      kind: "field",
      entity,
      targetId: entry.targetId,
      field: entry.field,
      expectedVersion: version as number,
      value: entry.value as string | null,
    });
  });
  return { changes: issues.length ? [] : changes, issues };
}

const ALTERNATE_FIELD_KEYS = [
  "nameType",
  "firstName",
  "middleName",
  "lastName",
  "namePrefix",
  "nameSuffix",
  "publishedName",
  "appliesFrom",
  "appliesUntil",
  "verificationStatus",
  "publicDisplay",
];

/** Shape check only. Values are checked against the rules in the service. */
function parseAlternateFields(input: unknown): AlternateNameFields | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !ALTERNATE_FIELD_KEYS.includes(key)))
    return null;
  const optional = (value: unknown): string | null | undefined =>
    value === undefined || value === null
      ? null
      : typeof value === "string" && value.length <= 1000
        ? value
        : undefined;
  const parts = {
    firstName: optional(raw.firstName),
    middleName: optional(raw.middleName),
    lastName: optional(raw.lastName),
    namePrefix: optional(raw.namePrefix),
    nameSuffix: optional(raw.nameSuffix),
    appliesFrom: optional(raw.appliesFrom),
    appliesUntil: optional(raw.appliesUntil),
  };
  if (Object.values(parts).some((value) => value === undefined)) return null;
  if (
    typeof raw.nameType !== "string" ||
    typeof raw.publishedName !== "string" ||
    raw.publishedName.length > 1000 ||
    typeof raw.verificationStatus !== "string" ||
    typeof raw.publicDisplay !== "boolean"
  )
    return null;
  return {
    nameType: raw.nameType as AlternateNameFields["nameType"],
    firstName: parts.firstName as string | null,
    middleName: parts.middleName as string | null,
    lastName: parts.lastName as string | null,
    namePrefix: parts.namePrefix as string | null,
    nameSuffix: parts.nameSuffix as string | null,
    publishedName: raw.publishedName,
    appliesFrom: parts.appliesFrom as string | null,
    appliesUntil: parts.appliesUntil as string | null,
    verificationStatus:
      raw.verificationStatus as AlternateNameFields["verificationStatus"],
    publicDisplay: raw.publicDisplay,
  };
}

function canonicalFields(input: AlternateNameFields): AlternateNameFields {
  return normalizeAlternateFields(input);
}

function canonical(changes: readonly ProfileChange[]): unknown[] {
  return changes.map((change) =>
    change.kind === "alternate_name"
      ? [
          "a",
          change.op,
          change.personId,
          "nameId" in change ? change.nameId : null,
          "expectedVersion" in change ? change.expectedVersion : null,
          change.op === "add" || change.op === "update"
            ? canonicalFields(change.fields)
            : null,
        ]
      : change.kind === "visibility"
        ? ["v", change.personId, change.expectedVersion, change.visible]
        : [
            "f",
            change.entity,
            change.targetId,
            change.field,
            change.expectedVersion,
            change.value === null ? null : change.value.trim(),
          ],
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function validUtc(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") ===
      value.replace(/\.\d+Z$/, "Z")
  );
}

export type { ProfileImpact };
export { PROFILE_FIELDS };

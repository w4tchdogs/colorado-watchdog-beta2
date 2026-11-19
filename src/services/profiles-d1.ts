import {
  PROFILE_FIELDS,
  PROFILE_SORT_FIELDS,
  PROFILES_DEFAULT_PAGE_SIZE,
  PROFILES_MAX_CHANGES,
  PROFILES_MAX_NAME_LENGTH,
  PROFILES_MAX_PAGE,
  PROFILES_MAX_PAGE_SIZE,
  PROFILES_MAX_QUERY_LENGTH,
  PROFILES_MAX_SELECT_ALL,
  type ProfileChange,
  type ProfileChangeIssue,
  type ProfileFacets,
  type ProfileImpact,
  type ProfilePage,
  type ProfilePreview,
  type ProfilePreviewItem,
  type ProfileQuery,
  type ProfileRow,
  type ProfileSaveResult,
  type ProfileSelectionEntry,
} from "../contracts/profiles.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { assertCredentialFree } from "./audit.js";
import { AuthorizationError, type TrustedPrincipal } from "./security.js";
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

/** Writable columns, each checked against the reviewed sync allowlist. */
const FIELD_WRITES: Readonly<
  Record<"people" | "person_roles", readonly string[]>
> = {
  people: ["display_name"],
  person_roles: ["start_date", "end_date", "source_checked_at"],
};
for (const [entity, columns] of Object.entries(FIELD_WRITES)) {
  for (const column of columns) {
    if (!SYNC_UPDATE_FIELDS[entity]?.includes(column)) {
      throw new Error(`Profiles field ${entity}.${column} is not syncable`);
    }
  }
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  display_name: "Full Name",
  start_date: "Employment Start",
  end_date: "Employment End",
  source_checked_at: "Date Reviewed",
};

const COUNTY_EXPRESSION = "COALESCE(pr.county_fips, o.county_fips)";
const OFFICE_EXPRESSION = "COALESCE(pr.published_office, o.name)";
const POSITION_EXPRESSION = "COALESCE(pr.published_title, pos.title)";

const FROM_CLAUSE = `
  FROM person_roles pr
  JOIN people p ON p.id = pr.person_id
  LEFT JOIN person_visibility pv ON pv.person_id = p.id
  LEFT JOIN positions pos ON pos.id = pr.position_id
  LEFT JOIN organizations o ON o.id = pos.organization_id
  LEFT JOIN organizations parent ON parent.id = o.parent_organization_id
  LEFT JOIN counties c ON c.fips = ${COUNTY_EXPRESSION}`;

const SORT_EXPRESSIONS: Readonly<Record<string, string>> = {
  profileId: "p.id",
  fullName: "p.display_name COLLATE NOCASE",
  visible: "COALESCE(pv.visible, 1)",
  createdOn: "p.created_at",
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
  p.display_name, COALESCE(pv.visible, 1) AS visible, p.created_at AS created_on,
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

export interface ProfilesService {
  listRows(principal: TrustedPrincipal, input: unknown): Promise<ProfilePage>;
  facets(principal: TrustedPrincipal): Promise<ProfileFacets>;
  selectAll(
    principal: TrustedPrincipal,
    input: unknown,
  ): Promise<{
    readonly entries: readonly ProfileSelectionEntry[];
    readonly truncated: boolean;
  }>;
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
          OR ${OFFICE_EXPRESSION} LIKE ? ESCAPE '\\'
          OR ${POSITION_EXPRESSION} LIKE ? ESCAPE '\\'
          OR pr.job_description LIKE ? ESCAPE '\\')`,
      );
      values.push(pattern, pattern, pattern, pattern);
    }
    if (query.countyFips) {
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
    return {
      where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
      values,
    };
  }

  function orderClause(query: ProfileQuery): string {
    const expression =
      SORT_EXPRESSIONS[query.sort] ?? SORT_EXPRESSIONS.fullName;
    const direction = query.direction === "desc" ? "DESC" : "ASC";
    return `ORDER BY ${expression} ${direction}, pr.id COLLATE BINARY ASC`;
  }

  function toRow(row: Row): ProfileRow {
    return {
      roleId: str(row.role_id),
      profileId: str(row.profile_id),
      profileVersion: num(row.profile_version),
      roleVersion: num(row.role_version),
      visibilityVersion: num(row.visibility_version),
      fullName: str(row.display_name),
      visible: num(row.visible) === 1,
      createdOn: str(row.created_on),
      countyFips: nullable(row.county_fips),
      county: nullable(row.county),
      countyUnit: nullable(row.county_unit),
      countySubUnit: nullable(row.county_sub_unit),
      officeDepartment: nullable(row.office),
      position: nullable(row.position),
      roleDuties: nullable(row.job_description),
      employmentStart: nullable(row.start_date),
      employmentEnd: nullable(row.end_date),
      affiliation: nullable(row.affiliation),
      dateReviewed: nullable(row.source_checked_at),
      roleCreatedOn: str(row.role_created_on),
      roleUpdatedOn: str(row.role_updated_on),
      profileUpdatedOn: str(row.profile_updated_on),
    };
  }

  async function loadFieldTargets(changes: readonly ProfileChange[]): Promise<{
    people: Map<string, Row>;
    roles: Map<string, Row>;
    visibility: Map<string, Row>;
    impact: Map<string, { roles: number; counties: string[] }>;
  }> {
    const personIds = new Set<string>();
    const roleIds = new Set<string>();
    const visibilityIds = new Set<string>();
    for (const change of changes) {
      if (change.kind === "visibility") visibilityIds.add(change.personId);
      else if (change.entity === "people") personIds.add(change.targetId);
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
    const profileIds = new Set<string>([...personIds, ...visibilityIds]);
    if (profileIds.size) {
      const list = JSON.stringify([...profileIds]);
      const rows = await database.all<Row>(
        `SELECT p.id, p.display_name, p.version,
                COALESCE(pv.visible, 1) AS visible,
                COALESCE(pv.version, 0) AS visibility_version,
                EXISTS (
                  SELECT 1 FROM person_roles r
                  LEFT JOIN positions ps ON ps.id = r.position_id
                  LEFT JOIN organizations o ON o.id = ps.organization_id
                  WHERE r.person_id = p.id AND r.source_id IS NOT NULL
                    AND COALESCE(r.county_fips, o.county_fips) IS NOT NULL
                    AND (r.position_id IS NOT NULL OR r.published_office IS NOT NULL
                         OR r.published_title IS NOT NULL OR r.job_description IS NOT NULL)
                ) AS eligible
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
    return { people, roles, visibility, impact };
  }

  async function validate(input: unknown): Promise<{
    readonly changes: readonly ProfileChange[];
    readonly preview: ProfilePreview;
    readonly stale: readonly ProfileChangeIssue[];
  }> {
    const parsed = parseChanges(input);
    if (parsed.issues.length)
      return {
        changes: [],
        preview: { ok: false, items: [], issues: parsed.issues },
        stale: [],
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
    const checkedAt = now();
    changes.forEach((change, index) => {
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
        if (change.visible && num(row.eligible) !== 1) {
          issues.push(
            issue(
              index,
              "not_eligible",
              "Only a Profile with a county, a name, a source and an office, position or duties can be visible.",
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
        if (currentVersion !== change.expectedVersion) {
          const entry = {
            ...issue(
              index,
              "stale_version",
              `${label} changed since it was read.`,
            ),
            currentVersion,
            currentValue: str(row.display_name),
          };
          issues.push(entry);
          stale.push(entry);
          return;
        }
        const value = change.value === null ? "" : change.value.trim();
        if (
          !value ||
          value.length > PROFILES_MAX_NAME_LENGTH ||
          // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
          /[\u0000-\u001f\u007f]/.test(value)
        ) {
          issues.push(
            issue(
              index,
              "invalid_value",
              `${label} must be 1 to ${PROFILES_MAX_NAME_LENGTH} characters with no control characters.`,
            ),
          );
          return;
        }
        if (value === str(row.display_name)) {
          issues.push(issue(index, "no_change", `${label} is unchanged.`));
          return;
        }
        const detail = targets.impact.get(change.targetId) ?? {
          roles: 0,
          counties: [],
        };
        items.push({
          index,
          label,
          field: change.field,
          targetId: change.targetId,
          before: str(row.display_name),
          after: value,
          impact: {
            shared: true,
            profileId: change.targetId,
            roleRows: detail.roles,
            counties: detail.counties,
            summary: `The display name is shared by this Profile's ${detail.roles} role ${plural(detail.roles, "row")}${
              detail.counties.length ? ` in ${detail.counties.join(", ")}` : ""
            } and by every public page that shows the person. The private reviewed Profiles record is not changed.`,
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
    };
  }

  async function savedResult(
    actorId: string,
    key: string,
  ): Promise<{ fingerprint: string; response: ProfileSaveResult } | null> {
    const row = await database.first<Row>(
      `SELECT request_fingerprint, response_json FROM profile_write_receipts
       WHERE actor_account_id = ? AND idempotency_key = ?`,
      [actorId, key],
    );
    if (!row) return null;
    return {
      fingerprint: str(row.request_fingerprint),
      response: JSON.parse(str(row.response_json)) as ProfileSaveResult,
    };
  }

  return {
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
      return {
        rows: rows.map(toRow),
        total,
        page,
        pageSize: query.pageSize,
        lastPage,
      };
    },
    async facets(principal) {
      await require(principal);
      const counties = await database.all<Row>(
        "SELECT fips, name FROM counties ORDER BY name COLLATE NOCASE",
        100,
      );
      const offices = await database.all<Row>(
        `SELECT DISTINCT ${OFFICE_EXPRESSION} AS office ${FROM_CLAUSE}
         WHERE ${OFFICE_EXPRESSION} IS NOT NULL
         ORDER BY ${OFFICE_EXPRESSION} COLLATE NOCASE`,
        500,
      );
      return {
        counties: counties.map((row) => ({
          fips: str(row.fips),
          name: str(row.name),
        })),
        offices: offices.map((row) => str(row.office)),
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
            roleId: entry.roleId,
            profileId: entry.profileId,
            profileVersion: entry.profileVersion,
            roleVersion: entry.roleVersion,
            visibilityVersion: entry.visibilityVersion,
            visible: entry.visible,
            fullName: entry.fullName,
            employmentStart: entry.employmentStart,
            employmentEnd: entry.employmentEnd,
            dateReviewed: entry.dateReviewed,
          };
        }),
        truncated: num(countRow?.total) > PROFILES_MAX_SELECT_ALL,
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
        entity: "people" | "person_roles" | "person_visibility";
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
                     SELECT 1 FROM person_roles r
                     LEFT JOIN positions ps ON ps.id = r.position_id
                     LEFT JOIN organizations o ON o.id = ps.organization_id
                     WHERE r.person_id = ? AND r.source_id IS NOT NULL
                       AND COALESCE(r.county_fips, o.county_fips) IS NOT NULL
                       AND (r.position_id IS NOT NULL OR r.published_office IS NOT NULL
                            OR r.published_title IS NOT NULL OR r.job_description IS NOT NULL)
                   ) THEN 1 ELSE 0 END`,
                  [crypto.randomUUID(), change.personId],
                ),
              );
            }
            statements.push(
              database.prepare(
                `UPDATE person_visibility
                 SET visible = ?, version = version + 1, changed_by_account_id = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
        if (change.entity === "people") {
          statements.push(
            database.prepare(
              `UPDATE people SET display_name = ?, version = version + 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE id = ? AND version = ?`,
              [
                (change.value ?? "").trim(),
                change.targetId,
                change.expectedVersion,
              ],
            ),
            assertion(),
            audit(
              "profile.update",
              "person",
              change.targetId,
              "Edited a Profile display name",
              { profileId: change.targetId, field: "display_name" },
            ),
          );
          results.push({
            index,
            entity: "people",
            targetId: change.targetId,
            field: change.field,
            newVersion: change.expectedVersion + 1,
          });
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
  if (county && !FIPS.test(county))
    throw new ProfilesInputError("Invalid county");
  const office = text("office", 500);
  const visibility = text("visibility", 10) || "all";
  if (!["all", "visible", "hidden"].includes(visibility))
    throw new ProfilesInputError("Invalid visibility");
  const sort = text("sort", 40) || "fullName";
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

function canonical(changes: readonly ProfileChange[]): unknown[] {
  return changes.map((change) =>
    change.kind === "visibility"
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

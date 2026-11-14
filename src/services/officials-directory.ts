import {
  type CountyAffiliationType,
  DEFAULT_DIRECTORY_PAGE_SIZE,
  MAX_DIRECTORY_PAGE_SIZE,
  type OrganizationType,
} from "../contracts/directory.js";
import {
  type CountyStructure,
  type CountyStructureOrganization,
  type CountyStructureRequest,
  OFFICIALS_SORT_FIELDS,
  type OfficialsCountyAssociation,
  type OfficialsDirectoryEntry,
  type OfficialsDirectoryPage,
  type OfficialsDirectoryRequest,
  type OfficialsSort,
} from "../contracts/officials-directory.js";
import type { AsyncD1Database } from "../database/d1.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

const ORGANIZATION_TYPES: readonly OrganizationType[] = [
  "county_government",
  "office",
  "department",
  "division",
  "regional",
  "partner",
  "other",
];
const MAX_QUERY_LENGTH = 100;
const MIN_QUERY_LENGTH = 2;
const MAX_PAGE = 10_000;
/** Depth bound for walking documented parent links. */
const MAX_HIERARCHY_DEPTH = 12;
/** Upper bound on organizations read for one county's structure. */
export const MAX_STRUCTURE_ORGANIZATIONS = 500;

export class OfficialsDirectoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficialsDirectoryInputError";
  }
}

type SqlValue = string | number | null;
type Row = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

/**
 * The only database access the directory needs. One SQL implementation runs
 * through this interface on both runtimes: local SQL.js and hosted D1.
 */
export interface DirectoryQueryRunner {
  first(sql: string, values: readonly SqlValue[]): MaybePromise<Row | null>;
  /** `maxRows` is a hard upper bound on the rows the query may return. */
  all(
    sql: string,
    maxRows: number,
    values: readonly SqlValue[],
  ): MaybePromise<readonly Row[]>;
}

export function sqliteDirectoryRunner(
  database: WebsiteDatabase,
): DirectoryQueryRunner {
  return {
    first: (sql, values) => database.prepare(sql).get(...values) ?? null,
    all: (sql, _maxRows, values) => database.prepare(sql).all(...values),
  };
}

export function d1DirectoryRunner(
  database: AsyncD1Database,
): DirectoryQueryRunner {
  return {
    first: (sql, values) => database.first<Row>(sql, values),
    all: (sql, maxRows, values) => database.all<Row>(sql, maxRows, values),
  };
}

/** D1 allows 100 bound parameters per statement; ID lists are chunked. */
const ID_CHUNK = 40;

/** Whitelisted ORDER BY expressions; request values never reach the SQL. */
const SORT_COLUMNS: Readonly<Record<OfficialsSort, string>> = {
  name: "display_name COLLATE NOCASE",
  title: "title COLLATE NOCASE",
  organization: "organization_name COLLATE NOCASE",
  county: "county_name COLLATE NOCASE",
  checked: "source_checked_at",
};
const SORT_NULL_CHECK: Readonly<Record<OfficialsSort, string | null>> = {
  name: null,
  title: "title IS NULL",
  organization: "organization_name IS NULL",
  county: "county_name IS NULL",
  checked: "source_checked_at IS NULL",
};

interface ValidatedRequest {
  readonly countyFips: string | null;
  readonly organizationId: string | null;
  readonly organizationType: OrganizationType | null;
  readonly pattern: string | null;
  readonly sort: OfficialsSort;
  readonly descending: boolean;
  readonly page: number;
  readonly limit: number;
}

async function validate(
  runner: DirectoryQueryRunner,
  request: OfficialsDirectoryRequest,
): Promise<ValidatedRequest> {
  const allowed = new Set([
    "countyFips",
    "organizationId",
    "organizationType",
    "query",
    "sort",
    "direction",
    "page",
    "limit",
  ]);
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => !allowed.has(key))
  ) {
    throw new OfficialsDirectoryInputError("directory request is malformed");
  }

  const countyFips = request.countyFips ?? null;
  if (countyFips !== null) await requireCounty(runner, countyFips);

  const organizationId = request.organizationId ?? null;
  if (organizationId !== null) {
    if (
      typeof organizationId !== "string" ||
      organizationId.length === 0 ||
      organizationId.length > 128 ||
      !(await runner.first(
        "SELECT 1 AS found FROM organizations WHERE id = ?",
        [organizationId],
      ))
    ) {
      throw new OfficialsDirectoryInputError("organization is not recorded");
    }
  }

  const organizationType = request.organizationType ?? null;
  if (
    organizationType !== null &&
    !ORGANIZATION_TYPES.includes(organizationType)
  ) {
    throw new OfficialsDirectoryInputError("organization type is not valid");
  }

  let pattern: string | null = null;
  if (request.query !== undefined && request.query !== null) {
    if (typeof request.query !== "string") {
      throw new OfficialsDirectoryInputError("query is malformed");
    }
    const query = request.query.trim();
    if (query.length > 0) {
      if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
        throw new OfficialsDirectoryInputError(
          `query must contain ${MIN_QUERY_LENGTH} to ${MAX_QUERY_LENGTH} characters`,
        );
      }
      pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    }
  }

  const sort = request.sort ?? "name";
  if (!OFFICIALS_SORT_FIELDS.includes(sort)) {
    throw new OfficialsDirectoryInputError("sort field is not valid");
  }
  const direction = request.direction ?? "asc";
  if (direction !== "asc" && direction !== "desc") {
    throw new OfficialsDirectoryInputError("sort direction is not valid");
  }
  const page = request.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new OfficialsDirectoryInputError(
      `page must be an integer from 1 to ${MAX_PAGE}`,
    );
  }
  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new OfficialsDirectoryInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }
  return {
    countyFips,
    organizationId,
    organizationType,
    pattern,
    sort,
    descending: direction === "desc",
    page,
    limit,
  };
}

async function requireCounty(
  runner: DirectoryQueryRunner,
  countyFips: unknown,
): Promise<{ fips: string; name: string }> {
  const row =
    typeof countyFips === "string" && /^08\d{3}$/.test(countyFips)
      ? await runner.first("SELECT fips, name FROM counties WHERE fips = ?", [
          countyFips,
        ])
      : null;
  if (!row) {
    throw new OfficialsDirectoryInputError("county is not in the registry");
  }
  return { fips: text(row.fips), name: text(row.name) };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid directory record");
  return value;
}
function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
function flag(value: unknown): boolean {
  return value === 1 || value === true;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid directory count");
  }
  return value;
}

/**
 * Builds the shared "matching people" query. Each person appears once, with
 * their most recently source-checked role among the roles that satisfy the
 * filters. People without any role record are included only when no county
 * or organization filter is active.
 */
function matchingPeopleSql(input: ValidatedRequest): {
  sql: string;
  parameters: SqlValue[];
} {
  const roleFilters: string[] = [];
  const roleParameters: SqlValue[] = [];
  let officeCte = "";
  const officeParameters: SqlValue[] = [];

  if (input.countyFips !== null) {
    roleFilters.push(
      `(org.county_fips = ? OR EXISTS (
          SELECT 1 FROM organization_county_affiliations AS affiliation
          WHERE affiliation.organization_id = org.id
            AND affiliation.county_fips = ?))`,
    );
    roleParameters.push(input.countyFips, input.countyFips);
  }
  if (input.organizationId !== null) {
    officeCte = `office(id, depth) AS (
        SELECT id, 0 FROM organizations WHERE id = ?
        UNION
        SELECT child.id, office.depth + 1
        FROM organizations AS child
        JOIN office ON child.parent_organization_id = office.id
        WHERE office.depth < ${MAX_HIERARCHY_DEPTH}
      ),`;
    officeParameters.push(input.organizationId);
    roleFilters.push("org.id IN (SELECT id FROM office)");
  }
  if (input.organizationType !== null) {
    roleFilters.push("org.organization_type = ?");
    roleParameters.push(input.organizationType);
  }
  if (input.pattern !== null) {
    roleFilters.push(
      `(person.display_name LIKE ? ESCAPE '\\'
        OR position.title LIKE ? ESCAPE '\\'
        OR org.name LIKE ? ESCAPE '\\')`,
    );
    roleParameters.push(input.pattern, input.pattern, input.pattern);
  }

  const scoped =
    input.countyFips !== null ||
    input.organizationId !== null ||
    input.organizationType !== null;
  const unassigned = scoped
    ? ""
    : `UNION ALL
       SELECT person.id, person.display_name, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0
       FROM people AS person
       WHERE NOT EXISTS (
               SELECT 1 FROM person_roles AS role WHERE role.person_id = person.id)
         ${input.pattern === null ? "" : "AND person.display_name LIKE ? ESCAPE '\\'"}`;

  const sql = `WITH RECURSIVE ${officeCte}
    candidate AS (
      SELECT person.id AS person_id, person.display_name,
             role.id AS role_id, role.start_date, role.end_date,
             role.source_checked_at,
             position.id AS position_id, position.title,
             org.id AS organization_id, org.name AS organization_name,
             org.organization_type, county.name AS county_name,
             source.id AS source_id, source.title AS source_title,
             source.url AS source_url, source.source_type,
             ROW_NUMBER() OVER (
               PARTITION BY person.id
               ORDER BY role.source_checked_at DESC, role.id COLLATE BINARY
             ) AS role_rank,
             COUNT(*) OVER (PARTITION BY person.id) AS matching_role_count
      FROM person_roles AS role
      JOIN people AS person ON person.id = role.person_id
      JOIN positions AS position ON position.id = role.position_id
      JOIN organizations AS org ON org.id = position.organization_id
      JOIN role_sources AS source ON source.id = role.source_id
      LEFT JOIN counties AS county ON county.fips = org.county_fips
      ${roleFilters.length ? `WHERE ${roleFilters.join(" AND ")}` : ""}
    ),
    entry AS (
      SELECT person_id, display_name, role_id, start_date, end_date,
             source_checked_at, position_id, title, organization_id,
             organization_name, organization_type, county_name, source_id,
             source_title, source_url, source_type, matching_role_count
      FROM candidate WHERE role_rank = 1
      ${unassigned}
    )`;
  return {
    sql,
    parameters: [
      ...officeParameters,
      ...roleParameters,
      ...(scoped || input.pattern === null ? [] : [input.pattern]),
    ],
  };
}

async function countyAssociations(
  runner: DirectoryQueryRunner,
  organizationIds: readonly string[],
): Promise<Map<string, OfficialsCountyAssociation[]>> {
  const result = new Map<string, OfficialsCountyAssociation[]>();
  for (let offset = 0; offset < organizationIds.length; offset += ID_CHUNK) {
    const chunk = organizationIds.slice(offset, offset + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await runner.all(
      `SELECT org.id AS organization_id, county.fips AS fips,
              county.name AS county_name, 1 AS direct,
              NULL AS relationship_type
       FROM organizations AS org
       JOIN counties AS county ON county.fips = org.county_fips
       WHERE org.id IN (${placeholders})
       UNION ALL
       SELECT affiliation.organization_id, county.fips, county.name,
              0, affiliation.relationship_type
       FROM organization_county_affiliations AS affiliation
       JOIN counties AS county ON county.fips = affiliation.county_fips
       WHERE affiliation.organization_id IN (${placeholders})
       ORDER BY county_name COLLATE NOCASE, fips, relationship_type`,
      1_000,
      [...chunk, ...chunk],
    );
    for (const row of rows) {
      const organizationId = text(row.organization_id);
      const list = result.get(organizationId) ?? [];
      result.set(organizationId, list);
      const fips = text(row.fips);
      let index = list.findIndex((county) => county.fips === fips);
      if (index < 0) {
        index =
          list.push({
            fips,
            name: text(row.county_name),
            direct: false,
            affiliations: [],
          }) - 1;
      }
      const entry = list[index];
      if (!entry) continue;
      list[index] = flag(row.direct)
        ? { ...entry, direct: true }
        : {
            ...entry,
            affiliations: [
              ...entry.affiliations,
              text(row.relationship_type) as CountyAffiliationType,
            ],
          };
    }
  }
  return result;
}

export async function listOfficials(
  runner: DirectoryQueryRunner,
  request: OfficialsDirectoryRequest = {},
): Promise<OfficialsDirectoryPage> {
  const input = await validate(runner, request);
  const { sql, parameters } = matchingPeopleSql(input);

  const total = count(
    (
      await runner.first(
        `${sql} SELECT COUNT(*) AS total FROM entry`,
        parameters,
      )
    )?.total,
  );
  const pageCount = Math.max(1, Math.ceil(total / input.limit));

  const direction = input.descending ? "DESC" : "ASC";
  const nullCheck = SORT_NULL_CHECK[input.sort];
  const rows =
    input.page > pageCount
      ? []
      : await runner.all(
          `${sql}
           SELECT * FROM entry
           ORDER BY ${nullCheck ? `${nullCheck}, ` : ""}${SORT_COLUMNS[input.sort]} ${direction},
                    display_name COLLATE NOCASE, person_id COLLATE BINARY
           LIMIT ? OFFSET ?`,
          input.limit,
          [...parameters, input.limit, (input.page - 1) * input.limit],
        );

  const counties = await countyAssociations(runner, [
    ...new Set(
      rows
        .map((row) => optionalText(row.organization_id))
        .filter((id): id is string => id !== null),
    ),
  ]);

  const items = rows.map((row): OfficialsDirectoryEntry => {
    const person = {
      id: text(row.person_id),
      displayName: text(row.display_name),
    };
    const roleId = optionalText(row.role_id);
    if (roleId === null) return { person, role: null, matchingRoleCount: 0 };
    const organizationId = text(row.organization_id);
    return {
      person,
      matchingRoleCount: count(row.matching_role_count),
      role: {
        id: roleId,
        startDate: optionalText(row.start_date),
        endDate: optionalText(row.end_date),
        sourceCheckedAt: text(row.source_checked_at),
        position: { id: text(row.position_id), title: text(row.title) },
        organization: {
          id: organizationId,
          name: text(row.organization_name),
          type: text(row.organization_type) as OrganizationType,
          counties: counties.get(organizationId) ?? [],
        },
        source: {
          id: text(row.source_id),
          title: text(row.source_title),
          url: text(row.source_url),
          type: text(row.source_type),
        },
      },
    };
  });

  return { items, total, page: input.page, pageSize: input.limit, pageCount };
}

/**
 * Organizations recorded for a county, direct and affiliated, with the
 * documented parent links and record counts needed to browse its structure.
 * Nothing is inferred: a parent appears only where a parent link is stored.
 */
export async function getCountyStructure(
  runner: DirectoryQueryRunner,
  request: CountyStructureRequest,
): Promise<CountyStructure> {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => key !== "countyFips")
  ) {
    throw new OfficialsDirectoryInputError("structure request is malformed");
  }
  const county = await requireCounty(runner, request.countyFips);
  const bound = MAX_STRUCTURE_ORGANIZATIONS + 1;

  const rows = await runner.all(
    `SELECT org.id, org.name, org.organization_type,
            org.parent_organization_id, org.parent_relationship,
            org.county_fips = ? AS direct,
            (SELECT COUNT(*) FROM positions AS position
             WHERE position.organization_id = org.id) AS position_count
     FROM organizations AS org
     WHERE org.county_fips = ?
        OR EXISTS (SELECT 1 FROM organization_county_affiliations AS affiliation
                   WHERE affiliation.organization_id = org.id
                     AND affiliation.county_fips = ?)
     ORDER BY org.name COLLATE NOCASE, org.id COLLATE BINARY
     LIMIT ?`,
    bound,
    [county.fips, county.fips, county.fips, bound],
  );
  const truncated = rows.length > MAX_STRUCTURE_ORGANIZATIONS;
  const selected = rows.slice(0, MAX_STRUCTURE_ORGANIZATIONS);

  // Both lookups are keyed by county, not by an ID list, so the statement
  // size does not grow with the number of organizations.
  const affiliations = new Map<string, CountyAffiliationType[]>();
  for (const row of await runner.all(
    `SELECT organization_id, relationship_type
     FROM organization_county_affiliations
     WHERE county_fips = ?
     ORDER BY organization_id COLLATE BINARY, relationship_type
     LIMIT 1000`,
    1_000,
    [county.fips],
  )) {
    const id = text(row.organization_id);
    affiliations.set(id, [
      ...(affiliations.get(id) ?? []),
      text(row.relationship_type) as CountyAffiliationType,
    ]);
  }
  // Distinct people at each organization or any documented subunit of it.
  const people = new Map<string, number>();
  for (const row of await runner.all(
    `WITH RECURSIVE scope(id) AS (
       SELECT id FROM organizations WHERE county_fips = ?
       UNION
       SELECT organization_id FROM organization_county_affiliations
       WHERE county_fips = ?
     ),
     subtree(root_id, organization_id, depth) AS (
       SELECT id, id, 0 FROM scope
       UNION
       SELECT subtree.root_id, child.id, subtree.depth + 1
       FROM organizations AS child
       JOIN subtree ON child.parent_organization_id = subtree.organization_id
       WHERE subtree.depth < ${MAX_HIERARCHY_DEPTH}
     )
     SELECT subtree.root_id AS root_id,
            COUNT(DISTINCT role.person_id) AS people_count
     FROM subtree
     JOIN positions AS position
       ON position.organization_id = subtree.organization_id
     JOIN person_roles AS role ON role.position_id = position.id
     GROUP BY subtree.root_id
     ORDER BY subtree.root_id COLLATE BINARY
     LIMIT 1000`,
    1_000,
    [county.fips, county.fips],
  )) {
    people.set(text(row.root_id), count(row.people_count));
  }

  const organizations = selected.map((row): CountyStructureOrganization => {
    const id = text(row.id);
    const relationship = optionalText(row.parent_relationship);
    return {
      id,
      name: text(row.name),
      type: text(row.organization_type) as OrganizationType,
      parentOrganizationId: optionalText(row.parent_organization_id),
      parentRelationship:
        relationship === "reports_to" || relationship === "grouped_under"
          ? relationship
          : null,
      countyAssociation: {
        direct: flag(row.direct),
        affiliations: affiliations.get(id) ?? [],
      },
      positionCount: count(row.position_count),
      peopleCount: people.get(id) ?? 0,
    };
  });
  return { county, organizations, truncated };
}

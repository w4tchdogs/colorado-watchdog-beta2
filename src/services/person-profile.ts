import {
  type CountyAffiliationType,
  DEFAULT_DIRECTORY_PAGE_SIZE,
  MAX_DIRECTORY_PAGE_SIZE,
  type OrganizationType,
} from "../contracts/directory.js";
import type {
  PersonProfileCounty,
  PersonProfilePage,
  PersonProfilePageRequest,
  PersonProfileRole,
} from "../contracts/person-profile.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

export class PersonProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonProfileInputError";
  }
}

type PageInput = {
  personId: string;
  limit: number;
  afterRoleId: string | null;
};

type MutableCounty = {
  fips: string;
  name: string;
  direct: boolean;
  affiliations: {
    id: string;
    relationshipType: CountyAffiliationType;
    version: number;
  }[];
};

export function getPersonProfile(
  database: WebsiteDatabase,
  request: PersonProfilePageRequest,
): PersonProfilePage | null {
  const input = validateRequest(request);
  const person = database
    .prepare("SELECT id, display_name, version FROM people WHERE id = ?")
    .get(input.personId);
  if (!person) return null;

  const rows = database
    .prepare(
      `SELECT pr.id AS role_id, pr.version AS role_version, pr.start_date, pr.end_date,
              pr.source_checked_at, pos.id AS position_id, pos.title AS position_title,
              pos.version AS position_version, o.id AS organization_id,
              o.name AS organization_name, o.organization_type,
              o.version AS organization_version, s.id AS source_id, s.title AS source_title,
              s.url AS source_url, s.source_type, s.version AS source_version
       FROM person_roles pr
       JOIN positions pos ON pos.id = pr.position_id
       JOIN organizations o ON o.id = pos.organization_id
       JOIN role_sources s ON s.id = pr.source_id
       WHERE pr.person_id = ? AND (? IS NULL OR pr.id COLLATE BINARY > ? COLLATE BINARY)
       ORDER BY pr.id COLLATE BINARY LIMIT ?`,
    )
    .all(input.personId, input.afterRoleId, input.afterRoleId, input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const countiesByOrganization = getOrganizationCounties(
    database,
    selected.map((row) => asString(row.organization_id)),
  );
  const items = selected.map(
    (row): PersonProfileRole => ({
      role: {
        id: asString(row.role_id),
        version: asNumber(row.role_version),
        startDate: nullableString(row.start_date),
        endDate: nullableString(row.end_date),
        sourceCheckedAt: asString(row.source_checked_at),
      },
      position: {
        id: asString(row.position_id),
        title: asString(row.position_title),
        version: asNumber(row.position_version),
      },
      organization: {
        id: asString(row.organization_id),
        name: asString(row.organization_name),
        type: row.organization_type as OrganizationType,
        version: asNumber(row.organization_version),
        counties:
          countiesByOrganization.get(asString(row.organization_id)) ?? [],
      },
      source: {
        id: asString(row.source_id),
        title: asString(row.source_title),
        url: asString(row.source_url),
        type: row.source_type as PersonProfileRole["source"]["type"],
        version: asNumber(row.source_version),
      },
    }),
  );
  const lastItem = items.at(-1);
  return {
    person: {
      id: asString(person.id),
      displayName: asString(person.display_name),
      version: asNumber(person.version),
    },
    items,
    hasMore,
    nextCursor: hasMore && lastItem ? lastItem.role.id : null,
  };
}

function validateRequest(request: PersonProfilePageRequest): PageInput {
  if (
    !request ||
    typeof request.personId !== "string" ||
    !isValidId(request.personId)
  ) {
    throw new PersonProfileInputError("personId is malformed");
  }
  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new PersonProfileInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }
  const afterRoleId = request.afterRoleId ?? null;
  if (afterRoleId !== null && !isValidId(afterRoleId)) {
    throw new PersonProfileInputError("afterRoleId is malformed");
  }
  return { personId: request.personId, limit, afterRoleId };
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function getOrganizationCounties(
  database: WebsiteDatabase,
  organizationIds: readonly string[],
): Map<string, PersonProfileCounty[]> {
  const counties = new Map<string, Map<string, MutableCounty>>();
  if (organizationIds.length === 0) return new Map();
  const placeholders = organizationIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT o.id AS organization_id, c.fips, c.name, 1 AS direct,
              NULL AS relationship_type, NULL AS affiliation_id,
              NULL AS affiliation_version
       FROM organizations o
       JOIN counties c ON c.fips = o.county_fips
       WHERE o.id IN (${placeholders})
       UNION ALL
       SELECT a.organization_id, c.fips, c.name, 0 AS direct,
              a.relationship_type, a.id AS affiliation_id,
              a.version AS affiliation_version
       FROM organization_county_affiliations a
       JOIN counties c ON c.fips = a.county_fips
       WHERE a.organization_id IN (${placeholders})
       ORDER BY organization_id COLLATE BINARY, fips COLLATE BINARY,
                direct DESC, relationship_type COLLATE BINARY`,
    )
    .all(...organizationIds, ...organizationIds);

  for (const row of rows) {
    const organizationId = asString(row.organization_id);
    const fips = asString(row.fips);
    let organizationCounties = counties.get(organizationId);
    if (!organizationCounties) {
      organizationCounties = new Map();
      counties.set(organizationId, organizationCounties);
    }
    let county = organizationCounties.get(fips);
    if (!county) {
      county = {
        fips,
        name: asString(row.name),
        direct: false,
        affiliations: [],
      };
      organizationCounties.set(fips, county);
    }
    if (row.direct === 1) {
      county.direct = true;
    } else {
      county.affiliations.push({
        id: asString(row.affiliation_id),
        relationshipType: row.relationship_type as CountyAffiliationType,
        version: asNumber(row.affiliation_version),
      });
    }
  }

  return new Map(
    [...counties].map(([organizationId, organizationCounties]) => [
      organizationId,
      [...organizationCounties.values()].map(
        (county): PersonProfileCounty => ({
          ...county,
          affiliations: county.affiliations,
        }),
      ),
    ]),
  );
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid person profile record");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Invalid person profile record");
  }
  return value;
}

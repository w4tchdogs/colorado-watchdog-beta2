import {
  DEFAULT_DIRECTORY_PAGE_SIZE,
  MAX_DIRECTORY_PAGE_SIZE,
  type OrganizationType,
} from "../contracts/directory.js";
import {
  MAX_PROFILE_SUBUNITS,
  type OrganizationProfileCounty,
  OrganizationProfilePage,
  OrganizationProfilePageRequest,
  OrganizationProfileParent,
  OrganizationProfilePosition,
  OrganizationRoleEntry,
  OrganizationRolePage,
  OrganizationRolePageRequest,
} from "../contracts/organization-profile.js";
import type { WebsiteDatabase } from "../database/sqlite.js";
import { personIsPublicSql } from "./person-visibility.js";

export class OrganizationProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationProfileInputError";
  }
}

type ProfilePageInput = {
  organizationId: string;
  limit: number;
  afterPositionId: string | null;
};

type RolePageInput = {
  organizationId: string;
  limit: number;
  afterRoleId: string | null;
};

type MutableCounty = {
  fips: string;
  name: string;
  direct: boolean;
  affiliations: {
    id: string;
    relationshipType: OrganizationProfileCounty["affiliations"][number]["relationshipType"];
    version: number;
  }[];
};

export function getOrganizationProfile(
  database: WebsiteDatabase,
  request: OrganizationProfilePageRequest,
): OrganizationProfilePage | null {
  const input = validateProfileRequest(request);
  const organization = database
    .prepare(
      `SELECT id, name, organization_type, version, parent_organization_id, parent_relationship
       FROM organizations WHERE id = ?`,
    )
    .get(input.organizationId);
  if (!organization) return null;

  const rows = database
    .prepare(
      `SELECT id, title, version
       FROM positions
       WHERE organization_id = ?
         AND (? IS NULL OR id COLLATE BINARY > ? COLLATE BINARY)
       ORDER BY id COLLATE BINARY
       LIMIT ?`,
    )
    .all(
      input.organizationId,
      input.afterPositionId,
      input.afterPositionId,
      input.limit + 1,
    );
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const counties = getOrganizationCounties(database, input.organizationId);
  const subunitRows = database
    .prepare(
      `SELECT id, name, organization_type, parent_relationship
       FROM organizations
       WHERE parent_organization_id = ?
       ORDER BY name COLLATE BINARY, id COLLATE BINARY
       LIMIT ?`,
    )
    .all(input.organizationId, MAX_PROFILE_SUBUNITS + 1);

  const parentOrganization =
    organization.parent_organization_id === null
      ? null
      : getParentOrganization(database, organization);

  return {
    organization: {
      id: asString(organization.id),
      name: asString(organization.name),
      type: organization.organization_type as OrganizationType,
      version: asNumber(organization.version),
    },
    parentOrganization,
    subunits: subunitRows.slice(0, MAX_PROFILE_SUBUNITS).map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      type: row.organization_type as OrganizationType,
      relationshipType: row.parent_relationship as
        | "reports_to"
        | "grouped_under",
    })),
    subunitsTruncated: subunitRows.length > MAX_PROFILE_SUBUNITS,
    counties: counties.get(input.organizationId) ?? [],
    items: selected.map(
      (row): OrganizationProfilePosition => ({
        id: asString(row.id),
        title: asString(row.title),
        version: asNumber(row.version),
      }),
    ),
    hasMore,
    nextCursor:
      hasMore && selected.at(-1) ? asString(selected.at(-1)?.id) : null,
  };
}

export function listOrganizationRoleEntries(
  database: WebsiteDatabase,
  request: OrganizationRolePageRequest,
): OrganizationRolePage | null {
  const input = validateRoleRequest(request);
  const organization = database
    .prepare("SELECT 1 AS found FROM organizations WHERE id = ?")
    .get(input.organizationId);
  if (!organization) return null;

  const rows = database
    .prepare(
      `SELECT pr.id AS role_id, pr.version AS role_version, pr.start_date, pr.end_date,
              pr.source_checked_at, p.id AS person_id, p.display_name, p.version AS person_version,
              pos.id AS position_id, pos.title AS position_title, pos.version AS position_version,
              s.id AS source_id, s.title AS source_title, s.url AS source_url,
              s.source_type, s.publisher_classification, s.version AS source_version
       FROM person_roles pr
       JOIN people p ON p.id = pr.person_id
       JOIN positions pos ON pos.id = pr.position_id
       JOIN role_sources s ON s.id = pr.source_id
       WHERE pos.organization_id = ?
         AND ${personIsPublicSql("p.id")}
         AND (? IS NULL OR pr.id COLLATE BINARY > ? COLLATE BINARY)
       ORDER BY pr.id COLLATE BINARY
       LIMIT ?`,
    )
    .all(
      input.organizationId,
      input.afterRoleId,
      input.afterRoleId,
      input.limit + 1,
    );

  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  return {
    items: selected.map(
      (row): OrganizationRoleEntry => ({
        role: {
          id: asString(row.role_id),
          version: asNumber(row.role_version),
          startDate: nullableString(row.start_date),
          endDate: nullableString(row.end_date),
          sourceCheckedAt: asString(row.source_checked_at ?? ""),
        },
        person: {
          id: asString(row.person_id),
          displayName: asString(row.display_name),
          version: asNumber(row.person_version),
        },
        position: {
          id: asString(row.position_id),
          title: asString(row.position_title),
          version: asNumber(row.position_version),
        },
        source: {
          id: asString(row.source_id),
          title: asString(row.source_title),
          url: asString(row.source_url),
          type: row.source_type as OrganizationRoleEntry["source"]["type"],
          ...(row.publisher_classification === "official" ||
          row.publisher_classification === "unofficial"
            ? { publisherClassification: row.publisher_classification }
            : {}),
          version: asNumber(row.source_version),
        },
      }),
    ),
    hasMore,
    nextCursor:
      hasMore && selected.at(-1) ? asString(selected.at(-1)?.role_id) : null,
  };
}

function validateProfileRequest(
  request: OrganizationProfilePageRequest,
): ProfilePageInput {
  if (
    !request ||
    typeof request.organizationId !== "string" ||
    !isValidId(request.organizationId)
  ) {
    throw new OrganizationProfileInputError("organizationId is malformed");
  }

  const allowedKeys = new Set(["organizationId", "limit", "afterPositionId"]);
  const unsupportedKeys = Object.keys(request).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new OrganizationProfileInputError("unsupported request fields");
  }

  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new OrganizationProfileInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }
  const afterPositionId = request.afterPositionId ?? null;
  if (
    afterPositionId !== null &&
    (!isValidId(afterPositionId) || afterPositionId.length < 1)
  ) {
    throw new OrganizationProfileInputError("afterPositionId is malformed");
  }
  return { organizationId: request.organizationId, limit, afterPositionId };
}

function validateRoleRequest(
  request: OrganizationRolePageRequest,
): RolePageInput {
  if (
    !request ||
    typeof request.organizationId !== "string" ||
    !isValidId(request.organizationId)
  ) {
    throw new OrganizationProfileInputError("organizationId is malformed");
  }

  const allowedKeys = new Set(["organizationId", "limit", "afterRoleId"]);
  const unsupportedKeys = Object.keys(request).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new OrganizationProfileInputError("unsupported request fields");
  }

  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new OrganizationProfileInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }

  const afterRoleId = request.afterRoleId ?? null;
  if (afterRoleId !== null && !isValidId(afterRoleId)) {
    throw new OrganizationProfileInputError("afterRoleId is malformed");
  }
  return { organizationId: request.organizationId, limit, afterRoleId };
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function getParentOrganization(
  database: WebsiteDatabase,
  organization: Record<string, unknown>,
): OrganizationProfileParent | null {
  const parentOrganizationId = organization.parent_organization_id;
  const parentRelationship = organization.parent_relationship;
  if (
    parentOrganizationId === null ||
    typeof parentOrganizationId !== "string"
  ) {
    return null;
  }
  const parent = database
    .prepare(
      "SELECT id, name, organization_type FROM organizations WHERE id = ?",
    )
    .get(parentOrganizationId) as
    | { id?: unknown; name?: unknown; organization_type?: unknown }
    | undefined;
  if (!parent) {
    return {
      id: parentOrganizationId,
      name: "",
      type: "other",
      relationshipType: asParentRelationship(parentRelationship),
    };
  }
  return {
    id: asString(parent.id),
    name: asString(parent.name),
    type: parent.organization_type as OrganizationType,
    relationshipType: asParentRelationship(parentRelationship),
  };
}

function asParentRelationship(value: unknown): "reports_to" | "grouped_under" {
  if (value === "reports_to" || value === "grouped_under") {
    return value;
  }
  return "grouped_under";
}

function getOrganizationCounties(
  database: WebsiteDatabase,
  organizationId: string,
): Map<string, OrganizationProfileCounty[]> {
  const counties = new Map<string, MutableCounty>();
  const rows = database
    .prepare(
      `SELECT o.id AS organization_id, c.fips, c.name, 1 AS direct,
              NULL AS affiliation_id, NULL AS relationship_type,
              NULL AS affiliation_version
       FROM organizations o
       JOIN counties c ON c.fips = o.county_fips
       WHERE o.id = ?
       UNION ALL
       SELECT a.organization_id, c.fips, c.name, 0 AS direct,
              a.id AS affiliation_id, a.relationship_type,
              a.version AS affiliation_version
       FROM organization_county_affiliations a
       JOIN counties c ON c.fips = a.county_fips
       WHERE a.organization_id = ?
       ORDER BY fips COLLATE BINARY, direct DESC, relationship_type COLLATE BINARY`,
    )
    .all(organizationId, organizationId);

  for (const row of rows) {
    const fips = asString(row.fips);
    let county = counties.get(fips);
    if (!county) {
      county = {
        fips,
        name: asString(row.name),
        direct: false,
        affiliations: [],
      };
      counties.set(fips, county);
    }
    if (row.direct === 1) {
      county.direct = true;
    } else {
      county.affiliations.push({
        id: asString(row.affiliation_id),
        relationshipType:
          row.relationship_type as OrganizationProfileCounty["affiliations"][number]["relationshipType"],
        version: asNumber(row.affiliation_version),
      });
    }
  }

  return new Map([
    [organizationId, [...counties.values()].map((county) => ({ ...county }))],
  ]);
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid organization profile record");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Invalid organization profile record");
  }
  return value;
}

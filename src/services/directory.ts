import {
  type CountyAffiliationType,
  type CountyOrganization,
  type CountyRoleEntry,
  DEFAULT_DIRECTORY_PAGE_SIZE,
  type DirectoryPage,
  type DirectoryPageRequest,
  MAX_DIRECTORY_PAGE_SIZE,
  type OrganizationType,
} from "../contracts/directory.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

export class DirectoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryInputError";
  }
}

type PageInput = { countyFips: string; limit: number; afterId: string | null };

export function listCountyOrganizations(
  database: WebsiteDatabase,
  request: DirectoryPageRequest,
): DirectoryPage<CountyOrganization> {
  const input = validateRequest(database, request);
  if (!input) return emptyPage();
  const rows = database
    .prepare(
      `SELECT o.id, o.name, o.organization_type, o.version, o.parent_organization_id,
            o.parent_relationship, o.county_fips = ? AS direct,
            COALESCE((SELECT GROUP_CONCAT(relationship_type, ',') FROM (
              SELECT relationship_type FROM organization_county_affiliations a
              WHERE a.organization_id = o.id AND a.county_fips = ?
              ORDER BY relationship_type
            )), '') AS affiliation_types
     FROM organizations o
     WHERE (o.county_fips = ? OR EXISTS (
       SELECT 1 FROM organization_county_affiliations a
       WHERE a.organization_id = o.id AND a.county_fips = ?
     )) AND (? IS NULL OR o.id > ?)
     ORDER BY o.id COLLATE BINARY LIMIT ?`,
    )
    .all(
      input.countyFips,
      input.countyFips,
      input.countyFips,
      input.countyFips,
      input.afterId,
      input.afterId,
      input.limit + 1,
    );
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = selected.map(
    (row): CountyOrganization => ({
      id: asString(row.id),
      name: asString(row.name),
      type: row.organization_type as OrganizationType,
      version: asNumber(row.version),
      parentOrganizationId: nullableString(row.parent_organization_id),
      parentRelationship:
        row.parent_relationship as CountyOrganization["parentRelationship"],
      countyAssociation: {
        direct: row.direct === 1,
        affiliations: asString(row.affiliation_types)
          .split(",")
          .filter(Boolean) as CountyAffiliationType[],
      },
    }),
  );
  return page(items, hasMore, (item) => item.id);
}

export function listCountyRoleEntries(
  database: WebsiteDatabase,
  request: DirectoryPageRequest,
): DirectoryPage<CountyRoleEntry> {
  const input = validateRequest(database, request);
  if (!input) return emptyPage();
  const rows = database
    .prepare(
      `SELECT pr.id AS role_id, pr.version AS role_version, pr.start_date, pr.end_date,
            pr.source_checked_at, p.id AS person_id, p.display_name, p.version AS person_version,
            pos.id AS position_id, pos.title AS position_title, pos.version AS position_version,
            o.id AS organization_id, o.name AS organization_name,
            o.organization_type, o.version AS organization_version,
            o.county_fips = ? AS direct,
            COALESCE((SELECT GROUP_CONCAT(relationship_type, ',') FROM (
              SELECT relationship_type FROM organization_county_affiliations a
              WHERE a.organization_id = o.id AND a.county_fips = ?
              ORDER BY relationship_type
            )), '') AS affiliation_types,
            s.id AS source_id, s.title AS source_title, s.url AS source_url,
            s.source_type, s.publisher_classification, s.version AS source_version
     FROM person_roles pr
     JOIN people p ON p.id = pr.person_id
     JOIN positions pos ON pos.id = pr.position_id
     JOIN organizations o ON o.id = pos.organization_id
     JOIN role_sources s ON s.id = pr.source_id
     WHERE (o.county_fips = ? OR EXISTS (
       SELECT 1 FROM organization_county_affiliations a
       WHERE a.organization_id = o.id AND a.county_fips = ?
     )) AND (? IS NULL OR pr.id > ?)
     ORDER BY pr.id COLLATE BINARY LIMIT ?`,
    )
    .all(
      input.countyFips,
      input.countyFips,
      input.countyFips,
      input.countyFips,
      input.afterId,
      input.afterId,
      input.limit + 1,
    );
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit).map((row): CountyRoleEntry => {
    const association = {
      direct: row.direct === 1,
      affiliations: asString(row.affiliation_types)
        .split(",")
        .filter(Boolean) as CountyAffiliationType[],
    };
    return {
      person: {
        id: asString(row.person_id),
        displayName: asString(row.display_name),
        version: asNumber(row.person_version),
      },
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
        countyAssociation: association,
      },
      source: {
        id: asString(row.source_id),
        title: asString(row.source_title),
        url: asString(row.source_url),
        type: row.source_type as CountyRoleEntry["source"]["type"],
        ...(row.publisher_classification === "official" ||
        row.publisher_classification === "unofficial"
          ? { publisherClassification: row.publisher_classification }
          : {}),
        version: asNumber(row.source_version),
      },
    };
  });
  return page(items, hasMore, (item) => item.role.id);
}

function validateRequest(
  database: WebsiteDatabase,
  request: DirectoryPageRequest,
): PageInput | null {
  if (
    !request ||
    typeof request.countyFips !== "string" ||
    !/^08\d{3}$/.test(request.countyFips)
  ) {
    throw new DirectoryInputError(
      "countyFips must be a five-digit Colorado FIPS code",
    );
  }
  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new DirectoryInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }
  const afterId = request.afterId ?? null;
  if (
    afterId !== null &&
    (typeof afterId !== "string" ||
      afterId.length < 1 ||
      afterId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(afterId))
  ) {
    throw new DirectoryInputError("afterId is malformed");
  }
  const known = database
    .prepare("SELECT 1 AS found FROM counties WHERE fips = ?")
    .get(request.countyFips);
  return known ? { countyFips: request.countyFips, limit, afterId } : null;
}

function page<T>(
  items: T[],
  hasMore: boolean,
  cursorFor: (item: T) => string,
): DirectoryPage<T> {
  const lastItem = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && lastItem ? cursorFor(lastItem) : null,
  };
}

function emptyPage<T>(): DirectoryPage<T> {
  return { items: [], hasMore: false, nextCursor: null };
}
function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid directory record");
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}
function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Invalid directory record");
  return value;
}

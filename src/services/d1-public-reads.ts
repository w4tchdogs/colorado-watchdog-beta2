import type { CountyOverview } from "../contracts/county-overview.js";
import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import type {
  CountyAffiliationType,
  CountyOrganization,
  CountyRoleEntry,
  DirectoryPage,
  DirectoryPageRequest,
  OrganizationType,
} from "../contracts/directory.js";
import {
  DEFAULT_DIRECTORY_PAGE_SIZE,
  MAX_DIRECTORY_PAGE_SIZE,
} from "../contracts/directory.js";
import type {
  DirectorySearchRequest,
  OrganizationSearchPage,
  PersonSearchPage,
} from "../contracts/directory-search.js";
import {
  MAX_PROFILE_SUBUNITS,
  type OrganizationProfilePage,
  type OrganizationProfilePageRequest,
  type OrganizationRoleEntry,
  type OrganizationRolePage,
  type OrganizationRolePageRequest,
} from "../contracts/organization-profile.js";
import type {
  PersonProfileCounty,
  PersonProfilePage,
  PersonProfilePageRequest,
  PersonProfileRole,
} from "../contracts/person-profile.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import type { AsyncD1Database } from "../database/d1.js";
import type { PublicSiteServiceResults } from "../site/types.js";
import { CountyOverviewInputError } from "./county-overview.js";
import { DirectoryInputError } from "./directory.js";
import {
  browseOrganizations,
  browsePeople,
  DirectorySearchInputError,
} from "./directory-search.js";
import {
  d1DirectoryRunner,
  getCountyStructure,
  listOfficials,
} from "./officials-directory.js";
import { OrganizationProfileInputError } from "./organization-profile.js";
import { PersonProfileInputError } from "./person-profile.js";
import {
  PUBLIC_ALTERNATE_NAMES_SQL,
  personIsPublicSql,
  publicPersonNameMatchSql,
  toPublicAlternateName,
} from "./person-visibility.js";

type Row = Record<string, unknown>;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ROWS = 101;

/** Read-only D1 adapter for the same projections consumed by the public site. */
export function createD1PublicReadServices(
  database: AsyncD1Database,
): PublicSiteServiceResults {
  const first = <T extends Row>(
    sql: string,
    ...values: (string | number | null)[]
  ) => database.first<T>(sql, values);
  const all = <T extends Row>(
    sql: string,
    ...values: (string | number | null)[]
  ) => database.all<T>(sql, MAX_ROWS, values);
  const allAssociations = <T extends Row>(
    sql: string,
    ...values: (string | number | null)[]
  ) => database.all<T>(sql, 1_000, values);

  async function listCounties(): Promise<readonly CountyRegistryEntry[]> {
    const rows = await all<Row>(
      "SELECT fips, name FROM counties ORDER BY name COLLATE NOCASE, fips LIMIT 65",
    );
    return rows.map((row) => ({ fips: str(row.fips), name: str(row.name) }));
  }

  async function getCountyOverview(input: {
    countyFips: string;
  }): Promise<CountyOverview | null> {
    if (!input || !/^08\d{3}$/.test(input.countyFips))
      throw new CountyOverviewInputError("Invalid county FIPS");
    const row = await first<Row>(
      `WITH associations AS (
      SELECT id organization_id, 1 direct, 0 affiliated FROM organizations WHERE county_fips = ?
      UNION ALL SELECT organization_id, 0, 1 FROM organization_county_affiliations WHERE county_fips = ?
    ), county_organizations AS (
      SELECT organization_id, MAX(direct) direct, MAX(affiliated) affiliated FROM associations GROUP BY organization_id
    ), role_counts AS (
      SELECT pos.organization_id, COUNT(*) role_count FROM county_organizations co
      JOIN positions pos ON pos.organization_id = co.organization_id
      JOIN person_roles pr ON pr.position_id = pos.id
      WHERE ${personIsPublicSql("pr.person_id")}
      GROUP BY pos.organization_id
    ) SELECT c.fips, c.name, COUNT(co.organization_id) total_organizations,
      COALESCE(SUM(co.direct),0) direct_organizations, COALESCE(SUM(co.affiliated),0) affiliated_organizations,
      COALESCE(SUM(rc.role_count),0) + (SELECT COUNT(*) FROM person_roles u WHERE u.position_id IS NULL AND u.county_fips=? AND ${personIsPublicSql("u.person_id")}) documented_role_count FROM counties c
      LEFT JOIN county_organizations co ON 1=1 LEFT JOIN role_counts rc ON rc.organization_id=co.organization_id
      WHERE c.fips=? GROUP BY c.fips,c.name`,
      input.countyFips,
      input.countyFips,
      input.countyFips,
      input.countyFips,
    );
    return row
      ? {
          county: { fips: str(row.fips), name: str(row.name) },
          organizationCounts: {
            total: num(row.total_organizations),
            direct: num(row.direct_organizations),
            affiliated: num(row.affiliated_organizations),
          },
          documentedRoleCount: num(row.documented_role_count),
        }
      : null;
  }

  async function listCountyOrganizations(
    input: DirectoryPageRequest,
  ): Promise<DirectoryPage<CountyOrganization>> {
    const page = await validateCounty(input);
    if (!page) return emptyPage();
    const rows = await all<Row>(
      `SELECT o.id,o.name,o.organization_type,o.version,o.parent_organization_id,o.parent_relationship,
      o.county_fips=? direct, COALESCE((SELECT GROUP_CONCAT(relationship_type, ',') FROM (
        SELECT relationship_type FROM organization_county_affiliations a WHERE a.organization_id=o.id AND a.county_fips=? ORDER BY relationship_type
      )), '') affiliation_types FROM organizations o WHERE (o.county_fips=? OR EXISTS (
        SELECT 1 FROM organization_county_affiliations a WHERE a.organization_id=o.id AND a.county_fips=?
      )) AND (? IS NULL OR o.id COLLATE BINARY>?) ORDER BY o.id COLLATE BINARY LIMIT ?`,
      page.countyFips,
      page.countyFips,
      page.countyFips,
      page.countyFips,
      page.afterId,
      page.afterId,
      page.limit + 1,
    );
    const selected = rows.slice(0, page.limit);
    return makePage(
      selected.map(
        (r): CountyOrganization => ({
          id: str(r.id),
          name: str(r.name),
          type: r.organization_type as OrganizationType,
          version: num(r.version),
          parentOrganizationId: nullable(r.parent_organization_id),
          parentRelationship:
            r.parent_relationship as CountyOrganization["parentRelationship"],
          countyAssociation: {
            direct: r.direct === true || r.direct === 1,
            affiliations: str(r.affiliation_types)
              .split(",")
              .filter(Boolean) as CountyAffiliationType[],
          },
        }),
      ),
      rows.length > page.limit,
      (item) => item.id,
    );
  }

  async function listCountyRoleEntries(
    input: DirectoryPageRequest,
  ): Promise<DirectoryPage<CountyRoleEntry>> {
    const page = await validateCounty(input);
    if (!page) return emptyPage();
    const rows = await all<Row>(
      `SELECT pr.id role_id,pr.version role_version,pr.start_date,pr.end_date,pr.source_checked_at,
      pr.published_office,pr.published_title,pr.job_description,
      p.id person_id,p.display_name,p.version person_version,pos.id position_id,pos.title position_title,pos.version position_version,
      o.id organization_id,o.name organization_name,o.organization_type,o.version organization_version,o.county_fips=? direct,
      COALESCE((SELECT GROUP_CONCAT(relationship_type, ',') FROM (SELECT relationship_type FROM organization_county_affiliations a
        WHERE a.organization_id=o.id AND a.county_fips=? ORDER BY relationship_type)), '') affiliation_types,
      s.id source_id,s.title source_title,s.url source_url,s.source_type,s.publisher_classification,s.version source_version
      FROM person_roles pr JOIN people p ON p.id=pr.person_id LEFT JOIN positions pos ON pos.id=pr.position_id
      LEFT JOIN organizations o ON o.id=pos.organization_id LEFT JOIN role_sources s ON s.id=pr.source_id
      WHERE (pr.county_fips=? OR o.county_fips=? OR EXISTS (SELECT 1 FROM organization_county_affiliations a WHERE a.organization_id=o.id AND a.county_fips=?))
      AND ${personIsPublicSql("p.id")} AND (? IS NULL OR pr.id COLLATE BINARY>?) ORDER BY pr.id COLLATE BINARY LIMIT ?`,
      page.countyFips,
      page.countyFips,
      page.countyFips,
      page.countyFips,
      page.countyFips,
      page.afterId,
      page.afterId,
      page.limit + 1,
    );
    const selected = rows.slice(0, page.limit);
    const items = selected.map(
      (r): CountyRoleEntry => ({
        person: {
          id: str(r.person_id),
          displayName: str(r.display_name),
          version: num(r.person_version),
        },
        role: {
          id: str(r.role_id),
          version: num(r.role_version),
          startDate: nullable(r.start_date),
          endDate: nullable(r.end_date),
          sourceCheckedAt: str(r.source_checked_at ?? ""),
          publishedOffice: nullable(r.published_office),
          publishedTitle: nullable(r.published_title),
          jobDescription: nullable(r.job_description),
        },
        position:
          r.position_id === null
            ? null
            : {
                id: str(r.position_id),
                title: str(r.position_title),
                version: num(r.position_version),
              },
        organization:
          r.organization_id === null
            ? null
            : {
                id: str(r.organization_id),
                name: str(r.organization_name),
                type: r.organization_type as OrganizationType,
                version: num(r.organization_version),
                countyAssociation: {
                  direct: r.direct === true || r.direct === 1,
                  affiliations: str(r.affiliation_types)
                    .split(",")
                    .filter(Boolean) as CountyAffiliationType[],
                },
              },
        source:
          r.source_id == null
            ? null
            : {
                id: str(r.source_id),
                title: str(r.source_title),
                url: str(r.source_url),
                type: r.source_type as NonNullable<
                  CountyRoleEntry["source"]
                >["type"],
                ...(r.publisher_classification === "official" ||
                r.publisher_classification === "unofficial"
                  ? { publisherClassification: r.publisher_classification }
                  : {}),
                version: num(r.source_version),
              },
      }),
    );
    return makePage(items, rows.length > page.limit, (item) => item.role.id);
  }

  const directoryRunner = d1DirectoryRunner(database);
  async function browse<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof DirectorySearchInputError) throw error;
      throw new StorageUnavailableError();
    }
  }

  async function searchPeople(input: DirectorySearchRequest) {
    return (await search(input, "people")) as PersonSearchPage;
  }
  async function searchOrganizations(input: DirectorySearchRequest) {
    return (await search(input, "organizations")) as OrganizationSearchPage;
  }
  async function search(
    input: DirectorySearchRequest,
    kind: "people" | "organizations",
  ) {
    const query = input?.query?.trim();
    if (typeof query !== "string" || query.length < 2 || query.length > 100)
      throw new DirectorySearchInputError("Invalid search query");
    const limit = input.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE
    )
      throw new DirectorySearchInputError("Invalid page limit");
    const cfg =
      kind === "people"
        ? { table: "people", column: "display_name" }
        : { table: "organizations", column: "name" };
    const publicOnly =
      kind === "people" ? ` AND ${personIsPublicSql("people.id")}` : "";
    // People match on the display name or a public alternate name only.
    const nameMatch =
      kind === "people"
        ? publicPersonNameMatchSql(cfg.column, "people.id")
        : `${cfg.column} LIKE ? ESCAPE '\\'`;
    const pattern = `%${escapeLike(query)}%`;
    const patterns = kind === "people" ? [pattern, pattern] : [pattern];
    const cursor = input.cursor ?? null;
    let afterName: string | null = null;
    let afterId: string | null = null;
    if (cursor !== null) {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new DirectorySearchInputError("Invalid cursor");
      try {
        const decoded = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(
              atob(cursor.replace(/-/g, "+").replace(/_/g, "/")),
              (c) => c.charCodeAt(0),
            ),
          ),
        ) as Record<string, unknown>;
        if (
          decoded.version !== 1 ||
          decoded.kind !== kind ||
          decoded.query !== query ||
          typeof decoded.id !== "string" ||
          !ID.test(decoded.id)
        )
          throw new Error();
        afterId = decoded.id;
      } catch {
        throw new DirectorySearchInputError("Invalid cursor");
      }
      const cur = await first<Row>(
        `SELECT ${cfg.column} name FROM ${cfg.table} WHERE id=? AND ${nameMatch}${publicOnly}`,
        afterId,
        ...patterns,
      );
      if (!cur) throw new DirectorySearchInputError("Stale cursor");
      afterName = str(cur.name);
    }
    const rows = await all<Row>(
      `SELECT id,${cfg.column} name,version${kind === "organizations" ? ",organization_type" : ""} FROM ${cfg.table}
      WHERE ${nameMatch}${publicOnly} AND (? IS NULL OR ${cfg.column} COLLATE NOCASE>? COLLATE NOCASE OR
      (${cfg.column} COLLATE NOCASE=? COLLATE NOCASE AND id COLLATE BINARY>? COLLATE BINARY))
      ORDER BY ${cfg.column} COLLATE NOCASE,id COLLATE BINARY LIMIT ?`,
      ...patterns,
      afterName,
      afterName,
      afterName,
      afterId,
      limit + 1,
    );
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected.map((r) =>
        kind === "people"
          ? { id: str(r.id), displayName: str(r.name), version: num(r.version) }
          : {
              id: str(r.id),
              name: str(r.name),
              type: r.organization_type as OrganizationType,
              version: num(r.version),
            },
      ),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ version: 1, kind, query, id: str(last.id) })
          : null,
    };
  }

  async function getPersonProfile(
    input: PersonProfilePageRequest,
  ): Promise<PersonProfilePage | null> {
    const { personId, limit, after } = validateProfile(input, "person");
    const person = await first<Row>(
      `SELECT id,display_name,version FROM people WHERE id=? AND ${personIsPublicSql("people.id")}`,
      personId,
    );
    if (!person) return null;
    const rows = await all<Row>(
      `SELECT pr.id role_id,pr.version role_version,pr.start_date,pr.end_date,pr.source_checked_at,
      pr.county_fips role_county_fips,rc.name role_county_name,pr.published_office,pr.published_title,pr.job_description,
      pos.id position_id,pos.title position_title,pos.version position_version,o.id organization_id,o.name organization_name,o.organization_type,o.version organization_version,
      s.id source_id,s.title source_title,s.url source_url,s.source_type,s.publisher_classification,s.version source_version FROM person_roles pr
      LEFT JOIN positions pos ON pos.id=pr.position_id LEFT JOIN organizations o ON o.id=pos.organization_id
      LEFT JOIN counties rc ON rc.fips=pr.county_fips LEFT JOIN role_sources s ON s.id=pr.source_id
      WHERE pr.person_id=? AND (? IS NULL OR pr.id COLLATE BINARY>?) ORDER BY pr.id COLLATE BINARY LIMIT ?`,
      personId,
      after,
      after,
      limit + 1,
    );
    const selected = rows.slice(0, limit),
      counties = await organizationCounties(
        selected.flatMap((r) =>
          r.organization_id === null ? [] : [str(r.organization_id)],
        ),
      );
    const items = selected.map(
      (r): PersonProfileRole => ({
        role: {
          id: str(r.role_id),
          version: num(r.role_version),
          startDate: nullable(r.start_date),
          endDate: nullable(r.end_date),
          sourceCheckedAt: str(r.source_checked_at ?? ""),
          county:
            r.role_county_fips === null
              ? null
              : {
                  fips: str(r.role_county_fips),
                  name: str(r.role_county_name),
                },
          publishedOffice: nullable(r.published_office),
          publishedTitle: nullable(r.published_title),
          jobDescription: nullable(r.job_description),
        },
        position:
          r.position_id === null
            ? null
            : {
                id: str(r.position_id),
                title: str(r.position_title),
                version: num(r.position_version),
              },
        organization:
          r.organization_id === null
            ? null
            : {
                id: str(r.organization_id),
                name: str(r.organization_name),
                type: r.organization_type as OrganizationType,
                version: num(r.organization_version),
                counties: counties.get(str(r.organization_id)) ?? [],
              },
        source:
          r.source_id == null
            ? null
            : {
                id: str(r.source_id),
                title: str(r.source_title),
                url: str(r.source_url),
                type: r.source_type as NonNullable<
                  PersonProfileRole["source"]
                >["type"],
                ...(r.publisher_classification === "official" ||
                r.publisher_classification === "unofficial"
                  ? { publisherClassification: r.publisher_classification }
                  : {}),
                version: num(r.source_version),
              },
      }),
    );
    return {
      person: {
        id: str(person.id),
        displayName: str(person.display_name),
        version: num(person.version),
        alternateNames: (
          await all<Row>(PUBLIC_ALTERNATE_NAMES_SQL, personId)
        ).map((row) =>
          toPublicAlternateName(row.name_type, row.published_name),
        ),
      },
      items,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? (items.at(-1)?.role.id ?? null) : null,
    };
  }

  async function getOrganizationProfile(
    input: OrganizationProfilePageRequest,
  ): Promise<OrganizationProfilePage | null> {
    const id = input?.organizationId;
    if (!validPageInput(id, input?.limit, input?.afterPositionId))
      throw new OrganizationProfileInputError(
        "Invalid organization profile request",
      );
    const limit = input.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE,
      after = input.afterPositionId ?? null;
    const org = await first<Row>(
      "SELECT id,name,organization_type,version,parent_organization_id,parent_relationship FROM organizations WHERE id=?",
      id,
    );
    if (!org) return null;
    const rows = await all<Row>(
      "SELECT id,title,version FROM positions WHERE organization_id=? AND (? IS NULL OR id COLLATE BINARY>?) ORDER BY id COLLATE BINARY LIMIT ?",
      id,
      after,
      after,
      limit + 1,
    );
    const selected = rows.slice(0, limit),
      counties = (await organizationCounties([id])).get(id) ?? [];
    const subunitRows = await all<Row>(
      "SELECT id,name,organization_type,parent_relationship FROM organizations WHERE parent_organization_id=? ORDER BY name COLLATE BINARY, id COLLATE BINARY LIMIT ?",
      id,
      MAX_PROFILE_SUBUNITS + 1,
    );
    const parentId = nullable(org.parent_organization_id);
    let parentOrganization = null;
    if (parentId) {
      const p = await first<Row>(
        "SELECT id,name,organization_type FROM organizations WHERE id=?",
        parentId,
      );
      parentOrganization = {
        id: parentId,
        name: p ? str(p.name) : "",
        type: p ? (p.organization_type as OrganizationType) : "other",
        relationshipType: org.parent_relationship as
          | "reports_to"
          | "grouped_under",
      };
    }
    return {
      organization: {
        id: str(org.id),
        name: str(org.name),
        type: org.organization_type as OrganizationType,
        version: num(org.version),
      },
      parentOrganization,
      subunits: subunitRows.slice(0, MAX_PROFILE_SUBUNITS).map((r) => ({
        id: str(r.id),
        name: str(r.name),
        type: r.organization_type as OrganizationType,
        relationshipType: r.parent_relationship as
          | "reports_to"
          | "grouped_under",
      })),
      subunitsTruncated: subunitRows.length > MAX_PROFILE_SUBUNITS,
      counties,
      items: selected.map((r) => ({
        id: str(r.id),
        title: str(r.title),
        version: num(r.version),
      })),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? str(selected.at(-1)?.id) : null,
    };
  }

  async function listOrganizationRoleEntries(
    input: OrganizationRolePageRequest,
  ): Promise<OrganizationRolePage | null> {
    const id = input?.organizationId;
    if (!validPageInput(id, input?.limit, input?.afterRoleId))
      throw new OrganizationProfileInputError(
        "Invalid organization role request",
      );
    const limit = input.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE,
      after = input.afterRoleId ?? null;
    if (!(await first<Row>("SELECT 1 found FROM organizations WHERE id=?", id)))
      return null;
    const rows = await all<Row>(
      `SELECT pr.id role_id,pr.version role_version,pr.start_date,pr.end_date,pr.source_checked_at,p.id person_id,p.display_name,p.version person_version,
      pos.id position_id,pos.title position_title,pos.version position_version,s.id source_id,s.title source_title,s.url source_url,s.source_type,s.publisher_classification,s.version source_version
      FROM person_roles pr JOIN people p ON p.id=pr.person_id JOIN positions pos ON pos.id=pr.position_id LEFT JOIN role_sources s ON s.id=pr.source_id
      WHERE pos.organization_id=? AND ${personIsPublicSql("p.id")} AND (? IS NULL OR pr.id COLLATE BINARY>?) ORDER BY pr.id COLLATE BINARY LIMIT ?`,
      id,
      after,
      after,
      limit + 1,
    );
    const selected = rows.slice(0, limit).map(
      (r): OrganizationRoleEntry => ({
        role: {
          id: str(r.role_id),
          version: num(r.role_version),
          startDate: nullable(r.start_date),
          endDate: nullable(r.end_date),
          sourceCheckedAt: str(r.source_checked_at ?? ""),
        },
        person: {
          id: str(r.person_id),
          displayName: str(r.display_name),
          version: num(r.person_version),
        },
        position: {
          id: str(r.position_id),
          title: str(r.position_title),
          version: num(r.position_version),
        },
        source:
          r.source_id == null
            ? null
            : {
                id: str(r.source_id),
                title: str(r.source_title),
                url: str(r.source_url),
                type: r.source_type as NonNullable<
                  OrganizationRoleEntry["source"]
                >["type"],
                ...(r.publisher_classification === "official" ||
                r.publisher_classification === "unofficial"
                  ? { publisherClassification: r.publisher_classification }
                  : {}),
                version: num(r.source_version),
              },
      }),
    );
    return {
      items: selected,
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit ? (selected.at(-1)?.role.id ?? null) : null,
    };
  }

  return {
    listCounties,
    getCountyOverview,
    listCountyOrganizations,
    listCountyRoleEntries,
    browsePeople: (input) => browse(() => browsePeople(directoryRunner, input)),
    browseOrganizations: (input) =>
      browse(() => browseOrganizations(directoryRunner, input)),
    searchPeople,
    searchOrganizations,
    getPersonProfile,
    getOrganizationProfile,
    listOrganizationRoleEntries,
    // The officials directory runs the same SQL on both runtimes.
    listOfficials: (input) => listOfficials(d1DirectoryRunner(database), input),
    getCountyStructure: (input) =>
      getCountyStructure(d1DirectoryRunner(database), input),
  };

  async function validateCounty(input: DirectoryPageRequest) {
    if (
      !input ||
      typeof input.countyFips !== "string" ||
      !/^08\d{3}$/.test(input.countyFips)
    )
      throw new DirectoryInputError("Invalid county FIPS");
    const limit = input.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE,
      afterId = input.afterId ?? null;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE ||
      (afterId !== null && !ID.test(afterId))
    )
      throw new DirectoryInputError("Invalid county page");
    return (await first<Row>(
      "SELECT 1 found FROM counties WHERE fips=?",
      input.countyFips,
    ))
      ? { countyFips: input.countyFips, limit, afterId }
      : null;
  }
  async function organizationCounties(
    ids: readonly string[],
  ): Promise<Map<string, PersonProfileCounty[]>> {
    if (!ids.length) return new Map();
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
    const map = new Map<string, Map<string, MutableCounty>>();
    for (let offset = 0; offset < ids.length; offset += 10) {
      const chunk = ids.slice(offset, offset + 10);
      const marks = chunk.map(() => "?").join(",");
      const rows = await allAssociations<Row>(
        `SELECT o.id organization_id,c.fips,c.name,1 direct,NULL affiliation_id,NULL relationship_type,NULL affiliation_version
      FROM organizations o JOIN counties c ON c.fips=o.county_fips WHERE o.id IN (${marks}) UNION ALL
      SELECT a.organization_id,c.fips,c.name,0,a.id,a.relationship_type,a.version FROM organization_county_affiliations a
      JOIN counties c ON c.fips=a.county_fips WHERE a.organization_id IN (${marks})
      ORDER BY organization_id COLLATE BINARY,fips COLLATE BINARY,direct DESC,relationship_type COLLATE BINARY`,
        ...chunk,
        ...chunk,
      );
      for (const r of rows) {
        const oid = str(r.organization_id),
          fips = str(r.fips);
        let counties = map.get(oid);
        if (!counties) {
          counties = new Map();
          map.set(oid, counties);
        }
        let c = counties.get(fips);
        if (!c) {
          c = { fips, name: str(r.name), direct: false, affiliations: [] };
          counties.set(fips, c);
        }
        if (r.direct === true || r.direct === 1) c.direct = true;
        else
          c.affiliations.push({
            id: str(r.affiliation_id),
            relationshipType: r.relationship_type as CountyAffiliationType,
            version: num(r.affiliation_version),
          });
      }
    }
    return new Map<string, PersonProfileCounty[]>(
      [...map].map(([id, counties]) => [id, [...counties.values()]]),
    );
  }
}

function validPageInput(id: unknown, limit: unknown, cursor: unknown): boolean {
  return (
    typeof id === "string" &&
    ID.test(id) &&
    (limit === undefined ||
      (Number.isInteger(limit) &&
        (limit as number) >= 1 &&
        (limit as number) <= MAX_DIRECTORY_PAGE_SIZE)) &&
    (cursor === undefined ||
      cursor === null ||
      (typeof cursor === "string" && ID.test(cursor)))
  );
}
function validateProfile(
  input: PersonProfilePageRequest,
  kind: "person",
): { personId: string; limit: number; after: string | null };
function validateProfile(input: PersonProfilePageRequest, kind: string): never;
function validateProfile(input: PersonProfilePageRequest, kind: string) {
  const id = input?.personId,
    limit = input?.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE,
    after = input?.afterRoleId ?? null;
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE ||
    (after !== null && !ID.test(after))
  )
    throw new PersonProfileInputError(`Invalid ${kind} profile request`);
  return { personId: id, limit, after };
}
function emptyPage<T>(): DirectoryPage<T> {
  return { items: [], hasMore: false, nextCursor: null };
}
function makePage<T>(
  items: T[],
  hasMore: boolean,
  cursor: (item: T) => string,
): DirectoryPage<T> {
  const last = items.at(-1);
  return { items, hasMore, nextCursor: hasMore && last ? cursor(last) : null };
}
function str(value: unknown): string {
  if (typeof value !== "string")
    throw new Error(`Invalid D1 public string field (${typeof value})`);
  return value;
}
function num(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "number")
    throw new Error(
      `Invalid D1 public number field (${typeof value}, ${Object.prototype.toString.call(value)})`,
    );
  return value;
}
function nullable(value: unknown): string | null {
  return value === null ? null : str(value);
}
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
function encodeCursor(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

import type {
  CountyOverview,
  CountyOverviewRequest,
} from "../contracts/county-overview.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

export class CountyOverviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CountyOverviewInputError";
  }
}

export function getCountyOverview(
  database: WebsiteDatabase,
  request: CountyOverviewRequest,
): CountyOverview | null {
  if (
    !request ||
    typeof request.countyFips !== "string" ||
    !/^08\d{3}$/.test(request.countyFips)
  ) {
    throw new CountyOverviewInputError(
      "countyFips must be a five-digit Colorado FIPS code",
    );
  }

  const row = database
    .prepare(
      `WITH associations AS (
         SELECT id AS organization_id, 1 AS direct, 0 AS affiliated
         FROM organizations
         WHERE county_fips = ?
         UNION ALL
         SELECT organization_id, 0 AS direct, 1 AS affiliated
         FROM organization_county_affiliations
         WHERE county_fips = ?
       ),
       county_organizations AS (
         SELECT organization_id, MAX(direct) AS direct, MAX(affiliated) AS affiliated
         FROM associations
         GROUP BY organization_id
       ),
       role_counts AS (
         SELECT pos.organization_id, COUNT(*) AS role_count
         FROM county_organizations co
         JOIN positions pos ON pos.organization_id = co.organization_id
         JOIN person_roles pr ON pr.position_id = pos.id
         JOIN role_sources source ON source.id = pr.source_id
         GROUP BY pos.organization_id
       )
       SELECT c.fips, c.name,
              COUNT(co.organization_id) AS total_organizations,
              COALESCE(SUM(co.direct), 0) AS direct_organizations,
              COALESCE(SUM(co.affiliated), 0) AS affiliated_organizations,
              COALESCE(SUM(rc.role_count), 0) AS documented_role_count
       FROM counties c
       LEFT JOIN county_organizations co ON 1 = 1
       LEFT JOIN role_counts rc ON rc.organization_id = co.organization_id
       WHERE c.fips = ?
       GROUP BY c.fips, c.name`,
    )
    .get(request.countyFips, request.countyFips, request.countyFips);

  if (!row) return null;
  return {
    county: {
      fips: asString(row.fips),
      name: asString(row.name),
    },
    organizationCounts: {
      total: asNumber(row.total_organizations),
      direct: asNumber(row.direct_organizations),
      affiliated: asNumber(row.affiliated_organizations),
    },
    documentedRoleCount: asNumber(row.documented_role_count),
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid county overview record");
  }
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Invalid county overview record");
  }
  return value;
}

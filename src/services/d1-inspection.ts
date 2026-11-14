import type { AsyncD1Database } from "../database/d1.js";
import type { TrustedPrincipal } from "./security.js";

export interface CanonicalMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

export type InspectedCountyFips = "08065" | "08067";
export type InspectionClassification =
  | "supported canonical association"
  | "legacy name-based selection evidence"
  | "potential misassignment"
  | "unresolved"
  | "no affected references"
  | "unavailable";

export interface InspectionAuthorization {
  authorize(principal: TrustedPrincipal): boolean | Promise<boolean>;
  projectId: string | null;
  bindingName?: string;
}

const CANONICAL_COUNTIES: Readonly<Record<InspectedCountyFips, string>> = {
  "08065": "Lake",
  "08067": "La Plata",
};

const REFERENCES: ReadonlyArray<{
  name: string;
  sql: string;
  sensitive?: boolean;
  provenance: "not retained" | "partial";
}> = [
  {
    name: "organizations",
    sql: "SELECT county_fips AS fips, COUNT(*) AS count FROM organizations WHERE county_fips IN (?, ?) GROUP BY county_fips",
    provenance: "not retained",
  },
  {
    name: "organization_county_affiliations",
    sql: "SELECT county_fips AS fips, COUNT(*) AS count FROM organization_county_affiliations WHERE county_fips IN (?, ?) GROUP BY county_fips",
    provenance: "not retained",
  },
  {
    name: "positions_through_organizations",
    sql: `SELECT fips, COUNT(DISTINCT position_id) AS count FROM (
      SELECT o.county_fips AS fips, p.id AS position_id
      FROM positions p JOIN organizations o ON o.id = p.organization_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, p.id AS position_id
      FROM positions p JOIN organization_county_affiliations a ON a.organization_id = p.organization_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "not retained",
  },
  {
    name: "person_roles_through_positions",
    sql: `SELECT fips, COUNT(DISTINCT role_id) AS count FROM (
      SELECT o.county_fips AS fips, r.id AS role_id
      FROM person_roles r JOIN positions p ON p.id = r.position_id
      JOIN organizations o ON o.id = p.organization_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, r.id AS role_id
      FROM person_roles r JOIN positions p ON p.id = r.position_id
      JOIN organization_county_affiliations a ON a.organization_id = p.organization_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "partial",
  },
  {
    name: "content_item_counties",
    sql: "SELECT county_fips AS fips, COUNT(*) AS count FROM content_item_counties WHERE county_fips IN (?, ?) GROUP BY county_fips",
    provenance: "not retained",
  },
  {
    name: "content_item_organizations_through_county",
    sql: `SELECT fips, COUNT(DISTINCT content_id) AS count FROM (
      SELECT o.county_fips AS fips, l.content_id AS content_id
      FROM content_item_organizations l JOIN organizations o ON o.id = l.organization_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, l.content_id AS content_id
      FROM content_item_organizations l JOIN organization_county_affiliations a
        ON a.organization_id = l.organization_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "partial",
  },
  {
    name: "content_item_people_through_roles",
    sql: `SELECT fips, COUNT(DISTINCT content_id) AS count FROM (
      SELECT o.county_fips AS fips, l.content_id AS content_id
      FROM content_item_people l JOIN person_roles r ON r.person_id = l.person_id
      JOIN positions p ON p.id = r.position_id JOIN organizations o ON o.id = p.organization_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, l.content_id AS content_id
      FROM content_item_people l JOIN person_roles r ON r.person_id = l.person_id
      JOIN positions p ON p.id = r.position_id
      JOIN organization_county_affiliations a ON a.organization_id = p.organization_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "partial",
  },
  {
    name: "content_revision_county_snapshots",
    sql: `SELECT cr_county.value AS fips, COUNT(*) AS count FROM content_revisions cr
      JOIN json_each(cr.county_fips_json) cr_county
      WHERE cr_county.value IN (?, ?) GROUP BY cr_county.value`,
    provenance: "partial",
  },
  {
    name: "banner_assets",
    sql: "SELECT county_fips AS fips, COUNT(*) AS count FROM banner_assets WHERE county_fips IN (?, ?) GROUP BY county_fips",
    provenance: "not retained",
  },
  {
    name: "reports",
    sql: "SELECT county_fips AS fips, COUNT(*) AS count FROM reports WHERE county_fips IN (?, ?) GROUP BY county_fips",
    sensitive: true,
    provenance: "not retained",
  },
  {
    name: "report_history",
    sql: `SELECT r.county_fips AS fips, COUNT(*) AS count FROM report_status_history h
      JOIN reports r ON r.id = h.report_id WHERE r.county_fips IN (?, ?) GROUP BY r.county_fips`,
    sensitive: true,
    provenance: "not retained",
  },
  {
    name: "report_audit",
    sql: `SELECT r.county_fips AS fips, COUNT(*) AS count FROM report_audit a
      JOIN reports r ON r.id = a.report_id WHERE r.county_fips IN (?, ?) GROUP BY r.county_fips`,
    sensitive: true,
    provenance: "not retained",
  },
  {
    name: "report_evidence",
    sql: `SELECT r.county_fips AS fips, COUNT(*) AS count FROM report_evidence e
      JOIN reports r ON r.id = e.report_id WHERE r.county_fips IN (?, ?) GROUP BY r.county_fips`,
    sensitive: true,
    provenance: "not retained",
  },
  {
    name: "report_receipts",
    sql: `SELECT r.county_fips AS fips, COUNT(*) AS count FROM report_receipts q
      JOIN reports r ON r.id = q.report_id WHERE r.county_fips IN (?, ?) GROUP BY r.county_fips`,
    sensitive: true,
    provenance: "not retained",
  },
  {
    name: "report_idempotency",
    sql: `SELECT r.county_fips AS fips, COUNT(*) AS count FROM report_idempotency i
      JOIN reports r ON r.id = i.report_id WHERE r.county_fips IN (?, ?) GROUP BY r.county_fips`,
    sensitive: true,
    provenance: "not retained",
  },
  {
    name: "sync_batch_items",
    sql: `SELECT fips, COUNT(DISTINCT batch_id || ':' || item_index) AS count FROM (
      SELECT o.county_fips AS fips, i.batch_id AS batch_id, i.item_index AS item_index
      FROM sync_batch_items i JOIN organizations o ON i.entity = 'organizations' AND o.id = i.target_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, i.batch_id AS batch_id, i.item_index AS item_index
      FROM sync_batch_items i JOIN organization_county_affiliations a
        ON i.entity = 'organization_county_affiliations' AND a.id = i.target_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "partial",
  },
  {
    name: "sync_batch_history",
    sql: `SELECT fips, COUNT(DISTINCT batch_id) AS count FROM (
      SELECT o.county_fips AS fips, i.batch_id AS batch_id
      FROM sync_batch_items i JOIN organizations o ON i.entity = 'organizations' AND o.id = i.target_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, i.batch_id AS batch_id
      FROM sync_batch_items i JOIN organization_county_affiliations a
        ON i.entity = 'organization_county_affiliations' AND a.id = i.target_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "partial",
  },
  {
    name: "sync_batch_reversals",
    sql: `SELECT fips, COUNT(*) AS count FROM (
      SELECT o.county_fips AS fips, r.id AS reversal_id
      FROM sync_batch_reversals r JOIN sync_batch_items i ON i.batch_id = r.batch_id
      JOIN organizations o ON i.entity = 'organizations' AND o.id = i.target_id
      WHERE o.county_fips IN (?, ?)
      UNION
      SELECT a.county_fips AS fips, r.id AS reversal_id
      FROM sync_batch_reversals r JOIN sync_batch_items i ON i.batch_id = r.batch_id
      JOIN organization_county_affiliations a
        ON i.entity = 'organization_county_affiliations' AND a.id = i.target_id
      WHERE a.county_fips IN (?, ?)
    ) GROUP BY fips`,
    provenance: "partial",
  },
];

export function createD1WebsiteInspectionService(
  database: AsyncD1Database,
  expectedMigrations: readonly CanonicalMigration[],
  authorization: InspectionAuthorization,
) {
  const bindingName = authorization.bindingName ?? "DB";

  async function requireInspection(principal: TrustedPrincipal) {
    if (!(await authorization.authorize(principal))) {
      throw new InspectionDeniedError();
    }
  }

  async function migrationHistory() {
    const table = await database.first<{ name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    );
    if (!table) {
      return {
        status: "missing" as const,
        orderedHistoryValid: false,
        issues: ["migration_history_missing"],
        migrations: [],
        migration0014Present: false,
        migration0015Present: false,
      };
    }

    const rows = await database.all<{
      version: unknown;
      name: unknown;
      sha256: unknown;
    }>(
      "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
      Math.min(Math.max(expectedMigrations.length + 1, 1), 100),
    );
    const issues: string[] = [];
    const records = rows.map((row, index) => {
      const version = Number(row.version);
      const name = typeof row.name === "string" ? row.name : "";
      const sha256 = typeof row.sha256 === "string" ? row.sha256 : "";
      const expected = expectedMigrations[index];
      if (!Number.isSafeInteger(version) || version !== index + 1) {
        issues.push("noncontiguous_history");
      }
      if (!expected || expected.version !== version) {
        issues.push("unknown_migration");
      } else {
        if (expected.name !== name) issues.push("migration_name_mismatch");
        if (expected.sha256 !== sha256)
          issues.push("migration_checksum_mismatch");
      }
      if (
        !/^\d{4}_[a-z0-9_]+\.sql$/.test(name) ||
        !/^[0-9a-f]{64}$/.test(sha256)
      ) {
        issues.push("invalid_migration_metadata");
      }
      return { version, name, sha256 };
    });
    if (records.length === 0) issues.push("empty_history");
    if (records.length < expectedMigrations.length)
      issues.push("missing_migrations");
    if (new Set(issues).size !== issues.length) {
      const unique = [...new Set(issues)];
      issues.splice(0, issues.length, ...unique);
    }
    return {
      status: issues.length === 0 ? ("valid" as const) : ("invalid" as const),
      orderedHistoryValid: issues.length === 0,
      issues,
      migrations: records,
      migration0014Present: records.some((record) => record.version === 14),
      migration0015Present: records.some((record) => record.version === 15),
    };
  }

  async function countyRegistry() {
    const rows = await database.all<{ fips: unknown; name: unknown }>(
      "SELECT fips, name FROM counties WHERE fips IN (?, ?) ORDER BY fips",
      2,
      ["08065", "08067"],
    );
    const byFips = new Map(
      rows
        .filter(
          (row) => typeof row.fips === "string" && typeof row.name === "string",
        )
        .map((row) => [row.fips as string, row.name as string]),
    );
    return (Object.keys(CANONICAL_COUNTIES) as InspectedCountyFips[]).map(
      (fips) => ({
        fips,
        canonicalName: CANONICAL_COUNTIES[fips],
        observedName: byFips.get(fips) ?? null,
        matchesCanonical: byFips.get(fips) === CANONICAL_COUNTIES[fips],
      }),
    );
  }

  async function referenceCounts(counties: readonly InspectedCountyFips[]) {
    const output: Array<Record<string, unknown>> = [];
    for (const reference of REFERENCES) {
      for (const fips of counties) {
        try {
          const values = reference.sql.includes("IN (?, ?)")
            ? [fips, counties.find((value) => value !== fips) ?? fips]
            : [];
          const placeholderCount = reference.sql.match(/\?/g)?.length ?? 0;
          const parameters = Array.from(
            { length: placeholderCount },
            (_, index) => values[index % values.length] ?? fips,
          );
          const rows = await database.all<{ fips: unknown; count: unknown }>(
            reference.sql,
            2,
            parameters,
          );
          const count = rows.find((row) => row.fips === fips)?.count ?? 0;
          const numeric = Number(count);
          if (!Number.isSafeInteger(numeric) || numeric < 0) {
            throw new Error("unsafe aggregate");
          }
          const suppressed = Boolean(
            reference.sensitive && numeric > 0 && numeric < 5,
          );
          output.push({
            countyFips: fips,
            relationship: reference.name,
            count: suppressed ? null : numeric,
            result: suppressed
              ? "suppressed"
              : numeric === 0
                ? "zero"
                : "nonzero",
            supported: true,
            provenanceAvailable: reference.provenance !== "not retained",
            provenanceCoverage: reference.provenance,
            classification:
              numeric === 0 ? "no affected references" : "unresolved",
          });
        } catch {
          output.push({
            countyFips: fips,
            relationship: reference.name,
            count: null,
            result: "unavailable",
            supported: false,
            provenanceAvailable: false,
            provenanceCoverage: "unavailable",
            classification: "unavailable",
          });
        }
      }
    }
    return output;
  }

  return {
    async status(principal: TrustedPrincipal) {
      await requireInspection(principal);
      try {
        const [migrations, counties] = await Promise.all([
          migrationHistory(),
          countyRegistry(),
        ]);
        return {
          state: "ready" as const,
          siteProjectId: authorization.projectId,
          logicalBinding: bindingName,
          physicalDatabaseIdentity: "unavailable" as const,
          migrationHistoryStatus: migrations.status,
          migration0014Present: migrations.migration0014Present,
          migration0015Present: migrations.migration0015Present,
          countyRegistry: counties,
        };
      } catch {
        return {
          state: "unavailable" as const,
          siteProjectId: authorization.projectId,
          logicalBinding: bindingName,
          physicalDatabaseIdentity: "unavailable" as const,
          migrationHistoryStatus: "unavailable" as const,
          migration0014Present: null,
          migration0015Present: null,
          countyRegistry: [],
        };
      }
    },
    async migrationHistory(principal: TrustedPrincipal) {
      await requireInspection(principal);
      return migrationHistory();
    },
    async countyReferenceCounts(
      principal: TrustedPrincipal,
      counties: readonly InspectedCountyFips[],
    ) {
      await requireInspection(principal);
      return {
        counties: await countyRegistry(),
        references: await referenceCounts(counties),
      };
    },
    async countyProvenanceSummary(
      principal: TrustedPrincipal,
      counties: readonly InspectedCountyFips[],
    ) {
      await requireInspection(principal);
      const [registry, migrations, references] = await Promise.all([
        countyRegistry(),
        migrationHistory(),
        referenceCounts(counties),
      ]);
      return counties.map((fips) => ({
        countyFips: fips,
        canonicalName: CANONICAL_COUNTIES[fips],
        observedName:
          registry.find((item) => item.fips === fips)?.observedName ?? null,
        registryMatchesCanonical:
          registry.find((item) => item.fips === fips)?.matchesCanonical ??
          false,
        migration0015Present: migrations.migration0015Present,
        classification: "unresolved" as InspectionClassification,
        rationale:
          "County-keyed records do not retain verified evidence of how their county FIPS was selected.",
        referenceSummary: {
          supportedRelationships: references.filter(
            (item) => item.countyFips === fips && item.supported,
          ).length,
          unavailableRelationships: references.filter(
            (item) => item.countyFips === fips && !item.supported,
          ).length,
          nonzeroRelationships: references.filter(
            (item) => item.countyFips === fips && item.result === "nonzero",
          ).length,
          suppressedRelationships: references.filter(
            (item) => item.countyFips === fips && item.result === "suppressed",
          ).length,
        },
      }));
    },
  };
}

export class InspectionDeniedError extends Error {
  constructor() {
    super("Administrative D1 inspection is not authorized");
    this.name = "InspectionDeniedError";
  }
}

import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

/**
 * Reads the seeded public county registry. The registry is the only source of
 * county names and FIPS codes; callers must not keep a second copy.
 */
export function listCounties(
  database: WebsiteDatabase,
): readonly CountyRegistryEntry[] {
  return database
    .prepare(
      "SELECT fips, name FROM counties ORDER BY name COLLATE NOCASE, fips",
    )
    .all()
    .map((row) => {
      if (typeof row.fips !== "string" || typeof row.name !== "string") {
        throw new Error("Invalid county registry record");
      }
      return { fips: row.fips, name: row.name };
    });
}

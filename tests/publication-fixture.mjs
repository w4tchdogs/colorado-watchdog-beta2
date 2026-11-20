/**
 * Test helper for the Profile publication rule (migration 0034). A Profile is
 * public only with a nonblank display name and at least one role with a
 * county, a source and an office, position or duties. Search and browse tests
 * that seed bare people call this so each one carries a synthetic text-only
 * qualifying role and stays public, without changing what those tests check.
 */
export function qualifyPeople(database, countyFips = "08001") {
  // Older schemas in migration tests predate the rule and need nothing.
  const ready = database
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'view' AND name = 'profile_publication_ready'",
    )
    .get();
  if (!ready) return;
  database
    .prepare(
      `INSERT OR IGNORE INTO role_sources (id, url, title, source_type)
       VALUES ('fixture-publication-source', 'https://example.invalid/fixture-publication',
               'Synthetic publication source', 'official_page')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO person_roles (id, person_id, source_id, county_fips, published_title)
       SELECT 'fixture-role-' || p.id, p.id, 'fixture-publication-source', ?, 'Synthetic Fixture Title'
       FROM people p
       WHERE p.id NOT IN (SELECT person_id FROM profile_publication_ready)
         AND NOT EXISTS (SELECT 1 FROM person_roles r WHERE r.id = 'fixture-role-' || p.id)`,
    )
    .run(countyFips);
}

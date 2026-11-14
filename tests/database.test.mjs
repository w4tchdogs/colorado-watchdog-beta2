import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  StaleVersionError,
  updateVersionedRow,
} from "../dist/database/versioned-writes.js";

const expectedCountyNames = [
  "Adams",
  "Alamosa",
  "Arapahoe",
  "Archuleta",
  "Baca",
  "Bent",
  "Boulder",
  "Broomfield",
  "Chaffee",
  "Cheyenne",
  "Clear Creek",
  "Conejos",
  "Costilla",
  "Crowley",
  "Custer",
  "Delta",
  "Denver",
  "Dolores",
  "Douglas",
  "Eagle",
  "Elbert",
  "El Paso",
  "Fremont",
  "Garfield",
  "Gilpin",
  "Grand",
  "Gunnison",
  "Hinsdale",
  "Huerfano",
  "Jackson",
  "Jefferson",
  "Kiowa",
  "Kit Carson",
  "La Plata",
  "Lake",
  "Larimer",
  "Las Animas",
  "Lincoln",
  "Logan",
  "Mesa",
  "Mineral",
  "Moffat",
  "Montezuma",
  "Montrose",
  "Morgan",
  "Otero",
  "Ouray",
  "Park",
  "Phillips",
  "Pitkin",
  "Prowers",
  "Pueblo",
  "Rio Blanco",
  "Rio Grande",
  "Routt",
  "Saguache",
  "San Juan",
  "San Miguel",
  "Sedgwick",
  "Summit",
  "Teller",
  "Washington",
  "Weld",
  "Yuma",
];

async function withDatabase(callback) {
  const database = await openWebsiteDatabase();
  try {
    await callback(database);
  } finally {
    database.close();
  }
}

function migrate(database) {
  migrateWebsiteDatabase(database);
}

function insertAccount(database, id = "test-human") {
  database
    .prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'human', 'contributor', 'Synthetic User')",
    )
    .run(id);
}

function schemaSnapshot(database) {
  return database
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

test("migrations produce the same schema and are safe to reapply", async () => {
  await withDatabase(async (first) => {
    await withDatabase((second) => {
      migrate(first);
      migrate(second);
      migrate(first);

      assert.deepEqual(schemaSnapshot(first), schemaSnapshot(second));
      assert.equal(
        first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
          .count,
        12,
      );
      assert.equal(
        first.prepare("SELECT COUNT(*) AS count FROM counties").get().count,
        64,
      );
    });
  });
});

test("M2 schema constraints and local commit, batch, and audit rollback hold", async () => {
  await withDatabase((database) => {
    migrate(database);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    insertAccount(database, "synthetic-sync-actor");

    const insertBatch = (id, actorId, key) =>
      database
        .prepare(
          `INSERT INTO sync_batches
             (id, actor_account_id, idempotency_key, request_fingerprint,
              contract_version, request_id, status, committed_at, result_json)
           VALUES (?, ?, ?, ?, 'm2-sync/v1', ?, 'committed', ?, '{}')`,
        )
        .run(
          id,
          actorId,
          key,
          "a".repeat(64),
          `request-${id}`,
          "2026-11-13T00:00:00.000Z",
        );

    assert.throws(() =>
      insertBatch(
        "missing-actor-batch",
        "missing-account",
        "missing-actor-key",
      ),
    );

    const transact = database.transaction(() => {
      database
        .prepare(
          "UPDATE accounts SET display_name = ?, version = version + 1 WHERE id = ?",
        )
        .run("Partially Committed", "synthetic-sync-actor");
      insertBatch("rolled-back-batch", "synthetic-sync-actor", "rollback-key");
      database
        .prepare(
          `INSERT INTO audit_events
             (id, actor_account_id, action, target_type, target_id, summary)
           VALUES ('rolled-back-audit', 'synthetic-sync-actor',
                   'sync.batch.commit', 'sync_batch', 'rolled-back-batch', 'Synthetic commit')`,
        )
        .run();
      throw new Error("synthetic failure after writes");
    });
    assert.throws(transact, /synthetic failure/);
    assert.equal(
      database
        .prepare("SELECT display_name FROM accounts WHERE id = ?")
        .get("synthetic-sync-actor").display_name,
      "Synthetic User",
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sync_batches WHERE id = ?")
        .get("rolled-back-batch").count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = ?")
        .get("rolled-back-audit").count,
      0,
    );

    insertBatch("unique-batch-1", "synthetic-sync-actor", "shared-key");
    assert.throws(() =>
      insertBatch("unique-batch-2", "synthetic-sync-actor", "shared-key"),
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  });
});

test("M2 migrations add schema without changing existing M1 rows", async () => {
  await withDatabase((database) => {
    const migrations = loadWebsiteMigrations();
    migrateWebsiteDatabase(database, migrations.slice(0, 4));
    insertAccount(database, "pre-m2-account");
    const before = database
      .prepare(
        "SELECT id, role, display_name, version FROM accounts WHERE id = ?",
      )
      .get("pre-m2-account");

    migrateWebsiteDatabase(database, migrations);

    assert.deepEqual(
      database
        .prepare(
          "SELECT id, role, display_name, version FROM accounts WHERE id = ?",
        )
        .get("pre-m2-account"),
      before,
    );
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sync_batches").get()
        .count,
      0,
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  });
});

test("a local Website database file persists across open and close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-website-db-"));
  const filename = join(directory, "website.sqlite");
  let database;

  try {
    database = await openWebsiteDatabase(filename);
    migrate(database);
    insertAccount(database, "persistent-test-account");
    database.close();
    database = undefined;

    database = await openWebsiteDatabase(filename);
    migrate(database);
    assert.equal(
      database
        .prepare("SELECT display_name FROM accounts WHERE id = ?")
        .get("persistent-test-account").display_name,
      "Synthetic User",
    );
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the public seed contains exactly 64 counties with their correct FIPS keys", async () => {
  await withDatabase((database) => {
    migrate(database);
    const rows = database
      .prepare("SELECT fips, name FROM counties ORDER BY fips")
      .all();
    const expectedCodes = Array.from(
      { length: 63 },
      (_, index) => `08${String(index * 2 + 1).padStart(3, "0")}`,
    );
    expectedCodes.splice(7, 0, "08014");

    assert.equal(rows.length, 64);
    assert.deepEqual(
      rows.map((row) => row.fips),
      expectedCodes,
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      expectedCountyNames,
    );
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips = '08014'").get()
        .name,
      "Broomfield",
    );
  });
});

test("county FIPS values must remain five-digit Colorado codes", async () => {
  await withDatabase((database) => {
    migrate(database);
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO counties (fips, name) VALUES ('01001', 'Invalid')",
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare("UPDATE counties SET fips = '08A01' WHERE fips = '08001'")
        .run(),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM counties").get().count,
      64,
    );
  });
});

test("foreign keys, enum checks, and JSON checks reject invalid values", async () => {
  await withDatabase((database) => {
    migrate(database);
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO identities (id, account_id, provider, subject) VALUES ('identity-1', 'missing', 'test', 'subject')",
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO accounts (id, kind, role, display_name) VALUES ('bad-kind', 'service', 'contributor', 'Synthetic')",
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO accounts (id, kind, role, display_name) VALUES ('bad-role', 'human', 'ownerless', 'Synthetic')",
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO accounts (id, kind, role, display_name, preferences) VALUES ('bad-json', 'human', 'contributor', 'Synthetic', '{')",
        )
        .run(),
    );
  });
});

test("Website schema includes M0, M1-A, M2-D and M2-E tables without Profiles records", async () => {
  await withDatabase((database) => {
    migrate(database);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      "accounts",
      "audit_events",
      "banner_asset_versions",
      "banner_assets",
      "banner_stage_operations",
      "checkpoints",
      "content_item_counties",
      "content_item_organizations",
      "content_item_people",
      "content_items",
      "content_revisions",
      "counties",
      "identities",
      "operations",
      "organization_county_affiliations",
      "organizations",
      "people",
      "person_duplicate_flag_observations",
      "person_duplicate_flags",
      "person_roles",
      "positions",
      "role_sources",
      "schema_migrations",
      "sync_batch_items",
      "sync_batch_reversals",
      "sync_batches",
      "website_dependency_assertions",
      "website_dependency_generation",
      "website_write_assertions",
    ]);

    for (const table of [
      "accounts",
      "audit_events",
      "checkpoints",
      "content_item_counties",
      "content_item_organizations",
      "content_item_people",
      "content_items",
      "content_revisions",
      "identities",
      "operations",
      "organization_county_affiliations",
      "organizations",
      "people",
      "person_duplicate_flags",
      "person_duplicate_flag_observations",
      "person_roles",
      "positions",
      "role_sources",
      "sync_batch_items",
      "sync_batches",
      "sync_batch_reversals",
    ]) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()
          .count,
        0,
      );
    }
  });
});

test("county organizations keep independent hierarchies and regional affiliations separate", async () => {
  await withDatabase((database) => {
    migrate(database);
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO organizations (id, name, organization_type) VALUES ('unscoped-county-government', 'Invalid County Government', 'county_government')",
        )
        .run(),
    );
    database
      .prepare(
        `INSERT INTO organizations
           (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
         VALUES
           ('adams-government', 'Synthetic Adams County', 'county_government', '08001', NULL, NULL),
           ('adams-health', 'Synthetic Health Department', 'department', '08001', 'adams-government', 'reports_to'),
           ('boulder-government', 'Synthetic Boulder County', 'county_government', '08013', NULL, NULL),
           ('regional-health', 'Synthetic Regional Health Office', 'regional', NULL, NULL, NULL),
           ('partner-dispatch', 'Synthetic Shared Dispatch Partner', 'partner', NULL, NULL, NULL)`,
      )
      .run();

    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO organizations
             (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
           VALUES ('cross-county-child', 'Invalid Child', 'office', '08001', 'boulder-government', 'grouped_under')`,
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE organizations SET parent_organization_id = 'adams-health', parent_relationship = 'grouped_under' WHERE id = 'adams-government'",
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE organizations SET county_fips = '08013' WHERE id = 'adams-government'",
        )
        .run(),
    );

    database
      .prepare(
        `INSERT INTO organization_county_affiliations
           (id, organization_id, county_fips, relationship_type)
         VALUES
           ('regional-adams', 'regional-health', '08001', 'serves'),
           ('dispatch-adams', 'partner-dispatch', '08001', 'shared_service'),
           ('dispatch-boulder', 'partner-dispatch', '08013', 'shared_service')`,
      )
      .run();

    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM organization_county_affiliations WHERE organization_id = 'partner-dispatch'",
        )
        .get().count,
      2,
    );
    assert.equal(
      database
        .prepare("SELECT parent_relationship FROM organizations WHERE id = ?")
        .get("adams-health").parent_relationship,
      "reports_to",
    );
  });
});

test("person roles require a public source and retain stable relational IDs", async () => {
  await withDatabase((database) => {
    migrate(database);
    database
      .prepare(
        `INSERT INTO organizations (id, name, organization_type, county_fips)
         VALUES ('synthetic-office', 'Synthetic County Office', 'office', '08001')`,
      )
      .run();
    database
      .prepare(
        "INSERT INTO people (id, display_name) VALUES ('synthetic-person-1', 'Synthetic Person')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO positions (id, organization_id, title) VALUES ('synthetic-position-1', 'synthetic-office', 'Synthetic Clerk')",
      )
      .run();

    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO role_sources (id, url, title, source_type)
           VALUES ('invalid-source', 'file:///private/person.html', 'Private File', 'official_page')`,
        )
        .run(),
    );
    database
      .prepare(
        `INSERT INTO role_sources (id, url, title, source_type)
         VALUES ('synthetic-source-1', 'https://county.example.test/clerk', 'Synthetic Official Directory', 'official_page')`,
      )
      .run();
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO person_roles
             (id, person_id, position_id, source_id, start_date, end_date, source_checked_at)
           VALUES ('invalid-date-range', 'synthetic-person-1', 'synthetic-position-1', 'synthetic-source-1', '2026-01-01', '2025-01-01', '2026-11-13T00:00:00Z')`,
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO person_roles
             (id, person_id, position_id, source_id, source_checked_at)
           VALUES ('role-without-source', 'synthetic-person-1', 'synthetic-position-1', 'missing-source', '2026-11-13T00:00:00Z')`,
        )
        .run(),
    );
    database
      .prepare(
        `INSERT INTO person_roles
           (id, person_id, position_id, source_id, start_date, source_checked_at)
         VALUES ('synthetic-role-1', 'synthetic-person-1', 'synthetic-position-1', 'synthetic-source-1', '2026-01-01', '2026-11-13T00:00:00Z')`,
      )
      .run();

    assert.deepEqual(
      database
        .prepare(
          "SELECT person_id, position_id, source_id, version FROM person_roles WHERE id = ?",
        )
        .get("synthetic-role-1"),
      {
        person_id: "synthetic-person-1",
        position_id: "synthetic-position-1",
        source_id: "synthetic-source-1",
        version: 1,
      },
    );
  });
});

test("versioned writes increment once and stale versions leave the row unchanged", async () => {
  await withDatabase((database) => {
    migrate(database);
    insertAccount(database);

    assert.equal(
      updateVersionedRow(database, "accounts", "test-human", 1, {
        display_name: "Updated Synthetic User",
      }),
      2,
    );
    assert.throws(
      () =>
        updateVersionedRow(database, "accounts", "test-human", 1, {
          display_name: "Stale Write",
        }),
      StaleVersionError,
    );
    assert.deepEqual(
      database
        .prepare("SELECT display_name, version FROM accounts WHERE id = ?")
        .get("test-human"),
      { display_name: "Updated Synthetic User", version: 2 },
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE accounts SET display_name = 'Skipped version' WHERE id = 'test-human'",
        )
        .run(),
    );
  });
});

test("M1-A rows use optimistic writes and reject skipped versions", async () => {
  await withDatabase((database) => {
    migrate(database);
    database
      .prepare(
        "INSERT INTO people (id, display_name) VALUES ('person-1', 'Synthetic Person')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO people (id, display_name) VALUES ('person-2', 'Other Synthetic Person')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO organizations (id, name, organization_type) VALUES ('regional-1', 'Synthetic Regional Office', 'regional')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO positions (id, organization_id, title) VALUES ('position-1', 'regional-1', 'Synthetic Role')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO organization_county_affiliations (id, organization_id, county_fips, relationship_type) VALUES ('affiliation-1', 'regional-1', '08001', 'serves')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO role_sources (id, url, title, source_type) VALUES ('source-1', 'https://regional.example.test/roles', 'Synthetic Roles', 'public_document')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at) VALUES ('role-1', 'person-1', 'position-1', 'source-1', '2026-11-13T00:00:00Z')",
      )
      .run();

    assert.equal(
      updateVersionedRow(database, "organizations", "regional-1", 1, {
        name: "Updated Synthetic Regional Office",
      }),
      2,
    );
    assert.equal(
      updateVersionedRow(
        database,
        "organization_county_affiliations",
        "affiliation-1",
        1,
        {
          relationship_type: "shared_service",
        },
      ),
      2,
    );
    assert.equal(
      updateVersionedRow(database, "people", "person-1", 1, {
        display_name: "Updated Synthetic Person",
      }),
      2,
    );
    assert.equal(
      updateVersionedRow(database, "positions", "position-1", 1, {
        title: "Updated Synthetic Role",
      }),
      2,
    );
    assert.equal(
      updateVersionedRow(database, "role_sources", "source-1", 1, {
        title: "Updated Synthetic Roles",
      }),
      2,
    );
    assert.equal(
      updateVersionedRow(database, "person_roles", "role-1", 1, {
        source_checked_at: "2026-11-13T01:00:00Z",
      }),
      2,
    );
    assert.throws(
      () =>
        updateVersionedRow(database, "person_roles", "role-1", 1, {
          source_checked_at: "2026-11-13T02:00:00Z",
        }),
      StaleVersionError,
    );
    assert.throws(() =>
      database
        .prepare("UPDATE person_roles SET source_checked_at = ? WHERE id = ?")
        .run("2026-11-13T03:00:00Z", "role-1"),
    );
    assert.equal(
      database
        .prepare(
          "SELECT source_checked_at, version FROM person_roles WHERE id = ?",
        )
        .get("role-1").version,
      2,
    );
  });
});

test("failed migration rolls back its schema changes and history entry", async () => {
  await withDatabase((database) => {
    const migrations = [
      {
        version: 1,
        name: "0001_initial.sql",
        sql: "CREATE TABLE initial_table (id TEXT PRIMARY KEY) STRICT;",
      },
      {
        version: 2,
        name: "0002_broken.sql",
        sql: "CREATE TABLE rolled_back_table (id TEXT PRIMARY KEY) STRICT; INSERT INTO absent_table VALUES ('x');",
      },
    ];

    assert.throws(() => migrateWebsiteDatabase(database, migrations));
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
        .count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back_table'",
        )
        .get().count,
      0,
    );
  });
});

test("changed applied migration definitions and tampered checksums are rejected", async () => {
  await withDatabase((database) => {
    const migrations = loadWebsiteMigrations();
    migrateWebsiteDatabase(database, migrations);
    const changed = migrations.map((migration) =>
      migration.version === 1
        ? { ...migration, sql: `${migration.sql}\n-- changed` }
        : migration,
    );
    assert.throws(
      () => migrateWebsiteDatabase(database, changed),
      /Applied migration changed/,
    );

    database
      .prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1")
      .run("0".repeat(64));
    assert.throws(
      () => migrateWebsiteDatabase(database, migrations),
      /Applied migration changed/,
    );
  });
});

test("incompatible and unmanaged databases are not silently adopted", async () => {
  await withDatabase((database) => {
    database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    assert.throws(
      () => migrate(database),
      /Refusing to adopt an unmanaged database/,
    );
  });

  await withDatabase((database) => {
    database.exec(
      "CREATE TABLE schema_migrations (migration TEXT PRIMARY KEY)",
    );
    assert.throws(
      () => migrate(database),
      /Incompatible Website migration history schema/,
    );
  });
});

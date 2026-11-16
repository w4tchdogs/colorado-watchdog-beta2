import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
  migrationChecksum,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  StaleVersionError,
  updateVersionedRow,
} from "../dist/database/versioned-writes.js";

const countyReference = JSON.parse(
  readFileSync(
    new URL("./fixtures/colorado-counties-acs26.json", import.meta.url),
    "utf8",
  ),
);
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
        18,
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
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
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
    const expectedCodes = countyReference.counties.map(([fips]) => fips);
    assert.equal(rows.length, 64);
    assert.deepEqual(
      rows.map((row) => row.fips),
      expectedCodes,
    );
    assert.deepEqual(
      rows.map(({ fips, name }) => [fips, name]),
      countyReference.counties,
    );
    assert.equal(new Set(rows.map((row) => row.fips)).size, 64);
    assert.equal(new Set(rows.map((row) => row.name)).size, 64);
    const nameToFips = new Map(rows.map(({ fips, name }) => [name, fips]));
    const fipsToName = new Map(rows.map(({ fips, name }) => [fips, name]));
    for (const [fips, name] of countyReference.counties) {
      assert.equal(nameToFips.get(name), fips);
      assert.equal(fipsToName.get(fips), name);
    }
    assert.equal(nameToFips.get("Lake"), "08065");
    assert.equal(nameToFips.get("La Plata"), "08067");
    for (const [name, fips] of [
      ["Adams", "08001"],
      ["Broomfield", "08014"],
      ["Denver", "08031"],
      ["Larimer", "08069"],
      ["San Juan", "08111"],
      ["San Miguel", "08113"],
    ])
      assert.equal(nameToFips.get(name), fips);
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips = '08014'").get()
        .name,
      "Broomfield",
    );
  });
});

test("0015 corrects only the county names and preserves dependent FIPS references", async () => {
  await withDatabase((database) => {
    const migrations = loadWebsiteMigrations();
    const historicChecksums = migrations
      .slice(0, 14)
      .map(({ version, name, sql }) => ({
        version,
        name,
        checksum: migrationChecksum(sql),
      }));
    migrateWebsiteDatabase(database, migrations.slice(0, 14));
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08065'").get()
        .name,
      "La Plata",
    );
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08067'").get()
        .name,
      "Lake",
    );

    database.exec(`
      INSERT INTO accounts (id,kind,role,display_name) VALUES ('fips-actor','human','contributor','Synthetic Actor');
      INSERT INTO organizations (id,name,organization_type,county_fips) VALUES
        ('fips-lake-org','Synthetic Lake Organization','county_government','08065'),
        ('fips-la-plata-org','Synthetic La Plata Organization','county_government','08067');
      INSERT INTO organization_county_affiliations (id,organization_id,county_fips,relationship_type) VALUES
        ('fips-aff-lake','fips-lake-org','08065','serves'),
        ('fips-aff-la-plata','fips-la-plata-org','08067','serves');
      INSERT INTO people (id,display_name) VALUES ('fips-person','Synthetic Person');
      INSERT INTO positions (id,organization_id,title) VALUES ('fips-position','fips-lake-org','Synthetic role');
      INSERT INTO role_sources (id,url,title,source_type) VALUES ('fips-source','https://example.test/source','Synthetic source','official_page');
      INSERT INTO person_roles (id,person_id,position_id,source_id,source_checked_at) VALUES
        ('fips-role','fips-person','fips-position','fips-source','2026-11-14');
      INSERT INTO content_items (id,content_type,title,body,status,created_by_account_id,last_edited_by_account_id)
        VALUES ('fips-content','post','Synthetic county record','','draft','fips-actor','fips-actor');
      INSERT INTO content_item_counties (content_id,county_fips) VALUES
        ('fips-content','08065'),('fips-content','08067');
      INSERT INTO banner_assets (id,county_fips,source_filename,display_order,created_by_account_id,updated_by_account_id)
        VALUES ('fips-banner','08065','synthetic-private-master.png',0,'fips-actor','fips-actor');
      INSERT INTO reports (id,county_fips,private_json,status,version,created_at)
        VALUES ('fips-report','08067','{}','submitted',1,'2026-11-14T00:00:00Z');
      INSERT INTO sync_batches (id,actor_account_id,idempotency_key,request_fingerprint,contract_version,request_id,status,committed_at,result_json)
        VALUES ('fips-batch','fips-actor','fips-key','${"a".repeat(64)}','m2-sync/v1','fips-request','committed','2026-11-14T00:00:00Z','{}');
      INSERT INTO sync_batch_items (batch_id,item_index,client_ref,entity,operation,target_id,outcome,committed_version,inverse_json)
        VALUES ('fips-batch',0,'county-org','organizations','create_organization','fips-lake-org','created',1,'{}');
    `);
    const dependentBefore = Object.fromEntries(
      [
        "organizations",
        "organization_county_affiliations",
        "content_item_counties",
        "banner_assets",
        "reports",
        "sync_batches",
        "sync_batch_items",
      ].map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ]),
    );

    migrateWebsiteDatabase(database, migrations);
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08065'").get()
        .name,
      "Lake",
    );
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08067'").get()
        .name,
      "La Plata",
    );
    assert.deepEqual(
      database.prepare("SELECT fips,name FROM counties ORDER BY fips").all(),
      countyReference.counties.map(([fips, name]) => ({ fips, name })),
    );
    for (const [table, before] of Object.entries(dependentBefore)) {
      const after = database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      const preserved =
        table === "banner_assets"
          ? after.map(({ homepage_order, ...row }) => row)
          : after;
      assert.deepEqual(preserved, before, `${table} preserved`);
    }
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
        .count,
      18,
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT version,name,sha256 FROM schema_migrations WHERE version <= 14 ORDER BY version",
        )
        .all(),
      historicChecksums.map(({ version, name, checksum }) => ({
        version,
        name,
        sha256: checksum,
      })),
    );
    migrateWebsiteDatabase(database, migrations);
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08065'").get()
        .name,
      "Lake",
    );
  });
});

test("0015 accepts an already-correct full registry and rejects unexpected mappings atomically", async () => {
  for (const corrupt of [
    (database) =>
      database
        .prepare("UPDATE counties SET name='Wrong name' WHERE fips='08001'")
        .run(),
    (database) =>
      database.prepare("DELETE FROM counties WHERE fips='08001'").run(),
  ]) {
    await withDatabase((database) => {
      const migrations = loadWebsiteMigrations();
      migrateWebsiteDatabase(database, migrations.slice(0, 14));
      corrupt(database);
      const before = database
        .prepare("SELECT fips,name FROM counties ORDER BY fips")
        .all();
      assert.throws(() => migrateWebsiteDatabase(database, migrations));
      assert.deepEqual(
        database.prepare("SELECT fips,name FROM counties ORDER BY fips").all(),
        before,
      );
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get().count,
        14,
      );
    });
  }

  await withDatabase((database) => {
    const migrations = loadWebsiteMigrations();
    migrateWebsiteDatabase(database, migrations.slice(0, 14));
    database.exec(
      "UPDATE counties SET name='VIS8 temporary county name' WHERE fips='08065'",
    );
    database
      .prepare("UPDATE counties SET name='La Plata' WHERE fips='08067'")
      .run();
    database
      .prepare("UPDATE counties SET name='Lake' WHERE fips='08065'")
      .run();
    migrateWebsiteDatabase(database, migrations);
    assert.deepEqual(
      database.prepare("SELECT fips,name FROM counties ORDER BY fips").all(),
      countyReference.counties.map(([fips, name]) => ({ fips, name })),
    );
  });
});

test("0015 rolls back a failure after the temporary name has been written", async () => {
  await withDatabase((database) => {
    const migrations = loadWebsiteMigrations();
    migrateWebsiteDatabase(database, migrations.slice(0, 14));
    database.exec(`
      CREATE TRIGGER fail_lake_plata_name_update
      BEFORE UPDATE OF name ON counties
      WHEN OLD.fips = '08067' AND NEW.name = 'La Plata'
      BEGIN SELECT RAISE(ABORT, 'synthetic interrupted name exchange'); END;
    `);
    assert.throws(
      () => migrateWebsiteDatabase(database, migrations),
      /synthetic interrupted name exchange/,
    );
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08065'").get()
        .name,
      "La Plata",
    );
    assert.equal(
      database.prepare("SELECT name FROM counties WHERE fips='08067'").get()
        .name,
      "Lake",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
        .count,
      14,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'vis8_fips_%'",
        )
        .get().count,
      0,
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
      "banner_admin_operations",
      "banner_asset_versions",
      "banner_assets",
      "banner_publications",
      "banner_stage_operations",
      "checkpoints",
      "content_item_counties",
      "content_item_organizations",
      "content_item_people",
      "content_items",
      "content_publications",
      "content_revisions",
      "counties",
      "identities",
      "operations",
      "organization_county_affiliations",
      "organizations",
      "owner_bootstrap_audit",
      "people",
      "person_duplicate_flag_observations",
      "person_duplicate_flags",
      "person_roles",
      "positions",
      "report_audit",
      "report_evidence",
      "report_idempotency",
      "report_receipts",
      "report_status_history",
      "reports",
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
      "content_publications",
      "content_revisions",
      "identities",
      "operations",
      "owner_bootstrap_audit",
      "organization_county_affiliations",
      "organizations",
      "people",
      "person_duplicate_flags",
      "person_duplicate_flag_observations",
      "person_roles",
      "positions",
      "report_audit",
      "report_evidence",
      "report_idempotency",
      "report_receipts",
      "report_status_history",
      "reports",
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

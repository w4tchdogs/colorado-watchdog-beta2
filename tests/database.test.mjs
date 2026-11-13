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
        3,
      );
      assert.equal(
        first.prepare("SELECT COUNT(*) AS count FROM counties").get().count,
        64,
      );
    });
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

test("Website schema contains only its six tables and no research records", async () => {
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
      "checkpoints",
      "counties",
      "identities",
      "operations",
      "schema_migrations",
    ]);

    for (const table of [
      "accounts",
      "audit_events",
      "checkpoints",
      "identities",
      "operations",
    ]) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()
          .count,
        0,
      );
    }
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

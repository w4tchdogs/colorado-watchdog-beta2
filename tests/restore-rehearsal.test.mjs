import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
  migrationChecksum,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";

// DEPLOY-1A local restore rehearsal. Everything here is synthetic and local:
// no hosted D1, R2, Profiles database or real records are touched.

const countyReference = JSON.parse(
  readFileSync(
    new URL("./fixtures/colorado-counties-acs26.json", import.meta.url),
    "utf8",
  ),
).counties;

const TARGETS = [
  ["08065", "Lake"],
  ["08067", "La Plata"],
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function schemaEvidence(database) {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function ledgerEvidence(database) {
  return database
    .prepare(
      "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
    )
    .all();
}

function countyEvidence(database) {
  return database
    .prepare("SELECT fips, name FROM counties ORDER BY fips")
    .all();
}

// Dependent records keyed to Lake and La Plata, plus one control county.
const FIXTURE_LINKS = [
  { table: "organizations", id: "org-lake", county: "08065" },
  { table: "organizations", id: "org-la-plata", county: "08067" },
  { table: "organizations", id: "org-adams", county: "08001" },
  { table: "reports", id: "rpt-lake", county: "08065" },
  { table: "reports", id: "rpt-la-plata", county: "08067" },
];

function seedSyntheticRecords(database) {
  database
    .prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-rehearsal', 'human', 'contributor', 'Synthetic Rehearsal Author')",
    )
    .run();
  const insertOrganization = database.prepare(
    "INSERT INTO organizations (id, name, organization_type, county_fips) VALUES (?, ?, 'county_government', ?)",
  );
  insertOrganization.run("org-lake", "Synthetic Lake Government", "08065");
  insertOrganization.run(
    "org-la-plata",
    "Synthetic La Plata Government",
    "08067",
  );
  insertOrganization.run("org-adams", "Synthetic Adams Government", "08001");
  database
    .prepare(
      "INSERT INTO organization_county_affiliations (id, organization_id, county_fips, relationship_type) VALUES ('aff-lake-la-plata', 'org-lake', '08067', 'shared_service')",
    )
    .run();
  for (const [id, county] of [
    ["rpt-lake", "08065"],
    ["rpt-la-plata", "08067"],
  ]) {
    database
      .prepare(
        "INSERT INTO reports (id, county_fips, private_json, status, version, created_at) VALUES (?, ?, '{\"note\":\"synthetic\"}', 'submitted', 1, '2026-01-01T00:00:00.000Z')",
      )
      .run(id, county);
    database
      .prepare(
        "INSERT INTO report_receipts (report_id, reference, credential_digest, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
      )
      .run(id, `ref-${id}`, sha256(`synthetic-${id}`));
  }
  database
    .prepare(
      "INSERT INTO content_items (id, content_type, title, created_by_account_id, last_edited_by_account_id) VALUES ('content-rehearsal', 'post', 'Synthetic rehearsal post', 'acct-rehearsal', 'acct-rehearsal')",
    )
    .run();
  const insertContentCounty = database.prepare(
    "INSERT INTO content_item_counties (content_id, county_fips) VALUES ('content-rehearsal', ?)",
  );
  insertContentCounty.run("08065");
  insertContentCounty.run("08067");
}

function dependentLinks(database) {
  return {
    organizations: database
      .prepare("SELECT id, county_fips FROM organizations ORDER BY id")
      .all(),
    affiliations: database
      .prepare(
        "SELECT id, organization_id, county_fips FROM organization_county_affiliations ORDER BY id",
      )
      .all(),
    reports: database
      .prepare("SELECT id, county_fips FROM reports ORDER BY id")
      .all(),
    contentCounties: database
      .prepare(
        "SELECT content_id, county_fips FROM content_item_counties ORDER BY county_fips",
      )
      .all(),
  };
}

/** Restore a snapshot and verify its digest BEFORE SQLite opens it. */
async function restoreSnapshot(snapshotPath, restoredPath, expected, opener) {
  copyFileSync(snapshotPath, restoredPath);
  const actual = sha256(readFileSync(restoredPath));
  if (actual !== expected) {
    throw new Error(
      `Snapshot digest mismatch: expected ${expected}, got ${actual}`,
    );
  }
  return opener(restoredPath);
}

async function createRehearsal(directory) {
  const sourcePath = join(directory, "source.sqlite");
  const source = await openWebsiteDatabase(sourcePath);
  migrateWebsiteDatabase(source);
  seedSyntheticRecords(source);
  const evidence = {
    schema: schemaEvidence(source),
    ledger: ledgerEvidence(source),
    counties: countyEvidence(source),
    links: dependentLinks(source),
  };
  // Closing finalizes the bytes of the file-backed SQL.js database.
  source.close();

  const snapshotPath = join(directory, "snapshot.sqlite");
  copyFileSync(sourcePath, snapshotPath);
  const digest = sha256(readFileSync(snapshotPath));
  return { evidence, snapshotPath, digest };
}

async function withRehearsalDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-restore-rehearsal-"));
  try {
    await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("pre-backup evidence covers the current schema, ledger and fixtures", async () => {
  await withRehearsalDirectory(async (directory) => {
    const { evidence } = await createRehearsal(directory);
    const migrations = loadWebsiteMigrations();
    assert.deepEqual(
      evidence.ledger,
      migrations.map((migration) => ({
        version: migration.version,
        name: migration.name,
        sha256: migrationChecksum(migration.sql),
      })),
    );
    assert.ok(evidence.schema.some((row) => row.type === "index"));
    assert.ok(evidence.schema.some((row) => row.type === "trigger"));
    assert.equal(evidence.counties.length, 64);
    for (const link of FIXTURE_LINKS) {
      assert.ok(
        JSON.stringify(evidence.links).includes(link.id),
        `${link.id} seeded`,
      );
    }
  });
});

test("restored snapshot keeps schema, ledger, counties and dependent links", async () => {
  await withRehearsalDirectory(async (directory) => {
    const { evidence, snapshotPath, digest } = await createRehearsal(directory);
    const restoredPath = join(directory, "restored.sqlite");

    let opened = 0;
    const restored = await restoreSnapshot(
      snapshotPath,
      restoredPath,
      digest,
      (path) => {
        opened += 1;
        return openWebsiteDatabase(path);
      },
    );
    assert.equal(opened, 1);
    assert.notEqual(restoredPath, snapshotPath);

    try {
      // Acceptance checks run before any migration or repair on the restored file.
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(restored.pragma("foreign_key_check"), []);

      assert.deepEqual(schemaEvidence(restored), evidence.schema);
      assert.deepEqual(ledgerEvidence(restored), evidence.ledger);

      const counties = countyEvidence(restored);
      assert.equal(counties.length, 64);
      assert.deepEqual(
        counties,
        countyReference.map(([fips, name]) => ({ fips, name })),
      );
      assert.deepEqual(counties, evidence.counties);
      for (const [fips, name] of TARGETS) {
        assert.deepEqual(
          restored
            .prepare("SELECT fips, name FROM counties WHERE fips = ?")
            .get(fips),
          { fips, name },
        );
      }

      const links = dependentLinks(restored);
      assert.deepEqual(links, evidence.links);
      const countyOf = (rows, id) =>
        rows.find((row) => (row.id ?? row.content_id) === id)?.county_fips;
      assert.equal(countyOf(links.organizations, "org-lake"), "08065");
      assert.equal(countyOf(links.organizations, "org-la-plata"), "08067");
      assert.equal(countyOf(links.reports, "rpt-lake"), "08065");
      assert.equal(countyOf(links.reports, "rpt-la-plata"), "08067");
      assert.deepEqual(
        links.contentCounties.map((row) => row.county_fips),
        ["08065", "08067"],
      );
      assert.equal(
        restored
          .prepare(
            "SELECT COUNT(*) AS count FROM reports r JOIN counties c ON c.fips = r.county_fips WHERE c.name IN ('Lake', 'La Plata')",
          )
          .get().count,
        2,
      );
    } finally {
      restored.close();
    }
  });
});

test("a changed snapshot is rejected before SQLite opens it", async () => {
  await withRehearsalDirectory(async (directory) => {
    const { snapshotPath, digest } = await createRehearsal(directory);
    const tampered = readFileSync(snapshotPath);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(snapshotPath, tampered);

    let opened = 0;
    await assert.rejects(
      restoreSnapshot(
        snapshotPath,
        join(directory, "restored.sqlite"),
        digest,
        (path) => {
          opened += 1;
          return openWebsiteDatabase(path);
        },
      ),
      /Snapshot digest mismatch/,
    );
    assert.equal(opened, 0);
  });
});

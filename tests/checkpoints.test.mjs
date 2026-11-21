import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  canonicalJson,
  decodeRowLine,
  tableMemberPath,
} from "../dist/local/checkpoints/core.js";
import {
  captureDatabaseSnapshot,
  restoreDatabaseSnapshot,
} from "../dist/local/checkpoints/database-snapshot.js";
import { LocalFileStore } from "../dist/local/checkpoints/file-store.js";
import {
  prepareCheckpoint,
  produceCheckpoint,
} from "../dist/local/checkpoints/producer.js";
import {
  knownMigrationRecords,
  verifyCheckpointBundle,
} from "../dist/local/checkpoints/verifier.js";
import {
  COMMIT,
  createFixture,
  overwrite,
  rewriteManifest,
  SYNTHETIC_FILES,
  sha256,
  treeDigest,
} from "./checkpoint-fixtures.mjs";

const ID = "ckpt-synthetic-0001";

async function produce(fixture, id = ID, overrides = {}) {
  return produceCheckpoint(
    overrides.database ?? fixture.database,
    overrides.fileStore ?? fixture.fileStore,
    fixture.destination,
    { checkpointId: id, applicationCommit: COMMIT, limits: overrides.limits },
  );
}

async function verify(fixture, id = ID, options = {}) {
  const reader = await fixture.destination.get(id);
  const outcome = await verifyCheckpointBundle(reader, {
    scratchRoot: fixture.scratchRoot,
    ...options,
  });
  return outcome.report;
}

const codes = (report) => report.failures.map((failure) => failure.code);

function assertFailed(report, code, subjectPattern) {
  assert.equal(report.ok, false);
  const failure = report.failures.find((item) => item.code === code);
  assert.ok(failure, `expected ${code}, got ${codes(report).join(",")}`);
  if (subjectPattern) {
    assert.match(`${failure.subject} ${failure.detail}`, subjectPattern);
  }
  for (const item of report.failures) {
    assert.ok(item.detail.length <= 200 && item.subject.length <= 120);
  }
}

test("checkpoint of a synthetic database and files restores and matches", async (t) => {
  const fixture = await createFixture(t);
  fixture.database.exec(`
    INSERT INTO organizations (id, name, organization_type, county_fips)
    VALUES
      ('m1-county-org', 'Synthetic County Government', 'county_government', '08001'),
      ('m1-regional-org', 'Synthetic Regional Office', 'regional', NULL);
    INSERT INTO organization_county_affiliations
      (id, organization_id, county_fips, relationship_type)
    VALUES ('m1-affiliation', 'm1-regional-org', '08001', 'serves');
    INSERT INTO people (id, display_name)
    VALUES ('m1-person', 'Synthetic M1 Person');
    INSERT INTO positions (id, organization_id, title)
    VALUES ('m1-position', 'm1-county-org', 'Synthetic M1 Position');
    INSERT INTO role_sources (id, url, title, source_type)
    VALUES ('m1-source', 'https://county.example.test/synthetic-role', 'Synthetic Public Role Source', 'official_page');
    INSERT INTO person_roles
      (id, person_id, position_id, source_id, source_checked_at)
    VALUES ('m1-person-role', 'm1-person', 'm1-position', 'm1-source', '2026-11-13T00:00:00Z');
  `);
  const prepared = await produce(fixture);
  const { manifest } = prepared;

  assert.equal(manifest.format_version, 1);
  assert.equal(manifest.checkpoint_id, ID);
  assert.equal(manifest.application.commit, COMMIT);
  assert.equal(manifest.database.migration_version, 39);
  assert.deepEqual(manifest.database.migrations, knownMigrationRecords());
  assert.deepEqual(
    manifest.database.tables.map((table) => [table.name, table.rows]),
    [
      ["accounts", 3],
      ["agent_capability_grants", 0],
      ["audit_events", 1],
      ["auth_login_transactions", 0],
      ["auth_sessions", 0],
      ["banner_admin_operations", 0],
      ["banner_asset_versions", 0],
      ["banner_assets", 0],
      ["banner_publications", 0],
      ["banner_stage_operations", 0],
      ["checkpoints", 0],
      ["content_item_counties", 0],
      ["content_item_organizations", 0],
      ["content_item_people", 0],
      ["content_items", 0],
      ["content_publications", 0],
      ["content_revisions", 0],
      ["counties", 64],
      ["county_role_display", 0],
      ["county_structure_history", 0],
      ["county_structure_import", 0],
      ["county_structure_import_item", 0],
      ["county_structure_layout_history", 0],
      ["county_structure_layout_state", 64],
      ["county_structure_pinned_group", 0],
      ["county_structure_state", 1],
      ["county_unit", 0],
      ["county_unit_alias", 0],
      ["county_unit_display", 0],
      ["identities", 3],
      ["operations", 1],
      ["organization_county_affiliations", 1],
      ["organizations", 2],
      ["owner_bootstrap_audit", 0],
      ["people", 1],
      ["person_duplicate_flag_observations", 0],
      ["person_duplicate_flags", 0],
      ["person_roles", 1],
      ["person_visibility", 0],
      ["positions", 1],
      ["profile_deleted_targets", 0],
      ["profile_legacy_names", 0],
      ["profile_name_events", 0],
      ["profile_names", 0],
      ["profile_write_receipts", 0],
      ["report_audit", 0],
      ["report_challenge_claims", 0],
      ["report_evidence", 0],
      ["report_idempotency", 0],
      ["report_receipts", 0],
      ["report_status_history", 0],
      ["reports", 0],
      ["role_sources", 1],
      ["schema_migrations", 39],
      ["sync_batch_items", 0],
      ["sync_batch_reversals", 0],
      ["sync_batches", 0],
      ["website_dependency_assertions", 0],
      ["website_dependency_generation", 1],
      ["website_write_assertions", 0],
    ],
  );
  const m1Tables = [
    "organization_county_affiliations",
    "organizations",
    "people",
    "person_roles",
    "positions",
    "role_sources",
  ];
  assert.deepEqual(
    manifest.database.tables
      .filter((table) => m1Tables.includes(table.name))
      .map((table) => table.name),
    m1Tables,
  );
  assert.deepEqual(
    manifest.files,
    Object.entries(SYNTHETIC_FILES)
      .map(([key, bytes]) => ({
        key,
        size: bytes.length,
        sha256: sha256(bytes),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  );
  assert.deepEqual(manifest.totals, {
    tables: 60,
    rows: 183,
    files: 4,
    file_bytes: 52,
  });

  // The bundle holds real file contents, stored once per distinct digest.
  const stored = readdirSync(fixture.bundlePath(ID, "files")).sort();
  assert.equal(stored.length, 3);
  for (const digest of stored) {
    assert.equal(
      sha256(readFileSync(fixture.bundlePath(ID, "files", digest))),
      digest,
    );
  }
  assert.equal(
    readFileSync(fixture.bundlePath(ID, "manifest.json"), "utf8"),
    prepared.manifestJson,
  );
  assert.deepEqual(await fixture.destination.list(), [ID]);

  const restoredIds = {};
  const report = await verify(fixture, ID, {
    expectedManifestSha256: prepared.manifestSha256,
    openScratchDatabase: async () => {
      const scratch = await openWebsiteDatabase();
      return {
        close() {
          try {
            for (const table of m1Tables) {
              restoredIds[table] = scratch
                .prepare(`SELECT id FROM "${table}" ORDER BY id`)
                .all()
                .map((row) => row.id);
            }
          } finally {
            scratch.close();
          }
        },
        exec: (sql) => scratch.exec(sql),
        pragma: (sql, options) => scratch.pragma(sql, options),
        prepare: (sql) => scratch.prepare(sql),
        transaction: (callback) => scratch.transaction(callback),
      };
    },
  });
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
  assert.equal(report.manifest_sha256, prepared.manifestSha256);
  assert.deepEqual(report.restored, manifest.totals);
  assert.deepEqual(restoredIds, {
    organization_county_affiliations: ["m1-affiliation"],
    organizations: ["m1-county-org", "m1-regional-org"],
    people: ["m1-person"],
    person_roles: ["m1-person-role"],
    positions: ["m1-position"],
    role_sources: ["m1-source"],
  });
  assert.deepEqual(readdirSync(fixture.scratchRoot), []);
});

test("verification is repeatable and leaves live data and the bundle untouched", async (t) => {
  const fixture = await createFixture(t);
  await produce(fixture);
  const limits = {
    maxTables: 1000,
    maxRows: 1e6,
    maxDatabaseBytes: 1e8,
    maxSchemaBytes: 1e6,
  };
  const before = {
    database: canonicalJson(
      captureDatabaseSnapshot(fixture.database, limits).tables.map((table) => [
        table.name,
        sha256(table.text),
      ]),
    ),
    files: treeDigest(fixture.filesRoot),
    bundle: treeDigest(fixture.bundlePath(ID)),
  };

  const first = await verify(fixture);
  const second = await verify(fixture);
  assert.equal(first.ok, true);
  assert.deepEqual(second.restored, first.restored);
  assert.deepEqual(second.failures, first.failures);

  assert.equal(
    canonicalJson(
      captureDatabaseSnapshot(fixture.database, limits).tables.map((table) => [
        table.name,
        sha256(table.text),
      ]),
    ),
    before.database,
  );
  assert.equal(treeDigest(fixture.filesRoot), before.files);
  assert.equal(treeDigest(fixture.bundlePath(ID)), before.bundle);
});

test("changing one database row fails verification and names the table", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await produce(fixture);
  const path = fixture.bundlePath(ID, "db", "tables", "accounts.jsonl");
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes("Synthetic Owner"));
  overwrite(path, text.replace("Synthetic Owner", "Synthetic Owned"));

  const report = await verify(fixture, ID, {
    expectedManifestSha256: prepared.manifestSha256,
  });
  assertFailed(report, "member_digest_mismatch", /Table accounts/);
  assert.equal(report.restored.rows, 0);
});

test("a consistently rewritten bundle is caught only by the recorded digest", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await produce(fixture);
  const path = fixture.bundlePath(ID, "db", "tables", "accounts.jsonl");
  const text = readFileSync(path, "utf8").replace(
    "Synthetic Owner",
    "Synthetic Owned",
  );
  overwrite(path, text);
  rewriteManifest(fixture, ID, (manifest) => {
    const table = manifest.database.tables.find(
      (item) => item.name === "accounts",
    );
    table.sha256 = sha256(text);
  });

  // Hashes prove consistency with the supplied manifest, not provenance.
  assert.equal((await verify(fixture)).ok, true);
  assertFailed(
    await verify(fixture, ID, {
      expectedManifestSha256: prepared.manifestSha256,
    }),
    "manifest_digest_mismatch",
  );
});

test("changing one file byte fails verification and names the file", async (t) => {
  const fixture = await createFixture(t);
  await produce(fixture);
  const digest = sha256(SYNTHETIC_FILES["images/pixel.bin"]);
  overwrite(
    fixture.bundlePath(ID, "files", digest),
    Buffer.from([0, 255, 1, 254, 2, 252]),
  );
  assertFailed(
    await verify(fixture),
    "member_digest_mismatch",
    /images\/pixel\.bin/,
  );
});

test("a missing file and an unexpected member both fail verification", async (t) => {
  const fixture = await createFixture(t);
  await produce(fixture);
  const digest = sha256(SYNTHETIC_FILES["images/pixel.bin"]);
  rmSync(fixture.bundlePath(ID, "files", digest));
  assertFailed(await verify(fixture), "member_missing", /images\/pixel\.bin/);

  const other = "ckpt-synthetic-0002";
  await produce(fixture, other);
  writeFileSync(fixture.bundlePath(other, "files", "extra.bin"), "x");
  mkdirSync(fixture.bundlePath(other, "db", "surplus"));
  const report = await verify(fixture, other);
  assertFailed(report, "member_unexpected");
  assert.deepEqual(
    report.failures.map((item) => item.subject),
    ["db/surplus", "files/extra.bin"],
  );

  const truncated = "ckpt-synthetic-0003";
  await produce(fixture, truncated);
  const table = fixture.bundlePath(truncated, "db", "tables", "counties.jsonl");
  overwrite(table, readFileSync(table).subarray(0, 100));
  assertFailed(
    await verify(fixture, truncated),
    "member_size_mismatch",
    /Table counties/,
  );
});

test("malformed manifests fail safely with bounded diagnostics", async (t) => {
  const fixture = await createFixture(t);
  const cases = {
    "not json": () => "SYNTHETIC-SECRET-MARKER {not json",
    truncated: (text) => text.slice(0, text.length / 2),
    "extra field": (text) => text.replace("{", '{"aaa":1,'),
    "not canonical": (text) => `${text}\n`,
    "wrong id": (text) =>
      text.replace(/ckpt-synthetic-9\d\d\d/, "ckpt-synthetic-zzzz"),
    "negative size": (text) => text.replace(/"bytes":\d+/, '"bytes":-1'),
    "unsafe key": (text) => text.replace("empty.dat", "../empty.dat"),
    array: () => "[]",
  };
  let index = 0;
  for (const [name, mutate] of Object.entries(cases)) {
    const id = `ckpt-synthetic-9${String(index++).padStart(3, "0")}`;
    await produce(fixture, id);
    const path = fixture.bundlePath(id, "manifest.json");
    overwrite(path, mutate(readFileSync(path, "utf8")));
    const report = await verify(fixture, id);
    assertFailed(report, "manifest_malformed");
    assert.equal(report.restored.rows, 0, name);
    assert.ok(
      !JSON.stringify(report).includes("SYNTHETIC-SECRET-MARKER"),
      name,
    );
  }

  const versioned = "ckpt-synthetic-9100";
  await produce(fixture, versioned);
  rewriteManifest(fixture, versioned, (manifest) => {
    manifest.format_version = 2;
  });
  assertFailed(await verify(fixture, versioned), "unsupported_format_version");

  const oversized = "ckpt-synthetic-9101";
  await produce(fixture, oversized);
  assertFailed(
    await verify(fixture, oversized, { limits: { maxManifestBytes: 64 } }),
    "limit_exceeded",
  );
});

test("unknown or changed migrations fail verification", async (t) => {
  const fixture = await createFixture(t);
  await produce(fixture);
  const known = knownMigrationRecords();
  assertFailed(
    await verify(fixture, ID, { knownMigrations: known.slice(0, 1) }),
    "unknown_migration_version",
    /migration 2/,
  );
  assertFailed(
    await verify(fixture, ID, {
      knownMigrations: known.map((migration, index) =>
        index === 1 ? { ...migration, sha256: "0".repeat(64) } : migration,
      ),
    }),
    "migration_mismatch",
  );
});

test("partial production never creates a valid checkpoint", async (t) => {
  const fixture = await createFixture(t);
  async function* interrupted() {
    yield { path: "db/schema.json", bytes: Buffer.from("{}") };
    throw new Error("synthetic interruption");
  }
  await assert.rejects(
    fixture.destination.put(ID, interrupted()),
    /synthetic interruption/,
  );
  async function* noManifest() {
    yield { path: "db/schema.json", bytes: Buffer.from("{}") };
  }
  await assert.rejects(fixture.destination.put(ID, noManifest()), {
    code: "invalid_bundle",
  });
  async function* afterManifest() {
    yield { path: "manifest.json", bytes: Buffer.from("{}") };
    yield { path: "db/schema.json", bytes: Buffer.from("{}") };
  }
  await assert.rejects(fixture.destination.put(ID, afterManifest()), {
    code: "invalid_bundle",
  });
  async function* escaping() {
    yield { path: "../escape.txt", bytes: Buffer.from("x") };
  }
  await assert.rejects(fixture.destination.put(ID, escaping()), {
    code: "unsafe_member_path",
  });

  assert.deepEqual(await fixture.destination.list(), []);
  assert.deepEqual(readdirSync(join(fixture.destinationRoot, "published")), []);
  assert.deepEqual(readdirSync(join(fixture.destinationRoot, "staging")), []);
  assert.equal(existsSync(join(fixture.root, "escape.txt")), false);
  await assert.rejects(fixture.destination.get(ID), {
    code: "checkpoint_not_found",
  });

  // A crash can leave a complete-looking staging directory. It is not listed.
  const stale = join(fixture.destinationRoot, "staging", `${ID}-crashed`);
  mkdirSync(stale);
  writeFileSync(join(stale, "manifest.json"), "{}");
  assert.deepEqual(await fixture.destination.list(), []);
});

test("a source file that changes during production publishes nothing", async (t) => {
  const fixture = await createFixture(t);
  let reads = 0;
  const changing = {
    list: () => fixture.fileStore.list(),
    put: (key, bytes) => fixture.fileStore.put(key, bytes),
    async read(key, maxBytes) {
      reads += 1;
      if (reads === Object.keys(SYNTHETIC_FILES).length + 1) {
        writeFileSync(join(fixture.filesRoot, "empty.dat"), "now not empty");
      }
      return fixture.fileStore.read(key, maxBytes);
    },
  };
  await assert.rejects(produce(fixture, ID, { fileStore: changing }), {
    code: "source_changed",
  });
  assert.deepEqual(await fixture.destination.list(), []);

  let lists = 0;
  const growing = {
    read: (key, maxBytes) => fixture.fileStore.read(key, maxBytes),
    put: (key, bytes) => fixture.fileStore.put(key, bytes),
    async list() {
      lists += 1;
      if (lists === 2) {
        writeFileSync(join(fixture.filesRoot, "late-arrival.txt"), "late");
      }
      return fixture.fileStore.list();
    },
  };
  await assert.rejects(produce(fixture, ID, { fileStore: growing }), {
    code: "source_changed",
  });
  assert.deepEqual(await fixture.destination.list(), []);
});

test("the database snapshot is one consistent state", async (t) => {
  const fixture = await createFixture(t);
  // The file inventory runs after the snapshot. A write made then must not
  // appear in any exported table.
  const writer = {
    read: (key, maxBytes) => fixture.fileStore.read(key, maxBytes),
    put: (key, bytes) => fixture.fileStore.put(key, bytes),
    async list() {
      fixture.database.exec(
        "INSERT OR IGNORE INTO accounts (id, kind, role, display_name) VALUES ('acct-synthetic-late', 'human', 'editor', 'Synthetic Late'); INSERT OR IGNORE INTO identities (id, account_id, provider, subject) VALUES ('ident-synthetic-late', 'acct-synthetic-late', 'test', 'late')",
      );
      return fixture.fileStore.list();
    },
  };
  const prepared = await produce(fixture, ID, { fileStore: writer });
  const rows = Object.fromEntries(
    prepared.manifest.database.tables.map((table) => [table.name, table.rows]),
  );
  assert.equal(rows.accounts, 3);
  assert.equal(rows.identities, 3);
  assert.equal(
    fixture.database.prepare("SELECT count(*) AS n FROM accounts").get().n,
    4,
  );
  assert.equal((await verify(fixture)).ok, true);

  // Capture refuses to run inside a caller's open transaction.
  fixture.database.exec("BEGIN");
  await assert.rejects(
    prepareCheckpoint(fixture.database, fixture.fileStore, {
      checkpointId: "ckpt-synthetic-0002",
      applicationCommit: COMMIT,
    }),
  );
  fixture.database.exec("ROLLBACK");
});

test("duplicate checkpoint identifiers are rejected without overwriting", async (t) => {
  const fixture = await createFixture(t);
  await produce(fixture);
  const before = treeDigest(fixture.bundlePath(ID));
  fixture.database.exec(
    "UPDATE accounts SET display_name = 'Changed', version = version + 1 WHERE kind = 'agent'",
  );
  await assert.rejects(produce(fixture), { code: "duplicate_checkpoint" });
  assert.equal(treeDigest(fixture.bundlePath(ID)), before);
  assert.deepEqual(readdirSync(join(fixture.destinationRoot, "staging")), []);
  for (const id of [
    "short",
    "UPPERCASE-ID",
    "../escape-attempt",
    "ckpt/../../x",
  ]) {
    await assert.rejects(produce(fixture, id), {
      code: "invalid_checkpoint_id",
    });
  }
});

test("new tables and unusual values are captured automatically and exactly", async (t) => {
  const fixture = await createFixture(t);
  fixture.database.exec(`
    CREATE TABLE m0d_values (
      id INTEGER PRIMARY KEY, big INTEGER, ratio REAL, payload BLOB, note TEXT,
      doubled INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL
    );
    INSERT INTO m0d_values (id, big, ratio, payload, note) VALUES
      (1, 9223372036854775807, 0.1, x'00ff10', 'plain'),
      (2, -9223372036854775808, 1e300, x'', 'Zoë — 雪 😀'),
      (3, NULL, -2.5, NULL, CAST(x'ff00fe' AS TEXT)),
      (4, 9007199254740993, 3.0, zeroblob(3), '{"json":[1,2,{"k":null}]}'),
      (5, 0, 9e999, x'ab', '');
    CREATE INDEX m0d_values_note ON m0d_values (note);
    CREATE VIEW m0d_view AS SELECT id, note FROM m0d_values;
    CREATE TABLE "Weird Name!" (k TEXT PRIMARY KEY, v ANY) WITHOUT ROWID;
    INSERT INTO "Weird Name!" VALUES ('a', 1), ('b', 'one'), ('c', 1.5);
    CREATE TABLE m0d_counter (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);
    INSERT INTO m0d_counter (label) VALUES ('a'), ('b'), ('c');
    DELETE FROM m0d_counter WHERE label = 'c';
    PRAGMA user_version = 7;
  `);
  const { manifest } = await produce(fixture);
  const table = (name) =>
    manifest.database.tables.find((item) => item.name === name);
  assert.equal(table("m0d_values").rows, 5);
  assert.deepEqual(
    table("m0d_values").columns.map((column) => column.name),
    ["id", "big", "ratio", "payload", "note"],
  );
  assert.equal(table("Weird Name!").rows, 3);
  assert.match(
    table("Weird Name!").member,
    /^db\/tables\/x-[0-9a-f]{32}\.jsonl$/,
  );
  assert.equal(table("Weird Name!").member, tableMemberPath("Weird Name!"));
  assert.equal(table("sqlite_sequence").rows, 1);

  const exported = readFileSync(
    fixture.bundlePath(ID, "db", "tables", "m0d_values.jsonl"),
    "utf8",
  );
  assert.ok(exported.includes('["i","9223372036854775807"]'));
  assert.ok(exported.includes('["i","-9223372036854775808"]'));
  assert.ok(exported.includes('["i","9007199254740993"]'));
  assert.ok(exported.includes('["x","FF00FE"]'));
  assert.ok(exported.includes('["r","Infinity"]'));
  assert.ok(exported.includes('["b",""]'));
  assert.match(exported, /^[\x20-\x7e\n]*$/);

  const report = await verify(fixture);
  assert.deepEqual(report.failures, []);
  assert.equal(report.restored.tables, manifest.totals.tables);
});

test("negative zero survives capture, validation, restore and verification", async (t) => {
  const fixture = await createFixture(t);
  // Untyped columns keep negative zero. SQLite normalizes it to positive zero
  // in REAL and NUMERIC affinity columns, so only these can hold it.
  fixture.database.exec(`
    CREATE TABLE m0d_zero (id INTEGER PRIMARY KEY, v);
    INSERT INTO m0d_zero (id, v) VALUES
      (1, CAST('-0.0' AS REAL)), (2, CAST('0.0' AS REAL)), (3, -1.5),
      (4, 1.5), (5, 5e-324), (6, -5e-324), (7, 1.7976931348623157e308),
      (8, 9e999), (9, -9e999), (10, 0.1);
    CREATE TABLE m0d_zero_strict (id INTEGER PRIMARY KEY, v ANY) STRICT;
    INSERT INTO m0d_zero_strict VALUES (1, CAST('-0.0' AS REAL));
  `);
  const read = (database, table) =>
    database.prepare(`SELECT id, v FROM ${table} ORDER BY id`).all();
  const stored = read(fixture.database, "m0d_zero");
  assert.ok(Object.is(stored[0].v, -0), "source holds negative zero");
  assert.ok(Object.is(stored[1].v, 0), "source holds positive zero");
  assert.ok(
    Object.is(read(fixture.database, "m0d_zero_strict")[0].v, -0),
    "STRICT ANY column holds negative zero",
  );

  const { manifest } = await produce(fixture);
  const exported = readFileSync(
    fixture.bundlePath(ID, "db", "tables", "m0d_zero.jsonl"),
    "utf8",
  );
  const lines = exported.trimEnd().split("\n");
  assert.ok(lines.includes('[["i","1"],["r","-0"]]'));
  assert.ok(lines.includes('[["i","2"],["r","0"]]'));
  assert.ok(lines.includes('[["i","3"],["r","-1.5"]]'));
  assert.ok(lines.includes('[["i","5"],["r","5e-324"]]'));
  assert.ok(lines.includes('[["i","8"],["r","Infinity"]]'));
  assert.ok(lines.includes('[["i","9"],["r","-Infinity"]]'));
  assert.ok(lines.includes('[["i","10"],["r","0.1"]]'));
  assert.equal(
    manifest.database.tables.find((item) => item.name === "m0d_zero").rows,
    10,
  );

  // Every row passes canonical cell validation, then restores exactly.
  const columns = [
    { name: "id", type: "INTEGER", notnull: false, pk: 1 },
    { name: "v", type: "", notnull: false, pk: 0 },
  ];
  const scratch = await openWebsiteDatabase(":memory:");
  t.after(() => scratch.close());
  restoreDatabaseSnapshot(
    scratch,
    {
      user_version: 0,
      objects: [
        {
          type: "table",
          name: "m0d_zero",
          tbl_name: "m0d_zero",
          sql: "CREATE TABLE m0d_zero (id INTEGER PRIMARY KEY, v)",
        },
      ],
    },
    [
      {
        name: "m0d_zero",
        columns,
        rows: lines.map((line) => decodeRowLine(line, 2, "m0d_zero")),
      },
    ],
  );
  const restored = read(scratch, "m0d_zero");
  assert.equal(restored.length, stored.length);
  for (const [index, row] of restored.entries()) {
    assert.ok(
      Object.is(row.v, stored[index].v),
      `row ${row.id}: ${row.v} vs ${stored[index].v}`,
    );
  }
  assert.ok(Object.is(restored[0].v, -0));
  assert.ok(Object.is(restored[1].v, 0));

  // Full verification of the correct bundle succeeds, and the verifier's own
  // scratch restore re-exports negative zero identically.
  const report = await verify(fixture);
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
});

test("REAL-affinity columns store negative zero as positive zero", async (t) => {
  const fixture = await createFixture(t);
  fixture.database.exec(
    "CREATE TABLE m0d_real (id INTEGER PRIMARY KEY, r REAL); INSERT INTO m0d_real VALUES (1, CAST('-0.0' AS REAL));",
  );
  // SQLite normalizes the value at storage, so the source never holds -0 here
  // and "0" is the exact representation of what is stored.
  const row = fixture.database.prepare("SELECT r FROM m0d_real").get();
  assert.ok(Object.is(row.r, 0));
  await produce(fixture);
  assert.equal(
    readFileSync(
      fixture.bundlePath(ID, "db", "tables", "m0d_real.jsonl"),
      "utf8",
    ),
    '[["i","1"],["r","0"]]\n',
  );
  assert.deepEqual((await verify(fixture)).failures, []);
});

test("hostile identifiers in a bundle never reach restore diagnostics", async (t) => {
  const hostile = '<script>alert("x")</script>';
  const fixture = await createFixture(t);
  fixture.database.exec(`
    CREATE TABLE m0d_hostile (
      id INTEGER PRIMARY KEY,
      n INTEGER,
      CONSTRAINT "${hostile.replaceAll('"', '""')}" CHECK (n > 0)
    );
    INSERT INTO m0d_hostile VALUES (1, 5);
  `);
  await produce(fixture);
  const path = fixture.bundlePath(ID, "db", "tables", "m0d_hostile.jsonl");
  const text = readFileSync(path, "utf8").replace('["i","5"]', '["i","-5"]');
  overwrite(path, text);
  rewriteManifest(fixture, ID, (manifest) => {
    const entry = manifest.database.tables.find(
      (item) => item.name === "m0d_hostile",
    );
    entry.sha256 = sha256(text);
    entry.bytes = Buffer.byteLength(text);
  });

  const report = await verify(fixture);
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report), ["restore_failed"]);
  assertFailed(report, "restore_failed", /CHECK constraint failed/);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("script"));
  assert.ok(!serialized.includes("alert"));
  assert.ok(!serialized.includes("<"));
  for (const failure of report.failures) {
    assert.equal(failure.subject, "database");
    assert.ok(failure.detail.length <= 200);
  }
  // An unrecognized engine error is reported with fixed text as well.
  const unknown = await createFixture(t);
  unknown.database.exec(
    `CREATE TABLE "${hostile.replaceAll('"', '""')}" (id INTEGER PRIMARY KEY)`,
  );
  await produce(unknown);
  const schemaPath = unknown.bundlePath(ID, "db", "schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const duplicate = schema.objects.find((item) => item.name === hostile);
  schema.objects.push({ ...duplicate, type: "table" });
  const schemaText = canonicalJson(schema);
  overwrite(schemaPath, schemaText);
  rewriteManifest(unknown, ID, (manifest) => {
    manifest.database.schema.sha256 = sha256(schemaText);
    manifest.database.schema.bytes = Buffer.byteLength(schemaText);
  });
  const second = await verify(unknown);
  assert.equal(second.ok, false);
  assert.ok(codes(second).length > 0);
  assert.ok(!JSON.stringify(second).includes("script"));
});

test("table digests do not depend on physical row order", async () => {
  const digests = [];
  for (const order of [
    ["a", "b", "c"],
    ["c", "a", "b"],
  ]) {
    const database = await openWebsiteDatabase();
    migrateWebsiteDatabase(database);
    database.exec("CREATE TABLE m0d_unordered (label TEXT, n INTEGER)");
    for (const label of order) {
      database
        .prepare("INSERT INTO m0d_unordered VALUES (?, ?)")
        .run(label, label.charCodeAt(0));
    }
    const limits = {
      maxTables: 100,
      maxRows: 1000,
      maxDatabaseBytes: 1e6,
      maxSchemaBytes: 1e6,
    };
    const snapshot = captureDatabaseSnapshot(database, limits);
    digests.push(
      sha256(
        snapshot.tables.find((table) => table.name === "m0d_unordered").text,
      ),
    );
    database.close();
  }
  assert.equal(digests[0], digests[1]);
});

test("foreign-key and schema integrity are checked by the restore", async (t) => {
  const fixture = await createFixture(t);
  fixture.database.exec("PRAGMA foreign_keys = OFF");
  fixture.database.exec(
    "INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-synthetic-orphan', 'acct-synthetic-missing', 'test', 'orphan')",
  );
  fixture.database.exec("PRAGMA foreign_keys = ON");
  await produce(fixture);
  assertFailed(await verify(fixture), "foreign_key_violation", /identities/);

  // A self-consistent bundle whose rows violate the schema cannot restore.
  const clean = await createFixture(t);
  await produce(clean);
  const path = clean.bundlePath(ID, "db", "tables", "accounts.jsonl");
  const text = readFileSync(path, "utf8").replace(
    '["t","human"]',
    '["t","robot"]',
  );
  overwrite(path, text);
  rewriteManifest(clean, ID, (manifest) => {
    manifest.database.tables.find((item) => item.name === "accounts").sha256 =
      sha256(text);
  });
  assertFailed(await verify(clean), "restore_failed", /CHECK constraint/);

  // A schema entry that differs from what SQLite would store is detected.
  const altered = await createFixture(t);
  await produce(altered);
  const schemaPath = altered.bundlePath(ID, "db", "schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const counties = schema.objects.find((item) => item.name === "counties");
  counties.sql = `${counties.sql}; DROP TABLE accounts`;
  const schemaText = canonicalJson(schema);
  overwrite(schemaPath, schemaText);
  rewriteManifest(altered, ID, (manifest) => {
    manifest.database.schema.sha256 = sha256(schemaText);
    manifest.database.schema.bytes = Buffer.byteLength(schemaText);
  });
  assertFailed(await verify(altered), "schema_digest_mismatch");
});

test("empty file storage and zero-byte files work", async (t) => {
  const empty = await createFixture(t, {});
  const prepared = await produce(empty);
  assert.deepEqual(prepared.manifest.files, []);
  assert.equal(existsSync(empty.bundlePath(ID, "files")), false);
  const report = await verify(empty);
  assert.equal(report.ok, true);
  assert.equal(report.restored.files, 0);

  const zero = await createFixture(t, { "zero.bin": Buffer.alloc(0) });
  const zeroPrepared = await produce(zero);
  assert.deepEqual(zeroPrepared.manifest.files, [
    { key: "zero.bin", size: 0, sha256: sha256("") },
  ]);
  assert.equal((await verify(zero)).restored.files, 1);
});

test("unsafe paths, symlinks and duplicate keys are rejected", async (t) => {
  const linked = await createFixture(t);
  symlinkSync(
    join(linked.filesRoot, "empty.dat"),
    join(linked.filesRoot, "link.dat"),
  );
  await assert.rejects(produce(linked), { code: "unsafe_source_file" });

  const named = await createFixture(t);
  writeFileSync(join(named.filesRoot, "bad name.txt"), "x");
  await assert.rejects(produce(named), { code: "unsafe_file_key" });
  assert.deepEqual(await named.destination.list(), []);

  const fixture = await createFixture(t);
  for (const key of [
    "../escape",
    "/absolute",
    "a//b",
    "a/./b",
    "a\\b",
    "nul",
    "trailing.",
    "",
  ]) {
    await assert.rejects(
      fixture.fileStore.read(key, 10),
      { code: "unsafe_file_key" },
      key,
    );
    await assert.rejects(
      fixture.fileStore.put(key, Buffer.from("x")),
      { code: "unsafe_file_key" },
      key,
    );
  }
  const stub = (keys) => ({
    list: async () => keys.map((key) => ({ key, size: 0, revision: "r" })),
    read: async (key) => ({
      key,
      size: 0,
      revision: "r",
      bytes: Buffer.alloc(0),
    }),
    put: async () => {},
  });
  await assert.rejects(
    produce(fixture, ID, { fileStore: stub(["../escape"]) }),
    {
      code: "unsafe_file_key",
    },
  );
  await assert.rejects(
    produce(fixture, ID, { fileStore: stub(["Report.txt", "report.txt"]) }),
    {
      code: "duplicate_file_key",
    },
  );
  await assert.rejects(produce(fixture, ID, { limits: { maxFileBytes: 4 } }), {
    code: "limit_exceeded",
  });
  await assert.rejects(produce(fixture, ID, { limits: { maxRows: 10 } }), {
    code: "limit_exceeded",
  });
  assert.deepEqual(await fixture.destination.list(), []);

  // A symlink planted in a published bundle is a defect, not followed.
  await produce(fixture);
  const outside = join(fixture.root, "outside.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, fixture.bundlePath(ID, "files", "planted"));
  assertFailed(await verify(fixture), "unsafe_bundle_member", /files\/planted/);

  // A symlinked parent directory is refused by the file store.
  const store = new LocalFileStore(fixture.filesRoot);
  symlinkSync(fixture.root, join(fixture.filesRoot, "sneaky"));
  await assert.rejects(store.read("sneaky/outside.txt", 100), {
    code: "unsafe_source_file",
  });
});

test("the local destination refuses to prune", async (t) => {
  const fixture = await createFixture(t);
  await produce(fixture);
  const before = treeDigest(fixture.destinationRoot);
  await assert.rejects(fixture.destination.prune(), { code: "prune_disabled" });
  assert.equal(treeDigest(fixture.destinationRoot), before);
  assert.deepEqual(await fixture.destination.list(), [ID]);
});

test("checkpoint tests rely on local synthetic inputs only", () => {
  assert.ok(loadWebsiteMigrations().length >= 3);
  for (const name of ["DATABASE_PATH", "CLOUDFLARE_API_TOKEN", "R2_BUCKET"]) {
    assert.equal(process.env[name], undefined, name);
  }
});

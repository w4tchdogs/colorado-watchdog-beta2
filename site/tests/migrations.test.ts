import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMigrations, migrationTags, schemaDump } from "../src/db/migrate.ts";
import { nodeSqliteDb } from "../src/db/node-sqlite.ts";
import { freshDb } from "./helpers.ts";

const M0_TABLES = [
  "accounts",
  "audit_events",
  "checkpoints",
  "counties",
  "identities",
  "operations",
];

test("migrations are ordered and build the six M0 tables on an empty database", () => {
  const db = nodeSqliteDb();
  const tags = applyMigrations(db);
  assert.deepEqual(tags, [...tags].sort());
  assert.ok(tags.length >= 2);
  const tables = db.raw
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
    .sort();
  assert.deepEqual(tables, M0_TABLES);
  db.close();
});

test("two rebuilds from empty produce an identical schema and identical seed data", () => {
  const first = freshDb();
  const second = freshDb();
  assert.equal(schemaDump(first), schemaDump(second));
  const counties = (db: typeof first) =>
    JSON.stringify(db.raw.prepare("SELECT * FROM counties ORDER BY fips").all());
  assert.equal(counties(first), counties(second));
  first.close();
  second.close();
});

test("the journal lists every migration file exactly once", () => {
  const tags = migrationTags();
  assert.equal(new Set(tags).size, tags.length);
  assert.deepEqual(tags.slice(0, 2), ["0000_foundation", "0001_seed_counties"]);
});

test("the Site schema contains no research tables", () => {
  const db = freshDb();
  const research = [
    "org_units",
    "org_names",
    "role_targets",
    "unit_coverage",
    "source_unit_links",
    "research_people",
    "name_variants",
    "role_claims",
    "possible_matches",
    "sources",
    "evidence_links",
    "scrape_batches",
    "research_runs",
    "source_visits",
    "site_links",
    "sync_batches",
    "sync_items",
    "research_events",
  ];
  const present = db.raw
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));
  assert.deepEqual(
    research.filter((name) => present.includes(name)),
    [],
  );
  db.close();
});

test("only reference data is seeded and every other table starts empty", () => {
  const db = freshDb();
  for (const table of M0_TABLES.filter((name) => name !== "counties")) {
    const row = db.raw.prepare(`SELECT count(*) AS total FROM ${table}`).get();
    assert.equal(row?.total, 0, table);
  }
  db.close();
});

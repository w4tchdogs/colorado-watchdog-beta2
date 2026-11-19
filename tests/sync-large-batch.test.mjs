import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangeset } from "../dist/services/sync-commit.js";
import { commitSyncChangesetD1 } from "../dist/services/sync-commit-d1.js";
import { reverseSyncBatch } from "../dist/services/sync-history.js";
import { planSyncChangeset } from "../dist/services/sync-planner.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";
import { reverseSyncBatchD1 } from "../dist/services/sync-revert-d1.js";

const REQUEST_ID = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const now = () => new Date("2026-11-13T12:00:00.000Z");
const PEOPLE = 300;
const SOURCES = 60;
const TEN_THOUSAND = 10_000;

/** 660 changes and 60 citations: well past the former 200-change and 25-citation caps. */
function bigChangeset(intent = "commit", people = PEOPLE, sources = SOURCES) {
  const changes = [];
  for (let s = 0; s < sources; s++) {
    changes.push({
      op: "register_source",
      entity: "role_sources",
      clientRef: `source-${s}`,
      fields: {
        url: `https://example.invalid/source-${s}`,
        title: `Synthetic source ${s}`,
        publisher_classification: s % 2 ? "official" : "unofficial",
        source_type: "other_public",
      },
    });
  }
  for (let p = 0; p < people; p++) {
    changes.push({
      op: "create_person",
      entity: "people",
      clientRef: `person-${p}`,
      fields: { display_name: `Synthetic Person ${p}` },
    });
  }
  for (let p = 0; p < people; p++) {
    changes.push({
      op: "create_person_role",
      entity: "person_roles",
      clientRef: `role-${p}`,
      fields: {
        person_ref: `person-${p}`,
        source_ref: `source-${p % sources}`,
        county_fips: "08001",
        published_office: `Synthetic Office ${p}`,
        source_checked_at: "2026-11-12T12:00:00Z",
      },
    });
  }
  return {
    contractVersion: "m2-sync/v1",
    requestId: REQUEST_ID,
    intent,
    changes,
  };
}

function localD1(database) {
  const binding = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...parameters) {
          values = parameters;
          return statement;
        },
        async first() {
          return database.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: database.prepare(sql).all(...values),
          };
        },
        async run() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
        runSync() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements) {
      return database.transaction(() =>
        statements.map((statement) => statement.runSync()),
      )();
    },
  };
  return new AsyncD1Database(binding);
}

async function fixture(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name) VALUES ('big-owner', 'human', 'owner', 'Synthetic Owner');
    INSERT INTO identities (id, account_id, provider, subject) VALUES ('big-identity', 'big-owner', 'test-human', 'owner');
  `);
  const principal = await resolvePrincipal(
    database,
    new Request("https://watchdog.invalid", {
      headers: { "x-test-human-subject": "owner" },
    }),
    createTestHumanIdentityAdapter({ owner: "owner" }),
  );
  assert.ok(principal);
  try {
    await callback(database, principal);
  } finally {
    database.close();
  }
}

const counts = (database) =>
  Object.fromEntries(
    ["people", "role_sources", "person_roles"].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    ]),
  );

test("both planners accept hundreds of changes and dozens of citations", async () => {
  await fixture(async (database) => {
    const request = bigChangeset("dry_run");
    const sync = planSyncChangeset(database, request, now);
    assert.equal(sync.eligible, true, JSON.stringify(sync.errors.slice(0, 3)));
    assert.equal(sync.items.length, 660);
    const asynchronous = await planSyncChangesetD1(
      localD1(database),
      request,
      now,
    );
    assert.deepEqual(asynchronous, sync);
  });
});

test("SQL.js commit and reversal handle a batch beyond the former caps", async () => {
  await fixture(async (database, principal) => {
    const committed = await commitSyncChangeset(
      database,
      principal,
      "big-sync-key",
      bigChangeset(),
      now,
    );
    assert.equal(committed.status, "committed", JSON.stringify(committed));
    if (committed.status !== "committed") return;
    assert.equal(committed.items.length, 660);
    assert.deepEqual(counts(database), {
      people: PEOPLE,
      role_sources: SOURCES,
      person_roles: PEOPLE,
    });
    const reversed = await reverseSyncBatch(
      database,
      principal,
      committed.batchId,
      "big-sync-revert",
      now,
    );
    assert.equal(reversed.status, "reverted", JSON.stringify(reversed));
    assert.deepEqual(counts(database), {
      people: 0,
      role_sources: 0,
      person_roles: 0,
    });
  });
});

test("D1 commit and reversal handle a batch beyond the former caps", async () => {
  await fixture(async (database, principal) => {
    const d1 = localD1(database);
    const committed = await commitSyncChangesetD1(
      d1,
      principal,
      "big-d1-key",
      bigChangeset(),
      { authorize: async (_p, capability) => capability === "sync.apply", now },
    );
    assert.equal(committed.status, "committed", JSON.stringify(committed));
    if (committed.status !== "committed") return;
    assert.equal(committed.items.length, 660);
    assert.equal(counts(database).person_roles, PEOPLE);
    const reversed = await reverseSyncBatchD1(
      d1,
      principal,
      committed.batchId,
      "big-d1-revert",
      {
        authorize: async (_p, capability) => capability === "sync.revert",
        now,
      },
    );
    assert.equal(reversed.status, "reverted", JSON.stringify(reversed));
    assert.deepEqual(counts(database), {
      people: 0,
      role_sources: 0,
      person_roles: 0,
    });
  });
});

test("the request size limit still bounds a changeset", async () => {
  await fixture(async (database) => {
    const request = bigChangeset("dry_run");
    for (const change of request.changes.slice(0, 300)) {
      change.untrustedPadding = "x".repeat(30_000);
    }
    const plan = planSyncChangeset(database, request, now);
    assert.equal(plan.eligible, false);
    assert.ok(plan.errors.some((error) => error.code === "request_too_large"));
  });
});

const WIDE_MIGRATION = "0023_sync_batch_result_size.sql";

function smallBatch(tag, requestId) {
  return {
    contractVersion: "m2-sync/v1",
    requestId,
    intent: "commit",
    duplicateFlags: [
      {
        targetType: "person",
        targetRef: "person",
        possibleDuplicateOf: "existing-person",
        category: "possible_match",
        reason: `Synthetic observation ${tag}`,
        evidenceSourceRefs: ["source"],
        nonblocking: true,
      },
    ],
    changes: [
      {
        op: "register_source",
        entity: "role_sources",
        clientRef: "source",
        fields: {
          url: `https://example.invalid/${tag}`,
          title: `Synthetic ${tag}`,
          publisher_classification: "official",
          source_type: "other_public",
        },
      },
      {
        op: "create_person",
        entity: "people",
        clientRef: "person",
        fields: { display_name: `Synthetic ${tag}` },
      },
      {
        op: "create_person_role",
        entity: "person_roles",
        clientRef: "role",
        fields: {
          person_ref: "person",
          source_ref: "source",
          county_fips: "08001",
          published_office: `Synthetic Office ${tag}`,
          source_checked_at: "2026-11-12T12:00:00Z",
        },
      },
    ],
  };
}

test("migration 0023 widens the batch result limit and preserves populated sync history", async () => {
  const database = await openWebsiteDatabase();
  try {
    const migrations = loadWebsiteMigrations();
    migrateWebsiteDatabase(
      database,
      migrations.filter((migration) => migration.name < WIDE_MIGRATION),
    );
    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('up-owner', 'human', 'owner', 'Synthetic Owner');
      INSERT INTO identities (id, account_id, provider, subject) VALUES ('up-identity', 'up-owner', 'test-human', 'owner');
      INSERT INTO people (id, display_name) VALUES ('existing-person', 'Synthetic Existing Person');
    `);
    const principal = await resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": "owner" },
      }),
      createTestHumanIdentityAdapter({ owner: "owner" }),
    );
    const first = await commitSyncChangeset(
      database,
      principal,
      "old-1",
      smallBatch("one", "1b5f57a2-84b7-4a4d-b300-33aea9feeb19"),
      now,
    );
    const second = await commitSyncChangeset(
      database,
      principal,
      "old-2",
      smallBatch("two", "2b5f57a2-84b7-4a4d-b300-33aea9feeb19"),
      now,
    );
    assert.equal(first.status, "committed", JSON.stringify(first));
    assert.equal(second.status, "committed", JSON.stringify(second));
    // The reversal engine checks Profile names as dependents. This schema
    // predates that table, so an empty stand-in lets history be built here.
    // It is dropped before the migrations resume.
    database.exec(
      "CREATE TABLE profile_names (id TEXT PRIMARY KEY, person_id TEXT)",
    );
    const reversed = await reverseSyncBatch(
      database,
      principal,
      second.batchId,
      "old-revert",
      now,
    );
    assert.equal(reversed.status, "reverted");
    database.exec("DROP TABLE profile_names");

    const tables = [
      "sync_batches",
      "sync_batch_items",
      "sync_batch_reversals",
      "person_duplicate_flags",
      "person_duplicate_flag_observations",
    ];
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
        ]),
      );
    const before = snapshot();
    assert.ok(before.person_duplicate_flags.length > 0);
    assert.ok(before.sync_batch_reversals.length > 0);

    migrateWebsiteDatabase(database, migrations);

    assert.deepEqual(snapshot(), before);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    for (const child of tables.slice(1)) {
      assert.ok(
        database
          .prepare(`PRAGMA foreign_key_list(${child})`)
          .all()
          .some((key) => key.table === "sync_batches"),
        child,
      );
    }
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'sync_batches_%' AND type = 'table'",
        )
        .get().n,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sync_batches'",
        )
        .get().n,
      3,
    );
    // The retained foreign keys still protect a committed batch.
    assert.throws(() =>
      database
        .prepare("DELETE FROM sync_batches WHERE id = ?")
        .run(first.batchId),
    );
    // Exact replay of an older result still works after the rebuild.
    const replay = await commitSyncChangeset(
      database,
      principal,
      "old-1",
      smallBatch("one", "1b5f57a2-84b7-4a4d-b300-33aea9feeb19"),
      now,
    );
    assert.equal(replay.status, "committed");
    assert.equal(replay.replayed, true);
    // A batch beyond the former 64 KiB result limit now commits.
    const big = await commitSyncChangeset(
      database,
      principal,
      "new-big",
      bigChangeset(),
      now,
    );
    assert.equal(big.status, "committed", JSON.stringify(big));
  } finally {
    database.close();
  }
});

test("a batch of 10,000 changes plans, commits, replays and reverses in SQL.js and D1", async () => {
  // 4,000 people, 4,000 roles and 2,000 distinct citations.
  const request = () => bigChangeset("commit", 4000, 2000);
  assert.equal(request().changes.length, TEN_THOUSAND);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(request())).length <
      8 * 1024 * 1024,
  );
  await fixture(async (database, principal) => {
    const plan = planSyncChangeset(
      database,
      { ...request(), intent: "dry_run" },
      now,
    );
    assert.equal(plan.eligible, true, JSON.stringify(plan.errors.slice(0, 3)));
    const committed = await commitSyncChangeset(
      database,
      principal,
      "ten-k-sql",
      request(),
      now,
    );
    assert.equal(
      committed.status,
      "committed",
      JSON.stringify(committed).slice(0, 300),
    );
    if (committed.status !== "committed") return;
    assert.equal(committed.items.length, TEN_THOUSAND);
    assert.equal(counts(database).person_roles, 4000);
    const replay = await commitSyncChangeset(
      database,
      principal,
      "ten-k-sql",
      request(),
      now,
    );
    assert.equal(replay.status, "committed");
    if (replay.status === "committed") assert.equal(replay.replayed, true);
    const reversed = await reverseSyncBatch(
      database,
      principal,
      committed.batchId,
      "ten-k-sql-revert",
      now,
    );
    assert.equal(reversed.status, "reverted", JSON.stringify(reversed));
    assert.equal(counts(database).person_roles, 0);
  });
  await fixture(async (database, principal) => {
    const d1 = localD1(database);
    const committed = await commitSyncChangesetD1(
      d1,
      principal,
      "ten-k-d1",
      request(),
      {
        authorize: async (_p, capability) => capability === "sync.apply",
        now,
      },
    );
    assert.equal(
      committed.status,
      "committed",
      JSON.stringify(committed).slice(0, 300),
    );
    if (committed.status !== "committed") return;
    assert.equal(committed.items.length, TEN_THOUSAND);
    assert.equal(counts(database).people, 4000);
    const reversed = await reverseSyncBatchD1(
      d1,
      principal,
      committed.batchId,
      "ten-k-d1-revert",
      {
        authorize: async (_p, capability) => capability === "sync.revert",
        now,
      },
    );
    assert.equal(
      reversed.status,
      "reverted",
      JSON.stringify(reversed).slice(0, 300),
    );
    assert.deepEqual(counts(database), {
      people: 0,
      role_sources: 0,
      person_roles: 0,
    });
  });
});

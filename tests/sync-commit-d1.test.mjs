import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangesetD1 } from "../dist/services/sync-commit-d1.js";
import { planSyncChangeset } from "../dist/services/sync-planner.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";

const requestId = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const now = () => new Date("2026-11-13T12:00:00.000Z");
const create = (op, entity, clientRef, fields) => ({
  op,
  entity,
  clientRef,
  fields,
});

function changeset(changes, extra = {}) {
  return {
    contractVersion: "m2-sync/v1",
    requestId,
    intent: "commit",
    changes,
    ...extra,
  };
}

function completeChangeset() {
  return changeset([
    create("create_organization", "organizations", "org", {
      name: "Synthetic Adams Office",
      organization_type: "office",
      county_fips: "08001",
    }),
    create(
      "add_county_affiliation",
      "organization_county_affiliations",
      "affiliation",
      {
        organization_ref: "org",
        county_fips: "08013",
        relationship_type: "serves",
      },
    ),
    create("create_position", "positions", "position", {
      organization_ref: "org",
      title: "Synthetic Clerk",
    }),
    create("create_person", "people", "person", {
      display_name: "Fictional Person",
    }),
    create("register_source", "role_sources", "source", {
      url: "https://example.invalid/synthetic",
      title: "Synthetic source",
      source_type: "official_page",
    }),
    create("create_person_role", "person_roles", "role", {
      person_ref: "person",
      position_ref: "position",
      source_ref: "source",
      source_checked_at: "2026-11-12T12:00:00Z",
    }),
  ]);
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
      const transact = database.transaction(() =>
        statements.map((statement) => statement.runSync()),
      );
      return transact();
    },
  };
  return new AsyncD1Database(binding);
}

async function fixture(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-owner', 'human', 'owner', 'Synthetic Owner');
    INSERT INTO identities (id, account_id, provider, subject) VALUES ('d1-identity', 'd1-owner', 'test-human', 'owner');
    INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('org-race', 'Synthetic Race Office', 'office', '08001');
  `);
  const adapter = createTestHumanIdentityAdapter({ owner: "owner" });
  const principal = await resolvePrincipal(
    database,
    new Request("https://watchdog.invalid", {
      headers: { "x-test-human-subject": "owner" },
    }),
    adapter,
  );
  assert.ok(principal);
  try {
    await callback(database, localD1(database), principal);
  } finally {
    database.close();
  }
}

const allowSynthetic = async (_principal, capability) =>
  capability === "sync.apply";

test("asynchronous planner matches the synchronous M2-B plan", async () => {
  await fixture(async (database, d1) => {
    const request = { ...completeChangeset(), intent: "dry_run" };
    assert.deepEqual(
      await planSyncChangesetD1(d1, request, now),
      planSyncChangeset(database, request, now),
    );
  });
});

test("D1 commit persists dependent records, inverse data, audit, and exact replay", async () => {
  await fixture(async (database, d1, principal) => {
    const first = await commitSyncChangesetD1(
      d1,
      principal,
      "d1-commit-key",
      completeChangeset(),
      {
        authorize: allowSynthetic,
        now,
      },
    );
    assert.equal(first.status, "committed");
    if (first.status !== "committed") return;
    assert.equal(first.items.length, 6);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_batch_items WHERE batch_id = ?",
        )
        .get(first.batchId).count,
      6,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sync.batch.commit'",
        )
        .get().count,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM website_write_assertions")
        .get().count,
      0,
    );

    const replay = await commitSyncChangesetD1(
      d1,
      principal,
      "d1-commit-key",
      {
        ...completeChangeset(),
        requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb20",
      },
      { authorize: allowSynthetic, now },
    );
    assert.equal(replay.status, "committed");
    if (replay.status === "committed") {
      assert.equal(replay.replayed, true);
      assert.equal(replay.batchId, first.batchId);
      assert.deepEqual(replay.items, first.items);
    }

    const mismatch = await commitSyncChangesetD1(
      d1,
      principal,
      "d1-commit-key",
      changeset([
        create("create_person", "people", "other", {
          display_name: "Different Person",
        }),
      ]),
      { authorize: allowSynthetic, now },
    );
    assert.equal(mismatch.status, "rejected");
    assert.equal(mismatch.errors[0]?.code, "idempotency_mismatch");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM people").get().count,
      1,
    );
  });
});

test("two asynchronous calls racing for one idempotency key return the durable winner", async () => {
  await fixture(async (database, d1, principal) => {
    const [left, right] = await Promise.all([
      commitSyncChangesetD1(d1, principal, "d1-race-key", completeChangeset(), {
        authorize: allowSynthetic,
        now,
      }),
      commitSyncChangesetD1(d1, principal, "d1-race-key", completeChangeset(), {
        authorize: allowSynthetic,
        now,
      }),
    ]);
    assert.equal(left.status, "committed");
    assert.equal(right.status, "committed");
    if (left.status === "committed" && right.status === "committed") {
      assert.equal(left.batchId, right.batchId);
      assert.deepEqual(left.items, right.items);
      assert.equal(Number(left.replayed) + Number(right.replayed), 1);
    }
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sync_batches").get()
        .count,
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM people").get().count,
      1,
    );
  });
});

test("a cross-writer change after the captured generation rejects the entire batch", async () => {
  await fixture(async (database, baseD1, principal) => {
    let injected = false;
    const originalFirst = baseD1.first.bind(baseD1);
    baseD1.first = async (sql, values = []) => {
      const row = await originalFirst(sql, values);
      if (!injected && sql.includes("FROM sync_batches")) {
        injected = true;
        database
          .prepare(
            "INSERT INTO positions (id, organization_id, title) VALUES ('race-position', 'org-race', 'Synthetic competing position')",
          )
          .run();
      }
      return row;
    };
    const request = changeset([
      create("create_person", "people", "person", {
        display_name: "Must roll back",
      }),
    ]);
    const result = await commitSyncChangesetD1(
      baseD1,
      principal,
      "d1-stale-key",
      request,
      { authorize: allowSynthetic, now },
    );
    assert.equal(result.status, "rejected");
    assert.equal(result.errors[0]?.code, "commit_conflict");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM people").get().count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sync_batches").get()
        .count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sync.batch.commit'",
        )
        .get().count,
      0,
    );
  });
});

test("D1 async commit defaults to deny without the sync.apply authorizer", async () => {
  await fixture(async (_database, d1, principal) => {
    await assert.rejects(
      commitSyncChangesetD1(
        d1,
        principal,
        "d1-denied-key",
        completeChangeset(),
        { now },
      ),
      /cannot apply synchronization/,
    );
  });
});

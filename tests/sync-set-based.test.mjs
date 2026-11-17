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
import { lookupSyncBatchD1 } from "../dist/services/sync-lookup-d1.js";
import { planSyncChangeset } from "../dist/services/sync-planner.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";
import { reverseSyncBatchD1 } from "../dist/services/sync-revert-d1.js";
import {
  countingD1Binding,
  mixedChangeset,
  referenceBaseChangeset,
  referenceRolesChangeset,
} from "./sync-scale-fixtures.mjs";

const now = () => new Date("2026-11-13T12:00:00.000Z");
const apply = { authorize: async (_p, c) => c === "sync.apply", now };
const revert = { authorize: async (_p, c) => c === "sync.revert", now };
const TABLES = [
  "organizations",
  "positions",
  "role_sources",
  "people",
  "person_roles",
  "sync_batches",
];

async function fixture(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name) VALUES ('set-owner', 'human', 'owner', 'Synthetic Owner');
    INSERT INTO identities (id, account_id, provider, subject) VALUES ('set-identity', 'set-owner', 'test-human', 'owner');
  `);
  const principal = await resolvePrincipal(
    database,
    new Request("https://watchdog.invalid", {
      headers: { "x-test-human-subject": "owner" },
    }),
    createTestHumanIdentityAdapter({ owner: "owner" }),
  );
  try {
    await callback(database, principal);
  } finally {
    database.close();
  }
}

function counted(database, hooks = {}) {
  const counting = countingD1Binding(database);
  if (hooks.beforeBatch) {
    const batch = counting.binding.batch;
    counting.binding.batch = async (statements) => {
      await hooks.beforeBatch();
      return batch(statements);
    };
  }
  return { ...counting, d1: new AsyncD1Database(counting.binding) };
}

const counts = (database) =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    ]),
  );

async function commitBase(database, principal) {
  const { d1 } = counted(database);
  const base = await commitSyncChangesetD1(
    d1,
    principal,
    "set-base",
    referenceBaseChangeset(),
    apply,
  );
  assert.equal(base.status, "committed", JSON.stringify(base.errors));
  return new Map(base.items.map((item) => [item.clientRef, item.websiteId]));
}

test("set-based D1 plans match the SQL.js planner for both scale fixtures", async () => {
  await fixture(async (database, principal) => {
    const mixed = mixedChangeset("dry_run");
    assert.deepEqual(
      await planSyncChangesetD1(counted(database).d1, mixed, now),
      planSyncChangeset(database, mixed, now),
    );
    const ids = await commitBase(database, principal);
    const references = referenceRolesChangeset(ids, "dry_run");
    const plan = await planSyncChangesetD1(
      counted(database).d1,
      references,
      now,
    );
    assert.equal(plan.eligible, true, JSON.stringify(plan.errors.slice(0, 3)));
    assert.deepEqual(plan, planSyncChangeset(database, references, now));
  });
});

test("D1 calls stay bounded instead of growing per item", async () => {
  await fixture(async (database, principal) => {
    const plan = counted(database);
    await planSyncChangesetD1(plan.d1, mixedChangeset("dry_run"), now);
    assert.ok(plan.total() <= 5, `mixed dry run used ${plan.total()} calls`);

    const commit = counted(database);
    const committed = await commitSyncChangesetD1(
      commit.d1,
      principal,
      "set-mixed",
      mixedChangeset(),
      apply,
    );
    assert.equal(
      committed.status,
      "committed",
      JSON.stringify(committed.errors),
    );
    assert.equal(committed.items.length, 816);
    assert.ok(
      commit.total() <= 12,
      `mixed commit used ${commit.total()} calls`,
    );
    assert.equal(commit.counter.batch, 1, "one atomic write");

    const ids = await commitBase(database, principal);
    const refs = counted(database);
    const roles = await commitSyncChangesetD1(
      refs.d1,
      principal,
      "set-refs",
      referenceRolesChangeset(ids),
      apply,
    );
    assert.equal(roles.status, "committed", JSON.stringify(roles.errors));
    assert.equal(roles.items.length, 251);
    assert.ok(
      refs.total() <= 15,
      `reference commit used ${refs.total()} calls`,
    );
  });
});

test("the diagnostic reports counts and timings only", async () => {
  await fixture(async (database, principal) => {
    const seen = [];
    const result = await commitSyncChangesetD1(
      counted(database).d1,
      principal,
      "set-diagnostic",
      mixedChangeset(),
      { ...apply, diagnostic: (value) => seen.push(value) },
    );
    assert.equal(result.status, "committed");
    assert.equal(seen.length, 1);
    const [d] = seen;
    assert.equal(d.outcome, "committed");
    assert.equal(d.operations, 816);
    assert.equal(
      d.finalPlanReads,
      0,
      "the final plan reuses the guarded reads",
    );
    assert.ok(d.planReads <= 5);
    assert.deepEqual(Object.keys(d).sort(), [
      "finalPlanReads",
      "milliseconds",
      "operations",
      "outcome",
      "planReads",
      "statements",
    ]);
    assert.doesNotMatch(JSON.stringify(d), /Synthetic|example\.invalid/);
  });
});

test("a concurrent write after the shared reads makes the guarded commit fail with no partial write", async () => {
  await fixture(async (database, principal) => {
    const ids = await commitBase(database, principal);
    const before = counts(database);
    const { d1 } = counted(database, {
      beforeBatch: async () => {
        database
          .prepare(
            "UPDATE people SET display_name = ?, version = version + 1 WHERE id = ?",
          )
          .run("Synthetic Concurrent Edit", ids.get("person-0"));
      },
    });
    const result = await commitSyncChangesetD1(
      d1,
      principal,
      "set-concurrent",
      referenceRolesChangeset(ids),
      apply,
    );
    assert.equal(result.status, "rejected");
    assert.ok(result.errors.some((e) => e.code === "commit_conflict"));
    assert.deepEqual(counts(database), before);
  });
});

test("a stale expected version is rejected before and after planning", async () => {
  await fixture(async (database, principal) => {
    const ids = await commitBase(database, principal);
    const person = ids.get("person-1");
    const update = (expectedVersion) => ({
      contractVersion: "m2-sync/v1",
      requestId: "8a3f5c10-0001-4d16-9a01-000000000001",
      intent: "commit",
      changes: [
        {
          op: "update_record",
          entity: "people",
          targetId: person,
          expectedVersion,
          fields: { display_name: "Synthetic Renamed Person" },
        },
      ],
    });
    const stale = await commitSyncChangesetD1(
      counted(database).d1,
      principal,
      "set-stale",
      update(99),
      apply,
    );
    assert.equal(stale.status, "rejected");
    assert.ok(stale.errors.some((e) => e.code === "stale_version"));

    // Planned at version 1, then changed by someone else before the write.
    const { d1 } = counted(database, {
      beforeBatch: async () => {
        database
          .prepare(
            "UPDATE people SET display_name = ?, version = 2 WHERE id = ?",
          )
          .run("Synthetic Concurrent Name", person);
      },
    });
    const raced = await commitSyncChangesetD1(
      d1,
      principal,
      "set-raced",
      update(1),
      apply,
    );
    assert.equal(raced.status, "rejected");
    const row = database
      .prepare("SELECT display_name, version FROM people WHERE id = ?")
      .get(person);
    assert.deepEqual(
      { ...row },
      { display_name: "Synthetic Concurrent Name", version: 2 },
    );

    const fresh = await commitSyncChangesetD1(
      counted(database).d1,
      principal,
      "set-fresh",
      update(2),
      apply,
    );
    assert.equal(fresh.status, "committed", JSON.stringify(fresh.errors));
    assert.equal(fresh.items[0].outcome, "updated");
    assert.equal(fresh.items[0].version, 3);
  });
});

test("mixed references: existing IDs, missing IDs, reused and conflicting sources", async () => {
  await fixture(async (database, principal) => {
    const ids = await commitBase(database, principal);
    const base = referenceBaseChangeset();
    const existingSource = base.changes[0].fields;
    const request = {
      contractVersion: "m2-sync/v1",
      requestId: "8a3f5c10-0002-4d16-9a01-000000000002",
      intent: "dry_run",
      changes: [
        {
          op: "register_source",
          entity: "role_sources",
          clientRef: "same-source",
          fields: { ...existingSource },
        },
        {
          op: "create_person",
          entity: "people",
          clientRef: "new-person",
          fields: { display_name: "Synthetic New Person" },
        },
        {
          op: "create_person_role",
          entity: "person_roles",
          clientRef: "role-existing",
          fields: {
            person_id: ids.get("person-2"),
            source_ref: "same-source",
            county_fips: "08001",
            published_office: "Synthetic Office A",
            source_checked_at: "2026-11-12T12:00:00Z",
          },
        },
        {
          op: "create_person_role",
          entity: "person_roles",
          clientRef: "role-missing",
          fields: {
            person_id: "00000000-0000-4000-8000-00000000dead",
            source_id: ids.get("source-1"),
            county_fips: "08001",
            published_office: "Synthetic Office B",
            source_checked_at: "2026-11-12T12:00:00Z",
          },
        },
        {
          op: "create_person_role",
          entity: "person_roles",
          clientRef: "role-unknown-county",
          fields: {
            person_ref: "new-person",
            source_id: ids.get("source-1"),
            county_fips: "08999",
            published_office: "Synthetic Office C",
            source_checked_at: "2026-11-12T12:00:00Z",
          },
        },
      ],
    };
    const d1Plan = await planSyncChangesetD1(
      counted(database).d1,
      request,
      now,
    );
    assert.deepEqual(d1Plan, planSyncChangeset(database, request, now));
    assert.equal(d1Plan.items[0].action, "would_reuse");
    assert.equal(d1Plan.items[0].websiteId, ids.get("source-0"));
    const codes = d1Plan.errors.map((e) => `${e.itemIndex}:${e.code}`);
    assert.ok(codes.includes("3:invalid_reference"), codes.join());
    assert.ok(codes.includes("4:unknown_county"), codes.join());

    const conflicting = structuredClone(request);
    conflicting.changes = [
      {
        ...request.changes[0],
        fields: { ...existingSource, title: "Synthetic Different Title" },
      },
    ];
    const conflict = await planSyncChangesetD1(
      counted(database).d1,
      conflicting,
      now,
    );
    assert.deepEqual(conflict, planSyncChangeset(database, conflicting, now));
    assert.ok(
      conflict.errors.some((e) => e.code === "source_metadata_conflict"),
    );
  });
});

test("replay, lookup and reversal of an 816-operation atomic batch", async () => {
  await fixture(async (database, principal) => {
    const committed = await commitSyncChangesetD1(
      counted(database).d1,
      principal,
      "set-replay",
      mixedChangeset(),
      apply,
    );
    assert.equal(
      committed.status,
      "committed",
      JSON.stringify(committed.errors),
    );
    const after = counts(database);
    assert.deepEqual(after, {
      organizations: 3,
      positions: 8,
      role_sources: 40,
      people: 262,
      person_roles: 503,
      sync_batches: 1,
    });

    const replay = counted(database);
    const again = await commitSyncChangesetD1(
      replay.d1,
      principal,
      "set-replay",
      mixedChangeset(),
      apply,
    );
    assert.equal(again.replayed, true);
    assert.equal(again.batchId, committed.batchId);
    assert.ok(replay.total() <= 5, `replay used ${replay.total()} calls`);
    assert.deepEqual(counts(database), after);

    const lookup = await lookupSyncBatchD1(counted(database).d1, principal, {
      batchId: committed.batchId,
    });
    assert.equal(lookup.status, "committed");
    assert.equal(lookup.items.length, 816);

    const reversed = await reverseSyncBatchD1(
      counted(database).d1,
      principal,
      committed.batchId,
      "set-replay-revert",
      revert,
    );
    assert.equal(reversed.status, "reverted", JSON.stringify(reversed));
    assert.deepEqual(counts(database), {
      organizations: 0,
      positions: 0,
      role_sources: 0,
      people: 0,
      person_roles: 0,
      sync_batches: 1,
    });
  });
});

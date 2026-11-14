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
import { reverseSyncBatchD1 } from "../dist/services/sync-revert-d1.js";

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
const allowRevert = async (_principal, capability) =>
  capability === "sync.revert";

async function commitReversibleBatch(database, d1, principal, key) {
  database
    .prepare(
      "INSERT OR IGNORE INTO people (id, display_name) VALUES ('existing-person', 'Synthetic Existing Person')",
    )
    .run();
  const committed = await commitSyncChangesetD1(
    d1,
    principal,
    key,
    {
      ...completeChangeset(),
      duplicateFlags: [
        {
          targetType: "person",
          targetRef: "person",
          possibleDuplicateOf: "existing-person",
          category: "possible_match",
          reason: `Synthetic observation for ${key}`,
          evidenceSourceRefs: ["source"],
          nonblocking: true,
        },
      ],
    },
    { authorize: allowSynthetic, now },
  );
  assert.equal(committed.status, "committed");
  return committed;
}

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

test("D1 reversal atomically reverses a dependent batch and replays by key", async () => {
  await fixture(async (database, d1, principal) => {
    const committed = await commitSyncChangesetD1(
      d1,
      principal,
      "reversal-commit-key",
      completeChangeset(),
      { authorize: allowSynthetic, now },
    );
    assert.equal(committed.status, "committed");
    if (committed.status !== "committed") return;
    const authorize = async (_principal, capability) =>
      capability === "sync.revert";
    const reversed = await reverseSyncBatchD1(
      d1,
      principal,
      committed.batchId,
      "reversal-key",
      { authorize, now },
    );
    assert.equal(reversed.status, "reverted");
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_batch_items WHERE batch_id = ?",
        )
        .get(committed.batchId).count,
      6,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM organizations WHERE id <> 'org-race'",
        )
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM people WHERE id <> 'existing-person'",
        )
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sync.batch.reverse'",
        )
        .get().count,
      1,
    );
    const replay = await reverseSyncBatchD1(
      d1,
      principal,
      committed.batchId,
      "reversal-key",
      { authorize, now },
    );
    assert.equal(replay.status, "reverted");
    if (replay.status === "reverted") assert.equal(replay.replayed, true);
    const anotherKey = await reverseSyncBatchD1(
      d1,
      principal,
      committed.batchId,
      "reversal-key-two",
      { authorize, now },
    );
    assert.equal(anotherKey.status, "already_reverted");
  });
});

test("D1 reversal rolls back early, middle, and final statement failures", async () => {
  await fixture(async (database, d1, principal) => {
    const failurePoints = [
      ["early", "person_roles", "DELETE"],
      ["middle", "positions", "DELETE"],
      ["final", "audit_events", "INSERT"],
    ];
    for (const [name, table, operation] of failurePoints) {
      const batch = await commitReversibleBatch(
        database,
        d1,
        principal,
        `reversal-failure-commit-${name}`,
      );
      if (batch.status !== "committed") continue;
      database.exec(
        operation === "DELETE"
          ? `CREATE TRIGGER reversal_${name}_failure BEFORE DELETE ON ${table}
             BEGIN SELECT RAISE(ABORT, 'synthetic reversal ${name} failure'); END`
          : `CREATE TRIGGER reversal_${name}_failure BEFORE INSERT ON ${table}
             WHEN NEW.action = 'sync.batch.reverse'
             BEGIN SELECT RAISE(ABORT, 'synthetic reversal ${name} failure'); END`,
      );
      const result = await reverseSyncBatchD1(
        d1,
        principal,
        batch.batchId,
        `reversal-failure-key-${name}`,
        { authorize: allowRevert, now },
      );
      assert.equal(result.status, "reversal_blocked", name);
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_batch_reversals WHERE batch_id = ?",
          )
          .get(batch.batchId).count,
        0,
        `${name}: no receipt`,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sync.batch.reverse'",
          )
          .get().count,
        0,
        `${name}: no audit`,
      );
      for (const item of batch.items) {
        const row = database
          .prepare(`SELECT id FROM "${item.entity}" WHERE id = ?`)
          .get(item.websiteId);
        assert.ok(row, `${name}: ${item.entity} remains`);
      }
      database.exec(`DROP TRIGGER reversal_${name}_failure`);
    }
  });
});

test("concurrent reversals elect one winner and incompatible keys fail closed", async () => {
  await fixture(async (database, d1, principal) => {
    const batch = await commitReversibleBatch(
      database,
      d1,
      principal,
      "parallel-revert-commit",
    );
    if (batch.status !== "committed") return;
    const [left, right] = await Promise.all([
      reverseSyncBatchD1(d1, principal, batch.batchId, "parallel-revert-left", {
        authorize: allowRevert,
        now,
      }),
      reverseSyncBatchD1(
        d1,
        principal,
        batch.batchId,
        "parallel-revert-right",
        { authorize: allowRevert, now },
      ),
    ]);
    assert.equal(
      [left, right].filter((result) => result.status === "reverted").length,
      1,
    );
    assert.equal(
      [left, right].filter((result) => result.status !== "reverted").length,
      1,
    );
    const winningKey =
      left.status === "reverted"
        ? "parallel-revert-left"
        : "parallel-revert-right";
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_batch_reversals WHERE batch_id = ?",
        )
        .get(batch.batchId).count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sync.batch.reverse'",
        )
        .get().count,
      1,
    );

    const other = await commitReversibleBatch(
      database,
      d1,
      principal,
      "parallel-revert-other-commit",
    );
    if (other.status !== "committed") return;
    const conflict = await reverseSyncBatchD1(
      d1,
      principal,
      other.batchId,
      winningKey,
      { authorize: allowRevert, now },
    );
    assert.equal(conflict.status, "reversal_blocked");
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_batch_reversals WHERE batch_id = ?",
        )
        .get(other.batchId).count,
      0,
    );
  });
});

test("reversal blocks stale generations, changed versions, cross-actor access, and revoked principals", async () => {
  await fixture(async (database, d1, principal) => {
    const staleGeneration = await commitReversibleBatch(
      database,
      d1,
      principal,
      "stale-generation-commit",
    );
    if (staleGeneration.status !== "committed") return;
    const originalGuard = d1.guardedBatch.bind(d1);
    d1.guardedBatch = async (...args) => {
      database
        .prepare("UPDATE organizations SET name = name WHERE id = 'org-race'")
        .run();
      return originalGuard(...args);
    };
    const generationResult = await reverseSyncBatchD1(
      d1,
      principal,
      staleGeneration.batchId,
      "stale-generation-key",
      { authorize: allowRevert, now },
    );
    assert.equal(generationResult.status, "reversal_blocked");
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sync_batch_reversals")
        .get().count,
      0,
    );
    d1.guardedBatch = originalGuard;

    const changed = await commitReversibleBatch(
      database,
      d1,
      principal,
      "changed-row-commit",
    );
    if (changed.status !== "committed") return;
    const person = changed.items.find((item) => item.entity === "people");
    assert.ok(person);
    database
      .prepare(
        "UPDATE people SET display_name = 'Synthetic later update', version = version + 1 WHERE id = ?",
      )
      .run(person.websiteId);
    const changedResult = await reverseSyncBatchD1(
      d1,
      principal,
      changed.batchId,
      "changed-row-key",
      { authorize: allowRevert, now },
    );
    assert.equal(changedResult.status, "reversal_blocked");

    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('other-actor', 'human', 'owner', 'Synthetic Other');
      INSERT INTO identities (id, account_id, provider, subject) VALUES ('other-identity', 'other-actor', 'test-human', 'other');
    `);
    const foreignPrincipal = {
      ...principal,
      accountId: "other-actor",
      identityId: "other-identity",
    };
    const crossActor = await reverseSyncBatchD1(
      d1,
      foreignPrincipal,
      changed.batchId,
      "cross-actor-key",
      { authorize: allowRevert, now },
    );
    assert.equal(crossActor.status, "reversal_blocked");

    database
      .prepare(
        "UPDATE identities SET revoked_at = ?, version = version + 1 WHERE id = ?",
      )
      .run(now().toISOString(), principal.identityId);
    await assert.rejects(
      reverseSyncBatchD1(d1, principal, changed.batchId, "revoked-key", {
        authorize: allowRevert,
        now,
      }),
      /cannot reverse synchronization/,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sync_batch_reversals")
        .get().count,
      0,
    );
  });
});

test("missing, corrupted, and conflicting inverse metadata block reversal without receipts", async () => {
  await fixture(async (database, d1, principal) => {
    for (const [key, corruption] of [
      ["inverse-missing", "missing"],
      ["inverse-corrupt", "{}"],
      [
        "inverse-conflict",
        JSON.stringify({ itemIndex: 0, entity: "people", targetId: "wrong" }),
      ],
    ]) {
      const batch = await commitReversibleBatch(
        database,
        d1,
        principal,
        `${key}-commit`,
      );
      if (batch.status !== "committed") continue;
      const item = database
        .prepare(
          "SELECT item_index FROM sync_batch_items WHERE batch_id = ? ORDER BY item_index LIMIT 1",
        )
        .get(batch.batchId);
      if (corruption === "missing") {
        database
          .prepare(
            "DELETE FROM sync_batch_items WHERE batch_id = ? AND item_index = ?",
          )
          .run(batch.batchId, item.item_index);
      } else {
        database
          .prepare(
            "UPDATE sync_batch_items SET inverse_json = ? WHERE batch_id = ? AND item_index = ?",
          )
          .run(corruption, batch.batchId, item.item_index);
      }
      const result = await reverseSyncBatchD1(
        d1,
        principal,
        batch.batchId,
        `${key}-key`,
        { authorize: allowRevert, now },
      );
      assert.equal(result.status, "reversal_blocked");
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_batch_reversals WHERE batch_id = ?",
          )
          .get(batch.batchId).count,
        0,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sync.batch.reverse'",
          )
          .get().count,
        0,
      );
    }
  });
});

test("external dependents, duplicate-flag decisions, and later observations block reversal", async () => {
  await fixture(async (database, d1, principal) => {
    const external = await commitReversibleBatch(
      database,
      d1,
      principal,
      "external-dependent-commit",
    );
    if (external.status !== "committed") return;
    const org = external.items.find((item) => item.entity === "organizations");
    assert.ok(org);
    database
      .prepare(
        "INSERT INTO positions (id, organization_id, title) VALUES ('outside-position', ?, 'Synthetic outside dependent')",
      )
      .run(org.websiteId);
    const dependentResult = await reverseSyncBatchD1(
      d1,
      principal,
      external.batchId,
      "external-dependent-key",
      { authorize: allowRevert, now },
    );
    assert.equal(dependentResult.status, "reversal_blocked");
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sync_batch_reversals")
        .get().count,
      0,
    );

    const decided = await commitReversibleBatch(
      database,
      d1,
      principal,
      "decided-flag-commit",
    );
    if (decided.status !== "committed") return;
    database
      .prepare(
        "UPDATE person_duplicate_flags SET status = 'dismissed', version = version + 1 WHERE origin_batch_id = ?",
      )
      .run(decided.batchId);
    const decidedResult = await reverseSyncBatchD1(
      d1,
      principal,
      decided.batchId,
      "decided-flag-key",
      { authorize: allowRevert, now },
    );
    assert.equal(decidedResult.status, "reversal_blocked");

    const later = await commitReversibleBatch(
      database,
      d1,
      principal,
      "later-observation-commit",
    );
    if (later.status !== "committed") return;
    const flag = database
      .prepare("SELECT * FROM person_duplicate_flags WHERE origin_batch_id = ?")
      .get(later.batchId);
    assert.ok(flag);
    database
      .prepare(`INSERT INTO sync_batches
      (id, actor_account_id, idempotency_key, request_fingerprint, contract_version, request_id, status, committed_at, result_json)
      VALUES ('later-observation-batch', ?, 'later-observation-key', ?, 'm2-sync/v1', 'later-observation-request', 'committed', ?, '{}')`)
      .run(principal.accountId, "a".repeat(64), now().toISOString());
    database
      .prepare(`INSERT INTO person_duplicate_flag_observations
      (id, duplicate_flag_id, pair_low_id, pair_high_id, batch_id, actor_account_id, report_position, reason, evidence_source_ids_json, observed_at)
      VALUES ('later-observation', ?, ?, ?, 'later-observation-batch', ?, 0, 'Synthetic later report', '[]', ?)`)
      .run(
        flag.id,
        flag.pair_low_id,
        flag.pair_high_id,
        principal.accountId,
        now().toISOString(),
      );
    const laterResult = await reverseSyncBatchD1(
      d1,
      principal,
      later.batchId,
      "later-observation-reversal-key",
      { authorize: allowRevert, now },
    );
    assert.equal(laterResult.status, "reversal_blocked");
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sync_batch_reversals")
        .get().count,
      0,
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

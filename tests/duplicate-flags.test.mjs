import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  getDuplicateFlag,
  listDuplicateFlags,
  transitionDuplicateFlag,
} from "../dist/services/duplicate-flags.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangeset } from "../dist/services/sync-commit.js";
import { reverseSyncBatch } from "../dist/services/sync-history.js";

const now = () => new Date("2026-11-13T12:00:00.000Z");
let counter = 0;
const uuid = () =>
  `6b5f57a2-84b7-4a4d-b300-${String(++counter).padStart(12, "0")}`;
const person = (clientRef, display_name = "Pat Example") => ({
  op: "create_person",
  entity: "people",
  clientRef,
  fields: { display_name },
});
const source = (clientRef, url = `https://example.invalid/${clientRef}`) => ({
  op: "register_source",
  entity: "role_sources",
  clientRef,
  fields: {
    url,
    title: `Synthetic ${clientRef}`,
    source_type: "official_page",
  },
});
const flag = (targetRef, possibleDuplicateOf, extra = {}) => ({
  targetType: "person",
  targetRef,
  possibleDuplicateOf,
  category: "possible_match",
  reason: "possible match; name alone is not identity evidence",
  nonblocking: true,
  ...extra,
});
const request = (changes, duplicateFlags) => ({
  contractVersion: "m2-sync/v1",
  requestId: uuid(),
  intent: "commit",
  changes,
  ...(duplicateFlags ? { duplicateFlags } : {}),
});
const idOf = (result, clientRef) =>
  result.items.find((item) => item.clientRef === clientRef).websiteId;
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

async function fixture(callback) {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-m2e-"));
  const path = join(dir, "website.sqlite");
  let db = await openWebsiteDatabase(path);
  migrateWebsiteDatabase(db);
  db.exec(`INSERT INTO accounts (id,kind,role,display_name,preferences) VALUES ('owner-a','human','owner','Synthetic Owner','{}'),('owner-b','human','owner','Synthetic Other','{}');
    INSERT INTO identities (id,account_id,provider,subject) VALUES ('identity-a','owner-a','test-human','subject-a'),('identity-b','owner-b','test-human','subject-b');`);
  const adapter = createTestHumanIdentityAdapter({
    a: "subject-a",
    b: "subject-b",
  });
  const principal = (who = "a") =>
    resolvePrincipal(
      db,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": who },
      }),
      adapter,
    );
  const commit = async (key, req, who = "a") =>
    commitSyncChangeset(db, await principal(who), key, req, now);
  try {
    await callback({
      get db() {
        return db;
      },
      principal,
      commit,
      reopen: async () => {
        db.close();
        db = await openWebsiteDatabase(path);
        migrateWebsiteDatabase(db);
      },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seeds one existing person and returns its Website ID. */
async function seed(f) {
  const first = await f.commit("seed", request([person("seed-person")]));
  assert.equal(first.status, "committed");
  return idOf(first, "seed-person");
}

test("flags persist with resolved IDs, batch linkage, evidence and audit, and never merge people", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const committed = await f.commit(
      "k1",
      request(
        [person("new-person"), source("evidence")],
        [flag("new-person", existing, { evidenceSourceRefs: ["evidence"] })],
      ),
    );
    assert.equal(committed.status, "committed");
    const newId = idOf(committed, "new-person");
    const sourceId = idOf(committed, "evidence");
    const owner = await f.principal();
    const flags = listDuplicateFlags(f.db, owner);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].personId, newId);
    assert.equal(flags[0].possibleDuplicateOfPersonId, existing);
    assert.deepEqual(flags[0].evidenceSourceIds, [sourceId]);
    assert.equal(flags[0].originBatchId, committed.batchId);
    assert.equal(flags[0].status, "open");
    assert.equal(flags[0].version, 1);
    assert.equal(flags[0].statusChangedByAccountId, "owner-a");
    // Identical display names: both people remain distinct and untouched.
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 2);
    assert.equal(
      count(
        f.db,
        "SELECT count(*) AS n FROM people WHERE display_name = 'Pat Example'",
      ),
      2,
    );
    const audit = f.db
      .prepare(
        "SELECT actor_account_id, details_json FROM audit_events WHERE action = 'duplicate_flag.create'",
      )
      .all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_account_id, "owner-a");
    const commitAudit = f.db
      .prepare(
        "SELECT details_json FROM audit_events WHERE action = 'sync.batch.commit' AND target_id = ?",
      )
      .get(committed.batchId);
    assert.equal(JSON.parse(commitAudit.details_json).duplicateFlagsCreated, 1);

    await f.reopen();
    const again = listDuplicateFlags(f.db, await f.principal());
    assert.deepEqual(again, flags);
  });
});

test("identical names without an explicit flag never create a flag or match", async () => {
  await fixture(async (f) => {
    await seed(f);
    const committed = await f.commit("same-name", request([person("twin")]));
    assert.equal(committed.status, "committed");
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      0,
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 2);
  });
});

test("exact replay creates no flags and does not reopen a dismissed flag", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const req = request([person("p")], [flag("p", existing)]);
    const first = await f.commit("replay", req);
    assert.equal(first.status, "committed");
    const owner = await f.principal();
    const [created] = listDuplicateFlags(f.db, owner);
    const dismissed = transitionDuplicateFlag(
      f.db,
      owner,
      { flagId: created.id, expectedVersion: 1, toStatus: "dismissed" },
      now,
    );
    assert.equal(dismissed.status, "transitioned");
    const replay = await f.commit("replay", req);
    assert.equal(replay.status, "committed");
    assert.equal(replay.replayed, true);
    assert.equal(replay.batchId, first.batchId);
    await f.reopen();
    const flags = listDuplicateFlags(f.db, await f.principal());
    assert.equal(flags.length, 1);
    assert.equal(flags[0].status, "dismissed");
    assert.equal(flags[0].version, 2);
  });
});

test("a later report of the same pair, in either order, never overrides a decision", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const first = await f.commit(
      "a",
      request([person("p")], [flag("p", existing)]),
    );
    const newId = idOf(first, "p");
    const owner = await f.principal();
    const [created] = listDuplicateFlags(f.db, owner);
    transitionDuplicateFlag(
      f.db,
      owner,
      { flagId: created.id, expectedVersion: 1, toStatus: "resolved" },
      now,
    );
    const again = await f.commit(
      "b",
      request([source("s")], [flag(existing, newId), flag(newId, existing)]),
    );
    assert.equal(again.status, "committed");
    const flags = listDuplicateFlags(f.db, owner);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].status, "resolved");
    assert.equal(flags[0].originBatchId, first.batchId);
    const details = f.db
      .prepare(
        "SELECT details_json FROM audit_events WHERE action = 'sync.batch.commit' AND target_id = ?",
      )
      .get(again.batchId);
    assert.equal(JSON.parse(details.details_json).duplicateFlagsExisting, 2);
  });
});

test("lifecycle transitions are attributed, version checked and audited", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    await f.commit("k", request([person("p")], [flag("p", existing)]));
    const owner = await f.principal();
    const [created] = listDuplicateFlags(f.db, owner);
    const move = (expectedVersion, toStatus) =>
      transitionDuplicateFlag(
        f.db,
        owner,
        { flagId: created.id, expectedVersion, toStatus },
        now,
      );
    const dismissed = move(1, "dismissed");
    assert.equal(dismissed.status, "transitioned");
    assert.equal(dismissed.flag.version, 2);
    assert.equal(dismissed.flag.status, "dismissed");
    assert.deepEqual(move(1, "resolved"), {
      status: "stale_version",
      currentVersion: 2,
    });
    assert.deepEqual(move(2, "dismissed"), { status: "invalid_transition" });
    assert.deepEqual(move(0, "open"), { status: "invalid_request" });
    assert.deepEqual(move(2, "closed"), { status: "invalid_request" });
    assert.equal(move(2, "open").status, "transitioned");
    assert.equal(move(3, "resolved").flag.version, 4);
    assert.equal(getDuplicateFlag(f.db, owner, created.id).status, "resolved");
    const audit = f.db
      .prepare(
        "SELECT actor_account_id, details_json FROM audit_events WHERE action = 'duplicate_flag.transition' ORDER BY created_at, rowid",
      )
      .all();
    assert.equal(audit.length, 3);
    assert.ok(audit.every((row) => row.actor_account_id === "owner-a"));
    assert.deepEqual(
      audit.map((row) => JSON.parse(row.details_json).to),
      ["dismissed", "open", "resolved"],
    );
    // Both people are unchanged by any lifecycle change.
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 2);
  });
});

test("flags are not visible or changeable across accounts", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    await f.commit("k", request([person("p")], [flag("p", existing)]));
    const [created] = listDuplicateFlags(f.db, await f.principal());
    const other = await f.principal("b");
    assert.equal(getDuplicateFlag(f.db, other, created.id), null);
    assert.deepEqual(listDuplicateFlags(f.db, other), []);
    assert.deepEqual(
      transitionDuplicateFlag(
        f.db,
        other,
        { flagId: created.id, expectedVersion: 1, toStatus: "dismissed" },
        now,
      ),
      { status: "not_found" },
    );
    assert.equal(
      getDuplicateFlag(f.db, await f.principal(), created.id).status,
      "open",
    );
  });
});

test("a late failure rolls back flags with the whole batch and does not consume the key", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const req = request([person("p")], [flag("p", existing)]);
    f.db.exec(`CREATE TRIGGER fail_commit_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'sync.batch.commit' AND json_extract(NEW.details_json, '$.duplicateFlagsCreated') = 1
      BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END;`);
    const failed = await f.commit("rollback", req);
    assert.equal(failed.status, "rejected");
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      0,
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 1);
    assert.equal(
      count(
        f.db,
        "SELECT count(*) AS n FROM audit_events WHERE action = 'duplicate_flag.create'",
      ),
      0,
    );
    f.db.exec("DROP TRIGGER fail_commit_audit");
    const retried = await f.commit("rollback", req);
    assert.equal(retried.status, "committed");
    assert.equal(retried.replayed, false);
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      1,
    );
  });
});

test("malformed flags follow the accepted contract while valid advisory flags never block", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const rejects = async (label, flags, code = "duplicate_flag_invalid") => {
      const result = await f.commit(
        `bad-${label}`,
        request([person("p")], flags),
      );
      assert.equal(result.status, "rejected", label);
      assert.equal(result.errors[0].code, code, label);
    };
    await rejects("category", [
      flag("p", existing, { category: "same_person" }),
    ]);
    await rejects("blocking", [flag("p", existing, { nonblocking: false })]);
    await rejects("unknown", [flag("p", "missing-person")]);
    await rejects("self", [flag(existing, existing)]);
    await rejects("extra-key", [flag("p", existing, { merge: true })]);
    await rejects("evidence", [
      flag("p", existing, { evidenceSourceRefs: ["nope"] }),
    ]);
    await rejects(
      "too-many",
      Array.from({ length: 21 }, () => flag("p", existing)),
      "too_many_duplicate_flags",
    );
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      0,
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 1);
    // A clean changeset commits identically with or without an advisory flag.
    const ok = await f.commit(
      "ok",
      request([person("p")], [flag("p", existing)]),
    );
    assert.equal(ok.status, "committed");
    assert.equal(ok.items.length, 1);
  });
});

test("reversal removes open flags, writes audit evidence and leaves no orphans", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const committed = await f.commit(
      "k",
      request(
        [person("p"), source("s")],
        [flag("p", existing, { evidenceSourceRefs: ["s"] })],
      ),
    );
    const owner = await f.principal();
    const reversed = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "rev",
      now,
    );
    assert.equal(reversed.status, "reverted");
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      0,
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 1);
    assert.equal(
      count(
        f.db,
        "SELECT count(*) AS n FROM audit_events WHERE action = 'duplicate_flag.remove'",
      ),
      1,
    );
    const reverseAudit = f.db
      .prepare(
        "SELECT details_json FROM audit_events WHERE action = 'sync.batch.reverse'",
      )
      .get();
    assert.equal(JSON.parse(reverseAudit.details_json).flagsRemoved, 1);
  });
});

test("reversal is blocked, with no partial change, when a human decision was recorded", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const committed = await f.commit(
      "k",
      request([person("p")], [flag("p", existing)]),
    );
    const owner = await f.principal();
    const [created] = listDuplicateFlags(f.db, owner);
    transitionDuplicateFlag(
      f.db,
      owner,
      { flagId: created.id, expectedVersion: 1, toStatus: "dismissed" },
      now,
    );
    const blocked = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "r1",
      now,
    );
    assert.equal(blocked.status, "reversal_blocked");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 2);
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      1,
    );
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM sync_batch_reversals"),
      0,
    );
    // Deliberately reopening the flag makes the batch reversible again.
    transitionDuplicateFlag(
      f.db,
      owner,
      { flagId: created.id, expectedVersion: 2, toStatus: "open" },
      now,
    );
    const reversed = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "r2",
      now,
    );
    assert.equal(reversed.status, "reverted");
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      0,
    );
  });
});

test("reversal is blocked while a later batch's flag references a person or source it created", async () => {
  await fixture(async (f) => {
    const first = await f.commit(
      "first",
      request([person("p1"), source("s1")]),
    );
    const p1 = idOf(first, "p1");
    const s1 = idOf(first, "s1");
    const second = await f.commit(
      "second",
      request([person("p2")], [flag("p2", p1, { evidenceSourceRefs: [s1] })]),
    );
    assert.equal(second.status, "committed");
    const owner = await f.principal();
    const blocked = await reverseSyncBatch(
      f.db,
      owner,
      first.batchId,
      "r1",
      now,
    );
    assert.equal(blocked.status, "reversal_blocked");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 2);
    assert.equal(
      count(f.db, "SELECT count(*) AS n FROM person_duplicate_flags"),
      1,
    );
    // Reversing the later batch first clears the dependency.
    assert.equal(
      (await reverseSyncBatch(f.db, owner, second.batchId, "r2", now)).status,
      "reverted",
    );
    assert.equal(
      (await reverseSyncBatch(f.db, owner, first.batchId, "r3", now)).status,
      "reverted",
    );
    assert.equal(count(f.db, "SELECT count(*) AS n FROM people"), 0);
  });
});

test("a source-only dependency from a later flag also blocks reversal", async () => {
  await fixture(async (f) => {
    const existing = await seed(f);
    const first = await f.commit("first", request([source("s1")]));
    const s1 = idOf(first, "s1");
    await f.commit(
      "second",
      request(
        [person("p")],
        [flag("p", existing, { evidenceSourceRefs: [s1] })],
      ),
    );
    const blocked = await reverseSyncBatch(
      f.db,
      await f.principal(),
      first.batchId,
      "r1",
      now,
    );
    assert.equal(blocked.status, "reversal_blocked");
    assert.equal(count(f.db, "SELECT count(*) AS n FROM role_sources"), 1);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_TIME, freshDb, insertAccount } from "./helpers.ts";

const CHECK = /CHECK constraint failed/;
const FOREIGN_KEY = /FOREIGN KEY constraint failed/;

test("foreign keys are enforced", async () => {
  const db = freshDb();
  await assert.rejects(
    db.run(
      "INSERT INTO identities (id, account_id, provider, subject, created_at, updated_at) VALUES ('idn-1', 'missing-account', 'sites', 'subject-1', ?, ?)",
      [FIXED_TIME, FIXED_TIME],
    ),
    FOREIGN_KEY,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO audit_events (id, at, account_id, action) VALUES ('aud-1', ?, 'missing-account', 'test.action')",
      [FIXED_TIME],
    ),
    FOREIGN_KEY,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO audit_events (id, at, action, operation_id) VALUES ('aud-2', ?, 'test.action', 'missing-operation')",
      [FIXED_TIME],
    ),
    FOREIGN_KEY,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO operations (id, type, requested_by, created_at, updated_at) VALUES ('op-1', 'test', 'missing-account', ?, ?)",
      [FIXED_TIME, FIXED_TIME],
    ),
    FOREIGN_KEY,
  );
  db.close();
});

test("an account that identities refer to cannot be deleted", async () => {
  const db = freshDb();
  const accountId = await insertAccount(db);
  await db.run(
    "INSERT INTO identities (id, account_id, provider, subject, created_at, updated_at) VALUES ('idn-1', ?, 'sites', 'subject-1', ?, ?)",
    [accountId, FIXED_TIME, FIXED_TIME],
  );
  await assert.rejects(db.run("DELETE FROM accounts WHERE id = ?", [accountId]), FOREIGN_KEY);
  db.close();
});

test("enumerated values are enforced", async () => {
  const db = freshDb();
  await assert.rejects(insertAccount(db, { kind: "robot" }), CHECK);
  await assert.rejects(insertAccount(db, { role: "superuser" }), CHECK);
  await assert.rejects(insertAccount(db, { status: "pending" }), CHECK);
  const accountId = await insertAccount(db);
  await assert.rejects(
    db.run(
      "INSERT INTO identities (id, account_id, provider, subject, created_at, updated_at) VALUES ('idn-1', ?, 'password', 'subject-1', ?, ?)",
      [accountId, FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO operations (id, type, state, created_at, updated_at) VALUES ('op-1', 'test', 'paused', ?, ?)",
      [FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO operations (id, type, progress, created_at, updated_at) VALUES ('op-2', 'test', 101, ?, ?)",
      [FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO checkpoints (id, path, sha256, manifest, verify_result, created_at, updated_at) VALUES ('cp-1', 'synthetic/cp-1', ?, '{}', 'maybe', ?, ?)",
      ["a".repeat(64), FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  db.close();
});

test("JSON columns reject invalid JSON", async () => {
  const db = freshDb();
  await assert.rejects(insertAccount(db, { preferences: "{not json" }), CHECK);
  await assert.rejects(insertAccount(db, { preferences: "[]" }), CHECK);
  await assert.rejects(
    db.run(
      "INSERT INTO operations (id, type, params, created_at, updated_at) VALUES ('op-1', 'test', 'oops', ?, ?)",
      [FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO operations (id, type, result, created_at, updated_at) VALUES ('op-2', 'test', '{bad', ?, ?)",
      [FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  await assert.rejects(
    db.run("INSERT INTO audit_events (id, at, action, summary) VALUES ('aud-1', ?, 'test', 'x')", [
      FIXED_TIME,
    ]),
    CHECK,
  );
  await assert.rejects(
    db.run(
      "INSERT INTO checkpoints (id, path, sha256, manifest, created_at, updated_at) VALUES ('cp-1', 'synthetic/cp-1', ?, 'nope', ?, ?)",
      ["a".repeat(64), FIXED_TIME, FIXED_TIME],
    ),
    CHECK,
  );
  db.close();
});

test("checkpoint hashes must be 64 lowercase hexadecimal characters", async () => {
  const db = freshDb();
  for (const sha of ["abc", "A".repeat(64), "g".repeat(64)]) {
    await assert.rejects(
      db.run(
        "INSERT INTO checkpoints (id, path, sha256, manifest, created_at, updated_at) VALUES ('cp-1', 'synthetic/cp-1', ?, '{}', ?, ?)",
        [sha, FIXED_TIME, FIXED_TIME],
      ),
      CHECK,
      sha,
    );
  }
  db.close();
});

test("an identity subject is unique per provider", async () => {
  const db = freshDb();
  const accountId = await insertAccount(db);
  const insert = (id: string, provider: string) =>
    db.run(
      "INSERT INTO identities (id, account_id, provider, subject, created_at, updated_at) VALUES (?, ?, ?, 'same-subject', ?, ?)",
      [id, accountId, provider, FIXED_TIME, FIXED_TIME],
    );
  await insert("idn-1", "sites");
  await assert.rejects(insert("idn-2", "sites"), /UNIQUE constraint failed/);
  await insert("idn-3", "agent_key");
  db.close();
});

test("valid synthetic rows are accepted with their defaults", async () => {
  const db = freshDb();
  const accountId = await insertAccount(db, { id: "acct-synthetic-agent", kind: "agent" });
  const account = await db.first("SELECT status, preferences, version FROM accounts WHERE id = ?", [
    accountId,
  ]);
  assert.deepEqual({ ...account }, { status: "active", preferences: "{}", version: 1 });
  await db.run(
    "INSERT INTO operations (id, type, requested_by, created_at, updated_at) VALUES ('op-1', 'test', ?, ?, ?)",
    [accountId, FIXED_TIME, FIXED_TIME],
  );
  await db.run(
    "INSERT INTO audit_events (id, at, account_id, action, operation_id) VALUES ('aud-1', ?, ?, 'test.action', 'op-1')",
    [FIXED_TIME, accountId],
  );
  const operation = await db.first("SELECT state, params, progress, version FROM operations");
  assert.deepEqual({ ...operation }, { state: "pending", params: "{}", progress: 0, version: 1 });
  db.close();
});

test("a failed statement in a batch rolls back the whole batch", async () => {
  const db = freshDb();
  await assert.rejects(
    db.batch([
      {
        sql: "INSERT INTO operations (id, type, created_at, updated_at) VALUES ('op-1', 'test', ?, ?)",
        params: [FIXED_TIME, FIXED_TIME],
      },
      {
        sql: "INSERT INTO operations (id, type, state, created_at, updated_at) VALUES ('op-2', 'test', 'invalid', ?, ?)",
        params: [FIXED_TIME, FIXED_TIME],
      },
    ]),
    CHECK,
  );
  const row = await db.first<{ total: number }>("SELECT count(*) AS total FROM operations");
  assert.equal(row?.total, 0);
  db.close();
});

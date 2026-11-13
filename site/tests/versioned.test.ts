import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundError, StaleVersionError, updateVersioned } from "../src/db/versioned.ts";
import { FIXED_TIME, freshDb, insertAccount } from "./helpers.ts";

const LATER = "2026-01-02T00:00:00.000Z";

test("an update raises the version by exactly one and stamps updated_at", async () => {
  const db = freshDb();
  const id = await insertAccount(db);
  const next = await updateVersioned(db, {
    table: "accounts",
    id,
    expectedVersion: 1,
    changes: { display_name: "Renamed Synthetic Administrator" },
    now: LATER,
  });
  assert.equal(next, 2);
  const row = await db.first("SELECT display_name, version, created_at, updated_at FROM accounts");
  assert.deepEqual(
    { ...row },
    {
      display_name: "Renamed Synthetic Administrator",
      version: 2,
      created_at: FIXED_TIME,
      updated_at: LATER,
    },
  );
  db.close();
});

test("an update that quotes a stale version is rejected and changes nothing", async () => {
  const db = freshDb();
  const id = await insertAccount(db);
  await updateVersioned(db, {
    table: "accounts",
    id,
    expectedVersion: 1,
    changes: { role: "editor" },
    now: LATER,
  });
  await assert.rejects(
    updateVersioned(db, {
      table: "accounts",
      id,
      expectedVersion: 1,
      changes: { role: "owner" },
      now: LATER,
    }),
    StaleVersionError,
  );
  const row = await db.first("SELECT role, version FROM accounts");
  assert.deepEqual({ ...row }, { role: "editor", version: 2 });
  db.close();
});

test("updating a missing row reports not found", async () => {
  const db = freshDb();
  await assert.rejects(
    updateVersioned(db, {
      table: "accounts",
      id: "acct-missing",
      expectedVersion: 1,
      changes: { role: "editor" },
      now: LATER,
    }),
    NotFoundError,
  );
  db.close();
});

test("identity, version and timestamps cannot be set through the helper", async () => {
  const db = freshDb();
  const id = await insertAccount(db);
  for (const column of ["id", "version", "created_at", "kind"]) {
    await assert.rejects(
      updateVersioned(db, {
        table: "accounts",
        id,
        expectedVersion: 1,
        changes: { [column]: "x" },
        now: LATER,
      }),
      /cannot be updated/,
      column,
    );
  }
  await assert.rejects(
    updateVersioned(db, { table: "accounts", id, expectedVersion: 1, changes: {}, now: LATER }),
    /No changes supplied/,
  );
  db.close();
});

test("a versioned update that breaks a constraint is rejected and keeps the version", async () => {
  const db = freshDb();
  const id = await insertAccount(db);
  await assert.rejects(
    updateVersioned(db, {
      table: "accounts",
      id,
      expectedVersion: 1,
      changes: { role: "superuser" },
      now: LATER,
    }),
    /CHECK constraint failed/,
  );
  const row = await db.first("SELECT role, version FROM accounts");
  assert.deepEqual({ ...row }, { role: "administrator", version: 1 });
  db.close();
});

test("the convention applies to operations and checkpoints", async () => {
  const db = freshDb();
  await db.run(
    "INSERT INTO operations (id, type, created_at, updated_at) VALUES ('op-1', 'test', ?, ?)",
    [FIXED_TIME, FIXED_TIME],
  );
  assert.equal(
    await updateVersioned(db, {
      table: "operations",
      id: "op-1",
      expectedVersion: 1,
      changes: { state: "running", progress: 50 },
      now: LATER,
    }),
    2,
  );
  await db.run(
    "INSERT INTO checkpoints (id, path, sha256, manifest, created_at, updated_at) VALUES ('cp-1', 'synthetic/cp-1', ?, '{}', ?, ?)",
    ["0".repeat(64), FIXED_TIME, FIXED_TIME],
  );
  assert.equal(
    await updateVersioned(db, {
      table: "checkpoints",
      id: "cp-1",
      expectedVersion: 1,
      changes: { verified_at: LATER, verify_result: "passed" },
      now: LATER,
    }),
    2,
  );
  db.close();
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { canonicalJson } from "../dist/local/checkpoints/core.js";
import { createCheckpointService } from "../dist/local/checkpoints/lifecycle.js";
import { produceCheckpoint } from "../dist/local/checkpoints/producer.js";
import { createServices } from "../dist/services/index.js";
import {
  createAgentCredential,
  createTestHumanIdentityAdapter,
  hasCapability,
  resolvePrincipal,
} from "../dist/services/security.js";
import {
  COMMIT,
  createFixture,
  failAuditFor,
  OWNER,
  overwrite,
  SYNTHETIC_FILES,
  sha256,
  treeDigest,
} from "./checkpoint-fixtures.mjs";

const ID = "ckpt-synthetic-life-1";

function createService(fixture, overrides = {}) {
  return createCheckpointService({
    database: fixture.database,
    fileStore: fixture.fileStore,
    destination: fixture.destination,
    applicationCommit: COMMIT,
    scratchRoot: fixture.scratchRoot,
    ...overrides.dependencies,
  });
}

const all = (fixture, sql, ...parameters) =>
  fixture.database.prepare(sql).all(...parameters);
const checkpointRow = (fixture, id = ID) =>
  all(fixture, "SELECT * FROM checkpoints WHERE id = ?", id)[0];
const auditActions = (fixture) =>
  all(
    fixture,
    "SELECT action FROM audit_events WHERE target_type = 'checkpoint' ORDER BY rowid",
  ).map((row) => row.action);
const operations = (fixture, kind) =>
  all(
    fixture,
    "SELECT id, status, error_code, progress_json, finished_at, created_by_account_id FROM operations WHERE kind = ? ORDER BY rowid",
    kind,
  ).map((row) => ({ ...row, progress: JSON.parse(row.progress_json) }));

test("checkpoint entrypoints fail closed without an authorized principal", async (t) => {
  const fixture = await createFixture(t);
  const service = createService(fixture);
  const denied = { name: "AuthorizationError" };

  // An actor string, a forged object and a missing principal are all refused.
  const forged = {
    accountId: OWNER,
    kind: "human",
    role: "owner",
    provider: "test-human",
  };
  for (const principal of [
    OWNER,
    { accountId: OWNER },
    forged,
    null,
    undefined,
  ]) {
    await assert.rejects(
      service.create(principal, { checkpointId: ID }),
      denied,
    );
    await assert.rejects(service.verify(principal, ID), denied);
    await assert.rejects(service.reconcile(principal), denied);
    assert.throws(() => service.list(principal), denied);
    assert.throws(() => service.read(principal, ID), denied);
  }
  // A real principal whose role lacks the capability is refused too.
  assert.equal(fixture.contributor.accountId, "acct-synthetic-contributor");
  await assert.rejects(service.create(fixture.contributor), denied);
  await assert.rejects(service.verify(fixture.contributor, ID), denied);
  assert.throws(() => service.list(fixture.contributor), denied);
  // A principal whose account is later disabled loses access immediately.
  fixture.database.exec(
    "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'acct-synthetic-contributor'",
  );
  await assert.rejects(service.reconcile(fixture.contributor), denied);

  // Nobody can prune, including the owner.
  await assert.rejects(service.prune(fixture.owner), {
    code: "prune_disabled",
  });

  assert.deepEqual(await fixture.destination.list(), []);
  assert.equal(all(fixture, "SELECT id FROM audit_events").length, 1);
  assert.equal(all(fixture, "SELECT id FROM operations").length, 1);
  assert.equal(all(fixture, "SELECT id FROM checkpoints").length, 0);

  // The shared service layer exposes checkpoints only when a host injects them.
  assert.throws(
    () => createServices({ database: fixture.database }).checkpoints(),
    {
      name: "StorageUnavailableError",
    },
  );
  const services = createServices({
    database: fixture.database,
    checkpoints: service,
  });
  assert.deepEqual(services.checkpoints().list(fixture.owner), []);
});

test("a created checkpoint is recorded as published but unverified", async (t) => {
  const fixture = await createFixture(t);
  const service = createService(fixture);
  const record = await service.create(fixture.owner, { checkpointId: ID });

  assert.equal(record.verificationStatus, "pending");
  assert.equal(record.verifiedAt, null);
  assert.equal(record.applicationCommit, COMMIT);
  assert.equal(record.migrationVersion, 10);
  const row = checkpointRow(fixture);
  assert.equal(row.verification_json, "{}");
  assert.equal(sha256(row.manifest_json), row.manifest_sha256);
  assert.equal(JSON.parse(row.manifest_json).checkpoint_id, ID);

  const [operation] = operations(fixture, "checkpoint.create");
  assert.equal(operation.id, record.operationId);
  assert.equal(operation.status, "succeeded");
  assert.equal(operation.created_by_account_id, OWNER);
  assert.deepEqual(operation.progress, {
    checkpoint_id: ID,
    phase: "published",
    manifest_sha256: row.manifest_sha256,
    verification: "pending",
  });

  const audit = all(
    fixture,
    "SELECT * FROM audit_events WHERE target_id = ?",
    ID,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "checkpoint.created");
  assert.equal(audit[0].actor_account_id, OWNER);
  assert.match(audit[0].summary, /verification pending/i);
  assert.equal(
    JSON.parse(audit[0].details_json).verification_status,
    "pending",
  );
  assert.deepEqual(
    service.list(fixture.owner).map((item) => item.id),
    [ID],
  );

  // The snapshot holds the in-flight operation as running, never as done.
  const generated = await service.create(fixture.owner);
  assert.match(generated.id, /^ckpt-\d{8}t\d{6}z-[0-9a-f]{16}$/);
});

test("verification records a verdict only after a completed restore", async (t) => {
  const fixture = await createFixture(t);
  const service = createService(fixture);
  await service.create(fixture.owner, { checkpointId: ID });

  const first = await service.verify(fixture.owner, ID);
  assert.equal(first.report.ok, true);
  assert.equal(first.record.verificationStatus, "verified");
  assert.equal(first.record.verifiedAt, first.report.finished_at);
  assert.equal(first.record.version, 2);

  // Repeating verification re-runs the restore and records the new verdict.
  const second = await service.verify(fixture.owner, ID);
  assert.equal(second.record.verificationStatus, "verified");
  assert.equal(second.record.version, 3);
  assert.deepEqual(second.report.restored, first.report.restored);
  assert.deepEqual(auditActions(fixture), [
    "checkpoint.created",
    "checkpoint.verified",
    "checkpoint.verified",
  ]);

  // Later corruption turns a verified checkpoint into a failed one.
  const digest = sha256(SYNTHETIC_FILES["reports/alpha.txt"]);
  overwrite(
    fixture.bundlePath(ID, "files", digest),
    "synthetic report alphA\n",
  );
  const third = await service.verify(fixture.owner, ID);
  assert.equal(third.report.ok, false);
  assert.equal(third.record.verificationStatus, "failed");
  assert.equal(third.record.verifiedAt, null);
  assert.match(third.report.failures[0].detail, /reports\/alpha\.txt/);
  const stored = service.read(fixture.owner, ID).verification;
  assert.equal(stored.ok, false);
  assert.equal(stored.failures[0].code, "member_digest_mismatch");
  assert.equal(auditActions(fixture).at(-1), "checkpoint.verification_failed");
  const verifyOperations = operations(fixture, "checkpoint.verify");
  assert.deepEqual(
    verifyOperations.map((item) => [item.status, item.error_code]),
    [
      ["succeeded", null],
      ["succeeded", null],
      ["failed", "verification_failed"],
    ],
  );
  await assert.rejects(service.verify(fixture.owner, "ckpt-synthetic-none"), {
    code: "checkpoint_not_found",
  });
});

test("an interrupted verification cannot mark a checkpoint verified", async (t) => {
  const fixture = await createFixture(t);
  await createService(fixture).create(fixture.owner, { checkpointId: ID });

  const interrupted = createService(fixture, {
    dependencies: {
      openScratchDatabase: async () => {
        throw new Error("synthetic scratch failure");
      },
    },
  });
  await assert.rejects(
    interrupted.verify(fixture.owner, ID),
    /synthetic scratch failure/,
  );
  assert.equal(checkpointRow(fixture).verification_status, "pending");
  assert.equal(checkpointRow(fixture).version, 1);

  // The restore succeeds but the verdict transaction fails: nothing recorded.
  const restoreAudit = failAuditFor(fixture.database, "checkpoint.verified");
  const unrecorded = createService(fixture);
  await assert.rejects(
    unrecorded.verify(fixture.owner, ID),
    /synthetic audit failure/,
  );
  restoreAudit();
  const row = checkpointRow(fixture);
  assert.equal(row.verification_status, "pending");
  assert.equal(row.verified_at, null);
  assert.equal(row.verification_json, "{}");
  assert.deepEqual(auditActions(fixture), ["checkpoint.created"]);
  assert.deepEqual(
    operations(fixture, "checkpoint.verify").map((item) => [
      item.status,
      item.error_code,
      item.progress.phase,
    ]),
    [
      ["failed", "verification_interrupted", "interrupted"],
      ["failed", "record_failed", "verdict_unrecorded"],
    ],
  );

  // A scratch database that is not empty is refused, not restored into.
  const dirty = createService(fixture, {
    dependencies: {
      openScratchDatabase: async () => {
        const database = await openWebsiteDatabase();
        database.exec("CREATE TABLE occupied (id INTEGER)");
        return database;
      },
    },
  });
  await assert.rejects(dirty.verify(fixture.owner, ID), {
    code: "scratch_not_empty",
  });
  assert.equal(checkpointRow(fixture).verification_status, "pending");
});

test("failed production leaves no checkpoint row, bundle or success claim", async (t) => {
  const fixture = await createFixture(t);
  const failing = createService(fixture, {
    dependencies: {
      fileStore: {
        list: () => fixture.fileStore.list(),
        put: (key, bytes) => fixture.fileStore.put(key, bytes),
        read: async () => {
          throw new Error("synthetic read failure");
        },
      },
    },
  });
  await assert.rejects(
    failing.create(fixture.owner, { checkpointId: ID }),
    /synthetic read failure/,
  );
  assert.equal(checkpointRow(fixture), undefined);
  assert.deepEqual(await fixture.destination.list(), []);
  assert.deepEqual(auditActions(fixture), []);
  const [operation] = operations(fixture, "checkpoint.create");
  assert.equal(operation.status, "failed");
  assert.equal(operation.error_code, "production_failed");
  assert.equal(operation.progress.phase, "failed_before_publication");
  assert.ok(operation.finished_at);

  // The same identifier can be retried because nothing was published.
  const record = await createService(fixture).create(fixture.owner, {
    checkpointId: ID,
  });
  assert.equal(record.verificationStatus, "pending");
  await assert.rejects(
    createService(fixture).create(fixture.owner, { checkpointId: ID }),
    { code: "duplicate_checkpoint" },
  );
  assert.equal(operations(fixture, "checkpoint.create").length, 2);
});

test("a bundle published but not recorded is reconciled only after verification", async (t) => {
  const fixture = await createFixture(t);
  const restoreAudit = failAuditFor(fixture.database, "checkpoint.created");
  const crashing = createService(fixture);
  await assert.rejects(crashing.create(fixture.owner, { checkpointId: ID }), {
    code: "record_failed",
  });
  restoreAudit();
  assert.deepEqual(await fixture.destination.list(), [ID]);
  assert.equal(checkpointRow(fixture), undefined);
  assert.deepEqual(auditActions(fixture), []);
  const [operation] = operations(fixture, "checkpoint.create");
  assert.equal(operation.status, "failed");
  assert.equal(operation.error_code, "record_failed");
  assert.equal(operation.progress.phase, "published_unrecorded");
  assert.match(operation.progress.manifest_sha256, /^[0-9a-f]{64}$/);

  const service = createService(fixture);
  const before = treeDigest(fixture.bundlePath(ID));
  // A retry must not overwrite or silently adopt the published bundle.
  await assert.rejects(service.create(fixture.owner, { checkpointId: ID }), {
    code: "duplicate_checkpoint",
  });
  assert.equal(treeDigest(fixture.bundlePath(ID)), before);

  const result = await service.reconcile(fixture.owner);
  assert.deepEqual(result, {
    interruptedOperations: [],
    adopted: [ID],
    untrustedOrphans: [],
    missingBundles: [],
  });
  const row = checkpointRow(fixture);
  assert.equal(row.verification_status, "verified");
  assert.equal(row.operation_id, operation.id);
  assert.equal(row.manifest_sha256, operation.progress.manifest_sha256);
  assert.equal(JSON.parse(row.verification_json).ok, true);
  assert.deepEqual(auditActions(fixture), ["checkpoint.reconciled"]);
  assert.deepEqual((await service.reconcile(fixture.owner)).adopted, []);
});

test("orphan bundles are never trusted merely because they exist", async (t) => {
  const fixture = await createFixture(t);
  const service = createService(fixture);

  // 1. A bundle with no operation record at all.
  const stray = "ckpt-synthetic-stray";
  await produceCheckpoint(
    fixture.database,
    fixture.fileStore,
    fixture.destination,
    {
      checkpointId: stray,
      applicationCommit: COMMIT,
    },
  );

  // 2. A recorded-digest bundle that was altered after publication.
  const altered = "ckpt-synthetic-altered";
  const restoreAudit = failAuditFor(fixture.database, "checkpoint.created");
  const crashing = createService(fixture);
  await assert.rejects(
    crashing.create(fixture.owner, { checkpointId: altered }),
  );
  restoreAudit();
  const digest = sha256(SYNTHETIC_FILES["images/pixel.bin"]);
  overwrite(fixture.bundlePath(altered, "files", digest), "tampered");

  // 3. An operation left running by a crash, and a row whose bundle is gone.
  fixture.database.exec(
    `INSERT INTO operations (id, kind, status, created_by_account_id, progress_json, started_at)
     VALUES ('op-synthetic-crashed', 'checkpoint.verify', 'running', '${OWNER}', '{"checkpoint_id":"x","phase":"restoring"}', '2026-01-01T00:00:00.000Z')`,
  );
  await service.create(fixture.owner, { checkpointId: ID });
  renameSync(fixture.bundlePath(ID), join(fixture.root, "moved-away"));

  const before = treeDigest(fixture.destinationRoot);
  const result = await service.reconcile(fixture.owner);
  assert.deepEqual(result, {
    interruptedOperations: ["op-synthetic-crashed"],
    adopted: [],
    untrustedOrphans: [
      { id: altered, reason: "member_size_mismatch" },
      { id: stray, reason: "no_operation_record" },
    ],
    missingBundles: [ID],
  });
  assert.equal(checkpointRow(fixture, stray), undefined);
  assert.equal(checkpointRow(fixture, altered), undefined);
  // Reconciliation reports untrusted bundles. It does not delete them.
  assert.equal(treeDigest(fixture.destinationRoot), before);
  assert.deepEqual(
    readdirSync(join(fixture.destinationRoot, "published")).sort(),
    [altered, stray],
  );
  const [crashed] = all(
    fixture,
    "SELECT status, error_code FROM operations WHERE id = 'op-synthetic-crashed'",
  );
  assert.deepEqual(
    { ...crashed },
    { status: "failed", error_code: "interrupted" },
  );
  assert.equal(checkpointRow(fixture).verification_status, "pending");

  // A recorded checkpoint whose bundle is gone fails verification outright.
  const missing = await service.verify(fixture.owner, ID);
  assert.equal(missing.record.verificationStatus, "failed");
  assert.equal(missing.report.failures[0].code, "bundle_missing");
});

test("pruning is disabled unconditionally for every principal", async (t) => {
  const fixture = await createFixture(t);
  const service = createService(fixture);
  await service.create(fixture.owner, { checkpointId: ID });
  const before = treeDigest(fixture.destinationRoot);

  // An administrator human and an administrator agent, resolved as requests are.
  fixture.database.exec(
    "UPDATE accounts SET role = 'administrator', version = version + 1 WHERE id = 'acct-synthetic-contributor'",
  );
  const administrator = await resolvePrincipal(
    fixture.database,
    new Request("https://watchdog.test/", {
      headers: { "x-test-human-subject": "contributor" },
    }),
    createTestHumanIdentityAdapter({ contributor: "subject-contributor" }),
  );
  const credential = await createAgentCredential();
  fixture.database
    .prepare(
      "INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES ('ident-synthetic-key', 'acct-synthetic-agent', 'agent-key', 'prune-agent', ?)",
    )
    .run(credential.hash);
  const agent = await resolvePrincipal(
    fixture.database,
    new Request("https://watchdog.test/", {
      headers: { authorization: `Bearer ${credential.secret}` },
    }),
  );
  assert.equal(administrator.role, "administrator");
  assert.equal(agent.kind, "agent");

  const forged = {
    accountId: OWNER,
    kind: "human",
    role: "owner",
    provider: "test-human",
  };
  const principals = [
    fixture.owner,
    administrator,
    agent,
    fixture.contributor,
    forged,
    OWNER,
    null,
    undefined,
  ];
  for (const principal of principals) {
    assert.equal(
      hasCapability(fixture.database, principal, "checkpoint.prune"),
      false,
    );
    await assert.rejects(service.prune(principal), { code: "prune_disabled" });
  }
  await assert.rejects(service.prune(), { code: "prune_disabled" });

  assert.equal(treeDigest(fixture.destinationRoot), before);
  assert.deepEqual(await fixture.destination.list(), [ID]);
  assert.equal(checkpointRow(fixture).verification_status, "pending");
});

test("hostile bundle text never enters returned or persisted verification details", async (t) => {
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
  const service = createService(fixture);
  await service.create(fixture.owner, { checkpointId: ID });

  const path = fixture.bundlePath(ID, "db", "tables", "m0d_hostile.jsonl");
  const text = readFileSync(path, "utf8").replace('["i","5"]', '["i","-5"]');
  overwrite(path, text);
  const manifestPath = fixture.bundlePath(ID, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.database.tables.find(
    (item) => item.name === "m0d_hostile",
  );
  entry.sha256 = sha256(text);
  entry.bytes = Buffer.byteLength(text);
  const manifestText = canonicalJson(manifest);
  overwrite(manifestPath, manifestText);
  // Re-anchor the recorded digest so verification reaches the restore step,
  // as an attacker who also rewrote the database row would.
  fixture.database
    .prepare(
      "UPDATE checkpoints SET manifest_sha256 = ?, version = version + 1 WHERE id = ?",
    )
    .run(sha256(manifestText), ID);

  const outcome = await service.verify(fixture.owner, ID);
  assert.equal(outcome.report.ok, false);
  assert.equal(outcome.record.verificationStatus, "failed");
  const restore = outcome.report.failures.find(
    (failure) => failure.code === "restore_failed",
  );
  assert.ok(restore);
  assert.match(restore.detail, /CHECK constraint failed/);
  assert.ok(restore.detail.length <= 200);

  const persisted = JSON.stringify([
    outcome,
    all(fixture, "SELECT * FROM checkpoints"),
    all(fixture, "SELECT * FROM operations"),
    all(fixture, "SELECT * FROM audit_events"),
  ]);
  assert.ok(!persisted.includes("script"));
  assert.ok(!persisted.includes("alert"));
});

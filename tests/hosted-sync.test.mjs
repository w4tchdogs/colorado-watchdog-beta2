import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";
import { createD1AccountServices } from "../dist/services/d1-accounts.js";
import {
  createTestHumanIdentityAdapter,
  hashCredential,
} from "../dist/services/security.js";
import { createWorld, ORIGIN } from "./auth-fixtures.mjs";

const SECRET = `cwa_${"S".repeat(43)}`;
const OTHER = `cwa_${"T".repeat(43)}`;
const ADMIN = `cwa_${"U".repeat(43)}`;
const REQ = "7b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const V = "m2-sync/v1";

const batch = (tag = "hs", intent = "commit", requestId = REQ) => ({
  contractVersion: V,
  requestId,
  intent,
  duplicateFlags: [],
  changes: [
    {
      op: "register_source",
      entity: "role_sources",
      clientRef: "source",
      fields: {
        url: `https://example.invalid/${tag}`,
        title: `Synthetic source ${tag}`,
        publisher_classification: "official",
        source_type: "other_public",
      },
    },
    {
      op: "create_person",
      entity: "people",
      clientRef: "person",
      fields: { display_name: `Synthetic Person ${tag}` },
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
});

async function setup(callback) {
  const world = await createWorld();
  try {
    world.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES
        ('sync-agent', 'agent', 'contributor', 'Synthetic Sync Agent'),
        ('other-agent', 'agent', 'contributor', 'Synthetic Other Agent'),
        ('admin-agent', 'agent', 'administrator', 'Synthetic Admin Agent');
      INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES
        ('i-sync-main', 'sync-agent', 'agent-key', 'i-sync-main', '${await hashCredential(SECRET)}'),
        ('i-sync-other', 'other-agent', 'agent-key', 'i-sync-other', '${await hashCredential(OTHER)}'),
        ('i-sync-admin', 'admin-agent', 'agent-key', 'i-sync-admin', '${await hashCredential(ADMIN)}');
      INSERT INTO identities (id, account_id, provider, subject) VALUES
        ('i-owner-test', 'h-owner', 'test-human', 'owner');
    `);
    const accounts = createD1AccountServices(
      world.asyncD1,
      createTestHumanIdentityAdapter({ owner: "owner" }),
    );
    const owner = await accounts.resolvePrincipal(
      new Request(ORIGIN, { headers: { "x-test-human-subject": "owner" } }),
    );
    assert.ok(owner);
    const call = (path, body, { key = SECRET, idem } = {}) =>
      worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(idem ? { "idempotency-key": idem } : {}),
          },
          body: JSON.stringify(body),
        }),
        world.env,
      );
    await callback({ world, accounts, owner, call });
  } finally {
    world.database.close();
  }
}

const n = (world, table) =>
  world.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const data = (world) => ({
  people: n(world, "people"),
  roles: n(world, "person_roles"),
  sources: n(world, "role_sources"),
  batches: n(world, "sync_batches"),
});
const DRY = "/internal/sync/changesets/dry-run";
const COMMIT = "/internal/sync/changesets/commit";
const LOOKUP = "/internal/sync/batches/lookup";
const REVERSE = "/internal/sync/batches/reverse";

test("hosted sync route is default-deny without an explicit grant", async () => {
  await setup(async ({ world, call }) => {
    const before = data(world);
    assert.equal(
      (await call(DRY, batch("a", "dry_run"), { key: null })).status,
      401,
    );
    assert.equal(
      (await call(DRY, batch("a", "dry_run"), { key: `cwa_${"Z".repeat(43)}` }))
        .status,
      401,
    );
    for (const key of [SECRET, ADMIN]) {
      assert.equal(
        (await call(DRY, batch("a", "dry_run"), { key })).status,
        403,
      );
      assert.equal(
        (await call(COMMIT, batch("a"), { key, idem: "k-1" })).status,
        403,
      );
      assert.equal(
        (await call(LOOKUP, { contractVersion: V, batchId: "x" }, { key }))
          .status,
        403,
      );
      assert.equal(
        (
          await call(
            REVERSE,
            { contractVersion: V, batchId: "x" },
            { key, idem: "k-2" },
          )
        ).status,
        403,
      );
    }
    assert.deepEqual(data(world), before);
    const get = await worker.fetch(
      new Request(`${ORIGIN}${LOOKUP}`),
      world.env,
    );
    assert.equal(get.status, 405);
  });
});

test("grants are owner-only, agent-only, sync-only, audited and revocable", async () => {
  await setup(async ({ world, accounts, owner }) => {
    const admin = await accounts.resolvePrincipal(
      new Request(ORIGIN, { headers: { authorization: `Bearer ${ADMIN}` } }),
    );
    assert.ok(admin);
    await assert.rejects(
      accounts.setAgentCapability(admin, "sync-agent", "sync.read", true),
    );
    await assert.rejects(
      accounts.setAgentCapability(owner, "sync-agent", "banner.manage", true),
    );
    await assert.rejects(
      accounts.setAgentCapability(owner, "h-editor", "sync.read", true),
    );
    assert.equal(n(world, "agent_capability_grants"), 0);
    await accounts.setAgentCapability(owner, "sync-agent", "sync.read", true);
    assert.deepEqual(
      await accounts.listAgentCapabilities(owner, "sync-agent"),
      ["sync.read"],
    );
    await assert.rejects(
      accounts.setAgentCapability(owner, "sync-agent", "sync.read", true),
    );
    await accounts.setAgentCapability(owner, "sync-agent", "sync.read", false);
    assert.deepEqual(
      await accounts.listAgentCapabilities(owner, "sync-agent"),
      [],
    );
    assert.equal(n(world, "agent_capability_grants"), 1);
    assert.throws(() =>
      world.database.exec("DELETE FROM agent_capability_grants"),
    );
    assert.throws(() =>
      world.database.exec(
        "UPDATE agent_capability_grants SET capability = 'sync.apply'",
      ),
    );
    const audit = world.database
      .prepare(
        "SELECT action, actor_account_id FROM audit_events WHERE action LIKE 'account.capability.%' ORDER BY rowid",
      )
      .all();
    assert.deepEqual(
      audit.map((e) => e.action),
      ["account.capability.grant", "account.capability.revoke"],
    );
    assert.ok(audit.every((e) => e.actor_account_id === "h-owner"));
    assert.equal(await accounts.hasCapability(admin, "sync.apply"), false);
    await accounts.setAgentCapability(owner, "admin-agent", "sync.apply", true);
    assert.equal(await accounts.hasCapability(admin, "sync.apply"), true);
    assert.equal(await accounts.hasCapability(admin, "sync.read"), false);
    assert.equal(await accounts.hasCapability(owner, "sync.apply"), false);
  });
});

test("hosted plan, commit, replay, readback and reversal", async () => {
  await setup(async ({ world, accounts, owner, call }) => {
    for (const c of ["sync.read", "sync.apply", "sync.revert"])
      await accounts.setAgentCapability(owner, "sync-agent", c, true);
    const before = data(world);

    const plan = await call(DRY, batch("p", "dry_run"));
    assert.equal(plan.status, 200);
    assert.deepEqual(data(world), before, "dry run writes nothing");

    const commit = await call(COMMIT, batch("p"), { idem: "hosted-1" });
    assert.equal(commit.status, 200, await commit.clone().text());
    const result = await commit.json();
    assert.equal(result.status, "committed");
    assert.equal(n(world, "person_roles"), before.roles + 1);

    const replay = await call(COMMIT, batch("p"), { idem: "hosted-1" });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).batchId, result.batchId);
    assert.equal(n(world, "sync_batches"), before.batches + 1);

    const mismatch = await call(COMMIT, batch("q"), { idem: "hosted-1" });
    assert.equal(mismatch.status, 409);
    assert.equal(n(world, "sync_batches"), before.batches + 1);

    const lookup = await call(LOOKUP, {
      contractVersion: V,
      batchId: result.batchId,
    });
    const found = await lookup.json();
    assert.equal(lookup.status, 200);
    assert.equal(found.status, "committed");
    assert.equal(found.items.length, 3);
    const byKey = await call(LOOKUP, {
      contractVersion: V,
      idempotencyKey: "hosted-1",
    });
    assert.equal((await byKey.json()).batchId, result.batchId);

    await accounts.setAgentCapability(owner, "other-agent", "sync.read", true);
    await accounts.setAgentCapability(
      owner,
      "other-agent",
      "sync.revert",
      true,
    );
    const foreign = await call(
      LOOKUP,
      { contractVersion: V, batchId: result.batchId },
      { key: OTHER },
    );
    assert.equal(foreign.status, 404);
    const foreignRevert = await call(
      REVERSE,
      { contractVersion: V, batchId: result.batchId },
      { key: OTHER, idem: "foreign-1" },
    );
    assert.notEqual((await foreignRevert.json()).status, "reverted");
    assert.equal(n(world, "person_roles"), before.roles + 1);

    await accounts.setAgentCapability(
      owner,
      "sync-agent",
      "sync.revert",
      false,
    );
    const denied = await call(
      REVERSE,
      { contractVersion: V, batchId: result.batchId },
      { idem: "rev-denied" },
    );
    assert.equal(denied.status, 403);
    assert.equal(n(world, "person_roles"), before.roles + 1);
    await accounts.setAgentCapability(owner, "sync-agent", "sync.revert", true);

    const reversal = await call(
      REVERSE,
      { contractVersion: V, batchId: result.batchId },
      { idem: "rev-1" },
    );
    assert.equal(reversal.status, 200);
    assert.equal((await reversal.json()).status, "reverted");
    assert.equal(n(world, "person_roles"), before.roles);
    assert.equal(n(world, "people"), before.people);
    assert.equal(n(world, "role_sources"), before.sources);
    assert.equal(n(world, "sync_batches"), before.batches + 1);
    assert.equal(n(world, "sync_batch_reversals"), 1);
    const after = await (
      await call(LOOKUP, { contractVersion: V, batchId: result.batchId })
    ).json();
    assert.equal(after.status, "reverted");
  });
});

test("malformed hosted requests are rejected before any write", async () => {
  await setup(async ({ world, accounts, owner, call }) => {
    await accounts.setAgentCapability(owner, "sync-agent", "sync.apply", true);
    const before = data(world);
    const empty = await call(
      COMMIT,
      {
        contractVersion: V,
        requestId: REQ,
        intent: "commit",
        changes: [],
        duplicateFlags: [],
      },
      { idem: "bad-1" },
    );
    assert.ok([400, 422].includes(empty.status));
    assert.equal((await call(COMMIT, batch("n"))).status, 400);
    const wrongType = await worker.fetch(
      new Request(`${ORIGIN}${COMMIT}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "text/plain",
          "idempotency-key": "t-1",
        },
        body: "{}",
      }),
      world.env,
    );
    assert.equal(wrongType.status, 415);
    assert.deepEqual(data(world), before);
  });
});

test("without a database binding the sync route is unavailable", async () => {
  const response = await worker.fetch(
    new Request(`${ORIGIN}${DRY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    {},
  );
  assert.equal(response.status, 503);
});

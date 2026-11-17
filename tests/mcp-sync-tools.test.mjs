import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";
import { createD1AccountServices } from "../dist/services/d1-accounts.js";
import {
  createTestHumanIdentityAdapter,
  hashCredential,
} from "../dist/services/security.js";
import { createWorld, ORIGIN } from "./auth-fixtures.mjs";
import { mixedChangeset } from "./sync-scale-fixtures.mjs";

// MCP-3 Profiles sync tools through the built Worker and a migrated synthetic
// database. Every record is invented. The 816-operation changeset is the same
// synthetic fixture used for the hosted scale rehearsal (about 166 KB; the isolated Adams preview was about 245 KB).

const KEYS = {
  main: `cwa_${"M".repeat(43)}`,
  other: `cwa_${"N".repeat(43)}`,
  readOnly: `cwa_${"R".repeat(43)}`,
  plain: `cwa_${"P".repeat(43)}`,
  inspector: `cwa_${"I".repeat(43)}`,
  agentOwner: `cwa_${"O".repeat(43)}`,
};
const META = {
  protocolVersion: "2026-07-28",
  clientInfo: { name: "synthetic-client", version: "1.0.0" },
  clientCapabilities: {},
};

async function setup(callback) {
  const world = await createWorld();
  try {
    const h = async (k) => `'${await hashCredential(KEYS[k])}'`;
    world.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES
        ('a-main', 'agent', 'contributor', 'Synthetic Sync Agent'),
        ('a-other', 'agent', 'contributor', 'Synthetic Other Agent'),
        ('a-read', 'agent', 'contributor', 'Synthetic Reader'),
        ('a-plain', 'agent', 'contributor', 'Synthetic Plain Agent'),
        ('a-inspector', 'agent', 'contributor', 'Synthetic Inspector'),
        ('a-agent-owner', 'agent', 'owner', 'Synthetic Agent Owner');
      INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES
        ('i-main', 'a-main', 'agent-key', 'i-main', ${await h("main")}),
        ('i-other', 'a-other', 'agent-key', 'i-other', ${await h("other")}),
        ('i-read', 'a-read', 'agent-key', 'i-read', ${await h("readOnly")}),
        ('i-plain', 'a-plain', 'agent-key', 'i-plain', ${await h("plain")}),
        ('i-inspector', 'a-inspector', 'agent-key', 'i-inspector', ${await h("inspector")}),
        ('i-agent-owner', 'a-agent-owner', 'agent-key', 'i-agent-owner', ${await h("agentOwner")}),
        ('i-owner-test', 'h-owner', 'test-human', 'owner', NULL);
    `);
    const accounts = createD1AccountServices(
      world.asyncD1,
      createTestHumanIdentityAdapter({ owner: "owner" }),
    );
    const owner = await accounts.resolvePrincipal(
      new Request(ORIGIN, { headers: { "x-test-human-subject": "owner" } }),
    );
    assert.ok(owner);
    for (const cap of ["sync.read", "sync.apply", "sync.revert"]) {
      await accounts.setAgentCapability(owner, "a-main", cap, true);
      await accounts.setAgentCapability(owner, "a-other", cap, true);
    }
    await accounts.setAgentCapability(owner, "a-read", "sync.read", true);
    await accounts.setAgentCapability(owner, "a-inspector", "d1.inspect", true);

    let rpcId = 0;
    const raw = (key, text, headers = {}) =>
      worker.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${KEYS[key]}` } : {}),
            ...headers,
          },
          body: text,
        }),
        world.env,
      );
    const envelope = (method, params) =>
      JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    const tool = async (key, name, args, headers = {}) => {
      const response = await raw(
        key,
        envelope("tools/call", { name, arguments: args, _meta: META }),
        headers,
      );
      if (response.status !== 200)
        return { http: response.status, body: await response.json() };
      const result = (await response.json()).result;
      const parsed = JSON.parse(result.content[0].text);
      return result.isError ? { error: parsed } : { ok: parsed };
    };
    await callback({ world, accounts, owner, raw, envelope, tool });
  } finally {
    world.database.close();
  }
}

const n = (world, table) =>
  world.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const data = (world) => ({
  orgs: n(world, "organizations"),
  people: n(world, "people"),
  roles: n(world, "person_roles"),
  sources: n(world, "role_sources"),
  positions: n(world, "positions"),
  batches: n(world, "sync_batches"),
  reversals: n(world, "sync_batch_reversals"),
});
const ZERO = {
  orgs: 0,
  people: 0,
  roles: 0,
  sources: 0,
  positions: 0,
  batches: 0,
  reversals: 0,
};

/** Reads every page of a batch the way an operator assembles a full receipt. */
async function allItems(tool, key, args) {
  const items = [];
  let offset = 0;
  for (;;) {
    const page = await tool(key, "website_sync_lookup", {
      ...args,
      itemOffset: offset,
    });
    assert.ok(page.ok, JSON.stringify(page));
    items.push(...page.ok.items);
    if (page.ok.nextItemOffset === null) return { items, last: page.ok };
    offset = page.ok.nextItemOffset;
  }
}

test("816-operation batch: dry run, commit, replay, changed payload, paged readback and reversal", async () => {
  await setup(async ({ world, tool }) => {
    const prepared = mixedChangeset("commit", "mcp");
    assert.equal(prepared.changes.length, 816);
    const size = Buffer.byteLength(JSON.stringify(prepared));
    assert.ok(size > 100_000 && size < 400_000, `fixture is ${size} bytes`);

    // A prepared commit request is planned as-is and writes nothing.
    const dry = await tool("main", "website_sync_dry_run", {
      changeset: prepared,
    });
    assert.ok(dry.ok, JSON.stringify(dry).slice(0, 400));
    assert.equal(dry.ok.eligible, true);
    assert.equal(dry.ok.itemCount, 816);
    assert.equal(dry.ok.items.length, 100);
    assert.equal(dry.ok.nextItemOffset, 100);
    assert.equal(dry.ok.counts["people:would_create"], 262);
    assert.deepEqual(data(world), ZERO);
    const lastPage = await tool("main", "website_sync_dry_run", {
      changeset: prepared,
      itemOffset: 800,
      itemLimit: 250,
    });
    assert.equal(lastPage.ok.items.length, 16);
    assert.equal(lastPage.ok.nextItemOffset, null);

    const committed = await tool("main", "website_sync_commit", {
      idempotencyKey: "mcp-816-a",
      changeset: prepared,
    });
    assert.ok(committed.ok, JSON.stringify(committed).slice(0, 400));
    assert.equal(committed.ok.status, "committed");
    assert.equal(committed.ok.replayed, false);
    assert.equal(committed.ok.itemCount, 816);
    assert.equal(committed.ok.items.length, 100);
    assert.equal(committed.ok.counts["people:created"], 262);
    const after = data(world);
    assert.deepEqual(
      { ...after, batches: undefined },
      {
        orgs: 3,
        people: 262,
        roles: 503,
        sources: 40,
        positions: 8,
        batches: undefined,
        reversals: 0,
      },
    );
    assert.equal(after.batches, 1);
    const batchId = committed.ok.batchId;

    // Same key and same changeset replays the one stored batch.
    const replay = await tool("main", "website_sync_commit", {
      idempotencyKey: "mcp-816-a",
      changeset: prepared,
    });
    assert.equal(replay.ok.replayed, true);
    assert.equal(replay.ok.batchId, batchId);
    assert.deepEqual(data(world), after);

    // Same key with a different changeset is refused and writes nothing.
    const changed = mixedChangeset("commit", "mcp-changed");
    const mismatch = await tool("main", "website_sync_commit", {
      idempotencyKey: "mcp-816-a",
      changeset: changed,
    });
    assert.equal(mismatch.error.error, "commit_rejected");
    assert.equal(mismatch.error.errors[0].code, "idempotency_mismatch");
    assert.deepEqual(data(world), after);

    // Paged readback reassembles the complete receipt, by ID or by key.
    const byId = await allItems(tool, "main", { batchId });
    const byKey = await allItems(tool, "main", {
      idempotencyKey: "mcp-816-a",
    });
    assert.equal(byId.items.length, 816);
    assert.deepEqual(byId.items, byKey.items);
    assert.deepEqual(
      byId.items.map((item) => item.itemIndex),
      [...Array(816).keys()],
    );
    assert.equal(byId.last.status, "committed");
    assert.ok(
      byId.items.every(
        (item) => item.websiteId && item.version >= 1 && item.clientRef,
      ),
    );
    // The first page of the commit receipt is identical to the readback's.
    assert.deepEqual(committed.ok.items, byId.items.slice(0, 100));

    const reversed = await tool("main", "website_sync_reverse", {
      batchId,
      idempotencyKey: "mcp-816-rev",
    });
    assert.equal(reversed.ok.status, "reverted", JSON.stringify(reversed));
    assert.equal(reversed.ok.replayed, false);
    const replayRev = await tool("main", "website_sync_reverse", {
      batchId,
      idempotencyKey: "mcp-816-rev",
    });
    assert.equal(replayRev.ok.replayed, true);
    assert.equal(replayRev.ok.reversalId, reversed.ok.reversalId);
    assert.equal(data(world).reversals, 1);
    const reread = await tool("main", "website_sync_lookup", { batchId });
    assert.equal(reread.ok.status, "reverted");
    assert.ok(reread.ok.reversedAt);
  });
});

test("stale versions and unresolved dependencies are refused without writes", async () => {
  await setup(async ({ world, tool }) => {
    const small = mixedChangeset("commit", "stale");
    small.changes = small.changes
      .filter((change) => change.entity === "people")
      .slice(0, 2);
    const done = await tool("main", "website_sync_commit", {
      idempotencyKey: "stale-1",
      changeset: small,
    });
    assert.ok(done.ok, JSON.stringify(done));
    const target = done.ok.items[0];
    const before = data(world);
    const update = (version, intent = "commit") => ({
      contractVersion: "m2-sync/v1",
      requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb19",
      intent,
      changes: [
        {
          op: "update_record",
          entity: "people",
          targetId: target.websiteId,
          expectedVersion: version,
          fields: { display_name: "Synthetic Renamed Person" },
        },
      ],
    });
    const stale = await tool("main", "website_sync_commit", {
      idempotencyKey: "stale-2",
      changeset: update(target.version + 7),
    });
    assert.equal(stale.error.error, "commit_rejected");
    assert.ok(stale.error.errors.length > 0);
    const planned = await tool("main", "website_sync_dry_run", {
      changeset: update(target.version + 7),
    });
    assert.equal(planned.ok.eligible, false);
    assert.ok(planned.ok.errors.length > 0);
    const dangling = await tool("main", "website_sync_commit", {
      idempotencyKey: "stale-3",
      changeset: {
        ...small,
        requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb20",
        changes: [
          {
            op: "create_position",
            entity: "positions",
            clientRef: "p",
            fields: { title: "Synthetic", organization_ref: "missing" },
          },
        ],
      },
    });
    assert.equal(dangling.error.error, "commit_rejected");
    assert.deepEqual(data(world), before);
    // The right version still commits.
    const ok = await tool("main", "website_sync_commit", {
      idempotencyKey: "stale-4",
      changeset: update(target.version),
    });
    assert.ok(ok.ok, JSON.stringify(ok));
  });
});

test("grants gate every tool and the large body, and failed calls write nothing", async () => {
  await setup(async ({ world, accounts, owner, raw, envelope, tool }) => {
    const prepared = mixedChangeset("commit", "gate");
    const big = envelope("tools/call", {
      name: "website_sync_commit",
      arguments: { idempotencyKey: "gate-1", changeset: prepared },
    });
    assert.ok(Buffer.byteLength(big) > 24 * 1024);

    // No credential, a plain agent, an inspection-only agent and an owner-role
    // agent never get the large body past the size gate.
    for (const key of [null, "plain", "inspector", "agentOwner"]) {
      const response = await raw(key, big);
      assert.equal(response.status, 413, String(key));
      const sized = await raw(key, big, {
        "content-length": String(Buffer.byteLength(big)),
      });
      assert.equal(sized.status, 413, String(key));
    }
    // Small calls from those agents get the normal tool-level denial.
    const args = { batchId: "x" };
    for (const key of ["plain", "inspector"])
      for (const [name, a] of [
        ["website_sync_lookup", args],
        ["website_sync_dry_run", { changeset: { a: 1 } }],
        ["website_sync_commit", { idempotencyKey: "k", changeset: { a: 1 } }],
        ["website_sync_reverse", { batchId: "x", idempotencyKey: "k" }],
      ])
        assert.equal(
          (await tool(key, name, a)).error.error,
          "not_authorized",
          `${key} ${name}`,
        );
    assert.equal(
      (await tool("agentOwner", "website_sync_lookup", args)).error.error,
      "authentication_required",
    );
    assert.equal(
      (await tool(null, "website_sync_lookup", args)).error.error,
      "authentication_required",
    );
    // A read-only grant may send a large body, but cannot commit or reverse.
    const readOnlyCommit = await tool("readOnly", "website_sync_commit", {
      idempotencyKey: "gate-2",
      changeset: prepared,
    });
    assert.equal(readOnlyCommit.error.error, "not_authorized");
    assert.equal(
      (
        await tool("readOnly", "website_sync_reverse", {
          batchId: "x",
          idempotencyKey: "gate-3",
        })
      ).error.error,
      "not_authorized",
    );
    assert.equal(
      (
        await tool("readOnly", "website_sync_dry_run", {
          changeset: prepared,
        })
      ).ok.eligible,
      true,
    );
    assert.deepEqual(data(world), ZERO);

    // A revoked grant is refused again, large body included.
    await accounts.setAgentCapability(owner, "a-read", "sync.read", false);
    assert.equal((await raw("readOnly", big)).status, 413);
    assert.equal(
      (await tool("readOnly", "website_sync_lookup", args)).error.error,
      "not_authorized",
    );
    assert.deepEqual(data(world), ZERO);
  });
});

test("cross-account batches are invisible, and a revoked apply grant stops commits", async () => {
  await setup(async ({ world, accounts, owner, tool }) => {
    const prepared = mixedChangeset("commit", "iso");
    prepared.changes = prepared.changes.slice(0, 3);
    const done = await tool("main", "website_sync_commit", {
      idempotencyKey: "iso-1",
      changeset: prepared,
    });
    assert.ok(done.ok, JSON.stringify(done));
    const batchId = done.ok.batchId;
    const before = data(world);
    assert.equal(
      (await tool("other", "website_sync_lookup", { batchId })).error.error,
      "batch_not_found",
    );
    assert.equal(
      (
        await tool("other", "website_sync_lookup", {
          idempotencyKey: "iso-1",
        })
      ).error.error,
      "batch_not_found",
    );
    const foreign = await tool("other", "website_sync_reverse", {
      batchId,
      idempotencyKey: "iso-rev",
    });
    assert.notEqual(foreign.ok?.status, "reverted");
    assert.deepEqual(data(world), before);

    await accounts.setAgentCapability(owner, "a-main", "sync.apply", false);
    const refused = await tool("main", "website_sync_commit", {
      idempotencyKey: "iso-2",
      changeset: {
        ...prepared,
        requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb21",
      },
    });
    assert.equal(refused.error.error, "not_authorized");
    assert.deepEqual(data(world), before);
  });
});

test("body limits are enforced on received bytes, and other tools keep the small cap", async () => {
  await setup(async ({ world, raw, envelope, tool }) => {
    const filler = "x".repeat(2 * 1024 * 1024 + 10);
    const huge = envelope("tools/call", {
      name: "website_sync_dry_run",
      arguments: { changeset: { pad: filler } },
    });
    // Granted agent, too large, with and without a declared length.
    assert.equal((await raw("main", huge)).status, 413);
    assert.equal(
      (
        await raw("main", huge, {
          "content-length": String(Buffer.byteLength(huge)),
        })
      ).status,
      413,
    );
    // A false declared length cannot smuggle more bytes than the limit.
    assert.equal(
      (await raw("main", huge, { "content-length": "100" })).status,
      413,
    );
    // Large bodies stay limited to the two changeset tools.
    const largeLookup = envelope("tools/call", {
      name: "website_sync_lookup",
      arguments: { batchId: "x" },
      _meta: { pad: "y".repeat(30 * 1024) },
    });
    assert.equal((await raw("main", largeLookup)).status, 413);
    const largeDiscover = envelope("server/discover", {
      _meta: { pad: "y".repeat(30 * 1024) },
    });
    assert.equal((await raw("main", largeDiscover)).status, 413);
    assert.equal((await raw(null, largeDiscover)).status, 413);
    // A small discovery request is unchanged.
    assert.equal((await raw(null, envelope("server/discover"))).status, 200);
    // Invalid arguments are refused after the grant check, without writes.
    for (const args of [
      {},
      { changeset: [] },
      { changeset: {}, extra: 1 },
      { changeset: {}, itemLimit: 1000 },
    ])
      assert.equal(
        (await tool("main", "website_sync_dry_run", args)).error.error,
        "invalid_arguments",
      );
    assert.equal(
      (
        await tool("main", "website_sync_lookup", {
          batchId: "a",
          idempotencyKey: "b",
        })
      ).error.error,
      "invalid_arguments",
    );
    assert.equal(
      (await tool("main", "website_sync_lookup", {})).error.error,
      "invalid_arguments",
    );
    // A malformed changeset is reported by the transport's own validation.
    assert.equal(
      (await tool("main", "website_sync_dry_run", { changeset: { a: 1 } }))
        .error.error,
      "unsupported_contract_version",
    );
    assert.deepEqual(data(world), ZERO);
  });
});

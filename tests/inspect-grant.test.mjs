import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";
import { createD1AccountServices } from "../dist/services/d1-accounts.js";
import {
  createTestHumanIdentityAdapter,
  hashCredential,
} from "../dist/services/security.js";
import { createWorld, ORIGIN } from "./auth-fixtures.mjs";

const KEYS = {
  inspector: `cwa_${"I".repeat(43)}`,
  plain: `cwa_${"P".repeat(43)}`,
  expired: `cwa_${"E".repeat(43)}`,
  revoked: `cwa_${"R".repeat(43)}`,
  agentOwner: `cwa_${"O".repeat(43)}`,
  admin: `cwa_${"A".repeat(43)}`,
};

async function setup(callback) {
  const world = await createWorld();
  try {
    const h = async (k) => `'${await hashCredential(KEYS[k])}'`;
    world.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES
        ('a-inspect', 'agent', 'contributor', 'Synthetic Inspector'),
        ('a-plain', 'agent', 'contributor', 'Synthetic Plain Agent'),
        ('a-expired', 'agent', 'contributor', 'Synthetic Expired Agent'),
        ('a-revoked', 'agent', 'contributor', 'Synthetic Revoked Agent'),
        ('a-owner', 'agent', 'owner', 'Synthetic Agent Owner'),
        ('a-admin', 'agent', 'administrator', 'Synthetic Agent Admin');
      INSERT INTO identities (id, account_id, provider, subject, credential_hash, expires_at, revoked_at) VALUES
        ('i-inspect', 'a-inspect', 'agent-key', 'i-inspect', ${await h("inspector")}, NULL, NULL),
        ('i-plain', 'a-plain', 'agent-key', 'i-plain', ${await h("plain")}, NULL, NULL),
        ('ia-expired', 'a-expired', 'agent-key', 'ia-expired', ${await h("expired")}, '2000-01-01T00:00:00.000Z', NULL),
        ('ia-revoked', 'a-revoked', 'agent-key', 'ia-revoked', ${await h("revoked")}, NULL, '2026-11-13T00:00:00.000Z'),
        ('i-agent-owner', 'a-owner', 'agent-key', 'i-agent-owner', ${await h("agentOwner")}, NULL, NULL),
        ('i-agent-admin', 'a-admin', 'agent-key', 'i-agent-admin', ${await h("admin")}, NULL, NULL),
        ('i-owner-test', 'h-owner', 'test-human', 'owner', NULL, NULL, NULL);
      INSERT INTO agent_capability_grants (id, account_id, capability, granted_by_account_id, granted_at) VALUES
        ('g-expired', 'a-expired', 'd1.inspect', 'h-owner', '2026-11-16T00:00:00.000Z'),
        ('g-revoked', 'a-revoked', 'd1.inspect', 'h-owner', '2026-11-16T00:00:00.000Z');
    `);
    const accounts = createD1AccountServices(
      world.asyncD1,
      createTestHumanIdentityAdapter({ owner: "owner" }),
    );
    const owner = await accounts.resolvePrincipal(
      new Request(ORIGIN, { headers: { "x-test-human-subject": "owner" } }),
    );
    assert.ok(owner);
    const http = (path, body, key, method = "POST") =>
      worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(/commit|reverse/.test(path)
              ? { "idempotency-key": "k-inspect-1" }
              : {}),
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        }),
        world.env,
      );
    const mcp = async (tool, key, args = {}) => {
      const response = await http(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
        key,
      );
      return (await response.json()).result;
    };
    await callback({ world, accounts, owner, http, mcp });
  } finally {
    world.database.close();
  }
}

const TOOLS = [
  "website_inspection_status",
  "website_county_reference_counts",
  "website_migration_history",
  "website_county_provenance_summary",
];
const TABLES = [
  "accounts",
  "identities",
  "agent_capability_grants",
  "banner_assets",
  "sync_batches",
  "operations",
  "audit_events",
];
const snapshot = (world) =>
  JSON.stringify(
    TABLES.map((t) => {
      try {
        return world.database.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      } catch {
        return null;
      }
    }),
  );

test("d1.inspect is an owner-only agent grant that unlocks only fixed inspection", async () => {
  await setup(async ({ world, accounts, owner, http, mcp }) => {
    assert.equal((await mcp(TOOLS[0], KEYS.inspector)).isError, true);

    const admin = await accounts.resolvePrincipal(
      new Request(ORIGIN, {
        headers: { authorization: `Bearer ${KEYS.admin}` },
      }),
    );
    await assert.rejects(
      accounts.setAgentCapability(admin, "a-inspect", "d1.inspect", true),
    );
    await assert.rejects(
      accounts.setAgentCapability(owner, "h-editor", "d1.inspect", true),
    );
    await accounts.setAgentCapability(owner, "a-inspect", "d1.inspect", true);
    assert.deepEqual(await accounts.listAgentCapabilities(owner, "a-inspect"), [
      "d1.inspect",
    ]);
    const audit = world.database
      .prepare(
        "SELECT action FROM audit_events WHERE action LIKE 'account.capability.%'",
      )
      .all();
    assert.ok(audit.some((row) => row.action === "account.capability.grant"));

    for (const tool of TOOLS) {
      assert.notEqual((await mcp(tool, KEYS.inspector)).isError, true, tool);
    }

    const principal = await accounts.resolvePrincipal(
      new Request(ORIGIN, {
        headers: { authorization: `Bearer ${KEYS.inspector}` },
      }),
    );
    for (const capability of [
      "account.read",
      "account.create",
      "account.update",
      "account.change_role",
      "identity.create",
      "identity.revoke",
      "audit.read",
      "operation.create",
      "checkpoint.create",
      "checkpoint.verify",
      "checkpoint.read",
      "checkpoint.prune",
      "banner.manage",
      "content.publish",
      "report.review",
      "sync.read",
      "sync.apply",
      "sync.revert",
    ])
      assert.equal(
        await accounts.hasCapability(principal, capability),
        false,
        capability,
      );
    assert.equal(await accounts.hasCapability(principal, "d1.inspect"), true);

    const before = snapshot(world);
    for (const [path, method] of [
      ["/api/admin/accounts", "GET"],
      ["/api/admin/accounts/a-plain/capabilities", "GET"],
      ["/api/admin/accounts/a-plain/credentials", "POST"],
      ["/api/admin/banners", "GET"],
      ["/api/admin/banners/counties", "GET"],
      ["/internal/sync/changesets/dry-run", "POST"],
      ["/internal/sync/changesets/commit", "POST"],
      ["/internal/sync/batches/lookup", "POST"],
      ["/internal/sync/batches/reverse", "POST"],
    ]) {
      const response = await http(path, {}, KEYS.inspector, method);
      assert.ok(
        [401, 403, 404, 405].includes(response.status),
        `${path} ${response.status}`,
      );
    }
    const put = await http(
      "/api/admin/accounts/a-plain/capabilities",
      { capability: "d1.inspect" },
      KEYS.inspector,
      "PUT",
    );
    assert.ok([401, 403].includes(put.status));
    assert.equal(snapshot(world), before);

    assert.equal(
      (await mcp("sql", KEYS.inspector, { sql: "select 1" })).isError,
      true,
    );
    assert.equal(
      (await mcp(TOOLS[1], KEYS.inspector, { countyFips: ["08001"] })).isError,
      true,
    );
  });
});

test("inspection credential failures are denied: missing, invalid, expired, revoked, insufficient", async () => {
  await setup(async ({ mcp }) => {
    assert.equal((await mcp(TOOLS[0], null)).isError, true);
    assert.equal((await mcp(TOOLS[0], `cwa_${"Z".repeat(43)}`)).isError, true);
    assert.equal((await mcp(TOOLS[0], "not-a-credential")).isError, true);
    assert.equal((await mcp(TOOLS[0], KEYS.expired)).isError, true);
    assert.equal((await mcp(TOOLS[0], KEYS.revoked)).isError, true);
    assert.equal((await mcp(TOOLS[0], KEYS.plain)).isError, true);
    assert.equal((await mcp(TOOLS[0], KEYS.agentOwner)).isError, true);
    assert.notEqual((await mcp(TOOLS[0], KEYS.admin)).isError, true);
  });
});

test("revoking the grant or the identity removes access and keeps the grant history", async () => {
  await setup(async ({ world, accounts, owner, mcp }) => {
    await accounts.setAgentCapability(owner, "a-inspect", "d1.inspect", true);
    assert.notEqual((await mcp(TOOLS[0], KEYS.inspector)).isError, true);

    await accounts.setAgentCapability(owner, "a-inspect", "d1.inspect", false);
    assert.equal((await mcp(TOOLS[0], KEYS.inspector)).isError, true);
    assert.equal(
      world.database
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_capability_grants WHERE account_id='a-inspect' AND revoked_at IS NOT NULL",
        )
        .get().n,
      1,
    );

    await accounts.setAgentCapability(owner, "a-inspect", "d1.inspect", true);
    assert.notEqual((await mcp(TOOLS[0], KEYS.inspector)).isError, true);
    world.database.exec(
      "UPDATE identities SET revoked_at='2026-11-16T00:00:00.000Z', version=version+1 WHERE id='i-inspect'",
    );
    assert.equal((await mcp(TOOLS[0], KEYS.inspector)).isError, true);
  });
});

test("migration 0025 keeps existing grants and the table rules", async () => {
  await setup(async ({ world }) => {
    const row = world.database
      .prepare("SELECT COUNT(*) AS n FROM agent_capability_grants")
      .get();
    assert.equal(row.n, 2);
    assert.throws(() =>
      world.database.exec(
        "INSERT INTO agent_capability_grants (id, account_id, capability, granted_by_account_id, granted_at) VALUES ('x','a-plain','banner.manage','h-owner','2026-11-16T00:00:00.000Z')",
      ),
    );
    assert.throws(() =>
      world.database.exec(
        "INSERT INTO agent_capability_grants (id, account_id, capability, granted_by_account_id, granted_at) VALUES ('y','h-editor','d1.inspect','h-owner','2026-11-16T00:00:00.000Z')",
      ),
    );
    assert.throws(() =>
      world.database.exec("DELETE FROM agent_capability_grants"),
    );
  });
});

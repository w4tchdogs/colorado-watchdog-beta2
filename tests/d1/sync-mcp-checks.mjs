import { AsyncD1Database } from "../../src/database/d1.ts";
import { handleWebsiteMcpRequest } from "../../src/mcp/website.ts";
import { createSyncMcpBridge } from "../../src/mcp/website-sync.ts";
import { createD1AccountServices } from "../../src/services/d1-accounts.ts";
import {
  createAgentCredential,
  createTestHumanIdentityAdapter,
} from "../../src/services/security.ts";
import { createHostedSyncTransportDependencies } from "../../src/services/sync-hosted.ts";
import { mixedChangeset } from "../sync-scale-fixtures.mjs";

const ORIGIN = "https://watchdog.invalid";

/**
 * MCP-3 Profiles sync tools over the real hosted sync services and the
 * isolated local D1. The 816-operation synthetic changeset is committed as one
 * atomic batch, read back in pages, replayed, refused when changed, and
 * reversed. Synthetic accounts and records only.
 */
export async function runSyncMcpChecks(env) {
  const checks = [];
  const check = (name, passed, detail = "") => {
    if (!passed)
      throw new Error(`Sync MCP check failed: ${name} ${detail}`.trim());
    checks.push(name);
  };
  const count = async (table) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(
        [
          "organizations",
          "people",
          "positions",
          "role_sources",
          "person_roles",
          "sync_batches",
          "sync_batch_items",
          "sync_batch_reversals",
        ].map(count),
      ),
    );

  await env.DB.prepare(
    "INSERT INTO accounts (id, kind, role, display_name) VALUES ('smcp-owner', 'human', 'owner', 'Synthetic sync MCP owner')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO identities (id, account_id, provider, subject) VALUES ('smcp-owner-identity', 'smcp-owner', 'test-human', 'smcp-owner-subject')",
  ).run();
  const keys = {};
  for (const id of ["smcp-main", "smcp-other", "smcp-plain"]) {
    const credential = await createAgentCredential();
    keys[id] = credential.secret;
    await env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'agent', 'contributor', 'Synthetic sync MCP agent')",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES (?, ?, 'agent-key', ?, ?)",
    )
      .bind(`${id}-key`, id, `${id}-key`, credential.hash)
      .run();
  }
  const database = new AsyncD1Database(env.DB);
  const accounts = createD1AccountServices(
    database,
    createTestHumanIdentityAdapter({ "smcp-owner": "smcp-owner-subject" }),
  );
  const owner = await accounts.resolvePrincipal(
    new Request(ORIGIN, { headers: { "x-test-human-subject": "smcp-owner" } }),
  );
  check("synthetic owner resolves", !!owner);
  for (const id of ["smcp-main", "smcp-other"])
    for (const capability of ["sync.read", "sync.apply", "sync.revert"])
      await accounts.setAgentCapability(owner, id, capability, true);

  const bridge = createSyncMcpBridge(
    createHostedSyncTransportDependencies(database, accounts.hasCapability),
  );
  const inspection = {
    status: async () => ({}),
    migrationHistory: async () => ({}),
    countyReferenceCounts: async () => ({}),
    countyProvenanceSummary: async () => ({}),
  };
  let id = 0;
  const post = (who, text) =>
    handleWebsiteMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(who ? { authorization: `Bearer ${keys[who]}` } : {}),
        },
        body: text,
      }),
      accounts,
      inspection,
      undefined,
      bridge,
    );
  const envelope = (name, args) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          protocolVersion: "2026-07-28",
          clientInfo: { name: "synthetic", version: "1" },
        },
      },
    });
  const call = async (who, name, args) => {
    const response = await post(who, envelope(name, args));
    if (response.status !== 200) return { http: response.status };
    const result = (await response.json()).result;
    const parsed = JSON.parse(result.content[0].text);
    return result.isError ? { error: parsed } : { ok: parsed };
  };

  const prepared = mixedChangeset("commit", "d1-mcp");
  const size = new TextEncoder().encode(
    envelope("website_sync_commit", {
      idempotencyKey: "d1-mcp-1",
      changeset: prepared,
    }),
  ).byteLength;
  check("the request is larger than the small MCP cap", size > 24 * 1024);

  const empty = await snapshot();
  const base = {
    people: await count("people"),
    roles: await count("person_roles"),
    orgs: await count("organizations"),
    batches: await count("sync_batches"),
    items: await count("sync_batch_items"),
    reversals: await count("sync_batch_reversals"),
  };
  const denied = await post(
    "smcp-plain",
    envelope("website_sync_commit", {
      idempotencyKey: "d1-mcp-1",
      changeset: prepared,
    }),
  );
  check("an ungranted agent cannot send a large body", denied.status === 413);
  check(
    "an ungranted agent is denied each tool",
    (
      await call("smcp-plain", "website_sync_commit", {
        idempotencyKey: "d1-mcp-1",
        changeset: { a: 1 },
      })
    ).error?.error === "not_authorized" &&
      (await call("smcp-plain", "website_sync_lookup", { batchId: "x" })).error
        ?.error === "not_authorized",
  );
  check("denied calls wrote nothing", (await snapshot()) === empty);

  const dry = await call("smcp-main", "website_sync_dry_run", {
    changeset: prepared,
  });
  check(
    "dry run plans 816 items and writes nothing",
    dry.ok?.eligible === true &&
      dry.ok.itemCount === 816 &&
      dry.ok.items.length === 100 &&
      (await snapshot()) === empty,
    JSON.stringify(dry).slice(0, 300),
  );

  const committed = await call("smcp-main", "website_sync_commit", {
    idempotencyKey: "d1-mcp-1",
    changeset: prepared,
  });
  check(
    "one atomic commit of 816 operations",
    committed.ok?.status === "committed" && committed.ok.itemCount === 816,
    JSON.stringify(committed).slice(0, 300),
  );
  check(
    "all rows landed in one batch",
    (await count("people")) === base.people + 262 &&
      (await count("person_roles")) === base.roles + 503 &&
      (await count("sync_batches")) === base.batches + 1 &&
      (await count("sync_batch_items")) === base.items + 816,
  );
  const afterCommit = await snapshot();
  const batchId = committed.ok.batchId;

  const replay = await call("smcp-main", "website_sync_commit", {
    idempotencyKey: "d1-mcp-1",
    changeset: prepared,
  });
  check(
    "same-key replay returns the stored batch without writes",
    replay.ok?.replayed === true &&
      replay.ok.batchId === batchId &&
      (await snapshot()) === afterCommit,
  );
  const mismatch = await call("smcp-main", "website_sync_commit", {
    idempotencyKey: "d1-mcp-1",
    changeset: mixedChangeset("commit", "d1-mcp-changed"),
  });
  check(
    "a changed payload under the same key is rejected without writes",
    mismatch.error?.errors?.[0]?.code === "idempotency_mismatch" &&
      (await snapshot()) === afterCommit,
  );

  const items = [];
  for (let offset = 0; offset !== null; ) {
    const page = await call("smcp-main", "website_sync_lookup", {
      batchId,
      itemOffset: offset,
      itemLimit: 250,
    });
    items.push(...(page.ok?.items ?? []));
    offset = page.ok ? page.ok.nextItemOffset : null;
    if (!page.ok) check("every readback page succeeds", false);
  }
  check(
    "paged readback returns the complete receipt",
    items.length === 816 &&
      items.every((item, index) => item.itemIndex === index),
  );
  const sameItem = (left, right) =>
    [
      "itemIndex",
      "clientRef",
      "entity",
      "websiteId",
      "version",
      "outcome",
    ].every((field) => left[field] === right[field]);
  check(
    "the commit receipt's first page matches the readback",
    committed.ok.items.length === 100 &&
      committed.ok.items.every((item, index) => sameItem(item, items[index])),
  );
  check(
    "another agent cannot see or reverse the batch",
    (await call("smcp-other", "website_sync_lookup", { batchId })).error
      ?.error === "batch_not_found" &&
      (
        await call("smcp-other", "website_sync_reverse", {
          batchId,
          idempotencyKey: "d1-mcp-other-rev",
        })
      ).ok?.status !== "reverted" &&
      (await snapshot()) === afterCommit,
  );

  const reversed = await call("smcp-main", "website_sync_reverse", {
    batchId,
    idempotencyKey: "d1-mcp-rev-1",
  });
  check(
    "reversal removes the batch's records atomically",
    reversed.ok?.status === "reverted" &&
      (await count("people")) === base.people &&
      (await count("person_roles")) === base.roles &&
      (await count("organizations")) === base.orgs &&
      (await count("sync_batch_reversals")) === base.reversals + 1,
    JSON.stringify(reversed).slice(0, 300),
  );
  const replayReversal = await call("smcp-main", "website_sync_reverse", {
    batchId,
    idempotencyKey: "d1-mcp-rev-1",
  });
  check(
    "same-key reversal replays",
    replayReversal.ok?.replayed === true &&
      (await count("sync_batch_reversals")) === base.reversals + 1,
  );
  const after = await call("smcp-main", "website_sync_lookup", { batchId });
  check(
    "readback reports the reversal",
    after.ok?.status === "reverted" && !!after.ok.reversedAt,
  );

  await accounts.setAgentCapability(owner, "smcp-main", "sync.read", false);
  check(
    "a revoked read grant is denied, and the apply grant alone cannot plan",
    (await call("smcp-main", "website_sync_lookup", { batchId })).error
      ?.error === "not_authorized" &&
      (await call("smcp-main", "website_sync_dry_run", { changeset: prepared }))
        .error?.error === "not_authorized",
  );
  await accounts.setAgentCapability(owner, "smcp-main", "sync.apply", false);
  check(
    "with every changeset grant revoked the large body is refused unread",
    (
      await post(
        "smcp-main",
        envelope("website_sync_dry_run", { changeset: prepared }),
      )
    ).status === 413 && (await count("sync_batches")) === base.batches + 1,
  );
  return { checks };
}

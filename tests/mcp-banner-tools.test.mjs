import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/server/index.js";
import { createD1AccountServices } from "../dist/services/d1-accounts.js";
import {
  createTestHumanIdentityAdapter,
  hashCredential,
} from "../dist/services/security.js";
import { createWorld, ORIGIN } from "./auth-fixtures.mjs";
import { bannerAdminFixtures } from "./d1/banner-admin-fixtures.mjs";

// MCP-3 banner tools through the built Worker, a migrated synthetic database
// and an in-memory bucket. Images are generated. No approved artwork is read.

const KEYS = {
  stager: `cwa_${"S".repeat(43)}`,
  publisher: `cwa_${"B".repeat(43)}`,
  inspector: `cwa_${"I".repeat(43)}`,
  plain: `cwa_${"P".repeat(43)}`,
  agentAdmin: `cwa_${"A".repeat(43)}`,
  agentOwner: `cwa_${"O".repeat(43)}`,
};
const COUNTY = "08001";
const BANNER = "synthetic-mcp-banner";

class MemoryR2 {
  objects = new Map();
  async put(key, value, options) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key))
      return null;
    const body = new Uint8Array(value);
    const stored = { body, customMetadata: { ...options?.customMetadata } };
    this.objects.set(key, stored);
    return { size: body.byteLength, customMetadata: stored.customMetadata };
  }
  async get(key) {
    const o = this.objects.get(key);
    return o
      ? {
          size: o.body.byteLength,
          customMetadata: o.customMetadata,
          httpMetadata: {},
          arrayBuffer: async () => o.body.slice().buffer,
        }
      : null;
  }
  async head(key) {
    const o = this.objects.get(key);
    return o
      ? { size: o.body.byteLength, customMetadata: o.customMetadata }
      : null;
  }
  async list({ prefix }) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

const b64url = (text) =>
  Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function setup(callback) {
  const world = await createWorld();
  const bucket = new MemoryR2();
  world.env.BUCKET = bucket;
  try {
    const h = async (k) => `'${await hashCredential(KEYS[k])}'`;
    world.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES
        ('a-stager', 'agent', 'administrator', 'Synthetic Stager'),
        ('a-publisher', 'agent', 'contributor', 'Synthetic Banner Publisher'),
        ('a-inspector', 'agent', 'contributor', 'Synthetic Inspector'),
        ('a-plain', 'agent', 'contributor', 'Synthetic Plain Agent'),
        ('a-agent-admin', 'agent', 'administrator', 'Synthetic Agent Admin'),
        ('a-agent-owner', 'agent', 'owner', 'Synthetic Agent Owner');
      INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES
        ('i-stager', 'a-stager', 'agent-key', 'i-stager', ${await h("stager")}),
        ('i-publisher', 'a-publisher', 'agent-key', 'i-publisher', ${await h("publisher")}),
        ('i-inspector', 'a-inspector', 'agent-key', 'i-inspector', ${await h("inspector")}),
        ('i-plain', 'a-plain', 'agent-key', 'i-plain', ${await h("plain")}),
        ('i-agent-admin', 'a-agent-admin', 'agent-key', 'i-agent-admin', ${await h("agentAdmin")}),
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
    await accounts.setAgentCapability(owner, "a-inspector", "d1.inspect", true);

    const fetchWorker = (path, init = {}) =>
      worker.fetch(new Request(`${ORIGIN}${path}`, init), world.env);
    let rpcId = 0;
    const rpc = async (key, method, params, extra = {}) => {
      rpcId += 1;
      const response = await fetchWorker("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method,
          ...(params ? { params } : {}),
          ...extra,
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const META = {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "synthetic-client", version: "1.0.0" },
      clientCapabilities: {},
      "claudecode/toolUseId": "toolu_synthetic",
      progressToken: "progress-synthetic",
    };
    /** Calls a tool with the protocol 2026-07-28 `_meta` envelope. */
    const call = async (key, name, args) => {
      const body = await rpc(key, "tools/call", {
        name,
        arguments: args,
        _meta: META,
      });
      const result = body.result;
      const parsed = JSON.parse(result.content[0].text);
      return result.isError ? { error: parsed } : { ok: parsed };
    };
    const stage = async (sourceFilename, file, target, idempotencyKey) => {
      const response = await fetchWorker("/api/admin/banners/stage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEYS.stager}`,
          "content-type": "image/png",
          "x-banner-stage": b64url(
            JSON.stringify({
              bannerId: BANNER,
              countyFips: COUNTY,
              sourceFilename,
              idempotencyKey,
              expectedSha256: file.sha256,
              target,
            }),
          ),
        },
        body: Buffer.from(file.base64, "base64"),
      });
      const body = await response.json();
      assert.ok([200, 201].includes(response.status), JSON.stringify(body));
      return body;
    };
    await callback({
      world,
      bucket,
      accounts,
      owner,
      call,
      rpc,
      stage,
      fetchWorker,
    });
  } finally {
    world.database.close();
  }
}

const FIXTURES = bannerAdminFixtures();
const NEW_TARGET = {
  kind: "new",
  metadata: {
    caption: "Synthetic caption one",
    altText: "Synthetic generated bands for testing",
    displayOrder: 0,
    isPrimary: true,
    homepageOrder: null,
    displayMode: "cover",
    focalX: 0.5,
    focalY: 0.5,
  },
};
const BANNER_TABLES = [
  "banner_assets",
  "banner_asset_versions",
  "banner_publications",
  "banner_admin_operations",
  "audit_events",
  "agent_capability_grants",
];
const snapshot = (world) =>
  JSON.stringify(
    BANNER_TABLES.map((table) =>
      world.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ),
  );
const pngA = { ...FIXTURES.pngA };
const pngB = { ...FIXTURES.pngB };

test("tools/list names the inspection, banner and sync tools", async () => {
  await setup(async ({ rpc }) => {
    const listed = await rpc(null, "tools/list");
    const tools = listed.result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "website_inspection_status",
        "website_county_reference_counts",
        "website_migration_history",
        "website_county_provenance_summary",
        "website_banner_county",
        "website_banner_publications",
        "website_banner_publish",
        "website_banner_withdraw",
        "website_banner_restore",
        "website_sync_dry_run",
        "website_sync_commit",
        "website_sync_lookup",
        "website_sync_reverse",
      ],
    );
    for (const tool of tools)
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  });
});

test("MCP banner flow: protected stage, lookup, publish, replay, readback, withdraw and recorded restore", async () => {
  await setup(async ({ world, accounts, owner, call, stage, fetchWorker }) => {
    const first = await stage(
      "synthetic-one.png",
      pngA,
      NEW_TARGET,
      "stage-one",
    );
    assert.equal(first.verified, true);
    const v1 = first.version.id;

    // Without the grant the publisher cannot even read.
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_county", {
          countyFips: COUNTY,
        })
      ).error.error,
      "not_authorized",
    );
    await accounts.setAgentCapability(
      owner,
      "a-publisher",
      "banner.publish",
      true,
    );

    const county = await call(KEYS.publisher, "website_banner_county", {
      countyFips: COUNTY,
      bannerId: BANNER,
    });
    const banner = county.ok.banners[0];
    assert.equal(banner.id, BANNER);
    assert.equal(banner.status, "draft");
    assert.equal(banner.selectedVersionId, null);
    assert.equal(banner.versions[0].id, v1);
    assert.equal(banner.versions[0].state, "verified");
    const text = JSON.stringify(county.ok);
    for (const hidden of [
      "objectKey",
      "object_key",
      "sourceFilename",
      "stagedByAccountId",
      "synthetic-one.png",
      "banners/",
    ])
      assert.equal(text.includes(hidden), false, hidden);

    const publishArgs = {
      bannerId: BANNER,
      versionId: v1,
      expectedRowVersion: banner.rowVersion,
      idempotencyKey: "mcp-publish-one",
    };
    const published = await call(
      KEYS.publisher,
      "website_banner_publish",
      publishArgs,
    );
    assert.equal(published.ok.status, "active");
    assert.equal(published.ok.selectedVersionId, v1);
    assert.equal(published.ok.replayed, false);
    assert.equal(published.ok.rowVersion, banner.rowVersion + 1);
    const p1 = published.ok.publicationId;

    // Same-key replay changes nothing and returns the recorded result.
    const before = snapshot(world);
    const replay = await call(
      KEYS.publisher,
      "website_banner_publish",
      publishArgs,
    );
    assert.deepEqual(replay.ok, { ...published.ok, replayed: true });
    assert.equal(snapshot(world), before);
    // The same key with a different request is refused.
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_publish", {
          ...publishArgs,
          expectedRowVersion: published.ok.rowVersion,
        })
      ).error.error,
      "idempotency_conflict",
    );
    // A stale row version is refused under a new key.
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_publish", {
          ...publishArgs,
          idempotencyKey: "mcp-publish-stale",
        })
      ).error.error,
      "stale_version",
    );
    assert.equal(snapshot(world), before);

    // Public readback serves the selected version.
    const live = await fetchWorker(`/banner-assets/${v1}`);
    assert.equal(live.status, 200);
    assert.equal(
      Buffer.from(await live.arrayBuffer()).toString("base64"),
      pngA.base64,
    );

    // An unverified version is refused and changes nothing.
    world.database
      .prepare(
        `INSERT INTO banner_asset_versions (id, banner_id, source_filename, sha256, width, height, aspect_ratio, byte_size, media_type, object_key, state)
         VALUES ('synthetic-pending', ?, 'synthetic-pending.png', ?, 10, 10, 1, 10, 'image/png', 'synthetic/pending', 'pending')`,
      )
      .run(BANNER, "c".repeat(64));
    const withPending = snapshot(world);
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_publish", {
          bannerId: BANNER,
          versionId: "synthetic-pending",
          expectedRowVersion: published.ok.rowVersion,
          idempotencyKey: "mcp-publish-pending",
        })
      ).error.error,
      "version_not_publishable",
    );
    assert.equal(snapshot(world), withPending);

    // Replace with a second staged version, then read the history.
    const second = await stage(
      "synthetic-two.png",
      pngB,
      { kind: "existing", expectedRowVersion: published.ok.rowVersion },
      "stage-two",
    );
    const v2 = second.version.id;
    const replaced = await call(KEYS.publisher, "website_banner_publish", {
      bannerId: BANNER,
      versionId: v2,
      expectedRowVersion: published.ok.rowVersion,
      idempotencyKey: "mcp-publish-two",
      metadata: {
        caption: "Synthetic caption two",
        altText: "Second synthetic test image",
        displayMode: "contain",
        focalX: 0.25,
        focalY: 0.75,
      },
    });
    assert.equal(replaced.ok.selectedVersionId, v2);
    const history = await call(KEYS.publisher, "website_banner_publications", {
      bannerId: BANNER,
    });
    assert.deepEqual(
      history.ok.publications.map((p) => [p.versionId, p.origin]),
      [
        [v2, "publish"],
        [v1, "publish"],
      ],
    );
    assert.equal(
      JSON.stringify(history.ok).includes("publishedByAccountId"),
      false,
    );

    const withdrawn = await call(KEYS.publisher, "website_banner_withdraw", {
      bannerId: BANNER,
      expectedRowVersion: replaced.ok.rowVersion,
      idempotencyKey: "mcp-withdraw",
    });
    assert.equal(withdrawn.ok.status, "withdrawn");
    assert.notEqual((await fetchWorker(`/banner-assets/${v2}`)).status, 200);
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_withdraw", {
          bannerId: BANNER,
          expectedRowVersion: withdrawn.ok.rowVersion,
          idempotencyKey: "mcp-withdraw-again",
        })
      ).error.error,
      "invalid_state",
    );

    const restored = await call(KEYS.publisher, "website_banner_restore", {
      bannerId: BANNER,
      versionId: v1,
      expectedRowVersion: withdrawn.ok.rowVersion,
      idempotencyKey: "mcp-restore-one",
      publicationId: p1,
    });
    assert.equal(restored.ok.status, "active");
    assert.equal(restored.ok.selectedVersionId, v1);
    const after = await call(KEYS.publisher, "website_banner_county", {
      countyFips: COUNTY,
      bannerId: BANNER,
    });
    assert.equal(after.ok.banners[0].caption, "Synthetic caption one");
    assert.equal(after.ok.banners[0].rowVersion, restored.ok.rowVersion);
    const latest = (
      await call(KEYS.publisher, "website_banner_publications", {
        bannerId: BANNER,
      })
    ).ok.publications[0];
    assert.equal(latest.origin, "restore_recorded");
    assert.equal(latest.restoredFromPublicationId, p1);
    assert.equal((await fetchWorker(`/banner-assets/${v1}`)).status, 200);

    const audits = world.database
      .prepare(
        "SELECT action, actor_account_id FROM audit_events WHERE target_id = ? AND action IN ('banner.published','banner.withdrawn','banner.restored') ORDER BY rowid",
      )
      .all(BANNER);
    assert.deepEqual(
      audits.map((row) => [row.action, row.actor_account_id]),
      [
        ["banner.published", "a-publisher"],
        ["banner.published", "a-publisher"],
        ["banner.withdrawn", "a-publisher"],
        ["banner.restored", "a-publisher"],
      ],
    );
  });
});

test("banner tools deny missing, invalid, inspection-only, ungranted, owner and revoked credentials without changing data", async () => {
  await setup(async ({ world, accounts, owner, call, stage, fetchWorker }) => {
    const staged = await stage(
      "synthetic-one.png",
      pngA,
      NEW_TARGET,
      "stage-deny",
    );
    const rowVersion = world.database
      .prepare("SELECT version FROM banner_assets WHERE id = ?")
      .get(BANNER).version;
    const publish = (key, idempotencyKey) =>
      call(key, "website_banner_publish", {
        bannerId: BANNER,
        versionId: staged.version.id,
        expectedRowVersion: rowVersion,
        idempotencyKey,
      });
    const before = snapshot(world);
    const cases = [
      [null, "authentication_required"],
      [`cwa_${"Z".repeat(43)}`, "authentication_required"],
      ["not-a-credential", "authentication_required"],
      [KEYS.inspector, "not_authorized"],
      [KEYS.plain, "not_authorized"],
      [KEYS.agentAdmin, "not_authorized"],
      [KEYS.stager, "not_authorized"],
      [KEYS.agentOwner, "authentication_required"],
    ];
    for (const [key, code] of cases) {
      for (const tool of ["website_banner_county", "website_banner_publish"]) {
        const result =
          tool === "website_banner_publish"
            ? await publish(key, `deny-${code}`)
            : await call(key, tool, { countyFips: COUNTY });
        assert.equal(result.error?.error, code, `${tool} ${key}`);
      }
    }
    assert.equal(snapshot(world), before);

    // The inspection-only credential keeps the four MCP-2 tools and stays read-only.
    for (const tool of [
      "website_inspection_status",
      "website_county_reference_counts",
      "website_migration_history",
      "website_county_provenance_summary",
    ])
      assert.ok((await call(KEYS.inspector, tool, {})).ok, tool);

    // A banner.publish grant does not open the protected HTTP banner API or inspection.
    await accounts.setAgentCapability(
      owner,
      "a-publisher",
      "banner.publish",
      true,
    );
    for (const capability of [
      "banner.manage",
      "d1.inspect",
      "account.read",
      "audit.read",
      "sync.apply",
      "content.publish",
    ]) {
      const principal = await accounts.resolvePrincipal(
        new Request(ORIGIN, {
          headers: { authorization: `Bearer ${KEYS.publisher}` },
        }),
      );
      assert.equal(
        await accounts.hasCapability(principal, capability),
        false,
        capability,
      );
    }
    assert.equal(
      (await call(KEYS.publisher, "website_inspection_status", {})).error.error,
      "not_authorized",
    );
    const granted = snapshot(world);
    for (const [method, path] of [
      ["GET", "/api/admin/banners/counties"],
      ["GET", `/api/admin/banners/counties/${COUNTY}`],
      ["GET", `/api/admin/banners/versions/${staged.version.id}/image`],
      ["GET", `/api/admin/banners/${BANNER}/reconcile`],
      ["POST", `/api/admin/banners/${BANNER}/metadata`],
      ["POST", `/api/admin/banners/${BANNER}/publish`],
      ["POST", "/api/admin/banners/stage"],
    ]) {
      const response = await fetchWorker(path, {
        method,
        headers: {
          authorization: `Bearer ${KEYS.publisher}`,
          "content-type": path.endsWith("/stage")
            ? "image/png"
            : "application/json",
          ...(path.endsWith("/stage")
            ? {
                "x-banner-stage": b64url(
                  JSON.stringify({
                    bannerId: BANNER,
                    countyFips: COUNTY,
                    sourceFilename: "x.png",
                    idempotencyKey: "deny-stage",
                    target: NEW_TARGET,
                  }),
                ),
              }
            : {}),
        },
        ...(method === "POST"
          ? {
              body: path.endsWith("/stage")
                ? Buffer.from(pngB.base64, "base64")
                : "{}",
            }
          : {}),
      });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    assert.equal(snapshot(world), granted);

    // Revoking the grant removes access and keeps the grant history.
    await accounts.setAgentCapability(
      owner,
      "a-publisher",
      "banner.publish",
      false,
    );
    const revoked = snapshot(world);
    assert.equal(
      (await publish(KEYS.publisher, "deny-revoked")).error.error,
      "not_authorized",
    );
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_county", {
          countyFips: COUNTY,
        })
      ).error.error,
      "not_authorized",
    );
    assert.equal(snapshot(world), revoked);

    // A revoked credential is denied even with an active grant.
    await accounts.setAgentCapability(
      owner,
      "a-publisher",
      "banner.publish",
      true,
    );
    world.database.exec(
      "UPDATE identities SET revoked_at='2026-11-16T00:00:00.000Z', version=version+1 WHERE id='i-publisher'",
    );
    const identityRevoked = snapshot(world);
    assert.equal(
      (await publish(KEYS.publisher, "deny-identity")).error.error,
      "authentication_required",
    );
    assert.equal(snapshot(world), identityRevoked);
  });
});

test("banner tool inputs are closed: no actor, storage key, path, URL or extra field", async () => {
  await setup(async ({ world, accounts, owner, call, rpc }) => {
    await accounts.setAgentCapability(
      owner,
      "a-publisher",
      "banner.publish",
      true,
    );
    const before = snapshot(world);
    const base = {
      bannerId: BANNER,
      versionId: "v1",
      expectedRowVersion: 1,
      idempotencyKey: "closed-1",
    };
    for (const args of [
      { ...base, actorAccountId: "h-owner" },
      { ...base, accountId: "h-owner" },
      { ...base, objectKey: "banners/08001/x.png" },
      { ...base, path: "C:\\\\banners\\\\x.png" },
      { ...base, url: "https://example.test/x.png" },
      { ...base, bannerId: "../secret" },
      { ...base, bannerId: "https://example.test/x" },
      { ...base, bannerId: "stage" },
      { ...base, versionId: "banners/08001/x.png" },
      { ...base, expectedRowVersion: 0 },
      { ...base, expectedRowVersion: "1" },
      { ...base, idempotencyKey: "   " },
      {
        ...base,
        metadata: {
          caption: "",
          altText: "x",
          displayMode: "cover",
          focalX: 0.5,
          focalY: 0.5,
          objectKey: "k",
        },
      },
      {
        ...base,
        metadata: {
          caption: "",
          altText: " ",
          displayMode: "cover",
          focalX: 0.5,
          focalY: 0.5,
        },
      },
    ])
      assert.equal(
        (await call(KEYS.publisher, "website_banner_publish", args)).error
          .error,
        "invalid_arguments",
        JSON.stringify(args),
      );
    for (const [tool, args] of [
      ["website_banner_county", { countyFips: "09001" }],
      ["website_banner_county", { countyFips: COUNTY, sql: "select 1" }],
      ["website_banner_publications", {}],
      [
        "website_banner_restore",
        {
          ...base,
          metadata: {
            caption: "",
            altText: "x",
            displayMode: "cover",
            focalX: 0.5,
            focalY: 0.5,
          },
        },
      ],
      ["website_banner_withdraw", { ...base }],
    ])
      assert.equal(
        (await call(KEYS.publisher, tool, args)).error.error,
        "invalid_arguments",
        tool,
      );
    // Extra params keys other than the `_meta` envelope are still refused.
    const extra = await rpc(KEYS.publisher, "tools/call", {
      name: "website_banner_county",
      arguments: { countyFips: COUNTY },
      actor: "h-owner",
    });
    assert.equal(extra.error.message, "invalid_params");
    assert.equal(snapshot(world), before);
    // An unknown county is not found.
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_county", {
          countyFips: "08999",
        })
      ).error.error,
      "not_found",
    );
  });
});

test("banner tools report unavailable without a bucket, after authorization", async () => {
  await setup(async ({ world, accounts, owner, call }) => {
    delete world.env.BUCKET;
    assert.equal(
      (await call(null, "website_banner_county", { countyFips: COUNTY })).error
        .error,
      "authentication_required",
    );
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_county", {
          countyFips: COUNTY,
        })
      ).error.error,
      "not_authorized",
    );
    await accounts.setAgentCapability(
      owner,
      "a-publisher",
      "banner.publish",
      true,
    );
    assert.equal(
      (
        await call(KEYS.publisher, "website_banner_county", {
          countyFips: COUNTY,
        })
      ).error.error,
      "banner_admin_unavailable",
    );
  });
});

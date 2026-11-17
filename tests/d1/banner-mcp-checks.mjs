import { handleWebsiteMcpRequest } from "../../src/mcp/website.ts";
import { D1BannerAdministration } from "../../src/services/banner-admin-d1.ts";
import { D1BannerPublicService } from "../../src/services/banner-public.ts";
import { R2BannerObjectStorage } from "../../src/services/banner-storage.ts";
import { createD1AccountServices } from "../../src/services/d1-accounts.ts";
import {
  createAgentCredential,
  createTestHumanIdentityAdapter,
} from "../../src/services/security.ts";
import {
  BANNER_STAGE_HEADER,
  createBannerAdminApiTransport,
} from "../../src/transport/banner-admin-api.ts";
import { MemoryR2, RevokingDatabase } from "./banner-admin-checks.mjs";

const ORIGIN = "https://watchdog.invalid";
const COUNTY = "08029";
const BANNER = "mcp-synthetic";
const b64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const b64url = (text) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * MCP-3: the Website MCP banner tools over the real banner service, the
 * isolated local D1 and an in-memory bucket. Images are staged through the
 * protected banner API. Synthetic images and accounts only.
 */
export async function runBannerMcpChecks(env, fixtures) {
  const checks = [];
  const check = (name, passed, detail = "") => {
    if (!passed)
      throw new Error(`Banner MCP check failed: ${name} ${detail}`.trim());
    checks.push(name);
  };
  const files = Object.fromEntries(
    Object.entries(fixtures).map(([name, file]) => [
      name,
      { ...file, bytes: b64(file.base64) },
    ]),
  );
  const rows = async (query, ...values) =>
    (
      await env.DB.prepare(query)
        .bind(...values)
        .all()
    ).results;
  const snapshot = async () =>
    JSON.stringify([
      await rows("SELECT * FROM banner_assets WHERE id = ?", BANNER),
      await rows(
        "SELECT * FROM banner_publications WHERE banner_id = ? ORDER BY sequence",
        BANNER,
      ),
      await rows("SELECT COUNT(*) AS n FROM banner_admin_operations"),
      await rows("SELECT COUNT(*) AS n FROM audit_events"),
    ]);

  await env.DB.prepare(
    "INSERT INTO accounts (id, kind, role, display_name) VALUES ('mcp-owner', 'human', 'owner', 'Synthetic MCP owner')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO identities (id, account_id, provider, subject) VALUES ('mcp-owner-identity', 'mcp-owner', 'test-human', 'mcp-owner-subject')",
  ).run();
  const keys = {};
  for (const [id, role] of [
    ["mcp-stager", "administrator"],
    ["mcp-publisher", "contributor"],
    ["mcp-inspector", "contributor"],
    ["mcp-admin-agent", "administrator"],
  ]) {
    const credential = await createAgentCredential();
    keys[id] = credential.secret;
    await env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'agent', ?, 'Synthetic MCP agent')",
    )
      .bind(id, role)
      .run();
    await env.DB.prepare(
      "INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES (?, ?, 'agent-key', ?, ?)",
    )
      .bind(`${id}-key`, id, `${id}-key`, credential.hash)
      .run();
  }

  const bucket = new MemoryR2();
  const storage = new R2BannerObjectStorage(bucket);
  const db = new RevokingDatabase(env.DB);
  const accounts = createD1AccountServices(
    db,
    createTestHumanIdentityAdapter({ "mcp-owner": "mcp-owner-subject" }),
  );
  const owner = await accounts.resolvePrincipal(
    new Request(ORIGIN, { headers: { "x-test-human-subject": "mcp-owner" } }),
  );
  check("synthetic owner resolves", !!owner);
  const administration = new D1BannerAdministration(db, storage);
  const publicReads = new D1BannerPublicService(db, bucket);
  const api = createBannerAdminApiTransport({
    resolvePrincipal: accounts.resolvePrincipal,
    authorize: (principal) =>
      accounts.hasCapability(principal, "banner.manage"),
    administration,
  });
  const inspection = {
    status: async () => ({ inspected: true }),
    migrationHistory: async () => ({ inspected: true }),
    countyReferenceCounts: async () => ({ inspected: true }),
    countyProvenanceSummary: async () => ({ inspected: true }),
  };
  let id = 0;
  const call = async (who, name, args) => {
    id += 1;
    const response = await handleWebsiteMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(who ? { authorization: `Bearer ${keys[who] ?? who}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              protocolVersion: "2026-07-28",
              clientInfo: { name: "synthetic", version: "1" },
              "claudecode/toolUseId": "toolu_synthetic",
              progressToken: "p",
            },
          },
        }),
      }),
      accounts,
      inspection,
      administration,
    );
    const body = await response.json();
    const parsed = JSON.parse(body.result.content[0].text);
    return body.result.isError ? { error: parsed.error } : { ok: parsed };
  };
  const stage = async (file, target, idempotencyKey) => {
    const response = await api.fetch(
      new Request(`${ORIGIN}/api/admin/banners/stage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${keys["mcp-stager"]}`,
          "content-type": "image/png",
          [BANNER_STAGE_HEADER]: b64url(
            JSON.stringify({
              bannerId: BANNER,
              countyFips: COUNTY,
              sourceFilename: "synthetic-mcp.png",
              idempotencyKey,
              target,
            }),
          ),
        },
        body: file.bytes,
      }),
    );
    return { status: response.status, body: await response.json() };
  };

  const one = await stage(
    files.mcpPng,
    {
      kind: "new",
      metadata: {
        caption: "Synthetic MCP caption",
        altText: "Synthetic MCP test image",
        displayOrder: 0,
        isPrimary: true,
        displayMode: "cover",
        focalX: 0.5,
        focalY: 0.5,
      },
    },
    "mcp-stage-one",
  );
  check(
    "image staged and verified through the protected API",
    one.status === 201 && one.body.verified === true,
    JSON.stringify(one),
  );
  const v1 = one.body.version.id;

  await accounts.setAgentCapability(owner, "mcp-inspector", "d1.inspect", true);
  const fresh = await snapshot();
  for (const [who, code] of [
    [null, "authentication_required"],
    ["mcp-inspector", "not_authorized"],
    ["mcp-admin-agent", "not_authorized"],
    ["mcp-stager", "not_authorized"],
  ]) {
    const result = await call(who, "website_banner_publish", {
      bannerId: BANNER,
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "mcp-denied",
    });
    check(
      `publish denied for ${who ?? "no credential"}`,
      result.error === code,
      JSON.stringify(result),
    );
  }
  check(
    "inspection-only credential still runs an MCP-2 tool",
    !!(await call("mcp-inspector", "website_inspection_status", {})).ok,
  );
  check("denied calls changed nothing", (await snapshot()) === fresh);

  await accounts.setAgentCapability(
    owner,
    "mcp-publisher",
    "banner.publish",
    true,
  );
  const county = await call("mcp-publisher", "website_banner_county", {
    countyFips: COUNTY,
  });
  const banner = county.ok?.banners.find((b) => b.id === BANNER);
  check(
    "granted lookup reads the staged draft without storage details",
    banner?.status === "draft" &&
      banner.versions[0]?.id === v1 &&
      !JSON.stringify(county.ok).includes("object"),
    JSON.stringify(county),
  );
  const args = {
    bannerId: BANNER,
    versionId: v1,
    expectedRowVersion: banner.rowVersion,
    idempotencyKey: "mcp-publish",
  };
  const published = await call("mcp-publisher", "website_banner_publish", args);
  check(
    "publish succeeds",
    published.ok?.status === "active",
    JSON.stringify(published),
  );
  const afterPublish = await snapshot();
  const replay = await call("mcp-publisher", "website_banner_publish", args);
  check(
    "same-key replay returns the recorded result and changes nothing",
    replay.ok?.replayed === true &&
      replay.ok.publicationId === published.ok.publicationId &&
      (await snapshot()) === afterPublish,
  );
  const stale = await call("mcp-publisher", "website_banner_publish", {
    ...args,
    idempotencyKey: "mcp-stale",
  });
  check("stale row version is refused", stale.error === "stale_version");
  const missing = await call("mcp-publisher", "website_banner_publish", {
    ...args,
    versionId: "mcp-no-such-version",
    expectedRowVersion: published.ok.rowVersion,
    idempotencyKey: "mcp-unverified",
  });
  check(
    "an unverified or unknown version is refused",
    missing.error === "version_not_publishable",
  );
  check("refused writes changed nothing", (await snapshot()) === afterPublish);
  check(
    "public readback serves the published version",
    (await publicReads.deliver(v1)) !== null,
  );

  // Revoke the grant between the service's permission check and its batch.
  const beforeRevoke = await snapshot();
  db.hook = () =>
    accounts.setAgentCapability(
      owner,
      "mcp-publisher",
      "banner.publish",
      false,
    );
  const raced = await call("mcp-publisher", "website_banner_withdraw", {
    bannerId: BANNER,
    expectedRowVersion: published.ok.rowVersion,
    idempotencyKey: "mcp-withdraw",
  });
  db.hook = null;
  const afterRace = JSON.parse(await snapshot());
  const expected = JSON.parse(beforeRevoke);
  check(
    "a grant revoked during the write stops it and leaves the banner unchanged",
    raced.error === "not_authorized" &&
      JSON.stringify(afterRace.slice(0, 3)) ===
        JSON.stringify(expected.slice(0, 3)),
    JSON.stringify(raced),
  );
  check(
    "revoked grant is denied on the next call",
    (
      await call("mcp-publisher", "website_banner_county", {
        countyFips: COUNTY,
      })
    ).error === "not_authorized",
  );

  await accounts.setAgentCapability(
    owner,
    "mcp-publisher",
    "banner.publish",
    true,
  );
  const withdrawn = await call("mcp-publisher", "website_banner_withdraw", {
    bannerId: BANNER,
    expectedRowVersion: published.ok.rowVersion,
    idempotencyKey: "mcp-withdraw",
  });
  check(
    "the failed attempt's key stays usable once granted again",
    withdrawn.ok?.status === "withdrawn" && withdrawn.ok.replayed === false,
  );
  check(
    "public delivery stops after withdrawal",
    (await publicReads.deliver(v1)) === null,
  );
  const restored = await call("mcp-publisher", "website_banner_restore", {
    bannerId: BANNER,
    versionId: v1,
    expectedRowVersion: withdrawn.ok.rowVersion,
    idempotencyKey: "mcp-restore",
    publicationId: published.ok.publicationId,
  });
  check(
    "restore of the recorded publication reactivates the banner",
    restored.ok?.status === "active" && restored.ok.selectedVersionId === v1,
  );
  const history = await call("mcp-publisher", "website_banner_publications", {
    bannerId: BANNER,
  });
  check(
    "history shows the publish and the recorded restore",
    JSON.stringify(history.ok?.publications.map((p) => p.origin)) ===
      JSON.stringify(["restore_recorded", "publish"]),
  );
  const audits = await rows(
    "SELECT action FROM audit_events WHERE target_id = ? AND actor_account_id = 'mcp-publisher' ORDER BY rowid",
    BANNER,
  );
  check(
    "each change was audited under the trusted agent account",
    JSON.stringify(audits.map((a) => a.action)) ===
      JSON.stringify([
        "banner.published",
        "banner.withdrawn",
        "banner.restored",
      ]),
  );
  return { checks };
}

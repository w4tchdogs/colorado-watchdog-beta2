import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = join(root, "wrangler.sites-test.toml");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const persist = mkdtempSync(join(tmpdir(), "watchdog-sites-d1-"));
let worker;

function cleanup() {
  try {
    rmSync(persist, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 250,
    });
  } catch (error) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    console.warn(
      "Wrangler still holds a disposable local-state file; operating-system temp cleanup will remove it after release.",
    );
  }
}

function command(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
  });
  if (result.status !== 0)
    throw new Error(
      `Wrangler failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (worker.exitCode !== null)
      throw new Error(`Wrangler exited early with ${worker.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {}
    await delay(200);
  }
  throw new Error("The local Sites Worker did not start");
}

async function main() {
  const agentToken = `cwa_${"A".repeat(43)}`;
  const { hashCredential } = await import(
    pathToFileURL(join(root, "dist", "services", "security.js"))
  );
  const agentHash = await hashCredential(agentToken);
  const migrations = [
    "0001_counties.sql",
    "0002_foundation.sql",
    "0003_county_fips_prefix.sql",
    "0004_m1_county_roles.sql",
    "0005_m2_sync_batches.sql",
    "0006_m2_sync_reversals.sql",
    "0007_m2_duplicate_flags.sql",
    "0008_duplicate_flag_observations.sql",
    "0009_content_foundation.sql",
    "0010_content_revisions.sql",
    "0011_m2_dependency_generation.sql",
    "0012_banner_assets.sql",
    "0013_private_report_intake.sql",
  ];
  const migrationFile = join(persist, "website-migrations.sql");
  writeFileSync(
    migrationFile,
    migrations
      .map((name) =>
        readFileSync(join(root, "website", "migrations", name), "utf8"),
      )
      .join("\n"),
  );
  command([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    persist,
    "--file",
    migrationFile,
  ]);

  const fixture = join(persist, "synthetic-public-records.sql");
  writeFileSync(
    fixture,
    `
    INSERT INTO organizations (id,name,organization_type,county_fips) VALUES
      ('d1-test-county-org','Synthetic Adams County','county_government','08001'),
      ('d1-test-partner','Synthetic Regional Partner','partner',NULL);
    INSERT INTO organization_county_affiliations (id,organization_id,county_fips,relationship_type)
      VALUES ('d1-test-affiliation','d1-test-partner','08001','serves');
    INSERT INTO people (id,display_name) VALUES
      ('d1-test-person-a','Synthetic Person A'),('d1-test-person-b','Synthetic Person B');
    INSERT INTO positions (id,organization_id,title) VALUES
      ('d1-test-position-a','d1-test-county-org','Synthetic Clerk'),
      ('d1-test-position-b','d1-test-partner','Synthetic Liaison');
    INSERT INTO role_sources (id,url,title,source_type) VALUES
      ('d1-test-source-a','https://example.test/adams','Synthetic official roster','official_page'),
      ('d1-test-source-b','https://example.test/partner','Synthetic partner roster','public_document');
    WITH RECURSIVE extra_people(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM extra_people WHERE n < 25)\n    INSERT INTO people (id,display_name) SELECT printf('synthetic-page-%02d',n),printf('Synthetic Directory %02d',n) FROM extra_people;\n    INSERT INTO person_roles (id,person_id,position_id,source_id,start_date,source_checked_at) VALUES
      ('d1-test-role-a','d1-test-person-a','d1-test-position-a','d1-test-source-a','2025-01-01','2026-10-01T00:00:00.000Z'),
      ('d1-test-role-b','d1-test-person-b','d1-test-position-b','d1-test-source-b','2025-02-01','2026-10-02T00:00:00.000Z');
    INSERT INTO accounts (id,kind,role,display_name) VALUES
      ('d1-test-admin','agent','administrator','Synthetic Sites Admin');
    INSERT INTO identities (id,account_id,provider,subject,credential_hash) VALUES
      ('d1-test-admin-key','d1-test-admin','agent-key','d1-test-admin-key','${agentHash}');
  `,
  );
  command([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    persist,
    "--file",
    fixture,
  ]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  worker = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--config",
      config,
      "--persist-to",
      persist,
    ],
    {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  try {
    await waitFor(`${base}/`);
    const homepage = await fetch(base);
    const homeHtml = await homepage.text();
    assert.match(homeHtml, /64 counties/);
    assert.match(homeHtml, /data-banner-count="0"/);

    const county = await fetch(`${base}/counties/08001`);
    const countyHtml = await county.text();
    assert.equal(county.status, 200, countyHtml);
    assert.match(countyHtml, /Synthetic Adams County/);
    assert.match(countyHtml, /Synthetic Regional Partner/);
    assert.match(countyHtml, /Synthetic official roster/);

    const directory = await fetch(`${base}/people?query=Synthetic`);
    const directoryHtml = await directory.text();
    assert.equal(directory.status, 200);
    assert.match(directoryHtml, /Synthetic Directory 01/);
    const next =
      directoryHtml.match(/href="([^"]+cursor=[^"]+)"[^>]*rel="next"/)?.[1] ??
      directoryHtml.match(/rel="next"[^>]*href="([^"]+)"/)?.[1];
    assert.ok(next, "first directory page has a next link");
    const nextPage = await fetch(new URL(next.replaceAll("&amp;", "&"), base));
    assert.equal(nextPage.status, 200);

    const person = await fetch(`${base}/people/d1-test-person-a`);
    assert.match(await person.text(), /Synthetic Clerk/);
    const organization = await fetch(
      `${base}/organizations/d1-test-county-org`,
    );
    assert.match(await organization.text(), /Synthetic Clerk/);

    for (const [path, type] of [
      ["/assets/site.css", "text/css"],
      ["/assets/site.js", "text/javascript"],
      ["/assets/brand-logo-white.png", "image/png"],
      ["/assets/brand-logo-white-large.png", "image/png"],
      ["/assets/brand-mascot-standing.png", "image/png"],
      ["/assets/brand-mascot-sit-alert.png", "image/png"],
      ["/assets/brand-mascot-lying.png", "image/png"],
      ["/assets/favicon-light.png", "image/png"],
      ["/assets/favicon-dark.png", "image/png"],
    ]) {
      const asset = await fetch(`${base}${path}`);
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get("content-type") ?? "", new RegExp(type));
      assert.ok(
        Number(asset.headers.get("content-length") ?? 0) > 0 ||
          (await asset.arrayBuffer()).byteLength > 0,
      );
    }

    const emptyCounty = await fetch(`${base}/counties/08003`);
    assert.match(await emptyCounty.text(), /class="empty-state"/);
    assert.equal((await fetch(`${base}/_internal/live`)).status, 200);
    assert.equal((await fetch(`${base}/_internal/ready`)).status, 200);
    assert.equal((await fetch(`${base}/_internal/health`)).status, 200);
    assert.equal(
      (await fetch(`${base}/api/people?query=Synthetic`)).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const forgedIdentity = await fetch(`${base}/_internal/principal`, {
      headers: {
        "oai-authenticated-user-id": "forged-user",
        "oai-authenticated-user-email": "owner@example.test",
      },
    });
    assert.equal(forgedIdentity.status, 401);
    const adminHeaders = { authorization: `Bearer ${agentToken}` };
    const principal = await fetch(`${base}/_internal/principal`, {
      headers: adminHeaders,
    });
    assert.equal(principal.status, 200);
    assert.equal((await principal.json()).role, "administrator");
    assert.equal(
      (await fetch(`${base}/admin/accounts`, { headers: adminHeaders })).status,
      200,
    );
    const accountList = await fetch(`${base}/api/admin/accounts?limit=10`, {
      headers: adminHeaders,
    });
    assert.equal(accountList.status, 200);
    assert.doesNotMatch(await accountList.text(), /credential_hash/);
    const created = await fetch(`${base}/api/admin/accounts`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        origin: base,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "agent",
        role: "contributor",
        displayName: "Synthetic Sites Account",
      }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const account = await created.json();
    assert.equal(account.version, 1);
    const accountUrl = `${base}/api/admin/accounts/${account.id}`;
    const detail = await fetch(accountUrl, { headers: adminHeaders });
    assert.equal(detail.status, 200);
    assert.doesNotMatch(await detail.text(), /credential_hash/);
    const updated = await fetch(accountUrl, {
      method: "PATCH",
      headers: {
        ...adminHeaders,
        origin: base,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedVersion: 1,
        displayName: "Updated synthetic agent",
      }),
    });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await updated.json()).version, 2);
    const audit = await fetch(`${accountUrl}/audit`, { headers: adminHeaders });
    assert.equal(audit.status, 200);
    assert.match(await audit.text(), /account.create/);
    const credentialResponse = await fetch(`${accountUrl}/credentials`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        origin: base,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(
      credentialResponse.status,
      201,
      await credentialResponse.clone().text(),
    );
    const issued = await credentialResponse.json();
    const agentHeaders = { authorization: `Bearer ${issued.secret}` };
    const newAgentPrincipal = await fetch(`${base}/_internal/principal`, {
      headers: agentHeaders,
    });
    assert.equal(newAgentPrincipal.status, 200);
    assert.equal((await newAgentPrincipal.json()).role, "contributor");
    const revoke = await fetch(
      `${accountUrl}/identities?id=${encodeURIComponent(issued.identityId)}&version=1`,
      {
        method: "DELETE",
        headers: { ...adminHeaders, origin: base },
      },
    );
    assert.equal(revoke.status, 200, await revoke.clone().text());
    assert.equal(
      (await fetch(`${base}/_internal/principal`, { headers: agentHeaders }))
        .status,
      401,
    );
    assert.equal((await fetch(`${base}/assets/not-allowed.txt`)).status, 404);
    assert.equal((await fetch(`${base}/api/reports`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/reports?status=pending`)).status,
      404,
    );
  } finally {
    worker.kill("SIGTERM");
    await new Promise((resolveExit) => worker.once("exit", resolveExit));
    cleanup();
  }

  const modulePath = join(root, "dist", "server", "index.js");
  const bundle = readFileSync(modulePath, "utf8");
  assert.doesNotMatch(
    bundle,
    /sql\.wasm|node_modules[\\/]sql\.js|research\/database/,
  );
  const siteWorker = await import(pathToFileURL(modulePath));
  assert.equal(
    (
      await siteWorker.default.fetch(
        new Request("https://site.test/_internal/live"),
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await siteWorker.default.fetch(
        new Request("https://site.test/_internal/ready"),
        {},
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await siteWorker.default.fetch(
        new Request("https://site.test/counties"),
        {},
      )
    ).status,
    503,
  );
  console.log(
    `Sites Worker D1 smoke check passed (${migrations.length} migrations, 64 counties, public routes/assets, agent account lifecycle, forged-identity rejection, no public reports route, and missing-binding behavior).`,
  );
}

main().catch((error) => {
  if (worker && worker.exitCode === null) worker.kill("SIGTERM");
  cleanup();
  console.error(error);
  process.exitCode = 1;
});

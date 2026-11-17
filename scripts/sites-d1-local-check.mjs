import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runHumanSignInChecks,
  SIGN_IN_CLIENT_SECRET,
  SIGN_IN_ISSUER,
  SIGN_IN_SEED_SQL,
  startSyntheticTenant,
} from "../tests/d1/human-sign-in-checks.mjs";

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

async function verifyPublication(
  base,
  { editorToken, contributorToken, disabledToken },
) {
  const root = `${base}/internal/content/publication`;
  const draft = {
    id: "fictional-story",
    expectedVersion: 1,
    expectedPublicationVersion: 0,
  };
  const story = {
    ...draft,
    slug: "fictional-river",
    metadata: {
      byline: "Fictional Reporter",
      pathway: "local-series",
      series: { slug: "river-series", label: "River Series" },
      topics: [{ slug: "water", label: "Water" }],
      sources: [
        {
          title: "Fictional meeting minutes",
          url: "https://example.test/minutes",
        },
      ],
    },
  };
  const change = (action, input, token = editorToken) =>
    fetch(`${root}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
  const privateDrafts = await fetch(`${base}/internal/content/drafts/list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${editorToken}`,
    },
    body: "{}",
  });
  assert.equal(privateDrafts.status, 404);
  const read = (path) => fetch(`${base}${path}`);
  const reject = async (action, input, status, error, token) => {
    const response = await change(action, input, token);
    assert.equal(response.status, status, await response.clone().text());
    assert.deepEqual(await response.json(), { error });
  };
  const publish = async (input) => {
    const response = await change("publish", input);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  assert.match(await (await read("/stories")).text(), /No stories yet/);
  assert.equal((await read("/stories/fictional-river")).status, 404);
  await reject("publish", story, 401, "authentication_required", null);
  await reject("publish", story, 401, "authentication_required", disabledToken);
  await reject(
    "publish",
    story,
    401,
    "authentication_required",
    `cwa_${"Z".repeat(43)}`,
  );
  await reject("publish", story, 403, "forbidden", contributorToken);
  await reject(
    "publish",
    { ...story, slug: "river--committee" },
    400,
    "invalid_request",
  );
  await reject(
    "publish",
    { ...story, authorId: "d1-test-editor" },
    400,
    "invalid_request",
  );
  await reject(
    "publish",
    { ...story, expectedVersion: 2 },
    409,
    "version_conflict",
  );
  await reject(
    "publish",
    {
      ...story,
      metadata: {
        ...story.metadata,
        sources: [{ title: "Malformed", url: "https://example.test\\bad" }],
      },
    },
    400,
    "invalid_request",
  );

  const competing = await Promise.all([
    change("publish", story),
    change("publish", story),
  ]);
  competing.sort((a, b) => a.status - b.status);
  assert.equal(competing[0].status, 200, await competing[0].clone().text());
  assert.deepEqual(await competing[0].json(), {
    contentId: story.id,
    slug: story.slug,
    publicationVersion: 1,
    revisionVersion: 1,
    status: "published",
  });
  assert.equal(competing[1].status, 409);
  assert.deepEqual(await competing[1].json(), { error: "version_conflict" });
  await reject(
    "publish",
    { ...story, expectedPublicationVersion: 1 },
    409,
    "invalid_state",
  );
  await reject(
    "publish",
    { ...story, id: "other-story" },
    409,
    "slug_conflict",
  );
  const posts = {
    ...story,
    id: "fictional-post",
    metadata: { byline: "Fictional Reporter" },
  };
  await publish(posts);
  assert.match(await (await read("/posts")).text(), /Fictional Dispatch/);
  assert.equal((await read("/posts/fictional-river")).status, 200);

  const article = await read("/stories/fictional-river");
  assert.equal(article.status, 200);
  assert.equal(article.headers.get("cache-control"), "no-store");
  const detail = await article.text();
  assert.match(detail, /<strong>synthetic watershed<\/strong>/);
  assert.match(detail, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(detail, /https:\/\/example\.test\/records/);
  assert.match(detail, /https:\/\/example\.test\/minutes/);
  assert.match(detail, /\/counties\/08001/);
  assert.match(detail, /\/people\/d1-test-person-a/);
  assert.match(detail, /\/organizations\/d1-test-county-org/);
  assert.doesNotMatch(
    detail,
    /javascript:|Unpublished|publicationVersion|d1-test-editor/,
  );
  const listing = await (
    await read(
      "/stories?q=synthetic+watershed&pathway=local-series&county=08001&series=river-series&topic=water",
    )
  ).text();
  assert.match(listing, /Fictional River Committee/);
  assert.doesNotMatch(listing, /Unpublished Canary|Another fictional Story/);
  assert.doesNotMatch(
    await (await read("/stories?q=secret+phrase")).text(),
    /Unpublished Canary/,
  );
  assert.match(await (await read("/")).text(), /Fictional River Committee/);
  assert.equal((await read("/stories/private-story")).status, 404);
  assert.equal((await read("/stories/%E0%A4")).status, 404);

  await reject(
    "withdraw",
    { ...draft, expectedPublicationVersion: 2 },
    409,
    "version_conflict",
  );
  const withdrawal = { ...draft, expectedPublicationVersion: 1 };
  const withdrawn = await change("withdraw", withdrawal);
  assert.equal(withdrawn.status, 200);
  assert.equal((await withdrawn.json()).status, "withdrawn");
  assert.equal((await read("/stories/fictional-river")).status, 404);
  assert.match(await (await read("/stories")).text(), /No stories yet/);
  assert.doesNotMatch(
    await (await read("/")).text(),
    /Fictional River Committee/,
  );
  await reject(
    "withdraw",
    { ...withdrawal, expectedPublicationVersion: 2 },
    409,
    "invalid_state",
  );
  await reject(
    "publish",
    { ...story, id: "other-story" },
    409,
    "slug_conflict",
  );
  const republished = await publish({
    ...story,
    expectedPublicationVersion: 2,
  });
  assert.equal(republished.publicationVersion, 3);
  assert.equal((await read("/stories/fictional-river")).status, 200);
  assert.equal(
    (await change("withdraw", { ...withdrawal, id: posts.id })).status,
    200,
  );
  assert.match(await (await read("/posts")).text(), /No posts yet/);
}

/** Banner administration through the bundled Worker, local D1 and local R2 simulation. */
async function verifyBannerAdmin(
  base,
  { agentToken, ownerToken, editorToken, contributorToken, disabledToken },
) {
  const { default: pngjs } = await import("pngjs");
  const { createHash } = await import("node:crypto");
  const makePng = (width, height, seed) => {
    const image = new pngjs.PNG({ width, height });
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        image.data[i] = (x * 5 + seed * 29) & 255;
        image.data[i + 1] = (y * 7 + seed * 53) & 255;
        image.data[i + 2] = ((x + y) * 3 + seed * 11) & 255;
        image.data[i + 3] = 255;
      }
    return new Uint8Array(pngjs.PNG.sync.write(image));
  };
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const imageOne = makePng(64, 24, 41);
  const imageTwo = makePng(72, 28, 42);
  const root = `${base}/api/admin/banners`;
  const as = (token) => (token ? { authorization: `Bearer ${token}` } : {});
  const call = async (
    method,
    path,
    token,
    { json, body, headers = {} } = {},
  ) => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        ...as(token),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: json === undefined ? body : JSON.stringify(json),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      body: type.startsWith("application/json")
        ? JSON.parse(new TextDecoder().decode(bytes))
        : null,
    };
  };
  const stage = (meta, token, bytes, type = "image/png") =>
    call("POST", "/stage", token, {
      body: bytes,
      headers: {
        "content-type": type,
        "x-banner-stage": Buffer.from(JSON.stringify(meta)).toString(
          "base64url",
        ),
      },
    });
  const COUNTY = "08005";
  const FIRST = {
    caption: "Synthetic first caption",
    altText: "Synthetic first alt text",
    displayMode: "cover",
    focalX: 0.25,
    focalY: 0.75,
  };
  const SECOND = {
    caption: "Synthetic second caption",
    altText: "Synthetic second alt text",
    displayMode: "contain",
    focalX: 0.6,
    focalY: 0.4,
  };

  // Denial: anonymous, invalid and disabled credentials, and every lower role.
  const reads = [
    "/counties",
    `/counties/${COUNTY}`,
    "/probe/publications",
    "/probe/reconcile",
    "/versions/probe/image",
  ];
  for (const path of reads) {
    assert.equal((await call("GET", path, null)).status, 401, path);
    assert.equal((await call("GET", path, disabledToken)).status, 401, path);
    assert.equal(
      (await call("GET", path, `cwa_${"Z".repeat(43)}`)).status,
      401,
      path,
    );
    for (const token of [editorToken, contributorToken])
      assert.equal((await call("GET", path, token)).status, 403, path);
  }
  for (const token of [editorToken, contributorToken])
    assert.equal(
      (
        await call("POST", "/probe/withdraw", token, {
          json: { expectedRowVersion: 1, idempotencyKey: "denied" },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await stage(
        {
          bannerId: "denied",
          countyFips: COUNTY,
          sourceFilename: "denied.png",
          idempotencyKey: "denied",
          target: { kind: "existing", expectedRowVersion: 1 },
        },
        editorToken,
        imageOne,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("GET", `/counties/${COUNTY}?x=1`, agentToken)).status,
    400,
  );
  const list = await call("GET", "/counties?query=Arapahoe", agentToken);
  assert.equal(list.status, 200);
  assert.equal(list.body.counties[0].fips, COUNTY);
  assert.equal((await call("GET", "/counties", ownerToken)).status, 200);

  // Stage, private preview, publish.
  const stageNew = (key) =>
    stage(
      {
        bannerId: "sites-api-a",
        countyFips: COUNTY,
        sourceFilename: "synthetic-one.png",
        idempotencyKey: key,
        target: {
          kind: "new",
          metadata: { ...FIRST, displayOrder: 0, isPrimary: true },
        },
      },
      agentToken,
      imageOne,
    );
  const staged = await stageNew("sites-api-stage-1");
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.verified, true);
  const v1 = staged.body.version.id;
  const replayed = await stageNew("sites-api-stage-1");
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replayed, true);
  assert.equal(replayed.body.version.id, v1);

  const preview = await call("GET", `/versions/${v1}/image`, agentToken);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(sha(preview.bytes), sha(imageOne));
  assert.equal(
    (await call("GET", `/versions/${v1}/image`, editorToken)).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/banner-assets/${v1}`)).status,
    404,
    "a staged version must not be public",
  );

  const published = await call("POST", "/sites-api-a/publish", agentToken, {
    json: {
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "sites-api-pub-1",
      metadata: FIRST,
    },
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const publicOne = await fetch(`${base}/banner-assets/${v1}`);
  assert.equal(publicOne.status, 200);
  assert.equal(
    sha(new Uint8Array(await publicOne.arrayBuffer())),
    sha(imageOne),
  );
  assert.match(
    await (await fetch(`${base}/counties/${COUNTY}`)).text(),
    /Synthetic first alt text/,
  );

  // Replace, then restore the earlier publication with its own text.
  const staged2 = await stage(
    {
      bannerId: "sites-api-a",
      countyFips: COUNTY,
      sourceFilename: "synthetic-two.png",
      idempotencyKey: "sites-api-stage-2",
      target: { kind: "existing", expectedRowVersion: 2 },
    },
    agentToken,
    imageTwo,
  );
  assert.equal(staged2.status, 201, JSON.stringify(staged2.body));
  const v2 = staged2.body.version.id;
  assert.equal(
    (await call("GET", `/versions/${v2}/image`, agentToken)).status,
    200,
  );
  assert.equal((await fetch(`${base}/banner-assets/${v2}`)).status, 404);
  const stale = await call("POST", "/sites-api-a/publish", agentToken, {
    json: {
      versionId: v2,
      expectedRowVersion: 1,
      idempotencyKey: "sites-api-pub-stale",
      metadata: SECOND,
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "stale_version");
  const replaced = await call("POST", "/sites-api-a/publish", agentToken, {
    json: {
      versionId: v2,
      expectedRowVersion: 2,
      idempotencyKey: "sites-api-pub-2",
      metadata: SECOND,
    },
  });
  assert.equal(replaced.status, 200);
  assert.equal((await fetch(`${base}/banner-assets/${v1}`)).status, 404);
  assert.equal((await fetch(`${base}/banner-assets/${v2}`)).status, 200);
  const restored = await call("POST", "/sites-api-a/restore", agentToken, {
    json: {
      versionId: v1,
      expectedRowVersion: 3,
      idempotencyKey: "sites-api-restore-1",
    },
  });
  assert.equal(restored.status, 200);
  const county = await call("GET", `/counties/${COUNTY}`, agentToken);
  const live = county.body.banners[0];
  assert.equal(live.selectedVersionId, v1);
  assert.equal(live.caption, FIRST.caption);
  assert.equal(live.altText, FIRST.altText);
  assert.equal(live.displayMode, FIRST.displayMode);
  assert.equal(live.focalX, FIRST.focalX);
  assert.equal(live.focalY, FIRST.focalY);
  assert.equal(JSON.stringify(county.body).includes("banner-assets/"), false);
  const history = await call("GET", "/sites-api-a/publications", agentToken);
  assert.equal(history.body.publications.length, 3);
  assert.equal(history.body.publications[0].origin, "restore_recorded");
  const reconcile = await call("GET", "/sites-api-a/reconcile", agentToken);
  assert.equal(reconcile.status, 200);
  assert.ok(
    reconcile.body.items.every(
      (i) => i.classification === "verified_unchanged",
    ),
  );

  // Bodies and uploads are bounded and closed.
  assert.equal(
    (
      await call("POST", "/sites-api-a/withdraw", agentToken, {
        json: {
          expectedRowVersion: live.rowVersion,
          idempotencyKey: "k",
          actor: "x",
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/sites-api-a/withdraw", agentToken, {
        body: "{not json",
        headers: { "content-type": "application/json" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/sites-api-a/withdraw", agentToken, {
        body: JSON.stringify({ pad: "x".repeat(70_000) }),
        headers: { "content-type": "application/json" },
      })
    ).status,
    413,
  );
  const oversized = await stage(
    {
      bannerId: "sites-api-big",
      countyFips: COUNTY,
      sourceFilename: "big.png",
      idempotencyKey: "sites-api-big",
      target: { kind: "existing", expectedRowVersion: 1 },
    },
    agentToken,
    new Uint8Array(26 * 1024 * 1024),
  );
  assert.equal(oversized.status, 413);
  const notAnImage = await stage(
    {
      bannerId: "sites-api-a",
      countyFips: COUNTY,
      sourceFilename: "text.png",
      idempotencyKey: "sites-api-notimage",
      target: { kind: "existing", expectedRowVersion: live.rowVersion },
    },
    agentToken,
    new TextEncoder().encode("not an image"),
  );
  assert.equal(notAnImage.status, 415);
  assert.equal(notAnImage.body.error, "unsupported_image_type");

  // Withdraw leaves nothing public and nothing deleted.
  const withdrawn = await call("POST", "/sites-api-a/withdraw", agentToken, {
    json: {
      expectedRowVersion: live.rowVersion,
      idempotencyKey: "sites-api-withdraw",
    },
  });
  assert.equal(withdrawn.status, 200);
  assert.equal((await fetch(`${base}/banner-assets/${v1}`)).status, 404);
  assert.equal(
    (await call("GET", `/versions/${v1}/image`, agentToken)).status,
    200,
  );
  assert.match(
    await (await fetch(`${base}/counties/${COUNTY}`)).text(),
    /class="empty-state"/,
  );
}

async function main() {
  const agentToken = `cwa_${"A".repeat(43)}`;
  const ownerToken = `cwa_${"O".repeat(43)}`;
  const editorToken = `cwa_${"E".repeat(43)}`;
  const disabledToken = `cwa_${"D".repeat(43)}`;
  const contributorToken = `cwa_${"C".repeat(43)}`;
  const { hashCredential } = await import(
    pathToFileURL(join(root, "dist", "services", "security.js"))
  );
  const agentHash = await hashCredential(agentToken);
  const ownerHash = await hashCredential(ownerToken);
  const editorHash = await hashCredential(editorToken);
  const disabledHash = await hashCredential(disabledToken);
  const contributorHash = await hashCredential(contributorToken);
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
    "0014_owner_bootstrap_audit.sql",
    "0015_correct_lake_la_plata_county_names.sql",
    "0016_banner_homepage_curation.sql",
    "0017_content_publication.sql",
    "0018_banner_publications.sql",
    "0019_human_sign_in.sql",
    "0020_role_source_publisher_classification.sql",
    "0021_report_challenge_claims.sql",
    "0022_unstructured_person_roles.sql",
    "0023_sync_batch_result_size.sql",
    "0024_agent_capability_grants.sql",
    "0025_agent_inspect_grant.sql",
    "0026_agent_banner_publish_grant.sql",
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
    WITH RECURSIVE extra_orgs(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM extra_orgs WHERE n < 50)
    INSERT INTO organizations
      (id,name,organization_type,county_fips,parent_organization_id,parent_relationship)
      SELECT printf('synthetic-org-%02d',n),
        CASE WHEN n % 2 = 0 THEN 'Synthetic Shared Name' ELSE 'synthetic shared name' END,
        'partner','08001','d1-test-county-org',
        CASE WHEN n % 2 = 0 THEN 'reports_to' ELSE 'grouped_under' END
      FROM extra_orgs;
    INSERT INTO organizations
      (id,name,organization_type,county_fips,parent_organization_id,parent_relationship)
      VALUES
      ('d1-test-subunit-nested','Zzz Synthetic Nested Subunit','department',
        '08001','synthetic-org-01','grouped_under'),
      ('d1-test-subunit-overflow','Zzz Synthetic Subunit Overflow','department',
        '08001','d1-test-county-org','reports_to');
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
    INSERT INTO accounts (id,kind,role,display_name) VALUES
      ('d1-test-owner','agent','owner','Synthetic Sites Owner');
    INSERT INTO identities (id,account_id,provider,subject,credential_hash) VALUES
      ('d1-test-owner-key','d1-test-owner','agent-key','d1-test-owner-key','${ownerHash}');
    INSERT INTO accounts (id,kind,role,display_name) VALUES
      ('d1-test-editor','agent','editor','Synthetic Sites Editor'),
      ('d1-test-contributor','agent','contributor','Synthetic Sites Contributor');
    INSERT INTO identities (id,account_id,provider,subject,credential_hash) VALUES
      ('d1-test-editor-key','d1-test-editor','agent-key','d1-test-editor-key','${editorHash}'),
      ('d1-test-contributor-key','d1-test-contributor','agent-key','d1-test-contributor-key','${contributorHash}');
    INSERT INTO accounts (id,kind,role,display_name,status) VALUES
      ('d1-sites-owner','human','owner','Synthetic Sites Human Owner','active'),
      ('d1-sites-admin','human','administrator','Synthetic Sites Human Administrator','active'),
      ('d1-sites-editor','human','editor','Synthetic Sites Human Editor','active'),
      ('d1-sites-contributor','human','contributor','Synthetic Sites Human Contributor','active'),
      ('d1-sites-disabled','human','owner','Synthetic Sites Disabled Human','disabled');
    INSERT INTO identities (id,account_id,provider,subject,expires_at,revoked_at) VALUES
      ('d1-sites-owner-id','d1-sites-owner','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-owner',NULL,NULL),
      ('d1-sites-admin-id','d1-sites-admin','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-admin',NULL,NULL),
      ('d1-sites-editor-id','d1-sites-editor','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-editor',NULL,NULL),
      ('d1-sites-contributor-id','d1-sites-contributor','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-contributor',NULL,NULL),
      ('d1-sites-disabled-id','d1-sites-disabled','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-disabled',NULL,NULL),
      ('d1-sites-expired-id','d1-sites-editor','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-expired','2000-01-01T00:00:00.000Z',NULL),
      ('d1-sites-revoked-id','d1-sites-editor','chatgpt-sites:appgprj_6af7fb8f615c81918da0e4450ba336de','synthetic-sites-revoked',NULL,'2026-11-13T00:00:00.000Z'),
      ('d1-sites-other-project-id','d1-sites-owner','chatgpt-sites:appgprj_00000000000000000000000000000000','synthetic-other-project-subject',NULL,NULL);
    INSERT INTO content_items (id,content_type,title,summary,body,created_by_account_id,last_edited_by_account_id) VALUES
      ('fictional-story','story','Fictional River Committee','A fictional county meeting.',
       '## Meeting notes' || char(10,10) || 'A **synthetic watershed**. <script>alert(1)</script> [blocked](javascript:alert(1)) [records](https://example.test/records)',
       'd1-test-editor','d1-test-editor'),
      ('fictional-post','post','Fictional Dispatch','A fictional Post.','A fictional dispatch from the records office.','d1-test-editor','d1-test-editor'),
      ('private-story','story','Unpublished Canary',NULL,'Unpublished secret phrase','d1-test-editor','d1-test-editor'),
      ('other-story','story','Another fictional Story',NULL,'Fictional competing slug.','d1-test-editor','d1-test-editor');
    INSERT INTO content_revisions (
      content_id,version,change_kind,title,summary,body,status,county_fips_json,person_ids_json,organization_ids_json,edited_by_account_id
    ) SELECT id,version,'create',title,summary,body,status,
      CASE WHEN id='fictional-story' THEN '["08001"]' ELSE '[]' END,
      CASE WHEN id='fictional-story' THEN '["d1-test-person-a"]' ELSE '[]' END,
      CASE WHEN id='fictional-story' THEN '["d1-test-county-org"]' ELSE '[]' END,
      last_edited_by_account_id FROM content_items;
    INSERT INTO accounts (id,kind,role,display_name,status) VALUES
      ('d1-test-disabled-editor','agent','editor','Synthetic Disabled Editor','disabled');
    INSERT INTO identities (id,account_id,provider,subject,credential_hash) VALUES
      ('d1-test-disabled-key','d1-test-disabled-editor','agent-key','d1-test-disabled-key','${disabledHash}');

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
  const startWorker = async (extraArguments = [], workerConfig = config) => {
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
        workerConfig,
        "--persist-to",
        persist,
        ...extraArguments,
      ],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
      },
    );
    await waitFor(`${base}/`);
  };
  await startWorker();
  try {
    await waitFor(`${base}/`);
    const homepage = await fetch(base);
    const homeHtml = await homepage.text();
    assert.match(homeHtml, /64 counties/);
    assert.match(homeHtml, /data-banner-count="0"/);

    await verifyPublication(base, {
      editorToken,
      contributorToken,
      disabledToken,
    });

    await verifyBannerAdmin(base, {
      agentToken,
      ownerToken,
      editorToken,
      contributorToken,
      disabledToken,
    });
    console.log(
      "PASS bundled Worker banner administration: protected routes, bounded uploads, local R2 stage, private preview, publish, replace and restore with public delivery rules intact",
    );

    // The same Worker without its R2 binding authenticates and authorizes, then
    // reports the administration API unavailable. Public pages keep rendering.
    worker.kill("SIGTERM");
    await new Promise((resolveExit) => worker.once("exit", resolveExit));
    const noBucketConfig = join(persist, "wrangler.no-bucket.toml");
    writeFileSync(
      noBucketConfig,
      readFileSync(config, "utf8")
        .replace(
          /^main = .*$/m,
          `main = ${JSON.stringify(join(root, "dist", "server", "index.js"))}`,
        )
        .replace(/\[\[r2_buckets\]\][\s\S]*?(?=\n\[|$)/g, ""),
    );
    await startWorker([], noBucketConfig);
    const unavailable = await fetch(`${base}/api/admin/banners/counties`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "banner_admin_unavailable",
    });
    assert.equal(
      (await fetch(`${base}/api/admin/banners/counties`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/api/admin/banners/counties`, {
          headers: { authorization: `Bearer ${editorToken}` },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/counties/08005`)).status, 200);
    assert.equal((await fetch(`${base}/banner-assets/missing`)).status, 404);
    console.log(
      "PASS bundled Worker banner administration without an R2 binding is a controlled 503 and public pages are unaffected",
    );
    worker.kill("SIGTERM");
    await new Promise((resolveExit) => worker.once("exit", resolveExit));
    await startWorker();

    const unauthorizedStaffPage = await fetch(`${base}/admin/reports`);
    assert.equal(unauthorizedStaffPage.status, 401);
    assert.match(
      unauthorizedStaffPage.headers.get("cache-control") ?? "",
      /no-store, private/,
    );
    assert.doesNotMatch(
      await unauthorizedStaffPage.text(),
      /report description|reporter@example|staff-reports\.js/,
    );
    const forgedStaffPage = await fetch(`${base}/admin/reports`, {
      headers: {
        "oai-authenticated-user-id": "forged-staff",
        "oai-authenticated-user-email": "staff@example.test",
      },
    });
    assert.equal(forgedStaffPage.status, 401);
    const sitesHeaders = (subject) => ({
      "oai-authenticated-user-id": subject,
      "oai-authenticated-user-email": "synthetic@example.test",
      "oai-authenticated-user-full-name": "Synthetic Sites User",
    });
    // No authenticated host context is available to the Worker. Header values,
    // even exact synthetic linked subjects, are therefore never principals.
    const linkedHumanAccess = async (subject) =>
      fetch(`${base}/admin/reports`, { headers: sitesHeaders(subject) });
    for (const subject of [
      "synthetic-sites-owner",
      "synthetic-sites-admin",
      "synthetic-sites-editor",
      "synthetic-sites-contributor",
      "synthetic-unlinked-human",
      "synthetic-sites-disabled",
      "synthetic-sites-expired",
      "synthetic-sites-revoked",
      "synthetic-other-project-subject",
    ]) {
      const response = await linkedHumanAccess(subject);
      assert.equal(response.status, 401, subject);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(
        (
          await fetch(`${base}/api/admin/accounts?limit=10`, {
            headers: sitesHeaders(subject),
          })
        ).status,
        401,
      );
    }
    for (const subject of [
      "synthetic-sites-editor",
      "synthetic-sites-contributor",
    ]) {
      assert.equal((await linkedHumanAccess(subject)).status, 401, subject);
    }
    const malformedClaims = [
      {
        "oai-authenticated-user-id": "",
        "oai-authenticated-user-email": "synthetic@example.test",
      },
      { "oai-authenticated-user-id": "synthetic-sites-editor" },
      {
        "oai-authenticated-user-id": "synthetic-sites-editor",
        "oai-authenticated-user-email": "not-an-email",
      },
      {
        "oai-authenticated-user-id": "synthetic-sites-editor, other",
        "oai-authenticated-user-email": "synthetic@example.test",
      },
      {
        ...sitesHeaders("synthetic-sites-editor"),
        "oai-authenticated-user-full-name": "A, B",
      },
      {
        ...sitesHeaders("synthetic-sites-editor"),
        "oai-authenticated-user-full-name": "N".repeat(513),
      },
    ];
    for (const headers of malformedClaims) {
      assert.equal(
        (await fetch(`${base}/admin/reports`, { headers })).status,
        401,
      );
    }
    const repeatedClaim = new Headers(sitesHeaders("synthetic-sites-editor"));
    repeatedClaim.append(
      "oai-authenticated-user-id",
      "another-synthetic-subject",
    );
    assert.equal(
      (await fetch(`${base}/admin/reports`, { headers: repeatedClaim })).status,
      401,
    );
    const forgedAssertions = await fetch(`${base}/admin/reports`, {
      headers: {
        ...sitesHeaders("synthetic-unlinked-human"),
        "x-account-id": "d1-sites-owner",
        "x-account-role": "owner",
      },
    });
    assert.equal(forgedAssertions.status, 401);
    const malformedAuthorization = await fetch(`${base}/admin/reports`, {
      headers: {
        ...sitesHeaders("synthetic-sites-editor"),
        authorization: "Bearer malformed",
      },
    });
    assert.equal(malformedAuthorization.status, 401);
    for (const token of [agentToken, ownerToken, editorToken]) {
      const authorized = await fetch(`${base}/admin/reports`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(authorized.status, 200);
      assert.match(await authorized.text(), /staff-reports\.js/);
      assert.match(
        authorized.headers.get("cache-control") ?? "",
        /no-store, private/,
      );
    }
    const contributorPage = await fetch(`${base}/admin/reports`, {
      headers: { authorization: `Bearer ${contributorToken}` },
    });
    assert.equal(contributorPage.status, 403);

    const county = await fetch(`${base}/counties/08001`);
    const homepageWithoutR2 = await fetch(`${base}/`);
    assert.equal(homepageWithoutR2.status, 200);
    assert.match(await homepageWithoutR2.text(), /data-banner-count="0"/);
    assert.equal(
      (
        await fetch(
          `${base}/banner-assets/11111111-1111-4111-8111-111111111111`,
        )
      ).status,
      404,
    );
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

    for (const [collection, count] of [
      ["people", 27],
      ["organizations", 54],
    ]) {
      assert.equal(
        (await fetch(`${base}/${collection}?ignored=yes`)).status,
        400,
      );
      let href = `/${collection}`;
      const ids = [];
      let firstCursor;
      while (href) {
        const response = await fetch(`${base}${href}`);
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.match(body, new RegExp(`Browse ${collection}`));
        const pageIds = Array.from(
          body.matchAll(
            new RegExp(
              `class="record-title"><a href="/${collection}/([^"]+)"`,
              "g",
            ),
          ),
          (match) => match[1],
        );
        assert.equal(pageIds.length, Math.min(25, count - ids.length));
        ids.push(...pageIds);
        href = body.match(/rel="next" href="([^"]+)"/)?.[1];
        if (href) {
          assert.match(href, new RegExp(`^/${collection}\\?cursor=`));
          firstCursor ??= new URL(href, base).searchParams.get("cursor");
        }
      }
      assert.equal(new Set(ids).size, count);
      if (collection === "organizations") {
        assert.deepEqual(ids.slice(2), [
          ...Array.from(
            { length: 50 },
            (_, i) => `synthetic-org-${String(i + 1).padStart(2, "0")}`,
          ),
          "d1-test-subunit-nested",
          "d1-test-subunit-overflow",
        ]);
      }
      const other = collection === "people" ? "organizations" : "people";
      assert.equal(
        (await fetch(`${base}/${other}?cursor=${firstCursor}`)).status,
        400,
      );
      assert.equal(
        (await fetch(`${base}/${collection}?cursor=${firstCursor}0`)).status,
        400,
      );
      assert.equal(
        (
          await fetch(
            `${base}/${collection}?query=Synthetic&cursor=${firstCursor}`,
          )
        ).status,
        400,
      );
      const short = await fetch(`${base}/${collection}?query=a`);
      assert.match(await short.text(), /That search is too short/);
    }

    const person = await fetch(`${base}/people/d1-test-person-a`);
    assert.match(await person.text(), /Synthetic Clerk/);
    const organization = await fetch(
      `${base}/organizations/d1-test-county-org`,
    );
    const organizationHtml = await organization.text();
    assert.equal(organization.status, 200, organizationHtml);
    assert.match(organizationHtml, /Synthetic Clerk/);
    const subunitsHtml = organizationHtml.match(
      /<ul class="subunit-list">([\s\S]*?)<\/ul>/,
    )?.[1];
    assert.ok(subunitsHtml, "organization page renders its subunit list");
    const listedSubunits = Array.from(
      subunitsHtml.matchAll(/<li>([\s\S]*?)<\/li>/g),
      ([, item]) => ({
        id: item.match(/href="\/organizations\/([^"]+)"/)?.[1],
        name: item.match(/href="\/organizations\/[^"]+">([^<]+)<\/a>/)?.[1],
        relationship: item.match(
          /\((reports to|grouped under) this organization\)/,
        )?.[1],
      }),
    );
    assert.deepEqual(listedSubunits, [
      ...Array.from({ length: 25 }, (_, i) => {
        const n = (i + 1) * 2;
        return {
          id: `synthetic-org-${String(n).padStart(2, "0")}`,
          name: "Synthetic Shared Name",
          relationship: "reports to",
        };
      }),
      {
        id: "d1-test-subunit-overflow",
        name: "Zzz Synthetic Subunit Overflow",
        relationship: "reports to",
      },
      ...Array.from({ length: 24 }, (_, i) => {
        const n = i * 2 + 1;
        return {
          id: `synthetic-org-${String(n).padStart(2, "0")}`,
          name: "synthetic shared name",
          relationship: "grouped under",
        };
      }),
    ]);
    assert.match(organizationHtml, /Only the first 50 subunits are listed\./);
    assert.doesNotMatch(
      subunitsHtml,
      /d1-test-partner|d1-test-subunit-nested|synthetic-org-49/,
    );

    const childOrganization = await fetch(
      `${base}/organizations/d1-test-partner`,
    );
    const childOrganizationHtml = await childOrganization.text();
    assert.equal(childOrganization.status, 200, childOrganizationHtml);
    assert.match(childOrganizationHtml, /No subunit is recorded\./);

    // M4-D officials directory through the hosted D1 read path.
    const officials = await fetch(`${base}/officials`);
    const officialsHtml = await officials.text();
    assert.equal(officials.status, 200, officialsHtml);
    assert.match(officialsHtml, /27 profiles match/);
    assert.match(officialsHtml, /Page 1 of 2/);
    const officialsPageTwo = await fetch(`${base}/officials?page=2`);
    assert.match(await officialsPageTwo.text(), /Showing 26 to 27 of 27/);
    const countyOfficials = await fetch(
      `${base}/officials?county=08001&sort=checked-desc`,
    );
    const countyOfficialsHtml = await countyOfficials.text();
    assert.equal(countyOfficials.status, 200, countyOfficialsHtml);
    assert.match(countyOfficialsHtml, /2 profiles match/);
    assert.ok(
      countyOfficialsHtml.indexOf("Synthetic Person B") <
        countyOfficialsHtml.indexOf("Synthetic Person A"),
      "county directory sorts by source-check date in D1",
    );
    assert.match(countyOfficialsHtml, /Serves<\/span>/);
    const titleSearch = await fetch(`${base}/officials?q=Liaison`);
    const titleSearchHtml = await titleSearch.text();
    assert.match(titleSearchHtml, /1 profile matches/);
    assert.match(titleSearchHtml, /Synthetic Person B/);
    const officeFilter = await fetch(
      `${base}/officials?county=08001&office=d1-test-county-org`,
    );
    assert.match(await officeFilter.text(), /1 profile matches/);
    const structure = await fetch(
      `${base}/officials?directoryView=structure&county=08001`,
    );
    const structureHtml = await structure.text();
    assert.equal(structure.status, 200, structureHtml);
    assert.match(structureHtml, /Synthetic Adams County/);
    assert.match(
      structureHtml,
      /Affiliated regional and partner organizations[\s\S]*Synthetic Regional Partner/,
    );
    assert.equal((await fetch(`${base}/officials?county=99999`)).status, 400);

    for (const [path, type] of [
      ["/assets/site.css", "text/css"],
      ["/assets/site.js", "text/javascript"],
      ["/assets/community-voices.css", "text/css"],
      ["/assets/report-interface.css", "text/css"],
      ["/assets/report-interface.js", "text/javascript"],
      ["/assets/staff-reports.css", "text/css"],
      ["/assets/staff-reports.js", "text/javascript"],
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

    const reportPage = await fetch(`${base}/submit-report?guest=1`);
    const reportHtml = await reportPage.text();
    assert.equal(reportPage.status, 200);
    assert.match(reportHtml, /report-interface\.css/);
    assert.match(reportHtml, /report-interface\.js/);
    assert.match(reportHtml, /data-report-enabled="true"/);
    assert.match(reportHtml, /data-report-counties=/);
    assert.match(
      reportPage.headers.get("content-security-policy") ?? "",
      /script-src 'self'/,
    );
    const trackPage = await fetch(`${base}/track-report`);
    assert.equal(trackPage.status, 200);
    assert.match(await trackPage.text(), /data-report-mode="track"/);

    const reportInput = {
      countyId: "08001",
      subject: { kind: "person", id: "d1-test-person-a" },
      description:
        "Synthetic fictional report content for an integration test.",
      evidence: [
        { title: "Synthetic source", url: "https://example.test/source" },
      ],
      reporter: {
        attribution: "anonymous",
        confidential: true,
        contactPreference: "none",
      },
      idempotencyKey: "sub-2c-receipt-key-001",
    };
    const submit = () =>
      fetch(`${base}/api/v1/reports`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify(reportInput),
      });
    const invalidCounty = await fetch(`${base}/api/v1/reports`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        ...reportInput,
        countyId: "99999",
        idempotencyKey: "sub-2c-invalid-county",
      }),
    });
    assert.equal(invalidCounty.status, 400);
    const invalidSubject = await fetch(`${base}/api/v1/reports`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        ...reportInput,
        subject: { kind: "person", id: "missing-person" },
        idempotencyKey: "sub-2c-invalid-subject",
      }),
    });
    assert.equal(invalidSubject.status, 400);
    const firstReceiptResponse = await submit();
    assert.equal(
      firstReceiptResponse.status,
      201,
      await firstReceiptResponse.clone().text(),
    );
    const firstReceipt = await firstReceiptResponse.json();
    assert.match(firstReceipt.reference, /^CW-/);
    assert.ok(firstReceipt.recoveryKey);
    assert.equal(firstReceipt.replayed, false);
    const retryResponse = await submit();
    assert.equal(retryResponse.status, 200);
    const retryReceipt = await retryResponse.json();
    assert.equal(retryReceipt.reference, firstReceipt.reference);
    assert.equal(retryReceipt.recoveryKey, undefined);
    assert.equal(retryReceipt.replayed, true);
    const anonymousStaff = await fetch(`${base}/api/v1/reports`, {
      headers: { "oai-authenticated-user-id": "forged-staff" },
    });
    assert.equal(anonymousStaff.status, 401);
    const staffHeaders = { authorization: `Bearer ${agentToken}` };
    const staffQueueResponse = await fetch(`${base}/api/v1/reports`, {
      headers: staffHeaders,
    });
    assert.equal(staffQueueResponse.status, 200);
    const staffQueue = await staffQueueResponse.json();
    const storedReport = staffQueue.reports.find(
      (entry) => entry.countyId === "08001",
    );
    assert.ok(storedReport?.id);
    assert.equal(storedReport.countyName, "Adams");
    const humanEditorQueue = await fetch(`${base}/api/v1/reports`, {
      headers: sitesHeaders("synthetic-sites-editor"),
    });
    assert.equal(humanEditorQueue.status, 401);
    const humanPrivateReport = await fetch(
      `${base}/api/v1/reports/${storedReport.id}`,
      { headers: sitesHeaders("synthetic-sites-editor") },
    );
    assert.equal(humanPrivateReport.status, 401);
    assert.match(
      humanPrivateReport.headers.get("cache-control") ?? "",
      /no-store, private/,
    );
    assert.equal(
      (
        await fetch(`${base}/api/v1/reports`, {
          headers: sitesHeaders("synthetic-sites-contributor"),
        })
      ).status,
      401,
    );
    const changeHumanRole = await fetch(
      `${base}/api/admin/accounts/d1-sites-editor/role`,
      {
        method: "PUT",
        headers: {
          ...sitesHeaders("synthetic-sites-owner"),
          origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1, role: "contributor" }),
      },
    );
    assert.equal(
      changeHumanRole.status,
      401,
      await changeHumanRole.clone().text(),
    );
    assert.equal(
      (await linkedHumanAccess("synthetic-sites-editor")).status,
      401,
    );
    const syntheticOwnerPrincipal = await fetch(`${base}/_internal/principal`, {
      headers: sitesHeaders("synthetic-sites-owner"),
    });
    assert.equal(syntheticOwnerPrincipal.status, 401);
    for (const token of [ownerToken, editorToken]) {
      assert.equal(
        (
          await fetch(`${base}/api/v1/reports`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        200,
      );
    }
    const contributorQueue = await fetch(`${base}/api/v1/reports`, {
      headers: { authorization: `Bearer ${contributorToken}` },
    });
    assert.equal(contributorQueue.status, 403);
    const privateRead = await fetch(
      `${base}/api/v1/reports/${storedReport.id}`,
      { headers: staffHeaders },
    );
    assert.equal(privateRead.status, 200);
    assert.match(
      privateRead.headers.get("cache-control") ?? "",
      /no-store, private/,
    );
    assert.deepEqual((await privateRead.clone().json()).allowedNextStatuses, [
      "triage",
    ]);
    assert.match(
      await privateRead.text(),
      /Synthetic fictional report content/,
    );
    const unauthorizedRead = await fetch(
      `${base}/api/v1/reports/${storedReport.id}`,
      {
        headers: { "oai-authenticated-user-id": "forged-staff" },
      },
    );
    assert.equal(unauthorizedRead.status, 401);
    const transitioned = await fetch(
      `${base}/api/v1/reports/${storedReport.id}/status`,
      {
        method: "PATCH",
        headers: {
          ...staffHeaders,
          origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          status: "triage",
          note: "private synthetic staff note",
        }),
      },
    );
    assert.equal(transitioned.status, 200, await transitioned.clone().text());
    const history = await fetch(
      `${base}/api/v1/reports/${storedReport.id}/history`,
      { headers: staffHeaders },
    );
    assert.equal(history.status, 200);
    assert.match(
      history.headers.get("cache-control") ?? "",
      /no-store, private/,
    );
    assert.match(await history.text(), /private synthetic staff note/);
    const publicTrackingRequest = () =>
      fetch(`${base}/api/v1/reports/track`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          reference: firstReceipt.reference,
          recoveryKey: firstReceipt.recoveryKey,
        }),
      });
    const publicTracking = await publicTrackingRequest();
    assert.equal(publicTracking.status, 200);
    const projection = await publicTracking.json();
    assert.equal(projection.status, "triage");
    const projectionText = JSON.stringify(projection);
    assert.doesNotMatch(
      projectionText,
      /Synthetic fictional report content|private synthetic staff note|d1-test-person-a|reportId|accountId/,
    );
    assert.match(
      publicTracking.headers.get("cache-control") ?? "",
      /no-store, private/,
    );

    // A worker restart against the same Wrangler state proves durable storage.
    worker.kill("SIGTERM");
    await new Promise((resolveExit) => worker.once("exit", resolveExit));
    await startWorker();
    const reopenedTracking = await publicTrackingRequest();
    assert.equal(reopenedTracking.status, 200);
    assert.equal((await reopenedTracking.json()).status, "triage");

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
    assert.equal(
      (await fetch(`${base}/api/v1/reports`, { headers: agentHeaders })).status,
      401,
    );
    assert.equal((await fetch(`${base}/assets/not-allowed.txt`)).status, 404);
    assert.equal((await fetch(`${base}/api/reports`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/reports?status=pending`)).status,
      404,
    );
    const ownerHeaders = { authorization: `Bearer ${ownerToken}` };
    const disableAdmin = await fetch(
      `${base}/api/admin/accounts/d1-test-admin`,
      {
        method: "PATCH",
        headers: {
          ...ownerHeaders,
          origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1, status: "disabled" }),
      },
    );
    assert.equal(disableAdmin.status, 200, await disableAdmin.clone().text());
    assert.equal(
      (await fetch(`${base}/api/v1/reports`, { headers: staffHeaders })).status,
      401,
    );
    const enableAdmin = await fetch(
      `${base}/api/admin/accounts/d1-test-admin`,
      {
        method: "PATCH",
        headers: {
          ...ownerHeaders,
          origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 2, status: "active" }),
      },
    );
    assert.equal(enableAdmin.status, 200, await enableAdmin.clone().text());
    const revokeAdmin = await fetch(
      `${base}/api/admin/accounts/d1-test-admin/identities?id=d1-test-admin-key&version=1`,
      {
        method: "DELETE",
        headers: { ...ownerHeaders, origin: base },
      },
    );
    assert.equal(revokeAdmin.status, 200, await revokeAdmin.clone().text());
    assert.equal(
      (await fetch(`${base}/api/v1/reports`, { headers: staffHeaders })).status,
      401,
    );
    // AUTH-3-WEB: sign-in is off by default, then enabled with synthetic
    // settings against a synthetic provider on loopback.
    const tenantPort = await freePort();
    const tenant = await startSyntheticTenant(tenantPort);
    try {
      worker.kill("SIGTERM");
      await new Promise((resolveExit) => worker.once("exit", resolveExit));
      const seedFile = join(persist, "synthetic-sign-in.sql");
      writeFileSync(seedFile, SIGN_IN_SEED_SQL);
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
        seedFile,
      ]);
      await startWorker();
      await runHumanSignInChecks({
        base,
        tenant,
        ownerHeaders,
        restart: async ({ enabled }) => {
          worker.kill("SIGTERM");
          await new Promise((resolveExit) => worker.once("exit", resolveExit));
          await startWorker(
            Object.entries({
              AUTH0_ENABLED: enabled ? "true" : "false",
              AUTH0_ISSUER: SIGN_IN_ISSUER,
              AUTH0_CLIENT_ID: "synthetic-client-id",
              AUTH0_CLIENT_SECRET: SIGN_IN_CLIENT_SECRET,
              AUTH0_CANONICAL_ORIGIN: base,
              AUTH0_REDIRECT_URI: `${base}/auth/callback`,
              AUTH0_TEST_UPSTREAM: tenant.origin,
            }).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
          );
        },
      });
      console.log(
        "Human sign-in integration passed in the bundled Worker on local D1: default off, login, callback replay and concurrent claims, unlinked denial, live role, disable and revocation changes, cross-origin writes, agent precedence, sign-out and disabled sessions.",
      );
    } finally {
      await tenant.close();
    }
    if (process.env.SITES_D1_BROWSER_PAUSE === "1") {
      console.log(`Synthetic browser test is ready at ${base}`);
      await delay(180_000);
    }
  } finally {
    worker.kill("SIGTERM");
    await new Promise((resolveExit) => worker.once("exit", resolveExit));
    cleanup();
  }

  const modulePath = join(root, "dist", "server", "index.js");
  const bundle = readFileSync(modulePath, "utf8");
  const hosting = JSON.parse(
    readFileSync(join(root, ".openai", "hosting.json"), "utf8"),
  );
  assert.equal(hosting.project_id, "appgprj_6af7fb8f615c81918da0e4450ba336de");
  assert.ok(bundle.includes(hosting.project_id));
  assert.doesNotMatch(
    bundle,
    /sql\.wasm|node_modules[\\/]sql\.js|research\/database/,
  );
  const siteWorker = await import(pathToFileURL(modulePath));
  for (const environment of [
    {},
    {
      DB: {
        prepare() {
          throw new Error("Private storage error");
        },
      },
    },
  ]) {
    const unavailable = await siteWorker.default.fetch(
      new Request("https://site.test/api/admin/banners/counties", {
        headers: { authorization: `Bearer ${agentToken}` },
      }),
      environment,
    );
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /Private storage error/);
  }
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
  for (const environment of [
    {},
    {
      DB: {
        prepare() {
          throw new Error("Private storage error");
        },
      },
    },
  ]) {
    const listing = await siteWorker.default.fetch(
      new Request("https://site.test/stories"),
      environment,
    );
    assert.equal(listing.status, 200);
    assert.match(await listing.text(), /No stories yet/);
    const detail = await siteWorker.default.fetch(
      new Request("https://site.test/stories/private"),
      environment,
    );
    assert.equal(detail.status, 404);
    assert.doesNotMatch(await detail.text(), /Private storage error/);
  }

  const disabledSubmission = await siteWorker.default.fetch(
    new Request("https://site.test/api/v1/reports", {
      method: "POST",
      headers: {
        origin: "https://site.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    {},
  );
  assert.equal(disabledSubmission.status, 503);
  const offLoopbackTestSubmission = await siteWorker.default.fetch(
    new Request("https://site.test/api/v1/reports", {
      method: "POST",
      headers: {
        origin: "https://site.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { APP_ENV: "test", REPORTS_TEST_ABUSE_CONTROL: "enabled" },
  );
  assert.equal(offLoopbackTestSubmission.status, 429);
  console.log(
    `Sites Worker D1 report and publication integration passed (${migrations.length} migrations, 64 counties, report routes/assets, durable private intake, staff authorization, and disabled non-loopback submissions).`,
  );
}

main().catch((error) => {
  if (worker && worker.exitCode === null) worker.kill("SIGTERM");
  cleanup();
  console.error(error);
  process.exitCode = 1;
});

import { AsyncD1Database } from "../../src/database/d1.ts";
import { D1BannerAdministration } from "../../src/services/banner-admin-d1.ts";
import { D1BannerPublicService } from "../../src/services/banner-public.ts";
import {
  R2BannerObjectStorage,
  sha256Hex,
} from "../../src/services/banner-storage.ts";
import { createD1AccountServices } from "../../src/services/d1-accounts.ts";
import {
  createAgentCredential,
  createTestHumanIdentityAdapter,
} from "../../src/services/security.ts";
import {
  BANNER_STAGE_HEADER,
  createBannerAdminApiTransport,
} from "../../src/transport/banner-admin-api.ts";
import {
  FaultStorage,
  MemoryR2,
  RevokingDatabase,
} from "./banner-admin-checks.mjs";

const b64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const ORIGIN = "https://watchdog.invalid";
const API = `${ORIGIN}/api/admin/banners`;
const SUBJECTS = {
  "api-admin": "api-admin-subject",
  "api-owner": "api-owner-subject",
  "api-editor": "api-editor-subject",
  "api-contributor": "api-contributor-subject",
  "api-temp": "api-temp-subject",
};

/**
 * BANNER-ADMIN-3: the HTTP transport over the real service, the isolated local
 * D1 and an in-memory bucket, with human access through the established test
 * adapter. Synthetic images only.
 */
export async function runBannerApiChecks(env, fixtures) {
  const checks = [];
  const check = (name, passed, detail = "") => {
    if (!passed)
      throw new Error(`Banner API check failed: ${name} ${detail}`.trim());
    checks.push(name);
  };
  const files = Object.fromEntries(
    Object.entries(fixtures).map(([name, file]) => [
      name,
      { ...file, bytes: b64(file.base64) },
    ]),
  );
  const sql = (query, ...values) =>
    env.DB.prepare(query)
      .bind(...values)
      .first();
  const count = async (table, where = "1=1", ...values) =>
    (await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...values))
      .n;

  for (const [subject, role] of [
    ["api-admin", "administrator"],
    ["api-owner", "owner"],
    ["api-editor", "editor"],
    ["api-contributor", "contributor"],
    ["api-temp", "administrator"],
  ]) {
    await env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'human', ?, 'Synthetic API tester')",
    )
      .bind(subject, role)
      .run();
    await env.DB.prepare(
      "INSERT INTO identities (id, account_id, provider, subject) VALUES (?, ?, 'test-human', ?)",
    )
      .bind(`${subject}-identity`, subject, SUBJECTS[subject])
      .run();
  }
  const agent = await createAgentCredential();
  await env.DB.prepare(
    "INSERT INTO accounts (id, kind, role, display_name) VALUES ('api-agent', 'agent', 'administrator', 'Synthetic API agent')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO identities (id, account_id, provider, subject, credential_hash) VALUES ('api-agent-key', 'api-agent', 'agent-key', 'api-agent-key', ?)",
  )
    .bind(agent.hash)
    .run();

  const bucket = new MemoryR2();
  const storage = new FaultStorage(new R2BannerObjectStorage(bucket));
  const db = new RevokingDatabase(env.DB);
  const accounts = createD1AccountServices(
    db,
    createTestHumanIdentityAdapter(SUBJECTS),
  );
  const publicReads = new D1BannerPublicService(db, bucket);
  let afterAuthorize = null;
  const transport = createBannerAdminApiTransport({
    resolvePrincipal: accounts.resolvePrincipal,
    authorize: async (principal) => {
      const allowed = await accounts.hasCapability(principal, "banner.manage");
      if (allowed && afterAuthorize) {
        const hook = afterAuthorize;
        afterAuthorize = null;
        await hook();
      }
      return allowed;
    },
    administration: new D1BannerAdministration(db, storage),
  });
  const texts = [];
  const api = async (method, path, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.who) headers["x-test-human-subject"] = options.who;
    if (options.agent) headers.authorization = `Bearer ${agent.secret}`;
    if (options.origin !== null && method !== "GET")
      headers.origin = options.origin ?? ORIGIN;
    let body = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const response = await transport.fetch(
      new Request(`${API}${path}`, { method, headers, body }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isImage = response.headers.get("content-type")?.startsWith("image/");
    const text = isImage ? "" : new TextDecoder().decode(bytes);
    texts.push(text);
    let parsed = null;
    if (!isImage && text) {
      try {
        parsed = JSON.parse(text);
      } catch {}
    }
    return {
      status: response.status,
      body: parsed,
      bytes,
      headers: response.headers,
    };
  };
  const ADMIN = { who: "api-admin" };
  const stage = (meta, file, options = {}) =>
    api("POST", "/stage", {
      ...ADMIN,
      ...options,
      headers: {
        "content-type": file.mediaType ?? "image/png",
        [BANNER_STAGE_HEADER]: Buffer.from(JSON.stringify(meta)).toString(
          "base64url",
        ),
        ...(options.headers ?? {}),
      },
      body: file.bytes,
    });
  const newMeta = (
    id,
    county,
    order,
    primary,
    key,
    caption = "First caption",
  ) => ({
    bannerId: id,
    countyFips: county,
    sourceFilename: `${id}.png`,
    idempotencyKey: key,
    target: {
      kind: "new",
      metadata: {
        caption,
        altText: `Alt text for ${id}`,
        displayOrder: order,
        isPrimary: primary,
        displayMode: "cover",
        focalX: 0.5,
        focalY: 0.5,
      },
    },
  });
  const nextMeta = (id, county, rowVersion, key) => ({
    bannerId: id,
    countyFips: county,
    sourceFilename: `${id}-next.png`,
    idempotencyKey: key,
    target: { kind: "existing", expectedRowVersion: rowVersion },
  });
  const text = (caption, altText, displayMode, focal) => ({
    caption,
    altText,
    displayMode,
    focalX: focal,
    focalY: focal,
  });
  const FIRST = text("Caption one", "Alt text one", "cover", 0.2);
  const SECOND = text("Caption two", "Alt text two", "contain", 0.8);
  const banner = (id) => sql("SELECT * FROM banner_assets WHERE id = ?", id);
  const everything = async (id) => ({
    banner: await banner(id),
    publications: await count("banner_publications", "banner_id = ?", id),
    ledger: await count("banner_admin_operations"),
    audit: await count("audit_events"),
    versions: await count("banner_asset_versions", "banner_id = ?", id),
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const COUNTY = "08021";

  // ---- Authentication and authorization on every route
  const probes = [
    ["GET", "/counties"],
    ["GET", `/counties/${COUNTY}`],
    ["GET", "/probe/publications"],
    ["GET", "/probe/reconcile"],
    ["GET", "/versions/probe-version/image"],
  ];
  for (const [method, path] of probes) {
    check(
      `anonymous ${method} ${path} is 401`,
      (await api(method, path)).status === 401,
    );
    for (const who of ["api-editor", "api-contributor"])
      check(
        `${who} ${method} ${path} is 403`,
        (await api(method, path, { who })).status === 403,
      );
  }
  for (const [path, json] of [
    [
      "/probe/publish",
      { versionId: "x", expectedRowVersion: 1, idempotencyKey: "k" },
    ],
    ["/probe/withdraw", { expectedRowVersion: 1, idempotencyKey: "k" }],
  ]) {
    check(
      `anonymous POST ${path} is 401`,
      (await api("POST", path, { json })).status === 401,
    );
    check(
      `editor POST ${path} is 403`,
      (await api("POST", path, { json, who: "api-editor" })).status === 403,
    );
  }
  check(
    "anonymous stage is 401 and an editor stage is 403",
    (
      await stage(newMeta("x", COUNTY, 0, true, "k"), files.apiPng1, {
        who: undefined,
      })
    ).status === 401 &&
      (
        await stage(newMeta("x", COUNTY, 0, true, "k"), files.apiPng1, {
          who: "api-editor",
        })
      ).status === 403,
  );
  check(
    "a forged principal header is not an identity",
    (await api("GET", "/counties", { who: "someone-else" })).status === 401 &&
      (
        await api("GET", "/counties", {
          headers: { "x-account-id": "api-admin" },
        })
      ).status === 401,
  );
  check(
    "nothing was written by denied calls",
    (await count("banner_assets", "county_fips = ?", COUNTY)) === 0,
  );

  const list = await api("GET", "/counties?query=Moffat&limit=5", ADMIN);
  check(
    "administrator lists counties with a bounded query",
    list.status === 200 &&
      list.body.counties.length === 1 &&
      list.body.counties[0].fips === "08081",
  );
  const owner = await api("GET", "/counties", { who: "api-owner" });
  check(
    "owner lists counties and paging is bounded",
    owner.status === 200 &&
      owner.body.counties.length === 25 &&
      owner.body.nextAfterFips === "08047",
  );
  check(
    "an agent administrator authenticates with its bearer credential",
    (await api("GET", "/counties", { agent: true })).status === 200,
  );

  // ---- Origin for browser writes
  const originProbe = {
    versionId: "x",
    expectedRowVersion: 1,
    idempotencyKey: "origin-probe",
  };
  for (const origin of [
    null,
    "https://evil.invalid",
    "null",
    `${ORIGIN}:444`,
  ]) {
    const result = await api("POST", "/probe/publish", {
      ...ADMIN,
      origin,
      json: originProbe,
    });
    check(
      `write with origin ${origin} is rejected`,
      result.status === 403 && result.body.error === "origin_rejected",
    );
  }
  check(
    "a bad origin writes nothing",
    (await count(
      "banner_admin_operations",
      "idempotency_key = 'origin-probe'",
    )) === 0,
  );

  // ---- Stage, private preview, publish, replace, restore
  const before = await count("audit_events", "actor_account_id = 'api-admin'");
  const staged = await stage(
    newMeta("api-a", COUNTY, 0, true, "api-stage-a1"),
    files.apiPng1,
  );
  check(
    "stage a new banner image returns a verified private version",
    staged.status === 201 &&
      staged.body.verified === true &&
      staged.body.version.state === "verified",
    JSON.stringify(staged.body),
  );
  const v1 = staged.body.version.id;
  const replay = await stage(
    newMeta("api-a", COUNTY, 0, true, "api-stage-a1"),
    files.apiPng1,
  );
  check(
    "retrying the same stage key replays the same version",
    replay.status === 200 &&
      replay.body.replayed === true &&
      replay.body.version.id === v1,
  );
  check(
    "staged audit rows name the server principal",
    (await count("audit_events", "actor_account_id = 'api-admin'")) > before,
  );
  const reused = await stage(
    newMeta("api-a", COUNTY, 0, true, "api-stage-a1-other"),
    files.apiPng1,
  );
  check(
    "the same key for a different request is an idempotency conflict",
    (
      await stage(
        newMeta("api-a", COUNTY, 5, false, "api-stage-a1"),
        files.apiPng1,
      )
    ).status === 409 && reused.status === 409,
  );

  const preview = await api("GET", `/versions/${v1}/image`, ADMIN);
  check(
    "a staged version previews privately with private no-store and nosniff",
    preview.status === 200 &&
      preview.headers.get("cache-control") === "private, no-store" &&
      preview.headers.get("x-content-type-options") === "nosniff" &&
      preview.headers.get("content-type") === "image/png" &&
      (await sha256Hex(preview.bytes)) === files.apiPng1.sha256,
  );
  check(
    "a preview is refused to callers without banner.manage",
    (await api("GET", `/versions/${v1}/image`, { who: "api-editor" }))
      .status === 403 &&
      (await api("GET", `/versions/${v1}/image`)).status === 401,
  );
  check(
    "an unpublished version stays inaccessible through public delivery",
    (await publicReads.deliver(v1)) === null &&
      (await publicReads.resolveCounty(COUNTY)).length === 0,
  );
  check(
    "an unknown version previews as 404",
    (await api("GET", "/versions/no-such-version/image", ADMIN)).status === 404,
  );

  const stale = await api("POST", "/api-a/publish", {
    ...ADMIN,
    json: {
      versionId: v1,
      expectedRowVersion: 9,
      idempotencyKey: "api-pub-stale",
      metadata: FIRST,
    },
  });
  check(
    "publish with a stale row version is 409 stale_version",
    stale.status === 409 && stale.body.error === "stale_version",
  );
  const blankAlt = await api("POST", "/api-a/publish", {
    ...ADMIN,
    json: {
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "api-pub-blank",
      metadata: { ...FIRST, altText: "  " },
    },
  });
  check(
    "publish refuses blank alt text with a validation error",
    blankAlt.status === 422 && blankAlt.body.error === "validation_failed",
  );
  const published = await api("POST", "/api-a/publish", {
    ...ADMIN,
    json: {
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "api-pub-1",
      metadata: FIRST,
    },
  });
  check(
    "publish selects the version with its metadata",
    published.status === 200 &&
      published.body.status === "active" &&
      published.body.selectedVersionId === v1 &&
      published.body.rowVersion === 2 &&
      published.body.replayed === false &&
      typeof published.body.publicationId === "string",
    JSON.stringify(published.body),
  );
  const retried = await api("POST", "/api-a/publish", {
    ...ADMIN,
    json: {
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "api-pub-1",
      metadata: FIRST,
    },
  });
  check(
    "an idempotent publish retry replays and changes nothing",
    retried.status === 200 &&
      retried.body.replayed === true &&
      retried.body.rowVersion === 2 &&
      (await count("banner_publications", "banner_id = 'api-a'")) === 1,
  );
  const conflicting = await api("POST", "/api-a/publish", {
    ...ADMIN,
    json: {
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "api-pub-1",
      metadata: SECOND,
    },
  });
  check(
    "reusing a publish key for different metadata is idempotency_conflict",
    conflicting.status === 409 &&
      conflicting.body.error === "idempotency_conflict",
  );
  const publicBefore = await publicReads.deliver(v1);
  check(
    "the published version is publicly delivered and bytes match",
    publicBefore !== null &&
      (await sha256Hex(publicBefore.body)) === files.apiPng1.sha256,
  );

  const staged2 = await stage(
    nextMeta("api-a", COUNTY, 2, "api-stage-a2"),
    files.apiPng2,
  );
  const v2 = staged2.body.version.id;
  check(
    "a replacement stages without touching the live banner",
    staged2.status === 201 &&
      staged2.body.bannerRowVersion === 2 &&
      (await banner("api-a")).selected_version_id === v1 &&
      (await banner("api-a")).caption === FIRST.caption,
  );
  const preview2 = await api("GET", `/versions/${v2}/image`, ADMIN);
  check(
    "a verified version that is not selected still previews privately",
    preview2.status === 200 &&
      (await sha256Hex(preview2.bytes)) === files.apiPng2.sha256 &&
      (await publicReads.deliver(v2)) === null,
  );
  const replaced = await api("POST", "/api-a/publish", {
    ...ADMIN,
    json: {
      versionId: v2,
      expectedRowVersion: 2,
      idempotencyKey: "api-pub-2",
      metadata: SECOND,
    },
  });
  check(
    "publish replaces the live image and metadata together",
    replaced.status === 200 &&
      replaced.body.selectedVersionId === v2 &&
      (await publicReads.resolveCounty(COUNTY))[0]?.versionId === v2 &&
      (await publicReads.resolveCounty(COUNTY))[0]?.caption ===
        SECOND.caption &&
      (await publicReads.deliver(v1)) === null,
  );
  const history = await api("GET", "/api-a/publications", ADMIN);
  check(
    "publication history is newest first and bounded",
    history.status === 200 &&
      history.body.publications.length === 2 &&
      history.body.publications[0].sequence === 2 &&
      history.body.publications[1].caption === FIRST.caption,
  );
  const firstPublicationId = history.body.publications[1].id;

  const restored = await api("POST", "/api-a/restore", {
    ...ADMIN,
    json: {
      versionId: v1,
      expectedRowVersion: 3,
      idempotencyKey: "api-restore-1",
    },
  });
  const restoredBanner = await banner("api-a");
  check(
    "restore selects the earlier version with its recorded caption, alt text, mode and focal point",
    restored.status === 200 &&
      restoredBanner.selected_version_id === v1 &&
      restoredBanner.caption === FIRST.caption &&
      restoredBanner.alt_text === FIRST.altText &&
      restoredBanner.display_mode === FIRST.displayMode &&
      restoredBanner.focal_x === FIRST.focalX &&
      restoredBanner.focal_y === FIRST.focalY,
  );
  const publications = await api("GET", "/api-a/publications", ADMIN);
  check(
    "the restore is recorded and references the original publication",
    publications.body.publications[0].origin === "restore_recorded" &&
      publications.body.publications[0].restoredFromPublicationId ===
        firstPublicationId,
  );
  const byPublication = await api("POST", "/api-a/restore", {
    ...ADMIN,
    json: {
      versionId: v2,
      expectedRowVersion: 4,
      idempotencyKey: "api-restore-2",
      publicationId: history.body.publications[0].id,
    },
  });
  check(
    "restore with a publication ID of the right version works, a wrong pairing is 409",
    byPublication.status === 200 &&
      (
        await api("POST", "/api-a/restore", {
          ...ADMIN,
          json: {
            versionId: v1,
            expectedRowVersion: 5,
            idempotencyKey: "api-restore-3",
            publicationId: history.body.publications[0].id,
          },
        })
      ).body?.error === "publication_mismatch",
  );

  // ---- Versions with no recorded publication need explicit metadata
  const staged3 = await stage(
    nextMeta("api-a", COUNTY, 5, "api-stage-a3"),
    files.apiPng3,
  );
  const v3 = staged3.body.version.id;
  const needsText = await api("POST", "/api-a/restore", {
    ...ADMIN,
    json: {
      versionId: v3,
      expectedRowVersion: 5,
      idempotencyKey: "api-restore-4",
    },
  });
  check(
    "restoring a version with no publication snapshot needs explicit metadata",
    needsText.status === 409 && needsText.body.error === "snapshot_required",
  );
  const explicit = await api("POST", "/api-a/restore", {
    ...ADMIN,
    json: {
      versionId: v3,
      expectedRowVersion: 5,
      idempotencyKey: "api-restore-5",
      metadata: text("Explicit caption", "Explicit alt", "contain", 0.4),
    },
  });
  const afterExplicit = await banner("api-a");
  const explicitHistory = await api("GET", "/api-a/publications", ADMIN);
  check(
    "explicit metadata restores it and is labelled restore_explicit",
    explicit.status === 200 &&
      afterExplicit.selected_version_id === v3 &&
      afterExplicit.caption === "Explicit caption" &&
      explicitHistory.body.publications[0].origin === "restore_explicit",
  );

  // ---- Metadata, second banner, reorder, withdraw
  const metadata = await api("POST", "/api-a/metadata", {
    ...ADMIN,
    json: {
      expectedRowVersion: 6,
      idempotencyKey: "api-meta-1",
      change: { caption: "Edited caption" },
    },
  });
  check(
    "metadata update changes only the named field",
    metadata.status === 200 &&
      (await banner("api-a")).caption === "Edited caption" &&
      (await banner("api-a")).alt_text === "Explicit alt",
  );
  const secondBanner = await stage(
    newMeta("api-b", COUNTY, 1, false, "api-stage-b1"),
    files.apiJpeg,
    {
      headers: { "content-type": "image/jpeg" },
    },
  );
  check(
    "a JPEG stages as a second banner",
    secondBanner.status === 201 &&
      secondBanner.body.version.mediaType === "image/jpeg",
    JSON.stringify(secondBanner.body),
  );
  const countyDetail = await api("GET", `/counties/${COUNTY}`, ADMIN);
  check(
    "county detail lists banners with versions and no object keys",
    countyDetail.status === 200 &&
      countyDetail.body.banners.length === 2 &&
      countyDetail.body.banners[0].versions.length === 3 &&
      !JSON.stringify(countyDetail.body).includes("banner-assets/"),
  );
  const reorder = await api("POST", `/counties/${COUNTY}/reorder`, {
    ...ADMIN,
    json: {
      idempotencyKey: "api-order-1",
      orderedBannerIds: ["api-b", "api-a"],
      expectedRowVersions: { "api-a": 7, "api-b": 1 },
    },
  });
  check(
    "county reorder swaps display order",
    reorder.status === 200 &&
      (await banner("api-b")).display_order === 0 &&
      (await banner("api-a")).display_order === 1,
    JSON.stringify(reorder.body),
  );
  const afterOrder = reorder.body.banners.find((b) => b.bannerId === "api-a");
  const withdraw = await api("POST", "/api-a/withdraw", {
    ...ADMIN,
    json: {
      expectedRowVersion: afterOrder.rowVersion,
      idempotencyKey: "api-withdraw-1",
    },
  });
  check(
    "withdraw removes the banner from public delivery but keeps history",
    withdraw.status === 200 &&
      withdraw.body.status === "withdrawn" &&
      (await publicReads.deliver(v3)) === null &&
      (await count("banner_asset_versions", "banner_id = 'api-a'")) === 3,
    JSON.stringify([
      withdraw.status,
      withdraw.body,
      await count("banner_asset_versions", "banner_id = 'api-a'"),
    ]),
  );
  check(
    "withdrawing twice is an invalid_state conflict",
    (
      await api("POST", "/api-a/withdraw", {
        ...ADMIN,
        json: {
          expectedRowVersion: withdraw.body.rowVersion,
          idempotencyKey: "api-withdraw-2",
        },
      })
    ).body?.error === "invalid_state",
  );

  // ---- Reconcile, missing and corrupt objects
  const clean = await api("GET", "/api-a/reconcile", ADMIN);
  check(
    "reconcile reports unchanged verified objects",
    clean.status === 200 &&
      clean.body.items.every((i) => i.classification === "verified_unchanged"),
  );
  const keyOf = (id) => `banner-assets/${id}`;
  const stored = bucket.objects.get(keyOf(v2));
  const original = stored.body;
  stored.body = new Uint8Array([
    ...original.slice(0, original.length - 1),
    original[original.length - 1] ^ 0xff,
  ]);
  const corrupt = await api("GET", `/versions/${v2}/image`, ADMIN);
  check(
    "a corrupt preview object is 409 object_verification_failed with no body leak",
    corrupt.status === 409 &&
      corrupt.body.error === "object_verification_failed" &&
      !JSON.stringify(corrupt.body).includes("banner-assets/"),
  );
  check(
    "reconcile flags the integrity failure read-only",
    (await api("GET", "/api-a/reconcile", ADMIN)).body.items.some(
      (i) =>
        i.versionId === v2 &&
        i.classification === "stored_object_integrity_failed",
    ),
  );
  stored.body = original;
  bucket.objects.delete(keyOf(v3));
  const missing = await api("GET", `/versions/${v3}/image`, ADMIN);
  check(
    "a missing preview object is 409 object_verification_failed",
    missing.status === 409 &&
      missing.body.error === "object_verification_failed",
  );
  check(
    "reconcile flags the missing object",
    (await api("GET", "/api-a/reconcile", ADMIN)).body.items.some(
      (i) =>
        i.versionId === v3 && i.classification === "verified_object_missing",
    ),
  );
  const noPublish = await api("POST", "/api-a/restore", {
    ...ADMIN,
    json: {
      versionId: v3,
      expectedRowVersion: withdraw.body.rowVersion,
      idempotencyKey: "api-restore-missing",
      metadata: FIRST,
    },
  });
  check(
    "restore of a version whose object is missing is refused",
    noPublish.status === 409 &&
      noPublish.body.error === "object_verification_failed",
  );
  bucket.objects.set(keyOf(v3), {
    body: files.apiPng3.bytes,
    customMetadata: { sha256: files.apiPng3.sha256, versionId: v3 },
  });
  const metadataMismatch = bucket.objects.get(keyOf(v3));
  metadataMismatch.customMetadata = { sha256: "0".repeat(64), versionId: v3 };
  check(
    "recorded object metadata is verified before serving",
    (await api("GET", `/versions/${v3}/image`, ADMIN)).status === 409,
  );
  metadataMismatch.customMetadata = {
    sha256: files.apiPng3.sha256,
    versionId: v3,
  };
  check(
    "a repaired object serves again",
    (await api("GET", `/versions/${v3}/image`, ADMIN)).status === 200,
  );
  storage.corruptNextGet = true;
  check(
    "a read that returns damaged bytes is refused",
    (await api("GET", `/versions/${v1}/image`, ADMIN)).status === 409,
  );

  // ---- Image rejection and storage failure
  const gif = await stage(newMeta("api-c", "08023", 0, true, "api-stage-gif"), {
    ...files.gif,
    mediaType: "image/png",
  });
  const truncated = await stage(
    newMeta("api-c", "08023", 0, true, "api-stage-trunc"),
    files.truncatedPng,
  );
  check(
    "a non-PNG/JPEG body is 415 and a damaged PNG is 422",
    gif.status === 415 &&
      gif.body.error === "unsupported_image_type" &&
      truncated.status === 422 &&
      truncated.body.error === "invalid_image",
  );
  check(
    "a rejected image leaves no banner behind",
    (await banner("api-c")) === null,
  );
  const mismatchedDigest = await stage(
    {
      ...newMeta("api-c", "08023", 0, true, "api-stage-digest"),
      expectedSha256: "f".repeat(64),
    },
    files.apiPng4,
  );
  check(
    "a client digest that does not match the bytes is 422",
    mismatchedDigest.status === 422 &&
      mismatchedDigest.body.error === "validation_failed",
  );
  storage.failNextPut = true;
  const failed = await stage(
    newMeta("api-c", "08023", 0, true, "api-stage-fail"),
    files.apiPng4,
  );
  check(
    "a storage failure while staging is 503 storage_failed and retryable",
    failed.status === 503 &&
      failed.body.error === "storage_failed" &&
      failed.body.retryable === true,
    JSON.stringify(failed.body),
  );
  const retry = await stage(
    newMeta("api-c", "08023", 0, true, "api-stage-fail"),
    files.apiPng4,
  );
  check(
    "the same key retries to success after a storage failure",
    retry.status === 201 && retry.body.verified === true,
    JSON.stringify(retry.body),
  );
  const foreign = await stage(
    {
      ...newMeta("api-c", "08023", 0, true, "api-stage-foreign"),
      actor: "api-owner",
    },
    files.apiPng5,
  );
  const keyed = await stage(
    {
      ...newMeta("api-c", "08023", 0, true, "api-stage-key"),
      objectKey: "banner-assets/x",
    },
    files.apiPng5,
  );
  check(
    "caller-supplied actor and object-key fields are rejected",
    foreign.status === 400 && keyed.status === 400,
  );

  // ---- Revocation after the initial permission check
  const baseline = await everything("api-b");
  const bVersion = reorder.body.banners.find(
    (b) => b.bannerId === "api-b",
  ).rowVersion;
  afterAuthorize = async () => {
    await env.DB.prepare(
      "UPDATE identities SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = 'api-temp-identity'",
    ).run();
  };
  const revoked = await api("POST", "/api-b/metadata", {
    who: "api-temp",
    json: {
      expectedRowVersion: bVersion,
      idempotencyKey: "api-revoked-1",
      change: { caption: "Should not land" },
    },
  });
  check(
    "an identity revoked after the permission check cannot finish the write",
    revoked.status === 403 &&
      revoked.body.error === "forbidden" &&
      (
        await sql(
          "SELECT revoked_at FROM identities WHERE id = 'api-temp-identity'",
        )
      ).revoked_at !== null &&
      same(baseline, await everything("api-b")),
  );
  check(
    "the revoked identity is refused afterwards",
    (await api("GET", "/counties", { who: "api-temp" })).status === 401,
    JSON.stringify(
      await sql(
        "SELECT revoked_at FROM identities WHERE id = 'api-temp-identity'",
      ),
    ),
  );

  // ---- Agents keep working without an origin, humans need one
  const agentWrite = await api("POST", "/api-b/metadata", {
    agent: true,
    origin: null,
    json: {
      expectedRowVersion: bVersion,
      idempotencyKey: "api-agent-1",
      change: { caption: "Agent caption" },
    },
  });
  check(
    "an agent with a bearer credential writes without an origin and is audited as the agent",
    agentWrite.status === 200 &&
      (await banner("api-b")).caption === "Agent caption" &&
      (await count(
        "audit_events",
        "actor_account_id = 'api-agent' AND action = 'banner.metadata.updated'",
      )) === 1,
  );
  check(
    "the audit actor of a human write is the server-derived account",
    (await count(
      "audit_events",
      "actor_account_id = 'api-admin' AND action = 'banner.published'",
    )) === 2,
  );

  // ---- Responses never expose storage internals
  check(
    "no response body contained an object key or a raw storage error",
    texts.every(
      (t) =>
        !t.includes("banner-assets/") && !/injected storage failure/.test(t),
    ),
  );
  check(
    "public delivery rules are unchanged: unselected and withdrawn versions stay 404",
    (await publicReads.deliver(v1)) === null &&
      (await publicReads.deliver(v2)) === null &&
      (await publicReads.deliver(v3)) === null,
  );

  return { checks };
}

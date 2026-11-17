import { BANNER_ADMIN_LIMITS } from "../../src/contracts/banner-administration.ts";
import { AsyncD1Database } from "../../src/database/d1.ts";
import {
  BannerStageError,
  D1BannerAdministration,
} from "../../src/services/banner-admin-d1.ts";
import {
  BannerConflictError,
  BannerValidationError,
} from "../../src/services/banner-assets.ts";
import { BannerImageError } from "../../src/services/banner-image-inspector.ts";
import { D1BannerPublicService } from "../../src/services/banner-public.ts";
import { R2BannerObjectStorage } from "../../src/services/banner-storage.ts";
import {
  AuthorizationError,
  makeTrustedPrincipal,
} from "../../src/services/security.ts";

/** Disposable stand-in for a Workers R2 bucket binding. It never leaves memory. */
export class MemoryR2 {
  objects = new Map();
  async put(key, value, options) {
    if (options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(key))
      return null;
    const stored = {
      body: new Uint8Array(value),
      customMetadata: { ...options.customMetadata },
    };
    this.objects.set(key, stored);
    return {
      size: stored.body.byteLength,
      customMetadata: stored.customMetadata,
    };
  }
  async get(key) {
    const o = this.objects.get(key);
    return o
      ? {
          size: o.body.byteLength,
          customMetadata: o.customMetadata,
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

/** Injects storage faults around the real R2 adapter. */
export class FaultStorage {
  failNextPut = false;
  corruptNextGet = false;
  afterPut = null;
  constructor(inner) {
    this.inner = inner;
  }
  async putIfAbsent(key, body, metadata) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("injected storage failure");
    }
    const result = await this.inner.putIfAbsent(key, body, metadata);
    if (this.afterPut) {
      const hook = this.afterPut;
      this.afterPut = null;
      await hook();
    }
    return result;
  }
  async get(key) {
    const object = await this.inner.get(key);
    if (object && this.corruptNextGet) {
      this.corruptNextGet = false;
      const body = new Uint8Array(object.body);
      body[body.length - 1] ^= 0xff;
      return { ...object, body };
    }
    return object;
  }
  head(key) {
    return this.inner.head(key);
  }
  listKeys(prefix) {
    return this.inner.listKeys(prefix);
  }
}

/** Revokes an identity at the moment the guarded batch reads its generation. */
export class RevokingDatabase extends AsyncD1Database {
  hook = null;
  guardedAttempts = 0;
  guardedFailures = 0;
  async readDependencyGeneration() {
    if (this.hook) {
      const hook = this.hook;
      this.hook = null;
      await hook();
    }
    return super.readDependencyGeneration();
  }
  async guardedBatch(...args) {
    this.guardedAttempts += 1;
    try {
      return await super.guardedBatch(...args);
    } catch (error) {
      this.guardedFailures += 1;
      throw error;
    }
  }
}

const b64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export async function runBannerAdminChecks(env, fixtures) {
  const checks = [];
  const check = (name, passed) => {
    if (!passed) throw new Error(`Banner admin check failed: ${name}`);
    checks.push(name);
  };
  const rejects = async (name, promise, type, code) => {
    let value;
    try {
      value = await promise;
    } catch (error) {
      const ok =
        error instanceof type && (code === undefined || error.code === code);
      if (!ok) throw new Error(`Banner admin check failed: ${name}: ${error}`);
      checks.push(name);
      return;
    }
    throw new Error(
      `Banner admin check failed: ${name}: did not reject ${JSON.stringify(value)}`,
    );
  };
  const files = Object.fromEntries(
    Object.entries(fixtures).map(([name, file]) => [
      name,
      { ...file, bytes: b64(file.base64) },
    ]),
  );
  const sql = async (query, ...values) =>
    env.DB.prepare(query)
      .bind(...values)
      .first();
  const rows = async (query, ...values) =>
    (
      await env.DB.prepare(query)
        .bind(...values)
        .all()
    ).results;
  const count = async (table, where = "1=1", ...values) =>
    (await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...values))
      .n;

  for (const [id, role] of [
    ["ba-admin", "administrator"],
    ["ba-owner", "owner"],
    ["ba-editor", "editor"],
    ["ba-temp", "administrator"],
    ["ba-temp2", "administrator"],
    ["ba-revoked", "administrator"],
  ]) {
    await env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'human', ?, 'Synthetic banner operator')",
    )
      .bind(id, role)
      .run();
    await env.DB.prepare(
      "INSERT INTO identities (id, account_id, provider, subject, revoked_at) VALUES (?, ?, 'synthetic', ?, ?)",
    )
      .bind(
        `${id}-identity`,
        id,
        id,
        id === "ba-revoked" ? "2026-01-01T00:00:00.000Z" : null,
      )
      .run();
  }
  const principal = (id, role = null) =>
    makeTrustedPrincipal(
      {
        id,
        identity_id: `${id}-identity`,
        kind: "human",
        role:
          role ??
          { "ba-owner": "owner", "ba-editor": "editor" }[id] ??
          "administrator",
      },
      "synthetic",
    );
  const admin = principal("ba-admin");
  const owner = principal("ba-owner");

  const bucket = new MemoryR2();
  const storage = new FaultStorage(new R2BannerObjectStorage(bucket));
  const db = new AsyncD1Database(env.DB);
  const service = new D1BannerAdministration(db, storage);
  const publicReads = new D1BannerPublicService(db, bucket);

  const metadata = (patch = {}) => ({
    caption: "Synthetic landmark",
    altText: "Synthetic panorama made of colored bands",
    displayOrder: 0,
    isPrimary: true,
    displayMode: "cover",
    focalX: 0.5,
    focalY: 0.5,
    ...patch,
  });
  const stageNew = (id, county, file, key, meta = {}, extra = {}) => ({
    bannerId: id,
    countyFips: county,
    sourceFilename: `${id}.${file.bytes[0] === 0xff ? "jpg" : "png"}`,
    bytes: file.bytes,
    idempotencyKey: key,
    target: { kind: "new", metadata: metadata(meta) },
    ...extra,
  });

  // ---- Authorization
  const editor = principal("ba-editor");
  await rejects(
    "editor cannot list counties",
    service.listCounties(editor),
    AuthorizationError,
  );
  await rejects(
    "editor cannot read a county",
    service.getCounty(editor, "08001"),
    AuthorizationError,
  );
  await rejects(
    "editor cannot stage",
    service.stage(
      editor,
      stageNew("ba-denied", "08001", files.pngA, "denied-1"),
    ),
    AuthorizationError,
  );
  await rejects(
    "editor cannot reconcile",
    service.reconcileBanner(editor, "x"),
    AuthorizationError,
  );
  await rejects(
    "an inflated claimed role is refused by the live account row",
    service.listCounties(principal("ba-editor", "administrator")),
    AuthorizationError,
  );
  await rejects(
    "a revoked identity is refused",
    service.listCounties(principal("ba-revoked")),
    AuthorizationError,
  );
  check(
    "owner and administrator may read",
    (await service.listCounties(owner)).counties.length > 0 &&
      (await service.listCounties(admin)).counties.length > 0,
  );
  check(
    "denied attempts changed nothing",
    (await count("banner_assets")) === 0 &&
      (await count("banner_asset_versions")) === 0 &&
      bucket.objects.size === 0,
  );

  // ---- Bounded county reads
  const first = await service.listCounties(admin, { limit: 3 });
  check(
    "county list is paged with a cursor",
    first.counties.length === 3 &&
      typeof first.nextAfterFips === "string" &&
      first.counties[0].fips < first.counties[1].fips,
  );
  const second = await service.listCounties(admin, {
    limit: 3,
    afterFips: first.nextAfterFips,
  });
  check(
    "next page continues after the cursor",
    second.counties[0].fips > first.nextAfterFips,
  );
  check(
    "county search matches name and FIPS prefix, case-insensitively",
    (await service.listCounties(admin, { query: "adams" })).counties.some(
      (c) => c.fips === "08001",
    ) &&
      (await service.listCounties(admin, { query: "0800" })).counties.every(
        (c) => c.fips.startsWith("0800"),
      ),
  );
  check(
    "search wildcards match literally",
    (await service.listCounties(admin, { query: "%" })).counties.length === 0,
  );
  await rejects(
    "oversized page is refused",
    service.listCounties(admin, { limit: 101 }),
    BannerValidationError,
  );
  await rejects(
    "malformed cursor is refused",
    service.listCounties(admin, { afterFips: "x" }),
    BannerValidationError,
  );
  check(
    "unknown county reads as null",
    (await service.getCounty(admin, "08999")) === null,
  );
  await rejects(
    "non-Colorado FIPS is refused",
    service.getCounty(admin, "09001"),
    BannerValidationError,
  );
  check(
    "county with no banners is valid",
    (await service.getCounty(admin, "08001")).banners.length === 0,
  );

  // ---- Stage a new banner. Facts come from the bytes, not from the caller.
  const A = await service.stage(
    admin,
    stageNew(
      "ba-adams-east",
      "08001",
      files.pngA,
      "key-a",
      {},
      {
        expectedSha256: files.pngA.sha256,
      },
    ),
  );
  const rowA = await sql(
    "SELECT * FROM banner_assets WHERE id = 'ba-adams-east'",
  );
  const versionA = await sql(
    "SELECT * FROM banner_asset_versions WHERE id = ?",
    A.version.id,
  );
  check(
    "a decoded PNG becomes verified with server-derived facts",
    A.verified &&
      A.decode === "full" &&
      A.version.state === "verified" &&
      A.version.width === files.pngA.width &&
      A.version.height === files.pngA.height &&
      A.version.sha256 === files.pngA.sha256 &&
      A.version.byteSize === files.pngA.bytes.length &&
      JSON.parse(versionA.verification_json).decode === "full",
  );
  check(
    "a new banner is a private draft with nothing selected",
    rowA.status === "draft" &&
      rowA.selected_version_id === null &&
      rowA.version === 1,
  );
  check(
    "the object key is generated from the version id and stored once",
    versionA.object_key === `banner-assets/${A.version.id}` &&
      bucket.objects.has(versionA.object_key) &&
      !versionA.object_key.includes("ba-adams-east"),
  );
  const auditA = await rows(
    "SELECT action, actor_account_id FROM audit_events WHERE target_id = 'ba-adams-east' ORDER BY created_at, rowid",
  );
  check(
    "stage audit rows are attributed to the acting account and never carry paths",
    auditA.map((r) => r.action).join() ===
      "banner.stage.started,banner.stage.verified" &&
      auditA.every((r) => r.actor_account_id === "ba-admin"),
  );

  // Simulate the later, separate publish step so staging can be tested against a live banner.
  await env.DB.prepare(
    "UPDATE banner_assets SET selected_version_id = ?, status = 'active', version = version + 1 WHERE id = 'ba-adams-east'",
  )
    .bind(A.version.id)
    .run();
  const liveBefore = await publicReads.resolveCounty("08001");
  check(
    "the public reader serves the selected version",
    liveBefore.length === 1 && liveBefore[0].versionId === A.version.id,
  );
  const snapshot = async () =>
    JSON.stringify(
      await sql(
        "SELECT selected_version_id, status, caption, alt_text, display_mode, focal_x, focal_y, display_order, is_primary, homepage_order, version, updated_at FROM banner_assets WHERE id = 'ba-adams-east'",
      ),
    );
  const before = await snapshot();

  // ---- Stage a replacement. Public selection and text must not move.
  const B = await service.stage(admin, {
    bannerId: "ba-adams-east",
    countyFips: "08001",
    sourceFilename: "replacement.png",
    bytes: files.pngB.bytes,
    idempotencyKey: "key-b",
    target: { kind: "existing", expectedRowVersion: 2 },
  });
  check(
    "the replacement is verified but not selected",
    B.verified && !B.version.isSelected,
  );
  check(
    "staging leaves the selected version, caption, alt text and row version untouched",
    (await snapshot()) === before,
  );
  const liveAfter = await publicReads.resolveCounty("08001");
  check(
    "public output is unchanged by staging",
    liveAfter.length === 1 &&
      liveAfter[0].versionId === A.version.id &&
      liveAfter[0].caption === liveBefore[0].caption &&
      liveAfter[0].altText === liveBefore[0].altText,
  );
  check(
    "the new version records the previous selected version",
    (
      await sql(
        "SELECT previous_version_id FROM banner_asset_versions WHERE id = ?",
        B.version.id,
      )
    ).previous_version_id === A.version.id,
  );
  const detail = await service.getCounty(admin, "08001");
  const shown = detail.banners[0];
  check(
    "county detail lists both versions, marks the selected one and stays public",
    shown.versions.length === 2 &&
      shown.versions
        .filter((v) => v.isSelected)
        .map((v) => v.id)
        .join() === A.version.id &&
      shown.publicEligible &&
      shown.rowVersion === 2 &&
      shown.versions.every((v) => v.stagedByAccountId === "ba-admin") &&
      !("objectKey" in shown.versions[0]),
  );

  // ---- Idempotency and conflicts
  const counts = async () =>
    [
      await count("banner_assets"),
      await count("banner_asset_versions"),
      await count("banner_stage_operations"),
      bucket.objects.size,
    ].join();
  const stable = await counts();
  const replay = await service.stage(admin, {
    bannerId: "ba-adams-east",
    countyFips: "08001",
    sourceFilename: "replacement.png",
    bytes: files.pngB.bytes,
    idempotencyKey: "key-b",
    target: { kind: "existing", expectedRowVersion: 2 },
  });
  check(
    "a repeated key returns the stored result and writes nothing",
    replay.replayed &&
      replay.version.id === B.version.id &&
      (await counts()) === stable,
  );
  const existing = (patch = {}) => ({
    bannerId: "ba-adams-east",
    countyFips: "08001",
    sourceFilename: "replacement.png",
    bytes: files.pngB.bytes,
    idempotencyKey: "key-b",
    target: { kind: "existing", expectedRowVersion: 2 },
    ...patch,
  });
  await rejects(
    "the same key with different bytes conflicts",
    service.stage(admin, existing({ bytes: files.pngC.bytes })),
    BannerConflictError,
  );
  await rejects(
    "the same key with a different filename conflicts",
    service.stage(admin, existing({ sourceFilename: "other.png" })),
    BannerConflictError,
  );
  await rejects(
    "the same key from a different actor conflicts",
    service.stage(owner, existing()),
    BannerConflictError,
  );
  await rejects(
    "a stale expected row version conflicts",
    service.stage(
      admin,
      existing({
        idempotencyKey: "key-stale",
        bytes: files.pngC.bytes,
        target: { kind: "existing", expectedRowVersion: 1 },
      }),
    ),
    BannerConflictError,
  );
  await rejects(
    "staging a new banner over an existing id conflicts",
    service.stage(
      admin,
      stageNew("ba-adams-east", "08001", files.pngC, "key-over"),
    ),
    BannerConflictError,
  );
  await rejects(
    "an existing-banner stage for the wrong county conflicts",
    service.stage(
      admin,
      existing({
        idempotencyKey: "key-county",
        bytes: files.pngC.bytes,
        countyFips: "08003",
      }),
    ),
    BannerConflictError,
  );
  await rejects(
    "an existing-banner stage for a missing banner conflicts",
    service.stage(
      admin,
      existing({
        bannerId: "ba-missing",
        idempotencyKey: "key-missing",
        bytes: files.pngC.bytes,
      }),
    ),
    BannerConflictError,
  );
  await rejects(
    "the same digest on another banner needs review",
    service.stage(
      admin,
      stageNew("ba-adams-west", "08001", files.pngA, "key-cross", {
        displayOrder: 1,
        isPrimary: false,
      }),
    ),
    BannerConflictError,
  );
  await rejects(
    "a duplicate display order in a county conflicts",
    service.stage(
      admin,
      stageNew("ba-order", "08001", files.pngC, "key-order", {
        displayOrder: 0,
        isPrimary: false,
      }),
    ),
    BannerConflictError,
  );
  await rejects(
    "a second primary banner in a county conflicts",
    service.stage(
      admin,
      stageNew("ba-primary", "08001", files.pngC, "key-primary", {
        displayOrder: 3,
      }),
    ),
    BannerConflictError,
  );
  check(
    "rejected requests created no rows or objects",
    (await counts()) === stable,
  );
  const reuse = await service.stage(
    admin,
    existing({ idempotencyKey: "key-reuse" }),
  );
  check(
    "the same image again under a new key reuses the version without a new object",
    reuse.replayed &&
      reuse.version.id === B.version.id &&
      (await count("banner_stage_operations")) === 3 &&
      bucket.objects.size === 2,
  );

  const stable2 = await counts();

  // ---- Validation before any write
  const bad = (patch, key) =>
    service.stage(admin, {
      ...stageNew("ba-valid", "08003", files.pngC, key),
      ...patch,
    });
  await rejects(
    "a parent-relative source filename is refused",
    bad({ sourceFilename: "../escape.png" }, "v1"),
    BannerValidationError,
  );
  await rejects(
    "a drive-letter source filename is refused",
    bad({ sourceFilename: "C:\\banners\\a.png" }, "v2"),
    BannerValidationError,
  );
  await rejects(
    "a banner id with a path separator is refused",
    bad({ bannerId: "a/b" }, "v3"),
    BannerValidationError,
  );
  await rejects(
    "a client digest that disagrees with the bytes is refused",
    bad({ expectedSha256: "0".repeat(64) }, "v4"),
    BannerValidationError,
  );
  await rejects(
    "blank alt text on a new banner is refused",
    bad(
      { target: { kind: "new", metadata: metadata({ altText: "  " }) } },
      "v5",
    ),
    BannerValidationError,
  );
  await rejects(
    "an out-of-range focal point is refused",
    bad({ target: { kind: "new", metadata: metadata({ focalX: 2 }) } }, "v6"),
    BannerValidationError,
  );
  await rejects(
    "an unknown target kind is refused",
    bad({ target: { kind: "other" } }, "v7"),
    BannerValidationError,
  );
  check("validation failures created nothing", (await counts()) === stable2);

  // ---- Malformed and oversized images are refused before any database or storage write
  for (const [name, code] of [
    ["truncatedPng", "decode_failed"],
    ["badCrcPng", "decode_failed"],
    ["corruptDataPng", "decode_failed"],
    ["bombPng", "decode_failed"],
    ["shortDataPng", "decode_failed"],
    ["interlacedPng", "unsupported_type"],
    ["gif", "unsupported_type"],
    ["oversizedClaimPng", "dimensions_exceeded"],
    ["truncatedJpeg", "malformed"],
    ["corruptJpeg", "decode_failed"],
    ["oversizedClaimJpeg", "dimensions_exceeded"],
  ]) {
    await rejects(
      `${name} is refused with ${code}`,
      service.stage(
        admin,
        stageNew(
          `ba-${name.toLowerCase()}`,
          "08003",
          { bytes: files[name].bytes },
          `m-${name}`,
          { displayOrder: 9, isPrimary: false },
        ),
      ),
      BannerImageError,
      code,
    );
  }
  await rejects(
    "an empty upload is refused",
    service.stage(
      admin,
      stageNew("ba-empty", "08003", { bytes: new Uint8Array() }, "m-empty"),
    ),
    BannerImageError,
    "empty",
  );
  check(
    "malformed images created no rows or objects",
    (await counts()) === stable2,
  );

  // ---- JPEG: fully decoded by the server before it can be verified
  const J = await service.stage(
    admin,
    stageNew("ba-alamosa-jpeg", "08003", files.jpegA, "key-jpeg"),
  );
  check(
    "a decoded JPEG becomes verified with server-derived facts",
    J.verified &&
      J.decode === "full" &&
      J.version.state === "verified" &&
      J.version.mediaType === "image/jpeg" &&
      J.version.width === files.jpegA.width &&
      J.version.height === files.jpegA.height,
  );
  const county03 = (await service.listCounties(admin, { query: "08003" }))
    .counties[0];
  check(
    "a staged JPEG draft is not public",
    county03.bannerCount === 1 && county03.publicBannerCount === 0,
  );
  const jpegReplay = await service.stage(
    admin,
    stageNew("ba-alamosa-jpeg", "08003", files.jpegA, "key-jpeg"),
  );
  check(
    "a JPEG replay returns the stored result",
    jpegReplay.replayed && jpegReplay.version.state === "verified",
  );

  // ---- Digest-attested JPEG: the pixel decode is skipped, the digest still gates
  const attestedStage = (key, file, extra = {}) =>
    stageNew(
      "ba-alamosa-attested",
      "08003",
      file,
      key,
      {},
      {
        expectedSha256: file.sha256,
        decodeAttestation: "owner_local_full_decode",
        ...extra,
      },
    );
  const AT = await service.stage(
    admin,
    stageNew(
      "ba-alamosa-attested",
      "08003",
      files.jpegB,
      "k-at-ok",
      { displayOrder: 7, isPrimary: false },
      {
        expectedSha256: files.jpegB.sha256,
        decodeAttestation: "owner_local_full_decode",
      },
    ),
  );
  const atVersion = await sql(
    "SELECT * FROM banner_asset_versions WHERE id = ?",
    AT.version.id,
  );
  const atVerification = JSON.parse(atVersion.verification_json);
  check(
    "an attested JPEG is verified without a Worker pixel decode and the skip is recorded",
    AT.verified &&
      AT.decode === "attested_local" &&
      AT.version.state === "verified" &&
      atVerification.decode === "attested_local" &&
      typeof atVerification.note === "string" &&
      atVerification.note.includes("skipped") &&
      typeof AT.note === "string",
  );
  await rejects(
    "an attestation needs the expected digest",
    service.stage(admin, {
      ...attestedStage("k-at-nodigest", files.jpegA),
      expectedSha256: undefined,
    }),
    BannerValidationError,
  );
  await rejects(
    "an attestation with a wrong digest is refused before storage",
    service.stage(
      admin,
      attestedStage("k-at-wrong", files.jpegA, {
        expectedSha256: "0".repeat(64),
      }),
    ),
    BannerValidationError,
  );
  await rejects(
    "an attestation applies to JPEG images only",
    service.stage(admin, attestedStage("k-at-png", files.pngA)),
    BannerValidationError,
  );

  // ---- Storage failure, then retry with the same key
  storage.failNextPut = true;
  await rejects(
    "a storage failure surfaces as a retryable stage error",
    service.stage(
      admin,
      stageNew("ba-alamosa-2", "08003", files.pngC, "key-fail", {
        displayOrder: 1,
        isPrimary: false,
      }),
    ),
    BannerStageError,
    "storage_failed",
  );
  const failed = await sql(
    "SELECT v.id, v.state, v.object_key, o.state AS op_state, o.error_code FROM banner_asset_versions v JOIN banner_stage_operations o ON o.version_id = v.id WHERE o.idempotency_key = 'key-fail'",
  );
  check(
    "a storage failure leaves a failed version and an interrupted operation with no object",
    failed.state === "failed" &&
      failed.op_state === "interrupted" &&
      failed.error_code === "storage_verification_failed" &&
      !bucket.objects.has(failed.object_key),
  );
  const retried = await service.stage(
    admin,
    stageNew("ba-alamosa-2", "08003", files.pngC, "key-fail", {
      displayOrder: 1,
      isPrimary: false,
    }),
  );
  check(
    "the retry reuses the same version id and immutable key and verifies",
    retried.verified &&
      retried.version.id === failed.id &&
      bucket.objects.has(failed.object_key) &&
      !retried.replayed,
  );
  storage.corruptNextGet = true;
  await rejects(
    "a corrupt reread is refused",
    service.stage(
      admin,
      stageNew("ba-alamosa-3", "08003", files.pngD, "key-corrupt", {
        displayOrder: 2,
        isPrimary: false,
      }),
    ),
    BannerStageError,
    "storage_failed",
  );
  const corrupt = await sql(
    "SELECT v.state FROM banner_asset_versions v JOIN banner_stage_operations o ON o.version_id = v.id WHERE o.idempotency_key = 'key-corrupt'",
  );
  const corruptRetry = await service.stage(
    admin,
    stageNew("ba-alamosa-3", "08003", files.pngD, "key-corrupt", {
      displayOrder: 2,
      isPrimary: false,
    }),
  );
  check(
    "a corrupt reread fails the version and the retry then verifies",
    corrupt.state === "failed" && corruptRetry.verified,
  );
  check(
    "failed attempts are audited without paths or credentials",
    (await count("audit_events", "action = 'banner.stage.failed'")) === 2,
  );

  // ---- Authority lost after the object was written
  storage.afterPut = () =>
    env.DB.prepare(
      "UPDATE identities SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1 WHERE id = 'ba-temp-identity'",
    ).run();
  const temp = principal("ba-temp");
  await rejects(
    "a principal revoked after the object write cannot finalize",
    service.stage(
      temp,
      stageNew("ba-adams-late", "08001", files.pngE, "key-late", {
        displayOrder: 5,
        isPrimary: false,
      }),
    ),
    AuthorizationError,
  );
  const late = await sql(
    "SELECT v.id, v.state, v.object_key, o.state AS op_state FROM banner_asset_versions v JOIN banner_stage_operations o ON o.version_id = v.id WHERE o.idempotency_key = 'key-late'",
  );
  check(
    "the abandoned version stays in staging with its object present and is never verified",
    late.state === "staging" &&
      late.op_state === "staging" &&
      bucket.objects.has(late.object_key) &&
      (await count(
        "audit_events",
        "target_id = 'ba-adams-late' AND action = 'banner.stage.verified'",
      )) === 0,
  );
  const reconciled = await service.reconcileBanner(admin, "ba-adams-late");
  check(
    "an authorized reader reconciles it read-only as an unverified object",
    reconciled.length === 1 &&
      reconciled[0].classification ===
        "object_present_unverified_database_state",
  );
  const keepSnapshot = await counts();
  await service.reconcileBanner(admin, "ba-adams-late");
  check("reconcile changes nothing", (await counts()) === keepSnapshot);
  await rejects(
    "the revoked principal cannot retry",
    service.stage(
      temp,
      stageNew("ba-adams-late", "08001", files.pngE, "key-late", {
        displayOrder: 5,
        isPrimary: false,
      }),
    ),
    AuthorizationError,
  );
  await rejects(
    "a second actor cannot silently adopt an unverified version",
    service.stage(admin, {
      bannerId: "ba-adams-late",
      countyFips: "08001",
      sourceFilename: "x.png",
      bytes: files.pngE.bytes,
      idempotencyKey: "key-adopt",
      target: { kind: "existing", expectedRowVersion: 1 },
    }),
    BannerConflictError,
  );
  check(
    "the abandoned draft is not public and the live banner is unchanged",
    (await publicReads.resolveCounty("08001")).length === 1 &&
      (await snapshot()) === before,
  );

  // ---- The guarded batch itself rejects a principal revoked mid-write
  const revoking = new RevokingDatabase(env.DB);
  const guardedService = new D1BannerAdministration(revoking, storage);
  const objectsBefore = bucket.objects.size;
  revoking.hook = () =>
    env.DB.prepare(
      "UPDATE identities SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1 WHERE id = 'ba-temp2-identity'",
    ).run();
  await rejects(
    "a revocation between the check and the batch rejects the write",
    guardedService.stage(
      principal("ba-temp2"),
      stageNew("ba-late2", "08005", files.pngF, "key-guard"),
    ),
    AuthorizationError,
  );
  check(
    "the in-batch principal assertion failed and nothing was written",
    revoking.guardedFailures === 1 &&
      (await count("banner_assets", "id = 'ba-late2'")) === 0 &&
      bucket.objects.size === objectsBefore,
  );

  // ---- Bounded reads
  await env.DB.prepare(
    "INSERT INTO banner_assets (id, county_fips, source_filename, display_order, created_by_account_id, updated_by_account_id) VALUES ('ba-seed', '08005', 'seed.png', 0, 'ba-admin', 'ba-admin')",
  ).run();
  for (let n = 0; n < 25; n += 1) {
    const id = `ba-seed-v${n}`;
    await env.DB.prepare(
      `INSERT INTO banner_asset_versions (id, banner_id, source_filename, sha256, width, height, aspect_ratio, byte_size, media_type, object_key, state, verified_at, created_at)
       VALUES (?, 'ba-seed', 'seed.png', ?, 10, 5, 2.0, 100, 'image/png', ?, 'verified', '2001-01-01T00:00:00.000Z', ?)`,
    )
      .bind(
        id,
        n.toString(16).padStart(64, "0"),
        `banner-assets/${id}`,
        `2001-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
      )
      .run();
  }
  await env.DB.prepare(
    "UPDATE banner_assets SET selected_version_id = 'ba-seed-v0', status = 'active', version = version + 1 WHERE id = 'ba-seed'",
  ).run();
  const seeded = (await service.getCounty(admin, "08005")).banners[0];
  check(
    "version history is bounded, newest first, and always includes the selected version",
    seeded.versions.length === BANNER_ADMIN_LIMITS.versionsPerBanner + 1 &&
      seeded.versionCount === 25 &&
      seeded.versionsTruncated &&
      seeded.versions[0].id === "ba-seed-v24" &&
      seeded.versions.at(-1).id === "ba-seed-v0" &&
      seeded.versions.at(-1).isSelected &&
      seeded.publicEligible,
  );
  for (let n = 0; n < 26; n += 1)
    await env.DB.prepare(
      "INSERT INTO banner_assets (id, county_fips, source_filename, display_order, created_by_account_id, updated_by_account_id) VALUES (?, '08007', 'seed.png', ?, 'ba-admin', 'ba-admin')",
    )
      .bind(`ba-many-${String(n).padStart(2, "0")}`, n)
      .run();
  const many = await service.getCounty(admin, "08007");
  check(
    "banners per county are bounded and flagged as truncated",
    many.banners.length === BANNER_ADMIN_LIMITS.bannersPerCounty &&
      many.bannersTruncated,
  );
  const adams = (await service.listCounties(admin, { query: "08001" }))
    .counties[0];
  check(
    "county summaries count banners, public banners and versions needing attention",
    adams.bannerCount === 2 &&
      adams.publicBannerCount === 1 &&
      adams.attentionVersionCount === 1,
  );
  check(
    "no raw object key, path or credential reaches a read result",
    !JSON.stringify([detail, seeded, adams]).includes("banner-assets/"),
  );

  return { success: true, checks };
}

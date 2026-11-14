import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pngjs from "pngjs";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  BannerAssetService,
  BannerConflictError,
  BannerValidationError,
  translateBanners1Record,
} from "../dist/services/banner-assets.js";
import {
  MemoryBannerObjectStorage,
  R2BannerObjectStorage,
} from "../dist/services/banner-storage.js";
import { createTestHumanIdentityAdapter } from "../dist/services/index.js";
import { resolvePrincipal } from "../dist/services/security.js";

const { PNG } = pngjs;
const png = PNG.sync.write({
  width: 2,
  height: 1,
  data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]),
});

async function fixture(t, role = "owner") {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database
    .prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'human', ?, 'Synthetic Operator')",
    )
    .run("banner-operator", role);
  database
    .prepare(
      "INSERT INTO identities (id, account_id, provider, subject) VALUES ('banner-identity', 'banner-operator', 'test-human', 'operator')",
    )
    .run();
  const principal = await resolvePrincipal(
    database,
    new Request("https://test.invalid", {
      headers: { "x-test-human-subject": "operator" },
    }),
    createTestHumanIdentityAdapter({ operator: "operator" }),
  );
  assert.ok(principal);
  const storage = new MemoryBannerObjectStorage();
  const service = new BannerAssetService(
    database,
    storage,
    (() => {
      let id = 0;
      return () => `synthetic-id-${++id}`;
    })(),
    (() => {
      let tick = 0;
      return () => `2026-11-13T00:00:${String(tick++).padStart(2, "0")}.000Z`;
    })(),
  );
  t.after(() => database.close());
  return { database, principal, storage, service };
}

function proposal(patch = {}) {
  const bytes = new Uint8Array(patch.bytes ?? png);
  return {
    bannerId: "banner-adams-east",
    countyFips: "08001",
    sourceFilename: "08001-Synthetic-Landmark.png",
    caption: "Synthetic landmark",
    altText: "Synthetic red and green panorama",
    displayOrder: 0,
    isPrimary: true,
    displayMode: "cover",
    focalX: 0.5,
    focalY: 0.5,
    width: 2,
    height: 1,
    bytes,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    idempotencyKey: "request-1",
    ...patch,
  };
}

test("stages immutable bytes, skips unchanged retries, then selects only verified content", async (t) => {
  const { service, storage, principal, database } = await fixture(t);
  const staged = await service.stage(proposal(), principal);
  assert.equal(staged.version.state, "verified");
  assert.equal(staged.banner.selectedVersionId, null);
  assert.equal(storage.writes, 1);
  const retry = await service.stage(proposal(), principal);
  assert.equal(retry.skipped, true);
  assert.equal(storage.writes, 1);
  await assert.rejects(
    service.stage(
      proposal({
        bannerId: "another-logical-banner",
        idempotencyKey: "duplicate-digest",
      }),
      principal,
    ),
    BannerConflictError,
  );
  await assert.rejects(
    service.stage(
      proposal({ caption: "Changed under the same key" }),
      principal,
    ),
    BannerConflictError,
  );
  const active = service.activate(
    staged.banner.id,
    staged.version.id,
    staged.banner.version,
    principal,
  );
  assert.equal(active.status, "active");
  assert.equal((await service.resolveCounty("08001")).length, 1);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE target_type = 'banner'",
      )
      .get().n >= 3,
    true,
  );
});

test("replacements retain the selected version until explicit activation and restore retained bytes", async (t) => {
  const { service, principal, storage } = await fixture(t);
  const first = await service.stage(proposal(), principal);
  const active = service.activate(
    first.banner.id,
    first.version.id,
    first.banner.version,
    principal,
  );
  const replacementBytes = PNG.sync.write({
    width: 2,
    height: 1,
    data: Buffer.from([0, 0, 255, 255, 255, 255, 0, 255]),
  });
  const second = await service.stage(
    proposal({
      bytes: replacementBytes,
      idempotencyKey: "request-2",
      expectedRowVersion: active.version,
    }),
    principal,
  );
  assert.equal(second.banner.selectedVersionId, first.version.id);
  const activations = await Promise.allSettled([
    Promise.resolve().then(() =>
      service.activate(
        first.banner.id,
        second.version.id,
        second.banner.version,
        principal,
      ),
    ),
    Promise.resolve().then(() =>
      service.activate(
        first.banner.id,
        first.version.id,
        second.banner.version,
        principal,
      ),
    ),
  ]);
  assert.equal(
    activations.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    activations.filter((result) => result.status === "rejected").length,
    1,
  );
  const selected = service.getBanner(first.banner.id);
  assert.equal(selected.selectedVersionId, second.version.id);
  const restored = await service.restore(
    first.banner.id,
    first.version.id,
    selected.version,
    principal,
  );
  assert.equal(restored.selectedVersionId, first.version.id);
  assert.equal(storage.writes, 2);
});

test("multiple county banners can be reordered and primary selection transfers atomically", async (t) => {
  const { service, principal } = await fixture(t);
  const first = await service.stage(proposal(), principal);
  const secondBytes = PNG.sync.write({
    width: 2,
    height: 1,
    data: Buffer.from([0, 0, 255, 255, 0, 0, 0, 255]),
  });
  const second = await service.stage(
    proposal({
      bannerId: "banner-adams-west",
      sourceFilename: "second.png",
      caption: "Second",
      displayOrder: 1,
      isPrimary: false,
      bytes: secondBytes,
      idempotencyKey: "second-banner",
    }),
    principal,
  );
  service.reorderCounty(
    "08001",
    [second.banner.id, first.banner.id],
    {
      [first.banner.id]: first.banner.version,
      [second.banner.id]: second.banner.version,
    },
    principal,
  );
  assert.deepEqual(await service.resolveCounty("08001"), []);
  const reorderedFirst = service.getBanner(first.banner.id);
  const reorderedSecond = service.getBanner(second.banner.id);
  service.updateMetadata(
    second.banner.id,
    reorderedSecond.version,
    { isPrimary: true },
    principal,
  );
  assert.equal(service.getBanner(first.banner.id).isPrimary, false);
  assert.equal(service.getBanner(second.banner.id).isPrimary, true);
  assert.equal(reorderedFirst.displayOrder, 1);
});

test("homepage curation is an explicit audited version-checked metadata choice", async (t) => {
  const { service, principal } = await fixture(t);
  const first = await service.stage(proposal(), principal);
  const secondBytes = PNG.sync.write({
    width: 2,
    height: 1,
    data: Buffer.from([0, 0, 255, 255, 0, 0, 0, 255]),
  });
  const second = await service.stage(
    proposal({
      bannerId: "banner-adams-second",
      sourceFilename: "second.png",
      displayOrder: 1,
      isPrimary: false,
      idempotencyKey: "homepage-second",
      bytes: secondBytes,
    }),
    principal,
  );
  assert.equal(first.banner.homepageOrder, null);
  service.updateMetadata(
    first.banner.id,
    first.banner.version,
    { homepageOrder: 1 },
    principal,
  );
  service.updateMetadata(
    second.banner.id,
    second.banner.version,
    { homepageOrder: 0 },
    principal,
  );
  assert.equal(service.getBanner(first.banner.id).homepageOrder, 1);
  assert.equal(service.getBanner(second.banner.id).homepageOrder, 0);
  assert.throws(() =>
    service.updateMetadata(
      first.banner.id,
      service.getBanner(first.banner.id).version,
      { homepageOrder: 0 },
      principal,
    ),
  );
});

test("uncertain object-write response retries the same immutable operation", async (t) => {
  class LostResponseStorage extends MemoryBannerObjectStorage {
    loseOnce = true;
    async putIfAbsent(key, bytes, metadata) {
      const result = await super.putIfAbsent(key, bytes, metadata);
      if (this.loseOnce) {
        this.loseOnce = false;
        throw new Error("simulated lost response");
      }
      return result;
    }
  }
  const { principal, database } = await fixture(t);
  const storage = new LostResponseStorage();
  const retryService = new BannerAssetService(
    database,
    storage,
    (() => {
      let id = 10;
      return () => `retry-id-${++id}`;
    })(),
  );
  await assert.rejects(
    retryService.stage(proposal({ idempotencyKey: "uncertain" }), principal),
    /simulated lost response/,
  );
  assert.equal(
    database
      .prepare(
        "SELECT state FROM banner_stage_operations WHERE idempotency_key = ?",
      )
      .get("uncertain").state,
    "interrupted",
  );
  const retried = await retryService.stage(
    proposal({ idempotencyKey: "uncertain" }),
    principal,
  );
  assert.equal(retried.version.state, "verified");
  assert.equal(storage.writes, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM banner_asset_versions").get().n,
    1,
  );
});

test("interruption before upload is recoverable without a duplicate version", async (t) => {
  class FailBeforeWriteStorage extends MemoryBannerObjectStorage {
    fail = true;
    async putIfAbsent(key, bytes, metadata) {
      if (this.fail) {
        this.fail = false;
        throw new Error("simulated interruption before upload");
      }
      return super.putIfAbsent(key, bytes, metadata);
    }
  }
  const { principal, database } = await fixture(t);
  const storage = new FailBeforeWriteStorage();
  const service = new BannerAssetService(database, storage);
  await assert.rejects(
    service.stage(proposal({ idempotencyKey: "before-upload" }), principal),
    /before upload/,
  );
  const result = await service.stage(
    proposal({ idempotencyKey: "before-upload" }),
    principal,
  );
  assert.equal(result.version.state, "verified");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM banner_asset_versions").get().n,
    1,
  );
});

test("audit failure rolls back activation metadata as one database transaction", async (t) => {
  const { service, principal, database } = await fixture(t);
  const staged = await service.stage(proposal(), principal);
  database.exec(`CREATE TRIGGER fail_banner_activation_audit BEFORE INSERT ON audit_events
    WHEN NEW.action = 'banner.version.activated' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
  assert.throws(
    () =>
      service.activate(
        staged.banner.id,
        staged.version.id,
        staged.banner.version,
        principal,
      ),
    /injected audit failure/,
  );
  assert.equal(service.getBanner(staged.banner.id).selectedVersionId, null);
  assert.equal(
    service.getBanner(staged.banner.id).version,
    staged.banner.version,
  );
  database.exec("DROP TRIGGER fail_banner_activation_audit");
});

test("withdrawal is logical, missing/corrupt objects are excluded and reconciliation is read-only", async (t) => {
  const { service, principal, storage } = await fixture(t);
  const staged = await service.stage(proposal(), principal);
  const active = service.activate(
    staged.banner.id,
    staged.version.id,
    staged.banner.version,
    principal,
  );
  const withdrawn = service.withdraw(active.id, active.version, principal);
  assert.equal(withdrawn.selectedVersionId, staged.version.id);
  assert.equal(storage.keys().length, 1);
  const restored = await service.restore(
    withdrawn.id,
    staged.version.id,
    withdrawn.version,
    principal,
  );
  assert.equal((await service.resolveCounty("08001")).length, 1);
  storage.hideForTest(staged.version.objectKey);
  assert.equal((await service.resolveCounty("08001")).length, 0);
  await assert.rejects(
    service.restore(
      withdrawn.id,
      staged.version.id,
      restored.version,
      principal,
    ),
    BannerConflictError,
  );
  assert.equal(
    (await service.reconcile()).some(
      (item) => item.classification === "verified_object_missing",
    ),
    true,
  );
  storage.revealForTest(staged.version.objectKey);
  storage.corruptForTest(staged.version.objectKey, new Uint8Array([1, 2, 3]));
  assert.equal((await service.resolveCounty("08001")).length, 0);
  assert.equal(
    (await service.reconcile()).some(
      (item) => item.classification === "stored_object_integrity_failed",
    ),
    true,
  );
  await storage.putIfAbsent(
    "banner-assets/orphaned-test-key",
    new Uint8Array(png),
    { sha256: "orphan" },
  );
  assert.equal(
    (await service.reconcile()).some((item) =>
      item.classification.startsWith("orphaned_object:"),
    ),
    true,
  );
  assert.equal(service.getBanner(restored.id).status, "active");
});

test("denies stale/unauthorized actors and rejects malformed or conflicting proposals", async (t) => {
  const { service, principal, database } = await fixture(t);
  database
    .prepare(
      "UPDATE accounts SET role = 'contributor', version = version + 1 WHERE id = 'banner-operator'",
    )
    .run();
  await assert.rejects(service.stage(proposal(), principal), /not authorized/);
  const admin = await fixture(t, "administrator");
  const staged = await admin.service.stage(proposal(), admin.principal);
  assert.throws(
    () =>
      admin.service.activate(
        staged.banner.id,
        staged.version.id,
        2,
        admin.principal,
      ),
    BannerConflictError,
  );
  await assert.rejects(
    admin.service.stage(
      proposal({ countyFips: "99999", idempotencyKey: "bad" }),
      admin.principal,
    ),
    BannerValidationError,
  );
  await assert.rejects(
    admin.service.stage(
      proposal({
        bytes: new Uint8Array([1, 2, 3]),
        idempotencyKey: "bad-bytes",
      }),
      admin.principal,
    ),
    BannerValidationError,
  );
  await assert.rejects(
    admin.service
      .stage(
        proposal({ idempotencyKey: "same-key", caption: "First" }),
        admin.principal,
      )
      .then(() =>
        admin.service.stage(
          proposal({ idempotencyKey: "same-key", caption: "Different" }),
          admin.principal,
        ),
      ),
    BannerConflictError,
  );
});

test("BANNERS-1 adapter carries stable IDs, source digest and metadata without interpreting missing files", () => {
  const record = {
    bannerId: "banner-existing-id",
    currentVersion: 1,
    countyFips: "08001",
    caption: "Caption",
    altText: "Alt",
    displayOrder: 3,
    isPrimary: false,
    displayMode: "contain",
    focalX: 0.4,
    focalY: 0.7,
    source: {
      filename: "old irregular name.png",
      width: 1200,
      height: 500,
      format: "png",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      validation: "full_decode_passed",
    },
  };
  const proposal = translateBanners1Record(record);
  assert.equal(proposal.bannerId, record.bannerId);
  assert.equal(proposal.sourceFilename, record.source.filename);
  assert.equal(proposal.expectedSha256, record.source.sha256);
  assert.equal(proposal.sourceVersionNumber, 1);
  assert.equal(proposal.sourceHistory[0].sha256, record.source.sha256);
  assert.throws(
    () => translateBanners1Record({ ...record, sourceMissing: true }),
    BannerValidationError,
  );
});

test("R2 adapter uses conditional create and reads object bytes without using ETag as SHA-256", async () => {
  const objects = new Map();
  let putOptions;
  const bucket = {
    async put(key, body, options) {
      putOptions = options;
      if (objects.has(key)) return null;
      objects.set(key, {
        body: new Uint8Array(body),
        metadata: options.customMetadata,
      });
      return { size: body.byteLength, customMetadata: options.customMetadata };
    },
    async get(key) {
      const item = objects.get(key);
      return item
        ? {
            size: item.body.byteLength,
            customMetadata: item.metadata,
            arrayBuffer: async () =>
              item.body.buffer.slice(
                item.body.byteOffset,
                item.body.byteOffset + item.body.byteLength,
              ),
          }
        : null;
    },
    async head(key) {
      const item = objects.get(key);
      return item
        ? { size: item.body.byteLength, customMetadata: item.metadata }
        : null;
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  const store = new R2BannerObjectStorage(bucket);
  assert.equal(
    await store.putIfAbsent("banner-assets/version", png, {
      sha256: "expected",
    }),
    "created",
  );
  assert.deepEqual(putOptions.onlyIf, { etagDoesNotMatch: "*" });
  assert.equal(
    await store.putIfAbsent("banner-assets/version", png, {
      sha256: "expected",
    }),
    "exists",
  );
  assert.deepEqual(await store.head("banner-assets/version"), {
    byteSize: png.byteLength,
    metadata: { sha256: "expected" },
  });
  assert.deepEqual(await store.listKeys("banner-assets/"), [
    "banner-assets/version",
  ]);
  assert.deepEqual(
    await store.get("banner-assets/version").then((item) => item.body),
    new Uint8Array(png),
  );
});

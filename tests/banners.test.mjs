import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import jpeg from "jpeg-js";
import pngjs from "pngjs";
import { inventory, run } from "../scripts/banners.mjs";

const { PNG } = pngjs;
const limits = {
  maxBytes: 8_000_000,
  maxPixels: 5_000_000,
  minWidth: 1000,
  minHeight: 350,
};

function jpegBytes(width, height, seed = 15) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (seed + i) % 255;
    data[i * 4 + 1] = (seed * 3 + i) % 255;
    data[i * 4 + 2] = 90;
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 80).data;
}

function pngBytes(width, height, seed = 20) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = seed;
    data[i * 4 + 1] = i % 255;
    data[i * 4 + 2] = 160;
    data[i * 4 + 3] = 255;
  }
  return PNG.sync.write({ data, width, height });
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-banners-"));
  const source = path.join(root, "approved");
  await fs.mkdir(source);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, source };
}

async function scan(source, previous = null, metadata = null) {
  return inventory({ source, previous, metadata, limits });
}
function codes(record) {
  return record.issues.map((item) => item.code);
}

test("valid JPEG and PNG panoramas retain non-3:1 geometry and undergo full decoding", async (t) => {
  const { source } = await setup(t);
  await fs.writeFile(
    path.join(source, "08001-adams-21_to_9.jpg"),
    jpegBytes(2100, 900),
  );
  await fs.writeFile(
    path.join(source, "08003-alamosa-intermediate.png"),
    pngBytes(2400, 1000),
  );
  await fs.writeFile(
    path.join(source, "08013-boulder-3_to_1.jpg"),
    jpegBytes(2400, 800),
  );
  const { manifest } = await scan(source);
  assert.equal(manifest.summary.validCount, 3);
  assert.deepEqual(
    manifest.banners.map((r) => r.source.validation),
    Array(3).fill("full_decode_passed"),
  );
  assert.deepEqual(
    manifest.banners.map((r) => r.source.aspectRatio),
    [2.333333, 2.4, 3],
  );
  assert.ok(
    manifest.banners.every(
      (r) => r.displayMode === "cover" && r.focalX === 0.5 && r.focalY === 0.5,
    ),
  );
  assert.equal(manifest.counties.length, 64);
});

test("invalid bytes, wrong extensions, malformed images and invalid county FIPS are isolated", async (t) => {
  const { source } = await setup(t);
  await fs.writeFile(
    path.join(source, "08001-adams-broken.jpg"),
    Buffer.from("not an image"),
  );
  await fs.writeFile(
    path.join(source, "08003-alamosa-truncated.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
  );
  await fs.writeFile(
    path.join(source, "08127-invalid-county.jpg"),
    jpegBytes(1800, 800),
  );
  await fs.writeFile(path.join(source, "no-county.jpg"), jpegBytes(1800, 800));
  await fs.writeFile(
    path.join(source, "08005-arapahoe-wrong-ext.png"),
    jpegBytes(1800, 800),
  );
  const { manifest } = await scan(source);
  assert.equal(manifest.banners.length, 5);
  assert.ok(
    manifest.banners
      .find((r) => r.source.filename.includes("broken"))
      .issues.some((x) => x.severity === "error"),
  );
  assert.ok(
    manifest.banners
      .find((r) => r.source.filename.includes("truncated"))
      .issues.some((x) => x.code === "decode_failed"),
  );
  assert.ok(
    codes(
      manifest.banners.find((r) => r.source.filename.startsWith("08127")),
    ).includes("invalid_county_fips"),
  );
  assert.ok(
    codes(
      manifest.banners.find((r) => r.source.filename === "no-county.jpg"),
    ).includes("county_assignment_missing"),
  );
  assert.ok(
    codes(
      manifest.banners.find((r) => r.source.filename.includes("wrong-ext")),
    ).includes("extension_mismatch"),
  );
});

test("stable IDs and no-op scans are idempotent; metadata changes do not create image versions", async (t) => {
  const { source } = await setup(t);
  const name = "08001-adams-barr_lake.jpg";
  await fs.writeFile(path.join(source, name), jpegBytes(1800, 800));
  const first = await scan(source);
  const repeat = await scan(source, first.manifest);
  assert.equal(
    repeat.changes.find((x) => x.filename === name).kind,
    "unchanged",
  );
  assert.equal(
    repeat.manifest.banners[0].bannerId,
    first.manifest.banners[0].bannerId,
  );
  assert.equal(repeat.manifest.banners[0].versions.length, 1);
  const edited = structuredClone(first.manifest);
  edited.banners[0].caption = "Owner-reviewed caption";
  const metadataScan = await scan(source, first.manifest, edited);
  assert.equal(
    metadataScan.changes.find((x) => x.filename === name).kind,
    "metadata_changed",
  );
  assert.equal(metadataScan.manifest.banners[0].currentVersion, 1);
  assert.equal(
    metadataScan.manifest.banners[0].caption,
    "Owner-reviewed caption",
  );
});

test("replacement preserves identity and prior version; missing source preserves record without withdrawal", async (t) => {
  const { source } = await setup(t);
  const name = "08001-adams-barr_lake.jpg";
  await fs.writeFile(path.join(source, name), jpegBytes(1800, 800, 10));
  const original = await scan(source);
  await fs.writeFile(path.join(source, name), jpegBytes(1800, 800, 230));
  const replacement = await scan(source, original.manifest);
  const changed = replacement.manifest.banners[0];
  assert.equal(
    replacement.changes.find((x) => x.filename === name).kind,
    "content_changed",
  );
  assert.equal(changed.bannerId, original.manifest.banners[0].bannerId);
  assert.equal(changed.currentVersion, 2);
  assert.equal(changed.versions.length, 2);
  assert.equal(
    changed.versions[0].sha256,
    original.manifest.banners[0].source.sha256,
  );
  await fs.rm(path.join(source, name));
  const missing = await scan(source, replacement.manifest);
  assert.equal(
    missing.changes.find((x) => x.filename === name).kind,
    "missing_from_source",
  );
  assert.equal(missing.manifest.banners[0].sourceMissing, true);
  assert.equal(missing.manifest.banners[0].versions.length, 2);
  assert.equal(missing.manifest.banners[0].lifecycleState, "proposed");
});

test("duplicates and filename anomalies are reported without dropping candidates", async (t) => {
  const { source } = await setup(t);
  const bytes = jpegBytes(1800, 800);
  await fs.writeFile(path.join(source, "08001-adams-lake.jpg"), bytes);
  await fs.writeFile(path.join(source, "08001-adams-lake (2).jpg"), bytes);
  await fs.writeFile(
    path.join(source, "08061-kiowa-next-remove-teh-bird.jpg"),
    jpegBytes(1800, 800, 77),
  );
  await fs.writeFile(
    path.join(source, "08075-logan-farmland-well-done-next.jpg"),
    jpegBytes(1800, 800, 88),
  );
  const result = await scan(source);
  assert.equal(result.manifest.banners.length, 4);
  assert.ok(
    result.manifest.banners.some((r) =>
      codes(r).includes("duplicate_style_suffix"),
    ),
  );
  assert.ok(
    result.manifest.banners.some((r) => codes(r).includes("editing_note")),
  );
  assert.ok(
    result.manifest.banners.find((r) =>
      r.source.filename.includes("well-done-next"),
    )?.metadataNeedsReview,
  );
  assert.ok(result.changes.some((x) => x.kind === "duplicate"));
});

test("ambiguous rename candidates and conflicting owner order stay reviewable", async (t) => {
  const { source } = await setup(t);
  const originalName = "08001-adams-lake.jpg";
  const bytes = jpegBytes(1500, 600);
  await fs.writeFile(path.join(source, originalName), bytes);
  const baseline = await scan(source);
  await fs.rm(path.join(source, originalName));
  await fs.writeFile(path.join(source, "08001-adams-new_name.jpg"), bytes);
  const renamed = await scan(source, baseline.manifest);
  assert.ok(
    renamed.changes.some(
      (item) =>
        item.kind === "ambiguous" &&
        item.filename === "08001-adams-new_name.jpg",
    ),
  );
  assert.ok(renamed.manifest.banners.some((item) => item.sourceMissing));

  await fs.writeFile(
    path.join(source, "08001-adams-second_lake.jpg"),
    jpegBytes(1500, 600, 32),
  );
  const two = await scan(source);
  for (const record of two.manifest.banners) {
    record.displayOrder = 1;
    record.countyFips = "08003";
  }
  const changed = await scan(source, two.manifest, two.manifest);
  assert.ok(changed.changes.some((item) => item.kind === "ambiguous"));
  assert.ok(
    changed.manifest.banners.every((record) =>
      codes(record).includes("conflicting_display_order"),
    ),
  );
  assert.ok(
    changed.manifest.banners.every((record) => record.countyName === "Alamosa"),
  );
  const primaryMetadata = structuredClone(two.manifest);
  primaryMetadata.banners.forEach((record) => {
    record.isPrimary = true;
  });
  const primaryConflict = await scan(source, two.manifest, primaryMetadata);
  assert.ok(
    primaryConflict.manifest.banners.every((record) =>
      codes(record).includes("conflicting_primary"),
    ),
  );
  const invalidMetadata = structuredClone(two.manifest);
  invalidMetadata.banners[1].bannerId = invalidMetadata.banners[0].bannerId;
  invalidMetadata.banners[0].isPrimary = true;
  invalidMetadata.banners[1].isPrimary = true;
  const conflicting = await scan(source, two.manifest, invalidMetadata);
  assert.ok(
    conflicting.manifest.banners.some((record) =>
      codes(record).includes("conflicting_metadata_banner_id"),
    ),
  );
  assert.ok(
    conflicting.changes.some(
      (item) => item.note === "Duplicate IDs in edited metadata need review",
    ),
  );
});

test("byte and pixel safety limits prevent expensive decoding", async (t) => {
  const { source } = await setup(t);
  await fs.writeFile(
    path.join(source, "08001-adams-large.jpg"),
    jpegBytes(2400, 800),
  );
  const result = await inventory({
    source,
    limits: { ...limits, maxBytes: 1, maxPixels: 100 },
  });
  assert.ok(codes(result.manifest.banners[0]).includes("file_too_large"));
  assert.match(result.manifest.banners[0].source.sha256, /^[a-f0-9]{64}$/);
  const result2 = await inventory({
    source,
    limits: { ...limits, maxBytes: 8000000, maxPixels: 100 },
  });
  assert.ok(
    codes(result2.manifest.banners[0]).includes("dimensions_over_limit"),
  );
  assert.equal(result2.manifest.banners[0].source.validation, "not_checked");
});

test("symlinks are skipped without reading outside the approved source root", async (t) => {
  const { root, source } = await setup(t);
  const outside = path.join(root, "outside.jpg");
  await fs.writeFile(outside, jpegBytes(1800, 800));
  try {
    await fs.symlink(outside, path.join(source, "08001-adams-link.jpg"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code))
      return t.skip("Symlink creation is unavailable");
    throw error;
  }
  const result = await scan(source);
  assert.equal(result.manifest.banners.length, 0);
  assert.equal(result.summary.unsafeEntries.length, 1);
});

test("source file bytes stay unchanged", async (t) => {
  const { source } = await setup(t);
  const name = "08001-adams-immutable.jpg";
  const bytes = jpegBytes(1800, 800);
  const before = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(source, name), bytes);
  await scan(source);
  const after = createHash("sha256")
    .update(await fs.readFile(path.join(source, name)))
    .digest("hex");
  assert.equal(after, before);
});

test("CLI writes revisioned outputs without overwriting existing reports", async (t) => {
  const { root, source } = await setup(t);
  await fs.writeFile(
    path.join(source, "08001-adams-lake.jpg"),
    jpegBytes(1500, 600),
  );
  const manifestDir = path.join(root, "manifests");
  const reportDir = path.join(root, "reports");
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  await fs.mkdir(manifestDir);
  const prior = path.join(manifestDir, `Banner manifest rev${day} v1.json`);
  await fs.writeFile(prior, "owner-kept\n");
  const args = [
    "node",
    "scripts/banners.mjs",
    "--source",
    source,
    "--manifest-dir",
    manifestDir,
    "--report-dir",
    reportDir,
  ];
  await run(args);
  assert.equal(await fs.readFile(prior, "utf8"), "owner-kept\n");
  assert.ok(
    await fs.stat(path.join(manifestDir, `Banner manifest rev${day} v2.json`)),
  );
  assert.ok(
    await fs.stat(path.join(manifestDir, `Banner inventory rev${day} v1.json`)),
  );
  assert.ok(
    await fs.stat(
      path.join(reportDir, `Banner change report rev${day} v1.json`),
    ),
  );
  assert.ok(
    await fs.stat(
      path.join(reportDir, `Banner validation report rev${day} v1.md`),
    ),
  );
  const manifests = await fs.readdir(manifestDir);
  assert.equal(
    manifests.some((name) => name.endsWith(".tmp")),
    false,
  );
});

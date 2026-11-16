import assert from "node:assert/strict";
import test from "node:test";
import {
  BANNER_IMAGE_LIMITS,
  BannerImageError,
  inspectBannerImage,
} from "../dist/services/banner-image-inspector.js";
import { bannerAdminFixtures } from "./d1/banner-admin-fixtures.mjs";

const fixtures = bannerAdminFixtures();
const bytes = (name) =>
  Uint8Array.from(Buffer.from(fixtures[name].base64, "base64"));
const refuses = (name, code, limits) =>
  assert.rejects(
    inspectBannerImage(bytes(name), limits),
    (error) => error instanceof BannerImageError && error.code === code,
  );

test("a PNG is fully decoded and its facts come from the bytes", async () => {
  for (const name of ["pngA", "pngB", "pngC", "pngD"]) {
    const result = await inspectBannerImage(bytes(name));
    assert.equal(result.mediaType, "image/png");
    assert.equal(result.decode, "full");
    assert.equal(result.width, fixtures[name].width);
    assert.equal(result.height, fixtures[name].height);
    assert.equal(result.sha256, fixtures[name].sha256);
    assert.equal(result.byteSize, bytes(name).length);
  }
});

test("a JPEG is fully decoded and its facts come from the bytes", async () => {
  const result = await inspectBannerImage(bytes("jpegA"));
  assert.equal(result.mediaType, "image/jpeg");
  assert.equal(result.width, 64);
  assert.equal(result.height, 24);
  assert.equal(result.decode, "full");
  assert.equal(result.sha256, fixtures.jpegA.sha256);
});

test("limits are enforced before any decoding", async () => {
  // This fixture has no image data, so any attempt to decode it would report
  // decode_failed. Seeing dimensions_exceeded proves the limit ran first.
  await refuses("oversizedClaimPng", "dimensions_exceeded");
  await refuses("oversizedClaimJpeg", "dimensions_exceeded");
  await refuses("jpegA", "dimensions_exceeded", {
    ...BANNER_IMAGE_LIMITS,
    maxPixels: 100,
  });
  await refuses("pngA", "dimensions_exceeded", {
    ...BANNER_IMAGE_LIMITS,
    maxPixels: 100,
  });
  await refuses("pngA", "dimensions_exceeded", {
    ...BANNER_IMAGE_LIMITS,
    maxDimension: 32,
  });
  await refuses("pngA", "dimensions_exceeded", {
    ...BANNER_IMAGE_LIMITS,
    maxDecodedBytes: 1000,
  });
  await refuses("pngA", "too_large", { ...BANNER_IMAGE_LIMITS, maxBytes: 50 });
  await assert.rejects(
    inspectBannerImage(new Uint8Array()),
    (e) => e.code === "empty",
  );
});

test("malformed and hostile images are refused", async () => {
  await refuses("truncatedPng", "decode_failed");
  await refuses("badCrcPng", "decode_failed");
  await refuses("corruptDataPng", "decode_failed");
  await refuses("bombPng", "decode_failed");
  await refuses("shortDataPng", "decode_failed");
  await refuses("interlacedPng", "unsupported_type");
  await refuses("gif", "unsupported_type");
  await refuses("truncatedJpeg", "malformed");
  await refuses("corruptJpeg", "decode_failed");
});

test("a JPEG that is not baseline or progressive Huffman is refused", async () => {
  const arithmetic = bytes("jpegA");
  const sof = arithmetic.findIndex(
    (v, i) => v === 0xff && arithmetic[i + 1] === 0xc0,
  );
  assert.ok(sof > 0);
  arithmetic[sof + 1] = 0xc9;
  await assert.rejects(
    inspectBannerImage(arithmetic),
    (e) => e.code === "unsupported_type",
  );
});

test("the inspector refuses data that decompresses past its declared size", async () => {
  // The bomb inflates to 8 MB. It must be cut off, not fully expanded.
  const started = performance.now();
  await refuses("bombPng", "decode_failed");
  assert.ok(performance.now() - started < 2000);
});

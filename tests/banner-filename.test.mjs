import assert from "node:assert/strict";
import test from "node:test";
import { parseBannerFilename } from "../dist/editor/banner-filename.js";

test("a conforming name gives the banner ID, caption and alt text", () => {
  const parsed = parseBannerFilename("08001-adams-barr_lake.jpg", "Adams");
  assert.deepEqual(parsed, {
    bannerId: "08001-adams-barr_lake",
    caption: "Adams Barr Lake",
    altText: "Adams Barr Lake, Adams County, Colorado",
    fips: "08001",
    matched: true,
  });
});

test("a county name with several words is matched against the selected county", () => {
  const parsed = parseBannerFilename("08041-el_paso-pikes_peak.png", "El Paso");
  assert.equal(parsed.caption, "El Paso Pikes Peak");
  assert.equal(parsed.altText, "El Paso Pikes Peak, El Paso County, Colorado");
  const hyphenated = parseBannerFilename(
    "08041-el-paso-pikes_peak.png",
    "El Paso",
  );
  assert.equal(hyphenated.caption, "El Paso Pikes Peak");
});

test("without a selected county the county comes from the file name", () => {
  const parsed = parseBannerFilename("08003-alamosa-sand_dunes.jpeg", "");
  assert.equal(parsed.caption, "Alamosa Sand Dunes");
});

test("a mismatched county code is reported through fips", () => {
  const parsed = parseBannerFilename("08005-arapahoe-reservoir.jpg", "Adams");
  assert.equal(parsed.fips, "08005");
});

test("names outside the convention only fill a safe banner ID", () => {
  const plain = parseBannerFilename("My photo (final).jpg", "Adams");
  assert.deepEqual(plain, {
    bannerId: "My-photo-final-",
    caption: "",
    altText: "",
    fips: null,
    matched: false,
  });
  const noCaption = parseBannerFilename("08001-adams.jpg", "Adams");
  assert.equal(noCaption.matched, false);
  assert.equal(noCaption.caption, "");
  const folder = parseBannerFilename("C:\\art\\08001-adams-x.jpg", "Adams");
  assert.equal(folder.bannerId, "08001-adams-x");
  assert.match(
    parseBannerFilename("_.hidden.png", "Adams").bannerId,
    /^[A-Za-z0-9]/,
  );
  assert.ok(
    parseBannerFilename("a".repeat(300) + ".png", "").bannerId.length <= 128,
  );
});

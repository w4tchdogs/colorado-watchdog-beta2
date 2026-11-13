import assert from "node:assert/strict";
import { test } from "node:test";
import { getCounty, listCounties } from "../src/services/counties.ts";
import { freshDb, testContext } from "./helpers.ts";

test("exactly 64 counties with unique five-character Colorado FIPS codes", async () => {
  const db = freshDb();
  const counties = await listCounties(testContext(db));
  assert.equal(counties.length, 64);
  assert.equal(new Set(counties.map((c) => c.fips)).size, 64);
  assert.equal(new Set(counties.map((c) => c.name)).size, 64);
  assert.equal(new Set(counties.map((c) => c.slug)).size, 64);
  for (const county of counties) {
    assert.match(county.fips, /^08\d{3}$/);
    assert.equal(typeof county.fips, "string");
    assert.match(county.slug, /^[a-z]+(-[a-z]+)*$/);
  }
  assert.equal(counties[0]?.fips, "08001");
  assert.equal(counties.at(-1)?.fips, "08125");
  db.close();
});

test("FIPS codes keep their leading zero and known anchors resolve", async () => {
  const db = freshDb();
  const ctx = testContext(db);
  assert.deepEqual(await getCounty(ctx, "08014"), {
    fips: "08014",
    name: "Broomfield",
    slug: "broomfield",
  });
  assert.equal((await getCounty(ctx, "08069"))?.name, "Larimer");
  assert.equal((await getCounty(ctx, "08031"))?.name, "Denver");
  assert.equal(await getCounty(ctx, "08002"), null);
  db.close();
});

test("a malformed or out-of-state FIPS code is rejected by the database", async () => {
  const db = freshDb();
  for (const fips of ["8001", "080010", "09001", "08A01"]) {
    await assert.rejects(
      db.run("INSERT INTO counties (fips, name, slug) VALUES (?, ?, ?)", [fips, fips, fips]),
      /CHECK constraint failed/,
      fips,
    );
  }
  await assert.rejects(
    db.run("INSERT INTO counties (fips, name, slug) VALUES ('08999', 'Adams', 'adams-two')"),
    /UNIQUE constraint failed/,
  );
  db.close();
});

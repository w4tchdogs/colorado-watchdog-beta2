import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/app.ts";
import { freshDb, testContext } from "./helpers.ts";

const get = (path: string) => new Request(`https://site.invalid${path}`);

test("routes delegate to the service layer", async () => {
  const db = freshDb();
  const ctx = testContext(db);
  const status = await handleRequest(get("/api/v1/status"), ctx);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), {
    service: "colorado-watchdog-beta2",
    milestone: "M0",
    counties: 64,
  });
  const list = (await (await handleRequest(get("/api/v1/counties"), ctx)).json()) as {
    counties: unknown[];
  };
  assert.equal(list.counties.length, 64);
  const one = await handleRequest(get("/api/v1/counties/08069"), ctx);
  assert.deepEqual(await one.json(), { fips: "08069", name: "Larimer", slug: "larimer" });
  db.close();
});

test("unknown routes, unknown counties and write methods are refused", async () => {
  const db = freshDb();
  const ctx = testContext(db);
  assert.equal((await handleRequest(get("/api/v1/counties/08002"), ctx)).status, 404);
  assert.equal((await handleRequest(get("/api/v1/accounts"), ctx)).status, 404);
  const post = new Request("https://site.invalid/api/v1/counties", { method: "POST" });
  assert.equal((await handleRequest(post, ctx)).status, 405);
  db.close();
});

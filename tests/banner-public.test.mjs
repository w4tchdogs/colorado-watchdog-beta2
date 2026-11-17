import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AsyncD1Database } from "../dist/database/d1.js";
import { D1BannerPublicService } from "../dist/services/banner-public.js";
import { createPublicSite } from "../dist/site/index.js";
import { createSitePreview } from "../dist/site-dev/preview.js";

const ORIGIN = "https://watchdog.test";
const siteOptions = (service) => ({
  services: {},
  assets: {
    async get() {
      return null;
    },
  },
  ...(service ? { bannerDelivery: service } : {}),
});

const VERSION_A = "11111111-1111-4111-8111-111111111111";
const VERSION_B = "22222222-2222-4222-8222-222222222222";
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function row({
  id = "banner-a",
  county = "08001",
  version = VERSION_A,
  key = `banner-assets/${version}`,
  order = 0,
  primary = 0,
  homepageOrder = null,
  status = "active",
  versionState = "verified",
  selected = version,
} = {}) {
  return {
    id,
    county_fips: county,
    caption: `Caption ${id}`,
    alt_text: `Alt ${id}`,
    display_mode: "cover",
    focal_x: 0.5,
    focal_y: 0.25,
    display_order: order,
    is_primary: primary,
    width: 1200,
    height: 400,
    version_id: version,
    object_key: key,
    sha256: "",
    byte_size: PNG.byteLength,
    media_type: "image/png",
    homepage_order: homepageOrder,
    status,
    version_state: versionState,
    selected_version_id: selected,
  };
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function fixture(
  rows,
  objectEntries = [
    [`banner-assets/${VERSION_A}`, PNG],
    [`banner-assets/${VERSION_B}`, PNG],
  ],
  randomOrder = shuffled,
) {
  const expectedDigest = createHash("sha256").update(PNG).digest("hex");
  const allRows = rows.map((item) => ({
    ...item,
    sha256: item.sha256 || expectedDigest,
  }));
  const storage = new Map([
    ...rows.map((item) => [item.object_key, PNG]),
    ...objectEntries,
  ]);
  const bucket = {
    async put(key, value, options) {
      if (options.onlyIf.etagDoesNotMatch === "*" && storage.has(key))
        return null;
      storage.set(key, new Uint8Array(value));
      return { size: value.byteLength };
    },
    async get(key) {
      const value = storage.get(key);
      return value
        ? {
            size: value.byteLength,
            customMetadata: {
              sha256: expectedDigest,
              versionId: key.split("/").at(-1),
            },
            arrayBuffer: async () => value.slice().buffer,
          }
        : null;
    },
    async head(key) {
      const value = storage.get(key);
      return value
        ? {
            size: value.byteLength,
            customMetadata: {
              sha256: expectedDigest,
              versionId: key.split("/").at(-1),
            },
          }
        : null;
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
  const binding = {
    prepare(sql) {
      let values = [];
      const execute = () => {
        let selected = allRows.filter(
          (item) =>
            item.status === "active" &&
            item.version_state === "verified" &&
            item.selected_version_id === item.version_id,
        );
        if (sql.includes("a.county_fips = ?"))
          selected = selected.filter((item) => item.county_fips === values[0]);
        if (sql.includes("v.id = ?"))
          selected = selected.filter((item) => item.version_id === values[0]);
        if (sql.includes("ORDER BY RANDOM()")) return randomOrder(selected);
        selected.sort(
          (a, b) =>
            Number(b.is_primary) - Number(a.is_primary) ||
            a.display_order - b.display_order,
        );
        return selected;
      };
      const statement = {
        bind(...bound) {
          values = bound;
          return statement;
        },
        async all() {
          return {
            success: true,
            results: execute().slice(0, values.at(-1) ?? 100),
          };
        },
        async first() {
          return execute()[0] ?? null;
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
  return {
    service: new D1BannerPublicService(new AsyncD1Database(binding), bucket),
    bucket,
    allRows,
    storage,
  };
}

test("public resolver filters lifecycle, county, verification, selection, and curation", async () => {
  const { service } = fixture([
    row({ id: "primary", primary: 1, homepageOrder: 1 }),
    row({
      id: "homepage-first",
      version: VERSION_B,
      order: 2,
      homepageOrder: 0,
    }),
    row({ id: "other", version: VERSION_B, order: 1, homepageOrder: null }),
    row({
      id: "wrong-county",
      county: "08003",
      version: "33333333-3333-4333-8333-333333333333",
    }),
    row({
      id: "withdrawn",
      version: "44444444-4444-4444-8444-444444444444",
      status: "withdrawn",
    }),
    row({
      id: "unverified",
      version: "55555555-5555-4555-8555-555555555555",
      versionState: "staged",
    }),
    row({
      id: "unselected",
      version: "66666666-6666-4666-8666-666666666666",
      selected: VERSION_B,
    }),
  ]);
  assert.deepEqual(
    (await service.resolveCounty("08001")).map((b) => b.bannerId).sort(),
    ["homepage-first", "other", "primary"],
  );
  const otherCounty = await service.resolveCounty("08003");
  assert.deepEqual(
    otherCounty.map((b) => b.bannerId),
    ["wrong-county"],
  );
  assert.deepEqual(await service.resolveCounty("99999"), []);
  // The homepage draws from every active verified banner, not only curated ones.
  const drawn = (await service.resolveHomepage()).map((b) => b.bannerId).sort();
  assert.deepEqual(drawn, [
    "homepage-first",
    "other",
    "primary",
    "wrong-county",
  ]);
});

test("missing and corrupted objects are omitted and delivery is rechecked against active selection", async () => {
  const { service, storage } = fixture([row()]);
  assert.equal((await service.resolveCounty("08001")).length, 1);
  storage.set(
    `banner-assets/${VERSION_A}`,
    Uint8Array.from([...PNG.slice(0, -1), 9]),
  );
  assert.deepEqual(await service.resolveCounty("08001"), []);
  assert.equal(await service.deliver(VERSION_A), null);
  storage.delete(`banner-assets/${VERSION_A}`);
  assert.equal(await service.deliver(VERSION_A), null);
});

test("public image GET and HEAD serve exact verified PNG bytes with safe headers", async () => {
  const { service } = fixture([row()]);
  const site = createPublicSite(siteOptions(service));
  const get = await site.fetch(
    new Request(`${ORIGIN}/banner-assets/${VERSION_A}`),
  );
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), PNG);
  const head = await site.fetch(
    new Request(`${ORIGIN}/banner-assets/${VERSION_A}`, { method: "HEAD" }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("synthetic D1/R2 service renders county and curated homepage banners without changing the 3:1 frame", async () => {
  const { service } = fixture([
    row({ id: "county-primary", primary: 1, homepageOrder: 1 }),
    row({ id: "home-first", version: VERSION_B, order: 1, homepageOrder: 0 }),
  ]);
  const preview = await createSitePreview({
    staticDirectory: fileURLToPath(
      new URL("../website/site/", import.meta.url),
    ),
    data: "empty",
    banners: service,
    bannerDelivery: service,
  });
  try {
    const home = await preview.fetch(new Request(`${ORIGIN}/`));
    const homeMarkup = await home.text();
    assert.equal(home.status, 200);
    assert.match(homeMarkup, /data-banner-id="(home-first|county-primary)"/);
    assert.match(homeMarkup, /data-banner-count="2"/);
    assert.match(homeMarkup, /class="banner-frame has-image mode-cover"/);
    const county = await preview.fetch(new Request(`${ORIGIN}/counties/08001`));
    const countyMarkup = await county.text();
    assert.equal(county.status, 200);
    assert.match(countyMarkup, /data-banner-id="(county-primary|home-first)"/);
    const image = await preview.fetch(
      new Request(`${ORIGIN}/banner-assets/${VERSION_A}`),
    );
    assert.equal(image.status, 200);
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG);
  } finally {
    preview.close();
  }
});

const versionId = (n) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const pool = (count, extra = {}) =>
  Array.from({ length: count }, (_, i) =>
    row({
      id: `county-${String(i).padStart(2, "0")}`,
      county: `08${String(1 + 2 * (i % 60)).padStart(3, "0")}`,
      version: versionId(i + 1),
      order: i,
      ...extra,
    }),
  );

test("homepage draws up to five distinct banners from the whole pool, shuffled before the limit", async () => {
  const rows = pool(12);
  // Reverse the pool so the last banners in id order come first. A limit applied
  // before shuffling would only ever see the first page of results.
  const { service } = fixture(rows, [], (selected) => [...selected].reverse());
  const ids = (await service.resolveHomepage()).map((b) => b.bannerId);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(ids, [
    "county-11",
    "county-10",
    "county-09",
    "county-08",
    "county-07",
  ]);
  const home = (await service.forHome()).map((b) => [b.bannerId, b.order]);
  assert.deepEqual(
    home.map(([, order]) => order),
    [0, 1, 2, 3, 4],
  );
  const seen = new Set();
  const randomised = fixture(rows, []);
  for (let draw = 0; draw < 200; draw += 1)
    for (const b of await randomised.service.resolveHomepage())
      seen.add(b.bannerId);
  assert.equal(seen.size, 12);
});

test("a published county banner with no homepage order or primary flag is eligible, ineligible versions are not", async () => {
  const { service } = fixture(
    [
      row({
        id: "plain",
        version: versionId(1),
        homepageOrder: null,
        primary: 0,
      }),
      row({ id: "withdrawn", version: versionId(2), status: "withdrawn" }),
      row({ id: "draft", version: versionId(3), status: "draft" }),
      row({ id: "staged", version: versionId(4), versionState: "staged" }),
      row({
        id: "superseded",
        version: versionId(5),
        selected: versionId(6),
      }),
    ],
    [],
  );
  for (let draw = 0; draw < 20; draw += 1)
    assert.deepEqual(
      (await service.resolveHomepage()).map((b) => b.bannerId),
      ["plain"],
    );
});

test("homepage renders zero, one and several eligible banners with the existing carousel", async () => {
  const render = async (rows) => {
    const { service } = fixture(rows, []);
    const preview = await createSitePreview({
      staticDirectory: fileURLToPath(
        new URL("../website/site/", import.meta.url),
      ),
      data: "empty",
      banners: service,
      bannerDelivery: service,
    });
    try {
      const response = await preview.fetch(new Request(`${ORIGIN}/`));
      assert.equal(response.status, 200);
      return await response.text();
    } finally {
      preview.close();
    }
  };
  const none = await render([]);
  assert.doesNotMatch(none, /data-banner-id=/);
  assert.doesNotMatch(none, /data-banner-slides=/);
  assert.match(none, /banner-frame/);
  const one = await render(pool(1));
  assert.match(one, /data-banner-id="county-00"/);
  assert.match(one, /data-banner-count="1"/);
  assert.doesNotMatch(one, /data-banner-slides=/);
  assert.match(one, /Alt county-00/);
  assert.match(one, /Caption county-00/);
  const many = await render(pool(8));
  assert.match(many, /data-banner-count="5"/);
  assert.match(many, /data-banner-slides=/);
  assert.match(many, /data-banner-controls/);
});

test("county pages draw a random order and ignore primary and display order", async () => {
  const { service } = fixture(
    [
      row({ id: "second", version: versionId(1), order: 1 }),
      row({ id: "first", version: versionId(2), order: 0 }),
      row({ id: "primary", version: versionId(3), order: 5, primary: 1 }),
    ],
    [],
    (items) => [...items].reverse(),
  );
  const draw = await service.forCounty("08001");
  // The reversed fixture order stands in for the SQL RANDOM() draw order.
  assert.deepEqual(
    draw.map((b) => b.bannerId),
    ["primary", "first", "second"],
  );
  assert.deepEqual(
    draw.map((b) => [b.order, b.primary]),
    [
      [0, false],
      [1, false],
      [2, false],
    ],
  );
});

test("image delivery denies invalid, unknown, private and unsupported requests", async () => {
  const { service } = fixture([row()]);
  const site = createPublicSite(siteOptions(service));
  for (const path of [
    "/banner-assets/not-a-uuid",
    "/banner-assets/77777777-7777-4777-8777-777777777777",
    "/banner-assets/../../secret",
  ]) {
    assert.equal(
      (await site.fetch(new Request(`${ORIGIN}${path}`))).status,
      404,
    );
  }
  assert.equal(
    (
      await site.fetch(
        new Request(`${ORIGIN}/banner-assets/${VERSION_A}?key=private`),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await site.fetch(
        new Request(`${ORIGIN}/banner-assets/${VERSION_A}`, { method: "POST" }),
      )
    ).status,
    405,
  );
});

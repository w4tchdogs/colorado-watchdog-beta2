import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServices } from "../dist/services/index.js";
import {
  bannerFrame,
  focalPercent,
  safeBannerSrc,
  selectBanners,
} from "../dist/site/banner.js";
import { createPublicSite } from "../dist/site/index.js";
import { createSitePreview } from "../dist/site-dev/preview.js";
import {
  FIXED_NOW,
  get,
  getEnhanced,
  ORIGIN,
  STATIC_DIRECTORY,
  siteAssets,
  withPreview,
} from "./site-fixtures.mjs";

const banner = (overrides) => ({
  bannerId: "b1",
  assetVersion: "v1",
  countyFips: "08001",
  src: "/assets/fixture-banner-3x1.v1.svg",
  alt: "Synthetic pattern",
  status: "published",
  ...overrides,
});

async function withBanners(options, callback) {
  const preview = await createSitePreview({
    staticDirectory: STATIC_DIRECTORY,
    now: FIXED_NOW,
    ...options,
  });
  try {
    return await callback(preview);
  } finally {
    preview.close();
  }
}

test("placeholders are shown everywhere when no banner is published", async () => {
  for (const data of ["fictional", "empty"]) {
    await withPreview(data, async (preview) => {
      for (const path of ["/", "/counties/08001", "/counties/08069"]) {
        const page = await get(preview, path);
        const frame = page.$(".hero [data-banner-frame]");
        assert.ok(frame, path);
        assert.equal(frame.dataset.bannerCount, "0", path);
        assert.ok(frame.querySelector(".banner-placeholder"), path);
        assert.equal(frame.querySelector("img"), null, path);
        assert.equal(frame.classList.contains("has-image"), false, path);
        // No fake slideshow controls accompany a static placeholder.
        assert.equal(page.$$(".hero button").length, 0, path);
        assert.doesNotMatch(
          page.$(".hero").textContent,
          /pause|next|reduce animations/i,
        );
      }
    });
  }
});

test("the stylesheet fixes the frame at 3:1 and never stretches images", () => {
  const css = readFileSync(`${STATIC_DIRECTORY}site.css`, "utf8");
  const frame = /\.banner-frame \{[^}]*\}/.exec(css)[0];
  assert.match(frame, /aspect-ratio: 3 \/ 1;/);
  const image = /\.banner-image \{[^}]*\}/.exec(css)[0];
  assert.match(image, /object-fit: cover;/);
  assert.match(image, /object-position: var\(--fx\) var\(--fy\);/);
  assert.match(css, /\.mode-contain \.banner-image \{\s*object-fit: contain;/);
  assert.doesNotMatch(css, /object-fit: fill/);
  for (let value = 0; value <= 100; value += 5) {
    assert.ok(
      css.includes(`.fx-${value} {\n  --fx: ${value}%;`),
      `fx-${value}`,
    );
    assert.ok(
      css.includes(`.fy-${value} {\n  --fy: ${value}%;`),
      `fy-${value}`,
    );
  }
  // The placeholder uses only the owner's logo, never banner or stock imagery.
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(urls, ['"/assets/brand-logo-white-large.png"']);
});

test("synthetic sources of 21:9, 13:5 and 3:1 render in cover and contain", async () => {
  await withBanners({ bannerFixtures: true }, async (preview) => {
    // Primary beats ordering; the unpublished record is not counted or shown.
    const adams = (await get(preview, "/counties/08001")).$(
      "[data-banner-frame]",
    );
    assert.equal(adams.dataset.bannerId, "fixture-adams-primary");
    assert.equal(adams.dataset.bannerCount, "2");
    assert.ok(adams.classList.contains("mode-cover"));
    const adamsImage = adams.querySelector("img");
    assert.equal(
      adamsImage.getAttribute("src"),
      "/assets/fixture-banner-13x5.v1.svg",
    );
    assert.equal(adamsImage.getAttribute("width"), "2600");
    assert.equal(adamsImage.getAttribute("height"), "1000");
    assert.equal(
      adamsImage.getAttribute("alt"),
      "Synthetic 13 by 5 test pattern.",
    );
    assert.ok(
      adamsImage.classList.contains("fx-50") &&
        adamsImage.classList.contains("fy-50"),
    );
    assert.match(adams.querySelector(".banner-caption").textContent, /13:5/);
    assert.ok(adams.querySelector(".banner-placeholder"));

    const boulder = (await get(preview, "/counties/08013")).$(
      "[data-banner-frame]",
    );
    assert.ok(boulder.classList.contains("mode-contain"));
    assert.equal(boulder.querySelector("img").getAttribute("width"), "2100");

    const denver = (await get(preview, "/counties/08031")).$(
      "[data-banner-frame] img",
    );
    assert.ok(
      denver.classList.contains("fx-50") && denver.classList.contains("fy-0"),
    );

    const larimer = (await get(preview, "/counties/08069")).$(
      "[data-banner-frame] img",
    );
    assert.equal(
      larimer.getAttribute("src"),
      "/assets/fixture-banner-3x1.v1.svg",
    );

    // Counties without a record keep the placeholder.
    assert.equal(
      (await get(preview, "/counties/08005")).$("[data-banner-frame] img"),
      null,
    );

    for (const [name, ratio] of [
      ["fixture-banner-21x9.v1.svg", 2100 / 900],
      ["fixture-banner-13x5.v1.svg", 2.6],
      ["fixture-banner-3x1.v1.svg", 3],
    ]) {
      const asset = await get(preview, `/assets/${name}`);
      assert.equal(asset.status, 200, name);
      assert.match(asset.headers.get("content-type"), /image\/svg\+xml/);
      const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(asset.text);
      assert.equal(Number(width) / Number(height), ratio, name);
      assert.match(asset.text, /Synthetic test pattern/);
      assert.doesNotMatch(asset.text, /<script|style=|href=/);
    }
  });
});

test("a missing or failing image falls back to the placeholder", async () => {
  await withBanners({ bannerFixtures: true }, async (preview) => {
    assert.equal(
      (await get(preview, "/assets/fixture-banner-missing.v1.svg")).status,
      404,
    );
    const page = await getEnhanced(preview, "/counties/08123");
    const frame = page.$("[data-banner-frame]");
    const image = frame.querySelector("img");
    assert.ok(frame.classList.contains("has-image"));
    image.dispatchEvent(new page.window.Event("error"));
    assert.equal(image.hidden, true);
    assert.equal(frame.classList.contains("has-image"), false);
    assert.equal(frame.dataset.bannerState, "unavailable");
    assert.ok(frame.querySelector(".banner-placeholder"));
    assert.equal(page.$("h1").textContent, "Weld County");
  });
});

const enhancement = readFileSync(`${STATIC_DIRECTORY}site.js`, "utf8");

function carouselPage(markup, { reduced = false, deferred = [], mutate } = {}) {
  const { window } = new JSDOM(
    `<section class="hero"><div class="hero-banner">${markup}</div></section>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: ORIGIN },
  );
  const { document } = window;
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  let hidden = false;
  const images = [];
  const createElement = document.createElement.bind(document);
  document.createElement = (name, options) => {
    const element = createElement(name, options);
    if (name === "img") images.push(element);
    return element;
  };
  Object.defineProperties(window.HTMLImageElement.prototype, {
    complete: {
      get() {
        return !deferred.includes(this.getAttribute("src"));
      },
    },
    naturalWidth: { get: () => 800 },
  });
  Object.defineProperty(window.performance, "now", { value: () => now });
  const motion = new window.EventTarget();
  motion.matches = reduced;
  window.matchMedia = () => motion;
  window.setTimeout = (callback, delay) => {
    timers.set(++nextTimer, { callback, delay });
    return nextTimer;
  };
  window.clearTimeout = (id) => timers.delete(id);
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const frame = document.querySelector("[data-banner-frame]");
  mutate?.(frame);
  window.eval(enhancement);
  const control = (name) => document.querySelector(`[data-banner-${name}]`);
  return {
    window,
    frame,
    timers,
    images,
    motion,
    control,
    changeVisibility(value) {
      hidden = value;
      document.dispatchEvent(new window.Event("visibilitychange"));
    },
    advanceTime(milliseconds) {
      now += milliseconds;
    },
    tick() {
      assert.equal(timers.size, 1);
      const [id, { callback, delay }] = timers.entries().next().value;
      timers.delete(id);
      now += delay;
      callback();
    },
    finishFade() {
      const event = new window.Event("animationend");
      Object.defineProperty(event, "animationName", {
        value: "banner-crossfade",
      });
      control("incoming").dispatchEvent(event);
    },
  };
}

const carouselSlides = [
  banner({ primary: true, caption: "First caption" }),
  banner({
    bannerId: "b2",
    assetVersion: "v2",
    src: "/assets/fixture-banner-21x9.v1.svg",
    alt: "Another synthetic pattern",
    caption: 'Second <caption> "quoted"',
    width: 2100,
    height: 900,
    displayMode: "contain",
    focalX: 0.2,
    focalY: 0.95,
  }),
  banner({
    bannerId: "b3",
    assetVersion: "v3",
    countyFips: "08013",
    src: "/assets/fixture-banner-missing.v1.svg",
  }),
];

test("carousel keeps a no-script fallback and synchronizes manual navigation", async () => {
  await withBanners(
    {
      banners: {
        forHome: () => carouselSlides,
        forCounty: () => carouselSlides,
      },
    },
    async (preview) => {
      for (const [path, count] of [
        ["/", 3],
        ["/counties/08001", 2],
      ]) {
        const page = await get(preview, path);
        const frame = page.$("[data-banner-frame]");
        assert.equal(frame.dataset.bannerCount, String(count));
        assert.equal(frame.dataset.bannerId, "b1");
        assert.equal(frame.querySelector("img").alt, "Synthetic pattern");
        assert.equal(
          frame.querySelector(".banner-caption").textContent,
          "First caption",
        );
        assert.ok(page.$("[data-banner-controls]").hidden);
      }
    },
  );

  const page = carouselPage(bannerFrame(carouselSlides, "08001").value);
  const { frame, control, window } = page;
  try {
    assert.equal(control("controls").hidden, false);
    assert.equal(control("status").getAttribute("aria-live"), "polite");
    const buttons = [...control("controls").querySelectorAll("button")];
    assert.deepEqual(
      buttons.map((button) => button.getAttribute("aria-label")),
      [
        "Previous banner",
        "Next banner",
        "Pause banner rotation",
        "Play banner rotation",
      ],
    );
    assert.ok(
      buttons.every(
        (button) => button.type === "button" && button.tabIndex === 0,
      ),
    );
    const firstImage = control("image");
    const previous = control("previous");
    previous.focus();
    previous.click();
    assert.equal(window.document.activeElement, previous);
    assert.equal(frame.dataset.bannerId, "b2");
    assert.equal(frame.dataset.bannerVersion, "v2");
    assert.ok(frame.classList.contains("mode-contain"));
    assert.equal(control("image").getAttribute("src"), carouselSlides[1].src);
    assert.equal(control("image").alt, carouselSlides[1].alt);
    assert.equal(control("image").width, 2100);
    assert.equal(control("image").height, 900);
    assert.equal(control("image").className, "banner-image fx-20 fy-95");
    assert.equal(
      frame.querySelector(".banner-caption").textContent,
      carouselSlides[1].caption,
    );
    assert.equal(control("status").textContent, "Banner 2 of 2");
    firstImage.dispatchEvent(new window.Event("error"));
    assert.equal(frame.dataset.bannerState, "ready");
    assert.equal(control("image").hidden, false);
    control("next").click();
    assert.equal(frame.dataset.bannerId, "b1");
    assert.equal(control("status").textContent, "Banner 1 of 2");
    assert.equal(control("image").getAttribute("width"), null);
  } finally {
    window.close();
  }
});

test("play is intentional and pauses the dwell and in-flight fade", () => {
  const page = carouselPage(bannerFrame(carouselSlides, "08001").value);
  const { control, window, frame, timers, motion } = page;
  const play = control("play");
  const pause = control("pause");
  try {
    assert.equal(timers.size, 0);
    assert.equal(pause.getAttribute("aria-disabled"), "true");
    play.click();
    play.click();
    assert.equal(timers.size, 1);
    assert.equal(timers.values().next().value.delay, 7000);
    assert.equal(play.getAttribute("aria-disabled"), "true");
    page.advanceTime(1700);
    pause.click();
    assert.equal(timers.size, 0);
    play.click();
    assert.equal(timers.values().next().value.delay, 5300);
    page.tick();
    const incoming = control("incoming");
    assert.equal(frame.dataset.bannerId, "b1");
    assert.ok(incoming);
    assert.equal(incoming.getAttribute("aria-hidden"), "true");
    assert.ok(frame.hasAttribute("data-banner-playing"));
    pause.click();
    assert.equal(frame.hasAttribute("data-banner-playing"), false);
    assert.equal(control("incoming"), incoming);
    assert.equal(timers.size, 0);
    play.click();
    assert.ok(frame.hasAttribute("data-banner-playing"));
    page.finishFade();
    assert.equal(frame.dataset.bannerId, "b2");
    assert.equal(control("image"), incoming);
    assert.ok(incoming.hasAttribute("data-banner-zoom"));
    assert.equal(incoming.hasAttribute("data-banner-incoming"), false);
    assert.equal(timers.values().next().value.delay, 7000);
    pause.click();
    assert.equal(timers.size, 0);
    control("next").click();
    assert.equal(timers.size, 0);
    assert.equal(frame.dataset.bannerId, "b1");

    for (const interrupt of [
      () => control("next").focus(),
      () =>
        frame.closest(".hero").dispatchEvent(new window.Event("pointerenter")),
      () =>
        frame.dispatchEvent(new window.Event("pointerdown", { bubbles: true })),
      () => page.changeVisibility(true),
      () => window.dispatchEvent(new window.Event("pagehide")),
    ]) {
      play.click();
      assert.equal(timers.size, 1);
      interrupt();
      assert.equal(timers.size, 0);
      page.changeVisibility(false);
      window.dispatchEvent(new window.Event("pageshow"));
      assert.equal(timers.size, 0);
    }
    play.click();
    motion.matches = true;
    motion.dispatchEvent(new window.Event("change"));
    assert.equal(timers.size, 0);
    play.click();
    assert.equal(timers.size, 0);
    motion.matches = false;
    motion.dispatchEvent(new window.Event("change"));
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

test("reduced motion is immediate and a failed replacement keeps the current artwork", () => {
  const page = carouselPage(bannerFrame(carouselSlides, null).value, {
    reduced: true,
    deferred: [carouselSlides[2].src],
  });
  const { control, window, frame, timers, images } = page;
  try {
    assert.equal(control("play").getAttribute("aria-disabled"), "true");
    control("play").click();
    assert.equal(timers.size, 0);
    const first = control("image");
    control("previous").click();
    assert.equal(frame.dataset.bannerId, "b1");
    assert.equal(control("image"), first);
    images.at(-1).dispatchEvent(new window.Event("error"));
    assert.equal(control("image"), first);
    assert.equal(frame.dataset.bannerState, "ready");
    assert.equal(
      control("status").textContent,
      "Banner 1 of 3 · Image unavailable",
    );
    control("previous").click();
    assert.equal(frame.dataset.bannerId, "b2");
    assert.equal(control("incoming"), null);
    assert.equal(control("image").hasAttribute("data-banner-zoom"), false);
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

test("a slow replacement starts the dwell only when ready", () => {
  const page = carouselPage(bannerFrame(carouselSlides, "08001").value, {
    deferred: [carouselSlides[1].src],
  });
  const { control, window, frame, timers, images } = page;
  try {
    const first = control("image");
    control("play").click();
    assert.equal(timers.size, 0);
    assert.equal(control("image"), first);
    page.advanceTime(8000);
    images[0].dispatchEvent(new window.Event("load"));
    assert.equal(timers.values().next().value.delay, 7000);
    page.tick();
    const incoming = control("incoming");
    assert.equal(frame.dataset.bannerId, "b1");
    assert.equal(control("image"), first);
    page.motion.matches = true;
    page.motion.dispatchEvent(new window.Event("change"));
    assert.equal(frame.dataset.bannerId, "b2");
    assert.equal(control("image"), incoming);
    assert.equal(control("incoming"), null);
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

test("malformed presentations are excluded before rendering or navigation", () => {
  const markup = bannerFrame(
    [
      ...carouselSlides,
      banner({ bannerId: "bad-url", src: "data:image/png,unsafe" }),
      banner({ bannerId: "no-version", assetVersion: null }),
      banner({ bannerId: "no-alt", alt: " " }),
      banner({ bannerId: "bad-county", countyFips: "unknown" }),
      banner({ bannerId: "unpublished", status: "unpublished" }),
    ],
    null,
  ).value;
  const { frame, control, window } = carouselPage(markup, {
    mutate(frame) {
      assert.equal(frame.dataset.bannerCount, "3");
      const slides = JSON.parse(frame.dataset.bannerSlides);
      slides.push({ ...slides[0], src: "//example.invalid/unsafe.png" });
      slides.push({ ...slides[0], focalX: "0 evil" });
      frame.dataset.bannerSlides = JSON.stringify(slides);
    },
  });
  try {
    control("previous").click();
    assert.equal(frame.dataset.bannerId, "b3");
    assert.equal(control("status").textContent, "Banner 3 of 3");
  } finally {
    window.close();
  }
  for (const slides of [[], carouselSlides.slice(0, 1)]) {
    assert.doesNotMatch(
      bannerFrame(slides, null).value,
      /data-banner-controls/,
    );
  }
});

test("selection handles add, unpublish, reorder and multiple banners as data", () => {
  const ids = (list, fips = "08001") =>
    selectBanners(list, fips).map((b) => b.bannerId);
  const a = banner({ bannerId: "a", order: 2 });
  const b = banner({ bannerId: "b", order: 1 });
  const c = banner({ bannerId: "c", order: 3 });
  assert.deepEqual(ids([a, b, c]), ["b", "a", "c"]);
  // Add.
  assert.deepEqual(ids([a, b, c, banner({ bannerId: "d", order: 0 })]), [
    "d",
    "b",
    "a",
    "c",
  ]);
  // Unpublish, then restore.
  assert.deepEqual(ids([a, { ...b, status: "unpublished" }, c]), ["a", "c"]);
  assert.deepEqual(ids([a, { ...b, status: "published" }, c]), ["b", "a", "c"]);
  // Reorder and primary selection.
  assert.deepEqual(ids([{ ...a, order: 1 }, { ...b, order: 2 }, c]), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(ids([a, b, { ...c, primary: true }]), ["c", "b", "a"]);
  // Stable without ordering metadata.
  assert.deepEqual(
    ids([banner({ bannerId: "z" }), banner({ bannerId: "y" })]),
    ["y", "z"],
  );
  // Other counties and unusable addresses are dropped.
  assert.deepEqual(
    ids([a, banner({ bannerId: "other", countyFips: "08069" })]),
    ["a"],
  );
  for (const src of [
    "javascript:alert(1)",
    "http://example.invalid/a.jpg",
    "//example.invalid/a.jpg",
    "",
    "relative.jpg",
    "/a b.jpg",
    "https://u:p@example.invalid/a.jpg",
    '/x"onerror="y',
  ]) {
    assert.equal(safeBannerSrc(src), null, src);
    assert.deepEqual(ids([banner({ src })]), [], src);
  }
  assert.equal(
    safeBannerSrc("https://banners.example.invalid/k/v2/a.jpg"),
    "https://banners.example.invalid/k/v2/a.jpg",
  );
  // The statewide selection is not filtered by county.
  assert.deepEqual(
    ids([banner({ bannerId: "s", countyFips: null }), a], null),
    ["a", "s"],
  );

  assert.equal(focalPercent(undefined), 50);
  assert.equal(focalPercent(0), 0);
  assert.equal(focalPercent(1), 100);
  assert.equal(focalPercent(0.22), 20);
  assert.equal(focalPercent(0.23), 25);
  assert.equal(focalPercent(-3), 0);
  assert.equal(focalPercent(7), 100);
  assert.equal(focalPercent(Number.NaN), 50);

  const withFocus = bannerFrame(
    [banner({ focalX: 0.8, focalY: 0.1, displayMode: "contain" })],
    "08001",
  ).value;
  assert.match(withFocus, /class="banner-image fx-80 fy-10"/);
  assert.match(withFocus, /mode-contain/);
  // Unknown modes fall back to cover; missing dimensions are simply omitted.
  const odd = bannerFrame(
    [banner({ displayMode: "stretch", width: -1 })],
    "08001",
  ).value;
  assert.match(odd, /mode-cover/);
  assert.doesNotMatch(odd, /width=/);
});

test("replacing the asset version changes the page without template changes", async () => {
  let records = [
    banner({
      bannerId: "logical-1",
      assetVersion: "v1",
      src: "/assets/fixture-banner-21x9.v1.svg",
      caption: "First",
    }),
  ];
  const banners = {
    forCounty: (fips) => records.filter((b) => b.countyFips === fips),
    forHome: () => records,
  };
  await withBanners({ bannerFixtures: true, banners }, async (preview) => {
    const before = (await get(preview, "/counties/08001")).$(
      "[data-banner-frame]",
    );
    assert.equal(before.dataset.bannerId, "logical-1");
    assert.equal(before.dataset.bannerVersion, "v1");
    assert.equal(
      before.querySelector("img").getAttribute("src"),
      "/assets/fixture-banner-21x9.v1.svg",
    );

    // Replace: same logical banner, new version and new address.
    records = [
      {
        ...records[0],
        assetVersion: "v2",
        src: "/assets/fixture-banner-21x9.v2.svg",
      },
    ];
    const after = (await get(preview, "/counties/08001")).$(
      "[data-banner-frame]",
    );
    assert.equal(after.dataset.bannerId, "logical-1");
    assert.equal(after.dataset.bannerVersion, "v2");
    assert.equal(
      after.querySelector("img").getAttribute("src"),
      "/assets/fixture-banner-21x9.v2.svg",
    );
    assert.equal(after.querySelector(".banner-caption").textContent, "First");
    // The homepage draws from the statewide selection.
    assert.equal(
      (await get(preview, "/")).$("[data-banner-frame]").dataset.bannerVersion,
      "v2",
    );

    // Restore the earlier version, then unpublish.
    records = [
      {
        ...records[0],
        assetVersion: "v1",
        src: "/assets/fixture-banner-21x9.v1.svg",
      },
    ];
    assert.equal(
      (await get(preview, "/counties/08001")).$("[data-banner-frame]").dataset
        .bannerVersion,
      "v1",
    );
    records = [{ ...records[0], status: "unpublished" }];
    const withdrawn = (await get(preview, "/counties/08001")).$(
      "[data-banner-frame]",
    );
    assert.equal(withdrawn.querySelector("img"), null);
    assert.equal(withdrawn.dataset.bannerCount, "0");
  });
});

test("banner text is escaped and extra image origins are opt-in", async () => {
  const hostile = banner({
    bannerId: 'x"><script>1</script>',
    alt: '"><img src=x onerror=1>',
    caption: "<b>bold</b>",
  });
  const markup = bannerFrame([hostile], "08001").value;
  assert.doesNotMatch(markup, /<script>|<b>|<img src=x/);
  assert.match(markup, /&lt;b&gt;bold&lt;\/b&gt;/);

  const site = (bannerOrigins) =>
    createPublicSite({
      services: createServices(),
      assets: siteAssets(),
      bannerOrigins,
    });
  const csp = async (origins) =>
    (await site(origins).fetch(new Request(`${ORIGIN}/about`))).headers.get(
      "content-security-policy",
    );
  assert.match(await csp(undefined), /img-src 'self';/);
  assert.match(
    await csp(["https://banners.example.invalid"]),
    /img-src 'self' https:\/\/banners\.example\.invalid;/,
  );
  assert.match(
    await csp([
      "*",
      "http://x.invalid",
      "https://a.invalid; script-src *",
      "data:",
    ]),
    /img-src 'self';/,
  );
});

test("county switcher redirects to the chosen county", async () => {
  await withPreview("empty", async (preview) => {
    const response = await preview.fetch(
      new Request(`${ORIGIN}/counties?county=08069`),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/counties/08069");
    for (const value of ["08002", "99999", "larimer", "08069%2F..%2Fx"]) {
      assert.equal(
        (await get(preview, `/counties?county=${value}`)).status,
        400,
        value,
      );
    }
    const county = await get(preview, "/counties/08069");
    const form = county.$("form.county-switch");
    assert.equal(form.getAttribute("action"), "/counties");
    assert.equal(form.querySelector("select").name, "county");
    assert.ok(county.$('label[for="county-switch"]'));
    assert.ok(form.querySelector('button[type="submit"]'));
    // County navigation follows the same model on every county.
    assert.deepEqual(
      county.$$(".county-nav ul a").map((a) => a.getAttribute("href")),
      [
        "/counties/08069",
        "/officials?county=08069",
        "/officials?directoryView=structure&county=08069",
      ],
    );
  });
});

test("owner logo and mascot artwork are used sparingly", async () => {
  await withPreview("fictional", async (preview) => {
    const home = await get(preview, "/");
    assert.equal(
      home.$(".site-header .brand img").getAttribute("src"),
      "/assets/brand-logo-white.png",
    );
    assert.equal(
      home.$(".site-footer img").getAttribute("src"),
      "/assets/brand-logo-white.png",
    );
    assert.match(
      home.$(".site-header .brand").textContent,
      /Colorado Watchdog/,
    );
    assert.match(
      home.$(".site-header .brand").textContent,
      /Accountability Starts with Being Heard/,
    );
    // Four discovery-card icons plus the header Submit a report arrow.
    assert.equal(home.$$("svg").length, 5);
    assert.equal(home.$$(".site-header svg[aria-hidden=true]").length, 1);
    assert.equal(home.$$(".discovery-card > svg[aria-hidden=true]").length, 4);
    const mascots = (page) =>
      page.$$("img.mascot").map((img) => img.getAttribute("src"));
    assert.deepEqual(mascots(home), ["/assets/brand-mascot-standing.png"]);
    assert.deepEqual(mascots(await get(preview, "/about")), [
      "/assets/brand-mascot-sit-alert.png",
    ]);
    assert.deepEqual(mascots(await get(preview, "/missing")), [
      "/assets/brand-mascot-lying.png",
    ]);
    for (const path of [
      "/counties",
      "/counties/08001",
      "/people/demo-person-riley",
      "/stories",
    ]) {
      assert.deepEqual(mascots(await get(preview, path)), [], path);
    }
    for (const img of home.$$("img")) {
      assert.equal(img.getAttribute("alt"), "");
      assert.ok(img.getAttribute("width") && img.getAttribute("height"));
      assert.equal((await get(preview, img.getAttribute("src"))).status, 200);
    }
    assert.match(home.$(".site-strip").textContent, /not findings of fact/);
  });
});

test("explicit play and pause are announced once, and nothing else is", () => {
  const page = carouselPage(bannerFrame(carouselSlides, "08001").value);
  const { control, window, timers, motion } = page;
  const said = () => control("announce").textContent;
  try {
    assert.equal(control("announce").getAttribute("aria-live"), "polite");
    assert.equal(said(), "");
    // A disabled Pause and manual navigation say nothing about playback.
    control("pause").click();
    control("next").click();
    assert.equal(said(), "");
    assert.equal(control("status").textContent, "Banner 2 of 2");

    control("play").click();
    assert.equal(said(), "Banner rotation playing");
    // The position status is untouched by Play and keeps one message per move.
    assert.equal(control("status").textContent, "Banner 2 of 2");
    page.tick();
    page.finishFade();
    assert.equal(control("status").textContent, "Banner 1 of 2");
    assert.equal(said(), "Banner rotation playing");
    control("play").click();
    assert.equal(timers.size, 1);

    control("pause").click();
    assert.equal(said(), "Banner rotation paused");
    assert.equal(timers.size, 0);
    control("pause").click();
    assert.equal(said(), "Banner rotation paused");

    // Focus entering the carousel stops running rotation and says so once.
    // A later Play is announced again.
    control("play").click();
    assert.equal(said(), "Banner rotation playing");
    control("next").focus();
    assert.equal(said(), "Banner rotation paused");
    assert.equal(timers.size, 0);
    control("pause").click();
    assert.equal(said(), "Banner rotation paused");
    control("play").click();
    assert.equal(said(), "Banner rotation playing");
    assert.equal(window.document.activeElement, control("next"));
    // Pointer interaction is spoken the same way, while automatic stops
    // (hidden page) are silent and clear the text so Play is heard again.
    control("frame")
      .closest(".hero")
      .dispatchEvent(new window.Event("pointerenter"));
    assert.equal(said(), "Banner rotation paused");
    control("play").click();
    page.changeVisibility(true);
    assert.equal(said(), "");
    page.changeVisibility(false);
    control("play").click();
    assert.equal(said(), "Banner rotation playing");

    // An unavailable Play never announces that rotation started.
    control("pause").click();
    assert.equal(said(), "Banner rotation paused");
    motion.matches = true;
    motion.dispatchEvent(new window.Event("change"));
    control("play").click();
    assert.equal(said(), "Banner rotation paused");
    assert.equal(timers.size, 0);
    motion.matches = false;
    motion.dispatchEvent(new window.Event("change"));
    control("play").click();
    page.changeVisibility(true);
    assert.equal(said(), "");
    control("play").click();
    assert.equal(said(), "");
    assert.equal(timers.size, 0);
  } finally {
    window.close();
  }
});

test("full-width heroes overlay unshaded copy and keep the 3:1 baseline at every width", () => {
  const css = readFileSync(`${STATIC_DIRECTORY}site.css`, "utf8");
  const shared = css.slice(
    css.indexOf("\n.hero {"),
    css.indexOf("@media (min-width: 64rem) {\n  .hero-content"),
  );
  assert.doesNotMatch(css, /100rem/);
  assert.match(shared, /\.hero \{\s*display: grid;/);
  assert.match(shared, /\.hero::before \{[^}]*aspect-ratio: 3 \/ 1;/);
  assert.match(
    shared,
    /\.hero-banner \{[^}]*grid-area: 1 \/ 1 \/ 4;[^}]*width: 100%;/,
  );
  assert.match(
    shared,
    /\.hero \.banner-frame \{[^}]*grid-row: 1 \/ 3;[^}]*aspect-ratio: auto;/,
  );
  assert.match(
    shared,
    /\.hero-content \{[^}]*grid-area: 1 \/ 1 \/ 3;[^}]*z-index: 1;/,
  );
  const textRules = css.matchAll(
    /(?:^|\n)\s*((?:\.hero )?\.banner-caption|\.hero-content) \{([^}]+)\}/g,
  );
  for (const [, selector, declarations] of textRules) {
    assert.doesNotMatch(declarations, /\bbackground(?:-[\w-]+)?\s*:/, selector);
  }
  assert.match(shared, /\.hero \.banner-caption \{[^}]*grid-row: 2;/);
  assert.match(shared, /\.hero \.banner-controls \{\s*grid-row: 3;/);
  assert.match(/\.hero-content \.wrap \{[^}]*\}/.exec(css)[0], /var\(--wrap\)/);
});

test("the synthetic preview shows two homepage banners and can turn them off", async () => {
  await withBanners({ bannerFixtures: true }, async (preview) => {
    const page = await get(preview, "/");
    const frame = page.$(".hero [data-banner-frame]");
    assert.equal(frame.dataset.bannerCount, "2");
    assert.equal(frame.dataset.bannerId, "fixture-home-wide");
    assert.ok(frame.querySelector("img"));
    assert.ok(page.$("[data-banner-controls]"));
    assert.ok(page.$("[data-banner-announce]"));
  });
  await withBanners(
    { bannerFixtures: true, homeBannerFixtures: false },
    async (preview) => {
      const page = await get(preview, "/");
      const frame = page.$(".hero [data-banner-frame]");
      assert.equal(frame.dataset.bannerCount, "0");
      assert.equal(frame.querySelector("img"), null);
      const county = await get(preview, "/counties/08001");
      assert.equal(county.$("[data-banner-frame]").dataset.bannerCount, "2");
    },
  );
});

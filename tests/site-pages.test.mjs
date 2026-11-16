import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createContentService } from "../dist/services/content.js";
import {
  COUNTY_MAP,
  renderCountyMap,
  validateCountyMap,
} from "../dist/site/county-map.js";
import {
  allowSynthetic,
  principalFactory,
  seedContentFixture,
} from "./content-fixtures.mjs";
import {
  get,
  getEnhanced,
  internalLinks,
  withPreview,
} from "./site-fixtures.mjs";

test("homepage renders navigation, discovery entry points and honest content", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/");
    assert.equal(page.status, 200);
    assert.equal(page.$$("h1").length, 1);
    assert.deepEqual(
      page
        .$$("#site-nav a")
        .map((a) => [a.textContent, a.getAttribute("href")]),
      [
        ["Counties", "/counties"],
        ["Officials", "/officials"],
        ["Organizations", "/organizations"],
        ["Stories", "/stories"],
        ["Posts", "/posts"],
        ["About", "/about"],
      ],
    );
    assert.equal(page.$$(".county-index-grid a").length, 64);
    assert.ok(page.$('form[action="/officials"] input[name="q"]'));
    assert.ok(page.$('form[action="/organizations"] input[name="query"]'));
    assert.ok(page.$('form[action="/counties"] input[name="q"]'));
    assert.equal(page.$$(".county-card").length, 6);
    assert.match(page.$(".preview-notice").textContent, /fictional/);
    assert.equal(
      page.$("h1").textContent,
      "Community Voices. Government Accountability.",
    );
    const pathways = page.$$(".cv-pathway");
    assert.equal(pathways.length, 3);
    assert.deepEqual(
      pathways.map(
        (card) => card.querySelector(".cv-pathway-title").textContent,
      ),
      ["Local series", "Guest Voices", "Statewide County Issues"],
    );
    assert.deepEqual(
      pathways.map((card) =>
        card.querySelector(".cv-pathway-link").getAttribute("href"),
      ),
      [
        "/stories?pathway=local-series#cv-results",
        "/stories?pathway=guest-voices#cv-results",
        "/stories?pathway=statewide-issues#cv-results",
      ],
    );
    assert.doesNotMatch(
      page.$(".cv-pathway-grid").textContent,
      /\d+ articles?/i,
    );
    for (const card of pathways) {
      assert.equal(
        (
          await get(
            preview,
            card.querySelector(".cv-pathway-link").getAttribute("href"),
          )
        ).status,
        200,
      );
    }
    // Nothing unimplemented is advertised.
    assert.doesNotMatch(page.text, /submit a report|log in|sign up|grievance/i);
    assert.ok(page.$$(".article-card").length > 0);
    assert.ok(
      page
        .$$(".article-card")
        .every((card) => card.querySelector(".fictional-flag")),
    );
    assert.ok(page.$('footer a[href="/reading-records"]'));

    // Every internal link on the homepage resolves.
    for (const href of new Set(internalLinks(page))) {
      assert.equal((await get(preview, href)).status, 200, href);
    }
  });
});

test("homepage on an empty database stays useful and claims nothing", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/");
    assert.equal(page.status, 200);
    assert.equal(page.$(".preview-notice"), null);
    assert.equal(page.$$(".county-index-grid a").length, 64);
    assert.equal(page.$$(".article-card").length, 0);
    assert.match(page.main(), /Nothing has been published yet/);
    assert.equal(page.$$(".cv-pathway").length, 3);
    assert.deepEqual(
      page.$$(".cv-pathway-link").map((link) => link.getAttribute("href")),
      [
        "/stories?pathway=local-series#cv-results",
        "/stories?pathway=guest-voices#cv-results",
        "/stories?pathway=statewide-issues#cv-results",
      ],
    );
    for (const link of page.$$(".cv-pathway-link")) {
      const result = await get(preview, link.getAttribute("href"));
      assert.equal(result.status, 200);
      assert.match(result.main(), /No stories yet/);
      assert.equal(result.$$(".article-card").length, 0);
    }
    assert.ok(
      page
        .$$(".county-card-counts")
        .every((n) => /No records in the database yet/.test(n.textContent)),
    );
    assert.doesNotMatch(page.text, /fictional/i);
  });
});

test("county directory lists all 64 counties and every county page loads", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/counties");
    const rows = page.$$("[data-county]");
    assert.equal(rows.length, 64);
    const registry = preview.database
      .prepare("SELECT fips, name FROM counties ORDER BY fips")
      .all();
    assert.deepEqual(
      rows.map((row) => row.dataset.fips).sort(),
      registry.map((row) => row.fips),
    );
    for (const row of rows) {
      const fips = row.dataset.fips;
      assert.match(fips, /^08\d{3}$/);
      assert.match(row.textContent, new RegExp(`FIPS ${fips}`));
      const href = row.querySelector("a").getAttribute("href");
      assert.equal(href, `/counties/${fips}`);
      const county = await get(preview, href);
      assert.equal(county.status, 200, href);
      assert.match(county.$("h1").textContent, / County$/);
      assert.match(county.main(), /No records for .+ yet/);
      assert.match(county.main(), /not the county's government/);
    }
    assert.ok(page.$$(".letter-nav a").length > 10);
  });
});

test("county page copy matches the Beta-1 reference and keeps the Alpha-1 controls", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/counties");
    const text = (selector) => page.$(selector).textContent.trim();
    assert.ok(page.$(".counties-page"));
    assert.equal(
      text(".counties-page .eyebrow"),
      "64 counties · one statewide record",
    );
    assert.equal(text(".counties-page h1"), "Explore Colorado’s counties");
    assert.equal(
      text(".counties-page .lede"),
      "Choose a county on the map or search the directory below. County totals reflect incident locations and can overlap; they do not add up to the statewide total.",
    );
    assert.equal(text(".county-map-status"), "Choose a county");
    assert.ok(
      page
        .$(".county-map-status")
        .compareDocumentPosition(page.$(".county-map")) & 4,
      "map label precedes the map",
    );
    const label = page.$('label[for="county-search"]');
    assert.equal(label.textContent.trim(), "Search counties");
    assert.ok(label.classList.contains("visually-hidden"));
    assert.equal(
      page.$("#county-search").getAttribute("placeholder"),
      "Search counties",
    );
    assert.equal(
      text("#county-search-hint"),
      "Type a county name or FIPS code to see matching counties.",
    );
    assert.equal(
      page.$(".county-map-skip").getAttribute("href"),
      "#county-directory",
    );
    assert.match(page.$(".county-map-skip").textContent, /Skip the map/);
    assert.equal(page.$$("a[data-map-county]").length, 64);
    assert.doesNotMatch(page.main(), /illustrative|surveying/);
  });
});

test("county search works by name and FIPS, with and without JavaScript", async () => {
  await withPreview("empty", async (preview) => {
    const visible = (page) =>
      page
        .$$("[data-county]")
        .filter((row) => !row.hidden)
        .map((row) => row.dataset.fips);

    assert.deepEqual(visible(await get(preview, "/counties?q=larimer")), [
      "08069",
    ]);
    assert.deepEqual(visible(await get(preview, "/counties?q=08069")), [
      "08069",
    ]);
    assert.deepEqual(visible(await get(preview, "/counties?q=lake")), [
      "08065",
    ]);
    assert.deepEqual(visible(await get(preview, "/counties?q=la%20plata")), [
      "08067",
    ]);
    assert.deepEqual(visible(await get(preview, "/counties?q=08065")), [
      "08065",
    ]);
    assert.deepEqual(visible(await get(preview, "/counties?q=08067")), [
      "08067",
    ]);
    const lake = await get(preview, "/counties/08065");
    assert.match(lake.$("h1").textContent, /^Lake County$/);
    const laPlata = await get(preview, "/counties/08067");
    assert.match(laPlata.$("h1").textContent, /^La Plata County$/);
    const none = await get(preview, "/counties?q=zzzz");
    assert.deepEqual(visible(none), []);
    assert.equal(none.$("[data-county-empty]").hidden, false);
    assert.match(
      none.$("[data-county-empty]").textContent,
      /No county matches/,
    );
    assert.match(none.$("[data-county-count]").textContent, /0 of 64/);

    const live = await getEnhanced(preview, "/counties");
    const input = live.$("[data-county-filter]");
    live.type(input, "san ");
    assert.deepEqual(visible(live), ["08111", "08113"]);
    assert.match(live.$("[data-county-count]").textContent, /2 of 64/);
    assert.equal(live.$('[data-letter-link="A"]').parentElement.hidden, true);
    live.type(input, "08125");
    assert.deepEqual(visible(live), ["08125"]);
    live.type(input, "no such county");
    assert.equal(live.$("[data-county-empty]").hidden, false);
    live.type(input, "");
    assert.equal(visible(live).length, 64);
    assert.equal(live.$("[data-county-empty]").hidden, true);
  });
});

test("county map geometry covers the public registry with canonical accessible links", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/counties?q=San");
    const registry = preview.database
      .prepare("SELECT fips, name FROM counties ORDER BY fips")
      .all();
    assert.equal(COUNTY_MAP.counties.length, 64);
    assert.equal(
      new Set(COUNTY_MAP.counties.map((region) => region.fips)).size,
      64,
    );
    assert.match(
      COUNTY_MAP.viewBox,
      /^-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/,
    );
    assert.ok(
      COUNTY_MAP.counties.every(
        (region) =>
          /^M[\d.,\s-]+(?:[MLZ][\d.,\s-]*)+$/.test(region.path) &&
          region.path.endsWith("Z"),
      ),
    );
    assert.equal(validateCountyMap(registry), true);
    assert.equal(page.$$("[data-map-county]").length, 64);
    assert.deepEqual(
      page.$$("[data-map-county].is-match").map((link) => link.dataset.fips),
      ["08111", "08113"],
    );
    const source = JSON.parse(
      readFileSync(
        new URL("../src/site/colorado-county-map-source.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(source.license, "Public Domain");
    assert.equal(
      source.fipsReference,
      "https://tigerweb.geo.census.gov/tigerwebmain/Files/acs26/tigerweb_acs26_county_co.html",
    );
    assert.equal(
      source.attribution,
      "Colorado Department of Transportation (CDOT), Counties in Colorado.",
    );
    assert.equal(
      registry.find((county) => county.fips === "08065").name,
      "Lake",
    );
    assert.equal(
      registry.find((county) => county.fips === "08067").name,
      "La Plata",
    );
    assert.equal(
      COUNTY_MAP.counties.find((region) => region.slug === "lake").fips,
      "08065",
    );
    assert.equal(
      COUNTY_MAP.counties.find((region) => region.slug === "la-plata").fips,
      "08067",
    );
    const mapDom = new JSDOM(
      `<main>${renderCountyMap(registry, new Set(["08069"])).value}</main>`,
    );
    const mapLinks = [
      ...mapDom.window.document.querySelectorAll("[data-map-county]"),
    ];
    assert.equal(mapLinks.length, 64);
    const countyByFips = new Map(
      registry.map((county) => [county.fips, county]),
    );
    assert.deepEqual(
      mapLinks.map((link) => link.getAttribute("data-fips")).sort(),
      registry.map((county) => county.fips).sort(),
    );
    for (const link of mapLinks) {
      const fips = link.getAttribute("data-fips");
      const countyName = countyByFips.get(fips).name;
      assert.equal(link.getAttribute("href"), `/counties/${fips}`);
      assert.equal(
        link.getAttribute("aria-label"),
        `${countyName} County, FIPS ${fips}. Open county directory page.`,
      );
      assert.equal(
        link.querySelector("title").textContent,
        `${countyName} County · FIPS ${fips}`,
      );
    }
    for (const fips of ["08001", "08069", "08111", "08113"]) {
      assert.equal(
        mapDom.window.document
          .querySelector(`[data-map-county="${fips}"]`)
          .getAttribute("href"),
        `/counties/${fips}`,
      );
    }
    assert.deepEqual(
      mapLinks
        .filter((link) => link.classList.contains("is-match"))
        .map((link) => link.getAttribute("data-fips")),
      ["08069"],
    );
    assert.equal(
      mapDom.window.document
        .querySelector(".county-map-caption")
        .textContent.replace(/\s+/g, " ")
        .trim(),
      "Boundaries: Colorado Department of Transportation. Simplified for navigation. Use the searchable directory for small counties and keyboard navigation.",
    );
    assert.equal(
      mapDom.window.document
        .querySelector(".county-map-status")
        .textContent.trim(),
      "Choose a county",
    );

    const reversedRegistry = registry.map((county) =>
      county.fips === "08065"
        ? { ...county, name: "La Plata" }
        : county.fips === "08067"
          ? { ...county, name: "Lake" }
          : county,
    );
    assert.equal(validateCountyMap(reversedRegistry), false);
    const reversedFallback = renderCountyMap(reversedRegistry, new Set()).value;
    assert.match(reversedFallback, /map is temporarily unavailable/);
    assert.doesNotMatch(reversedFallback, /data-map-county/);
    const malformed = {
      ...COUNTY_MAP,
      counties: [...COUNTY_MAP.counties.slice(0, 63), COUNTY_MAP.counties[0]],
    };
    assert.equal(validateCountyMap(registry, malformed), false);
    assert.doesNotMatch(
      renderCountyMap(registry, new Set(), malformed).value,
      /data-map-county/,
    );
    const invalidPath = {
      ...COUNTY_MAP,
      counties: COUNTY_MAP.counties.map((region, index) =>
        index === 0 ? { ...region, path: "M1,1L2,2Z" } : region,
      ),
    };
    assert.equal(validateCountyMap(registry, invalidPath), false);
    assert.doesNotMatch(
      renderCountyMap(registry, new Set(), invalidPath).value,
      /data-map-county/,
    );
    assert.equal(
      validateCountyMap(registry, { ...COUNTY_MAP, viewBox: "0 0 0 486" }),
      false,
    );
    assert.match(
      renderCountyMap(registry.slice(0, 63), new Set()).value,
      /map is temporarily unavailable/,
    );
  });
});

test("county groups and filtered results are alphabetized by displayed name", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/counties");
    for (const group of page.$$("[data-county-group]")) {
      const names = [...group.querySelectorAll(".county-name")].map(
        (item) => item.textContent,
      );
      assert.deepEqual(
        names,
        [...names].sort((left, right) =>
          left
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .localeCompare(right.toLowerCase().replace(/[^a-z0-9]/g, ""), "en"),
        ),
      );
    }
    assert.deepEqual(
      [...page.$('[data-letter="E"]').querySelectorAll(".county-name")].map(
        (item) => item.textContent,
      ),
      ["Eagle County", "Elbert County", "El Paso County"],
    );
    const filtered = await get(preview, "/counties?q=e");
    for (const group of filtered.$$("[data-county-group]")) {
      const names = [...group.querySelectorAll("[data-county]")]
        .filter((item) => !item.hidden)
        .map((item) => item.querySelector(".county-name").textContent);
      assert.deepEqual(
        names,
        [...names].sort((left, right) =>
          left
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .localeCompare(right.toLowerCase().replace(/[^a-z0-9]/g, ""), "en"),
        ),
      );
    }
    assert.equal(page.$$('[data-county] a[href^="/counties/"]').length, 64);
  });
});

test("county search keeps URL, map, result count, reset and history state aligned", async () => {
  await withPreview("empty", async (preview) => {
    const live = await getEnhanced(
      preview,
      "/counties?q=08069#county-directory",
    );
    assert.equal(live.$$("[data-map-county]").length, 64);
    live.window.eval(
      readFileSync(new URL("../website/site/site.js", import.meta.url), "utf8"),
    );
    const visible = () =>
      live.$$("[data-county]:not([hidden])").map((item) => item.dataset.fips);
    const input = live.$("[data-county-filter]");
    assert.equal(input.value, "08069");
    assert.equal(live.window.location.search, "?q=08069");
    assert.deepEqual(visible(), ["08069"]);
    assert.ok(live.$('[data-map-county="08069"]'));

    live.type(input, " 08111 ");
    assert.equal(input.value, "08111");
    assert.equal(live.window.location.search, "?q=08111");
    assert.equal(live.window.location.hash, "#county-directory");
    assert.equal(
      new URLSearchParams(live.window.location.search).getAll("q").length,
      1,
    );
    assert.deepEqual(visible(), ["08111"]);
    assert.deepEqual(
      live.$$("[data-map-county].is-match").map((link) => link.dataset.fips),
      ["08111"],
    );
    assert.match(live.$("[data-county-count]").textContent, /1 of 64/);

    const region = live.$('[data-map-county="08069"]');
    region.dispatchEvent(new live.window.Event("pointerenter"));
    assert.equal(region.classList.contains("is-active"), true);
    assert.equal(
      live.$('[data-map-county="08111"]').classList.contains("is-match"),
      true,
    );
    region.dispatchEvent(new live.window.Event("pointerleave"));
    assert.equal(region.classList.contains("is-active"), false);
    const focusedRegion = live.$('[data-map-county="08111"]');
    focusedRegion.dispatchEvent(
      new live.window.FocusEvent("focusin", { bubbles: true }),
    );
    assert.equal(focusedRegion.classList.contains("is-active"), true);
    assert.match(live.$("[data-map-status]").textContent, /Press Enter/);
    focusedRegion.dispatchEvent(
      new live.window.FocusEvent("focusout", { bubbles: true }),
    );
    assert.equal(focusedRegion.classList.contains("is-active"), false);

    live.type(input, "");
    assert.equal(live.window.location.search, "");
    assert.equal(live.$("[data-map-county].is-match"), null);
    assert.equal(visible().length, 64);
    assert.equal(live.$("[data-county-empty]").hidden, true);
    const reloaded = await get(
      preview,
      `${live.window.location.pathname}${live.window.location.search}${live.window.location.hash}`,
    );
    assert.equal(reloaded.$("[data-county-filter]").value, "");
    assert.equal(reloaded.$$("[data-county]").length, 64);

    live.window.history.pushState({}, "", "/counties?q=08113#county-directory");
    live.window.dispatchEvent(new live.window.PopStateEvent("popstate"));
    assert.equal(input.value, "08113");
    assert.deepEqual(visible(), ["08113"]);
    assert.deepEqual(
      live.$$("[data-map-county].is-match").map((link) => link.dataset.fips),
      ["08113"],
    );
    live.window.history.pushState({}, "", "/counties?q=08069#county-directory");
    live.window.dispatchEvent(new live.window.PopStateEvent("popstate"));
    assert.equal(input.value, "08069");
    assert.deepEqual(visible(), ["08069"]);
  });
});

test("county search safely normalizes direct empty and special-character URLs", async () => {
  await withPreview("empty", async (preview) => {
    const blank = await getEnhanced(
      preview,
      "/counties?q=%20%20#county-directory",
    );
    blank.window.eval(
      readFileSync(new URL("../website/site/site.js", import.meta.url), "utf8"),
    );
    assert.equal(blank.window.location.search, "");
    assert.equal(blank.$("[data-county-filter]").value, "");
    assert.equal(blank.$$("[data-county]:not([hidden])").length, 64);

    const special = await getEnhanced(preview, "/counties");
    special.window.eval(
      readFileSync(new URL("../website/site/site.js", import.meta.url), "utf8"),
    );
    const query = '<img src=x>&q="other"';
    special.type(special.$("[data-county-filter]"), query);
    assert.equal(
      new URLSearchParams(special.window.location.search).get("q"),
      query,
    );
    assert.equal(special.$("[data-county-count] img"), null);
    assert.match(special.$("[data-county-count]").textContent, /<img src=x>/);
    assert.equal(special.$$("[data-county]:not([hidden])").length, 0);
  });
});

test("county page separates county organizations from affiliated ones", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/counties/08001");
    assert.equal(page.status, 200);
    assert.equal(page.$("h1").textContent, "Adams County");
    assert.match(page.$(".hero").textContent, /FIPS 08001/);
    assert.ok(page.$(".hero [data-banner-frame] .banner-placeholder"));
    assert.equal(page.$("[data-banner-frame] img"), null);
    assert.deepEqual(
      page.$$(".county-nav ul a").map((a) => a.getAttribute("href")),
      [
        "/counties/08001",
        "/officials?county=08001",
        "/officials?directoryView=structure&county=08001",
      ],
    );
    assert.equal(page.$$("#county-switch option").length, 64);
    assert.equal(page.$("#county-switch option[selected]").value, "08001");
    assert.ok(page.$('.county-nav a[href="/counties"]'));

    const stats = Object.fromEntries(
      page
        .$$(".stat-row div")
        .map((d) => [
          d.querySelector("dt").textContent,
          d.querySelector("dd").textContent,
        ]),
    );
    assert.deepEqual(stats, {
      "Organizations in the database": "7",
      "County organizations": "4",
      "Affiliated organizations": "3",
      "Documented role records": "38",
    });
    assert.match(
      page.main(),
      /do not measure staffing, completeness, vacancies or current employment/,
    );

    const lists = page.$$("#organizations .record-list");
    assert.equal(lists.length, 2);
    const [direct, affiliated] = lists;
    const names = (list) =>
      [...list.querySelectorAll(".record-title")].map((n) => n.textContent);
    assert.equal(names(direct).length, 4);
    assert.ok(names(direct).includes("Fictional Public Works Department"));
    assert.ok(affiliated.classList.contains("affiliated"));
    assert.deepEqual(names(affiliated).sort(), [
      "Fictional Community Library Partnership",
      "Fictional Front Range Health District",
      "Fictional Shared Dispatch Center",
    ]);
    assert.ok(!names(direct).some((name) => names(affiliated).includes(name)));
    assert.match(affiliated.textContent, /Serves Adams County/);
    assert.match(affiliated.textContent, /Partner for Adams County/);
    assert.match(affiliated.textContent, /Shared service for Adams County/);
    assert.match(
      page.$("#organizations").textContent,
      /They are not county departments/,
    );
    assert.match(
      direct.textContent,
      /Grouped under Fictional Adams County Government/,
    );
    assert.match(
      direct.textContent,
      /Reports to Fictional Public Works Department/,
    );

    // Roles at an affiliated organization are flagged where they appear.
    const health = page
      .$$(".role-entry")
      .find((e) => /Morgan Sample/.test(e.textContent));
    assert.match(
      health.textContent,
      /Affiliated organization, not a county department/,
    );
    const clerk = page
      .$$(".role-entry")
      .find((e) => /Fictional Clerk and Recorder,/.test(e.textContent));
    assert.doesNotMatch(clerk.textContent, /Affiliated organization/);
    assert.ok(clerk.querySelector('a[href="/people/demo-person-jordan-a"]'));
    assert.ok(clerk.querySelector('a[href="/organizations/demo-adams-clerk"]'));
  });
});

test("county roles paginate with bounded pages and stable links", async () => {
  await withPreview("fictional", async (preview) => {
    const first = await get(preview, "/counties/08001");
    assert.equal(first.$$(".role-entry").length, 25);
    const next = first.$('#roles a[rel="next"]');
    assert.match(
      next.getAttribute("href"),
      /^\/counties\/08001\?roleAfter=[\w-]+#roles$/,
    );
    assert.equal(
      first.$("#roles .pager").textContent.includes("Back to first page"),
      false,
    );

    const second = await get(
      preview,
      next.getAttribute("href").replace(/#.*/, ""),
    );
    assert.equal(second.$$(".role-entry").length, 13);
    assert.equal(second.$('#roles a[rel="next"]'), null);
    assert.equal(
      second.$("#roles .pager a").getAttribute("href"),
      "/counties/08001#roles",
    );
    const ids = (page) =>
      page.$$(".role-entry h3 a").map((a) => a.getAttribute("href"));
    assert.equal(new Set([...ids(first), ...ids(second)]).size, 36);
  });
});

test("role citations show source, type, host and check date without implying dates", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/counties/08001");
    const entry = page
      .$$(".role-entry")
      .find((e) => /Fictional Clerk and Recorder,/.test(e.textContent));
    const link = entry.querySelector(".citation cite a");
    assert.equal(
      link.getAttribute("href"),
      "https://example.invalid/fictional-adams/staff-directory",
    );
    assert.match(link.getAttribute("rel"), /noopener/);
    assert.match(link.getAttribute("rel"), /noreferrer/);
    assert.equal(link.textContent, "Fictional Adams County staff directory");
    assert.match(
      entry.querySelector(".citation-meta").textContent,
      /Official webpage/,
    );
    assert.match(
      entry.querySelector(".citation-meta").textContent,
      /example\.invalid/,
    );
    assert.match(
      entry.querySelector(".citation-meta").textContent,
      /Source checked October 2, 2026/,
    );
    const dates = entry.querySelector(".role-dates").textContent;
    assert.match(
      dates,
      /Role start\s*January 10, 2023\s*Role end\s*Not recorded/,
    );

    // No role anywhere is described as current, and a check date is never a start date.
    const undated = page
      .$$(".role-entry")
      .find(
        (e) =>
          /Riley Placeholder/.test(e.textContent) &&
          /Director/.test(e.textContent),
      );
    assert.match(
      undated.querySelector(".role-dates").textContent,
      /Role start\s*Not recorded/,
    );
    assert.doesNotMatch(
      page.$("#roles .role-list").textContent,
      /\b(current|present|incumbent|vacant)\b/i,
    );
    assert.match(page.$("#roles").textContent, /not confirmed as current/);
  });
});

test("editorial templates show only injected fixtures and never database drafts", async () => {
  await withPreview("fictional", async (preview) => {
    const stories = await get(preview, "/stories");
    assert.equal(stories.$$(".article-card").length, 3);
    assert.ok(
      stories
        .$$(".article-card")
        .every((c) => c.querySelector(".fictional-flag")),
    );
    const posts = await get(preview, "/posts");
    assert.equal(posts.$$(".article-card").length, 4);

    const article = await get(preview, "/stories/fictional-road-budget-review");
    assert.equal(article.status, 200);
    assert.ok(article.$(".article-header .fictional-flag"));
    assert.ok(article.$(".article-header time[datetime='2026-01-15']"));
    assert.ok(article.$(".article-body h2"));
    assert.ok(article.$(".article-body blockquote"));
    assert.ok(article.$(".article-body ul li"));
    assert.ok(article.$('.article-aside a[href="/counties/08001"]'));
    assert.ok(article.$('.article-aside a[href="/people/demo-person-riley"]'));
    assert.ok(
      article.$('.article-aside a[href="/organizations/demo-adams-works"]'),
    );
    assert.equal(article.$$(".article-aside .citation").length, 2);
    for (const href of new Set(internalLinks(article))) {
      assert.equal((await get(preview, href)).status, 200, href);
    }
    assert.equal(
      (await get(preview, "/posts/fictional-road-budget-review")).status,
      404,
    );
    assert.equal((await get(preview, "/stories/Not_A_Slug")).status, 404);
  });

  await withPreview("empty", async (preview) => {
    // Real draft and archived rows exist in the Website database.
    seedContentFixture(preview.database);
    const service = createContentService(preview.database, {
      authorize: allowSynthetic,
    });
    const principal = await principalFactory(preview.database)("author");
    const draft = service.createDraft(principal, {
      contentType: "story",
      title: "UNPUBLISHED-DRAFT-MARKER",
      summary: "UNPUBLISHED-SUMMARY-MARKER",
      body: "UNPUBLISHED-BODY-MARKER",
      relationships: {
        countyFips: ["08001"],
        personIds: [],
        organizationIds: [],
      },
    });
    const archived = service.createDraft(principal, {
      contentType: "post",
      title: "ARCHIVED-MARKER",
      summary: "s",
      body: "b",
      relationships: { countyFips: [], personIds: [], organizationIds: [] },
    });
    service.archiveDraft(principal, archived.id, archived.version);

    for (const path of [
      "/",
      "/stories",
      "/posts",
      "/counties/08001",
      `/stories/${draft.id}`,
      `/posts/${archived.id}`,
    ]) {
      const page = await get(preview, path);
      assert.doesNotMatch(page.text, /UNPUBLISHED|ARCHIVED-MARKER/, path);
      assert.equal(page.$$(".article-card").length, 0, path);
    }
    assert.match((await get(preview, "/stories")).main(), /No stories yet/);
    assert.match((await get(preview, "/posts")).main(), /No posts yet/);
    assert.equal((await get(preview, `/stories/${draft.id}`)).status, 404);
    // The editorial API is not reachable anonymously through the website.
    for (const path of [
      "/api/content",
      "/api/content/drafts",
      `/api/content/${draft.id}`,
    ]) {
      const response = await get(preview, path);
      assert.notEqual(response.status, 200, path);
      assert.doesNotMatch(response.text, /UNPUBLISHED/, path);
    }
  });
});

test("supporting pages and unknown routes", async () => {
  await withPreview("empty", async (preview) => {
    const about = await get(preview, "/about");
    assert.equal(about.status, 200);
    assert.match(about.main(), /not a complete roster/);
    assert.equal(about.$$(".page-header h1").length, 1);
    assert.equal(about.$$(".page-header").length, 1);
    assert.equal(about.$$(".card").length, 2);
    assert.match(about.main(), /public sources name in those positions/);
    assert.match(about.main(), /date it was checked/);
    assert.match(
      about.main(),
      /does not treat a missing name or position as a vacancy/,
    );
    assert.match(
      about.main(),
      /does not merge people because their names match/,
    );
    assert.match(
      about.main(),
      /not operated by, affiliated with or endorsed by/,
    );
    assert.ok(about.$('a[href="/reading-records"]'));
    assert.equal(about.$$(".mascot").length, 1);
    assert.equal(
      about
        .$$(".card > h2")
        .map((heading) => heading.textContent.trim())
        .join("|"),
      "What this site documents|What it does not claim",
    );
    const guide = await get(preview, "/reading-records");
    assert.equal(guide.status, 200);
    assert.match(guide.main(), /It is not an employment date/);
    assert.match(guide.main(), /does not mean the person holds the role today/);
    assert.match(
      guide.main(),
      /Affiliated organizations are not county departments/,
    );
    assert.deepEqual(
      guide.$$(".breadcrumbs li").map((li) => li.textContent.trim()),
      ["Home", "About", "How to read these records"],
    );

    for (const path of [
      "/nope",
      "/counties/08001/extra",
      "/counties/99999",
      "/counties/08002",
      "/counties/abc",
      "/people/missing-person",
      "/organizations/missing-org",
      "/people/bad%20id",
      "/%E0%A4%A",
      `/${"a".repeat(400)}`,
    ]) {
      const page = await get(preview, path);
      assert.equal(page.status, 404, path);
      assert.equal(page.$$("h1").length, 1, path);
      assert.ok(page.$('.error-page a[href="/counties"]'), path);
      assert.ok(page.$("#site-nav"), path);
    }
    assert.match(
      (await get(preview, "/people/missing-person")).main(),
      /No person record at this address/,
    );

    for (const path of [
      "/?x=1",
      "/about?x=1",
      "/counties?q=a&q=b",
      "/counties/08001?orgAfter=bad%20id",
      "/people?query=ab&cursor=garbage",
      "/people?nope=1",
    ]) {
      const page = await get(preview, path);
      assert.equal(page.status, 400, path);
      assert.ok(page.$(".error-page a.button"), path);
    }
  });
});

test("county navigation stays compact on narrow screens", () => {
  const css = readFileSync(
    new URL("../website/site/site.css", import.meta.url),
    "utf8",
  );
  const block = css.match(
    /@media \(max-width: 44rem\) \{\s*\/\* Compact county navigation[\s\S]*?\n\}\n/,
  );
  assert.ok(block, "compact county navigation rules are present");
  const rule = (selector) => {
    const start = block[0].indexOf(`${selector} {`);
    return start < 0 ? "" : block[0].slice(start, block[0].indexOf("}", start));
  };
  // The three links take a full row, and the switcher shares a row with
  // "All counties" instead of each wrapping onto its own row.
  assert.match(rule(".county-nav ul"), /flex: 1 1 100%/);
  assert.match(rule(".county-switch"), /flex: 1 1 0/);
  assert.match(rule(".county-nav-all"), /flex: 0 0 auto/);
  // The no-JavaScript Go button is never hidden by the compact layout.
  assert.doesNotMatch(block[0], /display:\s*none/);
});

test("organization pages link parent and subunits both ways", async () => {
  await withPreview("fictional", async (preview) => {
    const works = await get(preview, "/organizations/demo-adams-works");
    assert.equal(works.status, 200);
    assert.deepEqual(
      works.$$(".subunit-list a").map((a) => a.getAttribute("href")),
      ["/organizations/demo-adams-roads"],
    );
    assert.ok(works.$('a[href="/organizations/demo-adams-gov"]'));

    const roads = await get(preview, "/organizations/demo-adams-roads");
    assert.ok(roads.$('a[href="/organizations/demo-adams-works"]'));
    assert.equal(roads.$(".subunit-list"), null);
    assert.match(
      roads.$("#context-heading").parentElement.textContent,
      /No subunit is recorded/,
    );
  });
});

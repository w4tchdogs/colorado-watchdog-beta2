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
import { get, internalLinks, withPreview } from "./site-fixtures.mjs";

test("homepage renders navigation, discovery entry points and honest content", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/");
    assert.equal(page.status, 200);
    assert.ok(page.$("body.home-page"));
    assert.equal(page.$$("h1").length, 1);
    const stats = page.$('main section[aria-label="Statewide totals"]');
    assert.ok(stats.querySelector(".stat-row"));
    assert.ok(stats.nextElementSibling.matches(".home-discovery"));
    assert.deepEqual(
      [...stats.querySelectorAll("dt")].map((label) => label.textContent),
      [
        "Colorado counties",
        "Departments and offices",
        "County officials and employees",
        "Reports",
        "Grievances",
      ],
    );
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
    const discovery = page.$(".home-discovery");
    assert.equal(
      discovery.querySelector("h2").textContent,
      "Accountability starts locally.",
    );
    assert.equal(discovery.querySelector("form, input, button"), null);
    assert.deepEqual(
      [...discovery.querySelectorAll(".discovery-card")].map((card) => [
        card.tagName,
        card.querySelector("h3").textContent,
        card.getAttribute("href"),
      ]),
      [
        ["A", "Explore the counties", "/counties"],
        ["A", "Find an official", "/officials"],
        ["A", "Find an organization", "/organizations"],
        ["A", "Community Voices", "/stories"],
      ],
    );
    assert.equal(page.$(".county-index-grid, .county-cards"), null);
    assert.ok(
      page
        .$$("main h2, main h3")
        .every((heading) => heading.textContent !== "Start with a county"),
    );
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
    // The shared header now offers Submit a report, so check the page body.
    assert.doesNotMatch(page.main(), /submit a report|log in|sign up/i);
    assert.ok(page.$$(".article-card").length > 0);
    for (const card of page.$$(".cv-pathway, .editorial-grid .article-card")) {
      assert.equal(card.querySelectorAll("a[href]").length, 1);
      assert.ok(card.querySelector(".cv-pathway-link, .article-card-title a"));
    }
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

test("Home and Stories share navigation, MENU and footer hover styles", async () => {
  await withPreview("fictional", async (preview) => {
    const css = await get(preview, "/assets/site.css");
    assert.equal(css.status, 200);

    for (const path of ["/", "/stories"]) {
      const page = await get(preview, path);
      assert.equal(page.status, 200);
      const { document } = page;
      const { getComputedStyle } = document.defaultView;
      const style = document.createElement("style");
      // jsdom has no pointer input. Activate the stylesheet's hover rules
      // with an attribute on the same elements that receive pointer hover.
      // jsdom's 1024px viewport is below the 75rem desktop header breakpoint,
      // so disable the narrow-screen block to assert the desktop hover styles.
      style.textContent = css.text
        .replaceAll(":hover", "[data-test-hover]")
        .replace("@media (max-width: 74.99rem)", "@media (max-width: 0rem)");
      document.head.append(style);

      const menu = page.$(".nav-toggle");
      menu.setAttribute("data-test-hover", "");
      assert.equal(
        getComputedStyle(menu).backgroundColor,
        "rgb(23, 23, 23)",
        path,
      );

      for (const link of page.$$(".site-nav a")) {
        link.setAttribute("data-test-hover", "");
        const hovered = getComputedStyle(link);
        assert.equal(hovered.backgroundColor, "rgba(0, 0, 0, 0)", path);
        assert.equal(hovered.borderBottomColor, "rgb(255, 255, 255)", path);
      }

      const footerLink = page.$(".site-footer nav a");
      assert.equal(
        getComputedStyle(footerLink).textDecorationLine,
        "none",
        path,
      );
      footerLink.setAttribute("data-test-hover", "");
      assert.equal(
        getComputedStyle(footerLink).textDecorationLine,
        "underline",
        path,
      );
    }
  });
});

test("county hero links and cards share the homepage hover and focus treatment", async () => {
  await withPreview("fictional", async (preview) => {
    const css = (await get(preview, "/assets/site.css")).text
      .replaceAll(":hover", "[data-test-hover]")
      .replaceAll(":focus-visible", "[data-test-focus]");
    for (const [path, cardSelector, cardCount] of [
      ["/", ".discovery-card", 4],
      ["/counties/08081", ".county-entry-card", 2],
    ]) {
      const page = await get(preview, path);
      const style = page.document.createElement("style");
      style.textContent = css;
      page.document.head.append(style);
      const { getComputedStyle } = page.document.defaultView;
      const heroLinks = page.$$(".hero-actions a.button");
      const cards = page.$$(cardSelector);
      assert.equal(heroLinks.length, 2, path);
      assert.equal(cards.length, cardCount, path);
      for (const card of cards)
        assert.equal(getComputedStyle(card).borderRadius, "4px", path);
      for (const link of [...heroLinks, ...cards]) {
        for (const state of ["data-test-hover", "data-test-focus"]) {
          link.setAttribute(state, "");
          const hovered = getComputedStyle(link);
          assert.equal(hovered.backgroundColor, "rgb(23, 23, 23)", path);
          assert.equal(hovered.color, "rgb(255, 255, 255)", path);
          assert.equal(hovered.outline, "1px solid rgb(255, 255, 255)", path);
          assert.equal(hovered.outlineOffset, "-1px", path);
          assert.equal(hovered.textDecorationLine, "none", path);
          for (const text of link.querySelectorAll("h3, p, span")) {
            assert.equal(
              getComputedStyle(text).color,
              "rgb(255, 255, 255)",
              path,
            );
            assert.equal(
              getComputedStyle(text).textDecorationLine,
              "none",
              path,
            );
          }
          link.removeAttribute(state);
        }
      }
    }
  });
});

test("homepage on an empty database stays useful and claims nothing", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/");
    assert.equal(page.status, 200);
    assert.equal(page.$(".preview-notice"), null);
    assert.equal(page.$$(".discovery-card").length, 4);
    assert.equal(page.$$(".article-card").length, 0);
    assert.deepEqual(
      page.$$(".stat-row dd").map((value) => value.textContent),
      ["64", "0", "0", "—", "—"],
    );
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
      assert.deepEqual(
        county.$$(".stat-row dd").map((d) => d.textContent),
        ["0", "0", "—", "—"],
      );
      assert.match(county.main(), /not the county's government/);
    }
    assert.ok(page.$("#county-directory > .county-index-grid"));
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

test("the complete alphabetical grid stays in front of changing county results", async () => {
  await withPreview("empty", async (preview) => {
    const directory = await get(preview, "/counties");
    const filtered = await get(preview, "/counties?q=e");
    const entries = (page, selector) =>
      page
        .$$(selector)
        .map((link) => [
          link.getAttribute("href"),
          link.querySelector(".cell-name").firstChild.textContent,
          link.querySelector(".cell-code").textContent,
        ]);
    const expected = entries(
      directory,
      "#county-directory .county-index-grid a",
    );
    assert.equal(expected.length, 64);
    const names = expected.map(([, name]) => name);
    assert.deepEqual(
      names,
      [...names].sort((left, right) => left.localeCompare(right, "en")),
    );
    assert.deepEqual(
      expected.map(([, name]) => name).filter((name) => name.startsWith("E")),
      ["Eagle", "El Paso", "Elbert"],
    );
    const noMatches = await get(preview, "/counties?q=zzzz");
    for (const page of [directory, filtered, noMatches]) {
      assert.deepEqual(
        entries(page, "#county-directory .county-index-grid a"),
        expected,
      );
      assert.equal(page.$$("#county-directory [hidden]").length, 0);
      assert.equal(
        page.$(".page-header").nextElementSibling.className,
        "county-browse",
      );
      assert.equal(
        page.$(".county-browse").nextElementSibling.className,
        "county-map-figure",
      );
      assert.ok(
        page
          .$("#county-directory")
          .compareDocumentPosition(page.$("[data-county-empty]")) & 4,
      );
      assert.ok(
        page
          .$("#county-directory")
          .compareDocumentPosition(page.$("[data-county-results]")) & 4,
      );
    }
  });
});

test("county home links to the directory and County Structure without duplicating their lists", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/counties/08001");
    assert.equal(page.status, 200);
    assert.equal(page.$("h1").textContent, "Adams County");
    assert.match(
      page.$(".hero").textContent,
      /County government. Community experiences. One lasting record./,
    );
    assert.ok(page.$(".hero [data-banner-frame] .banner-placeholder"));
    assert.equal(page.$("[data-banner-frame] img"), null);
    assert.deepEqual(
      page.$$(".county-nav ul a").map((a) => a.getAttribute("href")),
      ["/counties/08001", "/officials?county=08001", "/stories?county=08001"],
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
      "Departments and offices": "0",
      "County officials and employees": "36",
      Reports: "—",
      Grievances: "—",
    });
    assert.match(
      page.main(),
      /County directory eligibility does not require a unit attachment/,
    );

    assert.equal(page.$("#organizations"), null);
    assert.equal(page.$("#roles"), null);
    assert.ok(page.$("#structure"));
    assert.ok(page.$('.county-entry-card[href="/officials?county=08001"]'));
    assert.ok(page.$('.county-entry-card[href="/counties/08001#structure"]'));
    const bookmark = await get(
      preview,
      "/counties/08001?orgAfter=old-office&roleAfter=old-role",
    );
    assert.equal(bookmark.status, 200);
    assert.equal(bookmark.$("h1").textContent, "Adams County");
    assert.equal(bookmark.$("#organizations"), null);
    assert.equal(bookmark.$("#roles"), null);
  });
});

test("editorial templates show only injected fixtures and never database drafts", async () => {
  await withPreview("fictional", async (preview) => {
    const stories = await get(preview, "/stories");
    assert.equal(stories.$("body.home-page"), null);
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

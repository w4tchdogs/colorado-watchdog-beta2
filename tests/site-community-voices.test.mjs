import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createServices } from "../dist/services/index.js";
import {
  articleTags,
  filterArticles,
  PATHWAYS,
  parseEditorialFilters,
} from "../dist/site/community-voices.js";
import { emptyEditorialSource } from "../dist/site/editorial-source.js";
import { createPublicSite } from "../dist/site/index.js";
import {
  FIXED_NOW,
  get,
  STATIC_DIRECTORY,
  siteAssets,
  withPreview,
} from "./site-fixtures.mjs";

const slugs = (page) =>
  page
    .$$(".article-card-title a")
    .map((a) => a.getAttribute("href").split("/").at(-1));
const count = (page) => page.$(".cv-count")?.textContent.trim();

test("three pathway cards use verified Beta-1 labels and valid destinations", async () => {
  await withPreview("fictional", async (preview) => {
    for (const [base, plural] of [
      ["/stories", "Stories"],
      ["/posts", "Posts"],
    ]) {
      const page = await get(preview, base);
      const cards = page.$$(".cv-pathway");
      assert.equal(cards.length, 3);
      assert.deepEqual(
        cards.map((c) => c.querySelector(".cv-pathway-title").textContent),
        ["Local series", "Guest Voices", "Statewide County Issues"],
      );
      assert.deepEqual(
        cards.map((c) => c.querySelector(".cv-pathway-eyebrow").textContent),
        ["01 · Local series", "02 · Your perspective", "03 · Across Colorado"],
      );
      assert.match(
        cards[1].querySelector(".cv-pathway-description").textContent,
        /^Full stories from people navigating county government\.$/,
      );
      const links = cards.map((c) => c.querySelector("a.cv-pathway-link"));
      assert.deepEqual(
        links.map((a) => a.getAttribute("href")),
        PATHWAYS.map((p) => `${base}?pathway=${p.slug}#cv-results`),
      );
      assert.ok(links[0].textContent.includes(`in ${plural}`));
      // Cards never carry counts or imply content.
      assert.doesNotMatch(
        page.$(".cv-pathway-grid").textContent,
        /\d+ (articles?|stories|posts)/i,
      );
      // Beta-1 promises that Beta-2 cannot keep are not carried over.
      assert.doesNotMatch(
        page.$(".cv-pathways").textContent,
        /Share a story|every two weeks|Idlewild/i,
      );
      for (const a of links) {
        assert.equal(
          (await get(preview, a.getAttribute("href").split("#")[0])).status,
          200,
        );
      }
    }
    const active = await get(preview, "/stories?pathway=guest-voices");
    assert.equal(active.$$('.cv-pathway-link[aria-current="true"]').length, 1);
    assert.ok(
      active.$(".cv-pathway-active .cv-pathway-title").textContent ===
        "Guest Voices",
    );
  });
});

test("stories and posts keep their routes and switch with filters preserved", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(
      preview,
      "/stories?county=08001&pathway=local-series",
    );
    const links = page.$$(".cv-types a");
    assert.deepEqual(
      links.map((a) => [a.textContent, a.getAttribute("href")]),
      [
        ["Stories", "/stories?county=08001&pathway=local-series"],
        ["Posts", "/posts?county=08001&pathway=local-series"],
      ],
    );
    assert.equal(links[0].getAttribute("aria-current"), "page");
    assert.equal(links[1].getAttribute("aria-current"), null);
    const posts = await get(preview, links[1].getAttribute("href"));
    assert.equal(posts.status, 200);
    assert.deepEqual(slugs(posts), ["fictional-new-county-added"]);
    assert.ok(
      (await get(preview, "/stories/fictional-road-budget-review")).$(
        ".article",
      ),
    );
  });
});

test("filters apply to the whole collection with stable order and accurate counts", async () => {
  await withPreview("fictional", async (preview) => {
    const all = await get(preview, "/stories");
    assert.deepEqual(slugs(all), [
      "fictional-road-budget-review",
      "fictional-guest-perspective",
      "fictional-health-district-explainer",
    ]);
    assert.equal(count(all), "Showing all 3 stories.");
    const posts = await get(preview, "/posts");
    assert.deepEqual(slugs(posts), [
      "fictional-directory-update",
      "fictional-guest-note",
      "fictional-new-county-added",
      "fictional-source-note",
    ]);
    assert.equal(count(posts), "Showing all 4 posts.");

    const cases = [
      ["/stories?pathway=local-series", ["fictional-road-budget-review"]],
      ["/stories?pathway=guest-voices", ["fictional-guest-perspective"]],
      [
        "/stories?pathway=statewide-issues",
        ["fictional-health-district-explainer"],
      ],
      ["/stories?county=08069", ["fictional-health-district-explainer"]],
      ["/stories?county=08013", ["fictional-guest-perspective"]],
      [
        "/stories?county=08001",
        ["fictional-road-budget-review", "fictional-health-district-explainer"],
      ],
      [
        "/stories?series=fictional-roads-series",
        ["fictional-road-budget-review"],
      ],
      [
        "/stories?topic=regional-districts",
        ["fictional-health-district-explainer"],
      ],
      [
        "/stories?county=08001&pathway=local-series",
        ["fictional-road-budget-review"],
      ],
      [
        "/stories?county=08001&pathway=local-series&series=fictional-roads-series&topic=county-budgets",
        ["fictional-road-budget-review"],
      ],
      ["/posts?pathway=local-series", ["fictional-new-county-added"]],
      ["/posts?pathway=guest-voices", ["fictional-guest-note"]],
      ["/posts?county=08031", ["fictional-guest-note"]],
      ["/posts?topic=county-budgets", ["fictional-new-county-added"]],
      ["/posts?pathway=statewide-issues", []],
    ];
    for (const [path, expected] of cases) {
      const page = await get(preview, path);
      assert.equal(page.status, 200, path);
      assert.deepEqual(slugs(page), expected, path);
      const total = path.startsWith("/stories") ? 3 : 4;
      assert.match(
        count(page),
        new RegExp(
          `^${expected.length} of ${total} (stories|posts) match(es)? the selected filters\\.$`,
        ),
        path,
      );
    }
    assert.equal(
      count(await get(preview, "/stories?pathway=guest-voices")),
      "1 of 3 stories matches the selected filters.",
    );
  });
});

test("unclassified articles are never assigned to a pathway, series or topic", async () => {
  await withPreview("fictional", async (preview) => {
    for (const path of [
      "/posts?pathway=local-series",
      "/posts?pathway=guest-voices",
      "/posts?series=fictional-roads-series",
      "/posts?topic=regional-districts",
    ]) {
      const page = await get(preview, path);
      assert.ok(
        !slugs(page).includes("fictional-directory-update") &&
          !slugs(page).includes("fictional-source-note"),
        path,
      );
    }
    const plain = (await get(preview, "/posts"))
      .$$(".article-card")
      .find((c) =>
        c
          .querySelector("a")
          .getAttribute("href")
          .endsWith("fictional-source-note"),
      );
    // Only the county the record explicitly lists is shown.
    assert.deepEqual(
      [...plain.querySelectorAll(".cv-tag")].map((t) => t.textContent),
      ["County: Adams County"],
    );
    const classified = (await get(preview, "/stories"))
      .$$(".article-card")
      .find((c) =>
        c
          .querySelector("a")
          .getAttribute("href")
          .endsWith("fictional-road-budget-review"),
      );
    assert.deepEqual(
      [...classified.querySelectorAll(".cv-tag")].map((t) => t.textContent),
      [
        "Pathway: Local series",
        "Series: Fictional Roads Series",
        "Topic: County budgets",
        "County: Adams County",
      ],
    );
  });
});

test("no-match combinations show an honest empty result and an obvious way out", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(
      preview,
      "/stories?county=08069&pathway=local-series",
    );
    assert.equal(page.status, 200);
    assert.equal(page.$$(".article-card").length, 0);
    assert.equal(count(page), "0 of 3 stories match the selected filters.");
    assert.match(
      page.$(".cv-results .empty-state").textContent,
      /No stories match these filters/,
    );
    assert.ok(page.$('.cv-results .empty-state a[href="/stories"]'));
    assert.ok(page.$('.cv-filters a[href="/stories"]'));
    // Well-formed but unknown series stays selected and matches nothing.
    const unknown = await get(preview, "/stories?series=not-a-series");
    assert.equal(unknown.status, 200);
    assert.equal(unknown.$$(".article-card").length, 0);
    assert.equal(unknown.$("#cv-filter-series").value, "not-a-series");
  });
});

test("filter form is a keyboard-operable GET form reflecting the URL", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(
      preview,
      "/stories?county=08069&pathway=statewide-issues&topic=regional-districts",
    );
    const form = page.$("form.cv-filters");
    assert.equal(form.getAttribute("method"), "get");
    assert.equal(form.getAttribute("action"), "/stories");
    for (const name of ["pathway", "county", "series", "topic"]) {
      const select = page.$(`#cv-filter-${name}`);
      assert.ok(select, name);
      assert.ok(page.$(`label[for="cv-filter-${name}"]`), name);
    }
    assert.equal(page.$("#cv-filter-pathway").value, "statewide-issues");
    assert.equal(page.$("#cv-filter-county").value, "08069");
    assert.equal(page.$("#cv-filter-topic").value, "regional-districts");
    // Options come from the complete collection, not the displayed subset.
    assert.deepEqual(
      [...page.$("#cv-filter-county").options].map((o) => o.value),
      ["", "08001", "08013", "08069"],
    );
    assert.deepEqual(
      [...page.$("#cv-filter-county").options].map((o) => o.textContent),
      ["All counties", "Adams County", "Boulder County", "Larimer County"],
    );
    // Series is disabled-free here because a series exists.
    assert.equal(page.$("#cv-filter-series").disabled, false);
    assert.equal(page.$('button[type="submit"]').textContent, "Filter stories");
    assert.equal(page.$(".cv-filters a.button").textContent, "Clear filters");
    // Works without JavaScript: only the shared enhancement script is loaded and
    // nothing in the filter markup depends on it or on inline handlers.
    assert.equal(page.$$("script").length, 1);
    assert.doesNotMatch(form.outerHTML, /\son[a-z]+=|style=/i);
  });
});

test("invalid, duplicate and unknown parameters are rejected", async () => {
  await withPreview("fictional", async (preview) => {
    for (const path of [
      "/stories?county=99999",
      "/stories?county=08999",
      "/stories?county=abc",
      "/stories?pathway=nope",
      "/stories?pathway=Local-Series",
      "/stories?series=Bad_Slug",
      "/stories?series=-leading",
      `/stories?series=${"a".repeat(61)}`,
      `/posts?topic=${"a".repeat(61)}`,
      "/stories?county=08001&county=08069",
      "/stories?pathway=local-series&pathway=guest-voices",
      `/stories?q=${"x".repeat(201)}`,
      "/posts?type=story",
      "/posts?county=08001&unknown=1",
      "/stories/fictional-road-budget-review?pathway=local-series",
      "/posts/fictional-guest-note?county=08031",
    ]) {
      assert.equal((await get(preview, path)).status, 400, path);
    }
    // Filters stay confined to the editorial listings.
    for (const path of [
      "/people?pathway=local-series",
      "/counties?pathway=local-series",
      "/organizations?county=08001",
      "/?pathway=local-series",
    ]) {
      assert.equal((await get(preview, path)).status, 400, path);
    }
    // Empty values (what the form sends for "All") mean no filter.
    const blank = await get(
      preview,
      "/stories?county=&pathway=&series=&topic=",
    );
    assert.equal(blank.status, 200);
    assert.equal(count(blank), "Showing all 3 stories.");
    // The restart link on the error page leads back to the listing.
    const bad = await get(preview, "/stories?county=99999");
    assert.ok(bad.$('a[href="/stories"]'));
  });
});

test("URL state is stable across reloads", async () => {
  await withPreview("fictional", async (preview) => {
    const path = "/stories?pathway=local-series&county=08001";
    const first = await get(preview, path);
    const second = await get(preview, path);
    assert.equal(first.main(), second.main());
    assert.deepEqual(slugs(first), slugs(second));
  });
});

test("empty production state keeps the shared layout and stays truthful", async () => {
  await withPreview("empty", async (preview) => {
    for (const [base, noun] of [
      ["/stories", "stories"],
      ["/posts", "posts"],
    ]) {
      for (const path of [
        base,
        `${base}?pathway=guest-voices`,
        `${base}?county=08001`,
      ]) {
        const page = await get(preview, path);
        assert.equal(page.status, 200, path);
        assert.equal(page.$$(".cv-pathway").length, 3, path);
        assert.ok(page.$("form.cv-filters"), path);
        assert.equal(page.$$(".cv-types a").length, 2, path);
        assert.equal(page.$$(".article-card").length, 0, path);
        assert.match(
          page.$(".cv-results .empty-state").textContent,
          new RegExp(`No ${noun} yet`),
          path,
        );
        // No count is invented when nothing is published.
        assert.equal(page.$(".cv-count"), null, path);
        assert.doesNotMatch(
          page.text,
          /Fictional (story|post)|fictional demonstration/,
          path,
        );
      }
    }
    const page = await get(preview, "/stories");
    // Controls without any real options are disabled and say why.
    for (const name of ["county", "series", "topic"]) {
      assert.equal(page.$(`#cv-filter-${name}`).disabled, true, name);
      assert.ok(
        page.$(`#cv-filter-${name}-note`).textContent.length > 10,
        name,
      );
    }
    assert.equal(page.$("#cv-filter-pathway").disabled, false);
  });
});

test("the production site never carries preview fixtures or reads drafts", () => {
  assert.deepEqual(emptyEditorialSource.list("story"), []);
  assert.deepEqual(emptyEditorialSource.list("post"), []);
  assert.equal(
    emptyEditorialSource.get("story", "fictional-guest-perspective"),
    null,
  );
  const worker = readFileSync(
    new URL("../dist/server/index.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    worker,
    /fictional-guest-perspective|fictional-road-budget-review/,
  );
  const source = readFileSync(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /fictionalEditorialSource|preview-data/);
});

test("filtering and tagging never trust metadata and always escape", async () => {
  const hostile = {
    type: "story",
    slug: "hostile",
    title: "<b>Title</b>",
    summary: "s",
    date: "2026-02-01",
    byline: "b",
    fictional: true,
    body: [],
    related: {
      counties: [{ fips: "08001", name: "<i>Adams</i>" }],
      people: [],
      organizations: [],
    },
    sources: [],
    pathway: "guest-voices",
    series: { slug: "ok-series", label: "<script>alert(1)</script>" },
    topics: [
      { slug: "Bad Slug", label: "dropped" },
      { slug: "good-topic", label: '"><img src=x onerror=1>' },
    ],
  };
  const markup = articleTags(hostile).toString();
  assert.doesNotMatch(markup, /<script|<img|<i>|dropped/);
  assert.match(markup, /&lt;script&gt;/);
  assert.deepEqual(filterArticles([hostile], { topic: "bad-slug" }), []);
  assert.equal(filterArticles([hostile], { topic: "good-topic" }).length, 1);

  const database = await openWebsiteDatabase(":memory:");
  migrateWebsiteDatabase(database);
  try {
    const site = createPublicSite({
      services: createServices({ database }),
      assets: siteAssets(),
      now: FIXED_NOW,
      editorial: {
        list: (type) => (type === "story" ? [hostile] : []),
        get: () => null,
      },
    });
    const page = await get(site, "/stories?pathway=guest-voices");
    assert.equal(page.status, 200);
    assert.equal(page.$$(".article-card").length, 1);
    assert.equal(page.$$("script:not([src])").length, 0);
    assert.equal(
      page.$$("img").filter((i) => i.getAttribute("onerror")).length,
      0,
    );
    assert.match(
      page.$("#cv-filter-series option:last-child").textContent,
      /<script>/,
    );
    // A published production source gets the same layout and no preview notice.
    assert.equal(page.$(".preview-notice"), null);
  } finally {
    database.close();
  }
});

test("parser rejects malformed values and keeps only supplied ones", () => {
  const parse = (query) => parseEditorialFilters(new URLSearchParams(query));
  assert.deepEqual(parse(""), {});
  assert.deepEqual(parse("county=08001&topic=a-b"), {
    county: "08001",
    topic: "a-b",
  });
  assert.equal(parse("county=09001"), null);
  assert.equal(parse("pathway=other"), null);
  assert.equal(parse("series=A"), null);
  assert.equal(parse("topic=a--b"), null);
});

test("stylesheet is namespaced, allowlisted, bundled and CSP-safe", async () => {
  await withPreview("fictional", async (preview) => {
    const css = await get(preview, "/assets/community-voices.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.match(
      css.headers.get("content-security-policy"),
      /style-src 'self'/,
    );
    const page = await get(preview, "/stories");
    assert.deepEqual(
      page.$$('link[rel="stylesheet"]').map((l) => l.getAttribute("href")),
      ["/assets/site.css", "/assets/community-voices.css"],
    );
    assert.equal(page.$$("[style]").length, 0);
    assert.equal(page.$$("style").length, 0);
    const home = await get(preview, "/");
    assert.deepEqual(
      home
        .$$('link[rel="stylesheet"]')
        .map((link) => link.getAttribute("href")),
      ["/assets/site.css", "/assets/community-voices.css"],
    );
    assert.equal(
      home.$$('link[href="/assets/community-voices.css"]').length,
      1,
    );
    assert.equal(home.$$("[style]").length, 0);
    assert.equal(home.$$("style").length, 0);
    // Other unrelated pages do not load the stylesheet.
    for (const path of ["/about", "/counties"]) {
      assert.doesNotMatch(
        (await get(preview, path)).text,
        /community-voices\.css/,
        path,
      );
    }
    for (const path of ["/posts"]) {
      const page = await get(preview, path);
      assert.deepEqual(
        page
          .$$('link[rel="stylesheet"]')
          .map((link) => link.getAttribute("href")),
        ["/assets/site.css", "/assets/community-voices.css"],
      );
    }
    assert.equal(
      (await get(preview, "/assets/community-voices.css.map")).status,
      404,
    );
  });
  const source = readFileSync(
    `${STATIC_DIRECTORY}community-voices.css`,
    "utf8",
  );
  // Every selector is namespaced so it cannot collide with concurrent site.css work.
  const selectors = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]*\{/g, "")
    .match(/[^{}]+(?=\{)/g)
    .flatMap((group) => group.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(selectors.length > 20);
  for (const selector of selectors) {
    assert.match(selector, /^\.cv-/, selector);
  }
  // Responsive layout: one column by default, three on wider screens, and
  // filter fields that wrap rather than overflow.
  assert.match(
    source,
    /\.cv-pathway-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
  );
  assert.match(
    source,
    /@media \(min-width: 46rem\)[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    source,
    /repeat\(auto-fit, minmax\(min\(100%, 12\.5rem\), 1fr\)\)/,
  );
  assert.doesNotMatch(source, /@import|url\(|!important/);
  const component = readFileSync(
    new URL("../src/site/community-voices.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /WRAPPED_ARROW = trusted\('<span aria-hidden="true">&nbsp;→<\/span>'\)/,
  );
  const build = readFileSync(
    new URL("../scripts/build-sites-worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(build, /community-voices\\\.css/);
  const worker = readFileSync(
    new URL("../dist/server/index.js", import.meta.url),
    "utf8",
  );
  assert.ok(worker.includes('"community-voices.css"'));
});

test("Stories and Posts search published presentation text with combined filters", async () => {
  await withPreview("fictional", async (preview) => {
    const title = await get(preview, "/stories?q=%20ROAD%20BUDGET%20");
    assert.deepEqual(slugs(title), ["fictional-road-budget-review"]);
    assert.equal(count(title), "1 story matches “ROAD BUDGET”.");
    assert.equal(title.$("#cv-filter-q").value, "ROAD BUDGET");

    const body = await get(preview, "/stories?q=absence%20from%20a%20record");
    assert.deepEqual(slugs(body), ["fictional-road-budget-review"]);
    const summary = await get(preview, "/stories?q=regional%20organization");
    assert.deepEqual(slugs(summary), ["fictional-health-district-explainer"]);
    const sourceTitle = await get(
      preview,
      "/stories?q=board%20meeting%20minutes",
    );
    assert.deepEqual(slugs(sourceTitle), ["fictional-road-budget-review"]);

    const combined = await get(
      preview,
      "/stories?county=08001&pathway=local-series&series=fictional-roads-series&topic=county-budgets&q=road",
    );
    assert.deepEqual(slugs(combined), ["fictional-road-budget-review"]);
    const narrowed = await get(preview, "/stories?county=08069&q=road");
    assert.deepEqual(slugs(narrowed), []);
    assert.match(
      narrowed.$(".empty-state").textContent,
      /No published stories match “road”/,
    );
    assert.equal(narrowed.$(".cv-count").getAttribute("role"), "status");

    const posts = await get(preview, "/posts?q=records%20added");
    assert.deepEqual(slugs(posts), ["fictional-new-county-added"]);
    assert.equal(count(posts), "1 post matches “records added”.");
    const noCrossType = await get(preview, "/posts?q=regional%20organization");
    assert.deepEqual(slugs(noCrossType), []);

    const typeLink = combined.$('.cv-types a[href^="/posts"]');
    assert.ok(typeLink.getAttribute("href").includes("q=road"));
    const pathwayLink = combined.$(".cv-pathway-link");
    assert.ok(pathwayLink.getAttribute("href").includes("q=road"));
  });
});

test("search normalization, literal Unicode and duplicate results are safe", async () => {
  const article = {
    type: "story",
    slug: "unicode-story",
    title: "Café: roads & records",
    summary: "Public summary",
    date: "2026-02-01",
    byline: "Public byline",
    fictional: true,
    body: [{ kind: "paragraph", text: "Body-only searchable phrase." }],
    related: { counties: [], people: [], organizations: [] },
    sources: [],
  };
  assert.deepEqual(filterArticles([article, article], { q: "CAFÉ: ROADS" }), [
    article,
  ]);
  assert.deepEqual(filterArticles([article], { q: "cafe\u0301: roads" }), [
    article,
  ]);
  assert.deepEqual(filterArticles([article], { q: "summary" }), [article]);
  assert.deepEqual(filterArticles([article], { q: "body-only" }), [article]);
  assert.deepEqual(filterArticles([article], { q: "roads & records" }), [
    article,
  ]);
  assert.equal(
    parseEditorialFilters(new URLSearchParams("q=%20%20"))?.q,
    undefined,
  );
  assert.equal(
    parseEditorialFilters(new URLSearchParams(`q=${"x".repeat(201)}`)),
    null,
  );

  await withPreview("fictional", async (preview) => {
    const page = await get(
      preview,
      "/stories?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    );
    assert.equal(page.status, 200);
    assert.equal(page.$("#cv-filter-q").value, "<script>alert(1)</script>");
    assert.doesNotMatch(page.$("#cv-filter-q").outerHTML, /<script>/);
    assert.deepEqual(slugs(await get(preview, "/stories?q=%20%20")), [
      "fictional-road-budget-review",
      "fictional-guest-perspective",
      "fictional-health-district-explainer",
    ]);
    const queryPlusFilter = await get(preview, "/stories?county=08001&q=road");
    const clearSearch = queryPlusFilter.$(
      '.cv-filter-actions a[href*="county="]',
    );
    assert.equal(clearSearch.textContent, "Clear search");
    assert.equal(
      clearSearch.getAttribute("href"),
      "/stories?county=08001#cv-results",
    );
    assert.equal(
      queryPlusFilter.$("#cv-filter-q").getAttribute("maxlength"),
      "200",
    );
    assert.equal(
      queryPlusFilter.$("#cv-filter-q").getAttribute("type"),
      "search",
    );
    assert.ok(queryPlusFilter.$('label[for="cv-filter-q"]'));
    assert.equal(
      queryPlusFilter.$("form.cv-filters").getAttribute("method"),
      "get",
    );
  });
});

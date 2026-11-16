import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { countiesPage, sortCounties } from "../dist/site/pages/counties.js";
import {
  get,
  ORIGIN,
  STATIC_DIRECTORY,
  withPreview,
} from "./site-fixtures.mjs";

const SITE_JS = readFileSync(`${STATIC_DIRECTORY}site.js`, "utf8");

// Synthetic aggregate counts keyed by county name. Real aggregate wiring is
// separate work (STATS-1), so nothing here comes from real records.
const SYNTHETIC = {
  Douglas: { profiles: 7, reports: 2, grievances: 0 },
  "El Paso": { profiles: 30, reports: 2, grievances: 4 },
  "Las Animas": { profiles: null, reports: 5, grievances: 0 },
  Washington: { profiles: 7, reports: null, grievances: null },
};

function registryWithCounts(preview) {
  return preview.database
    .prepare("SELECT fips, name FROM counties ORDER BY fips")
    .all()
    .map((row) => {
      const key = row.name.replace(/ County$/i, "");
      return SYNTHETIC[key] ? { ...row, counts: SYNTHETIC[key] } : { ...row };
    });
}

/** Renders the real page body for a registry, optionally running site.js. */
async function load(counties, search = "", { script = true } = {}) {
  const parameters = new URLSearchParams(search);
  const page = await countiesPage(
    { services: { listCounties: async () => counties } },
    parameters.get("q") ?? "",
  );
  const dom = new JSDOM(
    `<!doctype html><html><body><main>${page.body}</main></body></html>`,
    {
      url: `${ORIGIN}/counties${search ? `?${search}` : ""}`,
      runScripts: "outside-only",
    },
  );
  if (script) dom.window.eval(SITE_JS);
  const { document } = dom.window;
  return {
    window: dom.window,
    document,
    $: (selector) => document.querySelector(selector),
    $$: (selector) => [...document.querySelectorAll(selector)],
    type(value) {
      const input = document.querySelector("[data-county-filter]");
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    },
    rows: () =>
      [...document.querySelectorAll("[data-result-row]")]
        .filter((row) => !row.hidden)
        .map((row) => row.querySelector(".county-name-link").textContent),
    links: () =>
      [
        ...document.querySelectorAll(
          "[data-result-row]:not([hidden]) .county-name-link",
        ),
      ].map((link) => link.getAttribute("href")),
    status: () => document.querySelector(".county-map-status")?.textContent,
    note: () => document.querySelector("[data-county-note]").textContent,
    results: () => document.querySelector("[data-county-results]"),
    empty: () => document.querySelector("[data-county-empty]"),
    matched: () =>
      [...document.querySelectorAll("[data-map-county].is-match")]
        .map((link) => link.dataset.fips)
        .sort(),
    visibleFips: () =>
      [...document.querySelectorAll("[data-result-row]")]
        .filter((row) => !row.hidden)
        .map((row) => row.dataset.fips)
        .sort(),
    sortState: () =>
      Object.fromEntries(
        [...document.querySelectorAll("th[data-sort-key]")].map((th) => [
          th.dataset.sortKey,
          th.getAttribute("aria-sort"),
        ]),
      ),
  };
}

const AS_COUNTIES = [
  "Douglas County",
  "El Paso County",
  "Las Animas County",
  "Washington County",
];
const AS_FIPS = ["08035", "08041", "08071", "08121"];

function assertIdle(view) {
  assert.equal(view.status(), "Choose a county");
  assert.equal(
    view.note(),
    "Type a county name or FIPS code to see matching counties.",
  );
  assert.equal(view.results().hidden, true);
  assert.equal(view.empty().hidden, true);
  assert.deepEqual(view.matched(), []);
  assert.deepEqual(view.rows(), []);
}

test("empty and whitespace-only searches show the idle labels and no results table", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    assertIdle(await load(counties));
    assertIdle(await load(counties, "q=%20%20%20"));
    assertIdle(await load(counties, "q=", { script: false }));
    assertIdle(await load(counties, "q=%20%20", { script: false }));
  });
});

test("searching as finds Douglas, El Paso, Las Animas and Washington", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    for (const script of [false, true]) {
      const view = await load(counties, "q=as", { script });
      assert.equal(view.status(), "4 matching counties");
      assert.equal(view.note(), "4 counties match");
      assert.equal(view.results().hidden, false);
      assert.equal(view.empty().hidden, true);
      assert.deepEqual(view.rows(), AS_COUNTIES);
      assert.deepEqual(view.visibleFips(), AS_FIPS);
      assert.deepEqual(view.matched(), AS_FIPS);
      assert.equal(view.$("[data-county-filter]").value, "as");
    }
    const live = await load(counties);
    live.type("as");
    assert.equal(live.status(), "4 matching counties");
    assert.equal(live.note(), "4 counties match");
    assert.deepEqual(live.rows(), AS_COUNTIES);
    assert.deepEqual(live.matched(), AS_FIPS);
    assert.equal(live.window.location.search, "?q=as");
  });
});

test("a full FIPS code matches exactly one county with singular labels", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    for (const script of [false, true]) {
      const view = await load(counties, "q=08065", { script });
      assert.equal(view.status(), "1 matching county");
      assert.equal(view.note(), "1 county matches");
      assert.deepEqual(view.rows(), ["Lake County"]);
      assert.deepEqual(view.matched(), ["08065"]);
    }
    const live = await load(counties);
    live.type("08067");
    assert.deepEqual(live.rows(), ["La Plata County"]);
    assert.equal(live.status(), "1 matching county");
  });
});

test("zero matches show explicit zero counts and an empty state, not a table", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    for (const script of [false, true]) {
      const view = await load(counties, "q=zzzz", { script });
      assert.equal(view.status(), "0 matching counties");
      assert.equal(view.note(), "0 counties match");
      assert.equal(view.results().hidden, true);
      assert.equal(view.empty().hidden, false);
      assert.match(view.empty().textContent, /No county matches that search/);
      assert.deepEqual(view.matched(), []);
    }
  });
});

test("clearing the field or typing only spaces restores the idle state", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview));
    live.type("as");
    live.type("");
    assertIdle(live);
    assert.equal(live.window.location.search, "");
    live.type("as");
    live.type("   ");
    assertIdle(live);
    assert.equal(live.window.location.search, "");
    live.type("zzzz");
    live.type("");
    assertIdle(live);
  });
});

test("typing keeps spaces so multi-word names can be entered", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview));
    live.type("la ");
    assert.equal(live.$("[data-county-filter]").value, "la ");
    live.type("la p");
    assert.deepEqual(live.rows(), ["La Plata County"]);
    assert.equal(live.window.location.search, "?q=la+p");
  });
});

test("direct links, URL state and history stay aligned", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview), "q=as");
    assert.equal(live.window.location.search, "?q=as");
    assert.deepEqual(live.rows(), AS_COUNTIES);
    live.type("08111");
    assert.equal(live.window.location.search, "?q=08111");
    assert.deepEqual(live.matched(), ["08111"]);
    live.window.history.pushState({}, "", "/counties?q=08113");
    live.window.dispatchEvent(new live.window.PopStateEvent("popstate"));
    assert.equal(live.$("[data-county-filter]").value, "08113");
    assert.deepEqual(live.matched(), ["08113"]);
    live.window.history.pushState({}, "", "/counties");
    live.window.dispatchEvent(new live.window.PopStateEvent("popstate"));
    assertIdle(live);
  });
});

test("typing, a direct link and native Enter give the same links and count", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    const snapshot = (view) => ({
      fips: view.visibleFips(),
      links: view.links(),
      status: view.status(),
      note: view.note(),
      matched: view.matched(),
    });
    for (const query of [
      "as",
      "  as  ",
      "AS",
      "08035",
      " 08035",
      "zzzz",
      "la p",
    ]) {
      const live = await load(counties);
      live.type(query);
      // Native Enter submits the form as a GET with the field value.
      const form = live.$('form[action="/counties"]');
      assert.equal(form.getAttribute("method"), "get");
      const enter = new URLSearchParams({
        [form.querySelector("input").name]: live.$("[data-county-filter]")
          .value,
      });
      const submitted = await load(counties, enter.toString(), {
        script: false,
      });
      assert.deepEqual(
        snapshot(submitted),
        snapshot(live),
        `query ${JSON.stringify(query)}`,
      );
      assert.deepEqual(submitted.matched(), submitted.visibleFips());
    }
  });
});

test("map highlights always equal the result rows, even for words in the map labels", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    for (const query of [
      "fips",
      "county",
      "·",
      "08",
      "as",
      "a",
      "zzzz",
      "0803",
    ]) {
      const server = await load(counties, `q=${encodeURIComponent(query)}`, {
        script: false,
      });
      assert.deepEqual(
        server.matched(),
        server.visibleFips(),
        `server ${query}`,
      );
      const live = await load(counties);
      live.type(query);
      assert.deepEqual(live.matched(), live.visibleFips(), `typed ${query}`);
      assert.deepEqual(
        live.visibleFips(),
        server.visibleFips(),
        `same ${query}`,
      );
    }
    const none = await load(counties);
    none.type("fips");
    assert.equal(none.status(), "0 matching counties");
  });
});

test("search text is escaped and never run as markup", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview));
    live.type('<img src=x>&q="other"');
    assert.equal(live.$("[data-county-note] img"), null);
    assert.equal(live.$("main img"), null);
    assert.equal(live.note(), "0 counties match");
    const view = await load(
      registryWithCounts(preview),
      `q=${encodeURIComponent("<img src=x>")}`,
      { script: false },
    );
    assert.equal(view.$("main img"), null);
    assert.equal(view.note(), "0 counties match");
  });
});

test("map hover and focus show the county, then restore the count", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview));
    live.type("as");
    const region = live.$$("[data-map-county].is-match")[0];
    region.dispatchEvent(new live.window.Event("pointerenter"));
    assert.match(live.status(), /County · FIPS \d{5}\. Select to open/);
    assert.equal(
      live
        .$(`[data-result-row][data-fips="${region.dataset.fips}"]`)
        .classList.contains("is-active"),
      true,
    );
    region.dispatchEvent(new live.window.Event("pointerleave"));
    assert.equal(live.status(), "4 matching counties");
    region.dispatchEvent(
      new live.window.FocusEvent("focusin", { bubbles: true }),
    );
    assert.match(live.status(), /Press Enter to open/);
    region.dispatchEvent(
      new live.window.FocusEvent("focusout", { bubbles: true }),
    );
    assert.equal(live.status(), "4 matching counties");
    live.type("");
    region.dispatchEvent(new live.window.Event("pointerenter"));
    region.dispatchEvent(new live.window.Event("pointerleave"));
    assert.equal(live.status(), "Choose a county");
  });
});

test("only the count beside the search is announced", async () => {
  await withPreview("empty", async (preview) => {
    const view = await load(registryWithCounts(preview), "", {
      script: false,
    });
    const statusRegions = view.$$("main [role=status], main [aria-live]");
    assert.deepEqual(
      statusRegions.map((element) => element.hasAttribute("data-county-note")),
      [true],
    );
    assert.equal(view.$(".county-map-status").hasAttribute("role"), false);
    assert.equal(view.$(".county-map-status").hasAttribute("aria-live"), false);
  });
});

test("the visible Filter button is gone and Enter still submits without JavaScript", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/counties?q=as");
    const form = page.$('form[action="/counties"]');
    assert.equal(form.getAttribute("method"), "get");
    assert.equal(form.querySelectorAll("input").length, 1);
    assert.equal(
      form.querySelectorAll('button, input[type="submit"]').length,
      0,
    );
    assert.equal(form.querySelector("input").name, "q");
    assert.equal(form.querySelector("input").value, "as");
    const visible = page
      .$$("[data-result-row]")
      .filter((row) => !row.hidden)
      .map((row) => row.querySelector(".county-name-link").textContent);
    assert.deepEqual(visible, AS_COUNTIES);
    assert.equal(page.$("[data-county-results]").hidden, false);
    assert.equal(page.$("[data-county-note]").textContent, "4 counties match");
  });
});

test("without JavaScript the headings are plain text and rows are County A to Z", async () => {
  await withPreview("empty", async (preview) => {
    const view = await load(registryWithCounts(preview), "q=as", {
      script: false,
    });
    assert.deepEqual(
      view.$$("thead th[data-sort-key]").map((th) => th.textContent),
      ["County", "Listed Profiles", "Reports", "Grievances"],
    );
    assert.equal(view.$$("thead a, thead button").length, 0);
    assert.equal(view.$$("th[aria-sort]").length, 0);
    assert.deepEqual(view.rows(), AS_COUNTIES);
    assert.deepEqual(
      view.links(),
      AS_FIPS.map((fips) => `/counties/${fips}`),
    );
    assert.equal(view.$$("[data-sort-select-wrap]:not([hidden])").length, 0);
  });
});

test("with JavaScript the headings gain sort buttons and arrows", async () => {
  await withPreview("empty", async (preview) => {
    const view = await load(registryWithCounts(preview), "q=as");
    assert.deepEqual(
      view.$$("th .county-sort-button").map((button) => button.textContent),
      ["County", "Listed Profiles", "Reports", "Grievances"],
    );
    assert.equal(view.$$("th .county-sort-arrow").length, 4);
    assert.deepEqual(view.sortState(), {
      county: "ascending",
      profiles: "none",
      reports: "none",
      grievances: "none",
    });
  });
});

test("results rows have real links, one tab stop and a decorative arrow", async () => {
  await withPreview("empty", async (preview) => {
    const view = await load(registryWithCounts(preview), "q=as");
    for (const row of view.$$("[data-result-row]")) {
      const link = row.querySelector(".county-name-link");
      assert.equal(link.getAttribute("href"), `/counties/${row.dataset.fips}`);
      assert.equal(
        row.querySelectorAll(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ).length,
        1,
      );
      assert.equal(
        row.querySelector(".county-row-arrow").getAttribute("aria-hidden"),
        "true",
      );
    }
  });
});

test("clicking anywhere in a row opens its county link", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview), "q=as");
    const row = live.$('[data-result-row][data-fips="08035"]');
    assert.ok(row);
    const link = row.querySelector(".county-name-link");
    const clicks = [];
    link.addEventListener("click", (event) => {
      event.preventDefault();
      clicks.push(link.getAttribute("href"));
    });
    row
      .querySelector(".county-row-arrow")
      .dispatchEvent(new live.window.MouseEvent("click", { bubbles: true }));
    row
      .querySelector('[data-label="Reports"]')
      .dispatchEvent(new live.window.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(clicks, ["/counties/08035", "/counties/08035"]);
    link.dispatchEvent(new live.window.MouseEvent("click", { bubbles: true }));
    assert.equal(clicks.length, 3);
  });
});

test("browse all and the skip link stay available during searches, at zero matches and without the map", async () => {
  await withPreview("empty", async (preview) => {
    const counties = registryWithCounts(preview);
    for (const search of ["", "q=as", "q=zzzz", "q=%20%20"]) {
      const view = await load(counties, search, { script: false });
      const browse = view.$(".county-browse-all");
      assert.equal(browse.getAttribute("href"), "#county-directory");
      assert.equal(browse.textContent, "Browse all 64 counties");
      const skip = view.$(".county-map-skip");
      assert.equal(skip.getAttribute("href"), "#county-directory");
      assert.ok(view.$("#county-directory"));
      assert.equal(view.$$("#county-directory [data-county]").length, 64);
    }
    const noMap = await load(counties.slice(0, 63), "q=zzzz");
    assert.match(noMap.$(".county-map-fallback").textContent, /unavailable/);
    assert.equal(noMap.$("[data-map-county]"), null);
    assert.equal(
      noMap.$(".county-browse-all").textContent,
      "Browse all 63 counties",
    );
    assert.equal(
      noMap.$(".county-browse-all").getAttribute("href"),
      "#county-directory",
    );
    assert.equal(noMap.empty().hidden, false);
    assert.equal(noMap.$$("#county-directory [data-county]").length, 63);
  });
});

test("table sorts by County and the count columns in both directions", async () => {
  await withPreview("empty", async (preview) => {
    const live = await load(registryWithCounts(preview), "q=as");
    const click = (key) =>
      live.$(`[data-sort="${key}"]`).dispatchEvent(
        new live.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    const names = () => live.rows().map((name) => name.replace(/ County$/, ""));

    // Default is County A to Z.
    assert.deepEqual(names(), [
      "Douglas",
      "El Paso",
      "Las Animas",
      "Washington",
    ]);

    click("county");
    assert.equal(live.sortState().county, "descending");
    assert.deepEqual(names(), [
      "Washington",
      "Las Animas",
      "El Paso",
      "Douglas",
    ]);
    click("county");
    assert.equal(live.sortState().county, "ascending");

    // Counts sort numerically. Ties use the county name. Unavailable is last.
    click("profiles");
    assert.equal(live.sortState().profiles, "descending");
    assert.equal(live.sortState().county, "none");
    assert.deepEqual(names(), [
      "El Paso",
      "Douglas",
      "Washington",
      "Las Animas",
    ]);
    click("profiles");
    assert.equal(live.sortState().profiles, "ascending");
    assert.deepEqual(names(), [
      "Douglas",
      "Washington",
      "El Paso",
      "Las Animas",
    ]);

    click("reports");
    assert.deepEqual(names(), [
      "Las Animas",
      "Douglas",
      "El Paso",
      "Washington",
    ]);
    click("reports");
    assert.deepEqual(names(), [
      "Douglas",
      "El Paso",
      "Las Animas",
      "Washington",
    ]);

    // Zeroes are real values. Unavailable stays last in both directions.
    click("grievances");
    assert.equal(live.sortState().grievances, "descending");
    assert.deepEqual(names(), [
      "El Paso",
      "Douglas",
      "Las Animas",
      "Washington",
    ]);
    click("grievances");
    assert.equal(live.sortState().grievances, "ascending");
    assert.deepEqual(names(), [
      "Douglas",
      "Las Animas",
      "El Paso",
      "Washington",
    ]);

    // The mobile sort control drives the same state.
    const select = live.$("[data-sort-select]");
    assert.equal(live.$("[data-sort-select-wrap]").hidden, false);
    select.value = "profiles:desc";
    select.dispatchEvent(new live.window.Event("change", { bubbles: true }));
    assert.equal(live.sortState().profiles, "descending");
    assert.deepEqual(names(), [
      "El Paso",
      "Douglas",
      "Washington",
      "Las Animas",
    ]);
  });
});

test("unavailable counts show a dash with an Unavailable label and zeroes show as 0", async () => {
  await withPreview("empty", async (preview) => {
    const view = await load(registryWithCounts(preview), "q=as", {
      script: false,
    });
    const row = (name) =>
      view
        .$$("[data-result-row]")
        .find(
          (item) =>
            item.querySelector(".county-name-link").textContent === name,
        );
    const cell = (name, label) =>
      row(name).querySelector(`[data-label="${label}"]`);
    const unavailable = cell("Las Animas County", "Listed Profiles");
    assert.equal(unavailable.querySelector("[aria-hidden]").textContent, "–");
    assert.equal(
      unavailable.querySelector(".visually-hidden").textContent,
      "Unavailable",
    );
    assert.equal(cell("Douglas County", "Grievances").textContent.trim(), "0");
    assert.equal(
      cell("Douglas County", "Grievances").querySelector(".visually-hidden"),
      null,
    );
    assert.equal(cell("Las Animas County", "Reports").textContent.trim(), "5");
    assert.equal(
      cell("El Paso County", "Listed Profiles").textContent.trim(),
      "30",
    );
  });
});

test("the real preview shows an Unavailable dash for every count until aggregates are wired", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/counties?q=as");
    const cells = page.$$(
      '[data-result-row]:not([hidden]) td[data-label]:not([data-label="County"])',
    );
    assert.equal(cells.length, 12);
    for (const cell of cells) {
      assert.equal(
        cell.querySelector(".visually-hidden").textContent,
        "Unavailable",
      );
    }
  });
});

test("sortCounties breaks ties by county name and then FIPS", () => {
  const entries = [
    { fips: "08003", name: "Same", counts: { reports: 3 } },
    { fips: "08001", name: "Same", counts: { reports: 3 } },
    { fips: "08005", name: "Alpha", counts: { reports: 3 } },
    { fips: "08007", name: "Beta", counts: {} },
    { fips: "08009", name: "Gamma", counts: { reports: 9 } },
    { fips: "08011", name: "Delta", counts: { reports: null } },
    { fips: "08013", name: "Zero", counts: { reports: 0 } },
  ];
  const order = (key, direction) =>
    sortCounties(entries, { key, direction }).map((entry) => entry.fips);
  assert.deepEqual(order("reports", "desc"), [
    "08009",
    "08005",
    "08001",
    "08003",
    "08013",
    "08007",
    "08011",
  ]);
  assert.deepEqual(order("reports", "asc"), [
    "08013",
    "08005",
    "08001",
    "08003",
    "08009",
    "08007",
    "08011",
  ]);
  assert.deepEqual(order("county", "asc"), [
    "08005",
    "08007",
    "08011",
    "08009",
    "08001",
    "08003",
    "08013",
  ]);
});

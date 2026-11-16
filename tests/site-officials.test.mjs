import assert from "node:assert/strict";
import test from "node:test";
import { directoryReturnHref } from "../dist/site/pages/officials.js";
import { get, ORIGIN, withPreview } from "./site-fixtures.mjs";

const rows = (page) => page.$$(".directory-table tbody tr");
const rowNames = (page) =>
  rows(page).map((row) => row.querySelector(".person-name").textContent);
const tabCounts = (page) =>
  page
    .$$(".directory-tab")
    .map((tab) => [
      tab.childNodes[0].textContent.trim(),
      tab.querySelector(".count-chip")?.childNodes[0].textContent ?? null,
      tab.getAttribute("aria-current"),
    ]);

test("named profiles can be browsed before any search term is entered", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/officials");
    assert.equal(page.status, 200);
    assert.equal(page.$("h1").textContent, "Search officials & employees");
    assert.equal(page.$("#site-nav a[aria-current]").textContent, "Officials");
    assert.equal(rows(page).length, 25);
    assert.deepEqual(tabCounts(page), [
      ["Named profiles", "46", "page"],
      ["County structure", null, null],
    ]);
    assert.match(page.$(".directory-status").textContent, /All counties\./);
    assert.match(page.$(".directory-status").textContent, /46 profiles match/);
    assert.match(page.$(".result-range").textContent, /Showing 1 to 25 of 46/);
    // The Beta-1 style address is accepted as-is.
    const legacy = await get(
      preview,
      "/officials?view=People&directoryView=people",
    );
    assert.deepEqual(rowNames(legacy), rowNames(page));

    // Controls: search, county, office and sort, all labelled.
    const form = page.$("form.directory-filters");
    assert.equal(form.getAttribute("action"), "/officials");
    assert.equal(form.method, "get");
    for (const id of [
      "directory-q",
      "directory-county",
      "directory-office",
      "directory-sort",
    ]) {
      assert.ok(page.$(`label[for="${id}"]`), id);
    }
    assert.equal(page.$$("#directory-county option").length, 65);
    // Statewide, only type groupings are offered until a county is chosen.
    assert.deepEqual(
      page.$$("#directory-office option").map((o) => o.value),
      [
        "",
        "type:county_government",
        "type:office",
        "type:department",
        "type:division",
        "type:regional",
        "type:partner",
        "type:other",
      ],
    );
    assert.match(
      page.$("#directory-office-hint").textContent,
      /after you select a county/,
    );
    assert.equal(page.$$("#directory-sort option").length, 10);

    // Table headings sort, and the active one is announced.
    const headings = page.$$(".directory-table thead th");
    assert.deepEqual(
      headings
        .slice(0, 4)
        .map((th) => th.querySelector("a").childNodes[0].textContent),
      ["Official / employee", "County", "County office", "Source checked"],
    );
    assert.equal(headings[0].getAttribute("aria-sort"), "ascending");
    assert.equal(
      headings[0].querySelector("a").getAttribute("href"),
      "/officials?sort=name-desc",
    );
    assert.equal(
      headings[3].querySelector("a").getAttribute("href"),
      "/officials?sort=checked",
    );
    assert.ok(headings.every((th) => th.getAttribute("scope") === "col"));

    // Nothing unimplemented is offered.
    assert.doesNotMatch(
      page.main(),
      /suggest a missing|flag|report|grievance|log in/i,
    );
    assert.doesNotMatch(
      page.main(),
      /\b(current employee|currently employed|incumbent|vacant)\b/i,
    );
    assert.match(page.main(), /does not confirm\s+current employment/);
  });
});

test("county and office filters narrow results and keep state in the address", async () => {
  await withPreview("fictional", async (preview) => {
    const larimer = await get(preview, "/officials?county=08069");
    assert.equal(rows(larimer).length, 11);
    assert.deepEqual(tabCounts(larimer), [
      ["Named profiles", "11", "page"],
      ["County structure", "7", null],
    ]);
    assert.equal(
      larimer.$("#directory-county option[selected]").value,
      "08069",
    );
    assert.match(
      larimer.$(".directory-status").textContent,
      /County: Larimer County\./,
    );
    assert.match(larimer.$("title").textContent, /Larimer County/);
    // Office choices are grouped by stored type, with affiliates kept apart.
    assert.deepEqual(
      larimer
        .$$("#directory-office optgroup")
        .map((g) => [g.label, g.querySelectorAll("option").length]),
      [
        ["County government", 2],
        ["Offices", 3],
        ["Departments", 2],
        ["Divisions", 2],
        ["Affiliated organizations (not county departments)", 2],
      ],
    );
    // The affiliated district's person is listed with the affiliation stated.
    const morgan = rows(larimer).find((row) =>
      /Morgan Sample/.test(row.textContent),
    );
    assert.match(
      morgan.querySelector('[data-label="County"]').textContent,
      /Serves\s+Larimer County/,
    );
    assert.doesNotMatch(
      morgan.querySelector('[data-label="County"]').textContent,
      /Adams/,
    );

    const department = await get(
      preview,
      "/officials?county=08069&office=demo-larimer-dev",
    );
    assert.equal(rows(department).length, 8);
    assert.equal(
      department.$("#directory-office option[selected]").value,
      "demo-larimer-dev",
    );
    assert.match(
      department.$(".directory-status").textContent,
      /Office: Fictional Community Development Department\./,
    );
    const division = await get(
      preview,
      "/officials?county=08069&office=type%3Adivision",
    );
    assert.equal(rows(division).length, 4);
    assert.equal(
      division.$("#directory-office option[selected]").value,
      "type:division",
    );

    // Every link out of a filtered view keeps the filters.
    const sortLink = department
      .$(".directory-table thead th:nth-child(4) a")
      .getAttribute("href");
    assert.equal(
      sortLink,
      "/officials?county=08069&office=demo-larimer-dev&sort=checked",
    );
    assert.equal(
      department.$$(".directory-tab")[1].getAttribute("href"),
      "/officials?directoryView=structure&county=08069",
    );
    const profile = rows(department)[0]
      .querySelector(".person-name")
      .getAttribute("href");
    assert.equal(
      profile,
      "/people/demo-l-02?from=county%3D08069%26office%3Ddemo-larimer-dev",
    );

    // Switching county with a stale office drops the office instead of failing.
    const switched = await get(
      preview,
      "/officials?county=08001&office=demo-larimer-dev",
    );
    assert.equal(switched.status, 200);
    assert.equal(rows(switched).length, 25);
    assert.equal(switched.$("#directory-office option[selected]"), null);
    assert.doesNotMatch(switched.$(".directory-status").textContent, /Office:/);

    // An organization serving two counties is reachable from both.
    for (const county of ["08001", "08069"]) {
      const page = await get(
        preview,
        `/officials?county=${county}&office=demo-regional-health`,
      );
      assert.deepEqual(rowNames(page), ["Morgan Sample (fictional)"], county);
    }
  });
});

test("search covers names, titles and organizations, and same names stay separate", async () => {
  await withPreview("fictional", async (preview) => {
    assert.deepEqual(rowNames(await get(preview, "/officials?q=addison")), [
      "Addison Fixture (fictional)",
    ]);
    const title = await get(preview, "/officials?q=Building+Inspector");
    assert.deepEqual(rowNames(title), [
      "Ellis Dummy (fictional)",
      "Frankie Dummy (fictional)",
    ]);
    assert.equal(title.$("#directory-q").value, "Building Inspector");
    assert.deepEqual(
      rowNames(await get(preview, "/officials?q=health+district")),
      ["Morgan Sample (fictional)"],
    );

    const jordans = await get(preview, "/officials?q=Jordan+Example");
    assert.equal(rows(jordans).length, 2);
    assert.deepEqual(
      rows(jordans).map(
        (row) =>
          row.querySelector(".person-name").getAttribute("href").split("?")[0],
      ),
      ["/people/demo-person-jordan-a", "/people/demo-person-jordan-b"],
    );
    assert.match(
      jordans.main(),
      /People who share a name are separate records/,
    );

    // One row for a person with several roles, with the others signposted.
    const riley = await get(preview, "/officials?q=Riley+Placeholder");
    assert.equal(rows(riley).length, 1);
    assert.match(
      rows(riley)[0].textContent,
      /2 other matching roles on the profile/,
    );
    assert.match(
      rows(riley)[0].textContent,
      /Role end recorded: April 30, 2015/,
    );
    assert.match(
      rows(riley)[0].querySelector('[data-label="Source checked"]').textContent,
      /October 20, 2026/,
    );
    const source = rows(riley)[0].querySelector(".checked-source a");
    assert.equal(
      source.getAttribute("href"),
      "https://example.invalid/fictional-larimer/community-development",
    );
    assert.match(source.getAttribute("rel"), /noopener/);

    const none = await get(preview, "/officials?q=zzzz");
    assert.equal(rows(none).length, 0);
    assert.match(none.main(), /No documented profiles match these filters/);
    assert.match(none.main(), /not a complete roster/);
    const short = await get(preview, "/officials?q=a");
    assert.equal(short.status, 200);
    assert.match(short.main(), /That search is too short/);
    const unlisted = await get(preview, "/officials?q=Harper");
    assert.match(rows(unlisted)[0].textContent, /No documented role/);
    assert.equal(rows(unlisted)[0].querySelector(".status-chip"), null);
  });
});

test("sorting and pagination work across the whole result set", async () => {
  await withPreview("fictional", async (preview) => {
    const first = await get(preview, "/officials");
    const next = first.$('.directory-pager a[rel="next"]').getAttribute("href");
    assert.equal(next, "/officials?page=2");
    assert.equal(first.$('.directory-pager a[rel="prev"]'), null);
    assert.match(first.$(".pager-status").textContent, /Page 1 of 2/);
    const second = await get(preview, next);
    assert.equal(rows(second).length, 21);
    assert.equal(
      second.$('.directory-pager a[rel="prev"]').getAttribute("href"),
      "/officials",
    );
    assert.equal(second.$('.directory-pager a[rel="next"]'), null);
    assert.equal(
      new Set([...rowNames(first), ...rowNames(second)]).size <= 46,
      true,
    );
    const profileLinks = (page) =>
      rows(page).map(
        (r) =>
          r.querySelector(".person-name").getAttribute("href").split("?")[0],
      );
    assert.equal(
      new Set([...profileLinks(first), ...profileLinks(second)]).size,
      46,
    );
    // A profile opened from page 2 remembers page 2.
    assert.match(
      rows(second)[0].querySelector(".person-name").getAttribute("href"),
      /\?from=page%3D2$/,
    );

    const descending = await get(
      preview,
      "/officials?county=08069&sort=name-desc",
    );
    const ascending = await get(preview, "/officials?county=08069");
    assert.deepEqual(rowNames(descending), [...rowNames(ascending)].reverse());
    assert.equal(
      descending.$("th[aria-sort]").getAttribute("aria-sort"),
      "descending",
    );
    assert.equal(
      descending.$("#directory-sort option[selected]").value,
      "name-desc",
    );
    const checked = await get(
      preview,
      "/officials?county=08069&sort=checked-desc",
    );
    assert.match(rows(checked)[0].textContent, /October 21, 2026/);
    assert.equal(checked.$$("th[aria-sort]").length, 1);
    assert.match(checked.$("th[aria-sort]").textContent, /Source checked/);
    // Paging keeps the sort.
    const sortedFirst = await get(preview, "/officials?sort=checked-desc");
    assert.equal(
      sortedFirst.$('.directory-pager a[rel="next"]').getAttribute("href"),
      "/officials?sort=checked-desc&page=2",
    );

    // A stale page number explains itself and links back.
    const stale = await get(preview, "/officials?county=08069&page=9");
    assert.equal(stale.status, 200);
    assert.match(stale.main(), /past the end of these results/);
    assert.equal(
      stale.$(".empty-state a").getAttribute("href"),
      "/officials?county=08069",
    );
  });
});

test("invalid directory parameters are refused with a way back", async () => {
  await withPreview("fictional", async (preview) => {
    for (const query of [
      "county=99999",
      "county=08002",
      "county=larimer",
      "office=bad%20id",
      "office=type:elected",
      "office=missing-organization",
      "sort=salary",
      "sort=name-up",
      "page=0",
      "page=abc",
      "page=100000",
      "directoryView=map",
      `q=${"a".repeat(101)}`,
      "county=08069&county=08001",
      "countyId=county-larimer",
    ]) {
      const page = await get(preview, `/officials?${query}`);
      assert.equal(page.status, 400, query);
      assert.match(
        page.$(".error-page a.button").getAttribute("href"),
        /^\/officials/,
        query,
      );
    }
    const hostile = await get(
      preview,
      `/officials?q=${encodeURIComponent('"><script>x</script>')}`,
    );
    assert.equal(hostile.status, 200);
    assert.equal(hostile.$$("script").length, 1);
    assert.equal(hostile.$("#directory-q").value, '"><script>x</script>');
  });
});

test("county structure shows documented relationships and keeps affiliates apart", async () => {
  await withPreview("fictional", async (preview) => {
    const prompt = await get(preview, "/officials?directoryView=structure");
    assert.equal(prompt.status, 200);
    assert.match(
      prompt.main(),
      /Select a county to browse its recorded structure/,
    );
    assert.equal(
      prompt.$('input[type=hidden][name="directoryView"]').value,
      "structure",
    );
    assert.equal(prompt.$(".directory-table"), null);

    const page = await get(
      preview,
      "/officials?directoryView=structure&county=08069",
    );
    assert.deepEqual(tabCounts(page), [
      ["Named profiles", "11", null],
      ["County structure", "7", "page"],
    ]);
    assert.match(page.main(), /County structure is not one chain of command/);
    assert.match(page.main(), /are not staffing totals/);
    assert.deepEqual(
      page.$$(".structure-grid .structure-card h3").map((h) => h.textContent),
      ["County government", "Offices", "Departments"],
    );
    const card = (title) =>
      page
        .$$(".structure-grid .structure-card")
        .find((c) => c.querySelector("h3").textContent === title);
    const entryNames = (root) =>
      [
        ...root.querySelectorAll(
          ":scope > .structure-entry > .structure-row .structure-name",
        ),
      ].map((a) => a.textContent);
    assert.deepEqual(
      entryNames(card("Offices").querySelector(".structure-list")),
      ["Fictional Assessor Office", "Fictional Clerk and Recorder Office"],
    );
    // The division is nested under the department that documents it as parent.
    const department = card("Departments").querySelector(".structure-entry");
    assert.equal(
      department.querySelector(".structure-name").textContent,
      "Fictional Community Development Department",
    );
    assert.match(
      department.querySelector(".structure-count").textContent,
      /8 profiles/,
    );
    const subunits = department.querySelectorAll(
      ".structure-subunits > .structure-entry",
    );
    assert.equal(subunits.length, 1);
    assert.equal(
      subunits[0].querySelector(".structure-name").textContent,
      "Fictional Building Division",
    );
    assert.match(
      subunits[0].textContent,
      /Reports to Fictional Community Development Department/,
    );
    assert.match(
      subunits[0].querySelector(".structure-count").textContent,
      /4 profiles/,
    );
    // Stored relationship wording is shown, never upgraded.
    assert.match(
      card("Offices").textContent,
      /Grouped under Fictional Larimer County Government/,
    );
    assert.doesNotMatch(card("Offices").textContent, /Reports to/);
    assert.doesNotMatch(page.main(), /elected/i);

    // Each organization leads to its people and to its positions record.
    assert.equal(
      department.querySelector(".structure-name").getAttribute("href"),
      "/officials?county=08069&office=demo-larimer-dev",
    );
    assert.ok(
      department.querySelector('a[href="/organizations/demo-larimer-dev"]'),
    );
    assert.equal(
      card("Departments")
        .querySelector(".structure-card-head a")
        .getAttribute("href"),
      "/officials?county=08069&office=type%3Adepartment",
    );
    assert.equal(
      card("County government").querySelector(".structure-card-head a"),
      null,
    );

    // Affiliates sit in their own section and are not listed as departments.
    const affiliated = page.$(".structure-affiliated");
    assert.deepEqual(
      [...affiliated.querySelectorAll(".structure-name")].map(
        (a) => a.textContent,
      ),
      [
        "Fictional Front Range Health District",
        "Fictional Shared Dispatch Center",
      ],
    );
    assert.match(affiliated.textContent, /Serves this county/);
    assert.match(affiliated.textContent, /Shared service for this county/);
    assert.match(
      page.$("#structure-affiliated").parentElement.textContent,
      /They are not county departments/,
    );
    assert.ok(
      !page.$(".structure-grid").textContent.includes("Health District"),
    );

    const empty = await get(
      preview,
      "/officials?directoryView=structure&county=08005",
    );
    assert.match(
      empty.main(),
      /No organizations recorded for Arapahoe County yet/,
    );
    assert.match(empty.main(), /not the county's government/);
  });
});

test("county navigation connects county pages and the directory", async () => {
  await withPreview("fictional", async (preview) => {
    const links = (page) =>
      page
        .$$(".county-nav ul a")
        .map((a) => [
          a.textContent,
          a.getAttribute("href"),
          a.getAttribute("aria-current"),
        ]);
    const expected = (current) => [
      ["County home", "/counties/08069", current === 0 ? "page" : null],
      [
        "Officials & employees",
        "/officials?county=08069",
        current === 1 ? "page" : null,
      ],
      [
        "County structure",
        "/officials?directoryView=structure&county=08069",
        current === 2 ? "page" : null,
      ],
    ];
    const home = await get(preview, "/counties/08069");
    assert.deepEqual(links(home), expected(0));
    assert.equal(
      home.$("form.county-switch").getAttribute("action"),
      "/counties",
    );
    assert.ok(home.$('.hero-actions a[href="/officials?county=08069"]'));
    assert.ok(
      home.$(
        '.hero-actions a[href="/officials?directoryView=structure&county=08069"]',
      ),
    );

    const officials = await get(preview, "/officials?county=08069");
    assert.deepEqual(links(officials), expected(1));
    // Switching county from the directory stays in the directory.
    const switcher = officials.$("form.county-switch");
    assert.equal(switcher.getAttribute("action"), "/officials");
    assert.equal(switcher.querySelector("input[type=hidden]"), null);
    assert.ok(officials.$('.county-nav a[href="/counties"]'));
    assert.deepEqual(
      officials.$$(".breadcrumbs li").map((li) => li.textContent.trim()),
      ["Home", "Counties", "Larimer County", "Officials & employees"],
    );

    const structure = await get(
      preview,
      "/officials?directoryView=structure&county=08069",
    );
    assert.deepEqual(links(structure), expected(2));
    assert.equal(
      structure.$("form.county-switch input[type=hidden]").value,
      "structure",
    );
    // Statewide browsing has no county bar.
    assert.equal((await get(preview, "/officials")).$(".county-nav"), null);
  });
});

test("a profile opened from the directory links back to the same results", async () => {
  await withPreview("fictional", async (preview) => {
    const from =
      "county%3D08069%26office%3Ddemo-larimer-dev%26sort%3Dchecked-desc";
    const profile = await get(preview, `/people/demo-l-05?from=${from}`);
    assert.equal(profile.status, 200);
    const back =
      "/officials?county=08069&office=demo-larimer-dev&sort=checked-desc";
    assert.equal(profile.$(".back-link a").getAttribute("href"), back);
    assert.equal(
      profile.$(".breadcrumbs a[href^='/officials']").getAttribute("href"),
      back,
    );
    assert.equal(profile.$$(".role-entry").length, 2);
    assert.equal((await get(preview, back)).status, 200);

    const plain = await get(preview, "/people/demo-l-05");
    assert.equal(plain.$(".back-link"), null);
    assert.equal(
      plain.$(".breadcrumbs a[href^='/officials']").getAttribute("href"),
      "/officials",
    );

    // The return address can only ever point at the directory.
    assert.equal(
      directoryReturnHref("county=08069&page=2"),
      "/officials?county=08069&page=2",
    );
    assert.equal(
      directoryReturnHref("directoryView=structure&county=08069"),
      "/officials?directoryView=structure&county=08069",
    );
    for (const value of [
      null,
      "",
      "county=evil",
      "https://example.invalid/",
      "page=-1",
      "x".repeat(600),
      "office=//evil",
    ]) {
      const href = directoryReturnHref(value);
      assert.ok(href === null || href.startsWith("/officials"), String(value));
    }
    for (const value of [
      "county%3Devil",
      encodeURIComponent("//example.invalid"),
      encodeURIComponent("javascript:alert(1)"),
    ]) {
      const page = await get(preview, `/people/demo-l-05?from=${value}`);
      assert.equal(page.status, 200, value);
      for (const link of page.$$("main a[href]")) {
        assert.doesNotMatch(link.getAttribute("href"), /^(\/\/|javascript:)/i);
      }
    }
    // Existing discovery routes still work and point to the directory.
    assert.equal((await get(preview, "/people?query=jordan")).status, 200);
    assert.ok((await get(preview, "/people")).$('a[href="/officials"]'));
    assert.equal(
      (await get(preview, "/organizations?query=fictional")).status,
      200,
    );
    const response = await preview.fetch(
      new Request(`${ORIGIN}/api/people?query=jordan`),
    );
    assert.equal(response.status, 200);
  });
});

test("empty and partially populated databases give honest empty states", async () => {
  await withPreview("empty", async (preview) => {
    const page = await get(preview, "/officials");
    assert.equal(page.status, 200);
    assert.match(
      page.main(),
      /No officials or employees have been documented yet/,
    );
    assert.deepEqual(tabCounts(page)[0], ["Named profiles", "0", "page"]);
    assert.equal(page.$(".directory-table"), null);
    const county = await get(preview, "/officials?county=08069");
    assert.match(
      county.main(),
      /No one has been documented for Larimer County/,
    );
    assert.match(county.main(), /not the county's staffing/);
    assert.deepEqual(tabCounts(county)[1], ["County structure", "0", null]);
    const structure = await get(
      preview,
      "/officials?directoryView=structure&county=08069",
    );
    assert.match(
      structure.main(),
      /No organizations recorded for Larimer County yet/,
    );
    assert.doesNotMatch(page.text + county.text + structure.text, /fictional/i);
  });
  await withPreview("fictional", async (preview) => {
    // A county with organizations but no documented people.
    preview.database.exec(
      "INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('partial-org','Synthetic Empty Office','office','08005')",
    );
    const people = await get(preview, "/officials?county=08005");
    assert.match(
      people.main(),
      /No one has been documented for Arapahoe County/,
    );
    const structure = await get(
      preview,
      "/officials?directoryView=structure&county=08005",
    );
    assert.match(structure.$(".structure-count").textContent, /0 profiles/);
    assert.doesNotMatch(structure.main(), /vacan/i);
  });
});

test("county to profile browsing keeps Larimer selected and links back", async () => {
  await withPreview("fictional", async (preview) => {
    // Start at the county directory and follow the rendered county link.
    const counties = await get(preview, "/counties");
    assert.equal(counties.status, 200);
    const larimerRow = counties
      .$$("[data-county]")
      .find(
        (row) =>
          row.querySelector(".county-name").textContent === "Larimer County",
      );
    assert.ok(larimerRow, "Larimer County row");
    const countyHref = larimerRow.querySelector("a").getAttribute("href");
    assert.equal(countyHref, "/counties/08069");
    const county = await get(preview, countyHref);
    assert.equal(county.status, 200);
    assert.match(county.$("h1").textContent, /Larimer County/);

    // The county page's own navigation leads to its officials directory.
    const officialsLink = county
      .$$(".county-nav a")
      .find((a) => a.textContent.trim() === "Officials & employees");
    assert.ok(officialsLink, "Officials & employees link");
    const directoryHref = officialsLink.getAttribute("href");
    assert.equal(directoryHref, "/officials?county=08069");
    const directory = await get(preview, directoryHref);
    assert.equal(directory.status, 200);
    assert.equal(
      directory.$("#directory-county option[selected]").value,
      "08069",
    );
    assert.match(
      directory.$(".directory-status").textContent,
      /County: Larimer County\./,
    );
    assert.equal(directory.$$(".directory-table tbody tr").length, 11);

    // Follow a rendered person link into a profile.
    const personHref = directory
      .$(".directory-table tbody .person-name")
      .getAttribute("href");
    assert.match(personHref, /^\/people\/[^?]+\?from=county%3D08069$/);
    const profile = await get(preview, personHref);
    assert.equal(profile.status, 200);
    assert.ok(profile.$("h1").textContent.trim().length > 0);
    assert.equal(
      profile.$(".back-link a").textContent,
      "Back to directory results",
    );

    // The rendered back link returns to the Larimer-filtered directory.
    const backHref = profile.$(".back-link a").getAttribute("href");
    assert.equal(backHref, "/officials?county=08069");
    const returned = await get(preview, backHref);
    assert.equal(returned.status, 200);
    assert.equal(
      returned.$("#directory-county option[selected]").value,
      "08069",
    );
    assert.match(
      returned.$(".directory-status").textContent,
      /County: Larimer County\./,
    );
    assert.deepEqual(rowNames(returned), rowNames(directory));
  });
});

test("an organization office without a county is shown, not applied invisibly", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/officials?office=demo-adams-gov");
    assert.equal(page.status, 200);
    assert.match(page.$(".directory-status").textContent, /Office: /);
    const selected = page
      .$$("#directory-office option")
      .filter((o) => o.hasAttribute("selected"));
    assert.deepEqual(
      selected.map((o) => o.value),
      ["demo-adams-gov"],
    );
    // With its county the same office still filters and is announced.
    const scoped = await get(
      preview,
      "/officials?county=08001&office=demo-adams-gov",
    );
    assert.match(scoped.$(".directory-status").textContent, /Office:/);
  });
});

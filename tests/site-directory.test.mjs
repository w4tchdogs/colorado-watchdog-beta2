import assert from "node:assert/strict";
import test from "node:test";
import { get, withPreview } from "./site-fixtures.mjs";

test("people directory prompts, searches and bounds its pages", async () => {
  await withPreview("fictional", async (preview) => {
    const blank = await get(preview, "/people");
    assert.equal(blank.status, 200);
    assert.match(blank.main(), /Search people by name/);
    assert.equal(blank.$$(".record-row").length, 0);
    assert.equal(blank.$("#people-search").getAttribute("minlength"), "2");

    const short = await get(preview, "/people?query=a");
    assert.equal(short.status, 200);
    assert.match(short.main(), /too short/);

    const none = await get(preview, "/people?query=nobody-here");
    assert.match(none.main(), /No people match "nobody-here"/);
    assert.match(none.main(), /not a complete roster/);

    const first = await get(preview, "/people?query=fictional");
    assert.equal(first.$$(".record-row").length, 25);
    assert.equal(first.$("#people-search").value, "fictional");
    const next = first.$('.pager a[rel="next"]').getAttribute("href");
    assert.match(next, /^\/people\?query=fictional&cursor=/);
    const second = await get(preview, next);
    assert.equal(second.$$(".record-row").length, 21);
    assert.equal(second.$('.pager a[rel="next"]'), null);
    assert.equal(
      second.$(".pager a").getAttribute("href"),
      "/people?query=fictional",
    );
    const hrefs = (page) =>
      page.$$(".record-title a").map((a) => a.getAttribute("href"));
    assert.equal(new Set([...hrefs(first), ...hrefs(second)]).size, 46);
  });
});

test("identically named people remain distinct records", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/people?query=Jordan%20Example");
    const rows = page.$$(".record-row");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.querySelector("a").getAttribute("href")).sort(),
      ["/people/demo-person-jordan-a", "/people/demo-person-jordan-b"],
    );
    assert.deepEqual(
      rows
        .map((row) => row.querySelector(".record-id code").textContent)
        .sort(),
      ["demo-person-jordan-a", "demo-person-jordan-b"],
    );
    assert.ok(rows.every((row) => /separate people/.test(row.textContent)));

    const a = await get(preview, "/people/demo-person-jordan-a");
    const b = await get(preview, "/people/demo-person-jordan-b");
    assert.equal(a.$("h1").textContent, b.$("h1").textContent);
    assert.match(a.main(), /Adams County/);
    assert.doesNotMatch(a.main(), /Larimer County/);
    assert.match(b.main(), /Larimer County/);
    assert.doesNotMatch(b.main(), /Adams County/);
    assert.equal(a.$$(".role-entry").length, 2);
    assert.equal(b.$$(".role-entry").length, 1);

    // Nickname or partial-name similarity never links records.
    const nickname = await get(preview, "/people?query=Jordy");
    assert.equal(nickname.$$(".record-row").length, 0);
  });
});

test("person profile shows role history, counties, dates and citations", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/people/demo-person-jordan-a");
    assert.equal(page.status, 200);
    assert.equal(page.$("h1").textContent, "Jordan Example (fictional)");
    assert.match(page.$(".page-meta").textContent, /demo-person-jordan-a/);
    const entries = page.$$(".role-entry");
    const clerk = entries.find(
      (e) =>
        e.querySelector("h3").textContent === "Fictional Clerk and Recorder",
    );
    assert.ok(clerk.querySelector('a[href="/organizations/demo-adams-clerk"]'));
    assert.ok(clerk.querySelector('a[href="/counties/08001"]'));
    assert.match(
      clerk.querySelector(".association-list").textContent,
      /County organization of\s+Adams County/,
    );
    assert.match(
      clerk.querySelector(".role-dates").textContent,
      /Role end\s*Not recorded/,
    );
    assert.match(
      clerk.querySelector(".citation").textContent,
      /Source checked October 2, 2026/,
    );
    const deputy = entries.find(
      (e) => e.querySelector("h3").textContent === "Fictional Deputy Clerk",
    );
    assert.match(
      deputy.querySelector(".role-dates").textContent,
      /March 1, 2019[\s\S]*January 9, 2023/,
    );
    assert.match(page.main(), /It is not when the role began/);
    assert.doesNotMatch(
      page.$(".role-list").textContent,
      /\b(current|present|incumbent)\b/i,
    );

    // Affiliation is labelled as such on a person's role.
    const morgan = await get(preview, "/people/demo-person-morgan");
    assert.match(
      morgan.$(".association-list").textContent,
      /Serves\s+Adams County\s+\(affiliation, not a county department\)/,
    );
    assert.doesNotMatch(
      morgan.$(".association-list").textContent,
      /County organization of/,
    );

    const empty = await get(preview, "/people/demo-person-no-roles");
    assert.equal(empty.status, 200);
    assert.match(empty.main(), /No documented roles/);

    assert.equal(
      (await get(preview, "/people/demo-person-jordan-a?afterRoleId=bad%20id"))
        .status,
      400,
    );
  });
});

test("organization directory and profiles distinguish types and relationships", async () => {
  await withPreview("fictional", async (preview) => {
    const blank = await get(preview, "/organizations");
    assert.match(blank.main(), /Search organizations by name/);

    const results = await get(preview, "/organizations?query=fictional");
    const badges = Object.fromEntries(
      results
        .$$(".record-row")
        .map((row) => [
          row.querySelector("a").getAttribute("href").split("/").pop(),
          row.querySelector(".type-badge").className,
        ]),
    );
    assert.equal(badges["demo-adams-gov"], "type-badge type-county-government");
    assert.equal(badges["demo-adams-clerk"], "type-badge type-office");
    assert.equal(badges["demo-adams-works"], "type-badge type-department");
    assert.equal(badges["demo-adams-roads"], "type-badge type-division");
    assert.equal(badges["demo-regional-health"], "type-badge type-regional");
    assert.equal(badges["demo-partner-library"], "type-badge type-partner");
    assert.equal(badges["demo-shared-dispatch"], "type-badge type-other");
    // Two same-named offices in different counties stay separate.
    assert.ok(badges["demo-larimer-clerk"]);

    const works = await get(preview, "/organizations/demo-adams-works");
    assert.equal(works.status, 200);
    assert.equal(
      works.$("h1").textContent,
      "Fictional Public Works Department",
    );
    assert.match(works.$(".profile-header .eyebrow").textContent, /Department/);
    assert.ok(works.$(".profile-header").classList.contains("edge-department"));
    assert.match(
      works.main(),
      /Reports to\s+Fictional Adams County Government/,
    );
    assert.ok(works.$('a[href="/organizations/demo-adams-gov"]'));
    assert.match(works.main(), /County organization of\s+Adams County/);
    assert.deepEqual(
      works
        .$$(".position-list li")
        .map((li) => li.textContent)
        .sort(),
      ["Fictional Fleet Manager", "Fictional Public Works Director"],
    );
    assert.match(
      works.$("#positions").textContent,
      /not a statement that it is\s+filled or vacant/,
    );
    assert.ok(works.$('#roles a[href="/people/demo-person-riley"]'));
    assert.equal(works.$$("#roles .citation").length, 1);
    assert.ok(
      works.$(".source-list .citation a[href^='https://example.invalid/']"),
    );

    const clerk = await get(preview, "/organizations/demo-adams-clerk");
    assert.match(
      clerk.main(),
      /Grouped under\s+Fictional Adams County Government/,
    );
    assert.match(clerk.main(), /does not establish a reporting line/);

    const health = await get(preview, "/organizations/demo-regional-health");
    assert.match(health.main(), /No parent organization is recorded/);
    const counties = health.$(".association-list").textContent;
    assert.match(counties, /Serves\s+Adams County/);
    assert.match(counties, /Serves\s+Larimer County/);
    assert.doesNotMatch(counties, /County organization of/);
    assert.ok(health.$('a[href="/counties/08069"]'));

    const roads = await get(preview, "/organizations/demo-adams-roads");
    assert.equal(roads.$$("#roles .role-entry").length, 25);
    const next = roads.$('#roles a[rel="next"]').getAttribute("href");
    const more = await get(preview, next.replace(/#.*/, ""));
    assert.equal(more.$$("#roles .role-entry").length, 8);

    const gov = await get(preview, "/organizations/demo-adams-gov");
    assert.match(gov.$("#positions").textContent, /No documented positions/);
    assert.match(
      gov.$("#roles").textContent,
      /This does not indicate a vacancy/,
    );
  });
});

test("empty database directories and profiles respond helpfully", async () => {
  await withPreview("empty", async (preview) => {
    for (const path of ["/people", "/organizations"]) {
      assert.equal((await get(preview, path)).status, 200);
    }
    const people = await get(preview, "/people?query=anyone");
    assert.equal(people.status, 200);
    assert.match(people.main(), /No people match/);
    const organizations = await get(preview, "/organizations?query=anything");
    assert.match(organizations.main(), /No organizations match/);
    assert.equal((await get(preview, "/people/demo-person-riley")).status, 404);
    assert.equal(
      (await get(preview, "/organizations/demo-adams-gov")).status,
      404,
    );
    const county = await get(preview, "/counties/08069");
    assert.equal(county.$("#organizations"), null);
    assert.equal(county.$(".stat-row"), null);
  });
});

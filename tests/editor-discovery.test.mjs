import assert from "node:assert/strict";
import test from "node:test";
import { mountWorkspace, waitFor } from "./editor-fixtures.mjs";

const rows = (w) => w.$$("table.drafts tbody tr");
const ids = (w) => rows(w).map((row) => row.getAttribute("data-id"));
const titles = (w) =>
  rows(w).map((row) => row.querySelector("strong").textContent);

async function ready(w) {
  await waitFor(() => rows(w).length > 0, "rows");
}
async function search(w, value) {
  w.type(w.$("#search-text"), value);
  w.$("form.filters").dispatchEvent(
    new w.window.Event("submit", { bubbles: true, cancelable: true }),
  );
}
async function pick(w, selector, value) {
  const select = w.$(selector);
  select.value = value;
  w.change(select);
}
async function allModified(w) {
  const all = [];
  let cursor = null;
  do {
    const page = await w.client.listDrafts({
      sort: "modified",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

test("dashboard defaults to recently modified, newest first, across pages", async () => {
  const w = await mountWorkspace({ pageSize: 4 });
  try {
    await ready(w);
    const expected = (await allModified(w)).map((item) => item.id);
    assert.equal(w.$("#sort-order").value, "modified");
    assert.match(w.text("#list-summary"), /recently modified, newest first/);
    assert.equal(
      w.$("table.drafts th[aria-sort]").textContent,
      "Last modified",
    );
    const seen = [...ids(w)];
    while (!w.$("#page-next").disabled) {
      const before = w.text("#page-label");
      w.click("#page-next");
      await waitFor(() => w.text("#page-label") !== before, "next page");
      await ready(w);
      assert.ok(rows(w).length <= 4);
      seen.push(...ids(w));
    }
    assert.deepEqual(seen, expected);
    assert.equal(seen.length, 14);
    const times = (await allModified(w)).map((i) => i.updatedAt);
    assert.deepEqual(times, [...times].sort().reverse());
  } finally {
    await w.close();
  }
});

test("ID order remains available and resets to page one when chosen", async () => {
  const w = await mountWorkspace({ pageSize: 5 });
  try {
    await ready(w);
    w.click("#page-next");
    await waitFor(() => /Page 2/.test(w.text("#page-label")), "page 2");
    await pick(w, "#sort-order", "id");
    await waitFor(() => /Page 1/.test(w.text("#page-label")), "reset");
    await waitFor(() => /ID order/.test(w.text("#list-summary")), "summary");
    await ready(w);
    const shown = ids(w);
    assert.deepEqual(shown, [...shown].sort());
    assert.equal(w.$("table.drafts th[aria-sort]"), null);
    w.click("#page-next");
    await waitFor(() => /Page 2/.test(w.text("#page-label")), "page 2 id");
    await ready(w);
    const second = ids(w);
    assert.ok(second[0] > shown.at(-1));
  } finally {
    await w.close();
  }
});

test("search filters by title and summary, combines with filters and resets paging", async () => {
  const w = await mountWorkspace({ pageSize: 3 });
  try {
    await ready(w);
    w.click("#page-next");
    await waitFor(() => /Page 2/.test(w.text("#page-label")), "page 2");
    await search(w, "story number 4");
    await waitFor(() => rows(w).length === 2, "summary matches 4 and 14");
    assert.match(w.text("#page-label"), /Page 1/);
    assert.match(w.text("#list-summary"), /search: "story number 4"/);
    assert.deepEqual(titles(w).sort(), [
      "Fictional Story 14",
      "Fictional Story 4",
    ]);
    await search(w, "fictional post");
    await waitFor(() => rows(w).length > 0 && w.$("#page-next"), "title match");
    await waitFor(() => titles(w).every((t) => /Post/.test(t)), "post titles");
    await pick(w, "#filter-status", "archived");
    await waitFor(
      () => rows(w).every((r) => /Archived/.test(r.textContent)),
      "archived",
    );
    await pick(w, "#filter-type", "story");
    await waitFor(() => w.$(".empty"), "empty");
    assert.match(w.text(".empty"), /No Posts or Stories match/);
    assert.equal(w.$("#page-next").disabled, true);
    w.click("#filters-clear");
    await waitFor(() => rows(w).length === 3, "cleared");
    assert.equal(w.$("#search-text").value, "");
    assert.equal(w.$("#filter-type").value, "");
    assert.equal(w.$("#filter-status").value, "");
    assert.equal(w.window.document.activeElement, w.$("#search-text"));
  } finally {
    await w.close();
  }
});

test("search text and wildcards are data and never become markup", async () => {
  const w = await mountWorkspace();
  try {
    await ready(w);
    const hostile = "<img src=x onerror=alert(1)> % _";
    await search(w, "<b>x</b> %");
    await waitFor(() => w.$(".empty"), "empty for markup");
    assert.equal(w.$$("main b, #list-summary b").length, 0);
    assert.match(w.text("#list-summary"), /<b>x<\/b> %/);
    await search(w, hostile);
    await waitFor(() => w.$(".empty"), "empty for hostile");
    assert.equal(w.$$("img").length, 0);
    assert.equal(w.$("#search-text").getAttribute("maxlength"), "100");
    // Too many terms is a server rejection shown as an error, not a crash.
    await search(w, "a b c d e f");
    await waitFor(() => w.$(".results .notice-error"), "invalid search error");
    assert.ok(w.$(".results button"));
  } finally {
    await w.close();
  }
});

test("saved edits move an article to the top of the recently modified list", async () => {
  const w = await mountWorkspace();
  try {
    await ready(w);
    const target = ids(w).at(-1);
    w.window.location.hash = `#/item/${target}`;
    await waitFor(() => w.titleInput(), "editor");
    w.type(w.titleInput(), "Moved to the top");
    w.click("#save");
    await waitFor(() => w.text("#version-line") === "Version 2", "saved");
    w.click("#nav-dashboard");
    await waitFor(() => rows(w).length > 0, "dashboard");
    assert.equal(ids(w)[0], target);
    assert.equal(titles(w)[0], "Moved to the top");
    assert.match(w.text("tbody tr"), /v2/);
    // Archive and restore still work from the opened article.
    assert.ok(w.$("tbody tr .badge-draft"));
  } finally {
    await w.close();
  }
});

test("rows show type, status, timestamp and a keyboard-reachable open link", async () => {
  const w = await mountWorkspace();
  try {
    await ready(w);
    const row = rows(w)[0];
    assert.ok(row.querySelector(".badge-post, .badge-story"));
    assert.ok(row.querySelector(".badge-draft, .badge-archived"));
    const time = row.querySelector("time");
    assert.ok(time.getAttribute("datetime"));
    assert.ok(row.querySelector(".relative"));
    const link = row.querySelector("a.open-link");
    assert.equal(link.tabIndex, 0);
    assert.ok(w.$$("form.filters label").length >= 4);
    for (const selector of [
      "#search-text",
      "#filter-type",
      "#filter-status",
      "#sort-order",
    ]) {
      const id = selector.slice(1);
      assert.ok(w.$(`label[for="${id}"]`), `label for ${id}`);
    }
    assert.equal(w.$("form.filters").getAttribute("role"), "search");
  } finally {
    await w.close();
  }
});

test("loading, error and retry states work for sorted and searched lists", async () => {
  let fail = false;
  let seen = [];
  const w = await mountWorkspace({
    hook: ({ path, init }) => {
      if (path.endsWith("/drafts/list")) {
        seen.push(JSON.parse(init.body));
        if (fail)
          return new Response(JSON.stringify({ error: "internal_error" }), {
            status: 500,
          });
      }
      return undefined;
    },
  });
  try {
    await ready(w);
    assert.equal(seen[0].sort, "modified");
    assert.equal("search" in seen[0], false);
    fail = true;
    await search(w, "fictional");
    await waitFor(() => w.$(".results .notice-error"), "error");
    fail = false;
    seen = [];
    w.click(".results button");
    await waitFor(() => rows(w).length > 0, "retry succeeds");
    assert.equal(seen.at(-1).search, "fictional");
    assert.equal(seen.at(-1).sort, "modified");
  } finally {
    await w.close();
  }
});

test("only the matching cursor kind is sent for each ordering", async () => {
  const bodies = [];
  const w = await mountWorkspace({
    pageSize: 3,
    hook: ({ path, init }) => {
      if (path.endsWith("/drafts/list")) bodies.push(JSON.parse(init.body));
      return undefined;
    },
  });
  try {
    await ready(w);
    w.click("#page-next");
    await waitFor(() => /Page 2/.test(w.text("#page-label")), "page 2");
    const modified = bodies.at(-1);
    assert.match(modified.cursor, /^m1~/);
    assert.equal("afterId" in modified, false);
    await pick(w, "#sort-order", "id");
    await waitFor(() => /ID order/.test(w.text("#list-summary")), "id");
    await ready(w);
    w.click("#page-next");
    await waitFor(() => /Page 2/.test(w.text("#page-label")), "page 2 id");
    const byId = bodies.at(-1);
    assert.equal("cursor" in byId, false);
    assert.ok(byId.afterId);
    assert.equal(byId.sort, "id");
  } finally {
    await w.close();
  }
});

test("denied accounts see authorization errors on the new list controls", async () => {
  const w = await mountWorkspace();
  try {
    await ready(w);
    await pick(w, "#sandbox-account", "readonly");
    await waitFor(() => w.$(".results .notice-error"), "denied");
    assert.match(w.text(".results"), /permission|not allowed|authorized/i);
    await pick(w, "#sort-order", "id");
    await waitFor(() => w.$(".results .notice-error"), "denied sorted");
    await search(w, "fictional");
    await waitFor(() => w.$(".results .notice-error"), "denied search");
    assert.equal(rows(w).length, 0);
  } finally {
    await w.close();
  }
});

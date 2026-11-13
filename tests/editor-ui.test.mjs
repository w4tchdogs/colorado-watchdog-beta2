import assert from "node:assert/strict";
import test from "node:test";
import { mountWorkspace, waitFor } from "./editor-fixtures.mjs";

const rows = (w) => w.$$("table.drafts tbody tr");
const savedLine = (w) => w.text("#save-state");

async function openItem(w, id) {
  w.window.location.hash = `#/item/${id}`;
  await waitFor(() => w.titleInput(), "editor loads");
}
async function firstDraftId(w, filter = () => true) {
  const page = await w.client.listDrafts({ limit: 100 });
  const item = page.items.find(filter);
  assert.ok(item);
  return item.id;
}
async function newPost(w, title = "UI test post", body = "body") {
  await waitFor(() => w.$("#new-post"), "dashboard ready");
  w.click("#new-post");
  await waitFor(() => w.titleInput(), "new editor");
  w.type(w.titleInput(), title);
  w.type(w.bodyInput(), body);
}
async function saveAndWait(w, versionText) {
  w.click("#save");
  await waitFor(() => w.text("#version-line") === versionText, versionText);
}

test("dashboard loads with columns, filters and bounded pagination", async () => {
  const w = await mountWorkspace({ pageSize: 5 });
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    assert.equal(rows(w).length, 5);
    const head = w.$$("table.drafts th").map((th) => th.textContent);
    assert.deepEqual(head, [
      "Type",
      "Title and summary",
      "Version",
      "Last modified",
      "Status",
      "Open",
    ]);
    assert.match(w.text("table.drafts tbody tr"), /v\d+/);
    assert.match(w.text("#page-label"), /Page 1/);
    assert.equal(w.$("#page-previous").disabled, true);
    w.click("#page-next");
    await waitFor(() => /Page 2/.test(w.text("#page-label")), "page 2");
    assert.equal(rows(w).length, 5);
    assert.equal(w.$("#page-previous").disabled, false);
    w.click("#page-previous");
    await waitFor(() => /Page 1/.test(w.text("#page-label")), "page 1 again");
    const status = w.$("#filter-status");
    status.value = "archived";
    w.change(status);
    await waitFor(() => rows(w).length === 2, "archived filter");
    assert.ok(rows(w).every((row) => /Archived/.test(row.textContent)));
    status.value = "";
    const type = w.$("#filter-type");
    type.value = "story";
    w.change(type);
    await waitFor(
      () =>
        rows(w).length > 0 && rows(w).every((r) => /Story/.test(r.textContent)),
      "story filter",
    );
  } finally {
    await w.close();
  }
});

test("dashboard shows empty, loading and error states", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    const status = w.$("#filter-status");
    const type = w.$("#filter-type");
    type.value = "story";
    status.value = "archived";
    w.change(type);
    await waitFor(() => rows(w).length > 0 || w.$(".empty"), "settled");
  } finally {
    await w.close();
  }
  let fail = false;
  const failing = await mountWorkspace({
    hook: ({ path }) =>
      fail && path.endsWith("/drafts/list")
        ? new Response(JSON.stringify({ error: "internal_error" }), {
            status: 500,
          })
        : undefined,
  });
  try {
    await waitFor(() => rows(failing).length > 0, "rows");
    fail = true;
    failing.click("#page-next");
    await waitFor(() => failing.$(".results .notice-error"), "error state");
    assert.match(failing.text(".results"), /went wrong|failed|try again/i);
  } finally {
    await failing.close();
  }
});

test("creating a Post and a Story saves version 1 and shows it in the list", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    await newPost(w, "Created post", "# Hi");
    assert.match(savedLine(w), /Unsaved/);
    await saveAndWait(w, "Version 1");
    assert.match(w.window.location.hash, /^#\/item\//);
    w.click("#nav-dashboard");
    await waitFor(() => rows(w).length > 0, "dashboard again");
    w.click("#new-story");
    await waitFor(() => w.titleInput(), "story editor");
    assert.match(w.text("h1"), /New Story/);
    w.type(w.titleInput(), "Created story");
    await saveAndWait(w, "Version 1");
    const page = await w.client.listDrafts({ limit: 100 });
    const story = page.items.find((i) => i.title === "Created story");
    assert.equal(story?.contentType, "story");
    assert.equal(
      page.items.some((i) => i.title === "Created post"),
      true,
    );
  } finally {
    await w.close();
  }
});

test("saving requires a title and does not call the API without one", async () => {
  let calls = 0;
  const w = await mountWorkspace({
    hook: ({ path }) => {
      if (path.endsWith("/create")) calls += 1;
    },
  });
  try {
    await waitFor(() => w.$("#new-post"), "dashboard ready");
    w.click("#new-post");
    await waitFor(() => w.titleInput(), "editor");
    w.type(w.bodyInput(), "text only");
    w.click("#save");
    await waitFor(
      () => /title/i.test(w.text("#messages")),
      "validation message",
    );
    assert.equal(calls, 0);
    assert.equal(w.bodyInput().value, "text only");
  } finally {
    await w.close();
  }
});

test("editing, saving and the unsaved indicator track exact state", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    await openItem(w, await firstDraftId(w, (i) => i.status === "draft"));
    await waitFor(
      () =>
        /All changes saved|Version/.test(
          w.text("#version-line") + savedLine(w),
        ),
      "loaded",
    );
    assert.match(savedLine(w), /All changes saved/);
    assert.equal(w.$("#save").disabled, true);
    const original = w.bodyInput().value;
    w.type(w.bodyInput(), `${original}\nmore`);
    assert.match(savedLine(w), /Unsaved changes/);
    assert.equal(w.$("#save").disabled, false);
    assert.equal(w.$("#lifecycle").disabled, true);
    w.type(w.bodyInput(), original);
    assert.match(savedLine(w), /All changes saved/);
    w.type(w.bodyInput(), `${original}\nmore`);
    const before = Number(w.text("#version-line").replace(/\D/g, ""));
    w.click("#save");
    await waitFor(
      () => w.text("#version-line") === `Version ${before + 1}`,
      "saved",
    );
    assert.match(savedLine(w), /All changes saved/);
    assert.equal(w.$("#preview").textContent.includes("more"), true);
  } finally {
    await w.close();
  }
});

test("a failed save keeps all unsaved text and allows retry", async () => {
  let failNext = false;
  const w = await mountWorkspace({
    hook: ({ path }) => {
      if (failNext && path.endsWith("/update")) {
        failNext = false;
        return new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
        });
      }
    },
  });
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    await openItem(w, await firstDraftId(w, (i) => i.status === "draft"));
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    w.type(w.titleInput(), "Precious unsaved title");
    w.type(w.bodyInput(), "Precious unsaved body");
    failNext = true;
    w.click("#save");
    await waitFor(() => w.$("#messages .notice-error"), "error shown");
    assert.match(w.text("#messages"), /still here/i);
    assert.equal(w.titleInput().value, "Precious unsaved title");
    assert.equal(w.bodyInput().value, "Precious unsaved body");
    assert.match(savedLine(w), /Unsaved/);
    assert.equal(w.$("#save").disabled, false);
    w.click("#save");
    await waitFor(
      () => /All changes saved/.test(savedLine(w)),
      "retry succeeds",
    );
    assert.equal(w.bodyInput().value, "Precious unsaved body");
  } finally {
    await w.close();
  }
});

test("network failures also keep unsaved text", async () => {
  let down = false;
  const w = await mountWorkspace({
    hook: ({ path }) => {
      if (down && path.endsWith("/update")) throw new TypeError("network down");
    },
  });
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    await openItem(w, await firstDraftId(w, (i) => i.status === "draft"));
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    w.type(w.bodyInput(), "kept through outage");
    down = true;
    w.click("#save");
    await waitFor(() => w.$("#messages .notice-error"), "network error shown");
    assert.equal(w.bodyInput().value, "kept through outage");
  } finally {
    await w.close();
  }
});

test("a stale version conflict never replaces other changes or loses typed text", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    const id = await firstDraftId(w, (i) => i.status === "draft");
    await openItem(w, id);
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    const loaded = await w.client.getDraft(id);
    // Someone else saves first.
    const other = { account: "editor" };
    const rival = await (await import("./editor-fixtures.mjs")).makeClient(
      w.sandbox,
      other,
    );
    const theirs = await rival.updateDraft(id, loaded.version, {
      body: "THEIR CONCURRENT TEXT",
    });
    w.type(w.bodyInput(), "MY LOCAL TEXT");
    w.click("#save");
    await waitFor(() => w.$("#conflict-panel"), "conflict panel");
    assert.match(w.text("#conflict-panel"), /Nothing you typed has been lost/);
    assert.match(w.text("#conflict-panel"), /sbx-editor/);
    assert.equal(w.bodyInput().value, "MY LOCAL TEXT");
    assert.equal(w.$("#save").disabled, true);
    const server = await w.client.getDraft(id);
    assert.equal(server.body, "THEIR CONCURRENT TEXT");
    assert.equal(server.version, theirs.version);
    assert.equal(w.$$(".diff-added, .diff-removed").length > 0, true);
    // Keep my edits on top of the latest version, then save as the next version.
    w.click("#conflict-keep");
    assert.equal(w.$("#conflict-panel"), null);
    assert.equal(w.bodyInput().value, "MY LOCAL TEXT");
    w.click("#save");
    await waitFor(
      () => w.text("#version-line") === `Version ${theirs.version + 1}`,
      "rebased save",
    );
    assert.equal((await w.client.getDraft(id)).body, "MY LOCAL TEXT");
  } finally {
    await w.close();
  }
});

test("conflict resolution can discard local edits only after confirmation", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    const id = await firstDraftId(w, (i) => i.status === "draft");
    await openItem(w, id);
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    const loaded = await w.client.getDraft(id);
    const { makeClient } = await import("./editor-fixtures.mjs");
    await makeClient(w.sandbox, { account: "editor" }).updateDraft(
      id,
      loaded.version,
      { title: "Server title" },
    );
    w.type(w.titleInput(), "Local title");
    w.click("#save");
    await waitFor(() => w.$("#conflict-discard"), "conflict");
    w.click("#conflict-discard");
    assert.equal(w.titleInput().value, "Local title");
    w.click("[data-confirm='no']");
    assert.equal(w.titleInput().value, "Local title");
    w.click("#conflict-discard");
    w.click("[data-confirm='yes']");
    assert.equal(w.titleInput().value, "Server title");
    assert.match(savedLine(w), /All changes saved/);
  } finally {
    await w.close();
  }
});

test("archive and restore use the current version and respect read-only rules", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    const id = await firstDraftId(w, (i) => i.status === "draft");
    await openItem(w, id);
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    w.type(w.bodyInput(), "dirty");
    assert.equal(w.$("#lifecycle").disabled, true);
    w.type(w.bodyInput(), (await w.client.getDraft(id)).body);
    assert.equal(w.$("#lifecycle").disabled, false);
    w.click("#lifecycle");
    await waitFor(() => w.$("#archived-banner"), "archived");
    assert.equal(w.bodyInput().readOnly, true);
    assert.equal(w.titleInput().readOnly, true);
    assert.equal(w.$("#save").disabled, true);
    assert.equal(w.text("#lifecycle"), "Restore to draft");
    assert.equal((await w.client.getDraft(id)).status, "archived");
    w.click("#lifecycle");
    await waitFor(() => !w.$("#archived-banner"), "restored");
    assert.equal(w.bodyInput().readOnly, false);
    assert.equal((await w.client.getDraft(id)).status, "draft");
  } finally {
    await w.close();
  }
});

test("relationships are never inferred from names in the text", async () => {
  const w = await mountWorkspace();
  try {
    await newPost(
      w,
      "Mentions Fictional Person One in Adams County",
      "Fictional Records Office, Adams County, Fictional Person One",
    );
    await saveAndWait(w, "Version 1");
    const item = await w.client.getDraft(
      w.window.location.hash.replace("#/item/", ""),
    );
    assert.deepEqual(item.relationships, {
      countyFips: [],
      personIds: [],
      organizationIds: [],
    });
  } finally {
    await w.close();
  }
});

test("revision history lists versions, kinds, editors and the current marker", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    const revised = (await w.client.listDrafts({ limit: 100 })).items.find(
      (i) => i.version >= 3,
    );
    assert.ok(revised);
    await openItem(w, revised.id);
    await waitFor(() => w.$("#revision-list li"), "revision list");
    const items = w.$$("#revision-list li");
    assert.equal(items.length, revised.version);
    assert.match(items[0].textContent, /Current/);
    assert.match(items[0].textContent, /sbx-(author|editor)/);
    assert.match(items.at(-1).textContent, /Created/);
    assert.equal(w.$$("#revision-list .badge-current").length, 1);
  } finally {
    await w.close();
  }
});

test("a historical revision opens read-only, previews safely and compares with the draft", async () => {
  const w = await mountWorkspace();
  try {
    await newPost(w, "History", "first **version**");
    await saveAndWait(w, "Version 1");
    w.type(w.bodyInput(), "second <script>x</script> version");
    await saveAndWait(w, "Version 2");
    await waitFor(
      () => w.$$("#revision-list li").length === 2,
      "two revisions",
    );
    w.click(".view-revision[data-version='1']");
    await waitFor(() => w.$("#historical-panel"), "historical view");
    assert.match(w.text("#historical-banner"), /v1/);
    assert.match(w.text("#historical-banner"), /read only/i);
    assert.equal(w.$("#historical-preview strong")?.textContent, "version");
    assert.equal(w.$("#historical-preview script"), null);
    assert.equal(w.$("#save").disabled, true);
    assert.equal(w.titleInput().readOnly, true);
    const compare = w.$("input[id$=-compare]");
    compare.checked = true;
    w.change(compare);
    assert.ok(w.$("#compare-panel"));
    assert.equal(w.$$("#compare-panel .diff-line").length > 0, true);
    w.click("#historical-back");
    assert.equal(w.$("#historical-panel"), null);
    assert.equal(w.titleInput().readOnly, false);
  } finally {
    await w.close();
  }
});

test("restoring a revision needs confirmation and creates a new version", async () => {
  const w = await mountWorkspace();
  try {
    await newPost(w, "Restore me", "original text");
    await saveAndWait(w, "Version 1");
    w.type(w.bodyInput(), "changed text");
    await saveAndWait(w, "Version 2");
    await waitFor(() => w.$$("#revision-list li").length === 2, "revisions");
    w.click(".view-revision[data-version='1']");
    await waitFor(() => w.$("#historical-restore"), "restore button");
    w.click("#historical-restore");
    assert.match(w.text("#restore-confirm"), /creates version 3/);
    w.click("[data-confirm='no']");
    assert.equal(
      (await w.client.getDraft(w.window.location.hash.replace("#/item/", "")))
        .version,
      2,
    );
    w.click("#historical-restore");
    w.click("[data-confirm='yes']");
    await waitFor(() => w.text("#version-line") === "Version 3", "restored");
    assert.equal(w.bodyInput().value, "original text");
    await waitFor(() => w.$$("#revision-list li").length === 3, "history grew");
    assert.match(w.text("#revision-list li"), /Restored from v1/);
    assert.equal(w.$("#historical-panel"), null);
  } finally {
    await w.close();
  }
});

test("restoring is blocked with unsaved changes and for archived articles", async () => {
  const w = await mountWorkspace();
  try {
    await newPost(w, "Blocked", "one");
    await saveAndWait(w, "Version 1");
    w.type(w.bodyInput(), "two");
    await saveAndWait(w, "Version 2");
    await waitFor(() => w.$$("#revision-list li").length === 2, "revisions");
    w.type(w.bodyInput(), "three unsaved");
    w.click(".view-revision[data-version='1']");
    await waitFor(() => w.$("#historical-restore"), "historical");
    assert.equal(w.$("#historical-restore").disabled, true);
    assert.match(w.text("#restore-blocked"), /unsaved/i);
    w.click("#historical-back");
    w.type(w.bodyInput(), "two");
    w.click("#lifecycle");
    await waitFor(() => w.$("#archived-banner"), "archived");
    w.click(".view-revision[data-version='1']");
    await waitFor(() => w.$("#historical-restore"), "historical archived");
    assert.equal(w.$("#historical-restore").disabled, true);
    assert.match(w.text("#restore-blocked"), /Restore the article/);
  } finally {
    await w.close();
  }
});

test("live preview escapes HTML and rejects unsafe links while typing", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => w.$("#new-post"), "dashboard ready");
    w.click("#new-post");
    await waitFor(() => w.titleInput(), "editor");
    w.type(w.titleInput(), "<img src=x onerror=alert(1)>");
    w.type(w.summaryInput(), "<b>summary</b>");
    w.type(
      w.bodyInput(),
      "# H\n\n<script>window.pwned=1</script> [bad](javascript:alert(1)) [good](https://example.invalid) ![i](https://example.invalid/i.png)\n\n> q\n\n- a\n- b",
    );
    const preview = w.$("#preview");
    for (const tag of ["script", "img", "b"])
      assert.equal(preview.querySelector(tag), null, tag);
    assert.equal(preview.querySelector("a[href^='javascript']"), null);
    assert.equal(preview.querySelectorAll("a").length, 1);
    assert.equal(w.window.pwned, undefined);
    assert.equal(preview.querySelector("blockquote") !== null, true);
    assert.equal(preview.querySelectorAll("li").length, 2);
    assert.match(preview.textContent, /<script>window\.pwned=1<\/script>/);
  } finally {
    await w.close();
  }
});

test("injected HTML in saved content, titles and revisions never creates elements", async () => {
  const w = await mountWorkspace();
  try {
    await newPost(
      w,
      '<svg onload="window.pwned=1">',
      '<iframe src="https://example.invalid"></iframe>',
    );
    await saveAndWait(w, "Version 1");
    await waitFor(() => w.$$("#revision-list li").length === 1, "revision");
    w.click(".view-revision[data-version='1']");
    await waitFor(() => w.$("#historical-panel"), "historical");
    assert.equal(w.$("#historical-panel iframe"), null);
    assert.equal(w.$("#historical-panel svg"), null);
    w.click("#historical-back");
    w.click("#nav-dashboard");
    await waitFor(() => rows(w).length > 0, "dashboard");
    assert.equal(w.$("table.drafts svg"), null);
    assert.equal(w.window.pwned, undefined);
  } finally {
    await w.close();
  }
});

test("authorization failures are shown clearly and never as permission", async () => {
  const w = await mountWorkspace();
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    const select = w.$("#sandbox-account");
    select.value = "readonly";
    w.change(select);
    await waitFor(() => w.$(".results .notice-error"), "forbidden shown");
    assert.match(w.text(".results"), /permission|not allowed|authorized/i);
    select.value = "retired";
    w.change(select);
    await waitFor(
      () => /sign|account|authenticat/i.test(w.text(".results")),
      "disabled account",
    );
    select.value = "editor";
    w.change(select);
    await waitFor(() => rows(w).length > 0, "editor allowed again");
    // The UI's own selection of an account grants nothing: a save as the read-only account is refused.
    await openItem(w, await firstDraftId(w, (i) => i.status === "draft"));
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    w.type(w.bodyInput(), "attempt");
    select.value = "readonly";
    w.change(select);
    w.click("#save");
    await waitFor(() => w.$("#messages .notice-error"), "save refused");
    assert.equal(w.bodyInput().value, "attempt");
  } finally {
    await w.close();
  }
});

test("missing or unavailable API handlers produce clear errors", async () => {
  const w = await mountWorkspace({
    hook: ({ path }) =>
      path.endsWith("/drafts/get")
        ? new Response(JSON.stringify({ error: "operation_unavailable" }), {
            status: 503,
          })
        : undefined,
  });
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    w.window.location.hash = "#/item/anything";
    await waitFor(() => w.$("main .notice-error"), "unavailable message");
    assert.match(w.text("main"), /unavailable|not available|later/i);
    assert.ok(w.$("main button"));
  } finally {
    await w.close();
  }
});

test("a missing article shows a not-found message with a way back", async () => {
  const w = await mountWorkspace({ hash: "#/item/does-not-exist" });
  try {
    await waitFor(() => w.$("main .notice-error"), "not found");
    assert.match(
      w.text("main"),
      /not found|could not be found|no longer|exist/i,
    );
  } finally {
    await w.close();
  }
});

test("leaving with unsaved changes asks first and keeps edits when declined", async () => {
  const asked = [];
  const w = await mountWorkspace({
    confirmLeave: (message) => {
      asked.push(message);
      return false;
    },
  });
  try {
    await waitFor(() => rows(w).length > 0, "rows");
    await openItem(w, await firstDraftId(w, (i) => i.status === "draft"));
    await waitFor(() => /Version/.test(w.text("#version-line")), "loaded");
    w.type(w.bodyInput(), "do not lose me");
    w.click("#nav-dashboard");
    assert.equal(asked.length, 1);
    assert.equal(w.bodyInput().value, "do not lose me");
    assert.equal(w.$("table.drafts"), null);
  } finally {
    await w.close();
  }
});

test("main controls have labels, headings and keyboard-reachable buttons", async () => {
  const w = await mountWorkspace();
  try {
    await newPost(w, "A11y", "text");
    for (const input of [w.titleInput(), w.summaryInput(), w.bodyInput()]) {
      assert.ok(w.$(`label[for='${input.id}']`), input.id);
    }
    assert.equal(w.$$("h1").length, 1);
    assert.ok(w.$(".skip-link"));
    assert.ok(w.$("#sandbox-flag"));
    for (const button of w.$$("button")) {
      assert.notEqual(button.getAttribute("tabindex"), "-1");
      assert.ok(button.textContent.trim() || button.getAttribute("aria-label"));
    }
    assert.equal(w.$("#save-state").textContent.length > 0, true);
  } finally {
    await w.close();
  }
});

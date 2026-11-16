import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createEditorApiClient } from "../dist/editor/api-client.js";
import { createDashboardClient } from "../dist/editor/dashboard-client.js";
import {
  mountSandboxDashboard,
  sandboxHeaders,
} from "../dist/editor/dashboard-sandbox.js";
import {
  accountView,
  createPostsView,
  overviewView,
} from "../dist/editor/dashboard-views.js";
import {
  ORIGIN,
  sandboxFetch,
  startSandbox,
  waitFor,
} from "./editor-fixtures.mjs";

const ACCOUNTS = [
  { key: "author", label: "Avery Author (editor)" },
  { key: "editor", label: "Eli Editor (editor)" },
  { key: "readonly", label: "Riley Reader (contributor)" },
  { key: "owner", label: "Olive Owner (owner)" },
  { key: "retired", label: "Rene Retired (disabled account)" },
  { key: "anonymous", label: "Signed-out visitor" },
];

/** Mounts the real dashboard shell over the real sandbox in jsdom. */
async function mountShell({
  account = "author",
  hash = "",
  hook,
  sandbox: given,
  confirmLeave,
} = {}) {
  const sandbox = given ?? (await startSandbox());
  const dom = new JSDOM("<!doctype html><body><div id=app></div></body>", {
    url: `${ORIGIN}/${hash}`,
  });
  const { window } = dom;
  const session = { account };
  const connection = {
    fetch: sandboxFetch(sandbox, hook),
    token: sandbox.token,
    account: () => session.account,
  };
  const dashboard = mountSandboxDashboard(
    window.document.getElementById("app"),
    {
      doc: window.document,
      client: createDashboardClient({
        fetch: connection.fetch,
        headers: sandboxHeaders(connection),
      }),
      publicSiteUrl: "http://127.0.0.1:8790/",
      views: {
        overview: overviewView,
        account: accountView,
        posts: createPostsView({
          client: createEditorApiClient(connection),
          session,
          previewDelayMs: 0,
          searchDelayMs: 0,
          ...(confirmLeave ? { confirmLeave } : {}),
        }),
      },
      sandbox: {
        accounts: ACCOUNTS,
        current: () => session.account,
        switchTo: (key) => {
          session.account = key;
        },
      },
    },
  );
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const text = (selector) => $(selector)?.textContent ?? "";
  return {
    sandbox,
    window,
    session,
    $,
    $$,
    text,
    nav: () => $$("#dash-sidebar a[data-view]").map((a) => a.textContent),
    go: (target) => {
      window.location.hash = target;
    },
    type(element, value) {
      element.value = value;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    click(target) {
      const element = typeof target === "string" ? $(target) : target;
      if (!element) throw new Error(`Missing element: ${target}`);
      element.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    },
    key(name) {
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: name, bubbles: true }),
      );
    },
    switchAccount(key) {
      const select = $("#sandbox-account");
      select.value = key;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    close() {
      dashboard.destroy();
      window.close();
      if (!given) sandbox.close();
    },
  };
}

const draftId = (sandbox, title) =>
  sandbox.database
    .prepare("SELECT id FROM content_items WHERE title = ?")
    .get(title).id;

test("a contributor reaches Overview and My Account and nothing else", async () => {
  const d = await mountShell({ account: "readonly" });
  try {
    await waitFor(() => d.$("#overview-heading"), "overview");
    assert.deepEqual(d.nav(), ["Overview", "My Account"]);
    assert.equal(d.text("#overview-heading"), "Welcome, Riley Reader");
    assert.ok(d.$("#overview-no-staff-tools"));
    assert.equal(d.$("#overview-editorial"), null);
    assert.equal(d.$("#overview-planned"), null);
    assert.equal(/Fictional|Lorem/.test(d.text("#main")), false);
    assert.equal(
      d.$("#dash-sidebar a[aria-current=page]").textContent,
      "Overview",
    );

    d.click("#account-menu-button");
    assert.equal(d.$("#account-menu").hidden, false);
    d.go(d.$("#menu-account").getAttribute("href"));
    await waitFor(() => d.$("#account-heading"), "my account");
    assert.equal(d.$("#account-menu").hidden, true);
    assert.match(d.text("#account-profile"), /Riley Reader/);
    assert.match(d.text("#account-profile"), /reader@example\.invalid/);
    assert.match(d.text("#account-profile"), /Contributor/);
    assert.match(d.text("#account-sign-in"), /Used for this session/);
    assert.equal(
      d.$("#dash-sidebar a[aria-current=page]").textContent,
      "My Account",
    );
    assert.match(d.window.document.title, /^My Account - /);
    // Self-view offers no edit control of any kind.
    assert.equal(d.$$("#main input, #main button, #main select").length, 0);
    assert.ok(d.$("#account-edit-note"));

    // A direct request to a restricted view is refused by the server.
    d.go("#/posts/new/post");
    await waitFor(() => d.$("#state-denied"), "denied");
    assert.equal(d.$("#editor-host"), null);
    assert.equal(d.$("#save"), null);
    d.go("#/banners");
    await waitFor(() => d.$("#state-denied"), "banners needs banner.manage");
    d.go("#/<script>");
    await waitFor(
      () => /Page not found/.test(d.text("#main")),
      "malformed address",
    );
  } finally {
    d.close();
  }
});

test("an editor sees Posts & Stories with listing, filters and recent drafts", async () => {
  const d = await mountShell();
  try {
    await waitFor(() => d.$("#overview-recent"), "recent drafts");
    assert.deepEqual(d.nav(), ["Overview", "My Account", "Posts & Stories"]);
    assert.equal(d.$$("#overview-recent li").length, 5);
    assert.match(d.text("#overview-planned"), /Reports/);
    assert.equal(/Banners|Accounts/.test(d.text("#overview-planned")), false);

    d.go("#/posts");
    await waitFor(() => d.$$("table.drafts tbody tr").length > 0, "list");
    assert.equal(d.$$("table.drafts tbody tr").length, 10);
    assert.equal(d.$$("h1").length, 1);
    assert.equal(
      d.$("#dash-sidebar a[aria-current=page]").textContent,
      "Posts & Stories",
    );
    assert.match(d.text("table.drafts"), /Lorem ipsum/);
    assert.match(
      d.$("table.drafts a.open-link").getAttribute("href"),
      /^#\/posts\/item\//,
    );
    const type = d.$("#filter-type");
    type.value = "story";
    type.dispatchEvent(new d.window.Event("change", { bubbles: true }));
    await waitFor(
      () => /type: Stories/.test(d.text("#list-summary")),
      "filtered",
    );
    await waitFor(
      () =>
        d.$$("table.drafts .badge-story").length > 0 &&
        d.$$("table.drafts .badge-post").length === 0,
      "stories only",
    );
  } finally {
    d.close();
  }
});

test("a stale save in a second editor view keeps both the newer revision and the typed text", async () => {
  const sandbox = await startSandbox();
  const id = draftId(sandbox, "Fictional Post 13");
  const first = await mountShell({
    sandbox,
    account: "author",
    hash: `#/posts/item/${id}`,
  });
  const second = await mountShell({
    sandbox,
    account: "editor",
    hash: `#/posts/item/${id}`,
  });
  const title = (d) => d.$("input[id$=-title]");
  const body = (d) => d.$("textarea[id$=-body]");
  try {
    for (const d of [first, second]) {
      await waitFor(
        () => d.text("#version-line") === "Version 1",
        "both views load version 1",
      );
    }
    // The first view saves a change.
    first.type(title(first), "Fictional Post 13 - first editor change");
    first.click("#save");
    await waitFor(() => first.text("#version-line") === "Version 2", "v2");

    // The second view still holds version 1 and saves different edits.
    const typed = `${body(second).value}\n\nSecond editor paragraph.`;
    second.type(body(second), typed);
    second.click("#save");
    await waitFor(() => second.$("#conflict-panel"), "conflict shown");

    // The newer stored revision survives untouched.
    const stored = sandbox.database
      .prepare(
        "SELECT title, version, last_edited_by_account_id AS editor FROM content_items WHERE id = ?",
      )
      .get(id);
    assert.deepEqual(
      { ...stored },
      {
        title: "Fictional Post 13 - first editor change",
        version: 2,
        editor: "sbx-author",
      },
    );
    // The second editor's unsaved text is preserved and nothing is saved.
    assert.equal(body(second).value, typed);
    assert.equal(second.text("#save-state"), "Unsaved changes");
    assert.equal(second.$("#save").disabled, true);
    assert.match(second.text("#conflict-panel"), /Version 2 was saved by/);
    assert.match(second.text("#conflict-panel"), /body, title/);
    assert.ok(second.$("#conflict-panel [data-kind=added]"));

    // Review, keep the edits on the latest version, and save a new version.
    second.click("#conflict-keep");
    assert.equal(second.$("#conflict-panel"), null);
    assert.equal(second.text("#version-line"), "Version 2");
    assert.equal(body(second).value, typed);
    second.click("#save");
    await waitFor(() => second.text("#version-line") === "Version 3", "v3");

    // Recovery through revision history: every version is still there.
    await waitFor(
      () => second.$$("#revision-list li").length === 3,
      "three revisions",
    );
    assert.match(
      second.text("#revision-list li[data-version='2']"),
      /sbx-author/,
    );
    assert.match(
      second.text("#revision-list li[data-version='3']"),
      /sbx-editor/,
    );
    second.click("#revision-list li[data-version='2'] .view-revision");
    await waitFor(() => second.$("#historical-panel"), "revision 2 opens");
    assert.equal(
      second.text("#historical-panel h2"),
      "Fictional Post 13 - first editor change",
    );
    assert.equal(second.$("#historical-restore").disabled, false);
    second.click("#historical-restore");
    second.click("#restore-confirm [data-confirm=yes]");
    await waitFor(() => second.text("#version-line") === "Version 4", "v4");
    assert.equal(
      title(second).value,
      "Fictional Post 13 - first editor change",
    );
    const revisions = sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM content_revisions WHERE content_id = ?",
      )
      .get(id).n;
    assert.equal(revisions, 4);
  } finally {
    first.close();
    second.close();
    sandbox.close();
  }
});

test("leaving Posts & Stories with unsaved text asks first, for navigation and for the account switch", async () => {
  const answers = [];
  let allow = false;
  const d = await mountShell({
    hash: "#/posts/new/post",
    confirmLeave: (message) => {
      answers.push(message);
      return allow;
    },
  });
  try {
    await waitFor(() => d.$("input[id$=-title]"), "new post editor");
    d.type(d.$("input[id$=-title]"), "Unsaved fictional title");

    d.go("#/account");
    await waitFor(() => answers.length === 1, "asked on navigation");
    await waitFor(
      () => d.window.location.hash === "#/posts/new/post",
      "address restored",
    );
    assert.equal(d.$("input[id$=-title]").value, "Unsaved fictional title");
    assert.equal(d.$("#account-heading"), null);

    d.switchAccount("readonly");
    assert.equal(answers.length, 2);
    assert.equal(d.session.account, "author");
    assert.equal(d.$("#sandbox-account").value, "author");
    assert.equal(d.$("input[id$=-title]").value, "Unsaved fictional title");

    allow = true;
    d.go("#/account");
    await waitFor(() => d.$("#account-heading"), "leaves once confirmed");
    assert.equal(d.$("#editor-host"), null);
  } finally {
    d.close();
  }
});

test("signed-out and disabled accounts see no navigation, data or account menu", async () => {
  const d = await mountShell({ account: "anonymous", hash: "#/posts" });
  try {
    await waitFor(() => d.$("#state-signed-out"), "signed out");
    assert.deepEqual(d.nav(), []);
    assert.equal(d.$("#account-menu-button"), null);
    assert.equal(d.text("#signed-out"), "Not signed in");
    assert.equal(/Fictional|Avery|Lorem/.test(d.text(".dash-body")), false);

    d.switchAccount("retired");
    await waitFor(() => d.session.account === "retired", "switched");
    await waitFor(() => d.$("#state-signed-out"), "disabled is signed out");
    assert.deepEqual(d.nav(), []);

    d.switchAccount("owner");
    await waitFor(() => d.$$("table.drafts tbody tr").length > 0, "owner list");
    assert.deepEqual(d.nav(), [
      "Overview",
      "My Account",
      "Posts & Stories",
      "Banners",
    ]);
    d.go("#/overview");
    await waitFor(() => d.$("#overview-planned"), "owner overview");
    assert.match(
      d.text("#overview-planned"),
      /Reports.*Accounts.*Audit.*System Status/s,
    );
    assert.equal(d.$$("#overview-planned a").length, 0);

    // Switching to a role without access closes the restricted view.
    d.go("#/posts");
    await waitFor(() => d.$("#editor-host"), "posts open");
    d.switchAccount("readonly");
    await waitFor(() => d.$("#state-denied"), "denied after switch");
    assert.equal(d.$("#editor-host"), null);
    assert.deepEqual(d.nav(), ["Overview", "My Account"]);
  } finally {
    d.close();
  }
});

test("loading failures and empty lists have clear states and a retry", async () => {
  let failViews = true;
  let emptyRecent = false;
  const d = await mountShell({
    hook: (call) => {
      if (call.path !== "/internal/dashboard/views/get") return undefined;
      if (failViews) return Promise.reject(new Error("offline"));
      if (emptyRecent) {
        return d.sandbox
          .fetch(
            new Request(`${ORIGIN}${call.path}`, {
              method: "POST",
              headers: call.init.headers,
              body: call.init.body,
            }),
          )
          .then(async (response) => {
            const data = await response.json();
            return new Response(
              JSON.stringify({ ...data, editorial: { recent: [] } }),
              { status: 200 },
            );
          });
      }
      return undefined;
    },
  });
  try {
    await waitFor(() => d.$("#state-error"), "error state");
    assert.match(d.text("#state-error"), /could not be reached/);
    // The chrome still reflects the server session while the view fails.
    assert.deepEqual(d.nav(), ["Overview", "My Account", "Posts & Stories"]);
    failViews = false;
    emptyRecent = true;
    d.click("#dash-retry");
    await waitFor(() => d.$("#overview-recent-empty"), "empty state");
    assert.equal(d.$("#overview-recent"), null);
  } finally {
    d.close();
  }

  const down = await mountShell({
    hook: (call) =>
      call.path === "/internal/dashboard/session"
        ? new Response('{"error":"internal_error"}', { status: 500 })
        : undefined,
  });
  try {
    await waitFor(() => down.$("#state-error"), "session error");
    assert.deepEqual(down.nav(), []);
    assert.ok(down.$("#dash-retry"));
  } finally {
    down.close();
  }
});

test("the shell is labelled and usable from the keyboard", async () => {
  const d = await mountShell();
  try {
    await waitFor(() => d.$("#overview-heading"), "overview");
    assert.equal(d.$(".skip-link").getAttribute("href"), "#main");
    assert.equal(d.$("#dash-sidebar").getAttribute("aria-label"), "Dashboard");
    assert.equal(d.$("#main").getAttribute("tabindex"), "-1");
    assert.equal(d.window.document.activeElement, d.$("#main"));
    assert.equal(d.$$("h1").length, 1);
    assert.ok(d.$("label[for=sandbox-account]"));
    assert.equal(
      d.$("#public-site-link").getAttribute("href"),
      "http://127.0.0.1:8790/",
    );
    // Every navigation entry is a real link, so it works without scripting.
    for (const anchor of d.$$("#dash-sidebar a[data-view]")) {
      assert.match(anchor.getAttribute("href"), /^#\/[a-z]+$/);
    }

    const toggle = d.$("#dash-menu-toggle");
    assert.equal(toggle.getAttribute("aria-controls"), "dash-sidebar");
    d.click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    d.key("Escape");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(d.window.document.activeElement, toggle);

    const button = d.$("#account-menu-button");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    d.click(button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.match(d.text("#account-menu"), /Avery Author.*Editor/s);
    d.key("Escape");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(d.$("#account-menu").hidden, true);
    assert.equal(d.window.document.activeElement, button);
    d.click(button);
    d.click("#main");
    assert.equal(d.$("#account-menu").hidden, true);

    // Moving to a view moves focus to the page and announces it.
    d.go("#/account");
    await waitFor(() => d.$("#account-heading"), "account");
    assert.equal(d.window.document.activeElement, d.$("#main"));
    assert.equal(
      d.text("[role=status][aria-live=polite]"),
      "My Account loaded",
    );
    assert.equal(d.window.localStorage.length, 0);
    assert.equal(d.window.sessionStorage.length, 0);
  } finally {
    d.close();
  }
});

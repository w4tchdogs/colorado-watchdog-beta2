import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createEditorApiClient } from "../dist/editor/api-client.js";
import { mountDashboard } from "../dist/editor/dashboard.js";
import { createDashboardClient } from "../dist/editor/dashboard-client.js";
import {
  accountView,
  createPostsView,
  overviewView,
} from "../dist/editor/dashboard-views.js";
import worker from "../dist/server/index.js";
import {
  cookieJar,
  count,
  createWorld,
  idToken,
  installUpstream,
  ORIGIN,
  request,
} from "./auth-fixtures.mjs";

// Draft editing for Posts & Stories on the bundled Worker, over a disposable
// migrated Website D1 and a synthetic sign-in tenant. Every title, body and
// account below is fictional.

let codeCounter = 0;
const LOGIN = "/auth/login?return_to=%2Fdashboard";
const EDITOR = "github|synthetic-editor";
const ADMIN = "github|synthetic-admin";
const CONTRIBUTOR = "github|synthetic-contributor";

function send(world, path, options = {}) {
  const { jar, headers = {}, ...rest } = options;
  const cookie = jar?.header();
  return worker.fetch(
    request(world, path, {
      ...rest,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    }),
    world.env,
  );
}

async function signedIn(world, subject) {
  const jar = cookieJar();
  const login = await send(world, LOGIN, { jar });
  jar.absorb(login);
  const authorize = new URL(login.headers.get("location"));
  codeCounter += 1;
  const code = `content-code-${codeCounter}`;
  const nonce = authorize.searchParams.get("nonce");
  world.codes.set(code, {
    idToken: () => idToken(world, { sub: subject, nonce }),
  });
  const state = authorize.searchParams.get("state");
  const callback = await send(
    world,
    `/auth/callback?code=${code}&state=${state}`,
    { jar },
  );
  jar.absorb(callback);
  assert.equal(callback.status, 302, subject);
  return jar;
}

async function withWorld(callback) {
  const world = await createWorld();
  const restore = installUpstream(world);
  try {
    await callback(world);
  } finally {
    restore();
    world.database.close();
  }
}

const sameOrigin = { origin: ORIGIN, "content-type": "application/json" };

/** Posts to a draft route and returns status and parsed body. */
async function call(world, jar, path, body = {}, headers = sameOrigin) {
  const response = await send(world, path, {
    method: "POST",
    jar,
    headers,
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await response.clone().json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, response };
}

const DRAFTS = "/internal/content/drafts";
const REVISIONS = "/internal/content/revisions";

const DRAFT_ROUTES = [
  [`${DRAFTS}/create`, { contentType: "post", title: "Nope" }],
  [`${DRAFTS}/get`, { id: "x" }],
  [`${DRAFTS}/list`, {}],
  [
    `${DRAFTS}/update`,
    { id: "x", expectedVersion: 1, changes: { title: "N" } },
  ],
  [
    `${DRAFTS}/relationships`,
    { id: "x", expectedVersion: 1, relationships: { countyFips: ["08001"] } },
  ],
  [`${DRAFTS}/archive`, { id: "x", expectedVersion: 1 }],
  [`${DRAFTS}/restore`, { id: "x", expectedVersion: 1 }],
  [`${REVISIONS}/list`, { id: "x" }],
  [`${REVISIONS}/get`, { id: "x", version: 1 }],
  [`${REVISIONS}/restore`, { id: "x", expectedVersion: 2, revisionVersion: 1 }],
];

test("callers without editorial access cannot reach any draft route", async () => {
  await withWorld(async (world) => {
    const before = {
      items: count(world, "content_items"),
      revisions: count(world, "content_revisions"),
      audit: count(world, "audit_events"),
    };
    const contributor = await signedIn(world, CONTRIBUTOR);
    const stale = cookieJar();
    stale.cookies.set("__Host-wd-session", "not-a-real-session");
    for (const [path, body] of DRAFT_ROUTES) {
      const signedOut = await call(world, null, path, body);
      assert.equal(signedOut.status, 401, `signed out ${path}`);
      assert.deepEqual(signedOut.body, { error: "authentication_required" });
      assert.equal((await call(world, stale, path, body)).status, 401, path);
      const refused = await call(world, contributor, path, body);
      assert.equal(refused.status, 403, `contributor ${path}`);
      assert.deepEqual(refused.body, { error: "forbidden" });
      // An agent credential never falls back to the cookie.
      const agent = await call(world, contributor, path, body, {
        ...sameOrigin,
        authorization: "Bearer not-a-real-credential",
      });
      assert.equal(agent.status, 401, `agent ${path}`);
    }
    // A cookie write from another origin is refused before any route runs.
    const editor = await signedIn(world, EDITOR);
    const crossOrigin = await call(
      world,
      editor,
      `${DRAFTS}/create`,
      { contentType: "post", title: "Cross origin" },
      {
        origin: "https://elsewhere.example.test",
        "content-type": "application/json",
      },
    );
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(crossOrigin.body, { error: "origin_rejected" });
    // Nothing was written by any refused call.
    assert.deepEqual(
      {
        items: count(world, "content_items"),
        revisions: count(world, "content_revisions"),
        audit: count(world, "audit_events"),
      },
      before,
    );
  });
});

test("the hosted draft routes serve every editorial action to an editor and keep every record", async () => {
  await withWorld(async (world) => {
    const editor = await signedIn(world, EDITOR);
    const admin = await signedIn(world, ADMIN);

    // Create a Post and a Story with synthetic text.
    const post = await call(world, editor, `${DRAFTS}/create`, {
      contentType: "post",
      title: "Synthetic Post One",
      summary: "A fictional summary.",
      body: "# Heading\n\nFictional **body** text.",
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.version, 1);
    assert.equal(post.body.status, "draft");
    assert.equal(post.body.lastEditedByAccountId, "h-editor");
    const story = await call(world, admin, `${DRAFTS}/create`, {
      contentType: "story",
      title: "Synthetic Story One",
      body: "Once upon a fictional time.",
    });
    assert.equal(story.status, 201);
    const id = post.body.id;

    // List and get.
    const list = await call(world, editor, `${DRAFTS}/list`, {
      sort: "modified",
    });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((item) => item.title).sort(), [
      "Synthetic Post One",
      "Synthetic Story One",
    ]);
    assert.equal("body" in list.body.items[0], false);
    const filtered = await call(world, editor, `${DRAFTS}/list`, {
      contentType: "story",
      search: "synthetic",
    });
    assert.deepEqual(
      filtered.body.items.map((item) => item.id),
      [story.body.id],
    );
    const got = await call(world, editor, `${DRAFTS}/get`, { id });
    assert.equal(got.body.body, "# Heading\n\nFictional **body** text.");
    assert.equal(
      (await call(world, editor, `${DRAFTS}/get`, { id: "missing" })).status,
      404,
    );

    // Update, then a stale write is refused and changes nothing.
    const updated = await call(world, editor, `${DRAFTS}/update`, {
      id,
      expectedVersion: 1,
      changes: { title: "Synthetic Post One, edited", body: "Edited body." },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);
    const revisionsBefore = count(world, "content_revisions");
    const auditBefore = count(world, "audit_events");
    const stale = await call(world, admin, `${DRAFTS}/update`, {
      id,
      expectedVersion: 1,
      changes: { body: "Typed against version 1." },
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { error: "version_conflict" });
    assert.equal(count(world, "content_revisions"), revisionsBefore);
    assert.equal(count(world, "audit_events"), auditBefore);
    const stored = world.database
      .prepare("SELECT body, version FROM content_items WHERE id = ?")
      .get(id);
    assert.deepEqual({ ...stored }, { body: "Edited body.", version: 2 });

    // Relationships use real counties and refuse unknown targets.
    const related = await call(world, editor, `${DRAFTS}/relationships`, {
      id,
      expectedVersion: 2,
      relationships: { countyFips: ["08001", "08003"] },
    });
    assert.equal(related.status, 200);
    assert.deepEqual(related.body.relationships.countyFips, ["08001", "08003"]);
    assert.equal(related.body.version, 3);
    const unknown = await call(world, editor, `${DRAFTS}/relationships`, {
      id,
      expectedVersion: 3,
      relationships: { personIds: ["no-such-person"] },
    });
    assert.equal(unknown.status, 422);
    assert.equal(
      world.database
        .prepare("SELECT version FROM content_items WHERE id = ?")
        .get(id).version,
      3,
    );

    // Archive, edits are refused while archived, then restore.
    const archived = await call(world, editor, `${DRAFTS}/archive`, {
      id,
      expectedVersion: 3,
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.status, "archived");
    assert.notEqual(archived.body.archivedAt, null);
    const blocked = await call(world, editor, `${DRAFTS}/update`, {
      id,
      expectedVersion: 4,
      changes: { title: "Blocked" },
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body, { error: "invalid_state" });
    const restored = await call(world, editor, `${DRAFTS}/restore`, {
      id,
      expectedVersion: 4,
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, "draft");
    assert.equal(restored.body.archivedAt, null);
    assert.equal(restored.body.version, 5);

    // Revision history lists every version and restoring copies an old one.
    const revisions = await call(world, editor, `${REVISIONS}/list`, { id });
    assert.deepEqual(
      revisions.body.items.map((item) => [item.version, item.changeKind]),
      [
        [5, "restore_draft"],
        [4, "archive"],
        [3, "relationships"],
        [2, "update"],
        [1, "create"],
      ],
    );
    const first = await call(world, editor, `${REVISIONS}/get`, {
      id,
      version: 1,
    });
    assert.equal(first.body.title, "Synthetic Post One");
    assert.deepEqual(first.body.relationships.countyFips, []);
    const rolledBack = await call(world, admin, `${REVISIONS}/restore`, {
      id,
      expectedVersion: 5,
      revisionVersion: 1,
    });
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.version, 6);
    assert.equal(rolledBack.body.title, "Synthetic Post One");
    assert.equal(rolledBack.body.body, "# Heading\n\nFictional **body** text.");
    assert.deepEqual(rolledBack.body.relationships.countyFips, []);
    const last = await call(world, editor, `${REVISIONS}/get`, {
      id,
      version: 6,
    });
    assert.equal(last.body.changeKind, "restore_revision");
    assert.equal(last.body.restoredFromVersion, 1);
    assert.equal(last.body.editedByAccountId, "h-admin");

    // One revision per version and one audit event per change, none with text.
    assert.equal(count(world, "content_revisions", `content_id = '${id}'`), 6);
    const events = world.database
      .prepare(
        "SELECT action, details_json, actor_account_id FROM audit_events WHERE target_id = ? ORDER BY created_at, rowid",
      )
      .all(id);
    assert.deepEqual(
      events.map((event) => event.action),
      [
        "content.create",
        "content.update",
        "content.relationships.set",
        "content.archive",
        "content.restore",
        "content.revision.restore",
      ],
    );
    for (const event of events)
      assert.doesNotMatch(
        event.details_json,
        /Fictional|Synthetic|Edited body/,
      );

    // A published article cannot be archived, as in the local service.
    world.database
      .prepare(
        `INSERT INTO content_publications
           (content_id, content_type, slug, revision_version, version, published_at, published_by_account_id, metadata_json)
         VALUES (?, 'post', 'synthetic-post-one', 6, 1, '2026-11-17T00:00:00.000Z', 'h-editor', '{"byline":"Synthetic"}')`,
      )
      .run(id);
    const refused = await call(world, editor, `${DRAFTS}/archive`, {
      id,
      expectedVersion: 6,
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: "invalid_state" });
  });
});

/** Mounts the hosted dashboard in jsdom against the real Worker. */
function mountHosted(world, jar, hash) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: `${ORIGIN}/dashboard${hash ?? ""}`,
  });
  const { window } = dom;
  const headersSeen = [];
  const fetchLike = async (input, init) => {
    headersSeen.push(Object.keys(init.headers ?? {}));
    return send(world, input, {
      method: init.method,
      jar,
      headers: { origin: ORIGIN, ...init.headers },
      body: init.body,
    });
  };
  const dashboard = mountDashboard(window.document.getElementById("app"), {
    doc: window.document,
    client: createDashboardClient({ fetch: fetchLike }),
    publicSiteUrl: "/",
    views: {
      overview: overviewView,
      account: accountView,
      posts: createPostsView({
        client: createEditorApiClient({ fetch: fetchLike }),
        session: { account: "" },
        previewDelayMs: 0,
        searchDelayMs: 0,
        confirmLeave: () => true,
      }),
    },
    signOut: { action: "/auth/logout" },
  });
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  return {
    window,
    $,
    $$,
    headersSeen,
    text: (selector) => $(selector)?.textContent ?? "",
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
    close() {
      dashboard.destroy();
      window.close();
    },
  };
}

async function waitFor(check, label) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const titleInput = (d) => d.$("input[id$=-title]");
const bodyInput = (d) => d.$("textarea[id$=-body]");

test("an editor creates, previews, saves, archives and restores a draft that survives a reload", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, EDITOR);
    const first = mountHosted(world, jar, "#/posts/new/post");
    let id;
    try {
      await waitFor(() => titleInput(first), "new draft form");
      first.type(titleInput(first), "Synthetic Reload Post");
      first.type(bodyInput(first), "A **fictional** reload body.");
      await waitFor(
        () =>
          /<strong>fictional<\/strong>/.test(first.$("#preview")?.innerHTML),
        "live preview",
      );
      first.click("#save");
      await waitFor(() => first.text("#version-line") === "Version 1", "v1");
      id = world.database
        .prepare("SELECT id FROM content_items WHERE title = ?")
        .get("Synthetic Reload Post").id;
      // The hosted client never sends a sandbox header.
      for (const names of first.headersSeen)
        assert.deepEqual(
          names.filter((name) => /editor|test-human/i.test(name)),
          [],
        );
      assert.equal(first.$("#sandbox-bar"), null);
    } finally {
      first.close();
    }

    // A reload is a new page with nothing in memory: only the Worker and D1.
    const reloaded = mountHosted(world, jar, `#/posts/item/${id}`);
    try {
      await waitFor(
        () => reloaded.text("#version-line") === "Version 1",
        "reload",
      );
      assert.equal(titleInput(reloaded).value, "Synthetic Reload Post");
      assert.equal(bodyInput(reloaded).value, "A **fictional** reload body.");
      assert.match(
        reloaded.$("#preview").innerHTML,
        /<strong>fictional<\/strong>/,
      );

      reloaded.go("#/posts");
      await waitFor(
        () => /Synthetic Reload Post/.test(reloaded.text("table.drafts")),
        "listing",
      );

      reloaded.go(`#/posts/item/${id}`);
      await waitFor(
        () => reloaded.$("#lifecycle") && !reloaded.$("#lifecycle").hidden,
        "editor",
      );
      reloaded.click("#lifecycle");
      await waitFor(() => reloaded.$("#archived-banner"), "archived");
      assert.equal(reloaded.text("#lifecycle"), "Restore to draft");
      reloaded.click("#lifecycle");
      await waitFor(() => !reloaded.$("#archived-banner"), "restored");
      await waitFor(
        () => reloaded.$$("#revision-list li").length === 3,
        "history shows create, archive and restore",
      );
    } finally {
      reloaded.close();
    }
    assert.equal(count(world, "content_revisions", `content_id = '${id}'`), 3);
  });
});

test("a stale save keeps the typed edits and recovers through the conflict panel", async () => {
  await withWorld(async (world) => {
    const editorJar = await signedIn(world, EDITOR);
    const adminJar = await signedIn(world, ADMIN);
    const created = await call(world, editorJar, `${DRAFTS}/create`, {
      contentType: "story",
      title: "Synthetic Conflict Story",
      body: "Original fictional body.",
    });
    const id = created.body.id;
    const first = mountHosted(world, editorJar, `#/posts/item/${id}`);
    const second = mountHosted(world, adminJar, `#/posts/item/${id}`);
    try {
      for (const d of [first, second])
        await waitFor(() => d.text("#version-line") === "Version 1", "v1");
      first.type(titleInput(first), "Synthetic Conflict Story, first change");
      first.click("#save");
      await waitFor(() => first.text("#version-line") === "Version 2", "v2");

      const typed = `${bodyInput(second).value}\n\nSecond editor paragraph.`;
      second.type(bodyInput(second), typed);
      second.click("#save");
      await waitFor(() => second.$("#conflict-panel"), "conflict");
      assert.equal(bodyInput(second).value, typed);
      assert.equal(second.text("#save-state"), "Unsaved changes");
      assert.match(second.text("#conflict-panel"), /Version 2 was saved by/);
      assert.deepEqual(
        {
          ...world.database
            .prepare("SELECT title, version FROM content_items WHERE id = ?")
            .get(id),
        },
        { title: "Synthetic Conflict Story, first change", version: 2 },
      );

      second.click("#conflict-keep");
      assert.equal(bodyInput(second).value, typed);
      second.click("#save");
      await waitFor(() => second.text("#version-line") === "Version 3", "v3");
      assert.equal(
        world.database
          .prepare("SELECT body FROM content_items WHERE id = ?")
          .get(id).body,
        typed,
      );
      assert.equal(
        count(world, "content_revisions", `content_id = '${id}'`),
        3,
      );
    } finally {
      first.close();
      second.close();
    }
  });
});

test("a contributor cannot open the Posts & Stories tab or its drafts", async () => {
  await withWorld(async (world) => {
    const editor = await signedIn(world, EDITOR);
    const created = await call(world, editor, `${DRAFTS}/create`, {
      contentType: "post",
      title: "Synthetic Private Draft",
      body: "Fictional private body.",
    });
    const id = created.body.id;
    const contributor = await signedIn(world, CONTRIBUTOR);
    const d = mountHosted(world, contributor, `#/posts/item/${id}`);
    try {
      await waitFor(() => d.$("#state-denied"), "denied");
      assert.equal(d.$("#editor-host"), null);
      assert.equal(d.$("#save"), null);
      assert.equal(
        d
          .$$("#dash-sidebar a[data-view]")
          .some((a) => /Posts/.test(a.textContent)),
        false,
      );
      assert.doesNotMatch(
        d.window.document.body.textContent,
        /Synthetic Private Draft/,
      );
    } finally {
      d.close();
    }
    const direct = await call(world, contributor, `${DRAFTS}/get`, { id });
    assert.equal(direct.status, 403);
    assert.doesNotMatch(JSON.stringify(direct.body), /Synthetic|Fictional/);
    const view = await call(
      world,
      contributor,
      "/internal/dashboard/views/get",
      {
        view: "posts",
      },
    );
    assert.equal(view.status, 403);
  });
});

test("deployments without sign-in or a database refuse every draft route", async () => {
  await withWorld(async (world) => {
    for (const env of [
      {},
      { DB: world.d1 },
      { ...world.env, AUTH0_ENABLED: "false" },
    ]) {
      for (const [path, body] of DRAFT_ROUTES) {
        const response = await worker.fetch(
          request(world, path, {
            method: "POST",
            headers: sameOrigin,
            body: JSON.stringify(body),
          }),
          env,
        );
        assert.equal(response.status, 401, path);
      }
    }
  });
});

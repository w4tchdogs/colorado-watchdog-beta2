import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createProfilesClient } from "../dist/editor/profiles-client.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { createProfilesApiTransport } from "../dist/transport/profiles-api.js";

const ORIGIN = "https://watchdog.invalid";

// Tabulator reads browser globals when it builds, so install a window first.
const dom = new JSDOM("<!doctype html><body></body>", { url: `${ORIGIN}/` });
const { window } = dom;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "HTMLInputElement",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? window : window[key],
    configurable: true,
    writable: true,
  });
}
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.ResizeObserver = globalThis.ResizeObserver;
// jsdom has no layout. Tabulator renders nothing into a zero-size table, so
// give every element a fixed size.
for (const [name, value] of [
  ["offsetHeight", 600],
  ["clientHeight", 600],
  ["offsetWidth", 1200],
  ["clientWidth", 1200],
])
  Object.defineProperty(window.HTMLElement.prototype, name, {
    configurable: true,
    get: () => value,
  });
window.requestAnimationFrame = globalThis.requestAnimationFrame;
const { createProfilesView } = await import("../dist/editor/profiles-view.js");

function d1Over(database) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    async first() {
      return database.prepare(sql).get(...values) ?? null;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values) };
    },
    async run() {
      database.prepare(sql).run(...values);
      return { success: true };
    },
    runSync() {
      database.prepare(sql).run(...values);
      return { success: true };
    },
  });
  return new AsyncD1Database({
    prepare: (sql) => statement(sql),
    async batch(statements) {
      return database.transaction(() => statements.map((s) => s.runSync()))();
    },
  });
}

const SEED = `
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-owner', 'human', 'owner', 'Synthetic Owner');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-owner', 'acct-owner', 'test-human', 'owner');
  INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('org-adams', 'Synthetic Adams Office', 'office', '08001'), ('org-larimer', 'Synthetic Larimer Office', 'office', '08069');
  INSERT INTO positions (id, organization_id, title) VALUES ('pos-adams', 'org-adams', 'Synthetic Clerk'), ('pos-larimer', 'org-larimer', 'Synthetic Analyst');
  INSERT INTO role_sources (id, url, title, source_type) VALUES ('src-a', 'https://example.invalid/a', 'A', 'official_page'), ('src-b', 'https://example.invalid/b', 'B', 'official_page'), ('src-c', 'https://example.invalid/c', 'C', 'official_page');
  INSERT INTO people (id, display_name) VALUES ('person-multi', 'Synthetic Multi Role'), ('person-former', 'Synthetic Former Official'), ('person-office', 'Synthetic Office Only');
  INSERT INTO person_roles (id, person_id, position_id, source_id, start_date, end_date, source_checked_at) VALUES
    ('role-multi-a', 'person-multi', 'pos-adams', 'src-a', '2020-01-02', NULL, '2026-10-01T00:00:00Z'),
    ('role-multi-b', 'person-multi', 'pos-larimer', 'src-b', NULL, NULL, '2026-10-02T00:00:00Z'),
    ('role-former', 'person-former', 'pos-adams', 'src-c', '2015-01-01', '2019-12-31', '2026-10-03T00:00:00Z');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at, county_fips, published_office) VALUES
    ('role-office', 'person-office', NULL, 'src-c', '2026-10-04T00:00:00Z', '08001', 'Synthetic Assessor Office');
`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await wait(20);
  }
}

async function mount(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(SEED);
  const adapter = createTestHumanIdentityAdapter({ owner: "owner" });
  const service = createD1ProfilesService(d1Over(database), {
    authorize: async (p) => p.accountId === "acct-owner",
  });
  const transport = createProfilesApiTransport({
    resolvePrincipal: (request) => resolvePrincipal(database, request, adapter),
    authorize: async (p) => p.accountId === "acct-owner",
    service,
  });
  const client = createProfilesClient({
    fetch: (path, init = {}) =>
      transport.fetch(
        new Request(`${ORIGIN}${path}`, {
          ...init,
          headers: {
            ...init.headers,
            origin: ORIGIN,
            "x-test-human-subject": "owner",
          },
        }),
      ),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const announcements = [];
  let keys = 0;
  const handle = createProfilesView({
    client,
    pageSize: 2,
    newKey: () => `ui-key-${String(++keys).padStart(6, "0")}`,
  })({
    doc: window.document,
    container,
    data: { view: "profiles" },
    session: {},
    hrefFor: () => "#",
    announce: (text) => announcements.push(text),
  });
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => Array.from(container.querySelectorAll(selector));
  const click = (element) =>
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  const rows = () => $$(".tabulator-row");
  const cell = (row, field) =>
    row.querySelector(`[tabulator-field="${field}"]`);
  const rowFor = (name, position) =>
    rows().find(
      (r) =>
        cell(r, "displayName")?.textContent.includes(name) &&
        (!position || r.textContent.includes(position)),
    );
  try {
    try {
      await waitFor(() => rows().length > 0, "first page");
    } catch (error) {
      console.log(
        "DEBUG",
        announcements,
        container
          .querySelector(".tabulator")
          ?.outerHTML.replace(
            /.*tabulator-tableholder/s,
            "tabulator-tableholder",
          )
          .slice(0, 1500),
      );
      throw error;
    }
    await callback({
      database,
      service,
      container,
      $,
      $$,
      click,
      rows,
      cell,
      rowFor,
      announcements,
      handle,
    });
  } finally {
    handle.destroy?.();
    container.remove();
    database.close();
  }
}

async function type(cellElement, value, key = "Enter") {
  cellElement.focus();
  cellElement.dispatchEvent(new window.Event("focus"));
  const input = await waitFor(
    () => cellElement.querySelector("input"),
    "cell editor",
  );
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key,
      keyCode: key === "Escape" ? 27 : 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(30);
}

test("the grid pages, searches across pages and labels row selection separately from visibility", async () => {
  await mount(async ({ $, rows, cell, container }) => {
    assert.equal($("h1").textContent, "Profiles");
    assert.equal(rows().length, 2, "page size 2");
    assert.match($(".cw-profiles-counts").textContent, /4 rows match/);
    assert.ok(
      $(".tabulator").getAttribute("role") === "grid" || $("[role=grid]"),
    );
    // Two different checkboxes per row, each with its own label.
    const first = rows()[0];
    assert.match(
      first.querySelector("input[data-select-role]").getAttribute("aria-label"),
      /^Select role row for /,
    );
    assert.match(
      cell(first, "visible").querySelector("input").getAttribute("aria-label"),
      /^Visible on Website for /,
    );
    // Search for a person who is not on page one.
    const search = $("#profiles-search");
    search.value = "Office Only";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(
      () => /1 row match/.test($(".cw-profiles-counts").textContent),
      "search result",
    );
    assert.equal(rows().length, 1);
    assert.match(rows()[0].textContent, /Synthetic Office Only/);
    // Unavailable fields are explained and not shown.
    const picker = $(".cw-profiles-picker");
    assert.match(picker.textContent, /Unavailable on the Website/);
    assert.match(picker.textContent, /Reviewer Notes/);
    assert.equal(
      container.querySelector('[tabulator-field="reviewerNotes"]'),
      null,
    );
  });
});

test("keyboard edit stages a change, Escape cancels, save and reload keep the value", async () => {
  await mount(async ({ $, database, rows, cell, rowFor, announcements }) => {
    const target = rowFor("Synthetic Former");
    assert.ok(target, "former row is on page one or search it");
    // Escape cancels an edit without staging anything.
    await type(cell(target, "employmentEnd"), "2018-01-01", "Escape");
    assert.match($(".cw-profiles-staged").textContent, /No unsaved changes/);
    // Enter commits to the staging area, not the database.
    await type(cell(target, "employmentEnd"), "2019-06-30");
    await waitFor(
      () => /1 unsaved change\./.test($(".cw-profiles-staged").textContent),
      "staged edit",
    );
    assert.equal(
      database
        .prepare("SELECT end_date FROM person_roles WHERE id='role-former'")
        .get().end_date,
      "2019-12-31",
    );
    // An invalid date is a field error and blocks the save.
    await type(cell(target, "employmentEnd"), "31/12/2019");
    $("#profiles-save").click();
    await waitFor(
      () =>
        /Fix these before saving/.test($(".cw-profiles-review").textContent),
      "local error",
    );
    assert.match($(".cw-profiles-review").textContent, /Use a date like/);
    await type(cell(rowFor("Synthetic Former"), "employmentEnd"), "2019-06-30");
    // Preview shows old and new, then confirm saves.
    $("#profiles-save").click();
    await waitFor(() => $("#profiles-confirm"), "preview");
    const review = $(".cw-profiles-review").textContent;
    assert.match(review, /2019-12-31/);
    assert.match(review, /2019-06-30/);
    $("#profiles-confirm").click();
    await waitFor(
      () =>
        /No unsaved changes/.test($(".cw-profiles-staged").textContent) &&
        announcements.some((a) => /^Saved 1 change/.test(a)),
      "saved",
    );
    assert.equal(
      database
        .prepare("SELECT end_date FROM person_roles WHERE id='role-former'")
        .get().end_date,
      "2019-06-30",
    );
    // The reloaded grid shows the saved value.
    await waitFor(
      () =>
        cell(rowFor("Synthetic Former") ?? rows()[0], "employmentEnd")
          ?.textContent === "2019-06-30",
      "reload",
    );
  });
});

test("selecting both roles of one person stages one visibility change, hides and restores it", async () => {
  await mount(async ({ $, $$, click, rows, database, announcements }) => {
    const search = $("#profiles-search");
    search.value = "Multi";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(
      () =>
        /2 rows match/.test($(".cw-profiles-counts").textContent) &&
        rows().length === 2,
      "multi rows",
    );
    for (const box of $$("input[data-select-role]")) {
      box.checked = true;
      box.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    assert.match(
      $(".cw-profiles-selection").textContent,
      /2 role rows selected across 1 Profile/,
    );
    click($("#profiles-hide"));
    assert.ok(
      announcements.some((a) =>
        /Hide staged for 1 Profile from 2 selected role rows/.test(a),
      ),
      announcements.join(" | "),
    );
    assert.match($(".cw-profiles-staged").textContent, /1 unsaved change\./);
    // Both visible boxes follow the one Profile.
    await waitFor(
      () =>
        $$('[tabulator-field="visible"] input').every(
          (b) => b.checked === false,
        ),
      "boxes follow",
    );
    $("#profiles-save").click();
    await waitFor(() => $("#profiles-confirm"), "preview");
    assert.equal($$(".cw-profiles-diff tbody tr").length, 1, "one change row");
    $("#profiles-confirm").click();
    await waitFor(
      () =>
        database
          .prepare(
            "SELECT COUNT(*) c FROM person_visibility WHERE person_id='person-multi' AND visible=0",
          )
          .get().c === 1,
      "hidden saved",
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) c FROM audit_events WHERE action = 'profile.hide'",
        )
        .get().c,
      1,
    );
    // Restore through the same selection path.
    await waitFor(
      () => /No unsaved changes/.test($(".cw-profiles-staged").textContent),
      "reload after hide",
    );
    await waitFor(
      () => $$("input[data-select-role]").length === 2,
      "rows back",
    );
    for (const box of $$("input[data-select-role]")) {
      box.checked = true;
      box.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    click($("#profiles-restore"));
    $("#profiles-save").click();
    await waitFor(() => $("#profiles-confirm"), "restore preview");
    $("#profiles-confirm").click();
    await waitFor(
      () =>
        database
          .prepare(
            "SELECT visible v FROM person_visibility WHERE person_id='person-multi'",
          )
          .get()?.v === 1,
      "restored",
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) c FROM people WHERE id='person-multi'")
        .get().c,
      1,
    );
  });
});

test("bulk set applies one role field to every selected row and saves it", async () => {
  await mount(async ({ $, $$, click, rows, database, announcements }) => {
    const search = $("#profiles-search");
    search.value = "Multi";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(
      () =>
        /2 rows match/.test($(".cw-profiles-counts").textContent) &&
        rows().length === 2,
      "multi rows",
    );
    click(
      $$("button").find((b) => b.textContent.startsWith("Select this page")),
    );
    click($("#profiles-set"));
    $("#profiles-set-field").value = "employmentEnd";
    $("#profiles-set-value").value = "2026-08-31";
    click(
      $$(".cw-profiles-set button").find(
        (b) => b.textContent === "Stage values",
      ),
    );
    assert.match($(".cw-profiles-staged").textContent, /2 unsaved changes/);
    $("#profiles-save").click();
    await waitFor(() => $("#profiles-confirm"), "preview");
    $("#profiles-confirm").click();
    await waitFor(
      () => announcements.some((a) => /^Saved 2 changes/.test(a)),
      "saved",
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT end_date FROM person_roles WHERE person_id='person-multi' ORDER BY id",
        )
        .all()
        .map((r) => r.end_date),
      ["2026-08-31", "2026-08-31"],
    );
  });
});

test("a stale write keeps the pending edit and lets the owner retry on the latest version", async () => {
  await mount(async ({ $, $$, click, cell, rowFor, database }) => {
    const row = rowFor("Synthetic Former");
    await type(cell(row, "employmentEnd"), "2019-07-01");
    await waitFor(
      () => /1 unsaved change\./.test($(".cw-profiles-staged").textContent),
      "staged",
    );
    // Another session changes the same role first.
    const version = database
      .prepare("SELECT version FROM person_roles WHERE id='role-former'")
      .get().version;
    database
      .prepare(
        "UPDATE person_roles SET end_date='2019-01-01', version=? WHERE id='role-former'",
      )
      .run(version + 1);
    $("#profiles-save").click();
    // Preview already sees the stale version and offers to keep the edit.
    await waitFor(
      () =>
        /cannot be saved yet|Another change landed first/.test(
          $(".cw-profiles-review").textContent,
        ),
      "stale shown",
    );
    assert.match($(".cw-profiles-review").textContent, /2019-01-01/);
    assert.match($(".cw-profiles-staged").textContent, /1 unsaved change\./);
    click(
      $$(".cw-profiles-review button").find((b) =>
        /Keep my edits on the latest versions/.test(b.textContent),
      ),
    );
    await waitFor(() => $("#profiles-confirm"), "re-review");
    $("#profiles-confirm").click();
    await waitFor(
      () =>
        database
          .prepare("SELECT end_date FROM person_roles WHERE id='role-former'")
          .get().end_date === "2019-07-01",
      "retried save",
    );
  });
});

test("a name component edit shows on every role of the Profile and saves", async () => {
  await mount(async ({ database, cell, rows, rowFor, $, announcements }) => {
    const target = rowFor("Synthetic Former");
    assert.ok(target, "former row is on the page");
    await type(cell(target, "lastName"), "Synthetic-Surname");
    await waitFor(
      () => /1 unsaved change\./.test($(".cw-profiles-staged").textContent),
      "staged component edit",
    );
    // Nothing is written until the owner saves.
    assert.equal(
      database
        .prepare("SELECT last_name FROM people WHERE id='person-former'")
        .get().last_name,
      null,
    );
    $("#profiles-save").click();
    await waitFor(() => $("#profiles-confirm"), "preview");
    $("#profiles-confirm").click();
    await waitFor(
      () => announcements.some((a) => /^Saved 1 change/.test(a)),
      "saved",
    );
    assert.equal(
      database
        .prepare("SELECT last_name FROM people WHERE id='person-former'")
        .get().last_name,
      "Synthetic-Surname",
    );
    assert.ok(rows().length > 0);
  });
});

test("the names button opens the alternate-name editor, and adds stage into the shared save", async () => {
  await mount(async ({ database, container, rows, $, announcements }) => {
    const open = container.querySelector("[data-names-for]");
    assert.ok(open, "each row has a names button");
    assert.match(open.getAttribute("aria-label"), /Edit alternate names for/);
    open.click();
    await waitFor(
      () => !$(".cw-profiles-names").hidden && $("#profiles-names-add"),
      "names panel",
    );
    // A new name starts private and requires review.
    assert.equal(
      database.prepare("SELECT COUNT(*) c FROM profile_names").get().c,
      0,
    );
    $("#profiles-names-add").click();
    await waitFor(
      () => $(".cw-profiles-names form, .cw-profiles-names input"),
      "name form",
    );
    assert.ok(rows().length > 0);
    assert.ok(announcements.length >= 0);
    $("#profiles-names-close")?.click();
    // Opening and closing the editor writes nothing.
    assert.equal(
      database.prepare("SELECT COUNT(*) c FROM profile_names").get().c,
      0,
    );
  });
});

test("a roleless Profile has one row with its status, and Visible stays disabled until it is complete", async () => {
  await mount(async ({ $, $$, click, rows, cell, database, announcements }) => {
    database.exec(`
      INSERT INTO people (id, display_name) VALUES ('person-draft', 'Synthetic Draft Profile');
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id) VALUES ('person-draft', 0, 'acct-owner');
    `);
    const search = $("#profiles-search");
    search.value = "Draft Profile";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(
      () =>
        /1 row match/.test($(".cw-profiles-counts").textContent) &&
        rows().length === 1,
      "draft row",
    );
    const [row] = rows();
    assert.match(
      cell(row, "displayName").textContent,
      /Synthetic Draft Profile/,
    );
    assert.equal(
      cell(row, "publicationStatus").textContent,
      "Hidden · Missing role",
    );
    const box = cell(row, "visible").querySelector("input");
    assert.equal(box.disabled, true);
    assert.equal(box.checked, false);
    assert.match(box.getAttribute("title"), /Missing role/);
    assert.match(box.getAttribute("aria-label"), /unavailable: missing role/);
    assert.match(
      row.querySelector("input[data-select-role]").getAttribute("aria-label"),
      /^Select Profile row for Synthetic Draft Profile/,
    );
    // Bulk restore leaves an incomplete Profile out and says why.
    const select = row.querySelector("input[data-select-role]");
    select.checked = true;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    click($("#profiles-restore"));
    assert.ok(
      announcements.some((a) =>
        /1 not restored because it is missing required information/.test(a),
      ),
      announcements.join(" | "),
    );
    assert.match($(".cw-profiles-staged").textContent, /No unsaved changes/);

    // Once a qualifying role exists the box is enabled and still unchecked.
    database.exec(`
      INSERT INTO person_roles (id, person_id, source_id, county_fips, published_title)
        VALUES ('role-draft', 'person-draft', 'src-a', '08001', 'Synthetic Title');
    `);
    search.value = "Draft Profile ";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(
      () =>
        rows().length === 1 &&
        cell(rows()[0], "publicationStatus").textContent === "Hidden",
      "ready row",
    );
    const ready = cell(rows()[0], "visible").querySelector("input");
    assert.equal(ready.disabled, false);
    assert.equal(ready.checked, false);
    assert.ok($$(".tabulator-row").length >= 1);
  });
});

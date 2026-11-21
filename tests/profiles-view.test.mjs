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
test("Unit Linked shows the current match and updates after a reviewed bulk link", async () => {
  await mount(
    async ({ database, $, click, cell, rowFor }) => {
      database
        .prepare(`
      INSERT INTO county_unit (id, county_fips, name, organization_type)
      VALUES ('ui-exact-unit', '08001', 'Synthetic Adams Office', 'office')
    `)
        .run();
      const county = $("#profiles-county");
      await waitFor(
        () => county.querySelector('option[value="08001"]'),
        "county options",
      );
      county.value = "08001";
      county.dispatchEvent(new window.Event("change", { bubbles: true }));
      const unitStatus = () =>
        cell(rowFor("Multi Role", "Clerk"), "unitLink")?.textContent;
      await waitFor(
        () => unitStatus() === "Exact match · ready to link",
        "ready unit status",
      );
      click($("#profiles-link-exact"));
      const confirm = await waitFor(
        () => $("#profiles-confirm-exact-links"),
        "exact links review",
      );
      assert.equal(confirm.textContent, "Link 2 roles");
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM county_role_display").get()
          .n,
        0,
      );
      click(confirm);
      await waitFor(() => unitStatus() === "✓ Linked", "saved unit status");
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM county_role_display").get()
          .n,
        2,
      );
    },
    { pageSize: 10 },
  );
});

async function waitFor(check, label, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await wait(20);
  }
}

async function mount(callback, { pageSize = 2 } = {}) {
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
    pageSize,
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
    assert.deepEqual(
      [...container.querySelectorAll(".tabulator-col-title")]
        .slice(0, 3)
        .map((column) => column.textContent.trim()),
      ["Select", "Visible", "Display Name"],
    );
    assert.equal($("#profiles-grid").style.height, "87.5vh");
    assert.equal(
      $("#profiles-hide").nextElementSibling.id,
      "profiles-delete-selected",
    );
    assert.equal($("#profiles-delete-selected").disabled, true);
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
        /Hidden: 1 Profile will change; 0 already have the requested value/.test(
          a,
        ),
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
        /1 Profile cannot be made Visible because it is missing required information/.test(
          a,
        ),
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

test("Set selected values stages visibility once per Profile across filters and skips drafts", async () => {
  await mount(async ({ $, $$, click, rows, database, announcements }) => {
    database.exec(`
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
        VALUES ('person-multi', 0, 'acct-owner');
      INSERT INTO people (id, display_name) VALUES ('person-draft', 'Synthetic Draft Profile');
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
        VALUES ('person-draft', 0, 'acct-owner');
    `);
    const search = $("#profiles-search");
    const find = async (term, expected) => {
      search.value = term;
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      await waitFor(
        () =>
          rows().length === expected &&
          $$(".cw-profiles-counts").some((el) =>
            el.textContent.includes(
              `${expected} ${expected === 1 ? "row" : "rows"} match`,
            ),
          ) &&
          (term === "" || rows().some((row) => row.textContent.includes(term))),
        `${term || "all"} filtered rows`,
      );
    };
    const selectRows = () => {
      for (const box of $$("input[data-select-role]")) {
        box.checked = true;
        box.dispatchEvent(new window.Event("change", { bubbles: true }));
      }
    };
    await find("Synthetic Multi Role", 2);
    selectRows();
    assert.match(
      $(".cw-profiles-selection").textContent,
      /2 role rows selected across 1 Profile/,
    );
    await find("Draft Profile", 1);
    selectRows();
    await find("Office Only", 1);
    selectRows();
    assert.match(
      $(".cw-profiles-selection").textContent,
      /4 role rows selected across 3 Profiles/,
    );

    const openAndStage = async (value) => {
      click($("#profiles-set"));
      const fieldSelect = $("#profiles-set-field");
      assert.ok(
        [...fieldSelect.options].some(
          (option) =>
            option.value === "visible" && option.textContent === "Visible",
        ),
      );
      fieldSelect.value = "visible";
      fieldSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
      const visibility = $("#profiles-set-visibility-value");
      assert.equal(visibility.hidden, false);
      assert.deepEqual(
        [...visibility.options].map((option) => option.textContent),
        ["Visible", "Hidden"],
      );
      visibility.value = String(value);
      click(
        [...$(".cw-profiles-set").querySelectorAll("button")].find(
          (button) => button.textContent === "Stage values",
        ),
      );
    };

    await openAndStage(true);
    assert.ok(
      announcements.some((text) =>
        /Visible: 1 Profile will change; 1 already have the requested value \(Visible\)\. 1 Profile cannot be made Visible because it is missing required information/.test(
          text,
        ),
      ),
      announcements.join(" | "),
    );
    assert.match($(".cw-profiles-staged").textContent, /1 unsaved change/);
    click($("#profiles-save"));
    await waitFor(() => {
      const confirm = $("#profiles-confirm");
      return confirm && !confirm.closest(".cw-profiles-review")?.hidden;
    }, "visibility preview");
    assert.equal($(".cw-profiles-diff tbody").rows.length, 1);
    click($("#profiles-confirm"));
    await waitFor(
      () =>
        database
          .prepare(
            "SELECT visible FROM person_visibility WHERE person_id='person-multi'",
          )
          .get()?.visible === 1,
      "bulk Visible readback",
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) n FROM audit_events WHERE action='profile.restore'",
        )
        .get().n,
      1,
    );

    await openAndStage(false);
    assert.ok(
      announcements.some((text) =>
        /Hidden: 2 Profiles will change; 1 already have the requested value \(Hidden\)/.test(
          text,
        ),
      ),
      announcements.join(" | "),
    );
    click($("#profiles-save"));
    await waitFor(() => {
      const confirm = $("#profiles-confirm");
      return confirm && !confirm.closest(".cw-profiles-review")?.hidden;
    }, "visibility hide preview");
    click($("#profiles-confirm"));
    await waitFor(
      () =>
        database
          .prepare(
            "SELECT visible FROM person_visibility WHERE person_id='person-office'",
          )
          .get()?.visible === 0,
      "bulk Hidden readback",
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) n FROM audit_events WHERE action='profile.hide'",
        )
        .get().n,
      2,
    );
    assert.equal(
      database
        .prepare(
          "SELECT visible FROM person_visibility WHERE person_id='person-draft'",
        )
        .get().visible,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT visible FROM person_visibility WHERE person_id='person-multi'",
        )
        .get().visible,
      0,
    );
  });
});

test("changing page size preserves filters, sort, selection and staged edits", async () => {
  await mount(
    async ({ $, $$, click, rows, database, announcements }) => {
      const search = $("#profiles-search");
      search.value = "Synthetic";
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      await waitFor(
        () =>
          rows().length === 2 &&
          $(".cw-profiles-counts").textContent.includes("4 rows match"),
        "filtered page one",
      );
      click($("button[aria-label='Next Page']"));
      await waitFor(
        () =>
          rows().length === 2 &&
          $(".tabulator-page.active")?.textContent === "2",
        "filtered page two",
      );
      click($("#profiles-select-page"));
      click($("#profiles-set"));
      const fieldSelect = $("#profiles-set-field");
      fieldSelect.value = "employmentEnd";
      fieldSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
      $("#profiles-set-value").value = "2027-01-01";
      click(
        [...$(".cw-profiles-set").querySelectorAll("button")].find(
          (button) => button.textContent === "Stage values",
        ),
      );
      assert.match($(".cw-profiles-staged").textContent, /2 unsaved changes/);

      const pageSize = $("select.tabulator-page-size");
      assert.equal(pageSize.tagName, "SELECT");
      assert.equal(pageSize.getAttribute("aria-label"), "Rows per page");
      assert.equal(pageSize.value, "2");
      pageSize.value = "50";
      pageSize.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitFor(
        () =>
          rows().length === 4 &&
          $(".tabulator-page.active")?.textContent === "1",
        "page size reset to page one",
      );
      assert.equal(search.value, "Synthetic");
      assert.match(
        $(".cw-profiles-selection").textContent,
        /2 role rows selected/,
      );
      assert.match($(".cw-profiles-staged").textContent, /2 unsaved changes/);
      assert.ok(
        rows().some((row) =>
          row
            .querySelector('[tabulator-field="employmentEnd"]')
            ?.textContent.includes("2027-01-01"),
        ),
      );
      assert.match(
        $(".tabulator-col[tabulator-field='displayName']").getAttribute(
          "aria-sort",
        ),
        /ascending/i,
      );

      click($("#profiles-save"));
      await waitFor(() => $("#profiles-confirm"), "save preview after resize");
      click($("#profiles-confirm"));
      await waitFor(
        () =>
          database
            .prepare(
              "SELECT COUNT(*) n FROM person_roles WHERE end_date='2027-01-01'",
            )
            .get().n === 2,
        "saved readback after page size change",
      );
      assert.ok(announcements.length > 0);
      assert.ok($$(".tabulator-row").length === 4);
    },
    { pageSize: 2 },
  );
});

test("remote pagination returns exactly 1000 rows then the remainder without duplicates", async () => {
  await mount(
    async ({ $, $$, click, rows, database, announcements }) => {
      const insertPerson = database.prepare(
        "INSERT INTO people (id, display_name) VALUES (?, ?)",
      );
      const insertRole = database.prepare(
        "INSERT INTO person_roles (id, person_id, position_id, source_id) VALUES (?, ?, 'pos-adams', 'src-a')",
      );
      for (let i = 1; i <= 1_002; i += 1) {
        const suffix = String(i).padStart(4, "0");
        const personId = `scale-person-${suffix}`;
        insertPerson.run(personId, `Synthetic Scale ${suffix}`);
        insertRole.run(`scale-role-${suffix}`, personId);
      }
      click($("#profiles-clear"));
      await waitFor(
        () => /1006 rows match/.test($(".cw-profiles-counts").textContent),
        "all synthetic scale rows loaded",
      );

      const pageSize = $("select.tabulator-page-size");
      assert.equal(pageSize.getAttribute("aria-label"), "Rows per page");
      assert.ok(
        pageSize.tabIndex >= 0,
        "native selector is keyboard focusable",
      );
      pageSize.focus();
      assert.equal(window.document.activeElement, pageSize);
      assert.equal(pageSize.value, "50");
      assert.deepEqual(
        [...pageSize.options].map((option) => option.value),
        ["50", "100", "250", "500", "1000"],
      );
      assert.match(
        $(".cw-profiles-counts").textContent,
        /1006 rows match\. Page 1\./,
      );
      pageSize.value = "1000";
      pageSize.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitFor(
        () =>
          rows().length === 1000 &&
          $(".tabulator-page.active")?.textContent === "1",
        "first thousand rows",
        15000,
      );
      assert.match($(".tabulator-page-counter").textContent, /rows/);
      const firstPageKeys = rows().map((row) =>
        row
          .querySelector("input[data-select-role]")
          .getAttribute("data-select-role"),
      );
      assert.equal(new Set(firstPageKeys).size, 1000);
      click($("#profiles-select-page"));
      click($("button[aria-label='Next Page']"));
      await waitFor(
        () =>
          rows().length === 6 &&
          $(".tabulator-page.active")?.textContent === "2",
        "last page remainder",
        15000,
      );
      const remainderKeys = rows().map((row) =>
        row
          .querySelector("input[data-select-role]")
          .getAttribute("data-select-role"),
      );
      assert.equal(new Set(remainderKeys).size, 6);
      assert.match(
        $(".cw-profiles-selection").textContent,
        /1000 role rows selected/,
      );
      const allKeys = [...firstPageKeys, ...remainderKeys];
      assert.equal(new Set(allKeys).size, 1006);
      const expected = database
        .prepare("SELECT id FROM person_roles ORDER BY id")
        .all()
        .map((row) => row.id);
      assert.deepEqual(new Set(allKeys), new Set(expected));

      const selectAll = $("#profiles-select-matching-rows");
      click(selectAll);
      await waitFor(
        () =>
          announcements.some((text) =>
            /first 1000 matching role rows/.test(text),
          ),
        "select-all remains capped",
      );
      click($("#profiles-set"));
      const fieldSelect = $("#profiles-set-field");
      fieldSelect.value = "visible";
      fieldSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
      $("#profiles-set-visibility-value").value = "false";
      click(
        [...$(".cw-profiles-set").querySelectorAll("button")].find(
          (button) => button.textContent === "Stage values",
        ),
      );
      assert.match(announcements.at(-1), /500-change save limit/);
      assert.match(announcements.at(-1), /not split automatically/);
      assert.match($(".cw-profiles-staged").textContent, /No unsaved changes/);
      assert.equal(
        database.prepare("SELECT COUNT(*) n FROM person_visibility").get().n,
        0,
      );
    },
    { pageSize: 50 },
  );
});

test("the owner grid confirms a single Profile deletion from the selection toolbar", async () => {
  await mount(async ({ $, database, rowFor }) => {
    const select = rowFor("Synthetic Former Official").querySelector(
      "input[data-select-role]",
    );
    select.checked = true;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    const open = async () => {
      const trigger = $("#profiles-delete-selected");
      trigger.click();
      return waitFor(
        () => $("#profiles-delete-confirmation"),
        "deletion preview",
      );
    };
    await open();
    const panel = $("#profiles-delete-h").parentElement;
    const findButton = (label) =>
      [...panel.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
    const cancel = findButton("Cancel");
    cancel.click();
    assert.equal(panel.hidden, true);
    assert.ok(
      database.prepare("SELECT 1 FROM people WHERE id = 'person-former'").get(),
    );
    const input = await open();
    const confirm = findButton("Delete Website Profile");
    assert.equal(confirm.disabled, true);
    const reason = $("#profiles-delete-reason");
    reason.value = "incorrect";
    reason.dispatchEvent(new window.Event("change"));
    input.value = "DELETE";
    input.dispatchEvent(new window.Event("input"));
    assert.equal(confirm.disabled, false);
    confirm.click();
    await waitFor(() => panel.hidden, "deletion receipt");
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) n FROM person_roles WHERE person_id = 'person-former'",
        )
        .get().n,
      0,
    );
    assert.ok(
      database.prepare("SELECT 1 FROM people WHERE id = 'person-multi'").get(),
    );
  });
});

test("deleting selected Profiles reviews cross-page selections once and stops on a stale target", async () => {
  await mount(async ({ $, database }) => {
    const selectAll = $("#profiles-select-matching-rows");
    selectAll.click();
    await waitFor(
      () =>
        /4 role rows selected across 3 Profiles/.test(
          $(".cw-profiles-selection").textContent,
        ),
      "all rows selected",
    );
    $("#profiles-delete-selected").click();
    const input = await waitFor(
      () => $("#profiles-delete-confirmation"),
      "bulk preview",
    );
    const panel = $("#profiles-delete-h").parentElement;
    assert.deepEqual(
      [...panel.querySelectorAll("li strong")].map((node) => node.textContent),
      [
        "Synthetic Former Official",
        "Synthetic Multi Role",
        "Synthetic Office Only",
      ],
    );
    assert.equal(database.prepare("SELECT COUNT(*) n FROM people").get().n, 3);
    database.exec(
      "UPDATE people SET display_name = 'Synthetic Updated Multi Role', version = version + 1 WHERE id = 'person-multi'",
    );
    const reason = $("#profiles-delete-reason");
    reason.value = "incorrect";
    reason.dispatchEvent(new window.Event("change"));
    input.value = "DELETE";
    input.dispatchEvent(new window.Event("input"));
    const confirm = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete 3 Website Profiles",
    );
    confirm.click();
    await waitFor(
      () =>
        /1 of 3 Profiles deleted/.test(panel.textContent) &&
        !$("#profiles-grid").inert,
      "partial deletion result",
    );
    assert.equal(confirm.disabled, true);
    assert.deepEqual(
      database
        .prepare("SELECT id FROM people ORDER BY id")
        .all()
        .map((record) => record.id),
      ["person-multi", "person-office"],
    );
    assert.match(
      $(".cw-profiles-selection").textContent,
      /3 role rows selected across 2 Profiles/,
    );
  });
});

test("Select all matching reviews a filtered visibility change across pages", async () => {
  await mount(async ({ $, database, announcements }) => {
    $("#profiles-search").value = "Synthetic";
    $("#profiles-search").dispatchEvent(
      new window.Event("input", { bubbles: true }),
    );
    $("#profiles-select-all-matching").click();
    const panel = $("#profiles-matching-visibility-h").parentElement;
    const preview = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "Preview hiding",
    );
    preview.click();
    const confirm = await waitFor(
      () => $("#profiles-confirm-matching-visibility"),
      "matching visibility confirmation",
    );
    assert.match(panel.textContent, /3 Profiles match. 3 will become hidden/);
    assert.equal(
      database.prepare("SELECT COUNT(*) n FROM person_visibility").get().n,
      0,
    );
    confirm.click();
    await waitFor(
      () => announcements.includes("3 Profiles hidden."),
      "bulk visibility saved",
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) n FROM person_visibility WHERE visible = 0")
        .get().n,
      3,
    );
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createProfilesClient } from "../dist/editor/profiles-client.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import { createD1ProfilesImportService } from "../dist/services/profiles-import-d1.js";
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
  INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('org-adams', 'Synthetic Adams Office', 'office', '08001');
  INSERT INTO positions (id, organization_id, title) VALUES ('pos-adams', 'org-adams', 'Synthetic Clerk');
  INSERT INTO role_sources (id, url, title, source_type) VALUES ('src-a', 'https://example.invalid/a', 'Synthetic source', 'official_page');
  INSERT INTO people (id, display_name) VALUES ('person-keep', 'Synthetic Existing Person');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at) VALUES ('role-keep', 'person-keep', 'pos-adams', 'src-a', '2026-10-01T00:00:00Z');
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

const PROFILE_CSV =
  "profile_id,display_name\r\nP1,Synthetic Alpha\r\nP2,Synthetic Beta\r\n";
const ROLE_CSV =
  "role_id,profile_id,county_fips,published_office,source_id,source_url,source_title,publisher_classification,source_type\r\n" +
  "R1,P1,08001,Synthetic Recorder,S1,https://example.invalid/s1,Source one,official,official_page\r\n" +
  "R2,P2,08001,Synthetic Assessor,S1,https://example.invalid/s1,Source one,official,official_page\r\n";

test("the owner runs upload, preview, inspect and commit entirely in the Profiles tab", async () => {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(SEED);
  const adapter = createTestHumanIdentityAdapter({ owner: "owner" });
  const authorize = async (p) => p.accountId === "acct-owner";
  const d1 = d1Over(database);
  const transport = createProfilesApiTransport({
    resolvePrincipal: (request) => resolvePrincipal(database, request, adapter),
    authorize,
    service: createD1ProfilesService(d1, { authorize }),
    importService: createD1ProfilesImportService(d1, { authorize }),
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
  let keys = 0;
  const handle = createProfilesView({
    client,
    pageSize: 5,
    newKey: () => `ui-key-${String(++keys).padStart(6, "0")}`,
  })({
    doc: window.document,
    container,
    data: { view: "profiles" },
    session: {},
    hrefFor: () => "#",
    announce: () => {},
  });
  const $ = (selector) => container.querySelector(selector);
  const click = (element) =>
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  const choose = (selector, text) =>
    Object.defineProperty($(selector), "files", {
      configurable: true,
      value: [{ text: async () => text }],
    });
  try {
    await waitFor(() => $("#profiles-import"), "import panel");
    assert.equal(
      $("#import-commit").hasAttribute("disabled"),
      true,
      "commit is off before a preview",
    );
    click($("#import-preview"));
    await waitFor(
      () => $(".cw-import-status").textContent.includes("Choose profile.csv"),
      "needs a file",
    );
    choose("#import-profile-file", PROFILE_CSV);
    choose("#import-role-file", ROLE_CSV);
    click($("#import-preview"));
    await waitFor(() => $("#import-preview-result"), "preview result");
    assert.match(
      $("#import-visibility").textContent,
      /2 new Profiles will be created hidden/,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) c FROM people").get().c,
      1,
      "preview wrote nothing",
    );
    assert.equal(
      $$rows().length,
      5,
      "two Profiles, two roles, one source row shown",
    );
    assert.equal($("#import-commit").hasAttribute("disabled"), false);
    click($("#import-commit"));
    await waitFor(() => $("#import-receipt"), "receipt");
    assert.match(
      $("#import-receipt").textContent,
      /Created 2 Profiles, 2 roles and 1 sources/,
    );
    assert.match($("#import-receipt").textContent, /2 new Profiles are hidden/);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) c FROM person_visibility WHERE visible = 0")
        .get().c,
      2,
    );
    assert.equal($("#import-reverse").hasAttribute("hidden"), false);
    click($("#import-reverse"));
    await waitFor(
      () =>
        !$("#import-receipt") &&
        $(".cw-import-status").textContent.includes("reversed"),
      "reversal",
    );
    assert.equal(database.prepare("SELECT COUNT(*) c FROM people").get().c, 1);
  } finally {
    handle.destroy?.();
    container.remove();
    database.close();
  }

  function $$rows() {
    return Array.from(container.querySelectorAll(".cw-import-rows tbody tr"));
  }
});

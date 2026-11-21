import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { SYNC_CONTRACT_VERSION } from "../dist/contracts/sync.js";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createProfilesClient } from "../dist/editor/profiles-client.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import { readCsv } from "../dist/services/profiles-import-csv.js";
import {
  createD1ProfilesImportService,
  ImportStalePreviewError,
} from "../dist/services/profiles-import-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";
import { createProfilesApiTransport } from "../dist/transport/profiles-api.js";
import { buildProfilesWorkbook } from "./support/profiles-workbook.mjs";

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

for (const format of ["CSV", "XLSX"])
  test(`the owner uploads and commits ${format} in the Profiles tab`, () =>
    runImport(format));

async function createImportTest() {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(SEED);
  const adapter = createTestHumanIdentityAdapter({ owner: "owner" });
  const authorize = async (p) => p.accountId === "acct-owner";
  const d1 = d1Over(database);
  const service = createD1ProfilesImportService(d1, { authorize });
  const resolve = (request) => resolvePrincipal(database, request, adapter);
  const profiles = createD1ProfilesService(d1, { authorize });
  const transport = createProfilesApiTransport({
    resolvePrincipal: resolve,
    authorize,
    service: profiles,
    importService: service,
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
  const owner = await resolve(
    new Request(ORIGIN, { headers: { "x-test-human-subject": "owner" } }),
  );
  const count = (table) =>
    database.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  return { database, client, service, owner, count, d1, profiles };
}

async function withWorkbookService(run) {
  const setup = await createImportTest();
  try {
    await run(setup);
  } finally {
    setup.database.close();
  }
}

async function runImport(format) {
  const { database, client } = await createImportTest();
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
    if (format === "XLSX") {
      const rows = (csv) => readCsv(csv).records.map((record) => record.cells);
      const bytes = buildProfilesWorkbook({
        Profiles: rows(PROFILE_CSV),
        Roles: rows(ROLE_CSV),
        "Alternate Names": [
          [
            "profile_name_id",
            "profile_id",
            "name_type",
            "full_name_as_published",
          ],
          ["N1", "P1", "nickname", "Unused Alternate Name"],
        ],
      });
      Object.defineProperty($("#import-workbook-file"), "files", {
        configurable: true,
        value: [new File([bytes], "profiles.xlsx")],
      });
    } else {
      choose("#import-profile-file", PROFILE_CSV);
      choose("#import-role-file", ROLE_CSV);
    }
    click($("#import-preview"));
    await waitFor(() => $("#import-preview-result"), "preview result");
    assert.equal(
      $("#import-unchanged-counts").textContent,
      "Unchanged Profiles (0) · Unchanged roles (0)",
    );
    assert.match(
      $("#import-visibility").textContent,
      /2 new Profiles will be created hidden/,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) c FROM people").get().c,
      1,
      "preview wrote nothing",
    );
    assert.equal($$rows().length, 4, "two Profiles and two roles shown");
    assert.equal($("#import-commit").hasAttribute("disabled"), false);
    if (format === "XLSX") {
      const includeNames = $("#import-include-alternate-names");
      assert.equal(includeNames.checked, false);
      assert.match(
        $("#import-preview-result").textContent,
        /Alternate Names worksheet is excluded/,
      );
      click(includeNames);
      assert.equal($("#import-commit").hasAttribute("disabled"), true);
      click($("#import-preview"));
      await waitFor(
        () =>
          $(".cw-import-issues")?.textContent.includes(
            'needs a "published_name" column',
          ),
        "blocking issue when including the incomplete worksheet",
      );
      click(includeNames);
      click($("#import-preview"));
      await waitFor(
        () => $("#import-preview-result"),
        "preview with the worksheet excluded",
      );
      assert.equal($(".cw-import-issues"), null);
      $("#import-workbook-file").dispatchEvent(new window.Event("change"));
      assert.equal($("#import-commit").hasAttribute("disabled"), true);
      click($("#import-preview"));
      await waitFor(() => $("#import-preview-result"), "new workbook preview");
    }
    click($("#import-commit"));
    await waitFor(() => $("#import-receipt"), "receipt");
    assert.match(
      $("#import-receipt").textContent,
      /Created 2 Profiles and 2 roles/,
    );
    assert.match($("#import-receipt").textContent, /2 new Profiles are hidden/);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS c FROM profile_names").get().c,
      0,
    );
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
}

const csv = (rows) => `${rows.map((row) => row.join(",")).join("\r\n")}\r\n`;
const snapshot = (count) =>
  [
    "people",
    "person_roles",
    "role_sources",
    "profile_names",
    "person_visibility",
    "sync_batches",
    "audit_events",
  ].map(count);

test("XLSX and CSV share the reviewed preview, privacy, receipt and reversal", async () => {
  await withWorkbookService(async ({ service, owner, count }) => {
    const files = { profile: PROFILE_CSV, profileRole: ROLE_CSV };
    files.profileName = csv([
      ["profile_name_id", "profile_id", "name_type", "published_name"],
      ["N1", "P1", "nickname", "Synthetic Alias"],
    ]);
    const rows = (text) => readCsv(text).records.map((r) => r.cells);
    const roles = rows(files.profileRole);
    roles[1][2] = 8001;
    const workbook = buildProfilesWorkbook({
      Profiles: rows(files.profile),
      Roles: roles,
      "Alternate Names": rows(files.profileName),
    }).toString("base64");
    const before = snapshot(count);
    const visibilityBefore = count("person_visibility");
    const preview = await service.preview(owner, { workbook });
    const { digest: csvDigest, ...csvPreview } = await service.preview(owner, {
      files,
    });
    const { digest: workbookDigest, notes, ...workbookPreview } = preview;
    assert.match(notes[0], /workbook supplies the Website values/);
    assert.deepEqual({ ...workbookPreview, notes: [] }, csvPreview);
    assert.match(csvDigest, /^[a-f0-9]{64}$/);
    assert.equal(preview.canCommit, true);
    assert.equal(preview.newProfilesHidden, 2);
    assert.equal(preview.newNamesPrivate, 1);
    assert.deepEqual(snapshot(count), before);
    const request = { workbook, digest: workbookDigest };
    const receipt = await service.commit(owner, "workbook-commit", request);
    const replay = await service.commit(owner, "workbook-commit", request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.batchId, receipt.batchId);
    assert.equal(count("person_visibility"), visibilityBefore + 2);
    assert.equal(count("profile_names"), 1);

    const emptyNames = buildProfilesWorkbook({
      Profiles: rows(files.profile),
      Roles: roles,
      "Alternate Names": [rows(files.profileName)[0]],
    }).toString("base64");
    const unchanged = await service.preview(owner, { workbook: emptyNames });
    assert.equal(unchanged.names.add + unchanged.names.update, 0);
    assert.equal(count("profile_names"), 1);
    await service.reverse(owner, receipt.batchId, "workbook-reverse");
    assert.equal(count("people"), before[0]);
    assert.equal(count("profile_names"), 0);
  });
});

test("XLSX rejects mixed inputs, unexpected tabs and formulas without writing", async () => {
  await withWorkbookService(async ({ service, owner, count }) => {
    const profiles = [
      ["profile_id", "display_name"],
      ["P1", "Synthetic Alpha"],
    ];
    const workbook = buildProfilesWorkbook({ Profiles: profiles }).toString(
      "base64",
    );
    const before = snapshot(count);
    await assert.rejects(
      service.preview(owner, { files: { profile: PROFILE_CSV }, workbook }),
      /Choose one Excel workbook or CSV files/,
    );
    await assert.rejects(
      service.preview(owner, {
        workbook: buildProfilesWorkbook({
          Profiles: profiles,
          Notes: [["fictional notes"]],
        }).toString("base64"),
      }),
      /Use one Profiles tab/,
    );
    await assert.rejects(
      service.preview(owner, {
        workbook: buildProfilesWorkbook(
          { Profiles: profiles },
          {
            "xl/worksheets/sheet1.xml":
              '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
          },
        ).toString("base64"),
      }),
      /Replace them with values/,
    );
    assert.deepEqual(snapshot(count), before);
  });
});

test("the reviewed Excel master overwrites supported Website values using stable IDs", async () => {
  await withWorkbookService(
    async ({ database, d1, service, profiles, owner }) => {
      const makeWorkbook = (name, headers, values) => ({
        workbook: buildProfilesWorkbook({
          Profiles: [
            ["profile_id", "display_name"],
            ["P1", name],
          ],
          Roles: [
            ["role_id", "profile_id", "county_fips", ...headers],
            ["R1", "P1", "08001", ...values],
          ],
        }).toString("base64"),
      });
      const initial = makeWorkbook(
        "Synthetic Person",
        [
          "published_office",
          "published_title",
          "job_description",
          "start_date",
          "end_date",
        ],
        [
          "Synthetic Recorder",
          "Clerk",
          "Initial duties",
          "2020-01-01",
          "2025-01-01",
        ],
      );
      await service.commit(owner, "first-master-01", {
        ...initial,
        digest: (await service.preview(owner, initial)).digest,
      });
      const personId = database
        .prepare(
          "SELECT target_id FROM sync_batch_items WHERE client_ref = 'dash:profile:P1'",
        )
        .get().target_id;
      const roleId = database
        .prepare("SELECT id FROM person_roles WHERE person_id = ?")
        .get(personId).id;
      await profiles.save(owner, "visible-master-01", [
        { kind: "visibility", personId, expectedVersion: 1, visible: true },
      ]);
      const editRole = (title) =>
        database
          .prepare(
            "UPDATE person_roles SET published_title = ?, version = version + 1 WHERE id = ?",
          )
          .run(title, roleId);
      editRole("Website role edit");
      database
        .prepare(
          "UPDATE people SET display_name = 'Website name edit', version = version + 1 WHERE id = ?",
        )
        .run(personId);
      database
        .prepare(
          "UPDATE person_roles SET source_id = 'src-a', version = version + 1 WHERE id = ?",
        )
        .run(roleId);
      database.exec(`INSERT INTO county_unit (id, county_fips, name, organization_type)
      VALUES ('master-test-unit', '08001', 'Synthetic Recorder', 'office');`);
      database
        .prepare(`INSERT INTO county_role_display
        (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
      VALUES ('master-test-home', ?, '08001', 'master-test-unit', 'home', 'acct-owner')`)
        .run(roleId);

      const update = makeWorkbook(
        "Workbook Person",
        [
          "published_office",
          "published_title",
          "job_description",
          "start_date",
        ],
        ["Workbook Office", "Workbook Title", "", ""],
      );
      const firstReview = await service.preview(owner, update);
      assert.equal(firstReview.profiles.update, 1);
      assert.equal(firstReview.roles.update, 1);
      assert.equal(firstReview.roles.conflict, 0);
      assert.equal(
        firstReview.canCommit,
        true,
        JSON.stringify(firstReview.issues),
      );
      const roleDiff = firstReview.rows.find((row) => row.key === "R1");
      assert.equal(roleDiff.websiteId, roleId);
      assert.deepEqual(
        roleDiff.fields.map(({ field, proposed }) => [field, proposed]),
        [
          ["published_office", "Workbook Office"],
          ["published_title", "Workbook Title"],
          ["job_description", null],
          ["start_date", null],
        ],
      );
      editRole("Edit after preview");
      await assert.rejects(
        service.commit(owner, "stale-master-01", {
          ...update,
          digest: firstReview.digest,
        }),
        ImportStalePreviewError,
      );
      const secondReview = await service.preview(owner, update);
      const result = await service.commit(owner, "update-master-01", {
        ...update,
        digest: secondReview.digest,
      });
      assert.deepEqual(result.updated, { profiles: 1, roles: 1, names: 0 });
      assert.equal(
        database
          .prepare("SELECT display_name FROM people WHERE id = ?")
          .get(personId).display_name,
        "Workbook Person",
      );
      const readRole = () =>
        database
          .prepare(`SELECT published_office, published_title, job_description,
      start_date, end_date, source_id FROM person_roles WHERE id = ?`)
          .get(roleId);
      assert.deepEqual(readRole(), {
        published_office: "Workbook Office",
        published_title: "Workbook Title",
        job_description: null,
        start_date: null,
        end_date: "2025-01-01",
        source_id: "src-a",
      });
      assert.equal(
        database
          .prepare("SELECT visible FROM person_visibility WHERE person_id = ?")
          .get(personId).visible,
        1,
      );
      assert.equal(
        database
          .prepare(
            "SELECT unit_id FROM county_role_display WHERE id = 'master-test-home'",
          )
          .get().unit_id,
        "master-test-unit",
      );
      assert.equal((await service.preview(owner, update)).roles.unchanged, 1);
      const blankDetails = makeWorkbook(
        "Workbook Person",
        ["published_office", "published_title"],
        ["", ""],
      );
      assert.ok(
        (await service.preview(owner, blankDetails)).issues.some(
          (issue) => issue.code === "role_detail_required",
        ),
      );
      const external = await planSyncChangesetD1(d1, {
        contractVersion: SYNC_CONTRACT_VERSION,
        requestId: "19371b47-c778-483d-90c2-cb16eec881b7",
        intent: "dry_run",
        changes: [
          {
            op: "update_record",
            entity: "person_roles",
            targetId: roleId,
            expectedVersion: database
              .prepare("SELECT version FROM person_roles WHERE id = ?")
              .get(roleId).version,
            fields: { published_title: "External edit" },
          },
        ],
      });
      assert.ok(
        external.errors.some((error) => error.code === "unsupported_field"),
        JSON.stringify(external.errors),
      );
      assert.equal(
        (await service.reverse(owner, result.batchId, "reverse-master-01"))
          .status,
        "reverted",
      );
      assert.equal(readRole().published_title, "Edit after preview");
      assert.equal(readRole().job_description, "Initial duties");
    },
  );
});

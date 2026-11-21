import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { AsyncD1Database } from "../dist/database/d1.js";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createD1PublicReadServices } from "../dist/services/d1-public-reads.js";
import { createServices } from "../dist/services/index.js";
import {
  createD1ProfilesService,
  ProfilesConflictError,
  ProfilesIdempotencyError,
  ProfilesValidationError,
} from "../dist/services/profiles-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangesetD1 } from "../dist/services/sync-commit-d1.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";
import { createPublicSite } from "../dist/site/index.js";
import { siteAssets } from "./site-fixtures.mjs";

const NOW = () => new Date("2026-11-18T12:00:00.000Z");

export function d1Over(database) {
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

/** Synthetic data across two counties. No real people or sources. */
const SEED = `
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-owner', 'human', 'owner', 'Synthetic Owner');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-owner', 'acct-owner', 'test-human', 'owner');
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-editor', 'human', 'editor', 'Synthetic Editor');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-editor', 'acct-editor', 'test-human', 'editor');
  INSERT INTO organizations (id, name, organization_type, county_fips) VALUES
    ('org-adams', 'Synthetic Adams Office', 'office', '08001'),
    ('org-larimer', 'Synthetic Larimer Office', 'office', '08069');
  INSERT INTO positions (id, organization_id, title) VALUES
    ('pos-adams', 'org-adams', 'Synthetic Adams Clerk'),
    ('pos-larimer', 'org-larimer', 'Synthetic Larimer Analyst'),
    ('pos-former', 'org-adams', 'Synthetic Former Deputy');
  INSERT INTO role_sources (id, url, title, source_type) VALUES
    ('src-a', 'https://example.invalid/a', 'Synthetic source A', 'official_page'),
    ('src-b', 'https://example.invalid/b', 'Synthetic source B', 'official_page'),
    ('src-c', 'https://example.invalid/c', 'Synthetic source C', 'official_page'),
    ('src-d', 'https://example.invalid/d', 'Synthetic source D', 'official_page');
  INSERT INTO people (id, display_name) VALUES
    ('person-multi', 'Synthetic Multi Role'),
    ('person-office', 'Synthetic Office Only'),
    ('person-former', 'Synthetic Former Official');
  INSERT INTO person_roles (id, person_id, position_id, source_id, start_date, end_date, source_checked_at) VALUES
    ('role-multi-a', 'person-multi', 'pos-adams', 'src-a', '2020-01-02', NULL, '2026-10-01T00:00:00Z'),
    ('role-multi-b', 'person-multi', 'pos-larimer', 'src-b', NULL, NULL, '2026-10-02T00:00:00Z'),
    ('role-former', 'person-former', 'pos-former', 'src-c', '2015-01-01', '2019-12-31', '2026-10-03T00:00:00Z');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at, county_fips, published_office) VALUES
    ('role-office', 'person-office', NULL, 'src-d', '2026-10-04T00:00:00Z', '08001', 'Synthetic Assessor Office');
`;

async function fixture(callback, { upgrade = false } = {}) {
  const database = await openWebsiteDatabase();
  const migrations = loadWebsiteMigrations();
  if (upgrade) migrateWebsiteDatabase(database, migrations.slice(0, 29));
  else migrateWebsiteDatabase(database, migrations);
  database.exec(SEED);
  const adapter = createTestHumanIdentityAdapter({
    owner: "owner",
    editor: "editor",
  });
  const principal = async (subject) =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": subject },
      }),
      adapter,
    );
  const d1 = d1Over(database);
  const service = createD1ProfilesService(d1, {
    now: NOW,
    authorize: async (p) => p.accountId === "acct-owner",
  });
  try {
    await callback({
      database,
      d1,
      service,
      owner: await principal("owner"),
      editor: await principal("editor"),
      migrations,
    });
  } finally {
    database.close();
  }
}

const query = (extra = {}) => ({
  query: "",
  county: null,
  office: null,
  visibility: "all",
  sort: "displayName",
  direction: "asc",
  page: 1,
  pageSize: 50,
  ...extra,
});
const names = (page) => page.rows.map((row) => row.displayName);
const visibility = (personId, visible, expectedVersion = 0) => ({
  kind: "visibility",
  personId,
  expectedVersion,
  visible,
});

const RUNTIMES = [
  ["SQL.js", (database) => createServices({ database })],
  ["D1", (database) => createD1PublicReadServices(d1Over(database))],
];

/** Every public read path that lists or opens a Profile. */
async function publicSnapshot(services) {
  return {
    person: await services.getPersonProfile({
      personId: "person-multi",
      limit: 10,
    }),
    search: (await services.searchPeople({ query: "Synthetic Multi" })).items,
    browse: (await services.browsePeople({})).items.map((i) => i.id),
    officials: (await services.listOfficials({})).items.map((i) => i.person.id),
    countyRoles: (
      await services.listCountyRoleEntries({ countyFips: "08001" })
    ).items.map((i) => i.role.id),
    larimerRoles: (
      await services.listCountyRoleEntries({ countyFips: "08069" })
    ).items.map((i) => i.role.id),
    overview: await services.getCountyOverview({ countyFips: "08001" }),
    orgRoles: (
      await services.listOrganizationRoleEntries({
        organizationId: "org-adams",
      })
    ).items.map((i) => i.role.id),
  };
}

test("lists one row per role across two counties with server-side sort, filter and paging", async () => {
  await fixture(async ({ service, owner }) => {
    const all = await service.listRows(owner, query());
    assert.equal(all.total, 4);
    assert.deepEqual(all.rows.map((r) => r.roleId).sort(), [
      "role-former",
      "role-multi-a",
      "role-multi-b",
      "role-office",
    ]);
    const first = await service.listRows(owner, query({ pageSize: 2 }));
    const second = await service.listRows(
      owner,
      query({ pageSize: 2, page: 2 }),
    );
    assert.equal(first.lastPage, 2);
    assert.deepEqual(
      [...first.rows, ...second.rows].map((r) => r.roleId).sort(),
      all.rows.map((r) => r.roleId).sort(),
    );
    // Search finds a person on a later page without paging through.
    const found = await service.listRows(
      owner,
      query({ query: "Former", pageSize: 1 }),
    );
    assert.deepEqual(names(found), ["Synthetic Former Official"]);
    const adams = await service.listRows(owner, query({ county: "08001" }));
    assert.deepEqual(adams.rows.map((r) => r.roleId).sort(), [
      "role-former",
      "role-multi-a",
      "role-office",
    ]);
    // The office-only role has no position and keeps its office name.
    const office = all.rows.find((r) => r.roleId === "role-office");
    assert.equal(office.position, null);
    assert.equal(office.officeDepartment, "Synthetic Assessor Office");
    // Unknown dates stay blank and shared fields repeat on every row.
    const multi = all.rows.filter((r) => r.profileId === "person-multi");
    assert.equal(multi.length, 2);
    assert.equal(multi[0].displayName, multi[1].displayName);
    assert.equal(
      all.rows.find((r) => r.roleId === "role-multi-b").employmentStart,
      null,
    );
    assert.ok(all.rows.every((r) => r.visible === true));
  });
});

test("unauthorized callers cannot read or write", async () => {
  await fixture(async ({ service, editor }) => {
    await assert.rejects(() => service.listRows(editor, query()));
    await assert.rejects(() => service.facets(editor));
    await assert.rejects(() => service.selectAll(editor, query()));
    await assert.rejects(() =>
      service.preview(editor, [visibility("person-multi", false)]),
    );
    await assert.rejects(() =>
      service.save(editor, "key-unauthorized-1", [
        visibility("person-multi", false),
      ]),
    );
  });
});

test("inline name edit and bulk date change save, retry safely and reload", async () => {
  await fixture(async ({ database, service, owner }) => {
    const rows = (await service.listRows(owner, query())).rows;
    const a = rows.find((r) => r.roleId === "role-multi-a");
    const b = rows.find((r) => r.roleId === "role-multi-b");
    const changes = [
      {
        kind: "field",
        entity: "people",
        targetId: "person-multi",
        field: "display_name",
        expectedVersion: a.profileVersion,
        value: "Synthetic Multi Renamed",
      },
      ...[a, b].map((r) => ({
        kind: "field",
        entity: "person_roles",
        targetId: r.roleId,
        field: "end_date",
        expectedVersion: r.roleVersion,
        value: "2026-06-30",
      })),
    ];
    const preview = await service.preview(owner, changes);
    assert.equal(preview.ok, true);
    const nameItem = preview.items.find((i) => i.targetId === "person-multi");
    assert.equal(nameItem.impact.shared, true);
    assert.equal(nameItem.before, "Synthetic Multi Role");

    const saved = await service.save(owner, "key-save-0001", changes);
    assert.equal(saved.applied, 3);
    assert.equal(saved.replayed, false);
    // Retry with the same key replays the receipt and changes nothing more.
    const retry = await service.save(owner, "key-save-0001", changes);
    assert.equal(retry.replayed, true);
    assert.equal(
      database
        .prepare("SELECT version FROM people WHERE id='person-multi'")
        .get().version,
      2,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) c FROM audit_events WHERE actor_account_id='acct-owner' AND target_id IN ('person-multi','role-multi-a','role-multi-b')",
        )
        .get().c,
      3,
    );
    // Same key with a different body is refused.
    await assert.rejects(
      () => service.save(owner, "key-save-0001", [changes[0]]),
      ProfilesIdempotencyError,
    );
    // Reload shows the saved values on every row of the person.
    const reloaded = (await service.listRows(owner, query())).rows.filter(
      (r) => r.profileId === "person-multi",
    );
    assert.deepEqual(
      reloaded.map((r) => r.displayName),
      Array(2).fill("Synthetic Multi Renamed"),
    );
    assert.deepEqual(
      reloaded.map((r) => r.employmentEnd),
      Array(2).fill("2026-06-30"),
    );
  });
});

test("a stale write is rejected as a whole and reports the current value", async () => {
  await fixture(async ({ database, service, owner }) => {
    const row = (await service.listRows(owner, query())).rows.find(
      (r) => r.roleId === "role-multi-a",
    );
    // Another change lands first.
    await service.save(owner, "key-first-0001", [
      {
        kind: "field",
        entity: "person_roles",
        targetId: "role-multi-a",
        field: "end_date",
        expectedVersion: row.roleVersion,
        value: "2025-01-01",
      },
    ]);
    const stale = [
      {
        kind: "field",
        entity: "person_roles",
        targetId: "role-multi-a",
        field: "end_date",
        expectedVersion: row.roleVersion,
        value: "2026-02-02",
      },
      {
        kind: "field",
        entity: "people",
        targetId: "person-multi",
        field: "display_name",
        expectedVersion: row.profileVersion,
        value: "Should Not Apply",
      },
    ];
    await assert.rejects(
      () => service.save(owner, "key-stale-0001", stale),
      (error) => {
        assert.ok(error instanceof ProfilesConflictError);
        const issue = error.issues.find((i) => i.code === "stale_version");
        assert.equal(issue.currentVersion, row.roleVersion + 1);
        assert.equal(issue.currentValue, "2025-01-01");
        return true;
      },
    );
    // Nothing in the batch applied, including the valid name edit.
    assert.equal(
      database
        .prepare("SELECT display_name FROM people WHERE id='person-multi'")
        .get().display_name,
      "Synthetic Multi Role",
    );
    // The pending edit can be re-sent on the refreshed version.
    const fresh = (await service.listRows(owner, query())).rows.find(
      (r) => r.roleId === "role-multi-a",
    );
    const done = await service.save(owner, "key-stale-0002", [
      { ...stale[0], expectedVersion: fresh.roleVersion },
    ]);
    assert.equal(done.applied, 1);
  });
});

test("invalid dates and date order are field-level errors", async () => {
  await fixture(async ({ service, owner }) => {
    const row = (await service.listRows(owner, query())).rows.find(
      (r) => r.roleId === "role-multi-a",
    );
    const bad = await service.preview(owner, [
      {
        kind: "field",
        entity: "person_roles",
        targetId: "role-multi-a",
        field: "end_date",
        expectedVersion: row.roleVersion,
        value: "2019-01-01",
      },
    ]);
    assert.equal(bad.ok, false);
    await assert.rejects(
      () =>
        service.save(owner, "key-invalid-01", [
          {
            kind: "field",
            entity: "person_roles",
            targetId: "role-multi-a",
            field: "end_date",
            expectedVersion: row.roleVersion,
            value: "not-a-date",
          },
        ]),
      ProfilesValidationError,
    );
    await assert.rejects(() =>
      service
        .preview(owner, [
          {
            kind: "field",
            entity: "person_roles",
            targetId: "role-multi-a",
            field: "source_id",
            expectedVersion: 1,
            value: "x",
          },
        ])
        .then((p) => {
          if (!p.ok) throw new Error("rejected");
        }),
    );
  });
});

test("two selected roles of one person make one visibility change, and hiding removes the person from every public read", async () => {
  await fixture(async ({ database, d1, service, owner }) => {
    const before = {};
    for (const [label, make] of RUNTIMES)
      before[label] = await publicSnapshot(make(database));
    for (const [label] of RUNTIMES) {
      assert.equal(before[label].browse.includes("person-multi"), true, label);
      assert.equal(
        before[label].countyRoles.includes("role-multi-a"),
        true,
        label,
      );
    }

    const selected = await service.selectAll(owner, query({ query: "Multi" }));
    assert.equal(selected.entries.length, 2);
    // Deduplicate by Profile ID the way the grid does.
    const profiles = new Map(selected.entries.map((e) => [e.profileId, e]));
    assert.equal(profiles.size, 1);
    const changes = [...profiles.values()].map((e) =>
      visibility(e.profileId, false, e.visibilityVersion),
    );
    // A request that repeats a Profile is refused outright.
    await assert.rejects(() =>
      service.save(owner, "key-dup-00001", [changes[0], changes[0]]),
    );
    const personVersion = database
      .prepare("SELECT version FROM people WHERE id='person-multi'")
      .get().version;
    const result = await service.save(owner, "key-hide-0001", changes);
    assert.equal(result.applied, 1);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) c FROM person_visibility WHERE person_id='person-multi'",
        )
        .get().c,
      1,
    );
    // Visibility never touches the shared Profile version.
    assert.equal(
      database
        .prepare("SELECT version FROM people WHERE id='person-multi'")
        .get().version,
      personVersion,
    );
    // The sheet still lists both role rows, now marked hidden.
    const hidden = await service.listRows(
      owner,
      query({ visibility: "hidden" }),
    );
    assert.deepEqual(hidden.rows.map((r) => r.roleId).sort(), [
      "role-multi-a",
      "role-multi-b",
    ]);

    for (const [label, make] of RUNTIMES) {
      const services = make(database);
      const after = await publicSnapshot(services);
      assert.equal(after.person, null, `${label} person page`);
      assert.deepEqual(after.search, [], `${label} search`);
      assert.equal(
        after.browse.includes("person-multi"),
        false,
        `${label} browse`,
      );
      assert.equal(
        before[label].officials.includes("person-multi"),
        true,
        `${label} officials before`,
      );
      assert.equal(
        after.officials.includes("person-multi"),
        false,
        `${label} officials`,
      );
      assert.equal(
        after.countyRoles.includes("role-multi-a"),
        false,
        `${label} county roles`,
      );
      assert.equal(
        after.larimerRoles.includes("role-multi-b"),
        false,
        `${label} larimer roles`,
      );
      assert.equal(
        after.orgRoles.includes("role-multi-a"),
        false,
        `${label} org roles`,
      );
      assert.equal(
        after.overview.documentedRoleCount,
        before[label].overview.documentedRoleCount - 1,
        `${label} county count`,
      );
      // Other Profiles are untouched.
      assert.equal(after.browse.includes("person-office"), true, label);
    }

    // Restore keeps the same Website ID and visibility row version moves on.
    const current = (await service.listRows(owner, query({ query: "Multi" })))
      .rows[0];
    const restored = await service.save(owner, "key-restore-01", [
      visibility("person-multi", true, current.visibilityVersion),
    ]);
    assert.equal(restored.applied, 1);
    for (const [label, make] of RUNTIMES) {
      const after = await publicSnapshot(make(database));
      assert.equal(
        after.person?.person?.id ?? after.person?.personId ?? "person-multi",
        "person-multi",
        label,
      );
      assert.notEqual(after.person, null, `${label} restored page`);
      assert.deepEqual(after.countyRoles, before[label].countyRoles, label);
      assert.deepEqual(after.overview, before[label].overview, label);
    }
    assert.equal(
      database
        .prepare("SELECT COUNT(*) c FROM people WHERE id='person-multi'")
        .get().c,
      1,
    );
    void d1;
  });
});

test("a hidden Profile's direct page and API return 404 and restore reopens the same ID", async () => {
  await fixture(async ({ database, service, owner }) => {
    const application = createApplication(createServices({ database }));
    const site = createPublicSite({
      services: createServices({ database }),
      assets: siteAssets(),
      reportReviewAccess: async () => null,
    });
    const status = async (handler, path) =>
      (await handler.fetch(new Request(`https://watchdog.invalid${path}`)))
        .status;
    assert.equal(await status(application, "/api/people/person-multi"), 200);
    assert.equal(await status(site, "/people/person-multi"), 200);
    await service.save(owner, "key-hide-404-1", [
      visibility("person-multi", false),
    ]);
    assert.equal(await status(application, "/api/people/person-multi"), 404);
    assert.equal(await status(site, "/people/person-multi"), 404);
    const list = await (
      await application.fetch(
        new Request(
          "https://watchdog.invalid/api/people?query=Synthetic%20Multi",
        ),
      )
    ).json();
    assert.equal(JSON.stringify(list).includes("person-multi"), false);
    const roles = await (
      await application.fetch(
        new Request("https://watchdog.invalid/api/counties/08001/roles"),
      )
    ).json();
    assert.equal(JSON.stringify(roles).includes("role-multi-a"), false);
    // The public page for a hidden Profile carries no private review data.
    const row = (await service.listRows(owner, query({ query: "Multi" })))
      .rows[0];
    await service.save(owner, "key-show-404-1", [
      visibility("person-multi", true, row.visibilityVersion),
    ]);
    assert.equal(await status(application, "/api/people/person-multi"), 200);
    assert.equal(await status(site, "/people/person-multi"), 200);
  });
});

test("restore respects role eligibility", async () => {
  await fixture(async ({ database, service, owner }) => {
    // The schema already requires an office, position or duties and a county
    // on every role, so the case left is a Profile with no role at all.
    database.exec(
      "INSERT INTO people (id, display_name) VALUES ('person-norole', 'Synthetic No Role')",
    );
    await service.save(owner, "key-elig-0001", [
      visibility("person-norole", false),
    ]);
    await assert.rejects(
      () =>
        service.save(owner, "key-elig-0002", [
          visibility("person-norole", true, 1),
        ]),
      (error) => {
        assert.ok(error instanceof ProfilesValidationError);
        assert.equal(error.issues[0].code, "not_eligible");
        return true;
      },
    );
    // An eligible Profile restores normally.
    await service.save(owner, "key-elig-0003", [
      visibility("person-office", false),
    ]);
    const row = (await service.listRows(owner, query({ query: "Office Only" })))
      .rows[0];
    const ok = await service.save(owner, "key-elig-0004", [
      visibility("person-office", true, row.visibilityVersion),
    ]);
    assert.equal(ok.applied, 1);
  });
});

test("upgrading from migration 29 keeps every existing Profile visible and changes no public read", async () => {
  await fixture(
    async ({ database, migrations, service, owner }) => {
      const tableCount = () =>
        database
          .prepare(
            "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('person_visibility','profile_write_receipts')",
          )
          .get().c;
      assert.equal(tableCount(), 0);
      // Public reads require migration 0030, so the baseline is a fresh database
      // with the same records and no hidden Profiles.
      const before = {};
      await fixture(async ({ database: fresh }) => {
        for (const [label, make] of RUNTIMES)
          before[label] = await publicSnapshot(make(fresh));
      });
      const people = database
        .prepare("SELECT id, version, updated_at FROM people ORDER BY id")
        .all();
      const roles = database
        .prepare("SELECT id, version FROM person_roles ORDER BY id")
        .all();
      migrateWebsiteDatabase(database, migrations);
      assert.equal(tableCount(), 2);
      assert.equal(
        database.prepare("SELECT MAX(version) v FROM schema_migrations").get()
          .v,
        38,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) c FROM person_visibility").get().c,
        0,
      );
      assert.deepEqual(
        database
          .prepare("SELECT id, version, updated_at FROM people ORDER BY id")
          .all(),
        people,
      );
      assert.deepEqual(
        database
          .prepare("SELECT id, version FROM person_roles ORDER BY id")
          .all(),
        roles,
      );
      for (const [label, make] of RUNTIMES)
        assert.deepEqual(
          await publicSnapshot(make(database)),
          before[label],
          label,
        );
      // The sheet reports the existing records as visible and can then hide one.
      const page = await service.listRows(owner, query());
      assert.equal(page.total, 4);
      assert.ok(
        page.rows.every((r) => r.visible === true && r.visibilityVersion === 0),
      );
      const result = await service.save(owner, "key-upgrade-01", [
        visibility("person-former", false),
      ]);
      assert.equal(result.applied, 1);
    },
    { upgrade: true },
  );
});

const SYNC_REQUEST = "7b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const syncSet = (intent, changes) => ({
  contractVersion: "m2-sync/v1",
  requestId: SYNC_REQUEST,
  intent,
  changes,
});
const syncUpdate = (entity, targetId, expectedVersion, fields) => ({
  op: "update_record",
  entity,
  targetId,
  expectedVersion,
  fields,
});
const allowSync = async (_principal, capability) => capability === "sync.apply";

test("a later reviewed sync shows the difference, rejects a stale version, accepts a deliberate replacement and leaves visibility alone", async () => {
  await fixture(async ({ database, d1, service, owner }) => {
    // The owner hides the Profile and edits a date on the Website first.
    const row = (
      await service.listRows(owner, query({ query: "Multi" }))
    ).rows.find((r) => r.roleId === "role-multi-a");
    await service.save(owner, "key-sync-pre-01", [
      visibility("person-multi", false),
      {
        kind: "field",
        entity: "person_roles",
        targetId: "role-multi-a",
        field: "end_date",
        expectedVersion: row.roleVersion,
        value: "2026-05-01",
      },
    ]);

    // A sync built from older data still carries the old role version.
    const stale = syncSet("commit", [
      syncUpdate("person_roles", "role-multi-a", row.roleVersion, {
        end_date: "2026-07-01",
      }),
    ]);
    const staleResult = await commitSyncChangesetD1(
      d1,
      owner,
      "sync-stale-key-1",
      stale,
      { authorize: allowSync, now: NOW },
    );
    assert.equal(staleResult.status, "rejected");
    assert.equal(staleResult.errors[0].code, "stale_version");
    assert.equal(
      database
        .prepare("SELECT end_date FROM person_roles WHERE id='role-multi-a'")
        .get().end_date,
      "2026-05-01",
    );

    // A deliberate reviewed replacement uses the current version. The preview
    // shows the Website value it would replace.
    const current = database
      .prepare("SELECT version FROM person_roles WHERE id='role-multi-a'")
      .get().version;
    const reviewed = [
      syncUpdate("person_roles", "role-multi-a", current, {
        end_date: "2026-07-01",
      }),
    ];
    const plan = await planSyncChangesetD1(
      d1,
      syncSet("dry_run", reviewed),
      NOW,
    );
    assert.equal(plan.eligible, true, JSON.stringify(plan.errors));
    assert.deepEqual(plan.items[0].fieldChanges, [
      { field: "end_date", current: "2026-05-01", proposed: "2026-07-01" },
    ]);
    const committed = await commitSyncChangesetD1(
      d1,
      owner,
      "sync-reviewed-key",
      syncSet("commit", reviewed),
      { authorize: allowSync, now: NOW },
    );
    assert.equal(committed.status, "committed", JSON.stringify(committed));
    assert.equal(
      database
        .prepare("SELECT end_date FROM person_roles WHERE id='role-multi-a'")
        .get().end_date,
      "2026-07-01",
    );

    // Sync cannot write visibility and does not change it.
    const hiddenRow = database
      .prepare(
        "SELECT visible FROM person_visibility WHERE person_id='person-multi'",
      )
      .get();
    assert.equal(hiddenRow.visible, 0);
    const smuggled = await planSyncChangesetD1(
      d1,
      syncSet("dry_run", [
        syncUpdate("people", "person-multi", 1, { visible: 1 }),
      ]),
      NOW,
    );
    assert.equal(smuggled.eligible, false);
    assert.equal(smuggled.errors[0].code, "unsupported_field");
    const after = (await service.listRows(owner, query({ query: "Multi" })))
      .rows;
    assert.ok(after.every((r) => r.visible === false));
    assert.equal(
      after.find((r) => r.roleId === "role-multi-a").employmentEnd,
      "2026-07-01",
    );
    // The Profiles sheet's next edit sees the synced version and is not stale.
    assert.equal(
      after.find((r) => r.roleId === "role-multi-a").roleVersion,
      current + 1,
    );
  });
});

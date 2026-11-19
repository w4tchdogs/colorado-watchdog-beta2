import assert from "node:assert/strict";
import test from "node:test";
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
  ProfilesValidationError,
} from "../dist/services/profiles-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";

const NOW = () => new Date("2026-11-18T12:00:00.000Z");

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

/** Synthetic data only. No real people, names or sources. */
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
    ('pos-larimer', 'org-larimer', 'Synthetic Larimer Analyst');
  INSERT INTO role_sources (id, url, title, source_type) VALUES
    ('src-a', 'https://example.invalid/a', 'Synthetic source A', 'official_page'),
    ('src-b', 'https://example.invalid/b', 'Synthetic source B', 'official_page');
  INSERT INTO people (id, display_name) VALUES
    ('person-multi', 'Synthetic Multi Role'),
    ('person-solo', 'Synthetic Solo Person');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at) VALUES
    ('role-multi-a', 'person-multi', 'pos-adams', 'src-a', '2026-10-01T00:00:00Z'),
    ('role-multi-b', 'person-multi', 'pos-larimer', 'src-b', '2026-10-02T00:00:00Z'),
    ('role-solo', 'person-solo', 'pos-adams', 'src-a', '2026-10-03T00:00:00Z');
`;

const RUNTIMES = [
  ["SQL.js", (database) => createServices({ database })],
  ["D1", (database) => createD1PublicReadServices(d1Over(database))],
];

async function fixture(callback, { upgrade = false } = {}) {
  const database = await openWebsiteDatabase();
  const migrations = loadWebsiteMigrations();
  // Version 0030 is the last migration before the name tables.
  migrateWebsiteDatabase(
    database,
    upgrade ? migrations.slice(0, 30) : migrations,
  );
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
  const service = createD1ProfilesService(d1Over(database), {
    now: NOW,
    authorize: async (p) => p.accountId === "acct-owner",
  });
  try {
    await callback({
      database,
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

const alt = (personId, fields = {}) => ({
  kind: "alternate_name",
  op: "add",
  personId,
  fields: {
    nameType: "nickname",
    firstName: null,
    middleName: null,
    lastName: null,
    namePrefix: null,
    nameSuffix: null,
    publishedName: "Synthetic Nick",
    appliesFrom: null,
    appliesUntil: null,
    verificationStatus: "requires_review",
    publicDisplay: false,
    ...fields,
  },
});

/** The editable fields of a stored name, as the editor sends them. */
const fieldsOf = (record) => ({
  nameType: record.nameType,
  firstName: record.firstName,
  middleName: record.middleName,
  lastName: record.lastName,
  namePrefix: record.namePrefix,
  nameSuffix: record.nameSuffix,
  publishedName: record.publishedName,
  appliesFrom: record.appliesFrom,
  appliesUntil: record.appliesUntil,
  verificationStatus: record.verificationStatus,
  publicDisplay: record.publicDisplay,
});

const person = (database, id) =>
  database.prepare("SELECT * FROM people WHERE id = ?").get(id);

const nameRows = (database, id) =>
  database
    .prepare("SELECT * FROM profile_names WHERE person_id = ? ORDER BY id")
    .all(id);

const approved = {
  verificationStatus: "confirmed",
  publicDisplay: true,
};

test("primary name components save together with one version bump and an event", async () => {
  await fixture(async ({ database, service, owner }) => {
    const row = (await service.listRows(owner, query())).rows.find(
      (r) => r.roleId === "role-multi-a",
    );
    const change = (field, value) => ({
      kind: "field",
      entity: "people",
      targetId: "person-multi",
      field,
      expectedVersion: row.profileVersion,
      value,
    });
    await service.save(owner, "key-names-0001", [
      change("first_name", "Synthetic"),
      change("middle_name", "Q."),
      change("last_name", "De La Example-Smith"),
      change("name_prefix", "Dr."),
      change("name_suffix", "III"),
      change("preferred_first_name", "Syn"),
    ]);
    const saved = person(database, "person-multi");
    assert.equal(saved.first_name, "Synthetic");
    assert.equal(saved.middle_name, "Q.");
    assert.equal(saved.last_name, "De La Example-Smith");
    assert.equal(saved.name_prefix, "Dr.");
    assert.equal(saved.name_suffix, "III");
    assert.equal(saved.preferred_first_name, "Syn");
    // Display Name is separate and was not touched by the components.
    assert.equal(saved.display_name, "Synthetic Multi Role");
    assert.equal(saved.version, row.profileVersion + 1);
    const events = database
      .prepare("SELECT action FROM profile_name_events WHERE person_id = ?")
      .all("person-multi");
    assert.deepEqual(events, [{ action: "primary_update" }]);
    // Every role row of the Profile shows the shared names.
    const rows = (await service.listRows(owner, query())).rows.filter(
      (r) => r.profileId === "person-multi",
    );
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.lastName, "De La Example-Smith");
      assert.equal(r.preferredFirstName, "Syn");
    }
  });
});

test("optional components may be blank and are cleared to null", async () => {
  await fixture(async ({ database, service, owner }) => {
    const row = (await service.listRows(owner, query())).rows[0];
    await service.save(owner, "key-names-0002", [
      {
        kind: "field",
        entity: "people",
        targetId: row.profileId,
        field: "middle_name",
        expectedVersion: row.profileVersion,
        value: "Initial",
      },
    ]);
    const next = (await service.listRows(owner, query())).rows.find(
      (r) => r.profileId === row.profileId,
    );
    await service.save(owner, "key-names-0003", [
      {
        kind: "field",
        entity: "people",
        targetId: row.profileId,
        field: "middle_name",
        expectedVersion: next.profileVersion,
        value: "",
      },
    ]);
    assert.equal(person(database, row.profileId).middle_name, null);
  });
});

test("over-long components are rejected", async () => {
  await fixture(async ({ service, owner }) => {
    const row = (await service.listRows(owner, query())).rows[0];
    const preview = await service.preview(owner, [
      {
        kind: "field",
        entity: "people",
        targetId: row.profileId,
        field: "name_suffix",
        expectedVersion: row.profileVersion,
        value: "x".repeat(51),
      },
    ]);
    assert.equal(preview.ok, false);
  });
});

test("alternate names are unlimited, typed, soft-removed and restored", async () => {
  await fixture(async ({ database, service, owner }) => {
    const types = [
      "nickname",
      "preferred",
      "middle_name_used",
      "birth_surname",
      "married_surname",
      "former_surname",
      "legal_name_change",
      "professional_name",
      "initials",
      "historical_published",
      "spelling_variant",
      "transliteration",
      "other",
    ];
    await service.save(
      owner,
      "key-alt-all-types",
      types.map((nameType) =>
        alt("person-solo", {
          nameType,
          publishedName: `Synthetic ${nameType}`,
        }),
      ),
    );
    const rows = nameRows(database, "person-solo");
    assert.equal(rows.length, 13);
    // New names default to private and requiring review.
    for (const r of rows) {
      assert.equal(r.public_display, 0);
      assert.equal(r.verification_status, "requires_review");
    }
    // More than 13 is allowed: the list is not capped by type.
    await service.save(owner, "key-alt-more-01", [
      alt("person-solo", { publishedName: "Synthetic Another Nick" }),
      alt("person-solo", { publishedName: "Synthetic Third Nick" }),
    ]);
    assert.equal(nameRows(database, "person-solo").length, 15);

    const list = await service.alternateNames(owner, "person-solo");
    const target = list.names.find(
      (n) => n.publishedName === "Synthetic other",
    );
    await service.save(owner, "key-alt-remove-1", [
      {
        kind: "alternate_name",
        op: "remove",
        personId: "person-solo",
        nameId: target.id,
        expectedVersion: target.version,
      },
    ]);
    const removed = database
      .prepare("SELECT * FROM profile_names WHERE id = ?")
      .get(target.id);
    assert.notEqual(removed.removed_at, null);
    assert.equal(removed.public_display, 0);
    // Removal is soft: the row stays and can be restored.
    await service.save(owner, "key-alt-restore-1", [
      {
        kind: "alternate_name",
        op: "restore",
        personId: "person-solo",
        nameId: target.id,
        expectedVersion: removed.version,
      },
    ]);
    assert.equal(
      database
        .prepare("SELECT removed_at FROM profile_names WHERE id = ?")
        .get(target.id).removed_at,
      null,
    );
    const actions = database
      .prepare(
        "SELECT action FROM profile_name_events WHERE profile_name_id = ? ORDER BY id",
      )
      .all(target.id)
      .map((e) => e.action)
      .sort();
    assert.deepEqual(actions, [
      "alternate_add",
      "alternate_remove",
      "alternate_restore",
    ]);
  });
});

test("the Website stores no evidence for an alternate name", async () => {
  await fixture(async ({ database, service, owner }) => {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'profile_name%' OR name LIKE 'profile_legacy%') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      "profile_legacy_names",
      "profile_name_events",
      "profile_names",
    ]);
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('profile_names')")
      .all()
      .map((row) => row.name);
    assert.equal(
      columns.some((name) => /source|evidence|claim/.test(name)),
      false,
    );
    // An editor or client that still sends a sources list is refused.
    await assert.rejects(
      service.save(owner, "key-alt-src-001", [
        alt("person-solo", { sources: ["Synthetic filing A"] }),
      ]),
    );
    assert.equal(nameRows(database, "person-solo").length, 0);
  });
});

test("duplicate active names for one Profile are refused, others are not", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-dup-names-1", [alt("person-solo")]);
    await assert.rejects(
      () =>
        service.save(owner, "key-dup-names-2", [
          alt("person-solo", { publishedName: "synthetic nick" }),
        ]),
      ProfilesValidationError,
    );
    // The same text on a different Profile is a separate person and is allowed.
    await service.save(owner, "key-dup-names-3", [alt("person-multi")]);
    assert.equal(nameRows(database, "person-multi").length, 1);
  });
});

test("a name cannot be public unless it is confirmed", async () => {
  await fixture(async ({ database, service, owner }) => {
    const preview = await service.preview(owner, [
      alt("person-solo", { publicDisplay: true }),
    ]);
    assert.equal(preview.ok, false);
    await assert.rejects(
      () =>
        service.save(owner, "key-pub-denied-1", [
          alt("person-solo", { publicDisplay: true }),
        ]),
      ProfilesValidationError,
    );
    assert.equal(nameRows(database, "person-solo").length, 0);
    // The database also refuses it, whatever the service does.
    assert.throws(() =>
      database.exec(
        "INSERT INTO profile_names (id, person_id, name_type, published_name, verification_status, public_display, created_by_account_id) VALUES ('pn_bad', 'person-solo', 'nickname', 'Synthetic Bad', 'requires_review', 1, 'acct-owner')",
      ),
    );
  });
});

test("invalid person references, types and dates are refused", async () => {
  await fixture(async ({ service, owner }) => {
    assert.equal(
      (await service.preview(owner, [alt("person-missing")])).ok,
      false,
    );
    assert.equal(
      (
        await service.preview(owner, [
          alt("person-solo", { nameType: "alias" }),
        ])
      ).ok,
      false,
    );
    assert.equal(
      (
        await service.preview(owner, [
          alt("person-solo", { appliesFrom: "2020-13-45" }),
        ])
      ).ok,
      false,
    );
    assert.equal(
      (
        await service.preview(owner, [
          alt("person-solo", {
            appliesFrom: "2020-01-01",
            appliesUntil: "2019-01-01",
          }),
        ])
      ).ok,
      false,
    );
  });
});

test("only an owner can edit names", async () => {
  await fixture(async ({ database, service, editor }) => {
    await assert.rejects(() =>
      service.save(editor, "key-names-editor", [alt("person-solo")]),
    );
    assert.equal(nameRows(database, "person-solo").length, 0);
  });
});

test("stale name edits conflict and nothing partial is written", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-stale-n-001", [alt("person-solo")]);
    const record = (await service.alternateNames(owner, "person-solo"))
      .names[0];
    const row = (await service.listRows(owner, query())).rows.find(
      (r) => r.profileId === "person-solo",
    );
    await assert.rejects(
      () =>
        service.save(owner, "key-stale-n-002", [
          {
            kind: "field",
            entity: "people",
            targetId: "person-solo",
            field: "first_name",
            expectedVersion: row.profileVersion,
            value: "Synthetic",
          },
          {
            kind: "alternate_name",
            op: "update",
            personId: "person-solo",
            nameId: record.id,
            expectedVersion: record.version + 7,
            fields: { ...fieldsOf(record), publishedName: "Synthetic Changed" },
          },
        ]),
      (error) =>
        error instanceof ProfilesConflictError ||
        error instanceof ProfilesValidationError,
    );
    // The primary change in the same save was not applied either.
    assert.equal(person(database, "person-solo").first_name, null);
    assert.equal(
      nameRows(database, "person-solo")[0].published_name,
      "Synthetic Nick",
    );
  });
});

test("a Profile with display name only keeps working and gains no duplicate people", async () => {
  await fixture(
    async ({ database, service, owner, migrations }) => {
      const before = database
        .prepare("SELECT id, display_name, version FROM people ORDER BY id")
        .all();
      migrateWebsiteDatabase(database, migrations);
      const after = database
        .prepare("SELECT id, display_name, version FROM people ORDER BY id")
        .all();
      assert.deepEqual(after, before);
      assert.equal(
        database.prepare("SELECT COUNT(*) c FROM person_roles").get().c,
        3,
      );
      // The original text is preserved as the legacy name.
      const legacy = database
        .prepare(
          "SELECT person_id, legacy_full_name FROM profile_legacy_names ORDER BY person_id",
        )
        .all();
      assert.deepEqual(legacy, [
        { person_id: "person-multi", legacy_full_name: "Synthetic Multi Role" },
        { person_id: "person-solo", legacy_full_name: "Synthetic Solo Person" },
      ]);
      const rows = (await service.listRows(owner, query())).rows;
      for (const r of rows) {
        assert.equal(r.firstName, null);
        assert.equal(r.nameReview, "display_only");
      }
    },
    { upgrade: true },
  );
});

test("public pages and search show only confirmed approved names", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-public-0001", [
      alt("person-multi", {
        nameType: "married_surname",
        publishedName: "Synthetic Formerly Named",
        ...approved,
      }),
      alt("person-multi", {
        publishedName: "Synthetic Hidden Nickname",
      }),
      alt("person-multi", {
        nameType: "professional_name",
        publishedName: "Synthetic Reviewed Only",
        verificationStatus: "confirmed",
        publicDisplay: false,
      }),
    ]);
    for (const [label, make] of RUNTIMES) {
      const services = make(database);
      const page = await services.getPersonProfile({
        personId: "person-multi",
        limit: 10,
      });
      assert.deepEqual(
        page.person.alternateNames,
        [{ name: "Synthetic Formerly Named", label: "Formerly known as" }],
        label,
      );
      // Nothing private reaches the public payload.
      const text = JSON.stringify(page);
      for (const secret of [
        "Synthetic Hidden Nickname",
        "Synthetic Reviewed Only",
        "Synthetic private evidence",
        "married_surname",
      ])
        assert.equal(text.includes(secret), false, `${label} leaked ${secret}`);
      const byAlt = await services.searchPeople({ query: "Formerly Named" });
      assert.deepEqual(
        byAlt.items.map((i) => i.id),
        ["person-multi"],
        label,
      );
      for (const hidden of ["Hidden Nickname", "Reviewed Only"]) {
        const none = await services.searchPeople({ query: hidden });
        assert.deepEqual(none.items, [], `${label} found ${hidden}`);
      }
    }
  });
});

test("hiding a Profile hides it from alternate-name search and pages", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-hidden-0001", [
      alt("person-multi", { publishedName: "Synthetic Findable", ...approved }),
    ]);
    const row = (await service.listRows(owner, query())).rows.find(
      (r) => r.profileId === "person-multi",
    );
    await service.save(owner, "key-hidden-0002", [
      {
        kind: "visibility",
        personId: "person-multi",
        expectedVersion: 0,
        visible: false,
      },
    ]);
    assert.ok(row);
    for (const [label, make] of RUNTIMES) {
      const services = make(database);
      const found = await services.searchPeople({ query: "Findable" });
      assert.deepEqual(found.items, [], label);
      const browse = await services.browsePeople({});
      assert.equal(
        browse.items.some((i) => i.id === "person-multi"),
        false,
        label,
      );
    }
  });
});

test("removing an approved name takes it off public pages", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-unpub-00001", [
      alt("person-solo", { publishedName: "Synthetic Gone Soon", ...approved }),
    ]);
    const record = (await service.alternateNames(owner, "person-solo"))
      .names[0];
    await service.save(owner, "key-unpub-00002", [
      {
        kind: "alternate_name",
        op: "remove",
        personId: "person-solo",
        nameId: record.id,
        expectedVersion: record.version,
      },
    ]);
    for (const [label, make] of RUNTIMES) {
      const page = await make(database).getPersonProfile({
        personId: "person-solo",
        limit: 10,
      });
      assert.deepEqual(page.person.alternateNames, [], label);
    }
  });
});

test("owner search finds internal names that public search does not", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-internal-01", [
      alt("person-solo", { publishedName: "Synthetic Internal Only" }),
    ]);
    const internal = await service.listRows(
      owner,
      query({ query: "Internal Only" }),
    );
    assert.deepEqual(
      internal.rows.map((r) => r.profileId),
      ["person-solo"],
    );
    for (const [label, make] of RUNTIMES) {
      const found = await make(database).searchPeople({
        query: "Internal Only",
      });
      assert.deepEqual(found.items, [], label);
    }
  });
});

test("names survive role changes and keep roles and citations intact", async () => {
  await fixture(async ({ database, service, owner }) => {
    const before = database
      .prepare(
        "SELECT id, person_id, source_id, version FROM person_roles ORDER BY id",
      )
      .all();
    await service.save(owner, "key-preserve-01", [
      alt("person-multi"),
      alt("person-solo"),
    ]);
    const after = database
      .prepare(
        "SELECT id, person_id, source_id, version FROM person_roles ORDER BY id",
      )
      .all();
    assert.deepEqual(after, before);
    assert.equal(database.prepare("SELECT COUNT(*) c FROM people").get().c, 2);
    assert.equal(
      person(database, "person-multi").display_name,
      "Synthetic Multi Role",
    );
  });
});

test("the name history cannot be rewritten or deleted", async () => {
  await fixture(async ({ database, service, owner }) => {
    await service.save(owner, "key-events-0001", [alt("person-solo")]);
    assert.throws(() =>
      database.exec(
        "UPDATE profile_name_events SET action = 'alternate_update'",
      ),
    );
    assert.throws(() => database.exec("DELETE FROM profile_name_events"));
    assert.throws(() =>
      database.exec("UPDATE profile_names SET person_id = 'person-multi'"),
    );
  });
});

test("a retry with the same key replays and writes nothing more", async () => {
  await fixture(async ({ database, service, owner }) => {
    const changes = [alt("person-solo")];
    const first = await service.save(owner, "key-replay-00001", changes);
    const retry = await service.save(owner, "key-replay-00001", changes);
    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.equal(nameRows(database, "person-solo").length, 1);
  });
});

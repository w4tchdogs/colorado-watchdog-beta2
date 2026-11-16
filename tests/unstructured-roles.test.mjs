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
  d1DirectoryRunner,
  listOfficials,
  sqliteDirectoryRunner,
} from "../dist/services/officials-directory.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangeset } from "../dist/services/sync-commit.js";
import { planSyncChangeset } from "../dist/services/sync-planner.js";

const ROLE_MIGRATION = "0022_unstructured_person_roles.sql";
const ID = "5b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const NOW = () => new Date("2026-11-13T12:00:00.000Z");

function d1Over(database) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    async first() {
      return database.prepare(sql).get(...values) ?? null;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values) };
    },
  });
  return new AsyncD1Database({ prepare: (sql) => statement(sql) });
}

function seedStructured(database) {
  database.exec(`
    INSERT INTO organizations (id,name,organization_type,county_fips,version)
      VALUES ('org-1','Synthetic Clerk Office','office','08001',2);
    INSERT INTO people (id,display_name,version) VALUES ('person-1','Synthetic Existing Person',4);
    INSERT INTO positions (id,organization_id,title,version) VALUES ('pos-1','org-1','Synthetic Clerk',3);
    INSERT INTO role_sources (id,url,title,source_type,publisher_classification,version)
      VALUES ('src-1','https://example.invalid/official','Synthetic Official Listing','official_page','official',2);
    INSERT INTO person_roles (id,person_id,position_id,source_id,start_date,source_checked_at,version,created_at,updated_at)
      VALUES ('role-1','person-1','pos-1','src-1','2020-01-02','2026-10-01T00:00:00Z',5,'2026-01-01T00:00:00.000Z','2026-02-02T00:00:00.000Z');
  `);
}

test("upgrade from a populated database preserves roles, IDs, citations and versions", async () => {
  const database = await openWebsiteDatabase();
  try {
    const migrations = loadWebsiteMigrations();
    const before = migrations.filter(
      (migration) => migration.name < ROLE_MIGRATION,
    );
    assert.ok(
      migrations.some((migration) => migration.name === ROLE_MIGRATION),
    );
    migrateWebsiteDatabase(database, before);
    seedStructured(database);
    const roleBefore = database.prepare("SELECT * FROM person_roles").all();
    const generation = database
      .prepare(
        "SELECT generation FROM website_dependency_generation WHERE id=1",
      )
      .get().generation;

    migrateWebsiteDatabase(database, migrations);

    const [after] = database.prepare("SELECT * FROM person_roles").all();
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM person_roles").get().n,
      1,
    );
    for (const key of Object.keys(roleBefore[0])) {
      assert.equal(after[key], roleBefore[0][key], key);
    }
    assert.equal(
      after.county_fips,
      "08001",
      "county comes from the linked organization",
    );
    assert.equal(after.published_office, null);
    assert.equal(after.published_title, null);
    assert.equal(after.job_description, null);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(
      database
        .prepare(
          "SELECT generation FROM website_dependency_generation WHERE id=1",
        )
        .get().generation,
      generation,
    );
    // Triggers survive the table rebuild.
    assert.throws(() =>
      database
        .prepare("UPDATE person_roles SET version=9 WHERE id='role-1'")
        .run(),
    );
    database
      .prepare("UPDATE person_roles SET version=6 WHERE id='role-1'")
      .run();
    assert.equal(
      database
        .prepare(
          "SELECT generation FROM website_dependency_generation WHERE id=1",
        )
        .get().generation,
      generation + 1,
    );
  } finally {
    database.close();
  }
});

test("a role needs a position link or a documented detail, and a county without a position", async () => {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    seedStructured(database);
    const insert = (columns, values) =>
      database
        .prepare(
          `INSERT INTO person_roles (id,person_id,source_id,source_checked_at,${columns}) VALUES ('r-${Math.random()}','person-1','src-1','2026-11-01T00:00:00Z',${values.map(() => "?").join(",")})`,
        )
        .run(...values);
    assert.throws(() => insert("county_fips", ["08001"]), /CHECK/);
    assert.throws(
      () => insert("published_office", ["Synthetic Office"]),
      /CHECK/,
    );
    assert.throws(
      () => insert("county_fips,published_title", ["08001", "   "]),
      /CHECK/,
    );
    insert("county_fips,published_office", ["08001", "Synthetic Office"]);
    insert("county_fips,published_title", ["08001", "Synthetic Deputy"]);
    insert("county_fips,job_description", ["08001", "Reviews permits"]);
  } finally {
    database.close();
  }
});

function request(changes, intent = "commit") {
  return { contractVersion: "m2-sync/v1", requestId: ID, intent, changes };
}
const create = (op, entity, clientRef, fields) => ({
  op,
  entity,
  clientRef,
  fields,
});
const source = create("register_source", "role_sources", "source", {
  url: "https://example.invalid/public",
  title: "Synthetic public listing",
  publisher_classification: "unofficial",
  source_type: "other_public",
});
const person = (ref, name) =>
  create("create_person", "people", ref, { display_name: name });
const role = (ref, personRef, fields) =>
  create("create_person_role", "person_roles", ref, {
    person_ref: personRef,
    source_ref: "source",
    county_fips: "08001",
    source_checked_at: "2026-11-12T12:00:00Z",
    ...fields,
  });

test("planner accepts the three unstructured cases and rejects missing details, county or citation", async () => {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    const people = [
      person("p1", "Synthetic One"),
      person("p2", "Synthetic Two"),
      person("p3", "Synthetic Three"),
    ];
    const accepted = planSyncChangeset(
      database,
      request(
        [
          source,
          ...people,
          role("r1", "p1", { published_office: "Synthetic Office" }),
          role("r2", "p2", { job_description: "Reviews permits" }),
          role("r3", "p3", { published_title: "Synthetic Deputy" }),
        ],
        "dry_run",
      ),
      NOW,
    );
    assert.equal(accepted.eligible, true, JSON.stringify(accepted.errors));

    const codes = (changes) =>
      planSyncChangeset(
        database,
        request([source, people[0], ...changes], "dry_run"),
        NOW,
      ).errors.map((error) => error.code);
    assert.ok(codes([role("bad", "p1", {})]).includes("role_detail_required"));
    assert.ok(
      codes([role("bad", "p1", { published_office: "   " })]).includes(
        "invalid_field",
      ),
    );
    const noCounty = role("bad", "p1", {
      published_office: "Synthetic Office",
    });
    delete noCounty.fields.county_fips;
    assert.ok(codes([noCounty]).includes("missing_field"));
    const noSource = role("bad", "p1", {
      published_office: "Synthetic Office",
    });
    delete noSource.fields.source_ref;
    assert.ok(codes([noSource]).includes("relationship_conflict"));
    assert.ok(
      codes([
        role("bad", "p1", {
          published_office: "Synthetic Office",
          county_fips: "99999",
        }),
      ]).includes("unknown_county"),
    );
  } finally {
    database.close();
  }
});

async function committedFixture(callback) {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    seedStructured(database);
    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name, preferences)
        VALUES ('owner-a','human','owner','Synthetic Owner','{}');
      INSERT INTO identities (id, account_id, provider, subject)
        VALUES ('identity-a','owner-a','test-human','subject-a');
    `);
    const adapter = createTestHumanIdentityAdapter({ a: "subject-a" });
    const principal = await resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": "a" },
      }),
      adapter,
    );
    const result = await commitSyncChangeset(
      database,
      principal,
      "unstructured-roles-key",
      request([
        source,
        person("p1", "Synthetic Office Person"),
        person("p2", "Synthetic Duties Person"),
        person("p3", "Synthetic Title Person"),
        role("r1", "p1", { published_office: "Synthetic Assessor Office" }),
        role("r2", "p2", { job_description: "Reviews building permits" }),
        role("r3", "p3", { published_title: "Synthetic Deputy" }),
      ]),
      NOW,
    );
    assert.equal(result.status, "committed", JSON.stringify(result));
    await callback(database);
  } finally {
    database.close();
  }
}

const RUNTIMES = [
  ["SQL.js", (database) => createServices({ database }), sqliteDirectoryRunner],
  [
    "D1",
    (database) => createD1PublicReadServices(d1Over(database)),
    (database) => d1DirectoryRunner(d1Over(database)),
  ],
];

test("committed unstructured roles appear with county and citation in profile and county reads", async () => {
  await committedFixture(async (database) => {
    for (const [label, makeServices, makeRunner] of RUNTIMES) {
      const services = makeServices(database);
      const byName = Object.fromEntries(
        database
          .prepare("SELECT id, display_name FROM people")
          .all()
          .map((row) => [row.display_name, row.id]),
      );

      const office = await services.getPersonProfile({
        personId: byName["Synthetic Office Person"],
        limit: 5,
      });
      const officeRole = office.items[0];
      assert.equal(officeRole.position, null, label);
      assert.equal(officeRole.organization, null, label);
      assert.equal(
        officeRole.role.publishedOffice,
        "Synthetic Assessor Office",
        label,
      );
      assert.equal(officeRole.role.publishedTitle, null, label);
      assert.equal(officeRole.role.jobDescription, null, label);
      assert.deepEqual(
        officeRole.role.county,
        { fips: "08001", name: "Adams" },
        label,
      );
      assert.equal(
        officeRole.source.url,
        "https://example.invalid/public",
        label,
      );
      assert.equal(
        officeRole.source.publisherClassification,
        "unofficial",
        label,
      );

      const duties = await services.getPersonProfile({
        personId: byName["Synthetic Duties Person"],
        limit: 5,
      });
      assert.equal(
        duties.items[0].role.jobDescription,
        "Reviews building permits",
        label,
      );
      assert.equal(duties.items[0].role.publishedTitle, null, label);

      const title = await services.getPersonProfile({
        personId: byName["Synthetic Title Person"],
        limit: 5,
      });
      assert.equal(
        title.items[0].role.publishedTitle,
        "Synthetic Deputy",
        label,
      );
      assert.equal(title.items[0].organization, null, label);

      const county = await services.listCountyRoleEntries({
        countyFips: "08001",
        limit: 10,
      });
      assert.equal(county.items.length, 4, label);
      assert.deepEqual(
        county.items.map((entry) => entry.person.displayName).sort(),
        [
          "Synthetic Duties Person",
          "Synthetic Existing Person",
          "Synthetic Office Person",
          "Synthetic Title Person",
        ],
        label,
      );
      assert.equal(
        county.items.find(
          (entry) => entry.person.displayName === "Synthetic Existing Person",
        ).position.title,
        "Synthetic Clerk",
        label,
      );
      const other = await services.listCountyRoleEntries({
        countyFips: "08003",
        limit: 10,
      });
      assert.equal(other.items.length, 0, label);

      const overview = await services.getCountyOverview({
        countyFips: "08001",
      });
      assert.equal(overview.documentedRoleCount, 4, label);

      const officials = await listOfficials(makeRunner(database), {
        countyFips: "08001",
      });
      assert.equal(officials.total, 4, label);
      const duty = officials.items.find(
        (item) => item.person.displayName === "Synthetic Duties Person",
      );
      assert.equal(duty.role.jobDescription, "Reviews building permits", label);
      assert.equal(duty.role.position, null, label);
      assert.equal(duty.role.organization, null, label);
      assert.deepEqual(
        duty.role.county,
        { fips: "08001", name: "Adams" },
        label,
      );
      const searched = await listOfficials(makeRunner(database), {
        countyFips: "08001",
        query: "permits",
      });
      assert.equal(searched.total, 1, label);
    }
  });
});

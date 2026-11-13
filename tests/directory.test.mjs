import assert from "node:assert/strict";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { DirectoryInputError } from "../dist/services/directory.js";
import { createServices } from "../dist/services/index.js";

async function fixture(callback) {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    const services = createServices({ database });
    await callback(database, services);
  } finally {
    database.close();
  }
}

function seed(database) {
  database
    .prepare(`INSERT INTO organizations (id,name,organization_type,county_fips,parent_organization_id,parent_relationship,version) VALUES
    ('adams-gov','Synthetic Adams Government','county_government','08001',NULL,NULL,3),
    ('adams-office','Synthetic Adams Clerk Office','office','08001','adams-gov','reports_to',2),
    ('adams-health','Synthetic Adams Health','department','08001','adams-gov','grouped_under',1),
    ('partner','Synthetic Shared Partner','partner',NULL,NULL,NULL,2),
    ('regional','Synthetic Regional Service','regional',NULL,NULL,NULL,1),
    ('unrelated','Synthetic Unrelated','office','08013',NULL,NULL,1)`)
    .run();
  database
    .prepare(`INSERT INTO organization_county_affiliations (id,organization_id,county_fips,relationship_type) VALUES
    ('partner-adams','partner','08001','shared_service'), ('partner-boulder','partner','08013','shared_service'),
    ('regional-adams','regional','08001','serves'), ('regional-boulder','regional','08013','partner_for'),
    ('adams-health-aff','adams-health','08001','serves')`)
    .run();
  database
    .prepare(`INSERT INTO people(id,display_name,version) VALUES
    ('person-a','Synthetic Alex Example',4),('person-b','Synthetic Alex Example',1)`)
    .run();
  database
    .prepare(`INSERT INTO positions(id,organization_id,title,version) VALUES
    ('position-1','adams-office','Synthetic Clerk',2),('position-2','regional','Synthetic Regional Liaison',1),
    ('position-3','partner','Synthetic Shared Coordinator',1),('position-4','unrelated','Synthetic Other Role',1)`)
    .run();
  database
    .prepare(`INSERT INTO role_sources(id,url,title,source_type,version) VALUES
    ('source-1','https://example.invalid/adams','Synthetic Adams Public Directory','official_page',2),
    ('source-2','https://example.invalid/partner','Synthetic Partner Public Listing','public_document',1)`)
    .run();
  database
    .prepare(`INSERT INTO person_roles(id,person_id,position_id,source_id,start_date,end_date,source_checked_at,version) VALUES
    ('role-1','person-a','position-1','source-1','2020-01-02',NULL,'2026-10-01T00:00:00Z',3),
    ('role-2','person-a','position-2','source-1',NULL,'2024-05-06','2026-10-02T00:00:00Z',1),
    ('role-3','person-b','position-3','source-2',NULL,NULL,'2026-10-03T00:00:00Z',1),
    ('role-4','person-b','position-4','source-2',NULL,NULL,'2026-10-04T00:00:00Z',1)`)
    .run();
}

test("bounded county organization and role reads preserve explicit relationships and public fields", async () => {
  await fixture(async (database, services) => {
    seed(database);
    const orgs = services.listCountyOrganizations({ countyFips: "08001" });
    assert.deepEqual(
      orgs.items.map(({ id }) => id),
      ["adams-gov", "adams-health", "adams-office", "partner", "regional"],
    );
    assert.equal(
      orgs.items.find(({ id }) => id === "adams-health").countyAssociation
        .affiliations[0],
      "serves",
    );
    assert.deepEqual(
      orgs.items.find(({ id }) => id === "partner").countyAssociation,
      { direct: false, affiliations: ["shared_service"] },
    );
    assert.equal(
      orgs.items.find(({ id }) => id === "adams-office").parentRelationship,
      "reports_to",
    );
    assert.equal(
      orgs.items.find(({ id }) => id === "adams-health").parentRelationship,
      "grouped_under",
    );
    assert.equal(orgs.items.find(({ id }) => id === "adams-gov").version, 3);

    const roles = services.listCountyRoleEntries({ countyFips: "08001" });
    assert.deepEqual(
      roles.items.map(({ role }) => role.id),
      ["role-1", "role-2", "role-3"],
    );
    assert.equal(roles.items[0].person.id, "person-a");
    assert.equal(roles.items[1].person.id, "person-a");
    assert.equal(roles.items[2].person.id, "person-b");
    assert.equal(
      roles.items[0].person.displayName,
      roles.items[2].person.displayName,
    );
    assert.equal(roles.items[0].role.version, 3);
    assert.equal(roles.items[0].role.startDate, "2020-01-02");
    assert.equal(roles.items[0].role.endDate, null);
    assert.equal(roles.items[0].position.version, 2);
    assert.deepEqual(roles.items[2].source, {
      id: "source-2",
      title: "Synthetic Partner Public Listing",
      url: "https://example.invalid/partner",
      type: "public_document",
      version: 1,
    });
    assert.deepEqual(roles.items[2].organization.countyAssociation, {
      direct: false,
      affiliations: ["shared_service"],
    });
    assert.equal(JSON.stringify(roles).includes("Synthetic User"), false);
    assert.equal(JSON.stringify(roles).includes("credential"), false);
  });
});

test("empty pages, unknown counties, validation, stable continuation and read-only behavior", async () => {
  await fixture(async (database, services) => {
    assert.deepEqual(
      services.listCountyOrganizations({ countyFips: "08001" }),
      { items: [], hasMore: false, nextCursor: null },
    );
    assert.deepEqual(services.listCountyRoleEntries({ countyFips: "08001" }), {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    assert.deepEqual(
      services.listCountyOrganizations({ countyFips: "08999" }),
      { items: [], hasMore: false, nextCursor: null },
    );
    for (const input of [
      { countyFips: "01001" },
      { countyFips: "08001", limit: 0 },
      { countyFips: "08001", limit: 101 },
      { countyFips: "08001", limit: 1.5 },
      { countyFips: "08001", afterId: "bad cursor" },
      { countyFips: "08001", afterId: "" },
    ])
      assert.throws(
        () => services.listCountyOrganizations(input),
        DirectoryInputError,
      );

    seed(database);
    const before = database
      .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    const versions = database
      .prepare("SELECT id,version FROM organizations ORDER BY id")
      .all();
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get().count;
    const first = services.listCountyOrganizations({
      countyFips: "08001",
      limit: 2,
    });
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, first.items[1].id);
    const second = services.listCountyOrganizations({
      countyFips: "08001",
      limit: 2,
      afterId: first.nextCursor,
    });
    const third = services.listCountyOrganizations({
      countyFips: "08001",
      limit: 2,
      afterId: second.nextCursor,
    });
    assert.equal(second.hasMore, true);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items, ...third.items].map(({ id }) => id),
      ["adams-gov", "adams-health", "adams-office", "partner", "regional"],
    );

    const roleFirst = services.listCountyRoleEntries({
      countyFips: "08001",
      limit: 2,
    });
    const roleSecond = services.listCountyRoleEntries({
      countyFips: "08001",
      limit: 2,
      afterId: roleFirst.nextCursor,
    });
    assert.deepEqual(
      [...roleFirst.items, ...roleSecond.items].map(({ role }) => role.id),
      ["role-1", "role-2", "role-3"],
    );
    assert.equal(roleSecond.hasMore, false);
    const emptyContinuation = services.listCountyRoleEntries({
      countyFips: "08001",
      afterId: "zzzzzz",
    });
    assert.deepEqual(emptyContinuation, {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    assert.deepEqual(
      database
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
        .all(),
      before,
    );
    assert.deepEqual(
      database
        .prepare("SELECT id,version FROM organizations ORDER BY id")
        .all(),
      versions,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM audit_events").get()
        .count,
      auditCount,
    );
  });
});

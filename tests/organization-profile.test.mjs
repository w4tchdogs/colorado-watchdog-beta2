import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createServices } from "../dist/services/index.js";
import {
  getOrganizationProfile,
  listOrganizationRoleEntries,
  OrganizationProfileInputError,
} from "../dist/services/organization-profile.js";

async function fixture(callback) {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    await callback(database, createServices({ database }));
  } finally {
    database.close();
  }
}

function seed(database) {
  database
    .prepare(
      `INSERT INTO organizations
       (id,name,organization_type,county_fips,parent_organization_id,parent_relationship,version)
       VALUES
       ('county-office','Synthetic County Office','office','08001',NULL,NULL,3),
       ('county-division','Synthetic County Division','department','08001','county-office','grouped_under',2),
       ('regional-agency','Synthetic Regional Agency','regional','08001','county-office','reports_to',5),
       ('partner-office','Synthetic Partner Office','partner',NULL,NULL,NULL,1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO organization_county_affiliations
       (id,organization_id,county_fips,relationship_type,version)
       VALUES
       ('regional-adams','regional-agency','08001','serves',3),
       ('regional-boulder','regional-agency','08013','partner_for',2),
       ('partner-boulder','partner-office','08013','shared_service',2),
       ('county-boulder','county-office','08013','serves',4)`,
    )
    .run();
  database
    .prepare("INSERT INTO people(id,display_name,version) VALUES (?, ?, ?)")
    .run("person-a", "Synthetic Alex Example", 4);
  database
    .prepare("INSERT INTO people(id,display_name,version) VALUES (?, ?, ?)")
    .run("person-b", "Synthetic Jamie Example", 2);
  database
    .prepare(
      `INSERT INTO positions(id,organization_id,title,version)
       VALUES
       ('position-1','county-office','Synthetic Clerk',2),
       ('position-2','county-office','Synthetic Analyst',1),
       ('position-3','regional-agency','Synthetic Regional Liaison',1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO role_sources(id,url,title,source_type,version)
       VALUES
       ('source-1','https://example.invalid/official','Synthetic Official Listing','official_page',2),
       ('source-2','https://example.invalid/document','Synthetic Public Document','public_document',3)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO person_roles
       (id,person_id,position_id,source_id,start_date,end_date,source_checked_at,version)
       VALUES
       ('role-a','person-a','position-1','source-1','2020-01-02',NULL,'2026-10-01T00:00:00Z',5),
       ('role-b','person-a','position-3','source-2',NULL,'2024-05-06','2026-10-02T00:00:00Z',2),
       ('role-c','person-b','position-2','source-1',NULL,NULL,'2026-10-03T00:00:00Z',1)`,
    )
    .run();
}

test("organization profiles preserve county associations, hierarchy, and pagination", async () => {
  await fixture(async (database, services) => {
    seed(database);
    const profile = services.getOrganizationProfile({
      organizationId: "county-office",
      limit: 1,
    });

    assert.deepEqual(profile.organization, {
      id: "county-office",
      name: "Synthetic County Office",
      type: "office",
      version: 3,
    });
    assert.equal(profile.parentOrganization, null);
    assert.deepEqual(profile.counties, [
      {
        fips: "08001",
        name: "Adams",
        direct: true,
        affiliations: [],
      },
      {
        fips: "08013",
        name: "Boulder",
        direct: false,
        affiliations: [
          {
            id: "county-boulder",
            relationshipType: "serves",
            version: 4,
          },
        ],
      },
    ]);
    assert.deepEqual(
      profile.items.map(({ id }) => id),
      ["position-1"],
    );
    assert.equal(profile.hasMore, true);
    assert.equal(profile.nextCursor, "position-1");

    const second = services.getOrganizationProfile({
      organizationId: "county-office",
      limit: 1,
      afterPositionId: profile.nextCursor,
    });
    assert.deepEqual(
      second.items.map(({ id }) => id),
      ["position-2"],
    );
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);

    assert.deepEqual(
      getOrganizationProfile(database, {
        organizationId: "county-office",
        limit: 1,
      }),
      profile,
    );
    assert.deepEqual(
      listOrganizationRoleEntries(database, {
        organizationId: "county-office",
        limit: 1,
      }),
      {
        items: [
          {
            role: {
              id: "role-a",
              version: 5,
              startDate: "2020-01-02",
              endDate: null,
              sourceCheckedAt: "2026-10-01T00:00:00Z",
            },
            person: {
              id: "person-a",
              displayName: "Synthetic Alex Example",
              version: 4,
            },
            position: {
              id: "position-1",
              title: "Synthetic Clerk",
              version: 2,
            },
            source: {
              id: "source-1",
              title: "Synthetic Official Listing",
              url: "https://example.invalid/official",
              type: "official_page",
              version: 2,
            },
          },
        ],
        hasMore: true,
        nextCursor: "role-a",
      },
    );
  });
});

test("organization hierarchy and role pagination preserve record distinctions and validation", async () => {
  await fixture(async (database, services) => {
    seed(database);
    const profile = services.getOrganizationProfile({
      organizationId: "regional-agency",
      limit: 10,
    });
    assert.equal(profile.parentOrganization?.relationshipType, "reports_to");
    assert.equal(profile.parentOrganization?.type, "office");
    assert.equal(profile.parentOrganization?.id, "county-office");
    assert.deepEqual(
      profile.items.map(({ id }) => id),
      ["position-3"],
    );

    const roles = services.listOrganizationRoleEntries({
      organizationId: "regional-agency",
      limit: 1,
    });
    assert.deepEqual(
      roles.items.map(({ role }) => role.id),
      ["role-b"],
    );
    assert.equal(roles.hasMore, false);
    assert.equal(roles.nextCursor, null);

    assert.equal(
      services.getOrganizationProfile({ organizationId: "missing-org" }),
      null,
    );
    assert.equal(
      services.listOrganizationRoleEntries({ organizationId: "missing-org" }),
      null,
    );

    for (const request of [
      { organizationId: "" },
      { organizationId: "../org" },
      { organizationId: "x".repeat(129) },
      { organizationId: "county-office", limit: 0 },
      { organizationId: "county-office", limit: 101 },
      { organizationId: "county-office", afterPositionId: "" },
      { organizationId: "county-office", afterPositionId: "bad cursor" },
      { organizationId: "county-office", afterRoleId: "bad" },
    ]) {
      assert.throws(
        () => getOrganizationProfile(database, request),
        OrganizationProfileInputError,
      );
    }
  });
});

test("organization HTTP endpoints validate route and method behavior", async () => {
  await fixture(async (database, services) => {
    seed(database);
    const application = createApplication(services);
    const request = (url, method = "GET") =>
      application.fetch(new Request(url, { method }));

    const profile = await request(
      "https://watchdog.test/api/organizations/county-office?limit=1",
    );
    assert.equal(profile.status, 200);
    assert.equal(profile.headers.get("cache-control"), "no-store");
    assert.deepEqual((await profile.json()).items.length, 1);

    const roles = await request(
      "https://watchdog.test/api/organizations/county-office/roles?limit=1",
    );
    assert.equal(roles.status, 200);
    assert.deepEqual((await roles.json()).items.length, 1);

    const unknown = await request(
      "https://watchdog.test/api/organizations/missing-org",
    );
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });

    const wrongMethod = await request(
      "https://watchdog.test/api/organizations/county-office",
      "POST",
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    for (const url of [
      "https://watchdog.test/api/organizations/",
      "https://watchdog.test/api/organizations/county-office?afterId=role-a",
      "https://watchdog.test/api/organizations/county-office/roles?afterPositionId=position-1",
      "https://watchdog.test/api/organizations/county-office/roles?limit=0",
    ]) {
      const response = await request(url);
      assert.equal(response.status, 400, url);
    }
  });
});

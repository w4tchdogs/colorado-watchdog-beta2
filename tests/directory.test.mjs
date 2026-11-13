import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { CountyOverviewInputError } from "../dist/services/county-overview.js";
import { DirectoryInputError } from "../dist/services/directory.js";
import { DirectorySearchInputError } from "../dist/services/directory-search.js";
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

function seedSearchRecords(database) {
  const people = [
    ["person-alex-b", "Synthetic Alex Example", 2],
    ["person-alex-a", "Synthetic Alex Example", 1],
    ["person-alice", "Synthetic Alice Example", 3],
    ["person-percent", "Synthetic 100% Office", 1],
    ["person-percent-wild", "Synthetic 100X Office", 1],
    ["person-underscore", "Synthetic _group Unit", 1],
    ["person-underscore-wild", "Synthetic Xgroup Unit", 1],
    ["person-quote", "Synthetic O'Brian Example", 1],
    ["person-backslash", "Synthetic A\\B Example", 1],
  ];
  const insertPerson = database.prepare(
    "INSERT INTO people(id,display_name,version) VALUES (?, ?, ?)",
  );
  for (const person of people) insertPerson.run(...person);
  for (let index = 0; index < 105; index += 1) {
    insertPerson.run(
      `directory-person-${String(index).padStart(3, "0")}`,
      "Synthetic Directory Person",
      1,
    );
  }

  const organizations = [
    ["org-county", "Synthetic County Government", "county_government", "08001"],
    ["org-office", "Synthetic Clerk's Office", "office", null],
    ["org-department", "Synthetic Public Works Department", "department", null],
    ["org-division", "Synthetic Services Division", "division", null],
    ["org-regional", "Synthetic Mountain 100% Regional", "regional", null],
    ["org-partner", "Synthetic County Partner", "partner", null],
    ["org-other", "Synthetic Other Unit", "other", null],
    ["org-underscore", "Synthetic _group Department", "department", null],
    ["org-underscore-wild", "Synthetic Xgroup Department", "division", null],
    ["org-percent-wild", "Synthetic 100X Regional", "regional", null],
  ];
  const insertOrganization = database.prepare(
    `INSERT INTO organizations
     (id,name,organization_type,county_fips,version)
     VALUES (?, ?, ?, ?, 1)`,
  );
  for (const organization of organizations) {
    insertOrganization.run(...organization);
  }
  database
    .prepare(
      `INSERT INTO organization_county_affiliations
       (id,organization_id,county_fips,relationship_type)
       VALUES ('regional-adams','org-regional','08001','serves')`,
    )
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

test("county overview aggregates distinct organizations and documented role records", async () => {
  await fixture(async (database, services) => {
    seed(database);
    database
      .prepare(
        "INSERT INTO positions (id,organization_id,title) VALUES ('position-5','adams-health','Synthetic Health Director')",
      )
      .run();
    database
      .prepare(
        `INSERT INTO person_roles
         (id,person_id,position_id,source_id,start_date,end_date,source_checked_at)
         VALUES ('role-5','person-a','position-5','source-1',NULL,NULL,'2026-10-05T00:00:00Z')`,
      )
      .run();

    assert.deepEqual(services.getCountyOverview({ countyFips: "08001" }), {
      county: { fips: "08001", name: "Adams" },
      organizationCounts: { total: 5, direct: 3, affiliated: 3 },
      documentedRoleCount: 4,
    });
    assert.deepEqual(services.getCountyOverview({ countyFips: "08015" }), {
      county: { fips: "08015", name: "Chaffee" },
      organizationCounts: { total: 0, direct: 0, affiliated: 0 },
      documentedRoleCount: 0,
    });
    assert.equal(services.getCountyOverview({ countyFips: "08999" }), null);
    assert.throws(
      () => services.getCountyOverview({ countyFips: "0800x" }),
      CountyOverviewInputError,
    );
  });
});

test("county overview HTTP endpoint validates responses, methods, and identifiers", async () => {
  await fixture(async (database, services) => {
    seed(database);
    const application = createApplication(services);
    const request = (path, method = "GET") =>
      application.fetch(
        new Request(`https://watchdog.test${path}`, { method }),
      );

    const response = await request("/api/counties/08001");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      county: { fips: "08001", name: "Adams" },
      organizationCounts: { total: 5, direct: 3, affiliated: 3 },
      documentedRoleCount: 3,
    });

    const empty = await request("/api/counties/08015");
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).organizationCounts, {
      total: 0,
      direct: 0,
      affiliated: 0,
    });

    const unknown = await request("/api/counties/08999");
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });

    const invalid = await request("/api/counties/0800x");
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_request" });

    const query = await request("/api/counties/08001?limit=1");
    assert.equal(query.status, 400);
    assert.deepEqual(await query.json(), { error: "unexpected_query" });

    const wrongMethod = await request("/api/counties/08001", "POST");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  });
});

test("people and organization discovery searches literal names with stable bounded pages", async () => {
  await fixture(async (database, services) => {
    seedSearchRecords(database);

    const emptyPeople = services.searchPeople({ query: "No matching record" });
    assert.deepEqual(emptyPeople, {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    const emptyOrganizations = services.searchOrganizations({
      query: "No matching organization",
    });
    assert.deepEqual(emptyOrganizations, {
      items: [],
      hasMore: false,
      nextCursor: null,
    });

    const exactName = services.searchPeople({
      query: "Synthetic Alex Example",
    });
    assert.deepEqual(
      exactName.items.map(({ id, displayName }) => [id, displayName]),
      [
        ["person-alex-a", "Synthetic Alex Example"],
        ["person-alex-b", "Synthetic Alex Example"],
      ],
    );
    assert.deepEqual(
      services.searchPeople({ query: "aLeX" }).items.map(({ id }) => id),
      ["person-alex-a", "person-alex-b"],
    );

    for (const [query, expectedId] of [
      ["100%", "person-percent"],
      ["_group", "person-underscore"],
      ["A\\B", "person-backslash"],
      ["O'Br", "person-quote"],
    ]) {
      assert.deepEqual(
        services.searchPeople({ query }).items.map(({ id }) => id),
        [expectedId],
      );
    }
    assert.deepEqual(services.searchPeople({ query: "' OR 1=1 --" }).items, []);

    const firstDefaultPage = services.searchPeople({ query: "Directory" });
    assert.equal(firstDefaultPage.items.length, 25);
    assert.equal(firstDefaultPage.hasMore, true);
    const firstPage = services.searchPeople({
      query: "Directory",
      limit: 100,
    });
    assert.equal(firstPage.items.length, 100);
    assert.equal(firstPage.items[0].id, "directory-person-000");
    assert.equal(firstPage.items.at(-1).id, "directory-person-099");
    assert.equal(firstPage.hasMore, true);
    const secondPage = services.searchPeople({
      query: "Directory",
      limit: 100,
      cursor: firstPage.nextCursor,
    });
    assert.deepEqual(
      secondPage.items.map(({ id }) => id),
      [
        "directory-person-100",
        "directory-person-101",
        "directory-person-102",
        "directory-person-103",
        "directory-person-104",
      ],
    );
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextCursor, null);

    const organizations = services.searchOrganizations({ query: "Synthetic" });
    const organizationTypes = new Map(
      organizations.items.map(({ id, type }) => [id, type]),
    );
    assert.equal(organizationTypes.get("org-county"), "county_government");
    assert.equal(organizationTypes.get("org-office"), "office");
    assert.equal(organizationTypes.get("org-department"), "department");
    assert.equal(organizationTypes.get("org-division"), "division");
    assert.equal(organizationTypes.get("org-regional"), "regional");
    assert.equal(organizationTypes.get("org-partner"), "partner");
    assert.equal(organizationTypes.get("org-other"), "other");
    assert.deepEqual(
      organizations.items.find(({ id }) => id === "org-county"),
      {
        id: "org-county",
        name: "Synthetic County Government",
        type: "county_government",
        version: 1,
      },
    );

    const pagedOrganizationIds = [];
    let organizationPage = services.searchOrganizations({
      query: "Synthetic",
      limit: 3,
    });
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      pagedOrganizationIds.push(...organizationPage.items.map(({ id }) => id));
      if (!organizationPage.hasMore) break;
      organizationPage = services.searchOrganizations({
        query: "Synthetic",
        limit: 3,
        cursor: organizationPage.nextCursor,
      });
    }
    assert.equal(organizationPage.hasMore, false);
    assert.equal(pagedOrganizationIds.length, 10);
    assert.equal(new Set(pagedOrganizationIds).size, 10);

    assert.deepEqual(
      services.searchOrganizations({ query: "100%" }).items.map(({ id }) => id),
      ["org-regional"],
    );
    assert.deepEqual(
      services
        .searchOrganizations({ query: "_group" })
        .items.map(({ id }) => id),
      ["org-underscore"],
    );

    for (const request of [
      { query: "x" },
      { query: "  " },
      { query: "x".repeat(101) },
      { query: "Synthetic", limit: 0 },
      { query: "Synthetic", limit: 101 },
      { query: "Synthetic", limit: 1.5 },
      { query: "Synthetic", cursor: "malformed" },
      { query: "Synthetic", unsupported: true },
    ]) {
      assert.throws(
        () => services.searchPeople(request),
        DirectorySearchInputError,
      );
    }
    assert.throws(
      () =>
        services.searchPeople({
          query: "Different",
          cursor: firstPage.nextCursor,
        }),
      DirectorySearchInputError,
    );
    assert.throws(
      () =>
        services.searchOrganizations({
          query: "Directory",
          cursor: firstPage.nextCursor,
        }),
      DirectorySearchInputError,
    );
  });
});

test("directory discovery HTTP routes validate input and preserve profile routes without writes", async () => {
  await fixture(async (database, services) => {
    seedSearchRecords(database);
    const application = createApplication(services);
    const request = (path, method = "GET") =>
      application.fetch(
        new Request(`https://watchdog.test${path}`, { method }),
      );
    const before = {
      schemaVersion: database.prepare("PRAGMA schema_version").get()
        .schema_version,
      people: database.prepare("SELECT COUNT(*) AS count FROM people").get()
        .count,
      organizations: database
        .prepare("SELECT COUNT(*) AS count FROM organizations")
        .get().count,
      auditEvents: database
        .prepare("SELECT COUNT(*) AS count FROM audit_events")
        .get().count,
    };

    const people = await request("/api/people?query=Alex&limit=1");
    assert.equal(people.status, 200);
    const peoplePage = await people.json();
    assert.deepEqual(peoplePage.items, [
      {
        id: "person-alex-a",
        displayName: "Synthetic Alex Example",
        version: 1,
      },
    ]);
    assert.equal(peoplePage.hasMore, true);
    assert.equal(typeof peoplePage.nextCursor, "string");

    const organizations = await request(
      "/api/organizations?query=Synthetic&limit=2",
    );
    assert.equal(organizations.status, 200);
    const organizationPage = await organizations.json();
    assert.equal(organizationPage.items.length, 2);
    assert.equal(organizationPage.hasMore, true);
    assert.equal(typeof organizationPage.nextCursor, "string");
    assert.equal(
      Object.hasOwn(organizationPage.items[0], "countyAssociation"),
      false,
    );

    const incompatibleCursor = await request(
      `/api/organizations?query=Synthetic&cursor=${peoplePage.nextCursor}`,
    );
    assert.equal(incompatibleCursor.status, 400);
    assert.deepEqual(await incompatibleCursor.json(), {
      error: "invalid_request",
    });

    for (const path of [
      "/api/people",
      "/api/people?query=x",
      `/api/people?query=${"x".repeat(101)}`,
      "/api/people?query=Alex&limit=101",
      "/api/people?query=Alex&cursor=not-a-cursor",
      "/api/people?query=Alex&unknown=1",
      "/api/people?query=Alex&query=Alice",
      "/api/organizations?query=",
    ]) {
      const response = await request(path);
      assert.equal(response.status, 400, path);
    }
    const unsupported = await request("/api/people?query=Alex&unknown=1");
    assert.deepEqual(await unsupported.json(), {
      error: "unexpected_query",
    });

    for (const collection of ["people", "organizations"]) {
      const wrongMethod = await request(
        `/api/${collection}?query=Synthetic`,
        "POST",
      );
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("allow"), "GET");
    }

    const personProfile = await request("/api/people/person-alex-a");
    assert.equal(personProfile.status, 200);
    assert.equal((await personProfile.json()).person.id, "person-alex-a");

    const organizationProfile = await request("/api/organizations/org-county");
    assert.equal(organizationProfile.status, 200);
    assert.equal(
      (await organizationProfile.json()).organization.id,
      "org-county",
    );
    const organizationRoles = await request(
      "/api/organizations/org-county/roles",
    );
    assert.equal(organizationRoles.status, 200);

    assert.deepEqual(
      {
        schemaVersion: database.prepare("PRAGMA schema_version").get()
          .schema_version,
        people: database.prepare("SELECT COUNT(*) AS count FROM people").get()
          .count,
        organizations: database
          .prepare("SELECT COUNT(*) AS count FROM organizations")
          .get().count,
        auditEvents: database
          .prepare("SELECT COUNT(*) AS count FROM audit_events")
          .get().count,
      },
      before,
    );
  });
});

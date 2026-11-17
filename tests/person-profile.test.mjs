import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createServices } from "../dist/services/index.js";
import {
  getPersonProfile,
  PersonProfileInputError,
} from "../dist/services/person-profile.js";

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
       ('regional-office','Synthetic Regional Attorney Office','regional',NULL,NULL,NULL,2),
       ('partner-office','Synthetic Shared Partner Office','partner',NULL,NULL,NULL,1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO organization_county_affiliations
       (id,organization_id,county_fips,relationship_type,version)
       VALUES
       ('regional-adams','regional-office','08001','serves',2),
       ('regional-boulder','regional-office','08013','partner_for',4),
       ('partner-boulder','partner-office','08013','shared_service',3)`,
    )
    .run();
  database
    .prepare("INSERT INTO people(id,display_name,version) VALUES (?, ?, ?)")
    .run("person-one", "Synthetic Alex Example", 4);
  database
    .prepare(
      `INSERT INTO positions(id,organization_id,title,version)
       VALUES
       ('position-clerk','county-office','Synthetic Clerk',2),
       ('position-regional','regional-office','Synthetic Regional Attorney',3),
       ('position-partner','partner-office','Synthetic Shared Coordinator',1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO role_sources(id,url,title,source_type,publisher_classification,version)
       VALUES
       ('source-one','https://example.invalid/official','Synthetic Official Listing','official_page','official',2),
       ('source-two','https://example.invalid/document','Synthetic Public Document','public_document','unofficial',3),
       ('source-three','https://example.invalid/partner','Synthetic Partner Page','other_public','official',1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO person_roles
       (id,person_id,position_id,source_id,start_date,end_date,source_checked_at,version)
       VALUES
       ('role-a','person-one','position-clerk','source-one','2020-01-02',NULL,'2026-10-01T00:00:00Z',5),
       ('role-b','person-one','position-regional','source-two',NULL,'2024-05-06','2026-10-02T00:00:00Z',2),
       ('role-c','person-one','position-partner','source-three',NULL,NULL,'2026-10-03T00:00:00Z',1)`,
    )
    .run();
}

test("person profiles preserve stored roles, county relationships, citations, and versions", async () => {
  await fixture(async (database, services) => {
    seed(database);
    const profile = services.getPersonProfile({
      personId: "person-one",
      limit: 2,
    });

    assert.deepEqual(profile.person, {
      id: "person-one",
      displayName: "Synthetic Alex Example",
      version: 4,
    });
    assert.deepEqual(
      profile.items.map(({ role }) => role.id),
      ["role-a", "role-b"],
    );
    assert.equal(profile.hasMore, true);
    assert.equal(profile.nextCursor, "role-b");
    assert.deepEqual(profile.items[0], {
      role: {
        id: "role-a",
        version: 5,
        startDate: "2020-01-02",
        endDate: null,
        sourceCheckedAt: "2026-10-01T00:00:00Z",
        county: null,
        publishedOffice: null,
        publishedTitle: null,
        jobDescription: null,
      },
      position: {
        id: "position-clerk",
        title: "Synthetic Clerk",
        version: 2,
      },
      organization: {
        id: "county-office",
        name: "Synthetic County Office",
        type: "office",
        version: 3,
        counties: [
          {
            fips: "08001",
            name: "Adams",
            direct: true,
            affiliations: [],
          },
        ],
      },
      source: {
        id: "source-one",
        title: "Synthetic Official Listing",
        url: "https://example.invalid/official",
        type: "official_page",
        publisherClassification: "official",
        version: 2,
      },
    });
    assert.equal(profile.items[1].role.startDate, null);
    assert.equal(profile.items[1].role.endDate, "2024-05-06");
    assert.deepEqual(profile.items[1].organization.counties, [
      {
        fips: "08001",
        name: "Adams",
        direct: false,
        affiliations: [
          {
            id: "regional-adams",
            relationshipType: "serves",
            version: 2,
          },
        ],
      },
      {
        fips: "08013",
        name: "Boulder",
        direct: false,
        affiliations: [
          {
            id: "regional-boulder",
            relationshipType: "partner_for",
            version: 4,
          },
        ],
      },
    ]);
    assert.equal(profile.items[1].organization.type, "regional");
    assert.deepEqual(profile.items[1].source, {
      id: "source-two",
      title: "Synthetic Public Document",
      url: "https://example.invalid/document",
      type: "public_document",
      publisherClassification: "unofficial",
      version: 3,
    });

    const continuation = services.getPersonProfile({
      personId: "person-one",
      afterRoleId: profile.nextCursor,
    });
    assert.deepEqual(
      continuation.items.map(({ role }) => role.id),
      ["role-c"],
    );
    assert.equal(continuation.hasMore, false);
    assert.equal(continuation.nextCursor, null);
    assert.deepEqual(continuation.items[0].organization.counties, [
      {
        fips: "08013",
        name: "Boulder",
        direct: false,
        affiliations: [
          {
            id: "partner-boulder",
            relationshipType: "shared_service",
            version: 3,
          },
        ],
      },
    ]);
    assert.equal(continuation.items[0].organization.type, "partner");

    const serialized = JSON.stringify(profile);
    assert.equal(serialized.includes("credential"), false);
    assert.equal(serialized.includes("account"), false);
    assert.equal(serialized.includes("research"), false);
  });
});

test("empty profiles, unknown people, invalid input, and read-only service behavior", async () => {
  await fixture(async (database) => {
    database
      .prepare("INSERT INTO people(id,display_name) VALUES (?, ?)")
      .run("person-empty", "Synthetic Person Without Roles");
    const before = {
      schemaVersion: database.prepare("PRAGMA schema_version").get()
        .schema_version,
      people: database.prepare("SELECT COUNT(*) AS count FROM people").get()
        .count,
      roles: database
        .prepare("SELECT COUNT(*) AS count FROM person_roles")
        .get().count,
      audits: database
        .prepare("SELECT COUNT(*) AS count FROM audit_events")
        .get().count,
    };

    assert.deepEqual(getPersonProfile(database, { personId: "person-empty" }), {
      person: {
        id: "person-empty",
        displayName: "Synthetic Person Without Roles",
        version: 1,
      },
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    assert.equal(
      getPersonProfile(database, { personId: "missing-person" }),
      null,
    );

    for (const request of [
      { personId: "" },
      { personId: "../person" },
      { personId: "x".repeat(129) },
      { personId: "person-empty", limit: 0 },
      { personId: "person-empty", limit: 101 },
      { personId: "person-empty", limit: 1.5 },
      { personId: "person-empty", afterRoleId: "bad cursor" },
      { personId: "person-empty", afterRoleId: "" },
    ]) {
      assert.throws(
        () => getPersonProfile(database, request),
        PersonProfileInputError,
      );
    }

    assert.deepEqual(
      {
        schemaVersion: database.prepare("PRAGMA schema_version").get()
          .schema_version,
        people: database.prepare("SELECT COUNT(*) AS count FROM people").get()
          .count,
        roles: database
          .prepare("SELECT COUNT(*) AS count FROM person_roles")
          .get().count,
        audits: database
          .prepare("SELECT COUNT(*) AS count FROM audit_events")
          .get().count,
      },
      before,
    );
  });
});

test("profile pagination caps result sets at 100 role records", async () => {
  await fixture(async (database) => {
    database
      .prepare(
        "INSERT INTO organizations(id,name,organization_type) VALUES (?, ?, ?)",
      )
      .run("large-org", "Synthetic Large Organization", "office");
    database
      .prepare("INSERT INTO people(id,display_name) VALUES (?, ?)")
      .run("person-many", "Synthetic Person With Many Roles");
    database
      .prepare(
        "INSERT INTO positions(id,organization_id,title) VALUES (?, ?, ?)",
      )
      .run("large-position", "large-org", "Synthetic Position");
    database
      .prepare(
        "INSERT INTO role_sources(id,url,title,source_type) VALUES (?, ?, ?, ?)",
      )
      .run(
        "large-source",
        "https://example.invalid/many",
        "Synthetic Public Source",
        "official_page",
      );
    const insertRole = database.prepare(
      `INSERT INTO person_roles
       (id,person_id,position_id,source_id,source_checked_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 105; index += 1) {
      insertRole.run(
        `role-${String(index).padStart(3, "0")}`,
        "person-many",
        "large-position",
        "large-source",
        "2026-10-01T00:00:00Z",
      );
    }

    const defaultPage = getPersonProfile(database, {
      personId: "person-many",
    });
    assert.equal(defaultPage.items.length, 25);
    assert.equal(defaultPage.hasMore, true);
    assert.equal(defaultPage.nextCursor, "role-024");
    const first = getPersonProfile(database, {
      personId: "person-many",
      limit: 100,
    });
    assert.equal(first.items.length, 100);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "role-099");
    const last = getPersonProfile(database, {
      personId: "person-many",
      afterRoleId: first.nextCursor,
      limit: 100,
    });
    assert.deepEqual(
      last.items.map(({ role }) => role.id),
      ["role-100", "role-101", "role-102", "role-103", "role-104"],
    );
    assert.equal(last.hasMore, false);
  });
});

test("profile HTTP endpoint validates requests and returns public pages", async () => {
  await fixture(async (database, services) => {
    seed(database);
    database
      .prepare("INSERT INTO people(id,display_name) VALUES (?, ?)")
      .run("person-empty", "Synthetic Person Without Roles");
    const application = createApplication(services);
    const request = (url, method = "GET") =>
      application.fetch(new Request(url, { method }));

    const before = {
      schemaVersion: database.prepare("PRAGMA schema_version").get()
        .schema_version,
      roleCount: database
        .prepare("SELECT COUNT(*) AS count FROM person_roles")
        .get().count,
      affiliationCount: database
        .prepare(
          "SELECT COUNT(*) AS count FROM organization_county_affiliations",
        )
        .get().count,
      auditCount: database
        .prepare("SELECT COUNT(*) AS count FROM audit_events")
        .get().count,
    };
    const first = await request(
      "https://watchdog.test/api/people/person-one?limit=1",
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), {
      person: {
        id: "person-one",
        displayName: "Synthetic Alex Example",
        version: 4,
      },
      items: [
        {
          role: {
            id: "role-a",
            version: 5,
            startDate: "2020-01-02",
            endDate: null,
            sourceCheckedAt: "2026-10-01T00:00:00Z",
            county: null,
            publishedOffice: null,
            publishedTitle: null,
            jobDescription: null,
          },
          position: {
            id: "position-clerk",
            title: "Synthetic Clerk",
            version: 2,
          },
          organization: {
            id: "county-office",
            name: "Synthetic County Office",
            type: "office",
            version: 3,
            counties: [
              {
                fips: "08001",
                name: "Adams",
                direct: true,
                affiliations: [],
              },
            ],
          },
        },
      ],
      hasMore: true,
      nextCursor: "role-a",
    });

    const empty = await request(
      "https://watchdog.test/api/people/person-empty",
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), {
      person: {
        id: "person-empty",
        displayName: "Synthetic Person Without Roles",
        version: 1,
      },
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    const unknown = await request(
      "https://watchdog.test/api/people/missing-person",
    );
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_found" });

    for (const url of [
      "https://watchdog.test/api/people/",
      "https://watchdog.test/api/people/bad%20id",
      "https://watchdog.test/api/people/person-one?limit=0",
      "https://watchdog.test/api/people/person-one?limit=101",
      "https://watchdog.test/api/people/person-one?afterRoleId=",
      "https://watchdog.test/api/people/person-one?afterRoleId=bad%20cursor",
      "https://watchdog.test/api/people/person-one?limit=1&limit=2",
    ]) {
      const response = await request(url);
      assert.equal(response.status, 400, url);
    }
    const unsupportedQuery = await request(
      "https://watchdog.test/api/people/person-one?afterId=role-a",
    );
    assert.equal(unsupportedQuery.status, 400);
    assert.deepEqual(await unsupportedQuery.json(), {
      error: "unexpected_query",
    });
    const wrongMethod = await request(
      "https://watchdog.test/api/people/person-one",
      "POST",
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    assert.deepEqual(
      {
        schemaVersion: database.prepare("PRAGMA schema_version").get()
          .schema_version,
        roleCount: database
          .prepare("SELECT COUNT(*) AS count FROM person_roles")
          .get().count,
        affiliationCount: database
          .prepare(
            "SELECT COUNT(*) AS count FROM organization_county_affiliations",
          )
          .get().count,
        auditCount: database
          .prepare("SELECT COUNT(*) AS count FROM audit_events")
          .get().count,
      },
      before,
    );
  });
});

test("unexpected profile service failures return sanitized HTTP errors", async () => {
  const application = createApplication({
    ...createServices(),
    getPersonProfile() {
      throw new Error("private failure detail");
    },
  });
  const response = await application.fetch(
    new Request("https://watchdog.test/api/people/person-one"),
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
});

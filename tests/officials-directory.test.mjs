import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createD1PublicReadServices } from "../dist/services/d1-public-reads.js";
import { createServices } from "../dist/services/index.js";
import {
  d1DirectoryRunner,
  getCountyStructure,
  listOfficials,
  MAX_STRUCTURE_ORGANIZATIONS,
  OfficialsDirectoryInputError,
  sqliteDirectoryRunner,
} from "../dist/services/officials-directory.js";
import { seedFictionalDirectory } from "../dist/site-dev/preview-data.js";

/**
 * A D1 binding over the local database. It enforces D1's limit of 100 bound
 * parameters per statement, so the hosted path cannot silently exceed it.
 */
function d1Over(database) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    async first() {
      assert.ok(values.length <= 100, "D1 allows 100 bound parameters");
      return database.prepare(sql).get(...values) ?? null;
    },
    async all() {
      assert.ok(values.length <= 100, "D1 allows 100 bound parameters");
      return { success: true, results: database.prepare(sql).all(...values) };
    },
  });
  return new AsyncD1Database({ prepare: (sql) => statement(sql) });
}

const RUNTIMES = [
  ["SQL.js", (database) => sqliteDirectoryRunner(database)],
  ["D1", (database) => d1DirectoryRunner(d1Over(database))],
];

/** Runs the callback once per runtime adapter against the same data. */
async function withDatabase(seed, callback) {
  for (const [label, makeRunner] of RUNTIMES) {
    const database = await openWebsiteDatabase();
    try {
      migrateWebsiteDatabase(database);
      if (seed) seedFictionalDirectory(database);
      await callback(makeRunner(database), database, label);
    } finally {
      database.close();
    }
  }
}
const names = (page) => page.items.map((item) => item.person.displayName);
const ids = (page) => page.items.map((item) => item.person.id);

test("browsing needs no search term and counts only stored people", async () => {
  await withDatabase(true, async (runner, database) => {
    // Only Profiles meeting the publication rule are public (migration 0034).
    const people = database
      .prepare(
        "SELECT COUNT(*) AS n FROM profile_publication_ready r WHERE NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = r.person_id AND v.visible = 0)",
      )
      .get().n;
    const first = await listOfficials(runner);
    assert.equal(first.total, people);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 25);
    assert.equal(first.items.length, 25);
    assert.equal(first.pageCount, Math.ceil(people / 25));
    // Default order is by name, then stable person ID.
    const sorted = [...names(first)].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase()
        ? -1
        : a.toLowerCase() > b.toLowerCase()
          ? 1
          : 0,
    );
    assert.deepEqual(names(first), sorted);

    // Walking every page returns each person exactly once.
    const seen = [];
    for (let page = 1; page <= first.pageCount; page += 1) {
      seen.push(...ids(await listOfficials(runner, { page })));
    }
    assert.equal(seen.length, people);
    assert.equal(new Set(seen).size, people);

    // A Profile with no role does not meet the publication rule, so it is
    // not public and is not listed.
    const unlisted = await listOfficials(runner, { query: "Harper Unlisted" });
    assert.equal(unlisted.total, 0);
  });
  await withDatabase(false, async (runner) => {
    const empty = await listOfficials(runner);
    assert.deepEqual(
      { items: empty.items, total: empty.total, pageCount: empty.pageCount },
      { items: [], total: 0, pageCount: 1 },
    );
    assert.equal(
      (await listOfficials(runner, { countyFips: "08069" })).total,
      0,
    );
  });
});

test("officials public reads preserve an unofficial role publisher classification", async () => {
  await withDatabase(true, async (runner, database) => {
    const role = database
      .prepare(
        `SELECT person.display_name, source.id AS source_id
         FROM person_roles AS role
         JOIN people AS person ON person.id = role.person_id
         JOIN role_sources AS source ON source.id = role.source_id
         ORDER BY role.id LIMIT 1`,
      )
      .get();
    database
      .prepare(
        "UPDATE role_sources SET publisher_classification='unofficial', version=version+1 WHERE id=?",
      )
      .run(role.source_id);

    const result = await listOfficials(runner, { query: role.display_name });
    assert.equal(
      result.items.find((item) => item.person.displayName === role.display_name)
        ?.role?.source.publisherClassification,
      "unofficial",
    );
  });
});

test("county, office and type filters run in the query, not on one page", async () => {
  await withDatabase(true, async (runner) => {
    const larimer = await listOfficials(runner, {
      countyFips: "08069",
      limit: 100,
    });
    assert.equal(larimer.total, 11);
    // The affiliated health district's person appears for both counties it serves.
    assert.ok(ids(larimer).includes("demo-person-morgan"));
    const adams = await listOfficials(runner, {
      countyFips: "08001",
      limit: 100,
    });
    assert.ok(ids(adams).includes("demo-person-morgan"));
    assert.equal(adams.total, 36);
    assert.ok(!ids(adams).includes("demo-l-01"));
    const morgan = adams.items.find(
      (i) => i.person.id === "demo-person-morgan",
    );
    assert.deepEqual(
      morgan.role.organization.counties.map((c) => [
        c.fips,
        c.direct,
        c.affiliations,
      ]),
      [
        ["08001", false, ["serves"]],
        ["08069", false, ["serves"]],
      ],
    );
    // A person without roles never appears under a county or office filter.
    assert.ok(!ids(adams).includes("demo-person-no-roles"));

    // An office includes its documented subunits.
    const department = await listOfficials(runner, {
      organizationId: "demo-larimer-dev",
    });
    assert.equal(department.total, 8);
    const division = await listOfficials(runner, {
      organizationId: "demo-larimer-building",
    });
    assert.deepEqual(ids(division).sort(), [
      "demo-l-05",
      "demo-l-06",
      "demo-l-07",
      "demo-l-08",
    ]);
    const government = await listOfficials(runner, {
      organizationId: "demo-larimer-gov",
    });
    assert.equal(government.total, 10);

    const byType = await listOfficials(runner, {
      countyFips: "08069",
      organizationType: "division",
    });
    assert.equal(byType.total, 4);
    assert.ok(
      byType.items.every((i) => i.role.organization.type === "division"),
    );
    // Type filtering is exact: the department's own people only.
    assert.equal(
      (
        await listOfficials(runner, {
          countyFips: "08069",
          organizationType: "department",
        })
      ).total,
      4,
    );
    // Filters that cannot overlap return an honest empty page.
    assert.equal(
      (
        await listOfficials(runner, {
          countyFips: "08001",
          organizationId: "demo-larimer-dev",
        })
      ).total,
      0,
    );
    // Filtering applies beyond the first page: page 2 of Adams is still Adams.
    const second = await listOfficials(runner, {
      countyFips: "08001",
      page: 2,
    });
    assert.equal(second.items.length, 11);
    assert.ok(
      second.items.every((i) =>
        i.role.organization.counties.some((c) => c.fips === "08001"),
      ),
    );
  });
});

test("search matches person names, position titles and organization names", async () => {
  await withDatabase(true, async (runner) => {
    assert.deepEqual(ids(await listOfficials(runner, { query: "addison" })), [
      "demo-l-01",
    ]);
    const inspectors = await listOfficials(runner, {
      query: "Building Inspector",
    });
    assert.deepEqual(ids(inspectors).sort(), ["demo-l-05", "demo-l-06"]);
    assert.ok(
      inspectors.items.every((i) => /Inspector/.test(i.role.position.title)),
    );
    const byOrganization = await listOfficials(runner, {
      query: "health district",
    });
    assert.deepEqual(ids(byOrganization), ["demo-person-morgan"]);
    assert.equal(
      (await listOfficials(runner, { query: "no such thing" })).total,
      0,
    );
    // LIKE wildcards in the query are literal.
    assert.equal((await listOfficials(runner, { query: "%%" })).total, 0);
    assert.equal((await listOfficials(runner, { query: "__" })).total, 0);
    // Search combines with a county filter.
    assert.equal(
      (
        await listOfficials(runner, {
          query: "Clerk and Recorder",
          countyFips: "08069",
        })
      ).total,
      1,
    );
    assert.equal(
      (await listOfficials(runner, { query: "Clerk and Recorder" })).total,
      2,
    );
  });
});

test("one row per person with multiple roles, and same names stay separate", async () => {
  await withDatabase(true, async (runner) => {
    // Riley has roles in two counties: three role records, one row.
    const riley = await listOfficials(runner, { query: "Riley Placeholder" });
    assert.equal(riley.total, 1);
    assert.equal(riley.items[0].matchingRoleCount, 3);
    // The shown role is the most recently source-checked one.
    assert.equal(riley.items[0].role.sourceCheckedAt, "2026-10-20");
    assert.equal(riley.items[0].role.position.id, "demo-pos-l-director");
    // Within Adams only the two Adams roles are considered.
    const rileyAdams = await listOfficials(runner, {
      query: "Riley Placeholder",
      countyFips: "08001",
    });
    assert.equal(rileyAdams.items[0].matchingRoleCount, 2);
    assert.ok(
      rileyAdams.items[0].role.organization.counties.some(
        (c) => c.fips === "08001",
      ),
    );

    const ellis = await listOfficials(runner, {
      organizationId: "demo-larimer-building",
      query: "Ellis",
    });
    assert.equal(ellis.items[0].matchingRoleCount, 2);
    assert.equal(ellis.items[0].role.endDate, null);

    const jordans = await listOfficials(runner, { query: "Jordan Example" });
    assert.equal(jordans.total, 2);
    assert.deepEqual(ids(jordans), [
      "demo-person-jordan-a",
      "demo-person-jordan-b",
    ]);
    assert.equal(names(jordans)[0], names(jordans)[1]);
    assert.notEqual(
      jordans.items[0].role.organization.id,
      jordans.items[1].role.organization.id,
    );
  });
});

test("sorting is applied in the query with stable tie-breaking", async () => {
  await withDatabase(true, async (runner) => {
    const county = { countyFips: "08069", limit: 100 };
    const asc = await listOfficials(runner, { ...county, sort: "name" });
    const desc = await listOfficials(runner, {
      ...county,
      sort: "name",
      direction: "desc",
    });
    assert.deepEqual(names(desc), [...names(asc)].reverse());

    const checked = await listOfficials(runner, {
      ...county,
      sort: "checked",
      direction: "desc",
    });
    const dates = checked.items.map((i) => i.role.sourceCheckedAt);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(dates[0], "2026-10-21");

    const byTitle = await listOfficials(runner, { ...county, sort: "title" });
    const titles = byTitle.items.map((i) =>
      i.role.position.title.toLowerCase(),
    );
    assert.deepEqual(titles, [...titles].sort());
    const byOrganization = await listOfficials(runner, {
      ...county,
      sort: "organization",
    });
    const organizations = byOrganization.items.map((i) =>
      i.role.organization.name.toLowerCase(),
    );
    assert.deepEqual(organizations, [...organizations].sort());

    // Entries with no county of their own (no role, or an affiliate-only
    // organization) sort last, whichever direction is used.
    for (const direction of ["asc", "desc"]) {
      const all = [];
      const total = (
        await listOfficials(runner, {
          sort: "county",
          direction,
        })
      ).pageCount;
      for (let page = 1; page <= total; page += 1) {
        all.push(
          ...(await listOfficials(runner, { sort: "county", direction, page }))
            .items,
        );
      }
      const hasCounty = all.map((i) =>
        Boolean(i.role?.organization.counties.some((c) => c.direct)),
      );
      assert.ok(hasCounty.includes(false) && hasCounty.includes(true));
      assert.equal(
        hasCounty.lastIndexOf(true) < hasCounty.indexOf(false),
        true,
        direction,
      );
      assert.equal(new Set(all.map((i) => i.person.id)).size, all.length);
    }
    // Sorting spans pages: the first page of a descending sort is not just
    // the first page reversed.
    const firstAsc = await listOfficials(runner, { sort: "name" });
    const firstDesc = await listOfficials(runner, {
      sort: "name",
      direction: "desc",
    });
    assert.notDeepEqual(new Set(ids(firstAsc)), new Set(ids(firstDesc)));
  });
});

test("requests are validated and pagination is bounded", async () => {
  await withDatabase(true, async (runner, database) => {
    for (const request of [
      { countyFips: "99999" },
      { countyFips: "08002" },
      { countyFips: "08069' OR 1=1 --" },
      { organizationId: "missing" },
      { organizationId: "" },
      { organizationType: "elected" },
      { query: "a" },
      { query: "x".repeat(101) },
      { query: 5 },
      { sort: "salary" },
      { sort: "name; DROP TABLE people" },
      { direction: "sideways" },
      { page: 0 },
      { page: 1.5 },
      { page: 10_001 },
      { limit: 0 },
      { limit: 101 },
      { unexpected: true },
    ]) {
      await assert.rejects(
        async () => listOfficials(runner, request),
        OfficialsDirectoryInputError,
        JSON.stringify(request),
      );
    }
    // A page past the end is empty but still reports the real total.
    const stale = await listOfficials(runner, {
      countyFips: "08069",
      page: 50,
    });
    assert.equal(stale.items.length, 0);
    assert.equal(stale.total, 11);
    assert.equal(stale.pageCount, 1);
    assert.equal(
      (await listOfficials(runner, { limit: 100 })).items.length <= 100,
      true,
    );
    assert.equal(
      (await listOfficials(runner, { query: "  " })).total > 0,
      true,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM people").get().n > 0,
      true,
    );
  });
});

test("county structure reports documented parents, affiliates and counts", async () => {
  await withDatabase(true, async (runner, database) => {
    const structure = await getCountyStructure(runner, { countyFips: "08069" });
    assert.deepEqual(structure.county, { fips: "08069", name: "Larimer" });
    assert.equal(structure.truncated, false);
    const byId = Object.fromEntries(
      structure.organizations.map((o) => [o.id, o]),
    );
    assert.deepEqual(Object.keys(byId).sort(), [
      "demo-larimer-assessor",
      "demo-larimer-building",
      "demo-larimer-clerk",
      "demo-larimer-dev",
      "demo-larimer-gov",
      "demo-regional-health",
      "demo-shared-dispatch",
    ]);
    assert.equal(
      byId["demo-larimer-building"].parentOrganizationId,
      "demo-larimer-dev",
    );
    assert.equal(
      byId["demo-larimer-building"].parentRelationship,
      "reports_to",
    );
    assert.equal(
      byId["demo-larimer-clerk"].parentRelationship,
      "grouped_under",
    );
    assert.equal(byId["demo-larimer-gov"].parentOrganizationId, null);
    // Counts include documented subunits and count distinct people.
    assert.equal(byId["demo-larimer-building"].peopleCount, 4);
    assert.equal(byId["demo-larimer-dev"].peopleCount, 8);
    assert.equal(byId["demo-larimer-gov"].peopleCount, 10);
    assert.equal(byId["demo-larimer-dev"].positionCount, 2);
    assert.equal(byId["demo-shared-dispatch"].peopleCount, 0);
    // Affiliates are marked as such and carry no invented parent.
    assert.deepEqual(byId["demo-regional-health"].countyAssociation, {
      direct: false,
      affiliations: ["serves"],
    });
    assert.deepEqual(byId["demo-shared-dispatch"].countyAssociation, {
      direct: false,
      affiliations: ["shared_service"],
    });
    assert.equal(byId["demo-regional-health"].parentOrganizationId, null);
    assert.deepEqual(byId["demo-larimer-dev"].countyAssociation, {
      direct: true,
      affiliations: [],
    });

    const empty = await getCountyStructure(runner, { countyFips: "08005" });
    assert.deepEqual(empty.organizations, []);
    for (const request of [
      { countyFips: "08002" },
      { countyFips: "x" },
      {},
      { countyFips: "08069", extra: 1 },
    ]) {
      await assert.rejects(
        async () => getCountyStructure(runner, request),
        OfficialsDirectoryInputError,
      );
    }

    // The read is bounded even for a very large county.
    const insert = database.prepare(
      "INSERT INTO organizations (id, name, organization_type, county_fips) VALUES (?, ?, 'other', '08005')",
    );
    for (let index = 0; index < MAX_STRUCTURE_ORGANIZATIONS + 5; index += 1) {
      insert.run(
        `bulk-${index}`,
        `Bulk Organization ${String(index).padStart(4, "0")}`,
      );
    }
    const large = await getCountyStructure(runner, { countyFips: "08005" });
    assert.equal(large.organizations.length, MAX_STRUCTURE_ORGANIZATIONS);
    assert.equal(large.truncated, true);
  });
});

test("both service adapters expose the directory with identical results", async () => {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    seedFictionalDirectory(database);
    const local = createServices({ database });
    const hosted = createD1PublicReadServices(d1Over(database));
    for (const request of [
      {},
      { page: 2 },
      { countyFips: "08069" },
      { countyFips: "08001", sort: "checked", direction: "desc", limit: 100 },
      { organizationId: "demo-larimer-dev", sort: "title" },
      { query: "clerk", sort: "organization" },
      { organizationType: "regional" },
    ]) {
      assert.deepEqual(
        await hosted.listOfficials(request),
        await local.listOfficials(request),
        JSON.stringify(request),
      );
    }
    for (const countyFips of ["08001", "08069", "08005"]) {
      assert.deepEqual(
        await hosted.getCountyStructure({ countyFips }),
        await local.getCountyStructure({ countyFips }),
        countyFips,
      );
    }
    assert.equal(
      (await local.listOfficials({ countyFips: "08069" })).total,
      11,
    );
    await assert.rejects(
      async () => hosted.listOfficials({ countyFips: "99999" }),
      OfficialsDirectoryInputError,
    );
  } finally {
    database.close();
  }
  const unavailable = createServices();
  assert.throws(() => unavailable.listOfficials(), {
    name: "StorageUnavailableError",
  });
});

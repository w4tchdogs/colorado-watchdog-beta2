import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { StorageUnavailableError } from "../dist/contracts/storage.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createLocalStorageProbe } from "../dist/local/storage-probe.js";
import { createServices } from "../dist/services/index.js";
import worker from "../dist/worker.js";

const healthRequest = (url = "https://watchdog.test/_internal/health") =>
  new Request(url);

test("Worker liveness is independent and readiness requires its dependency", async () => {
  const live = await worker.fetch(
    healthRequest("https://watchdog.test/_internal/live"),
    {
      APP_ENV: "test",
    },
  );
  const ready = await worker.fetch(
    healthRequest("https://watchdog.test/_internal/ready"),
    {
      APP_ENV: "test",
    },
  );

  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "ok" });
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { error: "dependency_unavailable" });
});

test("request dispatch reaches services with an injectable local adapter", async () => {
  let checks = 0;
  const storage = {
    async check() {
      checks += 1;
    },
  };
  const application = createApplication(createServices({ storage }));

  const response = await application.fetch(healthRequest());

  assert.equal(response.status, 200);
  assert.equal(checks, 1);
});

test("the deterministic local adapter satisfies the storage boundary", async () => {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  const application = createApplication(
    createServices({
      storage: createLocalStorageProbe(database),
    }),
  );

  try {
    const response = await application.fetch(healthRequest());
    assert.equal(response.status, 200);
  } finally {
    database.close();
  }
});

test("unsupported routes and methods fail predictably", async () => {
  const application = createApplication(createServices());

  const missing = await application.fetch(
    healthRequest("https://watchdog.test/public"),
  );
  const wrongMethod = await application.fetch(
    new Request("https://watchdog.test/_internal/health", { method: "POST" }),
  );
  const syncPath = await application.fetch(
    healthRequest("https://watchdog.test/internal/sync/batches/lookup"),
  );

  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  assert.equal(syncPath.status, 404);
  assert.deepEqual(await syncPath.json(), { error: "not_found" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
});

test("malformed paths and unexpected query strings are rejected", async () => {
  const application = createApplication(createServices());
  const malformedPath = await application.fetch(
    healthRequest("https://watchdog.test/_internal/%E0%A4%A"),
  );
  const query = await application.fetch(
    healthRequest("https://watchdog.test/_internal/health?extra=1"),
  );

  assert.equal(malformedPath.status, 400);
  assert.deepEqual(await malformedPath.json(), { error: "malformed_path" });
  assert.equal(query.status, 400);
  assert.deepEqual(await query.json(), { error: "unexpected_query" });
});

test("an unavailable adapter cannot be reported as healthy", async () => {
  const storage = {
    async check() {
      throw new StorageUnavailableError();
    },
  };
  const application = createApplication(createServices({ storage }));

  const response = await application.fetch(healthRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "dependency_unavailable",
  });
});

test("unexpected adapter errors are not converted into success responses", async () => {
  const storage = {
    async check() {
      throw new Error("unexpected adapter failure");
    },
  };
  const application = createApplication(createServices({ storage }));

  const response = await application.fetch(healthRequest());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
});

test("county directory endpoints expose service projections and forward pagination", async () => {
  const organizationPage = {
    items: [
      {
        id: "synthetic-office",
        name: "Synthetic County Office",
        type: "office",
        version: 2,
        parentOrganizationId: null,
        parentRelationship: null,
        countyAssociation: { direct: true, affiliations: [] },
      },
    ],
    nextCursor: "synthetic-office",
    hasMore: true,
  };
  const rolePage = {
    items: [
      {
        person: {
          id: "synthetic-person",
          displayName: "Synthetic Person",
          version: 1,
        },
        role: {
          id: "synthetic-role",
          version: 1,
          startDate: null,
          endDate: null,
          sourceCheckedAt: "2026-10-01T00:00:00Z",
        },
        position: {
          id: "synthetic-position",
          title: "Synthetic Role",
          version: 1,
        },
        organization: {
          id: "synthetic-office",
          name: "Synthetic County Office",
          type: "office",
          version: 2,
          countyAssociation: { direct: true, affiliations: [] },
        },
        source: {
          id: "synthetic-source",
          title: "Synthetic Public Source",
          url: "https://example.invalid/synthetic",
          type: "official_page",
          version: 1,
        },
      },
    ],
    nextCursor: null,
    hasMore: false,
  };
  const calls = [];
  const services = {
    ...createServices(),
    listCountyOrganizations(input) {
      calls.push(["organizations", input]);
      return organizationPage;
    },
    listCountyRoleEntries(input) {
      calls.push(["roles", input]);
      return rolePage;
    },
  };
  const application = createApplication(services);

  const organizations = await application.fetch(
    healthRequest(
      "https://watchdog.test/api/counties/08001/organizations?limit=100&afterId=office-1",
    ),
  );
  const roles = await application.fetch(
    healthRequest("https://watchdog.test/api/counties/08001/roles"),
  );

  assert.equal(organizations.status, 200);
  assert.equal(organizations.headers.get("cache-control"), "no-store");
  assert.match(
    organizations.headers.get("content-type"),
    /^application\/json; charset=utf-8$/,
  );
  assert.deepEqual(await organizations.json(), organizationPage);
  assert.equal(roles.status, 200);
  assert.deepEqual(await roles.json(), {
    ...rolePage,
    items: rolePage.items.map(({ source: _source, ...entry }) => entry),
  });
  assert.deepEqual(calls, [
    ["organizations", { countyFips: "08001", limit: 100, afterId: "office-1" }],
    ["roles", { countyFips: "08001" }],
  ]);
});

test("county directory endpoints preserve empty pages and report missing database dependencies", async () => {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  const application = createApplication(createServices({ database }));

  try {
    for (const resource of ["organizations", "roles"]) {
      const response = await application.fetch(
        healthRequest(`https://watchdog.test/api/counties/08999/${resource}`),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        items: [],
        hasMore: false,
        nextCursor: null,
      });
    }
  } finally {
    database.close();
  }

  const unavailable = await createApplication(createServices()).fetch(
    healthRequest("https://watchdog.test/api/counties/08001/organizations"),
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: "dependency_unavailable",
  });
});

test("county directory endpoints validate paths, pagination, query parameters, and methods", async () => {
  const application = createApplication({
    ...createServices(),
    listCountyOrganizations() {
      throw new Error("invalid request reached the directory service");
    },
    listCountyRoleEntries() {
      throw new Error("invalid request reached the directory service");
    },
  });
  const invalidUrls = [
    "https://watchdog.test/api/counties/0800x/organizations",
    "https://watchdog.test/api/counties/08001/organizations?limit=0",
    "https://watchdog.test/api/counties/08001/organizations?limit=101",
    "https://watchdog.test/api/counties/08001/organizations?limit=1.5",
    "https://watchdog.test/api/counties/08001/roles?afterId=bad%20cursor",
    "https://watchdog.test/api/counties/08001/roles?afterId=",
    "https://watchdog.test/api/counties/08001/roles?unexpected=1",
    "https://watchdog.test/api/counties/08001/roles?limit=1&limit=2",
  ];

  for (const url of invalidUrls) {
    const response = await application.fetch(healthRequest(url));
    assert.equal(response.status, 400, url);
    assert.deepEqual(
      await response.json(),
      {
        error: url.includes("unexpected=")
          ? "unexpected_query"
          : "invalid_request",
      },
      url,
    );
  }

  const wrongMethod = await application.fetch(
    new Request("https://watchdog.test/api/counties/08001/roles", {
      method: "POST",
    }),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
});

test("county directory HTTP reads do not change database or audit state", async () => {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  const application = createApplication(createServices({ database }));
  const before = {
    schemaVersion: database.prepare("PRAGMA schema_version").get()
      .schema_version,
    organizations: database
      .prepare("SELECT COUNT(*) AS count FROM organizations")
      .get().count,
    roles: database.prepare("SELECT COUNT(*) AS count FROM person_roles").get()
      .count,
    auditEvents: database
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get().count,
  };

  try {
    for (const resource of ["organizations", "roles"]) {
      const response = await application.fetch(
        healthRequest(`https://watchdog.test/api/counties/08001/${resource}`),
      );
      assert.equal(response.status, 200);
    }

    assert.deepEqual(
      {
        schemaVersion: database.prepare("PRAGMA schema_version").get()
          .schema_version,
        organizations: database
          .prepare("SELECT COUNT(*) AS count FROM organizations")
          .get().count,
        roles: database
          .prepare("SELECT COUNT(*) AS count FROM person_roles")
          .get().count,
        auditEvents: database
          .prepare("SELECT COUNT(*) AS count FROM audit_events")
          .get().count,
      },
      before,
    );
  } finally {
    database.close();
  }
});

test("existing application routes remain available", async () => {
  const application = createApplication(createServices());
  const responses = await Promise.all([
    application.fetch(healthRequest("https://watchdog.test/_internal/live")),
    application.fetch(healthRequest("https://watchdog.test/_internal/health")),
    application.fetch(
      healthRequest("https://watchdog.test/_internal/principal"),
    ),
    application.fetch(
      new Request("https://watchdog.test/api/accounts", { method: "POST" }),
    ),
  ]);

  assert.deepEqual(
    responses.map(({ status }) => status),
    [200, 503, 503, 503],
  );
});

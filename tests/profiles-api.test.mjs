import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { readCsvTable } from "../dist/services/county-structure-csv.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { createProfilesApiTransport } from "../dist/transport/profiles-api.js";

const ORIGIN = "https://watchdog.invalid";

function d1Over(database, afterRows) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    async first() {
      return database.prepare(sql).get(...values) ?? null;
    },
    async all() {
      const results = database.prepare(sql).all(...values);
      afterRows?.(database, sql);
      return { success: true, results };
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
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-owner', 'human', 'owner', 'Synthetic Owner'), ('acct-editor', 'human', 'editor', 'Synthetic Editor');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-owner', 'acct-owner', 'test-human', 'owner'), ('ident-editor', 'acct-editor', 'test-human', 'editor');
  INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('org-adams', 'Synthetic Adams Office', 'office', '08001');
  INSERT INTO positions (id, organization_id, title) VALUES ('pos-adams', 'org-adams', 'Synthetic Clerk');
  INSERT INTO role_sources (id, url, title, source_type) VALUES ('src-a', 'https://example.invalid/private-citation', 'Synthetic citation title', 'official_page');
  INSERT INTO people (id, display_name) VALUES ('person-a', 'Synthetic Person A');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at) VALUES ('role-a', 'person-a', 'pos-adams', 'src-a', '2026-10-01T00:00:00Z');
`;

async function withApi(callback, afterRows) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(SEED);
  const adapter = createTestHumanIdentityAdapter({
    owner: "owner",
    editor: "editor",
  });
  const resolve = async (request) => {
    const subject = request.headers.get("x-test-human-subject");
    if (subject === "agent")
      return {
        ...(await resolvePrincipal(
          database,
          new Request(ORIGIN, { headers: { "x-test-human-subject": "owner" } }),
          adapter,
        )),
        kind: "agent",
      };
    return subject ? resolvePrincipal(database, request, adapter) : null;
  };
  const service = createD1ProfilesService(d1Over(database, afterRows), {
    authorize: async (p) => p.accountId === "acct-owner",
  });
  const transport = createProfilesApiTransport({
    resolvePrincipal: resolve,
    authorize: async (p) => p.accountId === "acct-owner" && p.kind === "human",
    service,
  });
  const call = (path, { method = "GET", subject, body, headers = {} } = {}) =>
    transport.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(subject ? { "x-test-human-subject": subject } : {}),
          ...(body !== undefined
            ? { "content-type": "application/json", origin: ORIGIN }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    await callback({ call, database });
  } finally {
    database.close();
  }
}

test("CSV exports all matching saved rows in sort and column order", async () => {
  await withApi(async ({ call, database }) => {
    database.exec(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1002)
      INSERT INTO person_roles (id, person_id, county_fips, published_office, published_title)
      SELECT printf('role-csv-%04d', x), 'person-a', '08001', 'Synthetic CSV Office', printf('Role %04d', x) FROM n;
      INSERT INTO people (id, display_name) VALUES ('other-county-csv', 'Another Person');
      INSERT INTO person_roles (id, person_id, county_fips, published_office, published_title)
      VALUES ('other-csv', 'other-county-csv', '08069', 'Synthetic CSV Office', 'Role 4000');
    `);
    database
      .prepare(
        "UPDATE person_roles SET job_description = ?, version = version + 1 WHERE id = 'role-csv-1002'",
      )
      .run('  =1+1, "works"\nNext line');
    const base = "/api/admin/profiles/export";
    const params = new URLSearchParams({
      county: "08001",
      office: "Synthetic CSV Office",
      sort: "position",
      direction: "desc",
      columns: "position,roleDuties,visible",
    });
    const path = `${base}?${params}`;
    assert.equal((await call(path)).status, 401);
    for (const subject of ["editor", "agent"])
      assert.equal((await call(path, { subject })).status, 403);
    const response = await call(path, { subject: "owner" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.match(
      response.headers.get("content-disposition"),
      /attachment.*profiles-view[.]csv/,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const { rows } = readCsvTable(new TextDecoder().decode(bytes));
    assert.deepEqual(rows[0], ["Position", "Role / Duties", "Visible"]);
    assert.equal(rows.length, 1003);
    assert.deepEqual(rows[1], [
      "Role 1002",
      '\'  =1+1, "works"\nNext line',
      "Yes",
    ]);
    assert.deepEqual(rows.at(-1), ["Role 0001", "", "Yes"]);
    for (const columns of ["roleSource", "displayName,displayName"]) {
      const invalid = await call(`${base}?columns=${columns}`, {
        subject: "owner",
      });
      assert.equal(invalid.status, 400);
    }
    const empty = await call(`${base}?columns=displayName&query=no-matches`, {
      subject: "owner",
    });
    assert.equal(empty.status, 200);
    assert.equal(await empty.text(), "Display Name\r\n");
  });
});

test("CSV requests return no file if a reviewed visibility write interrupts the export", async () => {
  let changed = false;
  await withApi(
    async ({ call }) => {
      const response = await call(
        "/api/admin/profiles/export?columns=displayName,visible",
        { subject: "owner" },
      );
      assert.equal(changed, true);
      assert.equal(response.status, 409);
      assert.equal(response.headers.has("content-disposition"), false);
      assert.equal((await response.json()).error, "stale_version");
    },
    (database, sql) => {
      if (changed || !sql.includes("LIMIT 1000 OFFSET 0")) return;
      changed = true;
      database.exec(`
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
      VALUES ('person-a', 0, 'acct-owner');
      INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary)
      VALUES ('export-test-audit', 'acct-owner', 'profile.hide', 'person', 'person-a', 'Synthetic concurrent change');
    `);
    },
  );
});

test("protected routes deny anonymous, non-owner, agent and cross-origin callers", async () => {
  await withApi(async ({ call }) => {
    const key = { "idempotency-key": "key-api-denied-1" };
    const body = {
      changes: [
        {
          kind: "visibility",
          personId: "person-a",
          expectedVersion: 0,
          visible: false,
        },
      ],
    };
    assert.equal((await call("/api/admin/profiles/rows")).status, 401);
    assert.equal(
      (await call("/api/admin/profiles/rows", { subject: "editor" })).status,
      403,
    );
    assert.equal(
      (await call("/api/admin/profiles/facets", { subject: "editor" })).status,
      403,
    );
    assert.equal(
      (await call("/api/admin/profiles/select-all", { subject: "editor" }))
        .status,
      403,
    );
    assert.equal(
      (await call("/api/admin/profiles/rows", { subject: "agent" })).status,
      403,
    );
    for (const path of [
      "preview",
      "save",
      "matching-visibility/preview",
      "matching-visibility/save",
    ]) {
      const target = `/api/admin/profiles/${path}`;
      assert.equal(
        (await call(target, { method: "POST", body, headers: key })).status,
        401,
      );
      assert.equal(
        (
          await call(target, {
            method: "POST",
            subject: "editor",
            body,
            headers: key,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(target, {
            method: "POST",
            subject: "agent",
            body,
            headers: key,
          })
        ).status,
        403,
      );
      const crossOrigin = await call(target, {
        method: "POST",
        subject: "owner",
        body,
        headers: { ...key, origin: "https://evil.invalid" },
      });
      assert.equal(crossOrigin.status, 403);
    }
  });
});

test("matching visibility reviews and changes more than 13,000 profiles in one guarded save", async () => {
  await withApi(async ({ call, database }) => {
    database.exec(`
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 13000)
      INSERT INTO people (id, display_name) SELECT 'bulk-' || n, 'Bulk candidate ' || n FROM numbers;
      INSERT INTO people (id, display_name) VALUES
        ('no-role', 'Bulk candidate incomplete'), ('no-visibility', 'Bulk candidate roleless'),
        ('already', 'Bulk candidate visible'), ('outside', 'Outside filter');
      INSERT INTO person_roles (id, person_id, county_fips, published_office)
      SELECT 'r-' || id, id, '08001', 'Test office'
      FROM people WHERE id LIKE 'bulk-%' OR id IN ('already', 'outside');
      INSERT INTO person_roles (id, person_id, county_fips, published_office)
      VALUES ('r-duplicate', 'bulk-1', '08001', 'Second test role');
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
      SELECT id, 0, 'acct-owner' FROM people WHERE id LIKE 'bulk-%' OR id IN ('no-role', 'outside');
    `);
    const input = { filters: { query: "Bulk candidate" }, visible: true };
    const post = (path, body, key) =>
      call(`/api/admin/profiles/matching-visibility/${path}`, {
        method: "POST",
        subject: "owner",
        body,
        headers: key ? { "idempotency-key": key } : {},
      });
    const review = async () => {
      const reply = await post("preview", input);
      assert.equal(reply.status, 200);
      return reply.json();
    };
    const first = await review();
    assert.deepEqual(
      [first.matched, first.willChange, first.alreadySet, first.incomplete],
      [13003, 13000, 1, 2],
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) n FROM person_visibility WHERE visible = 1")
        .get().n,
      0,
    );
    database.exec(
      "UPDATE people SET display_name = 'Bulk candidate changed', version = version + 1 WHERE id = 'bulk-1'",
    );
    const stale = await post(
      "save",
      { ...input, digest: first.digest },
      "bulk-vis-stale-key",
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "stale_version");
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) n FROM audit_events WHERE action = 'profile.restore'",
        )
        .get().n,
      0,
    );

    const ready = await review();
    const payload = { ...input, digest: ready.digest };
    const key = "bulk-visibility-commit";
    const commit = await post("save", payload, key);
    assert.equal(commit.status, 200);
    assert.deepEqual(await commit.json(), { applied: 13000, replayed: false });
    const replay = await post("save", payload, key);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { applied: 13000, replayed: true });
    assert.equal(
      (await post("save", { ...payload, visible: false }, key)).status,
      409,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) n FROM person_visibility WHERE visible = 1 AND version = 2",
        )
        .get().n,
      13000,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) n FROM audit_events WHERE action = 'profile.restore'",
        )
        .get().n,
      13000,
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT person_id FROM person_visibility WHERE visible = 0 ORDER BY person_id",
        )
        .all()
        .map((r) => r.person_id),
      ["no-role", "outside"],
    );
  });
});

test("an equal-count visibility swap invalidates the matching preview", async () => {
  await withApi(async ({ call, database }) => {
    database.exec(`
      INSERT INTO people (id, display_name) VALUES ('person-b', 'Synthetic Person B');
      INSERT INTO person_roles (id, person_id, county_fips, published_office)
      VALUES ('role-b', 'person-b', '08001', 'Synthetic Claims Office');
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
      VALUES ('person-b', 0, 'acct-owner');
    `);
    const post = (path, body, key) =>
      call(`/api/admin/profiles/${path}`, {
        method: "POST",
        subject: "owner",
        body,
        headers: key ? { "idempotency-key": key } : {},
      });
    const input = { filters: { visibility: "hidden" }, visible: true };
    const first = await (
      await post("matching-visibility/preview", input)
    ).json();
    assert.equal(first.willChange, 1);
    const swap = await post(
      "save",
      {
        changes: [
          {
            kind: "visibility",
            personId: "person-a",
            expectedVersion: 0,
            visible: false,
          },
          {
            kind: "visibility",
            personId: "person-b",
            expectedVersion: 1,
            visible: true,
          },
        ],
      },
      "ordinary-visibility-swap",
    );
    assert.equal(swap.status, 200);
    const after = await (
      await post("matching-visibility/preview", input)
    ).json();
    assert.equal(after.willChange, 1);
    assert.notEqual(after.digest, first.digest);
    const stale = await post(
      "matching-visibility/save",
      { ...input, digest: first.digest },
      "matching-visibility-swap",
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(
      database
        .prepare("SELECT person_id FROM person_visibility WHERE visible = 0")
        .all()
        .map((row) => row.person_id),
      ["person-a"],
    );
  });
});

test("the owner reads, saves, retries and hits a stale version through the API", async () => {
  await withApi(async ({ call, database }) => {
    const rows = await call("/api/admin/profiles/rows?pageSize=10", {
      subject: "owner",
    });
    assert.equal(rows.status, 200);
    assert.match(rows.headers.get("cache-control"), /no-store/);
    const page = await rows.json();
    assert.equal(page.total, 1);
    assert.equal(page.pageSize, 10);
    const defaultPage = await call("/api/admin/profiles/rows", {
      subject: "owner",
    });
    assert.equal(defaultPage.status, 200);
    assert.equal((await defaultPage.json()).pageSize, 50);
    const thousand = await call("/api/admin/profiles/rows?pageSize=1000", {
      subject: "owner",
    });
    assert.equal(thousand.status, 200);
    assert.equal((await thousand.json()).pageSize, 1000);
    assert.equal(
      (
        await call("/api/admin/profiles/rows?pageSize=1001", {
          subject: "owner",
        })
      ).status,
      400,
    );
    // Public-private boundary: no citation or review data in the grid payload.
    const text = JSON.stringify(page);
    assert.equal(text.includes("private-citation"), false);
    assert.equal(text.includes("Synthetic citation title"), false);
    const row = page.rows[0];
    const change = {
      kind: "field",
      entity: "person_roles",
      targetId: row.roleId,
      field: "end_date",
      expectedVersion: row.roleVersion,
      value: "2026-03-01",
    };
    const headers = { "idempotency-key": "key-api-save-001" };
    const noKey = await call("/api/admin/profiles/save", {
      method: "POST",
      subject: "owner",
      body: { changes: [change] },
    });
    assert.equal(noKey.status, 400);
    const preview = await call("/api/admin/profiles/preview", {
      method: "POST",
      subject: "owner",
      body: { changes: [change] },
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).ok, true);
    const saved = await call("/api/admin/profiles/save", {
      method: "POST",
      subject: "owner",
      body: { changes: [change] },
      headers,
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).replayed, false);
    const retried = await call("/api/admin/profiles/save", {
      method: "POST",
      subject: "owner",
      body: { changes: [change] },
      headers,
    });
    assert.equal((await retried.json()).replayed, true);
    assert.equal(
      database
        .prepare("SELECT version FROM person_roles WHERE id='role-a'")
        .get().version,
      2,
    );
    // The same edit on the old version is stale and reports what is current.
    const stale = await call("/api/admin/profiles/save", {
      method: "POST",
      subject: "owner",
      body: { changes: [{ ...change, value: "2026-04-01" }] },
      headers: { "idempotency-key": "key-api-stale-01" },
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.error, "stale_version");
    assert.equal(staleBody.issues[0].currentValue, "2026-03-01");
    // Request-shape limits.
    const wrongType = await transportless(call, "text/plain");
    assert.equal(wrongType.status, 415);
    assert.equal(
      (await call("/api/admin/profiles/nope", { subject: "owner" })).status,
      404,
    );
    assert.equal(
      (
        await call("/api/admin/profiles/rows", {
          method: "POST",
          subject: "owner",
          body: {},
        })
      ).status,
      405,
    );
  });
});

async function transportless(call, type) {
  return call("/api/admin/profiles/preview", {
    method: "POST",
    subject: "owner",
    body: { changes: [] },
    headers: { "content-type": type },
  });
}

test("the names route is owner-only, no-store, validates input and returns the owner view", async () => {
  await withApi(async ({ call }) => {
    const path = "/api/admin/profiles/names?profileId=person-a";
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(path, { subject: "editor" })).status, 403);
    assert.equal((await call(path, { subject: "agent" })).status, 403);
    assert.equal(
      (await call("/api/admin/profiles/names", { subject: "owner" })).status,
      400,
    );
    assert.equal(
      (
        await call("/api/admin/profiles/names?profileId=person-missing", {
          subject: "owner",
        })
      ).status,
      404,
    );
    const save = await call("/api/admin/profiles/save", {
      method: "POST",
      subject: "owner",
      headers: { "idempotency-key": "key-api-names-01" },
      body: {
        changes: [
          {
            kind: "alternate_name",
            op: "add",
            personId: "person-a",
            fields: {
              nameType: "nickname",
              firstName: null,
              middleName: null,
              lastName: null,
              namePrefix: null,
              nameSuffix: null,
              publishedName: "Synthetic API Nick",
              appliesFrom: null,
              appliesUntil: null,
              verificationStatus: "requires_review",
              publicDisplay: false,
            },
          },
        ],
      },
    });
    assert.equal(save.status, 200);
    const names = await call(path, { subject: "owner" });
    assert.equal(names.status, 200);
    assert.match(names.headers.get("cache-control"), /no-store/);
    const list = await names.json();
    assert.equal(list.names.length, 1);
    assert.equal(list.names[0].publishedName, "Synthetic API Nick");
    assert.equal(list.names[0].publicDisplay, false);
    assert.equal("sources" in list.names[0], false);
  });
});

test("single Profile deletion requires an owner from the same origin and a reviewed confirmation", async () => {
  await withApi(async ({ call, database }) => {
    const prefix = "/api/admin/profiles/delete";
    const options = { method: "POST", body: { profileId: "person-a" } };
    assert.equal((await call(`${prefix}/preview`, options)).status, 401);
    for (const subject of ["editor", "agent"])
      assert.equal(
        (await call(`${prefix}/preview`, { ...options, subject })).status,
        403,
      );
    const owner = { ...options, subject: "owner" };
    assert.equal(
      (
        await call(`${prefix}/preview`, {
          ...owner,
          headers: { origin: "https://different.invalid" },
        })
      ).status,
      403,
    );
    const response = await call(`${prefix}/preview`, owner);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const preview = await response.json();
    assert.equal(preview.profileId, "person-a");
    const commit = {
      ...owner,
      headers: { "idempotency-key": "delete-api-0001" },
      body: {
        profileId: "person-a",
        digest: preview.digest,
        reason: "duplicate",
      },
    };
    assert.equal((await call(`${prefix}/commit`, commit)).status, 400);
    assert.ok(
      database.prepare("SELECT 1 FROM people WHERE id = 'person-a'").get(),
    );
    const deleted = await call(`${prefix}/commit`, {
      ...commit,
      body: { ...commit.body, confirmation: "DELETE" },
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).profileId, "person-a");
    assert.equal((await call(`${prefix}/preview`, owner)).status, 404);
  });
});

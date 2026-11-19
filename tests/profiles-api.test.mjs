import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { createProfilesApiTransport } from "../dist/transport/profiles-api.js";

const ORIGIN = "https://watchdog.invalid";

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

const SEED = `
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-owner', 'human', 'owner', 'Synthetic Owner'), ('acct-editor', 'human', 'editor', 'Synthetic Editor');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-owner', 'acct-owner', 'test-human', 'owner'), ('ident-editor', 'acct-editor', 'test-human', 'editor');
  INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('org-adams', 'Synthetic Adams Office', 'office', '08001');
  INSERT INTO positions (id, organization_id, title) VALUES ('pos-adams', 'org-adams', 'Synthetic Clerk');
  INSERT INTO role_sources (id, url, title, source_type) VALUES ('src-a', 'https://example.invalid/private-citation', 'Synthetic citation title', 'official_page');
  INSERT INTO people (id, display_name) VALUES ('person-a', 'Synthetic Person A');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at) VALUES ('role-a', 'person-a', 'pos-adams', 'src-a', '2026-10-01T00:00:00Z');
`;

async function withApi(callback) {
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
  const service = createD1ProfilesService(d1Over(database), {
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
    for (const path of ["preview", "save"]) {
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

test("the owner reads, saves, retries and hits a stale version through the API", async () => {
  await withApi(async ({ call, database }) => {
    const rows = await call("/api/admin/profiles/rows?pageSize=10", {
      subject: "owner",
    });
    assert.equal(rows.status, 200);
    assert.match(rows.headers.get("cache-control"), /no-store/);
    const page = await rows.json();
    assert.equal(page.total, 1);
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

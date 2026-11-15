import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { createContentService } from "../dist/services/content.js";
import { createServices } from "../dist/services/index.js";
import {
  CONTENT_API_PATHS,
  createContentApiTransport,
  createContentTransportOperations,
  MAX_CONTENT_REQUEST_BYTES,
} from "../dist/transport/content-api.js";
import {
  allowSynthetic,
  auditCount,
  revisionCount,
  withContentFixture,
} from "./content-fixtures.mjs";

const ORIGIN = "https://watchdog.invalid";
const ALL_OPERATIONS = Object.keys(CONTENT_API_PATHS);

function post(path, value, options = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...(options.method === "GET" || options.method === "HEAD"
      ? {}
      : { body: options.body ?? JSON.stringify(value) }),
  });
}

/** Principal resolution is a stand-in for the M0-C resolver; the transport trusts nothing in the request. */
function wire({ principal, service }, overrides = {}) {
  return createContentApiTransport({
    resolvePrincipal: async (request) => {
      const who = request.headers.get("x-synthetic-user");
      return who ? principal(who) : null;
    },
    authorize: (_principal, operation) => ALL_OPERATIONS.includes(operation),
    operations: createContentTransportOperations(service),
    ...overrides,
  });
}

const as = (who, headers = {}) => ({
  headers: { "x-synthetic-user": who, ...headers },
});

async function call(transport, path, value, who = "author", options = {}) {
  const response = await transport.fetch(
    post(path, value, {
      ...as(who),
      ...options,
      headers: { ...as(who).headers, ...(options.headers ?? {}) },
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    response,
    text,
    body: text ? JSON.parse(text) : null,
  };
}

test("denies every route by default when nothing is configured", async () => {
  const transport = createContentApiTransport();
  for (const path of Object.values(CONTENT_API_PATHS)) {
    const result = await call(transport, path, { id: "x" }, "author");
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "authentication_required" });
  }
});

test("each missing layer denies: authorization, handlers, and the service policy", async () => {
  await withContentFixture(async (fixture) => {
    const { principal, database } = fixture;
    const draftBody = { contentType: "post", title: "Layered" };
    const resolve = async (request) => {
      const who = request.headers.get("x-synthetic-user");
      return who ? principal(who) : null;
    };

    // Principal but no authorize callback.
    let result = await call(
      createContentApiTransport({ resolvePrincipal: resolve }),
      CONTENT_API_PATHS.createDraft,
      draftBody,
    );
    assert.equal(result.status, 403);

    // Authorization present but non-true, throwing, or for another operation.
    for (const authorize of [
      () => 1,
      () => "true",
      () => undefined,
      () => {
        throw new Error("boom");
      },
      () => false,
    ]) {
      result = await call(
        createContentApiTransport({
          resolvePrincipal: resolve,
          authorize,
          operations: createContentTransportOperations(fixture.service),
        }),
        CONTENT_API_PATHS.createDraft,
        draftBody,
      );
      assert.equal(result.status, 403);
    }
    const partial = createContentApiTransport({
      resolvePrincipal: resolve,
      authorize: async (_p, operation) => operation === "listDrafts",
      operations: createContentTransportOperations(fixture.service),
    });
    assert.equal(
      (await call(partial, CONTENT_API_PATHS.createDraft, draftBody)).status,
      403,
    );
    assert.equal(
      (await call(partial, CONTENT_API_PATHS.listRevisions, { id: "x" }))
        .status,
      403,
    );
    assert.equal(
      (await call(partial, CONTENT_API_PATHS.listDrafts, {})).status,
      200,
    );

    // Authorized but no handler for the operation.
    result = await call(
      createContentApiTransport({
        resolvePrincipal: resolve,
        authorize: () => true,
      }),
      CONTENT_API_PATHS.createDraft,
      draftBody,
    );
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "operation_unavailable" });
    const missingOne = createContentApiTransport({
      resolvePrincipal: resolve,
      authorize: () => true,
      operations: {
        ...createContentTransportOperations(fixture.service),
        restoreRevision: undefined,
      },
    });
    assert.equal(
      (
        await call(missingOne, CONTENT_API_PATHS.restoreRevision, {
          id: "x",
          expectedVersion: 2,
          revisionVersion: 1,
        })
      ).status,
      503,
    );

    // Resolver failure is a dependency error, never access.
    result = await call(
      createContentApiTransport({
        resolvePrincipal: async () => {
          throw new Error("down");
        },
        authorize: () => true,
        operations: createContentTransportOperations(fixture.service),
      }),
      CONTENT_API_PATHS.createDraft,
      draftBody,
    );
    assert.equal(result.status, 503);

    // The transport allows it but the service policy denies it.
    const denyingService = createContentService(database);
    const denied = wire({ ...fixture, service: denyingService });
    result = await call(denied, CONTENT_API_PATHS.createDraft, draftBody);
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: "forbidden" });
    // Unlisted accounts are denied by the service even when the transport allows them.
    result = await call(
      wire(fixture),
      CONTENT_API_PATHS.createDraft,
      draftBody,
      "outsider",
    );
    assert.equal(result.status, 403);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM content_items").get()
        .count,
      0,
    );
    assert.equal(auditCount(database), 0);
  });
});

test("denies inactive accounts and revoked identities even with a resolved principal", async () => {
  await withContentFixture(async (fixture) => {
    const { database, principal } = fixture;
    const retired = await principal("retired");
    const stale = createContentApiTransport({
      resolvePrincipal: async () => retired,
      authorize: () => true,
      operations: createContentTransportOperations(fixture.service),
    });
    database.exec(
      "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'acct-retired'",
    );
    for (const [path, body] of [
      [CONTENT_API_PATHS.createDraft, { contentType: "post", title: "No" }],
      [CONTENT_API_PATHS.listDrafts, {}],
      [CONTENT_API_PATHS.listRevisions, { id: "x" }],
    ]) {
      assert.equal((await call(stale, path, body)).status, 403);
    }
    assert.equal(auditCount(database), 0);
  });
});

test("supports the complete editorial workflow with sanitized responses", async () => {
  await withContentFixture(async (fixture) => {
    const { database } = fixture;
    const api = wire(fixture);

    const created = await call(api, CONTENT_API_PATHS.createDraft, {
      contentType: "story",
      title: "API story",
      summary: "API summary",
      body: "Body one",
      relationships: {
        countyFips: ["08001"],
        personIds: ["person-1"],
        organizationIds: ["org-1"],
      },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.deepEqual(Object.keys(created.body).sort(), [
      "archivedAt",
      "body",
      "bodyFormat",
      "contentType",
      "createdAt",
      "createdByAccountId",
      "id",
      "lastEditedByAccountId",
      "relationships",
      "status",
      "summary",
      "title",
      "updatedAt",
      "version",
    ]);
    assert.equal(created.body.version, 1);
    assert.equal(created.body.createdByAccountId, "acct-author");
    assert.equal(created.body.bodyFormat, "markdown");
    assert.doesNotMatch(
      created.text,
      /example\.invalid|Synthetic Author|display_name|email|credential/i,
    );
    assert.equal(
      created.response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(created.response.headers.get("cache-control"), "no-store");
    assert.equal(
      created.response.headers.get("x-content-type-options"),
      "nosniff",
    );

    const read = await call(api, CONTENT_API_PATHS.getDraft, { id });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, created.body);

    const updated = await call(
      api,
      CONTENT_API_PATHS.updateDraft,
      { id, expectedVersion: 1, changes: { body: "Body two", summary: null } },
      "editor",
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);
    assert.equal(updated.body.summary, null);
    assert.equal(updated.body.lastEditedByAccountId, "acct-editor");

    const linked = await call(api, CONTENT_API_PATHS.setRelationships, {
      id,
      expectedVersion: 2,
      relationships: { countyFips: ["08013", "08069"], personIds: [] },
    });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.relationships, {
      countyFips: ["08013", "08069"],
      personIds: [],
      organizationIds: ["org-1"],
    });

    const list = await call(api, CONTENT_API_PATHS.listDrafts, {
      status: "draft",
      contentType: "story",
      limit: 5,
    });
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal("body" in list.body.items[0], false);
    assert.deepEqual(Object.keys(list.body).sort(), [
      "hasMore",
      "items",
      "nextCursor",
    ]);

    const archived = await call(api, CONTENT_API_PATHS.archiveDraft, {
      id,
      expectedVersion: 3,
    });
    assert.equal(archived.body.status, "archived");
    assert.equal(
      (
        await call(api, CONTENT_API_PATHS.updateDraft, {
          id,
          expectedVersion: 4,
          changes: { title: "Blocked" },
        })
      ).status,
      409,
    );
    const restored = await call(api, CONTENT_API_PATHS.restoreDraft, {
      id,
      expectedVersion: 4,
    });
    assert.equal(restored.body.status, "draft");
    assert.equal(restored.body.version, 5);

    const revisions = await call(api, CONTENT_API_PATHS.listRevisions, {
      id,
      limit: 2,
    });
    assert.equal(revisions.status, 200);
    assert.deepEqual(
      revisions.body.items.map((r) => r.version),
      [5, 4],
    );
    assert.equal(revisions.body.hasMore, true);
    assert.equal(revisions.body.nextCursor, 4);
    assert.equal("body" in revisions.body.items[0], false);
    const older = await call(api, CONTENT_API_PATHS.listRevisions, {
      id,
      limit: 10,
      beforeVersion: revisions.body.nextCursor,
    });
    assert.deepEqual(
      older.body.items.map((r) => r.version),
      [3, 2, 1],
    );

    const first = await call(api, CONTENT_API_PATHS.getRevision, {
      id,
      version: 1,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.body, "Body one");
    assert.equal(first.body.changeKind, "create");
    assert.deepEqual(first.body.relationships, {
      countyFips: ["08001"],
      personIds: ["person-1"],
      organizationIds: ["org-1"],
    });

    const back = await call(
      api,
      CONTENT_API_PATHS.restoreRevision,
      { id, expectedVersion: 5, revisionVersion: 1 },
      "editor",
    );
    assert.equal(back.status, 200);
    assert.equal(back.body.version, 6);
    assert.equal(back.body.body, "Body one");
    assert.equal(back.body.summary, "API summary");
    assert.equal(back.body.lastEditedByAccountId, "acct-editor");
    assert.equal(back.body.createdByAccountId, "acct-author");
    assert.equal(revisionCount(database, id), 6);
  });
});

test("maps service failures to bounded, body-free errors", async () => {
  await withContentFixture(async (fixture) => {
    const { database } = fixture;
    const api = wire(fixture);
    const marker = "ARTICLE-BODY-MARKER-DO-NOT-ECHO";
    const created = await call(api, CONTENT_API_PATHS.createDraft, {
      contentType: "post",
      title: "Errors",
      body: marker,
    });
    const id = created.body.id;
    const revisions = revisionCount(database);
    const audits = auditCount(database);

    const cases = [
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 9, changes: { body: marker } },
        409,
        "version_conflict",
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id: "missing", expectedVersion: 1, changes: { body: marker } },
        404,
        "not_found",
      ],
      [CONTENT_API_PATHS.getDraft, { id: "missing" }, 404, "not_found"],
      [CONTENT_API_PATHS.getRevision, { id, version: 9 }, 404, "not_found"],
      [CONTENT_API_PATHS.listRevisions, { id: "missing" }, 404, "not_found"],
      [
        CONTENT_API_PATHS.restoreDraft,
        { id, expectedVersion: 1 },
        409,
        "invalid_state",
      ],
      [
        CONTENT_API_PATHS.setRelationships,
        {
          id,
          expectedVersion: 1,
          relationships: { personIds: ["missing-person"] },
        },
        422,
        "invalid_relationship",
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 1, changes: { title: "   ", body: marker } },
        400,
        "invalid_request",
      ],
      [
        CONTENT_API_PATHS.restoreRevision,
        { id, expectedVersion: 1, revisionVersion: 1 },
        400,
        "invalid_request",
      ],
      [
        CONTENT_API_PATHS.setRelationships,
        { id, expectedVersion: 1, relationships: { countyFips: ["Adams"] } },
        400,
        "invalid_request",
      ],
    ];
    for (const [path, body, status, error] of cases) {
      const result = await call(api, path, body);
      assert.equal(result.status, status, path);
      assert.deepEqual(result.body, { error }, path);
      assert.doesNotMatch(result.text, new RegExp(marker));
    }
    assert.equal(revisionCount(database), revisions);
    assert.equal(auditCount(database), audits);

    const leaky = createContentApiTransport({
      resolvePrincipal: async () => fixture.principal("author"),
      authorize: () => true,
      operations: {
        getDraft: () => {
          throw new Error(`secret ${marker} cwa_${"a".repeat(43)}`);
        },
        listDrafts: () => ({ items: "not-a-page" }),
        createDraft: () => undefined,
      },
    });
    for (const [path, body] of [
      [CONTENT_API_PATHS.getDraft, { id }],
      [CONTENT_API_PATHS.listDrafts, {}],
      [CONTENT_API_PATHS.createDraft, { contentType: "post", title: "x" }],
    ]) {
      const result = await call(leaky, path, body);
      assert.equal(result.status, 500);
      assert.deepEqual(result.body, { error: "internal_error" });
      assert.doesNotMatch(result.text, /secret|cwa_|MARKER/);
    }
  });
});

test("rejects invalid methods, routes, headers, and payloads before any change", async () => {
  await withContentFixture(async (fixture) => {
    const { database } = fixture;
    const api = wire(fixture);
    const created = await call(api, CONTENT_API_PATHS.createDraft, {
      contentType: "post",
      title: "Inputs",
    });
    const id = created.body.id;
    const revisions = revisionCount(database);
    const audits = auditCount(database);
    const raw = (request) => api.fetch(request);

    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const response = await raw(
        post(CONTENT_API_PATHS.getDraft, { id }, { method, ...as("author") }),
      );
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "POST");
    }
    assert.equal(
      (await raw(post("/internal/content/unknown", {}, as("author")))).status,
      404,
    );
    assert.equal(
      (await raw(post("/internal/content/drafts/get/", {}, as("author"))))
        .status,
      404,
    );
    assert.equal(
      (
        await raw(
          post(`${CONTENT_API_PATHS.getDraft}?id=${id}`, { id }, as("author")),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await raw(
          post(
            CONTENT_API_PATHS.getDraft,
            { id },
            {
              headers: {
                "content-type": "text/plain",
                "x-synthetic-user": "author",
              },
            },
          ),
        )
      ).status,
      415,
    );
    assert.equal(
      (
        await raw(
          post(
            CONTENT_API_PATHS.getDraft,
            { id },
            {
              headers: {
                "content-type": "application/json; charset=utf-8",
                "x-synthetic-user": "author",
              },
            },
          ),
        )
      ).status,
      200,
    );

    const invalidBodies = [
      ["{not json", CONTENT_API_PATHS.getDraft],
      ["", CONTENT_API_PATHS.getDraft],
      ["null", CONTENT_API_PATHS.getDraft],
      ["[]", CONTENT_API_PATHS.getDraft],
      ['"text"', CONTENT_API_PATHS.getDraft],
    ];
    for (const [body, path] of invalidBodies) {
      const result = await call(api, path, null, "author", { body });
      assert.equal(result.status, 400, body);
      assert.deepEqual(result.body, { error: "invalid_request" });
    }
    const badUtf8 = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    assert.equal(
      (
        await call(api, CONTENT_API_PATHS.getDraft, null, "author", {
          body: badUtf8,
        })
      ).status,
      400,
    );

    const bad = (path, value) => call(api, path, value);
    const invalid = [
      [CONTENT_API_PATHS.getDraft, {}],
      [CONTENT_API_PATHS.getDraft, { id, extra: 1 }],
      [CONTENT_API_PATHS.getDraft, { id: "has space" }],
      [CONTENT_API_PATHS.getDraft, { id: "x".repeat(129) }],
      [CONTENT_API_PATHS.getDraft, { id: 5 }],
      [CONTENT_API_PATHS.createDraft, { title: "No type" }],
      [
        CONTENT_API_PATHS.createDraft,
        { contentType: "page", title: "Bad type" },
      ],
      [CONTENT_API_PATHS.createDraft, { contentType: "post", title: 5 }],
      [
        CONTENT_API_PATHS.createDraft,
        { contentType: "post", title: "Ok", status: "archived" },
      ],
      [
        CONTENT_API_PATHS.createDraft,
        { contentType: "post", title: "Ok", createdByAccountId: "acct-editor" },
      ],
      [
        CONTENT_API_PATHS.createDraft,
        { contentType: "post", title: "Ok", body: "a".repeat(200_001) },
      ],
      [
        CONTENT_API_PATHS.createDraft,
        { contentType: "post", title: "Ok", summary: null },
      ],
      [
        CONTENT_API_PATHS.createDraft,
        {
          contentType: "post",
          title: "Ok",
          relationships: { personIds: "person-1" },
        },
      ],
      [
        CONTENT_API_PATHS.createDraft,
        {
          contentType: "post",
          title: "Ok",
          relationships: { names: ["Fictional Person One"] },
        },
      ],
      [
        CONTENT_API_PATHS.createDraft,
        {
          contentType: "post",
          title: "Ok",
          relationships: {
            personIds: Array.from({ length: 51 }, (_, i) => `p-${i}`),
          },
        },
      ],
      [CONTENT_API_PATHS.listDrafts, { limit: 0 }],
      [CONTENT_API_PATHS.listDrafts, { limit: 101 }],
      [CONTENT_API_PATHS.listDrafts, { limit: 2.5 }],
      [CONTENT_API_PATHS.listDrafts, { limit: "5" }],
      [CONTENT_API_PATHS.listDrafts, { status: "published" }],
      [CONTENT_API_PATHS.listDrafts, { contentType: "page" }],
      [CONTENT_API_PATHS.listDrafts, { afterId: "bad id" }],
      [CONTENT_API_PATHS.listDrafts, { offset: 1 }],
      [CONTENT_API_PATHS.updateDraft, { id, changes: { body: "x" } }],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 0, changes: { body: "x" } },
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 1.5, changes: { body: "x" } },
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: "1", changes: { body: "x" } },
      ],
      [CONTENT_API_PATHS.updateDraft, { id, expectedVersion: 1 }],
      [CONTENT_API_PATHS.updateDraft, { id, expectedVersion: 1, changes: {} }],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 1, changes: { status: "archived" } },
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 1, changes: { version: 9 } },
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 1, changes: { title: null } },
      ],
      [
        CONTENT_API_PATHS.updateDraft,
        { id, expectedVersion: 1, changes: { body: "a".repeat(200_001) } },
      ],
      [CONTENT_API_PATHS.setRelationships, { id, expectedVersion: 1 }],
      [
        CONTENT_API_PATHS.setRelationships,
        { id, expectedVersion: 1, relationships: {} },
      ],
      [CONTENT_API_PATHS.archiveDraft, { id }],
      [CONTENT_API_PATHS.restoreDraft, { id, expectedVersion: 1, force: true }],
      [CONTENT_API_PATHS.listRevisions, { id, limit: 101 }],
      [CONTENT_API_PATHS.listRevisions, { id, beforeVersion: 0 }],
      [CONTENT_API_PATHS.listRevisions, { limit: 5 }],
      [CONTENT_API_PATHS.getRevision, { id }],
      [CONTENT_API_PATHS.getRevision, { id, version: 0 }],
      [CONTENT_API_PATHS.getRevision, { id, version: 1.5 }],
      [CONTENT_API_PATHS.restoreRevision, { id, expectedVersion: 2 }],
      [CONTENT_API_PATHS.restoreRevision, { id, revisionVersion: 1 }],
      [
        CONTENT_API_PATHS.restoreRevision,
        { id, expectedVersion: 2, revisionVersion: 1, extra: true },
      ],
    ];
    for (const [path, value] of invalid) {
      const result = await bad(path, value);
      assert.equal(
        result.status,
        400,
        `${path} ${JSON.stringify(value).slice(0, 80)}`,
      );
      assert.deepEqual(result.body, { error: "invalid_request" });
    }

    // Oversized requests are rejected from the declared length or while streaming.
    const oversized = JSON.stringify({
      contentType: "post",
      title: "Big",
      body: "a".repeat(MAX_CONTENT_REQUEST_BYTES),
    });
    const declared = await call(
      api,
      CONTENT_API_PATHS.createDraft,
      null,
      "author",
      {
        body: oversized,
        headers: { "content-length": String(oversized.length) },
      },
    );
    assert.equal(declared.status, 413);
    assert.deepEqual(declared.body, { error: "request_too_large" });
    const streamed = new Request(`${ORIGIN}${CONTENT_API_PATHS.createDraft}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synthetic-user": "author",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      duplex: "half",
    });
    assert.equal((await raw(streamed)).status, 413);
    assert.equal(
      (
        await call(api, CONTENT_API_PATHS.getDraft, null, "author", {
          body: "{}",
          headers: { "content-length": "abc" },
        })
      ).status,
      400,
    );

    assert.equal(revisionCount(database), revisions);
    assert.equal(auditCount(database), audits);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM content_items").get()
        .count,
      1,
    );
  });
});

test("Markdown, HTML, and links are stored and returned only as inert source text", async () => {
  await withContentFixture(async (fixture) => {
    const api = wire(fixture);
    const hostile =
      '<script>alert("synthetic")</script>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))\n![pixel](https://example.invalid/pixel.png)\n<iframe src="https://example.invalid/frame"></iframe>\n';
    const created = await call(api, CONTENT_API_PATHS.createDraft, {
      contentType: "post",
      title: "Inert",
      body: hostile,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.body, hostile);
    assert.equal(created.body.bodyFormat, "markdown");
    assert.match(
      created.response.headers.get("content-type"),
      /^application\/json/,
    );
    assert.equal(
      created.response.headers.get("x-content-type-options"),
      "nosniff",
    );
    const revision = await call(api, CONTENT_API_PATHS.getRevision, {
      id: created.body.id,
      version: 1,
    });
    assert.equal(revision.body.body, hostile);
    assert.equal(revision.body.bodyFormat, "markdown");
    // A name or title that matches a person never creates a relationship.
    const named = await call(api, CONTENT_API_PATHS.createDraft, {
      contentType: "post",
      title: "Fictional Person One visits Fictional Records Office",
      body: "Fictional Person One is mentioned here.",
    });
    assert.deepEqual(named.body.relationships, {
      countyFips: [],
      personIds: [],
      organizationIds: [],
    });
  });
});

test("the draft and revision API stays unregistered in the application and services", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    service.createDraft(author, { contentType: "post", title: "Hidden" });
    const services = createServices({ database });
    const application = createApplication(services);
    for (const path of Object.values(CONTENT_API_PATHS)) {
      for (const method of ["POST", "GET"]) {
        const response = await application.fetch(
          post(path, {}, { method, ...as("author") }),
        );
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    }
    assert.deepEqual(
      Object.keys(services).filter((name) =>
        /content|draft|revision|editorial/i.test(name),
      ),
      [],
    );
    for (const file of ["src/application.ts", "src/services/index.ts"]) {
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /content-api|services\/content|contracts\/content/,
      );
    }
  });
});

test("content services keep their own default-deny policy behind the transport", async () => {
  await withContentFixture(async (fixture) => {
    const { database, principal } = fixture;
    const author = await principal("author");
    const baseline = createContentService(database, {
      authorize: allowSynthetic,
    });
    const draft = baseline.createDraft(author, {
      contentType: "post",
      title: "Policy",
    });
    // Transport authorization alone grants nothing: the service gets no policy.
    const noPolicy = createContentApiTransport({
      resolvePrincipal: async () => author,
      authorize: () => true,
      operations: createContentTransportOperations(
        createContentService(database),
      ),
    });
    for (const [path, body] of [
      [CONTENT_API_PATHS.getDraft, { id: draft.id }],
      [CONTENT_API_PATHS.listRevisions, { id: draft.id }],
      [
        CONTENT_API_PATHS.restoreRevision,
        { id: draft.id, expectedVersion: 2, revisionVersion: 1 },
      ],
    ]) {
      assert.equal((await call(noPolicy, path, body)).status, 403);
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { StorageUnavailableError } from "../dist/contracts/storage.js";
import { BannerStageError } from "../dist/services/banner-admin-d1.js";
import {
  BannerConflictError,
  BannerValidationError,
} from "../dist/services/banner-assets.js";
import { BannerImageError } from "../dist/services/banner-image-inspector.js";
import {
  AuthorizationError,
  makeTrustedPrincipal,
} from "../dist/services/security.js";
import {
  BANNER_STAGE_HEADER,
  createBannerAdminApiTransport,
  isBannerAdminPath,
  MAX_BANNER_ADMIN_JSON_BYTES,
} from "../dist/transport/banner-admin-api.js";

const ORIGIN = "https://watchdog.invalid";
const API = `${ORIGIN}/api/admin/banners`;
const VERSION = "11111111-2222-4333-8444-555555555555";
const KEY = "synthetic-key-1";

const principal = (id, role, kind = "human") =>
  makeTrustedPrincipal(
    { id, identity_id: `${id}-identity`, kind, role },
    kind === "agent" ? "agent-key" : "test-human",
  );
const PEOPLE = {
  admin: principal("admin", "administrator"),
  editor: principal("editor", "editor"),
  agent: principal("agent", "administrator", "agent"),
};

/** Records every call so a test can prove the service was or was not reached. */
function fakeService(overrides = {}) {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push({ name, args });
      return typeof result === "function" ? result(...args) : result;
    };
  const change = {
    bannerId: "b1",
    status: "active",
    selectedVersionId: VERSION,
    rowVersion: 2,
    publicationId: "p1",
    replayed: false,
  };
  const service = {
    listCounties: record("listCounties", { counties: [] }),
    getCounty: record("getCounty", {
      county: { fips: "08001", name: "Adams" },
      banners: [],
      bannersTruncated: false,
    }),
    listPublications: record("listPublications", []),
    reconcileBanner: record("reconcileBanner", []),
    readVersionImage: record("readVersionImage", {
      versionId: VERSION,
      mediaType: "image/png",
      byteSize: 3,
      sha256: "a".repeat(64),
      body: new Uint8Array([137, 80, 78]),
    }),
    stage: record("stage", {
      bannerId: "b1",
      version: { id: VERSION },
      bannerRowVersion: 1,
      replayed: false,
      decode: "full",
      verified: true,
    }),
    publish: record("publish", change),
    withdraw: record("withdraw", { ...change, status: "withdrawn" }),
    restore: record("restore", change),
    updateMetadata: record("updateMetadata", {
      ...change,
      publicationId: null,
    }),
    reorderCounty: record("reorderCounty", {
      countyFips: "08001",
      banners: [],
      replayed: false,
    }),
    ...overrides,
  };
  return { service, calls };
}

function wire({ service, authorize, resolve } = {}) {
  const fake = fakeService();
  const used = service ?? fake.service;
  const transport = createBannerAdminApiTransport({
    resolvePrincipal:
      resolve ??
      (async (request) =>
        PEOPLE[request.headers.get("x-synthetic-user")] ?? null),
    authorize: authorize ?? ((p) => p.role === "administrator"),
    administration: used,
  });
  return { transport, calls: fake.calls };
}

const as = (who, extra = {}) => ({ "x-synthetic-user": who, ...extra });
const write = { origin: ORIGIN, "content-type": "application/json" };

async function send(transport, method, path, { headers = {}, body } = {}) {
  const response = await transport.fetch(
    new Request(`${API}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body, duplex: "half" }),
    }),
  );
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, response, text };
}

const post = (transport, path, value, who = "admin", extra = {}) =>
  send(transport, "POST", path, {
    headers: as(who, { ...write, ...extra }),
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

const stageHeader = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const NEW_META = {
  caption: "Synthetic caption",
  altText: "Synthetic alt text",
  displayOrder: 0,
  isPrimary: true,
  displayMode: "cover",
  focalX: 0.5,
  focalY: 0.5,
};
const stageRequest = (transport, meta, bytes, headers = {}) =>
  send(transport, "POST", "/stage", {
    headers: as("admin", {
      origin: ORIGIN,
      "content-type": "image/png",
      [BANNER_STAGE_HEADER]: stageHeader(meta),
      ...headers,
    }),
    body: bytes,
  });
const NEW_STAGE = {
  bannerId: "synthetic-banner",
  countyFips: "08001",
  sourceFilename: "synthetic.png",
  idempotencyKey: KEY,
  target: { kind: "new", metadata: NEW_META },
};

const ROUTES = [
  ["GET", "/counties", undefined],
  ["GET", "/counties/08001", undefined],
  ["GET", "/b1/publications", undefined],
  ["GET", "/b1/reconcile", undefined],
  ["GET", `/versions/${VERSION}/image`, undefined],
  ["POST", "/stage", "stage"],
  [
    "POST",
    "/b1/publish",
    { versionId: VERSION, expectedRowVersion: 1, idempotencyKey: KEY },
  ],
  ["POST", "/b1/withdraw", { expectedRowVersion: 1, idempotencyKey: KEY }],
  [
    "POST",
    "/b1/restore",
    { versionId: VERSION, expectedRowVersion: 1, idempotencyKey: KEY },
  ],
  [
    "POST",
    "/b1/metadata",
    { expectedRowVersion: 1, idempotencyKey: KEY, change: { caption: "x" } },
  ],
  [
    "POST",
    "/counties/08001/reorder",
    {
      idempotencyKey: KEY,
      orderedBannerIds: ["b1"],
      expectedRowVersions: { b1: 1 },
    },
  ],
];

function routeRequest(transport, [method, path, body], who, extra = {}) {
  if (method === "GET")
    return send(transport, "GET", path, { headers: as(who, extra) });
  if (body === "stage")
    return stageRequest(
      transport,
      NEW_STAGE,
      new Uint8Array([137, 80, 78, 71]),
      { "x-synthetic-user": who, ...extra },
    );
  return post(transport, path, body, who, extra);
}

test("path matcher claims only the banner administration prefix", () => {
  assert.equal(isBannerAdminPath("/api/admin/banners"), true);
  assert.equal(isBannerAdminPath("/api/admin/banners/counties"), true);
  assert.equal(isBannerAdminPath("/api/admin/bannersx"), false);
  assert.equal(isBannerAdminPath("/api/admin/accounts"), false);
  assert.equal(isBannerAdminPath("/banner-assets/abc"), false);
});

test("anonymous callers are refused before any service call", async () => {
  const { transport, calls } = wire();
  for (const route of ROUTES) {
    const result = await routeRequest(transport, route, "nobody");
    assert.equal(result.status, 401, `${route[0]} ${route[1]}`);
    assert.deepEqual(result.body, { error: "authentication_required" });
  }
  assert.equal(calls.length, 0);
});

test("every operation, including preview and reconcile, requires banner.manage", async () => {
  const { transport, calls } = wire();
  for (const route of ROUTES) {
    const result = await routeRequest(transport, route, "editor");
    assert.equal(result.status, 403, `${route[0]} ${route[1]}`);
    assert.deepEqual(result.body, { error: "forbidden" });
  }
  assert.equal(calls.length, 0);
  const throwing = wire({
    authorize: async () => {
      throw new Error("authorizer exploded");
    },
  });
  assert.equal(
    (await routeRequest(throwing.transport, ROUTES[4], "admin")).status,
    403,
  );
  const absent = createBannerAdminApiTransport({
    resolvePrincipal: async () => PEOPLE.admin,
    administration: fakeService().service,
  });
  assert.equal((await routeRequest(absent, ROUTES[0], "admin")).status, 403);
});

test("administrator reaches each route and the actor is the server principal", async () => {
  const { transport, calls } = wire();
  for (const route of ROUTES) {
    const result = await routeRequest(transport, route, "admin");
    assert.ok(
      [200, 201].includes(result.status),
      `${route[0]} ${route[1]}: ${result.text}`,
    );
  }
  assert.equal(calls.length, ROUTES.length);
  for (const call of calls) assert.equal(call.args[0], PEOPLE.admin);
  const stageCall = calls.find((call) => call.name === "stage");
  assert.deepEqual([...stageCall.args[1].bytes], [137, 80, 78, 71]);
  assert.equal(stageCall.args[1].bannerId, "synthetic-banner");
  assert.equal(Object.hasOwn(stageCall.args[1], "actor"), false);
});

test("browser writes need the exact same origin, agents with a bearer credential do not", async () => {
  const { transport, calls } = wire();
  const body = JSON.stringify({ expectedRowVersion: 1, idempotencyKey: KEY });
  const attempt = (headers, who = "admin") =>
    send(transport, "POST", "/b1/withdraw", {
      headers: as(who, { "content-type": "application/json", ...headers }),
      body,
    });
  for (const headers of [
    {},
    { origin: "https://evil.invalid" },
    { origin: "https://watchdog.invalid:8443" },
    { origin: "http://watchdog.invalid" },
    { origin: "null" },
    { origin: `${ORIGIN}/` },
    { origin: ORIGIN.toUpperCase() },
  ]) {
    const result = await attempt(headers);
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.deepEqual(result.body, { error: "origin_rejected" });
  }
  assert.equal(calls.length, 0);
  assert.equal((await attempt({ origin: ORIGIN })).status, 200);
  // A bearer header from a human principal is not an exemption.
  assert.equal(
    (await attempt({ authorization: "Bearer cwa_x" }, "admin")).status,
    403,
  );
  assert.equal(
    (await attempt({ authorization: "Bearer cwa_x" }, "agent")).status,
    200,
  );
  // Reads need no origin.
  assert.equal(
    (await send(transport, "GET", "/counties", { headers: as("admin") }))
      .status,
    200,
  );
});

test("routing is strict: unknown, wrong method, query and reserved words", async () => {
  const { transport, calls } = wire();
  assert.equal(
    (await send(transport, "GET", "/nope", { headers: as("admin") })).status,
    404,
  );
  assert.equal(
    (await send(transport, "GET", "", { headers: as("admin") })).status,
    404,
  );
  assert.equal(
    (
      await send(transport, "GET", "/..%2f..%2fetc/publications", {
        headers: as("admin"),
      })
    ).status,
    404,
  );
  const wrong = await send(transport, "GET", "/b1/publish", {
    headers: as("admin"),
  });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.response.headers.get("allow"), "POST");
  assert.equal(
    (
      await send(transport, "POST", "/counties", {
        headers: as("admin", write),
        body: "{}",
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await send(transport, "GET", "/counties/08001?x=1", {
        headers: as("admin"),
      })
    ).status,
    400,
  );
  assert.equal(
    (await send(transport, "GET", "/counties?sql=1", { headers: as("admin") }))
      .status,
    400,
  );
  assert.equal(
    (
      await send(transport, "GET", "/counties?limit=abc", {
        headers: as("admin"),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await send(transport, "GET", "/counties?afterFips=99999", {
        headers: as("admin"),
      })
    ).status,
    400,
  );
  assert.equal(
    (await send(transport, "GET", "/counties/99999", { headers: as("admin") }))
      .status,
    404,
  );
  assert.equal(
    (
      await send(transport, "GET", "/versions/bad%20id/image", {
        headers: as("admin"),
      })
    ).status,
    404,
  );
  // "counties" cannot be used as a banner ID.
  assert.equal(
    (
      await send(transport, "GET", "/counties/publications", {
        headers: as("admin"),
      })
    ).status,
    404,
  );
  const reserved = await stageRequest(
    transport,
    { ...NEW_STAGE, bannerId: "counties" },
    new Uint8Array([1]),
  );
  assert.equal(reserved.status, 400);
  assert.equal(calls.length, 0);
  const ok = await send(
    transport,
    "GET",
    "/counties?query=ad&limit=5&afterFips=08001",
    {
      headers: as("admin"),
    },
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(calls[0].args[1], {
    query: "ad",
    limit: 5,
    afterFips: "08001",
  });
});

test("bodies are type-checked and closed before the service is called", async () => {
  const { transport, calls } = wire();
  const publish = (value, extra) =>
    post(transport, "/b1/publish", value, "admin", extra);
  const good = {
    versionId: VERSION,
    expectedRowVersion: 3,
    idempotencyKey: KEY,
  };
  const bad = [
    "{not json",
    "[]",
    "null",
    "42",
    '"text"',
    { ...good, actor: "someone-else" },
    { ...good, actorAccountId: "someone-else" },
    { ...good, objectKey: "banner-assets/other" },
    { ...good, path: "C:\\secret.png" },
    { ...good, sql: "DROP TABLE banner_assets" },
    { ...good, extra: true },
    { ...good, expectedRowVersion: "3" },
    { ...good, expectedRowVersion: 0 },
    { ...good, expectedRowVersion: 1.5 },
    { ...good, expectedRowVersion: Number.MAX_SAFE_INTEGER + 2 },
    { ...good, versionId: "../escape" },
    { ...good, versionId: 5 },
    { ...good, idempotencyKey: "" },
    { ...good, idempotencyKey: "   " },
    { ...good, idempotencyKey: "k".repeat(201) },
    { ...good, idempotencyKey: 7 },
    { versionId: VERSION, idempotencyKey: KEY },
    {
      ...good,
      metadata: {
        caption: "c",
        altText: "a",
        displayMode: "cover",
        focalX: 2,
        focalY: 0,
      },
    },
    {
      ...good,
      metadata: {
        caption: "c",
        altText: "a",
        displayMode: "wide",
        focalX: 0,
        focalY: 0,
      },
    },
    {
      ...good,
      metadata: {
        caption: "c",
        altText: "a",
        displayMode: "cover",
        focalX: 0,
        focalY: 0,
        extra: 1,
      },
    },
    {
      ...good,
      metadata: {
        caption: 1,
        altText: "a",
        displayMode: "cover",
        focalX: 0,
        focalY: 0,
      },
    },
  ];
  for (const value of bad) {
    const result = await publish(value);
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.deepEqual(result.body, { error: "invalid_request" });
  }
  const contentType = await send(transport, "POST", "/b1/publish", {
    headers: as("admin", { origin: ORIGIN, "content-type": "text/plain" }),
    body: JSON.stringify(good),
  });
  assert.equal(contentType.status, 415);
  const restoreBoth = await post(transport, "/b1/restore", {
    ...good,
    publicationId: "p1",
    metadata: {
      caption: "c",
      altText: "a",
      displayMode: "cover",
      focalX: 0,
      focalY: 0,
    },
  });
  assert.equal(restoreBoth.status, 400);
  const metadataEmpty = await post(transport, "/b1/metadata", {
    expectedRowVersion: 1,
    idempotencyKey: KEY,
    change: {},
  });
  assert.equal(metadataEmpty.status, 400);
  const reorderMismatch = await post(transport, "/counties/08001/reorder", {
    idempotencyKey: KEY,
    orderedBannerIds: ["b1", "b2"],
    expectedRowVersions: { b1: 1 },
  });
  assert.equal(reorderMismatch.status, 400);
  assert.equal(calls.length, 0);
  const accepted = await publish(good);
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls[0].args[1], { bannerId: "b1", ...good });
});

test("JSON bodies are capped on actual bytes with or without Content-Length", async () => {
  const { transport, calls } = wire();
  const huge = JSON.stringify({
    expectedRowVersion: 1,
    idempotencyKey: KEY,
    pad: "x".repeat(MAX_BANNER_ADMIN_JSON_BYTES),
  });
  const declared = await post(transport, "/b1/withdraw", huge, "admin", {
    "content-length": String(huge.length),
  });
  assert.equal(declared.status, 413);
  // A misleading small Content-Length does not let a large body through.
  const misleading = await post(transport, "/b1/withdraw", huge, "admin", {
    "content-length": "10",
  });
  assert.equal(misleading.status, 413);
  const stream = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(8_192).fill(0x20);
      for (let i = 0; i < 12; i += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
  const chunked = await transport.fetch(
    new Request(`${API}/b1/withdraw`, {
      method: "POST",
      headers: as("admin", write),
      body: stream,
      duplex: "half",
    }),
  );
  assert.equal(chunked.status, 413);
  const badLength = await post(transport, "/b1/withdraw", "{}", "admin", {
    "content-length": "12abc",
  });
  assert.equal(badLength.status, 400);
  const empty = await send(transport, "POST", "/b1/withdraw", {
    headers: as("admin", write),
  });
  assert.equal(empty.status, 400);
  assert.equal(calls.length, 0);
});

test("image upload is bounded on actual bytes and needs a closed metadata header", async () => {
  const { transport, calls } = wire();
  const overDeclared = await stageRequest(
    transport,
    NEW_STAGE,
    new Uint8Array([1]),
    {
      "content-length": String(26 * 1024 * 1024),
    },
  );
  assert.equal(overDeclared.status, 413);
  // 26 MiB streamed with no Content-Length.
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 26) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const chunked = await send(transport, "POST", "/stage", {
    headers: as("admin", {
      origin: ORIGIN,
      "content-type": "image/png",
      [BANNER_STAGE_HEADER]: stageHeader(NEW_STAGE),
    }),
    body: stream,
  });
  assert.equal(chunked.status, 413);
  assert.ok(sent <= 26);
  const understated = await stageRequest(
    transport,
    NEW_STAGE,
    new Uint8Array(26 * 1024 * 1024),
    { "content-length": "100" },
  );
  assert.equal(understated.status, 413);
  assert.equal(calls.length, 0);

  const headerCases = [
    undefined,
    "!!!not-base64!!!",
    Buffer.from("not json").toString("base64url"),
    stageHeader({ ...NEW_STAGE, actor: "x" }),
    stageHeader({ ...NEW_STAGE, objectKey: "banner-assets/x" }),
    stageHeader({ ...NEW_STAGE, bannerId: "../x" }),
    stageHeader({ ...NEW_STAGE, countyFips: "99999" }),
    stageHeader({ ...NEW_STAGE, sourceFilename: 5 }),
    stageHeader({ ...NEW_STAGE, expectedSha256: "XYZ" }),
    stageHeader({ ...NEW_STAGE, target: { kind: "other" } }),
    stageHeader({ ...NEW_STAGE, target: { kind: "existing" } }),
    stageHeader({
      ...NEW_STAGE,
      target: { kind: "new", metadata: { ...NEW_META, altText: 5 } },
    }),
    stageHeader({
      ...NEW_STAGE,
      target: { kind: "new", metadata: { ...NEW_META, extra: 1 } },
    }),
    "A".repeat(9_000),
  ];
  for (const header of headerCases) {
    const result = await send(transport, "POST", "/stage", {
      headers: as("admin", {
        origin: ORIGIN,
        "content-type": "image/png",
        ...(header === undefined ? {} : { [BANNER_STAGE_HEADER]: header }),
      }),
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(result.status, 400, String(header).slice(0, 40));
  }
  const wrongType = await stageRequest(
    transport,
    NEW_STAGE,
    new Uint8Array([1]),
    {
      "content-type": "image/gif",
    },
  );
  assert.equal(wrongType.status, 415);
  const encoded = await stageRequest(
    transport,
    NEW_STAGE,
    new Uint8Array([1]),
    {
      "content-encoding": "gzip",
    },
  );
  assert.equal(encoded.status, 415);
  const emptyBody = await send(transport, "POST", "/stage", {
    headers: as("admin", {
      origin: ORIGIN,
      "content-type": "image/png",
      [BANNER_STAGE_HEADER]: stageHeader(NEW_STAGE),
    }),
  });
  assert.equal(emptyBody.status, 400);
  assert.equal(calls.length, 0);

  const existing = await stageRequest(
    transport,
    {
      ...NEW_STAGE,
      target: { kind: "existing", expectedRowVersion: 4 },
      expectedSha256: "b".repeat(64),
    },
    new Uint8Array([9, 9]),
  );
  assert.equal(existing.status, 201);
  assert.deepEqual(calls[0].args[1].target, {
    kind: "existing",
    expectedRowVersion: 4,
  });
  assert.equal(calls[0].args[1].expectedSha256, "b".repeat(64));
});

test("service failures map to stable codes without internals", async () => {
  const cases = [
    [new AuthorizationError(), 403, "forbidden"],
    [new StorageUnavailableError(), 503, "dependency_unavailable"],
    [new BannerImageError("too_large", "x"), 413, "image_too_large"],
    [
      new BannerImageError("unsupported_type", "x"),
      415,
      "unsupported_image_type",
    ],
    [new BannerImageError("malformed", "x"), 422, "invalid_image"],
    [new BannerImageError("decode_failed", "x"), 422, "invalid_image"],
    [
      new BannerValidationError("Alt text is required"),
      422,
      "validation_failed",
    ],
    [new BannerConflictError("s", "stale_version"), 409, "stale_version"],
    [
      new BannerConflictError("k", "idempotency_conflict"),
      409,
      "idempotency_conflict",
    ],
    [
      new BannerConflictError("r", "snapshot_required"),
      409,
      "snapshot_required",
    ],
    [
      new BannerConflictError("v", "object_verification_failed"),
      409,
      "object_verification_failed",
    ],
    [new BannerConflictError("plain"), 409, "conflict"],
    [
      new BannerStageError("storage_failed", "boom banner-assets/secret"),
      503,
      "storage_failed",
    ],
    [new BannerStageError("finalize_failed", "boom"), 503, "finalize_failed"],
    [
      new Error("D1 exploded at banner-assets/secret-key"),
      500,
      "internal_error",
    ],
  ];
  for (const [error, status, code] of cases) {
    const { service } = fakeService({
      publish: async () => {
        throw error;
      },
    });
    const { transport } = wire({ service });
    const result = await post(transport, "/b1/publish", {
      versionId: VERSION,
      expectedRowVersion: 1,
      idempotencyKey: KEY,
    });
    assert.equal(result.status, status, error.message);
    assert.equal(result.body.error, code);
    assert.doesNotMatch(result.text, /banner-assets\/|D1 exploded|stack/);
  }
});

test("private preview serves bytes with private no-store and nosniff headers", async () => {
  const { transport, calls } = wire();
  const result = await send(transport, "GET", `/versions/${VERSION}/image`, {
    headers: as("admin"),
  });
  assert.equal(result.status, 200);
  const headers = result.response.headers;
  assert.equal(headers.get("cache-control"), "private, no-store");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("content-type"), "image/png");
  assert.equal(headers.get("content-length"), "3");
  assert.equal(calls[0].args[1], VERSION);
  const { service } = fakeService({ readVersionImage: async () => null });
  const missing = await send(
    wire({ service }).transport,
    "GET",
    `/versions/${VERSION}/image`,
    {
      headers: as("admin"),
    },
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "not_found" });
  assert.equal(
    (
      await send(transport, "POST", `/versions/${VERSION}/image`, {
        headers: as("admin", write),
        body: "{}",
      })
    ).status,
    405,
  );
});

test("unavailable dependencies produce controlled answers", async () => {
  const noService = createBannerAdminApiTransport({
    resolvePrincipal: async () => PEOPLE.admin,
    authorize: () => true,
  });
  const unavailable = await routeRequest(noService, ROUTES[0], "admin");
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { error: "banner_admin_unavailable" });
  // Anonymous callers still learn nothing about bindings.
  const anonymous = createBannerAdminApiTransport({
    resolvePrincipal: async () => null,
    authorize: () => true,
  });
  assert.equal((await routeRequest(anonymous, ROUTES[0], "x")).status, 401);
  const failing = wire({
    resolve: async () => {
      throw new Error("D1 down");
    },
  });
  const result = await routeRequest(failing.transport, ROUTES[0], "admin");
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: "dependency_unavailable" });
  assert.equal(
    (await send(createBannerAdminApiTransport(), "GET", "/counties")).status,
    401,
  );
});

test("every response is no-store JSON except the private image", async () => {
  const { transport } = wire();
  for (const route of ROUTES) {
    const result = await routeRequest(transport, route, "admin");
    if (route[1].endsWith("/image")) continue;
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(
      result.response.headers.get("x-content-type-options"),
      "nosniff",
    );
    assert.match(
      result.response.headers.get("content-type"),
      /^application\/json/,
    );
  }
});

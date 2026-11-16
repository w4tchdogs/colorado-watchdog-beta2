import assert from "node:assert/strict";
import test from "node:test";
import { readHumanSignIn } from "../dist/auth/config.js";
import {
  createSigningKeyProvider,
  exchangeAuthorizationCode,
  OidcError,
  parseJsonWithoutDuplicates,
  verifyIdToken,
} from "../dist/auth/oidc.js";
import { validReturnPath } from "../dist/auth/routes.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  compactJwt,
  idToken,
  newKey,
  ORIGIN,
} from "./auth-fixtures.mjs";

const ISSUER = "https://unit-tenant.example.test/";
const KEY = newKey("unit-kid");
const OTHER_KEY = newKey("unit-kid");
const SUB = "github|synthetic-unit";
const NONCE = "synthetic-nonce-value-0123456789abcdef";
const world = { issuer: ISSUER, key: KEY };

const config = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  canonicalOrigin: ORIGIN,
  redirectUri: `${ORIGIN}/auth/callback`,
  provider: `auth0:${ISSUER}`,
  authorizeUrl: `${ISSUER}authorize`,
  tokenUrl: `${ISSUER}oauth/token`,
  jwksUrl: `${ISSUER}.well-known/jwks.json`,
};

const staticKeys = (key = KEY) => ({
  async keyFor(kid) {
    if (kid !== key.kid) throw new OidcError("key_unknown");
    return key.jwk;
  },
});

async function rejects(token, label, options = {}) {
  await assert.rejects(
    () =>
      verifyIdToken(
        token,
        options.config ?? config,
        options.nonce ?? NONCE,
        options.keys ?? staticKeys(),
        options.now ?? Date.now(),
      ),
    (error) => {
      assert.ok(error instanceof OidcError, String(error));
      if (label) assert.equal(error.label, label);
      return true;
    },
  );
}

const good = (overrides = {}) =>
  idToken(world, { sub: SUB, nonce: NONCE, ...overrides });

test("a correct ID token yields only the exact opaque subject", async () => {
  const verified = await verifyIdToken(good(), config, NONCE, staticKeys());
  assert.deepEqual(verified, { subject: SUB });
  const array = await verifyIdToken(
    good({ claims: { aud: [CLIENT_ID], azp: CLIENT_ID } }),
    config,
    NONCE,
    staticKeys(),
  );
  assert.equal(array.subject, SUB);
});

test("ID tokens are rejected for every signature, header and claim defect", async () => {
  const now = Math.floor(Date.now() / 1000);
  // Signed by a different key that reuses the trusted key ID.
  await rejects(good({ signWith: OTHER_KEY }), "verification_failed");
  await rejects(good({ header: { alg: "HS256" } }), "invalid_token_header");
  await rejects(good({ header: { alg: "none" } }), "invalid_token_header");
  await rejects(good({ header: { alg: "RS384" } }), "invalid_token_header");
  await rejects(good({ header: { kid: "" } }), "invalid_token_header");
  await rejects(
    good({ header: { jku: "https://evil.example/jwks.json" } }),
    "invalid_token_header",
  );
  await rejects(
    good({ header: { x5u: "https://evil.example/cert.pem" } }),
    "invalid_token_header",
  );
  await rejects(good({ header: { jwk: KEY.jwk } }), "invalid_token_header");
  await rejects(good({ header: { kid: "other-kid" } }), "key_unknown");
  await rejects(
    good({ claims: { iss: "https://evil.example.test/" } }),
    "invalid_issuer_or_audience",
  );
  await rejects(
    good({ claims: { iss: ISSUER.slice(0, -1) } }),
    "invalid_issuer_or_audience",
  );
  await rejects(
    good({ claims: { aud: "another-client" } }),
    "invalid_issuer_or_audience",
  );
  await rejects(good({ remove: ["aud"] }), "invalid_issuer_or_audience");
  await rejects(
    good({ claims: { aud: [CLIENT_ID, "another-client"] } }),
    "invalid_authorized_party",
  );
  await rejects(
    good({ claims: { aud: [CLIENT_ID], azp: "another-client" } }),
    "invalid_authorized_party",
  );
  await rejects(
    good({ claims: { azp: "another-client" } }),
    "invalid_authorized_party",
  );
  await rejects(good({ nonce: "another-nonce" }), "invalid_nonce");
  await rejects(good({ remove: ["nonce"] }), "invalid_nonce");
  await rejects(good({ sub: "" }), "invalid_subject");
  await rejects(good({ sub: "   " }), "invalid_subject");
  await rejects(good({ sub: "github|bad\u0000subject" }), "invalid_subject");
  await rejects(good({ sub: "x".repeat(513) }), "invalid_subject");
  await rejects(good({ claims: { sub: 12345 } }), "invalid_subject");
  await rejects(good({ remove: ["sub"] }), "invalid_subject");
  await rejects(
    good({ claims: { exp: now - 3600, iat: now - 7200 } }),
    "verification_failed",
  );
  await rejects(good({ claims: { exp: now - 120 } }), "verification_failed");
  await rejects(good({ remove: ["exp"] }), "verification_failed");
  await rejects(good({ remove: ["iat"] }), "verification_failed");
  await rejects(
    good({ claims: { iat: now + 3600, exp: now + 7200 } }),
    "verification_failed",
  );
  await rejects(
    good({ claims: { iat: now - 7200, exp: now + 600 } }),
    "verification_failed",
  );
  await rejects(good({ claims: { nbf: now + 3600 } }), "verification_failed");
});

test("malformed or duplicated token JSON is rejected before verification", async () => {
  const duplicateClaim = `{"iss":"${ISSUER}","aud":"${CLIENT_ID}","sub":"github|attacker","sub":"${SUB}","nonce":"${NONCE}","iat":${Math.floor(Date.now() / 1000)},"exp":${Math.floor(Date.now() / 1000) + 600}}`;
  await rejects(good({ claimsJson: duplicateClaim }), "duplicate_json_member");
  const escapedDuplicate = duplicateClaim.replace(
    '"sub":"github|attacker"',
    '"\\u0073ub":"github|attacker"',
  );
  await rejects(
    good({ claimsJson: escapedDuplicate }),
    "duplicate_json_member",
  );
  await rejects(
    good({
      headerJson: `{"alg":"RS256","kid":"${KEY.kid}","kid":"${KEY.kid}"}`,
    }),
    "duplicate_json_member",
  );
  for (const token of [
    "",
    "not-a-token",
    "a.b",
    "a.b.c.d",
    "a..c",
    `${"a".repeat(20_000)}.b.c`,
    null,
    undefined,
    42,
    {},
  ])
    await rejects(token);
  const valid = good();
  const [header, claims, signature] = valid.split(".");
  await rejects(`${header}.${claims}.`);
  await rejects(`${header}.${claims}.${signature}.`);
  await rejects(`${header}.${claims}x.${signature}`);
  await rejects(`${header}.!!!.${signature}`);
  const notObject = compactJwt({
    headerJson: JSON.stringify({ alg: "RS256", kid: KEY.kid }),
    claimsJson: "[]",
    key: KEY,
  });
  await rejects(notObject, "invalid_token");
});

test("duplicate JSON members are found at any depth", () => {
  assert.deepEqual(
    parseJsonWithoutDuplicates('{"a":[{"b":1},{"b":2}],"c":{"d":1}}'),
    {
      a: [{ b: 1 }, { b: 2 }],
      c: { d: 1 },
    },
  );
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":{"b":1,"b":2}}',
    '[{"a":1,"a":2}]',
    '{"a":1,"\\u0061":2}',
    '{"a":1} trailing',
    '{"a":1,}',
    "{",
    "",
    `${"[".repeat(20)}${"]".repeat(20)}`,
  ])
    assert.throws(() => parseJsonWithoutDuplicates(text), OidcError, text);
});

test("a token cannot name the endpoint that supplies its key", async () => {
  const requests = [];
  const provider = createSigningKeyProvider({
    url: config.jwksUrl,
    fetch: async (url) => {
      requests.push(url);
      return Response.json({ keys: [KEY.jwk] });
    },
  });
  const token = good({ header: { jku: "https://evil.example/keys.json" } });
  await rejects(token, "invalid_token_header", { keys: provider });
  assert.deepEqual(requests, []);
});

test("return paths are same-origin relative paths only", () => {
  for (const accepted of [
    "/",
    "/admin/accounts",
    "/counties/08001?x=1",
    "/a%20b",
  ])
    assert.equal(validReturnPath(accepted), accepted, accepted);
  for (const rejected of [
    "",
    "admin",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "/%5Cevil.example",
    "/%2F%2Fevil.example/x",
    "https://evil.example/",
    "javascript:alert(1)",
    "/a#fragment",
    "/auth/login",
    "/auth",
    "/auth/logout",
    "/a b",
    "/a\nb",
    "/\u0000",
    `/${"a".repeat(200)}`,
    "/%E0%A4%A",
  ])
    assert.equal(validReturnPath(rejected), null, JSON.stringify(rejected));
});

const validSettings = {
  AUTH0_ENABLED: "true",
  AUTH0_ISSUER: ISSUER,
  AUTH0_CLIENT_ID: CLIENT_ID,
  AUTH0_CLIENT_SECRET: CLIENT_SECRET,
  AUTH0_CANONICAL_ORIGIN: ORIGIN,
  AUTH0_REDIRECT_URI: `${ORIGIN}/auth/callback`,
};

test("sign-in is off unless every setting is exactly valid", () => {
  assert.deepEqual(readHumanSignIn({}), { status: "disabled" });
  for (const enabled of ["false", "TRUE", "1", "yes", "", undefined])
    assert.deepEqual(
      readHumanSignIn({ ...validSettings, AUTH0_ENABLED: enabled }),
      { status: "disabled" },
    );
  const enabled = readHumanSignIn(validSettings);
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.config.provider, `auth0:${ISSUER}`);
  // Endpoints always derive from the validated issuer.
  assert.equal(enabled.config.authorizeUrl, `${ISSUER}authorize`);
  assert.equal(enabled.config.tokenUrl, `${ISSUER}oauth/token`);
  assert.equal(enabled.config.jwksUrl, `${ISSUER}.well-known/jwks.json`);
  const invalid = (changes) =>
    assert.deepEqual(
      readHumanSignIn({ ...validSettings, ...changes }),
      { status: "invalid" },
      JSON.stringify(changes),
    );
  invalid({ AUTH0_ISSUER: undefined });
  invalid({ AUTH0_ISSUER: "http://unit-tenant.example.test/" });
  invalid({ AUTH0_ISSUER: "https://unit-tenant.example.test" });
  invalid({ AUTH0_ISSUER: "https://unit-tenant.example.test/path/" });
  invalid({ AUTH0_ISSUER: "https://unit-tenant.example.test/?x=1" });
  invalid({ AUTH0_ISSUER: "https://unit-tenant.example.test/#x" });
  invalid({ AUTH0_ISSUER: "https://user:pass@unit-tenant.example.test/" });
  invalid({ AUTH0_ISSUER: "https://unit-tenant.example.test:8443/" });
  invalid({ AUTH0_ISSUER: "https://UNIT-TENANT.example.test/" });
  invalid({ AUTH0_ISSUER: "https://127.0.0.1/" });
  invalid({ AUTH0_ISSUER: "https://localhost/" });
  invalid({ AUTH0_ISSUER: "https://tenant/" });
  invalid({ AUTH0_CLIENT_ID: undefined });
  invalid({ AUTH0_CLIENT_ID: "short" });
  invalid({ AUTH0_CLIENT_ID: "has space in client id" });
  invalid({ AUTH0_CLIENT_SECRET: undefined });
  invalid({ AUTH0_CLIENT_SECRET: "tooshort" });
  invalid({ AUTH0_CLIENT_SECRET: `${"a".repeat(20)}\n` });
  invalid({ AUTH0_CANONICAL_ORIGIN: undefined });
  invalid({ AUTH0_CANONICAL_ORIGIN: `${ORIGIN}/` });
  invalid({ AUTH0_CANONICAL_ORIGIN: `${ORIGIN}/path` });
  invalid({ AUTH0_CANONICAL_ORIGIN: "http://watchdog.example.test" });
  invalid({ AUTH0_CANONICAL_ORIGIN: "http://127.0.0.1:8787" });
  invalid({ AUTH0_REDIRECT_URI: undefined });
  invalid({ AUTH0_REDIRECT_URI: `${ORIGIN}/auth/callback/` });
  invalid({ AUTH0_REDIRECT_URI: `${ORIGIN}/auth/callback?x=1` });
  invalid({ AUTH0_REDIRECT_URI: "https://other.example.test/auth/callback" });
  // Only the disposable test Worker may use loopback HTTP or a test upstream.
  // Elsewhere the override is ignored and the issuer's own endpoints are used.
  assert.equal(
    readHumanSignIn({
      ...validSettings,
      AUTH0_TEST_UPSTREAM: "http://127.0.0.1:9",
    }).config.tokenUrl,
    `${ISSUER}oauth/token`,
  );
  assert.equal(
    readHumanSignIn({
      ...validSettings,
      APP_ENV: "test",
      AUTH0_CANONICAL_ORIGIN: "http://127.0.0.1:8787",
      AUTH0_REDIRECT_URI: "http://127.0.0.1:8787/auth/callback",
      AUTH0_TEST_UPSTREAM: "http://127.0.0.1:9",
    }).status,
    "enabled",
  );
  assert.equal(
    readHumanSignIn({
      ...validSettings,
      APP_ENV: "test",
      AUTH0_TEST_UPSTREAM: "http://evil.example.test:9",
    }).status,
    "invalid",
  );
});

function fakeClock(start = 1_000_000) {
  const clock = { time: start, now: () => clock.time };
  return clock;
}

test("signing keys are cached, refreshed once on a miss, and never reused when stale", async () => {
  const clock = fakeClock();
  const rotated = newKey("rotated-kid");
  let served = [KEY.jwk];
  let failure = null;
  let requests = 0;
  const provider = createSigningKeyProvider({
    url: config.jwksUrl,
    now: clock.now,
    fetch: async () => {
      requests += 1;
      if (failure) return failure();
      return Response.json({ keys: served });
    },
  });
  assert.equal((await provider.keyFor(KEY.kid)).kid, KEY.kid);
  assert.equal((await provider.keyFor(KEY.kid)).kid, KEY.kid);
  assert.equal(requests, 1);

  // A new key appears. A miss inside the cooldown does not trigger a fetch.
  served = [KEY.jwk, rotated.jwk];
  clock.time += 1_000;
  await assert.rejects(() => provider.keyFor(rotated.kid), {
    label: "key_unknown",
  });
  assert.equal(requests, 1);
  // After the cooldown one miss refreshes, and the new key works.
  clock.time += 30_000;
  assert.equal((await provider.keyFor(rotated.kid)).kid, rotated.kid);
  assert.equal(requests, 2);
  // Unknown IDs cannot force a refresh flood.
  for (let attempt = 0; attempt < 5; attempt += 1)
    await assert.rejects(() => provider.keyFor("never-published"), {
      label: "key_unknown",
    });
  assert.equal(requests, 2);
  clock.time += 31_000;
  for (let attempt = 0; attempt < 5; attempt += 1)
    await assert.rejects(() => provider.keyFor("never-published"), {
      label: "key_unknown",
    });
  assert.equal(requests, 3);

  // A key removed upstream stops working after the next refresh.
  served = [rotated.jwk];
  clock.time += 6 * 60_000;
  await assert.rejects(() => provider.keyFor(KEY.kid), {
    label: "key_unknown",
  });
  assert.equal((await provider.keyFor(rotated.kid)).kid, rotated.kid);

  // Outage: an expired cache is not served.
  failure = () => new Response("down", { status: 503 });
  clock.time += 6 * 60_000;
  await assert.rejects(() => provider.keyFor(rotated.kid), {
    label: "keys_request_rejected",
    upstreamStatus: 503,
  });
  // And retries inside the cooldown do not hammer the endpoint.
  const before = requests;
  await assert.rejects(() => provider.keyFor(rotated.kid), {
    label: "keys_unavailable",
  });
  assert.equal(requests, before);
  // Recovery.
  failure = null;
  clock.time += 31_000;
  assert.equal((await provider.keyFor(rotated.kid)).kid, rotated.kid);
});

test("concurrent key lookups coalesce into one request", async () => {
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = createSigningKeyProvider({
    url: config.jwksUrl,
    fetch: async () => {
      requests += 1;
      await gate;
      return Response.json({ keys: [KEY.jwk] });
    },
  });
  const lookups = Array.from({ length: 8 }, () => provider.keyFor(KEY.kid));
  release();
  const keys = await Promise.all(lookups);
  assert.equal(requests, 1);
  assert.ok(keys.every((key) => key.kid === KEY.kid));
});

test("untrusted key documents are rejected", async () => {
  const attempt = async (response) => {
    const provider = createSigningKeyProvider({
      url: config.jwksUrl,
      fetch: async () => response(),
    });
    return provider.keyFor(KEY.kid);
  };
  await assert.rejects(
    () =>
      attempt(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/keys" },
          }),
      ),
    { label: "keys_request_redirect", upstreamStatus: 302 },
  );
  await assert.rejects(
    () => attempt(() => new Response("{}", { status: 404 })),
    { label: "keys_request_rejected", upstreamStatus: 404 },
  );
  await assert.rejects(() => attempt(() => new Response("not json")), {
    label: "keys_invalid",
  });
  await assert.rejects(() => attempt(() => Response.json({ keys: [] })), {
    label: "keys_invalid",
  });
  await assert.rejects(() => attempt(() => Response.json({ keys: "x" })), {
    label: "keys_invalid",
  });
  await assert.rejects(
    () => attempt(() => new Response(`{"keys":[],"keys":[]}`)),
    { label: "keys_invalid" },
  );
  await assert.rejects(() => attempt(() => new Response("x".repeat(70_000))), {
    label: "response_too_large",
  });
  await assert.rejects(
    () =>
      attempt(() =>
        Response.json({
          keys: Array.from({ length: 21 }, (_, index) => ({
            ...KEY.jwk,
            kid: `k${index}`,
          })),
        }),
      ),
    { label: "keys_invalid" },
  );
  // Non-RSA, wrong-algorithm and encryption keys are never usable.
  await assert.rejects(
    () =>
      attempt(() =>
        Response.json({
          keys: [
            { ...KEY.jwk, kty: "oct" },
            { ...KEY.jwk, use: "enc" },
            { ...KEY.jwk, alg: "RS384" },
          ],
        }),
      ),
    { label: "keys_invalid" },
  );
  // A repeated key ID is ambiguous and never trusted.
  await assert.rejects(
    () => attempt(() => Response.json({ keys: [KEY.jwk, OTHER_KEY.jwk] })),
    { label: "key_unknown" },
  );
});

test("the code exchange refuses redirects, bounds time and size, and sends PKCE material", async () => {
  const seen = [];
  const ok = (body) => async (url, init) => {
    seen.push({ url, init });
    return Response.json(body);
  };
  const token = await exchangeAuthorizationCode(
    config,
    "code-1",
    "verifier-value",
    {
      fetch: ok({ id_token: "header.claims.signature" }),
    },
  );
  assert.equal(token, "header.claims.signature");
  assert.equal(seen[0].url, `${ISSUER}oauth/token`);
  assert.equal(seen[0].init.redirect, "manual");
  assert.equal(seen[0].init.method, "POST");
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: "code-1",
    redirect_uri: `${ORIGIN}/auth/callback`,
    code_verifier: "verifier-value",
  });

  const run = (fetchFunction, timeoutMs) =>
    exchangeAuthorizationCode(config, "code", "verifier", {
      fetch: fetchFunction,
      timeoutMs,
    });
  await assert.rejects(
    () =>
      run(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/" },
          }),
      ),
    { label: "token_request_redirect", upstreamStatus: 302 },
  );
  await assert.rejects(
    () =>
      run(async () =>
        Response.json({ error: "invalid_grant" }, { status: 403 }),
      ),
    { label: "token_request_rejected", upstreamStatus: 403 },
  );
  await assert.rejects(() => run(async () => new Response("<html>")), {
    label: "token_response_unparseable",
  });
  await assert.rejects(
    () => run(async () => Response.json({ access_token: "x" })),
    { label: "token_response_missing_id_token" },
  );
  await assert.rejects(() => run(async () => Response.json({ id_token: 7 })), {
    label: "token_response_missing_id_token",
  });
  await assert.rejects(
    () => run(async () => new Response(`{"id_token":"a","id_token":"b"}`)),
    { label: "token_response_unparseable" },
  );
  await assert.rejects(
    () => run(async () => new Response("x".repeat(70_000))),
    { label: "response_too_large" },
  );
  await assert.rejects(
    () =>
      run(async () => {
        throw new TypeError("network down");
      }),
    { label: "token_request" },
  );
  // A silent upstream is cut off by the request timeout.
  const started = Date.now();
  await assert.rejects(
    () =>
      run(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
        25,
      ),
    { label: "token_request" },
  );
  assert.ok(Date.now() - started < 2_000);
});

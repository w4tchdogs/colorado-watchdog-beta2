import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import worker from "../dist/server/index.js";
import { hashCredential } from "../dist/services/security.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  cookieJar,
  count,
  createWorld,
  idToken,
  installUpstream,
  LOGIN_COOKIE,
  newKey,
  ORIGIN,
  parseSetCookie,
  request,
  SESSION_COOKIE,
  sha256Hex,
  snapshotCounts,
} from "./auth-fixtures.mjs";

const SUBJECTS = {
  owner: "github|synthetic-owner",
  admin: "github|synthetic-admin",
  editor: "github|synthetic-editor",
  contributor: "github|synthetic-contributor",
  unlinked: "github|synthetic-never-linked",
  disabled: "github|synthetic-disabled",
  expired: "github|synthetic-expired",
  revoked: "github|synthetic-revoked",
  agentKind: "github|synthetic-agent-kind",
};

let codeCounter = 0;

function send(world, path, options = {}) {
  const { jar, headers = {}, ...rest } = options;
  const cookie = jar?.header();
  return worker.fetch(
    request(world, path, {
      ...rest,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    }),
    options.env ?? world.env,
  );
}

async function start(world, jar, path = "/auth/login") {
  const response = await send(world, path, { jar });
  jar.absorb(response);
  return response;
}

function authorizeUrl(response) {
  return new URL(response.headers.get("location"));
}

/** Runs login and callback for `subject` and returns every step. */
async function signIn(world, jar, subject, options = {}) {
  const login = await start(world, jar, options.loginPath);
  assert.equal(login.status, 302, await login.clone().text());
  const authorize = authorizeUrl(login);
  const state = authorize.searchParams.get("state");
  const nonce = authorize.searchParams.get("nonce");
  codeCounter += 1;
  const code = `synthetic-code-${codeCounter}`;
  world.codes.set(code, {
    idToken: () => idToken(world, { sub: subject, nonce, ...options.token }),
  });
  const query = options.query ?? `code=${code}&state=${state}`;
  const callback = await send(world, `/auth/callback?${query}`, {
    jar: options.callbackJar ?? jar,
    headers: options.callbackHeaders,
  });
  if (!options.keepCookies) jar.absorb(callback);
  return { login, authorize, state, nonce, code, callback };
}

async function signedIn(world, subject, options = {}) {
  const jar = cookieJar();
  const flow = await signIn(world, jar, subject, options);
  assert.equal(flow.callback.status, 302, await flow.callback.clone().text());
  assert.ok(jar.cookies.has(SESSION_COOKIE));
  return { jar, ...flow };
}

async function withWorld(callback, options = {}) {
  const world = await createWorld(options);
  const restore = installUpstream(world);
  try {
    await callback(world);
  } finally {
    restore();
    world.database.close();
  }
}

async function agentKey(world, role = "editor") {
  const secret = `cwa_${"A".repeat(43)}`;
  world.database.exec(`
    INSERT INTO accounts (id, kind, role, display_name) VALUES ('h-agent', 'agent', '${role}', 'Synthetic Agent');
    INSERT INTO identities (id, account_id, provider, subject, credential_hash)
      VALUES ('i-agent', 'h-agent', 'agent-key', 'i-agent', '${await hashCredential(secret)}');
  `);
  return secret;
}

const principal = async (world, jar, headers = {}) => {
  const response = await send(world, "/_internal/principal", { jar, headers });
  return { status: response.status, body: await response.json() };
};

const noStore = (response) =>
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

test("sign-in is disabled by default and nothing reaches the provider", async () => {
  await withWorld(async (world) => {
    for (const env of [
      { DB: world.d1 },
      { ...world.env, AUTH0_ENABLED: "false" },
      { ...world.env, AUTH0_ENABLED: undefined },
      { ...world.env, AUTH0_CLIENT_SECRET: undefined },
    ]) {
      for (const path of ["/auth/login", "/auth/callback?code=x&state=y"]) {
        const response = await send(world, path, { env });
        assert.equal(response.status, 503, path);
        noStore(response);
        assert.equal(response.headers.get("location"), null);
      }
    }
    assert.deepEqual(world.upstreamLog, []);
    assert.equal(count(world, "auth_login_transactions"), 0);
    const home = await send(world, "/", { env: { DB: world.d1 } });
    assert.equal(home.status, 200);
    assert.equal(
      (await send(world, "/_internal/principal", { env: { DB: world.d1 } }))
        .status,
      401,
    );
  });
});

test("login sends an authorization-code request with openid scope, S256 PKCE and a bound state cookie", async () => {
  await withWorld(async (world) => {
    const jar = cookieJar();
    const response = await start(
      world,
      jar,
      "/auth/login?return_to=/admin/accounts",
    );
    assert.equal(response.status, 302);
    noStore(response);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const url = authorizeUrl(response);
    assert.equal(`${url.origin}${url.pathname}`, `${world.issuer}authorize`);
    const params = Object.fromEntries(url.searchParams);
    assert.deepEqual(Object.keys(params).sort(), [
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "nonce",
      "prompt",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
    assert.equal(params.response_type, "code");
    assert.equal(params.scope, "openid");
    assert.equal(params.client_id, CLIENT_ID);
    assert.equal(params.redirect_uri, `${ORIGIN}/auth/callback`);
    assert.equal(params.code_challenge_method, "S256");
    assert.equal(params.prompt, "login");
    assert.equal(url.searchParams.getAll("scope").length, 1);

    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    const login = parseSetCookie(cookies[0]);
    assert.equal(login.name, LOGIN_COOKIE);
    assert.deepEqual(login.attributes.sort(), [
      "httponly",
      "max-age=300",
      "path=/",
      "samesite=lax",
      "secure",
    ]);
    const row = world.database
      .prepare("SELECT * FROM auth_login_transactions")
      .get();
    // Only hashes of the handles are stored, never the handles themselves.
    assert.equal(row.state_hash, sha256Hex(params.state));
    assert.equal(row.browser_hash, sha256Hex(login.value));
    assert.equal(row.nonce, params.nonce);
    assert.equal(row.return_path, "/admin/accounts");
    assert.equal(
      createHash("sha256").update(row.code_verifier).digest("base64url"),
      params.code_challenge,
    );
    const rowText = JSON.stringify(row);
    assert.ok(
      !rowText.includes(params.state) && !rowText.includes(login.value),
    );
    // Five minutes, bound to one browser, single use.
    const lifetime = Date.parse(row.expires_at) - Date.parse(row.created_at);
    assert.equal(lifetime, 5 * 60_000);
    assert.equal(row.consumed_at, null);
  });
});

test("login rejects unsafe destinations, other methods and the wrong host", async () => {
  await withWorld(async (world) => {
    for (const bad of [
      "//evil.example",
      "https://evil.example/",
      "/\\evil.example",
      "/auth/login",
      "javascript:alert(1)",
      "/a#b",
    ]) {
      const response = await send(
        world,
        `/auth/login?return_to=${encodeURIComponent(bad)}`,
      );
      assert.equal(response.status, 400, bad);
      assert.equal(response.headers.get("location"), null);
    }
    const duplicate = await send(
      world,
      "/auth/login?return_to=/a&return_to=/b",
    );
    assert.equal(duplicate.status, 400);
    assert.equal(count(world, "auth_login_transactions"), 0);
    const post = await send(world, "/auth/login", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    const wrongHost = await send(world, "/auth/login", {
      origin: "https://alternate.example.test",
    });
    assert.equal(wrongHost.status, 404);
    assert.equal(wrongHost.headers.getSetCookie().length, 0);
    const wrongScheme = await send(world, "/auth/login", {
      origin: "http://watchdog.example.test",
    });
    assert.equal(wrongScheme.status, 404);
    assert.equal((await send(world, "/auth/unknown")).status, 404);
  });
});

test("a linked human signs in, gets a hardened session cookie, and resolves live capabilities", async () => {
  await withWorld(async (world) => {
    const flow = await signedIn(world, SUBJECTS.editor);
    const { jar, callback } = flow;
    noStore(callback);
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    assert.equal(callback.headers.get("location"), "/");
    const cookies = callback.headers.getSetCookie().map(parseSetCookie);
    assert.equal(cookies.length, 2);
    const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    assert.deepEqual(session.attributes.sort(), [
      "httponly",
      "max-age=28800",
      "path=/",
      "samesite=lax",
      "secure",
    ]);
    assert.ok(
      !session.attributes.some((attribute) => attribute.startsWith("domain")),
    );
    const cleared = cookies.find((cookie) => cookie.name === LOGIN_COOKIE);
    assert.equal(cleared.value, "");
    assert.ok(cleared.attributes.includes("max-age=0"));

    // Provider request: derived endpoint, manual redirect handling, PKCE.
    const tokenRequest = world.upstreamLog.find(
      (entry) => entry.url === `${world.issuer}oauth/token`,
    );
    assert.equal(tokenRequest.redirect, "manual");
    assert.equal(tokenRequest.hasSignal, true);
    const body = JSON.parse(tokenRequest.body);
    assert.equal(body.client_secret, CLIENT_SECRET);
    assert.equal(body.redirect_uri, `${ORIGIN}/auth/callback`);
    assert.equal(
      createHash("sha256").update(body.code_verifier).digest("base64url"),
      flow.authorize.searchParams.get("code_challenge"),
    );
    const keyRequest = world.upstreamLog.find((entry) =>
      entry.url.endsWith("/.well-known/jwks.json"),
    );
    assert.equal(keyRequest.redirect, "manual");
    assert.equal(keyRequest.url, `${world.issuer}.well-known/jwks.json`);

    // Only a hash of the session handle is stored, bound to the linked identity.
    const row = world.database.prepare("SELECT * FROM auth_sessions").get();
    assert.equal(row.token_hash, sha256Hex(session.value));
    assert.equal(row.account_id, "h-editor");
    assert.equal(row.identity_id, "i-editor");
    assert.equal(row.provider, world.provider);
    assert.equal(row.subject, SUBJECTS.editor);
    assert.ok(!JSON.stringify(row).includes(session.value));
    assert.equal(
      Date.parse(row.absolute_expires_at) - Date.parse(row.created_at),
      8 * 3600_000,
    );
    assert.equal(
      Date.parse(row.idle_expires_at) - Date.parse(row.created_at),
      30 * 60_000,
    );
    assert.equal(
      count(world, "auth_login_transactions", "consumed_at IS NOT NULL"),
      1,
    );

    // The Worker derives the principal and capabilities from live D1 rows.
    const who = await principal(world, jar);
    assert.deepEqual(who, {
      status: 200,
      body: { accountId: "h-editor", kind: "human", role: "editor" },
    });
    const me = await send(world, "/api/me", { jar });
    assert.equal(me.status, 200);
    noStore(me);
    assert.equal((await me.json()).displayName, "Synthetic <Editor> & Co");
    assert.equal((await send(world, "/admin/reports", { jar })).status, 200);
    assert.equal(
      (await send(world, "/api/admin/accounts", { jar })).status,
      403,
    );
    // No cookie, no access.
    assert.equal((await send(world, "/admin/reports")).status, 401);
  });
});

test("each existing role keeps exactly its own capabilities through the session", async () => {
  await withWorld(async (world) => {
    const owner = await signedIn(world, SUBJECTS.owner);
    const admin = await signedIn(world, SUBJECTS.admin);
    const contributor = await signedIn(world, SUBJECTS.contributor);
    assert.equal(
      (await send(world, "/api/admin/accounts", { jar: owner.jar })).status,
      200,
    );
    assert.equal(
      (await send(world, "/api/admin/accounts", { jar: admin.jar })).status,
      200,
    );
    assert.equal(
      (await send(world, "/api/admin/accounts", { jar: contributor.jar }))
        .status,
      403,
    );
    assert.equal(
      (await send(world, "/admin/reports", { jar: contributor.jar })).status,
      403,
    );
    assert.equal(
      (await principal(world, contributor.jar)).body.role,
      "contributor",
    );
    // Caller-supplied identity headers never grant or change access.
    const forged = {
      "oai-authenticated-user-id": SUBJECTS.owner,
      "oai-authenticated-user-email": "owner@example.test",
      "x-test-human-subject": "owner",
      "x-forwarded-user": SUBJECTS.owner,
    };
    assert.equal((await principal(world, undefined, forged)).status, 401);
    assert.equal(
      (await principal(world, contributor.jar, forged)).body.role,
      "contributor",
    );
  });
});

test("an unlinked, revoked, expired, disabled or wrong-kind identity gets 403 and creates nothing", async () => {
  await withWorld(async (world) => {
    const before = snapshotCounts(world);
    for (const subject of [
      SUBJECTS.unlinked,
      SUBJECTS.disabled,
      SUBJECTS.expired,
      SUBJECTS.revoked,
      SUBJECTS.agentKind,
      "",
    ]) {
      const jar = cookieJar();
      if (subject === "") continue;
      const flow = await signIn(world, jar, subject);
      assert.equal(flow.callback.status, 403, subject);
      noStore(flow.callback);
      assert.equal(
        flow.callback.headers
          .get("set-cookie")
          ?.includes(`${SESSION_COOKIE}=`) ?? false,
        false,
      );
      assert.ok(!jar.cookies.has(SESSION_COOKIE));
      assert.equal((await principal(world, jar)).status, 401);
    }
    assert.deepEqual(snapshotCounts(world), before);
    assert.equal(count(world, "auth_sessions"), 0);
    // A subject from another tenant is a different identity entirely.
    const other = cookieJar();
    const flow = await signIn(world, other, "github|synthetic-editor", {
      token: { claims: { iss: "https://other-tenant.example.test/" } },
    });
    assert.equal(flow.callback.status, 400);
    assert.equal(count(world, "auth_sessions"), 0);
  });
});

test("callback parameters must be present, single and consistent", async () => {
  await withWorld(async (world) => {
    const tokenRequests = () =>
      world.upstreamLog.filter((entry) => entry.url.endsWith("/oauth/token"))
        .length;
    const jar = cookieJar();
    const login = await start(world, jar);
    const state = authorizeUrl(login).searchParams.get("state");
    const cases = [
      "",
      `code=c1`,
      `state=${state}`,
      `code=c1&code=c2&state=${state}`,
      `code=c1&state=${state}&state=${state}`,
      `code=c1&state=${state}&error=access_denied`,
      `code=c1&state=${state}&extra=1`,
      `code=&state=${state}`,
      `code=c1&state=short`,
      `code=c1&state=${state}&iss=https%3A%2F%2Fevil.example.test%2F`,
      `code=${"c".repeat(3000)}&state=${state}`,
    ];
    for (const query of cases) {
      const response = await send(world, `/auth/callback?${query}`, { jar });
      assert.equal(response.status, 400, query.slice(0, 60));
      noStore(response);
      assert.equal(
        response.headers
          .getSetCookie()
          .some((c) => c.startsWith(`${SESSION_COOKIE}=`)),
        false,
      );
    }
    assert.equal(tokenRequests(), 0);
    // Rejected shapes do not consume the transaction.
    assert.equal(
      count(world, "auth_login_transactions", "consumed_at IS NOT NULL"),
      0,
    );

    // Browser binding: no cookie, a duplicate cookie or another browser's cookie.
    const other = cookieJar();
    await start(world, other);
    const mismatched = await send(
      world,
      `/auth/callback?code=c1&state=${state}`,
      { jar: other },
    );
    assert.equal(mismatched.status, 400);
    const none = await send(world, `/auth/callback?code=c1&state=${state}`);
    assert.equal(none.status, 400);
    const duplicate = await send(
      world,
      `/auth/callback?code=c1&state=${state}`,
      {
        headers: {
          cookie: `${LOGIN_COOKIE}=${jar.cookies.get(LOGIN_COOKIE)}; ${LOGIN_COOKIE}=${other.cookies.get(LOGIN_COOKIE)}`,
        },
      },
    );
    assert.equal(duplicate.status, 400);
    assert.equal(tokenRequests(), 0);
    assert.equal(
      count(world, "auth_login_transactions", "consumed_at IS NOT NULL"),
      0,
    );

    // Provider error: the transaction is consumed and cannot be replayed.
    const denied = await send(
      world,
      `/auth/callback?error=access_denied&error_description=no&state=${state}`,
      { jar },
    );
    assert.equal(denied.status, 400);
    assert.equal(tokenRequests(), 0);
    assert.equal(
      count(world, "auth_login_transactions", "consumed_at IS NOT NULL"),
      1,
    );
    const replay = await send(world, `/auth/callback?code=c1&state=${state}`, {
      jar,
    });
    assert.equal(replay.status, 400);
    assert.equal(tokenRequests(), 0);
    // Wrong method and wrong host.
    assert.equal(
      (
        await send(world, `/auth/callback?code=c&state=${state}`, {
          method: "POST",
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await send(world, `/auth/callback?code=c&state=${state}`, {
          origin: "https://alternate.example.test",
          jar,
        })
      ).status,
      404,
    );
  });
});

test("a callback can be used once, even when claimed concurrently", async () => {
  await withWorld(async (world) => {
    const jar = cookieJar();
    const login = await start(world, jar);
    const authorize = authorizeUrl(login);
    const state = authorize.searchParams.get("state");
    const nonce = authorize.searchParams.get("nonce");
    world.codes.set("shared-code", {
      idToken: () => idToken(world, { sub: SUBJECTS.editor, nonce }),
    });
    const claim = () =>
      send(world, `/auth/callback?code=shared-code&state=${state}`, { jar });
    const results = await Promise.all(Array.from({ length: 6 }, claim));
    const statuses = results.map((response) => response.status).sort();
    assert.deepEqual(statuses, [302, 400, 400, 400, 400, 400]);
    assert.equal(count(world, "auth_sessions"), 1);
    assert.equal(
      world.upstreamLog.filter((entry) => entry.url.endsWith("/oauth/token"))
        .length,
      1,
    );
    const later = await claim();
    assert.equal(later.status, 400);
    assert.equal(count(world, "auth_sessions"), 1);
  });
});

test("invalid tokens and provider failures never create a session", async () => {
  await withWorld(async (world) => {
    const attacker = newKey("attacker-kid");
    const cases = {
      "wrong signature": { token: { signWith: attacker } },
      "unknown key": { token: { key: attacker } },
      "wrong issuer": {
        token: { claims: { iss: "https://evil.example.test/" } },
      },
      "wrong audience": { token: { claims: { aud: "other-client" } } },
      "wrong nonce": { token: { nonce: "another-nonce" } },
      expired: { token: { claims: { exp: 1, iat: 0 } } },
      "empty subject": { token: { sub: "" } },
      "algorithm none": { token: { header: { alg: "none" } } },
      "key URL header": {
        token: { header: { jku: "https://evil.example/keys" } },
      },
      "duplicate subject": {
        token: {
          claimsJson: `{"iss":"${world.issuer}","aud":"${CLIENT_ID}","sub":"x","sub":"${SUBJECTS.owner}","nonce":"n","iat":${Math.floor(Date.now() / 1000)},"exp":${Math.floor(Date.now() / 1000) + 600}}`,
        },
      },
    };
    for (const [name, options] of Object.entries(cases)) {
      const jar = cookieJar();
      const flow = await signIn(world, jar, SUBJECTS.owner, options);
      assert.equal(flow.callback.status, 400, name);
      assert.ok(!jar.cookies.has(SESSION_COOKIE), name);
    }
    assert.equal(count(world, "auth_sessions"), 0);

    const failures = {
      "non-JSON token response": () => new Response("<html>nope</html>"),
      "token response without ID token": () =>
        Response.json({ access_token: "x" }),
      "provider 500": () => new Response("error", { status: 500 }),
      "provider 403": () =>
        Response.json({ error: "invalid_grant" }, { status: 403 }),
      "provider redirect": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/token" },
        }),
      "network failure": () => {
        throw new TypeError("network down");
      },
    };
    for (const [name, behavior] of Object.entries(failures)) {
      world.tokenBehavior = async () => behavior();
      const jar = cookieJar();
      const flow = await signIn(world, jar, SUBJECTS.owner);
      assert.equal(flow.callback.status, 400, name);
      assert.ok(!jar.cookies.has(SESSION_COOKIE), name);
    }
    world.tokenBehavior = null;
    assert.equal(count(world, "auth_sessions"), 0);
  });
});

test("signing-key outage, redirect and rotation fail closed", async () => {
  await withWorld(async (world) => {
    for (const behavior of [
      () => new Response("down", { status: 503 }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/jwks" },
        }),
      () => Response.json({ keys: [] }),
      () => new Response("not json"),
    ]) {
      world.jwksBehavior = behavior;
      const jar = cookieJar();
      const flow = await signIn(world, jar, SUBJECTS.owner);
      assert.equal(flow.callback.status, 400);
      assert.ok(!jar.cookies.has(SESSION_COOKIE));
    }
    assert.equal(count(world, "auth_sessions"), 0);
  });
  // Rotation: a token for a key the tenant has not published is denied, and a
  // token for a newly published key is accepted.
  await withWorld(async (world) => {
    const rotated = newKey("rotated-kid");
    const denied = await signIn(world, cookieJar(), SUBJECTS.owner, {
      token: { key: rotated },
    });
    assert.equal(denied.callback.status, 400);
    assert.equal(count(world, "auth_sessions"), 0);
  });
  await withWorld(async (world) => {
    const rotated = newKey("rotated-kid-2");
    world.keys = [world.key, rotated];
    const flow = await signedIn(world, SUBJECTS.owner, {
      token: { key: rotated },
    });
    assert.equal(flow.callback.status, 302);
  });
});

test("session cookies that are malformed, duplicated or on another origin do not authenticate", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.owner);
    const good = jar.cookies.get(SESSION_COOKIE);
    assert.equal((await principal(world, jar)).status, 200);
    const attempts = [
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=garbage`,
      `${SESSION_COOKIE}=${good}x`,
      `${SESSION_COOKIE}=${good.slice(1)}`,
      `${SESSION_COOKIE}=${good}; ${SESSION_COOKIE}=${good}`,
      `${SESSION_COOKIE}=${good}; ${SESSION_COOKIE}=another`,
      `${SESSION_COOKIE}=another; ${SESSION_COOKIE}=${good}`,
      `wd-session=${good}`,
      `__Secure-wd-session=${good}`,
      `${SESSION_COOKIE.toLowerCase()}=${good}`,
    ];
    for (const cookie of attempts) {
      const response = await send(world, "/_internal/principal", {
        headers: { cookie },
      });
      assert.equal(response.status, 401, cookie);
    }
    // Human sessions exist only on the canonical origin.
    for (const origin of [
      "https://alternate.example.test",
      "http://watchdog.example.test",
    ]) {
      const response = await send(world, "/_internal/principal", {
        jar,
        origin,
      });
      assert.equal(response.status, 401, origin);
    }
    // A handle for another browser's session is a different credential.
    const second = await signedIn(world, SUBJECTS.contributor);
    assert.equal((await principal(world, second.jar)).body.role, "contributor");
    assert.equal((await principal(world, jar)).body.role, "owner");
  });
});

test("expiry, revocation, account state and identity changes apply on the next request", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.editor);
    const reports = () => send(world, "/admin/reports", { jar });
    assert.equal((await reports()).status, 200);

    // Role change: demotion removes the capability, promotion adds it.
    world.database.exec(
      "UPDATE accounts SET role = 'contributor', version = version + 1 WHERE id = 'h-editor'",
    );
    assert.equal((await reports()).status, 403);
    assert.equal((await principal(world, jar)).body.role, "contributor");
    world.database.exec(
      "UPDATE accounts SET role = 'administrator', version = version + 1 WHERE id = 'h-editor'",
    );
    assert.equal(
      (await send(world, "/api/admin/accounts", { jar })).status,
      200,
    );
    world.database.exec(
      "UPDATE accounts SET role = 'editor', version = version + 1 WHERE id = 'h-editor'",
    );

    // Account disabled and re-enabled.
    world.database.exec(
      "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'h-editor'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      "UPDATE accounts SET status = 'active', version = version + 1 WHERE id = 'h-editor'",
    );
    assert.equal((await reports()).status, 200);

    // Account turned into an agent account.
    world.database.exec(
      "UPDATE accounts SET kind = 'agent', version = version + 1 WHERE id = 'h-editor'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      "UPDATE accounts SET kind = 'human', version = version + 1 WHERE id = 'h-editor'",
    );
    assert.equal((await reports()).status, 200);

    // Identity link expiry and revocation.
    world.database.exec(
      "UPDATE identities SET expires_at = '2000-01-01T00:00:00.000Z', version = version + 1 WHERE id = 'i-editor'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      "UPDATE identities SET expires_at = NULL, version = version + 1 WHERE id = 'i-editor'",
    );
    assert.equal((await reports()).status, 200);
    world.database.exec(
      "UPDATE identities SET revoked_at = '2026-11-14T00:00:00.000Z', version = version + 1 WHERE id = 'i-editor'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      "UPDATE identities SET revoked_at = NULL, version = version + 1 WHERE id = 'i-editor'",
    );

    // The link re-pointed at another subject or provider cannot be substituted.
    world.database.exec(
      "UPDATE identities SET subject = 'github|someone-else', version = version + 1 WHERE id = 'i-editor'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      "UPDATE identities SET subject = 'github|synthetic-editor-2', provider = 'auth0:https://other-tenant.example.test/', version = version + 1 WHERE id = 'i-editor'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      `UPDATE identities SET provider = '${world.provider}', subject = 'github|synthetic-editor', version = version + 1 WHERE id = 'i-editor'`,
    );
    assert.equal((await reports()).status, 200);

    // A session whose recorded link no longer matches its identity row.
    world.database.exec("UPDATE auth_sessions SET account_id = 'h-owner'");
    assert.equal((await reports()).status, 401);
    world.database.exec("UPDATE auth_sessions SET account_id = 'h-editor'");
    assert.equal((await reports()).status, 200);

    // Absolute and idle expiry.
    world.database.exec(
      "UPDATE auth_sessions SET idle_expires_at = '2000-01-01T00:00:00.000Z'",
    );
    assert.equal((await reports()).status, 401);
    world.database.exec(
      `UPDATE auth_sessions SET idle_expires_at = '${new Date(Date.now() + 600_000).toISOString()}', absolute_expires_at = '2000-01-01T00:00:00.000Z'`,
    );
    assert.equal((await reports()).status, 401);
    // An expired session does not come back by being extended.
    world.database.exec(
      `UPDATE auth_sessions SET absolute_expires_at = '${new Date(Date.now() + 3600_000).toISOString()}'`,
    );
    assert.equal((await reports()).status, 200);

    // Server-side revocation.
    world.database.exec(
      "UPDATE auth_sessions SET revoked_at = '2026-11-14T00:00:00.000Z'",
    );
    assert.equal((await reports()).status, 401);

    // A tenant change leaves earlier sessions unusable.
    world.database.exec("UPDATE auth_sessions SET revoked_at = NULL");
    assert.equal((await reports()).status, 200);
    const changed = {
      ...world.env,
      AUTH0_ISSUER: "https://replacement-tenant.example.test/",
    };
    assert.equal(
      (await send(world, "/admin/reports", { jar, env: changed })).status,
      401,
    );
  });
});

test("idle expiry is extended sparingly and never beyond the absolute limit", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.editor);
    const row = () =>
      world.database
        .prepare(
          "SELECT idle_expires_at, absolute_expires_at FROM auth_sessions",
        )
        .get();
    const initial = row().idle_expires_at;
    // A fresh session is not rewritten on every request.
    await principal(world, jar);
    assert.equal(row().idle_expires_at, initial);
    // Near idle expiry, a request extends it by the full idle window.
    const soon = new Date(Date.now() + 2 * 60_000).toISOString();
    world.database.exec(`UPDATE auth_sessions SET idle_expires_at = '${soon}'`);
    await principal(world, jar);
    const extended = Date.parse(row().idle_expires_at);
    assert.ok(Math.abs(extended - (Date.now() + 30 * 60_000)) < 10_000);
    // Never beyond the absolute limit.
    const absolute = new Date(Date.now() + 10 * 60_000).toISOString();
    world.database.exec(
      `UPDATE auth_sessions SET absolute_expires_at = '${absolute}', idle_expires_at = '${soon}'`,
    );
    await principal(world, jar);
    assert.equal(row().idle_expires_at, absolute);
  });
});

test("disabling sign-in denies existing sessions before any refresh, and sign-out still works", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.editor);
    const soon = new Date(Date.now() + 2 * 60_000).toISOString();
    world.database.exec(`UPDATE auth_sessions SET idle_expires_at = '${soon}'`);
    const row = () =>
      world.database
        .prepare("SELECT idle_expires_at, revoked_at FROM auth_sessions")
        .get();
    for (const disabled of [
      { ...world.env, AUTH0_ENABLED: "false" },
      { ...world.env, AUTH0_ENABLED: undefined },
      { DB: world.d1 },
      { ...world.env, AUTH0_CLIENT_SECRET: undefined },
    ]) {
      const response = await send(world, "/_internal/principal", {
        jar,
        env: disabled,
      });
      assert.equal(response.status, 401);
      const reports = await send(world, "/admin/reports", {
        jar,
        env: disabled,
      });
      assert.equal(reports.status, 401);
      // No idle refresh happened while disabled.
      assert.equal(row().idle_expires_at, soon);
    }
    // The browser can still reach a sign-out control and use it.
    const disabled = { ...world.env, AUTH0_ENABLED: "false" };
    const page = await send(world, "/auth/account", { jar, env: disabled });
    assert.equal(page.status, 401);
    const html = await page.text();
    assert.match(html, /<form method="post" action="\/auth\/logout">/);
    assert.doesNotMatch(html, /\/auth\/login/);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    // Without a session cookie there is nothing to sign out of.
    const bare = await send(world, "/auth/account", { env: disabled });
    assert.doesNotMatch(await bare.text(), /<form/);

    const out = await send(world, "/auth/logout", {
      method: "POST",
      jar,
      env: disabled,
      headers: { origin: ORIGIN },
    });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/");
    assert.ok(row().revoked_at);
    const cleared = out.headers.getSetCookie().map(parseSetCookie);
    assert.equal(cleared[0].name, SESSION_COOKIE);
    assert.equal(cleared[0].value, "");
    assert.ok(cleared[0].attributes.includes("max-age=0"));
    // Re-enabling does not resurrect a revoked session.
    assert.equal((await principal(world, jar)).status, 401);
  });
  // A session that was not signed out resumes on re-enable until it expires.
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.editor);
    const off = { ...world.env, AUTH0_ENABLED: "false" };
    assert.equal(
      (await send(world, "/_internal/principal", { jar, env: off })).status,
      401,
    );
    assert.equal((await principal(world, jar)).status, 200);
  });
});

test("sign-out needs the exact origin, a POST and leaves other sessions alone", async () => {
  await withWorld(async (world) => {
    const first = await signedIn(world, SUBJECTS.editor);
    const second = await signedIn(world, SUBJECTS.editor);
    const attempt = (headers, method = "POST") =>
      send(world, "/auth/logout", { method, jar: first.jar, headers });
    for (const headers of [
      {},
      { origin: "null" },
      { origin: "https://evil.example" },
      { origin: `${ORIGIN}.evil.example` },
      { origin: "http://watchdog.example.test" },
      { origin: `${ORIGIN}/` },
      { origin: `${ORIGIN}:8443` },
    ]) {
      const response = await attempt(headers);
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.headers.getSetCookie().length, 0);
    }
    assert.equal((await principal(world, first.jar)).status, 200);
    const get = await attempt({ origin: ORIGIN }, "GET");
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
    assert.equal((await principal(world, first.jar)).status, 200);

    const out = await attempt({ origin: ORIGIN });
    assert.equal(out.status, 303);
    noStore(out);
    assert.equal(out.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await principal(world, first.jar)).status, 401);
    assert.equal((await principal(world, second.jar)).status, 200);
    // Repeating is harmless, and works without any cookie.
    assert.equal((await attempt({ origin: ORIGIN })).status, 303);
    const bare = await send(world, "/auth/logout", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    assert.equal(bare.status, 303);
    // Duplicate session cookies are all revoked.
    const a = await signedIn(world, SUBJECTS.owner);
    const b = await signedIn(world, SUBJECTS.owner);
    const both = await send(world, "/auth/logout", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${a.jar.cookies.get(SESSION_COOKIE)}; ${SESSION_COOKIE}=${b.jar.cookies.get(SESSION_COOKIE)}`,
      },
    });
    assert.equal(both.status, 303);
    assert.equal((await principal(world, a.jar)).status, 401);
    assert.equal((await principal(world, b.jar)).status, 401);
  });
});

test("the signed-in page offers Sign out with a referrer policy that keeps the Origin header", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.editor);
    const page = await send(world, "/auth/account", { jar });
    assert.equal(page.status, 200);
    noStore(page);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.match(
      page.headers.get("content-security-policy"),
      /form-action 'self'/,
    );
    const html = await page.text();
    assert.match(
      html,
      /<form method="post" action="\/auth\/logout"><button type="submit">Sign out<\/button><\/form>/,
    );
    // Stored display text is escaped.
    assert.match(html, /Synthetic &lt;Editor&gt; &amp; Co/);
    assert.doesNotMatch(html, /<Editor>/);
    // Every other auth response keeps no-referrer.
    for (const response of [
      await send(world, "/auth/login"),
      await send(world, "/auth/logout", {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
      await send(world, "/auth/unknown"),
    ])
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const anonymous = await send(world, "/auth/account");
    assert.equal(anonymous.status, 401);
    assert.match(await anonymous.text(), /href="\/auth\/login"/);
  });
});

test("agent bearer credentials keep precedence and never fall back to a human cookie", async () => {
  await withWorld(async (world) => {
    const secret = await agentKey(world, "editor");
    const { jar } = await signedIn(world, SUBJECTS.owner);
    const bearer = { authorization: `Bearer ${secret}` };
    // Valid agent credential plus a valid owner cookie is the agent only.
    const both = await principal(world, jar, bearer);
    assert.deepEqual(both, {
      status: 200,
      body: { accountId: "h-agent", kind: "agent", role: "editor" },
    });
    assert.equal(
      (await send(world, "/api/admin/accounts", { jar, headers: bearer }))
        .status,
      403,
    );
    // Every invalid Authorization header denies, whatever the cookie says.
    for (const authorization of [
      "",
      "Bearer",
      "Bearer ",
      `Bearer ${secret}x`,
      `Bearer ${secret.slice(1)}`,
      `bearer ${secret}`,
      `Basic ${secret}`,
      `Bearer ${secret} extra`,
      `Bearer cwa_${"Z".repeat(43)}`,
      `${secret}`,
      "Bearer synthetic-human-session",
    ]) {
      const response = await send(world, "/_internal/principal", {
        jar,
        headers: { authorization },
      });
      assert.equal(response.status, 401, JSON.stringify(authorization));
    }
    // A revoked agent key denies and does not fall back either.
    world.database.exec(
      "UPDATE identities SET revoked_at = '2026-11-14T00:00:00.000Z', version = version + 1 WHERE id = 'i-agent'",
    );
    assert.equal((await principal(world, jar, bearer)).status, 401);
    // The agent still works with sign-in disabled, and cookies do not.
    world.database.exec(
      "UPDATE identities SET revoked_at = NULL, version = version + 1 WHERE id = 'i-agent'",
    );
    const off = { ...world.env, AUTH0_ENABLED: "false" };
    const agent = await send(world, "/_internal/principal", {
      env: off,
      headers: bearer,
    });
    assert.equal(agent.status, 200);
    // Duplicate Authorization headers are ambiguous.
    const response = await worker.fetch(
      new Request(`${ORIGIN}/_internal/principal`, {
        headers: new Headers([
          ["authorization", `Bearer ${secret}`],
          ["authorization", `Bearer ${secret}`],
          ["cookie", jar.header()],
        ]),
      }),
      world.env,
    );
    assert.equal(response.status, 401);
  });
});

test("cookie-authenticated writes from another origin are refused on every route", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.owner);
    const secret = await agentKey(world, "editor");
    const attempts = [
      [
        "/api/admin/accounts",
        { kind: "agent", role: "contributor", displayName: "Synthetic Forged" },
      ],
      ["/internal/content/publication/publish", {}],
      ["/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
      [
        "/api/accounts",
        { kind: "agent", role: "contributor", displayName: "Synthetic Forged" },
      ],
    ];
    const before = count(world, "accounts");
    for (const [path, body] of attempts) {
      for (const headers of [
        {},
        { origin: "null" },
        { origin: "https://evil.example" },
        { origin: `${ORIGIN}.evil.example` },
        { origin: "http://watchdog.example.test" },
      ]) {
        const response = await send(world, path, {
          method: "POST",
          jar,
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        assert.equal(
          response.status,
          403,
          `${path} ${JSON.stringify(headers)}`,
        );
        assert.deepEqual(await response.json(), { error: "origin_rejected" });
        noStore(response);
      }
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await send(world, "/api/admin/accounts/h-editor", {
        method,
        jar,
        headers: { origin: "https://evil.example" },
      });
      assert.equal(response.status, 403, method);
    }
    assert.equal(count(world, "accounts"), before);
    // The exact origin is accepted and still goes through the route's own checks.
    const created = await send(world, "/api/admin/accounts", {
      method: "POST",
      jar,
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        kind: "agent",
        role: "contributor",
        displayName: "Synthetic Created",
      }),
    });
    assert.equal(created.status, 201);
    // Reads are unaffected, and agent credentials keep their own behavior.
    assert.equal(
      (
        await send(world, "/api/admin/accounts", {
          jar,
          headers: { origin: "https://evil.example" },
        })
      ).status,
      200,
    );
    const agent = await send(world, "/api/accounts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({
        kind: "agent",
        role: "contributor",
        displayName: "Synthetic Agent Write",
      }),
    });
    assert.notEqual((await agent.json()).error, "origin_rejected");
    // A route's own origin check still applies with the exact origin.
    const intake = await send(world, "/api/v1/reports/track", {
      method: "POST",
      jar,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{}",
    });
    assert.equal(intake.status, 403);
  });
});

test("private responses are not cacheable and anonymous browsing is unchanged", async () => {
  await withWorld(async (world) => {
    const { jar } = await signedIn(world, SUBJECTS.editor);
    for (const path of [
      "/",
      "/counties",
      "/people",
      "/about",
      "/_internal/principal",
      "/api/me",
      "/admin/reports",
      "/admin/accounts",
    ]) {
      const response = await send(world, path, { jar });
      noStore(response);
    }
    // Public pages for anonymous visitors are served as before.
    const anonymous = await send(world, "/counties");
    assert.equal(anonymous.status, 200);
    const baseline = await worker.fetch(request(world, "/counties"), {
      DB: world.d1,
    });
    assert.equal(baseline.status, 200);
    assert.equal(
      baseline.headers.get("cache-control"),
      anonymous.headers.get("cache-control"),
    );
    // The only difference is the shared-header sign-in entry, which exists
    // only while sign-in is enabled.
    const entry = /<div class="header-account">[\s\S]*?<\/div>/;
    const withEntry = await anonymous.text();
    assert.match(withEntry, entry);
    assert.equal(await baseline.text(), withEntry.replace(entry, ""));
    for (const path of [
      "/",
      "/counties/08001",
      "/people",
      "/organizations",
      "/officials",
      "/stories",
      "/posts",
      "/about",
      "/reading-records",
    ]) {
      const withSignIn = await send(world, path);
      const without = await worker.fetch(request(world, path), {
        DB: world.d1,
      });
      assert.equal(withSignIn.status, without.status, path);
    }
  });
});

test("report intake stays default-off and MCP behaves the same with sign-in on or off", async () => {
  await withWorld(async (world) => {
    const secret = await agentKey(world, "administrator");
    const off = { DB: world.d1 };
    const submit = (env) =>
      send(world, "/api/v1/reports", {
        method: "POST",
        env,
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({}),
      });
    const disabledBefore = await submit(off);
    const disabledAfter = await submit(world.env);
    assert.equal(disabledAfter.status, disabledBefore.status);
    assert.equal(disabledAfter.status, 503);
    assert.deepEqual(await disabledAfter.json(), {
      error: "submission_unavailable",
    });
    const crossOrigin = await send(world, "/api/v1/reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);

    const mcp = (env, headers) =>
      send(world, "/mcp", {
        method: "POST",
        env,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    for (const headers of [
      {},
      { authorization: `Bearer ${secret}` },
      { authorization: "Bearer cwa_invalid" },
    ]) {
      const before = await mcp(off, headers);
      const after = await mcp(world.env, headers);
      assert.equal(after.status, before.status, JSON.stringify(headers));
      assert.equal(await after.text(), await before.text());
    }
    const authenticated = await mcp(world.env, {
      authorization: `Bearer ${secret}`,
    });
    assert.equal(authenticated.status, 200);
  });
});

test("transactions and old sessions are bounded and stale rows are purged", async () => {
  await withWorld(async (world) => {
    const { MAX_LIVE_TRANSACTIONS, PURGE_BATCH } = await import(
      "../dist/auth/store.js"
    );
    for (let attempt = 0; attempt < MAX_LIVE_TRANSACTIONS; attempt += 1) {
      const response = await send(world, "/auth/login");
      assert.equal(response.status, 302);
    }
    assert.equal(
      count(world, "auth_login_transactions"),
      MAX_LIVE_TRANSACTIONS,
    );
    // The cap holds: more requests are refused and add nothing.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await send(world, "/auth/login");
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
    assert.equal(
      count(world, "auth_login_transactions"),
      MAX_LIVE_TRANSACTIONS,
    );
    // Expired and consumed rows are purged by later requests, a bounded
    // number at a time, so the table does not keep growing.
    world.database.exec(
      "UPDATE auth_login_transactions SET expires_at = '2000-01-01T00:00:00.000Z'",
    );
    const response = await send(world, "/auth/login");
    assert.equal(response.status, 302);
    assert.equal(
      count(world, "auth_login_transactions"),
      MAX_LIVE_TRANSACTIONS - PURGE_BATCH + 1,
    );
    for (let attempt = 0; attempt < 4; attempt += 1)
      await send(world, "/auth/login");
    assert.ok(
      count(world, "auth_login_transactions") <=
        5 + (MAX_LIVE_TRANSACTIONS % PURGE_BATCH),
    );
    // Old expired sessions are purged too, recent ones are kept for audit.
    const { jar } = await signedIn(world, SUBJECTS.editor);
    world.database.exec(`INSERT INTO auth_sessions (id, token_hash, account_id, identity_id, provider, subject, created_at, idle_expires_at, absolute_expires_at, revoked_at)
      SELECT 'old-' || value, printf('%064x', value), 'h-editor', 'i-editor', '${world.provider}', 'github|synthetic-editor',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', '2026-01-01T08:00:00.000Z', '2026-01-01T01:00:00.000Z'
      FROM (WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 130) SELECT value FROM n)`);
    const total = () => count(world, "auth_sessions");
    const sessionsBefore = total();
    await send(world, "/auth/login");
    assert.equal(total(), sessionsBefore - PURGE_BATCH);
    await send(world, "/auth/login");
    assert.equal(total(), 1);
    assert.equal((await principal(world, jar)).status, 200);
  });
});

test("logs carry only fixed outcome labels and never credential material", async () => {
  const captured = [];
  const originals = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originals[level] = console[level];
    console[level] = (...args) => captured.push(args.map(String).join(" "));
  }
  try {
    await withWorld(async (world) => {
      const jar = cookieJar();
      const flow = await signIn(world, jar, SUBJECTS.editor);
      assert.equal(flow.callback.status, 302);
      const unlinked = await signIn(world, cookieJar(), SUBJECTS.unlinked);
      assert.equal(unlinked.callback.status, 403);
      world.tokenBehavior = async () =>
        new Response("secret provider body", { status: 500 });
      const failed = await signIn(world, cookieJar(), SUBJECTS.editor);
      assert.equal(failed.callback.status, 400);
      world.tokenBehavior = null;
      await send(world, "/auth/logout", {
        method: "POST",
        jar,
        headers: { origin: ORIGIN },
      });
      const text = captured.join("\n");
      assert.ok(captured.length > 0);
      for (const line of captured) {
        const entry = JSON.parse(line);
        assert.equal(entry.event, "human_sign_in");
        assert.ok(
          Object.keys(entry).every((key) =>
            ["event", "stage", "outcome", "upstream_status"].includes(key),
          ),
        );
        assert.match(entry.outcome, /^[a-z_]+$/);
      }
      for (const secret of [
        flow.state,
        flow.nonce,
        flow.code,
        unlinked.code,
        CLIENT_SECRET,
        SUBJECTS.editor,
        SUBJECTS.unlinked,
        "h-editor",
        "Synthetic",
        jar.cookies.get(SESSION_COOKIE) ?? "never-set",
        "provider body",
        "access_token",
        "/auth/callback?",
      ])
        assert.ok(!text.includes(secret), `logged: ${secret}`);
      assert.match(text, /upstream_status":500/);
    });
  } finally {
    Object.assign(console, originals);
  }
});

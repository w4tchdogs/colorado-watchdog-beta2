import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  CLIENT_ID,
  cookieJar,
  idToken,
  LOGIN_COOKIE,
  newKey,
  parseSetCookie,
  SESSION_COOKIE,
} from "../auth-fixtures.mjs";

/** Synthetic tenant values shared by the seed SQL and the Worker settings. */
export const SIGN_IN_ISSUER = "https://tenant-wrangler.example.test/";
export const SIGN_IN_CLIENT_SECRET = "synthetic-wrangler-client-secret";
export const SIGN_IN_SEED_SQL = `
  INSERT INTO accounts (id, kind, role, display_name) VALUES
    ('wr-editor', 'human', 'editor', 'Synthetic Wrangler Editor'),
    ('wr-contributor', 'human', 'contributor', 'Synthetic Wrangler Contributor'),
    ('wr-demoted', 'human', 'editor', 'Synthetic Wrangler Demoted'),
    ('wr-disabled', 'human', 'editor', 'Synthetic Wrangler Disabled'),
    ('wr-revoked', 'human', 'editor', 'Synthetic Wrangler Revoked');
  INSERT INTO identities (id, account_id, provider, subject) VALUES
    ('wr-editor-id', 'wr-editor', 'auth0:${SIGN_IN_ISSUER}', 'github|wrangler-editor'),
    ('wr-contributor-id', 'wr-contributor', 'auth0:${SIGN_IN_ISSUER}', 'github|wrangler-contributor'),
    ('wr-demoted-id', 'wr-demoted', 'auth0:${SIGN_IN_ISSUER}', 'github|wrangler-demoted'),
    ('wr-disabled-id', 'wr-disabled', 'auth0:${SIGN_IN_ISSUER}', 'github|wrangler-disabled'),
    ('wr-revoked-id', 'wr-revoked', 'auth0:${SIGN_IN_ISSUER}', 'github|wrangler-revoked');
`;

/**
 * A synthetic Auth0 tenant served over local HTTP. The Worker reaches it only
 * through the test-only upstream setting. Issued tokens still name the HTTPS
 * issuer, so verification runs exactly as in production.
 */
export async function startSyntheticTenant(port) {
  const key = newKey("wrangler-kid");
  const world = { issuer: SIGN_IN_ISSUER, key };
  const codes = new Map();
  const log = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    log.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [key.jwk] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parameters = JSON.parse(body);
        const entry = codes.get(parameters.code);
        response.setHeader("content-type", "application/json");
        if (
          !entry ||
          entry.used ||
          parameters.client_id !== CLIENT_ID ||
          parameters.client_secret !== SIGN_IN_CLIENT_SECRET ||
          parameters.grant_type !== "authorization_code"
        ) {
          response.statusCode = 403;
          response.end("{}");
          return;
        }
        entry.used = true;
        response.end(
          JSON.stringify({
            id_token: idToken(world, {
              sub: entry.subject,
              nonce: entry.nonce,
            }),
          }),
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    log,
    issueCode(code, subject, nonce) {
      codes.set(code, { subject, nonce, used: false });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Exercises the callback and session paths of the bundled Worker against
 * local D1. `restart` replaces the running Worker with one that has the given
 * extra settings, keeping the same local database.
 */
export async function runHumanSignInChecks({
  base,
  tenant,
  ownerHeaders,
  restart,
}) {
  let counter = 0;
  const send = (path, { jar, headers = {}, ...options } = {}) =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      ...options,
      headers: {
        ...(jar?.header() ? { cookie: jar.header() } : {}),
        ...headers,
      },
    });
  const signIn = async (
    subject,
    { jar = cookieJar(), concurrent = 1 } = {},
  ) => {
    const login = await send("/auth/login?return_to=/admin/reports", { jar });
    assert.equal(login.status, 302, await login.clone().text());
    jar.absorb(login);
    const authorize = new URL(login.headers.get("location"));
    assert.equal(
      `${authorize.origin}${authorize.pathname}`,
      `${SIGN_IN_ISSUER}authorize`,
    );
    assert.equal(authorize.searchParams.get("scope"), "openid");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      authorize.searchParams.get("redirect_uri"),
      `${base}/auth/callback`,
    );
    assert.equal(authorize.searchParams.get("client_id"), CLIENT_ID);
    counter += 1;
    const code = `wrangler-code-${counter}`;
    tenant.issueCode(code, subject, authorize.searchParams.get("nonce"));
    const callbackPath = `/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`;
    const results = await Promise.all(
      Array.from({ length: concurrent }, () => send(callbackPath, { jar })),
    );
    const winner = results.find((response) => response.status === 302);
    if (winner) jar.absorb(winner);
    return { jar, login, results, callbackPath };
  };
  const status = async (path, jar, headers) =>
    (await send(path, { jar, headers })).status;
  const accountCount = async () =>
    (
      await (
        await send("/api/admin/accounts?limit=100", { headers: ownerHeaders })
      ).json()
    ).accounts.length;
  const adminWrite = (path, method, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...ownerHeaders,
        origin: base,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  // Disabled by default: with no sign-in settings nothing starts.
  for (const path of ["/auth/login", "/auth/callback?code=x&state=y"]) {
    const response = await send(path);
    assert.equal(response.status, 503, path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(tenant.log.length, 0);

  await restart({ enabled: true });

  // A linked editor signs in and resolves live capabilities.
  const editor = await signIn("github|wrangler-editor");
  assert.equal(editor.results[0].status, 302);
  assert.equal(editor.results[0].headers.get("location"), "/admin/reports");
  assert.match(
    editor.results[0].headers.get("cache-control") ?? "",
    /no-store/,
  );
  const cookies = editor.results[0].headers.getSetCookie().map(parseSetCookie);
  const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
  assert.deepEqual(session.attributes.sort(), [
    "httponly",
    "max-age=28800",
    "path=/",
    "samesite=lax",
    "secure",
  ]);
  assert.equal(
    cookies.find((cookie) => cookie.name === LOGIN_COOKIE).value,
    "",
  );
  const me = await send("/api/me", { jar: editor.jar });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).id, "wr-editor");
  assert.equal(await status("/admin/reports", editor.jar), 200);
  assert.equal(await status("/api/admin/accounts", editor.jar), 403);
  assert.equal(await status("/admin/reports"), 401);
  // Caller-supplied identity headers grant nothing, with or without a cookie.
  assert.equal(
    await status("/_internal/principal", undefined, {
      "oai-authenticated-user-id": "github|wrangler-editor",
    }),
    401,
  );

  // The callback cannot be replayed, and concurrent claims yield one session.
  const replay = await send(editor.callbackPath, { jar: editor.jar });
  assert.equal(replay.status, 400);
  const contested = await signIn("github|wrangler-contributor", {
    concurrent: 5,
  });
  assert.deepEqual(
    contested.results.map((response) => response.status).sort(),
    [302, 400, 400, 400, 400],
  );
  assert.equal(await status("/admin/reports", contested.jar), 403);

  // An unlinked identity gets 403 and creates no account and no session.
  const accountsBefore = await accountCount();
  const unlinked = await signIn("github|wrangler-never-linked");
  assert.equal(unlinked.results[0].status, 403);
  assert.ok(!unlinked.jar.cookies.has(SESSION_COOKIE));
  assert.equal(await status("/_internal/principal", unlinked.jar), 401);
  assert.equal(await accountCount(), accountsBefore);

  // Cross-origin writes with the session cookie are refused.
  for (const origin of [
    undefined,
    "null",
    "https://evil.example",
    `${base}.evil.example`,
  ]) {
    const response = await send("/api/admin/accounts", {
      method: "POST",
      jar: editor.jar,
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({
        kind: "agent",
        role: "contributor",
        displayName: "Forged",
      }),
    });
    assert.equal(response.status, 403, String(origin));
    assert.deepEqual(await response.json(), { error: "origin_rejected" });
  }
  assert.equal(await accountCount(), accountsBefore);

  // Role change, account disable and identity revocation apply immediately.
  const demoted = await signIn("github|wrangler-demoted");
  assert.equal(await status("/admin/reports", demoted.jar), 200);
  const roleChange = await adminWrite(
    "/api/admin/accounts/wr-demoted/role",
    "PUT",
    {
      expectedVersion: 1,
      role: "contributor",
    },
  );
  assert.equal(roleChange.status, 200, await roleChange.clone().text());
  assert.equal(await status("/admin/reports", demoted.jar), 403);

  const disabled = await signIn("github|wrangler-disabled");
  assert.equal(await status("/admin/reports", disabled.jar), 200);
  const disable = await adminWrite("/api/admin/accounts/wr-disabled", "PATCH", {
    expectedVersion: 1,
    status: "disabled",
  });
  assert.equal(disable.status, 200, await disable.clone().text());
  assert.equal(await status("/admin/reports", disabled.jar), 401);
  const disabledAgain = await signIn("github|wrangler-disabled");
  assert.equal(disabledAgain.results[0].status, 403);

  const revoked = await signIn("github|wrangler-revoked");
  assert.equal(await status("/admin/reports", revoked.jar), 200);
  const revoke = await fetch(
    `${base}/api/admin/accounts/wr-revoked/identities?id=wr-revoked-id&version=1`,
    { method: "DELETE", headers: { ...ownerHeaders, origin: base } },
  );
  assert.equal(revoke.status, 200, await revoke.clone().text());
  assert.equal(await status("/admin/reports", revoked.jar), 401);

  // Agent bearer precedence over a valid human cookie.
  const bearer = await send("/_internal/principal", {
    jar: editor.jar,
    headers: ownerHeaders,
  });
  assert.equal((await bearer.json()).kind, "agent");
  assert.equal(
    await status("/_internal/principal", editor.jar, {
      authorization: "Bearer cwa_invalid",
    }),
    401,
  );

  // Sign-out needs the exact origin and revokes server-side.
  const page = await send("/auth/account", { jar: editor.jar });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  assert.match(await page.text(), /action="\/auth\/logout"/);
  for (const origin of [undefined, "null", "https://evil.example"]) {
    const response = await send("/auth/logout", {
      method: "POST",
      jar: editor.jar,
      headers: origin ? { origin } : {},
    });
    assert.equal(response.status, 403, String(origin));
  }
  assert.equal(await status("/admin/reports", editor.jar), 200);
  assert.equal((await send("/auth/logout", { jar: editor.jar })).status, 405);
  const out = await send("/auth/logout", {
    method: "POST",
    jar: editor.jar,
    headers: { origin: base },
  });
  assert.equal(out.status, 303);
  assert.equal(await status("/admin/reports", editor.jar), 401);

  // Disabling sign-in denies a live session. Sign-out still works.
  const survivor = await signIn("github|wrangler-editor");
  assert.equal(await status("/admin/reports", survivor.jar), 200);
  await restart({ enabled: false });
  assert.equal(await status("/admin/reports", survivor.jar), 401);
  assert.equal(await status("/_internal/principal", survivor.jar), 401);
  assert.equal((await send("/auth/login")).status, 503);
  const disabledPage = await send("/auth/account", { jar: survivor.jar });
  assert.equal(disabledPage.status, 401);
  assert.match(await disabledPage.text(), /action="\/auth\/logout"/);
  const disabledOut = await send("/auth/logout", {
    method: "POST",
    jar: survivor.jar,
    headers: { origin: base },
  });
  assert.equal(disabledOut.status, 303);
  const clearing = parseSetCookie(disabledOut.headers.getSetCookie()[0]);
  assert.equal(clearing.name, SESSION_COOKIE);
  assert.ok(clearing.attributes.includes("max-age=0"));
  assert.equal((await send("/counties")).status, 200);
  // The agent credential keeps working while human sign-in is disabled.
  assert.equal(
    (await send("/_internal/principal", { headers: ownerHeaders })).status,
    200,
  );
  // The bundled Worker really reached the synthetic provider for the code
  // exchange and the signing keys, and never followed any other request.
  assert.ok(tenant.log.includes("POST /oauth/token"));
  assert.ok(tenant.log.includes("GET /.well-known/jwks.json"));
  assert.ok(
    tenant.log.every(
      (line) =>
        line === "POST /oauth/token" || line === "GET /.well-known/jwks.json",
    ),
  );
}

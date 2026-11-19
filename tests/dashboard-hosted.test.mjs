import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createEditorApiClient } from "../dist/editor/api-client.js";
import { createBannerAdminClient } from "../dist/editor/banner-admin-client.js";
import { createBannersView } from "../dist/editor/banner-views.js";
import { mountDashboard } from "../dist/editor/dashboard.js";
import { createDashboardClient } from "../dist/editor/dashboard-client.js";
import {
  accountView,
  createPostsView,
  overviewView,
} from "../dist/editor/dashboard-views.js";
import worker from "../dist/server/index.js";
import {
  BETA2_PROJECT_ID,
  bootstrapFirstOwner,
} from "../dist/services/owner-bootstrap.js";
import { hashCredential } from "../dist/services/security.js";
import {
  cookieJar,
  createWorld,
  idToken,
  installUpstream,
  ORIGIN,
  request,
  SESSION_COOKIE,
} from "./auth-fixtures.mjs";

let codeCounter = 0;
const LOGIN = "/auth/login?return_to=%2Fdashboard";

function send(world, path, options = {}) {
  const { jar, headers = {}, env, ...rest } = options;
  const cookie = jar?.header();
  return worker.fetch(
    request(world, path, {
      ...rest,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    }),
    env ?? world.env,
  );
}

async function signIn(world, subject, jar = cookieJar()) {
  const login = await send(world, LOGIN, { jar });
  jar.absorb(login);
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get("location"));
  codeCounter += 1;
  const code = `dash-code-${codeCounter}`;
  const nonce = authorize.searchParams.get("nonce");
  world.codes.set(code, {
    idToken: () => idToken(world, { sub: subject, nonce }),
  });
  const state = authorize.searchParams.get("state");
  const callback = await send(
    world,
    `/auth/callback?code=${code}&state=${state}`,
    { jar },
  );
  jar.absorb(callback);
  return { jar, callback };
}

async function signedIn(world, subject) {
  const flow = await signIn(world, subject);
  assert.equal(flow.callback.status, 302, await flow.callback.clone().text());
  assert.equal(flow.callback.headers.get("location"), "/dashboard");
  assert.ok(flow.jar.cookies.has(SESSION_COOKIE));
  return flow.jar;
}

async function withWorld(callback, options) {
  const world = await createWorld(options);
  const restore = installUpstream(world);
  try {
    await callback(world);
  } finally {
    restore();
    world.database.close();
  }
}

const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const sameOrigin = { origin: ORIGIN, "content-type": "application/json" };
const session = (world, jar, headers) =>
  send(world, "/internal/dashboard/session", { jar, headers });
const view = (world, jar, id, headers = sameOrigin) =>
  send(world, "/internal/dashboard/views/get", {
    method: "POST",
    jar,
    headers,
    body: JSON.stringify({ view: id }),
  });
const ids = (list) => list.map((module) => module.id);

const OWNER = "github|synthetic-owner";
const EDITOR = "github|synthetic-editor";
const CONTRIBUTOR = "github|synthetic-contributor";
const ADMIN = "github|synthetic-admin";

test("the dashboard and the header entry do not exist while sign-in is off", async () => {
  await withWorld(async (world) => {
    for (const env of [
      { DB: world.d1 },
      { ...world.env, AUTH0_ENABLED: "false" },
      { ...world.env, AUTH0_CLIENT_SECRET: undefined },
      {},
    ]) {
      for (const path of [
        "/dashboard",
        "/internal/dashboard/session",
        "/internal/dashboard/views/get",
      ]) {
        const response = await send(world, path, { env });
        assert.equal(response.status, 404, path);
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.equal(response.headers.get("location"), null);
      }
      const home = await send(world, "/", { env });
      const html = await home.text();
      assert.doesNotMatch(html, /Log in \/ Sign up|header-login|\/dashboard/);
    }
  });
});

test("the header offers sign-in to signed-out visitors on every public page", async () => {
  await withWorld(async (world) => {
    for (const path of ["/", "/counties", "/about", "/no-such-page"]) {
      const response = await send(world, path);
      const html = await response.text();
      assert.match(
        html,
        /<a class="header-login" href="\/auth\/login\?return_to=%2Fdashboard" aria-describedby="header-login-note">Log in \/ Sign up<\/a>/,
        path,
      );
      assert.match(
        html,
        /id="header-login-note"[^>]*>[^<]*already linked/,
        path,
      );
      assert.doesNotMatch(html, /href="\/dashboard"/);
    }
    // A cookie that is not a live session is the same as none.
    const stale = await send(world, "/", {
      headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` },
    });
    assert.match(await stale.text(), /Log in \/ Sign up/);
  });
});

test("a signed-in visitor sees a Dashboard link, a plain keyboard-reachable anchor", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, EDITOR);
    for (const path of ["/", "/counties"]) {
      const html = await (await send(world, path, { jar })).text();
      assert.match(
        html,
        /<a class="header-login" href="\/dashboard">Dashboard<\/a>/,
      );
      assert.doesNotMatch(html, /Log in \/ Sign up/);
      // Ahead of the menu button and the main navigation in tab order.
      assert.ok(
        html.indexOf('class="header-login"') <
          html.indexOf('class="nav-toggle"'),
      );
      assert.doesNotMatch(html, /header-login"[^>]*tabindex/);
    }
    const dom = new JSDOM(await (await send(world, "/", { jar })).text());
    const link = dom.window.document.querySelector("a.header-login");
    assert.equal(link?.getAttribute("href"), "/dashboard");
    assert.equal(link?.tabIndex, 0);
  });
});

test("the shared header keeps the entry visible on narrow screens", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../website/site/site.css", import.meta.url)),
    "utf8",
  );
  const narrow = css.slice(css.indexOf("@media (max-width: 74.99rem)"));
  assert.match(narrow.slice(0, 600), /\.header-actions/);
  assert.doesNotMatch(
    narrow.slice(0, 600),
    /\.header-(actions|account)\s*\{[^}]*display:\s*none/,
  );
  assert.match(css, /\.header-login:focus-visible/);
});

test("/dashboard sends signed-out visitors to sign-in and serves the shell to a linked human", async () => {
  await withWorld(async (world) => {
    const out = await send(world, "/dashboard");
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), LOGIN);
    assert.match(out.headers.get("cache-control"), /no-store/);

    const jar = await signedIn(world, OWNER);
    const page = await send(world, "/dashboard", { jar });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("cache-control"), /no-store/);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    const policy = page.headers.get("content-security-policy");
    assert.match(
      policy,
      /default-src 'none'; script-src 'self'; style-src 'self'/,
    );
    assert.match(policy, /frame-ancestors 'none'/);
    // The Banners tab previews staged bytes it already fetched from the
    // protected route through a blob: URL. Nothing else widens the policy.
    assert.match(policy, /img-src 'self' blob:;/);
    assert.match(policy, /connect-src 'self';/);
    assert.doesNotMatch(policy, /data:|unsafe-|https?:/);
    assert.match(html, /\/assets\/dashboard-app\.js/);
    assert.match(html, /\/assets\/dashboard-app\.css/);
    assert.doesNotMatch(html, /editor-token|sandbox|Synthetic/i);
    const head = await send(world, "/dashboard", { jar, method: "HEAD" });
    assert.equal(head.status, 200);
    const post = await send(world, "/dashboard", {
      jar,
      method: "POST",
      headers: { origin: ORIGIN },
    });
    assert.equal(post.status, 405);
    assert.equal((await send(world, "/dashboard?x=1", { jar })).status, 404);
  });
});

test("the hosted bundle and assets carry no sandbox code, fixtures or switcher", async () => {
  await withWorld(async (world) => {
    for (const name of ["dashboard-app.js", "dashboard-app.css"]) {
      const response = await send(world, `/assets/${name}`);
      assert.equal(response.status, 200, name);
    }
    const script = await (await send(world, "/assets/dashboard-app.js")).text();
    // The hosted Posts & Stories view reuses the editor workspace, so the
    // workspace's own standalone-shell labels and the sandbox header names ride
    // in the bundle without being used. The hosted entry never passes a sandbox
    // token or account, never builds that shell, and the mount tests below
    // assert that no sandbox header is sent and no switcher is rendered.
    for (const marker of [
      "sbx-",
      "Avery Author",
      "Eli Editor",
      "Riley Reader",
      "createEditorSandbox",
      "editor-dev",
      "Lorem ipsum",
    ]) {
      assert.equal(script.includes(marker), false, marker);
    }
    // The Banners view is bundled and talks to the protected routes only.
    assert.match(script, /api\/admin\/banners/);
    assert.match(script, /x-banner-stage/);
    assert.match(script, /internal\/dashboard\/session/);
    assert.match(script, /\/auth\/logout/);
  });
});

test("the hyphenated County Structure view id is accepted and malformed ids are still rejected", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, OWNER);
    const ok = await view(world, jar, "county-structure");
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.view, "county-structure");
    for (const bad of [
      "County-Structure",
      "-county",
      "county-",
      "county--structure",
      "county_structure",
      "a".repeat(33),
      "",
    ]) {
      const response = await view(world, jar, bad);
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
  });
});

test("a linked owner gets Overview, My Account, Posts & Stories, Banners, Profiles and County Structure, with the rest named as planned", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, OWNER);
    const start = await json(await session(world, jar));
    assert.equal(start.status, 200);
    assert.deepEqual(ids(start.body.modules), [
      "overview",
      "account",
      "posts",
      "banners",
      "profiles",
      "county-structure",
    ]);
    assert.deepEqual(ids(start.body.planned).sort(), [
      "accounts",
      "audit",
      "reports",
      "status",
    ]);
    assert.equal(start.body.account.displayName, "Synthetic Owner");

    const overview = await json(await view(world, jar, "overview"));
    assert.equal(overview.status, 200);
    assert.equal(overview.body.view, "overview");
    assert.equal(overview.body.editorial, null);

    const account = await json(await view(world, jar, "account"));
    assert.equal(account.status, 200);
    assert.deepEqual(
      account.body.signInMethods.map((m) => [m.label, m.current]),
      [["Auth0 sign-in", true]],
    );
    const text = JSON.stringify(account.body);
    for (const secret of [
      "github|",
      "auth0:",
      "h-owner",
      "i-owner",
      world.issuer,
    ]) {
      assert.equal(text.includes(secret), false, secret);
    }

    // Banners names its view only. The data stays behind the protected API.
    const banners = await json(await view(world, jar, "banners"));
    assert.equal(banners.status, 200);
    assert.deepEqual(banners.body, { view: "banners" });

    // Posts & Stories names its view only. Every draft read and write goes
    // through the protected content routes.
    const posts = await json(await view(world, jar, "posts"));
    assert.equal(posts.status, 200);
    assert.deepEqual(posts.body, { view: "posts" });

    // Planned and unknown views are closed to every role.
    for (const id of ["reports", "accounts", "audit", "status", "nope"]) {
      assert.equal((await view(world, jar, id)).status, 404, id);
    }
  });
});

test("roles see only the hosted modules their role allows", async () => {
  await withWorld(async (world) => {
    const admin = await signedIn(world, ADMIN);
    const adminSession = await json(await session(world, admin));
    assert.deepEqual(ids(adminSession.body.modules), [
      "overview",
      "account",
      "posts",
      "banners",
    ]);
    assert.equal((await view(world, admin, "banners")).status, 200);
    assert.equal((await view(world, admin, "posts")).status, 200);

    const editor = await signedIn(world, EDITOR);
    const editorSession = await json(await session(world, editor));
    assert.deepEqual(ids(editorSession.body.modules), [
      "overview",
      "account",
      "posts",
    ]);
    assert.equal((await view(world, editor, "posts")).status, 200);
    // Without banner.manage the tab is absent and the view is refused.
    assert.equal((await view(world, editor, "banners")).status, 403);
    assert.deepEqual(ids(editorSession.body.planned).sort(), ["reports"]);
    const contributor = await signedIn(world, CONTRIBUTOR);
    const contributorSession = await json(await session(world, contributor));
    assert.deepEqual(ids(contributorSession.body.modules), [
      "overview",
      "account",
    ]);
    assert.deepEqual(contributorSession.body.planned, []);
    assert.equal((await view(world, contributor, "banners")).status, 403);
    assert.equal((await view(world, contributor, "posts")).status, 403);
  });
});

test("the banner API behind the tab stays authenticated and capability-gated", async () => {
  await withWorld(async (world) => {
    const path = "/api/admin/banners/counties";
    const signedOut = await send(world, path);
    assert.equal(signedOut.status, 401);
    const editor = await signedIn(world, EDITOR);
    assert.equal((await send(world, path, { jar: editor })).status, 403);
    const contributor = await signedIn(world, CONTRIBUTOR);
    assert.equal((await send(world, path, { jar: contributor })).status, 403);
    // The test world has no BUCKET, so an authorized caller is answered after
    // the checks, not before them.
    const owner = await signedIn(world, OWNER);
    const allowed = await send(world, path, { jar: owner });
    assert.equal(allowed.status, 503);
    assert.deepEqual(await allowed.json(), {
      error: "banner_admin_unavailable",
    });
  });
});

test("the hosted banner client authenticates by cookie only and reads the private preview route", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, OWNER);
    const calls = [];
    const client = createBannerAdminClient({
      fetch: async (input, init) => {
        calls.push({ input, method: init.method, headers: init.headers });
        return send(world, input, {
          method: init.method,
          jar,
          headers: { origin: ORIGIN, ...init.headers },
          body: init.body,
        });
      },
    });
    await assert.rejects(client.listCounties({ query: "adams" }), (error) => {
      assert.equal(error.code, "banner_admin_unavailable");
      return true;
    });
    await assert.rejects(client.versionImage("synthetic-version"), (error) => {
      assert.equal(error.code, "banner_admin_unavailable");
      return true;
    });
    assert.deepEqual(
      calls.map((call) => call.input),
      [
        "/api/admin/banners/counties?query=adams",
        "/api/admin/banners/versions/synthetic-version/image",
      ],
    );
    for (const call of calls) {
      assert.deepEqual(
        Object.keys(call.headers).filter((h) =>
          /editor|test-human|sandbox|token/i.test(h),
        ),
        [],
      );
    }
  });
});

test("signed-out callers, forged identity headers and agent credentials are denied", async () => {
  await withWorld(async (world) => {
    for (const call of [
      () => session(world, undefined),
      () => view(world, undefined, "overview"),
    ]) {
      const response = await call();
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: "authentication_required",
      });
    }
    const forged = {
      "x-test-human-subject": OWNER,
      "oai-authenticated-user-id": OWNER,
      "x-forwarded-user": OWNER,
    };
    assert.equal((await session(world, undefined, forged)).status, 401);
    const forgedPage = await send(world, "/dashboard", { headers: forged });
    assert.equal(forgedPage.status, 303);

    const secret = `cwa_${"A".repeat(43)}`;
    const hash = await hashCredential(secret);
    world.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('h-agent', 'agent', 'owner', 'Synthetic Agent');
      INSERT INTO identities (id, account_id, provider, subject, credential_hash)
        VALUES ('i-agent', 'h-agent', 'agent-key', 'i-agent', '${hash}');
    `);
    const bearer = { authorization: `Bearer ${secret}` };
    assert.equal((await session(world, undefined, bearer)).status, 403);
    const agentView = await view(world, undefined, "overview", {
      ...sameOrigin,
      ...bearer,
    });
    assert.equal(agentView.status, 403);
    assert.equal(
      (await send(world, "/dashboard", { headers: bearer })).status,
      403,
    );
    const bad = { authorization: `Bearer cwa_${"B".repeat(43)}` };
    assert.equal((await session(world, undefined, bad)).status, 401);
    assert.equal(
      (await send(world, "/dashboard", { headers: bad })).status,
      401,
    );
    // A valid session cookie never rescues a presented agent credential.
    const jar = await signedIn(world, OWNER);
    assert.equal((await session(world, jar, bearer)).status, 403);
    assert.equal((await session(world, jar, bad)).status, 401);
  });
});

test("an unlinked account never gets a session or the dashboard", async () => {
  await withWorld(async (world) => {
    const { jar, callback } = await signIn(
      world,
      "github|synthetic-never-linked",
    );
    assert.equal(callback.status, 403);
    assert.equal(jar.cookies.has(SESSION_COOKIE), false);
    assert.equal((await send(world, "/dashboard", { jar })).status, 303);
    assert.equal((await session(world, jar)).status, 401);
  });
});

test("a disabled account, a revoked link and an expired link lose the dashboard on the next request", async () => {
  for (const [name, change] of [
    [
      "disabled",
      "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'h-editor'",
    ],
    [
      "revoked",
      "UPDATE identities SET revoked_at = '2026-11-16T00:00:00.000Z', version = version + 1 WHERE id = 'i-editor'",
    ],
    [
      "expired",
      "UPDATE identities SET expires_at = '2000-01-01T00:00:00.000Z', version = version + 1 WHERE id = 'i-editor'",
    ],
  ]) {
    await withWorld(async (world) => {
      const jar = await signedIn(world, EDITOR);
      assert.equal((await session(world, jar)).status, 200, name);
      world.database.exec(change);
      assert.equal((await session(world, jar)).status, 401, name);
      assert.equal((await view(world, jar, "account")).status, 401, name);
      assert.equal(
        (await send(world, "/dashboard", { jar })).status,
        303,
        name,
      );
      const html = await (await send(world, "/", { jar })).text();
      assert.match(html, /Log in \/ Sign up/, name);
    });
  }
});

test("a cookie-authenticated view request from another origin is refused", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, OWNER);
    for (const origin of ["https://evil.example.test", "null"]) {
      const response = await view(world, jar, "overview", {
        origin,
        "content-type": "application/json",
      });
      assert.equal(response.status, 403, origin);
      assert.deepEqual(await response.json(), { error: "origin_rejected" });
    }
    const missing = await view(world, jar, "overview", {
      "content-type": "application/json",
    });
    assert.equal(missing.status, 403);
    assert.equal((await view(world, jar, "overview")).status, 200);
  });
});

test("same-origin sign-out ends the dashboard session", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, OWNER);
    assert.equal((await session(world, jar)).status, 200);
    const cross = await send(world, "/auth/logout", {
      method: "POST",
      jar,
      headers: { origin: "https://evil.example.test" },
    });
    assert.equal(cross.status, 403);
    assert.equal((await session(world, jar)).status, 200);
    const stale = cookieJar();
    for (const [name, value] of jar.cookies) stale.cookies.set(name, value);
    const out = await send(world, "/auth/logout", {
      method: "POST",
      jar,
      headers: { origin: ORIGIN },
    });
    assert.ok([200, 302, 303].includes(out.status), String(out.status));
    // The old cookie value no longer works, even if a browser kept it.
    assert.equal((await session(world, stale)).status, 401);
    assert.equal((await send(world, "/dashboard", { jar: stale })).status, 303);
  });
});

test("the first owner linked to Auth0 through the bootstrap can sign in and open the dashboard", async () => {
  await withWorld(
    async (world) => {
      const input = {
        projectId: BETA2_PROJECT_ID,
        bindingName: "DB",
        subject: "github|synthetic-first-owner",
        operatorReference: "synthetic-operator",
        provider: world.provider,
      };
      assert.deepEqual(
        await bootstrapFirstOwner(world.asyncD1, { ...input, dryRun: true }),
        { status: "ready" },
      );
      const created = await bootstrapFirstOwner(world.asyncD1, input);
      assert.equal(created.status, "created");
      assert.deepEqual(await bootstrapFirstOwner(world.asyncD1, input), {
        status: "already_complete",
      });
      for (const provider of [
        "auth0:http://x/",
        "auth0:https://x/path",
        "github",
      ]) {
        await assert.rejects(
          () => bootstrapFirstOwner(world.asyncD1, { ...input, provider }),
          TypeError,
          provider,
        );
      }
      const jar = await signedIn(world, input.subject);
      const start = await json(await session(world, jar));
      assert.equal(start.body.account.role, "owner");
      assert.equal(start.body.account.displayName, "Website Owner");
      // Sign-in created nothing: one account, one link, one session.
      const count = (table) =>
        world.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.equal(count("accounts"), 1);
      assert.equal(count("identities"), 1);
      assert.equal(count("auth_sessions"), 1);
    },
    { seed: false },
  );
});

test("the hosted shell mounts against the real Worker with sign-out and no sandbox strip", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, OWNER);
    const dom = new JSDOM('<!doctype html><div id="app"></div>', {
      url: `${ORIGIN}/dashboard`,
    });
    const { window } = dom;
    const calls = [];
    const fetchLike = async (input, init) => {
      calls.push({ input, headers: init.headers });
      return send(world, input, {
        method: init.method,
        jar,
        headers: { origin: ORIGIN, ...init.headers },
        body: init.body,
      });
    };
    mountDashboard(window.document.getElementById("app"), {
      doc: window.document,
      client: createDashboardClient({ fetch: fetchLike }),
      publicSiteUrl: "/",
      views: {
        overview: overviewView,
        account: accountView,
        posts: createPostsView({
          client: createEditorApiClient({ fetch: fetchLike }),
          session: { account: "" },
        }),
        banners: createBannersView({
          client: createBannerAdminClient({ fetch: fetchLike }),
        }),
      },
      signOut: { action: "/auth/logout" },
    });
    const $ = (selector) => window.document.querySelector(selector);
    const waitFor = async (selector) => {
      for (let i = 0; i < 60 && !$(selector); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await waitFor("#overview-heading");
    assert.equal(
      $("#overview-heading")?.textContent,
      "Welcome, Synthetic Owner",
    );
    // An owner is not told the role has no staff tools. They are planned.
    assert.equal($("#overview-no-staff-tools"), null);
    assert.ok($("#overview-planned"));
    assert.equal($("#sandbox-bar"), null);
    assert.equal($("#sandbox-account"), null);
    assert.deepEqual(
      [...window.document.querySelectorAll("#dash-sidebar a[data-view]")].map(
        (a) => a.textContent,
      ),
      [
        "Overview",
        "My Account",
        "Posts & Stories",
        "Banners",
        "Profiles",
        "County Structure",
      ],
    );
    const form = $("#menu-signout-form");
    assert.equal(form?.getAttribute("method"), "post");
    assert.equal(form?.getAttribute("action"), "/auth/logout");
    assert.equal($("#menu-signout")?.textContent, "Sign out");
    assert.equal(
      window.document.title,
      "Overview - Colorado Watchdog dashboard",
    );
    for (const call of calls) {
      assert.deepEqual(
        Object.keys(call.headers).filter((h) => /editor|test-human/i.test(h)),
        [],
      );
    }
    window.location.hash = "#/banners";
    await waitFor("#banners-heading");
    assert.equal($("#banners-heading")?.textContent, "Banners");
    assert.equal(
      $("#banners-heading")?.nextElementSibling?.textContent,
      "Manage the banners displayed on county pages.",
    );
    assert.ok(calls.some((c) => c.input === "/internal/dashboard/views/get"));
    for (const call of calls) {
      assert.deepEqual(
        Object.keys(call.headers).filter((h) => /editor|test-human/i.test(h)),
        [],
      );
    }
    window.location.hash = "#/reports";
    await waitFor("#state-not-found");
    assert.ok($("#state-not-found"));
  });
});

test("the header offers Submit a report in every account state, ahead of the account entry", async () => {
  await withWorld(async (world) => {
    const jar = await signedIn(world, EDITOR);
    for (const options of [{}, { jar }]) {
      const html = await (await send(world, "/counties", options)).text();
      assert.match(
        html,
        /<a class="header-submit" href="\/submit-report">Submit a report <svg[^>]*aria-hidden="true"/,
      );
      assert.ok(
        html.indexOf('class="header-submit"') <
          html.indexOf('class="header-login"'),
      );
      if (!options.jar)
        assert.match(html, /class="header-login-note visually-hidden"/);
    }
    for (const env of [{ ...world.env, AUTH0_CLIENT_SECRET: undefined }, {}]) {
      const html = await (await send(world, "/", { env })).text();
      assert.match(html, /href="\/submit-report"/);
      assert.doesNotMatch(html, /header-login/);
    }
  });
});

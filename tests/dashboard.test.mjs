import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApplication } from "../dist/application.js";
import { DASHBOARD_MODULES } from "../dist/contracts/dashboard.js";
import { createDashboardService } from "../dist/services/dashboard.js";
import {
  AuthorizationError,
  makeTrustedPrincipal,
  roleHasCapability,
} from "../dist/services/security.js";
import { createSitePreview } from "../dist/site-dev/preview.js";
import { createDashboardApiTransport } from "../dist/transport/dashboard-api.js";
import { ORIGIN, startSandbox } from "./editor-fixtures.mjs";

const SESSION = "/internal/dashboard/session";
const VIEW = "/internal/dashboard/views/get";
const LIST = "/internal/content/drafts/list";

const call = (sandbox, path, { account, body, headers = {}, method } = {}) =>
  sandbox.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        origin: ORIGIN,
        "x-editor-token": sandbox.token,
        ...(account === undefined ? {} : { "x-test-human-subject": account }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const session = (sandbox, account) => call(sandbox, SESSION, { account });
const view = (sandbox, account, id) =>
  call(sandbox, VIEW, { account, body: { view: id } });
const ids = (modules) => modules.map((module) => module.id);

test("navigation follows the existing role matrix for every human role", async () => {
  const sandbox = await startSandbox();
  try {
    const expected = {
      readonly: { role: "contributor", modules: ["overview", "account"] },
      author: { role: "editor", modules: ["overview", "account", "posts"] },
      admin: {
        role: "administrator",
        modules: ["overview", "account", "posts", "banners"],
      },
      owner: {
        role: "owner",
        modules: ["overview", "account", "posts", "banners"],
      },
    };
    for (const [account, want] of Object.entries(expected)) {
      const response = await session(sandbox, account);
      assert.equal(response.status, 200, account);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.account.role, want.role);
      assert.deepEqual(ids(body.modules), want.modules, account);
      // Planned modules are listed only where the role holds the capability.
      // Profiles and County Structure are hosted-only, so the local sandbox lists them as planned.
      const planned = DASHBOARD_MODULES.filter(
        (module) =>
          (module.state === "planned" ||
            module.id === "profiles" ||
            module.id === "county-structure") &&
          roleHasCapability(want.role, module.access.capability),
      ).map((module) => module.id);
      assert.deepEqual(ids(body.planned), planned, account);
    }
    const contributor = await (await session(sandbox, "readonly")).json();
    assert.deepEqual(contributor.planned, []);
    const owner = await (await session(sandbox, "owner")).json();
    assert.deepEqual(ids(owner.planned), [
      "reports",
      "profiles",
      "county-structure",
      "accounts",
      "audit",
      "status",
    ]);
  } finally {
    sandbox.close();
  }
});

test("anonymous, disabled and unknown callers get no session and no view", async () => {
  const sandbox = await startSandbox();
  try {
    for (const account of [undefined, "anonymous", "retired", "nobody", ""]) {
      const response = await session(sandbox, account);
      assert.equal(response.status, 401, String(account));
      assert.deepEqual(await response.json(), {
        error: "authentication_required",
      });
      for (const id of ["overview", "account", "posts"]) {
        assert.equal((await view(sandbox, account, id)).status, 401);
      }
      assert.equal(
        (await call(sandbox, LIST, { account, body: {} })).status,
        401,
      );
    }
  } finally {
    sandbox.close();
  }
});

test("My Account returns only safe fields for the caller's own account", async () => {
  const sandbox = await startSandbox();
  try {
    const response = await view(sandbox, "readonly", "account");
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), [
      "account",
      "modules",
      "signInMethods",
      "view",
    ]);
    assert.deepEqual(body.account, {
      displayName: "Riley Reader",
      email: "reader@example.invalid",
      role: "contributor",
      roleLabel: "Contributor",
      status: "active",
      memberSince: body.account.memberSince,
    });
    assert.deepEqual(Object.keys(body.signInMethods[0]).sort(), [
      "current",
      "expiresAt",
      "label",
      "linkedAt",
    ]);
    assert.equal(body.signInMethods[0].current, true);
    // No identifier, subject, provider string, hash or other account leaks.
    for (const secret of [
      "sbx-",
      "sandbox-subject",
      "test-human",
      "credential",
      "preferences",
      "Avery",
      "Olive",
    ]) {
      assert.equal(text.includes(secret), false, secret);
    }
    // The request cannot name another account: extra keys are refused.
    const forged = await call(sandbox, VIEW, {
      account: "readonly",
      body: { view: "account", accountId: "sbx-owner" },
    });
    assert.equal(forged.status, 400);
  } finally {
    sandbox.close();
  }
});

test("a contributor Overview carries no staff content or counts", async () => {
  const sandbox = await startSandbox();
  try {
    const response = await view(sandbox, "readonly", "overview");
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.editorial, null);
    assert.deepEqual(body.planned, []);
    assert.deepEqual(ids(body.modules), ["overview", "account"]);
    assert.equal(/Fictional|Lorem|draft|report/i.test(text), false);

    const editor = await (await view(sandbox, "author", "overview")).json();
    assert.equal(editor.editorial.recent.length, 5);
    assert.ok(editor.editorial.recent.every((item) => !("body" in item)));
  } finally {
    sandbox.close();
  }
});

test("direct requests to restricted, planned and unknown views are refused", async () => {
  const sandbox = await startSandbox();
  try {
    const denied = await view(sandbox, "readonly", "posts");
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "forbidden" });
    for (const account of ["author", "admin", "owner"]) {
      assert.equal((await view(sandbox, account, "posts")).status, 200);
      assert.equal(
        (await call(sandbox, LIST, { account, body: {} })).status,
        200,
      );
    }
    // Banners is now an active module: administrators and owners get it.
    assert.equal((await view(sandbox, "admin", "banners")).status, 200);
    assert.equal((await view(sandbox, "owner", "banners")).status, 200);
    assert.equal((await view(sandbox, "readonly", "banners")).status, 403);
    // Remaining planned modules have no view for anyone, including the owner.
    for (const id of ["accounts", "reports", "audit", "status", "nope"]) {
      for (const account of ["readonly", "owner"]) {
        assert.equal((await view(sandbox, account, id)).status, 404, id);
      }
    }
    // A contributor's direct editorial actions stay refused and unaudited.
    for (const [path, body] of [
      [LIST, {}],
      ["/internal/content/drafts/create", { contentType: "post", title: "x" }],
      ["/internal/content/drafts/get", { id: "x" }],
      ["/internal/content/revisions/list", { id: "x" }],
    ]) {
      assert.equal(
        (await call(sandbox, path, { account: "readonly", body })).status,
        403,
        path,
      );
    }
    assert.equal(
      sandbox.database
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE actor_account_id = 'sbx-readonly'",
        )
        .get().n,
      0,
    );
  } finally {
    sandbox.close();
  }
});

test("malformed dashboard requests and missing sandbox guards are rejected", async () => {
  const sandbox = await startSandbox();
  try {
    const account = "author";
    const cases = [
      [call(sandbox, SESSION, { account, method: "POST", body: {} }), 405],
      [call(sandbox, VIEW, { account, method: "GET" }), 405],
      [call(sandbox, `${SESSION}?account=owner`, { account }), 400],
      [call(sandbox, VIEW, { account, body: {} }), 400],
      [call(sandbox, VIEW, { account, body: { view: 7 } }), 400],
      [call(sandbox, VIEW, { account, body: { view: "../posts" } }), 400],
      [call(sandbox, VIEW, { account, body: ["posts"] }), 400],
      [
        call(sandbox, VIEW, {
          account,
          body: { view: "posts" },
          headers: { "content-type": "text/plain" },
        }),
        415,
      ],
      [
        call(sandbox, VIEW, {
          account,
          body: { view: "a".repeat(600) },
        }),
        413,
      ],
      [
        call(sandbox, SESSION, { account, headers: { "x-editor-token": "" } }),
        403,
      ],
      [
        call(sandbox, SESSION, {
          account,
          headers: { origin: "https://evil.invalid" },
        }),
        403,
      ],
      [
        call(sandbox, SESSION, {
          account,
          headers: { "sec-fetch-site": "cross-site" },
        }),
        403,
      ],
    ];
    for (const [pending, status] of cases) {
      assert.equal((await pending).status, status);
    }
    const rebound = await sandbox.fetch(
      new Request(`http://attacker.invalid${SESSION}`, {
        headers: {
          "x-editor-token": sandbox.token,
          "x-test-human-subject": "owner",
        },
      }),
    );
    assert.equal(rebound.status, 403);
  } finally {
    sandbox.close();
  }
});

test("a role change or disabled account applies on the next request", async () => {
  const sandbox = await startSandbox();
  try {
    assert.deepEqual(
      ids((await (await session(sandbox, "author")).json()).modules),
      ["overview", "account", "posts"],
    );
    sandbox.database
      .prepare(
        "UPDATE accounts SET role = 'contributor', version = version + 1 WHERE id = ?",
      )
      .run("sbx-author");
    assert.deepEqual(
      ids((await (await session(sandbox, "author")).json()).modules),
      ["overview", "account"],
    );
    assert.equal((await view(sandbox, "author", "posts")).status, 403);
    assert.equal(
      (await call(sandbox, LIST, { account: "author", body: {} })).status,
      403,
    );
    sandbox.database
      .prepare(
        "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = ?",
      )
      .run("sbx-author");
    assert.equal((await session(sandbox, "author")).status, 401);
    assert.equal((await view(sandbox, "author", "account")).status, 401);
  } finally {
    sandbox.close();
  }
});

test("the dashboard service refuses agent principals and absent wiring denies", async () => {
  const sandbox = await startSandbox();
  try {
    sandbox.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name)
      VALUES ('sbx-agent', 'agent', 'administrator', 'Synthetic Agent');
      INSERT INTO identities (id, account_id, provider, subject, credential_hash)
      VALUES ('sbx-id-agent', 'sbx-agent', 'agent-key', 'synthetic-agent',
              '${"a".repeat(64)}');
    `);
    const agent = makeTrustedPrincipal(
      {
        id: "sbx-agent",
        identity_id: "sbx-id-agent",
        kind: "agent",
        role: "administrator",
      },
      "agent-key",
    );
    const service = createDashboardService(sandbox.database);
    assert.throws(() => service.session(agent), AuthorizationError);
    assert.throws(() => service.view(agent, "overview"), AuthorizationError);
    assert.equal(service.mayOpen(agent, "overview"), false);
    assert.equal(service.mayOpen(null, "overview"), false);

    // A transport without a resolver or service never answers with data.
    const bare = createDashboardApiTransport();
    assert.equal(
      (await bare.fetch(new Request(`${ORIGIN}${SESSION}`))).status,
      401,
    );
    const noService = createDashboardApiTransport({
      resolvePrincipal: async () => agent,
    });
    assert.equal(
      (await noService.fetch(new Request(`${ORIGIN}${SESSION}`))).status,
      503,
    );
  } finally {
    sandbox.close();
  }
});

test("hosted and public entry points expose no dashboard fixture or account switch", async () => {
  const requests = [
    ["GET", SESSION],
    ["POST", VIEW],
    ["GET", "/sandbox/info"],
    ["POST", LIST],
    ["GET", "/dashboard.css"],
    ["GET", "/app/dashboard.js"],
    ["GET", "/api/admin/banners/counties"],
  ];
  const preview = await createSitePreview({
    staticDirectory: fileURLToPath(
      new URL("../website/site/", import.meta.url),
    ),
    data: "fictional",
  });
  try {
    for (const [method, path] of requests) {
      for (const target of [createApplication({}), preview]) {
        const response = await target.fetch(
          new Request(`https://example.invalid${path}`, {
            method,
            headers: {
              "x-test-human-subject": "owner",
              ...(method === "POST"
                ? { "content-type": "application/json" }
                : {}),
            },
            ...(method === "POST" ? { body: '{"view":"overview"}' } : {}),
          }),
        );
        assert.ok(response.status >= 400, `${method} ${path}`);
        const text = await response.text();
        assert.equal(/Avery|Olive Owner|sbx-|Fictional Post/.test(text), false);
      }
    }
  } finally {
    preview.close();
  }

  const read = (file) =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  for (const file of ["../src/application.ts", "../src/worker.ts"]) {
    assert.equal(
      /editor-dev|sandbox|dashboard-api|services\/dashboard\.js|x-test-human-subject|createTestHumanIdentityAdapter/i.test(
        read(file),
      ),
      false,
      file,
    );
  }
  // The packaged Worker bundle carries none of the sandbox or its switch.
  const bundle = read("../dist/server/index.js");
  for (const marker of [
    "x-test-human-subject",
    "sandbox-subject",
    "LOCAL SANDBOX",
    "x-editor-token",
    "sbx-owner",
  ]) {
    assert.equal(bundle.includes(marker), false, marker);
  }
});

test("dashboard browser code keeps nothing in browser storage", () => {
  for (const file of [
    "dashboard.js",
    "dashboard-client.js",
    "dashboard-sandbox.js",
    "dashboard-views.js",
    "banner-admin-client.js",
    "banner-views.js",
    "main.js",
    "app.js",
    "api-client.js",
  ]) {
    const source = readFileSync(
      fileURLToPath(new URL(`../dist/editor/${file}`, import.meta.url)),
      "utf8",
    );
    assert.equal(
      /localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/.test(
        source,
      ),
      false,
      file,
    );
  }
});

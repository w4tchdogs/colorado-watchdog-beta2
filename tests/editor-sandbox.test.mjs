import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApplication } from "../dist/application.js";
import { createEditorSandbox } from "../dist/editor-dev/sandbox.js";
import { HOST, ORIGIN, startSandbox } from "./editor-fixtures.mjs";

const post = (sandbox, path, body, headers = {}) =>
  sandbox.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-editor-token": sandbox.token,
        "x-test-human-subject": "author",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
const LIST = "/internal/content/drafts/list";

test("sandbox seeds fictional content through the real service", async () => {
  const sandbox = await startSandbox();
  try {
    const response = await post(sandbox, LIST, { limit: 100 });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.items.length, 14);
    assert.ok(page.items.some((item) => item.status === "archived"));
    assert.ok(page.items.some((item) => item.contentType === "story"));
    assert.ok(page.items.every((item) => /^Fictional/.test(item.title)));
    const count = sandbox.database
      .prepare("SELECT COUNT(*) AS n FROM audit_events")
      .get().n;
    assert.ok(count > 14);
  } finally {
    sandbox.close();
  }
});

test("sandbox ignores production environment and never opens a file database", async () => {
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = "/nonexistent/production.sqlite";
  try {
    const sandbox = await startSandbox();
    const response = await post(sandbox, LIST, {});
    assert.equal(response.status, 200);
    sandbox.close();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  }
  const source = readFileSync(
    fileURLToPath(new URL("../src/editor-dev/sandbox.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(/process\.env|\bD1\b|\bR2\b|research\//.test(source), false);
  assert.match(source, /openWebsiteDatabase\(":memory:"\)/);
  const launcher = readFileSync(
    fileURLToPath(new URL("../scripts/editor-dev.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(launcher, /const host = "127\.0\.0\.1"/);
  assert.equal(launcher.includes("DATABASE_PATH"), true); // only in the comment
  assert.equal(
    /openWebsiteDatabase|process\.env\.DATABASE_PATH/.test(launcher),
    false,
  );
});

test("two sandboxes are fully independent and disposable", async () => {
  const one = await startSandbox();
  const two = await startSandbox();
  try {
    assert.notEqual(one.token, two.token);
    const created = await post(one, "/internal/content/drafts/create", {
      contentType: "post",
      title: "Only in one",
    });
    assert.equal(created.status, 201);
    const page = await (await post(two, LIST, { limit: 100 })).json();
    assert.equal(
      page.items.some((item) => item.title === "Only in one"),
      false,
    );
  } finally {
    one.close();
    two.close();
  }
});

test("state-changing and read requests require the per-launch token", async () => {
  const sandbox = await startSandbox();
  try {
    for (const token of [null, "", "wrong", `${sandbox.token}x`]) {
      const headers =
        token === null ? { "x-editor-token": "" } : { "x-editor-token": token };
      const response = await post(sandbox, LIST, {}, headers);
      assert.equal(response.status, 403, String(token));
    }
    const info = await sandbox.fetch(
      new Request(`${ORIGIN}/sandbox/info`, { headers: { origin: ORIGIN } }),
    );
    assert.equal(info.status, 403);
  } finally {
    sandbox.close();
  }
});

test("cross-origin and cross-site requests are rejected", async () => {
  const sandbox = await startSandbox();
  try {
    const cases = [
      { origin: "https://evil.invalid" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of cases) {
      const response = await post(sandbox, LIST, {}, headers);
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    const noOrigin = await sandbox.fetch(
      new Request(`${ORIGIN}${LIST}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-editor-token": sandbox.token,
          "x-test-human-subject": "author",
        },
        body: "{}",
      }),
    );
    assert.equal(noOrigin.status, 403);
    const sameOrigin = await post(
      sandbox,
      LIST,
      {},
      { "sec-fetch-site": "same-origin" },
    );
    assert.equal(sameOrigin.status, 200);
  } finally {
    sandbox.close();
  }
});

test("unexpected Host headers are refused (DNS rebinding)", async () => {
  const sandbox = await startSandbox();
  try {
    for (const host of [
      "evil.invalid:8788",
      "127.0.0.1:9999",
      "localhost:8788",
    ]) {
      const response = await sandbox.fetch(new Request(`http://${host}/`));
      assert.equal(response.status, 403, host);
    }
    assert.equal(
      (await sandbox.fetch(new Request(`http://${HOST}/`))).status,
      200,
    );
  } finally {
    sandbox.close();
  }
});

test("pages carry a strict CSP and embed the token only in the HTML", async () => {
  const sandbox = await startSandbox();
  try {
    const page = await sandbox.fetch(new Request(`http://${HOST}/`));
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.equal(html.includes(sandbox.token), true);
    assert.equal(html.includes("__EDITOR_TOKEN__"), false);
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false);
    assert.equal(/\bon\w+=/i.test(html), false);
    for (const file of ["main.js", "banner-filename.js"]) {
      const script = await sandbox.fetch(
        new Request(`http://${HOST}/app/${file}`),
      );
      assert.equal(script.status, 200, file);
      assert.match(
        script.headers.get("content-type") ?? "",
        /javascript/,
        file,
      );
      assert.equal((await script.text()).includes(sandbox.token), false, file);
    }
    assert.equal(
      (await sandbox.fetch(new Request(`http://${HOST}/package.json`))).status,
      404,
    );
    assert.equal(
      (await sandbox.fetch(new Request(`http://${HOST}/..%2fpackage.json`)))
        .status,
      404,
    );
  } finally {
    sandbox.close();
  }
});

test("authorization failures: denied, disabled, unknown and missing accounts", async () => {
  const sandbox = await startSandbox();
  try {
    assert.equal(
      (await post(sandbox, LIST, {}, { "x-test-human-subject": "readonly" }))
        .status,
      403,
    );
    assert.equal(
      (await post(sandbox, LIST, {}, { "x-test-human-subject": "retired" }))
        .status,
      401,
    );
    assert.equal(
      (await post(sandbox, LIST, {}, { "x-test-human-subject": "nobody" }))
        .status,
      401,
    );
    assert.equal(
      (await post(sandbox, LIST, {}, { "x-test-human-subject": "" })).status,
      401,
    );
    const created = await post(
      sandbox,
      "/internal/content/drafts/create",
      { contentType: "post", title: "x" },
      { "x-test-human-subject": "readonly" },
    );
    assert.equal(created.status, 403);
    const audits = sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE actor_account_id = 'sbx-readonly'",
      )
      .get().n;
    assert.equal(audits, 0);
  } finally {
    sandbox.close();
  }
});

test("optimistic versions and revision restore still work through the sandbox", async () => {
  const sandbox = await startSandbox();
  try {
    const created = await (
      await post(sandbox, "/internal/content/drafts/create", {
        contentType: "story",
        title: "Version test",
        body: "one",
      })
    ).json();
    const update = (version, body) =>
      post(sandbox, "/internal/content/drafts/update", {
        id: created.id,
        expectedVersion: version,
        changes: { body },
      });
    assert.equal((await update(1, "two")).status, 200);
    const stale = await update(1, "three");
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "version_conflict");
    const restored = await post(
      sandbox,
      "/internal/content/revisions/restore",
      {
        id: created.id,
        expectedVersion: 2,
        revisionVersion: 1,
      },
    );
    assert.equal(restored.status, 200);
    const item = await restored.json();
    assert.equal(item.version, 3);
    assert.equal(item.body, "one");
  } finally {
    sandbox.close();
  }
});

test("unknown routes are not served as editorial API calls", async () => {
  const sandbox = await startSandbox();
  try {
    // The sandbox only wires the editorial API in-process; unknown routes 404.
    const missing = await sandbox.fetch(
      new Request(`${ORIGIN}/internal/content/drafts/delete`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-editor-token": sandbox.token },
      }),
    );
    assert.equal(missing.status, 405);
  } finally {
    sandbox.close();
  }
});

test("the public application does not register the draft API", async () => {
  const response = await createApplication({}).fetch(
    new Request("https://example.invalid/internal/content/drafts/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(response.status >= 400, true);
  for (const file of ["../src/application.ts", "../src/worker.ts"]) {
    const source = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      "utf8",
    );
    assert.equal(/editor-dev|sandbox/i.test(source), false, file);
  }
});

test("createEditorSandbox accepts an explicit token for reproducible tests", async () => {
  const sandbox = await createEditorSandbox({
    staticDirectory: fileURLToPath(
      new URL("../website/editor/", import.meta.url),
    ),
    scriptDirectory: fileURLToPath(new URL("../dist/editor/", import.meta.url)),
    allowedHosts: [HOST],
    token: "fixed-token-for-test",
  });
  try {
    assert.equal(sandbox.token, "fixed-token-for-test");
  } finally {
    sandbox.close();
  }
});

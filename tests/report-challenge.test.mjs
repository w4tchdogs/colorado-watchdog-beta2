import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createReportApiModule } from "../dist/report-api.js";
import sitesWorker from "../dist/server/index.js";
import {
  CHALLENGE_ACTION,
  CHALLENGE_TOKEN_HEADER,
  createTurnstileAbuseControl,
} from "../dist/services/report-challenge.js";
import { MemoryReportIntakeStore } from "../dist/services/report-intake-memory.js";

const ORIGIN = "https://reports.example.test";
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const OUTCOMES = new Set([
  "accepted",
  "missing_token",
  "rejected",
  "expired",
  "replayed",
  "hostname_mismatch",
  "action_mismatch",
  "provider_unavailable",
  "storage_unavailable",
  "configuration_error",
]);

/** Synchronous SQLite with the D1 surface the guard uses. Not D1 itself. */
function localBinding(database, hooks = {}) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async first() {
          return database.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: database.prepare(sql).all(...values),
          };
        },
        async run() {
          hooks.beforeRun?.(sql);
          database.prepare(sql).run(...values);
          const { changes } = database
            .prepare("SELECT changes() AS changes")
            .get();
          return { success: true, meta: { changes } };
        },
        runInBatch() {
          database.prepare(sql).run(...values);
        },
      };
    },
    async batch(statements) {
      return database.transaction(() => {
        for (const statement of statements) statement.runInBatch();
        return [];
      })();
    },
  };
}

async function migrated() {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database, loadWebsiteMigrations());
  return database;
}

const siteverify = (overrides = {}, status = 200) =>
  new Response(
    JSON.stringify({
      success: true,
      hostname: "reports.example.test",
      action: CHALLENGE_ACTION,
      challenge_ts: new Date(NOW - 5_000).toISOString(),
      "error-codes": [],
      ...overrides,
    }),
    { status, headers: { "content-type": "application/json" } },
  );

function guard(database, fetchImpl, extra = {}) {
  const outcomes = [];
  const calls = [];
  const control = createTurnstileAbuseControl({
    database: new AsyncD1Database(localBinding(database, extra.hooks)),
    secret: "synthetic-secret",
    hostname: "reports.example.test",
    now: () => NOW,
    record: (outcome) => outcomes.push(outcome),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    ...extra.options,
  });
  return { control, outcomes, calls };
}

const withToken = (token) =>
  new Request(`${ORIGIN}/api/v1/reports`, {
    method: "POST",
    headers: token === null ? {} : { [CHALLENGE_TOKEN_HEADER]: token },
  });

const claims = (database) =>
  database.prepare("SELECT * FROM report_challenge_claims").all();

test("a valid token is verified with only the secret and token, then claimed by digest", async () => {
  const database = await migrated();
  const { control, outcomes, calls } = guard(database, () => siteverify());
  const token = "synthetic.token.value-1";
  assert.deepEqual(await control.check(withToken(token)), { allowed: true });
  assert.deepEqual(outcomes, ["accepted"]);
  assert.equal(calls.length, 1);
  const body = calls[0].init.body;
  assert.deepEqual([...body.keys()].sort(), ["response", "secret"]);
  assert.equal(calls[0].init.redirect, "manual");
  const rows = claims(database);
  assert.equal(rows.length, 1);
  assert.match(rows[0].token_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].token_digest, token);
  assert.doesNotMatch(JSON.stringify(rows), /synthetic\.token/);
  const seconds = Math.floor(NOW / 1000);
  assert.equal(rows[0].claimed_at, seconds);
  assert.ok(rows[0].expires_at > seconds + 300);
});

test("concurrent use of one token lets exactly one request proceed even when every provider reply is affirmative", async () => {
  const database = await migrated();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { control, outcomes, calls } = guard(database, async () => {
    await gate;
    return siteverify();
  });
  const attempts = Array.from({ length: 8 }, () =>
    control.check(withToken("synthetic-shared-token")),
  );
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(attempts);
  assert.equal(calls.length, 8);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(claims(database).length, 1);
  assert.equal(outcomes.filter((name) => name === "accepted").length, 1);
  assert.equal(outcomes.filter((name) => name === "replayed").length, 7);
  for (const result of results.filter((item) => !item.allowed))
    assert.equal(result.retryAfterSeconds, 1);
});

test("a spent token stays spent, and a fresh token is independent", async () => {
  const database = await migrated();
  const { control } = guard(database, () => siteverify());
  assert.equal((await control.check(withToken("token-a"))).allowed, true);
  assert.equal((await control.check(withToken("token-a"))).allowed, false);
  assert.equal((await control.check(withToken("token-b"))).allowed, true);
});

test("missing, malformed, rejected, expired and mismatched challenges are denied without storing a claim", async () => {
  const database = await migrated();
  const cases = [
    [null, () => siteverify(), "missing_token"],
    ["", () => siteverify(), "missing_token"],
    ["x".repeat(2049), () => siteverify(), "missing_token"],
    ["has space", () => siteverify(), "missing_token"],
    [
      "t-rejected",
      () =>
        siteverify({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
      "rejected",
    ],
    [
      "t-duplicate",
      () =>
        siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      "replayed",
    ],
    [
      "t-old",
      () => siteverify({ challenge_ts: new Date(NOW - 301_000).toISOString() }),
      "expired",
    ],
    [
      "t-future",
      () => siteverify({ challenge_ts: new Date(NOW + 61_000).toISOString() }),
      "expired",
    ],
    [
      "t-host",
      () => siteverify({ hostname: "other.example.test" }),
      "hostname_mismatch",
    ],
    ["t-action", () => siteverify({ action: "login" }), "action_mismatch"],
  ];
  for (const [token, reply, expected] of cases) {
    const { control, outcomes } = guard(database, reply);
    const result = await control.check(withToken(token));
    assert.equal(result.allowed, false, expected);
    assert.deepEqual(outcomes, [expected]);
  }
  assert.equal(claims(database).length, 0);
});

test("a token still inside the five-minute window is accepted at its edge", async () => {
  const database = await migrated();
  const { control } = guard(database, () =>
    siteverify({ challenge_ts: new Date(NOW - 300_000).toISOString() }),
  );
  assert.equal((await control.check(withToken("t-edge"))).allowed, true);
});

test("provider failures close the guard and store nothing", async () => {
  const database = await migrated();
  const failures = {
    "network error": () => {
      throw new Error("connection reset with secret detail");
    },
    "HTTP 500": () => new Response("no", { status: 500 }),
    "HTTP 429": () => new Response("slow down", { status: 429 }),
    "redirect refused": () => new Response(null, { status: 302 }),
    "malformed JSON": () => new Response("{not json"),
    "JSON array": () => new Response("[]"),
    "oversized body": () => new Response(`{"pad":"${"a".repeat(9000)}"}`),
    "missing success": () => new Response("{}"),
    "missing timestamp": () => siteverify({ challenge_ts: undefined }),
    "bad timestamp": () => siteverify({ challenge_ts: "yesterday" }),
  };
  for (const [name, reply] of Object.entries(failures)) {
    const { control, outcomes } = guard(database, reply);
    await assert.rejects(control.check(withToken("t-fail")), (error) => {
      assert.doesNotMatch(String(error.message), /secret|synthetic/);
      return true;
    });
    assert.deepEqual(outcomes, ["provider_unavailable"], name);
  }
  assert.equal(claims(database).length, 0);
});

test("provider configuration and quota errors are treated as unavailable, not as visitor denials", async () => {
  const database = await migrated();
  for (const code of [
    "invalid-input-secret",
    "missing-input-secret",
    "internal-error",
  ]) {
    const { control, outcomes } = guard(database, () =>
      siteverify({ success: false, "error-codes": [code] }),
    );
    await assert.rejects(control.check(withToken("t-config")));
    assert.deepEqual(outcomes, ["configuration_error"]);
  }
});

test("a provider that never answers is cut off by the bounded timeout", async () => {
  const database = await migrated();
  const { control, outcomes } = guard(
    database,
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
    { options: { timeoutMs: 25 } },
  );
  const started = Date.now();
  await assert.rejects(control.check(withToken("t-hang")));
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(outcomes, ["provider_unavailable"]);
});

test("storage failure closes the guard and the visitor can retry with a fresh token", async () => {
  const database = await migrated();
  let broken = true;
  const { control, outcomes } = guard(database, () => siteverify(), {
    hooks: {
      beforeRun(sql) {
        if (broken && sql.includes("INSERT INTO report_challenge_claims"))
          throw new Error("D1 unavailable");
      },
    },
  });
  await assert.rejects(control.check(withToken("t-store")));
  assert.deepEqual(outcomes, ["storage_unavailable"]);
  assert.equal(claims(database).length, 0);
  broken = false;
  assert.equal((await control.check(withToken("t-store-2"))).allowed, true);
});

test("pruning is bounded, removes only expired claims, and never blocks a submission", async () => {
  const database = await migrated();
  const seconds = Math.floor(NOW / 1000);
  for (let index = 0; index < 60; index += 1) {
    database
      .prepare(
        "INSERT INTO report_challenge_claims (token_digest, claimed_at, expires_at) VALUES (?, ?, ?)",
      )
      .run(index.toString(16).padStart(64, "0"), seconds - 1000, seconds - 10);
  }
  const live = "f".repeat(64);
  database
    .prepare(
      "INSERT INTO report_challenge_claims (token_digest, claimed_at, expires_at) VALUES (?, ?, ?)",
    )
    .run(live, seconds - 10, seconds + 100);
  const { control } = guard(database, () => siteverify());
  assert.equal((await control.check(withToken("t-prune-1"))).allowed, true);
  assert.equal(claims(database).length, 61 - 25 + 1);
  assert.ok(claims(database).some((row) => row.token_digest === live));
  const failing = guard(database, () => siteverify(), {
    hooks: {
      beforeRun(sql) {
        if (sql.startsWith("DELETE")) throw new Error("prune failed");
      },
    },
  });
  assert.equal(
    (await failing.control.check(withToken("t-prune-2"))).allowed,
    true,
  );
});

test("the claim table rejects malformed digests and impossible lifetimes", async () => {
  const database = await migrated();
  const insert = (digest, claimed, expires) =>
    database
      .prepare(
        "INSERT INTO report_challenge_claims (token_digest, claimed_at, expires_at) VALUES (?, ?, ?)",
      )
      .run(digest, claimed, expires);
  assert.throws(() => insert("short", 1, 2));
  assert.throws(() => insert("G".repeat(64), 1, 2));
  assert.throws(() => insert("a".repeat(64), 5, 5));
  insert("a".repeat(64), 5, 6);
  assert.throws(() => insert("a".repeat(64), 5, 6));
});

const submission = (key) => ({
  countyId: "synthetic-county",
  description: "Synthetic report content used only by the challenge test.",
  evidence: [{ title: "Synthetic source" }],
  reporter: {
    attribution: "anonymous",
    confidential: true,
    contactPreference: "none",
  },
  idempotencyKey: key,
});

function api(control) {
  const store = new MemoryReportIntakeStore();
  const module = createReportApiModule({
    store,
    services: {
      async listCounties() {
        return [];
      },
      async resolvePrincipal() {
        return null;
      },
      async hasCapability() {
        return false;
      },
    },
    guestSubmissions: { enabled: true, abuseControl: control },
  });
  const post = (key, token) =>
    module.fetch(
      new Request(`${ORIGIN}/api/v1/reports`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...(token ? { [CHALLENGE_TOKEN_HEADER]: token } : {}),
        },
        body: JSON.stringify(submission(key)),
      }),
    );
  return { post, store };
}

test("the report API accepts one anonymous submission per token and keeps idempotent replay across fresh tokens", async () => {
  const database = await migrated();
  const { control } = guard(database, () => siteverify());
  const { post } = api(control);
  const first = await post("challenge-key-1", "api-token-1");
  assert.equal(first.status, 201);
  const receipt = await first.json();
  assert.equal(receipt.recoveryKey.length, 64);

  // Same token with a new report is refused as a replayed challenge.
  const reused = await post("challenge-key-2", "api-token-1");
  assert.equal(reused.status, 429);
  assert.equal(reused.headers.get("retry-after"), "1");
  assert.deepEqual(await reused.json(), { error: "rate_limited" });

  // A fresh token with the original idempotency key replays the first report.
  const retried = await post("challenge-key-1", "api-token-2");
  assert.equal(retried.status, 200);
  const replay = await retried.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.reference, receipt.reference);
  assert.equal(replay.recoveryKey, undefined);
  assert.equal(claims(database).length, 2);
});

test("a spent challenge on a retry never creates a second report", async () => {
  const database = await migrated();
  const { control } = guard(database, () => siteverify());
  const { post } = api(control);
  const attempts = await Promise.all([
    post("concurrent-key-1", "api-shared"),
    post("concurrent-key-2", "api-shared"),
    post("concurrent-key-3", "api-shared"),
  ]);
  assert.deepEqual(
    attempts.map((response) => response.status).sort(),
    [201, 429, 429],
  );
});

test("provider and storage outages return the generic 503 and leak nothing", async () => {
  const database = await migrated();
  const down = guard(database, () => new Response("no", { status: 503 }));
  const response = await api(down.control).post("outage-key", "api-token-x");
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "service_unavailable" });
  assert.doesNotMatch(text, /api-token-x|synthetic-secret|siteverify/);
  assert.equal(claims(database).length, 0);
});

test("a missing token is denied before the request body is read", async () => {
  const database = await migrated();
  const { control, calls } = guard(database, () => siteverify());
  const response = await api(control).post("no-token-key", undefined);
  assert.equal(response.status, 429);
  assert.equal(calls.length, 0);
});

// Worker wiring: default-off switch, complete configuration, widget scope.

function workerEnvironment(database, extra = {}) {
  return { DB: localBinding(database), ...extra };
}
const ENABLED = {
  REPORTS_TURNSTILE: "enabled",
  REPORTS_TURNSTILE_SITEKEY: "0x4AAAAAAA-synthetic_sitekey",
  REPORTS_TURNSTILE_SECRET: "synthetic-widget-secret",
  REPORTS_TURNSTILE_ORIGIN: ORIGIN,
};
const getPage = (path, environment) =>
  sitesWorker.fetch(new Request(`${ORIGIN}${path}`), environment);
const csp = (response) => response.headers.get("content-security-policy") ?? "";

test("with the switch off the Worker keeps today's closed behavior and never exposes the widget", async () => {
  const database = await migrated();
  for (const extra of [
    {},
    { ...ENABLED, REPORTS_TURNSTILE: "disabled" },
    { ...ENABLED, REPORTS_TURNSTILE: "ENABLED" },
    { ...ENABLED, REPORTS_TURNSTILE: "true" },
  ]) {
    const environment = workerEnvironment(database, extra);
    const page = await getPage("/submit-report", environment);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /data-report-enabled="false"/);
    assert.doesNotMatch(html, /sitekey|0x4AAAAAAA/);
    assert.doesNotMatch(csp(page), /challenges\.cloudflare\.com/);
    const post = await sitesWorker.fetch(
      new Request(`${ORIGIN}/api/v1/reports`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(submission("off-key")),
      }),
      environment,
    );
    assert.equal(post.status, 503);
    assert.deepEqual(await post.json(), { error: "submission_unavailable" });
  }
});

test("when enabled the sitekey and widget origin appear on the submission page only", async () => {
  const database = await migrated();
  const environment = workerEnvironment(database, ENABLED);
  const submit = await getPage("/submit-report", environment);
  const html = await submit.text();
  assert.match(html, /data-report-enabled="true"/);
  assert.match(
    html,
    /data-report-challenge-sitekey="0x4AAAAAAA-synthetic_sitekey"/,
  );
  assert.doesNotMatch(html, /synthetic-widget-secret/);
  assert.match(
    csp(submit),
    /script-src 'self' https:\/\/challenges\.cloudflare\.com;/,
  );
  assert.match(csp(submit), /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp(submit), /connect-src 'self';/);
  assert.match(csp(submit), /frame-ancestors 'none'/);

  for (const path of ["/track-report", "/", "/counties", "/about"]) {
    const other = await getPage(path, environment);
    const text = await other.text();
    assert.doesNotMatch(csp(other), /challenges\.cloudflare\.com/, path);
    assert.doesNotMatch(text, /sitekey/, path);
  }
  const track = await (await getPage("/track-report", environment)).text();
  assert.match(track, /data-report-enabled="true"/);
});

test("incomplete or unsafe configuration keeps intake closed", async () => {
  const database = await migrated();
  const broken = [
    { ...ENABLED, REPORTS_TURNSTILE_SECRET: "" },
    { ...ENABLED, REPORTS_TURNSTILE_SECRET: undefined },
    { ...ENABLED, REPORTS_TURNSTILE_SITEKEY: undefined },
    { ...ENABLED, REPORTS_TURNSTILE_SITEKEY: 'bad"key' },
    { ...ENABLED, REPORTS_TURNSTILE_ORIGIN: undefined },
    { ...ENABLED, REPORTS_TURNSTILE_ORIGIN: "not a url" },
    { ...ENABLED, REPORTS_TURNSTILE_ORIGIN: "http://reports.example.test" },
    { ...ENABLED, REPORTS_TURNSTILE_ORIGIN: `${ORIGIN}/path` },
    { ...ENABLED, REPORTS_TURNSTILE_ORIGIN: `${ORIGIN}/?x=1` },
    // A verifier override outside the disposable test environment is ignored
    // and never trusted, so the real endpoint would be used. Config stays valid
    // only when the override is absent, so assert the closed cases above and
    // that a non-loopback override under test is refused below.
    {
      ...ENABLED,
      APP_ENV: "test",
      REPORTS_TEST_TURNSTILE_VERIFY_URL: "http://203.0.113.9/siteverify",
    },
    {
      ...ENABLED,
      APP_ENV: "test",
      REPORTS_TEST_TURNSTILE_VERIFY_URL: "https://127.0.0.1/siteverify",
    },
  ];
  for (const extra of broken) {
    const page = await getPage(
      "/submit-report",
      workerEnvironment(database, extra),
    );
    const html = await page.text();
    assert.match(html, /data-report-enabled="false"/);
    assert.doesNotMatch(html, /sitekey/);
    assert.doesNotMatch(csp(page), /challenges\.cloudflare\.com/);
  }
});

test("the enabled Worker closes any other host and refuses a missing token without contacting storage for claims", async () => {
  const database = await migrated();
  const environment = workerEnvironment(database, ENABLED);
  const other = await sitesWorker.fetch(
    new Request("https://elsewhere.example.test/api/v1/reports", {
      method: "POST",
      headers: {
        origin: "https://elsewhere.example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify(submission("other-host")),
    }),
    environment,
  );
  assert.equal(other.status, 429);
  const missing = await sitesWorker.fetch(
    new Request(`${ORIGIN}/api/v1/reports`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(submission("missing-token")),
    }),
    environment,
  );
  assert.equal(missing.status, 429);
  assert.equal(claims(database).length, 0);
});

test("outcome names are the only thing the guard reports", () => {
  for (const name of OUTCOMES) assert.match(name, /^[a-z_]+$/);
});

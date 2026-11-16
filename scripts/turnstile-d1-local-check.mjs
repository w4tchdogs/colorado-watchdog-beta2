import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// SUB-3 local acceptance. Runs the built Sites Worker in Wrangler's local
// runtime against a disposable local D1 database and a synthetic Siteverify
// server on loopback. No provider account, credential or hosted resource.
const root = fileURLToPath(new URL("../", import.meta.url));
const config = join(root, "wrangler.sites-test.toml");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const persist = mkdtempSync(join(tmpdir(), "watchdog-turnstile-d1-"));
const SECRET = "synthetic-local-widget-secret";
const SITEKEY = "synthetic-local-sitekey";
let worker;
let verifier;

function cleanup() {
  try {
    rmSync(persist, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 250,
    });
  } catch (error) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    console.warn(
      "Wrangler still holds a disposable local-state file; operating-system temp cleanup will remove it after release.",
    );
  }
}

function command(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
  });
  if (result.status !== 0)
    throw new Error(
      `Wrangler failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

function sql(statement) {
  const output = command([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    persist,
    "--json",
    "--command",
    statement,
  ]);
  return JSON.parse(output)[0]?.results ?? [];
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (worker.exitCode !== null)
      throw new Error(`Wrangler exited early with ${worker.exitCode}`);
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {}
    await delay(200);
  }
  throw new Error("The local Sites Worker did not start");
}

/** Ends the Wrangler process tree. SIGTERM alone leaves workerd running on Windows. */
async function killWorker(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {}
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, delay(10_000)]);
}

/** Synthetic Siteverify. The token prefix selects the provider behavior. */
function startVerifier(hostname) {
  const requests = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      requests.push({
        method: request.method,
        type: request.headers["content-type"],
        keys: [...form.keys()].sort(),
        secretMatches: form.get("secret") === SECRET,
      });
      const token = form.get("response") ?? "";
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const ok = {
        success: true,
        hostname,
        action: "submit-report",
        challenge_ts: new Date().toISOString(),
        "error-codes": [],
      };
      if (token.startsWith("outage-")) return reply(500, {});
      if (token.startsWith("denied-"))
        return reply(200, {
          success: false,
          "error-codes": ["invalid-input-response"],
        });
      if (token.startsWith("expired-"))
        return reply(200, {
          ...ok,
          challenge_ts: new Date(Date.now() - 400_000).toISOString(),
        });
      if (token.startsWith("hostname-"))
        return reply(200, { ...ok, hostname: "other.example.test" });
      // Every other token is affirmative. A short pause lets concurrent
      // submissions of one token all reach the claim step as affirmative.
      setTimeout(() => reply(200, ok), token.startsWith("race-") ? 400 : 0);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, port: server.address().port }),
    );
  });
}

const report = (key) => ({
  countyId: "08001",
  description: "Synthetic fictional report content for the Turnstile check.",
  evidence: [{ title: "Synthetic source" }],
  reporter: {
    attribution: "anonymous",
    confidential: true,
    contactPreference: "none",
  },
  idempotencyKey: key,
});

async function main() {
  const migrations = (
    await import("node:fs/promises").then((fs) =>
      fs.readdir(join(root, "website", "migrations")),
    )
  )
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  assert.equal(migrations.at(-1), "0021_report_challenge_claims.sql");
  const migrationFile = join(persist, "website-migrations.sql");
  writeFileSync(
    migrationFile,
    migrations
      .map((name) =>
        readFileSync(join(root, "website", "migrations", name), "utf8"),
      )
      .join("\n"),
  );
  command([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    persist,
    "--file",
    migrationFile,
  ]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  verifier = await startVerifier("127.0.0.1");
  const startWorker = async (variables) => {
    worker = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--config",
        config,
        "--persist-to",
        persist,
        ...Object.entries(variables).flatMap(([key, value]) => [
          "--var",
          `${key}:${value}`,
        ]),
      ],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
      },
    );
    await waitFor(`${base}/`);
  };
  const stopWorker = async () => {
    await killWorker(worker);
  };
  const post = (key, token) =>
    fetch(`${base}/api/v1/reports`, {
      method: "POST",
      headers: {
        // A fresh connection each time: the synchronous wrangler D1 calls
        // between requests can leave a reused local socket reset.
        connection: "close",
        origin: base,
        "content-type": "application/json",
        ...(token ? { "x-turnstile-token": token } : {}),
      },
      body: JSON.stringify(report(key)),
    });
  const claims = () => sql("SELECT * FROM report_challenge_claims");
  const reportCount = () =>
    Number(sql("SELECT COUNT(*) AS n FROM reports")[0].n);

  // Switch on, with synthetic provider responses.
  await startWorker({
    REPORTS_TURNSTILE: "enabled",
    REPORTS_TURNSTILE_SITEKEY: SITEKEY,
    REPORTS_TURNSTILE_SECRET: SECRET,
    REPORTS_TURNSTILE_ORIGIN: base,
    REPORTS_TEST_TURNSTILE_VERIFY_URL: `http://127.0.0.1:${verifier.port}/siteverify`,
  });
  try {
    const page = await fetch(`${base}/submit-report`);
    const html = await page.text();
    assert.match(
      html,
      new RegExp(`data-report-challenge-sitekey="${SITEKEY}"`),
    );
    assert.doesNotMatch(html, new RegExp(SECRET));
    const policy = page.headers.get("content-security-policy") ?? "";
    assert.match(
      policy,
      /script-src 'self' https:\/\/challenges\.cloudflare\.com;/,
    );
    assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com;/);
    const track = await fetch(`${base}/track-report`);
    assert.doesNotMatch(await track.text(), /sitekey/);
    assert.doesNotMatch(
      track.headers.get("content-security-policy") ?? "",
      /challenges\.cloudflare\.com/,
    );

    // No token: refused before the provider or storage is touched.
    const providerCalls = verifier.requests.length;
    assert.equal((await post("missing-token-key")).status, 429);
    assert.equal(verifier.requests.length, providerCalls);
    assert.equal(reportCount(), 0);

    // Valid submission.
    const valid = await post("local-valid-key", "valid-token-1");
    assert.equal(valid.status, 201, await valid.clone().text());
    const receipt = await valid.json();
    assert.match(receipt.reference, /^CW-/);
    assert.equal(receipt.recoveryKey.length, 64);
    assert.equal(reportCount(), 1);
    const stored = claims();
    assert.equal(stored.length, 1);
    assert.match(stored[0].token_digest, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(stored), /valid-token-1/);
    const sent = verifier.requests.at(-1);
    assert.equal(sent.method, "POST");
    assert.equal(sent.type, "application/x-www-form-urlencoded");
    assert.deepEqual(sent.keys, ["response", "secret"]);
    assert.equal(sent.secretMatches, true);

    // Sequential reuse of the spent token.
    assert.equal(
      (await post("local-valid-key-2", "valid-token-1")).status,
      429,
    );
    assert.equal(reportCount(), 1);

    // Fresh token, original idempotency key: replay without a new recovery key.
    const retry = await post("local-valid-key", "valid-token-2");
    assert.equal(retry.status, 200);
    const replay = await retry.json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.reference, receipt.reference);
    assert.equal(replay.recoveryKey, undefined);
    assert.equal(reportCount(), 1);

    // Concurrent reuse while every provider reply is affirmative.
    const before = reportCount();
    const providerBefore = verifier.requests.length;
    const racing = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(`local-race-key-${index}`, "race-token-1"),
      ),
    );
    const statuses = racing.map((response) => response.status).sort();
    assert.deepEqual(statuses, [201, 429, 429, 429, 429, 429]);
    assert.equal(
      verifier.requests.length - providerBefore,
      6,
      "every concurrent request reached an affirmative provider reply",
    );
    assert.equal(reportCount(), before + 1);
    assert.equal(
      claims().filter((row) => row.claimed_at && row.expires_at).length,
      3,
    );

    // Expired, denied and mismatched challenges never create a report.
    for (const token of [
      "expired-token-1",
      "denied-token-1",
      "hostname-token-1",
    ]) {
      const denied = await post(`local-${token}`, token);
      assert.equal(denied.status, 429, token);
      assert.equal(denied.headers.get("retry-after"), "1");
      assert.deepEqual(await denied.json(), { error: "rate_limited" });
    }
    assert.equal(reportCount(), before + 1);
    assert.equal(claims().length, 3);

    // Provider failure closes intake with a generic response.
    const outage = await post("local-outage-key", "outage-token-1");
    assert.equal(outage.status, 503);
    assert.deepEqual(await outage.json(), { error: "service_unavailable" });
    assert.equal(reportCount(), before + 1);

    // Storage failure: the claim table disappears, intake closes, then recovers.
    sql(
      "ALTER TABLE report_challenge_claims RENAME TO report_challenge_claims_offline",
    );
    const storage = await post("local-storage-key", "valid-token-3");
    assert.equal(storage.status, 503);
    assert.deepEqual(await storage.json(), { error: "service_unavailable" });
    assert.equal(reportCount(), before + 1);
    sql(
      "ALTER TABLE report_challenge_claims_offline RENAME TO report_challenge_claims",
    );
    const recovered = await post("local-storage-key", "valid-token-4");
    assert.equal(recovered.status, 201);
    assert.equal(reportCount(), before + 2);
  } finally {
    await stopWorker();
  }

  // Switch off (the default): today's behavior and no widget anywhere.
  await startWorker({
    REPORTS_TURNSTILE: "disabled",
    REPORTS_TURNSTILE_SITEKEY: SITEKEY,
    REPORTS_TURNSTILE_SECRET: SECRET,
    REPORTS_TURNSTILE_ORIGIN: base,
    REPORTS_TEST_TURNSTILE_VERIFY_URL: `http://127.0.0.1:${verifier.port}/siteverify`,
  });
  try {
    const page = await fetch(`${base}/submit-report`);
    assert.doesNotMatch(await page.text(), /sitekey/);
    assert.doesNotMatch(
      page.headers.get("content-security-policy") ?? "",
      /challenges\.cloudflare\.com/,
    );
    const providerCalls = verifier.requests.length;
    const total = reportCount();
    // The disposable test Worker's loopback gate behaves exactly as before.
    const unchanged = await post("local-disabled-key");
    assert.equal(unchanged.status, 201);
    assert.equal(verifier.requests.length, providerCalls);
    assert.equal(reportCount(), total + 1);
  } finally {
    await stopWorker();
  }

  console.log(
    "PASS local Turnstile intake: valid, concurrent reuse, expiry, denial, provider outage, storage failure, retry, and disabled state against disposable local D1",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (worker) await killWorker(worker);
    verifier?.server.close();
    cleanup();
  });

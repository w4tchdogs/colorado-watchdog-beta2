import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = join(root, "wrangler.d1-test.toml");
const persist = mkdtempSync(join(tmpdir(), "watchdog-d1-local-"));
const migrationsDirectory = join(root, "website", "migrations");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const migrations = [
  "0001_counties.sql",
  "0002_foundation.sql",
  "0003_county_fips_prefix.sql",
  "0004_m1_county_roles.sql",
  "0005_m2_sync_batches.sql",
  "0006_m2_sync_reversals.sql",
  "0007_m2_duplicate_flags.sql",
  "0008_duplicate_flag_observations.sql",
  "0009_content_foundation.sql",
];

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
  });
  if (result.status !== 0) {
    throw new Error(
      `Wrangler failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function checksum(sql) {
  return createHash("sha256")
    .update(sql.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitForWorker(url, process) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null)
      throw new Error(`Wrangler dev exited early (${process.exitCode})`);
    try {
      const response = await fetch(`${url}/read`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Wrangler local Worker did not start: ${lastError}`);
}

async function main() {
  const history = `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')) STRICT;`;
  const sections = [history];
  for (const [index, name] of migrations.entries()) {
    const path = join(migrationsDirectory, name);
    const sql = readFileSync(path, "utf8");
    const escapedName = name.replaceAll("'", "''");
    sections.push(sql);
    sections.push(
      `INSERT INTO schema_migrations (version, name, sha256) VALUES (${index + 1}, '${escapedName}', '${checksum(sql)}');`,
    );
    if (index === 6) {
      sections.push(`
        INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-backfill-actor', 'human', 'contributor', 'Synthetic Backfill Actor');
        INSERT INTO people (id, display_name) VALUES ('d1-backfill-person-a', 'Synthetic Person A'), ('d1-backfill-person-b', 'Synthetic Person B');
        INSERT INTO sync_batches (id, actor_account_id, idempotency_key, request_fingerprint, contract_version, request_id, status, committed_at, result_json)
          VALUES ('d1-backfill-batch', 'd1-backfill-actor', 'd1-backfill-key', '${"a".repeat(64)}', 'm2-sync/v1', 'd1-backfill-request', 'committed', '2026-11-13T00:00:00.000Z', '{}');
        INSERT INTO person_duplicate_flags (id, person_id, possible_duplicate_person_id, pair_low_id, pair_high_id, category, reason, nonblocking, origin_batch_id, origin_actor_account_id, created_at, updated_at, status_changed_at, status_changed_by_account_id)
          VALUES ('d1-backfill-flag', 'd1-backfill-person-a', 'd1-backfill-person-b', 'd1-backfill-person-a', 'd1-backfill-person-b', 'possible_match', 'Synthetic legacy observation', 1, 'd1-backfill-batch', 'd1-backfill-actor', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'd1-backfill-actor');
      `);
    }
  }
  const migrationFile = join(persist, "website-migrations.sql");
  writeFileSync(migrationFile, sections.join("\n"));
  runWrangler([
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

  const port = await unusedPort();
  const worker = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--config",
      config,
      "--local",
      "--persist-to",
      persist,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  let workerOutput = "";
  worker.stdout.setEncoding("utf8").on("data", (chunk) => {
    workerOutput += chunk;
  });
  worker.stderr.setEncoding("utf8").on("data", (chunk) => {
    workerOutput += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForWorker(base, worker);
    const checks = await fetch(`${base}/verify`);
    const responseBody = await checks.text();
    let detail;
    try {
      detail = JSON.parse(responseBody);
    } catch {
      const message =
        responseBody.match(/D1 check failed:[^<]*/)?.[0] ??
        responseBody.slice(0, 200);
      throw new Error(
        `Local Worker returned HTTP ${checks.status}: ${message}\n${workerOutput.slice(-2_000)}`,
      );
    }
    if (!checks.ok || !detail.success) throw new Error(JSON.stringify(detail));
    const write = await fetch(`${base}/write`, { method: "POST" });
    const inserted = await write.json();
    const read = await fetch(`${base}/read`);
    const persisted = await read.json();
    if (!write.ok || inserted.version !== 1 || persisted?.id !== inserted?.id) {
      throw new Error(
        "Local D1 state did not survive separate Worker requests",
      );
    }
    console.log(
      `PASS local Wrangler D1: migrations 0001–0009; ${detail.checks.length} API checks; state persisted across requests`,
    );
  } finally {
    if (process.platform === "win32" && worker.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {}
    } else {
      try {
        process.kill(-worker.pid, "SIGTERM");
      } catch {}
    }
    await Promise.race([
      new Promise((resolveExit) => worker.once("exit", resolveExit)),
      delay(5_000),
    ]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(persist, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4 || error.code !== "EBUSY") {
          console.error(
            `Unable to remove disposable D1 state: ${error.message}`,
          );
          process.exitCode = 1;
          break;
        }
        await delay(250 * (attempt + 1));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

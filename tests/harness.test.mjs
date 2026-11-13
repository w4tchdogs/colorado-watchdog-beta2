import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";

test("local harness forwards authentication headers and JSON request bodies", {
  timeout: 15_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-harness-"));
  const databasePath = join(directory, "synthetic-website.sqlite");
  const secret = `cwa_${"A".repeat(43)}`;
  const database = await openWebsiteDatabase(databasePath);
  migrateWebsiteDatabase(database);
  database
    .prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES ('harness-agent', 'agent', 'administrator', 'Synthetic Harness Agent')",
    )
    .run();
  database
    .prepare(
      `INSERT INTO identities
           (id, account_id, provider, subject, credential_hash)
         VALUES ('harness-key', 'harness-agent', 'agent-key', 'harness-key', ?)`,
    )
    .run(createHash("sha256").update(secret, "utf8").digest("hex"));
  database.close();

  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const address = portServer.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    portServer.close((error) => (error ? reject(error) : resolve())),
  );

  const child = spawn(process.execPath, ["scripts/dev.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });

  try {
    let ready = false;
    const deadline = Date.now() + 5_000;
    while (!ready && Date.now() < deadline) {
      try {
        ready =
          (await fetch(`http://127.0.0.1:${port}/_internal/ready`)).status ===
          200;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(ready, true, `local harness did not become ready: ${output}`);

    const principal = await fetch(
      `http://127.0.0.1:${port}/_internal/principal`,
      { headers: { authorization: `Bearer ${secret}` } },
    );
    assert.equal(principal.status, 200);
    assert.deepEqual(await principal.json(), {
      accountId: "harness-agent",
      kind: "agent",
      role: "administrator",
    });

    const created = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "agent",
        role: "contributor",
        displayName: "Synthetic Forwarded Body",
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(
      (await created.json()).displayName,
      "Synthetic Forwarded Body",
    );
    assert.equal(output.includes(secret), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        childExit,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

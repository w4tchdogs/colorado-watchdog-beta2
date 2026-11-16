import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const python = process.env.WATCHDOG_PROFILES_PYTHON ?? "python";

test("Profiles MCP stdio serves aggregate readiness over the SDK client without writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-mcp-profiles-"));
  const databasePath = join(directory, "synthetic.sqlite");
  const fixture = join(root, "tests", "mcp-profiles-fixture.py");
  execFileSync(python, [fixture, databasePath], {
    cwd: root,
    windowsHide: true,
  });
  const before = createHash("sha256")
    .update(await readFile(databasePath))
    .digest("hex");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "mcp", "profiles-stdio.js")],
    cwd: root,
    env: { ...process.env, WATCHDOG_PROFILES_DATABASE: databasePath },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-1-synthetic-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["profiles_readiness_summary"],
    );
    const result = await client.callTool({
      name: "profiles_readiness_summary",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const summary = result.structuredContent?.result;
    assert.equal(summary.databaseReadiness, "ready");
    assert.equal(summary.readOnlyPreviewPossible, true);
    assert.equal(summary.eligibleCount, 0);
    assert.equal(summary.excludedCount, 0);
    assert.equal(summary.changesetLimit.maxChanges, null);
    assert.equal(JSON.stringify(result).includes(databasePath), false);
    const after = createHash("sha256")
      .update(await readFile(databasePath))
      .digest("hex");
    assert.equal(after, before);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Profiles MCP refuses an unconfigured database without exposing the path", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "mcp", "profiles-stdio.js")],
    cwd: root,
    env: { ...process.env, WATCHDOG_PROFILES_DATABASE: "" },
    stderr: "pipe",
  });
  const client = new Client({
    name: "mcp-1-missing-db-test",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "profiles_readiness_summary",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /database_not_configured/);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

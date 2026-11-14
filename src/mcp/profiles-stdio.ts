import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const outputSchema = z.object({ result: z.unknown() }).strict();

export function createProfilesStdioServer(
  options: {
    databasePath?: string;
    pythonExecutable?: string;
    cwd?: string;
  } = {},
) {
  const server = new McpServer(
    { name: "colorado-watchdog-profiles", version: "1.0.0" },
    { maxToolInputElements: 4 },
  );
  server.registerTool(
    "profiles_readiness_summary",
    {
      title: "Profiles readiness summary",
      description:
        "Return aggregate, read-only Profiles synchronization readiness for the configured private SQLite database. No person records, evidence, notes, paths or synchronization payloads are returned.",
      inputSchema: z.object({}).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const databasePath =
        options.databasePath ?? process.env.WATCHDOG_PROFILES_DATABASE;
      if (!databasePath || !isAbsolute(databasePath)) {
        return errorResult("database_not_configured");
      }
      const resolvedDatabase = resolve(databasePath);
      const fromRepository = relative(repositoryRoot, resolvedDatabase);
      if (
        fromRepository === "" ||
        (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
      ) {
        return errorResult("database_path_not_private");
      }
      try {
        const python =
          options.pythonExecutable ??
          process.env.WATCHDOG_PROFILES_PYTHON ??
          "python";
        const { stdout } = await execFileAsync(
          python,
          ["-m", "research", "mcp-readiness-summary", resolvedDatabase],
          {
            cwd: options.cwd ?? repositoryRoot,
            encoding: "utf8",
            timeout: 15_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
            env: {
              PATH: process.env.PATH ?? "",
              SystemRoot: process.env.SystemRoot ?? "",
              WINDIR: process.env.WINDIR ?? "",
              PYTHONUTF8: "1",
              PYTHONIOENCODING: "utf-8",
            },
          },
        );
        const value: unknown = JSON.parse(stdout);
        if (!isReadinessSummary(value))
          return errorResult("database_incompatible");
        return boundedResult(value);
      } catch {
        return errorResult("database_unavailable");
      }
    },
  );
  return server;
}

function isReadinessSummary(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.databaseReadiness === "ready" &&
    Number.isSafeInteger(record.eligibleCount) &&
    Number.isSafeInteger(record.excludedCount) &&
    Number.isSafeInteger(record.changesetSizeBytes) &&
    Array.isArray(record.selectedCountyFips) &&
    typeof record.readOnlyPreviewPossible === "boolean"
  );
}

function boundedResult(value: unknown) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > 16 * 1024) {
    return errorResult("result_too_large");
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { result: value },
  };
}

function errorResult(code: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: code }) }],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createProfilesStdioServer();
  await server.connect(new StdioServerTransport());
}

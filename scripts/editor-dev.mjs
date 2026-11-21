import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createEditorSandbox } from "../dist/editor-dev/sandbox.js";
import {
  createDraftSitePreview,
  createSitePreview,
} from "../dist/site-dev/preview.js";

// The sandbox ignores DATABASE_PATH and hosted settings. Draft review takes
// an explicit directory and uses a dedicated local file.
if (/^production$/i.test(process.env.APP_ENV ?? process.env.NODE_ENV ?? "")) {
  console.error(
    "Refusing to start: the dashboard sandbox never runs in a production environment.",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (
  args.length &&
  (args.length !== 2 || args[0] !== "--draft-review" || !args[1])
)
  throw new Error(
    "Usage: npm run editor:dev -- --draft-review <local-directory>",
  );
const draftDirectory = args[1];

const host = "127.0.0.1";
const port = Number(process.env.EDITOR_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("EDITOR_PORT must be an integer between 1 and 65535");
}

// The public preview runs beside the dashboard. Draft review shares the
// local file, while the fictional preview keeps its own fixture database.
const sitePort = Number(process.env.SITE_PORT ?? 8790);
if (
  !Number.isInteger(sitePort) ||
  sitePort < 1 ||
  sitePort > 65535 ||
  sitePort === port
) {
  throw new Error(
    "SITE_PORT must be an integer between 1 and 65535 and differ from EDITOR_PORT",
  );
}
const publicSiteUrl = `http://${host}:${sitePort}/`;
const draftDatabase = draftDirectory
  ? (
      await import("../dist/editor-dev/draft-database.js")
    ).openDraftPreviewDatabase(draftDirectory)
  : undefined;

const sandbox = await createEditorSandbox({
  draftDatabase,
  publicSiteUrl,
  staticDirectory: fileURLToPath(
    new URL("../website/editor/", import.meta.url),
  ),
  scriptDirectory: fileURLToPath(new URL("../dist/editor/", import.meta.url)),
  allowedHosts: [`${host}:${port}`, `localhost:${port}`],
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method ?? "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined || name === "host") continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        headers.append(name, entry);
      }
    }
    const chunks = [];
    let size = 0;
    if (method !== "GET" && method !== "HEAD") {
      for await (const chunk of incoming) {
        size += chunk.length;
        // Stage uploads carry a full banner image (25 MiB limit + overhead).
        if (size > 27_262_976) {
          outgoing.writeHead(413, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: "request_too_large" }));
          return;
        }
        chunks.push(chunk);
      }
    }
    const request = new Request(
      `http://${incoming.headers.host ?? "invalid.invalid"}${incoming.url ?? "/"}`,
      {
        method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      },
    );
    const response = await sandbox.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    // Raw bytes, never text: private banner previews are binary images.
    outgoing.end(
      method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()),
    );
  } catch {
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.listen(port, host, () => {
  console.log(
    draftDatabase
      ? "Private local draft dashboard running at:"
      : "Dashboard sandbox (fictional data, in-memory) running at:",
  );
  console.log(`  http://${host}:${port}/`);
  console.log(
    draftDatabase
      ? "Press Ctrl+C to stop. Draft edits are saved in website-draft.sqlite."
      : "Press Ctrl+C to stop. All sandbox data is discarded on exit.",
  );
});

const staticDirectory = fileURLToPath(
  new URL("../website/site/", import.meta.url),
);
const sitePreview = draftDatabase
  ? createDraftSitePreview(
      sandbox.database,
      staticDirectory,
      sandbox.bannerStorage,
    )
  : await createSitePreview({
      staticDirectory,
      data: "fictional",
      countyStructure: sandbox.countyStructure,
    });
const siteServer = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      incoming.resume();
      if (draftDatabase) {
        outgoing.writeHead(405, { allow: "GET, HEAD" });
        outgoing.end();
        return;
      }
    }
    if (
      draftDatabase &&
      ![`${host}:${sitePort}`, `localhost:${sitePort}`].includes(
        incoming.headers.host,
      )
    ) {
      outgoing.writeHead(403);
      outgoing.end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined || name === "host" || name === "connection") {
        continue;
      }
      for (const entry of Array.isArray(value) ? value : [value]) {
        headers.append(name, entry);
      }
    }
    // The preview is read-only, so request bodies are never forwarded.
    const response = await sitePreview.fetch(
      new Request(`http://${host}:${sitePort}${incoming.url ?? "/"}`, {
        method,
        headers,
      }),
    );
    const responseHeaders = Object.fromEntries(response.headers);
    if (draftDatabase) {
      responseHeaders["cache-control"] = "no-store";
      responseHeaders["referrer-policy"] = "no-referrer";
      responseHeaders["cross-origin-resource-policy"] = "same-origin";
    }
    outgoing.writeHead(response.status, responseHeaders);
    outgoing.end(
      method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()),
    );
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Internal error");
  }
});
siteServer.on("error", (error) => {
  if (draftDatabase) {
    console.error(
      `Could not start the private public-page preview on port ${sitePort}. Stop the other preview or choose a different SITE_PORT.`,
    );
    shutdown();
    process.exit(1);
  }
  // Another preview (for example `npm run site:dev`) may already hold the
  // port. The dashboard keeps working and its link points at that preview.
  console.log(
    error?.code === "EADDRINUSE"
      ? `Public site preview not started: port ${sitePort} is already in use.`
      : "Public site preview not started.",
  );
});
siteServer.listen(sitePort, host, () => {
  console.log(
    draftDatabase
      ? "Private local public-page preview (read-only) running at:"
      : "Fictional public site preview (read-only) running at:",
  );
  console.log(`  ${publicSiteUrl}`);
});

let closed = false;
function shutdown() {
  if (closed) return;
  closed = true;
  server.close();
  siteServer.close();
  sandbox.close();
  if (!draftDatabase) sitePreview.close();
}
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);

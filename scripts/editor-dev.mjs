import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createEditorSandbox } from "../dist/editor-dev/sandbox.js";
import { createSitePreview } from "../dist/site-dev/preview.js";

// The sandbox deliberately ignores DATABASE_PATH and every other production
// setting. It only ever uses a fresh, disposable in-memory database.
if (/^production$/i.test(process.env.APP_ENV ?? process.env.NODE_ENV ?? "")) {
  console.error(
    "Refusing to start: the dashboard sandbox never runs in a production environment.",
  );
  process.exit(1);
}

const host = "127.0.0.1";
const port = Number(process.env.EDITOR_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("EDITOR_PORT must be an integer between 1 and 65535");
}

// The fictional public site preview runs beside the dashboard so the "View
// public site" link has a local destination. It is the same read-only preview
// as `npm run site:dev`, with its own separate in-memory database.
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

const sandbox = await createEditorSandbox({
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
        if (size > 700_000) {
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
    outgoing.end(method === "HEAD" ? undefined : await response.text());
  } catch {
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.listen(port, host, () => {
  console.log(`Dashboard sandbox (fictional data, in-memory) running at:`);
  console.log(`  http://${host}:${port}/`);
  console.log("Press Ctrl+C to stop. All sandbox data is discarded on exit.");
});

const sitePreview = await createSitePreview({
  staticDirectory: fileURLToPath(new URL("../website/site/", import.meta.url)),
  data: "fictional",
});
const siteServer = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") incoming.resume();
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
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(
      method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()),
    );
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Internal error");
  }
});
siteServer.on("error", (error) => {
  // Another preview (for example `npm run site:dev`) may already hold the
  // port. The dashboard keeps working and its link points at that preview.
  console.log(
    error?.code === "EADDRINUSE"
      ? `Public site preview not started: port ${sitePort} is already in use.`
      : "Public site preview not started.",
  );
});
siteServer.listen(sitePort, host, () => {
  console.log(`Fictional public site preview (read-only) running at:`);
  console.log(`  ${publicSiteUrl}`);
});

let closed = false;
function shutdown() {
  if (closed) return;
  closed = true;
  server.close();
  siteServer.close();
  sandbox.close();
  sitePreview.close();
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

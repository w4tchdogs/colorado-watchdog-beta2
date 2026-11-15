import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createSitePreview } from "../dist/site-dev/preview.js";

// The preview ignores DATABASE_PATH and every production setting. It only
// ever uses a fresh, disposable in-memory Website database.
if (/^production$/i.test(process.env.APP_ENV ?? process.env.NODE_ENV ?? "")) {
  console.error(
    "Refusing to start: the public site preview never runs in a production environment.",
  );
  process.exit(1);
}

const host = "127.0.0.1";
const port = Number(process.env.SITE_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("SITE_PORT must be an integer between 1 and 65535");
}
const empty = process.argv.includes("--empty");
const bannerFixtures = process.argv.includes("--banner-fixtures");
const homeBannerFixtures = !process.argv.includes("--no-home-banners");

const preview = await createSitePreview({
  staticDirectory: fileURLToPath(new URL("../website/site/", import.meta.url)),
  data: empty ? "empty" : "fictional",
  bannerFixtures,
  homeBannerFixtures,
});

const server = createServer(async (incoming, outgoing) => {
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
    const response = await preview.fetch(
      new Request(`http://${host}:${port}${incoming.url ?? "/"}`, {
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

server.listen(port, host, () => {
  console.log(
    empty
      ? "Colorado Watchdog public site preview (empty database, in-memory):"
      : "Colorado Watchdog public site preview (fictional data, in-memory):",
  );
  console.log(`  http://${host}:${port}/`);
  if (bannerFixtures) {
    console.log(
      "  Synthetic banner test patterns are shown on the homepage and for Adams, Boulder, Larimer and Weld counties.",
    );
    if (!homeBannerFixtures) {
      console.log(
        "  Homepage banners are off (--no-home-banners): branded fallback.",
      );
    }
  }
  console.log("Press Ctrl+C to stop. All preview data is discarded on exit.");
});

let closed = false;
function shutdown() {
  if (closed) return;
  closed = true;
  server.close();
  preview.close();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}
process.on("exit", shutdown);

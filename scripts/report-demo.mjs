import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServices } from "../dist/services/index.js";
import { createSitePreview } from "../dist/site-dev/preview.js";

if (/^production$/i.test(process.env.APP_ENV ?? process.env.NODE_ENV ?? "")) {
  throw new Error(
    "The report interface demonstration cannot run in production.",
  );
}

const host = "127.0.0.1";
const port = Number(process.env.REPORT_DEMO_PORT ?? 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("REPORT_DEMO_PORT must be an integer between 1 and 65535");
}

const siteDirectory = fileURLToPath(
  new URL("../website/site/", import.meta.url),
);
const preview = await createSitePreview({
  staticDirectory: siteDirectory,
  data: "empty",
});
const counties = createServices({ database: preview.database }).listCounties();
const staticFiles = new Map([
  [
    "/site.css",
    [
      new URL("../website/site/site.css", import.meta.url),
      "text/css; charset=utf-8",
    ],
  ],
  [
    "/report-interface.css",
    [
      new URL("../website/site/report-interface.css", import.meta.url),
      "text/css; charset=utf-8",
    ],
  ],
  [
    "/report-demo.js",
    [
      new URL("../website/site/report-demo.js", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/assets/brand-logo-white.png",
    [
      new URL("../website/site/brand-logo-white.png", import.meta.url),
      "image/png",
    ],
  ],
  [
    "/assets/report-interface.js",
    [
      new URL("../dist/site/report-interface.js", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/assets/report-demo.js",
    [
      new URL("../dist/site-dev/report-demo.js", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
]);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Submit or Track a Report | Colorado Watchdog</title>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/report-interface.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header report-demo-header">
  <div class="wrap site-header-inner">
    <a class="brand" href="/">
      <img class="brand-logo" src="/assets/brand-logo-white.png" alt="" width="56" height="54">
      <span class="brand-text"><span class="brand-name">Colorado Watchdog</span><span class="brand-tagline">Accountability Starts with Being Heard</span></span>
    </a>
  </div>
</header>
<p class="site-strip"><strong>Records cite public sources. They are not findings of fact.</strong> <span>Independent</span> <span>Community-run</span></p>
<main id="main" class="wrap main-column" tabindex="-1">
  <div id="report-demo"></div>
</main>
<script type="module" src="/report-demo.js"></script>
</body>
</html>`;

const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? "/", `http://${host}:${port}`)
      .pathname;
    const headers = {
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    };
    if (pathname === "/") {
      response.writeHead(200, {
        ...headers,
        "content-type": "text/html; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : page);
      return;
    }
    if (pathname === "/demo/counties.json") {
      response.writeHead(200, {
        ...headers,
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        request.method === "HEAD" ? undefined : JSON.stringify(counties),
      );
      return;
    }
    const file = staticFiles.get(pathname);
    if (!file) {
      response.writeHead(404, { ...headers, "content-type": "text/plain" });
      response.end(request.method === "HEAD" ? undefined : "Not found");
      return;
    }
    const [url, contentType] = file;
    const body = await readFile(url);
    response.writeHead(200, { ...headers, "content-type": contentType });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500, {
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(request.method === "HEAD" ? undefined : "Local demo error");
  }
});

server.listen(port, host, () => {
  console.log(
    "Colorado Watchdog report UI (fictional data, browser memory only):",
  );
  console.log(`  http://${host}:${port}/`);
  console.log("No report content is sent to a server. Press Ctrl+C to stop.");
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

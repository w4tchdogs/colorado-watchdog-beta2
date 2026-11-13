import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createLocalStorageProbe } from "../dist/local/storage-probe.js";
import { createServices } from "../dist/services/index.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const database = await openWebsiteDatabase(
  process.env.DATABASE_PATH ?? ":memory:",
);
migrateWebsiteDatabase(database);
const application = createApplication(
  createServices({
    database,
    storage: createLocalStorageProbe(database),
  }),
);

const server = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method ?? "GET";
    const headers = new Headers();
    const hopByHopHeaders = new Set([
      "connection",
      "host",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined || hopByHopHeaders.has(name)) {
        continue;
      }
      for (const entry of Array.isArray(value) ? value : [value]) {
        headers.append(name, entry);
      }
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(
      `http://${host}:${port}${incoming.url ?? "/"}`,
      {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
      },
    );
    const response = await application.fetch(request);

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch {
    outgoing.writeHead(500, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    outgoing.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.listen(port, host, () => {
  console.log(
    `Local Worker-compatible harness listening at http://${host}:${port} (SQLite: ${process.env.DATABASE_PATH ?? "in-memory"})`,
  );
});

let databaseClosed = false;
function closeDatabase() {
  if (!databaseClosed) {
    database.close();
    databaseClosed = true;
  }
}

server.on("close", closeDatabase);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close((error) => {
      closeDatabase();
      if (error) {
        console.error("Could not stop the local server cleanly");
        process.exitCode = 1;
      }
    });
  });
}

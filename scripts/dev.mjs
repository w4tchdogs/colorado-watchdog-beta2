import { createServer } from "node:http";
import { createApplication } from "../dist/application.js";
import { createLocalStorageProbe } from "../dist/local/storage-probe.js";
import { createServices } from "../dist/services/index.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const application = createApplication(
  createServices({ storage: createLocalStorageProbe() }),
);

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(
      `http://${host}:${port}${incoming.url ?? "/"}`,
      { method: incoming.method },
    );
    const response = await application.fetch(request);

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch (error) {
    console.error("Local request failed", error);
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.listen(port, host, () => {
  console.log(
    `Local Worker-compatible harness listening at http://${host}:${port}`,
  );
});

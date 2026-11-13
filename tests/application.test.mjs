import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { StorageUnavailableError } from "../dist/contracts/storage.js";
import { createLocalStorageProbe } from "../dist/local/storage-probe.js";
import { createServices } from "../dist/services/index.js";
import worker from "../dist/worker.js";

const healthRequest = (url = "https://watchdog.test/_internal/health") =>
  new Request(url);

test("Worker entrypoint initializes without external services", async () => {
  const response = await worker.fetch(healthRequest(), {
    APP_ENV: "test",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("request dispatch reaches services with an injectable local adapter", async () => {
  let checks = 0;
  const storage = {
    async check() {
      checks += 1;
    },
  };
  const application = createApplication(createServices({ storage }));

  const response = await application.fetch(healthRequest());

  assert.equal(response.status, 200);
  assert.equal(checks, 1);
});

test("the deterministic local adapter satisfies the storage boundary", async () => {
  const application = createApplication(
    createServices({ storage: createLocalStorageProbe() }),
  );

  const response = await application.fetch(healthRequest());

  assert.equal(response.status, 200);
});

test("unsupported routes and methods fail predictably", async () => {
  const application = createApplication(createServices());

  const missing = await application.fetch(
    healthRequest("https://watchdog.test/public"),
  );
  const wrongMethod = await application.fetch(
    new Request("https://watchdog.test/_internal/health", { method: "POST" }),
  );

  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
});

test("malformed paths and unexpected query strings are rejected", async () => {
  const application = createApplication(createServices());
  const malformedPath = await application.fetch(
    healthRequest("https://watchdog.test/_internal/%E0%A4%A"),
  );
  const query = await application.fetch(
    healthRequest("https://watchdog.test/_internal/health?extra=1"),
  );

  assert.equal(malformedPath.status, 400);
  assert.deepEqual(await malformedPath.json(), { error: "malformed_path" });
  assert.equal(query.status, 400);
  assert.deepEqual(await query.json(), { error: "unexpected_query" });
});

test("an unavailable adapter cannot be reported as healthy", async () => {
  const storage = {
    async check() {
      throw new StorageUnavailableError();
    },
  };
  const application = createApplication(createServices({ storage }));

  const response = await application.fetch(healthRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "dependency_unavailable",
  });
});

test("unexpected adapter errors are not converted into success responses", async () => {
  const storage = {
    async check() {
      throw new Error("unexpected adapter failure");
    },
  };
  const application = createApplication(createServices({ storage }));

  await assert.rejects(application.fetch(healthRequest()), {
    message: "unexpected adapter failure",
  });
});

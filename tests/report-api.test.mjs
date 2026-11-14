import assert from "node:assert/strict";
import test from "node:test";
import { createReportApiModule } from "../dist/report-api.js";
import { MemoryReportIntakeStore } from "../dist/services/report-intake-memory.js";

const submission = {
  countyId: "synthetic-county",
  description: "Synthetic report content used only by the local API test.",
  evidence: [{ title: "Synthetic source" }],
  reporter: {
    attribution: "anonymous",
    confidential: true,
    contactPreference: "none",
  },
  idempotencyKey: "synthetic-api-001",
};
function setup(role = null, configure = true, sharedStore = null) {
  const store = sharedStore ?? new MemoryReportIntakeStore();
  const principal = role ? { accountId: `synthetic-${role}`, role } : null;
  const api = createReportApiModule({
    store,
    services: {
      async resolvePrincipal() {
        return principal;
      },
      async hasCapability(current, capability) {
        return (
          !!current &&
          capability === "report.review" &&
          ["editor", "administrator", "owner"].includes(current.role)
        );
      },
    },
    guestSubmissions: configure
      ? {
          enabled: true,
          abuseControl: {
            async check() {
              return { allowed: true };
            },
          },
        }
      : undefined,
  });
  const request = (path, method = "GET", body) =>
    api.fetch(
      new Request(`https://local.test${path}`, {
        method,
        headers:
          method === "GET"
            ? {}
            : {
                origin: "https://local.test",
                "content-type": "application/json",
              },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { api, request, store };
}

test("public submission is safe, replay hides the one-time recovery key, and tracking protects details", async () => {
  const { request } = setup();
  const first = await request("/api/v1/reports", "POST", submission);
  const receipt = await first.json();
  assert.equal(first.status, 201);
  assert.equal("reportId" in receipt, false);
  assert.equal(receipt.recoveryKey.length, 64);
  const replay = await request("/api/v1/reports", "POST", submission);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).recoveryKey, undefined);
  const track = await request("/api/v1/reports/track", "POST", {
    reference: receipt.reference,
    recoveryKey: receipt.recoveryKey,
  });
  const tracking = await track.json();
  assert.equal(tracking.status, "submitted");
  assert.equal(JSON.stringify(tracking).includes(receipt.recoveryKey), false);
  assert.equal(
    JSON.stringify(tracking).includes("Synthetic report content"),
    false,
  );
  const bad = await request("/api/v1/reports/track", "POST", {
    reference: receipt.reference,
    recoveryKey: "0".repeat(64),
  });
  assert.equal(bad.status, 404);
});

test("missing abuse boundary fails closed and rejects cross-origin requests", async () => {
  const { request: disabled } = setup(null, false);
  assert.equal(
    (await disabled("/api/v1/reports", "POST", submission)).status,
    503,
  );
  const { api } = setup();
  const cross = await api.fetch(
    new Request("https://local.test/api/v1/reports", {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        "content-type": "application/json",
      },
      body: JSON.stringify(submission),
    }),
  );
  assert.equal(cross.status, 403);
});

test("only editor, administrator, and owner can list or read private reports", async () => {
  for (const role of [
    "contributor",
    null,
    "editor",
    "administrator",
    "owner",
  ]) {
    const { request } = setup(role);
    const response = await request("/api/v1/reports?limit=10");
    assert.equal(
      response.status,
      ["editor", "administrator", "owner"].includes(role)
        ? 200
        : role
          ? 403
          : 401,
    );
  }
});

test("limits body sizes and denies caller-supplied account authority", async () => {
  const { api } = setup();
  const oversized = await api.fetch(
    new Request("https://local.test/api/v1/reports", {
      method: "POST",
      headers: {
        origin: "https://local.test",
        "content-type": "application/json",
      },
      body: " ".repeat(33_000),
    }),
  );
  assert.equal(oversized.status, 413);
  const { request } = setup();
  const forged = await request("/api/v1/reports", "POST", {
    ...submission,
    reporter: { ...submission.reporter, accountId: "forged" },
  });
  assert.equal(forged.status, 400);
});

test("staff queue is metadata-only and status transitions require an expected version", async () => {
  const { request: guest, store } = setup();
  const submitted = await guest("/api/v1/reports", "POST", {
    ...submission,
    reporter: {
      attribution: "signed",
      confidential: true,
      contactPreference: "email",
      name: "Synthetic Reporter",
      email: "private@example.invalid",
    },
  });
  const receipt = await submitted.json();
  const reportId = store.reportIdForReference(receipt.reference);
  const { request: staff } = setup("editor", true, store);
  const queue = await staff("/api/v1/reports?limit=1&status=submitted");
  const listing = await queue.json();
  assert.equal(listing.reports.length, 1);
  assert.equal("reporter" in listing.reports[0], false);
  assert.equal(
    JSON.stringify(listing).includes("private@example.invalid"),
    false,
  );
  const detail = await staff(`/api/v1/reports/${reportId}`);
  assert.equal(
    (await detail.json()).report.reporter.email,
    "private@example.invalid",
  );
  const transition = await staff(
    `/api/v1/reports/${reportId}/status`,
    "PATCH",
    {
      expectedVersion: 1,
      status: "triage",
      note: "Synthetic private review note.",
    },
  );
  assert.equal(transition.status, 200);
  const stale = await staff(`/api/v1/reports/${reportId}/status`, "PATCH", {
    expectedVersion: 1,
    status: "triage",
  });
  assert.equal(stale.status, 409);
  const history = await staff(`/api/v1/reports/${reportId}/history`);
  assert.equal(
    (await history.json()).history[1].note,
    "Synthetic private review note.",
  );
});

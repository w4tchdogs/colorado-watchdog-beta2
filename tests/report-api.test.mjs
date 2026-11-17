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
function setup(
  role = null,
  configure = true,
  sharedStore = null,
  check = async () => ({ allowed: true }),
) {
  const store = sharedStore ?? new MemoryReportIntakeStore();
  const principal = role
    ? {
        accountId: `synthetic-${role}`,
        role,
        kind: role === "agent" ? "agent" : "human",
      }
    : null;
  const api = createReportApiModule({
    store,
    services: {
      async listCounties() {
        return [];
      },
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
          abuseControl: { check },
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

test("synthetic challenge results gate anonymous guest intake before report storage", async () => {
  const acceptedTokens = new Set();
  const { api, store } = setup(null, true, null, async (request) => {
    const token = request.headers.get("x-report-challenge");
    if (token === "synthetic-unavailable") throw new Error("fixture outage");
    if (token !== "synthetic-valid" || acceptedTokens.has(token)) {
      return { allowed: false, retryAfterSeconds: 15 };
    }
    acceptedTokens.add(token);
    return { allowed: true };
  });
  const submit = (token, idempotencyKey) =>
    api.fetch(
      new Request("https://local.test/api/v1/reports", {
        method: "POST",
        headers: {
          origin: "https://local.test",
          "content-type": "application/json",
          "x-report-challenge": token,
        },
        body: JSON.stringify({
          ...submission,
          idempotencyKey,
          reporter: { ...submission.reporter, name: "Synthetic alias" },
        }),
      }),
    );

  const allowed = await submit(
    "synthetic-valid",
    "synthetic-challenge-allowed",
  );
  assert.equal(allowed.status, 201);
  const { reference } = await allowed.json();
  assert.ok(store.reportIdForReference(reference));

  for (const [outcome, token] of [
    ["denied", "synthetic-denied"],
    ["expired", "synthetic-expired"],
    ["replayed", "synthetic-valid"],
  ]) {
    const refused = await submit(token, `synthetic-challenge-${outcome}`);
    assert.equal(refused.status, 429, outcome);
    assert.equal(refused.headers.get("retry-after"), "15", outcome);
    assert.deepEqual(await refused.json(), { error: "rate_limited" }, outcome);
  }

  const unavailable = await submit(
    "synthetic-unavailable",
    "synthetic-challenge-unavailable",
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "service_unavailable" });
  const { request: staff } = setup("editor", true, store);
  const queue = await staff("/api/v1/reports?limit=10");
  const { reports } = await queue.json();
  assert.equal(reports.length, 1);
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
  const detailResult = await detail.json();
  assert.equal(detailResult.report.reporter.email, "private@example.invalid");
  assert.deepEqual(detailResult.allowedNextStatuses, ["triage"]);
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

// The account form sends the account it was rendered for in a header, never in
// the JSON body. The server only compares it with the live session.
const EXPECT = "x-report-account-expectation";
async function post(api, body, headers = {}) {
  return api.fetch(
    new Request("https://local.test/api/v1/reports", {
      method: "POST",
      headers: {
        origin: "https://local.test",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function queueSize(store) {
  const { request } = setup("editor", true, store);
  return (await (await request("/api/v1/reports")).json()).reports.length;
}

test("account submission succeeds only under the matching live session and stores the session account", async () => {
  const store = new MemoryReportIntakeStore();
  const { api } = setup("reporter", true, store);
  const first = await post(api, submission, { [EXPECT]: "synthetic-reporter" });
  assert.equal(first.status, 201);
  const receipt = await first.json();
  assert.equal(receipt.recoveryKey.length, 64);
  const { request: staff } = setup("editor", true, store);
  const id = store.reportIdForReference(receipt.reference);
  const stored = await (await staff(`/api/v1/reports/${id}`)).json();
  assert.equal(stored.report.reporter.accountId, "synthetic-reporter");
  // Same key replays without a second recovery key, and tracking still works.
  const replay = await post(api, submission, {
    [EXPECT]: "synthetic-reporter",
  });
  assert.equal(replay.status, 200);
  const replayed = await replay.json();
  assert.equal(replayed.recoveryKey, undefined);
  assert.equal(replayed.reference, receipt.reference);
  const { request: anyone } = setup(null, true, store);
  const track = await anyone("/api/v1/reports/track", "POST", {
    reference: receipt.reference,
    recoveryKey: receipt.recoveryKey,
  });
  assert.equal(track.status, 200);
  assert.equal(await queueSize(store), 1);
});

test("a changed or expired session creates no report and never falls back to guest", async () => {
  const store = new MemoryReportIntakeStore();
  const changed = await post(setup("other", true, store).api, submission, {
    [EXPECT]: "synthetic-reporter",
  });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "account_changed" });
  assert.equal(changed.headers.get("cache-control"), "no-store, private");
  const expired = await post(setup(null, true, store).api, submission, {
    [EXPECT]: "synthetic-reporter",
  });
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), { error: "authentication_required" });
  assert.equal(await queueSize(store), 0);
  // The same draft is not replayed as a guest report either.
  for (const bad of ["", "x".repeat(129), "has space", "a/b"]) {
    const response = await post(
      setup("reporter", true, store).api,
      submission,
      {
        [EXPECT]: bad,
      },
    );
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal(await queueSize(store), 0);
});

test("a client-supplied reporter.accountId stays rejected even with a matching expectation", async () => {
  const store = new MemoryReportIntakeStore();
  const response = await post(
    setup("reporter", true, store).api,
    {
      ...submission,
      reporter: { ...submission.reporter, accountId: "synthetic-reporter" },
    },
    { [EXPECT]: "synthetic-reporter" },
  );
  assert.equal(response.status, 400);
  assert.equal(await queueSize(store), 0);
});

test("guest name choices: anonymous sends none, shared name is stored privately", async () => {
  const store = new MemoryReportIntakeStore();
  const guest = setup(null, true, store).api;
  const { request: staff } = setup("editor", true, store);
  const stored = async (response) =>
    (
      await (
        await staff(
          `/api/v1/reports/${store.reportIdForReference((await response.json()).reference)}`,
        )
      ).json()
    ).report.reporter;
  const none = await post(guest, {
    ...submission,
    idempotencyKey: "synthetic-g-1",
  });
  assert.equal((await stored(none)).name, undefined);
  const named = await post(guest, {
    ...submission,
    idempotencyKey: "synthetic-g-2",
    reporter: { ...submission.reporter, name: "Fictional Name" },
  });
  const reporter = await stored(named);
  assert.equal(reporter.name, "Fictional Name");
  assert.equal(reporter.attribution, "anonymous");
  assert.equal(reporter.accountId, undefined);
});

test("disabled intake blocks account submissions and keeps private tracking available", async () => {
  const store = new MemoryReportIntakeStore();
  const receipt = await (
    await post(setup(null, true, store).api, submission)
  ).json();
  const { api, request } = setup("reporter", false, store);
  const blocked = await post(
    api,
    { ...submission, idempotencyKey: "synthetic-d-1" },
    {
      [EXPECT]: "synthetic-reporter",
    },
  );
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get("cache-control"), "no-store, private");
  const track = await request("/api/v1/reports/track", "POST", {
    reference: receipt.reference,
    recoveryKey: receipt.recoveryKey,
  });
  assert.equal(track.status, 200);
  assert.equal(track.headers.get("cache-control"), "no-store, private");
  assert.equal(await queueSize(store), 1);
});

test("an agent principal is refused when the account expectation is present and creates no report", async () => {
  const store = new MemoryReportIntakeStore();
  const response = await post(setup("agent", true, store).api, submission, {
    [EXPECT]: "synthetic-agent",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(await queueSize(store), 0);
  // The same agent without the header keeps today's behavior, and a human with
  // the header still succeeds.
  assert.equal(
    (
      await post(setup("reporter", true, store).api, submission, {
        [EXPECT]: "synthetic-reporter",
      })
    ).status,
    201,
  );
});

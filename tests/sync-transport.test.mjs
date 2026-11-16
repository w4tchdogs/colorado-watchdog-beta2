import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import {
  createSyncApiTransport,
  SYNC_API_PATHS,
} from "../dist/transport/sync-api.js";

const REQUEST_ID = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const BATCH_ID = "batch-synthetic-001";
const KEY = "synthetic-key-1";

async function withPrincipal(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id,kind,role,display_name,preferences)
    VALUES ('synthetic-owner','human','owner','Synthetic Owner','{}');
    INSERT INTO identities (id,account_id,provider,subject)
    VALUES ('synthetic-identity','synthetic-owner','test-human','subject-owner');
  `);
  const adapter = createTestHumanIdentityAdapter({
    owner: "subject-owner",
  });
  const principalFor = (login = "owner") =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.invalid/", {
        headers: { "x-test-human-subject": login },
      }),
      adapter,
    );
  try {
    await callback({ database, principalFor });
  } finally {
    database.close();
  }
}

function changeset(intent = "dry_run", extra = {}) {
  return {
    contractVersion: "m2-sync/v1",
    requestId: REQUEST_ID,
    intent,
    changes: [
      {
        op: "update_record",
        entity: "organizations",
        targetId: "organization-1",
        expectedVersion: 7,
        fields: { name: "Synthetic updated organization" },
      },
    ],
    ...extra,
  };
}

function jsonRequest(path, value, headers = {}, options = {}) {
  const method = options.method ?? "POST";
  return new Request(`https://watchdog.invalid${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: options.body ?? JSON.stringify(value) }),
  });
}

function dependencies(principal, operations, overrides = {}) {
  return {
    resolvePrincipal: async () => principal,
    // Positive sync decisions in transport tests are isolated synthetic grants.
    authorize: async () => true,
    operations,
    ...overrides,
  };
}

const planResult = {
  contractVersion: "m2-sync/v1",
  requestId: REQUEST_ID,
  eligible: true,
  items: [
    {
      itemIndex: 0,
      entity: "organizations",
      action: "would_update",
      targetId: "organization-1",
      expectedVersion: 7,
      dependencies: [],
    },
  ],
  errors: [],
  duplicateFlags: [],
};

test("dry run forwards the strict v1 changeset including expectedVersion", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let received;
    const transport = createSyncApiTransport(
      dependencies(principal, {
        dryRun: async (_principal, request) => {
          received = request;
          return planResult;
        },
      }),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.dryRun, changeset()),
    );
    assert.equal(response.status, 200);
    assert.equal(received.changes[0].expectedVersion, 7);
    assert.equal(received.intent, "dry_run");
    assert.deepEqual(await response.json(), planResult);
  });
});

test("rejects malformed IDs, missing expectedVersion and unknown fields", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let calls = 0;
    const transport = createSyncApiTransport(
      dependencies(principal, {
        dryRun: async () => {
          calls++;
          return planResult;
        },
      }),
    );
    const malformed = [
      changeset("dry_run", { extra: true }),
      {
        ...changeset(),
        requestId: "not-an-id",
      },
      {
        ...changeset(),
        changes: [
          {
            ...changeset().changes[0],
            expectedVersion: undefined,
          },
        ],
      },
      {
        ...changeset(),
        changes: [
          {
            ...changeset().changes[0],
            fields: { name: "Synthetic", privatePayload: "do not accept" },
          },
        ],
      },
      {
        ...changeset(),
        contractVersion: "m2-sync/v2",
      },
    ];
    const responses = await Promise.all(
      malformed.map((body) =>
        transport.fetch(jsonRequest(SYNC_API_PATHS.dryRun, body)),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      [400, 400, 400, 400, 400],
    );
    assert.equal(calls, 0);
    assert.deepEqual(await responses[4].json(), {
      error: "unsupported_contract_version",
    });
  });
});

test("enforces total and per-item request bounds while streaming", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const transport = createSyncApiTransport(
      dependencies(await principalFor(), { dryRun: async () => planResult }),
    );
    const oversizedBody = JSON.stringify({
      padding: "x".repeat(8 * 1024 * 1024),
    });
    const oversized = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.dryRun, null, {}, { body: oversizedBody }),
    );
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_too_large" });

    const oversizedItem = changeset("dry_run", {
      changes: [
        {
          op: "update_record",
          entity: "organizations",
          targetId: "organization-1",
          expectedVersion: 7,
          fields: { name: "x".repeat(32 * 1024) },
        },
      ],
    });
    const itemResponse = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.dryRun, oversizedItem),
    );
    assert.equal(itemResponse.status, 400);
    assert.deepEqual(await itemResponse.json(), { error: "item_too_large" });
  });
});

test("commit forwards its separate idempotency key and preserves replay results", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let call;
    const result = {
      status: "committed",
      batchId: BATCH_ID,
      requestId: REQUEST_ID,
      committedAt: "2026-11-13T12:00:00.000Z",
      replayed: true,
      items: [
        {
          itemIndex: 0,
          entity: "organizations",
          websiteId: "organization-1",
          version: 8,
          outcome: "updated",
        },
      ],
      errors: [],
    };
    const transport = createSyncApiTransport(
      dependencies(principal, {
        commit: async (...args) => {
          call = args;
          return { ...result, secret: "credential-never-return" };
        },
      }),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.commit, changeset("commit"), {
        "idempotency-key": KEY,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(call[0].accountId, principal.accountId);
    assert.equal(call[1], KEY);
    assert.equal(call[2].intent, "commit");
    assert.deepEqual(await response.json(), result);
  });
});

test("rejected commit keeps safe conflict semantics and replaces raw messages", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const secret = "private-internal-detail";
    const transport = createSyncApiTransport(
      dependencies(await principalFor(), {
        commit: async () => ({
          status: "rejected",
          requestId: REQUEST_ID,
          replayed: false,
          items: [],
          errors: [{ code: "commit_conflict", message: secret }],
        }),
      }),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.commit, changeset("commit"), {
        "idempotency-key": KEY,
      }),
    );
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    assert.match(body, /The changeset was rejected/);
  });
});

test("authorization defaults to deny and prevents every protected side effect", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let writes = 0;
    let audits = 0;
    const transport = createSyncApiTransport({
      resolvePrincipal: async () => principal,
      operations: {
        commit: async () => {
          writes++;
          audits++;
          return {
            status: "rejected",
            requestId: REQUEST_ID,
            replayed: false,
            items: [],
            errors: [{ code: "commit_conflict", message: "private detail" }],
          };
        },
      },
    });
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.commit, changeset("commit"), {
        "idempotency-key": KEY,
      }),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
    assert.equal(writes, 0);
    assert.equal(audits, 0);
  });
});

test("missing, inactive, or unauthorized principals cannot reach operation handlers", async () => {
  await withPrincipal(async ({ database, principalFor }) => {
    const active = await principalFor();
    let calls = 0;
    const ops = {
      dryRun: async () => {
        calls++;
        return planResult;
      },
    };
    const request = () => jsonRequest(SYNC_API_PATHS.dryRun, changeset());

    const noResolver = createSyncApiTransport({
      authorize: async () => true,
      operations: ops,
    });
    assert.equal((await noResolver.fetch(request())).status, 401);

    database
      .prepare(
        `UPDATE accounts SET status = 'disabled', version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(active.accountId);
    const inactive = await principalFor();
    assert.equal(inactive, null);
    const inactiveTransport = createSyncApiTransport(
      dependencies(inactive, ops),
    );
    assert.equal((await inactiveTransport.fetch(request())).status, 401);

    const unauthorized = createSyncApiTransport(
      dependencies(active, ops, { authorize: async () => false }),
    );
    assert.equal((await unauthorized.fetch(request())).status, 403);
    assert.equal(calls, 0);
  });
});

test("missing operation handlers fail closed after an explicit authorization decision", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let decisions = 0;
    const transport = createSyncApiTransport(
      dependencies(
        principal,
        {},
        {
          authorize: async () => {
            decisions++;
            return true;
          },
        },
      ),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.dryRun, changeset()),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "operation_unavailable",
    });
    assert.equal(decisions, 1);
  });
});

test("lookup is actor-scoped and strips unrecognized result data", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let received;
    const result = {
      status: "committed",
      batchId: BATCH_ID,
      committedAt: "2026-11-13T12:00:00.000Z",
      reversedAt: null,
      items: [
        {
          itemIndex: 0,
          clientRef: "organization",
          entity: "organizations",
          websiteId: "organization-1",
          outcome: "created",
          version: 1,
          inverse_json: "private inverse",
        },
      ],
      privateResearch: "must not leak",
    };
    const transport = createSyncApiTransport(
      dependencies(principal, {
        lookup: async (...args) => {
          received = args;
          return result;
        },
      }),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.lookup, {
        contractVersion: "m2-sync/v1",
        batchId: BATCH_ID,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(received[0].accountId, principal.accountId);
    assert.deepEqual(received[1], { batchId: BATCH_ID });
    const output = await response.json();
    assert.equal(output.privateResearch, undefined);
    assert.equal(output.items[0].inverse_json, undefined);
  });
});

test("reversal gets its own idempotency key and safe uncertain-outcome result", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const principal = await principalFor();
    let received;
    const transport = createSyncApiTransport(
      dependencies(principal, {
        reverse: async (...args) => {
          received = args;
          return {
            status: "reversal_blocked",
            batchId: BATCH_ID,
            replayed: false,
            message: "raw inverse data and credentials",
            inverse_json: "private",
          };
        },
      }),
    );
    const response = await transport.fetch(
      jsonRequest(
        SYNC_API_PATHS.reverse,
        { contractVersion: "m2-sync/v1", batchId: BATCH_ID },
        { "idempotency-key": "reverse-key-2" },
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(received[0].accountId, principal.accountId);
    assert.equal(received[1], BATCH_ID);
    assert.equal(received[2], "reverse-key-2");
    assert.deepEqual(await response.json(), {
      status: "reversal_blocked",
      batchId: BATCH_ID,
      replayed: false,
      message:
        "The batch could not be safely reversed; no changes were applied.",
    });
  });
});

test("handler exceptions return bounded errors without leaking details", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const secret = "synthetic-credential-must-not-leak";
    const transport = createSyncApiTransport(
      dependencies(await principalFor(), {
        dryRun: async () => {
          throw new Error(`${secret}\ninternal stack`);
        },
      }),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.dryRun, changeset()),
    );
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body, '{"error":"internal_error"}');
    assert.equal(body.includes(secret), false);
  });
});

test("oversized service results are replaced with a bounded generic response", async () => {
  await withPrincipal(async ({ principalFor }) => {
    const privateValue = "private-result".repeat(700_000);
    const transport = createSyncApiTransport(
      dependencies(await principalFor(), {
        dryRun: async () => ({
          ...planResult,
          duplicateFlags: [
            {
              targetRef: privateValue,
              possibleDuplicateOf: "synthetic-ref",
            },
          ],
        }),
      }),
    );
    const response = await transport.fetch(
      jsonRequest(SYNC_API_PATHS.dryRun, changeset()),
    );
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body, '{"error":"internal_error"}');
    assert.ok(new TextEncoder().encode(body).byteLength <= 64);
  });
});

test("rejects unsupported methods and does not expose a public application route", async () => {
  const transport = createSyncApiTransport();
  const method = await transport.fetch(
    jsonRequest(SYNC_API_PATHS.dryRun, changeset(), {}, { method: "GET" }),
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");

  const application = createApplication({});
  const publicRoute = await application.fetch(
    new Request(`https://watchdog.invalid${SYNC_API_PATHS.dryRun}`),
  );
  assert.equal(publicRoute.status, 404);
  assert.deepEqual(await publicRoute.json(), { error: "not_found" });
});

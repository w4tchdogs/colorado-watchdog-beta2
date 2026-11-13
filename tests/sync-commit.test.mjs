import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangeset } from "../dist/services/sync-commit.js";

const ID = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const NOW = () => new Date("2026-11-13T12:00:00.000Z");

async function fixture(callback, path = ":memory:") {
  const database = await openWebsiteDatabase(path);
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name, preferences)
    VALUES ('owner-a','human','owner','Synthetic Owner','{}'),
           ('owner-b','human','owner','Synthetic Second Owner','{}');
    INSERT INTO identities (id, account_id, provider, subject)
    VALUES ('identity-a','owner-a','test-human','subject-a'),
           ('identity-b','owner-b','test-human','subject-b');
  `);
  const adapter = createTestHumanIdentityAdapter({
    a: "subject-a",
    b: "subject-b",
  });
  const principal = async (which = "a") =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": which },
      }),
      adapter,
    );
  try {
    await callback(database, principal);
  } finally {
    database.close();
  }
}

const create = (op, entity, clientRef, fields) => ({
  op,
  entity,
  clientRef,
  fields,
});
function batch(changes, extra = {}) {
  return {
    contractVersion: "m2-sync/v1",
    requestId: ID,
    intent: "commit",
    changes,
    ...extra,
  };
}
function fullBatch() {
  return batch([
    create("create_organization", "organizations", "org", {
      name: "Synthetic Adams Office",
      organization_type: "office",
      county_fips: "08001",
    }),
    create(
      "add_county_affiliation",
      "organization_county_affiliations",
      "affiliation",
      {
        organization_ref: "org",
        county_fips: "08013",
        relationship_type: "serves",
      },
    ),
    create("create_position", "positions", "position", {
      organization_ref: "org",
      title: "Synthetic Clerk",
    }),
    create("create_person", "people", "person", {
      display_name: "Fictional Person",
    }),
    create("register_source", "role_sources", "source", {
      url: "https://example.invalid/synthetic",
      title: "Synthetic source",
      source_type: "official_page",
    }),
    create("create_person_role", "person_roles", "role", {
      person_ref: "person",
      position_ref: "position",
      source_ref: "source",
      source_checked_at: "2026-11-12T12:00:00Z",
    }),
  ]);
}

test("commits dependent records with Website IDs and exact replay independent of requestId", async () => {
  await fixture(async (db, principalFor) => {
    const principal = await principalFor();
    const first = await commitSyncChangeset(
      db,
      principal,
      "batch-key-1",
      fullBatch(),
      NOW,
    );
    assert.equal(first.status, "committed");
    if (first.status !== "committed") return;
    assert.equal(first.items.length, 6);
    assert.equal(first.items[1].outcome, "created");
    assert.equal(first.items[5].outcome, "created");
    const role = db
      .prepare(
        "SELECT person_id,position_id,source_id FROM person_roles WHERE id = ?",
      )
      .get(first.items[5].websiteId);
    assert.equal(role.person_id, first.items[3].websiteId);
    assert.equal(role.position_id, first.items[2].websiteId);
    assert.equal(role.source_id, first.items[4].websiteId);

    const retry = {
      ...fullBatch(),
      requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb20",
    };
    const replay = await commitSyncChangeset(
      db,
      principal,
      "batch-key-1",
      retry,
      NOW,
    );
    assert.equal(replay.status, "committed");
    if (replay.status !== "committed") return;
    assert.equal(replay.replayed, true);
    assert.equal(replay.requestId, ID);
    assert.equal(replay.batchId, first.batchId);
    assert.deepEqual(replay.items, first.items);
    assert.equal(db.prepare("SELECT count(*) AS n FROM people").get().n, 1);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='sync.batch.commit'",
        )
        .get().n,
      1,
    );
  });
});

test("changed material and independent actors have distinct idempotency scopes", async () => {
  await fixture(async (db, principalFor) => {
    const first = await commitSyncChangeset(
      db,
      await principalFor("a"),
      "shared-key",
      fullBatch(),
      NOW,
    );
    assert.equal(first.status, "committed");
    const changed = fullBatch();
    changed.changes[0].fields.name = "Changed Synthetic Office";
    const mismatch = await commitSyncChangeset(
      db,
      await principalFor("a"),
      "shared-key",
      changed,
      NOW,
    );
    assert.equal(mismatch.status, "rejected");
    if (mismatch.status === "rejected")
      assert.equal(mismatch.errors[0].code, "idempotency_mismatch");
    const otherActor = await commitSyncChangeset(
      db,
      await principalFor("b"),
      "shared-key",
      fullBatch(),
      NOW,
    );
    assert.equal(otherActor.status, "committed");
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      2,
    );
  });
});

test("a failed preflight does not consume the key and a transaction failure rolls back all evidence", async () => {
  await fixture(async (db, principalFor) => {
    const principal = await principalFor();
    const invalid = batch([
      { op: "delete", entity: "people", clientRef: "bad", fields: {} },
    ]);
    const rejected = await commitSyncChangeset(
      db,
      principal,
      "reusable",
      invalid,
      NOW,
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      0,
    );

    db.exec(
      "CREATE TRIGGER fail_person_insert BEFORE INSERT ON people BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END;",
    );
    const failed = await commitSyncChangeset(
      db,
      principal,
      "rollback-key",
      fullBatch(),
      NOW,
    );
    assert.equal(failed.status, "rejected");
    for (const table of [
      "organizations",
      "positions",
      "people",
      "role_sources",
      "person_roles",
      "sync_batches",
      "sync_batch_items",
    ]) {
      assert.equal(
        db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
        0,
        table,
      );
    }
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='sync.batch.commit'",
        )
        .get().n,
      0,
    );
    db.exec("DROP TRIGGER fail_person_insert;");
    const retry = await commitSyncChangeset(
      db,
      principal,
      "rollback-key",
      fullBatch(),
      NOW,
    );
    assert.equal(retry.status, "committed");

    db.exec(`CREATE TRIGGER fail_sync_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='sync.batch.commit' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
    const auditFailed = await commitSyncChangeset(
      db,
      principal,
      "audit-rollback-key",
      batch([
        create("create_person", "people", "audit-person", {
          display_name: "Audit rollback",
        }),
      ]),
      NOW,
    );
    assert.equal(auditFailed.status, "rejected");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM people WHERE display_name='Audit rollback'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM sync_batches WHERE idempotency_key='audit-rollback-key'",
        )
        .get().n,
      0,
    );
    db.exec("DROP TRIGGER fail_sync_audit;");
  });
});

test("fingerprints canonicalize object-key order but bind operation order and expected versions", async () => {
  await fixture(async (db, principalFor) => {
    const principal = await principalFor();
    const original = batch([
      create("create_person", "people", "person", {
        display_name: "Synthetic",
      }),
      create("create_person", "people", "second", {
        display_name: "Synthetic Two",
      }),
    ]);
    const first = await commitSyncChangeset(
      db,
      principal,
      "canonical",
      original,
      NOW,
    );
    assert.equal(first.status, "committed");
    const reordered = {
      intent: "commit",
      requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb20",
      contractVersion: "m2-sync/v1",
      changes: [
        {
          fields: { display_name: "Synthetic" },
          clientRef: "person",
          entity: "people",
          op: "create_person",
        },
        {
          fields: { display_name: "Synthetic Two" },
          clientRef: "second",
          entity: "people",
          op: "create_person",
        },
      ],
      duplicateFlags: [],
    };
    const same = await commitSyncChangeset(
      db,
      principal,
      "canonical",
      reordered,
      NOW,
    );
    assert.equal(same.status, "committed");
    if (same.status === "committed") assert.equal(same.replayed, true);
    const malformedRequestId = { ...reordered, requestId: "not-a-uuid" };
    const malformed = await commitSyncChangeset(
      db,
      principal,
      "canonical",
      malformedRequestId,
      NOW,
    );
    assert.equal(malformed.status, "rejected");
    if (malformed.status === "rejected")
      assert.equal(malformed.errors[0].code, "invalid_request");
    const changedOrder = batch([...original.changes].reverse());
    const mismatch = await commitSyncChangeset(
      db,
      principal,
      "canonical",
      changedOrder,
      NOW,
    );
    assert.equal(mismatch.status, "rejected");
    if (mismatch.status === "rejected")
      assert.equal(mismatch.errors[0].code, "idempotency_mismatch");
  });
});

test("updates increment exactly once, source URLs reuse, and expected versions bind retries", async () => {
  await fixture(async (db, principalFor) => {
    db.prepare(
      "INSERT INTO people(id,display_name) VALUES ('existing-person','Before')",
    ).run();
    db.prepare(
      "INSERT INTO role_sources(id,url,title,source_type) VALUES ('existing-source','https://example.invalid/reuse','Reusable source','official_page')",
    ).run();
    const principal = await principalFor();
    const request = batch([
      {
        op: "update_record",
        entity: "people",
        targetId: "existing-person",
        expectedVersion: 1,
        fields: { display_name: "After" },
      },
      create("register_source", "role_sources", "source", {
        url: "https://example.invalid/reuse",
        title: "Reusable source",
        source_type: "official_page",
      }),
    ]);
    const committed = await commitSyncChangeset(
      db,
      principal,
      "update-key",
      request,
      NOW,
    );
    assert.equal(committed.status, "committed");
    if (committed.status !== "committed") return;
    assert.equal(committed.items[0].version, 2);
    assert.equal(committed.items[0].outcome, "updated");
    assert.equal(committed.items[1].websiteId, "existing-source");
    assert.equal(committed.items[1].outcome, "reused");
    const replay = await commitSyncChangeset(
      db,
      principal,
      "update-key",
      request,
      NOW,
    );
    assert.equal(replay.status, "committed");
    if (replay.status === "committed") assert.equal(replay.items[0].version, 2);
    assert.equal(
      db.prepare("SELECT version FROM people WHERE id='existing-person'").get()
        .version,
      2,
    );

    const changedVersion = batch([
      {
        op: "update_record",
        entity: "people",
        targetId: "existing-person",
        expectedVersion: 2,
        fields: { display_name: "After" },
      },
      create("register_source", "role_sources", "source", {
        url: "https://example.invalid/reuse",
        title: "Reusable source",
        source_type: "official_page",
      }),
    ]);
    const mismatch = await commitSyncChangeset(
      db,
      principal,
      "update-key",
      changedVersion,
      NOW,
    );
    assert.equal(mismatch.status, "rejected");
    if (mismatch.status === "rejected")
      assert.equal(mismatch.errors[0].code, "idempotency_mismatch");
  });
});

test("unknown envelope fields cannot bypass the pinned request contract", async () => {
  await fixture(async (db, principalFor) => {
    const principal = await principalFor();
    const invalid = {
      ...batch([
        create("create_person", "people", "person", {
          display_name: "Synthetic",
        }),
      ]),
      originSystem: "unrecognized",
    };
    const result = await commitSyncChangeset(
      db,
      principal,
      "strict-key",
      invalid,
      NOW,
    );
    assert.equal(result.status, "rejected");
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      0,
    );
  });
});

test("file-backed database restart preserves committed result, mapping and audit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cw-sync-"));
  const path = join(root, "website.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firstDb = await openWebsiteDatabase(path);
  migrateWebsiteDatabase(firstDb);
  firstDb.exec(`INSERT INTO accounts(id,kind,role,display_name,preferences) VALUES ('owner-a','human','owner','Synthetic Owner','{}');
    INSERT INTO identities(id,account_id,provider,subject) VALUES ('identity-a','owner-a','test-human','subject-a');`);
  const adapter = createTestHumanIdentityAdapter({ a: "subject-a" });
  const principal = await resolvePrincipal(
    firstDb,
    new Request("https://watchdog.invalid", {
      headers: { "x-test-human-subject": "a" },
    }),
    adapter,
  );
  const committed = await commitSyncChangeset(
    firstDb,
    principal,
    "durable-key",
    fullBatch(),
    NOW,
  );
  assert.equal(committed.status, "committed");
  firstDb.close();

  const reopened = await openWebsiteDatabase(path);
  const afterRestartPrincipal = await resolvePrincipal(
    reopened,
    new Request("https://watchdog.invalid", {
      headers: { "x-test-human-subject": "a" },
    }),
    adapter,
  );
  const replay = await commitSyncChangeset(
    reopened,
    afterRestartPrincipal,
    "durable-key",
    fullBatch(),
    NOW,
  );
  assert.equal(replay.status, "committed");
  if (committed.status === "committed" && replay.status === "committed") {
    assert.equal(replay.replayed, true);
    assert.equal(replay.batchId, committed.batchId);
    assert.deepEqual(replay.items, committed.items);
  }
  assert.equal(
    reopened
      .prepare(
        "SELECT count(*) AS n FROM audit_events WHERE action='sync.batch.commit'",
      )
      .get().n,
    1,
  );
  reopened.close();
});

test("disabled actor cannot replay a previously committed result", async () => {
  await fixture(async (db, principalFor) => {
    const principal = await principalFor();
    const success = await commitSyncChangeset(
      db,
      principal,
      "disabled-key",
      fullBatch(),
      NOW,
    );
    assert.equal(success.status, "committed");
    db.prepare(
      "UPDATE accounts SET status='disabled', version=version+1 WHERE id='owner-a'",
    ).run();
    await assert.rejects(
      commitSyncChangeset(db, principal, "disabled-key", fullBatch(), NOW),
      /not active/,
    );
  });
});

test("same-key local contenders commit once and return one durable result", async () => {
  await fixture(async (db, principalFor) => {
    const principal = await principalFor();
    const [left, right] = await Promise.all([
      commitSyncChangeset(db, principal, "racing-key", fullBatch(), NOW),
      commitSyncChangeset(db, principal, "racing-key", fullBatch(), NOW),
    ]);
    assert.equal(left.status, "committed");
    assert.equal(right.status, "committed");
    if (left.status === "committed" && right.status === "committed") {
      assert.equal(left.batchId, right.batchId);
      assert.notEqual(left.replayed, right.replayed);
    }
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      1,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM people").get().n, 1);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='sync.batch.commit'",
        )
        .get().n,
      1,
    );
  });
});

test("different keys cannot both apply the same expected version", async () => {
  await fixture(async (db, principalFor) => {
    db.prepare(
      "INSERT INTO people(id,display_name) VALUES ('racing-person','Before')",
    ).run();
    const principal = await principalFor();
    const makeUpdate = (name) =>
      batch([
        {
          op: "update_record",
          entity: "people",
          targetId: "racing-person",
          expectedVersion: 1,
          fields: { display_name: name },
        },
      ]);
    const results = await Promise.all([
      commitSyncChangeset(
        db,
        principal,
        "race-one",
        makeUpdate("After one"),
        NOW,
      ),
      commitSyncChangeset(
        db,
        principal,
        "race-two",
        makeUpdate("After two"),
        NOW,
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "committed").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal(
      db.prepare("SELECT version FROM people WHERE id='racing-person'").get()
        .version,
      2,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      1,
    );
  });
});

test("transaction-time stale version failure rolls back earlier changes and audit", async () => {
  await fixture(async (db, principalFor) => {
    db.prepare(
      "INSERT INTO people(id,display_name) VALUES ('guarded-person','Before')",
    ).run();
    db.exec(`CREATE TRIGGER interfere_before_insert BEFORE INSERT ON organizations BEGIN
      UPDATE people SET display_name='Intervening', version=version+1 WHERE id='guarded-person';
    END;`);
    const principal = await principalFor();
    const request = batch([
      create("create_organization", "organizations", "org", {
        name: "Synthetic Office",
        organization_type: "office",
        county_fips: "08001",
      }),
      {
        op: "update_record",
        entity: "people",
        targetId: "guarded-person",
        expectedVersion: 1,
        fields: { display_name: "Requested" },
      },
    ]);
    const result = await commitSyncChangeset(
      db,
      principal,
      "guarded-key",
      request,
      NOW,
    );
    assert.equal(result.status, "rejected");
    assert.equal(
      db
        .prepare(
          "SELECT version,display_name FROM people WHERE id='guarded-person'",
        )
        .get().version,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT display_name FROM people WHERE id='guarded-person'")
        .get().display_name,
      "Before",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM organizations").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='sync.batch.commit'",
        )
        .get().n,
      0,
    );
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  listCountyOrganizations,
  listCountyRoleEntries,
} from "../dist/services/directory.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangeset } from "../dist/services/sync-commit.js";
import {
  lookupSyncBatch,
  reverseSyncBatch,
} from "../dist/services/sync-history.js";

const requestId = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19";
const now = () => new Date("2026-11-13T12:00:00.000Z");
const create = (op, entity, clientRef, fields) => ({
  op,
  entity,
  clientRef,
  fields,
});
const batch = {
  contractVersion: "m2-sync/v1",
  requestId,
  intent: "commit",
  changes: [
    create("create_organization", "organizations", "org", {
      name: "Synthetic Adams Office",
      organization_type: "office",
      county_fips: "08001",
    }),
    create(
      "add_county_affiliation",
      "organization_county_affiliations",
      "aff",
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
      publisher_classification: "official",
      source_type: "official_page",
    }),
    create("create_person_role", "person_roles", "role", {
      person_ref: "person",
      position_ref: "position",
      source_ref: "source",
      county_fips: "08001",
      source_checked_at: "2026-11-12T12:00:00Z",
    }),
  ],
};

async function fixture(callback) {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-m2d-"));
  const path = join(dir, "website.sqlite");
  let db = await openWebsiteDatabase(path);
  migrateWebsiteDatabase(db);
  db.exec(`INSERT INTO accounts (id,kind,role,display_name,preferences) VALUES ('owner-a','human','owner','Synthetic Owner','{}'),('owner-b','human','owner','Synthetic Other','{}');
    INSERT INTO identities (id,account_id,provider,subject) VALUES ('identity-a','owner-a','test-human','subject-a'),('identity-b','owner-b','test-human','subject-b');`);
  const adapter = createTestHumanIdentityAdapter({
    a: "subject-a",
    b: "subject-b",
  });
  const principal = (who = "a") =>
    resolvePrincipal(
      db,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": who },
      }),
      adapter,
    );
  try {
    await callback({
      get db() {
        return db;
      },
      path,
      principal,
      reopen: async () => {
        db.close();
        db = await openWebsiteDatabase(path);
        migrateWebsiteDatabase(db);
      },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("lookup is actor scoped and retains the original Website ID mapping across restart", async () => {
  await fixture(async (f) => {
    const owner = await f.principal();
    const committed = await commitSyncChangeset(
      f.db,
      owner,
      "lookup-key",
      batch,
      now,
    );
    assert.equal(committed.status, "committed");
    if (committed.status !== "committed") return;
    const first = lookupSyncBatch(f.db, owner, {
      idempotencyKey: "lookup-key",
    });
    assert.equal(first.items[4].websiteId, committed.items[4].websiteId);
    assert.equal(
      lookupSyncBatch(f.db, await f.principal("b"), {
        batchId: committed.batchId,
      }),
      null,
    );
    await f.reopen();
    const again = lookupSyncBatch(f.db, await f.principal(), {
      batchId: committed.batchId,
    });
    assert.deepEqual(again.items, first.items);
  });
});

test("successful reversal removes active directory rows and exact retries replay", async () => {
  await fixture(async (f) => {
    const owner = await f.principal();
    const committed = await commitSyncChangeset(
      f.db,
      owner,
      "reverse-target",
      batch,
      now,
    );
    const first = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "reverse-key",
      now,
    );
    assert.equal(first.status, "reverted");
    assert.equal(
      listCountyOrganizations(f.db, { countyFips: "08001" }).items.length,
      0,
    );
    assert.equal(
      listCountyRoleEntries(f.db, { countyFips: "08001" }).items.length,
      0,
    );
    assert.equal(
      lookupSyncBatch(f.db, owner, { batchId: committed.batchId }).status,
      "reverted",
    );
    assert.deepEqual(
      await reverseSyncBatch(
        f.db,
        owner,
        committed.batchId,
        "reverse-key",
        now,
      ),
      { ...first, replayed: true },
    );
    assert.equal(
      (
        await reverseSyncBatch(
          f.db,
          owner,
          committed.batchId,
          "another-key",
          now,
        )
      ).status,
      "already_reverted",
    );
    await f.reopen();
    assert.equal(
      lookupSyncBatch(f.db, await f.principal(), { batchId: committed.batchId })
        .status,
      "reverted",
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='sync.batch.reverse'",
        )
        .get().n,
      1,
    );
  });
});

test("a later dependent role blocks the whole reversal without partial deletion", async () => {
  await fixture(async (f) => {
    const owner = await f.principal();
    const committed = await commitSyncChangeset(
      f.db,
      owner,
      "dependent-target",
      batch,
      now,
    );
    const ids = Object.fromEntries(
      committed.items.map((item) => [item.clientRef, item.websiteId]),
    );
    f.db
      .prepare(
        `INSERT INTO person_roles (id,person_id,position_id,source_id,source_checked_at) VALUES ('later-role', ?, ?, ?, '2026-11-13T00:00:00Z')`,
      )
      .run(ids.person, ids.position, ids.source);
    const before = f.db
      .prepare("SELECT count(*) AS n FROM audit_events")
      .get().n;
    const result = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "blocked-key",
      now,
    );
    assert.equal(result.status, "reversal_blocked");
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM organizations").get().n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM audit_events").get().n,
      before,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM sync_batch_reversals").get().n,
      0,
    );
  });
});

test("updates restore prior fields with a new version and reused sources remain", async () => {
  await fixture(async (f) => {
    f.db.exec(`INSERT INTO people (id,display_name) VALUES ('existing-person','Before');
      INSERT INTO role_sources (id,url,title,source_type,publisher_classification) VALUES ('existing-source','https://example.invalid/reuse','Reusable source','official_page','official');`);
    const owner = await f.principal();
    const request = {
      ...batch,
      changes: [
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
          publisher_classification: "official",
          source_type: "official_page",
        }),
      ],
    };
    const committed = await commitSyncChangeset(
      f.db,
      owner,
      "update-target",
      request,
      now,
    );
    assert.equal(committed.status, "committed");
    const result = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "update-reversal",
      now,
    );
    assert.equal(result.status, "reverted");
    assert.deepEqual(
      f.db
        .prepare(
          "SELECT display_name,version FROM people WHERE id='existing-person'",
        )
        .get(),
      { display_name: "Before", version: 3 },
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM role_sources WHERE id='existing-source'",
        )
        .get().n,
      1,
    );
  });
});

test("malformed inverse metadata fails closed without applying any item", async () => {
  await fixture(async (f) => {
    const owner = await f.principal();
    const committed = await commitSyncChangeset(
      f.db,
      owner,
      "malformed-target",
      batch,
      now,
    );
    const record = f.db
      .prepare(
        "SELECT inverse_json FROM sync_batch_items WHERE batch_id = ? AND item_index = 0",
      )
      .get(committed.batchId);
    const inverse = JSON.parse(record.inverse_json);
    inverse.targetId = "some-other-record";
    f.db
      .prepare(
        "UPDATE sync_batch_items SET inverse_json = ? WHERE batch_id = ? AND item_index = 0",
      )
      .run(JSON.stringify(inverse), committed.batchId);
    const result = await reverseSyncBatch(
      f.db,
      owner,
      committed.batchId,
      "malformed-reversal",
      now,
    );
    assert.equal(result.status, "reversal_blocked");
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM organizations").get().n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM sync_batch_reversals").get().n,
      0,
    );
  });
});

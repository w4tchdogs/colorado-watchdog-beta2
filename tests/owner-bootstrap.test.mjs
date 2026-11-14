import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  BETA2_PROJECT_ID,
  BETA2_SITES_PROVIDER,
  bootstrapFirstOwner,
} from "../dist/services/owner-bootstrap.js";

function d1Fixture() {
  const local = openWebsiteDatabase();
  return local.then((database) => {
    migrateWebsiteDatabase(database);
    let failBatchAfter = null;
    const binding = {
      prepare(sql) {
        let values = [];
        return {
          bind(...args) {
            values = args;
            return this;
          },
          async first(column) {
            const row = database.prepare(sql).get(...values) ?? null;
            return column && row ? (row[column] ?? null) : row;
          },
          async all() {
            return {
              success: true,
              results: database.prepare(sql).all(...values),
            };
          },
          async run() {
            database.prepare(sql).run(...values);
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
      async batch(statements) {
        let count = 0;
        return database.transaction(() =>
          statements.map((statement) => {
            if (failBatchAfter !== null && count++ === failBatchAfter) {
              throw new Error("synthetic D1 batch failure");
            }
            const prepared = statement;
            return prepared.run();
          }),
        )();
      },
    };
    return {
      database,
      service: new AsyncD1Database(binding),
      failAfter(index) {
        failBatchAfter = index;
      },
      close() {
        database.close();
      },
    };
  });
}

const input = (overrides = {}) => ({
  projectId: BETA2_PROJECT_ID,
  bindingName: "DB",
  subject: "opaque-Synthetic-Subject/CaseSensitive",
  operatorReference: "synthetic-operator-17",
  ...overrides,
});

test("first-owner bootstrap is dry-run safe, atomic, attributed and idempotent", async () => {
  const fixture = await d1Fixture();
  try {
    assert.deepEqual(
      await bootstrapFirstOwner(fixture.service, input({ dryRun: true })),
      { status: "ready" },
    );
    assert.equal(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM accounts").get().n,
      0,
    );
    const created = await bootstrapFirstOwner(fixture.service, input());
    assert.equal(created.status, "created");
    assert.deepEqual(await bootstrapFirstOwner(fixture.service, input()), {
      status: "already_complete",
    });
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner'")
        .get().n,
      1,
    );
    const link = fixture.database
      .prepare("SELECT provider, subject FROM identities WHERE account_id = ?")
      .get(created.accountId);
    assert.deepEqual(link, {
      provider: BETA2_SITES_PROVIDER,
      subject: input().subject,
    });
    const event = fixture.database
      .prepare(
        "SELECT actor_kind, actor_reference, action, account_id, provider, site_project_id FROM owner_bootstrap_audit",
      )
      .get();
    assert.equal(event.actor_kind, "trusted_bootstrap_operator");
    assert.equal(event.actor_reference, "synthetic-operator-17");
    assert.equal(event.action, "account.first_owner.bootstrap");
    assert.equal(event.account_id, created.accountId);
    assert.equal(event.provider, BETA2_SITES_PROVIDER);
    assert.equal(event.site_project_id, BETA2_PROJECT_ID);
    assert.equal(Object.hasOwn(event, "subject"), false);
  } finally {
    fixture.close();
  }
});

test("bootstrap rejects wrong targets, conflicting owners, and partial state", async () => {
  const fixture = await d1Fixture();
  try {
    await assert.rejects(
      bootstrapFirstOwner(fixture.service, input({ projectId: "wrong" })),
      TypeError,
    );
    await assert.rejects(
      bootstrapFirstOwner(fixture.service, input({ bindingName: "OTHER" })),
      TypeError,
    );
    await assert.rejects(
      bootstrapFirstOwner(fixture.service, input({ subject: "bad\nsubject" })),
      TypeError,
    );
    fixture.database
      .prepare(
        "INSERT INTO accounts (id,kind,role,display_name) VALUES ('existing-owner','human','owner','Existing Owner')",
      )
      .run();
    await assert.rejects(
      bootstrapFirstOwner(fixture.service, input()),
      /conflicts/,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM owner_bootstrap_audit")
        .get().n,
      0,
    );
  } finally {
    fixture.close();
  }
});

test("bootstrap rejects a claimed subject already linked to another account and altered migration history", async () => {
  const fixture = await d1Fixture();
  try {
    fixture.database
      .prepare(
        "INSERT INTO accounts (id, kind, role, display_name) VALUES ('synthetic-contributor','human','contributor','Synthetic Contributor')",
      )
      .run();
    fixture.database
      .prepare(
        "INSERT INTO identities (id,account_id,provider,subject) VALUES ('synthetic-existing-link','synthetic-contributor',?,?)",
      )
      .run(BETA2_SITES_PROVIDER, input().subject);
    await assert.rejects(
      bootstrapFirstOwner(fixture.service, input()),
      /conflicts/,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner'")
        .get().n,
      0,
    );
  } finally {
    fixture.close();
  }

  const altered = await d1Fixture();
  try {
    altered.database
      .prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 14")
      .run("f".repeat(64));
    await assert.rejects(
      bootstrapFirstOwner(altered.service, input({ dryRun: true })),
      /migration state/,
    );
  } finally {
    altered.close();
  }
});

test("concurrent bootstrap attempts create at most one owner; failed batch rolls back", async () => {
  const fixture = await d1Fixture();
  try {
    fixture.failAfter(1);
    await assert.rejects(
      bootstrapFirstOwner(fixture.service, input()),
      /atomic batch failed/,
    );
    assert.equal(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM accounts").get().n,
      0,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM owner_bootstrap_audit")
        .get().n,
      0,
    );
    fixture.failAfter(null);
    const results = await Promise.all([
      bootstrapFirstOwner(fixture.service, input()),
      bootstrapFirstOwner(fixture.service, input()),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [
      "already_complete",
      "created",
    ]);
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner'")
        .get().n,
      1,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM owner_bootstrap_audit")
        .get().n,
      1,
    );
  } finally {
    fixture.close();
  }
});

test("competing subjects cannot seize the first-owner slot", async () => {
  const fixture = await d1Fixture();
  try {
    const results = await Promise.allSettled([
      bootstrapFirstOwner(fixture.service, input()),
      bootstrapFirstOwner(
        fixture.service,
        input({ subject: "different-synthetic-subject" }),
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner'")
        .get().n,
      1,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM owner_bootstrap_audit")
        .get().n,
      1,
    );
  } finally {
    fixture.close();
  }
});

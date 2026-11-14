import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createServices } from "../dist/services/index.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangesetD1 } from "../dist/services/sync-commit-d1.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";
import { reverseSyncBatchD1 } from "../dist/services/sync-revert-d1.js";

function bridge(mode, ...args) {
  const result = spawnSync(
    "python",
    ["-B", "tests/r7_profiles_bridge.py", mode, ...args],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function localD1(database) {
  const binding = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...parameters) {
          values = parameters;
          return statement;
        },
        async first() {
          return database.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: database.prepare(sql).all(...values),
          };
        },
        async run() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
        runSync() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements) {
      return database.transaction(() =>
        statements.map((statement) => statement.runSync()),
      )();
    },
  };
  return new AsyncD1Database(binding);
}

const allow = async (_principal, capability) =>
  capability === "sync.apply" || capability === "sync.revert";

test("R7 synthetic Profiles changeset validates, commits in D1, reconciles, updates, reads, and reverses safely", async () => {
  const temp = mkdtempSync(join(tmpdir(), "watchdog-r7-"));
  const researchDb = join(temp, "profiles.sqlite");
  const fixture = bridge("setup", researchDb);
  assert.equal(fixture.eligible, 17);
  assert.ok(
    fixture.excluded.some(
      (x) => x.entity_id === "claim-open" && x.reason === "identity_unresolved",
    ),
  );
  assert.ok(
    fixture.excluded.some(
      (x) =>
        x.entity_id === "claim-ambiguous" &&
        x.reason === "ambiguous_source_classification",
    ),
  );
  assert.equal(
    JSON.stringify(fixture.request).includes("PRIVATE FIXTURE NOTE"),
    false,
  );
  const sameNamePeople = fixture.request.changes.filter(
    (x) =>
      x.op === "create_person" &&
      x.fields.display_name === "Synthetic Jordan Example",
  );
  assert.equal(sameNamePeople.length, 2);
  assert.notEqual(sameNamePeople[0].clientRef, sameNamePeople[1].clientRef);

  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('r7-owner','human','owner','R7 Synthetic Owner');
      INSERT INTO identities (id, account_id, provider, subject) VALUES ('r7-identity','r7-owner','test-human','owner');
    `);
    const principal = await resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": "owner" },
      }),
      createTestHumanIdentityAdapter({ owner: "owner" }),
    );
    assert.ok(principal);
    const d1 = localD1(database);
    const dryRun = { ...fixture.request, intent: "dry_run" };
    const plan = await planSyncChangesetD1(d1, dryRun, () => new Date());
    assert.equal(plan.eligible, true, JSON.stringify(plan.errors));
    assert.equal(plan.items.length, fixture.request.changes.length);

    const committed = await commitSyncChangesetD1(
      d1,
      principal,
      "r7-initial-commit-key",
      fixture.request,
      { authorize: allow },
    );
    assert.equal(committed.status, "committed");
    if (committed.status !== "committed") return;
    assert.equal(committed.items.length, fixture.request.changes.length);
    assert.equal(
      committed.items.filter((x) => x.outcome === "created").length,
      fixture.request.changes.length,
    );
    const replay = await commitSyncChangesetD1(
      d1,
      principal,
      "r7-initial-commit-key",
      fixture.request,
      { authorize: allow },
    );
    assert.equal(replay.status, "committed");
    if (replay.status === "committed") assert.equal(replay.replayed, true);

    const services = createServices({ database });
    const organizations = services.listCountyOrganizations({
      countyFips: "08001",
    });
    const roles = services.listCountyRoleEntries({ countyFips: "08001" });
    assert.ok(organizations.items.some((x) => x.name === "Division Division"));
    assert.ok(
      organizations.items.some(
        (x) =>
          x.name === "Partner Partnership" &&
          x.countyAssociation.affiliations.includes("partner_for"),
      ),
    );
    assert.equal(roles.items.length, 4);
    assert.ok(
      roles.items.every((x) =>
        x.source.url.startsWith("https://example.invalid/"),
      ),
    );
    assert.equal(
      roles.items.filter(
        (x) => x.person.displayName === "Synthetic Jordan Example",
      ).length,
      4,
    );

    const acknowledged = bridge(
      "ack",
      researchDb,
      JSON.stringify(committed),
      fixture.submission_id,
    );
    assert.equal(acknowledged.result.state, "committed");
    assert.equal(acknowledged.repeat.replayed, true);
    assert.ok(acknowledged.mapping_count >= fixture.request.changes.length - 1);
    assert.equal(acknowledged.unresolved, 1);

    const updateFixture = bridge("prepare-update", researchDb);
    const stale = {
      ...updateFixture.request,
      changes: [{ ...updateFixture.request.changes[0], expectedVersion: 99 }],
    };
    const conflict = await planSyncChangesetD1(
      d1,
      { ...stale, intent: "dry_run" },
      () => new Date(),
    );
    assert.equal(conflict.eligible, false);
    assert.ok(conflict.errors.some((x) => x.code === "stale_version"));
    const update = await commitSyncChangesetD1(
      d1,
      principal,
      "r7-update-commit-key",
      updateFixture.request,
      { authorize: allow },
    );
    assert.equal(update.status, "committed");
    if (update.status !== "committed") return;
    assert.equal(update.items[0].outcome, "updated");
    const afterUpdate = services.listCountyRoleEntries({ countyFips: "08001" });
    assert.ok(
      afterUpdate.items.some(
        (x) => x.person.displayName === "Synthetic Jordan Example Revised",
      ),
    );
    const updatedLocal = bridge(
      "ack-update",
      researchDb,
      JSON.stringify(update),
      updateFixture.submission_id,
    );
    assert.equal(updatedLocal.version, 2);
    assert.equal(updatedLocal.approval_state, "consumed");

    const reversed = await reverseSyncBatchD1(
      d1,
      principal,
      update.batchId,
      "r7-update-reversal-key",
      { authorize: allow },
    );
    assert.equal(reversed.status, "reverted");
    if (reversed.status !== "reverted") return;
    const recovery = bridge(
      "reversal",
      researchDb,
      reversed.batchId,
      JSON.stringify(reversed),
    );
    assert.equal(recovery.link_state, "needs_refresh");
    const afterReversal = services.listCountyRoleEntries({
      countyFips: "08001",
    });
    assert.ok(
      afterReversal.items.some(
        (x) => x.person.displayName === "Synthetic Jordan Example",
      ),
    );
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM sync_batches").get().n,
      2,
    );
  } finally {
    database.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

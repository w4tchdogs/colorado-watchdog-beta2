import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createD1PublicReadServices } from "../dist/services/d1-public-reads.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import {
  createD1ProfilesImportService,
  ImportStalePreviewError,
} from "../dist/services/profiles-import-d1.js";
import { addPerson, withStructure } from "./county-structure-fixtures.mjs";

async function withDelete(callback) {
  await withStructure(async ({ database, d1, owner, admin }) => {
    addPerson(database, { personId: "person-keep", roleId: "role-keep" });
    const options = {
      authorize: async (principal) => principal.role === "owner",
    };
    const service = createD1ProfilesImportService(d1, options);
    const profiles = createD1ProfilesService(d1, options);
    const count = (table) =>
      database.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    await callback({
      database,
      d1,
      service,
      profiles,
      owner,
      editor: admin,
      count,
    });
  });
}

const files = {
  profile:
    "profile_id,display_name\nP1,Synthetic Alpha Q Tester\nP2,Synthetic Beta",
  profileRole: [
    "role_id,profile_id,county_fips,published_office,source_id,source_url,source_title,publisher_classification,source_type",
    "R1,P1,08001,Synthetic Recorder,S1,https://example.invalid/a,Shared Source,official,official_page",
    "R3,P1,08001,Synthetic Recorder,S2,https://example.invalid/b,Retained Source,official,official_page",
    "R2,P2,08001,Synthetic Recorder,S1,https://example.invalid/a,Shared Source,official,official_page",
  ].join("\n"),
  profileName: [
    "profile_name_id,profile_id,name_type,published_name",
    "N1,P1,nickname,Synthetic Nickname Alpha",
    "N2,P1,former_surname,Alpha Formerly",
    "N3,P2,spelling_variant,Synthetic Betta",
  ].join("\n"),
};

const idFor = (database, key) =>
  database
    .prepare("SELECT target_id id FROM sync_batch_items WHERE client_ref = ?")
    .get(`dash:profile:${key}`)?.id;

test("owner deletion preserves the shared import and explicitly re-adds only the retired Profile", async () => {
  await withDelete(
    async ({ database, d1, service, profiles, owner, editor, count }) => {
      const initial = await service.preview(owner, { files });
      const batch = await service.commit(owner, "key-delete-seed", {
        files,
        digest: initial.digest,
      });
      const alpha = idFor(database, "P1");
      const beta = idFor(database, "P2");
      assert.ok(alpha && beta);
      const alphaRoles = database
        .prepare("SELECT id FROM person_roles WHERE person_id = ? ORDER BY id")
        .all(alpha);
      const nickname = await profiles.alternateNames(owner, alpha);
      const first = nickname.names.find(
        (n) => n.publishedName === "Synthetic Nickname Alpha",
      );
      await profiles.save(owner, "key-delete-publish", [
        {
          kind: "visibility",
          personId: alpha,
          expectedVersion: 1,
          visible: true,
        },
        {
          kind: "alternate_name",
          op: "update",
          personId: alpha,
          nameId: first.id,
          expectedVersion: first.version,
          fields: {
            nameType: first.nameType,
            publishedName: first.publishedName,
            verificationStatus: "confirmed",
            publicDisplay: true,
          },
        },
      ]);
      database.exec(`
      INSERT INTO county_unit (id, county_fips, name, organization_type)
      VALUES ('del-unit', '08001', 'Synthetic delete unit', 'office');
    `);
      database
        .prepare(`INSERT INTO county_role_display
      (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
      VALUES ('del-link', ?, '08001', 'del-unit', 'home', 'cs-owner')`)
        .run(alphaRoles[0].id);
      const publicReads = createD1PublicReadServices(d1);
      const alias = "Synthetic Nickname Alpha";
      assert.equal(
        (await publicReads.searchPeople({ query: alias })).items.length,
        1,
      );
      const preview = await profiles.previewDelete(owner, { profileId: alpha });
      assert.deepEqual(preview.counts, { roles: 2, names: 2, countyLinks: 1 });
      assert.deepEqual(preview.counties, ["Adams"]);
      assert.equal(preview.visible, true);
      const deletion = {
        profileId: alpha,
        digest: preview.digest,
        confirmation: "DELETE",
        reason: "incorrect",
      };
      await assert.rejects(
        profiles.commitDelete(editor, "key-delete-role", deletion),
      );
      await assert.rejects(
        profiles.commitDelete(owner, "key-delete-type", {
          ...deletion,
          confirmation: "Delete",
        }),
        { code: "invalid_request" },
      );
      const ledgerBefore = count("sync_batch_items");
      const namesBefore = count("profile_name_events");
      const sourcesBefore = count("role_sources");

      // Verify a failed audit insert rolls back links, names, roles and retirement records too.
      database.exec(`CREATE TRIGGER synthetic_refuse_delete_audit
      BEFORE INSERT ON audit_events WHEN NEW.action = 'profile.delete'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit rejection'); END`);
      await assert.rejects(
        profiles.commitDelete(owner, "key-delete-atomic", deletion),
        (error) => error.cause?.message === "synthetic audit rejection",
      );
      assert.equal(
        (await profiles.previewDelete(owner, { profileId: alpha })).digest,
        preview.digest,
      );
      assert.equal(count("profile_deleted_targets"), 0);
      database.exec("DROP TRIGGER synthetic_refuse_delete_audit");

      const receipts = await Promise.all([
        profiles.commitDelete(owner, "key-delete-atomic", deletion),
        profiles.commitDelete(owner, "key-delete-atomic", deletion),
      ]);
      assert.deepEqual(receipts.map((receipt) => receipt.replayed).sort(), [
        false,
        true,
      ]);
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) n FROM audit_events WHERE action = 'profile.delete' AND target_id = ?",
          )
          .get(alpha).n,
        1,
      );
      await assert.rejects(
        profiles.commitDelete(owner, "key-delete-atomic", {
          ...deletion,
          reason: "other",
        }),
        { code: "idempotency_conflict" },
      );
      assert.equal(
        (await publicReads.searchPeople({ query: alias })).items.length,
        0,
      );
      assert.equal(await profiles.alternateNames(owner, alpha), null);
      assert.equal(count("county_role_display"), 0);
      assert.equal(count("county_unit"), 1);
      assert.equal(count("profile_deleted_targets"), 5);
      assert.equal(count("profile_name_events"), namesBefore);
      assert.equal(count("role_sources"), sourcesBefore);
      assert.equal(count("sync_batch_items"), ledgerBefore);
      assert.equal(
        database
          .prepare("SELECT COUNT(*) n FROM person_roles WHERE person_id = ?")
          .get(beta).n,
        1,
      );
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

      await assert.rejects(
        service.reverse(owner, batch.batchId, "key-delete-reverse"),
        { code: "reversal_profile_deleted" },
      );
      const ordinary = await service.preview(owner, { files });
      assert.equal(ordinary.canCommit, true);
      assert.equal(ordinary.profiles.add, 0);
      assert.equal(
        ordinary.rows.filter((row) => row.deletedOnWebsite).length,
        5,
      );
      assert.equal(ordinary.sources.add, 0);
      const corrected = {
        ...files,
        profile: files.profile.replace(
          "Synthetic Alpha Q Tester",
          "Synthetic Alpha Corrected",
        ),
      };
      const readd = await service.preview(owner, {
        files: corrected,
        readdProfileId: "P1",
      });
      assert.equal(readd.canCommit, true, JSON.stringify(readd.issues));
      assert.equal(readd.newProfilesHidden, 1);
      assert.equal(readd.roles.add, 2);
      assert.equal(readd.names.add, 2);
      await assert.rejects(
        service.commit(owner, "key-delete-readd", {
          files: corrected,
          digest: readd.digest,
        }),
        ImportStalePreviewError,
      );
      const readded = await service.commit(owner, "key-delete-readd", {
        files: corrected,
        digest: readd.digest,
        readdProfileId: "P1",
      });
      assert.equal(readded.created.profiles, 1);
      assert.equal(count("role_sources"), sourcesBefore);
      const newId = database
        .prepare(
          "SELECT id FROM people WHERE display_name = 'Synthetic Alpha Corrected'",
        )
        .get().id;
      assert.notEqual(newId, alpha);
      assert.equal(
        (await profiles.previewDelete(owner, { profileId: newId })).visible,
        false,
      );
      assert.equal(
        (await service.preview(owner, { files: corrected })).rows.filter(
          (row) => row.deletedOnWebsite,
        ).length,
        0,
      );
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    },
  );
});

test("an intervening staff report invalidates the Profile delete preview and blocks removal", async () => {
  await withDelete(async ({ database, profiles, owner }) => {
    const profileId = "person-keep";
    const preview = await profiles.previewDelete(owner, { profileId });
    database
      .prepare(`INSERT INTO reports (id, county_fips, subject_kind, subject_id, private_json, status, version, created_at)
      VALUES ('del-report', '08001', 'person', ?, '{}', 'submitted', 1, '2026-11-20')`)
      .run(profileId);
    const body = {
      profileId,
      digest: preview.digest,
      confirmation: "DELETE",
      reason: "other",
    };
    await assert.rejects(
      profiles.commitDelete(owner, "key-delete-stale", body),
      { code: "stale_preview" },
    );
    const fresh = await profiles.previewDelete(owner, { profileId });
    assert.equal(fresh.blockers.reports, 1);
    await assert.rejects(
      profiles.commitDelete(owner, "key-delete-block", {
        ...body,
        digest: fresh.digest,
      }),
      { code: "delete_blocked" },
    );
    assert.equal(
      database
        .prepare("SELECT subject_id FROM reports WHERE id = 'del-report'")
        .get().subject_id,
      profileId,
    );
    assert.ok(
      database.prepare("SELECT 1 FROM people WHERE id = ?").get(profileId),
    );
  });
});

test("migration 0035 preserves existing append-only name history", async () => {
  const database = await openWebsiteDatabase();
  try {
    const migrations = loadWebsiteMigrations();
    migrateWebsiteDatabase(
      database,
      migrations.filter((m) => m.version < 35),
    );
    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('migration-owner', 'human', 'owner', 'Synthetic Owner');
      INSERT INTO people (id, display_name) VALUES ('migration-person', 'Synthetic Old Name');
      INSERT INTO profile_names (id, person_id, name_type, published_name)
        VALUES ('migration-name', 'migration-person', 'nickname', 'Synthetic Alias');
      INSERT INTO profile_name_events (id, person_id, profile_name_id, action, actor_account_id, after_json)
        VALUES ('migration-event', 'migration-person', 'migration-name', 'alternate_add', 'migration-owner', '{"kept":true}');
    `);
    const event = () =>
      database.prepare("SELECT * FROM profile_name_events").all();
    const before = event();
    migrateWebsiteDatabase(database, migrations);
    assert.deepEqual(event(), before);
    assert.throws(
      () => database.exec("DELETE FROM profile_name_events"),
      /append-only/,
    );
    database.exec("DELETE FROM profile_names; DELETE FROM people;");
    assert.deepEqual(event(), before);
    assert.throws(
      () =>
        database.exec(`INSERT INTO profile_name_events
      (id, person_id, action, actor_account_id) VALUES ('invalid', 'migration-person', 'primary_update', 'migration-owner')`),
      /require a live matching target/,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

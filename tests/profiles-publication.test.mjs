import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { getPersonProfile } from "../dist/services/person-profile.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import { createD1ProfilesImportService } from "../dist/services/profiles-import-d1.js";
import { withStructure } from "./county-structure-fixtures.mjs";

/**
 * Profile publication rule, roleless drafts and Last Uploaded
 * (PROFILES-PUBLISH-1). Synthetic data only, through the real dashboard
 * importer and the owner Profiles service.
 */

const lines = (rows) => `${rows.map((r) => r.join(",")).join("\r\n")}\r\n`;
const ROLE_HEAD = [
  "role_id",
  "profile_id",
  "county_fips",
  "published_title",
  "start_date",
];
const role = (id, profile, title = "Synthetic Title", county = "08001") => [
  id,
  profile,
  county,
  title,
  "",
];
const profiles = (rows) => lines([["profile_id", "display_name"], ...rows]);
const roles = (rows) => lines([ROLE_HEAD, ...rows]);
const names = (rows) =>
  lines([
    ["profile_name_id", "profile_id", "name_type", "published_name"],
    ...rows,
  ]);

let counter = 0;
const key = (prefix = "pub") => {
  counter += 1;
  return `${prefix}-key-${String(counter).padStart(6, "0")}`;
};

async function withProfiles(callback) {
  await withStructure(async (ctx) => {
    const authorize = async (principal) => principal.accountId === "cs-owner";
    let clock = new Date("2026-11-19T10:00:00.000Z");
    const now = () => clock;
    const importer = createD1ProfilesImportService(ctx.d1, { authorize, now });
    const service = createD1ProfilesService(ctx.d1, { authorize, now });
    const upload = async (files, idempotencyKey = key("upload")) => {
      const preview = await importer.preview(ctx.owner, { files });
      assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
      const receipt = await importer.commit(ctx.owner, idempotencyKey, {
        files,
        digest: preview.digest,
      });
      return { preview, receipt, idempotencyKey, files };
    };
    const personFor = (profileKey) =>
      ctx.database
        .prepare(
          "SELECT target_id AS id FROM sync_batch_items WHERE client_ref = ? ORDER BY batch_id LIMIT 1",
        )
        .get(`dash:profile:${profileKey}`)?.id;
    const rowsFor = async (personId, query = {}) =>
      (
        await service.listRows(ctx.owner, { pageSize: 100, ...query })
      ).rows.filter((row) => row.profileId === personId);
    const visibility = async (personId, visible) => {
      const [row] = await rowsFor(personId);
      return service.save(ctx.owner, key("vis"), [
        {
          kind: "visibility",
          personId,
          expectedVersion: row.visibilityVersion,
          visible,
        },
      ]);
    };
    await callback({
      ...ctx,
      importer,
      service,
      upload,
      personFor,
      rowsFor,
      visibility,
      setClock: (iso) => {
        clock = new Date(iso);
      },
    });
  });
}

test("all three CSVs import together and a roleless Profile is a findable hidden draft", async () => {
  await withProfiles(async (ctx) => {
    const { receipt } = await ctx.upload({
      profile: profiles([
        ["P-multi", "Synthetic Multi Role"],
        ["P-draft", "Synthetic Draft Without Role"],
      ]),
      profileRole: roles([
        role("R-multi-1", "P-multi", "Synthetic Clerk"),
        role("R-multi-2", "P-multi", "Synthetic Deputy Clerk"),
      ]),
      profileName: names([
        ["N-multi", "P-multi", "nickname", "Synthetic Nick"],
      ]),
    });
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.created.profiles, 2);
    assert.equal(receipt.created.roles, 2);
    assert.equal(receipt.created.names, 1);
    assert.equal(receipt.newProfilesHidden, 2);

    const draft = ctx.personFor("P-draft");
    const multi = ctx.personFor("P-multi");
    const draftRows = await ctx.rowsFor(draft);
    assert.equal(draftRows.length, 1, "one row for a roleless Profile");
    const [row] = draftRows;
    assert.equal(row.roleId, null);
    assert.equal(row.rowKey, `profile:${draft}`);
    assert.equal(row.visible, false);
    assert.equal(row.publicationReady, false);
    assert.deepEqual(row.missingForPublication, ["role"]);
    assert.equal(row.publicationStatus, "Hidden · Missing role");
    assert.equal(row.displayName, "Synthetic Draft Without Role");
    assert.equal(row.lastUploaded, receipt.committedAt);

    // Multiple roles keep one row per role.
    const multiRows = await ctx.rowsFor(multi);
    assert.equal(multiRows.length, 2);
    assert.ok(multiRows.every((entry) => entry.publicationReady));
    assert.ok(multiRows.every((entry) => entry.publicationStatus === "Hidden"));

    // Search and filter find the draft.
    const found = await ctx.service.listRows(ctx.owner, {
      query: "Draft Without",
    });
    assert.deepEqual(
      found.rows.map((entry) => entry.profileId),
      [draft],
    );
    const incomplete = await ctx.service.listRows(ctx.owner, {
      visibility: "incomplete",
    });
    assert.deepEqual(
      incomplete.rows.map((entry) => entry.profileId),
      [draft],
    );
    const hidden = await ctx.service.listRows(ctx.owner, {
      visibility: "hidden",
    });
    assert.equal(hidden.total, 3);

    // The owner can open its names and edit its display name.
    const altNames = await ctx.service.alternateNames(ctx.owner, draft);
    assert.equal(altNames.profileId ?? draft, draft);
    const saved = await ctx.service.save(ctx.owner, key("name"), [
      {
        kind: "field",
        entity: "people",
        targetId: draft,
        field: "display_name",
        expectedVersion: row.profileVersion,
        value: "Synthetic Draft Renamed",
      },
    ]);
    assert.equal(saved.applied, 1);
    assert.equal(
      (await ctx.rowsFor(draft))[0].displayName,
      "Synthetic Draft Renamed",
    );
  });
});

test("Last Uploaded follows the latest committed import and sorts newest first", async () => {
  await withProfiles(async (ctx) => {
    ctx.setClock("2026-11-19T10:00:00.000Z");
    const first = await ctx.upload({
      profile: profiles([
        ["P-a", "Synthetic Alpha"],
        ["P-b", "Synthetic Beta"],
      ]),
      profileRole: roles([role("R-a", "P-a"), role("R-b", "P-b")]),
    });
    const alpha = ctx.personFor("P-a");
    const beta = ctx.personFor("P-b");
    // A Profile with no recorded upload shows a blank.
    ctx.database.exec(
      "INSERT INTO people (id, display_name) VALUES ('person-no-upload', 'Synthetic No Upload')",
    );
    assert.equal((await ctx.rowsFor("person-no-upload"))[0].lastUploaded, null);

    ctx.setClock("2026-11-19T11:00:00.000Z");
    // A role change for Beta only.
    const second = await ctx.upload({
      profile: profiles([["P-b", "Synthetic Beta"]]),
      profileRole: roles([
        role("R-b", "P-b", "Synthetic Title", "08001").map((value, index) =>
          index === 4 ? "2026-11-18" : value,
        ),
      ]),
    });
    assert.equal(second.receipt.status, "committed");
    assert.notEqual(second.receipt.committedAt, first.receipt.committedAt);
    assert.equal(
      (await ctx.rowsFor(alpha))[0].lastUploaded,
      first.receipt.committedAt,
    );
    assert.equal(
      (await ctx.rowsFor(beta))[0].lastUploaded,
      second.receipt.committedAt,
    );

    // Newest first.
    const sorted = await ctx.service.listRows(ctx.owner, {
      sort: "lastUploaded",
      direction: "desc",
    });
    assert.equal(sorted.rows[0].profileId, beta);
    assert.equal(sorted.rows.at(-1).lastUploaded, null);

    ctx.setClock("2026-11-19T12:00:00.000Z");
    // A preview, a same-key retry and an unchanged import leave it alone.
    await ctx.importer.preview(ctx.owner, {
      files: {
        profile: profiles([["P-a", "Synthetic Alpha Renamed"]]),
      },
    });
    const replay = await ctx.importer.commit(ctx.owner, second.idempotencyKey, {
      files: second.files,
      digest: second.preview.digest,
    });
    assert.equal(replay.replayed, true);
    const sameFiles = {
      profile: profiles([["P-a", "Synthetic Alpha"]]),
      profileRole: roles([role("R-a", "P-a")]),
    };
    const unchanged = await ctx.importer.preview(ctx.owner, {
      files: sameFiles,
    });
    const noop = await ctx.importer.commit(ctx.owner, key("noop"), {
      files: sameFiles,
      digest: unchanged.digest,
    });
    assert.equal(noop.status, "nothing_to_commit");
    assert.equal(
      (await ctx.rowsFor(alpha))[0].lastUploaded,
      first.receipt.committedAt,
    );
    assert.equal(
      (await ctx.rowsFor(beta))[0].lastUploaded,
      second.receipt.committedAt,
    );

    // An alternate name upload counts for its Profile.
    const named = await ctx.upload({
      profile: profiles([["P-a", "Synthetic Alpha"]]),
      profileName: names([["N-a", "P-a", "nickname", "Synthetic Al"]]),
    });
    assert.equal(
      (await ctx.rowsFor(alpha))[0].lastUploaded,
      named.receipt.committedAt,
    );
  });
});

test("publication is refused until the Profile is complete, singly and in bulk", async () => {
  await withProfiles(async (ctx) => {
    await ctx.upload({
      profile: profiles([
        ["P-ready", "Synthetic Ready"],
        ["P-draft", "Synthetic Draft"],
      ]),
      profileRole: roles([role("R-ready", "P-ready")]),
    });
    const ready = ctx.personFor("P-ready");
    const draft = ctx.personFor("P-draft");
    const [draftRow] = await ctx.rowsFor(draft);
    const [readyRow] = await ctx.rowsFor(ready);

    const single = await ctx.service.preview(ctx.owner, [
      {
        kind: "visibility",
        personId: draft,
        expectedVersion: draftRow.visibilityVersion,
        visible: true,
      },
    ]);
    assert.equal(single.ok, false);
    assert.equal(single.issues[0].code, "not_eligible");
    assert.match(single.issues[0].message, /Missing role/);

    // Bulk: one incomplete Profile refuses the whole batch.
    await assert.rejects(() =>
      ctx.service.save(ctx.owner, key("bulk"), [
        {
          kind: "visibility",
          personId: ready,
          expectedVersion: readyRow.visibilityVersion,
          visible: true,
        },
        {
          kind: "visibility",
          personId: draft,
          expectedVersion: draftRow.visibilityVersion,
          visible: true,
        },
      ]),
    );
    assert.equal((await ctx.rowsFor(ready))[0].visible, false);
    assert.equal((await ctx.rowsFor(draft))[0].visible, false);

    // A combined edit cannot blank the name and publish.
    const combined = await ctx.service.preview(ctx.owner, [
      {
        kind: "field",
        entity: "people",
        targetId: ready,
        field: "display_name",
        expectedVersion: readyRow.profileVersion,
        value: "",
      },
      {
        kind: "visibility",
        personId: ready,
        expectedVersion: readyRow.visibilityVersion,
        visible: true,
      },
    ]);
    assert.equal(combined.ok, false);

    // The complete Profile publishes on its own.
    const published = await ctx.visibility(ready, true);
    assert.equal(published.applied, 1);
    assert.equal((await ctx.rowsFor(ready))[0].publicationStatus, "Visible");

    // The database refuses a direct write that would publish the draft.
    assert.throws(() =>
      ctx.database.exec(
        `UPDATE person_visibility SET visible = 1, version = version + 1 WHERE person_id = '${draft}'`,
      ),
    );
  });
});

test("losing the last qualifying role hides the Profile, and restoring it waits for the owner", async () => {
  await withProfiles(async (ctx) => {
    await ctx.upload({
      profile: profiles([
        ["P-multi", "Synthetic Multi"],
        ["P-solo", "Synthetic Solo"],
      ]),
      profileRole: roles([role("R-multi-1", "P-multi")]),
    });
    const multi = ctx.personFor("P-multi");
    const solo = ctx.personFor("P-solo");
    // Later batch: a second role for Multi and the only role for Solo.
    const later = await ctx.upload({
      profile: profiles([
        ["P-multi", "Synthetic Multi"],
        ["P-solo", "Synthetic Solo"],
      ]),
      profileRole: roles([
        role("R-multi-2", "P-multi", "Synthetic Second Title"),
        role("R-solo", "P-solo"),
      ]),
    });
    await ctx.visibility(multi, true);
    await ctx.visibility(solo, true);
    assert.equal((await ctx.rowsFor(multi)).length, 2);
    assert.equal(
      getPersonProfile(ctx.database, { personId: solo }).person.id,
      solo,
    );

    // Reversing the later batch removes Multi's second role and Solo's only role.
    const reversal = await ctx.importer.reverse(
      ctx.owner,
      later.receipt.batchId,
      key("reverse"),
    );
    assert.equal(reversal.status, "reverted");

    const multiRows = await ctx.rowsFor(multi);
    assert.equal(multiRows.length, 1);
    assert.equal(multiRows[0].visible, true, "another role still qualifies");
    assert.equal(multiRows[0].publicationStatus, "Visible");

    const [soloRow] = await ctx.rowsFor(solo);
    assert.equal(soloRow.roleId, null);
    assert.equal(soloRow.visible, false);
    assert.equal(soloRow.hiddenReason, "incomplete");
    assert.equal(soloRow.publicationStatus, "Hidden · Missing role");
    const stored = ctx.database
      .prepare(
        "SELECT visible, hidden_reason, changed_by_account_id FROM person_visibility WHERE person_id = ?",
      )
      .get(solo);
    assert.deepEqual(
      { ...stored },
      { visible: 0, hidden_reason: "incomplete", changed_by_account_id: null },
    );
    assert.equal(getPersonProfile(ctx.database, { personId: solo }), null);

    // Restoring the role makes it publishable but leaves it hidden.
    await ctx.upload({
      profile: profiles([["P-solo", "Synthetic Solo"]]),
      profileRole: roles([role("R-solo-new", "P-solo")]),
    });
    const [restored] = await ctx.rowsFor(solo);
    assert.equal(restored.publicationReady, true);
    assert.equal(restored.visible, false);
    assert.equal(restored.publicationStatus, "Hidden · Ready to publish");
    assert.equal(getPersonProfile(ctx.database, { personId: solo }), null);
    await ctx.visibility(solo, true);
    const [published] = await ctx.rowsFor(solo);
    assert.equal(published.visible, true);
    assert.equal(published.hiddenReason, null);
  });
});

test("migration 0034 hides existing incomplete Profiles that were treated as visible", async () => {
  const database = await openWebsiteDatabase();
  try {
    const all = loadWebsiteMigrations();
    migrateWebsiteDatabase(
      database,
      all.filter((migration) => migration.version < 34),
    );
    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('m-owner', 'human', 'owner', 'Synthetic Owner');
      INSERT INTO role_sources (id, url, title, source_type) VALUES ('m-src', 'https://example.invalid/m', 'Synthetic', 'official_page');
      INSERT INTO people (id, display_name) VALUES
        ('m-ready', 'Synthetic Ready'), ('m-roleless', 'Synthetic Roleless'),
        ('m-flagged', 'Synthetic Flagged Visible'), ('m-hidden', 'Synthetic Owner Hidden');
      INSERT INTO person_roles (id, person_id, source_id, county_fips, published_title)
        VALUES ('m-role', 'm-ready', 'm-src', '08001', 'Synthetic Title'),
               ('m-role-hidden', 'm-hidden', 'm-src', '08001', 'Synthetic Title');
      INSERT INTO person_visibility (person_id, visible, changed_by_account_id)
        VALUES ('m-flagged', 1, 'm-owner'), ('m-hidden', 0, 'm-owner');
    `);
    migrateWebsiteDatabase(database, all);
    const rows = database
      .prepare(
        "SELECT person_id, visible, hidden_reason, changed_by_account_id FROM person_visibility ORDER BY person_id",
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      {
        person_id: "m-flagged",
        visible: 0,
        hidden_reason: "incomplete",
        changed_by_account_id: null,
      },
      {
        person_id: "m-hidden",
        visible: 0,
        hidden_reason: null,
        changed_by_account_id: "m-owner",
      },
      {
        person_id: "m-roleless",
        visible: 0,
        hidden_reason: "incomplete",
        changed_by_account_id: null,
      },
    ]);
    assert.equal(
      getPersonProfile(database, { personId: "m-ready" }).person.id,
      "m-ready",
    );
    assert.equal(getPersonProfile(database, { personId: "m-roleless" }), null);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

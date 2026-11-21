import assert from "node:assert/strict";
import test from "node:test";
import { parseAttachmentCsv } from "../dist/services/county-role-attachment.js";
import { D1CountyRoleAttachments } from "../dist/services/county-role-attachment-d1.js";
import { CountyStructureConflictError } from "../dist/services/county-structure-d1.js";
import { D1CountyStructurePublicService } from "../dist/services/county-structure-public.js";
import { createD1PublicReadServices } from "../dist/services/d1-public-reads.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import { createD1ProfilesImportService } from "../dist/services/profiles-import-d1.js";
import { createCountyStructureApiTransport } from "../dist/transport/county-structure-api.js";
import { csv, row, withStructure } from "./county-structure-fixtures.mjs";

/**
 * Role-to-unit attachment for one county, with synthetic data only. Roles
 * come from the real dashboard Profiles import, so the attachment resolves
 * them through the importer's stable `dash:role:` mappings. Units come from a
 * County Structure import. Nothing is matched by name.
 */

const BOULDER = ["08013", "Boulder"];
const ADAMS = ["08001", "Adams"];
const NOW = () => new Date("2026-11-19T12:00:00.000Z");
const ORIGIN = "https://watchdog.invalid";

const lines = (rows) => `${rows.map((r) => r.join(",")).join("\r\n")}\r\n`;
const ROLE_HEAD = [
  "role_id",
  "profile_id",
  "county_fips",
  "published_title",
  "source_id",
  "source_url",
  "source_title",
  "publisher_classification",
  "source_type",
  "source_checked_at",
];
const role = (id, profile, county, title) => [
  id,
  profile,
  county,
  title,
  "S1",
  "https://example.invalid/s1",
  "Synthetic source",
  "official",
  "official_page",
  "2026-11-01T00:00:00Z",
];

/** The private role file shape: readable headers and extra columns. */
const ATTACH_HEAD = [
  "Role ID",
  "Profile ID",
  "County code",
  "County unit ID",
  "Published title",
];
const attach = (rows) =>
  lines([
    ATTACH_HEAD,
    ...rows.map((r) => [r[0], r[1], r[2], r[3], "Synthetic"]),
  ]);

let keyNumber = 0;
const key = () => {
  keyNumber += 1;
  return `attach-key-${String(keyNumber).padStart(6, "0")}`;
};

async function withRoles(callback) {
  await withStructure(async (ctx) => {
    const authorize = async (principal) => principal.accountId === "cs-owner";
    const importer = createD1ProfilesImportService(ctx.d1, {
      authorize,
      now: NOW,
    });
    const profiles = createD1ProfilesService(ctx.d1, { authorize, now: NOW });
    const structure = csv([
      row(BOULDER, {
        id: "bo-sheriff",
        name: "Sheriff's Office",
        type: "office",
      }),
      row(BOULDER, {
        id: "bo-clerk",
        name: "Clerk & Recorder",
        type: "office",
      }),
      row(BOULDER, {
        id: "bo-extension",
        name: "CSU Extension",
        type: "department",
      }),
      row(ADAMS, {
        id: "ad-sheriff",
        name: "Sheriff's Office",
        type: "office",
      }),
    ]);
    const prepared = await ctx.service.prepareImport(ctx.owner, {
      fileName: "county.csv",
      csv: structure,
      mode: "merge",
      countyFips: null,
    });
    await ctx.service.commitImport(ctx.owner, {
      importId: prepared.import.id,
      changesetSha256: prepared.import.changesetSha256,
      expectedVersion: await ctx.service.version(),
      idempotencyKey: key(),
    });
    const files = {
      profile: lines([
        ["profile_id", "display_name"],
        ["P1", "Synthetic Alpha"],
        ["P2", "Synthetic Beta"],
        ["P3", "Synthetic Gamma"],
      ]),
      profileRole: lines([
        ROLE_HEAD,
        role("R1", "P1", "08013", "Synthetic Sheriff"),
        role("R2", "P2", "08013", "Synthetic Agent"),
        role("R3", "P3", "08001", "Synthetic Deputy"),
      ]),
    };
    const preview = await importer.preview(ctx.owner, { files });
    assert.equal(preview.canCommit, true);
    await importer.commit(ctx.owner, "profiles-import-1", {
      files,
      digest: preview.digest,
    });
    const personFor = (profileKey) =>
      ctx.database
        .prepare(
          "SELECT target_id AS id FROM sync_batch_items WHERE client_ref = ?",
        )
        .get(`dash:profile:${profileKey}`).id;
    const roleFor = (roleKey) =>
      ctx.database
        .prepare(
          "SELECT target_id AS id FROM sync_batch_items WHERE client_ref = ?",
        )
        .get(`dash:role:${roleKey}`).id;
    const publish = async (profileKey, visible = true) => {
      const personId = personFor(profileKey);
      const current = ctx.database
        .prepare("SELECT version FROM person_visibility WHERE person_id = ?")
        .get(personId);
      await profiles.save(ctx.owner, key(), [
        {
          kind: "visibility",
          personId,
          expectedVersion: current?.version ?? 0,
          visible,
        },
      ]);
    };
    await publish("P1");
    await publish("P2");
    await publish("P3");
    const publicReads = createD1PublicReadServices(ctx.d1);
    const publicStructure = new D1CountyStructurePublicService(ctx.d1);
    const peopleUnder = async (fips) => {
      const out = {};
      const walk = (units) => {
        for (const unit of units) {
          if (unit.people.length > 0)
            out[unit.id] = unit.people.map((person) => person.displayName);
          walk(unit.children);
        }
      };
      for (const group of (await publicStructure.getCountyStructure(fips))
        .groups)
        walk(group.units);
      return out;
    };
    const displays = () =>
      ctx.database
        .prepare(
          "SELECT person_role_id, unit_id, listing, version FROM county_role_display ORDER BY person_role_id",
        )
        .all()
        .map((entry) => ({ ...entry }));
    await callback({
      ...ctx,
      attachments: new D1CountyRoleAttachments(ctx.d1),
      importer,
      profiles,
      publish,
      personFor,
      roleFor,
      publicReads,
      peopleUnder,
      displays,
    });
  });
}

const preview = (ctx, text, countyFips = "08013") =>
  ctx.attachments.preview(ctx.owner, { csv: text, countyFips });
const commit = (
  ctx,
  text,
  digest,
  idempotencyKey = key(),
  countyFips = "08013",
) =>
  ctx.attachments.commit(ctx.owner, {
    csv: text,
    countyFips,
    digest,
    idempotencyKey,
  });

test("the role file is read by its stable ID columns only", () => {
  const parsed = parseAttachmentCsv(
    attach([
      ["R1", "P1", "08013", "bo-sheriff"],
      ["R5", "P5", "08013", ""],
    ]),
  );
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.ignoredColumns, ["profile_id", "published_title"]);
  assert.deepEqual(
    parsed.rows.map((entry) => [entry.roleKey, entry.countyFips, entry.unitId]),
    [
      ["R1", "08013", "bo-sheriff"],
      ["R5", "08013", null],
    ],
  );
  assert.equal(
    parseAttachmentCsv("role_id,county_fips\r\nR1,08013\r\n").issues[0].code,
    "missing_column",
  );
});

test("a published Profile without a unit link is in county browse and search but not in County Structure", async () => {
  await withRoles(async (ctx) => {
    const county = await ctx.publicReads.listCountyRoleEntries({
      countyFips: "08013",
    });
    assert.deepEqual(
      county.items.map((item) => item.person.displayName).sort(),
      ["Synthetic Alpha", "Synthetic Beta"],
    );
    const found = await ctx.publicReads.searchPeople({
      query: "Synthetic Alpha",
    });
    assert.equal(found.items.length, 1);
    assert.deepEqual(await ctx.peopleUnder("08013"), {});
  });
});

test("preview matches by stable IDs and county and writes nothing", async () => {
  await withRoles(async (ctx) => {
    const text = attach([
      ["R1", "P1", "08013", "bo-sheriff"],
      ["R2", "P2", "08013", "bo-extension"],
      ["R3", "P3", "08001", "ad-sheriff"],
      ["R4", "P4", "08013", "bo-clerk"],
      ["R5", "P5", "08013", ""],
    ]);
    const before = ctx.displays();
    const result = await preview(ctx, text);
    assert.deepEqual(
      { ...result.counts },
      {
        rows: 5,
        otherCounties: 1,
        attach: 2,
        remap: 0,
        unchanged: 0,
        unattached: 1,
        skipped: 1,
        blocked: 0,
      },
    );
    assert.equal(result.committable, true);
    assert.equal(
      result.items.find((item) => item.roleKey === "R1").websiteRoleId,
      ctx.roleFor("R1"),
    );
    assert.match(result.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(ctx.displays(), before);
  });
});

test("an explicit attachment shows the role in County Structure, keeps county browse, and replays", async () => {
  await withRoles(async (ctx) => {
    const text = attach([
      ["R1", "P1", "08013", "bo-sheriff"],
      ["R2", "P2", "08013", "bo-extension"],
      ["R4", "P4", "08013", "bo-clerk"],
    ]);
    assert.equal(await ctx.publicReads.countPublicPeople("08013"), 2);
    const reader = new D1CountyStructurePublicService(ctx.d1);
    const badges = async () =>
      (await reader.getCountyStructure("08013")).groups
        .flatMap((g) => g.units)
        .map((u) => [u.id, u.profileCount]);
    assert.ok((await badges()).every(([, count]) => count === 0));
    const reviewed = await preview(ctx, text);
    const idempotencyKey = key();
    const receipt = await commit(ctx, text, reviewed.digest, idempotencyKey);
    assert.deepEqual(
      { ...receipt },
      {
        countyFips: "08013",
        digest: reviewed.digest,
        attached: 2,
        remapped: 0,
        unchanged: 0,
        skipped: 1,
        replayed: false,
      },
    );
    assert.deepEqual(await ctx.peopleUnder("08013"), {
      "bo-sheriff": ["Synthetic Alpha"],
      "bo-extension": ["Synthetic Beta"],
    });
    const county = await ctx.publicReads.listCountyRoleEntries({
      countyFips: "08013",
    });
    assert.equal(county.items.length, 2);
    assert.equal(await ctx.publicReads.countPublicPeople("08013"), 2);
    assert.equal(new Map(await badges()).get("bo-sheriff"), 1);
    assert.equal(new Map(await badges()).get("bo-extension"), 1);
    await ctx.publish("P2", false);
    assert.equal(await ctx.publicReads.countPublicPeople("08013"), 1);
    assert.equal(new Map(await badges()).get("bo-extension"), 0);
    await ctx.publish("P2", true);

    // Same key and digest: the stored receipt, nothing written.
    const rows = ctx.displays();
    const replay = await commit(ctx, text, reviewed.digest, idempotencyKey);
    assert.equal(replay.replayed, true);
    assert.equal(replay.attached, 2);
    assert.deepEqual(ctx.displays(), rows);
    // The old preview is now stale for a new key.
    await assert.rejects(
      () => commit(ctx, text, reviewed.digest),
      (error) =>
        error instanceof CountyStructureConflictError &&
        error.code === "stale_preview",
    );
    // The same key cannot be reused for a different preview.
    const again = await preview(ctx, text);
    assert.equal(again.counts.unchanged, 2);
    assert.equal(again.committable, false);
    await assert.rejects(
      () => commit(ctx, text, again.digest, idempotencyKey),
      (error) =>
        error instanceof CountyStructureConflictError &&
        error.code === "idempotency_reuse",
    );
  });
});

test("remapping moves the role to the new unit only after an explicit commit", async () => {
  await withRoles(async (ctx) => {
    const first = attach([["R1", "P1", "08013", "bo-sheriff"]]);
    await commit(ctx, first, (await preview(ctx, first)).digest);
    const second = attach([
      ["R1", "P1", "08013", "bo-clerk"],
      ["R2", "P2", "08013", ""],
    ]);
    const reviewed = await preview(ctx, second);
    assert.equal(reviewed.counts.remap, 1);
    assert.equal(reviewed.counts.unattached, 1);
    const remapItem = reviewed.items.find((item) => item.action === "remap");
    assert.equal(remapItem.currentUnitId, "bo-sheriff");
    assert.deepEqual(await ctx.peopleUnder("08013"), {
      "bo-sheriff": ["Synthetic Alpha"],
    });
    const receipt = await commit(ctx, second, reviewed.digest);
    assert.equal(receipt.remapped, 1);
    assert.deepEqual(await ctx.peopleUnder("08013"), {
      "bo-clerk": ["Synthetic Alpha"],
    });
    assert.deepEqual(ctx.displays(), [
      {
        person_role_id: ctx.roleFor("R1"),
        unit_id: "bo-clerk",
        listing: "home",
        version: 2,
      },
    ]);
    // A blank unit ID never removes the existing link.
    const blank = attach([["R1", "P1", "08013", ""]]);
    const kept = await preview(ctx, blank);
    assert.equal(kept.counts.unattached, 1);
    assert.equal(kept.committable, false);
  });
});

test("county mismatches, unknown units and conflicting rows block the commit", async () => {
  await withRoles(async (ctx) => {
    const text = attach([
      ["R1", "P1", "08013", "ad-sheriff"],
      ["R3", "P3", "08013", "bo-sheriff"],
      ["R2", "P2", "08013", "bo-missing"],
      ["R2", "P2", "08013", "bo-clerk"],
    ]);
    const reviewed = await preview(ctx, text);
    assert.equal(reviewed.counts.blocked, 4);
    assert.equal(reviewed.committable, false);
    const reasons = reviewed.items.map((item) => item.reason).join(" | ");
    assert.match(reasons, /belongs to county 08001/);
    assert.match(reasons, /recorded in county 08001/);
    assert.match(reasons, /more than one county unit/);
    await assert.rejects(
      () => commit(ctx, text, reviewed.digest),
      (error) =>
        error instanceof CountyStructureConflictError &&
        error.code === "blocked",
    );
    assert.deepEqual(ctx.displays(), []);
  });
});

test("a change after preview makes the commit stale", async () => {
  await withRoles(async (ctx) => {
    const text = attach([["R1", "P1", "08013", "bo-sheriff"]]);
    const reviewed = await preview(ctx, text);
    await ctx.service.addRoleDisplay(ctx.owner, {
      personRoleId: ctx.roleFor("R1"),
      listing: "home",
      unitId: "bo-clerk",
    });
    await assert.rejects(
      () => commit(ctx, text, reviewed.digest),
      (error) =>
        error instanceof CountyStructureConflictError &&
        error.code === "stale_preview",
    );
    assert.equal(ctx.displays()[0].unit_id, "bo-clerk");
  });
});

test("a hidden Profile stays off County Structure even when attached", async () => {
  await withRoles(async (ctx) => {
    const text = attach([["R2", "P2", "08013", "bo-extension"]]);
    await commit(ctx, text, (await preview(ctx, text)).digest);
    assert.deepEqual(await ctx.peopleUnder("08013"), {
      "bo-extension": ["Synthetic Beta"],
    });
    await ctx.publish("P2", false);
    assert.deepEqual(await ctx.peopleUnder("08013"), {});
    const county = await ctx.publicReads.listCountyRoleEntries({
      countyFips: "08013",
    });
    assert.deepEqual(
      county.items.map((item) => item.person.displayName),
      ["Synthetic Alpha"],
    );
  });
});

test("the owner API previews and commits with origin and idempotency checks", async () => {
  await withRoles(async (ctx) => {
    const transport = createCountyStructureApiTransport({
      resolvePrincipal: async () => ctx.owner,
      authorize: async () => true,
      administration: ctx.service,
      roleAttachments: ctx.attachments,
    });
    const text = attach([["R1", "P1", "08013", "bo-sheriff"]]);
    const post = (path, payload, headers = {}) =>
      transport.fetch(
        new Request(`${ORIGIN}/api/admin/county-structure/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            ...headers,
          },
          body: JSON.stringify(payload),
        }),
      );
    const previewResponse = await post("role-attachments/preview", {
      csv: text,
      countyFips: "08013",
    });
    assert.equal(previewResponse.status, 200);
    const reviewed = await previewResponse.json();
    assert.equal(reviewed.counts.attach, 1);
    const missingKey = await post("role-attachments/commit", {
      csv: text,
      countyFips: "08013",
      digest: reviewed.digest,
    });
    assert.equal(missingKey.status, 400);
    const crossOrigin = await post(
      "role-attachments/commit",
      { csv: text, countyFips: "08013", digest: reviewed.digest },
      { origin: "https://elsewhere.invalid", "idempotency-key": key() },
    );
    assert.equal(crossOrigin.status, 403);
    const committed = await post(
      "role-attachments/commit",
      { csv: text, countyFips: "08013", digest: reviewed.digest },
      { "idempotency-key": key() },
    );
    assert.equal(committed.status, 200);
    assert.equal((await committed.json()).attached, 1);

    const anonymous = createCountyStructureApiTransport({
      resolvePrincipal: async () => null,
      administration: ctx.service,
      roleAttachments: ctx.attachments,
    });
    const denied = await anonymous.fetch(
      new Request(
        `${ORIGIN}/api/admin/county-structure/role-attachments/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ csv: text, countyFips: "08013" }),
        },
      ),
    );
    assert.equal(denied.status, 401);
    await assert.rejects(() =>
      ctx.attachments.preview(ctx.admin, {
        csv: text,
        countyFips: "08013",
      }),
    );
  });
});

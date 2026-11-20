import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { parseCountyCsv } from "../dist/services/county-structure-csv.js";
import {
  CountyStructureValidationError,
  D1CountyStructureAdministration,
} from "../dist/services/county-structure-d1.js";
import { D1CountyStructurePublicService } from "../dist/services/county-structure-public.js";
import { createCountyStructureApiTransport } from "../dist/transport/county-structure-api.js";
import {
  addPerson,
  csv,
  localD1,
  row,
  withStructure,
} from "./county-structure-fixtures.mjs";

/**
 * Regression coverage for the statewide v4 county.csv contract, with synthetic
 * data only. It reproduces the two v4 preview failures (one Source references
 * field of 8,816 characters, and eight units placed with `display_group`
 * beneath a regular unit such as CSU Extension) and checks that a v3-shaped
 * baseline with reconciled role links previews as additions and eight moves
 * only, with no updates, removals or blocked references.
 */

const BOULDER = ["08013", "Boulder"];
const LONG_SOURCES = 8816;
const PROGRAMS = 8;

let keyCounter = 0;
const key = () => {
  keyCounter += 1;
  return `v4-key-${String(keyCounter).padStart(6, "0")}`;
};

/** Deterministic synthetic source list of exactly `length` characters. */
function longSources(length) {
  const lines = [];
  for (let index = 0; lines.join("\n").length < length; index += 1)
    lines.push(
      `https://example.invalid/synthetic/boulder/source-${String(index).padStart(4, "0")}`,
    );
  const text = lines.join("\n");
  return text.slice(0, length);
}

function baselineRows() {
  const rows = [
    row(BOULDER, {
      id: "bo-eo",
      name: "Elected Officials",
      type: "display_group",
      l1: "Elected Officials",
      order: "1",
    }),
    row(BOULDER, {
      id: "bo-assessor",
      name: "Assessor",
      parent: "bo-eo",
      rel: "display_group",
      type: "office",
      l1: "Elected Officials",
      l2: "Assessor",
    }),
    row(BOULDER, {
      id: "bo-sheriff",
      name: "Sheriff's Office",
      type: "office",
      l1: "Sheriff's Office",
    }),
    row(BOULDER, {
      id: "bo-extension",
      name: "CSU Extension",
      type: "department",
      l1: "CSU Extension",
      evidence: "Synthetic evidence for the extension office.",
    }),
  ];
  for (let index = 1; index <= PROGRAMS; index += 1)
    rows.push(
      row(BOULDER, {
        id: `bo-program-${index}`,
        name: `Synthetic Program ${index}`,
        type: "program",
        l1: `Synthetic Program ${index}`,
        order: String(index),
      }),
    );
  return rows;
}

/** v4 shape: every baseline ID kept, programs placed under CSU Extension. */
function v4Rows(additions) {
  const rows = baselineRows().map((cells) => {
    const id = cells[2];
    if (!id.startsWith("bo-program-")) return cells;
    const name = cells[3];
    const next = [...cells];
    next[4] = "bo-extension";
    next[5] = "CSU Extension";
    next[6] = name;
    next[10] = "display_group";
    return next;
  });
  rows.push(
    row(BOULDER, {
      id: "bo-commissioners",
      name: "Board of County Commissioners",
      type: "board",
      l1: "Board of County Commissioners",
      sources: longSources(LONG_SOURCES),
    }),
  );
  for (let index = 1; index <= additions; index += 1)
    rows.push(
      row(BOULDER, {
        id: `bo-added-${index}`,
        name: `Synthetic Added Unit ${index}`,
        parent: "bo-commissioners",
        rel: "part_of",
        type: "division",
        l1: "Board of County Commissioners",
        l2: `Synthetic Added Unit ${index}`,
      }),
    );
  return rows;
}

async function prepare(ctx, text, mode = "replace_county", countyFips) {
  return ctx.service.prepareImport(ctx.owner, {
    fileName: "county.csv",
    csv: text,
    mode,
    countyFips: countyFips ?? BOULDER[0],
  });
}

async function commit(ctx, prepared, idempotencyKey = key()) {
  return ctx.service.commitImport(ctx.owner, {
    importId: prepared.import.id,
    changesetSha256: prepared.import.changesetSha256,
    expectedVersion: await ctx.service.version(),
    idempotencyKey,
  });
}

/** Reviewed `home` links for two baseline units, one of them a moved program. */
function linkRoles(ctx) {
  addPerson(ctx.database, {
    personId: "p-v4-sheriff",
    roleId: "r-v4-sheriff",
    county: BOULDER[0],
  });
  addPerson(ctx.database, {
    personId: "p-v4-program",
    roleId: "r-v4-program",
    county: BOULDER[0],
  });
  ctx.database.exec(`
    INSERT INTO county_role_display (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
      VALUES ('crd-v4-1', 'r-v4-sheriff', '08013', 'bo-sheriff', 'home', 'cs-owner'),
             ('crd-v4-2', 'r-v4-program', '08013', 'bo-program-3', 'home', 'cs-owner');
  `);
}

test("an 8,816 character Source references field parses without truncation", async () => {
  await withStructure(async (ctx) => {
    const registry = new Map(
      ctx.database
        .prepare("SELECT fips, name FROM counties")
        .all()
        .map((entry) => [entry.fips, entry.name]),
    );
    const parsed = parseCountyCsv(csv(v4Rows(0)), registry);
    assert.deepEqual(parsed.issues, []);
    const record = parsed.file.rows.find(
      (entry) => entry.id === "bo-commissioners",
    ).record;
    assert.equal(record.sources.length, LONG_SOURCES);
    assert.equal(record.sources, longSources(LONG_SOURCES));
  });
});

test("provenance over 32,768 characters is still refused", async () => {
  await withStructure(async (ctx) => {
    const rows = [
      row(BOULDER, {
        id: "bo-too-long",
        name: "Too Long",
        type: "office",
        sources: "x".repeat(32_769),
      }),
    ];
    await assert.rejects(
      () => prepare(ctx, csv(rows)),
      (error) =>
        error instanceof CountyStructureValidationError &&
        error.issues.some((issue) => issue.code === "text_length"),
    );
  });
});

test("v3 baseline to v4 previews as additions and eight moves with zero updates, removals or blocked references", async () => {
  await withStructure(async (ctx) => {
    await commit(ctx, await prepare(ctx, csv(baselineRows())));
    linkRoles(ctx);
    const additions = 20;
    const prepared = await prepare(ctx, csv(v4Rows(additions)));
    assert.deepEqual(prepared.issues, []);
    assert.equal(prepared.committable, true);
    const counts = prepared.import.counts;
    assert.equal(counts.add, additions + 1);
    assert.equal(counts.move, PROGRAMS);
    assert.equal(counts.update, 0);
    assert.equal(counts.remove, 0);
    assert.equal(counts.retire, 0);
    assert.equal(counts.blocked, 0);
    // The moved program keeps its reviewed role link through the move.
    assert.equal(counts.affectedProfileReferences, 1);
    const moved = prepared.items.filter((item) => item.action === "move");
    assert.equal(moved.length, PROGRAMS);
    for (const item of moved) {
      assert.equal(item.after.parentId, null);
      assert.equal(item.after.displayGroupId, "bo-extension");
      assert.equal(item.after.relationship, "display_group");
    }
  });
});

test("v4 commits, keeps browse placement out of the reporting hierarchy and round-trips", async () => {
  await withStructure(async (ctx) => {
    await commit(ctx, await prepare(ctx, csv(baselineRows())));
    linkRoles(ctx);
    const roleLinksBefore = ctx.database
      .prepare("SELECT id, unit_id FROM county_role_display ORDER BY id")
      .all();
    const text = csv(v4Rows(3));
    await commit(ctx, await prepare(ctx, text));

    const stored = ctx.database
      .prepare(
        `SELECT id, parent_unit_id, display_group_id, browse_parent_unit_id, parent_relationship
         FROM county_unit WHERE id LIKE 'bo-program-%' ORDER BY id`,
      )
      .all();
    assert.equal(stored.length, PROGRAMS);
    for (const unit of stored) {
      assert.equal(unit.parent_unit_id, null, "no reporting parent");
      assert.equal(unit.display_group_id, null);
      assert.equal(unit.browse_parent_unit_id, "bo-extension");
      assert.equal(unit.parent_relationship, null);
    }
    assert.deepEqual(
      ctx.database
        .prepare("SELECT id, unit_id FROM county_role_display ORDER BY id")
        .all(),
      roleLinksBefore,
    );
    const sources = ctx.database
      .prepare(
        "SELECT length(source_references) AS n FROM county_unit WHERE id = 'bo-commissioners'",
      )
      .get();
    assert.equal(sources.n, LONG_SOURCES);

    // Export, then re-import the export: nothing changes, nothing is truncated.
    const exported = await ctx.service.exportCsv(ctx.owner, BOULDER[0]);
    assert.ok(exported.csv.includes(longSources(LONG_SOURCES)));
    const again = await prepare(ctx, exported.csv);
    assert.equal(again.items.length, 0);
    assert.equal(again.import.counts.unchanged, 4 + PROGRAMS + 1 + 3);
    const second = await ctx.service.exportCsv(ctx.owner, BOULDER[0]);
    assert.equal(second.csv, exported.csv);

    // The owner detail tree lists the programs under CSU Extension.
    const detail = await ctx.service.getCounty(ctx.owner, BOULDER[0]);
    const extension = detail.roots.find(
      (node) => node.record.id === "bo-extension",
    );
    assert.equal(extension.children.length, PROGRAMS);
  });
});

test("authenticated export returns the full 8,816 character field", async () => {
  await withStructure(async (ctx) => {
    await commit(ctx, await prepare(ctx, csv(v4Rows(0))));
    const transport = createCountyStructureApiTransport({
      resolvePrincipal: async () => ctx.owner,
      authorize: async () => true,
      administration: ctx.service,
    });
    const response = await transport.fetch(
      new Request(
        "https://watchdog.invalid/api/admin/county-structure/export?county=08013",
      ),
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    const exported = body.startsWith("{") ? JSON.parse(body).csv : body;
    assert.ok(exported.includes(longSources(LONG_SOURCES)));

    const anonymous = createCountyStructureApiTransport({
      resolvePrincipal: async () => null,
      administration: ctx.service,
    });
    const denied = await anonymous.fetch(
      new Request(
        "https://watchdog.invalid/api/admin/county-structure/export?county=08013",
      ),
    );
    assert.equal(denied.status, 401);
  });
});

test("the public county section lists placed programs under CSU Extension and never exposes provenance", async () => {
  await withStructure(async (ctx) => {
    await commit(ctx, await prepare(ctx, csv(v4Rows(0))));
    const structure = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure(BOULDER[0]);
    const all = [];
    const walk = (units) => {
      for (const unit of units) {
        all.push(unit.id);
        walk(unit.children);
      }
    };
    for (const group of structure.groups) walk(group.units);
    assert.equal(new Set(all).size, all.length, "each unit appears once");
    const extension = structure.groups
      .flatMap((group) => group.units)
      .find((unit) => unit.id === "bo-extension");
    assert.deepEqual(
      extension.children.map((unit) => unit.id),
      Array.from({ length: PROGRAMS }, (_, index) => `bo-program-${index + 1}`),
    );
    assert.equal(JSON.stringify(structure).includes("example.invalid"), false);

    // A hidden CSU Extension does not hide its placed programs: they fall back
    // to their own heading.
    await ctx.service.edit(ctx.owner, {
      expectedVersion: await ctx.service.version(),
      edit: { op: "update", id: "bo-extension", status: "hidden" },
    });
    const hidden = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure(BOULDER[0]);
    const other = hidden.groups.find((group) => group.name === "Other");
    assert.equal(other.units.length, PROGRAMS);
  });
});

test("browse placement under a unit must stay in the county and cannot form a cycle", async () => {
  await withStructure(async (ctx) => {
    const cycle = [
      row(BOULDER, {
        id: "bo-a",
        name: "A",
        type: "department",
        parent: "bo-b",
        rel: "display_group",
      }),
      row(BOULDER, {
        id: "bo-b",
        name: "B",
        type: "division",
        parent: "bo-a",
        rel: "part_of",
      }),
    ];
    await assert.rejects(
      () => prepare(ctx, csv(cycle)),
      (error) =>
        error instanceof CountyStructureValidationError &&
        error.issues.some((issue) => issue.code === "parent_cycle"),
    );
    const cross = [
      row(["08001", "Adams"], {
        id: "ad-host",
        name: "Host",
        type: "department",
      }),
      row(BOULDER, {
        id: "bo-guest",
        name: "Guest",
        type: "program",
        parent: "ad-host",
        rel: "display_group",
      }),
    ];
    await assert.rejects(
      () => prepare(ctx, csv(cross), "merge", null),
      (error) =>
        error instanceof CountyStructureValidationError &&
        error.issues.some((issue) => issue.code === "parent_cross_county"),
    );
  });
});

test("reversing the v4 import restores the v3 baseline exactly", async () => {
  await withStructure(async (ctx) => {
    await commit(ctx, await prepare(ctx, csv(baselineRows())));
    const baseline = await ctx.service.exportCsv(ctx.owner, BOULDER[0]);
    const v4 = await prepare(ctx, csv(v4Rows(2)));
    await commit(ctx, v4);
    await ctx.service.reverseImport(ctx.owner, {
      importId: v4.import.id,
      expectedVersion: await ctx.service.version(),
      idempotencyKey: key(),
    });
    const restored = await ctx.service.exportCsv(ctx.owner, BOULDER[0]);
    assert.equal(restored.csv, baseline.csv);
    const placed = ctx.database
      .prepare(
        "SELECT COUNT(*) AS n FROM county_unit WHERE browse_parent_unit_id IS NOT NULL",
      )
      .get();
    assert.equal(placed.n, 0);
  });
});

test("a dashboard move keeps browse placement unless a reporting relationship is chosen", async () => {
  await withStructure(async (ctx) => {
    await commit(ctx, await prepare(ctx, csv(baselineRows())));
    await ctx.service.edit(ctx.owner, {
      expectedVersion: await ctx.service.version(),
      edit: {
        op: "move",
        id: "bo-program-1",
        parentId: "bo-extension",
        relationship: "display_group",
      },
    });
    let unit = ctx.database
      .prepare(
        "SELECT parent_unit_id, browse_parent_unit_id FROM county_unit WHERE id = 'bo-program-1'",
      )
      .get();
    assert.deepEqual(
      { ...unit },
      { parent_unit_id: null, browse_parent_unit_id: "bo-extension" },
    );
    await ctx.service.edit(ctx.owner, {
      expectedVersion: await ctx.service.version(),
      edit: { op: "move", id: "bo-program-1", parentId: "bo-extension" },
    });
    unit = ctx.database
      .prepare(
        "SELECT parent_unit_id, browse_parent_unit_id, parent_relationship FROM county_unit WHERE id = 'bo-program-1'",
      )
      .get();
    assert.deepEqual(
      { ...unit },
      {
        parent_unit_id: "bo-extension",
        browse_parent_unit_id: null,
        parent_relationship: "part_of",
      },
    );
  });
});

test("migration 0033 keeps existing County Structure rows, versions and provenance", async () => {
  const database = await openWebsiteDatabase();
  try {
    const all = loadWebsiteMigrations();
    const before = all.filter((migration) => migration.version < 33);
    assert.equal(all.length, before.length + 1);
    migrateWebsiteDatabase(database, before);
    database.exec(`
      INSERT INTO accounts (id, kind, role, display_name) VALUES ('cs-owner', 'human', 'owner', 'Synthetic Owner');
      INSERT INTO county_unit_display (id, county_fips, name, evidence, source_references)
        VALUES ('g-up', '08091', 'Synthetic Group', 'group evidence', 'group source');
      INSERT INTO county_unit (id, county_fips, name, organization_type, evidence, source_references)
        VALUES ('u-up', '08091', 'Synthetic Office', 'office', 'unit evidence', 'unit source');
      INSERT INTO county_unit (id, county_fips, display_group_id, parent_relationship, name, organization_type)
        VALUES ('u-up-2', '08091', 'g-up', 'display_group', 'Synthetic Listed Office', 'office');
      INSERT INTO county_unit_alias (unit_id, position, alias) VALUES ('u-up', 0, 'Synthetic Alias');
      UPDATE county_unit SET version = 2 WHERE id = 'u-up';
    `);
    const service = new D1CountyStructureAdministration(localD1(database));
    const versionBefore = await service.version();
    migrateWebsiteDatabase(database, all);
    const units = database
      .prepare(
        "SELECT id, evidence, source_references, version, display_group_id, browse_parent_unit_id FROM county_unit ORDER BY id",
      )
      .all();
    assert.deepEqual(
      units.map((unit) => ({ ...unit })),
      [
        {
          id: "u-up",
          evidence: "unit evidence",
          source_references: "unit source",
          version: 2,
          display_group_id: null,
          browse_parent_unit_id: null,
        },
        {
          id: "u-up-2",
          evidence: null,
          source_references: null,
          version: 1,
          display_group_id: "g-up",
          browse_parent_unit_id: null,
        },
      ],
    );
    const group = database
      .prepare(
        "SELECT evidence, source_references FROM county_unit_display WHERE id = 'g-up'",
      )
      .get();
    assert.deepEqual(
      { ...group },
      { evidence: "group evidence", source_references: "group source" },
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM county_unit_alias").get().n,
      1,
    );
    assert.equal(await service.version(), versionBefore);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

/**
 * The exact audit shape: a Partner Organizations display group, CSU Extension
 * placed in it, and child units placed under CSU Extension with
 * `display_group`. The readable columns name all three levels.
 */
function partnerRows() {
  const rows = [
    row(BOULDER, {
      id: "bo-partners",
      name: "Partner Organizations",
      type: "display_group",
      l1: "Partner Organizations",
    }),
    row(BOULDER, {
      id: "bo-csu",
      name: "CSU Extension",
      parent: "bo-partners",
      rel: "display_group",
      type: "department",
      l1: "Partner Organizations",
      l2: "CSU Extension",
    }),
  ];
  for (let index = 1; index <= PROGRAMS; index += 1)
    rows.push(
      row(BOULDER, {
        id: `bo-csu-child-${index}`,
        name: `Synthetic Extension Program ${index}`,
        parent: "bo-csu",
        rel: "display_group",
        type: "department",
        l1: "Partner Organizations",
        l2: "CSU Extension",
        l3: `Synthetic Extension Program ${index}`,
        order: String(index),
      }),
    );
  return rows;
}

test("the three-level Partner Organizations / CSU Extension / child shape previews, round-trips and nests without a reporting parent", async () => {
  await withStructure(async (ctx) => {
    const prepared = await prepare(ctx, csv(partnerRows()));
    assert.deepEqual(prepared.issues, []);
    assert.equal(prepared.committable, true);
    assert.equal(prepared.import.counts.add, PROGRAMS + 2);
    await commit(ctx, prepared);

    const stored = ctx.database
      .prepare(
        `SELECT id, parent_unit_id, display_group_id, browse_parent_unit_id, parent_relationship
         FROM county_unit WHERE county_fips = '08013' ORDER BY id`,
      )
      .all()
      .map((unit) => ({ ...unit }));
    assert.deepEqual(stored[0], {
      id: "bo-csu",
      parent_unit_id: null,
      display_group_id: "bo-partners",
      browse_parent_unit_id: null,
      parent_relationship: "display_group",
    });
    for (const unit of stored.slice(1)) {
      assert.equal(unit.parent_unit_id, null, "no reporting parent");
      assert.equal(unit.display_group_id, null);
      assert.equal(unit.browse_parent_unit_id, "bo-csu");
      assert.equal(unit.parent_relationship, null);
    }

    // Authenticated export keeps all three readable columns.
    const transport = createCountyStructureApiTransport({
      resolvePrincipal: async () => ctx.owner,
      authorize: async () => true,
      administration: ctx.service,
    });
    const response = await transport.fetch(
      new Request(
        "https://watchdog.invalid/api/admin/county-structure/export?county=08013",
      ),
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    const exported = body.startsWith("{") ? JSON.parse(body).csv : body;
    const registry = new Map(
      ctx.database
        .prepare("SELECT fips, name FROM counties")
        .all()
        .map((entry) => [entry.fips, entry.name]),
    );
    const parsed = parseCountyCsv(exported, registry);
    assert.deepEqual(parsed.issues, []);
    const readable = new Map(
      parsed.file.rows.map((entry) => [entry.id, entry.readable]),
    );
    assert.deepEqual(readable.get("bo-csu"), [
      "Partner Organizations",
      "CSU Extension",
      "",
    ]);
    for (let index = 1; index <= PROGRAMS; index += 1) {
      const id = `bo-csu-child-${index}`;
      const child = parsed.file.rows.find((entry) => entry.id === id);
      assert.deepEqual(readable.get(id), [
        "Partner Organizations",
        "CSU Extension",
        `Synthetic Extension Program ${index}`,
      ]);
      assert.equal(child.parentRef, "bo-csu");
      assert.equal(child.relationshipRaw, "display_group");
    }
    const again = await prepare(ctx, exported);
    assert.equal(again.items.length, 0);
    assert.equal(again.import.counts.unchanged, PROGRAMS + 2);

    // Public browse: CSU Extension under the Partner Organizations heading,
    // each child nested under CSU Extension.
    const structure = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure(BOULDER[0]);
    const partners = structure.groups.find(
      (group) => group.name === "Partner Organizations",
    );
    assert.deepEqual(
      partners.units.map((unit) => unit.id),
      ["bo-csu"],
    );
    assert.deepEqual(
      partners.units[0].children.map((unit) => unit.id),
      Array.from(
        { length: PROGRAMS },
        (_, index) => `bo-csu-child-${index + 1}`,
      ),
    );
    const ids = structure.groups.flatMap((group) => {
      const out = [];
      const walk = (units) => {
        for (const unit of units) {
          out.push(unit.id);
          walk(unit.children);
        }
      };
      walk(group.units);
      return out;
    });
    assert.equal(new Set(ids).size, ids.length, "each unit appears once");
    assert.equal(ids.length, PROGRAMS + 1);
  });
});

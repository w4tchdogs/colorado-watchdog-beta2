import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createCountyStructureView } from "../dist/editor/county-structure-view.js";
import { parseCountyCsv } from "../dist/services/county-structure-csv.js";
import {
  CountyStructureConflictError,
  CountyStructureValidationError,
} from "../dist/services/county-structure-d1.js";
import { D1CountyStructurePublicService } from "../dist/services/county-structure-public.js";
import { countyStructureSection } from "../dist/site/pages/county-structure-section.js";
import {
  ADAMS,
  ALAMOSA,
  adamsRows,
  addPerson,
  csv,
  row,
  withStructure,
} from "./county-structure-fixtures.mjs";

let keyCounter = 0;
const key = () => {
  keyCounter += 1;
  return `key-${String(keyCounter).padStart(6, "0")}-abcdef`;
};

async function importCsv(ctx, text, mode = "merge", countyFips = null) {
  const prepared = await ctx.service.prepareImport(ctx.owner, {
    fileName: "county.csv",
    csv: text,
    mode,
    countyFips,
  });
  return prepared;
}

async function assertInvalid(
  ctx,
  text,
  code,
  mode = "merge",
  countyFips = null,
) {
  await assert.rejects(
    () => importCsv(ctx, text, mode, countyFips),
    (error) =>
      error instanceof CountyStructureValidationError &&
      (code === undefined || error.issues.some((issue) => issue.code === code)),
  );
}

async function commit(ctx, prepared, idempotencyKey = key()) {
  const version = await ctx.service.version();
  return ctx.service.commitImport(ctx.owner, {
    importId: prepared.import.id,
    changesetSha256: prepared.import.changesetSha256,
    expectedVersion: version,
    idempotencyKey,
  });
}

async function load(ctx, text, mode = "merge", countyFips = null) {
  const prepared = await importCsv(ctx, text, mode, countyFips);
  assert.equal(prepared.committable, true, JSON.stringify(prepared.issues));
  await commit(ctx, prepared);
  return prepared;
}

const unitIds = (database, fips) =>
  database
    .prepare("SELECT id FROM county_unit WHERE county_fips = ? ORDER BY id")
    .all(fips)
    .map((r) => r.id);

test("an empty database has no structure and exports one county-only row per county", async () => {
  await withStructure(async (ctx) => {
    const exported = await ctx.service.exportCsv(ctx.owner);
    assert.equal(exported.fileName, "county.csv");
    const lines = exported.csv.trim().split(/\r?\n/);
    assert.equal(lines.length, 65);
    assert.equal(lines[0].split(",").length, 17);
    const publicView = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure("08001");
    assert.equal(publicView.empty, true);
  });
});

test("a 3-level county imports, exports and round-trips byte for byte", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const first = await ctx.service.exportCsv(ctx.owner, "08001");
    const registry = new Map([["08001", "Adams"]]);
    const parsed = parseCountyCsv(first.csv, registry);
    assert.deepEqual(parsed.issues ?? [], []);
    await load(ctx, first.csv, "replace_county", "08001");
    const second = await ctx.service.exportCsv(ctx.owner, "08001");
    assert.equal(second.csv, first.csv);
  });
});

test("Sheriff's Office is a top-level unit and not under Elected Official", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const sheriff = ctx.database
      .prepare(
        "SELECT parent_unit_id, display_group_id FROM county_unit WHERE id = 'adams-sheriff'",
      )
      .get();
    assert.equal(sheriff.parent_unit_id, null);
    assert.equal(sheriff.display_group_id, null);
    const assessor = ctx.database
      .prepare(
        "SELECT display_group_id FROM county_unit WHERE id = 'adams-assessor'",
      )
      .get();
    assert.equal(assessor.display_group_id, "adams-eo");
  });
});

test("the county summary counts sub-units under a unit or a display group and keeps the display group separate", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const detail = await ctx.service.getCounty(ctx.owner, "08001");
    assert.deepEqual(
      {
        units: detail.counts.units,
        subunits: detail.counts.subunits,
        displayGroups: detail.counts.displayGroups,
      },
      { units: 7, subunits: 5, displayGroups: 1 },
    );
    const list = await ctx.service.listCounties(ctx.owner);
    const adams = list.counties.find((county) => county.fips === "08001");
    assert.deepEqual(
      {
        units: adams.counts.units,
        subunits: adams.counts.subunits,
        displayGroups: adams.counts.displayGroups,
      },
      { units: 7, subunits: 5, displayGroups: 1 },
    );
  });
});

test("the dashboard summary reads top-level units, sub-units and the display group separately", async () => {
  const dom = new JSDOM('<!doctype html><div id="c"></div>');
  const { document } = dom.window;
  const container = document.getElementById("c");
  const counts = {
    units: 7,
    subunits: 5,
    displayGroups: 1,
    profiles: 0,
    unresolved: 0,
  };
  const client = {
    counties: async () => ({
      version: 1,
      counties: [{ fips: "08001", name: "Adams", counts }],
    }),
    county: async () => ({
      county: { fips: "08001", name: "Adams" },
      version: 1,
      counts,
      roots: [],
    }),
    imports: async () => ({ imports: [] }),
  };
  createCountyStructureView({ client })({
    doc: document,
    container,
    data: { view: "county-structure" },
    session: {},
    hrefFor: () => "#",
    announce: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const select = container.querySelector("select");
  select.value = "08001";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    container.querySelector(".cs-counts").textContent,
    "8 entries: 2 top-level units, 5 sub-units (under a unit or a display group) and 1 display group. 0 linked Profiles, 0 needing review.",
  );
});

test("the dashboard previews and commits role attachments for the selected county", async () => {
  const dom = new JSDOM('<!doctype html><div id="c"></div>');
  const { document } = dom.window;
  const container = document.getElementById("c");
  const counts = {
    units: 1,
    subunits: 0,
    displayGroups: 0,
    profiles: 0,
    unresolved: 0,
  };
  let committed = null;
  const item = {
    line: 2,
    roleKey: "R-SYNTH",
    countyFips: "08001",
    unitId: "adams-sheriff",
    websiteRoleId: "role-synth",
    currentUnitId: null,
    currentDisplayId: null,
    currentDisplayVersion: null,
    action: "attach",
    reason: null,
  };
  const preview = {
    countyFips: "08001",
    fileSha256: "a".repeat(64),
    digest: "b".repeat(64),
    counts: {
      rows: 1,
      otherCounties: 0,
      attach: 1,
      remap: 0,
      unchanged: 0,
      unattached: 0,
      skipped: 0,
      blocked: 0,
    },
    ignoredColumns: [],
    items: [item],
    committable: true,
  };
  const client = {
    counties: async () => ({
      version: 1,
      counties: [
        { fips: "08001", name: "Adams", counts },
        { fips: "08003", name: "Alamosa", counts },
      ],
    }),
    county: async (fips) => ({
      county: { fips, name: fips === "08001" ? "Adams" : "Alamosa" },
      version: 1,
      counts,
      roots: [],
    }),
    imports: async () => ({ imports: [] }),
    previewRoleAttachments: async ({ csv, countyFips }) => {
      assert.equal(csv, "synthetic csv");
      assert.equal(countyFips, "08001");
      return preview;
    },
    commitRoleAttachments: async (request, idempotencyKey) => {
      committed = { request, idempotencyKey };
      return {
        countyFips: "08001",
        digest: preview.digest,
        attached: 1,
        remapped: 0,
        unchanged: 0,
        skipped: 0,
        replayed: false,
      };
    },
  };
  createCountyStructureView({ client, newKey: () => "attach-test-key" })({
    doc: document,
    container,
    data: { view: "county-structure" },
    session: {},
    hrefFor: () => "#",
    announce: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const county = container.querySelector("#cs-county");
  county.value = "08001";
  county.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const file = container.querySelector("#cs-role-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [{ name: "profile_role.csv", text: async () => "synthetic csv" }],
  });
  file.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.match(
    container.querySelector("#cs-attachment-county").textContent,
    /Adams \(08001\).*profile_role\.csv/,
  );
  const previewButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview attachments",
  );
  previewButton.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(
    container.querySelector("#cs-attachment-county").textContent,
    /Adams \(08001\)/,
  );
  assert.match(
    container.querySelector(".cs-attachments .cs-preview").textContent,
    /profile_role.csv/,
  );
  const commitButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Commit attachments",
  );
  assert.equal(commitButton.disabled, false);
  commitButton.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(committed.request.digest, preview.digest);
  assert.equal(committed.idempotencyKey, "attach-test-key");
  assert.match(
    container.querySelector(".cs-attachments .cs-preview").textContent,
    /Receipt: 1 attached/,
  );
  dom.window.close();
});

test("duplicate ids, missing parents and cycles are rejected", async () => {
  await withStructure(async (ctx) => {
    await assertInvalid(
      ctx,
      csv([
        row(ADAMS, { id: "a", name: "A", type: "office", l1: "A" }),
        row(ADAMS, { id: "a", name: "B", type: "office", l1: "B" }),
      ]),
      "duplicate_unit_id",
    );
    await assertInvalid(
      ctx,
      csv([
        row(ADAMS, {
          id: "a",
          name: "A",
          parent: "ghost",
          type: "office",
          rel: "part_of",
        }),
      ]),
    );
    await assertInvalid(
      ctx,
      csv([
        row(ADAMS, {
          id: "a",
          name: "A",
          parent: "b",
          type: "office",
          rel: "part_of",
        }),
        row(ADAMS, {
          id: "b",
          name: "B",
          parent: "a",
          type: "office",
          rel: "part_of",
        }),
      ]),
    );
    assert.equal(unitIds(ctx.database, "08001").length, 0);
  });
});

test("a unit cannot cross counties", async () => {
  await withStructure(async (ctx) => {
    await assertInvalid(
      ctx,
      csv([
        row(ADAMS, { id: "a", name: "A", type: "office", l1: "A" }),
        row(ALAMOSA, {
          id: "b",
          name: "B",
          parent: "a",
          type: "division",
          rel: "part_of",
        }),
      ]),
    );
  });
});

test("aliases and special characters survive a round trip", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const aliases = ctx.database
      .prepare(
        "SELECT alias, alias_kind FROM county_unit_alias WHERE unit_id = 'adams-clerk' ORDER BY position",
      )
      .all();
    assert.deepEqual(
      aliases.map((r) => r.alias),
      ["Clerk and Recorder", "C&R"],
    );
    const evidence = ctx.database
      .prepare("SELECT evidence FROM county_unit WHERE id = 'adams-sheriff'")
      .get();
    assert.match(evidence.evidence, /"quotes"/);
    assert.match(evidence.evidence, /\n/);
  });
});

test("provenance is optional and never reaches the public service", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const pub = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure("08001");
    const text = JSON.stringify(pub);
    assert.ok(!text.includes("Synthetic evidence"));
    assert.ok(!text.includes("example.invalid"));
    assert.equal(pub.empty, false);
    const exported = await ctx.service.exportCsv(ctx.owner, "08001");
    assert.ok(exported.csv.includes("Synthetic evidence"));
    assert.ok(exported.csv.includes("example.invalid/sheriff"));
  });
});

test("merge updates, renames and moves by stable id", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const rows = adamsRows().map((r) => [...r]);
    // rename Patrol Division and move Road & Bridge under the Sheriff.
    for (const r of rows) {
      if (r[2] === "adams-patrol") {
        r[3] = "Field Operations";
        r[6] = "Field Operations";
      }
      if (r[2] === "adams-roads") {
        r[4] = "adams-sheriff";
        r[5] = "Sheriff's Office";
        r[6] = "Road & Bridge";
        r[10] = "part_of";
      }
    }
    const prepared = await load(ctx, csv(rows));
    assert.ok(prepared.import.counts.update >= 1);
    assert.ok(prepared.import.counts.move >= 1);
    const patrol = ctx.database
      .prepare("SELECT name FROM county_unit WHERE id = 'adams-patrol'")
      .get();
    assert.equal(patrol.name, "Field Operations");
    const roads = ctx.database
      .prepare(
        "SELECT parent_unit_id FROM county_unit WHERE id = 'adams-roads'",
      )
      .get();
    assert.equal(roads.parent_unit_id, "adams-sheriff");
  });
});

test("replace one county leaves other counties alone", async () => {
  await withStructure(async (ctx) => {
    await load(
      ctx,
      csv([
        ...adamsRows(),
        row(ALAMOSA, {
          id: "alamosa-clerk",
          name: "Clerk",
          type: "office",
          l1: "Clerk",
        }),
      ]),
    );
    await load(
      ctx,
      csv([
        row(ADAMS, {
          id: "adams-only",
          name: "Only Office",
          type: "office",
          l1: "Only Office",
        }),
      ]),
      "replace_county",
      "08001",
    );
    assert.deepEqual(unitIds(ctx.database, "08001"), ["adams-only"]);
    assert.deepEqual(unitIds(ctx.database, "08003"), ["alamosa-clerk"]);
  });
});

test("replace all counties removes counties missing from the file", async () => {
  await withStructure(async (ctx) => {
    await load(
      ctx,
      csv([
        ...adamsRows(),
        row(ALAMOSA, {
          id: "alamosa-clerk",
          name: "Clerk",
          type: "office",
          l1: "Clerk",
        }),
      ]),
    );
    const everyCounty = ctx.database
      .prepare("SELECT fips, name FROM counties ORDER BY fips")
      .all()
      .filter((county) => county.fips !== "08003")
      .map((county) => row([county.fips, county.name]));
    await load(
      ctx,
      csv([
        row(ALAMOSA, {
          id: "alamosa-clerk",
          name: "Clerk",
          type: "office",
          l1: "Clerk",
        }),
        ...everyCounty,
      ]),
      "replace_state",
    );
    assert.deepEqual(unitIds(ctx.database, "08001"), []);
    assert.deepEqual(unitIds(ctx.database, "08003"), ["alamosa-clerk"]);
  });
});

test("a failed commit rolls back every change", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const before = unitIds(ctx.database, "08001");
    const rows = adamsRows().slice(0, 4);
    const prepared = await importCsv(ctx, csv(rows), "replace_county", "08001");
    // Sabotage: a trigger that fails midway through the batch.
    ctx.database.exec(`
      CREATE TRIGGER sabotage BEFORE DELETE ON county_unit
      WHEN old.id = 'adams-works' BEGIN SELECT RAISE(ABORT, 'sabotage'); END;
    `);
    await assert.rejects(() => commit(ctx, prepared));
    ctx.database.exec("DROP TRIGGER sabotage");
    assert.deepEqual(unitIds(ctx.database, "08001"), before);
  });
});

test("commit is idempotent and a second key cannot re-apply", async () => {
  await withStructure(async (ctx) => {
    const prepared = await importCsv(ctx, csv(adamsRows()));
    const version = await ctx.service.version();
    const request = {
      importId: prepared.import.id,
      changesetSha256: prepared.import.changesetSha256,
      expectedVersion: version,
      idempotencyKey: key(),
    };
    const first = await ctx.service.commitImport(ctx.owner, request);
    assert.equal(first.replayed, false);
    const again = await ctx.service.commitImport(ctx.owner, request);
    assert.equal(again.replayed, true);
    assert.equal(
      ctx.database.prepare("SELECT count(*) AS n FROM county_unit").get().n,
      adamsRows().length - 1,
    );
    await assert.rejects(
      () =>
        ctx.service.commitImport(ctx.owner, {
          ...request,
          idempotencyKey: key(),
        }),
      (error) => error instanceof CountyStructureConflictError,
    );
  });
});

test("a stale prepared import is refused", async () => {
  await withStructure(async (ctx) => {
    const a = await importCsv(ctx, csv(adamsRows()));
    const b = await importCsv(
      ctx,
      csv([
        row(ALAMOSA, {
          id: "alamosa-clerk",
          name: "Clerk",
          type: "office",
          l1: "Clerk",
        }),
      ]),
    );
    const version = await ctx.service.version();
    await ctx.service.commitImport(ctx.owner, {
      importId: a.import.id,
      changesetSha256: a.import.changesetSha256,
      expectedVersion: version,
      idempotencyKey: key(),
    });
    await assert.rejects(
      () =>
        ctx.service.commitImport(ctx.owner, {
          importId: b.import.id,
          changesetSha256: b.import.changesetSha256,
          expectedVersion: version,
          idempotencyKey: key(),
        }),
      (error) =>
        error instanceof CountyStructureConflictError &&
        error.code === "stale_version",
    );
  });
});

test("two concurrent commits: exactly one wins", async () => {
  await withStructure(async (ctx) => {
    const a = await importCsv(ctx, csv(adamsRows()));
    const b = await importCsv(
      ctx,
      csv([
        row(ALAMOSA, {
          id: "alamosa-clerk",
          name: "Clerk",
          type: "office",
          l1: "Clerk",
        }),
      ]),
    );
    const version = await ctx.service.version();
    const attempt = (p) =>
      ctx.service.commitImport(ctx.owner, {
        importId: p.import.id,
        changesetSha256: p.import.changesetSha256,
        expectedVersion: version,
        idempotencyKey: key(),
      });
    const results = await Promise.allSettled([attempt(a), attempt(b)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });
});

test("Profile references block unsafe removal and survive retirement", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const roleId = addPerson(ctx.database);
    await ctx.service.addRoleDisplay(ctx.owner, {
      personRoleId: roleId,
      listing: "home",
      unitId: "adams-sheriff",
    });
    const prepared = await importCsv(
      ctx,
      csv(
        adamsRows().filter(
          (r) => r[2] !== "adams-sheriff" && r[4] !== "adams-sheriff",
        ),
      ),
      "replace_county",
      "08001",
    );
    assert.equal(prepared.committable, false);
    assert.ok(prepared.import.counts.blocked >= 1);
    assert.equal(
      ctx.database.prepare("SELECT count(*) AS n FROM person_roles").get().n,
      1,
    );
  });
});

test("one Sheriff appears in elected and Sheriff views without duplicates", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const roleId = addPerson(ctx.database);
    await ctx.service.addRoleDisplay(ctx.owner, {
      personRoleId: roleId,
      listing: "home",
      unitId: "adams-sheriff",
    });
    const added = await ctx.service.addRoleDisplay(ctx.owner, {
      personRoleId: roleId,
      listing: "elected_official",
      unitId: "adams-sheriff",
    });
    assert.equal(added.created, true);
    const again = await ctx.service.addRoleDisplay(ctx.owner, {
      personRoleId: roleId,
      listing: "elected_official",
      unitId: "adams-sheriff",
    });
    assert.equal(again.created, false);
    const pub = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure("08001");
    assert.equal(pub.electedOfficials.length, 1);
    assert.equal(pub.electedOfficials[0].personId, "p-sheriff");
    const sheriff = pub.groups
      .flatMap((group) => group.units)
      .find((u) => u.id === "adams-sheriff");
    assert.equal(sheriff.people.length, 1);
    assert.equal(sheriff.people[0].personId, "p-sheriff");
    assert.equal(
      ctx.database.prepare("SELECT count(*) AS n FROM people").get().n,
      1,
    );
    assert.equal(
      ctx.database.prepare("SELECT count(*) AS n FROM person_roles").get().n,
      1,
    );
  });
});

test("dashboard edits, version checks and reversal", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    let version = await ctx.service.version();
    const created = await ctx.service.edit(ctx.owner, {
      expectedVersion: version,
      edit: {
        op: "create_unit",
        countyFips: "08001",
        name: "Treasurer",
        organizationType: "office",
      },
    });
    assert.ok(created.entityId);
    await assert.rejects(
      () =>
        ctx.service.edit(ctx.owner, {
          expectedVersion: version,
          edit: { op: "update", id: created.entityId, name: "Stale" },
        }),
      (error) => error instanceof CountyStructureConflictError,
    );
    version = created.structureVersion;
    await ctx.service.edit(ctx.owner, {
      expectedVersion: version,
      edit: { op: "update", id: created.entityId, name: "County Treasurer" },
    });
    assert.equal(
      ctx.database
        .prepare("SELECT name FROM county_unit WHERE id = ?")
        .get(created.entityId).name,
      "County Treasurer",
    );
  });
});

test("a committed import can be reversed only while it is the latest change", async () => {
  await withStructure(async (ctx) => {
    const first = await load(ctx, csv(adamsRows()));
    const second = await load(
      ctx,
      csv([
        row(ALAMOSA, {
          id: "alamosa-clerk",
          name: "Clerk",
          type: "office",
          l1: "Clerk",
        }),
      ]),
    );
    await assert.rejects(
      () =>
        ctx.service.reverseImport(ctx.owner, {
          importId: first.import.id,
          idempotencyKey: key(),
        }),
      (error) =>
        error instanceof CountyStructureConflictError &&
        error.code === "not_reversible",
    );
    await ctx.service.reverseImport(ctx.owner, {
      importId: second.import.id,
      idempotencyKey: key(),
    });
    assert.deepEqual(unitIds(ctx.database, "08003"), []);
    assert.ok(unitIds(ctx.database, "08001").length > 0);
  });
});

test("history is append-only", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    assert.throws(() =>
      ctx.database.exec("DELETE FROM county_structure_history"),
    );
    assert.throws(() =>
      ctx.database.exec("UPDATE county_structure_history SET action = 'x'"),
    );
  });
});

test("only the owner may use the service", async () => {
  await withStructure(async (ctx) => {
    await assert.rejects(() => ctx.service.exportCsv(ctx.admin));
    await assert.rejects(() =>
      ctx.service.prepareImport(ctx.admin, {
        fileName: "county.csv",
        csv: csv(adamsRows()),
        mode: "merge",
      }),
    );
    await assert.rejects(() => ctx.service.listCounties(ctx.admin));
  });
});

test("a header mismatch is a validation error", async () => {
  await withStructure(async (ctx) => {
    await assert.rejects(
      () => importCsv(ctx, "wrong,header\r\n1,2\r\n"),
      (error) => error instanceof CountyStructureValidationError,
    );
  });
});

test("a county with no units imports as a county-only row", async () => {
  await withStructure(async (ctx) => {
    const prepared = await importCsv(ctx, csv([row(ADAMS)]));
    assert.equal(prepared.committable, true, JSON.stringify(prepared.issues));
    await commit(ctx, prepared);
    assert.deepEqual(unitIds(ctx.database, "08001"), []);
  });
});

test("the documented example county.csv imports, exports and round-trips", async () => {
  await withStructure(async (ctx) => {
    const example = readFileSync(
      new URL("./fixtures/county-structure-example.csv.txt", import.meta.url),
      "utf8",
    );
    await load(ctx, example, "merge");
    const exported = await ctx.service.exportCsv(ctx.owner, "08001");
    const lines = exported.csv.trim().split(/\r?\n/);
    assert.equal(lines[0].split(",").length, 17);
    assert.ok(exported.csv.includes("adams-sheriff"));
    assert.ok(exported.csv.includes("Synthetic evidence"));
  });
});

test("the public county section shows names and people but never private fields", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const roleId = addPerson(ctx.database);
    for (const listing of ["home", "elected_official"]) {
      await ctx.service.addRoleDisplay(ctx.owner, {
        personRoleId: roleId,
        listing,
        unitId: "adams-sheriff",
      });
    }
    const structure = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure("08001");
    const page = String(countyStructureSection("Adams County", structure));
    assert.match(page, /Sheriff&#39;s Office|Sheriff's Office/);
    assert.match(page, /Synthetic Sheriff/);
    assert.match(page, /Elected officials/);
    assert.ok(!page.includes("Synthetic evidence"));
    assert.ok(!page.includes("example.invalid"));
    const empty = String(
      countyStructureSection(
        "Alamosa County",
        await new D1CountyStructurePublicService(ctx.d1).getCountyStructure(
          "08003",
        ),
      ),
    );
    assert.match(empty, /No structure recorded for Alamosa County yet/);
  });
});

test("hidden and former units stay off the public section", async () => {
  await withStructure(async (ctx) => {
    const rows = adamsRows().map((r) => [...r]);
    for (const r of rows) {
      if (r[2] === "adams-works") r[16] = "hidden";
      if (r[2] === "adams-detention") r[16] = "former";
    }
    await load(ctx, csv(rows));
    const structure = await new D1CountyStructurePublicService(
      ctx.d1,
    ).getCountyStructure("08001");
    const page = String(countyStructureSection("Adams County", structure));
    assert.ok(!page.includes("Public Works"));
    assert.ok(!page.includes("Detention Division"));
    assert.match(page, /Patrol Division/);
  });
});

// COUNTY-DB-1 display corrections (#269, #259 reproduction).

const publicView = (ctx, fips = "08001") =>
  new D1CountyStructurePublicService(ctx.d1).getCountyStructure(fips);

const headingOf = (view, id) => {
  const hits = [];
  const walk = (units, heading) => {
    for (const unit of units) {
      if (unit.id === id) hits.push(heading);
      walk(unit.children, heading);
    }
  };
  for (const group of view.groups) walk(group.units, group.name);
  return hits;
};

const countOf = (page, text) => page.split(text).length - 1;

test("a unit with no saved heading shows under its type heading, and Other once", async () => {
  await withStructure(async (ctx) => {
    await load(
      ctx,
      csv([
        row(ADAMS, { id: "u-dept", name: "Planning", type: "department" }),
        row(ADAMS, { id: "u-board", name: "Library Board", type: "board" }),
        row(ADAMS, {
          id: "u-comm",
          name: "Zoning Commission",
          type: "commission",
        }),
        row(ADAMS, {
          id: "u-odd1",
          name: "Special Project Alpha",
          type: "program",
        }),
        row(ADAMS, {
          id: "u-odd2",
          name: "Special Project Beta",
          type: "other",
        }),
      ]),
    );
    const view = await publicView(ctx);
    assert.deepEqual(headingOf(view, "u-dept"), ["Departments"]);
    assert.deepEqual(headingOf(view, "u-board"), ["Boards"]);
    assert.deepEqual(headingOf(view, "u-comm"), ["Commissions"]);
    assert.deepEqual(headingOf(view, "u-odd1"), ["Other"]);
    assert.deepEqual(headingOf(view, "u-odd2"), ["Other"]);
    assert.equal(view.groups.filter((g) => g.name === "Other").length, 1);
    const page = String(countyStructureSection("Adams County", view));
    for (const name of ["Planning", "Library Board", "Special Project Alpha"])
      assert.equal(countOf(page, name), 1, name);
    assert.equal(countOf(page, ">Other<"), 1);
  });
});

test("a saved heading wins, and the county's own matching heading is reused", async () => {
  await withStructure(async (ctx) => {
    await load(
      ctx,
      csv([
        row(ADAMS, {
          id: "g-dept",
          name: "Departments",
          type: "display_group",
          order: "1",
        }),
        row(ADAMS, {
          id: "g-eo",
          name: "Elected Official",
          type: "display_group",
          order: "2",
        }),
        row(ADAMS, {
          id: "u-assessor",
          name: "Assessor",
          parent: "g-eo",
          rel: "display_group",
          type: "office",
        }),
        row(ADAMS, { id: "u-works", name: "Public Works", type: "department" }),
        row(ADAMS, { id: "u-clerk", name: "Clerk", type: "office" }),
      ]),
    );
    const view = await publicView(ctx);
    assert.deepEqual(headingOf(view, "u-assessor"), ["Elected Official"]);
    assert.deepEqual(headingOf(view, "u-works"), ["Departments"]);
    assert.deepEqual(headingOf(view, "u-clerk"), ["Offices"]);
    assert.equal(view.groups.filter((g) => g.name === "Departments").length, 1);
  });
});

test("a verified parent nests once, a held parent stays under Departments, and the Sheriff stays top-level", async () => {
  await withStructure(async (ctx) => {
    const rows = adamsRows();
    rows.push(
      // Reporting parent held: no parent id, the reason stays in private evidence.
      row(ADAMS, {
        id: "adams-rb-held",
        name: "Road and Bridge",
        type: "department",
        evidence: "Synthetic hold: reporting line not verified.",
      }),
    );
    await load(ctx, csv(rows));
    const view = await publicView(ctx);
    // Verified nested line: Road & Bridge sits under Public Works, once.
    assert.deepEqual(headingOf(view, "adams-roads"), ["Departments"]);
    const works = view.groups
      .flatMap((g) => g.units)
      .find((u) => u.id === "adams-works");
    assert.deepEqual(
      works.children.map((c) => c.id),
      ["adams-roads"],
    );
    assert.equal(
      view.groups.flatMap((g) => g.units).some((u) => u.id === "adams-roads"),
      false,
    );
    // Held parent: the unit is a direct child of the Departments heading.
    const departments = view.groups.find((g) => g.name === "Departments");
    assert.ok(departments.units.some((u) => u.id === "adams-rb-held"));
    const held = ctx.database
      .prepare(
        "SELECT parent_unit_id, evidence FROM county_unit WHERE id = 'adams-rb-held'",
      )
      .get();
    assert.equal(held.parent_unit_id, null);
    assert.match(held.evidence, /hold/);
    // Sheriff's Office: structural root, not under Elected Official.
    assert.ok(!headingOf(view, "adams-sheriff").includes("Elected Official"));
    assert.equal(headingOf(view, "adams-sheriff").length, 1);
    assert.equal(
      ctx.database
        .prepare(
          "SELECT parent_unit_id FROM county_unit WHERE id = 'adams-sheriff'",
        )
        .get().parent_unit_id,
      null,
    );
    const page = String(countyStructureSection("Adams County", view));
    for (const name of [
      "Road and Bridge",
      "Sheriff&#39;s Office",
      "Public Works",
    ]) {
      assert.equal(countOf(page, `class="structure-name">${name}<`), 1, name);
    }
  });
});

test("whitespace-only aliases on one unit ID show one public label and stay in private data", async () => {
  await withStructure(async (ctx) => {
    await load(
      ctx,
      csv([
        row(ADAMS, {
          id: "u-hyphen",
          name: "Health-Human Services",
          type: "department",
          aliases:
            '["Health - Human Services","Health -Human  Services","Public Health"]',
        }),
        row(ADAMS, {
          id: "u-slash",
          name: "Clerk/Recorder",
          type: "office",
          aliases: '["Clerk / Recorder"]',
        }),
      ]),
    );
    const view = await publicView(ctx);
    const find = (id) =>
      view.groups.flatMap((g) => g.units).find((u) => u.id === id);
    assert.deepEqual(find("u-hyphen").aliases, ["Public Health"]);
    assert.deepEqual(find("u-slash").aliases, []);
    const page = String(countyStructureSection("Adams County", view));
    assert.ok(!page.includes("Health - Human Services"));
    assert.ok(!page.includes("Clerk / Recorder"));
    assert.equal(countOf(page, "Also known as"), 1);
    // Literal spellings stay in the database and round trip through export.
    assert.equal(
      ctx.database
        .prepare(
          "SELECT count(*) AS n FROM county_unit_alias WHERE unit_id = 'u-hyphen'",
        )
        .get().n,
      3,
    );
    const exported = await ctx.service.exportCsv(ctx.owner, "08001");
    assert.ok(exported.csv.includes("Health - Human Services"));
    assert.ok(exported.csv.includes("Clerk / Recorder"));
  });
});

test("distinct IDs with lookalike names stay separate public units", async () => {
  await withStructure(async (ctx) => {
    await load(
      ctx,
      csv([
        row(ADAMS, { id: "u-a", name: "Road-Bridge", type: "department" }),
        row(ADAMS, { id: "u-b", name: "Road - Bridge", type: "department" }),
      ]),
    );
    const view = await publicView(ctx);
    assert.deepEqual(headingOf(view, "u-a"), ["Departments"]);
    assert.deepEqual(headingOf(view, "u-b"), ["Departments"]);
    assert.equal(unitIds(ctx.database, "08001").length, 2);
    const page = String(countyStructureSection("Adams County", view));
    assert.equal(countOf(page, "Road-Bridge"), 1);
    assert.equal(countOf(page, "Road - Bridge"), 1);
  });
});

test("a replacement preview protects linked Profile roles and keeps them when the unit is only re-headed", async () => {
  await withStructure(async (ctx) => {
    await load(ctx, csv(adamsRows()));
    const roleId = addPerson(ctx.database);
    await ctx.service.addRoleDisplay(ctx.owner, {
      personRoleId: roleId,
      listing: "home",
      unitId: "adams-sheriff",
    });
    const without = await importCsv(
      ctx,
      csv(
        adamsRows().filter(
          (r) => r[2] !== "adams-sheriff" && r[4] !== "adams-sheriff",
        ),
      ),
      "replace_county",
      "08001",
    );
    assert.equal(without.committable, false);
    const sheriffItem = without.items.find(
      (i) => i.entityId === "adams-sheriff",
    );
    assert.equal(sheriffItem.blocked, true);
    assert.equal(sheriffItem.profileReferences, 1);
    // Re-heading the same ID under a saved group keeps the link and commits.
    const moved = adamsRows().map((r) => [...r]);
    for (const r of moved) {
      if (r[2] === "adams-sheriff") {
        r[4] = "adams-eo";
        r[5] = "Elected Official";
        r[6] = "Sheriff's Office";
        r[10] = "display_group";
      }
      if (r[4] === "adams-sheriff") {
        r[5] = "Elected Official";
        r[7] = r[6];
        r[6] = "Sheriff's Office";
      }
    }
    const kept = await importCsv(ctx, csv(moved), "replace_county", "08001");
    assert.equal(kept.committable, true, JSON.stringify(kept.issues));
    await commit(ctx, kept);
    assert.equal(
      ctx.database
        .prepare("SELECT count(*) AS n FROM county_role_display")
        .get().n,
      1,
    );
    assert.equal(
      ctx.database.prepare("SELECT count(*) AS n FROM person_roles").get().n,
      1,
    );
  });
});

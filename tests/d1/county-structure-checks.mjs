import { AsyncD1Database } from "../../src/database/d1.ts";
import { D1CountyRoleAttachments } from "../../src/services/county-role-attachment-d1.ts";
import { writeCsvTable } from "../../src/services/county-structure-csv.ts";
import {
  CountyStructureConflictError,
  D1CountyStructureAdministration,
} from "../../src/services/county-structure-d1.ts";
import { D1CountyStructurePublicService } from "../../src/services/county-structure-public.ts";
import {
  AuthorizationError,
  makeTrustedPrincipal,
} from "../../src/services/security.ts";

const ADAMS = ["08001", "Adams"];
const ALAMOSA = ["08003", "Alamosa"];

const row = (county, f = {}) => [
  county[0],
  county[1],
  f.id ?? "",
  f.name ?? "",
  f.parent ?? "",
  f.l1 ?? "",
  f.l2 ?? "",
  f.l3 ?? "",
  f.type ?? "",
  f.aliases ?? "",
  f.rel ?? "",
  f.evidence ?? "",
  f.sources ?? "",
  f.from ?? "",
  f.until ?? "",
  f.order ?? "",
  f.status ?? "",
];

/**
 * County Structure over the real isolated local D1: a three-level county with
 * the Sheriff's Office at the top level, merge and replace imports, atomic
 * rollback, idempotent commit, stale and concurrent commits, Profile blocking,
 * reversal, private provenance and a 3,000 unit county that exercises chunked
 * set-based writes and keyset reads. Synthetic accounts and records only.
 */
export async function runCountyStructureChecks(env) {
  const checks = [];
  const check = (name, passed, detail = "") => {
    if (!passed)
      throw new Error(
        `County Structure check failed: ${name} ${detail}`.trim(),
      );
    checks.push(name);
  };
  const one = async (sql, ...values) =>
    env.DB.prepare(sql)
      .bind(...values)
      .first();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO accounts (id, kind, role, display_name) VALUES ('cs-d1-owner', 'human', 'owner', 'Synthetic CS Owner')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO identities (id, account_id, provider, subject) VALUES ('cs-d1-owner-identity', 'cs-d1-owner', 'synthetic', 'cs-d1-owner')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO accounts (id, kind, role, display_name) VALUES ('cs-d1-admin', 'human', 'administrator', 'Synthetic CS Admin')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO identities (id, account_id, provider, subject) VALUES ('cs-d1-admin-identity', 'cs-d1-admin', 'synthetic', 'cs-d1-admin')",
    ),
  ]);
  const principal = (id, role) =>
    makeTrustedPrincipal(
      { id, identity_id: `${id}-identity`, kind: "human", role },
      "synthetic",
    );
  const owner = principal("cs-d1-owner", "owner");
  const admin = principal("cs-d1-admin", "administrator");
  const database = new AsyncD1Database(env.DB);
  const service = new D1CountyStructureAdministration(database);
  const publicService = new D1CountyStructurePublicService(database);
  let keyNumber = 0;
  const key = () => {
    keyNumber += 1;
    return `cs-d1-key-${String(keyNumber).padStart(6, "0")}`;
  };

  const prepare = (csv, mode = "merge", countyFips = null) =>
    service.prepareImport(owner, {
      fileName: "county.csv",
      csv,
      mode,
      countyFips,
    });
  const commit = async (prepared, idempotencyKey = key()) =>
    service.commitImport(owner, {
      importId: prepared.import.id,
      changesetSha256: prepared.import.changesetSha256,
      expectedVersion: await service.version(),
      idempotencyKey,
    });
  const units = async (fips) =>
    (
      await env.DB.prepare(
        "SELECT id FROM county_unit WHERE county_fips = ? ORDER BY id",
      )
        .bind(fips)
        .all()
    ).results.map((r) => r.id);

  // A three-level county with Sheriff's Office as a top-level unit.
  const adams = [
    row(ADAMS, {
      id: "d1-eo",
      name: "Elected Official",
      type: "display_group",
      l1: "Elected Official",
      order: "1",
    }),
    row(ADAMS, {
      id: "d1-assessor",
      name: "Assessor",
      parent: "d1-eo",
      type: "office",
      l1: "Elected Official",
      l2: "Assessor",
      rel: "display_group",
      order: "1",
    }),
    row(ADAMS, {
      id: "d1-sheriff",
      name: "Sheriff's Office",
      type: "office",
      l1: "Sheriff's Office",
      order: "2",
      evidence: "Synthetic private evidence",
      sources: "https://example.invalid/d1",
    }),
    row(ADAMS, {
      id: "d1-patrol",
      name: "Patrol Division",
      parent: "d1-sheriff",
      type: "division",
      l1: "Sheriff's Office",
      l2: "Patrol Division",
      rel: "part_of",
    }),
    row(ADAMS, {
      id: "d1-works",
      name: "Public Works",
      type: "department",
      l1: "Public Works",
      order: "3",
    }),
    row(ADAMS, {
      id: "d1-roads",
      name: "Road & Bridge",
      parent: "d1-works",
      type: "division",
      l1: "Public Works",
      l2: "Road & Bridge",
      rel: "reports_to",
    }),
  ];
  const adamsCsv = writeCsvTable(adams);

  const first = await prepare(adamsCsv);
  check(
    "preview is committable and changes nothing",
    first.committable && (await units("08001")).length === 0,
  );
  const version = await service.version();
  const committed = await service.commitImport(owner, {
    importId: first.import.id,
    changesetSha256: first.import.changesetSha256,
    expectedVersion: version,
    idempotencyKey: "cs-d1-key-first",
  });
  check(
    "merge import commits",
    !committed.replayed && (await units("08001")).length === 5,
  );
  const sheriff = await one(
    "SELECT parent_unit_id, display_group_id FROM county_unit WHERE id = 'd1-sheriff'",
  );
  check(
    "Sheriff's Office is top-level and not under a display group",
    sheriff.parent_unit_id === null && sheriff.display_group_id === null,
  );
  const replay = await service.commitImport(owner, {
    importId: first.import.id,
    changesetSha256: first.import.changesetSha256,
    expectedVersion: version,
    idempotencyKey: "cs-d1-key-first",
  });
  check(
    "same key replays without a second write",
    replay.replayed === true && (await service.version()) === version + 1,
  );

  let reused = false;
  try {
    await service.commitImport(owner, {
      importId: first.import.id,
      changesetSha256: first.import.changesetSha256,
      expectedVersion: version,
      idempotencyKey: key(),
    });
  } catch (error) {
    reused = error instanceof CountyStructureConflictError;
  }
  check(
    "a prepared import cannot be committed again under another key",
    reused,
  );

  const exported = await service.exportCsv(owner, "08001");
  check(
    "export keeps 17 columns and private provenance",
    exported.csv.split(/\r?\n/)[0].split(",").length === 17 &&
      exported.csv.includes("Synthetic private evidence"),
  );
  const roundTrip = await prepare(exported.csv, "replace_county", "08001");
  check(
    "exported file previews as no change",
    roundTrip.committable &&
      roundTrip.import.counts.add === 0 &&
      roundTrip.import.counts.remove === 0 &&
      roundTrip.import.counts.move === 0,
  );

  const pub = JSON.stringify(await publicService.getCountyStructure("08001"));
  check(
    "public structure shows names and never private provenance",
    pub.includes("Sheriff") &&
      !pub.includes("Synthetic private evidence") &&
      !pub.includes("example.invalid"),
  );

  // Authorization.
  let denied = false;
  try {
    await service.exportCsv(admin);
  } catch (error) {
    denied = error instanceof AuthorizationError;
  }
  check("administrators are denied", denied);

  // Stale commit: two imports prepared at one version.
  const a = await prepare(
    writeCsvTable([
      ...adams,
      row(ADAMS, {
        id: "d1-extra-a",
        name: "Extra A",
        type: "office",
        l1: "Extra A",
      }),
    ]),
  );
  const b = await prepare(
    writeCsvTable([
      ...adams,
      row(ADAMS, {
        id: "d1-extra-b",
        name: "Extra B",
        type: "office",
        l1: "Extra B",
      }),
    ]),
  );
  const staleVersion = await service.version();
  const results = await Promise.allSettled(
    [a, b].map((prepared) =>
      service.commitImport(owner, {
        importId: prepared.import.id,
        changesetSha256: prepared.import.changesetSha256,
        expectedVersion: staleVersion,
        idempotencyKey: key(),
      }),
    ),
  );
  check(
    "two competing commits: exactly one wins",
    results.filter((r) => r.status === "fulfilled").length === 1 &&
      results.filter((r) => r.status === "rejected").length === 1,
  );

  // Atomic rollback: a trigger fails the batch part way through.
  await env.DB.prepare(
    "CREATE TRIGGER cs_d1_sabotage BEFORE DELETE ON county_unit WHEN old.id = 'd1-roads' BEGIN SELECT RAISE(ABORT, 'sabotage'); END",
  ).run();
  const before = JSON.stringify(await units("08001"));
  const shrink = await prepare(
    writeCsvTable(adams.slice(0, 3)),
    "replace_county",
    "08001",
  );
  let rolledBack = false;
  try {
    await commit(shrink);
  } catch {
    rolledBack = true;
  }
  await env.DB.prepare("DROP TRIGGER cs_d1_sabotage").run();
  check(
    "a failing batch rolls every change back",
    rolledBack && JSON.stringify(await units("08001")) === before,
  );

  // Profile references block removal.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO role_sources (id, url, title, source_type) VALUES ('cs-d1-source', 'https://example.invalid/cs', 'Synthetic', 'official_page')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO people (id, display_name) VALUES ('cs-d1-person', 'Synthetic Sheriff')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO person_roles (id, person_id, source_id, source_checked_at, county_fips, published_title) VALUES ('cs-d1-role', 'cs-d1-person', 'cs-d1-source', '2026-11-01T00:00:00Z', '08001', 'Sheriff')",
    ),
  ]);
  await service.addRoleDisplay(owner, {
    personRoleId: "cs-d1-role",
    listing: "home",
    unitId: "d1-sheriff",
  });
  await service.addRoleDisplay(owner, {
    personRoleId: "cs-d1-role",
    listing: "elected_official",
    unitId: "d1-sheriff",
  });
  const blocked = await prepare(
    writeCsvTable(
      adams.filter((r) => r[2] !== "d1-sheriff" && r[4] !== "d1-sheriff"),
    ),
    "replace_county",
    "08001",
  );
  check(
    "removing a unit with a Profile reference is blocked",
    !blocked.committable && blocked.import.counts.blocked >= 1,
  );
  const view = await publicService.getCountyStructure("08001");
  check(
    "one Sheriff role appears in both views with no duplicate",
    view.electedOfficials.length === 1 &&
      (
        await one(
          "SELECT COUNT(*) AS n FROM person_roles WHERE id = 'cs-d1-role'",
        )
      ).n === 1,
  );

  // Reversal of the latest import.
  const other = await prepare(
    writeCsvTable([
      row(ALAMOSA, {
        id: "d1-alamosa",
        name: "Clerk",
        type: "office",
        l1: "Clerk",
      }),
    ]),
  );
  const otherCommit = await commit(other);
  check(
    "a second county merges in",
    (await units("08003")).includes("d1-alamosa"),
  );
  await service.reverseImport(owner, {
    importId: otherCommit.import.id,
    idempotencyKey: key(),
  });
  check(
    "reversal restores the previous state",
    (await units("08003")).length === 0 && (await units("08001")).length > 0,
  );

  // Scale: 3,000 units in three levels.
  const scale = [];
  for (let a1 = 0; a1 < 10; a1 += 1) {
    scale.push(
      row(ALAMOSA, {
        id: `s-${a1}`,
        name: `Office ${a1}`,
        type: "office",
        l1: `Office ${a1}`,
        order: String(a1),
      }),
    );
    for (let b1 = 0; b1 < 10; b1 += 1) {
      scale.push(
        row(ALAMOSA, {
          id: `s-${a1}-${b1}`,
          name: `Division ${a1}.${b1}`,
          parent: `s-${a1}`,
          type: "division",
          l1: `Office ${a1}`,
          l2: `Division ${a1}.${b1}`,
          rel: "part_of",
        }),
      );
      for (let c1 = 0; c1 < 29; c1 += 1) {
        scale.push(
          row(ALAMOSA, {
            id: `s-${a1}-${b1}-${c1}`,
            name: `Section ${a1}.${b1}.${c1}`,
            parent: `s-${a1}-${b1}`,
            type: "section",
            l1: `Office ${a1}`,
            l2: `Division ${a1}.${b1}`,
            l3: `Section ${a1}.${b1}.${c1}`,
            rel: "part_of",
            evidence: "Synthetic scale evidence",
          }),
        );
      }
    }
  }
  const scaleCsv = writeCsvTable(scale);
  const scalePrepared = await prepare(scaleCsv, "replace_county", "08003");
  check(
    "a 3,010 unit county previews",
    scalePrepared.committable &&
      scalePrepared.import.counts.add === scale.length,
    JSON.stringify(scalePrepared.import.counts),
  );
  await commit(scalePrepared);
  check(
    "a 3,010 unit county commits in one batch",
    (await units("08003")).length === scale.length,
  );
  const scaleExport = await service.exportCsv(owner, "08003");
  const again = await prepare(scaleExport.csv, "replace_county", "08003");
  check(
    "the large export round-trips with no change",
    again.committable &&
      again.import.counts.add === 0 &&
      again.import.counts.update === 0 &&
      again.import.counts.remove === 0,
  );
  const detail = await service.getCounty(owner, "08003");
  check(
    "the large county reads back as a tree",
    detail.counts.units === scale.length && detail.roots.length === 10,
  );
  const emptied = await prepare(
    writeCsvTable([row(ALAMOSA)]),
    "replace_county",
    "08003",
  );
  await commit(emptied);
  check(
    "replacing the large county with an empty one removes all units",
    (await units("08003")).length === 0,
  );

  // The v4 contract (migration 0033): an 8,816 character Source references
  // field and units placed for browsing under a regular unit.
  const BOULDER = ["08013", "Boulder"];
  const longSources = Array.from(
    { length: 200 },
    (_, index) =>
      `https://example.invalid/synthetic/d1/source-${String(index).padStart(4, "0")}`,
  )
    .join("\n")
    .slice(0, 8816);
  const v4 = [
    row(BOULDER, {
      id: "d1-extension",
      name: "CSU Extension",
      type: "department",
      l1: "CSU Extension",
      sources: longSources,
    }),
    ...Array.from({ length: 8 }, (_, index) =>
      row(BOULDER, {
        id: `d1-program-${index + 1}`,
        name: `Synthetic Program ${index + 1}`,
        parent: "d1-extension",
        rel: "display_group",
        type: "program",
        l1: "CSU Extension",
        l2: `Synthetic Program ${index + 1}`,
        order: String(index + 1),
      }),
    ),
  ];
  const v4Prepared = await prepare(
    writeCsvTable(v4),
    "replace_county",
    "08013",
  );
  check(
    "the v4 shapes preview",
    v4Prepared.committable && v4Prepared.import.counts.add === 9,
    JSON.stringify(v4Prepared.import.counts),
  );
  await commit(v4Prepared);
  const stored = await one(
    "SELECT length(source_references) AS n FROM county_unit WHERE id = 'd1-extension'",
  );
  check("8,816 characters are stored without truncation", stored?.n === 8816);
  const placed = await one(
    `SELECT COUNT(*) AS n FROM county_unit WHERE county_fips = '08013'
       AND browse_parent_unit_id = 'd1-extension' AND parent_unit_id IS NULL
       AND parent_relationship IS NULL`,
  );
  check(
    "placed units have browse placement and no reporting parent",
    placed?.n === 8,
  );
  const v4Export = await service.exportCsv(owner, "08013");
  const v4Again = await prepare(v4Export.csv, "replace_county", "08013");
  check(
    "the v4 export round-trips unchanged with the full field",
    v4Export.csv.includes(longSources) && v4Again.items.length === 0,
  );
  const v4Public = await publicService.getCountyStructure("08013");
  const extension = v4Public.groups
    .flatMap((group) => group.units)
    .find((unit) => unit.id === "d1-extension");
  check(
    "the public page lists placed units under CSU Extension without provenance",
    extension?.children.length === 8 &&
      !JSON.stringify(v4Public).includes("example.invalid"),
  );
  await commit(
    await prepare(writeCsvTable([row(BOULDER)]), "replace_county", "08013"),
  );
  check(
    "placed units and their browse parent remove together",
    (await units("08013")).length === 0,
  );
  // Role-to-unit attachment over real D1: set-based insert and remap with
  // exact count assertions, one importer-mapped role, and a keyed replay.
  await commit(
    await prepare(
      writeCsvTable([
        row(BOULDER, { id: "d1-att-a", name: "Synthetic A", type: "office" }),
        row(BOULDER, { id: "d1-att-b", name: "Synthetic B", type: "office" }),
      ]),
      "replace_county",
      "08013",
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO people (id, display_name) VALUES ('cs-d1-att-person', 'Synthetic Attached')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO person_roles (id, person_id, source_id, source_checked_at, county_fips, published_title) VALUES ('cs-d1-att-role', 'cs-d1-att-person', 'cs-d1-source', '2026-11-01T00:00:00Z', '08013', 'Synthetic Title')",
    ),
    env.DB.prepare(
      `INSERT INTO sync_batches (id, actor_account_id, idempotency_key, request_fingerprint, contract_version, request_id, status, committed_at, result_json)
       VALUES ('cs-d1-att-batch', 'cs-d1-owner', 'pi:cs-d1-att', '${"0".repeat(64)}', 'm2-sync/v1', 'cs-d1-att-request', 'committed', '2026-11-19T00:00:00Z', '{}')`,
    ),
    env.DB.prepare(
      `INSERT INTO sync_batch_items (batch_id, item_index, client_ref, entity, operation, target_id, outcome, committed_version, inverse_json)
       VALUES ('cs-d1-att-batch', 0, 'dash:role:RA1', 'person_roles', 'create_person_role', 'cs-d1-att-role', 'created', 1, '{}')`,
    ),
  ]);
  const attachments = new D1CountyRoleAttachments(database);
  const attachFile = (unit) =>
    `role_id,county_fips,county_unit_id\r\nRA1,08013,${unit}\r\nRA9,08013,d1-att-a\r\n`;
  const firstFile = attachFile("d1-att-a");
  const firstPreview = await attachments.preview(owner, {
    csv: firstFile,
    countyFips: "08013",
  });
  check(
    "attachment preview resolves the importer mapping and skips unimported roles",
    firstPreview.counts.attach === 1 && firstPreview.counts.skipped === 1,
    JSON.stringify(firstPreview.counts),
  );
  const attachKey = key();
  await attachments.commit(owner, {
    csv: firstFile,
    countyFips: "08013",
    digest: firstPreview.digest,
    idempotencyKey: attachKey,
  });
  const replayed = await attachments.commit(owner, {
    csv: firstFile,
    countyFips: "08013",
    digest: firstPreview.digest,
    idempotencyKey: attachKey,
  });
  const homeUnit = async () =>
    one(
      "SELECT unit_id, version FROM county_role_display WHERE person_role_id = 'cs-d1-att-role' AND listing = 'home'",
    );
  check(
    "attachment commits once and replays the stored receipt",
    replayed.replayed && (await homeUnit())?.unit_id === "d1-att-a",
  );
  const secondFile = attachFile("d1-att-b");
  const secondPreview = await attachments.preview(owner, {
    csv: secondFile,
    countyFips: "08013",
  });
  await attachments.commit(owner, {
    csv: secondFile,
    countyFips: "08013",
    digest: secondPreview.digest,
    idempotencyKey: key(),
  });
  const remapped = await homeUnit();
  check(
    "a remap moves the home listing and increments its version",
    secondPreview.counts.remap === 1 &&
      remapped?.unit_id === "d1-att-b" &&
      remapped?.version === 2,
  );
  await env.DB.prepare(
    "DELETE FROM county_role_display WHERE person_role_id = 'cs-d1-att-role'",
  ).run();
  await commit(
    await prepare(writeCsvTable([row(BOULDER)]), "replace_county", "08013"),
  );

  check(
    "history is append-only",
    await (async () => {
      try {
        await env.DB.prepare("DELETE FROM county_structure_history").run();
        return false;
      } catch {
        return true;
      }
    })(),
  );

  return { checks };
}

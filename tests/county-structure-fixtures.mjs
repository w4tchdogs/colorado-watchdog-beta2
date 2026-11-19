import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { writeCsvTable } from "../dist/services/county-structure-csv.js";
import { D1CountyStructureAdministration } from "../dist/services/county-structure-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";

/** In-process D1: the batch is one transaction, like the hosted binding. */
export function localD1(database) {
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
      const transact = database.transaction(() =>
        statements.map((statement) => statement.runSync()),
      );
      return transact();
    },
  };
  return new AsyncD1Database(binding);
}

let counter = 0;
const sequentialId = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

export async function withStructure(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name) VALUES ('cs-owner', 'human', 'owner', 'Synthetic Owner');
    INSERT INTO identities (id, account_id, provider, subject) VALUES ('cs-owner-identity', 'cs-owner', 'test-human', 'owner');
    INSERT INTO accounts (id, kind, role, display_name) VALUES ('cs-admin', 'human', 'administrator', 'Synthetic Admin');
    INSERT INTO identities (id, account_id, provider, subject) VALUES ('cs-admin-identity', 'cs-admin', 'test-human', 'admin');
  `);
  const adapter = createTestHumanIdentityAdapter({
    owner: "owner",
    admin: "admin",
  });
  const principalFor = (subject) =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": subject },
      }),
      adapter,
    );
  const owner = await principalFor("owner");
  const admin = await principalFor("admin");
  const d1 = localD1(database);
  const service = new D1CountyStructureAdministration(d1, sequentialId);
  try {
    await callback({ database, d1, service, owner, admin });
  } finally {
    database.close();
  }
}

export const ADAMS = ["08001", "Adams"];
export const ALAMOSA = ["08003", "Alamosa"];

/**
 * One CSV row. Keys: county, id, name, parent, l1, l2, l3, type, aliases, rel,
 * evidence, sources, from, until, order, status.
 */
export function row(county, fields = {}) {
  const [code, name] = county;
  return [
    code,
    name,
    fields.id ?? "",
    fields.name ?? "",
    fields.parent ?? "",
    fields.l1 ?? "",
    fields.l2 ?? "",
    fields.l3 ?? "",
    fields.type ?? "",
    fields.aliases ?? "",
    fields.rel ?? "",
    fields.evidence ?? "",
    fields.sources ?? "",
    fields.from ?? "",
    fields.until ?? "",
    fields.order ?? "",
    fields.status ?? "",
  ];
}

export const csv = (rows) => writeCsvTable(rows);

/** A realistic synthetic county: Sheriff's Office is its own top-level unit. */
export function adamsRows() {
  return [
    row(ADAMS, {
      id: "adams-eo",
      name: "Elected Official",
      type: "display_group",
      l1: "Elected Official",
      order: "1",
    }),
    row(ADAMS, {
      id: "adams-assessor",
      name: "Assessor",
      parent: "adams-eo",
      type: "office",
      l1: "Elected Official",
      l2: "Assessor",
      order: "1",
      rel: "display_group",
    }),
    row(ADAMS, {
      id: "adams-clerk",
      name: "Clerk & Recorder",
      parent: "adams-eo",
      type: "office",
      l1: "Elected Official",
      l2: "Clerk & Recorder",
      order: "2",
      rel: "display_group",
      aliases: '["Clerk and Recorder","C&R"]',
    }),
    row(ADAMS, {
      id: "adams-sheriff",
      name: "Sheriff's Office",
      type: "office",
      l1: "Sheriff's Office",
      order: "2",
      aliases: '[{"name":"Adams Sheriff","kind":"historical"}]',
      evidence:
        'Synthetic evidence, line one.\nLine two, with "quotes" and a comma.',
      sources: "https://example.invalid/sheriff",
    }),
    row(ADAMS, {
      id: "adams-patrol",
      name: "Patrol Division",
      parent: "adams-sheriff",
      type: "division",
      l1: "Sheriff's Office",
      l2: "Patrol Division",
      rel: "part_of",
      order: "1",
    }),
    row(ADAMS, {
      id: "adams-detention",
      name: "Detention Division",
      parent: "adams-sheriff",
      type: "division",
      l1: "Sheriff's Office",
      l2: "Detention Division",
      rel: "part_of",
      order: "2",
    }),
    row(ADAMS, {
      id: "adams-works",
      name: "Public Works",
      type: "department",
      l1: "Public Works",
      order: "3",
    }),
    row(ADAMS, {
      id: "adams-roads",
      name: "Road & Bridge",
      parent: "adams-works",
      type: "division",
      l1: "Public Works",
      l2: "Road & Bridge",
      rel: "reports_to",
    }),
  ];
}

export function addPerson(
  database,
  { personId = "p-sheriff", roleId = "r-sheriff", county = "08001" } = {},
) {
  database.exec(`
    INSERT OR IGNORE INTO role_sources (id, url, title, source_type) VALUES ('s-1', 'https://example.invalid/source', 'Synthetic source', 'official_page');
    INSERT INTO people (id, display_name) VALUES ('${personId}', 'Synthetic Sheriff');
    INSERT INTO person_roles (id, person_id, source_id, source_checked_at, county_fips, published_title)
      VALUES ('${roleId}', '${personId}', 's-1', '2026-11-01T00:00:00Z', '${county}', 'Sheriff');
  `);
  return roleId;
}

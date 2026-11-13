// Applies the generated migrations in journal order to a local SQLite database.
// Used by tests and local development. The hosted database is migrated by the platform
// from the same files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeSqliteDb } from "./node-sqlite.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

interface Journal {
  entries: { idx: number; tag: string }[];
}

export function migrationTags(dir = MIGRATIONS_DIR): string[] {
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

export function applyMigrations(db: NodeSqliteDb, dir = MIGRATIONS_DIR): string[] {
  const tags = migrationTags(dir);
  for (const tag of tags) {
    const sql = readFileSync(join(dir, `${tag}.sql`), "utf8");
    db.raw.exec("BEGIN");
    try {
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) db.raw.exec(statement);
      }
      db.raw.exec("COMMIT");
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw new Error(`Migration ${tag} failed`, { cause: error });
    }
  }
  return tags;
}

// A stable text dump of every table, index and other schema object, for comparing rebuilds.
export function schemaDump(db: NodeSqliteDb): string {
  const rows = db.raw
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  return rows.map((r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql ?? ""}`).join("\n");
}

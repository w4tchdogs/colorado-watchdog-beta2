import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebsiteDatabase } from "./sqlite.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../website/migrations/", import.meta.url),
);
const MIGRATION_NAME = /^(\d{4})_[a-z][a-z0-9_]*\.sql$/;
const HISTORY_SCHEMA = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (
      length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT;
`;

export function loadWebsiteMigrations(
  directory = MIGRATIONS_DIRECTORY,
): Migration[] {
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql"));
  const migrations = files.map((name) => {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      throw new Error(`Invalid migration filename: ${name}`);
    }

    return {
      version: Number(match[1]),
      name,
      sql: readFileSync(join(directory, name), "utf8"),
    };
  });

  return migrations.sort((left, right) => left.version - right.version);
}

export function migrateWebsiteDatabase(
  database: WebsiteDatabase,
  migrations = loadWebsiteMigrations(),
): void {
  validateMigrationSet(migrations);
  if (database.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("Foreign keys must be enabled before migrations");
  }

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  let hasHistory = tables.some((table) => table.name === "schema_migrations");
  const applicationTables = tables.filter(
    (table) => table.name !== "schema_migrations",
  );

  if (!hasHistory && applicationTables.length > 0) {
    throw new Error("Refusing to adopt an unmanaged database");
  }

  const applied = hasHistory
    ? readMigrationHistory(database, applicationTables.length)
    : [];
  if (applied.length > migrations.length) {
    throw new Error("Database has migration versions unknown to this checkout");
  }

  for (let index = 0; index < applied.length; index += 1) {
    const record = applied[index];
    const migration = migrations[index];
    if (!record || !migration || record.version !== migration.version) {
      throw new Error("Migration history is noncontiguous or unknown");
    }
    if (record.name !== migration.name) {
      throw new Error(
        `Applied migration name changed at version ${record.version}`,
      );
    }
    if (record.sha256 !== checksum(migration.sql)) {
      throw new Error(`Applied migration changed: ${migration.name}`);
    }
  }

  for (const migration of migrations.slice(applied.length)) {
    const apply = database.transaction(() => {
      if (!hasHistory) {
        database.exec(HISTORY_SCHEMA);
      }
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, sha256) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum(migration.sql));
      database.exec(migration.sql);
    });

    apply();
    hasHistory = true;
  }

  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length > 0) {
    throw new Error("Foreign-key violations found after migration");
  }
}

function validateMigrationSet(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new Error("No Website migrations found");
  }

  migrations.forEach((migration, index) => {
    const match = MIGRATION_NAME.exec(migration.name);
    if (
      !match ||
      Number(match[1]) !== migration.version ||
      migration.version !== index + 1
    ) {
      throw new Error(
        "Website migration versions must be contiguous from 0001",
      );
    }
  });
}

function readMigrationHistory(
  database: WebsiteDatabase,
  applicationTableCount: number,
): MigrationRecord[] {
  const tableColumns = database.pragma("table_info(schema_migrations)") as {
    name: string;
  }[];
  const columns = tableColumns.map((column) => column.name);
  if (
    columns.length !== 3 ||
    columns[0] !== "version" ||
    columns[1] !== "name" ||
    columns[2] !== "sha256"
  ) {
    throw new Error("Incompatible Website migration history schema");
  }

  const rows = database
    .prepare(
      "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
    )
    .all();
  const records = rows.map(parseMigrationRecord);
  if (records.length === 0 && applicationTableCount > 0) {
    throw new Error(
      "Website migration history is empty for a nonempty database",
    );
  }

  records.forEach((record, index) => {
    if (record.version !== index + 1) {
      throw new Error("Website migration history is noncontiguous");
    }
  });
  return records;
}

function parseMigrationRecord(row: Record<string, unknown>): MigrationRecord {
  if (
    typeof row.version !== "number" ||
    typeof row.name !== "string" ||
    typeof row.sha256 !== "string"
  ) {
    throw new Error("Incompatible Website migration history record");
  }
  return {
    version: row.version,
    name: row.name,
    sha256: row.sha256,
  };
}

function checksum(sql: string): string {
  const normalized = sql.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

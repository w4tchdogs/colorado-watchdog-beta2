import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../database/migrations.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

// SQLite application_id for private Website draft preview databases.
const DRAFT_PREVIEW_ID = 0x43575056;

export function openDraftPreviewDatabase(directory: string): WebsiteDatabase {
  const folder = resolve(directory);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const filename = join(folder, "website-draft.sqlite");
  let created = false;
  try {
    closeSync(openSync(filename, "wx", 0o600));
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!created) {
    const existing = new DatabaseSync(filename, { readOnly: true });
    try {
      const marker = existing.prepare("PRAGMA application_id").get();
      if (marker?.application_id !== DRAFT_PREVIEW_ID)
        throw new Error(
          "This SQLite file is not a Website draft preview. Choose a separate directory.",
        );
    } finally {
      existing.close();
    }
  }

  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (created) database.exec(`PRAGMA application_id = ${DRAFT_PREVIEW_ID}`);
  } catch (error) {
    database.close();
    throw error;
  }
  const draftDatabase: WebsiteDatabase = {
    close: () => database.close(),
    exec: (sql) => database.exec(sql),
    pragma(sql, options) {
      const rows = database.prepare(`PRAGMA ${sql}`).all();
      return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: (...parameters) => statement.all(...parameters),
        get: (...parameters) => statement.get(...parameters),
        run: (...parameters) => {
          statement.run(...parameters);
        },
      };
    },
    transaction(callback) {
      return () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = callback();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      };
    },
  };
  try {
    const migrations = loadWebsiteMigrations().map((migration) => {
      if (migration.name !== "0023_sync_batch_result_size.sql")
        return migration;
      // The hosted check fits receipts into D1's row size limit. Native
      // SQLite can store the full receipt for the local workbook limits.
      const hostedLimit = "length(result_json) <= 1900000";
      if (!migration.sql.includes(hostedLimit))
        throw new Error(
          "The Website receipt limit changed. Review draft compatibility.",
        );
      return {
        ...migration,
        sql: migration.sql.replace(
          hostedLimit,
          "length(result_json) <= 64000000",
        ),
      };
    });
    migrateWebsiteDatabase(draftDatabase, migrations);
  } catch (error) {
    draftDatabase.close();
    throw error;
  }
  return draftDatabase;
}

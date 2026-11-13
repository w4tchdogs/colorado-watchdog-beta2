import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import initSqlJs from "sql.js";

type SqlJsDatabase = initSqlJs.Database;
type SqlValue = initSqlJs.SqlValue;
type Row = Record<string, unknown>;

export interface WebsiteStatement {
  all(...parameters: SqlValue[]): Row[];
  get(...parameters: SqlValue[]): Row | undefined;
  run(...parameters: SqlValue[]): void;
}

export interface WebsiteDatabase {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): WebsiteStatement;
  transaction<T>(callback: () => T): () => T;
}

const require = createRequire(import.meta.url);
const sqlJsDirectory = dirname(require.resolve("sql.js"));

class LocalStatement implements WebsiteStatement {
  constructor(
    private readonly database: SqlJsDatabase,
    private readonly sql: string,
  ) {}

  all(...parameters: SqlValue[]): Row[] {
    const statement = this.database.prepare(this.sql);
    try {
      if (parameters.length > 0) {
        statement.bind(parameters);
      }
      const rows: Row[] = [];
      while (statement.step()) {
        rows.push({ ...statement.getAsObject() });
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  get(...parameters: SqlValue[]): Row | undefined {
    const statement = this.database.prepare(this.sql);
    try {
      if (parameters.length > 0) {
        statement.bind(parameters);
      }
      return statement.step() ? { ...statement.getAsObject() } : undefined;
    } finally {
      statement.free();
    }
  }

  run(...parameters: SqlValue[]): void {
    this.database.run(this.sql, parameters);
  }
}

class LocalDatabase implements WebsiteDatabase {
  constructor(
    private readonly database: SqlJsDatabase,
    private readonly filename: string,
  ) {}

  close(): void {
    if (this.filename !== ":memory:") {
      writeFileSync(this.filename, this.database.export());
    }
    this.database.close();
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const rows = new LocalStatement(this.database, `PRAGMA ${sql}`).all();
    return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }

  prepare(sql: string): WebsiteStatement {
    return new LocalStatement(this.database, sql);
  }

  transaction<T>(callback: () => T): () => T {
    return () => {
      this.database.run("BEGIN IMMEDIATE");
      try {
        const result = callback();
        this.database.run("COMMIT");
        return result;
      } catch (error) {
        this.database.run("ROLLBACK");
        throw error;
      }
    };
  }
}

export async function openWebsiteDatabase(
  filename = ":memory:",
): Promise<WebsiteDatabase> {
  const SqlJs = await initSqlJs({
    locateFile: (file) => join(sqlJsDirectory, file),
  });
  const data =
    filename === ":memory:" || !existsSync(filename)
      ? undefined
      : readFileSync(filename);
  const database = new SqlJs.Database(data);
  database.run("PRAGMA foreign_keys = ON");

  const version = database.exec("SELECT sqlite_version() AS version")[0]
    ?.values[0]?.[0];
  if (typeof version !== "string" || !supportsStrictTables(version)) {
    database.close();
    throw new Error("SQLite 3.37 or newer is required");
  }

  return new LocalDatabase(database, filename);
}

function supportsStrictTables(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 37);
}

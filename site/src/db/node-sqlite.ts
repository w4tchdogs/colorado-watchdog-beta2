// Local development and test adapter. D1 is SQLite, so this exercises the same SQL.
// Never imported by the Worker entry point.
import { DatabaseSync } from "node:sqlite";
import type { Db, Row, SqlValue, Statement, WriteResult } from "./client.ts";

export interface NodeSqliteDb extends Db {
  readonly raw: DatabaseSync;
  close(): void;
}

export function nodeSqliteDb(location = ":memory:"): NodeSqliteDb {
  const raw = new DatabaseSync(location);
  raw.exec("PRAGMA foreign_keys = ON");
  const run = (sql: string, params: readonly SqlValue[] = []): WriteResult => ({
    changes: Number(raw.prepare(sql).run(...params).changes),
  });
  return {
    raw,
    close: () => raw.close(),
    async all<T extends Row>(sql: string, params: readonly SqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async first<T extends Row>(sql: string, params: readonly SqlValue[] = []) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, params?: readonly SqlValue[]) {
      return run(sql, params);
    },
    async batch(statements: readonly Statement[]) {
      raw.exec("BEGIN");
      try {
        const results = statements.map((s) => run(s.sql, s.params));
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

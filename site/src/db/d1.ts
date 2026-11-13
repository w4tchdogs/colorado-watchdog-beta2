import type { Db, Row, SqlValue, Statement, WriteResult } from "./client.ts";

// Structural subset of the Cloudflare D1 binding. Declared here so the app has no
// dependency on platform type packages.
interface D1Result<T> {
  results: T[];
  meta: { changes: number };
}
interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement;
  all<T>(): Promise<D1Result<T>>;
  run<T>(): Promise<D1Result<T>>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export function d1Db(database: D1DatabaseLike): Db {
  const prepare = (sql: string, params: readonly SqlValue[] = []) =>
    database.prepare(sql).bind(...params);
  return {
    async all<T extends Row>(sql: string, params?: readonly SqlValue[]) {
      return (await prepare(sql, params).all<T>()).results;
    },
    async first<T extends Row>(sql: string, params?: readonly SqlValue[]) {
      return (await prepare(sql, params).all<T>()).results[0] ?? null;
    },
    async run(sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
      return { changes: (await prepare(sql, params).run()).meta.changes };
    },
    async batch(statements: readonly Statement[]): Promise<WriteResult[]> {
      const results = await database.batch(statements.map((s) => prepare(s.sql, s.params)));
      return results.map((r) => ({ changes: r.meta.changes }));
    },
  };
}

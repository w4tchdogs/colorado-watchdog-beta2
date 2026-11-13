// The only database surface the service layer may use. Two adapters implement it:
// d1.ts for the hosted Worker and node-sqlite.ts for local development and tests.
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface Statement {
  sql: string;
  params?: readonly SqlValue[];
}

export interface WriteResult {
  changes: number;
}

export interface Db {
  all<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  run(sql: string, params?: readonly SqlValue[]): Promise<WriteResult>;
  // Runs every statement in one transaction. Either all apply or none do.
  batch(statements: readonly Statement[]): Promise<WriteResult[]>;
}

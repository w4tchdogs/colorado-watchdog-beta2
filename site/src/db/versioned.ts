// Row version convention. Every mutable table has an integer `version` that starts at 1.
// All updates go through updateVersioned, which requires the version the caller last read,
// raises it by exactly one, and refuses the write if the row changed in the meantime.
import type { Db, SqlValue } from "./client.ts";

export const VERSIONED_TABLES = {
  accounts: { key: "id", columns: ["role", "display_name", "email", "status", "preferences"] },
  identities: { key: "id", columns: ["label", "expires_at", "revoked_at"] },
  operations: { key: "id", columns: ["state", "result", "progress"] },
  checkpoints: { key: "id", columns: ["verified_at", "verify_result"] },
} as const;

export type VersionedTable = keyof typeof VERSIONED_TABLES;

export class StaleVersionError extends Error {
  readonly table: string;
  readonly id: string;
  constructor(table: string, id: string) {
    super(`${table} ${id} changed since it was read. Reload and retry.`);
    this.name = "StaleVersionError";
    this.table = table;
    this.id = id;
  }
}

export class NotFoundError extends Error {
  constructor(table: string, id: string) {
    super(`${table} ${id} does not exist.`);
    this.name = "NotFoundError";
  }
}

export interface VersionedUpdate {
  table: VersionedTable;
  id: string;
  expectedVersion: number;
  changes: Record<string, SqlValue>;
  now: string;
}

export async function updateVersioned(db: Db, update: VersionedUpdate): Promise<number> {
  const spec = VERSIONED_TABLES[update.table];
  const allowed: readonly string[] = spec.columns;
  const columns = Object.keys(update.changes);
  if (columns.length === 0) throw new Error("No changes supplied.");
  for (const column of columns) {
    if (!allowed.includes(column)) {
      throw new Error(`Column ${column} of ${update.table} cannot be updated.`);
    }
  }
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  const result = await db.run(
    `UPDATE ${update.table} SET ${assignments}, version = version + 1, updated_at = ? WHERE ${spec.key} = ? AND version = ?`,
    [...Object.values(update.changes), update.now, update.id, update.expectedVersion],
  );
  if (result.changes === 1) return update.expectedVersion + 1;
  const existing = await db.first(`SELECT version FROM ${update.table} WHERE ${spec.key} = ?`, [
    update.id,
  ]);
  if (!existing) throw new NotFoundError(update.table, update.id);
  throw new StaleVersionError(update.table, update.id);
}

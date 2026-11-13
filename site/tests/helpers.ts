// Synthetic fixtures only. Every account, identity and value here is invented.
import { applyMigrations } from "../src/db/migrate.ts";
import { type NodeSqliteDb, nodeSqliteDb } from "../src/db/node-sqlite.ts";
import type { ServiceContext } from "../src/services/context.ts";

export const FIXED_TIME = "2026-01-01T00:00:00.000Z";

export function freshDb(): NodeSqliteDb {
  const db = nodeSqliteDb();
  applyMigrations(db);
  return db;
}

// Deterministic clock and IDs so tests never depend on the wall clock or randomness.
export function testContext(db: NodeSqliteDb): ServiceContext {
  let counter = 0;
  return {
    db,
    now: () => FIXED_TIME,
    newId: () => `test-id-${String(++counter).padStart(4, "0")}`,
  };
}

export async function insertAccount(
  db: NodeSqliteDb,
  overrides: Partial<Record<string, string | number | null>> = {},
): Promise<string> {
  const row = {
    id: "acct-synthetic-admin",
    kind: "human",
    role: "administrator",
    display_name: "Synthetic Administrator",
    email: "admin@example.invalid",
    status: "active",
    preferences: "{}",
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    ...overrides,
  };
  const columns = Object.keys(row);
  await db.run(
    `INSERT INTO accounts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
  return String(row.id);
}

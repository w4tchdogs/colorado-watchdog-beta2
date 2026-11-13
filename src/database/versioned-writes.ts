import type { WebsiteDatabase } from "./sqlite.js";

const MUTABLE_COLUMNS = {
  accounts: ["display_name", "email", "role", "status", "preferences"],
  identities: ["expires_at", "revoked_at"],
  operations: [
    "status",
    "progress_json",
    "started_at",
    "finished_at",
    "error_code",
  ],
  checkpoints: [
    "application_commit",
    "manifest_json",
    "manifest_sha256",
    "verification_status",
    "verification_json",
    "verified_at",
  ],
} as const;

export type VersionedTable = keyof typeof MUTABLE_COLUMNS;
export type VersionedValue = string | number | null;

export class StaleVersionError extends Error {
  constructor() {
    super("The row changed since it was read");
    this.name = "StaleVersionError";
  }
}

export function updateVersionedRow(
  database: WebsiteDatabase,
  table: VersionedTable,
  id: string,
  expectedVersion: number,
  changes: Readonly<Record<string, VersionedValue>>,
): number {
  if (!Object.hasOwn(MUTABLE_COLUMNS, table)) {
    throw new Error("Unsupported versioned table");
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("Expected version must be a positive integer");
  }
  if (!id.trim()) {
    throw new Error("Row ID must not be blank");
  }

  const entries = Object.entries(changes).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const allowed = MUTABLE_COLUMNS[table] as readonly string[];
  if (
    entries.length === 0 ||
    entries.some(([column]) => !allowed.includes(column))
  ) {
    throw new Error(
      "Versioned update contains no changes or an unsupported field",
    );
  }

  const assignments = entries
    .map(([column]) => `"${column}" = ?`)
    .concat([
      '"version" = "version" + 1',
      "\"updated_at\" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ])
    .join(", ");
  const statement = database.prepare(
    `UPDATE "${table}" SET ${assignments} WHERE "id" = ? AND "version" = ? RETURNING "version"`,
  );
  const row = statement.get(
    ...entries.map(([, value]) => value),
    id,
    expectedVersion,
  ) as { version: number } | undefined;

  if (!row) {
    throw new StaleVersionError();
  }
  return row.version;
}

import type {
  CheckpointColumn,
  CheckpointLimits,
  CheckpointMigrationRecord,
} from "../../contracts/checkpoints.js";
import type { WebsiteDatabase } from "../../database/sqlite.js";
import {
  bundleDefect,
  type CheckpointCell,
  CheckpointError,
  canonicalJson,
  compareLines,
  encodeRowLine,
  quoteIdentifier,
  SHA256_PATTERN,
  tableMemberPath,
} from "./core.js";

export type SchemaObjectType = "index" | "table" | "trigger" | "view";

export interface SchemaObject {
  readonly type: SchemaObjectType;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

export interface SchemaDocument {
  readonly user_version: number;
  readonly objects: readonly SchemaObject[];
}

export interface TableSnapshot {
  readonly name: string;
  readonly member: string;
  readonly columns: readonly CheckpointColumn[];
  readonly rows: number;
  /** Canonical JSON lines, sorted, each terminated by a newline. */
  readonly text: string;
}

export interface DatabaseSnapshot {
  readonly schemaJson: string;
  readonly migrations: readonly CheckpointMigrationRecord[];
  readonly tables: readonly TableSnapshot[];
}

export interface RestoreTable {
  readonly name: string;
  readonly columns: readonly CheckpointColumn[];
  readonly rows: readonly (readonly CheckpointCell[])[];
}

const OBJECT_TYPES = ["index", "table", "trigger", "view"] as const;
const CREATE_PREFIX: Record<SchemaObjectType, RegExp> = {
  index: /^CREATE (UNIQUE )?INDEX /i,
  table: /^CREATE TABLE /i,
  trigger: /^CREATE TRIGGER /i,
  view: /^CREATE VIEW /i,
};
// SQLite reserves the sqlite_ prefix for engine-internal objects. Only the
// AUTOINCREMENT counter table carries state a restore needs.
const CAPTURED_ENGINE_TABLES = new Set(["sqlite_sequence"]);

function isEngineInternal(name: string): boolean {
  return name.toLowerCase().startsWith("sqlite_");
}

/**
 * Captures schema, migration history and every table in one synchronous
 * SQLite transaction. The adapter is single-connection and synchronous, so no
 * other statement can run between the first and last read. Calling this inside
 * an open transaction fails rather than capturing uncommitted state.
 */
export function captureDatabaseSnapshot(
  database: WebsiteDatabase,
  limits: CheckpointLimits,
): DatabaseSnapshot {
  const capture = database.transaction(() => {
    const changesBefore = totalChanges(database);
    const schema = readSchemaDocument(database);
    const tableNames = listExportableTables(database, schema);
    if (tableNames.length > limits.maxTables) {
      throw new CheckpointError("limit_exceeded", "Too many tables");
    }
    const migrations = readMigrationHistory(database, tableNames);
    const schemaJson = canonicalJson(schema);
    if (Buffer.byteLength(schemaJson) > limits.maxSchemaBytes) {
      throw new CheckpointError("limit_exceeded", "Schema is too large");
    }

    const budget = { rows: 0, bytes: 0 };
    const tables = tableNames.map((name) =>
      exportTable(database, name, limits, budget),
    );
    if (totalChanges(database) !== changesBefore) {
      throw new CheckpointError(
        "snapshot_inconsistent",
        "The database changed during capture",
      );
    }
    return { schemaJson, migrations, tables };
  });
  return capture();
}

function totalChanges(database: WebsiteDatabase): number {
  const row = database.prepare("SELECT total_changes() AS changes").get();
  return Number(row?.changes ?? 0);
}

function readSchemaDocument(database: WebsiteDatabase): SchemaDocument {
  const rows = database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema")
    .all();
  const objects: SchemaObject[] = [];
  for (const row of rows) {
    const name = String(row.name);
    if (isEngineInternal(name)) {
      continue;
    }
    const type = String(row.type) as SchemaObjectType;
    if (
      !OBJECT_TYPES.includes(type) ||
      typeof row.sql !== "string" ||
      !CREATE_PREFIX[type].test(row.sql)
    ) {
      throw new CheckpointError(
        "unsupported_schema_object",
        "The database contains a schema object this format cannot restore",
        { subject: name },
      );
    }
    objects.push({ type, name, tbl_name: String(row.tbl_name), sql: row.sql });
  }
  objects.sort(
    (left, right) =>
      compareLines(left.type, right.type) ||
      compareLines(left.name, right.name),
  );
  const userVersion = database.pragma("user_version", { simple: true });
  return { user_version: Number(userVersion ?? 0), objects };
}

function listExportableTables(
  database: WebsiteDatabase,
  schema: SchemaDocument,
): string[] {
  const listed = database.pragma("table_list") as {
    schema: string;
    name: string;
    type: string;
  }[];
  const names: string[] = [];
  for (const table of listed) {
    if (table.schema !== "main" || table.type === "view") {
      continue;
    }
    if (isEngineInternal(table.name)) {
      if (CAPTURED_ENGINE_TABLES.has(table.name)) {
        names.push(table.name);
      }
      continue;
    }
    if (table.type !== "table") {
      throw new CheckpointError(
        "unsupported_schema_object",
        "Virtual and shadow tables are not supported by this format",
        { subject: table.name },
      );
    }
    names.push(table.name);
  }

  const declared = schema.objects
    .filter((object) => object.type === "table")
    .map((object) => object.name);
  const exported = new Set(names);
  if (declared.some((name) => !exported.has(name))) {
    throw new CheckpointError(
      "snapshot_inconsistent",
      "Schema and table listing disagree",
    );
  }
  return names.sort(compareLines);
}

function readMigrationHistory(
  database: WebsiteDatabase,
  tableNames: readonly string[],
): CheckpointMigrationRecord[] {
  if (!tableNames.includes("schema_migrations")) {
    throw new CheckpointError(
      "unmanaged_database",
      "The database has no Website migration history",
    );
  }
  const rows = database
    .prepare(
      "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
    )
    .all();
  const records = rows.map((row, index) => {
    if (
      row.version !== index + 1 ||
      typeof row.name !== "string" ||
      typeof row.sha256 !== "string" ||
      !SHA256_PATTERN.test(row.sha256)
    ) {
      throw new CheckpointError(
        "unmanaged_database",
        "The Website migration history is incompatible",
      );
    }
    return { version: index + 1, name: row.name, sha256: row.sha256 };
  });
  if (records.length === 0) {
    throw new CheckpointError(
      "unmanaged_database",
      "The Website migration history is empty",
    );
  }
  return records;
}

function readColumns(
  database: WebsiteDatabase,
  table: string,
): CheckpointColumn[] {
  const info = database.pragma(`table_xinfo(${quoteIdentifier(table)})`) as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
    hidden: number;
  }[];
  // Generated columns (hidden 2 and 3) are recomputed by the schema.
  const columns = info
    .filter((column) => column.hidden === 0)
    .map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull === 1,
      pk: column.pk,
    }));
  if (columns.length === 0) {
    throw new CheckpointError(
      "unsupported_schema_object",
      "Table has no exportable columns",
      { subject: table },
    );
  }
  return columns;
}

function exportTable(
  database: WebsiteDatabase,
  name: string,
  limits: CheckpointLimits,
  budget: { rows: number; bytes: number },
): TableSnapshot {
  const columns = readColumns(database, name);
  const table = quoteIdentifier(name);
  const count = database.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  budget.rows += Number(count?.n ?? 0);
  if (budget.rows > limits.maxRows) {
    throw new CheckpointError("limit_exceeded", "Too many database rows");
  }

  // Values are normalized inside SQLite so 64-bit integers and raw text bytes
  // never pass through a lossy JavaScript number or string conversion.
  const selections = columns.map((column, index) => {
    const quoted = quoteIdentifier(column.name);
    return (
      `typeof(${quoted}) AS t${index}, CASE typeof(${quoted}) ` +
      `WHEN 'null' THEN NULL WHEN 'integer' THEN CAST(${quoted} AS TEXT) ` +
      `WHEN 'real' THEN ${quoted} ` +
      `ELSE hex(CAST(${quoted} AS BLOB)) END AS v${index}`
    );
  });
  const rows = database
    .prepare(`SELECT ${selections.join(", ")} FROM ${table}`)
    .all();
  const lines = rows.map((row) => {
    const cells = columns.map((_, index) =>
      encodeCell(row[`t${index}`], row[`v${index}`], name),
    );
    const line = encodeRowLine(cells);
    budget.bytes += line.length + 1;
    if (budget.bytes > limits.maxDatabaseBytes) {
      throw new CheckpointError("limit_exceeded", "Database export too large");
    }
    return line;
  });
  // Sorting the canonical lines makes digests independent of physical order.
  lines.sort(compareLines);
  return {
    name,
    member: tableMemberPath(name),
    columns,
    rows: lines.length,
    text: lines.map((line) => `${line}\n`).join(""),
  };
}

function encodeCell(
  type: unknown,
  value: unknown,
  table: string,
): CheckpointCell {
  if (type === "null") {
    return null;
  }
  if (type === "integer" && typeof value === "string") {
    return ["i", value];
  }
  if (type === "real" && typeof value === "number" && !Number.isNaN(value)) {
    return ["r", String(value)];
  }
  if (type === "blob" && typeof value === "string") {
    return ["b", value];
  }
  if (type === "text" && typeof value === "string") {
    const bytes = Buffer.from(value, "hex");
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? ["t", text] : ["x", value];
  }
  throw new CheckpointError(
    "unsupported_value",
    "A stored value has an unsupported storage class",
    { subject: table },
  );
}

/** Parses and strictly validates the bundle's schema document. */
export function parseSchemaDocument(text: string): SchemaDocument {
  const fail = () =>
    bundleDefect("schema_malformed", "Schema document is malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail();
  }
  const document = parsed as Partial<SchemaDocument> | null;
  if (
    !document ||
    typeof document !== "object" ||
    !Number.isSafeInteger(document.user_version) ||
    !Array.isArray(document.objects)
  ) {
    throw fail();
  }
  for (const object of document.objects as Partial<SchemaObject>[]) {
    const type = object?.type as SchemaObjectType;
    if (
      !OBJECT_TYPES.includes(type) ||
      typeof object.name !== "string" ||
      typeof object.tbl_name !== "string" ||
      typeof object.sql !== "string" ||
      isEngineInternal(object.name) ||
      !CREATE_PREFIX[type].test(object.sql)
    ) {
      throw fail();
    }
  }
  if (canonicalJson(document) !== text) {
    throw fail();
  }
  return document as SchemaDocument;
}

/**
 * Rebuilds a snapshot in an empty scratch database: tables, then rows with
 * foreign keys deferred, then indexes, triggers and views. Each schema entry
 * is prepared as a single statement, so trailing SQL in an entry never runs.
 * The caller checks integrity afterwards. Never call this on a live database.
 */
export function restoreDatabaseSnapshot(
  database: WebsiteDatabase,
  schema: SchemaDocument,
  tables: readonly RestoreTable[],
): void {
  const existing = database
    .prepare("SELECT count(*) AS n FROM sqlite_schema")
    .get();
  if (Number(existing?.n ?? 1) !== 0) {
    throw new CheckpointError(
      "scratch_not_empty",
      "Restore requires an empty scratch database",
    );
  }

  database.exec("PRAGMA foreign_keys = OFF");
  const restore = database.transaction(() => {
    const create = (type: SchemaObjectType) => {
      for (const object of schema.objects) {
        if (object.type === type) {
          database.prepare(object.sql).run();
        }
      }
    };
    create("table");
    const ordered = [...tables].sort(
      (left, right) =>
        Number(CAPTURED_ENGINE_TABLES.has(left.name)) -
        Number(CAPTURED_ENGINE_TABLES.has(right.name)),
    );
    for (const table of ordered) {
      if (CAPTURED_ENGINE_TABLES.has(table.name)) {
        database.prepare(`DELETE FROM ${quoteIdentifier(table.name)}`).run();
      }
      insertRows(database, table);
    }
    create("index");
    create("trigger");
    create("view");
  });
  restore();
  database.exec(`PRAGMA user_version = ${Math.trunc(schema.user_version)}`);
  database.exec("PRAGMA foreign_keys = ON");
}

function insertRows(database: WebsiteDatabase, table: RestoreTable): void {
  const columns = table.columns
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  const prefix = `INSERT INTO ${quoteIdentifier(table.name)} (${columns}) VALUES `;
  for (const row of table.rows) {
    const placeholders: string[] = [];
    const parameters: (string | number | Uint8Array)[] = [];
    for (const cell of row) {
      if (cell === null) {
        placeholders.push("NULL");
        continue;
      }
      const [tag, text] = cell;
      if (tag === "i") {
        placeholders.push("CAST(? AS INTEGER)");
        parameters.push(text);
      } else if (tag === "r") {
        placeholders.push("CAST(? AS REAL)");
        parameters.push(Number(text));
      } else if (tag === "t") {
        placeholders.push("?");
        parameters.push(text);
      } else if (text.length === 0) {
        placeholders.push(tag === "b" ? "x''" : "''");
      } else {
        placeholders.push(tag === "b" ? "?" : "CAST(? AS TEXT)");
        parameters.push(Buffer.from(text, "hex"));
      }
    }
    database
      .prepare(`${prefix}(${placeholders.join(", ")})`)
      .run(...parameters);
  }
}

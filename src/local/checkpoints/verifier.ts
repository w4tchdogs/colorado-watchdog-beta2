import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BundleReader,
  CHECKPOINT_FORMAT,
  CHECKPOINT_FORMAT_VERSION,
  type CheckpointLimits,
  type CheckpointManifest,
  type CheckpointMigrationRecord,
  type CheckpointTable,
  type VerificationFailure,
  type VerificationReport,
} from "../../contracts/checkpoints.js";
import {
  loadWebsiteMigrations,
  type Migration,
  migrationChecksum,
} from "../../database/migrations.js";
import {
  openWebsiteDatabase,
  type WebsiteDatabase,
} from "../../database/sqlite.js";
import {
  assertApplicationCommit,
  assertCheckpointId,
  assertFileKey,
  bundleDefect,
  CheckpointError,
  canonicalJson,
  compareLines,
  DEFAULT_CHECKPOINT_LIMITS,
  decodeRowLine,
  fileMemberPath,
  foldKey,
  SHA256_PATTERN,
  sanitizeDiagnostic,
  sha256Hex,
  tableMemberPath,
} from "./core.js";
import {
  captureDatabaseSnapshot,
  parseSchemaDocument,
  type RestoreTable,
  restoreDatabaseSnapshot,
  type SchemaDocument,
} from "./database-snapshot.js";
import { LocalFileStore } from "./file-store.js";

export interface VerifyOptions {
  /** Digest recorded when the checkpoint was produced, when one exists. */
  readonly expectedManifestSha256?: string;
  readonly knownMigrations?: readonly CheckpointMigrationRecord[];
  readonly scratchRoot?: string;
  readonly limits?: Partial<CheckpointLimits>;
  readonly openScratchDatabase?: () => Promise<WebsiteDatabase>;
}

export interface VerificationOutcome {
  readonly report: VerificationReport;
  readonly manifest: CheckpointManifest | null;
  readonly manifestJson: string | null;
}

export function knownMigrationRecords(
  migrations: readonly Migration[] = loadWebsiteMigrations(),
): CheckpointMigrationRecord[] {
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    sha256: migrationChecksum(migration.sql),
  }));
}

class FailureLog {
  readonly failures: VerificationFailure[] = [];
  truncated = false;

  constructor(private readonly max: number) {}

  get empty(): boolean {
    return this.failures.length === 0 && !this.truncated;
  }

  add(code: string, subject: string, detail: string): void {
    if (this.failures.length >= this.max) {
      this.truncated = true;
      return;
    }
    this.failures.push({
      code,
      subject: sanitizeDiagnostic(subject, 120),
      detail: sanitizeDiagnostic(detail),
    });
  }

  /** Records bundle defects. Any other error is not a verdict and rethrows. */
  capture(error: unknown): void {
    if (error instanceof CheckpointError && error.bundleDefect) {
      this.add(error.code, error.subject, error.message);
      return;
    }
    throw error;
  }
}

/**
 * Verifies a published bundle by restoring it into a scratch database and a
 * scratch directory and comparing the result with the manifest.
 *
 * `report.ok` is true only after the full restore and comparison. Defects in
 * the bundle produce a failed report. Environmental errors (for example a
 * scratch disk failure) throw instead, so an interrupted verification is
 * never recorded as a verdict. The source bundle, the live database and live
 * file storage are only read, never written.
 */
export async function verifyCheckpointBundle(
  reader: BundleReader,
  options: VerifyOptions = {},
): Promise<VerificationOutcome> {
  const limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...options.limits };
  const startedAt = new Date().toISOString();
  const log = new FailureLog(limits.maxFailures);
  const restored = { tables: 0, rows: 0, files: 0, file_bytes: 0 };
  let manifest: CheckpointManifest | null = null;
  let manifestJson: string | null = null;
  let manifestSha256: string | null = null;

  try {
    const bytes = await reader.read("manifest.json", limits.maxManifestBytes);
    manifestSha256 = sha256Hex(bytes);
    if (
      options.expectedManifestSha256 !== undefined &&
      options.expectedManifestSha256 !== manifestSha256
    ) {
      throw bundleDefect(
        "manifest_digest_mismatch",
        "Manifest differs from the digest recorded at production",
        "manifest.json",
      );
    }
    manifestJson = decodeUtf8(bytes, "manifest.json");
    manifest = parseManifest(manifestJson);
    if (manifest.checkpoint_id !== reader.id) {
      throw bundleDefect(
        "manifest_malformed",
        "Manifest names a different checkpoint",
        "manifest.json",
      );
    }

    checkMigrations(
      manifest,
      options.knownMigrations ?? knownMigrationRecords(),
      log,
    );
    const database = await checkMembers(reader, manifest, limits, log);
    if (log.empty && database) {
      await restoreDatabase(manifest, database, options, limits, log, restored);
    }
    if (log.empty) {
      await restoreFiles(reader, manifest, options, limits, log, restored);
    }
  } catch (error) {
    log.capture(error);
  }

  return {
    report: {
      format_version: CHECKPOINT_FORMAT_VERSION,
      checkpoint_id: reader.id,
      ok: log.empty,
      manifest_sha256: manifestSha256,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      restored,
      failures: log.failures,
      failures_truncated: log.truncated,
    },
    manifest,
    manifestJson,
  };
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw bundleDefect("member_malformed", "Member is not UTF-8", subject);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Strict structural validation. Unknown or missing fields are rejected. */
export function parseManifest(text: string): CheckpointManifest {
  const fail = (reason: string) =>
    bundleDefect(
      "manifest_malformed",
      `Manifest is malformed: ${reason}`,
      "manifest.json",
    );
  const require = (condition: boolean, reason: string) => {
    if (!condition) {
      throw fail(reason);
    }
  };
  const shape = (value: unknown, keys: readonly string[], name: string) => {
    require(isRecord(value), `${name} is not an object`);
    const record = value as Record<string, unknown>;
    const actual = Object.keys(record).sort();
    require(actual.length === keys.length &&
      actual.every((k, i) => k === keys[i]), `${name} has unexpected fields`);
    return record;
  };
  const member = (value: Record<string, unknown>, name: string) => {
    require(isCount(value.bytes), `${name} size`);
    require(typeof value.sha256 === "string" &&
      SHA256_PATTERN.test(value.sha256), `${name} digest`);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("not valid JSON");
  }
  try {
    const root = shape(
      parsed,
      [
        "application",
        "checkpoint_id",
        "created_at",
        "database",
        "files",
        "format",
        "format_version",
        "totals",
      ],
      "manifest",
    );
    require(root.format === CHECKPOINT_FORMAT, "format");
    if (root.format_version !== CHECKPOINT_FORMAT_VERSION) {
      throw bundleDefect(
        "unsupported_format_version",
        "Manifest format version is not supported",
        "manifest.json",
      );
    }
    assertCheckpointId(root.checkpoint_id as string);
    const created = root.created_at;
    require(typeof created === "string" &&
      !Number.isNaN(Date.parse(created)) &&
      new Date(created).toISOString() === created, "created_at");
    const application = shape(root.application, ["commit"], "application");
    assertApplicationCommit(application.commit as string);

    const database = shape(
      root.database,
      ["migration_version", "migrations", "schema", "tables"],
      "database",
    );
    require(Array.isArray(database.migrations), "migrations");
    const migrations = database.migrations as unknown[];
    migrations.forEach((value, index) => {
      const record = shape(value, ["name", "sha256", "version"], "migration");
      require(record.version === index + 1, "migration order");
      require(typeof record.name === "string" &&
        record.name.length > 0 &&
        record.name.length <= 200, "migration name");
      require(typeof record.sha256 === "string" &&
        SHA256_PATTERN.test(record.sha256), "migration digest");
    });
    require(migrations.length > 0 &&
      database.migration_version === migrations.length, "migration version");
    const schema = shape(
      database.schema,
      ["bytes", "member", "sha256"],
      "schema",
    );
    require(schema.member === "db/schema.json", "schema member");
    member(schema, "schema");

    require(Array.isArray(database.tables), "tables");
    let rows = 0;
    let previousTable: string | null = null;
    for (const value of database.tables as unknown[]) {
      const table = shape(
        value,
        ["bytes", "columns", "member", "name", "rows", "sha256"],
        "table",
      );
      const name = table.name;
      require(typeof name === "string" &&
        name.length > 0 &&
        name.length <= 256, "table name");
      require(previousTable === null ||
        compareLines(previousTable, name as string) < 0, "table order");
      previousTable = name as string;
      require(table.member === tableMemberPath(name as string), "table member");
      member(table, "table");
      require(isCount(table.rows), "table rows");
      rows += table.rows as number;
      require(Array.isArray(table.columns) &&
        table.columns.length > 0, "table columns");
      for (const column of table.columns as unknown[]) {
        const record = shape(
          column,
          ["name", "notnull", "pk", "type"],
          "column",
        );
        require(typeof record.name === "string" &&
          typeof record.type === "string" &&
          typeof record.notnull === "boolean" &&
          isCount(record.pk), "column fields");
      }
    }

    require(Array.isArray(root.files), "files");
    let fileBytes = 0;
    let previousKey: string | null = null;
    const folded = new Set<string>();
    const sizes = new Map<string, number>();
    for (const value of root.files as unknown[]) {
      const file = shape(value, ["key", "sha256", "size"], "file");
      assertFileKey(file.key as string);
      const key = file.key as string;
      require(previousKey === null ||
        compareLines(previousKey, key) < 0, "file order");
      previousKey = key;
      require(!folded.has(foldKey(key)), "duplicate file key");
      folded.add(foldKey(key));
      require(isCount(file.size), "file size");
      const digest = file.sha256;
      require(typeof digest === "string" &&
        SHA256_PATTERN.test(digest), "file digest");
      const size = file.size as number;
      require((sizes.get(digest as string) ?? size) ===
        size, "file digest reused with a different size");
      sizes.set(digest as string, size);
      fileBytes += size;
    }

    const totals = shape(
      root.totals,
      ["file_bytes", "files", "rows", "tables"],
      "totals",
    );
    require(totals.tables === (database.tables as unknown[]).length &&
      totals.rows === rows &&
      totals.files === (root.files as unknown[]).length &&
      totals.file_bytes === fileBytes, "totals");
    require(canonicalJson(parsed) === text, "not canonical");
  } catch (error) {
    if (error instanceof CheckpointError && error.bundleDefect) {
      throw error;
    }
    throw fail("invalid field");
  }
  return parsed as CheckpointManifest;
}

function checkMigrations(
  manifest: CheckpointManifest,
  known: readonly CheckpointMigrationRecord[],
  log: FailureLog,
): void {
  for (const [index, record] of manifest.database.migrations.entries()) {
    const expected = known[index];
    if (!expected) {
      log.add(
        "unknown_migration_version",
        `migration ${record.version}`,
        "Checkpoint uses a migration version unknown to this application",
      );
      return;
    }
    if (expected.name !== record.name || expected.sha256 !== record.sha256) {
      log.add(
        "migration_mismatch",
        `migration ${record.version}`,
        "Checkpoint migration differs from this application's migration",
      );
      return;
    }
  }
}

interface ParsedDatabase {
  readonly schema: SchemaDocument;
  readonly tables: readonly RestoreTable[];
}

/** Checks the member set, sizes and digests, and parses database members. */
async function checkMembers(
  reader: BundleReader,
  manifest: CheckpointManifest,
  limits: CheckpointLimits,
  log: FailureLog,
): Promise<ParsedDatabase | null> {
  const { schema, tables } = manifest.database;
  const expected = new Map<string, { bytes: number; label: string }>();
  expected.set(schema.member, { bytes: schema.bytes, label: "Schema" });
  for (const table of tables) {
    expected.set(table.member, {
      bytes: table.bytes,
      label: `Table ${table.name}`,
    });
  }
  for (const file of manifest.files) {
    const path = fileMemberPath(file.sha256);
    const label = expected.get(path)?.label ?? `File ${file.key}`;
    expected.set(path, { bytes: file.size, label });
  }
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join("/"));
    }
  }

  const present = new Set<string>();
  const unreadable = new Set<string>();
  for (const entry of await reader.entries(limits.maxMembers)) {
    if (entry.path === "manifest.json" && entry.kind === "file") {
      continue;
    }
    const known = entry.kind === "file" ? expected.get(entry.path) : undefined;
    if (entry.kind === "directory" && directories.has(entry.path)) {
      continue;
    }
    if (!known) {
      log.add("member_unexpected", entry.path, "Unexpected bundle member");
      continue;
    }
    present.add(entry.path);
    if (entry.size !== known.bytes) {
      unreadable.add(entry.path);
      log.add(
        "member_size_mismatch",
        entry.path,
        `${known.label} size differs from the manifest`,
      );
    }
  }
  for (const [path, known] of expected) {
    if (!present.has(path)) {
      unreadable.add(path);
      log.add("member_missing", path, `${known.label} is missing`);
    }
  }

  const readVerified = async (path: string, sha256: string) => {
    const known = expected.get(path);
    if (!known || unreadable.has(path)) {
      return null;
    }
    const bytes = await reader.read(path, known.bytes);
    if (sha256Hex(bytes) !== sha256) {
      log.add(
        "member_digest_mismatch",
        path,
        `${known.label} content differs from the manifest`,
      );
      return null;
    }
    return bytes;
  };

  let schemaDocument: SchemaDocument | null = null;
  const restoreTables: RestoreTable[] = [];
  try {
    const bytes = await readVerified(schema.member, schema.sha256);
    if (bytes) {
      schemaDocument = parseSchemaDocument(decodeUtf8(bytes, schema.member));
    }
  } catch (error) {
    log.capture(error);
  }
  for (const table of tables) {
    try {
      const bytes = await readVerified(table.member, table.sha256);
      if (bytes) {
        restoreTables.push(parseTable(table, bytes));
      }
    } catch (error) {
      log.capture(error);
    }
  }
  const checkedFiles = new Set<string>();
  for (const file of manifest.files) {
    if (!checkedFiles.has(file.sha256)) {
      checkedFiles.add(file.sha256);
      try {
        await readVerified(fileMemberPath(file.sha256), file.sha256);
      } catch (error) {
        log.capture(error);
      }
    }
  }
  return schemaDocument && restoreTables.length === tables.length
    ? { schema: schemaDocument, tables: restoreTables }
    : null;
}

function parseTable(table: CheckpointTable, bytes: Uint8Array): RestoreTable {
  const text = decodeUtf8(bytes, table.member);
  const lines = text.split("\n");
  if (lines.pop() !== "") {
    throw bundleDefect(
      "table_row_malformed",
      "Table export is truncated",
      table.name,
    );
  }
  if (lines.length !== table.rows) {
    throw bundleDefect(
      "table_row_count_mismatch",
      `Table ${table.name} row count differs from the manifest`,
      table.name,
    );
  }
  const rows = lines.map((line, index) => {
    if (index > 0 && compareLines(lines[index - 1] ?? "", line) > 0) {
      throw bundleDefect(
        "table_row_malformed",
        "Table export is not in canonical order",
        table.name,
      );
    }
    return decodeRowLine(line, table.columns.length, table.name);
  });
  return { name: table.name, columns: table.columns, rows };
}

async function restoreDatabase(
  manifest: CheckpointManifest,
  parsed: ParsedDatabase,
  options: VerifyOptions,
  limits: CheckpointLimits,
  log: FailureLog,
  restored: { tables: number; rows: number },
): Promise<void> {
  const open =
    options.openScratchDatabase ?? (() => openWebsiteDatabase(":memory:"));
  const scratch = await open();
  try {
    let snapshot: ReturnType<typeof captureDatabaseSnapshot>;
    try {
      restoreDatabaseSnapshot(scratch, parsed.schema, parsed.tables);
      const violations = scratch.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        const names = [...new Set(violations.map((row) => String(row.table)))];
        log.add(
          "foreign_key_violation",
          names.slice(0, 5).join(","),
          `Restored database has ${violations.length} foreign-key violations`,
        );
      }
      if (scratch.pragma("integrity_check", { simple: true }) !== "ok") {
        log.add(
          "integrity_check_failed",
          "database",
          "Restored database failed the SQLite integrity check",
        );
      }
      snapshot = captureDatabaseSnapshot(scratch, limits);
    } catch (error) {
      if (
        error instanceof CheckpointError &&
        error.code === "scratch_not_empty"
      ) {
        throw error;
      }
      // SQLite rejected the bundle's schema or rows. Engine messages embed
      // identifiers chosen by the bundle author, so the text is never
      // echoed. Only a fixed description selected from the message prefix
      // is reported.
      log.add(
        "restore_failed",
        "database",
        `Restore rejected: ${describeRestoreRejection(error)}`,
      );
      return;
    }

    const { database } = manifest;
    if (sha256Hex(snapshot.schemaJson) !== database.schema.sha256) {
      log.add(
        "schema_digest_mismatch",
        "schema",
        "Restored schema differs from the manifest",
      );
    }
    if (
      canonicalJson(snapshot.migrations) !== canonicalJson(database.migrations)
    ) {
      log.add(
        "migration_history_mismatch",
        "schema_migrations",
        "Restored migration history differs from the manifest",
      );
    }
    const restoredTables = new Map(
      snapshot.tables.map((table) => [table.name, table]),
    );
    for (const table of database.tables) {
      const actual = restoredTables.get(table.name);
      restoredTables.delete(table.name);
      if (!actual) {
        log.add("table_missing", table.name, "Table was not restored");
      } else if (actual.rows !== table.rows) {
        log.add(
          "table_row_count_mismatch",
          table.name,
          `Restored ${actual.rows} rows, manifest records ${table.rows}`,
        );
      } else if (sha256Hex(actual.text) !== table.sha256) {
        log.add(
          "table_digest_mismatch",
          table.name,
          "Restored table content differs from the manifest",
        );
      } else {
        restored.tables += 1;
        restored.rows += actual.rows;
      }
    }
    for (const name of restoredTables.keys()) {
      log.add("table_unexpected", name, "Restore produced an undeclared table");
    }
  } finally {
    scratch.close();
  }
}

async function restoreFiles(
  reader: BundleReader,
  manifest: CheckpointManifest,
  options: VerifyOptions,
  limits: CheckpointLimits,
  log: FailureLog,
  restored: { files: number; file_bytes: number },
): Promise<void> {
  const scratch = await mkdtemp(
    join(options.scratchRoot ?? tmpdir(), "cw-checkpoint-verify-"),
  );
  try {
    const store = new LocalFileStore(scratch, { maxFiles: limits.maxFiles });
    for (const file of manifest.files) {
      const bytes = await reader.read(fileMemberPath(file.sha256), file.size);
      await store.put(file.key, bytes);
    }
    const expected = new Map(manifest.files.map((file) => [file.key, file]));
    for (const info of await store.list()) {
      const file = expected.get(info.key);
      expected.delete(info.key);
      if (!file) {
        log.add("file_unexpected", info.key, "Restore produced an extra file");
        continue;
      }
      const copy = await store.read(info.key, limits.maxFileBytes);
      if (copy.bytes.length !== file.size) {
        log.add("file_size_mismatch", file.key, "Restored file size differs");
      } else if (sha256Hex(copy.bytes) !== file.sha256) {
        log.add("file_digest_mismatch", file.key, "Restored file differs");
      } else {
        restored.files += 1;
        restored.file_bytes += file.size;
      }
    }
    for (const key of expected.keys()) {
      log.add("file_missing", key, "File was not restored");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const RESTORE_REJECTIONS: readonly (readonly [RegExp, string])[] = [
  [/^CHECK constraint failed/, "a CHECK constraint failed"],
  [/^UNIQUE constraint failed/, "a UNIQUE constraint failed"],
  [/^NOT NULL constraint failed/, "a NOT NULL constraint failed"],
  [/^FOREIGN KEY constraint failed/, "a FOREIGN KEY constraint failed"],
  [/^datatype mismatch/, "a datatype mismatch"],
  [/syntax error/, "a schema statement has a syntax error"],
];

/**
 * Maps a SQLite restore error to a fixed, bounded description. The result
 * never contains text taken from the error message.
 */
function describeRestoreRejection(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  for (const [pattern, description] of RESTORE_REJECTIONS) {
    if (pattern.test(message)) {
      return description;
    }
  }
  return "SQLite rejected the bundle schema or rows (details withheld)";
}

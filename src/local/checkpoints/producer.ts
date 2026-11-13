import {
  type BundleMember,
  CHECKPOINT_FORMAT,
  CHECKPOINT_FORMAT_VERSION,
  type CheckpointDestination,
  type CheckpointFileEntry,
  type CheckpointLimits,
  type CheckpointManifest,
  type FileStore,
  type StoredFileInfo,
} from "../../contracts/checkpoints.js";
import type { WebsiteDatabase } from "../../database/sqlite.js";
import {
  assertApplicationCommit,
  assertCheckpointId,
  assertFileKey,
  CheckpointError,
  canonicalJson,
  compareLines,
  DEFAULT_CHECKPOINT_LIMITS,
  fileMemberPath,
  foldKey,
  sha256Hex,
} from "./core.js";
import {
  captureDatabaseSnapshot,
  type DatabaseSnapshot,
} from "./database-snapshot.js";

export interface ProduceOptions {
  readonly checkpointId: string;
  readonly applicationCommit: string;
  readonly createdAt?: Date;
  readonly limits?: Partial<CheckpointLimits>;
}

/** A captured but unpublished checkpoint. Nothing has been written yet. */
export interface PreparedCheckpoint {
  readonly manifest: CheckpointManifest;
  readonly manifestJson: string;
  readonly manifestSha256: string;
  readonly snapshot: DatabaseSnapshot;
  readonly inventory: readonly StoredFileInfo[];
  readonly limits: CheckpointLimits;
}

/**
 * Captures the database and inventories the file store.
 *
 * The database snapshot is taken synchronously before this function first
 * yields, so it reflects the database at the moment of the call. Every file
 * is then read once to record its size and SHA-256.
 */
export async function prepareCheckpoint(
  database: WebsiteDatabase,
  fileStore: FileStore,
  options: ProduceOptions,
): Promise<PreparedCheckpoint> {
  assertCheckpointId(options.checkpointId);
  assertApplicationCommit(options.applicationCommit);
  const limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...options.limits };
  const snapshot = captureDatabaseSnapshot(database, limits);

  const inventory = await listInventory(fileStore, limits);
  const files: CheckpointFileEntry[] = [];
  for (const info of inventory) {
    const file = await fileStore.read(info.key, limits.maxFileBytes);
    assertUnchanged(info, file);
    files.push({
      key: info.key,
      size: file.bytes.length,
      sha256: sha256Hex(file.bytes),
    });
  }

  const tables = snapshot.tables.map((table) => ({
    name: table.name,
    member: table.member,
    columns: table.columns,
    rows: table.rows,
    bytes: Buffer.byteLength(table.text),
    sha256: sha256Hex(table.text),
  }));
  const manifest: CheckpointManifest = {
    format: CHECKPOINT_FORMAT,
    format_version: CHECKPOINT_FORMAT_VERSION,
    checkpoint_id: options.checkpointId,
    created_at: (options.createdAt ?? new Date()).toISOString(),
    application: { commit: options.applicationCommit },
    database: {
      migration_version: snapshot.migrations.at(-1)?.version ?? 0,
      migrations: snapshot.migrations,
      schema: {
        member: "db/schema.json",
        bytes: Buffer.byteLength(snapshot.schemaJson),
        sha256: sha256Hex(snapshot.schemaJson),
      },
      tables,
    },
    files,
    totals: {
      tables: tables.length,
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      files: files.length,
      file_bytes: files.reduce((sum, file) => sum + file.size, 0),
    },
  };
  const manifestJson = canonicalJson(manifest);
  if (Buffer.byteLength(manifestJson) > limits.maxManifestBytes) {
    throw new CheckpointError("limit_exceeded", "Manifest is too large");
  }
  return {
    manifest,
    manifestJson,
    manifestSha256: sha256Hex(manifestJson),
    snapshot,
    inventory,
    limits,
  };
}

/**
 * Writes a prepared checkpoint to the destination. File contents are read a
 * second time and must match the prepared inventory byte for byte; the store
 * is then listed again. Any difference fails the checkpoint before the
 * manifest is written, so nothing is published.
 */
export async function publishPreparedCheckpoint(
  prepared: PreparedCheckpoint,
  fileStore: FileStore,
  destination: CheckpointDestination,
): Promise<void> {
  await destination.put(
    prepared.manifest.checkpoint_id,
    bundleMembers(prepared, fileStore),
  );
}

export async function produceCheckpoint(
  database: WebsiteDatabase,
  fileStore: FileStore,
  destination: CheckpointDestination,
  options: ProduceOptions,
): Promise<PreparedCheckpoint> {
  const prepared = await prepareCheckpoint(database, fileStore, options);
  await publishPreparedCheckpoint(prepared, fileStore, destination);
  return prepared;
}

async function* bundleMembers(
  prepared: PreparedCheckpoint,
  fileStore: FileStore,
): AsyncGenerator<BundleMember> {
  const { manifest, snapshot, inventory, limits } = prepared;
  yield { path: "db/schema.json", bytes: Buffer.from(snapshot.schemaJson) };
  for (const table of snapshot.tables) {
    yield { path: table.member, bytes: Buffer.from(table.text) };
  }

  const written = new Set<string>();
  for (const [index, entry] of manifest.files.entries()) {
    const info = inventory[index];
    const file = await fileStore.read(entry.key, limits.maxFileBytes);
    if (!info || info.key !== entry.key) {
      throw new CheckpointError("snapshot_inconsistent", "Inventory mismatch");
    }
    assertUnchanged(info, file);
    if (sha256Hex(file.bytes) !== entry.sha256) {
      throw changed(entry.key);
    }
    // Identical contents are stored once, addressed by their digest.
    if (!written.has(entry.sha256)) {
      written.add(entry.sha256);
      yield { path: fileMemberPath(entry.sha256), bytes: file.bytes };
    }
  }

  const finalInventory = await listInventory(fileStore, limits);
  const same =
    finalInventory.length === inventory.length &&
    finalInventory.every(
      (info, index) =>
        info.key === inventory[index]?.key &&
        info.revision === inventory[index]?.revision,
    );
  if (!same) {
    throw new CheckpointError(
      "source_changed",
      "File storage changed while the checkpoint was produced",
    );
  }
  yield { path: "manifest.json", bytes: Buffer.from(prepared.manifestJson) };
}

async function listInventory(
  fileStore: FileStore,
  limits: CheckpointLimits,
): Promise<StoredFileInfo[]> {
  const inventory = [...(await fileStore.list())].sort((left, right) =>
    compareLines(left.key, right.key),
  );
  if (inventory.length > limits.maxFiles) {
    throw new CheckpointError("limit_exceeded", "Too many stored files");
  }
  const folded = new Set<string>();
  let totalBytes = 0;
  for (const info of inventory) {
    assertFileKey(info.key);
    if (folded.has(foldKey(info.key))) {
      throw new CheckpointError(
        "duplicate_file_key",
        "Two stored files share one logical key",
        { subject: info.key },
      );
    }
    folded.add(foldKey(info.key));
    totalBytes += info.size;
    if (info.size > limits.maxFileBytes) {
      throw new CheckpointError("limit_exceeded", "Stored file too large", {
        subject: info.key,
      });
    }
  }
  if (totalBytes > limits.maxTotalFileBytes) {
    throw new CheckpointError("limit_exceeded", "File storage too large");
  }
  return inventory;
}

function assertUnchanged(info: StoredFileInfo, file: StoredFileInfo): void {
  if (file.revision !== info.revision || file.size !== info.size) {
    throw changed(info.key);
  }
}

function changed(key: string): CheckpointError {
  return new CheckpointError(
    "source_changed",
    "A stored file changed while the checkpoint was produced",
    { subject: key },
  );
}

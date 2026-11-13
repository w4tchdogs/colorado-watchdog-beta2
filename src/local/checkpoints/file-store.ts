import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FileStore,
  StoredFile,
  StoredFileInfo,
} from "../../contracts/checkpoints.js";
import { assertFileKey, CheckpointError, compareLines } from "./core.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface LocalFileStoreOptions {
  readonly maxFiles?: number;
}

/**
 * Local directory standing in for R2 file storage. Keys map to relative
 * paths. Symlinks, special files and unsafe names fail the listing instead of
 * being skipped, so a checkpoint never silently omits stored content.
 */
export class LocalFileStore implements FileStore {
  private readonly maxFiles: number;

  constructor(
    private readonly root: string,
    options: LocalFileStoreOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? 100_000;
  }

  async list(): Promise<StoredFileInfo[]> {
    await assertRealDirectory(this.root, "");
    const files: StoredFileInfo[] = [];
    const walk = async (directory: string, prefix: string) => {
      const names = (await readdir(directory)).sort(compareLines);
      for (const name of names) {
        const key = prefix ? `${prefix}/${name}` : name;
        assertFileKey(key);
        const path = join(directory, name);
        const stats = await lstat(path, { bigint: true });
        if (stats.isDirectory()) {
          await walk(path, key);
        } else if (stats.isFile()) {
          files.push({
            key,
            size: Number(stats.size),
            revision: revisionOf(stats),
          });
          if (files.length > this.maxFiles) {
            throw new CheckpointError("limit_exceeded", "Too many files");
          }
        } else {
          throw new CheckpointError(
            "unsafe_source_file",
            "File storage contains a symlink or special file",
            { subject: key },
          );
        }
      }
    };
    await walk(this.root, "");
    return files;
  }

  async read(key: string, maxBytes: number): Promise<StoredFile> {
    const path = await this.resolve(key);
    const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new CheckpointError(
          "unsafe_source_file",
          "Stored object is not a regular file",
          { subject: key },
        );
      }
      if (before.size > BigInt(maxBytes)) {
        throw new CheckpointError("limit_exceeded", "Stored file too large", {
          subject: key,
        });
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        BigInt(bytes.length) !== before.size ||
        revisionOf(after) !== revisionOf(before)
      ) {
        throw new CheckpointError(
          "source_changed",
          "A stored file changed while it was read",
          { subject: key },
        );
      }
      return { key, size: bytes.length, revision: revisionOf(before), bytes };
    } finally {
      await handle.close();
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = await this.resolve(key, true);
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }

  /** Resolves a key under the root and refuses symlinked parents. */
  private async resolve(key: string, createParents = false): Promise<string> {
    assertFileKey(key);
    await assertRealDirectory(this.root, key);
    const segments = key.split("/");
    let path = this.root;
    for (const segment of segments.slice(0, -1)) {
      path = join(path, segment);
      if (createParents) {
        await mkdir(path, { recursive: true });
      }
      await assertRealDirectory(path, key);
    }
    return join(path, segments.at(-1) ?? "");
  }
}

async function assertRealDirectory(path: string, key: string): Promise<void> {
  let isDirectory = false;
  try {
    isDirectory = (await lstat(path)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new CheckpointError(
      "unsafe_source_file",
      "File storage path is missing or is not a real directory",
      { subject: key },
    );
  }
}

function revisionOf(stats: {
  mtimeNs: bigint;
  ino: bigint;
  size: bigint;
}): string {
  return `${stats.mtimeNs}:${stats.ino}:${stats.size}`;
}

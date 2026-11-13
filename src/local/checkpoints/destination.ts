import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  BundleEntry,
  BundleMember,
  BundleReader,
  CheckpointDestination,
} from "../../contracts/checkpoints.js";
import {
  assertCheckpointId,
  assertMemberPath,
  bundleDefect,
  CheckpointError,
  compareLines,
} from "./core.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MANIFEST = "manifest.json";

/**
 * Local directory destination.
 *
 *   <root>/staging/<id>-<random>/   incomplete bundles, never listed
 *   <root>/published/<id>/          complete bundles, never rewritten
 *
 * A bundle is staged in full, then published by one directory rename. This
 * class has no update or delete path for a published bundle.
 */
export class LocalDirectoryDestination implements CheckpointDestination {
  private readonly staging: string;
  private readonly published: string;

  constructor(root: string) {
    this.staging = join(root, "staging");
    this.published = join(root, "published");
  }

  async put(id: string, members: AsyncIterable<BundleMember>): Promise<void> {
    assertCheckpointId(id);
    await mkdir(this.staging, { recursive: true });
    await mkdir(this.published, { recursive: true });
    const target = join(this.published, id);
    if (await exists(target)) {
      throw duplicate(id);
    }

    const stage = await mkdtemp(join(this.staging, `${id}-`));
    try {
      const seen = new Set<string>();
      let manifestWritten = false;
      for await (const member of members) {
        assertMemberPath(member.path);
        const folded = member.path.toLowerCase();
        if (manifestWritten || seen.has(folded)) {
          throw new CheckpointError(
            "invalid_bundle",
            "Bundle members must be unique and end with the manifest",
            { subject: member.path },
          );
        }
        seen.add(folded);
        manifestWritten = member.path === MANIFEST;
        await writeMember(stage, member);
      }
      if (!manifestWritten) {
        throw new CheckpointError("invalid_bundle", "Bundle has no manifest");
      }
      await publish(stage, target, id);
    } catch (error) {
      // Only this call's own unpublished staging directory is removed.
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.published);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const ids: string[] = [];
    for (const name of names) {
      try {
        assertCheckpointId(name);
      } catch {
        continue;
      }
      const directory = await lstat(join(this.published, name));
      const manifest = await lstat(join(this.published, name, MANIFEST)).catch(
        () => undefined,
      );
      if (directory.isDirectory() && manifest?.isFile()) {
        ids.push(name);
      }
    }
    return ids.sort(compareLines);
  }

  async get(id: string): Promise<BundleReader> {
    assertCheckpointId(id);
    const root = join(this.published, id);
    const stats = await lstat(root).catch(() => undefined);
    if (!stats?.isDirectory()) {
      throw new CheckpointError(
        "checkpoint_not_found",
        "No published checkpoint has this identifier",
        { subject: id },
      );
    }
    return new LocalBundleReader(id, root);
  }

  async prune(): Promise<never> {
    throw new CheckpointError(
      "prune_disabled",
      "Checkpoint pruning is not authorized and deletes nothing",
    );
  }
}

class LocalBundleReader implements BundleReader {
  constructor(
    readonly id: string,
    private readonly root: string,
  ) {}

  async entries(maxEntries: number): Promise<BundleEntry[]> {
    const entries: BundleEntry[] = [];
    const walk = async (directory: string, prefix: string) => {
      const names = (await readdir(directory)).sort(compareLines);
      for (const name of names) {
        const path = prefix ? `${prefix}/${name}` : name;
        assertMemberPath(path);
        const stats = await lstat(join(directory, name));
        if (!stats.isDirectory() && !stats.isFile()) {
          throw bundleDefect(
            "unsafe_bundle_member",
            "Bundle contains a symlink or special file",
            path,
          );
        }
        const kind = stats.isDirectory() ? "directory" : "file";
        entries.push({ path, kind, size: stats.isFile() ? stats.size : 0 });
        if (entries.length > maxEntries) {
          throw bundleDefect("limit_exceeded", "Bundle has too many members");
        }
        if (stats.isDirectory()) {
          await walk(join(directory, name), path);
        }
      }
    };
    await walk(this.root, "");
    return entries;
  }

  async read(path: string, maxBytes: number): Promise<Uint8Array> {
    assertMemberPath(path);
    const segments = path.split("/");
    let directory = this.root;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      const stats = await lstat(directory).catch(() => undefined);
      if (!stats?.isDirectory()) {
        throw bundleDefect("member_missing", "Bundle member is missing", path);
      }
    }
    const file = join(directory, segments.at(-1) ?? "");
    const stats = await lstat(file).catch(() => undefined);
    if (!stats) {
      throw bundleDefect("member_missing", "Bundle member is missing", path);
    }
    if (!stats.isFile()) {
      throw bundleDefect(
        "unsafe_bundle_member",
        "Bundle member is not a regular file",
        path,
      );
    }
    if (stats.size > maxBytes) {
      throw bundleDefect("limit_exceeded", "Bundle member is too large", path);
    }
    const handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
    try {
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) {
        throw bundleDefect("limit_exceeded", "Bundle member too large", path);
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }
}

async function writeMember(stage: string, member: BundleMember): Promise<void> {
  const segments = member.path.split("/");
  const directory = join(stage, ...segments.slice(0, -1));
  await mkdir(directory, { recursive: true });
  // Exclusive create, read-only mode: a member is written exactly once.
  const handle = await open(join(stage, ...segments), "wx", 0o444);
  try {
    await handle.writeFile(member.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publish(
  stage: string,
  target: string,
  id: string,
): Promise<void> {
  try {
    await rename(stage, target);
  } catch (error) {
    // Renaming onto an existing bundle fails; it never merges or replaces.
    if (await exists(target)) {
      throw duplicate(id);
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

function duplicate(id: string): CheckpointError {
  return new CheckpointError(
    "duplicate_checkpoint",
    "A checkpoint with this identifier is already published",
    { subject: id },
  );
}

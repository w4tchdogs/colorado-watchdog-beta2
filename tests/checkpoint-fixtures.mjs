// Synthetic fixtures for checkpoint tests. Every account, key and file here
// is invented. Nothing reads a hosted service, real record or credential.
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { canonicalJson } from "../dist/local/checkpoints/core.js";
import { LocalDirectoryDestination } from "../dist/local/checkpoints/destination.js";
import { LocalFileStore } from "../dist/local/checkpoints/file-store.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const OWNER = "acct-synthetic-owner";
export const SYNTHETIC_FILES = {
  "reports/alpha.txt": Buffer.from("synthetic report alpha\n"),
  "reports/copy-of-alpha.txt": Buffer.from("synthetic report alpha\n"),
  "images/pixel.bin": Buffer.from([0, 255, 1, 254, 2, 253]),
  "empty.dat": Buffer.alloc(0),
};

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function openSyntheticDatabase() {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name, email, preferences)
    VALUES
      ('${OWNER}', 'human', 'owner', 'Synthetic Owner', 'owner@example.invalid', '{"theme":"dark"}'),
      ('acct-synthetic-agent', 'agent', 'administrator', 'Synthetic Agent Zoë', NULL, '{}'),
      ('acct-synthetic-contributor', 'human', 'contributor', 'Synthetic Contributor', NULL, '{}');
    INSERT INTO identities (id, account_id, provider, subject, credential_hash)
    VALUES
      ('ident-synthetic-1', 'acct-synthetic-agent', 'agent-key', 'synthetic-agent', '${"ab".repeat(32)}'),
      ('ident-synthetic-2', '${OWNER}', 'test-human', 'subject-owner', NULL),
      ('ident-synthetic-3', 'acct-synthetic-contributor', 'test-human', 'subject-contributor', NULL);
    INSERT INTO operations (id, kind, status, created_by_account_id, finished_at)
    VALUES ('op-synthetic-1', 'synthetic.seed', 'succeeded', '${OWNER}', '2026-01-01T00:00:00.000Z');
    INSERT INTO audit_events (id, actor_account_id, operation_id, action, target_type, target_id, summary)
    VALUES ('audit-synthetic-1', '${OWNER}', 'op-synthetic-1', 'synthetic.seeded', 'account', '${OWNER}', 'Synthetic seed');
  `);
  return database;
}

/** Builds an isolated database, file store and destination under a tmp dir. */
export async function createFixture(t, files = SYNTHETIC_FILES) {
  const root = mkdtempSync(join(tmpdir(), "cw-m0d-test-"));
  const filesRoot = join(root, "files");
  const destinationRoot = join(root, "checkpoints");
  const scratchRoot = join(root, "scratch");
  mkdirSync(filesRoot);
  mkdirSync(scratchRoot);
  for (const [key, bytes] of Object.entries(files)) {
    const path = join(filesRoot, ...key.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  const database = await openSyntheticDatabase();
  // Principals come from the M0-C resolver, exactly as a request would.
  const adapter = createTestHumanIdentityAdapter({
    owner: "subject-owner",
    contributor: "subject-contributor",
  });
  const principalFor = (login) =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.test/", {
        headers: { "x-test-human-subject": login },
      }),
      adapter,
    );
  const owner = await principalFor("owner");
  const contributor = await principalFor("contributor");
  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    filesRoot,
    destinationRoot,
    scratchRoot,
    database,
    owner,
    contributor,
    fileStore: new LocalFileStore(filesRoot),
    destination: new LocalDirectoryDestination(destinationRoot),
    bundlePath: (id, ...member) =>
      join(destinationRoot, "published", id, ...member),
  };
}

/** Replaces a read-only bundle member, as an outside tamperer would. */
export function overwrite(path, bytes) {
  chmodSync(path, 0o644);
  writeFileSync(path, bytes);
}

/** Rewrites the manifest so it is canonical and self-consistent again. */
export function rewriteManifest(fixture, id, mutate) {
  const path = fixture.bundlePath(id, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  mutate(manifest);
  overwrite(path, canonicalJson(manifest));
}

/** Digest of every path, type and byte under a directory. */
export function treeDigest(directory) {
  const hash = createHash("sha256");
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = lstatSync(path);
      hash.update(`${prefix}${name}\0${stats.isDirectory() ? "d" : "f"}\0`);
      if (stats.isDirectory()) {
        walk(path, `${prefix}${name}/`);
      } else {
        hash.update(readFileSync(path));
      }
    }
  };
  walk(directory, "");
  return hash.digest("hex");
}

/**
 * Makes the audit insert for one action fail, which rolls back the M0-C
 * audited transaction. Simulates a crash between two lifecycle steps.
 */
export function failAuditFor(database, action) {
  database.exec(
    `CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_events
     WHEN NEW.action = '${action}'
     BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`,
  );
  return () => database.exec("DROP TRIGGER synthetic_audit_failure");
}

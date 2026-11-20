import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const required = [
  "WATCHDOG_STAGING_ACCOUNT_ID",
  "WATCHDOG_STAGING_D1_ID",
  "WATCHDOG_STAGING_R2_BUCKET_NAME",
];
for (const key of required) {
  if (!process.env[key]?.trim()) throw new Error(`Missing ${key}`);
}

const accountId = process.env.WATCHDOG_STAGING_ACCOUNT_ID.trim();
const d1Id = process.env.WATCHDOG_STAGING_D1_ID.trim();
const bucketName = process.env.WATCHDOG_STAGING_R2_BUCKET_NAME.trim();
if (accountId !== "e137ca17e819d5761088a98f59f6a8ff") {
  throw new Error(
    "Refusing staging config for an unexpected Cloudflare account",
  );
}
if (!/^[0-9a-f-]{36}$/i.test(d1Id)) throw new Error("Invalid staging D1 UUID");
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucketName)) {
  throw new Error("Invalid staging R2 bucket name");
}

const output = resolve(root, ".wrangler/wrangler.cloudflare-staging.toml");
const migrationDirectory = resolve(
  root,
  ".wrangler/cloudflare-staging-migrations",
);
await mkdir(resolve(root, ".wrangler"), { recursive: true });
await mkdir(migrationDirectory, { recursive: true });
const sourceMigrations = (await readdir(resolve(root, "website/migrations")))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (
  sourceMigrations.length !== 34 ||
  !sourceMigrations.at(-1)?.startsWith("0034_") ||
  sourceMigrations.some((name, index) => Number(name.slice(0, 4)) !== index + 1)
) {
  throw new Error(
    `Expected the staging catalog of 34 migrations; found ${sourceMigrations.length}`,
  );
}
const historyTable =
  "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')) STRICT;\n";
for (const [index, name] of sourceMigrations.entries()) {
  const sql = (
    await readFile(resolve(root, "website/migrations", name), "utf8")
  ).replace(/\r\n?/g, "\n");
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  const escapedName = name.replaceAll("'", "''");
  const ledger = `\nINSERT INTO schema_migrations (version, name, sha256) VALUES (${index + 1}, '${escapedName}', '${checksum}');\n`;
  await writeFile(
    resolve(migrationDirectory, name),
    `${index === 0 ? historyTable : ""}${sql}${ledger}`,
    "utf8",
  );
}
await writeFile(
  output,
  `name = "colorado-watchdog-alpha1-staging"\n` +
    `main = "../dist/server/index.js"\n` +
    `compatibility_date = "2026-11-13"\n` +
    `workers_dev = true\n` +
    `preview_urls = false\n` +
    `keep_vars = true\n` +
    `account_id = "${accountId}"\n\n` +
    `[vars]\nAPP_ENV = "production"\nREPORTS_TURNSTILE = "disabled"\n\n` +
    `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "colorado-watchdog-alpha1-staging"\ndatabase_id = "${d1Id}"\nmigrations_dir = "cloudflare-staging-migrations"\n\n` +
    `[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "${bucketName}"\n`,
  "utf8",
);
console.log(
  `Generated the staging config and ${sourceMigrations.length}-migration ledger set in the ignored .wrangler directory.`,
);

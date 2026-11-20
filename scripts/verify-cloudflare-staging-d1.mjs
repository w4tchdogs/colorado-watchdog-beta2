import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const config = resolve(root, ".wrangler/wrangler.cloudflare-staging.toml");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const names = (await readdir(resolve(root, "website/migrations")))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (
  names.length !== 34 ||
  names.some((name, index) => Number(name.slice(0, 4)) !== index + 1)
) {
  throw new Error(
    "Expected the exact contiguous staging migration catalog 0001–0034",
  );
}
const expectedMigrations = await Promise.all(
  names.map(async (name, index) => ({
    version: index + 1,
    name,
    sha256: createHash("sha256")
      .update(
        (
          await readFile(resolve(root, "website/migrations", name), "utf8")
        ).replace(/\r\n?/g, "\n"),
      )
      .digest("hex"),
  })),
);

function query(sql) {
  const result = spawnSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "execute",
      "colorado-watchdog-alpha1-staging",
      "--config",
      config,
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Remote D1 verification query failed: ${result.stderr || result.stdout}`,
    );
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.some((entry) => entry.success !== true))
    throw new Error("Remote D1 returned an unsuccessful query result");
  return parsed.flatMap((entry) => entry.results ?? []);
}

const ledger = query(
  "SELECT version, name, sha256 FROM schema_migrations ORDER BY version;",
);
const wranglerLedger = query("SELECT name FROM d1_migrations ORDER BY name;");
const counties = query("SELECT fips, name FROM counties ORDER BY fips;");
const mismatch = expectedMigrations.find((expected, index) => {
  const actual = ledger[index];
  return (
    !actual ||
    Number(actual.version) !== expected.version ||
    actual.name !== expected.name ||
    actual.sha256 !== expected.sha256
  );
});
if (ledger.length !== expectedMigrations.length || mismatch) {
  throw new Error(
    `Application migration ledger mismatch at ${mismatch?.name ?? "row count"}; expected ${expectedMigrations.length}, got ${ledger.length}`,
  );
}
if (
  wranglerLedger.length !== names.length ||
  wranglerLedger.some((entry, index) => entry.name !== names[index])
) {
  throw new Error(
    `Wrangler D1 migration history mismatch: expected ${names.length} named migrations, got ${wranglerLedger.length}`,
  );
}

const correction = await readFile(
  resolve(
    root,
    "website/migrations/0015_correct_lake_la_plata_county_names.sql",
  ),
  "utf8",
);
function values(sql, marker, endMarker) {
  const section = sql.split(marker)[1]?.split(endMarker)[0];
  if (!section) throw new Error(`Could not parse county values from ${marker}`);
  return [...section.matchAll(/\('([0-9]{5})', '([^']+)'\)/g)].map((match) => ({
    fips: match[1],
    name: match[2],
  }));
}
const canonicalCounties = values(
  correction,
  "INSERT INTO vis8_fips_expected (fips, name) VALUES",
  ";",
);
if (canonicalCounties.length !== 64)
  throw new Error(
    `Expected 64 canonical county rows, parsed ${canonicalCounties.length}`,
  );
const expectedCountyJson = JSON.stringify(canonicalCounties);
if (counties.length !== 64 || JSON.stringify(counties) !== expectedCountyJson) {
  throw new Error(
    "Live D1 county/FIPS pairs do not exactly match migration 0015's canonical 64-pair inventory",
  );
}
console.log(
  `PASS live Website D1: ${ledger.length} application migration version/name/normalized-SHA256 rows; ${wranglerLedger.length} Wrangler migration names; all ${counties.length} canonical county/FIPS pairs.`,
);

#!/usr/bin/env node
// Synthetic Adams-sized fixture for the dashboard Profiles import (SYNC-1).
// Every name, URL and ID is invented (example.invalid). No real person appears.
//
//   node scripts/profiles-import-fixture.mjs --out <folder> [--profiles 262] [--roles 413]
//
// Writes profile.csv and profile_role.csv for the owner to upload on the
// Cloudflare synthetic acceptance run. Uses the key prefix "SYN" so the rows
// are plainly synthetic.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const quote = (value) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const line = (cells) => cells.map(quote).join(",");

export function buildAdamsFixture({
  profiles = 262,
  roles = 413,
  tag = "SYN",
} = {}) {
  const pad = (n, width) => String(n).padStart(width, "0");
  const profileRows = [line(["profile_id", "display_name"])];
  for (let i = 1; i <= profiles; i++)
    profileRows.push(
      line([`${tag}-P${pad(i, 4)}`, `Synthetic Adams Person ${pad(i, 4)}`]),
    );
  const sourceCount = Math.max(1, Math.ceil(roles / 3));
  const roleRows = [
    line([
      "role_id",
      "profile_id",
      "county_fips",
      "published_office",
      "job_description",
      "source_id",
      "source_url",
      "source_title",
      "publisher_classification",
      "source_type",
      "source_checked_at",
    ]),
  ];
  for (let i = 1; i <= roles; i++) {
    const owner = ((i - 1) % profiles) + 1;
    const source = ((i - 1) % sourceCount) + 1;
    roleRows.push(
      line([
        `${tag}-R${pad(i, 4)}`,
        `${tag}-P${pad(owner, 4)}`,
        "08001",
        `Synthetic Adams Office ${pad((i % 17) + 1, 2)}`,
        i % 5 === 0 ? 'Synthetic duties, with a comma and a "quoted" word' : "",
        `${tag}-S${pad(source, 4)}`,
        `https://example.invalid/adams/${tag.toLowerCase()}/${pad(source, 4)}`,
        `Synthetic Adams source ${pad(source, 4)}`,
        "official",
        "official_page",
        "2026-11-01T00:00:00Z",
      ]),
    );
  }
  return {
    profile: `${profileRows.join("\r\n")}\r\n`,
    profileRole: `${roleRows.join("\r\n")}\r\n`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
  };
  const out = value("--out", "");
  if (!out) {
    console.error(
      "Usage: node scripts/profiles-import-fixture.mjs --out <folder> [--profiles N] [--roles N]",
    );
    process.exit(2);
  }
  const files = buildAdamsFixture({
    profiles: Number(value("--profiles", "262")),
    roles: Number(value("--roles", "413")),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "profile.csv"), files.profile);
  writeFileSync(join(out, "profile_role.csv"), files.profileRole);
  console.log(`Wrote synthetic profile.csv and profile_role.csv to ${out}`);
}

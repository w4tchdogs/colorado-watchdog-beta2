import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const dist = join(root, "dist");
const server = join(dist, "server");
const metadata = join(dist, ".openai");
const siteBundle = join(dist, "site-browser");
const assetsDirectory = join(root, "website", "site");

await Promise.all([
  rm(server, { recursive: true, force: true }),
  rm(metadata, { recursive: true, force: true }),
  rm(siteBundle, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(server, { recursive: true }),
  mkdir(join(metadata, "drizzle"), { recursive: true }),
  mkdir(siteBundle, { recursive: true }),
]);

await Promise.all([
  build({
    entryPoints: [join(root, "src", "site", "report-browser.ts")],
    outfile: join(siteBundle, "report-interface.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "info",
  }),
  build({
    entryPoints: [join(root, "src", "site", "staff-report-browser.ts")],
    outfile: join(siteBundle, "staff-reports.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "info",
  }),
]);

const files = (await readdir(assetsDirectory, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() &&
      /^(?:site\.(?:css|js)|report-interface\.css|staff-reports\.css|brand-[a-z-]+\.png|favicon-[a-z-]+\.png)$/.test(
        entry.name,
      ),
  )
  .sort((a, b) => a.name.localeCompare(b.name, "en"));
if (
  !files.some((file) => file.name === "site.css") ||
  !files.some((file) => file.name === "site.js")
) {
  throw new Error("Expected reviewed site.css and site.js assets");
}
const assetData = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file.name,
      (await readFile(join(assetsDirectory, file.name))).toString("base64"),
    ]),
  ),
);
assetData["report-interface.js"] = (
  await readFile(join(siteBundle, "report-interface.js"))
).toString("base64");
assetData["staff-reports.js"] = (
  await readFile(join(siteBundle, "staff-reports.js"))
).toString("base64");
const hosting = JSON.parse(
  await readFile(join(root, ".openai", "hosting.json"), "utf8"),
);
if (
  hosting.project_id !== undefined &&
  (typeof hosting.project_id !== "string" || !hosting.project_id.trim())
) {
  throw new Error(
    "Sites project_id in hosting.json must be a non-empty string",
  );
}

await build({
  entryPoints: [join(root, "src", "worker.ts")],
  outfile: join(server, "index.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  define: {
    __WATCHDOG_SITE_ASSETS__: JSON.stringify(assetData),
    __WATCHDOG_SITES_PROJECT_ID__: JSON.stringify(hosting.project_id ?? null),
  },
  logLevel: "info",
});

await cp(join(root, ".openai", "hosting.json"), join(metadata, "hosting.json"));
const migrations = (await readdir(join(root, "website", "migrations")))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (migrations.at(-1) !== "0013_private_report_intake.sql") {
  throw new Error("Sites artifact must include Website migration 0013");
}
for (const migration of migrations) {
  await cp(
    join(root, "website", "migrations", migration),
    join(metadata, "drizzle", migration),
  );
}

console.log(
  `Built Sites Worker and packaged ${migrations.length} Website migrations plus ${files.length} static assets.`,
);

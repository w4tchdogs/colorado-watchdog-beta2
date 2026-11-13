import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Deliberately small source-only bootstrap. Extend alongside future scoped work.
const allowed = new Set([
  ".gitattributes",
  ".gitignore",
  ".githooks/pre-commit",
  ".github/workflows/check.yml",
  "wrangler.d1-test.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "docs/decisions.md",
  "docs/cost-limits.md",
  "docs/collaboration.md",
  "scripts/check.mjs",
  "scripts/d1-local-check.mjs",
  "docs/coordination/START.md",
  "docs/coordination/HANDOFF-TEMPLATE.md",
  "docs/coordination/PROJECT-BOOTSTRAP.md",
  "docs/architecture/beta-2-planning-handoff.md",
  ".github/ISSUE_TEMPLATE/scoped-task.md",
  ".github/pull_request_template.md",
  "package.json",
  "package-lock.json",
  "biome.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "scripts/dev.mjs",
  "scripts/editor-dev.mjs",
  "src/application.ts",
  "src/worker.ts",
  "src/contracts/runtime.ts",
  "src/contracts/directory.ts",
  "src/contracts/organization-profile.ts",
  "src/contracts/person-profile.ts",
  "src/contracts/sync.ts",
  "src/services/sync-planner.ts",
  "src/services/sync-commit.ts",
  "src/services/sync-history.ts",
  "src/contracts/storage.ts",
  "src/services/index.ts",
  "src/local/storage-probe.ts",
  "src/database/sqlite.ts",
  "src/database/migrations.ts",
  "src/database/versioned-writes.ts",
  "src/services/security.ts",
  "src/services/sync-authorization.ts",
  "src/contracts/county-overview.ts",
  "src/contracts/directory-search.ts",
  "src/services/directory.ts",
  "src/services/county-overview.ts",
  "src/services/directory-search.ts",
  "src/services/organization-profile.ts",
  "src/services/person-profile.ts",
  "src/services/audit.ts",
  "src/services/accounts.ts",
  "src/services/operations.ts",
  "src/transport/sync-api.ts",
  "website/migrations/0001_counties.sql",
  "website/migrations/0002_foundation.sql",
  "website/migrations/0003_county_fips_prefix.sql",
  "website/migrations/0004_m1_county_roles.sql",
  "website/migrations/0005_m2_sync_batches.sql",
  "website/migrations/0006_m2_sync_reversals.sql",
  "website/migrations/0007_m2_duplicate_flags.sql",
  "website/migrations/0008_duplicate_flag_observations.sql",
  "website/migrations/0009_content_foundation.sql",
  "src/contracts/content.ts",
  "src/services/content.ts",
  "tests/content.test.mjs",
  "website/migrations/0010_content_revisions.sql",
  "src/transport/content-api.ts",
  "tests/content-fixtures.mjs",
  "tests/content-revisions.test.mjs",
  "tests/content-api.test.mjs",
  "tests/content-listing.test.mjs",
  "tests/editor-fixtures.mjs",
  "tests/editor-markdown.test.mjs",
  "tests/editor-sandbox.test.mjs",
  "tests/editor-ui.test.mjs",
  "tests/editor-discovery.test.mjs",
  "tests/editor-relationships.test.mjs",
  "src/contracts/editor-lookup.ts",
  "src/editor-dev/lookup.ts",
  "src/editor/picker.ts",
  "src/editor/relationship-format.ts",
  "src/editor/relationships.ts",
  "docs/architecture/content-foundation.md",
  "docs/architecture/editorial-workspace.md",
  "website/editor/index.html",
  "website/editor/editor.css",
  "src/editor/api-client.ts",
  "src/editor/app.ts",
  "src/editor/diff.ts",
  "src/editor/dom.ts",
  "src/editor/main.ts",
  "src/editor/markdown.ts",
  "src/editor/preview.ts",
  "src/editor-dev/sandbox.ts",
  "src/services/duplicate-flags.ts",
  "tests/duplicate-flags.test.mjs",
  "tests/application.test.mjs",
  "tests/database.test.mjs",
  "tests/d1/worker.mjs",
  "tests/directory.test.mjs",
  "tests/organization-profile.test.mjs",
  "tests/person-profile.test.mjs",
  "tests/sync-planner.test.mjs",
  "tests/sync-commit.test.mjs",
  "tests/sync-history.test.mjs",
  "tests/sync-transport.test.mjs",
  "tests/security.test.mjs",
  "tests/harness.test.mjs",
  "src/contracts/checkpoints.ts",
  "src/local/checkpoints/core.ts",
  "src/local/checkpoints/database-snapshot.ts",
  "src/local/checkpoints/file-store.ts",
  "src/local/checkpoints/destination.ts",
  "src/local/checkpoints/producer.ts",
  "src/local/checkpoints/verifier.ts",
  "src/local/checkpoints/lifecycle.ts",
  "tests/checkpoints.test.mjs",
  "tests/checkpoint-lifecycle.test.mjs",
  "tests/checkpoint-fixtures.mjs",
  "docs/architecture/checkpoints.md",
  "docs/architecture/site-foundation.md",
  "docs/architecture/site-sync-contract.md",
  "docs/architecture/d1-readiness.md",
  "research/__init__.py",
  "research/__main__.py",
  "research/backup.py",
  "research/db.py",
  "research/intake.py",
  "research/mapping.py",
  "research/quarantine.py",
  "research/store.py",
  "research/submission.py",
  "research/operator.py",
  "research/structure.py",
  "research/migrations/001_foundation.sql",
  "research/migrations/002_durable_site_submissions.sql",
  "tests/__init__.py",
  "tests/research_fixtures.py",
  "tests/test_research.py",
  "tests/test_submission.py",
  "tests/test_legacy_contract.py",
  "tests/test_csv_intake.py",
  "tests/test_readiness.py",
  "tests/test_quarantine.py",
  "tests/test_source_classification.py",
  "tests/test_operator.py",
  "tests/test_structure.py",
  "tests/test_identity_bootstrap.py",
  "docs/research/R0-foundation.md",
  "docs/research/legacy-csv-compatibility.md",
  "docs/research/csv-intake.md",
  "docs/research/R1-operator-interface.md",
  "docs/research/R2-identity-bootstrap.md",
  "docs/research/R4-H1-intake-hardening.md",
  "docs/research/R5A-local-database-readiness.md",
  "docs/research/organizational-positions.md",
  "docs/research/R6-durable-submission-client.md",
]);
const staged = process.argv.includes("--staged");
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 2 * 1024 * 1024 });
const errors = [];
const files = git("ls-files", "-z")
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const present = new Set(files);
for (const required of allowed) {
  if (!present.has(required)) errors.push(`Missing required file: ${required}`);
}
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
];
for (const file of files) {
  if (!allowed.has(file)) {
    errors.push(`Outside bootstrap file allowlist: ${file}`);
    continue;
  }
  const mode = git("ls-files", "--stage", "--", file)
    .toString("utf8")
    .slice(0, 6);
  if (!["100644", "100755"].includes(mode))
    errors.push(`Non-regular file: ${file}`);
  const bytes = staged ? git("show", `:${file}`) : readFileSync(file);
  // The generated npm lockfile is the only file allowed to exceed 64 KiB.
  const sizeLimit = file === "package-lock.json" ? 256 * 1024 : 64 * 1024;
  if (bytes.length > sizeLimit)
    errors.push(`File exceeds ${sizeLimit / 1024} KiB: ${file}`);
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push(`Invalid UTF-8: ${file}`);
    continue;
  }
  if (content.includes("\0")) errors.push(`Binary content: ${file}`);
  if (!content.endsWith("\n")) errors.push(`Missing final newline: ${file}`);
  if (/^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(content))
    errors.push(`Conflict marker: ${file}`);
  if (/[\t ]+\r?$/m.test(content)) errors.push(`Trailing whitespace: ${file}`);
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    errors.push(`Possible credential (value withheld): ${file}`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `PASS: ${files.length} ${staged ? "staged" : "tracked"} source files; no dependencies or services used.`,
  );
}

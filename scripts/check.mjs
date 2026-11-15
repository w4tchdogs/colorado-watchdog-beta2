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
  "scripts/banners.mjs",
  "docs/coordination/START.md",
  "docs/coordination/CURRENT.md",
  "docs/coordination/ROADMAP.md",
  "docs/coordination/ARCHON-HANDOFF-REQUEST.md",
  "docs/coordination/visual-audit/coverage-ledger.csv",
  "docs/coordination/visual-audit/Shared Visual Design Inventory rev2026-11-14 v1.md",
  "docs/coordination/visual-audit/VIS-6 Coverage Summary and Follow-up rev2026-11-14 v1.md",
  "docs/coordination/visual-audit/VIS-6 Evidence Index rev2026-11-14 v1.md",
  "docs/coordination/HANDOFF-TEMPLATE.md",
  "docs/coordination/PROJECT-BOOTSTRAP.md",
  "docs/architecture/beta-2-planning-handoff.md",
  "docs/architecture/county-map-geometry.md",
  "docs/architecture/fable-assessment-rev3.md",
  "docs/architecture/fable-assessment-rev4.md",
  ".github/ISSUE_TEMPLATE/scoped-task.md",
  ".github/pull_request_template.md",
  "package.json",
  "package-lock.json",
  "biome.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "scripts/dev.mjs",
  "scripts/site-dev.mjs",
  "src/contracts/county-registry.ts",
  "src/services/county-registry.ts",
  "src/site/html.ts",
  "src/site/format.ts",
  "src/site/types.ts",
  "src/site/editorial-source.ts",
  "src/site/layout.ts",
  "src/site/components.ts",
  "src/site/index.ts",
  "src/site/banner.ts",
  "src/site/county-nav.ts",
  "src/site/pages/officials.ts",
  "src/contracts/officials-directory.ts",
  "src/services/officials-directory.ts",
  "tests/site-officials.test.mjs",
  "tests/officials-directory.test.mjs",
  "src/site-dev/banner-fixtures.ts",
  "tests/site-banner.test.mjs",
  "website/site/BRAND-ASSETS.md",
  "src/site/pages/home.ts",
  "src/site/pages/counties.ts",
  "src/site/county-map.ts",
  "src/site/colorado-county-map-source.json",
  "src/site/colorado-county-map.json",
  "src/site/pages/county.ts",
  "src/site/pages/directory.ts",
  "src/site/pages/person.ts",
  "src/site/pages/organization.ts",
  "src/site/pages/editorial.ts",
  "src/site/community-voices.ts",
  "tests/site-community-voices.test.mjs",
  "src/site/pages/info.ts",
  "src/site/pages/errors.ts",
  "src/site/report-interface.ts",
  "src/site/report-browser.ts",
  "src/site/staff-report-browser.ts",
  "src/site/pages/report.ts",
  "src/site/pages/staff-reports.ts",
  "src/site-dev/preview.ts",
  "src/site-dev/report-demo.ts",
  "src/site-dev/preview-data.ts",
  "website/site/site.css",
  "website/site/site.js",
  "website/site/community-voices.css",
  "website/site/report-interface.css",
  "website/site/staff-reports.css",
  "website/site/report-demo.js",
  "tests/site-fixtures.mjs",
  "tests/site-pages.test.mjs",
  "tests/site-directory.test.mjs",
  "tests/site-safety.test.mjs",
  "tests/report-interface.test.mjs",
  "docs/architecture/public-site.md",
  "docs/architecture/d1-readiness.md",
  "docs/architecture/county-identity-correction.md",
  ".openai/hosting.json",
  "wrangler.sites-test.toml",
  "scripts/build-sites-worker.mjs",
  "scripts/sites-d1-local-check.mjs",
  "src/services/d1-public-reads.ts",
  "src/services/d1-accounts.ts",
  "src/site/worker-assets.ts",
  "docs/architecture/report-interface.md",
  "scripts/editor-dev.mjs",
  "src/application.ts",
  "src/worker.ts",
  "src/contracts/runtime.ts",
  "src/contracts/banner-assets.ts",
  "src/contracts/directory.ts",
  "src/contracts/organization-profile.ts",
  "src/contracts/person-profile.ts",
  "src/contracts/sync.ts",
  "src/services/sync-planner.ts",
  "src/services/sync-commit.ts",
  "src/services/sync-planner-d1.ts",
  "src/services/sync-commit-d1.ts",
  "src/services/sync-revert-d1.ts",
  "src/services/banner-assets.ts",
  "src/services/banner-storage.ts",
  "src/services/sync-history.ts",
  "src/contracts/storage.ts",
  "src/services/index.ts",
  "src/local/storage-probe.ts",
  "src/database/sqlite.ts",
  "src/database/d1.ts",
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
  "src/account-admin.ts",
  "src/services/sites-identity.ts",
  "src/services/owner-bootstrap.ts",
  "docs/architecture/account-management.md",
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
  "tests/banner-assets.test.mjs",
  "website/migrations/0010_content_revisions.sql",
  "website/migrations/0011_m2_dependency_generation.sql",
  "website/migrations/0012_banner_assets.sql",
  "website/migrations/0013_private_report_intake.sql",
  "website/migrations/0014_owner_bootstrap_audit.sql",
  "website/migrations/0015_correct_lake_la_plata_county_names.sql",
  "website/migrations/0016_banner_homepage_curation.sql",
  "src/services/report-intake-d1.ts",
  "src/report-api.ts",
  "docs/architecture/report-api.md",
  "tests/report-api.test.mjs",
  "tests/staff-report-browser.test.mjs",
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
  "docs/architecture/banner-storage.md",
  "docs/architecture/banner-delivery.md",
  "src/services/banner-public.ts",
  "tests/banner-public.test.mjs",
  "website/migrations/0016_banner_homepage_curation.sql",
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
  "tests/sync-commit-d1.test.mjs",
  "tests/sync-history.test.mjs",
  "tests/sync-transport.test.mjs",
  "tests/security.test.mjs",
  "tests/owner-bootstrap.test.mjs",
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
  "tests/fixtures/colorado-counties-acs26.json",
  "tests/banners.test.mjs",
  "tests/r7-sync-integration.test.mjs",
  "docs/architecture/checkpoints.md",
  "docs/architecture/site-foundation.md",
  "docs/architecture/site-sync-contract.md",
  "docs/architecture/banner-inventory.md",
  "docs/architecture/d1-readiness.md",
  "docs/architecture/m2-g0-transaction-guard.md",
  "research/__init__.py",
  "research/__main__.py",
  "research/backup.py",
  "research/db.py",
  "research/intake.py",
  "research/mapping.py",
  "research/quarantine.py",
  "research/store.py",
  "research/submission.py",
  "research/sync.py",
  "research/operator.py",
  "research/identity.py",
  "research/identity_triage.py",
  "research/structure.py",
  "research/migrations/001_foundation.sql",
  "research/migrations/002_durable_site_submissions.sql",
  "research/migrations/003_site_entity_reconciliation.sql",
  "tests/__init__.py",
  "tests/research_fixtures.py",
  "tests/test_research.py",
  "tests/test_submission.py",
  "tests/test_sync_cli.py",
  "tests/r7_profiles_bridge.py",
  "tests/test_legacy_contract.py",
  "tests/test_csv_intake.py",
  "tests/test_readiness.py",
  "tests/test_quarantine.py",
  "tests/test_source_classification.py",
  "tests/test_operator.py",
  "tests/test_structure.py",
  "tests/test_identity_bootstrap.py",
  "tests/test_identity_foundation.py",
  "tests/test_identity_triage.py",
  "docs/research/identity-backlog-triage.md",
  "docs/research/R0-foundation.md",
  "docs/research/legacy-csv-compatibility.md",
  "docs/research/csv-intake.md",
  "docs/research/R1-operator-interface.md",
  "docs/research/R2-identity-bootstrap.md",
  "docs/research/R4-H1-intake-hardening.md",
  "docs/research/R5A-local-database-readiness.md",
  "docs/research/organizational-positions.md",
  "docs/research/identity-foundation.md",
  "docs/research/R6-durable-submission-client.md",
  "docs/research/R7-profiles-website-integration.md",
  "docs/research/R8-profiles-sync-operator.md",
  "docs/architecture/report-intake-d1-contract.md",
  "src/contracts/report-intake.ts",
  "src/services/report-intake.ts",
  "src/services/report-intake-memory.ts",
  "tests/report-intake.test.mjs",
  "tests/mcp-website.test.mjs",
  "tests/mcp-profiles.test.mjs",
  "tests/mcp-profiles-fixture.py",
  "src/mcp/website.ts",
  "src/mcp/profiles-stdio.ts",
  "src/services/d1-inspection.ts",
  "src/services/security.ts",
  "src/worker.ts",
  "scripts/build-sites-worker.mjs",
  "package.json",
  "package-lock.json",
  "research/__main__.py",
  "tests/mcp-profiles-fixture.py",
  "docs/architecture/mcp-administration.md",
  "tests/content-revisions.test.mjs",
  "tests/content.test.mjs",
  "tests/d1/worker.mjs",
  "scripts/d1-local-check.mjs",
  "scripts/report-demo.mjs",
]);
// Web derivatives of the owner's logo and mascot artwork: the only binary
// files allowed. Each is a small PNG; masters stay outside this repository.
const brandImages = new Set([
  "website/site/brand-logo-white.png",
  "website/site/brand-logo-white-large.png",
  "website/site/brand-mascot-standing.png",
  "website/site/brand-mascot-lying.png",
  "website/site/brand-mascot-sit-alert.png",
  "website/site/favicon-light.png",
  "website/site/favicon-dark.png",
]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const staged = process.argv.includes("--staged");
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 2 * 1024 * 1024 });
const errors = [];
const files = git("ls-files", "-z")
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const present = new Set(files);
// COORD-1: content captured while scanning tracked files, checked after the
// main loop. Keep this cheap and tied to files already read above; do not
// hardcode a commit SHA (it would fail after every normal merge).
const coord1Files = new Set([
  "docs/coordination/CURRENT.md",
  "docs/coordination/START.md",
  "docs/decisions.md",
  "AGENTS.md",
  "README.md",
  "docs/architecture/beta-2-planning-handoff.md",
]);
const coord1Content = {};
for (const required of [...allowed, ...brandImages]) {
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
  if (brandImages.has(file)) {
    const image = staged ? git("show", `:${file}`) : readFileSync(file);
    if (image.length > 96 * 1024) errors.push(`Image exceeds 96 KiB: ${file}`);
    if (!PNG_SIGNATURE.every((byte, index) => image[index] === byte))
      errors.push(`Not a PNG image: ${file}`);
    continue;
  }
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
  // Large files have scoped limits: the lockfile, bundled county geometry and
  // the repository copy of the Fable revision 4 assessment.
  const sizeLimit =
    file === "package-lock.json"
      ? 256 * 1024
      : file === "src/site/colorado-county-map.json"
        ? 1024 * 1024
        : file === "docs/architecture/fable-assessment-rev4.md"
          ? 96 * 1024
          : 64 * 1024;
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
  if (coord1Files.has(file)) coord1Content[file] = content;
}

// COORD-1 (Issue #93): cheap documentation-consistency invariants. These
// check that the shared startup path stays coherent; they do not audit
// implementation status, which belongs in CURRENT.md itself, not in this
// script.
{
  const current = coord1Content["docs/coordination/CURRENT.md"];
  const start = coord1Content["docs/coordination/START.md"];
  const decisions = coord1Content["docs/decisions.md"];
  const agents = coord1Content["AGENTS.md"];
  const readme = coord1Content["README.md"];
  if (!present.has("docs/coordination/CURRENT.md"))
    errors.push("COORD-1: docs/coordination/CURRENT.md is missing");
  if (start && !/CURRENT\.md/.test(start))
    errors.push("COORD-1: START.md does not link to CURRENT.md");
  if (start && !/decisions\.md/.test(start))
    errors.push("COORD-1: START.md does not link to decisions.md");
  if (agents && !/coordination\/START\.md/.test(agents))
    errors.push(
      "COORD-1: AGENTS.md does not point to docs/coordination/START.md",
    );
  if (current) {
    const vocabulary = [
      "planned",
      "prepared",
      "assigned",
      "merged",
      "deployed",
      "hosted-verified",
      "blocked",
    ];
    const lowerCurrent = current.toLowerCase();
    for (const word of vocabulary) {
      if (!lowerCurrent.includes(word))
        errors.push(`COORD-1: CURRENT.md is missing status word "${word}"`);
    }
  }
  // A small, intentionally narrow set of present-tense claims COORD-1
  // corrected. This is not a general prose linter.
  const obsoletePresentTense = [
    /\bthe (website|site) has not been built\b/i,
    /\bno site (is|has been) created\b/i,
    /\bmcp is (merely|just|only) an optional\b/i,
  ];
  for (const [name, content] of [
    ["README.md", readme],
    ["docs/decisions.md", decisions],
  ]) {
    if (!content) continue;
    for (const pattern of obsoletePresentTense) {
      if (pattern.test(content))
        errors.push(
          `COORD-1: obsolete present-tense claim in ${name}: ${pattern}`,
        );
    }
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

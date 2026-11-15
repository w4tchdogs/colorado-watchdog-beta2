# DEPLOY-1 deployment safety assessment

**Assessment date:** November 14, 2026 (America/Denver)

**Source assessed:** `main` at [`384a375c09360bd4dc4bff3077e6842d24bfa8f4`](https://github.com/w4tchdogs/colorado-watchdog-beta2/commit/384a375c09360bd4dc4bff3077e6842d24bfa8f4)
**Decision:** **NO-GO for deployment.** The local source is buildable and has passing disposable-D1 validation, but the platform migration execution/selection behavior and hosted D1 provenance are not established. No production change is authorized by this assessment.

## Scope and baseline

This is a read-only deployment safety assessment. It compares the current `main` source with the last verified Alpha-1 deployment and defines a procedure for a later, separately scoped deployment. It does not deploy, publish, change hosting configuration, inspect hosted D1 directly, apply a migration, provision R2, or alter live access.

At assessment time, GitHub `main` was `384a375c` (PR #106, after PR #105). PR #106 updated `CURRENT.md`; it was merged before this assessment branch was based on `main`. There was no overlapping open deployment PR. The project baseline is maintained in [CURRENT](../coordination/CURRENT.md), and the ordered goals in [ROADMAP](../coordination/ROADMAP.md).

The Sites connector was used only for read-only project/version/deployment metadata. It returned the existing Alpha-1 project, latest saved version 4, version 4's source commit `85653665761466b3ec20213091f89da890f936ed`, and a successful production deployment record for that version. Current project metadata reports the audience as **public**. The version record reports `has_mcp: false`. This confirms the saved/deployed version identity and audience metadata as observed at assessment time; it does not prove current runtime behavior or inspect D1.

| Item | Observed evidence |
|---|---|
| Sites project | `appgprj_6af7fb8f615c81918da0e4450ba336de` |
| Live URL | `https://colorado-watchdog-alpha1.futureguild2.chatgpt.site/` |
| Saved/deployed version | Version 4; successful deployment record |
| Source commit | `85653665761466b3ec20213091f89da890f936ed` |
| Configured binding in current source | `DB`; `r2: null`; MCP declared as a capability in `.openai/hosting.json` |
| Hosted D1 state | **Unknown.** No approved MCP endpoint is published/connected, and this assessment did not use direct database access. |
| Migration 0015 state | **Unknown** (not evidence of applied or unapplied) |

The saved version/source and deployment facts above are from the connected Sites version and deployment metadata, not merely the earlier `CURRENT.md` snapshot. No live visitor smoke checks or database reads were made.

## Build artifact and migration inventory

[`scripts/build-sites-worker.mjs`](../../scripts/build-sites-worker.mjs) builds `dist/server/index.js` from `src/worker.ts`, bundles the allowlisted website assets into the Worker, copies `.openai/hosting.json`, copies every filename matching `NNNN_*.sql` from `website/migrations/` into `dist/.openai/drizzle/`, and injects a catalog of each migration's version, filename and normalized SHA-256 into the Worker. It currently requires migration 0016 to be the final packaged migration. The build output contained **16 Website migrations and 12 static assets**.

The package inventory is:

| Version | Migration | Deployment-sensitive change |
|---:|---|---|
| 0001–0013 | `0001_counties.sql` … `0013_private_report_intake.sql` | Existing Website schema through private report intake |
| 0014 | `0014_owner_bootstrap_audit.sql` | Owner bootstrap audit schema |
| 0015 | `0015_correct_lake_la_plata_county_names.sql` | Corrects names at FIPS keys `08065` and `08067`, with a complete-registry assertion |
| 0016 | `0016_banner_homepage_curation.sql` | Adds `banner_assets.homepage_order` and a partial unique index |

SHA-256 values below are computed from each source file after the build's LF normalization; the same catalog is embedded in the Worker for MCP comparison with `schema_migrations`.

| Migration | SHA-256 |
|---|---|
| `0001_counties.sql` | `34afb80353f08c3b870da68749883446fa6e5117fd7a8f301ff9bd8d3d85160f` |
| `0002_foundation.sql` | `9b371a49b90b485677ff9d1cc39a5df7a8086b5b2acca01ac2d88005b2938f6a` |
| `0003_county_fips_prefix.sql` | `4ebf166ed87a8ab7dafb1e84ae61576cf7431dbb38380229c756ffa09d4d085e` |
| `0004_m1_county_roles.sql` | `605faffca42b0f283480fa45207bae171f9d8f54dadc9d9f80ed3aaa85d9d108` |
| `0005_m2_sync_batches.sql` | `51ed3d4b47691558f1304f67f5bf3fb27e4910a4cd4c4774099f1bec881c8160` |
| `0006_m2_sync_reversals.sql` | `55f66883a7321b6dcbf790c26ca3115f234e0bd491dcd5734f219d0beb61c3f8` |
| `0007_m2_duplicate_flags.sql` | `179a8e0a1116ac786c9e8eae3f165589559d3de092034dab037c21984fc6bcaf` |
| `0008_duplicate_flag_observations.sql` | `cfab25b06a5f66380b015e3d220a9984585f7dbe61b7c98ee5df82c32bd9f773` |
| `0009_content_foundation.sql` | `5e138d3f1bb94b206c90005314f085fe05b17e53e399bfe5588e0b054e8944e1` |
| `0010_content_revisions.sql` | `7f2734abe539a68a04edceb0af55bd9533510382e099cf26dc8ec111472a82ec` |
| `0011_m2_dependency_generation.sql` | `b67191a91a1a2956238aa428ed8a3387d0b869411e787a93a00c3ff82e3e804b` |
| `0012_banner_assets.sql` | `42033b6637632099fa7e65335bd18529a2f8a708c1cf66ef334d7b5649cf2083` |
| `0013_private_report_intake.sql` | `af7e9c4d8b73bade702a68385eaec8c4088467ad58f576ae40be42faa414965b` |
| `0014_owner_bootstrap_audit.sql` | `49b38ade15ca25a05b518dded687c0969625d1c7cc3b4beb807a2f873d288308` |
| `0015_correct_lake_la_plata_county_names.sql` | `5495a554e78a437076dc8be01a58d1d46ec8ec8b594290aa9c4ad5c3761ea533` |
| `0016_banner_homepage_curation.sql` | `43ce1f59250e5c9c78832467afc8440d7b373ad07818b6cf6607e67f5376e5f9` |

The checked-in migration files and worker catalog use SHA-256 over UTF-8 SQL after CRLF/CR line endings are normalized to LF. The local Website migration runner uses the same normalization in [`src/database/migrations.ts`](../../src/database/migrations.ts). Build-time catalog hashes and the app's custom migration ledger are distinct artifacts: a Sites migration may be applied outside the Worker, and the Worker does not run `migrateWebsiteDatabase` at request startup.

**Platform mechanism finding:** current public [Sites project management docs](https://learn.chatgpt.com/docs/sites/managing-a-site) describe saving a version as a buildable deployment candidate and deploying a saved version as a separate publishing step. The [publishing guide](https://learn.chatgpt.com/docs/sites/publishing-and-sharing) directs local-project users to review source changes and database migrations. I found no current official public documentation specifying whether `.openai/drizzle/` is automatically executed, whether execution is before Worker activation, whether a migration can be selected/deferred/excluded, the ledger used by the platform, atomicity across a migration file or a multi-file deployment, or how partial failure/retry is reported. The repo's existing [public-site hosting guidance](public-site.md) says included migrations are applied before uploading the Worker, but the present platform documentation located for this assessment does not substantiate that precise sequence. Treat that statement as a prior project assumption pending direct platform evidence; it is not locally tested or hosted-verified here.

Accordingly, the only verified deployment sequence is that Sites has separate save-version and deploy-version stages. **The migration step and its order relative to Worker activation are unknown.** There is no evidence that migration 0015 can be excluded safely or that an automatic application is atomic. Local Wrangler simulations do not establish any of those Sites behaviors.

## Migration 0015: data safety and hosted unknowns

Migration 0015 includes all 64 expected FIPS/name pairs and an assertion that the database has exactly 64 counties, both target FIPS keys are in one of the two accepted name states, every other expected FIPS has its exact name, and no extra FIPS exists. It accepts the known swapped Lake/La Plata pair or the already-correct pair. Any missing/extra county, changed non-target name, or third state for either target causes the SQL assertion to fail before the name updates.

It updates only `counties.name`; it leaves `counties.fips` unchanged. Website dependents use county FIPS keys and foreign keys, so retaining those keys preserves the synthetic dependent rows exercised by the tests. The migration uses a temporary name to avoid a uniqueness collision while exchanging the two names, then checks the complete final registry before dropping its temporary assertion/expected tables.

The source-level and synthetic-local safety evidence is strong for the known states:

- `tests/database.test.mjs` tests the swapped mapping with synthetic dependent organization, affiliation, editorial, banner, report and sync rows; checks all 64 final records, the prior 0001–0014 history checksums and `foreign_key_check`; and reapplies the application migration runner without changing the result.
- Tests cover already-correct full registry acceptance, unexpected non-target mapping/deletion rejection without ledger advancement, and injected failure during the swap with rollback under the SQL.js transaction runner.
- `npm run test:d1` applies source migrations 0001–0016 to disposable Wrangler local D1, including a synthetic 64-county registry. `npm run test:sites:d1` likewise provisions a disposable local D1 for the Sites Worker integration.

These checks do **not** prove Sites uses the same transaction boundary, tracks application history in `schema_migrations`, can retry a partially executed SQL file safely, or will report an uncertain commit in a way an operator can reconcile. The D1-0015-PREFLIGHT-1 limitation remains: the hosted identity, actual `schema_migrations` rows and checksums, Lake/La Plata values, complete 64-county mapping, dependent row relationships, backup and restore evidence are all unverified. The assessment cannot report 0015 as applied or unapplied. If Sites applied migrations independently, the platform migration record and the application's `schema_migrations` may be different ledgers; their relationship must be established through the accepted MCP service before migration decisions. Do not repair either ledger manually.

Before a future hosted application of 0015, the trusted, authenticated, capability-limited MCP service must establish the intended project and binding, physical database identity where the platform can prove it, exact migration names/versions/hashes, target rows, and all 64 county names. It must produce integrity/backup and tested-restore evidence sufficient to recover the same database. If identity, history, registry or platform behavior is unavailable or ambiguous, stop.

## DEPLOY-1 / MCP-2 / D1-0015 sequence

The current order is operationally unresolved:

1. MCP-2 depends on deploying a Worker that publishes the read-only MCP endpoint.
2. D1-0015 depends on MCP to perform the provenance check.
3. The current Worker build packages every migration, including 0015 and 0016. Existing project guidance asserts that Sites applies included migrations before Worker upload, but current official public docs do not verify that behavior or expose a migration hold control.
4. If Sites applies the package before activating the Worker, migration 0015 could run before the MCP provenance check. If Sites does not apply 0016 before activation, the new Worker is not demonstrated to be compatible with the old schema: `src/services/banner-public.ts` selects `banner_assets.homepage_order`, which exists only after 0016. A homepage request may therefore fail on a pre-0016 database.
5. The old deployed version's metadata reports `has_mcp: false`; there is no hosted MCP route already available in the current version. The first-owner/bootstrap and verified administrative identity conditions are also unresolved in [account management](account-management.md) and [MCP administration](mcp-administration.md).

The approved architecture offers no documented safe bypass around MCP, authenticated identity, or migration history. Do not use an unauthenticated endpoint, arbitrary SQL, Wrangler remote access, or a hand-edited migration ledger. No mechanism was established that simultaneously preserves current D1 contents, defers 0015, makes an authenticated MCP endpoint available, and keeps Worker/schema compatibility verifiable. Local tests cannot resolve this sequencing problem.

**Smallest consistent correction:** keep production deployment pending and assign a focused platform/architecture task to establish a supported migration deferral/selection mechanism and a compatible authenticated MCP bootstrap path. That task must demonstrate (with platform documentation or an approved non-production environment, not a production trial) how 0014 and 0016 can be handled, how 0015 is held until MCP provenance is complete, and how both migration ledgers reconcile. If Sites cannot support this, revise the roadmap dependency order only after an alternative MCP-first bootstrap has been proven within the binding architecture. This assessment does not reorder the roadmap speculatively.

## Candidate application and risk matrix

The deployed commit has only migrations 0001–0013; current `main` adds 0014–0016. The intervening source range contains 83 changed files (7,741 insertions, 471 deletions) and includes a new MCP service, D1 inspection/owner bootstrap, banner delivery, a 64-county map, public website routes/assets, account and report behavior, tests, and coordination/architecture material. The exact comparison is available at [GitHub compare](https://github.com/w4tchdogs/colorado-watchdog-beta2/compare/85653665761466b3ec20213091f89da890f936ed...384a375c09360bd4dc4bff3077e6842d24bfa8f4).

| Area | Assessment |
|---|---|
| D1 schema | Current Worker expects the 0016 `homepage_order` column on the banner query path; candidate schema is 16. Compatibility with the hosted database is unverified. R2 remains absent and optional; branded placeholders are intended to work without it. |
| MCP and authorization | Source declares MCP capability and implements authenticated fixed aggregate-only inspection tools. Version 4 reports no MCP. There is no current connected hosted endpoint or verified host identity. Account authorization remains default-deny; no first owner is established. |
| County data | Application source has corrected FIPS/name semantics. Hosted data/history is unknown. Public county names could remain mislabeled until 0015, depending on deployment behavior. |
| Public pages and assets | Server-rendered pages and reviewed static assets are bundled. Public and staff routes exist. Local tests exercise routes, but no candidate hosted smoke test was performed. |
| Reports and abuse control | Private report review is capability guarded; guest submission remains disabled outside test loopback. Confirm these flags/routes in the saved candidate and hosted smoke checks. |
| Banners | The Worker supports published banner reads and a homepage curation column; no R2 is provisioned. Current source documents fallback placeholders, but hosted no-R2 behavior still needs smoke verification. |
| Recovery | Sites saved versions identify source and offer version selection, but that is application rollback only. It does not restore D1. No hosted D1 backup/restore capability or tested restore is established. |

## Local validation

Checks ran in the isolated assessment worktree against disposable local resources. No local private Profiles database, banner originals or retained files were accessed.

| Check | Result |
|---|---|
| `npm ci` | Passed; lockfile dependencies installed. Node 22.21.1 emitted engine warnings because `jsdom@31.0.1` and `w3c-xmlserializer@6.0.0` specify Node 22.22.2 or later. |
| `npm run build` | Passed; produced Worker bundle, copied hosting config, 16 migrations, and 12 static assets. |
| Artifact migration inventory | Passed; source build copied numbered migrations 0001–0016, including 0015 and 0016. Source and build catalog hashes use LF-normalized SQL SHA-256. |
| `npm run test:d1` | Passed; disposable local Wrangler D1, migrations 0001–0016, synthetic county registry and 22 API checks. |
| `npm run test:sites:d1` | Passed; disposable local D1 and production-code Worker integration, 16 migrations and 64 synthetic counties. |
| `npm run test` | Passed; 402 tests, 0 failures, including migration 0015 accepted/rejected states, synthetic dependencies, failed-run rollback and repeated-run behavior in the SQL.js migration runner. |
| `npm run typecheck` | Passed. |
| `npm run format:check` | Passed (176 files). |
| `npm run lint` | Completed with 10 existing warnings in `src/services/banner-assets.ts`; no lint errors were reported. |
| `git diff --check` | Passed. |

The local D1 scripts explicitly select Wrangler `--local` and temporary persistence. They do not target hosted D1. Neither they nor the SQL.js unit tests validate Sites' migration behavior, remote transaction guarantees, Alpha-1 compatibility, backup, or restore.

## GO / NO-GO

**NO-GO for publishing current `main` to Alpha-1.** All of the following must become true before a later deployment assignment can recommend GO:

- A supported Sites migration sequence and an enforceable way to keep 0015 unapplied until provenance is complete are established.
- The authenticated MCP bootstrap is operational and confirms the exact project/database identity, full county registry, migration state and matching source checksums.
- The candidate's required schema (including 0014 and 0016) is shown compatible with the actual database, and the relationship between Sites' migration state and `schema_migrations` is reconciled.
- A database backup and tested restore path exists; its evidence and limitations are recorded. A previous Worker version is not a database backup.
- The exact source commit, built archive digest, migration manifest/checksums, target project, bindings, audience, and expected version are reviewed before deployment.
- A post-deployment read-only verification can check candidate identity, public pages/assets, database readiness, MCP authentication/authorization and expected county state without writes.

One failed or unknown condition is a NO-GO. No reasoned assumption about current D1 contents may replace these checks.

## Later deployment and recovery procedure

Use this checklist only after the blocking mechanism and hosted preflight have been established by a later scoped assignment. This document is not authorization to execute a deployment.

### Preflight

1. Read current `CURRENT.md`, `ROADMAP.md`, the latest deployment issue/PR and this assessment. Confirm no overlapping change or owner pause. Fetch `main`; record its full SHA and verify the intended PRs are merged.
2. Read `.openai/hosting.json` and use Sites read-only metadata to confirm project ID `appgprj_6af7fb8f615c81918da0e4450ba336de`, Alpha-1 title/URL, audience, `DB` binding, absent/present R2, current deployed version and deployed source commit. Stop if any differ unexpectedly. This project is currently public.
3. Build the exact pushed source commit. Record archive digest and file count, Worker path, config and each migration filename/version/SHA-256. Confirm 0015 is present in the artifact but **cannot execute before** its provenance gate. Do not silently edit or delete historical SQL to alter the artifact.
4. Through the approved authenticated MCP connection, verify Site and database identity; read the complete migration ledger and county evidence; compare all applied names, versions and checksums to repository history; confirm all 64 FIPS/name pairs and inspect provenance for `08065`/`08067`. Record unknown/unavailable fields and stop on any mismatch.
5. Reconcile the platform migration record with the app `schema_migrations` ledger. Verify the actual platform order, selectable/deferred migrations, failure reporting, transaction behavior and retry semantics from authoritative evidence. Confirm 0015 remains held until its separate preflight has passed.
6. Confirm a consistent D1 backup, its identity and digest, and a completed restore test in an isolated environment with equivalent schema and data. Record which state/configuration is not included. A saved Sites version or Worker rollback is not a D1 restore.
7. Check candidate runtime/schema compatibility. Verify migration 0016 is applied before any Worker route querying `homepage_order`; verify 0014 dependencies for owner/bootstrap behavior; confirm the 0015 gate and public route/auth/report conditions. If no safe sequence exists, stop.

### Save, deploy, verify

8. Save the exact pushed source as a Sites version and inspect its commit provenance and build result. A saved version is a candidate only; Sites documentation treats deployment as a separate production publish.
9. Reconfirm project identity and audience immediately before deployment. Deploy only that saved version using the verified migration controls and expected action recorded in the preflight. Record the version number, deployment ID, source SHA and platform migration outcomes.
10. Verify successful deployment status, live version/source identity, and read-only smoke checks: homepage, counties `08065` and `08067`, county directory/map, people/organization pages, public assets, database readiness, and expected public API behavior. Confirm no test submission or protected write. Test the authenticated MCP connection and capability denial behavior only with the approved authorized agent. Record results and timestamps.
11. Compare county aggregate/provenance output and migration history against the preflight. If behavior, counts, hashes, binding state or identity deviates, stop further activity and preserve logs/receipts. Do not run an ad hoc SQL repair or migration retry.

### Failure and recovery

12. If the Worker publish fails before any database change, record the exact failed version/deployment and determine platform state from Sites metadata. Retry only after identifying whether any migration ran.
13. If a migration partially ran, a response is uncertain, or platform and app histories disagree, treat the database as indeterminate. Do not retry 0015, alter history, or publish another version until the approved MCP inspection and recovery procedure re-establish state.
14. If only the Worker is faulty and D1 is known unchanged, a prior saved Worker version may be redeployed if the platform allows it. This restores code only; it does not undo D1 migrations or data. If D1 changed, use only the tested D1 restore procedure with a recorded consistent backup and explicit recovery scope. Recheck the restored database identity, schema, history, integrity and rows before publishing compatible code.
15. Record deployment and hosted verification separately in CURRENT. Preserve the source/build hashes, migration evidence, backup/restore result and smoke-check record.

## Blocker and next scoped work

DEPLOY-1 assessment is complete; deployment remains pending/blocked. The specific blocker is the unresolved sequence between a pre-migration authenticated MCP provenance check and a Sites publication whose artifact contains migration 0015, together with unverified hosted migration/rollback behavior and unknown D1 history. Update [CURRENT](../coordination/CURRENT.md) to record this milestone and blocker in the assessment PR. Do not reorder [ROADMAP](../coordination/ROADMAP.md) until a supported sequence is demonstrated.

The next assignment should be narrowly scoped to establishing a supported, non-production-verifiable migration gate and authenticated MCP bootstrap path, including the platform/app ledger relationship and recoverability evidence. If no such supported path exists, present the minimum architecture/roadmap change for an owner decision before any production deployment work.

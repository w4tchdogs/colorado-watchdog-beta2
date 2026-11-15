# Fable beta-2 technical assessment, revision 3

> Repository copy of "Beta 2 Technical Assessment and Architecture rev2026-11-12 v3.docx", converted to Markdown on November 14, 2026, when Google Drive was retired for coordination. The text is unchanged from the original. The original Word file is kept in the owner's local Watchdog workspace. Historical baseline, superseded by [revision 4](fable-assessment-rev4.md) where they differ.

Independent beta-1 code audit and beta-2 architecture recommendations, prepared for the owner and Archon \| Website v4. November 12, 2026 (America/Denver). Read-only analysis. Nothing was changed in source, Git, data, hosting or either Site.

**Reviewed:** D:\ChatGPT\Watchdog\colorado-watchdog, branch main, HEAD 73ef273edb9d41fa5932d40a11b08aefc34e2d9f, 52 commits, first commit November 1, 2026. The working tree has 11 modified tracked files and 15 untracked entries, and no Git remote is configured. The deployed Site (version 35) was built from c85f64e, so the checkout and the live Site differ. Status labels used below: **Source** means I read it in the code. **Reported** means it comes from a project report I did not repeat. **Docs** means current vendor documentation. **Proposal** means my recommendation.

**Revision 3** records the owner’s decision to drop WordPress. The Site will manage all posts itself (section L). Revision 2 applied the earlier directions of November 12: no added cost, no approval steps, no beta-1 data, the address that ChatGPT Sites provides, and FileZilla optional. Sections A to D are the code audit. Sections E to L are the zero-cost plan. Revisions 1 and 2 remain on file.

# A. Executive technical verdict

Beta-1 is a capable prototype built in twelve days. It became hard to operate for five architectural reasons, in order of impact.

1.  **The database is used as a document store with one global lock.** Every request that needs data runs load(), which reads every row of 24 tables into memory as JSON, and every write diffs the whole state and bumps one application-wide version (lib/repository.mjs lines 4 to 13). About forty files call it. There is no row-level update, no SQL an administrator can run, and no bulk operation. Archiving 1,423 profiles is one UPDATE statement in a normal schema. In beta-1 it needs a new deployed action, which is exactly where RC-02 stopped.

2.  **There was no ordinary way to move data in or out.** Sites has no SFTP or database console, and beta-1 built no general upload or bulk tools to make up for it. Real data was shipped by compiling encrypted snapshots into source code and deploying single-use dated routes, which are now permanent tombstones (lib/server/larimer-package.mjs, 227 KB, and app/api/county-batch-20261101/route.ts). The Worker cannot decode images, so each upload needs a 15-minute operator task run on a local machine (docs/uploaded-image-workflow.md line 3). Backups are 28 manual downloads.

3.  **Safety was built as structure instead of permission.** Thirty-three of the 37 database triggers exist to forbid update or delete, covering 16 tables including seven CSV tables. Receipts, fingerprints and leases appear throughout (the word receipt occurs 677 times under lib in the working tree). These controls protect history, and they also make correction, cleanup and retry into engineering projects.

4.  **A parallel fictional track grew beside the real path.** Ten modules totaling 192 KB (planner, fictional issuer, receipt registry, local staging, audit engine) are imported by no route. The repository holds 112 test files, while npm test runs one of them and there is no CI. Passing tests therefore say little about the deployed Site.

5.  **Coordination cost exceeded build cost.** The plan ledger has 51 batch rows in twelve days. The workspace root holds 75 status documents totaling about 1 MB, plus a 1,152-line HANDOFF.md and a 1,146-line START-HERE.md. Each AI session must read these before working, and the true state still lives in an uncommitted working tree.

**Greatest simplifications for beta-2:** a plain relational schema with real columns, upload and bulk tools built into the dashboard, one service layer used by people and AI alike, free GitHub with automated checks as the single record of work, and no approval steps, with automatic backups and undo in their place. All of this fits on ChatGPT Sites at no added cost.

**Worth keeping from beta-1:** the public interface and county artwork, the three CSV column formats and their validation rules, the FIPS master, the county-scoped matching policy with nickname matches as candidates only, the separation of private apply from public release, and the habit of proving a backup by restoring it.

# B. Actual codebase architecture map

| **Layer**            | **Location (Source)**                                                                                            | **What it does and depends on**                                                                                                                                                                                                                                                                                       |
|----------------------|------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Runtime and hosting  | .openai/hosting.json, worker/index.ts, vite.config.ts                                                            | Next.js 16 code compiled by vinext into one Cloudflare Worker, run by OpenAI Sites. Bindings: D1 DB, R2 BUCKET, capability mcp. 38 files import cloudflare:workers. 127 references to env.DB.                                                                                                                         |
| Identity             | app/chatgpt-auth.ts, lib/repository.mjs lines 15 to 26                                                           | Reads oai-authenticated-user-\* headers. ensureMember enrolls any signed-in visitor as a contributor and maps the header ID through auth_links. Roles are editor and contributor. The owner is the single ownerId in app_meta.                                                                                        |
| Domain model         | lib/model.mjs (29 KB, 135 lines)                                                                                 | One transition function with 22 action cases covers reports, reviews, merges, people and research. No archive action exists.                                                                                                                                                                                          |
| Persistence          | lib/repository.mjs, db/schema.ts, drizzle/0000 to 0014                                                           | Whole-state load and diff-commit described in section A. 39 tables. db/schema.ts declares 32 of them and the Drizzle snapshots stop at migration 0010, so the ORM schema and the real database have drifted.                                                                                                          |
| Editorial API        | app/api/workspace/route.ts                                                                                       | One route multiplexes most admin reads and writes by mode and action. Imports test fixtures (lib/fixtures.mjs) into production code.                                                                                                                                                                                  |
| CSV pipeline         | lib/research-csv.mjs, lib/server/csv-\*.mjs, app/api/csv-\*, migrations 0010 to 0014                             | Hand-written parser. Five stages (staging, comparison, row review, workbench, publication) across nine tables. Staging limit 1 MiB and 1,000 rows (lib/server/csv-staging.mjs line 7). Original files are stored as chunks inside D1. Rows are applied and published one at a time (docs/csv-publication.md line 11). |
| Earlier import paths | app/api/larimer-import, research-snapshot, county-batch-20261101, county-publication-20261101, county-import     | Four are retired with HTTP 410. They existed to carry specific data sets through a deployment.                                                                                                                                                                                                                        |
| Images               | 16 image scripts including scripts/images.mjs, public/image-files/v2, assets/image-masters                       | 1,238 generated image files and 73 master files, about 390 MB together, are committed to Git. Processing runs locally with Sharp because the Worker has no codec. Banner names follow FIPS-county-landmark.                                                                                                           |
| Backup               | app/api/operational-checkpoint, lib/server/operational-checkpoint.mjs, scripts/verify-operational-checkpoint.mjs | Owner-only JSON export plus one download per stored object, captured twice. A local script restores into SQLite and verifies hashes.                                                                                                                                                                                  |
| MCP                  | app/mcp/route.ts, lib/mcp-owner-auth.mjs                                                                         | Two tools. The owner tool is fail-closed because platform identity is unverified.                                                                                                                                                                                                                                     |
| Front end            | app/\*.tsx, components/ui, app/globals.css (79 KB)                                                               | Public pages, slideshow, directory, and one large admin component (app/workspace.tsx, 29 KB). Reusable in beta-2.                                                                                                                                                                                                     |

Code style is itself a maintenance factor. Of 6,075 lines in app and lib, 540 exceed 300 characters and 100 exceed 1,000. Diffs, reviews and line references are hard for people and for AI tools.

# C. Complexity and technical debt register

| **Issue**                                                  | **Severity** | **Source evidence**                                                                 | **Operational impact**                                                                                    | **Recommendation**                                                                                |
|------------------------------------------------------------|--------------|-------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| Whole-state load, global version, JSON rows                | Critical     | lib/repository.mjs 4 to 13. All tables are id plus data JSON (db/schema.ts line 3). | No bulk edits, no SQL administration, every write conflicts with every other, cost grows with total data. | **REPLACE** with typed tables and per-row transactions.                                           |
| Data delivered through code deployments                    | Critical     | lib/server/larimer-package.mjs. Four tombstone routes. docs/county-import.md.       | Each import was a development batch. Private data sits encrypted in Git history.                          | **RETIRE**. Use dashboard upload and API.                                                         |
| Platform identity cannot be verified                       | High         | app/chatgpt-auth.ts 21 to 39. My earlier investigation report.                      | Blocks every AI-operated admin action.                                                                    | **REPLACE** for assistants with agent keys the Site verifies. Keep Sites sign-in for the browser. |
| Immutability by trigger                                    | High         | 33 blocking triggers on 16 tables, in migrations 0001 to 0004 and 0009 to 0012.     | Failed or mistaken batches cannot be cleaned up. Restores need special handling.                          | **SIMPLIFY**. Append-only by application rule on two tables only.                                 |
| Five-stage CSV pipeline, one row at a time                 | High         | Nine csv\_\* tables. STAGING_LIMITS. docs/csv-publication.md 1 to 20.               | A 1,000-row county file needs hundreds of manual steps. Real imports stalled.                             | **REBUILD** as two tables and batch operations (section G).                                       |
| Unwired fictional modules                                  | High         | Ten lib/county-\* modules, 192 KB, no importer in app or lib/server.                | Large review effort with no production effect.                                                            | **RETIRE**. Keep the matching rules as one tested function.                                       |
| Custom receipts, fingerprints, leases, idempotency ledgers | Medium       | lib/evidence.mjs, csv_workflow\_\*, csv_row_applications.                           | Hard to reason about. Duplicates what transactions and unique indexes give free.                          | **REPLACE** with transactions, unique constraints and one audit table.                            |
| Images and derivatives in Git, local processing loop       | High         | public/image-files/v2 (1,238 files). docs/uploaded-image-workflow.md line 3.        | Slow clones and deploys. Banner upload needs a developer machine.                                         | **REPLACE** with browser-side resizing and file storage.                                          |
| Backup by manual download                                  | High         | docs/operational-checkpoint.md 9 to 11.                                             | 28 downloads and 20 minutes per checkpoint.                                                               | **REPLACE** (section I).                                                                          |
| Schema drift and no CI                                     | Medium       | db/schema.ts has 32 of 39 tables. package.json test script. No .github.             | Migrations and tests are not trustworthy signals.                                                         | **REBUILD** with generated migrations and CI on every pull request.                               |
| Uncommitted, unpushed state                                | Medium       | 26 changed entries at HEAD 73ef273. No remote.                                      | Other assistants cannot see current work. Loss risk.                                                      | **REPLACE** with GitHub as the record.                                                            |
| Documentation as state                                     | Medium       | 75 root status files, about 1 MB. 51 ledger rows.                                   | Every session pays a reading tax. Some documents name private individuals.                                | **SIMPLIFY** to a short agent guide, decision notes and issues.                                   |
| Dense single-line code and fixtures in production paths    | Medium       | Line-length figures in section B. app/api/workspace/route.ts imports fixtures.      | Low reviewability.                                                                                        | **REBUILD** with a formatter and lint rule in CI.                                                 |
| Public UI, FIPS master, CSV formats, matching policy       | None         | app/site-shell.tsx, lib/county-identifiers.mjs, lib/research-csv.mjs 5 to 7.        | Proven and approved.                                                                                      | **KEEP** and port.                                                                                |

# D. Database review and proposed schema

## D.1 Inventory of the 39 beta-1 tables

Table names and structure are **Source** (migrations 0000 to 0014). Row counts are **Reported** from RC-01 and total 7,362.

| **Table**                                                                                                   | **Rows**                   | **Purpose**                                                 | **Beta-2 disposition**                                                         |
|-------------------------------------------------------------------------------------------------------------|----------------------------|-------------------------------------------------------------|--------------------------------------------------------------------------------|
| counties                                                                                                    | 64                         | County master with FIPS.                                    | Keep. FIPS becomes the primary key.                                            |
| organizations, org_counties                                                                                 | 480, 479                   | Offices and their county link (effectively one to one).     | Keep organizations. Fold the county into a column.                             |
| people                                                                                                      | 1,427                      | Profiles. Only visibility is a real column.                 | Keep with typed columns, status and archive fields.                            |
| employment                                                                                                  | 1,773                      | Person to office affiliations.                              | Keep with typed columns.                                                       |
| research, source_mappings                                                                                   | 1,427, 1,506               | Imported source observations and external keys.             | Rebuild as observations and sources.                                           |
| merges, aliases, different_pairs, csv_identity_decisions                                                    | 2, 0, 0, 23                | Four stores for same-person and different-person decisions. | Merge into one identity_decisions table.                                       |
| csv_batches, csv_stage_rows, csv_original_chunks                                                            | 2, 28, 2                   | Staged files, rows and file bytes in D1.                    | Rebuild as import_batches and import_rows. Files live in file storage.         |
| csv_comparisons, csv_row_reviews, csv_row_applications                                                      | 34, 3, 3                   | Per-row snapshots, decisions and receipts.                  | Become columns on import_rows.                                                 |
| csv_workbench_preferences, csv_workflow_events, csv_workflow_leases                                         | 1, 0, 0                    | UI state, event log, lock.                                  | Retire.                                                                        |
| users, auth_links                                                                                           | 7, 2                       | Accounts and the Sites header mapping.                      | Keep users. Replace links with standard auth tables.                           |
| app_meta, write_guards                                                                                      | 1, 0                       | Global version and compare-and-swap helper.                 | Retire.                                                                        |
| audit                                                                                                       | 45                         | Append-only action log.                                     | Keep as audit_events.                                                          |
| workspace_preferences                                                                                       | 3                          | Per-user UI settings.                                       | Fold into a JSON column on users.                                              |
| image_jobs                                                                                                  | 0                          | Image processing ledger.                                    | Replace with assets and the shared operations table.                           |
| reports, revisions, concerns, subjects, subject_overrides, reviews, amendments, release_preparations, files | 5, 8, 9, 13, 8, 5, 0, 0, 1 | Accountability reports and editorial review.                | Later release. Articles and voices use the built-in posts feature (section L). |
| guest_credentials, private_requests, intake_limits                                                          | 0, 0, 1                    | Guest submissions and rate limits.                          | Defer with reporting.                                                          |

The lesson is not the table count. It is that 39 tables hold data as opaque JSON under one lock. The proposal below has about 17 tables with real columns, foreign keys and indexes.

## D.2 Proposed beta-2 schema (Proposal)

> counties fips PK, name, slug
>
> organizations id, county_fips FK, parent_id, name, kind, is_public, archived_at
>
> people id, display_name, given, family, nicknames JSON, visibility(private\|public),
>
> status(active\|archived), archived_at, archive_reason, merged_into_id,
>
> created_by_batch_id, attributes JSON, created_at, updated_at
>
> employment id, person_id FK, organization_id FK, county_fips FK, title, division,
>
> listing_status, start_date, end_date, is_public, observation_id,
>
> created_by_batch_id, attributes JSON
>
> sources id, title, url, source_date, checked_date
>
> observations id, batch_id, row_number, person_id, employment_id, source_id,
>
> county_fips, raw JSON, normalized JSON, fingerprint UNIQUE, private_note
>
> identity_decisions id, person_a, person_b, decision(same\|different), reason, decided_by,
>
> decided_at, supersedes_id
>
> import_formats id, version, name, columns JSON, active
>
> field_definitions key PK, label, type, applies_to, visibility, rules JSON
>
> import_batches id, county_fips, format_id, file_sha256, file_path, state, counts JSON,
>
> uploaded_by, uploaded_via, applied_at, reverted_at,
>
> UNIQUE(county_fips, file_sha256)
>
> import_rows batch_id, row_number, raw JSON, normalized JSON, issues JSON,
>
> proposed_action, match_person_id, decision, decided_by, observation_id
>
> assets id, kind, county_fips, slug, sha256, path, width, height, status, alt,
>
> attribution, replaces_id, uploaded_by, uploaded_via
>
> users id, email, name, role(owner\|editor\|viewer\|agent), active, preferences JSON
>
> api_keys id, user_id, name, key_hash, scopes JSON, expires_at, revoked_at
>
> operations id, type, state, requested_by, params JSON, result JSON, progress
>
> audit_events id, at, actor_id, action, target_type, target_id, operation_id, summary JSON
>
> checkpoints id, created_at, path, sha256, manifest JSON, verified_at, verify_result
>
> posts id, kind(article\|voice\|page), title, slug UNIQUE, body, summary,
>
> county_fips, cover_asset_id, status(draft\|published), author_id,
>
> published_at, updated_at, deleted_at
>
> post_revisions id, post_id, title, body, saved_by, saved_at

Beta-2 starts empty, so no beta-1 records or IDs are carried over. The schema is written for D1, which is SQLite: JSON columns are text checked as valid JSON, and lists are JSON arrays. Its shape is unchanged if the data ever moves to PostgreSQL. Observations and audit events are append-only by application rule. Everything else can be corrected through ordinary audited operations.

**Bulk archive** becomes one audited operation: set status to archived for every person matching a filter, in one transaction, with one audit row that records the filter and the count. Restore is the reverse.

## D.3 Adding fields without reengineering

1.  **A new optional CSV column**, for example an office phone. Add one row to field_definitions (key office_phone, type phone, applies to employment, private) and publish a new import_formats version that maps the column. No migration. The value is validated by type and stored in employment.attributes. Older 11-, 16- and 17-column files keep working because each format version is its own mapping.

2.  **A field that needs filtering or sorting**, for example an office classification. One generated migration adds a real column and copies the value out of attributes. CI applies it to a scratch database before merge.

3.  **Several affiliations or historical observations for one person.** No schema change. They are additional rows in employment and observations.

4.  **An unknown column in an uploaded file.** The import does not fail. The raw value is preserved in import_rows.raw, the preview lists it as unmapped, and an editor can map it or ignore it.

## D.4 Database technology under the zero-cost rule

| **Option**                             | **Administration and backup**                                                                             | **Fit**                                                                               | **Assessment**                                 |
|----------------------------------------|-----------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|------------------------------------------------|
| D1 on ChatGPT Sites                    | No owner console. Add a data page to the dashboard. Backup through the checkpoint operation in section I. | Included with Sites. 10 GB per Site (Docs). Handles this schema and bulk statements.  | **Recommended.** No cost and no second vendor. |
| D1 on your own free Cloudflare account | Dashboard console, command line, export.                                                                  | Same database engine, so the same schema and migrations.                              | Fallback if beta-2 leaves Sites.               |
| Free hosted PostgreSQL                 | Provider console and standard tools.                                                                      | Reachable from a Site over HTTPS only. Adds a second vendor and its free-tier limits. | Not needed.                                    |
| PostgreSQL on a free Oracle server     | Any standard client and pg_dump.                                                                          | Full control, with server upkeep and reclamation risk.                                | Only if that host is chosen.                   |

# E. GitHub collaboration at zero cost

**Plan:** GitHub Free, private repository, under a neutrally named account. The free plan includes 2,000 Actions minutes per month (Docs: GitHub plans). Protected branches and required reviewers for private repositories are listed only under the paid plans, so they cannot be enforced. That fits the direction that nothing waits for approval. Quality comes from automated checks instead.

| **Collaborator** | **Role in the zero-cost workflow**                                                                                                                                            | **Status**                                                                                     |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| Codex            | Implements features and is the only assistant that can publish to ChatGPT Sites, because publishing uses the Sites plugin tools (Source: Sites 1.1.6 SKILL.md, Publish step). | Source read. Publishing from a GitHub checkout is ordinary Git and should work. Not exercised. |
| Claude           | Implements and reviews through GitHub branches and pull requests. Operates the live Site through its API with an agent key. Cannot publish to Sites.                          | GitHub push capability seen in this session’s tools and in Anthropic documentation.            |
| ChatGPT (Archon) | Coordinates, reads the repository, and operates the live Site through the Site’s own ChatGPT plugin or the API.                                                               | Write access to GitHub unverified. Not needed.                                                 |
| Owner            | Reads issues and pull requests in the GitHub web interface when curious. Nothing requires an owner action.                                                                    | Standard.                                                                                      |

## Workflow with no approval steps

1.  One issue per feature. The issue is the complete authorization for code, tests, migrations, merge and deployment.

2.  The assistant works on a branch and opens a pull request. GitHub Actions runs type check, lint, tests, all migrations against a fresh SQLite database, and a production build.

3.  When checks pass, the assistant merges. A second assistant reviews after the fact when one is available. Review never blocks.

4.  Codex pulls main from GitHub into the Sites checkout, builds, saves a version and deploys.

5.  A smoke test calls the live API. If it fails, Codex redeploys the previous saved version. Sites keeps saved versions that can be listed and redeployed (Docs: Managing a site).

**Previews:** ChatGPT Sites has no pull-request previews. Use the local preview that the Sites tooling provides, plus CI. A second Site used as staging is free through December 31, 2026 and would count as another Site with storage afterward.

**Unverified:** whether a scheduled Codex task can run the Sites deployment tools unattended. If it can, step 4 becomes fully automatic. If not, deployment happens at the end of each Codex work session.

# F. File management without SFTP

ChatGPT Sites has no SFTP, FTP or shell, and neither does a Cloudflare account. Following direction 7, FileZilla is dropped for beta-2 on Sites and replaced by a Files page in the dashboard that does the same jobs.

| **Task you wanted in FileZilla** | **Dashboard equivalent**                                                                                                         | **Where it is stored**                             |
|----------------------------------|----------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|
| Upload county CSV files          | Drag one or many files onto the Imports page. Each becomes a batch with a validation report.                                     | Original file in R2. Rows in D1.                   |
| Upload banners and images        | Drag files or a ZIP of a folder onto the Media page. Named FIPS-county-landmark, they are assigned and catalogued automatically. | Originals and resized copies in R2. Catalog in D1. |
| Edit ordinary site content       | Write and edit posts and pages in the dashboard (section L).                                                                     | D1.                                                |
| Download exports and backups     | One Download button per checkpoint or export. Download any media folder as a ZIP.                                                | R2.                                                |
| Browse what is on the site       | Files page lists every stored object by folder, with size and date.                                                              | R2.                                                |

**Deployments cannot overwrite uploads.** Uploaded files and content live in R2 and D1. A deployment replaces only the application bundle. Beta-1 kept 390 MB of images inside the bundle, and beta-2 keeps none.

**Visible to AI:** every upload appears at once in the same API the dashboard uses, so Claude, Codex and ChatGPT see the same imports, assets and checkpoints the owner sees.

**If FileZilla matters later:** the only zero-cost host with real SFTP is a free Oracle server, which carries the risks listed in section H.

# G. CSV and media management on ChatGPT Sites

Dashboard uploads and the admin API call the same service functions. The pipeline is the one described in revision 1, adapted to what Sites provides.

| **Step**        | **What the system does**                                                                                                        | **Mechanism on Sites**                                              |
|-----------------|---------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------|
| Upload          | Accept one or many files. Store each original unchanged under its SHA-256. Confirm the county from the FIPS column.             | R2 object. Unique index on county and file hash makes retries safe. |
| Validate        | Detect the 11-, 16- or 17-column format or a newer registered version. Record every error with line and column.                 | Format definitions stored as data.                                  |
| Match           | Apply the county-scoped rules. Exact rules associate. Nickname matches are flagged as candidates. Nothing merges automatically. | One tested function. Unique fingerprint index finds duplicates.     |
| Preview         | Counts and row-level before and after.                                                                                          | Read-only query.                                                    |
| Decide          | Approve or hold rows one at a time or all clean rows at once.                                                                   | Columns on import_rows.                                             |
| Apply privately | Create people, employment and observations as private, stamped with the batch ID.                                               | D1 batch, which runs as one transaction.                            |
| Publish         | Make selected applied profiles public by batch, county or selection.                                                            | One bulk statement.                                                 |
| Revert          | Remove what a batch created if untouched since.                                                                                 | The batch stamp on each row.                                        |

- **Long jobs.** The Sites manifest offers a database, file storage and the MCP capability, with no queue. Large files are processed in steps: an operations row tracks progress and the dashboard or the calling assistant repeats one call until the job reports done.

- **Images.** The hosted Worker cannot decode images. The dashboard resizes each banner in the browser before upload and sends the original with its smaller copies. An assistant uploading through the API creates the copies in its own workspace first. This removes the local operator loop and adds no service.

- **Limits.** Beta-1 staged at most 1 MiB and 1,000 rows. Worker memory is 128 MB, so files of several megabytes are practical. The real ceiling should be measured in the first import milestone.

- **Data page.** Because Sites gives the owner no database console, the dashboard includes a table browser with filters, bulk actions, CSV export of any table, and a query box. This is what makes operations like archiving 1,400 profiles a two-click task.

# H. Hosting under the zero-cost rule

| **Criterion**               | **ChatGPT Sites (recommended)**                                                                                                                                                     | **Own Cloudflare free account**                                                                                   | **Oracle Always Free server**                                                                                                  | **Vercel Hobby with free PostgreSQL**                                    | **Free PHP hosting with WordPress**                                         |
|-----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| Cost                        | Free through December 31, 2026. From January 1, 2027 covered by the plan allowance of 125 credits on Plus, 375 on Pro, 125 per seat on Business, while usage stays under it (Docs). | Free plan: 100,000 requests per day and 10 ms of CPU per request (Docs). D1 and R2 free allowances not rechecked. | Always Free: 2 Arm cores, 12 GB memory, 200 GB disk (Docs).                                                                    | Free hobby tier, limited to personal non-commercial use (not rechecked). | Free (not rechecked).                                                       |
| Address                     | A chatgpt.site address.                                                                                                                                                             | A workers.dev address.                                                                                            | IP address only. Needs a free dynamic DNS name.                                                                                | A vercel.app address.                                                    | Host-provided subdomain.                                                    |
| GitHub deploys and previews | No direct link. Codex pulls from GitHub and publishes. No pull-request previews.                                                                                                    | Yes, with preview addresses (Reported in Archon’s plan).                                                          | Yes through Coolify (Docs).                                                                                                    | Yes, with previews.                                                      | FTP upload from a GitHub Action.                                            |
| FileZilla                   | None.                                                                                                                                                                               | None. Free S3-capable desktop clients may work with R2 (unverified).                                              | Yes, native SFTP.                                                                                                              | None.                                                                    | Yes, FTP.                                                                   |
| Database administration     | Read-only table reader in the tools. Build a data page into the dashboard.                                                                                                          | Dashboard console and command line.                                                                               | Any PostgreSQL client.                                                                                                         | Provider console.                                                        | phpMyAdmin.                                                                 |
| CSV and media               | Through dashboard and API. No image codec, so resize in the browser.                                                                                                                | Same as Sites.                                                                                                    | Full server. Sharp works.                                                                                                      | Works. Small free file storage.                                          | Through plugins.                                                            |
| Backups                     | App-built ZIP plus a free nightly GitHub Action.                                                                                                                                    | Database export by command line plus the same Action.                                                             | Self-run.                                                                                                                      | Provider dependent.                                                      | Plugin.                                                                     |
| WordPress                   | Cannot run. Not used.                                                                                                                                                               | Cannot run.                                                                                                       | Runs natively.                                                                                                                 | Cannot run.                                                              | Runs natively.                                                              |
| AI access                   | Site API with agent keys, and the Site’s ChatGPT plugin.                                                                                                                            | Site API with agent keys, plus Cloudflare API tokens.                                                             | Site API and SSH.                                                                                                              | Site API.                                                                | WordPress REST API. Some free hosts block non-browser clients (unverified). |
| Main risk                   | Metered from 2027. Traffic above the allowance is billed.                                                                                                                           | The 10 ms CPU limit may be too tight for server-rendered pages.                                                   | Idle instances may be reclaimed when CPU, network and memory stay under 20 percent for 7 days (Docs). You maintain the server. | Plan terms. Two vendors.                                                 | Reliability and limits of free hosts.                                       |

**Recommendation:** build beta-2 as a new Site on ChatGPT Sites. It is already paid for, it supplies sign-in, a database, file storage and an address, and Codex can publish to it. Its two gaps against the earlier requirements are SFTP, which direction 7 made optional, and pull-request previews, which local preview and CI replace. Beta-1’s difficulties came mostly from application design, and section C shows each can be designed out on the same platform.

**Fallback:** a free Cloudflare account of your own. Beta-2 would be the same kind of program (a Worker with D1 and R2), so it moves with one changed file for sign-in. Use it if the Sites allowance or a Sites limit becomes a problem. The CPU limit is the thing to test first.

## What zero cost means on Sites after January 1, 2027

OpenAI’s published proposed rates are 25 credits per month for each Site that has storage, 16 credits per 100,000 requests, 150 credits per GiB of database and 3.75 credits per GiB of files. A page visit typically makes 30 to 50 requests (Docs: Sites overview).

- **Plus plan, beta-2 alone:** 125 minus 25 leaves 100 credits, which is 625,000 requests, or roughly 12,500 to 20,800 page visits a month.

- **Plus plan, beta-1 kept with its storage:** 75 credits remain, which is about 469,000 requests, or roughly 9,400 to 15,600 visits.

- **Storage** at this size costs under 2 credits a month.

- **Design target:** fewer than 10 requests per page view by bundling scripts and styles and loading one banner at a time. That gives about five times the headroom.

Usage above the allowance is billed, so the dashboard should show the month’s request count against the allowance. OpenAI says per-Site usage becomes visible on December 1, 2026. I do not know which plan this workspace is on, or whether cached files count as requests.

# I. Backup and disaster recovery at zero cost

1.  **Create.** A Create checkpoint button and one API call run the same operation: export every table, list every stored file with its SHA-256, and stream a single ZIP with a manifest. Stored files change rarely, so the ZIP can include only files added since the last full checkpoint, with a full one weekly.

2.  **Nightly, automatic, off the Site.** A scheduled GitHub Actions job calls the checkpoint API with an agent key, downloads the ZIP, encrypts it with a passphrase held in Actions secrets, and stores it as a release file in the private repository. This uses the free Actions minutes.

3.  **Verify by restoring.** The same job loads the export into a fresh SQLite database, compares every row count and file hash with the manifest, and fails loudly if anything differs. D1 is SQLite, so this is a true restore test.

4.  **Report.** The job writes the result back to the Site. The dashboard shows the age of the last verified checkpoint, and a failed run opens a GitHub issue.

5.  **Before risky operations.** Every bulk change, revert and deployment takes a database checkpoint first, automatically.

**Restore:** a Restore operation loads a chosen checkpoint into a new empty Site or into the current one. Restoring is the same call for a person or an assistant. This replaces the 28-download procedure with zero manual steps.

**Unverified:** the largest ZIP a Sites Worker can stream in one response. If it is small, the checkpoint is delivered as a manifest plus a few parts, still fetched by the automated job and never by hand.

# J. Minimum release and roadmap

Beta-2 starts empty. No beta-1 data is transferred. County records arrive through real CSV imports.

**In the minimum release:** public statewide and county navigation, county personnel directory, search and filters, dashboard with bulk actions and the data page, real CSV import, identity conflict review, private apply and publish, banner upload and galleries, automated verified backup, GitHub workflow, agent keys for assistants. **Built in:** posts for articles, community voices and ordinary pages (section L). **Later:** accountability reports with editorial review, and guest submissions.

|     | **Milestone**                 | **Includes implementation, tests, corrections and deployment**                                                                                                                                                            | **Rough effort** |
|-----|-------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| M0  | Foundation                    | New Site, free GitHub repository, CI, typed schema and migrations, sign-in, agent keys, checkpoint ZIP, nightly backup job with restore test.                                                                             | 2 to 4 days      |
| M1  | Directory and administration  | Counties, offices, people and employment with typed fields. Dashboard tables with filters, bulk archive, restore and publish, audit log, data page. Public county pages, directory and search using the beta-1 interface. | About 1 week     |
| M2  | CSV import                    | The full pipeline in section G through dashboard and API, proven with real county files.                                                                                                                                  | About 1 week     |
| M3  | Media, files and posts        | Media and Files pages, browser-side resizing, galleries and rotation. Built-in posts editor for articles, voices and pages.                                                                                               | About 1 week     |
| M4  | AI tools and launch readiness | Tool endpoint for the Site’s ChatGPT plugin, usage meter against the hosting allowance, accessibility and mobile pass, restore drill.                                                                                     | 3 to 5 days      |

Effort figures are estimates for AI implementation. They are not commitments. Each milestone is one issue and one authorization.

# K. Authorization and remaining decisions

## K.1 Fully automated authorization

Per direction 3, nothing waits for an approval in beta or production. The pending-approval mechanism from revision 1 is removed.

- **Who can act.** The owner, signed in through ChatGPT sign-in, and each assistant holding its own agent key. Every one of them can perform every operation, including publish, archive, delete, restore and deploy.

- **How the Site knows who is calling.** Browser requests use the Sites sign-in identity. API requests carry an agent key that the Site checks against a stored hash. The unresolved Sites header question from my earlier report no longer blocks anything, because assistants use keys the Site verifies itself.

- **Development.** An issue authorizes the whole feature through deployment.

Removing approvals means a mistaken action takes effect at once. Protection therefore comes from being able to undo, and all of it is automatic:

- A checkpoint before every bulk change, revert and deployment.

- Delete moves records to a trash that empties after 30 days.

- Every import batch, publication and banner replacement can be reverted.

- An audit entry for every action, naming the person or assistant.

- Agent keys are named per assistant and can be revoked in one click.

The one thing undo cannot reverse is publication of private research that someone has already read. If that risk ever matters for a particular county or file, a Hold flag on the batch is the lightest control.

## K.2 What still needs you

1.  **Beta-1 after January 1, 2027.** Beta-1 will count as a second Site with storage, 25 credits a month, against the same allowance. Decide then whether to keep it.

2.  **Start.** Say when to create the beta-2 Site. Nothing else in this plan needs a decision.

# L. Posts managed by the Site

WordPress is dropped by owner decision. It cannot run inside ChatGPT Sites, and connecting an outside WordPress site would have added a second service to maintain. The Site manages articles, community voices and ordinary pages itself.

| **Capability**            | **How it works**                                                                                                                                                                                                         |
|---------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Writing                   | A Posts page in the dashboard with a visual editor: headings, bold, links, lists, quotes and images. Use an established open-source editor component. The body is saved as cleaned HTML so nothing unsafe can be stored. |
| Kinds of post             | Article, community voice, and page (About, Help, Legal and similar). One table and one editor serve all three.                                                                                                           |
| Images                    | Insert from the Media library or drag an image into the editor. It is resized in the browser and stored like any other asset.                                                                                            |
| County link               | An optional county on each post places it on that county page and in county lists.                                                                                                                                       |
| Draft and published       | Save as draft, preview exactly as visitors will see it, then publish. Unpublish returns it to draft.                                                                                                                     |
| History and undo          | Every save keeps the previous version. Any earlier version can be restored. Deleted posts sit in the trash for 30 days.                                                                                                  |
| Addresses                 | Each post gets a readable address from its title. Changing the title keeps the old address working.                                                                                                                      |
| Assistants                | The same create, update, publish and unpublish operations are in the API, so Claude, Codex and ChatGPT can draft or publish posts with their agent keys.                                                                 |
| Bringing in existing text | Paste from a document or upload a Markdown or text file to start a post.                                                                                                                                                 |
| Backup                    | Posts and their history are ordinary tables, so every checkpoint includes them.                                                                                                                                          |

This is built in milestone M3 and reuses the Media page, the audit log and the trash, so it adds one table pair and one screen. Features WordPress would have brought and that are not planned: comments, themes, plugins and multiple author roles. Any of them can be added later as its own issue.

# Evidence basis and limits

- **Read directly:** the checkout at the commit stated on page 1, both AGENTS.md files, the canonical plan, all six reference reports, Archon’s beta-2 plan, and the installed Sites 1.1.6 plugin files.

- **Not examined:** production data, hosted behavior and personnel records. Row counts are from RC-01. I did not run tests or builds.

- **Vendor facts read today:** ChatGPT Sites overview and Managing a site pages (allowance, proposed rates, limits, saved versions), Cloudflare Workers limits, Oracle Always Free resources, GitHub plans, Claude Code cloud quickstart. My reader returns summarized page text, so confirm figures on the pages before relying on them.

- **Unverified and flagged in the text:** unattended Sites deployment by a scheduled Codex task, the size of ZIP a Sites Worker can stream, the practical CSV size limit, the plan this workspace is on, and whether cached files count as requests.

- **Superseded from revision 1:** the paid server and paid GitHub recommendations, the three-tier approval model, the beta-1 data transfer, and the SFTP folder design. **Superseded from revision 2:** the WordPress options.

- **Privacy note:** several beta-1 documents name individuals whose profiles are held private. Keep those documents out of the new repository.

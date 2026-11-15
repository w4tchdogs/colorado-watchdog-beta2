# Fable beta-2 technical assessment, revision 4

> Repository copy of "Beta 2 Technical Assessment and Architecture rev2026-11-12 v4.docx", converted to Markdown on November 14, 2026, when Google Drive was retired for coordination. The text is unchanged from the original. The original Word file is kept in the owner's local Watchdog workspace. Current technical assessment.

Independent beta-1 code audit and beta-2 architecture recommendations, prepared for the owner and Archon \| Website v4. November 12, 2026 (America/Denver). Read-only analysis. Nothing was changed in source, Git, data, hosting or either Site.

**Reviewed:** D:\ChatGPT\Watchdog\colorado-watchdog, branch main, HEAD 73ef273edb9d41fa5932d40a11b08aefc34e2d9f, 52 commits, first commit November 1, 2026. The working tree has 11 modified tracked files and 15 untracked entries, and no Git remote is configured. The deployed Site (version 35) was built from c85f64e, so the checkout and the live Site differ. Status labels used below: **Source** means I read it in the code. **Reported** means it comes from a project report I did not repeat. **Docs** means current vendor documentation. **Proposal** means my recommendation. **Decided** means recorded as an owner decision in docs/decisions.md of the beta-2 repository at commit a1d6e52.

**Revision 4** brings this document in line with the owner decisions recorded in the beta-2 repository after revision 3: a separate local research database, version-checked changesets to the Site, one account model for people and AI agents, nonblocking duplicate flags, and an undecided backup destination. Sections D, E, F, G, I, J and K are rewritten and section M is new. Sections A to C are the beta-1 audit and are unchanged. Earlier revisions remain on file.

# A. Executive technical verdict

Beta-1 is a capable prototype built in twelve days. It became hard to operate for five architectural reasons, in order of impact.

1.  **The database is used as a document store with one global lock.** Every request that needs data runs load(), which reads every row of 24 tables into memory as JSON, and every write diffs the whole state and bumps one application-wide version (lib/repository.mjs lines 4 to 13). About forty files call it. There is no row-level update, no SQL an administrator can run, and no bulk operation. Archiving 1,423 profiles is one UPDATE statement in a normal schema. In beta-1 it needs a new deployed action, which is exactly where RC-02 stopped.

2.  **There was no ordinary way to move data in or out.** Sites has no SFTP or database console, and beta-1 built no general upload or bulk tools to make up for it. Real data was shipped by compiling encrypted snapshots into source code and deploying single-use dated routes, which are now permanent tombstones (lib/server/larimer-package.mjs, 227 KB, and app/api/county-batch-20261101/route.ts). The Worker cannot decode images, so each upload needs a 15-minute operator task run on a local machine (docs/uploaded-image-workflow.md line 3). Backups are 28 manual downloads.

3.  **Safety was built as structure instead of permission.** Thirty-three of the 37 database triggers exist to forbid update or delete, covering 16 tables including seven CSV tables. Receipts, fingerprints and leases appear throughout (the word receipt occurs 677 times under lib in the working tree). These controls protect history, and they also make correction, cleanup and retry into engineering projects.

4.  **A parallel fictional track grew beside the real path.** Ten modules totaling 192 KB (planner, fictional issuer, receipt registry, local staging, audit engine) are imported by no route. The repository holds 112 test files, while npm test runs one of them and there is no CI. Passing tests therefore say little about the deployed Site.

5.  **Coordination cost exceeded build cost.** The plan ledger has 51 batch rows in twelve days. The workspace root holds 75 status documents totaling about 1 MB, plus a 1,152-line HANDOFF.md and a 1,146-line START-HERE.md. Each AI session must read these before working, and the true state still lives in an uncommitted working tree.

**Greatest simplifications for beta-2:** a plain relational schema with real columns, bulk tools built into the dashboard, one service layer used by people and AI alike, research kept in a separate local database that sends only finished changes to the Site, free GitHub with automated checks as the single record of work, and no approval steps, with automatic backups and undo in their place. All of this fits on ChatGPT Sites at no added cost.

**Worth keeping from beta-1:** the public interface and county artwork, the three CSV column formats and their validation rules, the FIPS master, the principle that nickname matches are candidates only, the separation of private apply from public release, and the habit of proving a backup by restoring it.

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
| Five-stage CSV pipeline, one row at a time                 | High         | Nine csv\_\* tables. STAGING_LIMITS. docs/csv-publication.md 1 to 20.               | A 1,000-row county file needs hundreds of manual steps. Real imports stalled.                             | **REBUILD**. Parsing and screening move to local tooling. The Site gets a sync API (section G).   |
| Unwired fictional modules                                  | High         | Ten lib/county-\* modules, 192 KB, no importer in app or lib/server.                | Large review effort with no production effect.                                                            | **RETIRE**. Matching becomes evidence-based screening in local tooling (section M).               |
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

Table names and structure are **Source** (migrations 0000 to 0014). Row counts are **Reported** from RC-01 and total 7,362. No beta-1 data is carried into beta-2.

| **Table**                                                                                                   | **Rows**                   | **Purpose**                                                 | **Beta-2 disposition**                                                                                           |
|-------------------------------------------------------------------------------------------------------------|----------------------------|-------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| counties                                                                                                    | 64                         | County master with FIPS.                                    | Keep on the Site. FIPS becomes the primary key.                                                                  |
| organizations, org_counties                                                                                 | 480, 479                   | Offices and their county link (effectively one to one).     | Keep organizations on the Site. Fold the county into a column.                                                   |
| people                                                                                                      | 1,427                      | Profiles. Only visibility is a real column.                 | Keep on the Site with typed columns, status, archive fields and a row version.                                   |
| employment                                                                                                  | 1,773                      | Person to office affiliations.                              | Keep on the Site with typed columns.                                                                             |
| research, source_mappings                                                                                   | 1,427, 1,506               | Imported source observations and external keys.             | Move to the local research database. The Site keeps a public citation per role.                                  |
| merges, aliases, different_pairs, csv_identity_decisions                                                    | 2, 0, 0, 23                | Four stores for same-person and different-person decisions. | Decisions and evidence move to the local research database. The Site keeps duplicate_flags and a merge redirect. |
| csv_batches, csv_stage_rows, csv_original_chunks                                                            | 2, 28, 2                   | Staged files, rows and file bytes in D1.                    | Move to local research tooling. The Site keeps sync_batches.                                                     |
| csv_comparisons, csv_row_reviews, csv_row_applications                                                      | 34, 3, 3                   | Per-row snapshots, decisions and receipts.                  | Not needed on the Site.                                                                                          |
| csv_workbench_preferences, csv_workflow_events, csv_workflow_leases                                         | 1, 0, 0                    | UI state, event log, lock.                                  | Retire.                                                                                                          |
| users, auth_links                                                                                           | 7, 2                       | Accounts and the Sites header mapping.                      | Rebuild as accounts and identities for people and AI agents.                                                     |
| app_meta, write_guards                                                                                      | 1, 0                       | Global version and compare-and-swap helper.                 | Retire.                                                                                                          |
| audit                                                                                                       | 45                         | Append-only action log.                                     | Keep as audit_events.                                                                                            |
| workspace_preferences                                                                                       | 3                          | Per-user UI settings.                                       | Fold into a JSON column on accounts.                                                                             |
| image_jobs                                                                                                  | 0                          | Image processing ledger.                                    | Replace with assets and the shared operations table.                                                             |
| reports, revisions, concerns, subjects, subject_overrides, reviews, amendments, release_preparations, files | 5, 8, 9, 13, 8, 5, 0, 0, 1 | Accountability reports and editorial review.                | Later release. Articles and voices use the built-in posts feature (section L).                                   |
| guest_credentials, private_requests, intake_limits                                                          | 0, 0, 1                    | Guest submissions and rate limits.                          | Replace with submissions in stages B and C (section K).                                                          |

## D.2 Site database (Proposal)

**Decided:** one typed relational D1 database for the website. The table list below is my proposal for it. It is smaller than revision 3 because research, source tracking and identity analysis moved to the local database.

> counties fips PK, name, slug
>
> organizations id, county_fips FK, parent_id, name, kind, is_public,
>
> archived_at, version
>
> people id, display_name, given, family, visibility(private\|public),
>
> status(active\|archived), archived_at, archive_reason, merged_into_id,
>
> version, last_batch_id, attributes JSON, created_at, updated_at
>
> employment id, person_id FK, organization_id FK, county_fips FK, title,
>
> division, listing_status, start_date, end_date, is_public,
>
> version, last_batch_id, attributes JSON
>
> role_sources id, employment_id FK, url, title, checked_date, is_official
>
> duplicate_flags id, person_a, person_b, status(open\|dismissed\|merged), note,
>
> raised_by, raised_at, resolved_by, resolved_at
>
> sync_batches id, client_batch_id UNIQUE, account_id, state, counts JSON,
>
> applied_at, reverted_at
>
> assets id, kind, county_fips, slug, sha256, path, width, height,
>
> status, alt, attribution, replaces_id, uploaded_by
>
> posts id, kind(article\|voice\|page), title, slug UNIQUE, body, summary,
>
> county_fips, cover_asset_id, status(draft\|published), author_id,
>
> published_at, updated_at, deleted_at
>
> post_revisions id, post_id, title, body, saved_by, saved_at
>
> accounts id, kind(human\|agent), role(contributor\|editor\|administrator\|owner),
>
> display_name, email, status, preferences JSON
>
> identities id, account_id FK, provider(sites\|agent_key), subject UNIQUE, label,
>
> expires_at, revoked_at
>
> submissions id, kind, account_id, payload JSON, status, handled_by, created_at
>
> (stage B)
>
> operations id, type, state, requested_by, params JSON, result JSON, progress
>
> audit_events id, at, account_id, action, target_type, target_id, operation_id,
>
> summary JSON
>
> checkpoints id, created_at, path, sha256, manifest JSON, verified_at,
>
> verify_result

Beta-2 starts empty. The schema is written for D1, which is SQLite: JSON columns are text checked as valid JSON. Each person, office and role row carries a version number that rises on every change. A changeset quotes the version it expects, which is how the Site detects that a row changed since the local database last read it.

**Bulk archive** is one audited operation: set status to archived for every person matching a filter, in one transaction, with one audit row that records the filter and the count. Restore is the reverse.

**The local research database is separate (Decided, not built).** It runs in SQLite on the owner’s Windows computer with a proposed 19-table model: county structure (counties, org_units, org_names, role_targets, unit_coverage, source_unit_links), people and identity (research_people, name_variants, role_claims, possible_matches), sources and ingestion (sources, evidence_links, scrape_batches, research_runs, source_visits), and Site sync (site_links, sync_batches, sync_items, research_events). Its columns are not in the repository, so this document does not specify them. Raw CSV files, private notes and evidence stay there and never reach the Site or GitHub.

## D.3 Adding fields without reengineering

1.  **A new research field**, such as a source verification detail or another observation date. It is added to the local research database only. The Site does not change.

2.  **A new field that should appear on public profiles**, such as an office phone. The changeset carries it and the Site stores it in attributes, with one entry in the Site’s field list for validation and display. No migration.

3.  **A field that needs filtering or sorting**, such as an office classification. One generated migration adds a real column and copies the value out of attributes. CI applies it to a scratch database before merge.

4.  **Several affiliations for one person.** No schema change. They are additional rows in employment, each with its own source links.

## D.4 Database technology under the zero-cost rule

| **Option**                                           | **Administration and backup**                                                                             | **Fit**                                                                              | **Assessment**                                    |
|------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|---------------------------------------------------|
| D1 on ChatGPT Sites, for the website                 | No owner console. Add a data page to the dashboard. Backup through the checkpoint operation in section I. | Included with Sites. 10 GB per Site (Docs). Handles this schema and bulk statements. | **Decided** for the website.                      |
| SQLite on the owner’s Windows computer, for research | DB Browser for SQLite. A backup is a file copy.                                                           | Private research, sources and identity analysis, with no hosting limits.             | **Decided** for research. Separate from the Site. |
| D1 on your own free Cloudflare account               | Dashboard console, command line, export.                                                                  | Same database engine, so the same schema and migrations.                             | Fallback if beta-2 leaves Sites.                  |
| Free hosted PostgreSQL                               | Provider console and standard tools.                                                                      | Reachable from a Site over HTTPS only. Adds a second vendor.                         | Not needed.                                       |

# E. GitHub collaboration at zero cost

**In place (verified through Git on November 12):** the private repository w4tchdogs/colorado-watchdog-beta2 on GitHub Free, with a check workflow on pushes and pull requests and four merged pull requests. main was at a1d6e52 when this revision was written. The free plan cannot enforce protected branches on private repositories (Docs: GitHub plans), which fits the rule that nothing waits for approval.

| **Collaborator** | **Role**                                                                                                                                              | **Status**                                                                                          |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Codex            | Implements, merges, and is the only assistant that can publish to ChatGPT Sites, because publishing uses the Sites plugin tools.                      | Write access is recorded in the repository. Publishing from a GitHub checkout is not yet exercised. |
| Claude           | Implements and reviews through branches and pull requests. Will operate the live Site through its API with an agent account. Cannot publish to Sites. | Read access verified by clone and fetch. GitHub reports push permission. No push exercised yet.     |
| ChatGPT (Archon) | Coordinates and writes through its GitHub connector.                                                                                                  | A successful write through PR \#3 is recorded in the repository. I did not verify it myself.        |
| Owner            | Reads issues and pull requests when curious. Nothing requires an owner action.                                                                        | Standard.                                                                                           |

## Workflow with no approval steps

1.  One issue per feature. The issue is the complete authorization for code, tests, migrations, merge and deployment.

2.  The assistant works on a branch and opens a pull request. GitHub Actions runs the checks. Application checks are added when application code exists: type check, lint, tests, all migrations against a fresh SQLite database, and a production build.

3.  When checks pass, the assistant merges. A second assistant may review afterward. Review never blocks.

4.  Codex pulls main from GitHub into the Sites checkout, builds, saves a version and deploys.

5.  A smoke test calls the live API. If it fails, Codex redeploys the previous saved version. Sites keeps saved versions that can be listed and redeployed (Docs: Managing a site).

**Previews:** ChatGPT Sites has no pull-request previews. Use the local preview that the Sites tooling provides, plus CI. A second Site used as staging is free through December 31, 2026 and would count as another Site with storage afterward.

**Unverified:** whether a scheduled Codex task can run the Sites deployment tools unattended. If not, deployment happens at the end of each Codex work session.

# F. File management without SFTP

ChatGPT Sites has no SFTP, FTP or shell. FileZilla is optional by owner direction and is not part of the plan. Dashboard pages do the same jobs.

| **Task**                         | **Dashboard equivalent**                                                                                                                 | **Where it is stored**                             |
|----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|
| Send county research to the Site | Research CSV files stay with the local research tool. The Sync page accepts the changeset file that tool produces, with a dry run first. | Rows in D1. A batch record is kept.                |
| Upload banners and images        | Drag files or a ZIP of a folder onto the Media page. Named FIPS-county-landmark, they are assigned and catalogued automatically.         | Originals and resized copies in R2. Catalog in D1. |
| Edit ordinary site content       | Write and edit posts and pages in the dashboard (section L).                                                                             | D1.                                                |
| Download exports and backups     | One Download button per checkpoint or export. Download any media folder as a ZIP.                                                        | R2.                                                |
| Browse what is on the site       | Files page lists every stored object by folder, with size and date.                                                                      | R2.                                                |

**Deployments cannot overwrite uploads.** Uploaded files and content live in R2 and D1. A deployment replaces only the application bundle.

**Visible to AI:** every upload and every sync batch appears at once in the same API the dashboard uses.

# G. Data flow from local research to the Site

**Decided:** research, source tracking, screening and identity analysis happen in the local SQLite database. The Site receives compact, version-checked changesets through an API and assigns persistent profile IDs, and the local system keeps the mapping. Administrators may also create profiles directly. **Proposal:** the division of work below.

| **Where** | **Step**                                                                                                                                       | **Mechanism**                                                                                                                                        |
|-----------|------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Local     | Collect and parse. Read county CSV files in the 11-, 16- and 17-column formats through versioned maps. Keep every source row as its own claim. | Code, not model calls. Exact repeats of the same source row are dropped by hash.                                                                     |
| Site      | Read API. Return the directory by county in pages, with IDs and versions, and a changes-since cursor.                                          | Bounded indexed queries.                                                                                                                             |
| Local     | Screen. Compare claims with local people and with the live directory.                                                                          | The evidence standard in section M.                                                                                                                  |
| Local     | Build a changeset: create or update people, offices and roles, set visibility, attach official source links, list possible-duplicate pairs.    | A JSON file with a client batch ID and the row versions it expects.                                                                                  |
| Site      | Dry run. Report what would change and every rule the batch breaks.                                                                             | The same code path as apply, with no write.                                                                                                          |
| Site      | Apply. Write the batch, stamp the rows with it, return the new Site IDs.                                                                       | A D1 batch, which runs as one transaction. The client batch ID makes retries safe. An item whose expected version is stale is rejected and returned. |
| Local     | Record the returned Site IDs.                                                                                                                  | site_links in the research database.                                                                                                                 |
| Site      | Publish. Visibility is set by the changeset or in bulk from the dashboard.                                                                     | One bulk statement.                                                                                                                                  |
| Site      | Revert. Undo a batch whose rows are untouched since.                                                                                           | The batch stamp on each row.                                                                                                                         |

- **The Site checks rules, not research.** It confirms that the county exists, the office belongs to the county, required fields are present, values are allowed, and each role has at least one official source link. That last rule mirrors the decided standard that one verified official county webpage is enough for a profile. The Site does not parse research CSV files, run matching rules or hold identity decisions.

- **Three doors, one function.** An API call from the local tool or an assistant, a changeset file on the Sync page, and manual create or edit by an administrator all run the same service code.

- **Edits made on the Site flow back.** The local tool reads the changes-since cursor before each run, so profiles created or corrected in the dashboard are known locally.

- **Long jobs.** The Sites manifest offers a database, file storage and the MCP capability, with no queue. Large batches are processed in steps: an operations row tracks progress and the caller repeats one call until the job reports done.

- **Images.** The hosted Worker cannot decode images. The dashboard resizes each banner in the browser before upload. An assistant uploading through the API creates the smaller copies in its own workspace first.

- **Data page.** Because Sites gives the owner no database console, the dashboard includes a table browser with filters, bulk actions, CSV export of any table and a query box.

- **Unverified:** the local tool calling the Site API from the owner’s computer has not been tried, because neither exists yet. The practical batch size on Sites should be measured in milestone M2.

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

**Recommendation:** build beta-2 as a new Site on ChatGPT Sites. It is already paid for, it supplies sign-in, a database, file storage and an address, and Codex can publish to it. Its two gaps against the earlier requirements are SFTP, which the owner made optional, and pull-request previews, which local preview and CI replace. Beta-1’s difficulties came mostly from application design, and section C shows each can be designed out on the same platform.

**Fallback:** a free Cloudflare account of your own. Beta-2 would be the same kind of program (a Worker with D1 and R2), so it moves with one changed file for sign-in. Use it if the Sites allowance or a Sites limit becomes a problem. The CPU limit is the thing to test first.

## What zero cost means on Sites after January 1, 2027

OpenAI’s published proposed rates are 25 credits per month for each Site that has storage, 16 credits per 100,000 requests, 150 credits per GiB of database and 3.75 credits per GiB of files. A page visit typically makes 30 to 50 requests (Docs: Sites overview).

- **Plus plan, beta-2 alone:** 125 minus 25 leaves 100 credits, which is 625,000 requests, or roughly 12,500 to 20,800 page visits a month.

- **Plus plan, beta-1 kept with its storage:** 75 credits remain, which is about 469,000 requests, or roughly 9,400 to 15,600 visits.

- **Storage** at this size costs under 2 credits a month.

- **Design target:** fewer than 10 requests per page view by bundling scripts and styles and loading one banner at a time. That gives about five times the headroom.

Usage above the allowance is billed, so the dashboard should show the month’s request count against the allowance. OpenAI says per-Site usage becomes visible on December 1, 2026. I do not know which plan this workspace is on, or whether cached files count as requests.

# I. Backup and disaster recovery at zero cost

**Decided:** backups must cover the D1 database, the R2 files and the deployable application version, with automated encrypted off-site copies and a tested restore. **Open:** the exact no-cost destination and the schedule. Revision 3 named GitHub release files and a nightly run. Neither was approved, and both are withdrawn as fixed choices.

**Proposal:** build three parts that do not depend on where the copy ends up.

1.  **Producer on the Site.** A Create checkpoint button and one API call run the same operation: export every table, list every stored file with its SHA-256, and deliver one bundle with a manifest. The manifest records the application commit, the migration version and the row count per table, which covers the deployable application version together with Git.

2.  **Verifier.** A script loads the export into a fresh SQLite database, compares every row count and file hash with the manifest, and fails loudly if anything differs. D1 is SQLite, so this is a true restore test. It runs wherever the copy is fetched.

3.  **Destination adapter.** Four operations: put, list, get and prune. The destination is a setting. Changing it later touches neither the producer nor the verifier.

- **Quick undo copy.** Each checkpoint is also kept in the Site’s own R2 storage, and every bulk change, revert and deployment takes a database checkpoint first.

- **Local research database.** It is backed up with the same bundle format and verifier, in the same run, so Site IDs and the local mapping are captured together.

- **Scheduler.** A free GitHub Actions timer, Windows Task Scheduler on the owner’s computer, or both. This follows from the destination.

## Destination candidates at no cost

| **Destination**                   | **For**                                                                                                                        | **Against**                                                                                |
|-----------------------------------|--------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| The owner’s Windows workspace     | Private research already lives there. One local job can bundle the Site checkpoint with the research database. No new account. | Runs only when the computer is on. It is not off-site from the research database itself.   |
| The owner’s Google Drive          | Already used for project reports. Independent of both the Site and the computer.                                               | Needs a one-time connection for an automated job. Free storage is limited (not rechecked). |
| Encrypted release files on GitHub | Free scheduler and storage in one place. This was revision 3’s proposal.                                                       | Puts encrypted private data in the account that holds the code. Not approved.              |
| A second free storage account     | An independent provider.                                                                                                       | A new account, and possibly a card on file (unverified).                                   |

My leaning, which is not a decision: the Windows workspace as the first copy, plus one cloud copy. The owner chooses, because the choice sets where private data may rest.

**Restore:** one operation loads a chosen checkpoint into a new empty Site or the current one, and it is the same call for a person or an assistant. **Unverified:** the largest bundle a Sites Worker can deliver in one response. If it is small, the checkpoint comes as a manifest plus parts, still fetched by the automated job.

# J. Minimum release and roadmap

Beta-2 starts empty. County records arrive as changesets from the local research database, and administrators can add profiles by hand.

**In the minimum release:** public statewide and county navigation, county personnel directory, search and filters, dashboard with bulk actions and the data page, manual profile creation, the sync API with duplicate flags, banner upload and galleries, posts, verified backup, and accounts for the owner, administrators and AI agents. **Separate track:** the local research tooling. **Later stages:** contributors and submissions, then guest submissions and accountability reports.

|     | **Milestone**                                                   | **Includes implementation, tests, corrections and deployment**                                                                                                                                                  | **Rough effort** |
|-----|-----------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| M0  | Foundation                                                      | New Site, typed schema and migrations, accounts and identities with Sites sign-in and agent keys, one capability check, audit log, checkpoint producer and verifier.                                            | 2 to 4 days      |
| M1  | Directory and administration                                    | Counties, offices, people and roles. Manual create and edit. Dashboard tables with filters, bulk archive, restore and publish, data page. Public county pages, directory and search using the beta-1 interface. | About 1 week     |
| M2  | Sync API                                                        | Read API with versions and change cursor, changeset endpoint with dry run, batches, revert, duplicate flags and the Sync page. Proven with synthetic data.                                                      | About 1 week     |
| R   | Local research tooling (separate track on the owner’s computer) | SQLite research schema, CSV maps, source registry and visits, screening, changeset builder and Site ID mapping. Can start once M0 fixes the changeset format.                                                   | 1 to 2 weeks     |
| M3  | Media, files and posts                                          | Media and Files pages, browser-side resizing, galleries and rotation. Posts editor for articles, voices and pages.                                                                                              | About 1 week     |
| M4  | Contributors, AI tools and launch readiness                     | Stage B contributor sign-in and submissions queue, tool endpoint for the Site’s ChatGPT plugin, usage meter against the hosting allowance, accessibility and mobile pass, restore drill.                        | About 1 week     |

Effort figures are estimates for AI implementation. They are not commitments. Real county data flows only when both M2 and track R are done. Each milestone is one issue and one authorization.

# K. Accounts, authorization and remaining decisions

## K.1 One account model for people and AI

**Decided:** an early unified account and permission design for guests, contributors, editors, administrators, the owner and individually attributable AI agents. The role matrix and sign-in details still need specification. **Proposal:** an account has a kind, human or agent, and a role. An AI agent is an account with a role exactly as a person is, so every action is attributable. The schema holds the whole model from the start and capabilities are switched on in stages.

| **Role**           | **Can do**                                                                                       | **Switched on**                                       |
|--------------------|--------------------------------------------------------------------------------------------------|-------------------------------------------------------|
| Guest (no account) | Read public pages. Later, send a submission.                                                     | Reading in the first release. Submissions in stage C. |
| Contributor        | Propose profiles and corrections. See own submissions.                                           | Stage B.                                              |
| Editor             | Create and edit profiles, posts and media. Work the submissions queue.                           | First release.                                        |
| Administrator      | Everything an editor can do, plus sync, bulk actions, publish, archive, restore and checkpoints. | First release.                                        |
| Owner              | Everything, plus accounts, keys and settings.                                                    | First release.                                        |

- **Stage A, first release:** owner, administrators and agent accounts. Two small tables and no public account screens, so the first release does not grow.

- **Stage B:** contributor sign-in and one generic submissions queue.

- **Stage C:** no-account guest submissions with abuse limits, and accountability reports.

## K.2 No approval steps

- **Who can act.** The owner and administrators signed in through Sites sign-in, and each assistant through its own agent key. Under the owner’s full-automation direction, assistant accounts hold the administrator role.

- **How the Site knows who is calling.** Browser requests use the Sites sign-in identity. API requests carry an agent key that the Site checks against a stored hash.

- **Submissions are screened, staff are not gated.** Public submissions are untrusted input, so an editor or an AI agent triages them. That is content screening. It adds no approval step for staff or assistants.

Protection comes from being able to undo, and all of it is automatic: a checkpoint before every bulk change, revert and deployment, a trash that empties after 30 days, reversible batches and banner replacements, an audit entry naming the account for every action, and agent keys that can be revoked in one click. The one thing undo cannot reverse is publication of private information that someone has already read. A Hold flag on a batch is the lightest control if that risk ever matters for a particular county.

## K.3 What still needs you

1.  **Off-site backup location.** Choose from the candidates in section I.

2.  **Evidence standard for one person.** The default in section M applies unless you change it.

3.  **Contributor sign-in, before stage B.** Either contributors need a ChatGPT account, which is the only sign-in Sites provides, or the Site builds its own sign-in.

4.  **Beta-1 after January 1, 2027.** It will count as a second Site with storage, 25 credits a month, against the same allowance.

5.  **Start.** Say when to create the beta-2 Site.

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

# M. Identity across the local database and the Site

**Decided:** AI screens each upload by county and against the current directory before anything is applied. Identical repeated source rows are excluded. One identity can hold several roles. Nicknames, spelling variants, a shared department or county, and identical names are not proof of the same person. After import, possible duplicates are flagged without blocking, and AI maintenance later resolves them on evidence. Merges are never forced.

**Removed from revision 3:** the rule that an exact name, county and office match proposes an association, and the step that blocked a batch until every conflict was decided.

## Three layers that work together (Proposal)

1.  **Local, before import.** Every source row is kept as its own role claim linked to its source. Only exact repeats of the same source row are dropped. Screening attaches a claim to an existing person only when the evidence standard below is met. Otherwise it creates a new person and, where there is similarity, records a possible match with the evidence for and against.

2.  **Sync.** The changeset creates the profiles and carries the possible-duplicate pairs. The Site stores them in duplicate_flags. A flag never blocks apply or publication.

3.  **After import.** AI revisits open flags when new source visits add evidence. It then merges, or dismisses the pair as distinct and remembers that, so the pair is not raised again without new evidence.

## Evidence standard (Proposal, default until the owner changes it)

Two observations are treated as one person only when at least one of these holds:

- The same entry is observed again on the same official source.

- An official page itself connects the two names or the two roles.

- A unique contact detail published by the county, such as an email address or direct phone number, matches.

Not sufficient alone or together: an identical name, a nickname or spelling variant, the same county, the same department.

- **A wrong merge is worse than a duplicate.** Until evidence arrives, two public profiles may exist for one real person. That is the accepted cost of never forcing a merge.

- **Merges are reversible.** The merged profile keeps its ID and points to the surviving one through merged_into_id, so old links keep working and the merge can be undone.

- **Where things live.** The local research database is the record for evidence and decisions. The Site holds only the outcome: profiles, flags and redirects.

# Evidence basis and limits

- **Beta-1 audit:** the checkout at the commit stated on page 1, both AGENTS.md files, the canonical plan, all six reference reports, Archon’s beta-2 plan and the installed Sites 1.1.6 plugin files.

- **Beta-2 decisions:** the repository w4tchdogs/colorado-watchdog-beta2 at commit a1d6e52, read through Git: AGENTS.md, docs/coordination/START.md, docs/decisions.md and docs/architecture/beta-2-planning-handoff.md. Items marked Decided restate those files. Everything marked Proposal is mine.

- **Not built:** the beta-2 Site, the local research database, the sync API, the tool endpoint and the backup system. This document describes designs.

- **Not examined:** production data, hosted behavior and personnel records. The column-level design of the 19 research tables is not in the repository and was not reviewed.

- **Vendor facts** were read on November 12, 2026 through a reader that returns summarized page text. Confirm figures on the vendor pages before relying on them.

- **Unverified and flagged in the text:** unattended Sites deployment by a scheduled Codex task, the size of bundle a Sites Worker can deliver, the practical sync batch size, the local tool reaching the Site API, the plan this workspace is on, and whether cached files count as requests.

- **Superseded from revision 3:** the Site-side CSV import pipeline and its tables, the exact-name association rule, GitHub release files as the fixed backup destination, and the four-role account model.

- **Privacy note:** several beta-1 documents name individuals whose profiles are held private. Keep those documents out of the beta-2 repository.

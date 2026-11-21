# R0 — local research foundation

Implemented against [Fable architecture revision 4](../architecture/fable-assessment-rev4.md) and Profiles Coverage and Source-Intelligence v2 (a private local document in the owner's Watchdog workspace, not in this repository). Validation uses invented people, units and example.invalid URLs; Routt, Denver and Weld are conceptual mapping cases.

## Use

Requires Python 3.10+ with SQLite 3.37+, plus Node for the existing checker. No third-party Python packages.

```text
python -B -m unittest discover -s tests -v
node scripts/check.mjs
```

For a future working database, explicitly choose a path outside this checkout:

```text
python -B -m research init D:/private-research/research.sqlite
python -B -m research check D:/private-research/research.sqlite
```

The parent directory must exist. Initialization exclusively creates an empty database, refusing an existing file or a path inside the checkout. Check opens read-only. R0 tests use in-memory and temporary synthetic databases. DB Browser can inspect the ordinary SQLite file; its GUI was not exercised. External writers must enable `PRAGMA foreign_keys=ON` on every connection.

## Schema

`research/migrations/001_foundation.sql` defines the 19 domain tables:

| Area | Tables |
| --- | --- |
| County structure | counties, org_units, org_names, role_targets, unit_coverage, source_unit_links |
| People/identity | research_people, name_variants, role_claims, possible_matches |
| Sources/provenance | sources, evidence_links, scrape_batches, research_runs, source_visits |
| Future Site exchange/audit | site_links, sync_batches, sync_items, sync_submissions, research_events |

`schema_migrations` is a separate infrastructure table. Migrations are transactional and checksum-verified, normalizing LF across Windows/Linux. Unknown history, changed applied migrations, inconsistent versions and unmanaged databases are rejected. STRICT types, foreign keys, unique indexes and focused relationship constraints protect relational integrity.

County FIPS is the stable geographic key. The mapper includes the 64 public Colorado FIPS/name pairs; initialization seeds none. Entity IDs are stored text, not inferred from names. Ingestion generates UUIDs for sources/batches/runs and deterministic claim/evidence IDs within a persisted batch. Replays retain IDs; independently initialized databases need not generate identical UUIDs. Renaming a unit preserves its ID.

### Plain-language columns in DB Browser

[Migration 005](../../research/migrations/005_plain_language_profile_columns.sql)
renames all 89 columns across People, Roles, Sources and supporting records.
The table names, row values, relationships, CSV headers, and CLI/export keys stay
the same in migration 005. On schema v6, open **Browse Data** and choose
`profile_research` for **Full name** or `profile_research_role` for
**Office or department as published**, **Position as
published**, and **Job description or duties**. Quote the new column names in
queries, for example `SELECT "Full name" FROM profile_research`.

### Upgrade the working database from v5 to v6

[Migration 006](../../research/migrations/006_local_profiles_table_names.sql)
applies the [existing-object naming map](local-profiles-schema-redesign.md#existing-v5-tables-and-view).
It stops if any of the three legacy sync tables has data. The error includes the
counts for `site_links`, `sync_batches`, and `sync_items`. A successful upgrade
keeps the existing column names and the durable Website requests and receipts.

Close DB Browser and other database writers and pause any local submission
jobs. From a checkout containing the merged migration and tools, use Windows
PowerShell to create a private encrypted backup and rehearse on a fresh restore.

```powershell
$db = 'D:/ChatGPT/Watchdog/profiles/database/research.sqlite'
$backupDir = 'D:/ChatGPT/Watchdog/profiles/backups'
$tag = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backup = Join-Path $backupDir "profiles-before-v6-$tag.cwbackup"
$copy = Join-Path $backupDir "profiles-v6-rehearsal-$tag.sqlite"

python -B -m research backup $db $backup
if ($LASTEXITCODE -ne 0) { throw 'Backup failed.' }
python -B -m research restore $backup $copy
if ($LASTEXITCODE -ne 0) { throw 'Restore failed.' }
python -B -m research migrate $copy
if ($LASTEXITCODE -ne 0) { throw 'Migration rehearsal failed.' }
python -B -m research check $copy
if ($LASTEXITCODE -ne 0) { throw 'Rehearsal check failed.' }
```

The backup and restore commands report the source schema version and table
counts. Verify the source is schema v5 and the legacy tables are empty. On
the copy, expect schema version 6, integrity `ok`, and no foreign-key violations.
Compare retained counts under the [new names](local-profiles-schema-redesign.md#existing-v5-tables-and-view),
inspect `profile_research_role_selected`, and check the pending request and
receipt records if present. Use `profiles-export` with a private output path
to verify the current exporter. After verifying the rehearsal, upgrade the
working file with the same checkout.

```powershell
python -B -m research migrate $db
if ($LASTEXITCODE -ne 0) { throw 'Working database migration failed.' }
python -B -m research check $db
if ($LASTEXITCODE -ne 0) { throw 'Working database check failed.' }
```

Repeat the rehearsal checks on the working file before resuming writes.
If the upgrade fails, keep clients closed. A failed migration 006 rolls back
to v5. If the working file needs recovery, restore the encrypted backup to a
fresh private path with `python -B -m research restore`. Verify the restored
v5 file using the pre-006 checkout, set the failed file and any SQLite
sidecars aside together, then move the verified restore into the working
path. Use the pre-006 checkout with the restored working file.

### Upgrade the working database from v6 to v7

[Migration 007](../../research/migrations/007_confirmed_profiles.sql) adds the nine confirmed Profile tables and the `county_research_conclusions`, `profile_research_conclusions` and `profiles_overview` views. The result has 34 tables and four views. It changes no existing row and the new tables start empty. Rehearse first, as a separate operation from merging.

Close DB Browser and other writers and pause local submission jobs. From a checkout containing the merged migration, use Windows PowerShell:

```powershell
$db = 'D:/ChatGPT/Watchdog/profiles/database/research.sqlite'
$backupDir = 'D:/ChatGPT/Watchdog/profiles/backups'
$tag = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backup = Join-Path $backupDir "profiles-before-v7-$tag.cwbackup"
$copy = Join-Path $backupDir "profiles-v7-rehearsal-$tag.sqlite"

python -B -m research backup $db $backup
if ($LASTEXITCODE -ne 0) { throw 'Backup failed.' }
python -B -m research restore $backup $copy
if ($LASTEXITCODE -ne 0) { throw 'Restore failed.' }
python -B -m research migrate $copy
if ($LASTEXITCODE -ne 0) { throw 'Migration rehearsal failed.' }
python -B -m research check $copy
if ($LASTEXITCODE -ne 0) { throw 'Rehearsal check failed.' }
```

The backup must report schema v6. On the copy, expect schema v7, integrity `ok`, no foreign-key violations, 34 tables and four views, unchanged counts and content in every earlier table, and zero rows in the nine new tables. Then upgrade the working file with `python -B -m research migrate $db` followed by `python -B -m research check $db`, and repeat the same checks on it.

Rollback: migration 007 runs in one transaction, so a failed upgrade stays at v6. If the working file needs recovery, keep clients closed, restore the `profiles-before-v7` backup to a fresh private path with `python -B -m research restore`, and verify it with the v6 checkout (the v7 `check` rejects a v6 file). Set the failed file and its SQLite sidecars aside together, move the verified restore into the working path, and use the v6 checkout until the upgrade is repeated. Once confirmed Profiles exist, a restore to v6 loses them, so back up again before and after promotion work.

### Upgrade the working database from v7 to v8

[Migration 008](../../research/migrations/008_profiles_website_review.sql) adds
four optional fields to `profile`, an evidence-linked `profile_alternate_name`
table and the `profiles_website_review` view. It never splits or rewrites an
existing Full name. Existing components remain null and alternate names remain
empty until independently verified. The result has 35 tables and five views.

In DB Browser, open the private `research.sqlite` file, choose **Browse Data**,
then select `profiles_website_review` from the table/view picker. Each confirmed
role appears on one row. The grid contains only the eleven displayed columns;
private evidence and citation titles and URLs remain in their source tables.
The role's confirmed county supplies County. A confirmed unit supplies County
Unit and, if it has a confirmed parent chain, County Sub Unit. An office-only
role displays its office under County Unit. An unresolved parent is not guessed.
An administrative or statutory chain is a reporting path (`›`); a navigation
edge is labeled `Grouped under:` in County Sub Unit and does not assert
reporting authority.

For a new approved `profile_revisions` row, `Public revision` may include a
`website_review.roles` array. Each role object must contain `role_id`,
`county_code`, `county`, `first_name`, `middle_name`, `last_name`, `alternate_name_1`,
`alternate_name_2`, `county_unit`, `county_sub_unit`, `position` and `role`,
using the exact displayed strings and empty strings for blank cells. The view
uses `Reviewed on` from the newest matching approved or superseded revision,
as a date. If no snapshot matches the current row, Date Reviewed is blank.
This includes edits made after approval. `Promotion reviewed on` and citation
`Verified on` are separate dates. Approval snapshots stay private and do not
alter the existing Website sync sender.

Close DB Browser and all other writers. From the repository root of the merged
v8 checkout, in Windows PowerShell, use fresh private paths:

```powershell
$db = 'D:/ChatGPT/Watchdog/profiles/database/research.sqlite'
$backupDir = 'D:/ChatGPT/Watchdog/profiles/backups'
$tag = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backup = Join-Path $backupDir "profiles-before-v8-$tag.cwbackup"
$copy = Join-Path $backupDir "profiles-v8-rehearsal-$tag.sqlite"

python -B -m research backup $db $backup
if ($LASTEXITCODE -ne 0) { throw 'Backup failed.' }
python -B -m research restore $backup $copy
if ($LASTEXITCODE -ne 0) { throw 'Restore failed.' }
python -B -m research migrate $copy
if ($LASTEXITCODE -ne 0) { throw 'Migration rehearsal failed.' }
python -B -m research check $copy
if ($LASTEXITCODE -ne 0) { throw 'Rehearsal check failed.' }

python -B -m research migrate $db
if ($LASTEXITCODE -ne 0) { throw 'Working database migration failed.' }
python -B -m research check $db
if ($LASTEXITCODE -ne 0) { throw 'Working database check failed.' }
```

The backup must report v7. Compare every v7 table's rows and IDs between the
restored copy and the working file before and after migration, allowing only
the four new null `profile` columns and the new migration ledger entry. Check
the existing evidence, approvals and Website receipts specifically. Both v8
databases must report integrity `ok`, zero foreign-key violations, 35 tables
and five views; the new alternate-name table starts empty. Do not copy the
rehearsal database over the working file. Migration 008 is transactional; an
error leaves v7 intact. Preserve the encrypted backup for rollback and use
the v7 checkout to inspect any restored v7 copy.

## Mapping and provenance

`research.mapping.parse_csv` implements the report's exact ordered 17-column header as `legacy-17/v1`. It validates UTF-8/BOM, exact header/width, CSV quoting, county/FIPS agreement, published name, Listed in official source/Explicitly former/Unclear legacy status, HTTP(S) URLs without credentials, source-date precision and full checked dates. Blank titles and dates remain unknown. Source wording, grouping basis, names and notes remain unchanged. Grouping basis validates Official county structure, Directory display fallback and Needs editorial review. Source-specific display labels remain verbatim because supported source groupings vary. The legacy status Listed in official source maps explicitly to the internal Listed enum; raw evidence retains the exact legacy value. No migration or rewrite of existing observations is needed.

Explicit `MappingSpec` registration supports future 11/16-column mappings. Their actual legacy contracts are not asserted or implemented here; tests use synthetic extension maps. Width is never guessed, mapping versions cannot be replaced, and replay rejects changed definitions under an existing version.

`research.store.ingest_csv` transactionally maps one county delivery. Evidence retains all original fields, header, exact record text, physical line spans, logical record numbers, file hash, filename, mapping and delivery versions. Only complete equal parsed rows within one delivery coalesce, preserving every duplicate occurrence and locator. Any changed field, including a private note, remains distinct. Different versions are not globally collapsed. The file hash establishes delivery integrity, not webpage freshness.

Claims start unassigned to people/units for later evidence-led screening; labels never become inferred hierarchy. Checked dates remain observation metadata, not successful visits or employment dates. Unknown source-version keys, discovery/fetch times, HTTP status, actor, duration and page hashes remain null. Zero-yield sources are first-class registry records. Explicit reconstructed visits preserve known outcomes, such as blocked, without inventing other telemetry.

## Structure, lineage and identity

- A source represents its exact original URL; evidence preserves the observed title, URL, source date/precision/basis and optional source-version key. URL identity, source version and delivery version are separate. Redirect/alias reconciliation is future work.
- Original and complementary deliveries have independent families. Corrected/alternative deliveries reference a same-county parent in the same family. Only one family member can be selected. `profile_research_role_selected` avoids additive counting of alternate versions while keeping historical claims. Selection changes are transactional; replay does not reselect an old version.
- Corrections use explicit record-to-parent-claim mappings. The tool never guesses that row N in another version is the same observation. Replay cannot silently change lineage.
- Units have one current evidenced parent edge: administrative, statutory or navigation. Cross-county parents, cycles and reporting authority through navigation containers are rejected. `set_parent` transactionally records old/new edges and evidence in `research_history`. This is an initial tree model, not a complete temporal organizational graph.
- Structure, leadership, named_staff and positions have independent coverage rows. Reviewed does not mean exhaustive. Position occupancy defaults to unknown; explicit vacancy requires evidence.
- People can hold several roles. Possible-match pairs are unique and county-scoped. Resolution needs evidence and a supported decision basis; recording it never merges/deletes people. R0 records decisions, but does not perform AI screening or verify a citation's truth. Direct SQL changes are not automatically audited; use the provided transactional operations where available.
- Site tables are forward-compatible scaffolding, empty after mapping. They represent external IDs, expected/result versions, client batch IDs and future receipts, with basic update preconditions. The durable local submission client stores an exact prepared Website request, canonical fingerprint and idempotency key before transport; only an injected transport is supported. See [R6 durable submission client](R6-durable-submission-client.md). No production transport or remote-version verification is enabled.

## Verification and continuation

38 deterministic tests cover migration rollback/history, disk reopen and ID preservation, CLI read-only checks and existing-file protection, foreign keys, uniqueness, strict types, malformed mappings, quoted/multiline records, partial dates, complete-row deduplication, replay, null telemetry, hierarchy, independent coverage, possible matches, multi-role identities and future sync preconditions. CI runs the same suite on its existing Ubuntu runner alongside the preserved source checker.

Routt fixtures exercise parent/subunit relationships and uncertain telemetry; Denver fixtures exercise appointed/navigation distinctions and complementary deliveries; Weld fixtures exercise nonadditive display corrections. These are invented mapping patterns, not real county validation.

Next useful work: a bounded local operator interface for evidence-led person/claim association, source visits and coverage changes with transactional audit; then exact 11/16 mappings from authoritative contracts. Real intake, source fetching, AI screening, backups, multi-client concurrency, richer temporal relationships and Site exchange remain future implementation/testing work.

## R0 legacy-contract follow-up

The merged foundation was checked against the consolidated legacy reference. This follow-up corrects the Elbert/El Paso FIPS association, accepts the exact source-listing status, and rejects unsupported grouping-basis values before writes. It preserves the original migration checksum and raw source fields. Five regression tests extend the suite to 43 passing tests, including rejection without partial ingestion. Database contents remain synthetic only.

## R3 legacy CSV compatibility

The historical 11- and 16-column beta-1 contracts are now implemented as explicit `legacy-11/v1` and `legacy-16/v1` mappings. See the [compatibility guide](legacy-csv-compatibility.md) for the evidence, exact crosswalk, validation behavior, and limitations. The existing `legacy-17/v1` mapping and migration checksum remain unchanged.

## Statewide organizational and position foundation

The reusable evidence-led planner and transactional operator are documented in [organizational-positions.md](organizational-positions.md). It reuses the existing schema and migration, preserves source/version history, and has a private inspectable preview plus idempotent apply and verification commands. Tests use only synthetic evidence; a separately authorized local execution may apply the reviewed preview to the permanent Profiles database.

The county-scoped evidence-based people and identity planner reuses the same database and is documented in [identity-foundation.md](identity-foundation.md). It preserves uncertain claims, uses direct official evidence for associations, and does not infer identity from names or roles alone.

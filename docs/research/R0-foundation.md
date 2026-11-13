# R0 — local research foundation

Implemented against [Fable architecture revision 4](https://drive.google.com/file/d/1ux9NG09zr9DkztRGYtc-Z3uXBZ81ncI0/view) and [Profiles Coverage and Source-Intelligence v2](https://drive.google.com/file/d/1se6iAtL8czdLnV-AjvKAezSmYV0ayHKn/view). Validation uses invented people, units and example.invalid URLs; Routt, Denver and Weld are conceptual mapping cases.

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

## Mapping and provenance

`research.mapping.parse_csv` implements the report's exact ordered 17-column header as `legacy-17/v1`. It validates UTF-8/BOM, exact header/width, CSV quoting, county/FIPS agreement, published name, Listed in official source/Explicitly former/Unclear legacy status, HTTP(S) URLs without credentials, source-date precision and full checked dates. Blank titles and dates remain unknown. Source wording, grouping basis, names and notes remain unchanged. Grouping basis validates Official county structure, Directory display fallback and Needs editorial review. Source-specific display labels remain verbatim because supported source groupings vary. The legacy status Listed in official source maps explicitly to the internal Listed enum; raw evidence retains the exact legacy value. No migration or rewrite of existing observations is needed.

Explicit `MappingSpec` registration supports future 11/16-column mappings. Their actual legacy contracts are not asserted or implemented here; tests use synthetic extension maps. Width is never guessed, mapping versions cannot be replaced, and replay rejects changed definitions under an existing version.

`research.store.ingest_csv` transactionally maps one county delivery. Evidence retains all original fields, header, exact record text, physical line spans, logical record numbers, file hash, filename, mapping and delivery versions. Only complete equal parsed rows within one delivery coalesce, preserving every duplicate occurrence and locator. Any changed field, including a private note, remains distinct. Different versions are not globally collapsed. The file hash establishes delivery integrity, not webpage freshness.

Claims start unassigned to people/units for later evidence-led screening; labels never become inferred hierarchy. Checked dates remain observation metadata, not successful visits or employment dates. Unknown source-version keys, discovery/fetch times, HTTP status, actor, duration and page hashes remain null. Zero-yield sources are first-class registry records. Explicit reconstructed visits preserve known outcomes, such as blocked, without inventing other telemetry.

## Structure, lineage and identity

- A source represents its exact original URL; evidence preserves the observed title, URL, source date/precision/basis and optional source-version key. URL identity, source version and delivery version are separate. Redirect/alias reconciliation is future work.
- Original and complementary deliveries have independent families. Corrected/alternative deliveries reference a same-county parent in the same family. Only one family member can be selected. `selected_role_claims` avoids additive counting of alternate versions while keeping historical claims. Selection changes are transactional; replay does not reselect an old version.
- Corrections use explicit record-to-parent-claim mappings. The tool never guesses that row N in another version is the same observation. Replay cannot silently change lineage.
- Units have one current evidenced parent edge: administrative, statutory or navigation. Cross-county parents, cycles and reporting authority through navigation containers are rejected. `set_parent` transactionally records old/new edges and evidence in research_events. This is an initial tree model, not a complete temporal organizational graph.
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

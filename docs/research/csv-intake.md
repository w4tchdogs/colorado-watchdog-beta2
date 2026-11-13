# Local CSV intake

R4 adds a two-step command-line workflow over the existing R0–R3 mappings and SQLite database. Preview reads the selected CSV and database without writes. Intake revalidates the file and current database state, then calls the existing transactional `research.store.ingest_csv()` operation. It does not fetch source URLs or create identities.

## Supported mappings

Choose one mapping explicitly with `--version`:

- `legacy-11/v1`
- `legacy-16/v1`
- `legacy-17/v1`

No version is inferred from file width, filename, or a similar header. Exact columns, historical county-name behavior, field limits, status and date rules are in the [legacy compatibility guide](legacy-csv-compatibility.md).

The examples below assume a synthetic `synthetic-example.csv` containing one invented row, for example:

```csv
County FIPS,County,Full name,Nicknames,Display group (proposed),Grouping basis,Department / office,Division / unit,Program / location,Position / title,Other documented responsibility,Listing status,Official source title,Official source URL,Source date,Checked date,Private review note
08107,Routt,Synthetic Riley Example,,Illustrative group,Official county structure,Fixture Office,Fixture Division,Fixture Program,Fixture Coordinator,Invented responsibility,Listed in official source,Synthetic official directory,https://example.invalid/routt/synthetic,2025-03,2026-11-13,SYNTHETIC ONLY
```

## Preview

```powershell
python -B -m research preview-csv "D:/private-research/research.sqlite" `
  --file "D:/private-research/synthetic-example.csv" `
  --version legacy-17/v1 `
  --version-label synthetic-example-v1 `
  --lineage-kind original `
  --provenance synthetic
```

The database must already exist outside the source checkout and have the current, checksum-valid migration history. Preview opens it in read-only mode. It does not run migrations or create database/journal sidecar files. To guarantee that preview never touches SQLite auxiliary files, WAL-mode databases are refused; switch to the standard rollback-journal mode before preview. Diagnostics do not include row content, source URLs, or private notes. `--max-errors` controls the diagnostic cap (default 100; maximum 500).

The JSON result includes mapping version, file name/hash/size, column count and exact header-match state, canonical county FIPS/name when determinable, total/valid/invalid record counts, exact-row duplicate count, expected distinct claims, source metadata counts, proposed lineage and selection choice, replay state, bounded errors/warnings, and `eligible`. Each record diagnostic carries its logical record number, physical line span when known, field, category and a sanitized message. Header/CSV structure errors are delivery-level diagnostics.

Preview does not reveal data values. To compare an existing delivery's full metadata, include `--version-label`; without it, matching bytes are reported as a replay candidate because the version label cannot be compared.

## Intentional commit

```powershell
python -B -m research intake-csv "D:/private-research/research.sqlite" `
  --file "D:/private-research/synthetic-example.csv" `
  --version legacy-17/v1 `
  --version-label synthetic-example-v1 `
  --lineage-kind original `
  --provenance synthetic `
  --expect-sha256 PREVIEW_SHA256 `
  --commit
```

`--commit` is mandatory. Commit requires an explicit mapping version, version label and lineage kind. The source filename is recorded from the selected input file's basename. `--expect-sha256` is optional; replace `PREVIEW_SHA256` with the hash returned by preview. When supplied, the command stops before database writes if the file hash differs. The CSV, mapping, database migration history, lineage and replay checks are run again at commit time.

`--select` explicitly selects a newly created delivery in its version family. Without it, the delivery is left unselected. A replay never changes selection, even if `--select` is supplied on the retry. Complementary deliveries remain separate additive families; corrected and alternative deliveries remain nonadditive family members.

For corrected or alternative deliveries, specify `--parent-batch-id`. To record known claim corrections, pass a JSON object mapping CSV record numbers to parent claim IDs, for example a synthetic `supersedes.json` containing `{"1":"claim_fixture_parent_1"}` and use `--supersedes-json "D:/private-research/supersedes.json"`. R4 never guesses row correspondence. Correction links may be omitted when no explicit claim correspondence is known, consistent with the existing store API. A supplied link must identify a claim in the same-county parent delivery. Original and complementary deliveries cannot have a parent or correction links.

The commit JSON reports `created` or `replayed`, batch and family IDs, mapping version, input hash, county FIPS, logical row count, distinct claims, duplicate rows, lineage, parent and actual selected state. Exact replay returns its original batch ID and creates no new sources, claims, runs or events. Different metadata for the same county/hash/mapping version is rejected.

## Exit codes and limits

- `0`: eligible preview or newly committed delivery.
- `1`: preview completed but found an invalid/ineligible file or lineage.
- `2`: command/commit failure, malformed arguments, database problem, or expected-hash mismatch.
- `3`: the requested delivery was already committed and recognized as a replay.

The database is never created or initialized by these commands. Preview and commit process one explicit CSV file per invocation. Invalid rows prevent commit of the delivery; the operator must correct the source file or choose a verified mapping before retrying. Source URLs are required by the current schema. No application, web service, automatic identity matching, organizational inference, visit creation, or migration is part of R4.

All documented filenames, labels, IDs, and URLs in examples are synthetic. The automated tests create temporary SQLite files and use `example.invalid` sources only.

For rejected-original quarantine, county-registry preflight and explicit source classification, see the [R4-H1 hardening guide](R4-H1-intake-hardening.md).

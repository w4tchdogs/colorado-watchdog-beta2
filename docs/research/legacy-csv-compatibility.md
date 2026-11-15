# Legacy research CSV compatibility

R3 adds explicit `legacy-11/v1` and `legacy-16/v1` mappings alongside the unchanged `legacy-17/v1` mapping. The beta-1 code calls the older headers `RESEARCH_CSV_COLUMNS` and `RESEARCH_EXTENDED_COLUMNS`; those names did not include formal version numbers. The beta-2 version identifiers are immutable registry keys for these verified header contracts.

## Verification sources

- Beta-1 committed parser, `lib/research-csv.mjs` at commit `357281604ec2845cb37f525ff6dc93d409583846` in the separate read-only beta-1 checkout: exact 11- and 16-field header constants (lines 5–6), exact ordered-header acceptance (line 29), BOM removal and parser/preview validation. R3 did not modify beta-1.
- Beta-1 `docs/research-csv.md`, “Additional supplied county lists — October 31, 2026,” lines 204–207: describes the expanded 16-column header and says the 11-column contract remains supported. It corroborates that the two exact parser layouts are historical formats, rather than width-based guesses.
- Beta-1 `lib/county-identifiers.mjs`, `countyNameMatches` and `resolveResearchCounty`: five-character FIPS validation plus NFKC, trim, whitespace-collapse and case-insensitive matching against the county name, official name, or county name without the ` County` suffix. For Denver and Broomfield this includes “City and County of …”.
- [Fable architecture v4](../architecture/fable-assessment-rev4.md) says the three beta-1 CSV formats and their validation rules are worth preserving. Profiles Coverage and Source-Intelligence Report v2 (a private local document in the owner's Watchdog workspace, not in this repository) documents the 17-column contract; it was not used as proof of either earlier header.

The historical source does not assign formal version identifiers to the 11- and 16-column layouts. `legacy-11/v1` and `legacy-16/v1` are beta-2 registry identifiers, not claims about beta-1 naming.

## Exact ordered columns and crosswalk

| # | `legacy-11/v1` | `legacy-16/v1` | R0 destination |
| --- | --- | --- | --- |
| 1 | County FIPS | County FIPS | `county_fips`, checked against the public FIPS map |
| 2 | County | County | checked against FIPS; original cell stays in raw evidence |
| 3 | Full name | Full name | `published_name`; no person identity is created |
| 4 | Department / office | Display group (proposed) | 11: `department_label`; 16: `legacy_display_group` |
| 5 | Position / title | Grouping basis | 11: `published_title`; 16: `grouping_basis` |
| 6 | Listing status | Department / office | 11: `source_listing_status`; 16: `department_label` |
| 7 | Official source title | Division / unit | 11: `observed_title`; 16: `division_label` |
| 8 | Official source URL | Program / location | 11: source and evidence URL; 16: `program_location` |
| 9 | Source date | Position / title | 11: source date with reported precision; 16: `published_title` |
| 10 | Checked date | Other documented responsibility | 11: reported checked date; 16: `responsibility` |
| 11 | Private review note | Listing status | 11: `private_note`; 16: `source_listing_status` |
| 12 | — | Official source title | `observed_title` |
| 13 | — | Official source URL | source and evidence URL |
| 14 | — | Source date | source date with reported precision |
| 15 | — | Checked date | reported checked date |
| 16 | — | Private review note | `private_note` |

Values absent from a format remain `None` in its normalized mapping. Every supplied cell remains in the raw evidence JSON with the exact header, cell text, row text and line locator. Display groups and organizational labels do not create units or parent relationships. Nicknames are absent in both formats and are not inferred from names.

## Validation and field semantics

- Headers must exactly equal the selected ordered header. The parser accepts UTF-8 with an optional BOM and quoted CSV fields, including embedded newlines. There is no automatic selection by width or header guessing.
- Beta-1 trims surrounding whitespace from the common 11 semantic fields before validation. R3 does the same for mapped values while retaining every original cell and row unchanged in evidence. The additional 16-column context fields remain verbatim.
- FIPS is an approved five-character Colorado code including its leading zero. County text follows the historical beta-1 name/official-name matching rule; it must match that FIPS. The 17-column mapping retains its original exact canonical-name check.
- Full name is required (maximum 200 characters). Department and title are optional (maximum 200 each). Source title is optional (maximum 2,000). Private note is optional (maximum 8,000). The four 16-column context fields—display group, grouping basis, division, and program/location—and responsibility are retained as supplied (maximum 2,000 each). The 11-column grouping-basis field is absent.
- Listing status is required and must be exactly `Listed in official source`, `Explicitly former`, or `Unclear`. The internal `Listed` value is still assigned only by R0's existing explicit normalization.
- Source URL is required for R0 ingestion and must be an HTTP(S) URL without embedded credentials (maximum 2,000 characters). A source title may be blank; a missing URL cannot produce the source/evidence pair required by the existing schema and is rejected before writes.
- Source date is optional and accepts `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`; its precision is recorded as year, month, or day. Checked date is optional and accepts only `YYYY-MM-DD`. Neither date implies employment dates or a successful visit.
- Beta-1's preview accepts grouping-basis wording as raw text rather than applying the later R0 enum check. The 16-column mapping preserves that exact wording; it does not impose the 17-column PR #9 grouping-basis categories.
- The status and date rules above follow beta-1 `lib/research-csv.mjs` and `lib/research-records.mjs`. Empty title, department, date, and note values remain empty in raw cells; existing R0 storage converts only its already-defined nullable fields as before.

## Import and limitations

Select a mapping explicitly when calling `research.store.ingest_csv`, for example `version="legacy-11/v1"` or `version="legacy-16/v1"`. The existing default remains `legacy-17/v1`. Mapping headers, fields, and policy are persisted with the delivery; replay rejects a changed definition under the same mapping version. Raw CSV hashes, delivery lineage, duplicate handling, corrections, complementary batches, rollback, and source/evidence provenance use the existing R0 path.

No database migration is required. The mappings do not create people, infer organizational hierarchy, create source visits, or treat a checked date as fetch telemetry. R4 adds a separate explicit CLI preview and intake workflow; see the [operator guide](csv-intake.md). Direct Python callers can also use the existing ingestion API with an explicitly selected version.

Synthetic regression coverage is in `tests/test_research.py`, including exact layouts, field semantics, county aliases, validation failures, preserved raw evidence, replay, corrected and complementary lineage, and rollback. All fixtures use fictional names and `example.invalid` URLs.

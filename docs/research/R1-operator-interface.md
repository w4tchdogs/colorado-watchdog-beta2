# R1 local research operator interface

R1 adds bounded, JSON-producing local operations over the R0 SQLite schema. It does not fetch sources, infer identities, merge people, or change the website. Python 3.10+ and the R0 SQLite requirements apply; no third-party package is needed.

## Database path and setup

Always pass an explicit database path outside the repository. `init` exclusively creates a new file and refuses to overwrite an existing file. All other commands require an existing database. `check` and inspection commands open SQLite in read-only mode.

```powershell
python -B -m research init D:/private-research/research.sqlite
python -B -m research check D:/private-research/research.sqlite
```

## Read-only inspection

All inspection commands return predictable JSON and accept `--limit` (1–200). Result ordering is stable by county and ID, except events/visits which are newest first. Filters are optional.

```text
python -B -m research counties DB [--county FIPS] [--limit N]
python -B -m research units DB [--county FIPS] [--unit-id ID] [--limit N]
python -B -m research people DB [--county FIPS] [--person-id ID] [--limit N]
python -B -m research claims DB [--county FIPS] [--claim-id ID] [--status Listed|Explicitly former|Unclear] [--unassigned] [--limit N]
python -B -m research unassigned DB [--county FIPS] [--limit N]
python -B -m research sources DB [--county FIPS] [--source-id ID] [--limit N]
python -B -m research matches DB [--county FIPS] [--status open|same_supported|different_supported] [--person-id ID] [--limit N]
python -B -m research coverage DB [--county FIPS] [--unit-id ID] [--axis structure|leadership|named_staff|positions] [--status STATUS] [--limit N]
python -B -m research events DB [--run-id ID] [--entity-type TYPE] [--entity-id ID] [--kind KIND] [--limit N]
```

`people` includes their associated role claims. `sources` includes evidence metadata and visit telemetry, but omits raw evidence, quotations, and private review notes. `events` decodes the recorded detail JSON and is the explicit audit inspection operation. Neither inspection nor `check` changes rows, timestamps, journals, or database contents.

## Evidence-led claim association

The operator supplies an existing unassigned claim, existing person, evidence ID, rationale, and actor:

```text
python -B -m research associate-claim DB --claim-id CLAIM --person-id PERSON --evidence-id EVIDENCE --rationale "Why this cited record establishes the link" --actor "operator-id"
```

The person and claim must be in the same county. The supplied evidence must already be linked through `name_variants` to that person and the claim's exact published name, identify an official source, and come from the same source record as the claim. The person choice is always explicit. R1 does not use name similarity, nicknames, departments, titles, or county to choose a person. A successful operation creates an attributable screening run and a transactional `research_events` entry; it changes only `role_claims.person_id`. Original names, raw CSV evidence, source links, and prior events remain intact. Unsupported links fail without partial writes.

## Source visit or attempt

Record an observed attempt, a source-supported reconstruction, or a synthetic fixture. No HTTP request is made.

```text
python -B -m research record-visit DB --source-id SOURCE --run-id RUN --provenance observed --outcome blocked --actor "operator-id"
```

Outcomes are `success`, `not_modified`, `blocked`, `failed`, and `not_found`. A successful zero-yield visit uses `--outcome success --result-count 0`. Supply telemetry only when known; omitted timestamp, HTTP status, duration, hash, ETag, Last-Modified, attempt number, and result count remain null. A reconstructed visit requires `--evidence-id`, and that evidence must belong to the selected source. A historical checked date is stored as reported metadata and does not establish an HTTP outcome.

## Independent coverage update

Update one axis per command. A research run is always required for the audit event; non-`not_started` statuses also require supporting evidence.

```text
python -B -m research set-coverage DB --unit-id UNIT --axis leadership --status partial --evidence-id EVIDENCE --run-id RUN --actor "operator-id" --rationale "Scope reviewed and remaining work"
```

Statuses are `not_started`, `partial`, `reviewed`, `stale`, and `blocked`. The operation writes only the chosen axis, includes before/after state, evidence, run, actor, and rationale in `research_events`, and leaves the other axes unchanged. `reviewed` is not exhaustive coverage, and unknown occupancy is not vacancy.

The same operations are available as reusable functions in `research.operator` (`inspect_counties`, `inspect_units`, `inspect_people`, `inspect_claims`, `inspect_sources`, `inspect_matches`, `inspect_coverage`, `inspect_events`, `associate_claim`, `record_visit`, and `update_coverage`). Mutation functions require a connection with foreign keys enabled, reject an already-open transaction, and use their own immediate transaction.

## Reviewed local Profile promotion

Use a compatible checkout for the installed Profiles schema and one private
plan per county batch. Use the reviewed batch manifest to account for every
claim in scope. Include only claims that have a supported research identity,
a documented office, position title or job description, and a retained
evidence record linked to its source. Keep unsupported claims in the
county review queue. Office-only and duties-only roles may leave the title
blank. An unresolved unit path can stay blank.

`Listed` and `Explicitly former` claims use the same reviewed promotion
workflow. A former role can have an unknown employment end date. The
confirmed role links to the original claim through `profile_evidence_role`,
which retains access to the claim's `Listing status` and source evidence.
Use the latest supported observation when a claim was superseded. Claims
with unclear listing status remain in the research review queue.

Omit the standalone word “County” in confirmed position titles. For the
consolidated title “City and County Manager,” use “City Manager.” A reviewed
role grouping can reuse all claims for the same role when their titles differ
only by “County”, capitalization, or “and” versus “&”. Use the county,
office and documented dates to distinguish genuinely different roles or terms.
Keep original position and office wording in the linked research observations.

The plan records the reviewer, review date, canonical county FIPS, exact
research identities and claim groups, the reviewed role fields, and the
source link for each claim. Preserve the source wording. The owner confirmed
the existing sources were verified when found. Use the recorded source
discovery date or its retained reported check date. If neither exists, keep
the date unset and retain the evidence link. Complete any needed identity
links through the research operator workflow before building the promotion
preview.

Use format `colorado-watchdog/profile-promotion/v1`. The top-level fields
are `format`, `county_code`, `batch_id` (the retained intake batch),
`manifest_sha256` (the reviewed scope), `reviewed_by`, `reviewed_on`, and
`profiles`. Each Profile supplies `research_profile_id`, `full_name`,
`reviewer_notes`, and `roles`. A role supplies `role_claim_ids`,
`office_or_department`, `position_title`, `duties`,
`employment_start_date`, `employment_end_date`, and `citations`. Each
citation entry has `claim_id` and `verified_on`. Use `null` to derive the
source discovery date from retained provenance. The date remains unset if
neither discovery field is recorded. Use ISO calendar dates for populated
dates. The private role evidence remains linked even if a separate dated
public-citation row cannot be represented.

Keep the plan, preview and receipts in the owner's private Profiles folder.

```powershell
python -B -m research preview-profile-promotion DB --plan PLAN.json
python -B -m research apply-profile-promotion DB --plan PLAN.json --expect-plan-sha256 SHA --apply
```

Review the exact preview and retain its SHA-256. One writer rehearses the
apply on a consistent private disposable copy, checks the created Profiles,
county links, roles and evidence, then reruns the same plan there to verify
stable IDs and zero duplicate writes. After the rehearsal passes, the
writer repeats the apply against the working file with the reviewed hash.
A changed plan or changed source state requires review of the new preview.
After apply, read back the affected rows and run `python -B -m research check DB`.
Record counts and the local receipt path. Intake selection and Website
submission are separate workflows.

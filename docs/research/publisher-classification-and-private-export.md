# Profiles publisher classification and private export

Publisher classification is separate from `sources.page_type`. The first answers who published or issued the material; the second identifies the page or document type used by R7.

## Publisher classification

`sources.publisher_classification` is one of `official`, `unofficial`, or `unresolved`.

- Use `official` only when evidence establishes a government publisher or a verified government publishing channel.
- Use `unofficial` only when evidence establishes a nongovernment publisher.
- Keep a linked source `unresolved` when its publisher cannot be established. A PDF suffix, URL suffix, or hostname alone is insufficient.
- A person with no linked source has `source_classification: null` in the export. The linked unresolved source remains `unresolved` and is counted separately.
- `official_status` remains for compatibility and history. Existing `unknown`, `official`, `partner`, and `other` values are not blanket-converted. The preview carries a prior `official` classification forward only when its audit entry points to evidence linked to that exact source. Existing `partner` and `other` values remain intact.
- New CSV intake leaves the publisher unresolved until a reviewer classifies it. Use `classify-publisher` with source-specific evidence and a documented basis for a manual decision.

## Schema update and reviewable correction

First verify the database and preserve a fresh encrypted backup with a separate restore. Rehearse the additive migration and the hash-checked plan on the restore before migrating the live database:

```powershell
$db = 'D:/ChatGPT/Watchdog/profiles/database/research.sqlite'
$copy = 'D:/ChatGPT/Watchdog/profiles/scratch/research-pre-classification-restore-YYYY-MM-DD.sqlite'
$backup = 'D:/ChatGPT/Watchdog/profiles/backups/research-pre-classification-YYYY-MM-DD.cwbackup'
$plan = 'D:/ChatGPT/Watchdog/profiles/reports/publisher-classification-plan-YYYY-MM-DD-v1.json'
python -B -m research check $db
python -B -m research backup $db $backup
python -B -m research restore $backup $copy
python -B -m research check $copy
python -B -m research migrate $copy
python -B -m research preview-publisher-classifications $copy --output $plan
python -B -m research apply-publisher-classifications $copy --plan $plan --expect-plan-sha256 <plan-sha256>
python -B -m research verify-publisher-classifications $copy --plan $plan --expect-plan-sha256 <plan-sha256>
python -B -m research apply-publisher-classifications $copy --plan $plan --expect-plan-sha256 <plan-sha256>
python -B -m research check $copy
```

The preview is read-only and writes a private row-level plan outside the checkout. It reports proposed counts and unresolved exceptions without printing rows. The apply command opens an immediate transaction, hashes relevant source/evidence, batch-selection, identity and organization state, refuses stale input, preserves the legacy partner field, and records before/after classification with its evidence. Reapplying the same verified plan is idempotent. If backup, restore, checks, or rehearsal fail, stop before migrating or writing the live database.

After rehearsal, run `migrate` on the live database, create a fresh plan against that post-migration state, review its aggregate summary, and apply and verify only that exact plan hash. Keep the plan, backup, restore, and individual rows in the private workspace.

Manual classification example (all identifiers and evidence below are synthetic):

```powershell
python -B -m research classify-publisher $db `
  --source-id source_fixture_1 `
  --classification unofficial `
  --evidence-id evidence_fixture_1 `
  --actor 'synthetic-reviewer' `
  --basis 'The attached synthetic source evidence identifies a private publisher.'
```

## County and statewide exports

Choose one or more canonical county FIPS codes, or explicitly select statewide. Scope is applied before the limit. The exporter sorts profile IDs deterministically and counts each person once; role claims stay separate from profile records and carry their own county, organization, source citation and source classification. One person with roles in several selected counties appears once, with every selected county and role link retained.

```powershell
python -B -m research profiles-export $db `
  --county 08001 `
  --output 'D:/ChatGPT/Watchdog/profiles/reports/adams-profiles-YYYY-MM-DD.json'

python -B -m research profiles-export $db `
  --statewide `
  --output 'D:/ChatGPT/Watchdog/profiles/reports/statewide-profiles-YYYY-MM-DD.json'
```

Each file contains at most 10,000 distinct profiles. When `continuation.has_more` is true, resume with the returned `continuation.after_profile_id`:

```powershell
python -B -m research profiles-export $db --statewide `
  --after-profile-id '<last-profile-id-from-previous-page>' `
  --output 'D:/ChatGPT/Watchdog/profiles/reports/statewide-profiles-next-YYYY-MM-DD.json'
```

The first page includes unassigned role claims separately; continuation pages do not repeat that list. Claims attached to profiles appear with those profiles, so continuation does not duplicate assigned claims. Aggregate counts in the command response show profiles, role claims, official and unofficial sources, source-less profiles, unresolved publishers, and truncation. Rows include citations and selected public role fields only. The export omits private notes, raw captures, audit bodies and unrelated personal fields. Write outputs only under the owner's private Watchdog workspace.

This export is a local research artifact, not an M2 changeset or a hosted write. Keep M2 changeset limits and hosted write controls unchanged.

# Profiles dashboard CSV import (SYNC-1)

The owner uploads reviewed CSV files in the Profiles tab, inspects the exact adds, updates, conflicts and visibility, then commits. The whole workflow runs in the browser. It follows the [dashboard CSV import decision](../decisions.md#dashboard-csv-imports--november-19-2026) and extends the [Profiles sheet](profiles-sheet.md) from PR #257.

## Flow

1. **Upload.** The browser reads each chosen file as text and sends it. It never parses, matches or decides anything.
2. **Preview.** `POST /api/admin/profiles/import/preview` is read-only. The server parses and validates the files, matches rows to existing Website records, runs the shared sync planner as a dry run and returns the plan with a digest.
3. **Inspect.** The panel shows counts and every row with its action, Website ID, field differences and visibility. Blocking issues name the file, line and key.
4. **Commit.** `POST /api/admin/profiles/import/commit` carries the reviewed digest and an idempotency key. The server recomputes the plan, refuses with `409 stale_preview` if it differs, and otherwise writes through the shared sync commit engine in one atomic batch.
5. **Reverse.** `POST /api/admin/profiles/import/reverse` reverses a committed batch through the shared reversal path.

Access is the existing owner `profile.manage` capability on a signed-in human session. An agent credential never passes. Every POST needs the exact page origin and a JSON body. Commit and reverse need an `Idempotency-Key` header. Nothing here adds a new capability, table or migration.

## Supported file contract (`profiles-import/v1`)

Headers are matched after lowercasing and replacing spaces and hyphens with underscores. `county_code` is accepted for `county_fips`. Columns not listed below are shown in the preview as not imported and are never written.

| File | Required | Optional |
| --- | --- | --- |
| `profile.csv` | `profile_id`, `display_name` | `first_name`, `middle_name`, `last_name`, `name_prefix`, `name_suffix`, `preferred_first_name` |
| `profile_name.csv` | `profile_name_id`, `profile_id`, `name_type`, `published_name` | `first_name`, `middle_name`, `last_name`, `name_prefix`, `name_suffix`, `applies_from`, `applies_until`, `verification_status`, `public_display` |
| `profile_role.csv` | `role_id`, `profile_id`, `county_fips`, `source_id`, `source_url`, `source_title`, `publisher_classification`, `source_type` | `published_office`, `published_title`, `job_description`, `source_checked_at`, `start_date`, `end_date` |

- A role needs at least one of `published_office`, `published_title` or `job_description`.
- `publisher_classification` is `official` or `unofficial`. `source_type` is `official_page`, `public_document` or `other_public`.
- The Website holds one source per role. Role rows repeat their source fields and a source is registered once per `source_id`. A source URL that already exists with identical metadata is reused.
- Keys (`profile_id`, `role_id`, `source_id`) are the private export keys. They are 1 to 100 letters, digits, dots, colons, underscores or hyphens.
- `profile_role.csv` is optional. Without it only Profiles are previewed.

This is the contract the Profiles Audit handoff on [Issue #141](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/141#issuecomment-7000870240) describes for the first slice.

Private evidence files (`profile_evidence*.csv`), claim IDs, research evidence-link IDs and review metadata stay in the private Profiles store. Each role can carry its selected source citation inline.

The first slice defers these imports:

- `profile_county_unit.csv`, `profile_position.csv` and any organization or position links. Rows carrying only those keys cannot become roles until a verified Website mapping exists.

## Names (migration 0032)

- **Primary components.** A present component column in `profile.csv` sets that component. A blank cell clears it. An absent column leaves it alone. `display_name` is never derived from components. Components update only while the Profile is unchanged since its last import, otherwise the row is a conflict and the Website value is kept.
- **Alternates.** Each `profile_name.csv` row has its own stable `profile_name_id` (stored as `dash:name:<id>`) and names its Profile by `profile_id`, which may be in the same upload or already imported. `name_type` is one of the 13 types in migration 0032. Several alternates can share one Profile. Dates are `YYYY-MM-DD` and ordered. A row repeating an active name, type and dates on the same Profile is blocked.
- **Private by default.** Every created alternate is `requires_review` and not public, whatever `verification_status` or `public_display` say. Rows asking for Public or Confirmed are counted in the preview and ignored. Publication is the owner's action in the Names editor.
- **Preservation.** A private alternate updates only while unchanged since the last import. An owner edit, an approval, a removal or a public alternate turns the row into a conflict and the Website value is kept. A change to a public name is held for the Names editor and its review. The importer has no proposals queue.
- **Engine.** Name fields and the `profile_names` entity are importer-only in the sync engine and absent from the external sync API allowlist. Migration 0032 also widens the `sync_batch_items` entity and operation checks so a receipt can record a created name.
- **Evidence.** No evidence, claim or snapshot column is read. Unrecognized columns are listed as not imported.

## Matching, versions and preservation

- **Stable keys.** Each created record is stored with a namespaced client reference (`dash:profile:<id>`, `dash:role:<id>`, `dash:source:<id>`) on its committed sync item. A later upload of the same key matches the Website record that commit created. Matching is never by name or label. A reversed batch releases its keys.
- **Updates.** A mapped Profile or role is updated only when it has not changed since the last import. Each update carries the current version as `expectedVersion`, and the shared engine rechecks it inside the batch. Updatable fields are `display_name`, `start_date`, `end_date`, `source_checked_at` and a source `title`.
- **Conflicts.** A mapped record whose version moved past its last import and whose value differs from the file is reported as a conflict and skipped. Role fields the sync contract cannot change (office, title, duties, county, source) are also reported as conflicts. The Website value is kept.
- **Absent records.** Records the file does not mention are never touched. The preview counts them.
- **Visibility.** Existing Profiles keep their visibility. New Profiles are created hidden in the same atomic batch, so a Profile is never publicly readable before an explicit publication. Public reads omit hidden Profiles through the #257 visibility predicate. Reversal removes the visibility row it created.

## Receipts and retries

A commit returns the batch ID, counts and the hidden Profiles it created. Retrying the same key with the same reviewed digest returns the stored receipt with `replayed: true` and writes nothing. The same key with a different digest returns `409 idempotency_conflict`.

## Cloudflare synthetic acceptance checklist

Use a synthetic file only. Generate one with `node scripts/profiles-import-fixture.mjs --out <folder>` (262 Profiles, 413 roles, 138 sources, all `example.invalid`). Do not send real Adams data until this passes and the owner approves the reviewed pilot scope.

1. Deploy this branch to the Cloudflare staging Worker that has migration 0030 or later applied. Confirm the verifier reports the expected migration count. This change adds no migration.
2. Sign in as the owner. Open Dashboard, Profiles, Import CSV. Confirm the panel is absent for an editor and that the routes answer 401 or 403 without an owner session.
3. Upload `profile.csv` and `profile_role.csv`. Choose Preview. Confirm 262 Profiles, 413 roles and 138 sources are adds, zero blocking issues, and 262 new Profiles are shown as created hidden. Confirm the preview wrote nothing (Profiles tab row count unchanged, no new sync batch).
4. Commit. Confirm the receipt shows 262 Profiles, 413 roles and 138 sources and that all 262 are hidden.
5. Public readback. In a signed-out browser confirm none of the 262 names appear in search, browse, the Adams county page, role listings or by direct Profile URL (404).
6. Same-key retry. Repeat the commit request with the same key (browser network replay or the same panel session). Confirm `replayed: true` and unchanged counts.
7. Stale preview. Preview again, edit one synthetic Profile name in the Profiles sheet, then commit the earlier preview. Confirm `stale_preview` and no new batch.
8. Stable update. Change one display name in the CSV and one `source_checked_at`, add one new row, and preview. Confirm one Profile update, one role update, one add and everything else unchanged. Commit and confirm the Website IDs did not change.
9. Preserve owner edits. Edit a synthetic Profile name in the sheet, upload a file that renames the same Profile, preview and confirm a conflict. Publish one synthetic Profile in the sheet, re-upload and confirm it stays visible.
10. Missing dependency. Upload a `profile_role.csv` row with an unknown `profile_id` and another with a blank `source_url`. Confirm both are blocking and Commit stays disabled.
11. Reverse. Reverse the first batch. Confirm the Profiles, roles, sources and visibility rows it created are gone and the Profiles tab count returns to the starting total.
12. Record the Worker version, source SHA, receipts and results in the PR. Revoke any temporary access.

The real Adams send stays a separate step. It needs the owner's exact reviewed selection and uses this same workflow after the synthetic run passes.

## Mapping isolation

The importer reads stable-ID mappings only from sync batches it committed itself. Importer batches are stored with the idempotency key prefix `pi:` and mappings use the `dash:profile:`, `dash:role:` and `dash:source:` client references. A mapping is ignored when its batch has a reversal record, when its key lacks the `pi:` prefix, or when the batch belongs to another account. The reverse route refuses any batch that is not an importer batch of the signed-in owner. Tests cover import, reverse and re-preview, an unrelated batch that reuses the `dash:` namespace, and a synthetic 5 Profile, 7 role, 1 shared source follow-on batch.

## Title only roles

A role row may carry only published_title, with published_office and job_description blank and no structured position link. The exact title, including commas and an ampersand when the field is quoted, is stored in person_roles.published_title and is shown in the Position column of the Profiles tab (the column reads the published title first and the structured position second). A regression test uses the synthetic title Training, Records & Development Manager through preview, commit, readback, search and an unchanged re-upload.

## Reserved marker and version guard

The pi: key prefix is reserved inside the shared sync writer. A batch whose key starts with it is refused unless the importer passes the importer flag, and the flag is refused for any other key, so ordinary sync callers cannot create importer mappings. The commit route samples the Website dependency generation before it reads mappings or builds the plan and hands that value to the shared write. If anything the plan depends on changed after that sample, the guarded write fails and the importer answers with a stale preview. Two commits from one preview with different keys therefore cannot both create records. Tests cover the reserved prefix, and a deterministic rival commit landing between the importer plan and the shared write.

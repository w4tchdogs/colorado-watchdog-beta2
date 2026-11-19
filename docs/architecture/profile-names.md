# Profile names and alternate names (PROFILES-NAMES-1)

Status: Tested locally with synthetic data. Not deployed and not Hosted-verified. This work extends the Profiles sheet from [PR #257](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/257). It does not replace or duplicate it.

## What this adds

Each Profile keeps one primary name in seven fields and any number of typed alternate names. The Website stores them in the existing Website D1 database. It does not create a second people database. Names are matched to a Profile by stable ID only. Nothing in this work merges people by name.

Public pages use the Display Name. A public page shows an alternate name only when the owner has marked it Confirmed and Public. Every new name starts private and requires review.

## Primary name fields

| Field | Column on `people` | Rule |
| --- | --- | --- |
| Display Name | `display_name` | Required. This is the name the public page shows. |
| First Name | `first_name` | Optional, up to 200 characters. |
| Middle Name | `middle_name` | Optional, up to 200 characters. A single initial is allowed. |
| Last Name | `last_name` | Optional, up to 200 characters. Compound surnames stay in one field. |
| Name Prefix | `name_prefix` | Optional, up to 50 characters. |
| Name Suffix | `name_suffix` | Optional, up to 50 characters. |
| Preferred First Name | `preferred_first_name` | Optional, up to 200 characters. It never replaces Display Name on its own. |

A blank optional field is stored as null. The components are Website-only for now. The local Profiles database is not changed by this work, so a sync does not overwrite them.

Migration 0032 backfills nothing into the components. It copies each existing display name into `profile_legacy_names` once, so the original text survives if the owner later edits Display Name. A Profile with a display name only keeps working, and its Names review state reads “display only”.

## Alternate names

Table `profile_names` has one row per alternate name. A Profile can have any number. The editor loads up to 500 per Profile and says when there are more.

| Column | Meaning |
| --- | --- |
| `id` | `pn_` plus a UUID. Never reused. |
| `person_id` | The Profile. Cannot be changed after creation. |
| `name_type` | One of the 13 types below. |
| `first_name`, `middle_name`, `last_name`, `name_prefix`, `name_suffix` | Optional components of this name. |
| `published_name` | The exact name as published, up to 500 characters. |
| `applies_from`, `applies_until` | Optional dates (YYYY-MM-DD). The end cannot precede the start. |
| `verification_status` | `requires_review` (default) or `confirmed`. |
| `public_display` | 0 (default) or 1. The database allows 1 only when the name is confirmed and not removed. |
| `removed_at`, `removed_by_account_id` | Soft removal. Both are set together or both are null. |
| `version` | Increments on every change. Edits carry the version they read. |

Two active names for one Profile cannot share a type, a case-insensitive published name and the same dates. The same text on a different Profile is allowed because that is a different person.

### Name types

| Type | Public label | Use for |
| --- | --- | --- |
| `nickname` | Also known as | A nickname in use. |
| `preferred` | Also known as | A preferred name that differs from the primary name. |
| `middle_name_used` | Also known as | The person goes by a middle name. |
| `birth_surname` | Formerly known as | The surname at birth. |
| `married_surname` | Formerly known as | A surname taken at marriage. |
| `former_surname` | Formerly known as | A surname used before, for another reason. |
| `legal_name_change` | Formerly known as | A name replaced by a legal change. |
| `professional_name` | Professional name | A name used in a profession. |
| `initials` | Also known as | A form such as initials plus surname. |
| `historical_published` | Published as | A name as printed in an older document. |
| `spelling_variant` | Published as | A variant spelling found in documents. |
| `transliteration` | Published as | A transliteration from another script. |
| `other` | Also known as | Anything else. Prefer a specific type. |

The label is a presentation choice. It does not say why a name applies. The public page never shows the type, dates or evidence.

### Evidence

The Website stores no evidence for names. Evidence files, claim IDs, research evidence-link IDs, review notes and the original research name stay in the private Profiles store. A name carries only its own values, its review status and its visibility.

### History

`profile_name_events` is append-only. Triggers refuse updates and deletes. Each event records the action (`primary_update`, `alternate_add`, `alternate_update`, `alternate_remove`, `alternate_restore`) with before and after values. The same atomic batch also writes the `audit_events` row.

## Dashboard

The Profiles dashboard from PR #257 gains the seven name columns and a Names count column. Person-level fields repeat on every role row of the same Profile. Selecting the count button opens the alternate-name panel for that Profile. Add, edit, remove, restore and undo all stage into the same Save as every other edit, so a primary name change and an alternate name change save in one atomic batch with one preview and one idempotency key. The Public checkbox stays disabled until the status is Confirmed.

The owner API gains `GET /api/admin/profiles/names?profileId=…`. It is owner-only and no-store. Agents and editors are refused.

## Public display and search

- A Profile page shows the Display Name as the heading. Approved alternate names appear in a list grouped by the labels above.
- Public search matches the Display Name or a public alternate name. It never matches an unapproved, unconfirmed or removed name.
- A hidden Profile is not found by any name, and the page is not served.
- The sync reads (`person-profile.ts`, `directory-search.ts`) and the D1 reads (`d1-public-reads.ts`) use the same predicate from `person-visibility.ts`.
- Owner search in the dashboard also finds internal names. The legacy table is not searched.

## CSV import compatibility

`src/services/profile-csv.ts` validates and maps name rows. It is pure and reads no database. The dashboard upload that uses it is the follow-up described in [Profiles dashboard CSV import](profiles-import.md).

`profile.csv` name columns: `first_name`, `middle_name`, `last_name`, `name_prefix`, `name_suffix`, `preferred_first_name` and `display_name`.

`profile_name.csv` columns: `profile_name_id`, `profile_id`, `name_type`, `first_name`, `middle_name`, `last_name`, `name_prefix`, `name_suffix`, `published_name`, `applies_from`, `applies_until`, `verification_status`, `public_display`. There is no evidence column.

A name is never matched or merged by its text.

## Operator instructions

1. Open the Profiles tab and find the Profile. Search covers Display Name, first, last and preferred names, and internal alternate names.
2. Edit a name component in its cell. The edit is staged. Nothing is saved until Save changes.
3. To add an alternate name, select the Names count on any row of that Profile. Choose Add, pick the type, enter the name as published, add dates, and leave Public off and Requires review on.
4. Review the name against the private research. Set the status to Confirmed only when it supports the name. Then, and only then, tick Public.
5. Select Save changes, check the preview of old and new values, and confirm. A stale version keeps the pending edit and offers to re-apply it.
6. To retire a name, choose Remove. It leaves public pages at once and can be restored.
7. To hide a whole Profile, use Visible on Website. A hidden Profile’s names are not found.

## Migration and recovery plan

Migration 0032 is purely additive. It adds six nullable columns to `people` and three new tables. It changes no existing row’s meaning. No public read changes until the new Worker is deployed.

Numbering: this is migration 0032 because 0031 is `0031_county_structure.sql`. Files that hardcode the migration count and list: `scripts/check.mjs`, `scripts/cloudflare-staging-config.mjs`, `scripts/d1-local-check.mjs`, `scripts/sites-d1-local-check.mjs`, `scripts/verify-cloudflare-staging-d1.mjs`, `src/services/owner-bootstrap.ts` and the tests that assert the migration count.

Order: apply the migration first, verify, then deploy the Worker. The new Worker needs the new tables. The previous Worker keeps working after the migration because it ignores the new columns and tables.

Recovery: take an exported checkpoint before applying. If the migration fails, D1 applies it as one unit, so nothing partial remains. To undo after applying, redeploy the previous Worker. The new tables can stay unused. Do not drop `profile_legacy_names`. It is the only copy of the pre-edit display names.

## Cloudflare staging acceptance checklist

Not done. A staging step needs the owner’s approval and is outside this PR.

1. Confirm the ledger shows migrations 0001 to 0031 with matching checksums.
2. Export a checkpoint of the staging database.
3. Apply 0032. Confirm the ledger shows 32 rows and the verifier passes.
4. Deploy the Worker built from the merge commit.
5. Open the Profiles tab as the owner. Confirm the name columns and Names count load.
6. Add a synthetic alternate name. Confirm it is private. Confirm the public page and public search do not show it.
7. Mark it Confirmed and Public. Confirm the page shows it under the right label and search finds it.
8. Remove it. Confirm it leaves the page and search.
9. Hide the Profile. Confirm no name finds it.
10. Confirm an agent or editor account gets 403 from the names route.
11. Remove the synthetic records using the dashboard.

## Limits

- Tested locally on synthetic data only, with sql.js and the Worker build. Not run against a real D1 or a browser.
- The dashboard CSV upload is a follow-up PR. Only validation and mapping exist here.
- Components are Website-only. A later local Profiles database change would need its own mapping.

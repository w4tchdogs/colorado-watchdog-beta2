# Local Profiles database redesign

Design proposal, November 17, 2026. Baseline: Profiles SQLite schema v5,
migrations 001–005. The owner distinguishes People Research, County Research
and Profiles prepared for the Website. Every research table name starts with
`research_`. Use the [human operation decision](../decisions.md#human-operation-of-profiles-november-17-2026)
as the editing and sync requirement.

## What an operator sees

| Area | Contents | Typical action |
| --- | --- | --- |
| People Research | Observed people, role claims, names as published and possible identity matches | Compare claims, correct associations, resolve identities and review promotion |
| County Research | County offices, departments, organizational relationships, position types and coverage | Review documented county structure and the offices or positions still to check |
| Profiles | Confirmed people, roles and public citations prepared for the Website | Open a profile, review proposed edits and mark the exact changes ready to send |
| Website Sync | Website IDs, reviewed batches, submission and reversal receipts | See what was sent, recover an uncertain submission and reconcile results |

Use one private SQLite file for these local areas. The Website D1 remains a
separate database. People Research and County Research share a private source
and evidence registry so one observation can support both kinds of research.
Within this database, County Research means county government structure,
positions and coverage. The county lookup supplies names and FIPS codes.

## Research table order in DB Browser

Use a two-digit number immediately after `research_`. An alphabetical
table picker then keeps the entire Research block together and shows the
observations before the conclusions.

| Prefix | What you see in that part of the list |
| --- | --- |
| `research_01_` | Shared sources, evidence, visits, intake batches and runs |
| `research_02_people_` | People identities under review, names, role observations and possible matches |
| `research_03_county_` | County units, names and sources for the structure |
| `research_04_` | People conclusions and county conclusions, documented positions and coverage |
| `research_05_` | Research change history |

Add `research_04_people_conclusions` and `research_04_county_conclusions`
as views of evidence-supported identities and county structure. Keep their
source records and any unresolved observations in the earlier groups.
Reviewed research conclusions can support a Profiles revision. Confirmation
and selection for Website sync are explicit steps in the Profiles workflow.

`profiles` is the physical table for confirmed profile records. It is
separate from the numbered Research block. An alphabetical picker places
`profiles` above `research_`. In the human editing workflow, show People and
County Research, then Profiles, then Website Sync.

## Profiles tables to add

| Table | Contents and key relationships |
| --- | --- |
| `profiles` | One confirmed local person per stable Profile ID. Human-facing fields start with Full name. Creation and update times track the editable profile record. |
| `profile_roles` | One confirmed role per Profile Role ID, linked to Profile ID and county. Show Office, Position, Job description, optional published organization/position, and documented dates. A person can have several roles and counties. |
| `profile_citations` | Public URL, title, publisher classification, page type and verification date for the citation chosen for a role. Keep the link to the private source. Select the citation used by the current Website contract explicitly. |
| `profile_organizations` | Approved public organization name, type, parent relationship and county scope needed by confirmed roles. |
| `profile_organization_counties` | Approved county affiliations when an organization serves multiple counties. |
| `profile_positions` | Approved title linked to its public organization, where evidence supports a structured position. |
| `profile_research_people` | Link Profile ID to the evidence-supported local research identities used to confirm it. |
| `profile_role_evidence` | Link a role to the supporting claims and evidence IDs; preserve multiple supporting observations. Private lineage stays local. |
| `profile_changes` | Proposed edits, review history and exact approved public revisions. Retain the review actor, time, prior revision and the accepted change fingerprint. Use reviewed revisions as the input to the sync planner. |

Show county and sync state in a `profiles_overview` browse view, derived from
roles and Website receipts. Keep Full name and role information prominent.
Show a distinction between **Confirmed**, **Ready to sync**, **Synced** and
**Changes to review** in the operator interface. Confirmed describes the
profile or role evidence. Ready to sync describes a reviewed revision.
Synced requires an acknowledged Website receipt reconciled locally.
An uncertain submission has its own pending state.

## Existing v5 tables and view

These are proposed destinations for all current schema objects. Keep existing
IDs, rows and relationships during the migration.

| Current | Proposed | Area |
| --- | --- | --- |
| `research_people` | `research_02_people_identities` | People Research identities |
| `role_claims` | `research_02_people_role_claims` | People Research observations |
| `name_variants` | `research_02_people_names` | People Research names |
| `possible_matches` | `research_02_people_possible_matches` | People Research identity review |
| `selected_role_claims` (view) | `research_02_people_selected_role_claims` (view) | People Research intake selection |
| `org_units` | `research_03_county_units` | County Research structure |
| `org_names` | `research_03_county_unit_names` | County Research organization names |
| `role_targets` | `research_04_county_documented_positions` | County Research documented positions |
| `unit_coverage` | `research_04_county_coverage` | County Research coverage |
| `source_unit_links` | `research_03_county_unit_sources` | County Research links to shared sources |
| `sources` | `research_01_sources` | Shared Research source registry |
| `evidence_links` | `research_01_evidence` | Shared Research source observations |
| `source_visits` | `research_01_source_visits` | Shared Research source visits |
| `scrape_batches` | `research_01_batches` | Shared Research intake and selected batch families |
| `research_runs` | `research_01_runs` | Shared Research run history |
| `research_events` | `research_05_history` | Shared Research audit history |
| `counties` | `counties` | Shared county lookup |
| `site_links` | `website_legacy_profile_links` | Website Sync retained legacy person mapping |
| `site_entity_links` | `website_entity_links` | Website Sync entity ID mapping |
| `site_entity_lineage` | `website_entity_lineage` | Website Sync retained source lineage |
| `site_sync_update_approvals` | `website_update_approvals` | Website Sync version-pinned approvals |
| `sync_batches` | `website_legacy_batches` | Website Sync retained legacy batches |
| `sync_items` | `website_legacy_batch_items` | Website Sync retained legacy batch items |
| `sync_submissions` | `website_submissions` | Website Sync durable requests |
| `sync_submission_items` | `website_submission_items` | Website Sync item-to-record links |
| `sync_submission_receipts` | `website_submission_receipts` | Website Sync commit receipts |
| `sync_item_receipts` | `website_item_receipts` | Website Sync item receipts |
| `sync_reversal_receipts` | `website_reversal_receipts` | Website Sync reversal receipts |
| `schema_migrations` | `schema_migrations` | SQLite migration ledger |

## Research into Profiles and Website Sync

1. Reuse the accepted county, name, role detail and public citation checks.
   Research can retain unsupported identities, source-only observations,
   notes, conflicting claims and superseded batches. An identity marked
   evidence-supported is one input to profile review.
2. Review the candidate person and the specific roles and citations together,
   one profile or a batch at a time. Promotion creates or updates confirmed
   Profiles rows and retains the private research links. An already confirmed
   identity keeps its Profile ID when a correction or added role is proposed.
   Save human corrections with the reason and original source wording.
3. Record the exact reviewed public revision. An edit produces a new proposed
   revision and a new review fingerprint. The revision awaiting send is
   immutable. If an earlier submission is pending, resolve it by replay or
   receipt lookup before preparing a replacement.
4. Build Website changesets only from reviewed Profiles revisions and the
   public organizations, positions and citations they reference. Exclude
   unapproved roles, notes, source captures and private identifiers from the
   public projection. Continue to use opaque request references and let the
   Website assign permanent Website IDs. Keep the existing validation,
   idempotency, full receipt reconciliation and reversal behavior.
5. Give the human operator a local browse and edit screen and an explicit
   preview-and-send action. Use the same change and receipt boundaries for
   human and automated workflows. A read-only browse view is useful in
   DB Browser. A human editing surface applies updates to linked records in
   a single audited transaction and makes the human sync path usable without
   an AI session or MCP connection.

## Migration and verification

- Implement as a new local migration and ship the updated research tools,
  export, backup/restore and operator paths together. Preserve the checksums
  of migrations 001–005 and the CSV and machine-facing export keys.
- Rehearse on synthetic SQLite and a private, consistent copy of the working
  v5 database. Compare all preserved table counts and stable IDs, verify
  evidence, source classification, selected batch families, organization
  relationships, county/FIPS coverage, and existing Website mappings and
  receipts. Check integrity and foreign keys, both before and after.
- Preserve exact request bytes and keys for any pending or previously
  reconciled submission. Verify upgrade and retry on a fixture containing a
  pending submission, a committed receipt, and a reversal. Exercise backup
  and restore with the matching schema and tools before upgrading the working
  database.
- Backfill Research first. Populate Profiles through the reviewed promotion
  path, using the current private Adams candidate to compare eligibility,
  scope and proposed public payloads. Keep the existing distinction between
  an eligible candidate, a selected send batch and a successful hosted
  receipt. Rehearse edits, stale review, public field filtering, retry,
  reconciliation and reversal with synthetic records before a real send
  from the redesigned workflow.

Schema implementation, private migration rehearsal and live upgrade follow
this design in separate assignments. The current local database and hosted
receipts are the source of truth for any actual pilot already in progress.

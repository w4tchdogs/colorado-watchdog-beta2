# Local Profiles database redesign

Design proposal, November 17, 2026. Baseline: Profiles SQLite schema v5,
migrations 001–005. The owner distinguishes People Research, County Research
and Profiles prepared for the Website. Use the [human operation decision](../decisions.md#human-operation-of-profiles-november-17-2026)
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

## Table order in DB Browser

The alphabetical picker groups County Research under `county_research_*`
and People Research under `profile_research_*`. Shared sources, evidence,
intake and history use `research_*`. Confirmed profile records are in the
physical `profile` table. Website sync records use `website_*`.

`profile_research_conclusions` and `county_research_conclusions` are views
of evidence-supported identities and county structure.
`profile_research_observations_selected` is the existing observation view
under its new name. It filters observations by the selected intake batches.
Review findings before preparing a confirmed profile or a Website revision.

## Profiles tables to add

| Table | Contents and key relationships |
| --- | --- |
| `profile` | One confirmed local person per stable Profile ID. Human-facing fields start with Full name. |
| `profile_county` | Approved county relationships used by confirmed Profiles. The row identity and location of organization-to-county affiliations need a schema decision. |
| `profile_county_unit` | Approved county organization or unit details used by confirmed roles. |
| `profile_evidence` | Private evidence supporting a confirmed profile. The schema must represent the link to its research identity and supporting evidence. |
| `profile_evidence_citation` | Public URL, title, publisher classification, page type and verification date for a role citation, with a link to the private source. |
| `profile_evidence_role` | Links a confirmed role to supporting observations and evidence. Multiple supporting observations can be retained. |
| `profile_position` | Approved title linked to a county unit where evidence supports a structured position. |
| `profile_revisions` | Proposed edits, review history and the exact approved public revision, with review actor, time and fingerprint. |
| `profile_role` | One confirmed role linked to a Profile ID and county. Keep office, position title, job description and documented dates distinct. |

Show county and sync state in a `profiles_overview` browse view, derived from
roles and Website receipts. Keep Full name and role information prominent.
Show a distinction between **Confirmed**, **Ready to sync**, **Synced** and
**Changes to review** in the operator interface. Confirmed describes the
profile or role evidence. Ready to sync describes a reviewed revision.
Synced requires an acknowledged Website receipt reconciled locally.
An uncertain submission has its own pending state.

## Existing v5 tables and view

Preserve existing IDs, rows and relationships. The owner confirmed zero rows
in `site_links`, `sync_batches` and `sync_items` on the working v5 file
on November 17, 2026. Before retiring them, check their counts on the database
being migrated and update the backup and restore schema checks. A nonempty
legacy table requires a preservation plan before retirement.

| Current | Target | Area |
| --- | --- | --- |
| `research_people` | `profile_research` | People Research identities |
| `role_claims` | `profile_research_observations` | People Research observations |
| `name_variants` | `profile_research_name` | People Research names |
| `possible_matches` | `profile_research_duplicates` | People Research identity review |
| `selected_role_claims` (view) | `profile_research_observations_selected` (view) | People Research intake selection |
| `org_units` | `county_research_unit_structure` | County Research structure |
| `org_names` | `county_research_unit_names` | County Research organization names |
| `role_targets` | `county_research_positions` | County Research documented positions |
| `unit_coverage` | `county_research_coverage` | County Research coverage |
| `source_unit_links` | `county_research_unit_sources` | County Research links to shared sources |
| `sources` | `research_sources` | Shared Research source registry |
| `evidence_links` | `research_evidence` | Shared Research source observations |
| `source_visits` | `research_source_visits` | Shared Research source visits |
| `scrape_batches` | `research_scrapes` | Shared Research intake and selected batch families |
| `research_runs` | `research_runs` | Shared Research run history |
| `research_events` | `research_history` | Shared Research audit history |
| `counties` | `county` | Shared county lookup |
| `site_links` | Retire if empty | Legacy Website sync |
| `site_entity_links` | `website_ids` | Website Sync entity ID mapping |
| `site_entity_lineage` | `website_id_evidence` | Website Sync retained source lineage |
| `site_sync_update_approvals` | `website_update_approvals` | Website Sync version-pinned approvals |
| `sync_batches` | Retire if empty | Legacy Website sync |
| `sync_items` | Retire if empty | Legacy Website sync |
| `sync_submissions` | `website_requests` | Website Sync durable requests |
| `sync_submission_items` | `website_request_changes` | Website Sync item-to-record links |
| `sync_submission_receipts` | `website_request_receipts` | Website Sync commit receipts |
| `sync_item_receipts` | `website_change_receipts` | Website Sync item receipts |
| `sync_reversal_receipts` | `website_reversal_receipts` | Website Sync reversal receipts |
| `schema_migrations` | `schema_migrations` | SQLite migration ledger |

## Full table and view list

The target has 34 tables and 4 views, listed in alphabetical picker order.

```text
county
county_research_conclusions (view)
county_research_coverage
county_research_positions
county_research_unit_names
county_research_unit_sources
county_research_unit_structure
profile
profile_county
profile_county_unit
profile_evidence
profile_evidence_citation
profile_evidence_role
profile_position
profile_research
profile_research_conclusions (view)
profile_research_duplicates
profile_research_name
profile_research_observations
profile_research_observations_selected (view)
profile_revisions
profile_role
profiles_overview (view)
research_evidence
research_history
research_runs
research_scrapes
research_source_visits
research_sources
schema_migrations
website_change_receipts
website_id_evidence
website_ids
website_request_changes
website_request_receipts
website_requests
website_reversal_receipts
website_update_approvals
```

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

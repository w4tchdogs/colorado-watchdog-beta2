# County Structure

This is the design record for the County Structure database, dashboard and single-file import. It covers what was built in COUNTY-DB-1, the rules behind it, what is deliberately not done yet, and the plan for retiring the older organization tables. The file format and operator steps are in the [county.csv contract and operator guide](county-structure-csv.md). The hosted rollout steps are in the [staging acceptance checklist](county-structure-staging.md). The owner decision is recorded in [decisions.md](../decisions.md).

## Why a new database

The earlier assumption was that the existing `organizations` table could hold the county structure. It could not carry the rules the owner needs. It has no stable key that survives renames in a CSV, it mixes organizations with units of a county, it ties a unit to Profile positions in ways that make a structural edit risky, and it has no preview, receipt or reversal for bulk change. COUNTY-DB-1 therefore builds a new, clean set of tables in the existing Website D1. There is no second D1. The `organizations` table is not the canonical County Structure and nothing in this change reads from it or writes to it.

## Tables

Migration `0031_county_structure.sql` adds eight STRICT tables. It does not change 0030 or any earlier migration.

| Table | Purpose |
| --- | --- |
| `county_structure_state` | One row holding the global structure version used for optimistic checks. |
| `county_unit_display` | Display groups such as “Elected Official”. A group is a navigation heading and never a structural parent. |
| `county_unit` | The units. The primary key is the stable ID from the CSV. Holds county, name, type, status, dates, display order, one parent (a unit or a display group), and the private evidence and source references. |
| `county_unit_alias` | Alternate names for a unit, in order, with an optional kind. |
| `county_role_display` | Reviewed classification that places an existing Profile role in a listing: `home`, `elected_official` or `department_leader`. It never copies a Profile or a role. |
| `county_structure_import` | One row per prepared import, commit or reversal, with the file hash, change set hash, base and after versions, status and the commit idempotency key. |
| `county_structure_import_item` | The exact change set of an import, one row per unit or group. |
| `county_structure_history` | Append-only record of every change, with before and after. Triggers refuse updates and deletes. |

Triggers enforce what a CHECK cannot. Identifiers are shared between units and groups so an ID is never ambiguous. A unit never changes county. A parent or group must be in the same county. A parent chain cannot form a cycle. The structure version only moves forward. A role display must belong to the same county as its unit.

These tables are owner-only and carry their own version row, so they are left out of the generic dependency-generation trigger set, as the Profiles visibility tables were. The local D1 verifier lists them as excluded for that reason.

Migration `0033_county_structure_v4_contract.sql` adapts the tables for the statewide v4 `county.csv` without rebuilding them. It copies the private provenance aside, drops and re-adds `evidence` and `source_references` on `county_unit` and `county_unit_display` with a 32,768 character limit instead of 4,000, and copies the text back unchanged. It adds `county_unit.browse_parent_unit_id` for browse placement under another unit, with same-county and no-cycle triggers and a CHECK that keeps it exclusive of a reporting parent or a display grouping. Unit versions, timestamps, aliases and Profile role links are unchanged. A rebuild was avoided because aliases cascade from `county_unit` and Profile role displays restrict deletes on it.

## Rules

**Placement is separate from elected status.** The Sheriff’s Office is a normal top-level unit. “Elected Official” is a display group. A Profile role is classified as elected only by an explicit reviewed row in `county_role_display`, never by a name or a CSV column. One role can have a `home` row under the Sheriff’s Office and an `elected_official` row, and the public pages list the one Profile and role in both places. No Profile and no role is duplicated.

**Public browse headings.** The public county section shows every shown unit exactly once. A unit with a shown parent nests under it. Every other unit sits directly under one browse heading, which is a navigation label and never a reporting parent. The heading is the unit's saved display group when it has one, then the county's own group whose name matches the generic category for the unit type (Departments, Offices, Boards or Commissions, ignoring case and a trailing s), then that generic category, and **Other** when the type has no category. A unit whose reporting parent is unknown or held therefore stays visible under its heading, and the hold stays in private evidence. Public labels collapse whitespace-only variants on one unit ID, including spaces around a hyphen or slash, so one name shows and a matching alternate name is not repeated. The literal spellings stay in the database and the export. Two different IDs with look-alike names are never merged by this rule.

**Stable IDs decide identity.** The Office or unit ID is the key. There is no name matching and no mapping file. An ID never moves between counties or between unit and group.

**One target state, then a difference.** Every writer builds a complete target structure for the counties it touches and computes the difference against what is stored. Merge, replace one county, replace all counties, dashboard edits and reversals all use that one path, so they share the same validation and the same transaction.

**Imports are two steps.** Prepare validates the file, computes the change set and stores it with a hash. Nothing else changes. Commit applies that exact change set only if the structure version still equals the version it was prepared against. The whole commit is one D1 batch, so it succeeds or leaves nothing behind. Writes are ordered by depth, deletes children first and inserts parents first, because the foreign keys are immediate.

**Idempotency and receipts.** A commit carries an idempotency key. The same key replays the stored result and writes nothing. A different key for an import that is already committed is refused. Each commit leaves a receipt row and one history row per changed entity.

**Reversal is safe or refused.** A reversal restores the state from before an import. It is allowed only when the current version equals the import’s after version and no Profile role would be orphaned. It is itself a recorded import and cannot be reversed again.

**Profile references block removal.** A unit that a Profile role points at cannot be removed by an import. The preview marks it blocked with the count. The owner retires or hides it instead, or moves the roles first.

**Private provenance.** Evidence and source references are stored on the unit, exported and round-tripped, and shown in the dashboard. The public service selects only public columns, so no public API or page can return them. Tests check this on the page output.

**Owner only.** The capability `county_structure.manage` is held by the owner role alone. The transport requires a human principal, checks the live account on every call, checks the exact origin on every write, and answers 404 when sign-in is disabled.

## Layers

- `src/contracts/county-structure.ts` holds the column list and shared types.
- `src/services/county-structure-csv.ts` reads and writes the CSV.
- `src/services/county-structure-model.ts` validates a structure and exports it.
- `src/services/county-structure-plan.ts` computes the change set and its hash.
- `src/services/county-structure-d1.ts` is the D1 service for reads, imports, edits, reversal and role displays.
- `src/transport/county-structure-api.ts` serves `/api/admin/county-structure/*`.
- `src/services/county-structure-public.ts` is the public reader.
- `src/editor/county-structure-client.ts` and `county-structure-view.ts` are the dashboard module.
- `src/site/pages/county-structure-section.ts` renders the public county section.

## Verification

The service tests run on an in-process SQLite and cover the 25 cases in `tests/county-structure.test.mjs`. The same service also runs against Wrangler’s local D1 engine in `tests/d1/county-structure-checks.mjs`, with 21 checks that include a county of 3,010 units, so chunked writes and keyset reads are exercised on the real engine. Both ran locally in the Linux workspace on the owner’s computer with synthetic data. They are local results only. Nothing here has run on the hosted Site.

## What is deliberately not done

- **No real data.** No audit table, provisional audit data or real Profile is imported.
- **No hosted change.** Migration 0031 has not been applied to staging or production, and nothing is deployed. The staging counts of existing tables could not be inspected from this session, so only the source and local migrations were inspected.
- **Legacy tables are not dropped.** See the retirement assessment below.
- **Not every public consumer reads the new tables yet.** The county page now has a County structure section that reads only the new tables and shows an empty state until data exists. The Officials “County structure” tab, organization profile pages, directory search and the sync planner still read the older `organizations` data. Moving them is a separate, ordered change.
- **No Profile role to unit link in Profiles.** Roles are attached to units through `county_role_display` in the dashboard. A direct unit field in the Profiles sheet is follow-up work.

## Proposed application of the approved naming and coverage rules

The [owner's naming decision](../decisions.md#county-structure-names-and-statutory-coverage--november-19-2026) governs this proposal. The approved CSV remains the input for the confirmed organizational structure.

1. **Inventory in `county.csv`.** Start with the latest locally validated statewide candidate and keep a hashed baseline. Keep the existing 17-column contract. Export supported local unit rows, documented reporting parents, and approved browse memberships. Preserve stable IDs, same-county scope, existing Profile links, and approved labels. Only change a unit's public name or relationships when the existing County Structure review supports that specific change. Apply the readable hierarchy fields to match the accepted changes. Keep tentative relationships and source provenance in the private audit record.
2. **Comparison in the private unit crosswalk and chart.** Join the private crosswalk to the CSV by county FIPS and stable unit ID. Store the exact label, canonical function, actual type, and verified parent ID. Keep distinct child functions and use verified parent relationships for broader totals. Treat a variation number as a chart reference. Retain the exact-label frequency chart and report functional totals separately.
3. **County coverage in the private statutory workbook.** Keep one row per county FIPS and reviewed obligation. Use the documented local label or the approved default. Keep evidence status, delivery mode, provider, and source separately. Link to a stable unit ID only where a verified inventory row represents the provider. Use provider references that allow multiple counties to point to the same district or shared agency. Represent funds, plans, and service agreements as coverage records. Leave pending entries in the coverage workbook while provider and placement evidence is unresolved. Keep consolidated-government metadata at the county level.
4. **County by county validation.** Reconcile the inventory and private companion records against retained evidence. Use Ouray for a simple display and parent review, Archuleta or Garfield for a parent and child example, and Denver and Broomfield for consolidated-government providers. Validate the exact CSV header, unique stable IDs, FIPS, parent scope, acyclic relationships, unchanged Profile links, and one credit per documented county obligation. Record the counts of inventory changes and deferred coverage entries separately. For an approved staging county, use the existing **Replace one county** preview and check the delta and public headings before a separate commit. Statewide replacement remains on hold.

Use the [CSV operator guide](county-structure-csv.md) for the approved import contract. Keep private row-level reports and evidence out of GitHub.

## Migration and legacy retirement assessment

The older tables stay in place and keep working. The plan below retires them only after the new structure is populated and the readers have moved. It is a plan, not an instruction to act.

| Step | What | Gate |
| --- | --- | --- |
| 1 | Apply 0031 to staging and complete the [staging checklist](county-structure-staging.md). | Owner approval of the staging change. |
| 2 | Convert the final audit tables to `county.csv` and load one county with Replace one county. Review it in the dashboard. | Owner review of that county. |
| 3 | Load the remaining counties, then take a checkpoint. | All 64 counties reviewed or marked empty. |
| 4 | COUNTY-DB-2: classify Profile roles into units and elected listings through the dashboard or a reviewed import. | Roles reviewed. Nothing inferred. |
| 5 | Repoint the Officials structure tab, organization profile pages, directory search and the sync planner from `organizations` to the new tables. | Each reader has its own tests and a staging read-back. |
| 6 | Freeze writes to the older organization hierarchy and compare. | The two views agree or the differences are explained. |
| 7 | Drop the older hierarchy columns and unused tables in a separate migration with its own backup and rollback. | Owner approval. Never in the same change as a reader move. |

Readers that still depend on the older tables today are the Officials directory and its structure tab, county overview counts, organization and person profile pages, directory search, the D1 inspection tools, the Profiles sheet, and the sync planner through `positions.organization_id`.

## Limits and follow-ups

- Replace all counties is bounded by the file limits of 1 MiB and 20,000 rows. A larger load should go county by county.
- Dashboard edits use the global version for concurrency. Two owners editing at once will see a stale-version message and reload, which is intended.
- The dashboard view is covered by build and type checks and by the hosted dashboard registry tests. It has not been exercised in a browser in this change, so keyboard, screen reader and narrow-width checks belong in the staging checklist.

# Profiles sheet

The Profiles module is an owner-only, Excel-style grid in the signed-in Beta-2 dashboard. It reads and writes the Website D1 database only. It works in a browser with no MCP connection, because it calls the same protected Worker routes as the rest of the dashboard. The private reviewed Profiles database is a separate system and this module never reads it.

## What it does

One row per role, keyed by the stable Profile ID and Role ID. A Profile with no role has exactly one row, keyed `profile:<Profile ID>`, with blank role cells that cannot be edited, so a hidden draft imported without its role can be searched, filtered, renamed and opened in the Names editor. Shared Profile fields and the Visible on Website checkbox repeat the same value on every row of a person. Search, County, Office / Unit and Visibility filters (All, Visible, Hidden and Missing information), sorting and paging run on the server with bounded page sizes. Edits are staged in the browser until Save changes. The save first shows an old and new preview with the impact on shared records, then sends one atomic batch with an idempotency key. Discard changes drops the staged edits. A stale version keeps the pending edits and offers to re-apply them on the latest versions.

Bulk actions are Set selected values for supported role fields and Profile visibility, plus the Hide selected Profiles and Restore selected Profiles shortcuts. The visibility field offers explicit Visible and Hidden values, applies once per distinct Profile (including roleless drafts), reports changes, already-matching Profiles and publication-ineligible skips, and uses the same guarded staging and save review as other edits. Selection and staging remain across page and filter changes. Each save still has a 500-change cap; the UI refuses to stage a bulk operation that would exceed it and explains how to reduce the selection. Select all matching remains capped at 1000 rows and says when it was truncated.

The remote grid defaults to 50 rows per page. Owners can choose 50, 100, 250, 500 or 1,000 rows; the server accepts up to 1,000 rows per request. Changing page size returns to page 1 while keeping filters, sort, selection and staged edits. The selector and result counter describe rows because one Profile can occupy multiple role rows.

## Routes and authorization

All routes are under `/api/admin/profiles` and are default-deny. Every request resolves the signed-in human principal first, then checks the `profile.manage` capability, which only the owner role holds. Agent credentials never pass. Writes also require an exact same-origin request, a JSON body under 256 KB and an `idempotency-key` header. Responses are `no-store`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/rows` | GET | One page of role rows. Query, county, office, visibility, sort, direction, page and pageSize. |
| `/facets` | GET | County and office filter choices. Office entries carry their county FIPS. When the response has a `nextOfficeCursor`, pass it as `afterOffice` to load the next set. |
| `/select-all` | GET | Stable IDs and versions for every matching row, capped at 1000. |
| `/preview` | POST | Validates changes and returns old and new values, impact and field-level issues. Writes nothing. |
| `/save` | POST | Applies the changes atomically. A repeated key with the same body replays the stored result. |

## Field map

Editable fields are written only through the sync allowlist fields (`people.display_name`, `person_roles.start_date`, `person_roles.end_date` and `person_roles.source_checked_at`) and Visible on Website. The service checks this at load, so a field cannot become editable here without also being in the sync allowlist. Fields marked Unavailable are listed in the column picker with the reason and are never fetched.

| Field | Status | Level | Source | Owner and what a later sync can change |
| --- | --- | --- | --- | --- |
| Profile ID | Read-only | Profile | people.id | Website. Assigned once when the Profile is created and never changed by a sync. |
| Full Name | Editable | Profile | people.display_name | Shared. The Website value is edited here. The private reviewed Profiles record is edited through its own workflow. A later reviewed sync replaces the Website value only through a preview and the expected-version check. |
| Visible on Website | Editable | Profile | person_visibility.visible (no row means visible) | Website only. Changed by an explicit hide or restore action. No sync ever reads or replaces it. |
| Promotion Reviewed By | Unavailable on the Website | Profile | Private Profiles database | Private Profiles database. Not stored on the Website and never synced to it. System-generated review metadata. It stays in the private Profiles workflow. |
| Promotion Reviewed On | Unavailable on the Website | Profile | Private Profiles database | Private Profiles database. Not stored on the Website and never synced to it. System-generated review metadata. It stays in the private Profiles workflow. |
| Reviewer Notes | Unavailable on the Website | Profile | Private Profiles database | Private Profiles database. Not stored on the Website and never synced to it. Private reviewer notes stay in the private Profiles workflow. |
| Status | Read-only | Profile | Visible on Website and the publication rule | Website. Computed. Visible, Hidden, Hidden · Ready to publish (hidden automatically, now complete) or Hidden with what is missing, such as Hidden · Missing role. |
| Created On | Read-only | Profile | people.created_at | Website. Set when the Website record was created, not the private research date. |
| Last Uploaded | Read-only | Profile | sync_batches.committed_at of the latest dashboard import | Website. The commit time of the most recent committed, unreversed dashboard Profiles import (`pi:` batch) that created or updated the Profile, one of its roles or one of its alternate names. Previews, failed commits, unchanged rows and same-key retries write no such item, so they leave it alone. Blank when no upload is recorded. Sortable, newest first. |
| First Name | Unavailable on the Website | Profile | No Website column | Private Profiles database. The Website stores one display name, so no component is derived from it. The Website keeps only the full display name. Verified name components are not on main. |
| Middle Name | Unavailable on the Website | Profile | No Website column | Private Profiles database. The Website stores one display name, so no component is derived from it. The Website keeps only the full display name. Verified name components are not on main. |
| Last Name | Unavailable on the Website | Profile | No Website column | Private Profiles database. The Website stores one display name, so no component is derived from it. The Website keeps only the full display name. Verified name components are not on main. |
| Alternate Name 1 | Unavailable on the Website | Profile | No Website column | Private Profiles database. Not stored on the Website and never synced to it. The Website has no alternate-name table, so Search covers the display name only. |
| Alternate Name 2 | Unavailable on the Website | Profile | No Website column | Private Profiles database. Not stored on the Website and never synced to it. The Website has no alternate-name table, so Search covers the display name only. |
| County | Read-only | Role | person_roles.county_fips, else the linked office's county, joined to counties.name | Shared. A role's county is set by a reviewed sync. This module does not write it. |
| County Unit | Read-only | Role | Parent of the linked organization (organizations.parent_organization_id) | Shared organization entity. Changed only through a reviewed sync of the organization. |
| County Sub Unit | Read-only | Role | The linked organization when it has a parent | Shared organization entity. Changed only through a reviewed sync of the organization. |
| Office / Department | Read-only | Role | person_roles.published_office, else organizations.name | Role text is written by a reviewed sync. The Website allowlist has no office field, so it is read-only here. |
| Position | Read-only | Role | person_roles.published_title, else positions.title | Role text is written by a reviewed sync. A shared position title is not edited from a single row. |
| Role / Duties | Read-only | Role | person_roles.job_description | Role text is written by a reviewed sync. The Website allowlist has no duties field, so it is read-only here. |
| Employment Start | Editable | Role | person_roles.start_date | Shared. Edited here on the Website. A later reviewed sync can replace it only after the preview shows the difference and the role's expected version still matches. |
| Employment End | Editable | Role | person_roles.end_date | Shared. Edited here on the Website. A later reviewed sync can replace it only after the preview shows the difference and the role's expected version still matches. |
| Affiliation | Read-only | Role | Direct county government, or organization_county_affiliations for the county | Shared organization entity. Changed only through a reviewed sync. |
| Date Reviewed | Editable | Role | person_roles.source_checked_at | Shared. The Website value is the source check date. A later reviewed sync can replace it through the preview and expected-version check. |
| Role ID | Read-only | Role | person_roles.id | Website. Assigned once when the role is created and kept through every sync. |
| Profile Version | Read-only | Profile | people.version | Website. System counter checked on every save and by every sync update. |
| Role Version | Read-only | Role | person_roles.version | Website. System counter checked on every save and by every sync update. |
| Source Citation | Unavailable on the Website | Role | role_sources and the private evidence record | Private Profiles database. Not stored on the Website and never synced to it. Claim-level evidence and citations stay in the private Profiles workflow and are never shown in this sheet. |

Everyday fields are shown by default. The stored Full Name is kept as the display name. No name components are derived from it, so First, Middle and Last Name stay unavailable until verified components exist on the Website.

## Sync ownership

A reviewed sync can update only the four allowlisted fields above, and each update carries the expected version of the record. The sync preview now lists, for every update, the Website value it would replace and the proposed value. A sync built from older data fails the expected-version check and changes nothing. A deliberate reviewed replacement is a new plan against the current version, and its preview shows the Website value that it overwrites. Visibility is outside this path. The sync allowlist has no visibility field, so a sync cannot read, set or reset it.

## Public visibility

Visible on Website is a Profile-level publication control stored in `person_visibility`. A Profile with no row is visible, so migration 0030 preserves the effective visibility of every existing record without writing any rows. Only an explicit hide or restore action changes it. Hiding does not change `people.version`, so it never makes a pending sync stale. Restore reuses the same Website ID.

### Publication rule (migration 0034)

A Profile may be visible only when it has a nonblank display name and at least one role with a county and an office, position or duties. The county is the role's own county, its office's county, or a county the office is affiliated with. Text-only roles qualify. Migration 0037 removes the citation requirement and keeps upload evidence private. A verified County Structure attachment and an alternate name are optional. The view `profile_publication_ready` is the one definition, and every reader uses it.

- **Import.** New Profiles are created hidden. A valid `profile.csv` row without a role is saved as a hidden draft.
- **Sheet.** Visible on Website is disabled while the Profile is incomplete. Its label and tooltip say what is missing. Bulk Restore leaves incomplete Profiles out and says how many.
- **Server.** Single and bulk visibility changes are refused with `not_eligible` and the missing items, checked against the final state of the save (a combined edit that blanks the name cannot publish). The batch also asserts the final state after every change, and a database trigger refuses any write that would leave a visible row on an incomplete Profile.
- **Automatic hiding.** Triggers on roles, display names, positions, office counties and county affiliations hide a public Profile the moment it stops meeting the rule, with `hidden_reason = incomplete` and no human actor. A Profile with another qualifying role stays visible. When the missing information is restored the checkbox is enabled and stays unchecked until the owner publishes.
- **Existing records.** Migration 0034 hid every incomplete Profile that was previously treated as visible, with reason `incomplete`.
- **Public reads.** The public visibility predicate also requires the rule, so an incomplete Profile is never public on any page, API, search or count.

A hidden Profile is removed from the public directory and browse lists, people search, the officials directory, county role lists and county role counts, county structure counts, organization role lists, the report grievance pickers and validation, and related people in editorial content. Its direct page and its `/api/people/<id>` response return 404. Existing staff report references stay intact. Public responses never include reviewer notes, review metadata or private citations, and the sheet payload omits them as well.

**Select all matching** opens a visibility review across every page of the active filters. The server counts each Profile once, previews how many will change, and shows how many already have that visibility or are incomplete. The owner confirms the change separately. A changed database snapshot forces a new preview. A confirmed change writes visibility, per-Profile audit events, and one retry receipt in the same batch. **Select matching rows** remains available for individual row edits.

The dashboard importer creates Profiles hidden. The external sync create path still creates a Profile without a visibility row, and the publication rule keeps it private until it is complete.

## Retry safety and audit

Each save writes its audit events and an entry in `profile_write_receipts` in the same atomic batch as the changes. The receipt stores the actor, the idempotency key, a hash of the request and the response. The same key and body replay the stored result and the same key with a different body is refused. Every changed row writes an audit event that names the owner account.

## Deploy order

Migration 0030 must be applied before the Worker that contains these changes, because the public read queries join `person_visibility`. Migration 0034 must likewise be applied before the Worker that reads `profile_publication_ready` and `person_visibility.hidden_reason`. Migration 0037 adds support for Website roles without citation links. Migration 0038 makes the publication triggers check each Profile by ID for large visibility changes.

## Not in this slice

CSV import, county-tree editing, creating Profiles from the sheet and editing organizations or positions are follow-on work. Alternate names, name components, review metadata, reviewer notes and citations need a private-to-Website design before they can appear.


## Delete one Website Profile

Select one or more Profiles and choose **Delete selected Profiles** next to **Hide selected Profiles**. The preview lists each selected Profile once, including selections on other pages. Review the Website IDs, counties, visibility, affected counts, and blockers, then select a reason and type `DELETE`. Each Profile is permanently removed in a separate audited request. If a request fails, the operation stops and reports how many succeeded. The private offline master stays authoritative and is outside this write path.

The owner-only `POST /delete/preview` and `POST /delete/commit` routes under `/api/admin/profiles` use the existing human session, capability and same-origin guards. Commit checks the reviewed dependency snapshot and takes an actor-scoped idempotency key. Active grievance subjects, editorial associations and duplicate-review records block the delete. Existing history remains available as historical ID snapshots. The atomic write removes alternate and legacy names, visibility, County Structure role display links and roles, then the Profile. Shared and unused source catalog records both remain available for reuse. The actor, reason, target and counts are recorded without copying name or source contents into the new audit event.

Migration 0035 preserves append-only name events and makes intentional deletions distinguishable from stale mappings. The migration and matching Worker source are both needed before hosted acceptance. Test with a disposable staging fixture only. Verify public detail/API/search and county reads, check surviving shared sources and unrelated batch rows, and reconcile the fixture to its baseline. Real Adams and statewide replacement stay on hold.

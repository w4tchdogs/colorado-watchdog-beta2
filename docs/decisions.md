# Current decisions — November 12, 2026

This is the durable **owner-decision register** for beta-2: it records what the
owner has selected, not day-to-day implementation or deployment status. For
current implementation, deployment and assignment status, see
[CURRENT](coordination/CURRENT.md); do not use this file as a changing
implementation ledger. Historical entries below are preserved as written; a
dated status update follows them rather than rewriting them.

**Binding, easy to find:** the backbone decision below selects an **AI-first
modular architecture with one relational Website D1 database, R2 files, and a
shared dashboard/API/MCP service layer**. This is an owner decision, not a
proposal, and later planning must not demote MCP to an optional add-on. See
[CURRENT](coordination/CURRENT.md) for its current implementation,
publication and hosted verification state.

Current technical assessment: [Fable assessment revision 4](architecture/fable-assessment-rev4.md). See the [revision 4 section](#revision-4-technical-assessment-november-12-2026) below. The first two sections are the earlier decision records and remain as written.

Authority: [Fable assessment revision 3](architecture/fable-assessment-rev3.md), originally read through the connected Drive account (repository copy since November 14, 2026). The owner's bootstrap request determines this task's scope and resolves conflicting recommendations or residual tables in older documents.

| Topic | Current direction | Superseded choice |
| --- | --- | --- |
| Cost/hosting | $0 incremental; existing Sites plan and free GitHub capabilities; verify limits | Render or other paid hosting assumptions |
| Starting data | Empty beta-2; preserve beta-1 separately | Beta-1 migration, cloning its complete source/data/captures |
| Content | Site-managed Posts later | WordPress |
| Files | Files page later; optional simple/free/useful FileZilla | Mandatory SFTP/server |
| Operations | Automated checks, audit, checkpoints, reversible operations, trash/restore | Routine human authorization, per-change approval, required reviewers |
| Shared history | One private GitHub repository; branches and PRs; assistant merges green changes | Separate assistant copies as competing records |
| This task | Starter collaboration pipeline only | Starting all of Fable's M0, creating/deploying a Site now |

Older records remain historical, not deleted or rewritten. No matching policy, importer, data model, publication feature, or backup service is implemented by this decision note. Account capability gaps are technical limitations, not new approval gates.

## Owner's later beta-2 planning and coordination decisions — November 12, 2026

These decisions describe intended architecture and collaboration; they do **not** claim that website features, SQLite research tooling, or MCP have been implemented.

| Topic | Selected direction |
| --- | --- |
| Backbone | AI-first modular design; one relational website D1 database, R2 files, shared dashboard/API/MCP service layer, early unified accounts, efficient bulk updates and recoverable backups |
| Content | Site-managed Posts and stories as a central feature; beta-1 page patterns as reference only |
| Research | Separate Windows 11 SQLite research database, DB Browser for SQLite; AI-led, county-by-county screening outside the Site |
| Profile eligibility | An eligible Profile role needs a linked source. The recorded source discovery date serves as its verification date. |
| Identity | Initial pre-import screening, then nonblocking possible-duplicate flags, later evidence-supported AI maintenance; name/nickname similarity alone never proves identity |
| Research memory | Proposed 19-table relational model, including county-specific organizational structure, source discoveries and visits, coverage, role targets, aliases and website sync |
| Shared AI memory | One GitHub repository, issue handoffs, checked PRs for durable documentation, short shared instructions and optional Project bootstrap text |
| Chat titles | Standard `model | description`; Archon `💠model | description`; unspecified-model Chat mode `💠| description`. Lowercase, concise; no colored thinking-level markers or mandatory batch IDs |

See [sanitized architecture handoff](architecture/beta-2-planning-handoff.md). Any later implementation still requires a scoped task; keep the initial beta-2 database empty.

## Revision 4 technical assessment (November 12, 2026)

[Fable assessment revision 4](architecture/fable-assessment-rev4.md) is the current technical assessment. It supersedes the recommendations of [revision 3](architecture/fable-assessment-rev3.md) where they differ. Revision 3 stays as history.

Revision 4 restates the owner decisions recorded above and adds technical proposals. A proposal is not an owner decision. It is the working design and can change through normal scoped work. Nothing in this section is implemented.

| Area | Owner decision already recorded above | Revision 4 technical proposal |
| --- | --- | --- |
| Import | Research, screening and identity analysis in the local SQLite database. Version-checked changesets to the Site. The Site assigns profile IDs | The Site keeps a paged read API with row versions, one changeset endpoint with dry run and safe retries, sync batch records with revert, rule checks only, and a public source citation per role. Revision 3's Site-side CSV import pipeline is withdrawn |
| Backup | Cover D1, R2 and the deployable application version. Automated encrypted off-site copies. Tested restore. Destination and schedule open | A producer on the Site, a restore-based verifier and a swappable destination adapter. Revision 3's GitHub release destination is withdrawn as a fixed choice |
| Accounts | Early unified accounts for guests, contributors, editors, administrators, owner and attributable AI agents | An account has a kind (human or agent) and a role. Full model in the schema from the start. Stage A: owner, administrators and agents. Stage B: contributors and submissions. Stage C: guest submissions and reports |
| Identity | Pre-import screening. Nonblocking possible-duplicate flags. Evidence-supported maintenance. Name or nickname similarity never proves identity | Revision 3's exact-name association rule is removed. Local claims stay distinct. The Site stores duplicate flags and reversible merge redirects. A default evidence standard applies |
| Site schema and roadmap | One typed relational D1 database. Empty start | A smaller Site schema. A sync API milestone plus a separate local research tooling track |

### Remaining owner choices

None of these blocks current work. Each has a default or is needed only at the stated point.

| Choice | Needed | Default until chosen |
| --- | --- | --- |
| Off-site backup location | Before a backup destination is configured | Build the producer and verifier. Keep the on-Site copy. Configure no off-site destination |
| Evidence standard for treating two observations as one person | Before real county data is screened | The default in revision 4 section M |
| Contributor sign-in method | Before stage B | Not needed for the first release |
| Beta-1 hosting after January 1, 2027 | When Sites hosting becomes metered | Beta-1 unchanged |
| When to create the beta-2 Site | Before milestone M0 | Not created as of November 12, 2026 — **superseded**, see the status update below: the beta-2 Alpha-1 Site has since been created and deployed |

## Status update — November 14, 2026 (COORD-1)

This section corrects drift identified in Issue
[#93](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/93) without
rewriting the history above.

- **Site creation.** "Starting data: Empty beta-2" (first table) and "When to
  create the beta-2 Site: Not created" (above) were accurate initialization
  decisions on November 12, 2026, before any Site existed. They describe a
  starting state, not a continuing claim that the Site remains uncreated. The
  beta-2 Alpha-1 Site has since been created and deployed; see
  [CURRENT](coordination/CURRENT.md) section D for its last-verified
  deployment evidence. Older planning text that still says the Website "has
  not been built" describes history at the time it was written, not the
  current state — see the corrected pointers in README.md and
  [beta-2-planning-handoff.md](architecture/beta-2-planning-handoff.md).
- **MCP is not a proposal.** The dashboard/API/MCP service layer in the
  Backbone row (owner's later planning decisions, below) is a selected
  architectural requirement. No later technical assessment, including Fable
  revision 4, downgrades it to optional. It has **no implementation yet** —
  that is a status fact tracked in CURRENT, not a reopening of the decision.
- **Two distinct databases.** The Backbone row's "one relational website D1
  database" and the Research row's "separate Windows 11 SQLite research
  database" are two separate stores by owner decision. Nothing in this
  register or in revision 4 merges them; synchronization between them goes
  only through the accepted M2/R7/R8 changeset architecture.
- **Revision 4 proposals stay proposals** unless a later dated entry in this
  file adopts one as a decision; the table in the
  [revision 4 section](#revision-4-technical-assessment-november-12-2026)
  already marks which rows are owner decisions versus technical proposals.
- **D1-0015-ACCESS-1** (a standalone plan to obtain one-off hosted D1 access)
  is superseded: administrative hosted-D1 access is intended to come through
  the MCP-first architecture above, not a bespoke access script.

## Status update — November 14, 2026 (COORD-1A)

- **MCP has a merged read-only local foundation** (PR #95): a Website
  inspection MCP endpoint and a Profiles readiness MCP server, both
  aggregate-only with no write, sync, import, or migration tool. This
  corrects the COORD-1 status update above, written earlier the same day,
  which still said MCP had no implementation. Hosted Site publication of
  the MCP endpoint remains not done; see [CURRENT](coordination/CURRENT.md)
  for current detail. This is a status fact, not a reopening of the
  backbone decision.

## Coordination consolidation, November 14, 2026

- One 💠archon coordinates both Website and Profiles. The separate Profiles
  Archon is retired.
- Other chats in the project are task chats. They report results to the
  💠archon through GitHub (Issue, PR, or CURRENT row).
- The 💠 chat-title prefix is reserved for the single coordinating chat.
  This supersedes the earlier "Chat titles" row for all other chats, which
  use the standard `model | description` format.
- Active county research is paused by the owner because the research database
  is well seeded.
- Existing Profiles architecture decisions are unchanged: a separate local
  SQLite research database, a separate Website D1 database, synchronization
  only through the accepted R7/R8/M2 architecture, and the existing identity
  evidence rules.

## Google Drive retirement, November 14, 2026

- Google Drive is retired for project coordination. GitHub is the canonical
  record for instructions, decisions, status and handoffs.
- Long reference reports needed by collaborators are committed to the
  repository. The Fable assessments are at
  [revision 4](architecture/fable-assessment-rev4.md) (current) and
  [revision 3](architecture/fable-assessment-rev3.md) (history).
- All local and private material (the Profiles research database, private
  research, archives and Beta-1 history) lives in the owner's local Watchdog
  folder and is never committed. Beta-1 material is archived there under
  `archive\beta-1`.
- Stale material is moved to the workspace `_trash` folder instead of being
  deleted. Only the owner deletes.

## Beta-2 launch goals, November 14, 2026

- Launch means Beta-2 replaces Beta-1 as the public site. It requires all
  six goals in the [roadmap](coordination/ROADMAP.md): AI administration
  through MCP, a populated hosted database with per-county counts, sign-in
  and sign-up for admins and editors, guest grievance submission, a working
  blog workspace with at least three published installments of "The
  Idlewild Story", and Beta-1's look, search and browse functionality.
- Public grievance counts include reviewed submissions only. Reporters may
  submit under an anonymous name, as in Beta-1.
- "The Idlewild Story" comes from the owner's existing drafts, about 15
  installments written in another AI account. They were never Beta-1
  records. The owner approves each installment before publication.
- The development pause is lifted with the adoption of the roadmap.

## Alpha-1 Website D1 initialization, November 14, 2026

- The owner confirmed that Alpha-1 had no real application data to carry
  forward and directed initialization to proceed. The Sites database
  viewer showed an existing `DB` binding with a seeded county registry
  and empty application data tables. Use that binding and apply pending
  migrations through the normal Sites deployment. The pre-migration hold
  and MCP provenance sequence in DEPLOY-1A do not gate this initialization.
- Keep one Website D1 and the shared dashboard/API/MCP architecture.
  AUTH-3/AUTH-4 retain provider and first-owner ownership. Establish a
  supported hosted backup and isolated restore before relying on hosted
  D1 for real records.

## Dashboard priority and content pause, November 15, 2026

- Prioritize one WordPress-style Website dashboard for signed-in human account holders, editors, administrators and the owner. Show tabs and actions according to existing server-verified capabilities. The prepared first slice is Overview, My Account and a working Posts & Stories workflow. Use the archived Beta-1 dashboard as a layout and workflow reference.
- Hold CONTENT-1 and use generic Lorem Ipsum in local editorial fixtures. Keep the real Idlewild drafts private and the existing launch goal on the backlog.
- On November 17 the owner requested continuing work on the Posts & Stories dashboard editor from the existing local EDIT-2 slice. The CONTENT-1 pause still applies.
- The dashboard is the manual operator surface while hosted D1/R2 access and verification are open. The existing Website D1/R2 and shared dashboard/API/MCP backbone still applies. The supplied generic CMS prompt and framework, browser-storage and generic database follow-ups are reference material only. The owner will say when the prepared Fable assignment is initiated.

## Profiles publisher classification and private export, November 15, 2026

- Classify a source publisher as `official` only when the material is published by a government body or issued by it through a verified publishing channel. Classify it as `unofficial` when available evidence establishes a nongovernment publisher. A URL suffix, file extension, or hostname by itself does not establish publisher identity.
- Keep publisher classification separate from `page_type`, which describes the page or document. Preserve legacy `official_status` values, including `partner` and `other`; never bulk-convert them without source-specific evidence. A linked source with an unestablished publisher remains `unresolved`. A profile with no linked source has a true `null` classification in the export.
- Preserve all sources and their individual classifications, citation URLs, evidence, attachments, audit history, batch selection, identity links, and organizational relationships during source correction. Do not replace or delete prior classification evidence.
- Keep Profiles exports private in the owner's Watchdog workspace. Scope to one or more canonical county FIPS codes or an explicit statewide selection before applying the profile limit. One distinct person is one profile record regardless of role count; retain the county and role links for every exported role. Deduplicate a person across selected counties by profile ID.
- Limit each export to 10,000 distinct profile records. Use deterministic profile-ID ordering, visibly mark truncation, and continue after the last profile ID. Include official and unofficial citations, preserve unresolved publishers as a separate state, and exclude private research notes, raw captures and unrelated personal data.
- Keep the local Profiles export separate from Website M2 changesets and hosted write controls. This decision does not authorize a hosted migration, sync submission, or public publication.

## Profiles and Website role citations, November 16–17, 2026

- A linked source satisfies the role's evidence requirement. The owner confirmed
  that every source already in the Profiles database was verified when it was
  found. Apply this decision to all counties and all existing review queues.
- Use the recorded source discovery date as the verification date. If the source
  has no separate discovery date, use the retained reported check date. Leave
  an unrecorded date unset. A source link does not require a repeat visit.
- Preserve the private evidence link, original role wording and any documented
  date. Website role records retain the linked public source and its URL, title,
  publisher classification and page type. Keep publisher classification
  separate from page type. The existing Website public-source metadata and
  official-evidence rules for identity, organization names and county
  affiliations remain in force.

### Public display of Profiles evidence, November 17, 2026

- Retain supporting evidence for each role in the private Profiles workflow. The existing Website sync contract carries role-source metadata for validation and audit.
- Public Website pages and unauthenticated directory responses must omit Profiles citations, including their titles and URLs. A source-check date may be shown as a date. This decision is limited to Profiles.

## Profiles eligibility and same-name merging, November 16, 2026

- A Profile needs a county, a name, and at least one of an office, a position, or a job description.
- Within the same county, claims with the same name are merged when their office, position, or job description align. County plus name alone is not enough; name or nickname similarity without an aligned role descriptor does not establish a merge.
- An unknown organization type or unresolved hierarchy is not, by itself, a reason to exclude an otherwise qualifying Profile.
- Keep each supported role, its office/position/job-description text, county association, source citation and evidence history. Do not turn a responsibility into a job title.
- The owner reaffirmed on November 17 that private Profiles include both current and former county officials and employees. Apply the same identity, role and linked-source standard to former roles. Preserve the original listing status and documented employment dates. Leave unknown dates unset.
- The owner directed on November 17 that confirmed role titles omit the standalone word “County”. Preserve the source wording, county and office or department separately. Apply the standalone “County” rule case-insensitively and treat “and” and “&” as equivalent for title matching. Consolidate variants only when they describe the same role for the same person. Keep an existing Role ID and retain every supporting claim, source link and history entry. Preserve distinct offices, duties or terms supported by the evidence. See the [owner direction](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/240#issuecomment-6957807253). For example, “County Clerk and Recorder” and “Clerk & Recorder” describe one Clerk & Recorder role, and “County Treasurer” and “Treasurer” describe one Treasurer role.
- This decision supersedes conflicting earlier identity evidence defaults and R7 eligibility assumptions. The identity planner, R7 generator and local Website reads implement it as of SYNC-1. Apply the source-link rule recorded above to every qualifying role.

### Confirmed Profiles elected-office grouping, November 17, 2026

- Use **Elected Official** as the county-specific display unit. Use the documented office as the subunit for Assessor, Board of County Commissioners, Clerk & Recorder, Coroner, Sheriff’s Office, Surveyor, Treasurer and Public Trustee. Apply the rule to new batches and supported existing assignments through the normal coordinated write window.
- The display hierarchy records navigation. Preserve the researched organization hierarchy, documented position and duties, election and former status, dates, role IDs and source wording. Keep the full Board of County Commissioners office name. The standalone “County” omission applies to confirmed position titles.
- Review Treasurer and Public Trustee county by county. Use a combined display label when the retained evidence supports it and preserve distinct documented offices or roles. The same officeholder alone is insufficient evidence for combining the offices. Flag unresolved cases for review. See the [owner direction](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/240#issuecomment-6965128633) and [independent audit](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/240#issuecomment-6965409800).
- **November 19, 2026 directory decision:** Use separate Treasurer (or Treasurer’s Office, as documented) and Public Trustee browse links in Arapahoe, Gunnison and San Miguel. Keep the combined Treasurer / Public Trustee heading live in those counties until both destinations are verified to show the correct reviewed roles. The other nine cases in the [directory display audit](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/240#issuecomment-7001252256) keep the combined heading under the existing rule. This decision covers directory navigation. Structural parentage, Profile-to-Role mapping and individual elected membership remain separate reviews.

## Profiles database column names, November 16, 2026

Use the approved plain-language names as actual SQLite column identifiers in
People, Roles, Sources, and their supporting tables. Preserve the original row
values and evidence, keep the machine-facing CSV and export keys stable, and
ship the schema migration and updated Profiles tools together. The local
operator procedure is in [the Profiles foundation guide](research/R0-foundation.md#plain-language-columns-in-db-browser).

## Website sync batch size limits, November 16, 2026

- The original 200 change, 25 citation and 200 changed row caps were first-draft defaults with no measured basis and are removed. A batch is bounded by an 8 MiB request and 32 KiB per change, and the design target is up to 10,000 changes per batch.
- Website migration 0023 widens the stored batch result limit from 64 KiB to 1,900,000 bytes so a 10,000 change batch fits inside the 2 MB D1 row limit.
- This is verified locally only. Hosted D1 limits on one atomic batch of that size and on Worker subrequests have not been tested, so hosted use of very large batches needs its own check before it is enabled.

## Cloudflare hosting transition and first-owner target, November 16, 2026

- Move Website hosting to the owner's Cloudflare Workers, Website D1 and private R2. Stage and verify on Cloudflare before any public cutover. Keep the original Sites deployment and DNS in service during staging. This decision supersedes using Cloudflare to obtain access to the Sites-managed Worker or database. Keep the private Profiles database local and move eligible Website records through the accepted sync boundary.
- Use the existing AUTH-3 Auth0 application and GitHub connection for staging. Append the staging callback and retain the Sites callback. Keep sign-in disabled until the guarded private first-owner bootstrap is verified. Public registration, Turnstile and guest intake stay disabled for this staging phase.
- The public hostname and cutover timing remain open. Record the disposition of existing Sites R2 objects before retiring the Sites deployment. See [Cloudflare staging evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/173) and [hosted staging sign-in evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/174#issuecomment-6932672296).

## Hosting and MCP operator priorities, November 16, 2026

- The owner prioritizes Cloudflare for Website sign-in, dashboard and data work. The separate first-owner setup on the existing ChatGPT Sites URL is withdrawn. Keep that public Site in service during the transition. The owner explicitly deferred preparing or executing the public cutover. See the [owner’s Cloudflare priority](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/168#issuecomment-6939221622).
- Future Profiles MCP operation should work from ChatGPT Work/Codex with access to the owner's Windows workspace, without relying on Claude Code. Preserve distinct evidence for native ChatGPT connectivity, scripted hosted transport, and the R6/R8 operator bridge. See [PR #204](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/204) and the [R6 driver verification](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/202#issuecomment-6940902868).
- The owner made this repository public for transparency and standard Actions compute availability. The existing boundaries on private research, credentials and original artwork still apply.
- The owner confirmed the approved-folder lineage and the reviewed caption and alt text for the single Adams banner pilot. That decision is limited to the selected artwork. See the [approved-artwork pilot preparation](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137#issuecomment-6933879397). Its scope is the county page on Cloudflare staging.

## Local review and Alpha-1 staging releases, November 20, 2026

- Review Website changes locally by default. Give the owner the [local preview command and link](../README.md#public-website-preview) for the affected page when handing off a change. Use the checkout or worktree containing that source and follow the [paste-ready PowerShell format](../AGENTS.md#paste-ready-powershell). GitHub `main` records the latest merged source.
- Retain D1 as the Website database and reduce live reads for public browsing. Start with [the static county registry](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/320). Keep private and authorization-dependent paths on the existing service and evaluate further public projections against freshness and privacy requirements in [Issue #319](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/319).
- The owner may load draft Profiles workbooks and County Structure CSVs into a dedicated private [local review database](../README.md#private-draft-review). The local dashboard and public-page preview share that database and apply the normal publication rules. Keep the draft inputs and database out of GitHub, hosted storage, and the private Profiles research database.
- The owner may also review approved banner images in the same private preview. Keep local image copies and banner history in the draft database. Banner publication there applies only to the local browser preview. Keep the approved originals in the owner's private banner folder.
- Deploy passing changes to the shared [Cloudflare Alpha-1 staging Worker](https://colorado-watchdog-alpha1-staging.dauthfamilymail.workers.dev/) when the owner asks for a release. Each release can include several merged changes. Use the [staging runbook](deployment/cloudflare-staging.md) and verify the affected hosted paths. Record the exact source, Worker version, and verification result in the relevant GitHub thread. If deployment access is unavailable, record the blocker and the source ready to deploy.
- Public Sites publishing and production cutover remain separately scoped. Existing account, data, and intake boundaries apply to the shared staging release.

## Public report attribution, November 16, 2026

- Guests and account holders can choose Anonymous (default), Sign with my initials, or Use a generated pseudonym. Enter initials directly. Generate another is available for a pseudonym, with no free-text editing. A private account name is not copied to the byline. Explain on the form that report details can still identify the contributor. Verify name-list provenance before describing the lists as national top-100 rankings.
- Show the exact byline before certification and record its mode and value on the certified revision. Edits clear certification. Only the approved revision supplies the public byline, and private names and contact details stay outside the public projection.
- Keep an existing approved byline visible while a replacement is under review. Let the authorized reporter immediately switch a published byline to Anonymous through an audited, report-specific action that preserves the original certified revision privately. Showing a name again requires new certification and editorial approval. Future guest change authority is report-specific. Existing status tracking does not give that authority.
- The [owner approval](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/184#issuecomment-6940889112) is the original decision record. The [Beta-1 form reference](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/184#issuecomment-6940138593) documents archived behavior and differences. The subsequent archived-source inspection confirmed two pools of 100 unique names, independently sampled, but did not establish that they are the overall national top 100. It also confirmed that guests and account holders share the same signing editor and that Beta-1 supported a separate display override. The hosted Beta-1 review step failed to load, so those findings are source-only. This is a design decision for subsequent revisions and editorial release work.

## Human operation of Profiles, November 17, 2026

- The owner requires a human-operated way to manage Profiles. A person must
  be able to find and edit records in the private Windows Profiles database,
  review the proposed Website changes, and carry out the approved sync
  without depending on an AI session or an MCP connection.
- Preserve profile identity, source evidence and edit history. Send approved
  public changes through the existing changeset and receipt boundary between
  local Profiles SQLite and Website D1.
- The editor, human sync access design and choice of table names or views
  are open design questions. MCP remains an AI operator interface.

## Local Profiles data areas, November 17, 2026

- Keep People Research and County Research distinct in the local database.
  Prefix all research tables with `research_` and order the adjacent research
  areas by name from sources and observations through reviewed conclusions.
- Use Profiles for confirmed records prepared for the Website. Keep research
  observations distinguishable from confirmed Profiles and keep Website
  submission state distinguishable from local confirmation.
- Proposed tables and the complete v5 mapping are in the
  [local Profiles database redesign](research/local-profiles-schema-redesign.md).

## Required county for confirmed Profiles, November 17, 2026

- Every confirmed Profile has exactly one required county. `profile_county` is the single authoritative link and references the canonical code in `county`. See the [v7 scope](research/local-profiles-schema-redesign.md#county-decision-and-v7-scope).
- County Research supplies a researched unit’s county and parent. A role may rest on a documented office, position title or job description before a structured unit is resolved.

## Local Profiles table names, November 17, 2026

- The current naming plan uses `county`, `profile`, `county_research_*`,
  `profile_research_*` and `research_*` for shared research. It replaces
  the earlier single numbered research block.
- Use `county_research_coverage` and `profile_research_role`. The
  `profile_research_role_selected` view shows role observations from
  selected import batches.
- The owner chose `website_change_receipts`, `website_id_evidence`,
  `website_ids`, `website_request_changes`, `website_request_receipts`,
  `website_requests`, `website_reversal_receipts` and
  `website_update_approvals` for Website sync. The
  [full inventory](research/local-profiles-schema-redesign.md#full-table-and-view-list)
  records the working naming plan and the migration conditions for the three
  empty legacy tables.

## County Structure database and single-file import, November 18, 2026

- The owner selected a new, clean County Structure database in the existing Cloudflare Website D1. There is no second D1. The `organizations` table is not the canonical County Structure, and the County Structure tables do not read from it or write to it. This supersedes the earlier assumption that `organizations` would be extended or reused for county units. The design is in [County Structure](architecture/county-structure.md).
- The structure is edited and bulk loaded through one file, `county.csv`, with the 17 columns in the [county.csv contract](architecture/county-structure-csv.md). This is separate from, and does not revive, the withdrawn Profiles CSV pipeline. The file has no mapping companion. The Office or unit ID is the stable key and names are never matched.
- The Sheriff’s Office is normally a top-level County Unit. “Elected Official” is a navigation and display group and not a structural parent. This supersedes the November 17, 2026 navigation rule that placed the Sheriff’s Office under Elected Official. One Profile and role appear in both views through a reviewed classification, with no duplicate Profile or role. Elected status comes only from an explicit reviewed classification, never from a name or from the file.
- Imports offer merge, replace one county and replace all 64 counties. Each is a preview followed by an explicit commit in one atomic transaction, with a version check, an idempotency key, a receipt, audit history and a reversal that is refused when later changes or Profile references depend on it. A Profile reference blocks removal of a unit.
- Evidence for relationships and source references are private. They round-trip through the file and appear only in the owner dashboard. No public API or page returns them.
- The public county page reads only the new tables and shows an empty state until data exists. The Officials structure tab, organization profiles, directory search and the sync planner still read the older data and move in a separate step. Old tables are not dropped here. The ordered retirement plan is in the [assessment](architecture/county-structure.md#migration-and-legacy-retirement-assessment).
- No real or provisional audit data is part of this change. Migration 0031 is source only until the owner approves a staging migration.

## County Structure import and organizational display — November 18, 2026

- **New canonical Website County Structure schema:** The owner rejected using the existing `organizations` table as the canonical structure. Build dedicated Website D1 `county_unit` and related names, parent/display, history and import tables; preserve the canonical 64-county FIPS registry and inspect actual existing data/dependencies before any legacy retirement. Existing unrelated tables must not be dropped blindly. The Website D1 remains separate from the private Windows research SQLite database.
- **Single owner-facing `county.csv`:** All 64 county organizational hierarchies must be uploadable, previewable, updated/replaced and exportable through one dashboard CSV; internally normalized tables are an implementation detail. Approved proposed 17 columns in order: `County code`, `County name`, `Office or unit ID`, `Office or unit name`, `Parent office or unit ID`, `County Unit`, `County Sub Unit`, `County Sub Sub Unit`, `Organization type`, `Alternate names`, `Relationship to parent`, `Evidence for relationship`, `Source references`, `Applies from`, `Applies until`, `Display order`, `Status`. Provenance columns are optional, private, not public-facing. Parent IDs are authoritative; deep hierarchy and stable IDs must survive round trip. A guarded one-county or statewide structure-only replacement must protect existing role/Profile links.
- **Elected-office classification is not structural parentage:** Sheriff's Office is normally a top-level County Unit alongside other county units, **not** a subunit of `Elected Official`. An evidence-supported elected Sheriff may also appear in an Elected Officials listing, sharing one canonical Profile and role; a separate reviewed display membership handles the second listing. County-specific evidenced exceptions remain possible. This qualifies/supersedes the November 17 elected-office display grouping wherever it treated the Sheriff's Office as a structural child. Do not automatically reparent researched units.
- **CSV approval is specific to County Structure:** The revision-4 withdrawal of the older Site-side general Profiles CSV pipeline remains in force; this new County Structure CSV importer is a distinct approved owner workflow. Profiles still require protected review, changesets and receipts.
- **Audit inputs:** All exported research/confirmed SQLite tables have been shared as Google Drive CSVs so the audit chats can work without local Windows access. Drive remains **retired as project coordination authority**, which is GitHub; this use for private data transfer/audit inputs is intentional and distinct. Do not request Windows access as a prerequisite to a CSV-based audit. No real data import is authorized by this decision.

## Profiles primary and alternate-name design — November 18, 2026

- The final proposed `profile.csv` must use separate `First Name`, `Middle Name`, `Last Name`, optional `Name Prefix`/`Name Suffix`, `Preferred First Name`, and `Display Name`, in addition to its stable Profile ID and existing relationships. Retain original `Full name` from source snapshots for traceability; do not invent components through naive name splitting.
- A new related `profile_name.csv` provides **unlimited typed alternate names** rather than fixed `Alternate Name 1/2` columns. Each name has its own stable ID, Profile ID, type (nickname, preferred, birth/married/former surname, professional, initials, spelling variation, etc.), available name components, exact published form, optional dates/source evidence, verification status and explicit public-display permission. Additional evidence associations must be preserved without duplicate people/names.
- Alternate names and uncertain identity claims are primarily internal research/search aids; **public display defaults off until reviewed and approved**. Do not infer marriage or legal name changes from a different published surname. Do not auto-merge similarly named people. The final audit proposes revised CSVs and migration specifications; no source, local SQLite or hosted D1 mutation is implied.
- The Website Profiles dashboard should extend the existing PR #257 grid for these name fields and typed alternate names, with versioned owner-only writes and public-read restrictions; coordinate with the separate new County Structure implementation. Use synthetic fixtures until approved statewide data is available.
- **Staging test data decision:** The owner permits use of reviewed real county Profiles for staging acceptance after a scoped preview and evidence/visibility review; synthetic-only fixtures are no longer a standing requirement for that later test phase. This does **not** constitute approval to import unresolved audit cases, to import all 64 counties, or to publish private research material, and no real import has yet been performed.

## Protected Profiles name sync — November 19, 2026

The owner approved these rules for the protected alternate-name sync follow-up to [PR #261](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/261). Use the existing M2/R7/R8 review, changeset and receipt boundary between private Profiles SQLite and Website D1.

1. **Original research Full name.** Keep the exact source value in the private Profiles ledger for traceability.
2. **Changes to public alternate names.** Hold sync changes to an already-public alternate name for owner review, including evidence-only additions, replacements, detachments and clears. Keep the current public name and owner publication settings in effect while the proposal is pending.
3. **Pending proposals.** Keep distinct proposals for the same name open until the owner explicitly resolves them. A newer proposal leaves earlier proposals pending. A pending proposal becomes out of date when its base version differs from the current record version. Recheck the current record version at acceptance and require fresh review for a stale proposal.
4. **Recovery.** Require explicit approval for each recovery of a reversed sync-created alternate name.
5. **Removal attribution.** Record the sync account as the actor that performed an automated removal.
6. **Traceability after reversal.** Retain detached evidence and reversed mapping rows so their original links and Website IDs remain traceable.
7. **Imported publication flags.** Warn when an incoming v5 row is marked Public or Confirmed. Create the alternate name private with status `requires_review`.

The [v5 evidence-link replay audit](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/240#issuecomment-7001257592) verified all 314 IDs across 136 alternate names on the retained snapshot. The [v5 to v6 revision 3 audit](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/240#issuecomment-7011013389) verified stable IDs for all 307 retained links and reconciled the seven withheld links to private history. The v6 candidate used retained inputs. Compare future source snapshots before using them to update existing private evidence links.

These decisions govern the contract. Implementation, working-database verification, hosted acceptance and real-data sync remain separate work.

## Profiles export eligibility and County Review hold — November 19, 2026

- **Profile duplicate audit.** The owner approved the 206 proposed consolidations on the private Profile Duplicates review tab. Keep all other cases on that tab held and exclude their affected Profiles from the next `profile.csv`. That includes the 81 keep-separate recommendations and 51 existing holds. Apply approved consolidations only where they can be reconciled with this hold and other open blockers. Keep a withheld Profile out of the export even if it also appears in an approved consolidation. Retain the underlying Profiles, links and source evidence privately.
- **Employment cutoff.** Withhold anyone whose final documented working date is earlier than January 1, 2010 from `profile.csv`. Evaluate the person’s retained role history across counties and approved consolidations. An old role alone does not disqualify a person with later documented work. Leave unknown dates unset and flag cases where the available evidence cannot establish a final date. Use employment evidence to establish the cutoff and keep source publication, discovery and verification dates as separate provenance. Preserve the withheld records, supporting evidence and source references in the private Profiles database so future work can reuse retained evidence and avoid re-scraping the same sources for those records.
- **County category display and relationship holds.** Show every county unit under the applicable grouping used by that county, such as Elected Officials, Departments, Offices, Boards or Commissions. When a unit's actual parent or reporting relationship is unknown or held, place it directly under the applicable generic category heading. Use the county's own grouping where documented. Use **Other** when no supported grouping can be identified. For a given unit, render one public label when its recorded names differ only in whitespace, including spaces around a hyphen or slash. Keep exact source spellings in private evidence. A whitespace match alone provides no basis to merge separate unit IDs. The heading is the unit's browse parent and carries no reporting relationship. Carry forward independently verified relationships and stable IDs. Retain proposed or uncertain relationships in the private review queue until verified.
- **Statewide County Structure candidate row status.** The owner approved including all 49 previously flagged rows as active in the private 507-row `county.csv` candidate. This covers 48 Treasurer / Public Trustee office-structure review rows and the Yuma Sheriff’s Office source-verification row. The standardized Treasurer / Public Trustee label applies in the candidate for Lake, Larimer, Las Animas, Lincoln and Logan. Preserve the original reasons for review in the private audit evidence and follow the existing county-specific browse and reporting relationship rules. This decision covers candidate row status.
- **Scope.** Apply these rules to the next private export candidate and validate the resulting Profile, role and evidence links before any import or protected Website synchronization. The hold applies to unverified hierarchy and other unresolved case changes, while category display can proceed. Review any proposed detachments or moves separately before committing a County Structure import.

## Dashboard CSV imports — November 19, 2026

- The owner confirmed that both imports are direct dashboard workflows. Upload reviewed `profile.csv` in **Profiles** and reviewed `county.csv` in **County Structure**. The owner can validate, preview and explicitly commit from the dashboard. The approved County Structure importer in [#259](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/259) covers its own file.
- For Profiles, this supersedes the earlier withdrawal of a Site-side CSV importer and the use of the local driver for the first real import. The private research store stays separate. The dashboard prepares the reviewed Website changes on the server and uses the shared service layer for validation, version checks, Website-assigned IDs, receipts and reversal. Dashboard import requires neither a local SQLite session nor an MCP client or R7/R8 command. Preserve existing sync clients and their recorded evidence.
- Add the missing upload flow to the [Profiles tab from #257](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/257). Verify the supported private export contract and any related files needed to preserve roles and name links. Begin with a synthetic Cloudflare staging acceptance, then use the reviewed Adams scope for the first real dashboard pilot. Review visibility at preview and preserve decisions on existing Profiles and alternate names. Use the existing scoped pilot and statewide approval boundaries.
- On November 20, the owner approved one Excel workbook as a second Profiles input alongside CSV. The workbook uses **Profiles**, **Roles** and **Alternate Names** tabs and the same server-side validation, preview, commit and reversal path. An empty Alternate Names tab leaves existing names untouched.

## Profiles dashboard import scope and name priority — November 19, 2026

- **Profile evidence stays in the private Profiles store.** Keep raw evidence, evidence files, claim IDs, research evidence-link IDs and review notes out of Website uploads and Website storage. Continue to accept the selected role source citation in `profile_role.csv`. Preserve private evidence associations and the original research name locally. This supersedes proposals to send private evidence or its linkage IDs to Website D1 for Profile names. Existing review, version and publication protections still apply.
- **Launch Profile evidence review (November 20, 2026).** The owner confirms the initial launch Profiles have private sources. Supporting evidence in the private Profiles store is sufficient for the evidence requirement. A single citation link on `profile.csv` or on the workbook's Profiles tab is never a condition for including a Profile. Check the evidence citation privately for new Profiles after launch. Profile-level citations and evidence stay in the private Profiles store.
- **Structured work is county by county.** Profiles Audit and County Structure Audit will reconcile organization, county-unit and position links together in a later county-by-county audit. Until a link is verified, import the eligible Profile and supported role text with its county, leave the unverified link unset and preserve any existing verified links. Profiles with approved public visibility must appear in county-filtered Profile search and browse. County Structure unit and role listings require the applicable verified link and reviewed display membership.
- **Primary and alternate names are the immediate Profiles work.** Integrate [#261](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/261) with `main`, then complete dashboard CSV preview and import of the approved primary components in `profile.csv` and typed alternate names in `profile_name.csv`. Use stable IDs and preserve owner-approved values and visibility. Create imported alternate names private pending explicit owner review and keep private names and components out of public reads unless approved. The scoped Adams staging sequence can run independently.

## Profile names storage and migration number — November 19, 2026

- A Profile has one primary name in seven fields (Display Name, First, Middle, Last, Name Prefix, Name Suffix, Preferred First Name) on `people`, plus any number of typed alternate names in `profile_names`. Display Name is the public heading.
- Alternate names use a 13-value controlled vocabulary. New names default to Public Display No and Requires review. A name is public only when it is Confirmed and the owner marks it Public. The database enforces this. Public pages show approved names under four labels and public search matches only approved names. Hidden Profiles are not found by any name. Names attach to a Profile by stable ID only.
- The Website stores no evidence for names. Raw evidence, evidence files, claim IDs, research evidence-link IDs, review notes and the original research name stay in the private Profiles store, as the November 19 scope decision requires. The earlier proposal to hold source references (`profile_name_sources`) and a research name ID map (`profile_name_source_ids`) in Website D1 is withdrawn, and the editor no longer has a sources field.
- Migration 0032 holds the name tables because 0031 is County Structure. See [Profile names](architecture/profile-names.md).

## County Structure names and statutory coverage — November 19, 2026

The owner approved the [default names and pending coverage entries](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/259#issuecomment-7014708285) for all 64 counties, then approved the rules below for comparing local units. The defaults apply to the coverage records for the reviewed obligations.

| Coverage obligation | Approved default name |
| --- | --- |
| Sheriff services | Sheriff's Office |
| Human services delivery | Human Services |
| Human services governance | Board of Human Services |
| Public health delivery | Public Health Agency |
| Public health governance | Board of Health |
| Emergency management | Emergency Management |
| Veterans services | Veterans Service Office |
| Weed management plan | Noxious Weed Management Plan |
| Weed advisory governance | Noxious Weed Advisory Board |
| Jail services | Jail Services |
| Road and bridge funding | Road & Bridge Fund |
| Planning commission | Planning Commission |

- **Local unit records.** Preserve the exact documented label, stable unit ID, unit type and verified reporting parent. Preserve the approved public label and the underlying source wording under the existing public-label rules. Sheriff's Offices remain organizational units. Any elected classification belongs on the individual Profile role.
- **Comparison names.** Record a canonical function independently of the local label, actual unit type and parent. Normalize apostrophe styles and treat ampersands and the word “and” as equivalent when comparing labels. Retain words such as Office, Department and Division. A name match or a common function alone does not establish shared identity. An organizational merge requires evidence of the same unit and its type. Keep boards and commissions distinct from the operating units they serve.
- **Functional groupings and hierarchy.** Road and Bridge labels can share a function while retaining department or division types. Keep Public Works distinct when it is a parent. Public health operating agencies can share a function. Keep documented children such as Environmental Health, Fiscal, and Controller's Office distinct and under their verified parents. Jail, Operations Division, and Victims Advocate retain their separate functions under their verified sheriff parents. Count only documented jail facilities, service arrangements or providers toward jail-services coverage. Weed and Pest and Vegetation Management share an operational weed-management category when the retained evidence supports it. Keep the advisory board separate. Administration and Manager's Office can share a broad function. Preserve the documented placement of Procurement and Human Resources. Planning and Zoning remains distinct from the Planning Commission. Attorney's Office, Airports, and Lodging Tax Panel stay distinct.
- **Consolidated governments.** Record Denver and Broomfield as consolidated city-counties at the county level. Denver's Sheriff Department and Broomfield's Police Department count as their local sheriff-services providers. Keep the local names and preserve the distinction between the providers. Use applicable charter and local evidence to verify each arrangement.
- **Coverage and verification.** Carry one coverage entry per county and reviewed obligation, counting a county once for each obligation with a documented arrangement. Prefer the documented local name or provider, including shared providers and governing bodies acting in another capacity. Use the approved default when the local name or arrangement has not been documented. Keep provider and verification evidence separate from label approval. A fund, plan, shared provider or service arrangement is represented according to its record type. Keep unresolved county-unit and position links pending in the private audit workflow.

The [offline application proposal](architecture/county-structure.md#proposed-application-of-the-approved-naming-and-coverage-rules) describes how to carry these decisions into the CSV and companion records. Statewide replacement remains on hold.

## Profile publication rule — November 19, 2026

- A Profile may be visible on the Website only with a nonblank display name and at least one role with a valid county, a source and an office, position or duties. Text-only roles qualify. A verified County Structure attachment and an alternate name are optional.
- New Profiles stay hidden on import. A valid `profile.csv` row without a role is a hidden draft and must be findable in the owner Profiles tab.
- Visible on Website is disabled while a Profile is incomplete and the dashboard shows what is missing. The server enforces the same rule for single and bulk visibility changes against the final saved state.
- A visible Profile that becomes incomplete is hidden automatically with the reason recorded. Existing incomplete records previously treated as visible are hidden the same way. Restoring the missing information enables the checkbox, and the Profile stays hidden until the owner publishes it.
- Implemented by migration 0034 and the [Profiles sheet](architecture/profiles-sheet.md#publication-rule-migration-0034).

## Single-Profile Website deletion — November 20, 2026

- The offline Profiles master is authoritative. The owner can permanently remove one Website copy through the dashboard, with a reviewed dependency preview and an audit receipt. Deletion does not propagate to the offline master.
- Preserve shared sources and existing audit history. Retain the original import receipts. Routine CSV imports skip an intentionally deleted Profile, and an owner can explicitly re-add a corrected copy from a new preview. See [PR #293](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/293).

## Adams County Structure pilot preparation — November 20, 2026

- Prepare a fresh Adams (08001) `county.csv` and private review on current Beta-2 `main`. The owner-designated current `county.csv` governs existing unit IDs, hierarchy and browse versus reporting mappings. Carry those mappings forward. Use retained private audit exports and current authoritative county and office sources to review the rest of the file. Record discrepancies and any proposed mapping changes for the owner. The [CSV contract](architecture/county-structure-csv.md) makes relationship evidence optional. For new rows outside the approved mappings, flag unresolved relationships and leave them unset.
- Save the artifacts and evidence in the local Watchdog workspace and validate using a disposable local preview. That approval covered preparation and review. Preserve shared staging and the #289 synthetic Profiles batch. See the later owner reports in CURRENT for the separate statewide County Structure commit and the scoped Adams Profiles staging trial.

## Public County Structure presentation — November 20, 2026

- Match Beta-1 typography and styling with two desktop columns, one narrow-screen column, red unit names and right-aligned profile counts. Follow the CSV group order and preserve hierarchy and browse mappings. Keep Office and Department type badges in the dashboard only. [#300](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/300) implements the styling.
- The owner reviewed the local County Structure pinning preview and requested it in the default preview. Allow the owner to pin public headings to either column and set their order per county. Unpinned headings use masonry. Keep these display preferences separate from the CSV hierarchy and Profile links. [#318](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/318) implements the controls.
- After the earlier preparation hold, the owner reported committing the approved statewide County Structure CSV. See [CURRENT](coordination/CURRENT.md) for verification status. The later Adams Profiles CSV trial was scoped to shared staging, with the new records left hidden pending owner review. Statewide Profiles replacement and public cutover remain on hold.

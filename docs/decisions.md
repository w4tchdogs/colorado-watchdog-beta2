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
| Profile eligibility | One verified official county webpage linking a person's name to a position is sufficient; additional sources are allowed and useful |
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
- The dashboard is the manual operator surface while hosted D1/R2 access and verification are open. The existing Website D1/R2 and shared dashboard/API/MCP backbone still applies. The supplied generic CMS prompt and framework, browser-storage and generic database follow-ups are reference material only. The owner will say when the prepared Fable assignment is initiated.

## Profiles publisher classification and private export, November 15, 2026

- Classify a source publisher as `official` only when the material is published by a government body or issued by it through a verified publishing channel. Classify it as `unofficial` when available evidence establishes a nongovernment publisher. A URL suffix, file extension, or hostname by itself does not establish publisher identity.
- Keep publisher classification separate from `page_type`, which describes the page or document. Preserve legacy `official_status` values, including `partner` and `other`; never bulk-convert them without source-specific evidence. A linked source with an unestablished publisher remains `unresolved`. A profile with no linked source has a true `null` classification in the export.
- Preserve all sources and their individual classifications, citation URLs, evidence, attachments, audit history, batch selection, identity links, and organizational relationships during source correction. Do not replace or delete prior classification evidence.
- Keep Profiles exports private in the owner's Watchdog workspace. Scope to one or more canonical county FIPS codes or an explicit statewide selection before applying the profile limit. One distinct person is one profile record regardless of role count; retain the county and role links for every exported role. Deduplicate a person across selected counties by profile ID.
- Limit each export to 10,000 distinct profile records. Use deterministic profile-ID ordering, visibly mark truncation, and continue after the last profile ID. Include official and unofficial citations, preserve unresolved publishers as a separate state, and exclude private research notes, raw captures and unrelated personal data.
- Keep the local Profiles export separate from Website M2 changesets and hosted write controls. This decision does not authorize a hosted migration, sync submission, or public publication.

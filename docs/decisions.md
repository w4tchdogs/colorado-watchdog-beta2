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
[CURRENT](coordination/CURRENT.md) for its current implementation state —
a read-only local foundation is merged; hosted publication and any
write/sync/import tool are not.

Current technical assessment: [Fable assessment revision 4](https://drive.google.com/file/d/1ux9NG09zr9DkztRGYtc-Z3uXBZ81ncI0/view). See the [revision 4 section](#revision-4-technical-assessment-november-12-2026) below. The first two sections are the earlier decision records and remain as written.

Authority: [Fable assessment revision 3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view), read through the connected Drive account. The owner's bootstrap request determines this task's scope and resolves conflicting recommendations or residual tables in older documents.

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

[Fable assessment revision 4](https://drive.google.com/file/d/1ux9NG09zr9DkztRGYtc-Z3uXBZ81ncI0/view) is the current technical assessment. It supersedes the recommendations of [revision 3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view) where they differ. Revision 3 stays as history.

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
- Active county research is paused by the owner because the research database
  is well seeded.
- Existing Profiles architecture decisions are unchanged: a separate local
  SQLite research database, a separate Website D1 database, synchronization
  only through the accepted R7/R8/M2 architecture, and the existing identity
  evidence rules.

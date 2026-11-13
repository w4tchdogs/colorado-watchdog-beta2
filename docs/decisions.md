# Current decisions — November 12, 2026

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
| Chat titles | Circles for conversational AI and squares for Codex, each green/yellow/orange/red by low/medium/high/extra-high thinking, followed by actual model name; no Max tier |

See [sanitized architecture handoff](architecture/beta-2-planning-handoff.md). Any later implementation still requires a scoped task; keep the initial beta-2 database empty.

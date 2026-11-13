# Beta-2 architecture — sanitized planning handoff

**R0 implementation update:** [Local research foundation](../research/R0-foundation.md) implements the initial 19-table SQLite model and synthetic mapping tests. The earlier planning text below remains historical context; consult R0 for the implemented boundary and remaining work.

**Prepared:** November 12, 2026. **Status: planning and owner decisions, not implemented features.**
**Audience:** Codex, Claude, ChatGPT and later collaborators. **Authority:** [Fable v3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view) as starting architecture, updated by explicit owner choices summarized in [decisions](../decisions.md). This file is not a substitute for the original detailed planning conversation or a migration instruction.
**Later assessment:** [Fable v4](https://drive.google.com/file/d/1ux9NG09zr9DkztRGYtc-Z3uXBZ81ncI0/view) reconciles revision 3 with these decisions. [Decisions](../decisions.md) separates owner decisions from revision 4 proposals.

## Verified collaboration baseline

- Private repository: https://github.com/w4tchdogs/colorado-watchdog-beta2
- [PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) bootstrap pipeline merged.
- [PR #2](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/2) local Git sync notes merged. The repository documents successful Codex local Git authentication and synchronized main.
- This planning chat read the repository through an authenticated GitHub connector. Other assistants must verify their *own* current access. A PR/check is evidence of that revision only, not evidence of deployment.

## Website direction (not built)

- AI-first modular Site with **one** typed relational D1 production database for counties, people, offices, accounts, submissions, Posts, media metadata and relationships, plus R2 for files. A shared service layer underlies dashboard, API and MCP so routine AI administration does not require code changes.
- Early unified account/permission design for guests, contributors, editors, administrators, owner and individually attributable AI agents; actual production role matrix/authentication and MCP client support require later specification and tests.
- Native Posts, stories, related counties/people/offices and media; WordPress is excluded. Common page families include homepage, county, directory, profile, stories/topics, information, account, submissions, admin and error/search pages. Reuse templates and relational IDs to propagate updates rather than copying content.
- Prefer indexed, bounded reads, targeted transactions, bulk updates, concise auditing, idempotent retries and reversible corrections; avoid whole-database loads, elaborate multi-step online identity review and repeated redundant checks.
- Backups must eventually cover D1, R2 and deployable application version, with automated encrypted off-site copies and tested restore. Exact no-cost destination, schedule and recoverability remain design questions, not completed controls.

## Local research direction (not built)

- Windows 11 **SQLite + DB Browser for SQLite** chosen as a human-usable research database. It is **separate from** the website D1 database. Raw CSVs, private captures and detailed investigative materials stay in the private Windows workspace, never GitHub or the public Site.
- AI-led county screening takes place locally or through authorized AI tools. Routine deterministic parsing, deduplication, hashing, indexing and batching should be done in code rather than thousands of model calls. Support existing 11/16/17-column CSV variants through versioned maps; do not copy beta-1 production data.
- **Profile eligibility:** one verified official county webpage directly tying a person's name to an official role is sufficient. Additional sources are encouraged when useful to document another name or role, organizational structure, and future source discovery. One source is enough; corroboration is not a requirement. Check date is not an employment start date.
- **Identity:** on initial upload, AI screens by county and against current directory before applying; identical repeated source rows are excluded. One established identity can hold several distinct roles. Candidate nicknames, spelling variants, shared departments/county and identical names are *not proof* of the same person; preserve distinct people and unresolved cases. After initial import use nonblocking candidate flags, then progressively evidence-supported AI maintenance. Avoid forced merges.
- Site administrators may directly create profiles and contributors may propose profiles; complicated source/merge adjudication stays out of the website. Exchange compact, current-version-checked website changesets via the future API; Site assigns persistent profile IDs, local system retains mapping.

## Integrated proposed SQLite research schema — 19 tables

- County structure: `counties`, `org_units`, `org_names`, `role_targets`, `unit_coverage`, `source_unit_links`.
- People/identity: `research_people`, `name_variants`, `role_claims`, `possible_matches`.
- Sources/ingestion: `sources`, `evidence_links`, `scrape_batches`, `research_runs`, `source_visits`.
- Site sync/audit: `site_links`, `sync_batches`, `sync_items`, `research_events`.

This is a **proposed logical schema**; column and index choices from planning have not been migrated, validated or adopted as live production schema.

### County structure

Each of 64 Colorado counties has its actual hierarchy. Do **not** impose one statewide department list. Distinguish elected offices, departments, divisions, subunits, partners and navigation groupings. A navigation parent must not falsely imply statutory reporting authority; organizational cycles and cross-county parents are invalid. Preserve stable unit IDs, alternative/former names, actual source-backed role targets, and four independent coverage dimensions: structure, leadership, named staff and documented positions. Coverage status can be not_started, partial, reviewed, stale or blocked; *reviewed does not mean all staff found*, and missing name does not establish vacancy.

Prior beta-1 interface documentation confirms a County Structure tab and grouping of elected offices/departments/subunits, but the earlier detailed 64-county research packages **have not all been retrieved/verified** here. Treat them as references only; do not import beta-1 application records.

### Source-discovery memory

Retain **all discovered useful and unproductive source URLs** as a compact registry, with page type, official-status, first-discovered and last-checked timestamps, last successful fetch, content hash, HTTP ETag/Last-Modified where available, next due, availability and usefulness. Each `source_visits` record points to a research run/source, outcome, attempt and compact results; `source_unit_links` connects pages to organizational research areas. A failed/blocked visit is not evidence that someone left employment. A previously searched page may change and must be eligible for future revisits. Reuse unchanged material within a run and prefer relevant high-yield pages for later focused updates. No full HTML/screenshot storage required by default.

### Human/AI access and security

DB Browser is for local human access; future local Python/Node utilities and an MCP adapter may expose bounded searches and transactional changes. Cloud-hosted ChatGPT cannot directly read an arbitrary Windows drive; live client connectivity is **unverified** and cannot be assumed. Shared website API/MCP and independent local backup/restore remain future scoped work. No new service or paid API is authorized by this handoff.

## Status / next safe use

These are **approved planning choices**, not an installed database, scraper, MCP server, Site, Posts editor, or backup system. No real county ingestion, account provisioning, payment, GitHub identity merge or deployment is authorized. New development requires a separately scoped owner task and current-source inspection. This handoff exists to make separate AI chats share context without re-reading a long conversation.

# Colorado Watchdog beta-2 — start here

[Shared repository](https://github.com/w4tchdogs/colorado-watchdog-beta2)

**Read in this order for any substantial new assignment:** this page, then
[CURRENT](CURRENT.md) (current architecture/implementation/deployment
snapshot), then [decisions](../decisions.md) (binding owner decisions), then
the relevant track-specific architecture document and the latest related
Issue or handoff. Retrieve only the context needed to advance the task — do
not reread all of GitHub history, and do not require a new report for every
chat response.

Before planning substantial new work: read CURRENT and the relevant binding
decisions, check current `main` and active overlapping work (CURRENT section
F), preserve binding architecture rather than reopening it, check for
conflicts with active work before a major assignment, and treat
implementation, deployment and hosted verification as separate claims
(CURRENT's status vocabulary). Preserve accepted work; record consequential
changes (a decision, a milestone, a blocker, an ownership change) in GitHub —
update CURRENT or decisions, or note it in the relevant Issue — rather than
leaving it chat-local; do this only for material cross-project change (see
CURRENT's own maintenance note), not for routine PRs. See
[AGENTS.md](../../AGENTS.md)'s "Architectural Continuity and Shared Project
State" section for the full reasoning, and
[ARCHON-HANDOFF-REQUEST.md](ARCHON-HANDOFF-REQUEST.md) to produce a complete
successor handoff when replacing an Archon or ending a long-running
coordination chat.

## Shared knowledge

- **Main:** current accepted source, instructions and decisions
- **[CURRENT](CURRENT.md):** short canonical current-state snapshot — read before decisions or architecture notes
- **Issues:** work in progress, discussion and AI session handoffs
- **PRs:** durable changes and checks
- **Architecture reports:** current technical assessment: [Fable's beta-2 architecture v4](../architecture/fable-assessment-rev4.md). Earlier baseline, kept as history: [v3](../architecture/fable-assessment-rev3.md). Google Drive is retired for coordination. GitHub is canonical
- **Local workspace:** development material, private research, the Profiles database and archives, all inside the owner's Watchdog folder and never committed

The [current beta-2 planning handoff](../architecture/beta-2-planning-handoff.md) covers the proposed website architecture and separate 19-table SQLite research database; it is historical planning context — check [CURRENT](CURRENT.md) for what is actually implemented. Revision 4 folds the owner's decisions into one assessment. [Decisions](../decisions.md) shows which revision 4 items are owner decisions and which are technical proposals.

## Collaborate efficiently

Complete routine work without process overhead. Share progress in the relevant Issue and durable changes through a branch/PR. No AI has a mandatory reviewer role.

See [AGENTS.md](../../AGENTS.md) for chat naming, progressive buttons and early handoffs. Related ChatGPT Projects can use the [short bootstrap](PROJECT-BOOTSTRAP.md).

The existing beta-1 website has its own development history and master plan; keep that distinct from beta-2.

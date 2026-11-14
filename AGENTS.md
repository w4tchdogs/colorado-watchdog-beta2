# Colorado Watchdog Beta-2 — Shared AI Guidance

Develop the AI-first Colorado Watchdog Website and Profiles system collaboratively. Beta-1 is a separate project; preserve its history and decisions.

## Coordination

💠archon coordinates assignments, prevents conflicting work, and identifies useful next tasks. No AI is a mandatory reviewer or approval authority.

One 💠archon coordinates both Website and Profiles; task chats report results through GitHub (Issue, PR, or CURRENT row), not only in chat.

Check relevant progress and dependencies without repeatedly reviewing completed work. Preserve accepted changes and enable parallel development.

An assignment to execute work covers ordinary operations within its scope, including use of available project resources. Do not invent extra permission requirements. Respect explicit exclusions, actual access restrictions, and genuine blockers.

When asked to prepare a prompt or conduct a read-only review, do not execute the proposed work.

## Development

Work independently, efficiently, and economically. Make reasonable decisions and prefer simple, maintainable solutions.

Default workflow: **Assignment → implementation → relevant tests → passing PR → merge.**

Use additional reviews only for material risks. Avoid unnecessary reports, checkpoints, and approval cycles. Recommend the least expensive capable AI model and thinking level for assignments.

## Project Boundaries and Evidence

Keep Beta-2 Website development and the separate local SQLite Profiles research system distinct. Keep private research records, local databases, credentials, and sensitive source material out of GitHub and public Website assets. Use synthetic research data for development tests.

Preserve original evidence, source lineage, historical distinctions, unresolved identities, and accepted functionality. Do not invent personnel facts or infer identities, employment status, or vacancies without evidence.

## Shared Context

Start with [coordination/START.md](docs/coordination/START.md), which points
to [CURRENT](docs/coordination/CURRENT.md) (current architecture,
implementation and deployment snapshot) and [decisions](docs/decisions.md)
(binding owner decisions) before track-specific documents. Use current
repository decisions and relevant project documents when needed; treat
implementation, deployment and hosted verification as separate claims. Update
CURRENT or decisions only for a material cross-project change (a decision
change, a milestone changing state, a blocker resolving, or ownership of
overlapping work changing) — not for routine PRs, minor refactors or
completed tasks that do not affect another workstream.

## Architectural Continuity and Shared Project State

This section prevents drift between what a chat session believes and what is
actually recorded. It adds no new approval step; it says where facts live.

**A. Canonical records take priority.** GitHub `main`, [CURRENT](docs/coordination/CURRENT.md),
[decisions.md](docs/decisions.md) and open Issues/PRs are the shared truth.
A chat transcript, a local worktree, or an assumption carried over from an
earlier conversation is not authoritative where it conflicts with these —
re-read the canonical records rather than trusting chat memory or a stale
checkout.

**B. Preserve approved architecture before proposing alternatives.** Binding
decisions in [decisions.md](docs/decisions.md) are not reopened by a new
technical assessment, a convenience, or an unrelated assignment. The
AI-first dashboard/API/MCP service layer is the standing example: it stays
binding even though it has no implementation yet, and no later proposal may
quietly treat it as optional. Raise a change to binding architecture as an
explicit decision for the owner, not as a side effect of other work.

**C. Record owner corrections in GitHub, not just in chat.** When the owner
corrects a misunderstanding, a status claim, or a plan, write that
correction into the relevant Issue, PR, or durable doc (CURRENT or
decisions) so a later session does not have to rediscover it the hard way.
A correction that lives only in one chat is not shared project memory.

**D. Record consequential changes, and only claim what happened.** A
decision change, an architecture change, a new or resolved dependency or
blocker, a deployment change, an ownership change, or a milestone changing
state belongs in CURRENT, decisions.md, or the relevant Issue/PR — in the
same PR when practical, otherwise noted as pending. Never state that a
GitHub operation (a merge, a push, an Issue update) succeeded unless it
actually did; if the environment blocks an action, report the actual
restriction instead of claiming success.

**E. Use the existing evidence vocabulary.** CURRENT's status vocabulary
(Planned / Prepared / Assigned / In progress / PR open / Merged / Deployed
/ Hosted-verified / Blocked / Superseded / Complete) is the one vocabulary
for implementation and deployment status. Do not invent a second set of
status terms in a different document.

**F. No new bureaucracy.** This section does not add a mandatory reviewer,
a required sign-off, a forced full-history audit, or a mandatory report for
every small PR. It only asks that consequential facts end up in the
canonical records above instead of staying chat-local. The
assignment → implementation → relevant tests → passing PR → merge workflow
is unchanged.

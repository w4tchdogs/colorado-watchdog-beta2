# Colorado Watchdog Beta-2 — Shared AI Guidance

Develop the AI-first Colorado Watchdog Website and Profiles system collaboratively. Beta-1 is a separate project; preserve its history and decisions.

## Coordination

💠archon coordinates assignments, prevents conflicting work, and identifies useful next tasks. No AI is a mandatory reviewer or approval authority.

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

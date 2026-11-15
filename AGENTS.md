# Colorado Watchdog Beta-2 shared AI guidance

Every AI working on Colorado Watchdog (ChatGPT, Codex, Claude and any other
collaborator) follows this file. Start each substantial task at
[coordination/START.md](docs/coordination/START.md).

## Roles

- **Owner:** sets direction and makes binding decisions. Only the owner
  deletes files, lifts a pause or changes a binding decision.
- **💠archon:** the single coordinating chat for Website and Profiles. It
  keeps [CURRENT](docs/coordination/CURRENT.md) accurate, prepares
  assignments, prevents overlapping work and recommends next tasks.
- **Task chats and agents:** carry out one assignment and report the result
  through GitHub (PR, Issue or CURRENT row), not only in chat.
- No AI is a mandatory reviewer or approval authority.

## Where facts live

| Fact | Canonical place |
| --- | --- |
| Accepted source | GitHub `main` |
| Binding owner decisions | [decisions.md](docs/decisions.md) |
| Current state, assignments, blockers, pauses | [CURRENT](docs/coordination/CURRENT.md) |
| Work in progress and task handoffs | Issues and PRs |
| Long reference reports | `docs/architecture/` (for example the [Fable assessment](docs/architecture/fable-assessment-rev4.md)) |
| Private research, databases, banner originals, archives | The owner's local Watchdog folder only, never GitHub |

Chat memory, a local checkout and a handoff document never outrank these
records. When they disagree, re-read GitHub and say which source you relied
on. A canonical document can itself be stale: reconcile it with newer
verified evidence and correct the record. Google Drive is retired and is no
longer a project record.

## Working rules

1. **Workflow:** assignment, implementation, relevant tests, passing PR,
   merge. An assignment covers the ordinary operations in its scope,
   including repository operations, testing, opening the PR and merging it
   once checks pass. Do not add permission boilerplate, owner-confirmation
   steps, sign-offs, checkpoints or approval cycles.
   Reserve an extra independent review for concrete security, privacy,
   destructive or irreversible, production or major architectural risk.
2. **Prepare is not execute:** a request to prepare a prompt or do a
   read-only review is not a request to do the described work.
3. **Self-contained assignments:** an assignment states the task, scope,
   constraints, relevant tests, expected deliverables and the recommended
   model and reasoning level. State genuine security boundaries and
   explicit exclusions as direct constraints, and raise only substantive
   blockers.
4. **Preserve binding architecture.** Two standing examples: the AI-first
   dashboard/API/MCP service layer is required, not optional (its read-only
   foundation is merged and full administration is still to come), and the
   Website D1 database stays separate from the local Profiles SQLite
   database. Raise any change to a binding decision with the owner as an
   explicit decision, never as a side effect of other work.
5. **Keep claims separate.** Prepared, assigned, merged, deployed and
   hosted-verified are different states (CURRENT's status vocabulary is the
   only one). Never claim a GitHub, hosting or file operation succeeded
   without a confirmed result. Tested locally is not verified in
   production. If an action is blocked, report the actual restriction.
6. **Record what matters.** A decision, a milestone changing state, a new
   or resolved blocker, a deployment change, an ownership change or an owner
   correction goes into CURRENT, decisions or the relevant Issue/PR, in the
   same PR when practical. Routine PRs need no record update, and no Issue,
   report or approval step is needed just for process compliance.
7. **Work in parallel.** Disjoint tasks proceed independently. Before a
   major assignment, check CURRENT section F and open PRs for overlap, and
   recheck `main` before merging. If work conflicts, pause only the
   conflicting part. Never overwrite accepted work or disrupt a concurrent
   assignment, but do not stall unrelated work merely because unpublished
   local work cannot be ruled out. Check progress proportionately and reuse
   recent evidence instead of re-auditing completed work.
8. **Cost discipline.** Prefer the least expensive capable model and
   reasoning level. Reserve the most expensive models for work that needs
   them.

## Boundaries and evidence

- Beta-1 is archived and not under development. Use it only as a visual
  reference. Never migrate its data, banners or policies into Beta-2.
- Keep private research records, local databases, credentials, personnel
  details and banner originals out of GitHub and public assets. Use
  synthetic data in tests.
- Preserve evidence, source lineage, observed dates and unresolved
  identities. Do not invent personnel facts or infer identity, employment,
  appointments or vacancies without evidence. Similar names are not proof of
  the same person.
- Administrative access stays authenticated, capability-limited and
  default-deny. Do not add unauthenticated administrative endpoints, broad
  SQL tools or identity bypasses.
- Preserve approved artwork pixel for pixel, with its versions, hashes and
  approval lineage.

## Local workspace

All local Watchdog material on the owner's Windows computer is in
`D:\ChatGPT\Watchdog`. Nothing Watchdog-related belongs elsewhere on the
computer.

| Folder | Contents |
| --- | --- |
| `colorado-watchdog-beta2\` | The canonical local clone of this repository |
| `worktrees\` | Active task worktrees |
| `banners\` | Approved banner originals (`approved\`), inventory and manifests (`manifests\`) and reports (`reports\`). Private, never committed |
| `profiles\` | The private Profiles research database (`database\research.sqlite`), reports and backups. Access is restricted. Repository docs call this folder `<private-root>` |
| `documents\` | Reports, audits and workspace records |
| `archive\beta-1\` | Archived Beta-1 material |
| `_trash\` | Items set aside instead of deleted |

Never delete local files. Move them to `_trash\`, which only the owner
empties. Keep the Website D1 and Profiles databases separate on disk as well
as in code.

## Documents and names

- Separately revisioned documents use `Title revYYYY-MM-DD vX.ext`: Title
  Case, the local date, v1 on each new date, a higher version for each
  same-day revision, and never overwrite an earlier revision. Canonical
  files such as AGENTS, START, CURRENT, decisions and architecture notes
  keep stable names.
- Chat names: only the coordinating chat uses the 💠 prefix
  (`💠archon | description`). Task chats use `model | description`, in
  lowercase, without guessing an unspecified model. Add a batch ID only when
  useful. No colored thinking-level markers or other extra prefixes.

## Handoffs

- Task chats use [HANDOFF-TEMPLATE.md](docs/coordination/HANDOFF-TEMPLATE.md).
- Coordinator succession uses
  [ARCHON-HANDOFF-REQUEST.md](docs/coordination/ARCHON-HANDOFF-REQUEST.md).
- Put durable facts into GitHub first. A handoff carries only what GitHub
  does not already record, so it stays short and cannot drift from the
  canonical records.

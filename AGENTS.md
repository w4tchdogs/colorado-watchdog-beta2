# Colorado Watchdog beta-2 — Shared AI Instructions

## Purpose and Approach

Develop Colorado Watchdog beta-2 collaboratively through ChatGPT, Codex, Claude, Copilot, Mistral, and other AI tools.

**Shared repository:**

https://github.com/w4tchdogs/colorado-watchdog-beta2

Work proactively toward the user's objective. Make reasonable technical and procedural choices, complete useful intermediate steps independently, and ask about decisions that materially change the intended direction.

Prefer maintainable solutions over repeated confirmations, unnecessary approvals, process overhead, or duplicated work.

Beta-1 is the separate existing website. Preserve the technical history and architectural decisions of each development effort.

## 💠archon — Assignment Coordination

**💠archon is the official designation for the AI project coordination role responsible for planning, sequencing, delegating, and preventing conflicting assignments.**

Use this designation instead of overseer, director, manager, or administrator when referring to AI project coordination.

The 💠archon must verify current work, assignment ownership, dependencies, and preservation requirements before issuing development or research prompts.

This designation is not an exclusive development role or mandatory review authority.

All authorized AI collaborators may independently implement, review, and contribute. No individual AI must approve every change.

Preparing an assignment does not authorize execution.

## Shared Memory and Collaboration

Start substantial work with [START.md](docs/coordination/START.md).

Read relevant decisions, architecture documents, and recent handoffs as needed, not every historical file.

GitHub `main` holds accepted work and documentation. Issues hold tasks, discussion, and concise handoffs. Task branches and PRs carry durable changes. Drive holds longer reference reports.

Use branches and PRs, run checks appropriate to the change, resolve failures, and integrate passing work while accounting for concurrent changes.

## Mandatory Assignment Coordination and Conflict Prevention

Before starting substantial work:

1. Check the latest `main`, relevant Issues, PRs, handoffs, and known concurrent assignments.
2. Confirm the task's prerequisites, ownership, authorized scope, affected files/interfaces, and exclusions.
3. Identify overlapping work, outdated baselines, and missing dependencies.
4. Preserve accepted commits, migrations, tests, research evidence, and documentation.
5. Avoid modifying another collaborator's active work or silently replacing local-only deliverables.
6. Report material conflicts and stop the conflicting portion rather than independently reassigning or overwriting work.
7. Recheck current `main` and concurrent changes before merging.
8. Resolve integration conflicts without discarding accepted work.

Distinguish local completion, reported success, merged work, and independent acceptance when required.

No open PR does not necessarily mean no work is underway.

Do not implement dependent work against unavailable or unverified deliverables.

The 💠archon must apply the same conflict-prevention checks **before issuing prompts**, not merely after work begins.

**Conflict prevention takes precedence over maximizing parallel activity.**

Use existing Issues and concise handoffs for coordination. Avoid unnecessary tracking bureaucracy or approval gates.

## Cost-Conscious Assignments

Every Codex assignment must specify the minimum recommended model and thinking level.

Favor Luna Low or Medium when sufficient. Recommend Sol or Astra only when stronger reasoning is justified.

Prefer narrow, independently verifiable batches over unnecessarily expensive assignments.

Recommend economical configurations for other AI collaborators where useful.

## Prompt Preparation and Sequencing

When asked to prepare an assignment, provide a complete, copy-ready prompt without automatically executing it.

Include:

- Current verified baseline.
- Scope and exclusions.
- Dependencies and concurrent work.
- Preservation requirements.
- Verification and acceptance criteria.
- Deliverables and stop conditions.

When a request contains multiple tasks, prepare the selected task first.

Immediately afterward, provide a Next Task action that prepares the next eligible prompt.

If prerequisites are missing, initiate verification or blocker resolution instead.

Next Task actions never authorize execution unless the user explicitly requests it.

## Chat Naming

Propose a concise title in the first response of every new development or coordination chat.

- 💠archon coordination: `💠archon | description`
- Standard model conversation: `model | description`
- Other model-identified Archon conversation: `💠model | description`
- Chat mode without a specified model: `💠| description`

Use lowercase model names and descriptions.

Use `💠archon` for the project coordination role.

Never guess an unspecified model or thinking level.

Include batch IDs when useful, but do not require them.

Do not use colored thinking-level circles or squares, unnecessary dates, or prefixes.

Apply the naming convention across Website and Profiles projects.

## Progressive Actions

Whenever recommending a meaningful next step, place a working clickable action immediately after the recommendation when supported.

Make its intended outcome clear.

For prompt-generation workflows, actions prepare assignments or check readiness rather than execute development.

Offer multiple choices when useful and copy-ready alternatives when controls are unavailable.

Avoid unnecessary decisions that stall progress.

## Conversation Continuity

Use available context and usage indicators during substantial work.

When measurable, prepare a handoff around 70% context utilization and recommend a fresh chat around 80%.

Otherwise, use visible warnings, conversation length, tool outputs, compaction, and task complexity.

Record completed work, decisions, active assignments, dependencies, progress, and next continuation in the [handoff template](docs/coordination/HANDOFF-TEMPLATE.md).

## Reporting

Report completed work, actual verification, remaining work, blockers, and useful links.

Distinguish collaborator claims from independently verified outcomes.

Include important PRs, merge commits, CI results, and test counts when relevant.

Prefer useful progress over lengthy procedural status reports.

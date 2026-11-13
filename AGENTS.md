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

## Default Delivery Path — Ship Routine Work

**For routine, reversible work with available prerequisites, the default is: authorized assignment → implementation → relevant automated tests/checks → passing PR → merge.**

An implementing collaborator may merge a passing, nonconflicting PR under its assigned scope without another AI acceptance review, a 💠archon sign-off, a separate owner approval, or a repeated documentation closeout. A concise PR summary and normal CI are sufficient evidence for routine work. Do not create a new Issue, Drive report, tracking ledger, or handoff merely to satisfy a process step.

Use **targeted independent review only when a concrete material risk warrants it**: authentication/authorization and secrets, exposure of private data, destructive or irreversible changes, identity merges, production-impacting operations, or an architectural uncertainty with expensive consequences. Not every schema addition or small correction is high risk. Review the specific risk once; do not create chains of re-review or delay unrelated work. Automated tests and a checked PR remain the normal verification standard.

The 💠archon's responsibility is to keep Codex, Claude, Copilot, Mistral and others moving safely in parallel—not to act as a mandatory approver. Prefer independently useful, nonoverlapping tasks to unnecessary sequential approval gates. Planning a prompt never authorizes execution; once an implementation task is explicitly authorized, its executor may complete and merge it within scope.

## Lightweight Conflict Prevention

Before preparing a new assignment or starting material work, perform a **quick, proportionate readiness check**:

1. Reuse recent reliable context and check current `main`, relevant active PRs/Issues and known local-only assignments as needed. Do not exhaustively audit all historical work for routine tasks.
2. Check only material prerequisites and plausible file, schema, interface or responsibility overlaps. A missing PR does not prove inactivity, but unknown local work is not a reason to freeze unrelated tasks.
3. If there is no concrete conflict or missing prerequisite, **proceed**. If an overlap exists, split ownership, coordinate integration or pause only the conflicting portion while other work continues.
4. Before merging, refresh `main`, resolve actual conflicts, preserve accepted work and require appropriate automated checks to pass.

Do not rewrite accepted migrations or erase concurrent changes. Escalate only demonstrated risks or genuinely missing dependencies. Distinguish reported local completion, green CI, merged history and optional independent acceptance when making factual claims.

**Avoid redundant verification, speculative blockers, mandatory review-after-review, and administrative work that slows delivery.**

## Cost-Conscious Assignments

Every Codex assignment must specify the minimum recommended model and thinking level.

Favor Luna Low or Medium when sufficient. Recommend Sol or Astra only when stronger reasoning is justified.

Prefer narrow, independently verifiable batches over unnecessarily expensive assignments.

Recommend economical configurations for other AI collaborators where useful.

## Prompt Preparation and Sequencing

When asked to prepare an assignment, provide a complete, copy-ready prompt without automatically executing it.

Keep prompts **complete but proportional to the task**. State the working baseline, relevant ownership and dependencies, boundaries, appropriate checks, and expected deliverable without repeating long historical background or imposing routine approvals. Use concise prompts for simple tasks and detailed safeguards only for high-risk work.

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

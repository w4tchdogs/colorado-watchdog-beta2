# Colorado Watchdog beta-2 — shared AI instructions

## Purpose and approach

Develop Colorado Watchdog beta-2 collaboratively through ChatGPT, Codex, Claude and future AI tools. [Shared repository](https://github.com/w4tchdogs/colorado-watchdog-beta2).

Work proactively toward the user's objective. Make reasonable technical and procedural choices, complete useful intermediate steps independently, and ask about decisions that materially change the intended direction. Prefer maintainable solutions over repeated confirmations, process overhead or approval loops.

Beta-1 is the separate existing website; use the relevant history and architectural decisions for each development effort.

## Shared memory and collaboration

Start substantial work with [START.md](docs/coordination/START.md). Read relevant decisions, architecture documents and recent handoffs as needed, not every historical file.

GitHub main holds accepted work and documentation. Issues hold tasks, discussion and concise handoffs. Task branches and PRs carry durable changes. Drive holds longer reference reports.

All connected AIs may contribute. No AI is the required controller or reviewer. Use branches and PRs, run checks appropriate to the change, resolve failures, and integrate passing work while accounting for concurrent changes.

## Chat naming

Propose a title in the first response of every new development chat: `[emoji] [model] | [batch-id] [short title]`.

- Conversational AI: 🟢 low · 🟡 medium · 🟠 high · 🔴 extra high
- Codex: 🟩 low · 🟨 medium · 🟧 high · 🟥 extra high

Use the actual model name, lowercase title text, exact batch identifiers and concise descriptions. Omit the batch ID when none is assigned. Do not guess unknown model or thinking settings.

## Progressive actions

Whenever recommending a meaningful next step, place a working clickable action immediately after the recommendation when supported. Offer multiple choices when useful and copy-ready alternatives where controls are unavailable. Keep actions clear about their outcome; avoid unnecessary decisions that stall progress.

## Conversation continuity

Use available context and usage indicators during substantial work. When context use is measurable, prepare a handoff around 70% and recommend a fresh chat around 80%. Otherwise use visible warnings, conversation length, tool outputs, compaction and task complexity. Record completed work, decisions, progress and next continuation in [the handoff template](docs/coordination/HANDOFF-TEMPLATE.md).

## Reporting

Report completed work, actual verification, remaining work and useful links. Prefer making progress over lengthy procedural status reports.

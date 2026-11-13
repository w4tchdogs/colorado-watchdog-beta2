# Colorado Watchdog beta-2 — Start here

This is the lightweight entry point for ChatGPT, Codex, Claude and future collaborators. Canonical **private** repository: https://github.com/w4tchdogs/colorado-watchdog-beta2

## Orient before substantial work

1. Read current `AGENTS.md`, `README.md`, `docs/decisions.md` and, for Claude, `CLAUDE.md`.
2. Read the currently assigned GitHub Issue and **latest** handoff comment, or the owner's direct scoped instruction if there is no issue.
3. Read only the architecture files needed for that assignment. The [current beta-2 planning handoff](../architecture/beta-2-planning-handoff.md) is a summary, not an executable spec or proof of implementation.
4. Inspect the actual latest `main`, relevant branch/PR, checks, connector capabilities and remaining blockers. Never rely on a stale summary or infer access.
5. Work within the *current authorized scope*. A next-step recommendation, issue, older chat, or handoff is not self-authorization.

## Where knowledge belongs

- **GitHub main:** accepted source, instructions, architectural decisions, short durable planning summaries.
- **GitHub Issues:** scoped tasks, progress, blockers, session handoffs. Do not create an issue for every conversation.
- **Branches and PRs:** reviewed diff/check history for durable changes. Any authorized connected assistant can contribute; no designated AI or mandatory second reviewer.
- **Google Drive:** long reference documents, including [Fable v3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view).
- **Private Windows workspace:** local SQLite research data, scraped CSVs, private evidence and backups; never put these in GitHub.

## Continuity and interfaces

- New development chat: propose `[emoji] [model] | [batch-id] [short description]` in its first response. Chat circles: 🟢 low, 🟡 medium, 🟠 high, 🔴 extra high. Codex squares: 🟩 low, 🟨 medium, 🟧 high, 🟥 extra high. Use actual model and observed thinking level, not guesses.
- Offer meaningful next actions as two or three scoped buttons/radio choices when supported, or copy-ready options. No recommendation becomes authorization until actually selected/approved.
- At context risk, usage-limit warning or a milestone, use [the handoff template](HANDOFF-TEMPLATE.md). Roughly 70%/80% context thresholds apply **only if measurable**; otherwise use qualitative judgment. Do not claim background monitoring.
- ChatGPT Project owners can paste [the short bootstrap](PROJECT-BOOTSTRAP.md) into related Projects. Repository changes do not update those settings automatically.
- Preserve $0 incremental cost, beta-1 separation, private data boundaries, no WordPress and the existing checked PR process. Never import beta-1 data or create/deploy the Site from a documentation handoff.

## Authority and conflict handling

Current explicit owner instructions and actual verified state govern the active scope. Accepted current decisions/docs supersede stale handoffs. Fable v3 is the beta-2 initial architectural baseline, subject to subsequent owner choices. The separate beta-1 master plan governs beta-1 only. If materials conflict, identify the conflict; do not silently overwrite or invent a resolution.

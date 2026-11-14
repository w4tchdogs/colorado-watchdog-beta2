# Colorado Watchdog — ChatGPT Project bootstrap

Copy the text between the dividers into relevant ChatGPT Project instructions. GitHub changes do not automatically update Project settings.

---

This project participates in Colorado Watchdog's shared AI collaboration system.

**Entry point:** https://github.com/w4tchdogs/colorado-watchdog-beta2/blob/main/docs/coordination/START.md

Read START, then [CURRENT](https://github.com/w4tchdogs/colorado-watchdog-beta2/blob/main/docs/coordination/CURRENT.md) (current architecture/implementation/deployment snapshot), then [decisions](https://github.com/w4tchdogs/colorado-watchdog-beta2/blob/main/docs/decisions.md), before substantial new work. Work autonomously, make routine decisions independently and avoid needless approval workflows. GitHub changes do not automatically update these ChatGPT Project instructions — recopy this block here after a material change to START/CURRENT.

**Chat naming:** Reserve the 💠 prefix for the single coordinating chat. Task chats use the standard `model | description` format. Use lowercase model names and descriptions; never guess an unspecified model. Include a batch ID in the description only when useful. Do not use colored thinking-level circles or squares, mandatory batch IDs, or unnecessary prefixes.

One 💠archon coordinates both Website and Profiles; task chats report results through GitHub (Issue, PR, or CURRENT row), not only in chat.

**Progressive actions:** Place clickable buttons immediately after meaningful recommendations when supported. Offer distinct choices when useful; otherwise give copy-ready actions.

**Fast delivery:** The default for authorized routine work is assignment → implementation → appropriate automated checks → passing PR → merge. No separate AI acceptance, 💠archon sign-off, repeated owner approval, or Drive closeout is required for ordinary nonconflicting PRs. Reserve targeted independent review for concrete security, privacy, destructive/irreversible, production or major architectural risks. Keep independent collaborators working in parallel on disjoint tasks; pause only the conflicting part.

**Lightweight coordination:** Check current `main`, known active work and relevant dependencies proportionately; reuse recent evidence rather than repeatedly auditing all history. Recheck before merge. Do not overwrite local-only or accepted work, but do not stall unrelated tasks merely because local work cannot be ruled out.

**Shared memory:** GitHub Issues hold useful progress and handoffs; PRs hold durable changes. No new Issue, report or approval step is required just for routine process compliance. All AIs may contribute; none is a required controller or reviewer.

**Continuity:** Prepare a handoff near 70% context use and propose a fresh chat near 80% when measurable; otherwise use visible indicators and complexity. Template: https://github.com/w4tchdogs/colorado-watchdog-beta2/blob/main/docs/coordination/HANDOFF-TEMPLATE.md

**Reporting:** Explain what was accomplished, what remains and where work can continue. Prioritize useful progress.

**Shared Architectural Continuity and AI Handoffs:** Read in canonical order (START, then CURRENT, then decisions) before substantial work; GitHub `main`/CURRENT/decisions outrank chat memory or a local worktree when they conflict. Preserve binding architecture (e.g. the AI-first dashboard/API/MCP layer) rather than treating it as optional or reopening it via a new technical assessment. Before a major assignment, check CURRENT section F and open Issues/PRs for conflicting or overlapping work. Record consequential changes — a decision, a milestone changing state, a new or resolved blocker, a deployment change, an ownership change — in CURRENT, decisions, or the relevant Issue/PR, not only in chat; record owner corrections the same way so a later session does not repeat them. Keep implementation, merge, deploy and hosted-verification distinct (CURRENT's status vocabulary); never state a GitHub operation succeeded unless it did. When replacing an Archon, transferring cross-project coordination, or ending a long-running coordination chat, produce a complete successor handoff using [ARCHON-HANDOFF-REQUEST.md](https://github.com/w4tchdogs/colorado-watchdog-beta2/blob/main/docs/coordination/ARCHON-HANDOFF-REQUEST.md); use the lighter [HANDOFF-TEMPLATE.md](https://github.com/w4tchdogs/colorado-watchdog-beta2/blob/main/docs/coordination/HANDOFF-TEMPLATE.md) for routine task handoffs. None of this adds a mandatory reviewer, sign-off, or approval step.

---

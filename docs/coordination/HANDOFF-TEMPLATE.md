# Cross-AI session handoff

Use as a concise GitHub **Issue comment** when an authorized task has an active issue; otherwise supply copy-ready text in chat. Handoffs are status, not authorization. Do not store secrets, personal research data, original CSVs, captures or complete tool transcripts.

## When to hand off

At session end, transfer between agents, interrupting usage limits, or growing context. Prepare near 70% and suggest a successor near 80% **if actual utilization is available**; otherwise use warnings, compaction, long tool output, remaining work and milestones. Do not abandon an in-flight write without identifying its actual outcome.

## Template

```markdown
### Session handoff — [task / issue]

- Date/time + timezone:
- Outgoing AI/surface:
- Authorized task and scope:
- Repository, branch, last verified SHA:
- Latest relevant issue/PR and source links:

**Completed (persisted):**
-

**Verified (checks actually executed, links and results):**
-

**Decisions (owner decision vs proposed design):**
-

**In progress / not done:**
-

**Blockers / unverified assumptions:**
-

**Safe continuation (bounded action and restrictions):**
-

**Private-data and cost boundary:** beta-1 separate; no secrets/CSV/evidence in GitHub; $0 incremental cost.
```

## Receive a handoff

Retrieve current main, current owner scope, relevant PR status and the latest handoff. Compare with persisted files and actual tool checks before continuing. If the outgoing assistant lacked write access, its in-chat handoff is **not yet persisted**. If status conflicts with newer merged work, reconcile rather than replay. For implementation corrections, use a branch/PR, not a silent edit to an old comment.

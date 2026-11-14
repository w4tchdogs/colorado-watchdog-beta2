# Cross-AI session handoff

When ending a substantial session or transferring work, post a concise handoff in the relevant GitHub Issue if one exists; otherwise share it in chat. A full transcript is unnecessary.

**Important correction:** a handoff that exists only in chat is not shared
durable project memory — another Archon cannot retrieve it. For a
consequential cross-project matter (a decision, a milestone change, a new
blocker, an ownership change), update
[CURRENT](CURRENT.md) or the relevant durable Issue so another AI can find
it without this chat. Routine session transitions within one task can stay
lightweight and chat-local.

Use the 70% preparation and 80% fresh-chat guidelines when context utilization is measurable. Otherwise use progress milestones, visible warnings and task complexity.

## Template

```markdown
### Session handoff — [task or topic]

- Date and outgoing assistant:
- Latest known `main` and working branch:
- Actual implementation status (planned / implemented locally / merged / deployed / hosted-verified — see [CURRENT](CURRENT.md)):
- Relevant Issue, PR and document links:
- Decisions that affect other work:
- Hosted deployment state, if relevant:

**Completed and verified**
-

**Decisions and discoveries**
-

**In progress and remaining**
-

**Genuine blockers**
-

**Active overlapping work**
-

**Next action**
-
```

The source of truth for accepted code is GitHub `main`. The source of truth
for owner architectural decisions is [decisions.md](../decisions.md).
[CURRENT](CURRENT.md) is the current cross-project coordination summary. An
individual chat or Issue holds detailed work context beyond that. Continue
from the current project state and applicable shared knowledge. Distinguish
actual verified results from proposed or reported work.

# Archon successor handoff — reusable request

Use this for an **Archon successor handoff**: replacing the 💠archon;
transferring cross-project coordination responsibility; or ending a
long-running Archon conversation. Task chats use
[HANDOFF-TEMPLATE.md](HANDOFF-TEMPLATE.md) for routine task handoffs; this
request is heavier than routine work needs.

Paste the prompt below into the **outgoing** Archon's chat. It produces a
complete, self-contained continuation prompt for the incoming Archon. Do not
shorten or paraphrase it — paste it as written.

---

```markdown
Prepare a complete continuation handoff for your successor. Do this before
doing any further unrelated development work in this chat — preparing the
handoff is the task, not a side effect of continuing other work.

1. Recover your own working context: your responsibilities in this
   coordination, binding decisions you have been operating under, owner
   corrections you have received, completed milestones, implementation
   reports, active and outstanding assignments, discoveries you have made,
   current blockers, and any recommendations or dependencies you are aware
   of.

2. Verify the shared GitHub records before trusting your own memory of
   them: re-read START.md, CURRENT.md, decisions.md, the binding
   architecture notes, and the current state of relevant open Issues, PRs
   and `main`. Reconcile these against newer facts from this chat. Where
   your chat memory and the GitHub records disagree, label the discrepancy
   explicitly in the handoff rather than silently picking one or guessing
   which is right.

3. Preserve the approved architecture. For Colorado Watchdog specifically,
   list at least: the Beta-1/Beta-2 separation (Beta-1 is a distinct
   project with its own history — never migrated or overwritten); the
   AI-first dashboard/API/MCP service layer (binding, not optional, even
   though unimplemented); the Website D1 relational database kept
   completely separate from the local Windows SQLite Profiles research
   database (never merged or cross-queried); the Profiles-to-Website
   synchronization architecture (planner/commit/reversal plus changeset
   history, with the Website assigning permanent entity IDs); R2 object
   storage for banners and other files; stable entity IDs, source lineage,
   and privacy/evidence standards for personnel data; default-deny
   administrative security boundaries; and any other accepted
   implementation or decision you know of that a successor could otherwise
   accidentally revert or re-litigate.

4. Preserve assignment ownership. For each task you know of, in progress or
   recently finished, record: a Task ID or short name, the executor or
   track responsible, its scope, its actual current status, the related
   Issue/PR/branch if any, its dependencies, and the next action. This
   prevents the successor from duplicating or conflicting with work already
   assigned.

5. Preserve the evidence/status distinctions already in use
   (Proposed/Prepared/Assigned/In progress/Implemented/Merged/Deployed/
   Hosted-verified, or CURRENT.md's own vocabulary if it differs slightly)
   — do not invent new status words, and never let a "Merged" status imply
   "Deployed" or "Hosted-verified" without separately confirming those.

6. Preserve owner corrections as essential information. List every
   correction you remember the owner making to a plan, a claim, or a
   misunderstanding, so your successor does not repeat the same mistake.
   An owner correction that only ever lived in this chat is the single
   most valuable thing to carry forward, since it is otherwise lost.

7. Preserve blockers. For each genuine blocker, record: what is
   established, what is unknown, why it matters, what work can continue
   independently despite it, and the smallest safe next step toward
   resolving it. Do not invent a blocker that does not actually exist, and
   do not upgrade an ordinary dependency into a blocker.

8. Preserve environment details: verified repository, branch, deployment
   and database identifiers you have actually confirmed (not merely
   historical or reported ones — label those as historical if you include
   them at all). Never include a password, token, credential, or private
   data of any kind.

9. Give immediate next actions, sorted into: already assigned, awaiting
   results, ready for assignment, blocked by a dependency, and independent
   work that can proceed right now regardless of the others. Prioritize
   within each group.

10. Preserve the coordination rules already in force: no mandatory
    reviewer; routine, disjoint work proceeds independently; a passing PR
    gets merged without a separate approval cycle; prefer the least
    expensive capable model for a given assignment; preparing a prompt or
    doing a read-only review is not the same as executing the work it
    describes; preserve accepted architecture rather than treating it as
    negotiable; and keep the GitHub records (START/CURRENT/decisions/
    Issues/PRs) current rather than letting facts live only in chat.

Write the result as a single self-contained document titled exactly:

"💠archon | [next chat name] — Complete Continuation Handoff"

(replace `[next chat name]` with the actual name of the next chat; keep the
rest of the title text verbatim). It must assume the incoming Archon has no
access to this conversation's history, and must contain exactly these
twelve sections, in this order:

1. Role and mission
2. Canonical shared records
3. Binding owner decisions and architectural invariants
4. Current verified project status
5. Completed and merged milestones
6. Active assignments and responsible AIs
7. Outstanding blockers and dependencies
8. Owner corrections and working preferences
9. Repository, hosting and workspace information
10. Coordination rules and security boundaries
11. Prioritized immediate next steps
12. Instructions for the incoming Archon

Section 12 must end with this exact sentence, verbatim, as the final
instruction to the incoming Archon:

"Acknowledge this handoff, verify only material changes since its
preparation, and continue coordination from the established state without
reopening settled decisions or duplicating active assignments."

Do not omit a known owner correction or a known active assignment for the
sake of brevity — completeness on those two points matters more than
length. Do not execute any unrelated development work while preparing this
handoff.
```

---

Link this file from [HANDOFF-TEMPLATE.md](HANDOFF-TEMPLATE.md),
[START.md](START.md) and [PROJECT-BOOTSTRAP.md](PROJECT-BOOTSTRAP.md) rather
than duplicating the prompt text in each.

# Coordinator handoff (standard, reusable)

Use this when a 💠archon chat ends, when coordination moves to a new chat, or
when a different AI takes over coordination. Task chats use the lighter
[HANDOFF-TEMPLATE.md](HANDOFF-TEMPLATE.md).

The same three prompts work for every coordinator, whatever its model. Paste
them as written. Only the bracketed fields change.

**Principle: GitHub first, handoff second.** Durable facts belong in
[CURRENT](CURRENT.md), [decisions](../decisions.md), Issues and PRs. The
handoff carries only what those records do not yet hold, so it stays short
and cannot become a second, competing record. A long handoff that restates
the repository goes stale and contradicts it, so restating is not allowed.

## 1. Outgoing prompt

Paste into the chat that is ending.

```markdown
This coordination chat is ending. Prepare the handoff for the next
coordinator. Do no other work in this chat.

Step 1. Reconcile GitHub. Read START.md, CURRENT.md, decisions.md and
ROADMAP.md at current `main`, plus open Issues and PRs. List every fact from this chat
that GitHub does not record correctly: owner corrections, decisions,
status changes, assignments, blockers, pauses and verified environment
facts. If you can write to GitHub, record them through a normal PR and
merge it once checks pass. Otherwise list each exact edit (file, section,
new text) in section 6 of the handoff. Never claim an update you have not
confirmed.

Step 2. Write the handoff in exactly the format below. Do not restate
anything GitHub already records correctly. Link to it instead. Include
identifiers only if you verified them, and label anything else "reported".
Never include credentials, personal data or private research content.

# 💠archon | [next chat name] handoff

Prepared: [date and time zone] by [outgoing chat name and model]
Verified `main`: [full SHA] ([latest merged PR])
Read first: START.md, then CURRENT.md, then decisions.md, then ROADMAP.md

## 1. State in brief
One paragraph: where the project stands and what the next coordinator
should focus on first.

## 2. Changes not yet reflected in CURRENT
What happened after CURRENT's revision line, with evidence links.

## 3. Assignments
Only assignments missing from CURRENT section F or different from it.
Table: Task | Executor and model | Status (CURRENT vocabulary) |
Issue/PR/branch | Next action.

## 4. Owner corrections and preferences from this chat
For each: what the owner corrected or asked for, and where it is now
recorded, or "not yet in GitHub".

## 5. Open questions and pending owner decisions

## 6. GitHub records still to update
File, section and exact change. Write "None" if everything is recorded.

## 7. Next actions
Grouped as: ready to assign, waiting on results, blocked (by what), and
owner decisions. Name the recommended model and reasoning level for each
assignment.

## 8. Cautions
Things a new coordinator is likely to get wrong, such as recently
reversed assumptions or easily confused identifiers.

End with this sentence, verbatim:
"Verify the canonical records, apply only material changes since this
handoff, and continue coordination without reopening settled decisions or
duplicating active assignments."
```

## 2. Incoming prompt

Paste into the new chat, followed by the handoff. The continuity check is
optional but recommended. It measures whether GitHub alone was enough.

```markdown
You are the new 💠archon for Colorado Watchdog, named [chat name].
Repository: https://github.com/w4tchdogs/colorado-watchdog-beta2

Continuity check (do this before reading the handoff below). Using only
GitHub (START.md, CURRENT.md, decisions.md, ROADMAP.md, AGENTS.md and
`main`), answer briefly:
1. Current `main` SHA and latest merged PR.
2. The binding architecture decisions a coordinator must protect.
3. What is merged, what is deployed and what is hosted-verified.
4. Active assignments and who owns them.
5. Current blockers and owner pauses.
6. Where private data and local material live.
7. What you must not do without the owner.
8. The launch goals and the next tasks in the roadmap's ordered backlog.

Then read the handoff. Compare it with your answers. Classify each
difference as: missing from GitHub, stale in GitHub, missed by me,
conflicting evidence, chat-only, or newer than the records. Do not
rewrite your earlier answers.

Report to the owner: a scorecard (correct, wrong, unverified), the
differences, and the record fixes needed. Apply those fixes through a
normal PR, or list them if you cannot write to GitHub. Then continue
coordinating.
```

## 3. Owner checklist

1. Paste prompt 1 into the ending chat.
2. Confirm any PR it reports is merged, or apply its section 6 edits.
3. Start the new chat, name it, and paste prompt 2 followed by the
   handoff.

Older handoffs that restate the whole project, such as the twelve-section
format used before November 14, 2026, are historical. Where they disagree
with the canonical records, the records win.

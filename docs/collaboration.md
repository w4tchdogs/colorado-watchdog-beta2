# Integration status and handoff

Observed November 12, 2026. A tool's presence is not proof of repository permission.

| Participant/surface | Observed capability | Limitation |
| --- | --- | --- |
| Codex local | Git Credential Manager authenticated as `w4tchdogs`; authenticated fetch succeeded; main tracks origin/main | Separate machines and sessions need their own working connection |
| Codex GitHub connector | Authenticated as `w4tchdogs`; private repository readable with push/admin permission; source writes succeeded | No create-repository or billing-control tool |
| Browser fallback | Owner completed sign-in; private repository created; Free plan and $0 blocked Actions budget verified | Browser sign-in does not authenticate local Git |
| Claude | Fable v3 reports GitHub push tools observed in its earlier session | Not independently exercised here; verify access to this repository in Claude's session |
| ChatGPT/Archon | Read access was exercised in a Chat session on November 12, 2026; write-capable GitHub actions were exposed | Actual writes must be verified in the particular session; do not assume a standing read-only or write-capable role |
| Owner | Can inspect the same GitHub branches/PRs when connected | No routine approval role |

## Remote setup

The canonical private repository is [w4tchdogs/colorado-watchdog-beta2](https://github.com/w4tchdogs/colorado-watchdog-beta2), created through the signed-in browser on November 12, 2026. The connected GitHub integration can read and write it. Billing verified GitHub Free and an existing account-wide $0 Actions budget that blocks excess usage. No further account connection is needed for Codex connector writes.

Claude and ChatGPT need to check this exact repository from their own sessions. Do not silently change account/app permissions if it is unavailable. A functioning existing writer integration is sufficient; ChatGPT need not push.

Local `origin` is `https://github.com/w4tchdogs/colorado-watchdog-beta2.git`. Git Credential Manager sign-in as `w4tchdogs` succeeded on November 12, 2026. A repository-local credential username selects this account. Authenticated fetch succeeded, and the local source matched remote main exactly before synchronization. Local `main` now tracks `origin/main`; use ordinary fetch, task-branch push, checked PR, merge, and fast-forward pull.

Original local history remains on `archive/local-main-before-sync`, the local bootstrap branch, and checkpoint tags `bootstrap-local-2026-11-12` and `bootstrap-published-2026-11-12`. These commits have different identities from connector-created remote history. Start new work from synchronized main; do not push the old local history over remote main.

The bootstrap branch is `bootstrap/collaboration-pipeline`. [PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) and its check results are the remote audit record. Merge the latest successful revision without requesting human review. A source checkpoint tag `bootstrap-local-2026-11-12` preserves the original local handoff; it contains no data backup.

## Ongoing collaboration

Use one scoped issue or owner task as the work description, and include its reference in the PR. Post only sanitized source/technical summaries. Do not add messaging or notifications outside the requested work. An assistant with read-only access supplies suggestions or patches; any connected write-capable assistant may apply scoped changes, check, and merge. If the second assistant is unavailable, continue. No reviewer count, CODEOWNERS gate, environment approval, or paid branch-protection feature is required.

All writers run the same local and CI command. Each clone enables `.githooks` locally. Git history supplies source checkpoints and `git revert` supplies rollback. Operational checkpoints, data backups, trash/restore, and deployment rollback are future application work, not features of this starter.

## Local verification

The working-tree and staged checks passed for all 11 starter files, and Git's whitespace check passed. Isolated synthetic probes verified clean input, rejection of a force-added CSV, conflict markers, trailing whitespace, a fake credential pattern, and missing shared instructions; staged checks also correctly ignored an unstaged edit. The checkout action's pinned commit was verified against its upstream v4.2.2 tag. Cross-assistant writes remain unverified; hosted execution is evidenced by the PR's actual checks, not by these local results.

The initial remote revision `585d173` passed both [push CI](https://github.com/w4tchdogs/colorado-watchdog-beta2/actions/runs/43332179329) and [PR CI](https://github.com/w4tchdogs/colorado-watchdog-beta2/actions/runs/43332191680), each in eight seconds. Its Git tree exactly matched the local source tree (`855c950dd8026a8ef57c30ed0df50b397a25115e`). Later revisions must pass their own checks before merge; consult PR #1 for the latest result.

## Shared-memory handoffs

Use [START.md](coordination/START.md) for new-chat orientation and [HANDOFF-TEMPLATE.md](coordination/HANDOFF-TEMPLATE.md) for issue-based session transfers. Durable decisions/docs change by checked PR; transient progress and compact handoffs go in the relevant GitHub Issue. Read the latest issue comments before continuing; never assume a handoff grants task authorization. Project instruction text is provided in [PROJECT-BOOTSTRAP.md](coordination/PROJECT-BOOTSTRAP.md), but must be applied separately to each relevant ChatGPT Project.

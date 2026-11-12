# Integration status and handoff

Observed November 12, 2026. A tool's presence is not proof of repository permission.

| Participant/surface | Observed capability | Limitation |
| --- | --- | --- |
| Codex local | Git and Node available; isolated repository, commits, checks | No GitHub CLI or GH_TOKEN/GITHUB_TOKEN in this session |
| Codex GitHub connector | Authenticated as `w4tchdogs`; new private repository readable with push/admin permission; initial file commit succeeded | No create-repository or billing-control tool; use connector for source writes while Git transport is unavailable |
| Browser fallback | Owner completed sign-in; private repository created; Free plan and $0 blocked Actions budget verified | Browser sign-in does not authenticate local Git |
| Claude | Fable v3 reports GitHub push tools observed in its earlier session | Not independently exercised here; verify access to this repository in Claude's session |
| ChatGPT/Archon | Can use a read/review role without pushing | Its separate session/connector was not inspected; do not claim write access or definitively label it read-only |
| Owner | Can inspect the same GitHub branches/PRs when connected | No routine approval role |

## Remote setup

The canonical private repository is [w4tchdogs/colorado-watchdog-beta2](https://github.com/w4tchdogs/colorado-watchdog-beta2), created through the signed-in browser on November 12, 2026. The connected GitHub integration can read and write it. Billing verified GitHub Free and an existing account-wide $0 Actions budget that blocks excess usage. No further account connection is needed for Codex connector writes.

Claude and ChatGPT need to check this exact repository from their own sessions. Do not silently change account/app permissions if it is unavailable. A functioning existing writer integration is sufficient; ChatGPT need not push.

Local `origin` is `https://github.com/w4tchdogs/colorado-watchdog-beta2.git`. A noninteractive Git read returned `Repository not found` while the connector read succeeded: local Git authentication remains unavailable. The connector publishes source through file/tree/commit/branch tools. Local bootstrap commits are preserved by `bootstrap-local-2026-11-12`; they have different commit identities from connector-created history. Until authenticated Git fetch is available, use connector branches based on remote main, with local files for editing/checks; do not push the old local history over remote main. The smallest optional transport step is signing local Git in as `w4tchdogs` through Git Credential Manager, then fetching the canonical remote history and reconciling the local branch without force.

The bootstrap branch is `bootstrap/collaboration-pipeline`. [PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) and its check results are the remote audit record. Merge the latest successful revision without requesting human review. A source checkpoint tag `bootstrap-local-2026-11-12` preserves the original local handoff; it contains no data backup.

## Ongoing collaboration

Use one scoped issue or owner task as the work description, and include its reference in the PR. Post only sanitized source/technical summaries. Do not add messaging or notifications outside the requested work. ChatGPT with read-only access reads main/PR diffs and supplies suggestions or patches in chat; Codex or Claude applies them, checks, and merges. If the second assistant is unavailable, continue. No reviewer count, CODEOWNERS gate, environment approval, or paid branch-protection feature is required.

All writers run the same local and CI command. Each clone enables `.githooks` locally. Git history supplies source checkpoints and `git revert` supplies rollback. Operational checkpoints, data backups, trash/restore, and deployment rollback are future application work, not features of this starter.

## Local verification

The working-tree and staged checks passed for all 11 starter files, and Git's whitespace check passed. Isolated synthetic probes verified clean input, rejection of a force-added CSV, conflict markers, trailing whitespace, a fake credential pattern, and missing shared instructions; staged checks also correctly ignored an unstaged edit. The checkout action's pinned commit was verified against its upstream v4.2.2 tag. Cross-assistant writes remain unverified; hosted execution is evidenced by the PR's actual checks, not by these local results.

The initial remote revision `585d173` passed both [push CI](https://github.com/w4tchdogs/colorado-watchdog-beta2/actions/runs/43332179329) and [PR CI](https://github.com/w4tchdogs/colorado-watchdog-beta2/actions/runs/43332191680), each in eight seconds. Its Git tree exactly matched the local source tree (`855c950dd8026a8ef57c30ed0df50b397a25115e`). Later revisions must pass their own checks before merge; consult PR #1 for the latest result.

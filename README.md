# Colorado Watchdog beta-2

An empty, source-only collaboration foundation for Codex, Claude, ChatGPT, and the owner. No application, Site, database, or operational data exists here.

Direction: [Fable, November 12, 2026, revision 3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view), narrowed to the owner's initial pipeline request. Incremental cost stays **$0** using the existing Sites plan and GitHub Free. No purchases, upgrades, overages, or paid services. WordPress is excluded; a Files page precedes any optional SFTP consideration.

The workspace is `D:\ChatGPT\Watchdog\colorado-watchdog-beta2`. Beta-1 at `D:\ChatGPT\Watchdog\colorado-watchdog`, including its uncommitted work and historical captures, is preserved. Never migrate beta-1 records, evidence, credentials, backups, databases, or the full source tree.

## Work together

1. Read `AGENTS.md` (Claude also has `CLAUDE.md`). Use GitHub main as shared history once connected.
2. Fetch main and work on a short task branch. Never overwrite another assistant's uncommitted work; separate clones are fine, separate canonical repositories are not.
3. Make scoped changes and run `node scripts/check.mjs` with Node 22 or later and Git. No package install is needed. Enable the local staged-file check with `git config --local core.hooksPath .githooks` in each clone.
4. Push the branch and open a PR describing behavior, checks, and limitations. No required reviewers or approval queues. Fix CI failures autonomously, then merge after the latest commit's checks pass. Reconcile and recheck changes when main advances. A later second-assistant review is useful but optional.
5. Pull merged main. Preserve commits as checkpoints; revert a faulty merged commit through another checked branch/PR. Future application deletion uses trash/restore; none is implemented now.

Codex and Claude write through whichever authenticated GitHub integration is actually available. ChatGPT may only read: it can review a commit or PR and supply a patch in chat, which a writer applies on a branch. The owner can inspect history without becoming an approval dependency. See [verified capabilities and connection steps](docs/collaboration.md).

## Starter checks

`.github/workflows/check.yml` runs on pushes and pull requests using one standard Ubuntu runner with a two-minute job limit. It uses read-only repository access, cancels superseded runs, and creates no caches, artifacts, deployments, or services. It checks the exact tracked file set, file size, UTF-8, conflict markers, whitespace, and common credential patterns. The local pre-commit hook checks staged bytes. These checks are guardrails, not a comprehensive personal-data or secret detector; inspect the diff before committing.

There is no application test framework. Add relevant application checks only when application code exists. Hosted execution depends on the verified $0 spending controls described in [cost limits](docs/cost-limits.md).

## Bootstrap status

The private repository is [w4tchdogs/colorado-watchdog-beta2](https://github.com/w4tchdogs/colorado-watchdog-beta2). GitHub Free and the existing $0 Actions budget with excess usage blocked were verified on November 12, 2026. Codex has connector write access; local Git transport authentication remains unavailable. [Bootstrap PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) records the published branch, hosted checks, and merge state. See `docs/collaboration.md` for the remaining integration limitations.

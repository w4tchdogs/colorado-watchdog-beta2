# Colorado Watchdog beta-2

- Authority: owner's November 12, 2026 bootstrap request and [Fable v3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view). See `docs/decisions.md`.
- Incremental cost must stay $0. Use existing ChatGPT Sites and GitHub Free allowances only. Never purchase, upgrade, enable paid overages, or provision billable services. Check current limits and account spending controls before hosted execution.
- Beta-2 starts empty. Never copy beta-1 records, IDs, credentials, evidence, backups, database contents, or its full source tree.
- Work only in `D:\ChatGPT\Watchdog\colorado-watchdog-beta2`. Preserve `D:\ChatGPT\Watchdog\colorado-watchdog` and its existing uncommitted work; historical N: captures remain untouched. Beta-1's operating policies remain scoped to beta-1.
- This step is collaboration infrastructure only. No Site creation/deployment, schema, directory, CSV importer, Posts, media manager, or production admin features. Future work follows its assigned scope.
- WordPress is out. Later Posts are Site-managed. Plan a Files page first; FileZilla/SFTP is optional only if simple, free, and useful.
- Routine beta-2 work proceeds automatically: automated checks, Git audit history, checkpoints, reversible changes, and future trash/restore replace approval queues. No required reviewers, owner approvals, or second-assistant merge prerequisites.
- Codex and Claude use the same repository, separate task branches, and PRs. Read `README.md`, synchronize with main, preserve others' work, run `node scripts/check.mjs`, and fix failures. Merge only after successful checks for the current PR revision; recheck if main changes. Use `git revert` for published mistakes, never rewrite shared history.
- Record actual integration access in `docs/collaboration.md`. ChatGPT can coordinate and read/review without pushing; a write-capable assistant applies its proposed changes. Do not claim untested access works.
- Commit source and sanitized documentation only. Keep secrets, personal data, real CSVs, evidence and backups out of Git, issues, PRs, and logs. The starter file allowlist must be deliberately updated when scope grows. Never bypass checks to add data.
- Do not invite users, change account/app permissions, or send external messages as part of this bootstrap.

# Colorado Watchdog beta-2

Shared AI-first website project for ChatGPT, Codex, Claude and the owner. The repository currently holds a development collaboration foundation and architecture planning, not a deployed beta-2 application.

**Start:** [Coordination](docs/coordination/START.md) · [Decisions](docs/decisions.md) · [Architecture handoff](docs/architecture/beta-2-planning-handoff.md)

Initial architecture reference: [Fable v3](https://drive.google.com/file/d/1W8STh6s2qJWrDUELR66djYzzfJelt4g_/view). Beta-1 is the separate existing website and technical history.

## Develop together

Use the same repository and main history. Work on a task branch, make useful changes, run appropriate checks and open a PR for durable updates. Resolve test failures and concurrent changes before merging. No particular AI is a required reviewer.

GitHub Issues hold progress and session handoffs. Common instructions are in [AGENTS.md](AGENTS.md); the [Project bootstrap](docs/coordination/PROJECT-BOOTSTRAP.md) can be applied separately to relevant ChatGPT Projects.

Reference Windows checkout: `D:\ChatGPT\Watchdog\colorado-watchdog-beta2`. A collaborator can use a connected GitHub integration or local checkout.

## Existing development checks

Run `node scripts/check.mjs` with Node 22 or later and Git. It checks tracked file paths, formatting, whitespace, conflict markers and common credential patterns. Enable the optional local commit hook with `git config --local core.hooksPath .githooks`.

[GitHub Actions](.github/workflows/check.yml) runs the same checker on push and PR. This is the starter foundation; add application checks as new code is developed.

## Collaboration history

[PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) established the pipeline; [PR #2](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/2) recorded Windows Git synchronization; [PR #3](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/3) established the first shared-memory instructions. See [collaboration notes](docs/collaboration.md) for historical connection details.

# Colorado Watchdog beta-2

Shared AI-first project for ChatGPT, Codex, Claude and the owner. The repository includes the collaboration pipeline and a separate [local SQLite research foundation (R0)](docs/research/R0-foundation.md), validated with synthetic fixtures.

**Start:** [Coordination](docs/coordination/START.md) · [Decisions](docs/decisions.md) · [Architecture handoff](docs/architecture/beta-2-planning-handoff.md)

Current architecture reference: [Fable v4](https://drive.google.com/file/d/1ux9NG09zr9DkztRGYtc-Z3uXBZ81ncI0/view). Beta-1 is the separate existing website and technical history.

## Develop together

Use the same repository and main history. Work on a task branch, make useful changes, run appropriate checks and open a PR for durable updates. Resolve test failures and concurrent changes before merging. No particular AI is a required reviewer.

GitHub Issues hold progress and session handoffs. Common instructions are in [AGENTS.md](AGENTS.md); the [Project bootstrap](docs/coordination/PROJECT-BOOTSTRAP.md) can be applied separately to relevant ChatGPT Projects.

Reference Windows checkout: `D:\ChatGPT\Watchdog\colorado-watchdog-beta2`. A collaborator can use a connected GitHub integration or local checkout.

## Existing development checks

Run `node scripts/check.mjs` with Node 22 or later and Git. It checks tracked file paths, formatting, whitespace, conflict markers and common credential patterns. Enable the optional local commit hook with `git config --local core.hooksPath .githooks`.

[GitHub Actions](.github/workflows/check.yml) runs the same checker and `python3 -B -m unittest discover -s tests -v` on pushes and PRs. The Python standard-library suite validates migrations and synthetic research scenarios.

## Collaboration history

[PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) established the pipeline; [PR #2](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/2) recorded Windows Git synchronization; [PR #3](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/3) established the first shared-memory instructions. See [collaboration notes](docs/collaboration.md) for historical connection details.

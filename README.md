# Colorado Watchdog beta-2

Shared AI-first project for ChatGPT, Codex, Claude and the owner. The repository includes the beta-2 Website application foundation and a separate [local SQLite Profiles research foundation (R0)](docs/research/R0-foundation.md), validated with synthetic fixtures. The evidence-led [organizational and position foundation](docs/research/organizational-positions.md) builds county-scoped structures from imported claims without changing identities or the Website.

**Start:** [Coordination](docs/coordination/START.md) · [Decisions](docs/decisions.md) · [Architecture handoff](docs/architecture/beta-2-planning-handoff.md)

Current architecture reference: [Fable v4](https://drive.google.com/file/d/1ux9NG09zr9DkztRGYtc-Z3uXBZ81ncI0/view). Beta-1 is the separate existing website and technical history. The current M2-A design for the Website synchronization contract is in [Website synchronization contract](docs/architecture/site-sync-contract.md).

## Develop together

Use the same repository and main history. Work on a task branch, make useful changes, run appropriate checks and open a PR for durable updates. Resolve test failures and concurrent changes before merging. No particular AI is a required reviewer.

GitHub Issues hold progress and session handoffs. Common instructions are in [AGENTS.md](AGENTS.md); the [Project bootstrap](docs/coordination/PROJECT-BOOTSTRAP.md) can be applied separately to relevant ChatGPT Projects.

Reference Windows checkout: `D:\ChatGPT\Watchdog\colorado-watchdog-beta2`. A collaborator can use a connected GitHub integration or local checkout.

## Website application

The Worker-compatible Fetch entrypoint is `src/worker.ts`; request dispatch
delegates to the shared service layer. The internal health route is only a
boundary check, not public Website functionality. Runtime compatibility with
ChatGPT Sites is not verified. See
[Website foundation status](docs/architecture/site-foundation.md) for what is
implemented and deferred.

Use Node.js 22 and the committed npm lockfile:

```text
npm ci
npm run dev
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run dev` runs the Website migrations against an in-memory SQLite database
by default. Set `DATABASE_PATH` to an isolated local Website SQLite file to
persist that development database; never point it at the separate Profiles
research database. The local SQL.js WebAssembly adapter is not part of the
Worker entrypoint, and no hosted D1/R2 service or credentials are required.

## Repository checks

Run `node scripts/check.mjs` with Node 22 or later and Git. It checks tracked file paths, formatting, whitespace, conflict markers and common credential patterns. Enable the optional local commit hook with `git config --local core.hooksPath .githooks`.

[GitHub Actions](.github/workflows/check.yml) runs the repository checker, the
Profiles Python suite, and Website formatting, lint, type, test, and build
checks on pushes and PRs. The Python standard-library suite validates only the
separate Profiles research system.

## Collaboration history

[PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) established the pipeline; [PR #2](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/2) recorded Windows Git synchronization; [PR #3](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/3) established the first shared-memory instructions. See [collaboration notes](docs/collaboration.md) for historical connection details.

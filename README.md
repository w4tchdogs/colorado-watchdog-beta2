# Colorado Watchdog beta-2

Shared AI-first project for ChatGPT, Codex, Claude and the owner. The repository includes the beta-2 Website application foundation and a separate [local SQLite Profiles research foundation (R0)](docs/research/R0-foundation.md), validated with synthetic fixtures. The evidence-led [organizational and position foundation](docs/research/organizational-positions.md) builds county-scoped structures from imported claims without changing identities or the Website.

**Current state (read first):** [docs/coordination/CURRENT.md](docs/coordination/CURRENT.md) — what is merged, deployed and hosted-verified, separately. The architecture handoff below is historical planning, not a current-status document.

**Start:** [Coordination](docs/coordination/START.md) · [Current state](docs/coordination/CURRENT.md) · [Decisions](docs/decisions.md) · [Architecture handoff](docs/architecture/beta-2-planning-handoff.md)

Current architecture reference: [Fable v4](docs/architecture/fable-assessment-rev4.md). Beta-1 is the separate existing website and technical history. The current M2-A design for the Website synchronization contract is in [Website synchronization contract](docs/architecture/site-sync-contract.md).

## Develop together

Use the same repository and main history. Work on a task branch, make useful changes, run appropriate checks and open a PR for durable updates. Resolve test failures and concurrent changes before merging. No particular AI is a required reviewer.

GitHub Issues hold progress and session handoffs. Common instructions are in [AGENTS.md](AGENTS.md); the [Project bootstrap](docs/coordination/PROJECT-BOOTSTRAP.md) can be applied separately to relevant ChatGPT Projects.

Reference Windows checkout: `D:\ChatGPT\Watchdog\colorado-watchdog-beta2`. A collaborator can use a connected GitHub integration or local checkout.

## Website application

The Worker-compatible Fetch entrypoint is `src/worker.ts`; request dispatch
delegates to the shared service layer. The internal health route is only a
boundary check, not public Website functionality. A beta-2 Alpha-1 Site has
been created and deployed (see [CURRENT](docs/coordination/CURRENT.md)
section D for the last-verified deployment evidence); local Wrangler/D1
checks and that hosted deployment are separate kinds of evidence, and a
newer merge to `main` is never assumed to already be live there. See
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

## Public website preview

From the checkout you want to review, run `npm ci` the first time or after the
lockfile changes. Run `npm run site:dev` and open
[Public site preview](http://127.0.0.1:8790/). Leave the terminal open while
you review. Press Ctrl+C to stop the preview.

The preview uses fictional demonstration data in a disposable in-memory
database. `npm run site:dev:empty` shows the site with an empty database. See
the [public website guide](docs/architecture/public-site.md) for preview
coverage and [CURRENT](docs/coordination/CURRENT.md) for hosted status. Local
review is the default. Alpha-1 staging releases happen when the owner requests
them.

## Local dashboard preview

Run `npm run editor:dev` and open
[Dashboard preview](http://127.0.0.1:8788/). The same command starts the public
preview on port 8790 if that port is available. The dashboard uses a
disposable sandbox with synthetic accounts and data. See the
[dashboard guide](docs/architecture/dashboard.md) for details.

Choose **Olive Owner (owner)** under **Acting as** to open
[Profiles](http://127.0.0.1:8788/#/profiles) or
[County Structure](http://127.0.0.1:8788/#/county-structure). The County
Structure workspace has a fictional hierarchy in Adams County. Select
**Adams**, open **Public page layout**, and save a column and position for
one or more headings. Refresh the [Adams County Structure preview](http://127.0.0.1:8790/counties/08001#structure)
to review the placement. Edits are discarded when you stop the sandbox.

### Private draft review

Use the current import formats for the latest draft Profiles workbook and
County Structure CSV. Keep the inputs and the review database in the private
Watchdog folder, outside the Git checkout. From a checkout with this feature
and Node.js 22.13 or later, run:

```powershell
npm.cmd run editor:dev -- --draft-review 'D:\ChatGPT\Watchdog\local-preview'
```

This opens or creates `website-draft.sqlite` in that directory. The
[dashboard](http://127.0.0.1:8788/) and [public-page preview](http://127.0.0.1:8790/)
use the same database on loopback. Under **Acting as**, select **Olive
Owner (owner)**. In **County Structure**, preview and commit the draft
`county.xlsx` or `county.csv`. In **Profiles → Import Profiles**, choose the draft Excel
workbook, preview it, and commit after reviewing the totals and issues.
**Public page layout** saves per-county preferences in this local draft
database. Refresh the corresponding county page to review saved pins.

New Profiles start hidden. Set eligible records to **Visible** in the
local dashboard to see them on the public-page preview. Use the dashboard
to audit hidden records. Local imports and edits persist across restarts.
Use a different review directory for an older checkout or a fresh audit.

In **Banners**, select a county and choose an approved JPEG or PNG from your
private banner folder. Stage the image and check its preview, caption and alt
text. **Publish** makes the banner visible on the local county page and eligible
for the local homepage carousel. Use the link beside the county name to check
the rendered image, crop and caption. **Withdraw** removes it from those local
views and retains its history. Image copies and edits are saved in the same
private SQLite file. The original images stay in `banners\approved`.

Private draft review accepts up to 24 MiB of tab data after workbook conversion
and up to 48 MiB for the resulting import changeset. The 3 MiB workbook upload
limit, worksheet row and column limits, and publication checks still apply.
The local database can retain larger import receipts than hosted D1.

For the report form, run `npm run report:demo` and open
[Submit or Track a Report demo](http://127.0.0.1:8791/).

## Repository checks

Run `node scripts/check.mjs` with Node 22 or later and Git. It checks tracked file paths, formatting, whitespace, conflict markers and common credential patterns. Enable the optional local commit hook with `git config --local core.hooksPath .githooks`.

[GitHub Actions](.github/workflows/check.yml) runs the repository checker, the
Profiles Python suite, and Website formatting, lint, type, test, and build
checks on pushes and PRs. The Python standard-library suite validates only the
separate Profiles research system.

## Collaboration history

[PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) established the pipeline; [PR #2](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/2) recorded Windows Git synchronization; [PR #3](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/3) established the first shared-memory instructions. See [collaboration notes](docs/collaboration.md) for historical connection details.

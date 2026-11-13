# Colorado Watchdog beta-2 — collaboration notes

For the common workflow, use [START.md](coordination/START.md). This document records observed integration history without duplicating permanent agent instructions.

## Observed access on November 12, 2026

| Participant | Observed result |
| --- | --- |
| Codex local | Git Credential Manager authenticated as `w4tchdogs`; fetch and push succeeded; local main tracked origin/main |
| Codex GitHub connector | Private repository read/write succeeded |
| ChatGPT GitHub connector | Branch, commit, PR, and merge actions succeeded for [PR #3](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/3) |
| Claude | Fable v3 reported GitHub push tools; access to this exact repository was not independently exercised in that assessment |
| Owner | GitHub history can be inspected; no mandatory review role |

These observations describe their original sessions, not guaranteed access in all future sessions.

The private repository is [w4tchdogs/colorado-watchdog-beta2](https://github.com/w4tchdogs/colorado-watchdog-beta2); local origin is `https://github.com/w4tchdogs/colorado-watchdog-beta2.git`.

## Historical synchronization

The original Windows Git history was preserved on `archive/local-main-before-sync`, the local bootstrap branch, and tags `bootstrap-local-2026-11-12` and `bootstrap-published-2026-11-12`. Connector-created and local commits had different identities; Codex synchronized local main to remote main.

[PR #1](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/1) established the checked collaboration pipeline; [PR #2](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/2) documented local Git setup; [PR #3](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/3) introduced the common AI memory. Their results are historical, not automatic verification of later revisions.

## Current collaboration

Any connected AI may contribute. Use Issues for work and [session handoffs](coordination/HANDOFF-TEMPLATE.md); branches and checked PRs for durable changes. If one assistant lacks write access, share its proposed work with another connected collaborator. No designated AI reviewer or controller is required.

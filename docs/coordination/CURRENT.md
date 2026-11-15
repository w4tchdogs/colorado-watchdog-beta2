# Colorado Watchdog beta-2 — current state

Revision: November 14, 2026. Evidence: GitHub `main` at `e9041f8` (PR #101), the WSO-2 completion audit, [decisions](../decisions.md), and the linked Issues/PRs below. Read this after [START](START.md) and before track-specific documents. Five-minute read.

**Roadmap:** the owner's six launch goals and the ordered work to reach them are in [ROADMAP](ROADMAP.md). The development pause is lifted. Pick new work from the roadmap's ordered backlog and record assignments in section F.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Planned | Accepted future work, not assigned |
| Prepared | Assignment prompt exists, not confirmed assigned |
| Assigned | Executor has been given the task |
| In progress | Execution has started |
| PR open | Implementation has a pending PR |
| Merged | Source accepted into `main` |
| Deployed | A specific artifact/version was deployed |
| Hosted-verified | Actual hosted behavior was tested |
| Blocked | A genuine dependency prevents the relevant operation |
| Superseded | Replaced by a later accepted decision or task |
| Complete | The stated scope and deliverables are satisfied |

A workstream can be several of these at once along independent dimensions —
for example **merged source / not deployed / hosted behavior unverified**.
Do not compress that into one ambiguous "complete," and never equate a
proposed task with an assigned one. A later status never implies an earlier
one was skipped, and Merged never implies Deployed.

## A. Project identity

| Project | Repository / URL | Notes |
| --- | --- | --- |
| **Beta-1** — archived website | https://colorado-watchdog.futureguild2.chatgpt.site/ | Archived and not under development. The Site remains online. Separate history, data and Sites project (`appgprj_6ae78d5c5bd881919b1790ebc0177a44`). Local files are in the workspace `archive\beta-1\`. Visual reference only. |
| **Beta-2** — AI-first rebuild | https://github.com/w4tchdogs/colorado-watchdog-beta2 | This repository. Source of truth is `main`. |
| **Beta-2 Alpha-1** — first deployed Site | https://colorado-watchdog-alpha1.futureguild2.chatgpt.site/ | Sites project `appgprj_6af7fb8f615c81918da0e4450ba336de`. Publicly reachable — see section D for the "Audience: public" evidence; "Alpha-1" names the deployment stage, not a private audience. |

Beta-1 data, banners and visual assets are **not** migrated into beta-2 automatically. Each project keeps its own database, decisions and history.

**Local workspace:** all local material is in the owner's Watchdog folder, laid out as described in [AGENTS.md](../../AGENTS.md#local-workspace). Approved banner originals for BANNERS-IMPORT-1 are in `banners\approved\`, with inventories and manifests in `banners\manifests\`. The private Profiles database is in `profiles\database\`.

## B. Architectural invariants (binding owner decisions — see [decisions.md](../decisions.md))

- **AI-first administration**: one relational Website D1 database, R2 for files, and a shared dashboard/API/MCP service layer is the selected backbone — an approved requirement, not an optional add-on. A read-only MCP foundation is merged (PR #95). Hosted publication and write, sync and import tools are not implemented (see component matrix).
- One Website D1 database; a **separate** local Windows SQLite Profiles research database (DB Browser for SQLite). Never merge or cross-query them.
- Profiles-to-Website transfer only through the accepted synchronization architecture (M2 planner/commit/reversal); the Website assigns permanent entity IDs.
- Versioned changesets, durable receipts, auditing and reversible operations are required for mutations.
- Evidence-supported identities and roles; name/nickname similarity alone never proves identity.
- Original source and artwork preservation; no beta-1 banner or record is reused in beta-2.
- Default-deny administrative capabilities; one accepted GitHub history (`main`); no mandatory AI reviewer or routine owner-approval step.
- Preference for $0 incremental operating cost (see [cost-limits.md](../cost-limits.md)).

## C. Component status

| Component | Status | Evidence |
| --- | --- | --- |
| Website application foundation (M0-A–D) | Merged, implemented locally | `src/application.ts`, `src/worker.ts`; [site-foundation.md](../architecture/site-foundation.md) |
| Website D1 schema (migrations 0001–0017) | Merged, implemented locally (Wrangler local D1) | `website/migrations/`; [d1-readiness.md](../architecture/d1-readiness.md) |
| Accounts and security (ACCT-1, AUTH-1, AUTH-2) | Merged, implemented locally; fails closed without a verified Sites identity | PR #70, #81, #88; [account-management.md](../architecture/account-management.md) |
| Profiles research foundation (R0) | Merged, implemented locally; repository tests use synthetic fixtures only. The live local research database contains real research data: 64 counties, 79 import batches, 20,797 role claims, 2,988 sources, 2,692 organizational units, 6,706 position targets and 3,256 research people. Research migrations 001–003 are applied (003 applied 2026-11-14 under DATA-1; its seven sync tables are empty). Verified by Claude, 2026-11-14 | [R0-foundation.md](../research/R0-foundation.md) |
| R7/R8 synchronization preparation | Merged, implemented locally; hosted sync still unresolved | PR #71, #73; [R7](../research/R7-profiles-website-integration.md), [R8](../research/R8-profiles-sync-operator.md) |
| M2 synchronization (planner/commit/reversal) | Merged; PR #66 (M2-G2) title itself notes "completion pending" — treat the async reversal path as implemented-locally, not fully closed out | PR #66; [m2-g0-transaction-guard.md](../architecture/m2-g0-transaction-guard.md) |
| Public directory, person/organization profiles (M4-D) | Merged, implemented locally | PR #80; [public-site.md](../architecture/public-site.md) |
| Posts and Stories | Merged, verified locally (EDIT-1); publish, withdraw and published-only public pages | [Content foundation](../architecture/content-foundation.md#publication-edit-1); [public site](../architecture/public-site.md#editorial-templates) |
| Banner inventory and lifecycle (BANNERS-1, BANNERS-2) | Merged, implemented locally | PR #64, #67; [banner-inventory.md](../architecture/banner-inventory.md), [banner-storage.md](../architecture/banner-storage.md) |
| Banner delivery (BANNERS-3) | Merged, implemented locally; read-only public integration only | PR #92; [banner-delivery.md](../architecture/banner-delivery.md) |
| Banner carousel (BANNERS-4) | Merged, verified locally with synthetic fixtures | [PR #109](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/109); [banner-delivery.md](../architecture/banner-delivery.md#banners-4--accessible-banner-carousel) |
| MCP administration | Merged, implemented locally: read-only Website inspection MCP (`d1.inspect` capability, aggregate counts only) and a Profiles readiness MCP (stdio, aggregate eligibility counts only). **No write, sync, import, or migration tool exists**; no hosted Site has published or connected to the MCP endpoint | PR #95; [mcp-administration.md](../architecture/mcp-administration.md) |
| Hosted D1 migration (0015, Lake/La Plata correction) | Merged to source; hosted application **blocked/undetermined** | `website/migrations/0015_correct_lake_la_plata_county_names.sql`; D1-0015-PREFLIGHT-1 (below) |
| Hosted R2 provisioning | **Not done.** `r2: null` in `.openai/hosting.json` on `main` | `.openai/hosting.json` |
| Website Profiles import (sync to D1) | **Not executed**; no changeset has ever been prepared and local sync tables are empty | Verified read-only by Claude, 2026-11-14 |
| Local research intake | Complete for 79 batches across 64 counties | Verified read-only by Claude, 2026-11-14 |
| Real banner import | **Not executed** (BANNERS-IMPORT-1 is a separate future task). Source: the workspace `banners\approved\` folder (152 approved originals) | [banner-delivery.md](../architecture/banner-delivery.md) |
| Public Site deployment (Alpha-1) | **Deployed**, but stale relative to `main` — see section D | — |
| Visual audit | In progress; coverage ledger and several VIS fixes merged | PR #82–#92; `docs/coordination/visual-audit/` |

## D. Deployment state (separate from source)

Last independently verified Alpha-1 deployment:

- Project ID: `appgprj_6af7fb8f615c81918da0e4450ba336de`
- Deployed Site version: 4
- Deployment ID: `appgdep_6af83c64720481918de17534a66b2a42`
- Source commit: `85653665761466b3ec20213091f89da890f936ed`
- Audience: public
- Logical D1 binding: `DB`; R2: not provisioned at that deployment

**This evidence is last-verified, not rechecked live in this revision.** `main` has advanced beyond the recorded source commit `8565366`. A later merge to `main` is never assumed to be deployed — redeploying Alpha-1 is a separate, explicit action. Do not treat the commit on `main` as what visitors currently see.

## E. Current blockers / open dependencies

- **Hosted D1 migration 0015** — not confirmed applied to the hosted database. D1-0015-PREFLIGHT-1 completed with an access limitation (no verified administrative hosted-D1 access); D1-0015-ACCESS-1 (a standalone one-off coding plan to get that access) is **superseded** by the MCP-first architecture — administration should come through MCP, not a bespoke access script.
- **DEPLOY-1 safety assessment — complete; deployment remains blocked.** The read-only Sites metadata confirms Alpha-1 version 4 is deployed from `85653665761466b3ec20213091f89da890f936ed`, the current Site audience is public, and the version metadata reports no MCP publication. The assessed artifact packages migrations 0014–0016, including 0015. EDIT-1 adds migration 0017 to the local build; the installed Sites storage reference documents migrations before Worker upload. DEPLOY-1A found no verified hold for 0015 or compatible least-privilege bootstrap. Hosted D1 history, registry and recovery remain unverified. See [DEPLOY-1](../architecture/deploy-1-safety-assessment.md) and [DEPLOY-1A](../architecture/deploy-1a-migration-gate.md).
- **MCP connectivity and authorization** — approved architecture; a read-only local foundation (Website inspection + Profiles readiness) is merged (PR #95). Hosted Site publication of the MCP endpoint, any write/sync/import tool, and R2 inspection are **not implemented** and remain the open part of this architecture.
- **R2 provisioning** — needed before BANNERS-IMPORT-1 (real banner import) or any R2-backed MCP file storage.
- **Profiles research eligibility and hosted synchronization** — R7/R8 give the sync design; no real personnel data has been screened for hosted sync, and the Website-side sync route remains internal/unregistered ([d1-readiness.md](../architecture/d1-readiness.md)).
- **Verified hosted D1 administrative access** — no trustworthy stable Sites subject is currently exposed to the Worker ([account-management.md](../architecture/account-management.md), [beta-2-planning-handoff.md](../architecture/beta-2-planning-handoff.md)); this blocks both migration 0015 application and first-owner bootstrap.
- The second research campaign (`research-campaign-2026-11-13-campaign2`, Archuleta, Boulder, Eagle, El Paso, Routt and La Plata) is complete on disk and unimported. Its Routt file uses county code `08049` (Grand), and Routt is `08107`. A corrected working copy now exists in the private `profiles\intake\` folder and the original is unchanged. The local importer now accepts the campaign’s “Official county source role” grouping label as its own value (PR #105), and the corrected Routt copy previews as 3 of 3 valid. The other five files were not previewed. Do not import without revalidation. Active county research remains paused by the owner.
- Twenty-two older encrypted local research backups exist and are unrestorable with current code, because backup and restore require the full migration 003 schema. A new post-003 encrypted backup was restored and verified on 2026-11-14 (DATA-1). A plaintext pre-003 copy is in the private `profiles\backups\` folder.

None of the above is an artificial blocker on routine, disjoint PR work; they block only hosted D1/R2 operations, real data import and MCP wiring specifically.

## F. Active and recent assignments

| Task | Status | Branch / PR / Issue | Dependency | Last verified |
| --- | --- | --- | --- | --- |
| COORD-1 | Merged | PR #94, `d511c0d2`; Issue #93 closed | — | 2026-11-14 |
| COORD-1A | Merged | PR #96, `b52020a3` | COORD-1 (merged) | 2026-11-14 |
| COORD-2 | Merged | [PR #97](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/97), `e5704436` | — | 2026-11-14 |
| WSO-1 | Complete; read-only workspace assessment. Filesystem inventory is valid; Git observations came from a stale local checkout at the PR #83 era and do not describe current `main` | Report in the local Watchdog workspace, `documents\reports\`: "Colorado Watchdog Workspace Organization Assessment and Proposed Plan rev2026-11-14 v1.docx" | — | 2026-11-14 |
| WSO-2 | Complete; all Watchdog material consolidated into the local Watchdog folder, stale worktrees moved to `_trash` (nothing deleted), Profiles database moved to the private `profiles\` folder with hash, integrity and counts unchanged, Git worktrees repaired. Verified by Claude | Move plan v2, manifest and logs in the local workspace, `documents\workspace\wso-2\` | Owner cleanup of `_trash` and the `.moved-2026-11-14` sources | 2026-11-14 |
| COORD-3 | Merged; Drive links replaced with repository copies of the Fable assessments, Drive retirement recorded, private paths generalized to `<private-root>` | [PR #100](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/100), `f7f4ed5` | — | 2026-11-14 |
| COORD-4 | Merged; AGENTS, START, project instructions and the standard coordinator handoff refreshed; local workspace layout recorded; `banner_assets` folder renamed `banners` | [PR #101](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/101), `e9041f8` | — | 2026-11-14 |
| DATA-1 | Partly complete; migration 003 applied to the local research database, with a pre-change copy, a post-change encrypted backup and a verified restore. The Routt code correction is prepared as a separate copy. Grouping label accepted by the importer (PR #105). Remaining: preview the other campaign-2 files and any import | PR #104, PR #105 | Owner decision on campaign-2 handling | 2026-11-14 |
| COORD-5 | Merged; roadmap adopted, launch goals recorded in decisions, development pause lifted | [PR #102](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/102), `8793352` | — | 2026-11-14 |
| Profiles Archon retired | Complete | Owner decision, 2026-11-14 | — | 2026-11-14 |
| VIS8-RESTORE-1 | Merged | PR #91, `db2903d1` | — | 2026-11-14 |
| BANNERS-3 | Merged | PR #92, `0c08faf8` | R2 provisioning (for real import) | 2026-11-14 |
| VIS13-SEARCH-1 | Merged | PR #90, `8b39dadc` | — | 2026-11-14 |
| VIS8-FIPS-1 | Merged | PR #89 | — | 2026-11-14 |
| AUTH-2 | Merged | PR #88 | — | 2026-11-14 |
| AUTH-3 | Assessment complete. Implementation blocked | [Identity assessment](../architecture/auth-3-identity-assessment.md) | Owner selects provider. Hosted trust and runtime behavior require verification before enablement. | 2026-11-14 |
| D1-0015-PREFLIGHT-1 | Complete, with access limitation | — | Hosted D1 admin access | 2026-11-14 |
| DEPLOY-1 safety assessment | Complete; deployment blocked pending supported migration gate, authenticated MCP bootstrap and hosted D1 provenance/recovery evidence | [PR #107](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/107) | Platform migration behavior; hosted D1 preflight through MCP | 2026-11-14 |
| DEPLOY-1A migration gate and MCP bootstrap | Assessment complete; Alpha-1 deployment blocked | [Evidence and next action](../architecture/deploy-1a-migration-gate.md) | Supported 0015 hold or migration-free binding; AUTH-3/AUTH-4 and an inspection-only grant; hosted provenance and restore evidence | 2026-11-14 |
| D1-0015-ACCESS-1 | Superseded by MCP-first architecture | — | — | 2026-11-14 |
| MCP-1 (read-only foundation) | Merged | PR #95, `bc60154f` | — | 2026-11-14 |
| MCP hosted publication / write tools | Planned, not started | — | Hosted Site MCP configuration (owner-scoped) | — |
| Profiles Import Pilot | Assessment complete; readiness/hosted-sync unresolved | — | Hosted D1 admin access, R7/R8 | 2026-11-14 |
| EDIT-1 | Merged, verified locally | [PR #110](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/110) | Hosted application of migration 0017 depends on DEPLOY-1; hosted editorial access depends on AUTH-3 and EDIT-2 | 2026-11-14 |
| BANNERS-4 (carousel) | Merged | [PR #109](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/109) | Real artwork awaits R2-1 and BANNERS-IMPORT-1 | 2026-11-14 |
| BANNERS-IMPORT-1 (real import) | Planned, not started | — | R2 provisioning | — |
| Website Profiles import (sync to D1) | Not executed | No changeset ever prepared; local sync tables empty | Migration 003, R7/R8, hosted sync | 2026-11-14 |

No task above is owned by more than one AI at once; check this table and the linked Issue/PR before starting overlapping work.

## G. Next tasks

Use the ordered backlog in [ROADMAP](ROADMAP.md). These need no hosted access
and can start now: BROWSE-1, the visual-audit follow-ups
and preparing the owner's drafts of "The Idlewild Story".
AUTH-3 implementation awaits the owner's provider selection.
DEPLOY-1 assessment is complete, but deployment is blocked pending a
supported migration gate, authenticated MCP bootstrap and hosted D1 preflight.
Hosted MCP writes, real data imports, migration 0015 and Alpha-1 redeployment
follow the roadmap's dependencies.

## Maintenance — when to update this file

Update this file when: an owner architectural decision changes (also update
[decisions.md](../decisions.md)); a milestone in section C changes status
(merged → deployed → hosted-verified, or similar); a blocker in section E is
resolved or a new one is confirmed; or ownership of overlapping work changes
(section F). The executor who makes the change includes the update in the
same PR when practical; otherwise the coordinating Archon updates it
afterward, or records in the relevant Issue that the update is pending. Do
not update this file for routine PRs, minor refactors, editorial wording, or
work already represented by a linked Issue. Prefer a short table-row edit and
a PR link over a long rewrite; never regenerate the whole file for a small
change, and never maintain a second, competing current-state document.

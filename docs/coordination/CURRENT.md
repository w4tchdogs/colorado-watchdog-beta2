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

- **AI-first administration**: one relational Website D1 database, R2 for files, and a shared dashboard/API/MCP service layer is the selected backbone — an approved requirement, not an optional add-on. A read-only MCP foundation is merged (PR #95). Alpha-1 v5 publishes the read-only endpoint. Hosted authenticated use and write, sync and import tools remain open (see component matrix).
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
| MCP administration | Merged, implemented locally: read-only Website inspection MCP (`d1.inspect` capability, aggregate counts only) and a Profiles readiness MCP (stdio, aggregate eligibility counts only). Read-only Website endpoint published in Alpha-1 v5; authenticated connection unverified. **No write, sync, import, or migration tool exists** | PR #95; [mcp-administration.md](../architecture/mcp-administration.md) |
| Hosted D1 migration (0015, Lake/La Plata correction) | Hosted result verified in Alpha-1 v5: all 64 county pairs match | `website/migrations/0015_correct_lake_la_plata_county_names.sql`; Section D |
| Hosted R2 provisioning | **Not done.** `r2: null` in `.openai/hosting.json` on `main` | `.openai/hosting.json` |
| Website Profiles import (sync to D1) | **Not executed**; no changeset has ever been prepared and local sync tables are empty | Verified read-only by Claude, 2026-11-14 |
| Local research intake | Complete for 79 batches across 64 counties | Verified read-only by Claude, 2026-11-14 |
| Real banner import | **Not executed** (BANNERS-IMPORT-1 is a separate future task). Source: the workspace `banners\approved\` folder (152 approved originals) | [banner-delivery.md](../architecture/banner-delivery.md) |
| Public Site deployment (Alpha-1) | **Deployed** as v5; public routes and D1 readiness smoke-tested | — |
| Visual audit | In progress; coverage ledger and several VIS fixes merged | PR #82–#92; `docs/coordination/visual-audit/` |

## D. Deployment state (separate from source)

Alpha-1 v5 deployed and verified on November 14, 2026 (America/Denver).

- Site: [Colorado Watchdog Alpha-1](https://colorado-watchdog-alpha1.futureguild2.chatgpt.site/), public, project `appgprj_6af7fb8f615c81918da0e4450ba336de`.
- Deployment: `appgdep_6af9439582688191b558e8f777591503`, Sites source `ddd5bc7fdc42440c33ad423d0ecc60b87d32c5b6`. It has the identical Git tree `bfb116cdbee415c437a1043d5928db62f9c331df` as [GitHub main `5a4f88d`](https://github.com/w4tchdogs/colorado-watchdog-beta2/commit/5a4f88d6b8b95b6cf452b67b42d579f28f62d8ea).
- Sites archive digest: `sha256:062a3c83f79001dcc5ff625ad6dad567675310f5cb626e77c54305a966305b19`. The archive packaged migrations 0001–0017 and retained the existing `DB` binding. R2 was not provisioned.

Before deploy, Sites showed the seeded registry and empty accounts, identities, people, organizations, reports, editorial content, banners and sync tables. The registry matched the accepted pre-0015 state with only Lake and La Plata swapped. The owner directed initialization to proceed. After deploy, the same Site's `DB` showed all 64 expected pairs, including `08065 Lake` and `08067 La Plata`, and the expected `owner_bootstrap_audit`, `banner_assets.homepage_order` and `content_publications` schema changes.

HTTP checks passed for the homepage, county directory, both corrected county pages, People, Organizations, Posts, Stories, report entry, CSS and Website D1 readiness. Anonymous requests to the account admin and staff report APIs returned HTTP 401. Sites confirms MCP publication. Authenticated MCP calls, exact platform/application migration-ledger reconciliation and hosted restore remain unverified. Version 4 in the prior assessments is historical. Future GitHub merges require a separate deployment.

## E. Current blockers / open dependencies

- **DEPLOY-1 and D1-0015** — Alpha-1 v5 is deployed and the hosted county registry is verified. The [owner's initialization decision](../decisions.md#alpha-1-website-d1-initialization-november-14-2026) supersedes the [DEPLOY-1A](../architecture/deploy-1a-migration-gate.md) migration hold for this initialization. Exact migration execution history and hosted restore remain unverified.
- **MCP connectivity and authorization** — the read-only endpoint is published. AUTH-3/AUTH-4, an inspection-only credential and authenticated connection verification remain open. Write, sync, import and R2 inspection tools are future work.
- **R2 provisioning** — needed before BANNERS-IMPORT-1 (real banner import) or any R2-backed MCP file storage.
- **Profiles research eligibility and hosted synchronization** — R7/R8 give the sync design; no real personnel data has been screened for hosted sync, and the Website-side sync route remains internal/unregistered ([d1-readiness.md](../architecture/d1-readiness.md)).
- **Verified Website administrator identity and recovery** — AUTH-3 provider selection and AUTH-4 owner bootstrap remain open. Exercise hosted backup and isolated restore before relying on D1 for real records.
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
| DEPLOY-1 | Alpha-1 v5 deployed; public routes and D1 readiness smoke-tested | Section D; [assessment PR #107](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/107) | Hosted recovery remains open | 2026-11-14 |
| DEPLOY-1A migration gate and MCP bootstrap | Historical assessment complete; owner initialization decision supersedes its deployment blocker | [Evidence](../architecture/deploy-1a-migration-gate.md) | Authenticated inspection and hosted recovery remain open | 2026-11-14 |
| D1-0015 | Hosted effect verified in Alpha-1 v5, including all 64 FIPS/name pairs | Section D | Exact execution-ledger reconciliation unverified | 2026-11-14 |
| D1-0015-ACCESS-1 | Superseded by MCP-first architecture | — | — | 2026-11-14 |
| MCP-1 (read-only foundation) | Merged | PR #95, `bc60154f` | — | 2026-11-14 |
| MCP-2 | Read-only endpoint published; authenticated connection and protected calls unverified | Section D | AUTH-3/AUTH-4, inspection-only credential and hosted transport verification | 2026-11-14 |
| Profiles Import Pilot | Assessment complete; readiness/hosted-sync unresolved | — | Hosted D1 admin access, R7/R8 | 2026-11-14 |
| EDIT-1 | Merged, verified locally | [PR #110](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/110) | Hosted publication schema and public routes smoke-tested; staff access and publication workflow await AUTH-3 and EDIT-2 | 2026-11-14 |
| BANNERS-4 (carousel) | Merged | [PR #109](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/109) | Real artwork awaits R2-1 and BANNERS-IMPORT-1 | 2026-11-14 |
| BANNERS-4B (full-width heroes, playback speech) | Merged; homepage and county carousel verified locally with NVDA and Chrome on synthetic fixtures. Awaiting deployment and hosted verification | [PR #120](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/120), `6e8c526` | Real artwork awaits R2-1 and BANNERS-IMPORT-1 | 2026-11-14 |
| BROWSE-1 | Merged, implemented locally. Statewide People and Organizations have bounded browse pages and retain name search. Hosted empty routes smoke-tested | [PR #111](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/111) | Hosted populated lists and pagination await eligible data | 2026-11-14 |
| BANNERS-IMPORT-1 (real import) | Planned, not started | — | R2 provisioning | — |
| Website Profiles import (sync to D1) | Not executed | No changeset ever prepared; local sync tables empty | Migration 003, R7/R8, hosted sync | 2026-11-14 |

No task above is owned by more than one AI at once; check this table and the linked Issue/PR before starting overlapping work.

## G. Next tasks

Use the ordered backlog in [ROADMAP](ROADMAP.md). These need no hosted access
and can start now: the visual-audit follow-ups and preparing the owner's
drafts of "The Idlewild Story".
AUTH-3 implementation awaits the owner's provider selection.
Alpha-1 v5 is deployed. Complete authenticated MCP verification, R2 provisioning
and hosted D1 recovery work as dependencies allow. Hosted MCP writes and real
data imports follow the roadmap.

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

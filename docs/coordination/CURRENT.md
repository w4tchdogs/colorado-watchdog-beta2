# Colorado Watchdog beta-2 — current state

Revision: November 15, 2026 (America/Denver). Source baseline: GitHub `main` at `9e7221d` ([PR #133](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/133)). Deployment and verification evidence are linked below. Read this after [START](START.md) and before track-specific documents.

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

- **AI-first administration**: one relational Website D1 database, R2 for files, and a shared dashboard/API/MCP service layer is the selected backbone — an approved requirement, not an optional add-on. A read-only MCP foundation is merged (PR #95). Alpha-1 publishes the read-only endpoint. Hosted authenticated use and write, sync and import tools remain open (see component matrix).
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
| Website D1 schema (migrations 0001–0019) | Merged, implemented locally (Wrangler local D1) | `website/migrations/`; [d1-readiness.md](../architecture/d1-readiness.md) |
| Accounts and security (ACCT-1, AUTH-1, AUTH-2) | Merged, implemented locally; fails closed without a verified Sites identity | PR #70, #81, #88; [account-management.md](../architecture/account-management.md) |
| Website human sign-in (AUTH-3-WEB) | Merged and verified locally with synthetic identities. Disabled by default. No Alpha-1 deployment or hosted Website verification | [PR #133](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/133) and [human-sign-in.md](../architecture/human-sign-in.md) |
| Profiles research foundation (R0) | Merged, implemented locally; repository tests use synthetic fixtures only. The live local research database contains real research data: 64 counties, 79 import batches, 20,797 role claims, 2,988 sources, 2,692 organizational units, 6,706 position targets and 3,256 research people. Research migrations 001–003 are applied (003 applied 2026-11-14 under DATA-1; its seven sync tables are empty). Verified by Claude, 2026-11-14 | [R0-foundation.md](../research/R0-foundation.md) |
| R7/R8 synchronization preparation | Merged, implemented locally; hosted sync still unresolved | PR #71, #73; [R7](../research/R7-profiles-website-integration.md), [R8](../research/R8-profiles-sync-operator.md) |
| M2 synchronization (planner/commit/reversal) | Merged; PR #66 (M2-G2) title itself notes "completion pending" — treat the async reversal path as implemented-locally, not fully closed out | PR #66; [m2-g0-transaction-guard.md](../architecture/m2-g0-transaction-guard.md) |
| Public directory, person/organization profiles (M4-D) | Merged, implemented locally | PR #80; [public-site.md](../architecture/public-site.md) |
| Posts and Stories | Merged, verified locally (EDIT-1); publish, withdraw and published-only public pages | [Content foundation](../architecture/content-foundation.md#publication-edit-1); [public site](../architecture/public-site.md#editorial-templates) |
| Banner inventory and lifecycle (BANNERS-1, BANNERS-2) | Merged, implemented locally | PR #64, #67; [banner-inventory.md](../architecture/banner-inventory.md), [banner-storage.md](../architecture/banner-storage.md) |
| Banner delivery (BANNERS-3) | Merged, implemented locally; read-only public integration only | PR #92; [banner-delivery.md](../architecture/banner-delivery.md) |
| Banner administration (BANNER-ADMIN-1/2) | Merged, verified locally with synthetic images. Publish and restore preserve publication metadata. Website migration 0018 is in source only. See section F for the protected API and dashboard status | [PR #131](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/131), [PR #132](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/132), [service notes](../architecture/banner-admin-service.md) |
| Banner carousel (BANNERS-4) | Merged, verified locally with synthetic fixtures | [PR #109](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/109); [banner-delivery.md](../architecture/banner-delivery.md#banners-4--accessible-banner-carousel) |
| MCP administration | Merged, implemented locally: read-only Website inspection MCP (`d1.inspect` capability, aggregate counts only) and a Profiles readiness MCP (stdio, aggregate eligibility counts only). Read-only Website endpoint published on Alpha-1; authenticated connection unverified. **No write, sync, import, or migration tool exists** | PR #95; [mcp-administration.md](../architecture/mcp-administration.md) |
| Hosted D1 migration (0015, Lake/La Plata correction) | Hosted result verified in Alpha-1 v5: all 64 county pairs match | `website/migrations/0015_correct_lake_la_plata_county_names.sql`; Section D |
| Hosted R2 provisioning | `BUCKET` declared and deployed. Runtime attachment, bucket identity and synthetic object round trip remain unverified | [PR #117](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/117), [Issue #122](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/122) |
| Website Profiles import (sync to D1) | **Not executed**; no changeset has ever been prepared and local sync tables are empty | Verified read-only by Claude, 2026-11-14 |
| Local research intake | Complete for 79 batches across 64 counties | Verified read-only by Claude, 2026-11-14 |
| Real banner import | **Not executed** (BANNERS-IMPORT-1 is a separate future task). Source: the workspace `banners\approved\` folder (152 approved originals) | [banner-delivery.md](../architecture/banner-delivery.md) |
| Public Site deployment (Alpha-1) | v10 Deployed. County search HTML, assets and live responses Hosted-verified. Website migrations 0018 and 0019 remain source-only | [v10 handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/143#issuecomment-6909085763) |
| Visual audit | In progress; coverage ledger and several VIS fixes merged | PR #82–#92; `docs/coordination/visual-audit/` |

## D. Deployment state (separate from source)

Alpha-1 v10 is the current successful deployment. The [v10 release handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/143#issuecomment-6909085763) records the deployed v9 baseline plus the VIS8-PARITY-2 county-search patch, the saved version and deployment IDs, public and protected response checks, and MCP publication. The [v9 handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/136#issuecomment-6907753431) records the live county-map appearance and editor framing header. The signed-in editor was verified on [v8](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/126#issuecomment-6903391997). The v10 archive carries the same Website migrations 0001–0017 as v9. Migrations 0018 and 0019 remain source-only. The [v5 initialization evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/107) and the D1-0015 record below establish historical D1 and county-registry verification. Hosted migration-ledger reconciliation and recovery remain open. The v8 source uses no browser `localStorage` for application records, and the v9 and v10 county patches add no browser storage. Storage access inside the Sites editor iframe was not tested.

The separate AUTH-3 contributor pilot is on v6, disabled, with the temporary linking setting absent. See [pilot v6 hosted evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/125#issuecomment-6906140793) for exact source, version and deployment, the disabled-session test and remaining cleanup. The pilot is not Alpha-1 and neither the pilot's database nor its contributor bootstrap belongs in the Website.

## E. Current blockers / open dependencies

- **DEPLOY-1 and D1-0015** — Alpha-1 v10 is deployed. The earlier hosted county registry check remains recorded below. The [initialization decision](../decisions.md#alpha-1-website-d1-initialization-november-14-2026) superseded the historical DEPLOY-1A migration hold for that initialization. Exact platform execution history and hosted recovery remain unverified.
- **MCP connectivity and authorization** — the read-only endpoint is published. AUTH-3/AUTH-4, an inspection-only credential and authenticated connection verification remain open. Write, sync, import and R2 inspection tools are future work.
- **R2 attachment and object verification** — [Issue #122](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/122) remains open. The visible Cloudflare account did not reach the Site's backing account. Sites exposes no live bucket inventory or private invocation here. Draft [PR #123](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/123) stays undeployed. A throwaway bucket test cannot identify Alpha-1's binding.
- **Profiles research eligibility and hosted synchronization** — R7/R8 give the sync design; no real personnel data has been screened for hosted sync, and the Website-side sync route remains internal/unregistered ([d1-readiness.md](../architecture/d1-readiness.md)). On 2026-11-15 the real database had an empty `sources.page_type` on every source, which blocked all sync eligibility. The `preview-source-types`, `apply-source-types` and `verify-source-types` commands (rule `url-extension/v1`, documented in [source-page-types.md](../research/source-page-types.md)) set it for the 1,607 official sources and the statewide preview now yields 66 eligible organizations and no eligible role claims. Role claims remain blocked by unresolved identity, unselected batches and unclassified parent units (SYNC-1 Issue 141).
- **Verified Website administrator identity and recovery** — AUTH-3-WEB is merged and off by default. Hosted enablement awaits decisions on the Auth0 tenant and operator, canonical Website origin, recovery operator, and the proposed 5-minute login transaction, 30-minute idle session and 8-hour absolute session bounds in [PR #133](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/133), plus normal migration deployment through 0019 and separate hosted verification. AUTH-4 also needs a supported private D1 write channel that identifies the intended physical database before a write, and a verified backup and isolated restore. Sites database tooling is read-only. Local restore coverage is in [PR #130](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/130).
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
| VIS8-PARITY-2 | Merged in #143 and deployed on Alpha-1 v10. Live search responses, map and row agreement, labels, unavailable counts and assets Hosted-verified. Interactive browser behavior verified locally at three widths | [PR #143](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/143), [v10 handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/143#issuecomment-6909085763) | STATS-1 for real counts | 2026-11-15 |
| VIS8-PARITY-1 | Merged in #139. Alpha-1 v9 Deployed. Live map appearance, copy, 64 links, and name/FIPS filtering Hosted-verified. Three-width and keyboard/touch comparisons verified locally | [PR #139](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/139), [v9 handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/136#issuecomment-6907753431) | v8 baseline plus county-page patch. Migrations 0018 and 0019 remain source-only | 2026-11-15 |
| VIS8-RESTORE-1 | Merged | PR #91, `db2903d1` | — | 2026-11-14 |
| BANNERS-3 | Merged | PR #92, `0c08faf8` | R2 provisioning (for real import) | 2026-11-14 |
| VIS13-SEARCH-1 | Merged | PR #90, `8b39dadc` | — | 2026-11-14 |
| VIS8-FIPS-1 | Merged | PR #89 | — | 2026-11-14 |
| AUTH-2 | Merged | PR #88 | — | 2026-11-14 |
| AUTH-3 pilot | Hosted-verified for linked sign-in, repeat sign-in, sign-out and denial of a still-valid session while disabled. v6 disabled | [pilot v6 hosted evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/125#issuecomment-6906140793); draft [PR #125](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/125) | Separate unlinked account pending. Hosted identity revocation blocked on a private D1 write | 2026-11-15 |
| AUTH-3-WEB | Merged as `9e7221d`; local checks passed. Disabled by default. Hosted verification open | [PR #133](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/133), [CI](https://github.com/w4tchdogs/colorado-watchdog-beta2/actions/runs/43800527305) | Owner configuration decisions and normal hosted migration through 0019 before enablement | 2026-11-15 |
| AUTH-4 | Readiness assessment complete (reported); implementation and hosted execution not started | [Account architecture](../architecture/account-management.md) | Trusted physical D1 targeting, backup and isolated restore, and a first-owner correction procedure. Keep bootstrap outside the sign-in callback | 2026-11-15 |
| D1-0015-PREFLIGHT-1 | Complete, with access limitation | — | Hosted D1 admin access | 2026-11-14 |
| DEPLOY-1 | Alpha-1 v10 Deployed. County-search responses Hosted-verified. Signed-in editor framing verified on v8 | Section D; [v10 handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/143#issuecomment-6909085763) | Hosted recovery remains open | 2026-11-15 |
| DEPLOY-1A migration gate and MCP bootstrap | Historical assessment complete; owner initialization decision supersedes its deployment blocker | [Evidence](../architecture/deploy-1a-migration-gate.md) | Authenticated inspection and hosted recovery remain open | 2026-11-14 |
| D1-0015 | Hosted effect verified in Alpha-1 v5, including all 64 FIPS/name pairs | Section D | Exact execution-ledger reconciliation unverified | 2026-11-14 |
| D1-0015-ACCESS-1 | Superseded by MCP-first architecture | — | — | 2026-11-14 |
| MCP-1 (read-only foundation) | Merged | PR #95, `bc60154f` | — | 2026-11-14 |
| MCP-2 | Read-only endpoint published; authenticated connection and protected calls unverified | Section D | AUTH-3/AUTH-4, inspection-only credential and hosted transport verification | 2026-11-14 |
| Profiles Import Pilot | Assessment complete; readiness/hosted-sync unresolved | — | Hosted D1 admin access, R7/R8 | 2026-11-14 |
| EDIT-1 | Merged, verified locally | [PR #110](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/110) | Hosted publication schema and public routes smoke-tested; staff access and publication workflow await AUTH-3 and EDIT-2 | 2026-11-14 |
| BANNERS-4 (carousel) | Merged | [PR #109](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/109) | Real artwork awaits R2-1 and BANNERS-IMPORT-1 | 2026-11-14 |
| BANNERS-4B (full-width heroes, playback speech) | Merged and included in Alpha-1 v8 source. Homepage and county carousel verified locally with NVDA and Chrome on synthetic fixtures. Hosted carousel behavior unverified | [PR #120](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/120), `6e8c526`; [v8 source handoff](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/126#issuecomment-6897322873) | Real artwork awaits R2-1 and BANNERS-IMPORT-1 | 2026-11-15 |
| BROWSE-1 | Merged, implemented locally. Statewide People and Organizations have bounded browse pages and retain name search. Hosted empty routes smoke-tested | [PR #111](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/111) | Hosted populated lists and pagination await eligible data | 2026-11-14 |
| R2-1 / R2-1A | Declaration merged and deployed; independent binding and round trip Blocked | [PR #117](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/117), [Issue #122](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/122) | Sites or provider access for the actual deployed Worker and bucket | 2026-11-15 |
| BANNERS-IMPORT-1 (real import) | Planned, not started | — | R2 provisioning | — |
| Website Profiles import (sync to D1) | Not executed | No changeset ever prepared; local sync tables empty | Migration 003, R7/R8, hosted sync | 2026-11-14 |
| VIS-11 / VIS-12 | Merged; local visual audit and organization subunit links | [PR #128](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/128) | Direct D1 regression coverage is a follow-up; hosted checks remain separate | 2026-11-15 |
| VIS-15 | Merged; local information-page audit | [PR #129](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/129) | Policy and Help/CORA scope remain owner choices | 2026-11-15 |
| DEPLOY-1A local restore rehearsal | Merged; synthetic local SQLite coverage | [PR #130](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/130) | Hosted D1 export, isolated restore and operator access remain open | 2026-11-15 |
| BANNER-ADMIN-0 | PR open (draft design); implementation status is tracked separately | [PR #127](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/127) | Design reflects an earlier baseline | 2026-11-15 |
| BANNER-ADMIN-1 / BANNER-ADMIN-2 | Merged; service, staging and publication history verified locally | [PR #131](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/131), [PR #132](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/132) | 0018 is in source only. Hosted upload limits and progressive JPEG coverage are open | 2026-11-15 |
| BANNER-ADMIN-3 | Merged as `7089d0e8`. Protected `/api/admin/banners/*` and private version previews verified locally with synthetic images in D1, the bundled Worker and local R2. Awaiting deployment and hosted verification | [PR #137](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137), [API contract](../architecture/banner-admin-api.md) | Hosted human use needs Website migration 0018, AUTH-3-WEB enablement, AUTH-4 and verified `BUCKET` attachment | 2026-11-15 |
| SUB-3 implementation | In progress (executor-reported). Claude Code; Sonnet Medium recommended | [PR #118](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/118) is the merged assessment. No implementation PR verified | Finish reported D1 checks, use next free Website migration number after 0018 and 0019, and keep hosted intake disabled | 2026-11-15 |
| Dashboard foundation (EDIT-2 local slice) | Prepared; owner will tell the coordinator when Fable starts. Fable Medium if available | [Editorial sandbox](../architecture/editorial-workspace.md), [Banner API contract](../architecture/banner-admin-api.md) for the BANNER-ADMIN-4 follow-up | Use a capability-based shell, Overview, My Account and a working Posts & Stories preview with Lorem Ipsum. Reserve the Banners slot for BANNER-ADMIN-4 | 2026-11-15 |
| CONTENT-1 | Planned; paused by owner | [Roadmap](ROADMAP.md) | No real editorial content during dashboard development | 2026-11-15 |

No task above is owned by more than one AI at once; check this table and the linked Issue/PR before starting overlapping work.

## G. Next tasks

Prioritize the local dashboard foundation and finish SUB-3. BANNER-ADMIN-3 is merged. BANNER-ADMIN-4 can use the merged API contract after the dashboard shell is available. Hosted banner administration has separate dependencies. CONTENT-1 stays paused. Start Fable when the owner reports initiating the prepared assignment. AUTH-3-WEB is merged; hosted enablement and AUTH-4 remain separate. Follow [ROADMAP](ROADMAP.md) for dependencies.

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

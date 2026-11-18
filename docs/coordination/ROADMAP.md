# Colorado Watchdog Beta-2 roadmap to launch

This file holds the owner's launch goals for Beta-2, what each one requires,
and the ordered work that gets there. [CURRENT](CURRENT.md) remains the only
place for present status and active assignments. This roadmap says where the
project is going. CURRENT says where it is now. Status words use CURRENT's
vocabulary.

Revision: November 17, 2026. Based on `main` at `8764b522e225549de1431cb5a4558a01f8f2012b` (PR #204). The
owner approved these goals and lifted the development pause with this
roadmap. The goals are recorded as an owner decision in
[decisions.md](../decisions.md).

**Launch** means Beta-2 replaces Beta-1 as the public Colorado Watchdog site.
All six goals below must be met first.

## Launch goals (owner, November 14, 2026)

### Goal 1. AI administration through MCP

MCP connections for Profiles, banners, Posts and Stories, and every other
database-backed function, plus an AI operating system that knows how to
update and edit each of them.

- **Done when:** an authorized AI agent, connected to the hosted Site's MCP
  endpoint, can inspect and change Profiles, banners and editorial content
  through audited, capability-limited tools. Each domain has a written
  operator guide that any AI can follow.
- **Today:** see [CURRENT](CURRENT.md) for hosted inspection, banner and Profiles tools and client-specific evidence.
- **Remaining:** the first real Profiles pilot, bulk banner import, editorial write tools, and AI operator guides (MCP-4). The [Windows Profiles bridge](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/204) has passed synthetic hosted acceptance. See CURRENT for native client status.

### Goal 2. A populated hosted database

Profiles and banners for every county in the online database, with counts
that show the state of profiles, departments and grievances.

- **Done when:** all 64 counties have screened, synchronized Profiles and an
  approved banner in hosted D1 and R2, and public pages show per-county
  counts for profiles, departments and grievances. Grievance counts include
  reviewed submissions only. A human operator can edit and synchronize Profiles
  through the [human Profiles workflow](../decisions.md#human-operation-of-profiles-november-17-2026).
- **Today:** the local research database covers 64 counties (3,256 research
  people, 2,692 organizational units). Real Profiles and bulk banner imports
  remain pending. The [one-banner Adams pilot](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137#issuecomment-6944557184) passed on Cloudflare staging and the banner was withdrawn afterward. 152 approved banner originals are in the local `banners\approved\`
  folder. Cloudflare staging passed the R2 storage round trip and the
  [protected banner API exercise with one synthetic PNG](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137#issuecomment-6933294436). The separate
  [Sites R2 attachment and object inventory](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/122)
  remains open. Public pages show no counts.
- **Remaining:** finish the campaign-2 validation and resolve the intake
  decision in DATA-1. Research migration 003 and the post-003 restore test
  are complete. Screen and run the first hosted sync (SYNC-1), then sync all
  counties (SYNC-2), resolve display ordering and import approved banners
  (BANNERS-IMPORT-1), and add public county counts (STATS-1).

### Goal 3. Universal sign-in and sign-up for admins and editors

- **Done when:** owners, administrators and editors can sign up or be
  invited, sign in on the hosted Site and reach the pages and tools their
  role allows.
- **Today:** the account model and AUTH-3-WEB are merged. Cloudflare staging's first owner, GitHub sign-in, dashboard, refresh and sign-out are hosted-verified. The original Sites deployment remains disabled. See the [hosted staging sign-in evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/174#issuecomment-6932672296).
- **Remaining:** a separate hosted unlinked-account check and invitation or sign-up for editors and administrators
  (AUTH-5).

### Goal 4. Guest grievance submission

- **Done when:** a guest can submit a grievance on the hosted Site, receive
  a reference and recovery key, and track it, while staff review it in the
  private queue. As in Beta-1, a reporter can choose to submit under an
  anonymous name.
- **Today:** submission, tracking and the staff review workspace are merged
  (SUB-1 to SUB-2D). The Turnstile integration (SUB-3) is merged, and its
  migration is applied on Cloudflare staging. Hosted guest intake is disabled.
- **Remaining:** test Turnstile and the guest flow with provider keys, then
  the owner decides whether to enable intake. Verify staff review with the
  account access in Goal 3.

### Goal 5. Blog workspace and the first posts of "The Idlewild Story"

- **Done when:** editors can draft, revise and publish Posts and Stories on
  the hosted Site, and at least the first three installments of "The
  Idlewild Story" are published.
- **Today:** the content model, revision history, search, local editorial workspace, publication endpoint and public article rendering are merged. The EDIT-2 capability-based dashboard shell (Overview, My Account, and Posts & Stories) is merged and verified locally with Lorem Ipsum fixtures ([PR #144](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/144)), and the Banners module (BANNER-ADMIN-4) is merged and verified locally with synthetic images. The Posts & Stories editor is included in the operator-reported Cloudflare staging rollout. Signed-in editing and AI checkpoint restore still need hosted verification. See [CURRENT](CURRENT.md#d-deployment-state-separate-from-source).
- **Remaining:** hosted EDIT-2 still depends on Website identity and account access (AUTH-5) and EDIT-1. CONTENT-1 remains paused; the existing real drafts and the launch requirement to publish at least three Idlewild Story installments remain on the backlog.

### Goal 6. Beta-1 look, search and browse

- **Done when:** Beta-2 matches Beta-1's style and its search and browse
  functionality, apart from intentional Beta-2 differences, verified at
  desktop, tablet and mobile sizes.
- **Today:** the county map, directory, editorial search and several visual
  fixes are merged. The visual audit's follow-ups VIS-7 to VIS-19 remain.
  Browse-all is merged in BROWSE-1; hosted populated behavior is still open.
- **Remaining:** the remaining VIS follow-ups, hosted verification of the merged browse-all and banner carousel work, and the final deployed visual parity check (VIS-20).

## Shared foundations

Several goals depend on the same hosted groundwork. These come first.

| ID | Work | Unblocks | Status |
| --- | --- | --- | --- |
| DEPLOY-1 | Maintain existing Sites Alpha-1 during the Cloudflare transition | Every hosted goal | See [CURRENT](CURRENT.md#d-deployment-state-separate-from-source). Owner deferred the public cutover. |
| D1-0015 | Apply and verify the Lake and La Plata correction during Alpha-1 initialization | Goal 2 | Hosted registry verified in v5 |
| AUTH-3 | Verified hosted human identity for sign-in | Goals 3, 4 (staff), 5 | Pilot hosted checks recorded on #125. Cloudflare staging owner sign-in hosted-verified in #174 |
| MCP-2 | Publish read-only MCP and verify authenticated inspection | Goal 1, hosted D1 administration | Authenticated inspection verified on Cloudflare staging. See [CURRENT](CURRENT.md) for client-specific limits. |
| R2-1 | Verify storage at the active deployment target | BANNERS-IMPORT-1 | Cloudflare staging storage round trip and protected banner API Hosted-verified with one synthetic PNG. [R2-1 staging receipt](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137#issuecomment-6933294436). Sites R2 inventory remains open. |

## Ordered backlog

Within each phase, items can run in parallel unless a dependency is listed.
Work that needs no hosted access can start as soon as the development pause
is lifted.

### Phase 1. Hosted foundations

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 1 | DEPLOY-1 | Keep Sites Alpha-1 live during Cloudflare staging and cutover | [Hosting decision](../decisions.md#cloudflare-hosting-transition-and-first-owner-target-november-16-2026) | All |
| 2 | MCP-2 | Hosted read-only MCP publication and authenticated inspection | DEPLOY-1; AUTH-3/AUTH-4 and inspection-only credential for protected calls | 1 |
| 3 | D1-0015 | Verify the complete hosted county registry after migration 0015 | DEPLOY-1 initialization | 2 |
| 4 | AUTH-3 | Choose and implement a verified hosted identity method at $0 cost | Owner decision | 3 |
| 5 | AUTH-4 | Cloudflare staging first owner created and verified | [PR #174 hosted evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/174#issuecomment-6932672296) | 3 |
| 6 | R2-1 | Verify app-level R2 behavior on Cloudflare staging | DEPLOY-1 | 2 |

### Phase 2. AI administration

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 7 | MCP-3 | Audited MCP write tools: banners, content, Profiles sync | MCP-2 | 1 |
| 8 | MCP-4 | Operator guides for each domain, tested by an AI that has not seen the code | MCP-3 | 1 |
| 9 | AUTH-5 | Editor and administrator invitation or sign-up | AUTH-4 | 3 |

### Phase 3. Data

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 10 | DATA-1 | Research migration 003, the campaign-2 Routt code fix, and a restore test of one backup | None (local) | 2 |
| 11 | SYNC-1 | Screen one county and run the first hosted sync | DATA-1, MCP-3 | 2 |
| 12 | SYNC-2 | Sync the remaining counties | SYNC-1 | 2 |
| 13 | BANNERS-IMPORT-1 | Import approved banners to R2 and D1 after resolving display ordering | One-banner staging pilot passed. R2-1, MCP-3 | 2 |
| 14 | STATS-1 | Public per-county counts for profiles, departments and reviewed grievances | SYNC-1 | 2 |

### Phase 4. Public features

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 15 | SUB-3 | $0 abuse-control provider and hosted guest intake | DEPLOY-1 | 4 |
| 16 | EDIT-1 | Publication endpoint and public article pages | None (local) | 5 |
| 17 | EDIT-2 | Capability-based dashboard and editorial workspace | Local foundation merged and verified locally ([PR #144](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/144)); hosted editorial use requires AUTH-5 and EDIT-1 | 5 |
| 18 | BANNERS-4 | Accessible banner carousel | None (local) | 6 |
| 19 | BROWSE-1 | Browse all people and organizations without a search term | None (local) | 6 |
| 20 | VIS-7 to VIS-19 | Visual audit follow-ups | None (local) | 6 |

### Phase 5. Content and launch

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 21 | CONTENT-1 | Bring in the owner's drafts of "The Idlewild Story", then publish at least three installments | Paused by owner; hosted EDIT-2 before publication | 5 |
| 22 | VIS-20 | Visual parity check on the deployed Site | Phase 4 | 6 |
| 23 | LAUNCH-1 | Launch readiness check against all six goals, then the switch from Beta-1 | All | All |

**Can proceed locally:** prepare the Adams pilot, inventory approved banners and continue scoped visual-audit follow-ups. Check CURRENT for the staging sign-in evidence and hosted import dependencies.

## Owner decisions

Settled on November 14, 2026:

- Public grievance counts include reviewed submissions only. Reporters can
  choose an anonymous name, as in Beta-1.
- "A few" Idlewild Story installments means at least three. The owner's
  existing drafts, about 15, are the source.
- The development pause is lifted with this roadmap.

Settled on November 16, 2026:

- Cloudflare is the staging priority. The separate Sites owner login assignment was withdrawn and public cutover preparation was deferred. See [decisions](../decisions.md#hosting-and-mcp-operator-priorities-november-16-2026).
- The public report attribution choices and revision rules are recorded in [decisions](../decisions.md#public-report-attribution-november-16-2026).

Still open:

1. **Public hosting.** Choose the public Cloudflare hostname and cutover
   timing. Determine the disposition of any existing Sites R2 objects before
   retiring Sites. The [hosting decision](../decisions.md#cloudflare-hosting-transition-and-first-owner-target-november-16-2026)
   already selects the existing AUTH-3 application and GitHub connection for
   staging.
2. **Report expansion.** The employee picker, event context and grievance cards are the merged baseline in [PR #228](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/228). Draft workspace, private attachments, revision and withdrawal, editorial release and approved attribution still need their own work. See [CURRENT](CURRENT.md) for hosted status.

## Maintenance

The 💠archon updates this file when a goal, phase, order or dependency
changes, or when an item finishes. Day-to-day status stays in CURRENT. Keep
task IDs identical in both files.

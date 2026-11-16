# Colorado Watchdog Beta-2 roadmap to launch

This file holds the owner's launch goals for Beta-2, what each one requires,
and the ordered work that gets there. [CURRENT](CURRENT.md) remains the only
place for present status and active assignments. This roadmap says where the
project is going. CURRENT says where it is now. Status words use CURRENT's
vocabulary.

Revision: November 16, 2026. Based on `main` at `ff9d888` (PR #147). The
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
- **Today:** a read-only Website inspection MCP and a local Profiles
  readiness MCP are merged (PR #95). Alpha-1 publishes the read-only
  Website endpoint. Authenticated inspection and write tools remain open.
- **Remaining:** authenticated hosted MCP verification (MCP-2), write tools for each domain
  (MCP-3), and AI operator guides (MCP-4).

### Goal 2. A populated hosted database

Profiles and banners for every county in the online database, with counts
that show the state of profiles, departments and grievances.

- **Done when:** all 64 counties have screened, synchronized Profiles and an
  approved banner in hosted D1 and R2, and public pages show per-county
  counts for profiles, departments and grievances. Grievance counts include
  reviewed submissions only.
- **Today:** the local research database covers 64 counties (3,256 research
  people, 2,692 organizational units). Nothing has been imported to hosted
  D1. 152 approved banner originals are in the local `banners\approved\`
  folder. R2 is declared in the deployed manifest; runtime attachment and the object round trip remain open (Issue #122). Public pages show no counts.
- **Remaining:** finish the campaign-2 validation and resolve the intake
  decision in DATA-1. Research migration 003 and the post-003 restore test
  are complete. Screen and run the first hosted sync (SYNC-1), then sync all
  counties (SYNC-2), verify R2 (R2-1), import banners (BANNERS-IMPORT-1) and
  add public county counts (STATS-1).

### Goal 3. Universal sign-in and sign-up for admins and editors

- **Done when:** owners, administrators and editors can sign up or be
  invited, sign in on the hosted Site and reach the pages and tools their
  role allows.
- **Today:** the account model and default-off AUTH-3-WEB source are merged. The separate Auth0/GitHub pilot verified linked browser sign-in, sign-out and disabled-session denial. Alpha-1 sign-in has not been deployed or verified. First-owner and invitation work remain separate.
- **Remaining:** a verified hosted identity method (AUTH-3), owner bootstrap
  (AUTH-4), and invitation or sign-up for editors and administrators
  (AUTH-5).

### Goal 4. Guest grievance submission

- **Done when:** a guest can submit a grievance on the hosted Site, receive
  a reference and recovery key, and track it, while staff review it in the
  private queue. As in Beta-1, a reporter can choose to submit under an
  anonymous name.
- **Today:** submission, tracking and the staff review workspace are merged
  (SUB-1 to SUB-2D). Hosted guest intake is disabled until a
  production-ready abuse-control provider exists. Staff review needs
  Goal 3's sign-in.
- **Remaining:** a $0 abuse-control provider for anonymous intake (SUB-3),
  then hosted verification. Staff review depends on AUTH-3.

### Goal 5. Blog workspace and the first posts of "The Idlewild Story"

- **Done when:** editors can draft, revise and publish Posts and Stories on
  the hosted Site, and at least the first three installments of "The
  Idlewild Story" are published.
- **Today:** the content model, revision history, search, local editorial workspace, publication endpoint and public article rendering are merged. The EDIT-2 capability-based dashboard shell (Overview, My Account, and Posts & Stories) is merged and verified locally with Lorem Ipsum fixtures ([PR #144](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/144)). Hosted editorial sign-in remains open.
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
| DEPLOY-1 | Initialize the existing Alpha-1 Website D1 and publish the accepted source | Every hosted goal | Deployed as v8; see CURRENT |
| D1-0015 | Apply and verify the Lake and La Plata correction during Alpha-1 initialization | Goal 2 | Hosted registry verified in v5 |
| AUTH-3 | Verified hosted human identity for sign-in | Goals 3, 4 (staff), 5 | Pilot hosted checks recorded on #125. Website source merged default-off in #133; hosted Website verification open |
| MCP-2 | Publish read-only MCP and verify authenticated inspection | Goal 1, hosted D1 administration | Endpoint published; authenticated verification open |
| R2-1 | Provision the R2 binding on the existing Site | BANNERS-IMPORT-1 | Declaration deployed; runtime binding and object verification blocked (Issue #122) |

## Ordered backlog

Within each phase, items can run in parallel unless a dependency is listed.
Work that needs no hosted access can start as soon as the development pause
is lifted.

### Phase 1. Hosted foundations

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 1 | DEPLOY-1 | Initialize existing Alpha-1 D1 with pending migrations and deploy the accepted source | Verified unused application database; owner decision | All |
| 2 | MCP-2 | Hosted read-only MCP publication and authenticated inspection | DEPLOY-1; AUTH-3/AUTH-4 and inspection-only credential for protected calls | 1 |
| 3 | D1-0015 | Verify the complete hosted county registry after migration 0015 | DEPLOY-1 initialization | 2 |
| 4 | AUTH-3 | Choose and implement a verified hosted identity method at $0 cost | Owner decision | 3 |
| 5 | AUTH-4 | Create the first owner account | AUTH-3 | 3 |
| 6 | R2-1 | Provision R2 on the existing Site | DEPLOY-1 | 2 |

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
| 13 | BANNERS-IMPORT-1 | Import the approved banners to R2 and D1 | R2-1, MCP-3 | 2 |
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

**Can proceed locally:** protected banner API work, SUB-3 and scoped visual-audit follow-ups. The EDIT-2 dashboard foundation is merged and verified locally ([PR #144](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/144)). See CURRENT before assigning work.

## Owner decisions

Settled on November 14, 2026:

- Public grievance counts include reviewed submissions only. Reporters can
  choose an anonymous name, as in Beta-1.
- "A few" Idlewild Story installments means at least three. The owner's
  existing drafts, about 15, are the source.
- The development pause is lifted with this roadmap.

Still open:

1. **Hosted Website sign-in.** Decide the Auth0 tenant and operator, canonical Website origin, and trusted recovery operator. Auth0/GitHub is the implemented default-off Website integration; its hosted verification is separate from the isolated pilot.

## Maintenance

The 💠archon updates this file when a goal, phase, order or dependency
changes, or when an item finishes. Day-to-day status stays in CURRENT. Keep
task IDs identical in both files.

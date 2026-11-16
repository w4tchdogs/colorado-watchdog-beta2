# Colorado Watchdog Beta-2 roadmap to launch

This file holds the owner's launch goals for Beta-2, what each one requires,
and the ordered work that gets there. [CURRENT](CURRENT.md) remains the only
place for present status and active assignments. This roadmap says where the
project is going. CURRENT says where it is now. Status words use CURRENT's
vocabulary.

Revision: November 14, 2026. Based on `main` at `e9041f8` (PR #101). The
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
  readiness MCP are merged (PR #95). Alpha-1 v5 publishes the read-only
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
  folder. R2 is not provisioned. Public pages show no counts.
- **Remaining:** research migration 003 and data corrections (DATA-1),
  eligibility screening and the first hosted sync (SYNC-1), then all
  counties (SYNC-2), R2 provisioning (R2-1), the banner import
  (BANNERS-IMPORT-1) and public county counts (STATS-1).

### Goal 3. Universal sign-in and sign-up for admins and editors

- **Done when:** owners, administrators and editors can sign up or be
  invited, sign in on the hosted Site and reach the pages and tools their
  role allows.
- **Today:** the account model, roles and capability checks are merged. All
  human sign-in on the hosted Site fails closed because Sites exposes no
  verified identity to the Worker (AUTH-2). The first owner account has never
  been created.
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
- **Today:** the content model, revision history, search and a local
  editorial workspace are merged. There is no hosted editorial sign-in, no
  publication endpoint and no public rendering of published content.
- **Remaining:** a publication endpoint and public article pages (EDIT-1),
  the hosted editorial workspace (EDIT-2, after AUTH-3), and the series
  itself (CONTENT-1). The owner has about 15 installments already drafted
  in another AI account. They were never part of Beta-1. The owner supplies
  them and approves every installment before publication.

### Goal 6. Beta-1 look, search and browse

- **Done when:** Beta-2 matches Beta-1's style and its search and browse
  functionality, apart from intentional Beta-2 differences, verified at
  desktop, tablet and mobile sizes.
- **Today:** the county map, directory, editorial search and several visual
  fixes are merged. The visual audit's follow-ups VIS-7 to VIS-19 remain.
  Browsing all people or organizations without a search term is not
  implemented.
- **Remaining:** the VIS follow-ups, browse-all (BROWSE-1), the banner
  carousel (BANNERS-4), and a final visual parity check on the deployed
  Site (VIS-20).

## Shared foundations

Several goals depend on the same hosted groundwork. These come first.

| ID | Work | Unblocks | Status |
| --- | --- | --- | --- |
| DEPLOY-1 | Initialize the existing Alpha-1 Website D1 and publish the accepted source | Every hosted goal | Deployed as v5; see CURRENT |
| D1-0015 | Apply and verify the Lake and La Plata correction during Alpha-1 initialization | Goal 2 | Hosted registry verified in v5 |
| AUTH-3 | Verified hosted human identity for sign-in | Goals 3, 4 (staff), 5 | Website source in review, disabled by default. Hosted verification open |
| MCP-2 | Publish read-only MCP and verify authenticated inspection | Goal 1, hosted D1 administration | Endpoint published; authenticated verification open |
| R2-1 | Provision the R2 binding on the existing Site | BANNERS-IMPORT-1 | Planned |

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
| 17 | EDIT-2 | Hosted editorial workspace | AUTH-5, EDIT-1 | 5 |
| 18 | BANNERS-4 | Accessible banner carousel | None (local) | 6 |
| 19 | BROWSE-1 | Browse all people and organizations without a search term | None (local) | 6 |
| 20 | VIS-7 to VIS-19 | Visual audit follow-ups | None (local) | 6 |

### Phase 5. Content and launch

| Order | ID | Work | Depends on | Goal |
| --- | --- | --- | --- | --- |
| 21 | CONTENT-1 | Bring in the owner's drafts of "The Idlewild Story", then publish at least three installments | EDIT-2 (preparing the drafts can start now) | 5 |
| 22 | VIS-20 | Visual parity check on the deployed Site | Phase 4 | 6 |
| 23 | LAUNCH-1 | Launch readiness check against all six goals, then the switch from Beta-1 | All | All |

**Can start now, with no hosted dependency:** DATA-1, EDIT-1, BANNERS-4,
BROWSE-1, the VIS follow-ups, the DEPLOY-1 assessment, the AUTH-3
assessment and preparing the Idlewild Story drafts.

## Owner decisions

Settled on November 14, 2026:

- Public grievance counts include reviewed submissions only. Reporters can
  choose an anonymous name, as in Beta-1.
- "A few" Idlewild Story installments means at least three. The owner's
  existing drafts, about 15, are the source.
- The development pause is lifted with this roadmap.

Still open:

1. **Sign-in method (AUTH-3).** Sites does not provide a verified identity.
   The likely route is a free sign-in provider, such as Sign in with Google.
   AUTH-3 starts by assessing which free provider works on Sites, and the
   owner then chooses. This is the largest open risk to Goals 3, 4 and 5.

## Maintenance

The 💠archon updates this file when a goal, phase, order or dependency
changes, or when an item finishes. Day-to-day status stays in CURRENT. Keep
task IDs identical in both files.

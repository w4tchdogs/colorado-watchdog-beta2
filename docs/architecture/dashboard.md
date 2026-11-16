# Dashboard foundation (EDIT-2 local slice)

One WordPress-style dashboard for signed-in human accounts. This slice delivers the shared shell and three working views: Overview, My Account and Posts & Stories. It runs only in the disposable local sandbox. Nothing here is deployed, and no hosted Worker route, Auth0 setting, D1, R2 or Profiles data is touched.

## Start the preview

Requirements: Node.js 22 and `npm install` run once in the checkout.

1. Run `npm run editor:dev`.
2. Open `http://127.0.0.1:8788/`.
3. Stop with `Ctrl+C`. Every change is discarded on exit.

The same command also starts the read-only fictional public site preview at `http://127.0.0.1:8790/`, which is where “View public site” goes. Set `EDITOR_PORT` or `SITE_PORT` to change either port. If the site port is already in use, the dashboard still starts and the link points at whatever preview holds that port.

## What the shell provides

- A compact sidebar grouped as Your workspace, Editorial and Administration. Only working destinations the signed-in account may open are listed. The open page is marked with `aria-current="page"`.
- A masthead with the Colorado Watchdog name, the current page, and an account menu with the account name, role, My Account and the public site link.
- A “Menu” button below 800 pixels wide that opens and closes the sidebar. Escape closes the sidebar or the account menu and returns focus to its button.
- A skip link, one `h1` per page, labelled controls, a polite live region, and focus moved to the page when a view opens.
- A yellow sandbox strip with the “Acting as” switch. The strip exists only when the host passes the `sandbox` option, which only the local sandbox does.

Pages use hash addresses: `#/overview`, `#/account`, `#/posts`, `#/posts/item/<id>` and `#/posts/new/post` or `/story`.

## How access is decided

The server decides everything. The browser renders what it is given and never treats a response or its own state as permission.

1. The host resolves a trusted principal for each request with the existing `resolvePrincipal`. In the sandbox the principal comes from the synthetic test identity adapter.
2. `src/services/dashboard.ts` checks on every call that the principal is a current, active human account, then applies the existing role matrix in `src/services/security.ts` through `hasCapability`. No role or capability was added or changed.
3. `GET /internal/dashboard/session` returns the caller’s own safe account fields and the modules they may open.
4. `POST /internal/dashboard/views/get` with `{"view": "<id>"}` is asked before any view is mounted. It answers `401` with no principal, `403` when the role lacks access, and `404` for an unknown or not-yet-built view. No request field can name an account, role or capability, and unknown keys are refused.
5. Every editorial read and write still goes through the existing content transport and content service, which apply their own default-deny policy on each action.

A role change, a disabled account or a revoked link applies on the next request. A disabled account is indistinguishable from a signed-out visitor.

### Capability-to-tab map

| Tab | State | Access rule | Contributor | Editor | Administrator | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| Overview | Working | Any active human account | Yes | Yes | Yes | Yes |
| My Account (self-view) | Working | Any active human account, own row only | Yes | Yes | Yes | Yes |
| Posts & Stories | Working | `content.publish` | No | Yes | Yes | Yes |
| Reports | Planned | `report.review` | No | Yes | Yes | Yes |
| Banners | Planned | `banner.manage` | No | No | Yes | Yes |
| Accounts | Planned | `account.read` | No | No | Yes | Yes |
| Audit | Planned | `audit.read` | No | No | Yes | Yes |
| System Status | Planned | `d1.inspect` | No | No | Yes | Yes |

Signed-out visitors, disabled accounts and agent credentials get no dashboard at all. Planned modules have no page and no data for anyone. Overview only names them, without links, for roles that already hold the capability.

My Account is a self-view. It is separate from account management: it reads only the caller’s own account, needs no `account.*` capability, and grants none. It shows name, email, role, status, member-since date, a display label and linked date for each sign-in link, and the caller’s working tabs. It never returns an account ID, identity ID, subject, provider string, credential hash or preferences. It has no edit controls, because self-service edits are not supported yet.

### Overview by role

A contributor sees their own account and the one action they have, My Account, with a plain statement that the role has no staff tools. The response carries no draft, report or count. Editors, administrators and the owner also see quick actions for Posts & Stories and the five most recently changed drafts, read through the content service under their own principal. There are no administrative counts in this slice.

## Posts & Stories

The existing editorial workspace runs inside the shell unchanged in behavior: listing, search, type and status filters, sorting, paging, draft editing, the safe Markdown preview, save, archive and restore, relationships and revision history. See [editorial-workspace.md](editorial-workspace.md). `mountEditorApp` gained a `host` option so the shell owns the page chrome and the account switch. Seed content is fictional Lorem Ipsum.

Publication is not offered in the dashboard. The local sandbox mounts the draft routes only, so publish and withdraw could not be verified here and are left to hosted EDIT-2.

### Stale-save conflict

1. Open one draft in two browser tabs. Both show the same version.
2. Save a change in the first tab. It becomes the next version.
3. Change different text in the second tab and save. The server refuses the stale version.
4. The second tab shows the Version conflict panel. It names the newer version and its editor and shows a line comparison. The stored newer revision is untouched and everything typed in the second tab is still in the fields.
5. Choose “Keep my edits on top of the latest version”, review, and save. That creates a further version. Revision history lists every version, and any of them can be viewed, compared and restored.

Keeping edits applies the second editor’s whole fields on top of the latest version. It is not a merge. The panel names each field that differs so the editor can review before saving, and the earlier revision stays in history for restore.

Leaving a draft with unsaved changes asks first. That covers moving to another dashboard page and using the sandbox account switch.

## Sandbox isolation

The synthetic accounts, the account switch and every fixture live in `src/editor-dev/sandbox.ts` and `scripts/editor-dev.mjs`. The sandbox binds to loopback, serves only its exact Host values, needs a per-launch token and same-origin requests, sends a strict Content Security Policy, and always uses a fresh in-memory database. `src/application.ts` and `src/worker.ts` do not import the sandbox, the dashboard transport or the test identity adapter, and the packaged Worker bundle contains none of them. The acting account is held in page memory only. Nothing is written to `localStorage`, `sessionStorage`, IndexedDB or cookies, so a reload returns to the default account.

| Sandbox account | Role | Purpose |
| --- | --- | --- |
| Avery Author | Editor | Default. Editorial flow |
| Eli Editor | Editor | Second editor for the conflict flow |
| Riley Reader | Contributor | Overview and My Account only |
| Ada Administrator | Administrator | Editorial plus planned administration |
| Olive Owner | Owner | Same, with every planned module named |
| Rene Retired | Editor, disabled | Behaves as signed out |
| Signed-out visitor | None | No identity is sent |

## Adding a module

1. In `src/contracts/dashboard.ts`, set the module’s `state` to `active`. Its access rule must use an existing capability.
2. In `src/services/dashboard.ts`, return the view’s data from `view()`. Keep module data and writes in the module’s own service and transport, with their own checks.
3. Write a `DashboardViewFactory` and register it under the module ID in the `views` option in `src/editor/main.ts`. A factory receives an empty container, the authorized view data and the session, and returns `destroy` and an optional `canLeave`.
4. Serve any new browser file from the host and add tests for each role, signed-out and disabled callers.

The shell asks the server before it mounts a view, so a factory never runs for a refused account.

### Integration map for later modules

| Module | Connects to | Notes |
| --- | --- | --- |
| Banners (reserved for BANNER-ADMIN-4) | The merged `/api/admin/banners/*` contract in [banner-admin-api.md](banner-admin-api.md), gated by `banner.manage` | Use private version previews for staged images and publication snapshots for history and restore. Local development can use synthetic images and test storage now that the shell exists. Live `BUCKET` verification is a hosted dependency |
| Accounts | `createAccountAdminModule` and `/api/admin/accounts` in [account-management.md](account-management.md), gated by `account.read` and the other `account.*` and `identity.*` capabilities | Stays separate from My Account. The self-view never becomes an edit path for other accounts |
| Reports | The staff report review API in [report-api.md](report-api.md), gated by `report.review` | Private report data appears only inside this module |
| Audit | The audit service, gated by `audit.read` | Read-only, paged |
| System Status | The read-only inspection service behind `d1.inspect` in [mcp-administration.md](mcp-administration.md) | Bounded, read-only inspection: migration inventory, aggregate counts, binding presence. No generic database CRUD, raw SQL, bulk writes or browser-driven migrations |

## Hosted use (not part of this slice)

A hosted dashboard needs a Worker route that serves the shell without the `sandbox` option, the dashboard transport wired to the AUTH-3-WEB session adapter, an asynchronous D1 form of the dashboard service, a hosted editorial policy, and sign-out through `POST /auth/logout`. Those depend on AUTH-3-WEB enablement, AUTH-4 and AUTH-5 and are separate work.

## Tests

`tests/dashboard.test.mjs` covers navigation for each role, signed-out, disabled and unknown callers, the self-view field list, the contributor Overview, direct requests to restricted, planned and unknown views, malformed requests, sandbox token, origin and Host guards, role changes between requests, agent principals, hosted and public entry points, the Worker bundle, and browser storage. `tests/dashboard-ui.test.mjs` runs the real shell in jsdom over the real sandbox for the contributor flow, the editor listing, the two-view stale-save conflict and recovery, the unsaved-changes guard, signed-out and disabled states, error and empty states, and keyboard and labelling basics. The existing editorial tests still cover the workspace itself.

## Limits

- Local sandbox only. No hosted route, deployment or hosted verification.
- Beta-1 was reviewed from archived source only (`lib/site-navigation.mjs`, `app/workspace.tsx` and `app/my-profile.tsx`): grouped sidebar sections, role-gated entries and a profile page open to every signed-in account. The running Beta-1 dashboard was not opened, so no screen-level parity is claimed.
- No publication controls, no self-service account edits and no administrative counts.
- The standalone editor shell in `mountEditorApp` remains for the existing editorial tests. The sandbox serves the dashboard.

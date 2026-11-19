# Dashboard foundation (EDIT-2 local slice)

One WordPress-style dashboard for signed-in human accounts. This slice delivers the shared shell and three working views: Overview, My Account and Posts & Stories. The sandbox runs only locally with fictional data. The hosted Alpha-1 entry (Overview and My Account) is described in the hosted section below.

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
| Banners | Working | `banner.manage` | No | No | Yes | Yes |
| Profiles | Working, hosted only. The local sandbox lists it as planned | `profile.manage` | No | No | No | Yes |
| Accounts | Planned | `account.read` | No | No | Yes | Yes |
| Audit | Planned | `audit.read` | No | No | Yes | Yes |
| System Status | Planned | `d1.inspect` | No | No | Yes | Yes |

Signed-out visitors, disabled accounts and agent credentials get no dashboard at all. Planned modules have no page and no data for anyone. Overview only names them, without links, for roles that already hold the capability.

My Account is a self-view. It is separate from account management: it reads only the caller’s own account, needs no `account.*` capability, and grants none. It shows name, email, role, status, member-since date, a display label and linked date for each sign-in link, and the caller’s working tabs. It never returns an account ID, identity ID, subject, provider string, credential hash or preferences. It has no edit controls, because self-service edits are not supported yet.

### Overview by role

A contributor sees their own account and the one action they have, My Account, with a plain statement that the role has no staff tools. The response carries no draft, report or count. Editors, administrators and the owner also see quick actions for Posts & Stories and the five most recently changed drafts, read through the content service under their own principal. There are no administrative counts in this slice.

## Posts & Stories

The existing editorial workspace runs inside the shell unchanged in behavior: listing, search, type and status filters, sorting, paging, draft editing, the safe Markdown preview, save, archive and restore, relationships and revision history. See [editorial-workspace.md](editorial-workspace.md). `mountEditorApp` gained a `host` option so the shell owns the page chrome and the account switch. Seed content is fictional Lorem Ipsum.

Publication is not offered in Posts & Stories. The local sandbox mounts the draft routes only, so post and story publish and withdraw could not be verified here and are left to hosted EDIT-2. The Banners tab is separate: it can publish, restore and withdraw banner publications within the disposable local sandbox, as verified in [PR #156](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/156) and [Issue #146](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/146).

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
| Banners | The merged `/api/admin/banners/*` contract in [banner-admin-api.md](banner-admin-api.md), gated by `banner.manage`, through the browser client in `src/editor/banner-admin-client.ts` and the view in `src/editor/banner-views.ts` | Working (BANNER-ADMIN-4). County search by name or FIPS, stage a new banner or a replacement, private version preview, publish, replace, restore, withdraw, publication history, metadata edit, reorder, stale-version conflicts, idempotent retries, reconcile for missing or corrupt images, in-DOM confirmations. The sandbox serves the real D1-backed service over a sync→async binding adapter with in-memory storage. Live `BUCKET` verification is a hosted dependency |
| Accounts | `createAccountAdminModule` and `/api/admin/accounts` in [account-management.md](account-management.md), gated by `account.read` and the other `account.*` and `identity.*` capabilities | Stays separate from My Account. The self-view never becomes an edit path for other accounts |
| Reports | The staff report review API in [report-api.md](report-api.md), gated by `report.review` | Private report data appears only inside this module |
| Audit | The audit service, gated by `audit.read` | Read-only, paged |
| System Status | The read-only inspection service behind `d1.inspect` in [mcp-administration.md](mcp-administration.md) | Bounded, read-only inspection: migration inventory, aggregate counts, binding presence. No generic database CRUD, raw SQL, bulk writes or browser-driven migrations |

## Hosted dashboard (Alpha-1 entry)

Status: merged source, tested locally. Not deployed and not verified on the hosted Site.

The Worker serves the same shell, registry and capability checks on Alpha-1, but only while Website human sign-in is enabled (see [human-sign-in.md](human-sign-in.md)). With sign-in off, missing settings or no `DB`, `/dashboard` and `/internal/dashboard/*` answer `404` and the public header shows no sign-in entry.

| Route | Behavior |
| --- | --- |
| `GET /dashboard` | Serves the shell page to a current human session. No session or a stale cookie gets `303` to `/auth/login?return_to=%2Fdashboard`. A presented agent credential never falls back to the cookie flow. An invalid one gets `401` and a valid one `403`. A disabled account or a revoked or expired link gets `403` or the sign-in redirect |
| `GET /internal/dashboard/session`, `POST /internal/dashboard/views/get` | The existing dashboard transport over `createD1DashboardService` in `src/services/dashboard-d1.ts`. The principal comes from the Website session adapter. Cookie-authenticated posts need an exact `Origin` match. Responses are `no-store` |
| `/assets/dashboard-app.js`, `/assets/dashboard-app.css` | The hosted browser bundle from `src/editor/hosted-main.ts` and the shared shell styles |

The hosted service uses the same `DASHBOARD_MODULES` registry and `roleHasCapability` matrix as the local service. It adds one gate, `HOSTED_DASHBOARD_MODULES`. A module that is active locally but not in that set is reported as planned. Its navigation, view and data stay closed to every role, and a direct request for it answers `404`.

| Module | Hosted | Why |
| --- | --- | --- |
| Overview, My Account | Yes | Read only, any active human account. My Account shows no subject, provider string, identity ID or account ID |
| Posts & Stories | Yes, draft editing only. Merged source, tested locally on the bundled Worker and a disposable local D1. Not deployed and not Hosted-verified | The view only names itself. Every read and write goes through the protected `/internal/content/drafts/*` and `/internal/content/revisions/*` routes with the Website session cookie, over `createD1ContentService` in `src/services/content-d1.ts`. Each change is one atomic D1 batch: the versioned write, a write assertion that aborts it when no row matched, relationships, the revision snapshot and the audit event. The routes require a current human account holding `content.publish`, so an agent credential is refused. Publication controls are not in the tab. The county, person and organization relationship pickers need sandbox lookups that the hosted Worker does not serve, so the hosted editor leaves them empty and edits title, summary and body only |
| Banners | Yes. Merged in #214, Deployed on Cloudflare staging and Hosted-verified in the signed-in owner dashboard with a synthetic image | The view only names itself. Every read and write goes through the protected `/api/admin/banners/*` routes with the Website session cookie, and the hosted client sends no sandbox header. The Cloudflare staging `BUCKET` is verified by the Adams pilot. The original Sites attachment stays open in [Issue #122](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/122). The hosted shell allows `blob:` in `img-src` only, so the staged preview built from bytes fetched from the protected route can render |
| Profiles | Yes. Draft [PR #257](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/257), tested locally on a migrated local D1 and in jsdom. Not merged, not deployed and not Hosted-verified | An owner-only Tabulator grid over the protected `/api/admin/profiles/*` routes with the Website session cookie. See [profiles-sheet.md](profiles-sheet.md) for the field map, sync ownership and public visibility rules |
| Reports, Accounts, Audit, System Status | No | Still planned |

To add a module to the hosted dashboard, wire its hosted service and transport, verify its dependencies on the hosted Site, add its view factory to `src/editor/hosted-main.ts`, add the ID to `HOSTED_DASHBOARD_MODULES` and add role, signed-out, disabled, revoked and agent tests.

Sign-out is a same-origin form post to `/auth/logout` from the account menu. The page sends `Referrer-Policy: same-origin` so the exact `Origin` check passes.

The hosted bundle is built by `scripts/build-sites-worker.mjs`. It imports no sandbox, fixture, synthetic account or sandbox header. The synthetic account switch and sandbox headers live in `src/editor/dashboard-sandbox.ts`, which only the local sandbox loads. `tests/dashboard-hosted.test.mjs` asserts that the served bundle contains none of them.

A hosted editorial policy, AUTH-5 invitations, hosted relationship lookups and publication controls remain separate work.

## Tests

`tests/content-hosted.test.mjs` drives Posts & Stories on the bundled Worker over a migrated local D1: every draft route for signed-out, stale-cookie, contributor, agent and cross-origin callers, create, list, get, update, stale write, relationships, archive, restore and revision history with their audit events, a draft that survives a reload, the two-view stale-save conflict with kept edits, and the contributor denial in the shell. `tests/d1/draft-checks.mjs` repeats the flow on the real local D1 through `npm run test:sites:d1`. `tests/dashboard-hosted.test.mjs` drives the bundled Worker with a migrated local D1 and a synthetic provider for the hosted routes, header entry, bundle contents, roles, signed-out, unlinked, disabled, revoked, expired and agent callers, cross-origin posts, sign-out and the Auth0 first-owner link. `tests/dashboard.test.mjs` covers navigation for each role, signed-out, disabled and unknown callers, the self-view field list, the contributor Overview, direct requests to restricted, planned and unknown views, malformed requests, sandbox token, origin and Host guards, role changes between requests, agent principals, hosted and public entry points, the Worker bundle, and browser storage. `tests/dashboard-ui.test.mjs` runs the real shell in jsdom over the real sandbox for the contributor flow, the editor listing, the two-view stale-save conflict and recovery, the unsaved-changes guard, signed-out and disabled states, error and empty states, and keyboard and labelling basics. `tests/dashboard-banners-ui.test.mjs` runs the Banners module in jsdom over the real sandbox with synthetic PNG fixtures: county search, stage, private preview, publish with confirmation, replace, details edit, reorder, withdraw, restore from history, stale-version conflicts with kept edits, idempotent retries, missing stored images with reconcile, the live role matrix, and labelling. The existing editorial tests still cover the workspace itself.

## Limits

- The sandbox is local only. The hosted dashboard has merged source and local tests, with no deployment or hosted verification (see the hosted section).
- Beta-1 was reviewed from archived source only (`lib/site-navigation.mjs`, `app/workspace.tsx` and `app/my-profile.tsx`): grouped sidebar sections, role-gated entries and a profile page open to every signed-in account. The running Beta-1 dashboard was not opened, so no screen-level parity is claimed.
- No Posts & Stories publication controls, no self-service account edits and no administrative counts. The Banners tab can publish, restore and withdraw within the disposable local sandbox, as verified in [PR #156](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/156) and [Issue #146](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/146).
- The standalone editor shell in `mountEditorApp` remains for the existing editorial tests. The sandbox serves the dashboard.

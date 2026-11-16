# Banner administration dashboard: design and implementation brief (BANNER-ADMIN-0)

Status: design only. This document adds no code, route, migration, hosted change or real banner file. It was written against `main` at `aa99683`. It does not touch the roadmap or CURRENT. The archon can add the implementation rows to both when the owner accepts the plan.

## 1. Summary

- Beta-1 had no browser tool for managing banners. The owner’s workflow there was a command-line and JSON-registry process, so the Beta-2 dashboard is a new design and not a port.
- Beta-2 already has the right lifecycle in `BannerAssetService` (stage, verify, activate, withdraw, restore, metadata, reorder) and the right authorization (`banner.manage`, audited, version-checked, immutable versions). It has no hosted write path and no administrator route. The service runs only on the synchronous local SQL.js database.
- The smallest useful design is one page, `/admin/banners`, backed by `/api/admin/banners/*`, copying the existing account-administration module pattern. Every write goes through one shared `BannerAdministration` contract that a D1 and R2 adapter implements. The same contract is what MCP-3 will wrap later.
- The first implementation PR is BANNER-ADMIN-1: the shared contract, an image inspector and the D1 and R2 adapter for reads and staging. It needs no hosted access and is verified locally with synthetic images.
- Hosted use is gated by verified administrator sign-in (AUTH-3 and AUTH-4) and by independent evidence that the `BUCKET` R2 binding is attached (R2-1). MCP-3 does not gate it.

## 2. What Beta-1 actually did

Source root for every citation in this section is `D:\ChatGPT\Watchdog\archive\beta-1\`, opened read-only. Nothing from it was copied.

| Finding | Evidence |
| --- | --- |
| The banner registry was a JSON file in the repository, one record per image, with explicit `draft`, `approved` or `retired` status. Approved records required a canonical filename (`<FIPS>-<county>-<landmark_with_underscores>`), alt text, a name, a SHA-256 and dimensions. Optional fields were caption, credit, source label, desktop and mobile focal position and display order. | `colorado-watchdog\data\county-banner-art.json`, validation in `colorado-watchdog\lib\county-gallery.mjs` |
| Adding or replacing a banner was an operator command, not a screen. The operator prepared a separate reviewed registry and a plan file binding each input to its exact SHA-256, then ran `node scripts/images.mjs curated <plan.json>`, then `verify`, then a build, then the Sites save and publish steps. | `colorado-watchdog\docs\curated-image-workflow.md`, `colorado-watchdog\docs\county-gallery.md`, `colorado-watchdog\scripts\curated-image-operator.mjs` |
| Reversal was a second reviewed plan. Replacement kept the stable artwork ID and retained prior originals and delivery files in a private history folder, and old hashed URLs stayed routable. | `curated-image-workflow.md` (“history” and “retained” paragraphs) |
| Bulk additions were one-off scripts that renamed files into the canonical pattern and wrote registry records, with live-site check scripts afterwards. | `n-drive-original\recovery\organize-banners.py`, `latest-banner-batch.json`, `verify-latest-banner-batch.mjs`, `verify-live-banners.mjs` |
| The only browser image page was `/image-processing`, signed-in owner only. It was a queue for private uploaded evidence and story attachments: download a task, run a local processor, upload an `acceptance.json`, approve exact over-budget files. Its own text says it “does not approve public release” and points banner work at the curated workflow. | `colorado-watchdog\app\image-processing\page.tsx`, `app\image-processing-panel.tsx`, screenshot `recovery\phase-img-c-2026-11-02\hosted-owner-image-processing.png` (shows an empty queue) |
| The public slideshow read the registry. It had no admin controls. | `colorado-watchdog\app\scenic-slideshow.tsx`, `docs\county-gallery.md` |

What the owner’s real banner workflow therefore was, in order: choose a county and a landmark, produce an image, name it canonically, hash it, write alt text and caption into a registry record, decide approval, run the verify and build commands, publish the Site, check the live page. Each step the dashboard replaces maps onto a Beta-2 operation in section 4.

Not seen, so not claimed:

- No screenshot or walkthrough of a banner management screen exists in what I opened, and a source search of `colorado-watchdog\app` for “banner” found only the public county page, the front page and the two scenic components. That supports “no banner admin UI existed” but I did not open every screenshot in `evidence\` and `recovery\`, and I did not read the Workspace and Handoff view source in `app\page.tsx`.
- I did not compare the four `linked-worktrees\` copies against the main Beta-1 folder.
- I did not read `documents\` walkthroughs. The workspace folder names suggest MCP audit design documents, which are outside this task.
- I did not open any banner image file.

## 3. What Beta-2 already provides

All paths are in this repository at `aa99683`.

| Piece | Evidence | Limit |
| --- | --- | --- |
| `BannerAssetService` with `stage`, `activate`, `withdraw`, `restore`, `updateMetadata`, `reorderCounty`, `resolveCounty`, `reconcile`, `getBanner`, `getVersion` | `src/services/banner-assets.ts` (stage 218, activate 563, withdraw 614, restore 622, updateMetadata 657, reorderCounty 761, reconcile 854) | Constructor takes the synchronous local `WebsiteDatabase`, which `src/database/sqlite.ts:21` says “is not a D1 adapter”. The class comment says “No route is registered”. There is no listing query. |
| Capability and attribution | `banner.manage` held by administrator and owner only (`src/services/security.ts`), rechecked on every mutation. Audit rows through `runAuditedMutation` (`src/services/audit.ts`), actor taken from the trusted principal, never from input | Synchronous only |
| Immutable versions and separate staging | `banner_asset_versions` is append-only. Stage ends `verified` and never changes the selected pointer. Activation is a separate call that requires a verified version and the current row version | None |
| R2 adapter | `R2BannerObjectStorage` in `src/services/banner-storage.ts`, conditional create, reread and digest check | Never exercised against a real bucket (CURRENT, R2-1 row) |
| Hosted public reads | `D1BannerPublicService` in `src/services/banner-public.ts`, `GET and HEAD /banner-assets/<version-uuid>` in `src/site/index.ts:329` | Serves only the selected verified version of an active banner. A staged version is a 404 |
| Async D1 write primitives | `AsyncD1Database.batch` and `guardedBatch` in `src/database/d1.ts:84` and `:99`. The guard re-asserts the current principal, role and dependency generation inside the same atomic batch | Used by accounts, content publication and sync, not banners |
| Administrator page pattern | `src/account-admin.ts`: server page plus static script, `resolvePrincipal`, `hasCapability`, same-origin check on writes, `no-store`, strict content security policy, mounted in `createApplication` (`src/application.ts:37`) | Gated by capability `account.read`, not banners |
| Public renderer for previews | `bannerFrame` in `src/site/banner.ts:145`. `src` may be any root-relative path, and it already skips banners with empty alt text | None |
| Local sandbox pattern | `npm run editor:dev` (`scripts/editor-dev.mjs`, `docs/architecture/editorial-workspace.md`): loopback only, per-launch token, in-memory database, synthetic seed | None |
| Synthetic images | `src/site-dev/banner-fixtures.ts` (generated SVG test patterns), `pngjs` and `jpeg-js` dev dependencies | SVG is not an accepted banner type, so the sandbox needs generated PNG and JPEG |

Gaps found in the service that the dashboard must not inherit:

1. Width and height are caller-supplied. The service checks only the PNG or JPEG signature and the digest (`validateProposal`). A browser can read the true size with `createImageBitmap`, but the server must cross-check it by parsing the PNG IHDR or JPEG start-of-frame header.
2. `validText` accepts an empty string, so the service accepts empty alt text. The public renderer then silently drops that banner. The dashboard must require non-empty alt text before publish.
3. For an existing banner, `stage` creates the version but does not change caption or alt text. `updateMetadata` changes a live banner immediately. Doing “new image plus new caption” as stage, then metadata, then activate would show a mismatched caption for a moment. A composite `publish` operation is needed (section 5).
4. `activate` does not reread the object bytes. `restore` does. The adapter’s activate must reread and digest-check immediately before moving the pointer.
5. `withdraw` changes status only and keeps the selected pointer. There is no public “un-withdraw”. Reversal is `restore` of a verified version, which sets the pointer and status together.
6. The local service checks the row version in application code inside a synchronous transaction. On D1 the pointer update must carry `WHERE version = ?` and the batch must fail if zero rows change.
7. The same digest attached to a different banner is a conflict (flagged for owner review). The dashboard must show that conflict plainly and not offer to override it.

## 4. The smallest owner workflow

One page, `/admin/banners`, with three areas. It uses plain HTML and one script file, the same way the account page does.

**Find a county.** A search box and a list of the 64 counties from the county registry (`listCounties`), each row showing name, FIPS, active banner count and a state badge: “Banner live”, “Fallback placeholder”, “Staged, not published” or “Needs attention”. “Needs attention” comes from `reconcile` (missing, corrupt or unverified object). Typing filters by name or FIPS. The counties list is paged and bounded.

**County view.** For the chosen county:

- The active banner or banners, rendered through the real `bannerFrame` so what the owner sees is what visitors see, plus caption, alt text, display mode, focal point, display order, primary flag, homepage order, row version, selected version ID and the first 12 characters of its SHA-256.
- Version history per banner, newest first: version ID, state, dimensions, byte size, media type, digest prefix, source filename, the previous version it replaced, who staged it and when, who activated it and when (from `audit_events`, read with `audit.read`). The selected version is marked. Each retained verified version has a “Preview” and a “Restore this version” action.
- “Stage a new image” starts the publish flow below.

**Publish flow, five explicit steps, nothing public until the last.**

1. **Choose image.** A file picker accepts JPEG or PNG only. The browser decodes it (`createImageBitmap`), shows the true pixel size, computes SHA-256 with `crypto.subtle`, and shows both. The original file name is kept as provenance and never as a path.
2. **Stage.** The browser sends bytes plus the digest and an idempotency key (generated once per attempt, reused on retry). The server inspects the header, cross-checks dimensions, stages to R2, rereads and verifies. Result: a version in state `verified` that is not selected and not public. A failure shows the stored error code and offers “Retry” with the same key.
3. **Describe.** The owner types caption and alt text. Alt text is required and the page says what good alt text for a landscape banner looks like. Display mode and focal point are set with a click on the image. Defaults come from the service (`cover`, centered).
4. **Preview.** The page renders the staged version through `bannerFrame` at 1440, 768 and 390 pixel widths with the typed caption and alt text, next to the current live banner. The image comes from an administrator-only bytes route, not the public route. A preview is a rendering of unsaved text over verified bytes, so nothing is written.
5. **Publish.** A confirmation names the county, the old and new version IDs and digest prefixes, the caption and alt text, and states “This changes the public Site now.” One button, “Publish”. The call is the composite `publish` operation with the banner’s current row version. A stale version shows “Someone changed this banner. Reload.” and changes nothing.

For a first banner in a county, step 2 creates the banner row in `draft` with the caption and alt text from step 3, which means step 3 precedes step 2 in that case. That ordering difference is the only branch in the flow.

**Reversing a mistaken publication.** Two buttons on the county view, both one click plus a confirmation, both audited, neither deleting anything.

- **Restore previous version.** Calls `restore(bannerId, previousVersionId)`. The service rereads the retained object from R2, checks its digest and size, then moves the pointer and sets status `active`. The mistaken version stays in history, unselected, and its public URL returns 404 because the public route serves only the selected version.
- **Withdraw.** Sets status `withdrawn`. The county immediately goes back to the placeholder. Use this when no earlier good version exists or the right fix is not ready. Undoing a withdrawal is `restore` of the same version.
- Metadata-only mistakes are corrected by a new `updateMetadata` call, which is also audited and version-checked.
- Because the public delivery route is `no-store`, a pointer change takes effect on the next request to that route. Whether the hosted Sites layer caches the county HTML is not verified and goes on the hosted checklist in section 8.

## 5. Service operations: reuse, adapt, new

| Need | Existing operation | Status for hosted D1 and R2 |
| --- | --- | --- |
| County list | `listCounties` | Reuse the query through the async D1 reader that already serves the public county directory |
| Counties with banner summary | none | **New** read: one grouped query of `banner_assets` by county |
| County banners and version history | `getBanner`, `getVersion` by ID only | **New** read: list banners and versions for a county |
| Audit history for a banner | `listAuditEvents` (`src/services/audit.ts:87`) | Adapt to async D1 with `audit.read` |
| Reconcile | `reconcile` | Adapt: read-only, async, per county |
| Stage and verify | `stage` | **Adapt.** Same state machine, rewritten on `AsyncD1Database.guardedBatch` with the existing R2 adapter. Add header-based dimension cross-check |
| Preview bytes | `D1BannerPublicService.deliver` serves only selected versions | **New** route that serves any version of a banner the caller may manage, with digest check, `private, no-store`, `nosniff` and the JPEG and PNG allowlist |
| Publish | `updateMetadata` plus `activate` | **New composite** `publish(bannerId, versionId, expectedRowVersion, metadata)`: one guarded batch, one audit event naming both versions. Rejects empty alt text. Rereads bytes first |
| Withdraw | `withdraw` | Adapt to guarded batch |
| Restore | `restore` | Adapt to guarded batch |
| Metadata only | `updateMetadata` | Adapt to guarded batch. Non-empty alt rule enforced at the dashboard and `publish` |
| Reorder | `reorderCounty` | Adapt. Not part of the first workflow, include in BANNER-ADMIN-2 for parity |
| Public delivery | `D1BannerPublicService`, `/banner-assets/<id>` | Reuse unchanged |
| Routes | none | **New** `/admin/banners`, `/admin/banners.js`, `/api/admin/banners/*` |

The shared contract is a TypeScript interface, `BannerAdministration`, with async methods whose inputs carry no actor. The principal is passed separately, as it is today. The existing synchronous service can be wrapped to satisfy it so the current tests keep passing. The D1 adapter must recheck the live principal inside the batch with `guardedBatch`, as the accounts, content publication and sync services already do, so a revoked administrator cannot finish an in-flight write.

Proposed routes, all requiring `banner.manage`, same-origin on every write, `no-store`, JSON bodies capped at a small size and image bodies capped at the service’s 25 MiB limit:

- `GET /admin/banners` and `GET /admin/banners.js`
- `GET /api/admin/banners/counties`
- `GET /api/admin/banners/counties/<fips>`
- `GET /api/admin/banners/versions/<id>/image`
- `POST /api/admin/banners/stage`
- `POST /api/admin/banners/<id>/publish`
- `POST /api/admin/banners/<id>/withdraw`
- `POST /api/admin/banners/<id>/restore`
- `POST /api/admin/banners/<id>/metadata`
- `GET /api/admin/banners/reconcile`

No route accepts an actor ID, an object key, a path, SQL or a table name. Object keys stay generated by the service as `banner-assets/<version-id>`.

## 6. Manual operation without waiting for MCP-3

MCP-3 is “audited MCP write tools” and depends on MCP-2 (authenticated hosted MCP), which depends on AUTH-3 and AUTH-4. The dashboard does not need any of that code. It needs the same two things MCP-3 needs, a verified principal and the shared service, and it needs them in the same shape.

- The dashboard and the future MCP tools both call `BannerAdministration`. Neither owns business rules. A tool such as `banner_stage` or `banner_publish` later becomes a thin wrapper that resolves the Website-agent principal and calls the same method. That keeps the AI-first service layer decision intact and keeps audit rows identical for human and agent actions, with the actor’s account kind recording which it was.
- Nothing in the dashboard bypasses a rule the agent path would face. There is no dashboard-only write.
- The tool inputs and outputs of MCP-3 should be the JSON shapes of these routes, so one test suite can cover both.
- What the dashboard does not remove is the need for a verified administrator identity on the hosted Site. Today all hosted human sign-in fails closed (CURRENT, section E). So the honest position is that manual operation without MCP-3 is possible, but manual operation without AUTH-3 is not. I do not propose a shortcut credential, a shared secret or an unauthenticated route.

## 7. What can be built and verified locally, and what stays gated

Buildable and verifiable now, with synthetic data only:

- The `BannerAdministration` contract, the image inspector, and the D1 adapter, tested against the isolated Wrangler local D1 (`npm run test:d1`) and `MemoryBannerObjectStorage`. Synthetic PNG and JPEG files are generated in test code with `pngjs` and `jpeg-js`. No file from `banners\` is read.
- Authorization tests with the test human identity adapter: owner and administrator allowed, editor, contributor, disabled account and anonymous denied, plus a revoked-mid-write case.
- Concurrency and failure tests: stale row version, duplicate idempotency key with a different request, R2 failure leaving the version `failed` and the operation `interrupted`, corrupt object refused at activate and restore, same digest on a different banner refused.
- The route module with sign-in simulated by the test adapter, same-origin and size-limit checks, and the strict page headers.
- The page in a sandbox launcher modeled on `editor:dev` (loopback, per-launch token, in-memory database and storage, synthetic seed of a few counties and versions). Checks use jsdom for logic and Edge or Chrome for keyboard use, 1440, 768 and 390 pixel layouts and the actual `bannerFrame` rendering. A screen reader pass can reuse the NVDA method from `banner-screen-reader-verification.md`.
- Whether Wrangler’s local R2 simulation can replace the memory adapter in tests is untested, and BANNER-ADMIN-1 should try it and record the result without assuming it.

Gated, and stated as such in every PR until proven:

| Gate | What it blocks | Evidence needed |
| --- | --- | --- |
| Verified administrator sign-in (AUTH-3, AUTH-4) | Any hosted use of the page or API | A hosted principal resolves to an owner or administrator account and a non-administrator is refused |
| `BUCKET` attachment (R2-1) | Any hosted stage, preview of staged bytes, restore | A synthetic object conditionally created, read back and digest-checked in the real Worker. CURRENT lists this as unverified |
| Hosted D1 behavior of guarded batches | Pointer changes | A synthetic banner published, withdrawn and restored on the hosted `DB` with the audit rows present |
| Sites request body limits and header handling | Uploading near the 25 MiB limit and the strict content security policy | A hosted upload at a realistic size and a clean browser console |
| Hosted cache behavior | The promise that a withdrawal is visible at once | County page fetched before and after a withdrawal, with headers recorded |
| Real artwork | Everything in BANNERS-IMPORT-1 | Not in scope here. The 152 approved originals stay in `banners\approved\` |

Tests pass locally means “tested locally”. It never becomes “verified on the hosted Site” without the evidence in the right column.

## 8. Implementation PRs

Each PR stands alone, merges without hosted access and leaves `main` deployable. Numbering is a proposal for the archon to adopt.

1. **BANNER-ADMIN-1 (first).** Add the `BannerAdministration` contract and result types, an image inspector (signature, PNG IHDR and JPEG frame dimensions, size and digest), and the async D1 and R2 adapter for the read side and for `stage`. Include the new county summary and county detail reads, async `reconcile` and async audit reads. No route, no page, no migration. Tests: local D1, synthetic images, the failure cases in section 7. Why first: every later piece, including MCP-3, depends on this contract, it is the only piece that touches the data model risk, and it needs nothing hosted.
2. **BANNER-ADMIN-2.** Pointer operations on the same adapter: `publish` (composite), `withdraw`, `restore`, `updateMetadata`, `reorderCounty`, each as a guarded batch with byte reread and row-count checks. Tests cover the reversal path end to end: publish, publish again, restore the first, withdraw, restore again, with the audit trail asserted.
3. **BANNER-ADMIN-3.** The `/api/admin/banners/*` module and the administrator-only image route, mounted in the Worker only when `DB` and `BUCKET` exist. Authorization, same-origin, size limits and header tests. Public behavior unchanged.
4. **BANNER-ADMIN-4.** The `/admin/banners` page and script, the sandbox launcher and its synthetic seed, the DOM tests and the live-browser and screen-reader notes at three widths. Still no hosted claim.
5. **BANNER-ADMIN-5.** Hosted enablement and verification record, no new features. Runs only after AUTH-3 and AUTH-4 and the independent `BUCKET` evidence. It uses synthetic images first, records the results in the PR and updates CURRENT. It does not import real banners.
6. **Not in this series: MCP-3 banner tools.** They wrap the contract from PR 1 and 2 and reuse the route tests’ JSON cases. BANNERS-IMPORT-1 stays a separate task that uses the same contract with real manifests after R2 and sign-in are proven.

## 9. Constraints preserved

- `banner.manage` is checked on every operation and rechecked against the live principal inside the write.
- Audit rows record the actor account, the banner and version IDs and digests. They never record local paths, filenames from the owner’s folders as paths, credentials or tokens.
- Versions and their object keys are never edited or deleted. No dashboard action deletes anything.
- Staging and activation stay separate calls. A staged version is private until a publish confirmation.
- Beta-1 data, artwork and credentials are not copied. Tests use generated images.
- Default-deny: no unauthenticated administrator endpoint, no broad SQL tool.
- The Website D1 stays separate from the local Profiles database. This work does not read the Profiles database.

## 10. Decisions and risks for the owner

- Approve the composite `publish` operation. It is a small addition to the service and it prevents showing a new caption with the old image.
- Alt text is required to publish. The service currently allows empty text, so this is a deliberate tightening.
- A dashboard preview that shows unsaved caption text is a rendering only. If the owner wants drafts of caption and alt text to persist before publish, that needs a schema change and is deferred.
- Dimensions from the browser decode are cross-checked by header parsing, but neither is a full image decode on the server. Full decode remains an operator claim (“full_decode_passed” in the manifest model), as in BANNERS-1.
- Sites Worker request-size and caching behavior is unverified and could force a change such as a smaller upload cap.

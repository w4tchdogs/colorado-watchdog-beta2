# BANNERS-3 delivery and follow-on contracts

## BANNERS-3 implementation

The public Worker uses D1 as the lifecycle authority and an optional `BUCKET`
R2 binding for immutable bytes. `D1BannerPublicService` is a read-only async
adapter over the BANNERS-2 schema and `R2BannerObjectStorage`; it does not add a
second metadata store or mutation API. It returns only active banners whose
selected version is verified and whose current object bytes match the complete
SHA-256, byte size and JPEG/PNG signature. Any absent, malformed, corrupt or
unavailable object is omitted, leaving the existing 3:1 placeholder.

`GET` and `HEAD /banner-assets/<version-uuid>` resolves only a currently active
banner's selected verified version. It performs the same byte verification for
both methods, permits only JPEG/PNG and responds with `nosniff` and `no-store`.
The version UUID is the only public lookup input; object keys never come from a
request. Unknown, stale, withdrawn, draft, malformed and unselected versions
return 404. Unsupported methods retain the site's `GET, HEAD` 405 behavior.

**Automatic homepage selection.** The homepage hero draws from the whole pool of
county banners that are `active` with a selected version in state `verified`. A
county banner enters the pool automatically when it is published, whatever its
`homepage_order` or county primary flag. Withdrawn banners, drafts, staged or
unverified versions and superseded (unselected) versions are never in the pool.
On each homepage request `D1BannerPublicService.resolveHomepage` orders the
pool randomly in SQL (`ORDER BY RANDOM()`) before any limit is applied, so a
banner outside the first page of results can be chosen. It reads at most 10
random candidates from R2, runs the same byte, size, SHA-256 and signature
checks as the image route, and stops at five verified banners, so a missing
object is replaced by the next candidate. The draw order becomes the carousel
order, with no primary flag. The existing carousel renders the draw with its
current controls, captions, alt text, crop, focal point and branded fallback:
no banner shows the fallback, one has no controls and several show them. County
pages are unchanged and keep their primary-first, then `display_order`
sequence. `homepage_order` is no longer consulted. The homepage response sets no
cache headers, so each fresh load can differ.

Until R2-1 is deployed and verified, the checked-in Sites hosting manifest on `main` retains `r2: null`. The R2-1 branch declares `"r2": "BUCKET"` as the Sites storage documentation describes, and hosted provisioning is unverified. The earlier reason was that the platform
documentation does not specify a deployable R2 binding declaration and the
existing project has not provisioned one. Source/runtime compatibility is
prepared using the optional `BUCKET` binding. To continue in BANNERS-IMPORT-1,
ask Sites to add R2 object storage to the existing project while retaining the
existing `DB` D1 binding, and bind the bucket as `BUCKET`. Do not create another
Site or guess a bucket identifier. Rebuild and inspect the produced hosting
manifest after Sites reports the binding; if the platform cannot attach it,
keep the current null binding and use no live import.

## BANNERS-4 — accessible banner carousel

**Data contract.** Consume the ordered `BannerPresentation[]` already supplied
by BANNERS-3: stable banner ID, immutable version ID, county attribution, URL,
alt text, caption, intrinsic dimensions, display mode, focal point, order and
primary flag. Data is already filtered to active selected verified objects.
Do not fetch lifecycle metadata or expose object keys from the browser.

**Browser architecture.** Keep server-rendered first-image markup as the
no-JavaScript and zero-banner fallback. Add one small same-origin enhancement
that changes the current index and updates image URL, alt, caption, banner ID
and version together. Keep the URL version-specific. Do not start image
preloading beyond the current and next eligible image.

`bannerFrame` emits the first image and stores the ordered public presentation
data in an escaped HTML attribute. `/assets/site.js` validates that data,
reveals the controls, and preloads the next eligible image while keeping the
current artwork visible. The incoming image becomes the current item after the
fade and keeps its zoom position through that handoff.

**Controls and accessibility.** With two or more images, expose native Previous,
Next, Pause and Play buttons with accessible names, visible keyboard focus and
logical tab order. Announce the current item through a concise polite status.
Do not auto-rotate when `prefers-reduced-motion: reduce` is active. Pause on
focus, hover, pointer interaction, page visibility loss and explicit Pause; do
not resume after a visitor explicitly paused. Play starts rotation only on
explicit request. Reduced-motion navigation swaps to the loaded image without
zoom or fade.

**Playback speech and full width (BANNERS-4B).** A second polite, visually
hidden region (`data-banner-announce`) says "Banner rotation playing" after a
successful Play and "Banner rotation paused" when the visitor's own action stops
running rotation (Pause, focus or pointer entering the carousel). Automatic
stops (hidden page, reduced motion, failed image) are silent, an unavailable
Play says nothing, and the position status keeps one message per selection.
Focus entering the carousel already stops rotation, so a keyboard or screen
reader visitor hears "paused" on arrival. The hero frame, fallback and control
bar span the page width inside the scrollbar, with no 100rem cap, while the
heading and buttons keep the content width. `npm run site:dev:banners` shows
two synthetic homepage banners, and adding `-- --no-home-banners` (or running
`node scripts/site-dev.mjs --banner-fixtures --no-home-banners`) restores the
homepage fallback. Evidence: [banner-screen-reader-verification.md](banner-screen-reader-verification.md).

The carousel starts paused. During playback it dwells for seven seconds after
the next image is ready, then crossfades for four seconds with ease-in-out.
Each image zooms from 1.01 to 1.05 over 15 seconds, linearly from the center.
Pause freezes the artwork and any active fade and preserves the remaining
dwell time. Previous and Next still work while paused without starting playback.

**Layout and failure behavior.** Preserve the 3:1 frame, reserved caption area,
focal positions and branded placeholder. Galleries cover the frame and keep
the gradient, copy and controls fixed. Single images retain their configured
fit and stay static. A failed replacement leaves the current artwork in place
and is skipped for the rest of the page visit. A failed initial image shows the
placeholder until a successful manual selection. Zero images show the
placeholder without controls.

**Verification.** Automated DOM tests should cover data synchronization,
button names and focus, zero/one/many images, explicit and automatic movement,
pause/resume rules, reduced motion, visibility changes, failed image fallback,
and county/home data. Live-browser coverage should inspect keyboard-only use,
screen-reader status text, 1440x900, 768x1024 and 390x844 layouts, reduced
motion, network failure and stable frame/caption positioning. Do not claim
hosted artwork results from synthetic fixtures.

## BANNERS-IMPORT-1 — independent hosted import operation

1. Confirm the owner's current approved source and manifest outside Git; run the
   read-only BANNERS-1 inventory and reconcile added/unchanged/changed/missing/
   invalid entries. Do not copy source artwork to GitHub or rename it.
2. Provision `BUCKET` on this existing Sites project while preserving `DB`.
   Verify a harmless synthetic object can be conditionally created, read and
   digest-checked before any approved source is staged.
3. Stage each explicitly selected approved manifest record through the existing
   BANNERS-2 `BannerAssetService` using original bytes and the manifest SHA-256.
   Retry only with the same idempotency key and request. Confirm source lineage,
   immutable object key, size and digest, and keep failures isolated.
4. Review metadata and homepage curation separately. Activate only versions in
   `verified`; never infer approval from inventory, staging or successful upload.
   Keep prior versions and use the existing version-checked activation/withdrawal
   methods for reversible changes.
5. Verify the selected public URL and bytes in the real Worker, then inspect
   county and curated homepage appearance. Record method, bytes, MIME, digest,
   browser dimensions and cache result. A source-only build or synthetic local
   test is not hosted rendering evidence.

BANNERS-3 itself does not provision a hosted bucket, import real images, activate
records, deploy a Site version, or certify hosted rendering.

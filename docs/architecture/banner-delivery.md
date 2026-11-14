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

Homepage display is opt-in: `homepage_order` is null by default. Only an
explicitly curated active/verified record may appear there. County order and
primary selection remain independent. The static presentation renders the
first eligible selected record; it does not rotate.

The checked-in Sites hosting manifest retains `r2: null`, because the platform
documentation does not specify a deployable R2 binding declaration and the
existing project has not provisioned one. Source/runtime compatibility is
prepared using the optional `BUCKET` binding. To continue in BANNERS-IMPORT-1,
ask Sites to add R2 object storage to the existing project while retaining the
existing `DB` D1 binding, and bind the bucket as `BUCKET`. Do not create another
Site or guess a bucket identifier. Rebuild and inspect the produced hosting
manifest after Sites reports the binding; if the platform cannot attach it,
keep the current null binding and use no live import.

## BANNERS-4 — static data to accessible carousel

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

**Controls and accessibility.** With two or more images, expose native Previous,
Next, Pause and Play buttons with accessible names, visible keyboard focus and
logical tab order. Announce the current item through a concise polite status.
Do not auto-rotate when `prefers-reduced-motion: reduce` is active. Pause on
focus, hover, pointer interaction, page visibility loss and explicit Pause; do
not resume after a visitor explicitly paused. Play starts rotation only on
explicit request. A reasonable default is 8 seconds, configurable through a
bounded data attribute.

**Layout and failure behavior.** Preserve the 3:1 frame, reserved caption area,
current cover/contain and focal classes, responsive overlays and branded
placeholder. Keep the frame dimensions stable. If an image fails, show the
placeholder and advance only through the explicit controls; never expose an
unverified or withdrawn URL. Zero images retain the current placeholder and no
controls; one image has no cycling controls; multiple images expose controls.

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

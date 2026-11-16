# Banner administration service (BANNER-ADMIN-1)

This is the first implementation slice of the banner administration design in draft PR #127. It adds a shared async contract, bounded county and version reads, an image inspector and a D1-backed staging adapter. It adds no route, page, migration, publish, restore or withdraw operation, and it reads no real artwork. It was verified only against the isolated Wrangler local D1 with synthetic images. Nothing here is deployed or verified on the hosted Site.

## What was added

- `src/contracts/banner-administration.ts` is the `BannerAdministration` interface. No input carries an actor. The trusted principal is passed separately. No result carries an object key.
- `src/services/banner-admin-d1.ts` is `D1BannerAdministration`. It implements `listCounties`, `getCounty`, `stage` and a read-only `reconcileBanner` over `AsyncD1Database` and the existing `ImmutableObjectStorage` interface.
- `src/services/banner-image-inspector.ts` checks byte, type and pixel limits, derives dimensions and SHA-256 from the supplied bytes and decodes PNG files completely.

## Staging rules

- Every call needs `banner.manage`. The adapter checks the claimed role and then the live account and identity rows. Every write runs through `guardedBatch`, which reasserts the principal and the dependency generation inside the same atomic batch. A principal revoked between the check and the batch cannot finish the write.
- Staging never selects a version and never edits an existing banner row. A new version of an existing banner carries no caption, alt text or other metadata, so the live text and the row version cannot change. A new banner is created as a private draft with its first metadata and requires non-blank alt text.
- Width, height, media type, byte size and digest come from the inspected bytes. A client digest is optional and must match. A caller cannot supply dimensions.
- Object keys are `banner-assets/<version id>` and never come from a request. Object metadata uses the existing `sha256` and `versionId` keys, which the public reader requires, plus `mediaType` and `operationId`.
- The idempotency fingerprint covers the acting account, banner, county, source filename, target and digest. The same key with the same request returns the stored result. The same key with anything different is a conflict.
- A storage or reread failure marks the version `failed` and the operation `interrupted`. A retry with the same key reuses the same version and key. If authority is lost after the object was written, the version stays in `staging` with its object present. It is never finalized, and `reconcileBanner` classifies it as an unverified object.

## Decode status and what remains

A PNG becomes `verified` only after the server has decoded every row (chunk checksums, the zlib stream, exact decoded length and every row filter) within hard limits. Interlaced PNG is refused. A JPEG is checked structurally and stored, but the result is `staged` with `decode: "not_performed"`, because no bounded Worker-compatible JPEG decoder exists in this slice. The database refuses to select a version that is not `verified`, so a staged JPEG cannot go public.

To let JPEG uploads become verified, one of these is still needed. Each is a separate decision:

1. Add a bounded baseline and progressive JPEG decoder with Worker-safe memory limits. Adding the maintained `jpeg-js` package as a runtime dependency would be the shortest path but changes the repository’s no-runtime-dependency posture.
2. Convert the upload in the browser to PNG and stage that. This changes what bytes are retained as the original.
3. Accept a PNG-only banner policy.

The inspector bounds are 25 MiB, 16 million pixels, 12,000 pixels per side and 96 MiB of decoded data. They have not been tuned against the Workers memory limit or against hosted request-size limits.

## Restoring old bytes does not restore old text

A version row holds image facts only. Caption, alt text, display mode and focal point live on the banner row and are shared by all versions. A later restore of an earlier version therefore brings back the earlier image with the current caption and alt text, which may describe a different picture. The publish and restore PRs must either restore text explicitly, show the difference and require confirmation, or store text with each version. The last option needs a schema change, which this slice does not make.

## Running the checks

`npm run test:d1` runs the banner checks in the isolated Wrangler local D1 with an in-memory R2 stand-in. `npm test` runs the image inspector unit tests.

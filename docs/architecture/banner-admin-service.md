# Banner administration service (BANNER-ADMIN-1)

This is the first implementation slice of the banner administration design in draft PR #127. It adds a shared async contract, bounded county and version reads, an image inspector and a D1-backed staging adapter. It adds no route, page, migration, publish, restore or withdraw operation, and it reads no real artwork. It was verified only against the isolated Wrangler local D1 with synthetic images. Nothing here is deployed or verified on the hosted Site.

## What was added

- `src/contracts/banner-administration.ts` is the `BannerAdministration` interface. No input carries an actor. The trusted principal is passed separately. No result carries an object key.
- `src/services/banner-admin-d1.ts` is `D1BannerAdministration`. It implements `listCounties`, `getCounty`, `stage` and a read-only `reconcileBanner` over `AsyncD1Database` and the existing `ImmutableObjectStorage` interface.
- `src/services/banner-image-inspector.ts` checks byte, type and pixel limits, derives dimensions and SHA-256 from the supplied bytes and decodes PNG and JPEG files completely.

## Staging rules

- Every call needs `banner.manage`. The adapter checks the claimed role and then the live account and identity rows. Every write runs through `guardedBatch`, which reasserts the principal and the dependency generation inside the same atomic batch. A principal revoked between the check and the batch cannot finish the write.
- Staging never selects a version and never edits an existing banner row. A new version of an existing banner carries no caption, alt text or other metadata, so the live text and the row version cannot change. A new banner is created as a private draft with its first metadata and requires non-blank alt text.
- Width, height, media type, byte size and digest come from the inspected bytes. A client digest is optional and must match. A caller cannot supply dimensions.
- Object keys are `banner-assets/<version id>` and never come from a request. Object metadata uses the existing `sha256` and `versionId` keys, which the public reader requires, plus `mediaType` and `operationId`.
- The idempotency fingerprint covers the acting account, banner, county, source filename, target and digest. The same key with the same request returns the stored result. The same key with anything different is a conflict.
- A storage or reread failure marks the version `failed` and the operation `interrupted`. A retry with the same key reuses the same version and key. If authority is lost after the object was written, the version stays in `staging` with its object present. It is never finalized, and `reconcileBanner` classifies it as an unverified object.

## Decode status and what remains

A version becomes `verified` only after the server has decoded the image within hard limits. A PNG is decoded by code in this repository (chunk checksums, the zlib stream, exact decoded length and every row filter). Interlaced PNG is refused. A JPEG is decoded by the `jpeg-js` package, which the owner approved as a runtime dependency on this slice. It runs with typed arrays only, so it needs no `Buffer`, with strict decoding (tolerant mode off, so truncated or corrupt data is refused), a megapixel cap and a memory cap, and the decoded size must match the frame header. Only baseline and progressive Huffman 8-bit JPEG with one or three components is accepted. Arithmetic, lossless and other variants are refused.

The inspector bounds are 25 MiB, 16 million pixels, 12,000 pixels per side and 96 MiB of decoded data.

What is verified and what is not:

- The local Wrangler Worker runtime (workerd) bundled and ran the decoders in the D1 checks, so no Node-only global is needed.
- Decoding is synchronous and CPU heavy. A noisy 2048 by 682 JPEG took about 1.2 seconds in Node. Whether that fits the hosted Worker CPU limit is not verified, and a larger image could exceed it. Measure on the hosted Site before accepting real uploads, and lower the pixel cap if needed.
- Only baseline JPEG was exercised, because the available encoder cannot write progressive files. The progressive path is untested here.
- The limits have not been tuned against Workers memory or hosted request-size limits.
- `jpeg-js` is a new runtime dependency and the `jpeg-js` and Worker bundle sizes were not measured against Sites limits.

## Restoring old bytes does not restore old text

A version row holds image facts only. Caption, alt text, display mode and focal point live on the banner row and are shared by all versions. A later restore of an earlier version therefore brings back the earlier image with the current caption and alt text, which may describe a different picture. The publish and restore PRs must either restore text explicitly, show the difference and require confirmation, or store text with each version. The last option needs a schema change, which this slice does not make.

## Running the checks

`npm run test:d1` runs the banner checks in the isolated Wrangler local D1 with an in-memory R2 stand-in. `npm test` runs the image inspector unit tests.

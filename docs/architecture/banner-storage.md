# Durable county banner storage (BANNERS-2)

This milestone added the Website-side private metadata and staging foundation. BANNERS-3 adds a read-only public integration; it does not load a real source image, provision a hosted bucket, or perform a live import.

## Data and storage

Migration `0012_banner_assets.sql` adds:

- `banner_assets`: stable logical identity, county FIPS foreign key, source filename, public display metadata, lifecycle status, selected immutable version, actor attribution, and optimistic row version.
- `banner_asset_versions`: append-only image provenance, SHA-256, original geometry and byte size, media type, immutable object key, verification evidence, and previous-version lineage. Version identity and binary facts cannot be edited or deleted.
- `banner_stage_operations`: idempotency key, request fingerprint, actor, and durable state for each staged or reused version.

The image bytes belong in an R2-compatible object store; D1 holds the metadata and lifecycle state. Source names are provenance only. The complete BANNERS-1 source-version list is retained as private manifest provenance; versions that were never staged do not gain fabricated storage records. Keys are generated as `banner-assets/<random-version-id>` and are independent of filenames and user-provided banner IDs. R2 writes use an atomic conditional create (`etagDoesNotMatch: "*"`); ETags are not used as content digests. The adapter always rereads stored bytes and independently checks SHA-256, size, and operation metadata.

`MemoryBannerObjectStorage` is a disposable test adapter. `R2BannerObjectStorage` accepts a Workers R2 binding and does not configure a bucket or credentials. The owner source directories are not read by this service.

## State flow

Normal stage: `pending → staging → staged → verified`. A storage or integrity failure leaves the image version `failed` and operation `interrupted`; retry moves the same operation and immutable key back through staging. Operations may then become `activated`. Reconciliation is read-only and classifies missing objects, unverified database state, corrupt objects, orphaned keys, and verified unchanged objects. It never deletes or selects anything.

Verification and selection are separate. Stage cannot change the selected version. `activate` changes the pointer only after the new bytes are verified and requires the current row version. `withdraw` changes only the logical status. `restore` verifies retained bytes again before switching the pointer. Historical versions and their keys remain available. `resolveCounty` returns only active, selected, verified versions whose current bytes still match the recorded digest; an empty list is the frontend fallback.

Metadata updates are audited and version-checked. Per-county display order is unique; `reorderCounty` requires every banner in the county and all expected versions, then writes through a collision-free temporary order. `updateMetadata` can transfer the primary designation atomically. Counties without any banner remain valid.

## Authorization and database protection

The internal service rechecks the current trusted principal and requires `banner.manage`, currently granted only to administrators and the owner. Contributors and editors are denied. No caller-supplied actor ID is accepted. Audit events reference the actor account and contain banner/version IDs and image hashes, not local paths or credentials.

Migration 0012 adds dependency-generation triggers for all three banner tables, extending the existing 0011 guarded-D1 snapshot invalidation from 66 to 75 triggers. All three new tables are covered. This is a generation guard, not a universal SQL authorization gate; the mutation service remains internal and no public route is registered. Cross-service R2/D1 operations are not atomic.

## BANNERS-1 compatibility

`translateBanners1Record` accepts the existing manifest record layout (`bannerId`, `countyFips`, source filename, dimensions, SHA-256, full-decode result, and editable metadata) without changing the manifest format. It rejects missing, undecoded, malformed, or unresolved county records. Stage compares the manifest digest to the supplied original bytes. Missing-source records cannot become withdrawals. Duplicate content attached to a different logical banner is flagged as a conflict for owner review.

## BANNERS-3 integration

Use `BannerAssetService.resolveCounty(fips)` as the internal resolver shape:

```ts
Promise<readonly ResolvedBanner[]>
```

Each result contains `bannerId`, `countyFips`, `versionId`, `assetRef`, `caption`, `altText`, `displayMode`, `focalX`, `focalY`, `displayOrder`, `isPrimary`, `width`, and `height`. It contains no source path, staging details, audit data, or credentials. The hosted async adapter keeps this projection, checks R2 bytes, and serves a version-specific route. See [banner-delivery.md](banner-delivery.md) for lifecycle, delivery and follow-on contracts.

## Local verification and limits

Run `npm test` and `npm run test:d1`. The former exercises synthetic PNGs and disposable SQL.js; the latter applies migrations through isolated Wrangler local D1. These tests do not establish hosted D1/R2 behavior, remote consistency, cache behavior, or a production upload workflow. The R2 adapter follows the documented conditional Workers binding operations, but no bucket was accessed. Original artwork has not been transformed or uploaded.

Cloudflare references: [Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and [R2 consistency and conditional writes](https://developers.cloudflare.com/r2/reference/consistency/).

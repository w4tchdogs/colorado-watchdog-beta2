# Banner administration API (BANNER-ADMIN-3)

This is the dashboard author’s contract for `/api/admin/banners/*`. The protected routes ship in the deployed Worker. Cloudflare staging has a hosted-verified human owner session and a verified storage-level R2 round trip. [R2-1 staging receipt](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137#issuecomment-6933294436) verifies the protected stage, private preview, publication, public readback and withdrawal flow with a synthetic PNG. The original Sites deployment has human sign-in disabled, and its `BUCKET` attachment and object inventory are unverified. See [CURRENT](../coordination/CURRENT.md#d-deployment-state-separate-from-source). The transport is `src/transport/banner-admin-api.ts`. It is a thin adapter over the `BannerAdministration` contract in `src/contracts/banner-administration.ts`, implemented by `D1BannerAdministration`. The design is in the dashboard brief of design PR #127 and the service rules are in [banner-admin-service.md](banner-admin-service.md).

## Rules that apply to every route

- Authentication uses the existing trusted principal resolver. An unauthenticated caller gets `401 authentication_required`. The transport adds no sign-in and no bypass.
- Every route, including the image preview and reconcile, requires the `banner.manage` capability. A caller without it gets `403 forbidden`. The service then rechecks the live account and identity, and the write batch reasserts them, so a caller revoked after the first check still cannot finish a write. That case is also `403 forbidden` and changes nothing.
- The actor is always the server’s principal. No route accepts an actor ID, an object key, a path, SQL or a table name. Any unexpected field is `400 invalid_request`. Object keys never appear in a response.
- A write from a browser must carry an `Origin` header exactly equal to the request origin. A missing or different origin is `403 origin_rejected`. An agent that presents its own bearer credential sends no `Origin` and is exempt. A human principal is never exempt, even with an `Authorization` header.
- Every JSON response is `no-store` with `x-content-type-options: nosniff`. Errors have the form `{ "error": "<code>" }`. Some add `detail` (a safe message) or `reason`.
- Banner IDs match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`. The words `counties`, `versions` and `stage` are reserved. County FIPS is five digits starting `08`. Version and publication IDs match `^[A-Za-z0-9_-]{1,128}$`.
- Every write needs an `idempotencyKey` (1 to 200 characters, not blank) and, except stage of a new banner, an `expectedRowVersion` (an integer of 1 or more) taken from the last read. Generate a key once per attempt and reuse it on a retry.
- JSON bodies are `application/json` and at most 64 KiB. Query strings are refused except on the county list.

MCP agents publish, withdraw and restore through the Website MCP banner tools, which call the same service under the separate `banner.publish` agent grant. That grant does not open any route here. See [mcp-administration.md](mcp-administration.md#banner-tools-mcp-3).

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/admin/banners/counties?query=&limit=&afterFips=` | County list with banner counts. `limit` is 1 to 100 (default 25). Returns `{ counties: [{ fips, name, bannerCount, publicBannerCount, attentionVersionCount }], nextAfterFips? }` |
| `GET /api/admin/banners/counties/<fips>` | County detail. Returns `{ county, banners, bannersTruncated }`. Each banner has its metadata, `rowVersion`, `selectedVersionId`, `publicEligible` and `versions` (newest first, at most 20, with `versionCount` and `versionsTruncated`). `404 not_found` for an unknown county |
| `GET /api/admin/banners/<bannerId>/publications` | Bounded publication history, newest first, at most 50. Returns `{ publications: [{ id, versionId, sequence, origin, restoredFromPublicationId, caption, altText, displayMode, focalX, focalY, bannerRowVersion, publishedByAccountId, publishedAt }] }`. `origin` is `publish`, `restore_recorded`, `restore_explicit` or `metadata_edit` |
| `GET /api/admin/banners/<bannerId>/reconcile` | Read-only. Returns `{ items: [{ versionId, state, classification }] }`. Classifications are `verified_unchanged`, `verified_object_missing`, `staging_object_missing`, `stored_object_integrity_failed` and `object_present_unverified_database_state` |
| `GET /api/admin/banners/versions/<versionId>/image` | Private preview bytes. See below |
| `POST /api/admin/banners/stage` | Stage an image. See below |
| `POST /api/admin/banners/<bannerId>/publish` | Body `{ versionId, expectedRowVersion, idempotencyKey, metadata? }`. `metadata` is `{ caption, altText, displayMode, focalX, focalY }` and omitting it keeps the banner’s current text. Alt text must not be blank. Returns a change result |
| `POST /api/admin/banners/<bannerId>/withdraw` | Body `{ expectedRowVersion, idempotencyKey }`. Only an active banner can be withdrawn. Returns a change result |
| `POST /api/admin/banners/<bannerId>/restore` | Body `{ versionId, expectedRowVersion, idempotencyKey, publicationId? , metadata? }`. Without either optional field the version’s latest recorded publication is used. `publicationId` and `metadata` are mutually exclusive. A version with no recorded publication needs explicit `metadata` and otherwise gets `409 snapshot_required`. Returns a change result |
| `POST /api/admin/banners/<bannerId>/metadata` | Body `{ expectedRowVersion, idempotencyKey, change }`. `change` has at least one of `caption`, `altText`, `displayOrder`, `homepageOrder` (or null), `isPrimary`, `displayMode`, `focalX`, `focalY`. Returns a change result |
| `POST /api/admin/banners/counties/<fips>/reorder` | Body `{ idempotencyKey, orderedBannerIds, expectedRowVersions }`. Every banner of the county exactly once and one expected version for each. Returns `{ countyFips, banners: [{ bannerId, displayOrder, rowVersion }], replayed }` |

A change result is `{ bannerId, status, selectedVersionId, rowVersion, publicationId, replayed }`. Use the returned `rowVersion` for the next write. `replayed: true` means the same request had already completed and nothing changed this time.

### Stage

`POST /api/admin/banners/stage` sends the image as the raw request body so that large uploads are never buffered twice. The `Content-Type` must be `image/png` or `image/jpeg` and the body at most 25 MiB. The limit is enforced on the bytes actually received, whatever `Content-Length` says. A compressed `Content-Encoding` is refused. The fields travel in the `x-banner-stage` header as base64url of this JSON (at most 8 KiB):

```json
{
  "bannerId": "string",
  "countyFips": "08001",
  "sourceFilename": "provenance only, never a path",
  "idempotencyKey": "string",
  "expectedSha256": "optional 64 hex characters, must match the bytes",
  "decodeAttestation": "optional, only \"owner_local_full_decode\", needs expectedSha256",
  "target": { "kind": "new", "metadata": { "caption": "", "altText": "required", "displayOrder": 0, "isPrimary": true, "homepageOrder": null, "displayMode": "cover", "focalX": 0.5, "focalY": 0.5 } }
}
```

For a new version of an existing banner use `"target": { "kind": "existing", "expectedRowVersion": 3 }`. That never changes the live caption or alt text. Staging never selects the image and never makes it public. Success is `201` with `{ bannerId, version, bannerRowVersion, replayed, decode, verified, note? }`, or `200` with `replayed: true` for an identical retry. A failed stage can be retried with the same key.

**Decode attestation (BANNERS-IMPORT-1).** The Worker normally decodes every pixel of a JPEG or PNG before it will mark a version `verified`. On the Workers Free plan that pure JavaScript JPEG decode can exceed the 10 ms CPU limit, so the stage call fails with a Cloudflare 503. For the owner’s approved import, where the BANNERS-1 inventory already recorded `full_decode_passed`, a JPEG stage may send `decodeAttestation: "owner_local_full_decode"` together with `expectedSha256`, the manifest digest. The Worker then still checks the byte limit, the JPEG signature and header, the pixel limits and the end marker, and still computes the SHA-256. It refuses the request with `422 validation_failed` unless that digest equals `expectedSha256`, and it refuses an attestation on a PNG. Only the pixel decode is skipped. The version is `verified` and carries `decode: "attested_local"` in the response and in its stored verification record, which also holds a note that the Worker decode was skipped, so the skip is auditable. The normal publish, withdraw and restore workflow is unchanged. Without the field the behavior is exactly as before. The field needs `banner.manage` like every stage call and an attestation is part of the idempotency fingerprint.

### Private preview

`GET /api/admin/banners/versions/<versionId>/image` resolves the ID to its D1 record and internal object key, and serves bytes only for a `verified` PNG or JPEG version, including one that is not publicly selected. It checks size, SHA-256, recorded object metadata and the file signature before sending. The response is `private, no-store` with `x-content-type-options: nosniff`, a `content-disposition: inline`, `content-security-policy: default-src 'none'; sandbox` and `cross-origin-resource-policy: same-origin`. An unknown or unverified version is `404 not_found`. A missing or corrupt object is `409 object_verification_failed`. A storage fault is `503 storage_failed`. Public delivery at `/banner-assets/<versionId>` is unchanged and still serves only the selected verified version of an active banner.

## Error codes

| Status | `error` | Meaning and what the dashboard should do |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed, unexpected field, wrong type or bad ID. A bug in the caller |
| 400 | `unexpected_query` | A query string where none is allowed |
| 401 | `authentication_required` | Not signed in |
| 403 | `forbidden` | Missing `banner.manage`, or authority lost during the write |
| 403 | `origin_rejected` | Browser write from the wrong or missing origin |
| 404 | `not_found` | Unknown route, county, version or unverified version |
| 405 | `method_not_allowed` | The `allow` header names the method |
| 409 | `stale_version` | Someone changed the banner. Reload and let the user decide again |
| 409 | `idempotency_conflict` | The key was already used for a different request. Make a new key |
| 409 | `snapshot_required` | Restore needs explicit `metadata` because the version has no recorded publication |
| 409 | `version_not_publishable` | The version is not a verified version of this banner |
| 409 | `object_verification_failed` | The stored image is missing or failed its size, digest or metadata check. Run reconcile |
| 409 | `duplicate_image` | The same image is already attached to another banner. Needs owner review |
| 409 | `order_conflict` | Display order, homepage order or primary flag collides with another banner |
| 409 | `banner_exists`, `banner_not_found`, `publication_mismatch`, `invalid_state`, `needs_reconciliation`, `conflict` | Other conflicts. `detail` has a safe explanation |
| 413 | `request_too_large`, `image_too_large` | Body over its limit |
| 415 | `unsupported_media_type`, `unsupported_image_type` | Wrong `Content-Type`, or bytes that are not PNG or JPEG |
| 422 | `validation_failed` | A service rule failed (for example blank alt text). `detail` explains |
| 422 | `invalid_image` | `reason` is `empty`, `malformed`, `dimensions_exceeded` or `decode_failed` |
| 503 | `storage_failed`, `finalize_failed` | Storage or the final write failed. `retryable: true`. Retry with the same key |
| 503 | `dependency_unavailable` | The database or identity lookup failed |
| 503 | `banner_admin_unavailable` | A binding is missing. See below |
| 500 | `internal_error` | Unexpected. Nothing internal is exposed |

## Worker wiring and unavailable behavior

The Worker routes `/api/admin/banners` and everything below it before the public site. With no `DB` binding every such request is `503 banner_admin_unavailable`. With `DB` but no `BUCKET`, the request is authenticated and authorized first and then answered `503 banner_admin_unavailable`, so an anonymous caller learns nothing about bindings. Public pages and `/banner-assets/*` are unaffected in both cases.

## Hosted acceptance

The staging owner session exercised same-origin writes, idempotent staging, byte-identical private preview and public readback, private preview cache controls, and audited withdrawal. The served Adams county HTML reflected publication and withdrawal. The fixture remains withdrawn with its audit history. See the [R2-1 staging receipt](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/137#issuecomment-6933294436) for the pinned Worker and source. Wrong-origin write denial, larger uploads, progressive JPEGs and browser-rendered appearance remain unverified. The hosted Banners dashboard needs its own wiring and verification. Track the original Sites binding and inventory in [Issue #122](https://github.com/w4tchdogs/colorado-watchdog-beta2/issues/122).

# Administrative MCP foundation

This change adds two read-only MCP surfaces for local development and later
operator evaluation. It does not publish the Site, apply a migration, connect
to a hosted database, or import profile data.

## Website inspection

The Sites Worker exposes `POST /mcp` using the Sites protocol version
`2026-07-28`: `server/discover`, `tools/list`, and `tools/call`. Discovery is
public. Calls require an existing Website-agent bearer credential resolved by
the established account service and the `d1.inspect` capability. The handler
does not accept an actor identity from request parameters or trust injected
identity headers. Website Owner and Administrator roles receive the capability;
Agent Owner credentials are explicitly refused.

**Inspection-only grant (MCP-2).** Migration `0025_agent_inspect_grant.sql` lets the existing owner-only, audited agent capability grant carry `d1.inspect`. A contributor agent holds no role capability, so with only that grant its credential passes the MCP inspection gate and nothing else: it holds no account, identity, audit, checkpoint, banner, content, report or sync capability, and the grant is checked in the same account service the dashboard and Website API use. Grants are retained after revocation. Revoking the grant, the credential or the account removes access. Issue the credential from the account dashboard or `PUT /api/admin/accounts/{id}/capabilities` and `POST .../credentials` as the Website Owner.

The fixed tools report inspection status, county reference counts, migration
history, and county provenance summaries for Lake (`08065`) or La Plata
(`08067`). They expose aggregate counts only. They do not accept SQL, table
names, arbitrary counties, record identifiers, or write operations. Sensitive
report counts below five are suppressed. Query failures produce unavailable
status rather than partial raw data.

Migration comparison uses a build-time catalog of migration names and hashes.
The catalog is computed from the checked-in files during the Sites Worker
build. The service only reads `schema_migrations`; it never repairs or writes
the ledger. The physical database identity is reported as unavailable because
the binding does not provide a trustworthy physical identity. County FIPS
values alone are not treated as proof of how a record was assigned, so
provenance remains unresolved unless the schema supplies explicit evidence.

The repository's `.openai/hosting.json` declares the MCP capability for a
future authorized Sites publication. A source declaration does not enable a
hosted MCP endpoint until the Site is configured and published. The current
Sites connection lookup did not establish the target project's identity, so no
hosted database was inspected and no publication was attempted.

## Profiles readiness

`npm run profiles:mcp` starts an MCP stdio server using the official TypeScript
SDK. `profiles_readiness_summary` launches only the fixed Python
`mcp-readiness-summary` command. The database path must be supplied through
`WATCHDOG_PROFILES_DATABASE` and point outside the repository. The subprocess
uses a bounded execution time and output size, with a restricted environment;
the MCP caller cannot pass a path, SQL, or command arguments.

The Python command opens the database read-only and previews the existing
Colorado County sync mapping without emitting names, record IDs, notes,
evidence URLs, filesystem paths, or generated requests. It returns aggregate
eligibility and exclusion counts and whether a read-only preview is possible.
This is a readiness report, not an import or synchronization action.

## Verification and operational boundary

The MCP tests use synthetic local databases. They verify Sites discovery and
authorization, static bounded tool arguments, migration drift detection,
sensitive-count suppression, aggregate profile output, and unchanged database
fingerprints. Neither interface authorizes an import, publication, migration,
or other write operation.

Native Sites MCP is the intended route for a published Site where the Sites
platform is configured for MCP. ChatGPT custom remote MCP connections are
available only in supported plans and workspaces and require the relevant
administrator configuration. Codex can run the Profiles server locally over
stdio; an API-hosted agent that needs a private local MCP server would require
the separately configured Secure MCP Tunnel. These are platform connection
options, not deployment authorization.

No R2 inspection tools, profile write/sync tools, Posts and Stories tools,
migrations, owner creation, or public-profile actions are included. Their
interfaces and authorization remain separate future work. The banner tools
below are the only MCP write tools.

## Banner tools (MCP-3)

The Website MCP endpoint also carries five banner tools. Every one of them calls the existing `BannerAdministration` service (`D1BannerAdministration` over D1 and the R2 `BUCKET`), the same service the protected banner API and the dashboard use. Image staging and private preview stay on the protected banner API.

| Tool | Arguments | Result |
| --- | --- | --- |
| `website_banner_county` | `countyFips`, optional `bannerId` | County, banners with `rowVersion`, `status`, `selectedVersionId`, `publicEligible`, publication text, order flags and up to 20 newest versions (`id`, `state`, `isSelected`, media type, size, dimensions, SHA-256, dates) |
| `website_banner_publications` | `bannerId` | Up to 50 publication records, newest first, with `id`, `versionId`, `sequence`, `origin`, `restoredFromPublicationId`, text, `bannerRowVersion` and `publishedAt` |
| `website_banner_publish` | `bannerId`, `versionId`, `expectedRowVersion`, `idempotencyKey`, optional `metadata` | Change result |
| `website_banner_withdraw` | `bannerId`, `expectedRowVersion`, `idempotencyKey` | Change result |
| `website_banner_restore` | `bannerId`, `versionId`, `expectedRowVersion`, `idempotencyKey`, optional `publicationId` | Change result |

A change result is `{ bannerId, status, selectedVersionId, rowVersion, publicationId, replayed }`. Restore through MCP uses recorded publications only. Restoring a version that was never published needs explicit text and stays on the protected API. Results never carry an object key, source filename, staging actor or publishing account. Errors use the protected API’s codes (`stale_version`, `idempotency_conflict`, `version_not_publishable`, `invalid_state`, `publication_mismatch`, `snapshot_required`, `object_verification_failed`, `validation_failed` and the rest) plus `authentication_required`, `not_authorized`, `invalid_arguments`, `not_found` and `banner_admin_unavailable`.

**Permission scope.** Every banner tool, reads included, needs the `banner.publish` capability. No role holds it. Migration `0026_agent_banner_publish_grant.sql` lets the existing owner-only, audited agent capability grant carry it, so it reaches an agent only through an active grant issued by the Website Owner. Agent Owner credentials are refused as for inspection. `banner.publish` grants nothing else. It is not `banner.manage`, so the protected banner API still answers `403` to a credential that holds only `banner.publish`: it cannot stage, read a private preview, reconcile, edit metadata or reorder. The service accepts the grant only for county and history reads, publish, withdraw and restore, and checks the live account, identity and grant before each call. Inside the write batch the account, identity, role and grant are reasserted, so a grant or credential revoked after the check cannot finish a write. A `d1.inspect` credential cannot call any banner tool, and `banner.publish` cannot call the inspection tools. Human sessions and agents that hold `banner.manage` by role also need the explicit grant to use MCP.

**Inputs.** Each tool has a closed schema. IDs use the protected API patterns, county FIPS is five digits starting `08`, row versions are positive integers and idempotency keys are 1 to 200 non-blank characters. Actor IDs, object keys, paths, URLs, SQL and any extra field are refused as `invalid_arguments`. The protocol `2026-07-28` `params._meta` envelope is accepted and ignored, as for the inspection tools. It is never used for identity. The actor is always the trusted principal resolved from the bearer credential, and every change keeps the service’s expected row versions, idempotency ledger and audit records.

### Operator example

Stage through the protected API with a credential that holds `banner.manage`. Use MCP with a separate agent credential that holds only the `banner.publish` grant.

1. Stage. `POST /api/admin/banners/stage` with `Authorization: Bearer <stager credential>`, `Content-Type: image/png`, the image bytes as the body and the `x-banner-stage` header (base64url JSON with `bannerId`, `countyFips`, `sourceFilename`, `idempotencyKey`, optional `expectedSha256` and `target`). Check `verified: true` in the `201` response and note `version.id`. Preview the bytes at `GET /api/admin/banners/versions/<versionId>/image` if needed.
2. Look up. Call `website_banner_county` with `{ "countyFips": "08001", "bannerId": "<bannerId>" }`. Note `rowVersion` and confirm the version is `verified`.
3. Publish. Call `website_banner_publish` with `{ "bannerId": "<bannerId>", "versionId": "<versionId>", "expectedRowVersion": <rowVersion>, "idempotencyKey": "<new key>" }`. If the response is lost, repeat the identical call with the same key. `replayed: true` means it had already completed.
4. Read back. Call `website_banner_county` again and `website_banner_publications`. The public page and `/banner-assets/<versionId>` now serve the version.
5. Reverse. Call `website_banner_withdraw` with the latest `rowVersion` and a new key to take the banner out of public view. To put an earlier recorded publication back, call `website_banner_restore` with its `versionId`, optional `publicationId` from the history, the latest `rowVersion` and a new key.

A `stale_version` error means someone else changed the banner. Read it again and decide again with a new key.

**Verification.** `tests/mcp-banner-tools.test.mjs` runs the built Worker with a synthetic database and an in-memory bucket. `tests/d1/banner-mcp-checks.mjs` runs inside `npm run test:d1` against an isolated local Wrangler D1, including a grant revoked between the permission check and the write batch. Hosted MCP banner acceptance has not been run. Cloudflare staging needs migration 0026 applied and an owner-issued `banner.publish` grant first.

## Profiles sync tools (MCP-3)

The Website MCP endpoint carries four Profiles sync tools. They are a thin typed layer over the hosted sync transport from PR #179 and the set-based planner and commit from PR #193. The MCP handler authenticates the bearer credential, checks the tool’s grant, and then runs the same transport in process for that principal. Request validation, the live per-operation grant check, batch ownership, dependency and version checks, the atomic write, same-key replay and the durable receipt are the existing ones. The tools read and write nothing themselves.

| Tool | Grant | Arguments | Result |
| --- | --- | --- | --- |
| `website_sync_dry_run` | `sync.read` | `changeset`, optional `itemOffset`, `itemLimit` | `eligible`, `itemCount`, `counts` by entity and action, one page of items, `nextItemOffset`, `errors` (at most 200) and `duplicateFlags`. Writes nothing |
| `website_sync_commit` | `sync.apply` | `idempotencyKey`, `changeset`, optional `itemOffset`, `itemLimit` | `status`, `batchId`, `requestId`, `committedAt`, `replayed`, `itemCount`, `counts` and the first page of items. A rejected changeset returns an error result `commit_rejected` with the transport’s coded errors |
| `website_sync_lookup` | `sync.read` | exactly one of `batchId` and `idempotencyKey`, optional `itemOffset`, `itemLimit` | `status` (`committed` or `reverted`), `batchId`, `committedAt`, `reversedAt`, `itemCount`, `counts` and one page of items. Another account’s batch is `batch_not_found` |
| `website_sync_reverse` | `sync.revert` | `batchId`, `idempotencyKey` | `reverted`, `already_reverted` or `reversal_blocked`, with the stored receipt fields |

**Receipt compatibility.** The `changeset` argument is the prepared `m2-sync/v1` request exactly as `sync-prepare` stores it, and the items carry the same fields as the REST receipt (`itemIndex`, `clientRef`, `entity`, `websiteId`, `version`, `outcome`). A client that needs the complete receipt for `sync-reconcile` reads every page with `website_sync_lookup`. Pages hold 100 items by default and at most 250. A prepared request with intent `commit` can be sent to `website_sync_dry_run` unchanged. It is planned as a dry run, and `website_sync_commit` still requires intent `commit`.

**Payload size.** Discovery, inspection and banner calls keep the 24 KiB request cap. A body over 24 KiB is read only when the bearer credential resolves to an agent that holds `sync.read` or `sync.apply`, and then only up to 2 MiB counted on the bytes actually received, whatever the declared length. It is accepted only for `website_sync_dry_run` and `website_sync_commit`, and each tool still needs its own grant. Anything else gets `413 request_too_large` before the body is parsed. The synthetic 816-operation changeset is about 166 KB and the isolated Adams preview was about 245 KB, both inside the cap. Results are limited to 192 KiB, and a larger result is refused with `result_too_large` and never cut short.

**Permission scope.** No role holds `sync.read`, `sync.apply` or `sync.revert`. They reach an agent only through an active grant issued by the Website Owner, and Agent Owner credentials are refused as for the other tools. Tool errors are `authentication_required`, `not_authorized`, `invalid_arguments`, `batch_not_found`, `commit_rejected`, the transport’s codes such as `invalid_request`, `unsupported_contract_version` and `item_too_large`, `sync_unavailable` and `sync_failed`.

**Verification.** `tests/mcp-sync-tools.test.mjs` runs the built Worker with a synthetic database and the 816-operation fixture. `tests/d1/sync-mcp-checks.mjs` runs inside `npm run test:d1` against an isolated local Wrangler D1. Hosted acceptance has not been run.


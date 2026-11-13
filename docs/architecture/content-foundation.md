# Native Posts and Stories foundation

Migration `0009_content_foundation.sql`, `src/contracts/content.ts` and `src/services/content.ts` add the first internal content model. They add no routes, editor, publication, media or WordPress integration. The service is not registered in `ApplicationServices`, the Worker or MCP.

## Model

One `content_items` table holds both Posts and Stories (`content_type` is `post` or `story`). Each row has a Website-generated ID, title (up to 200 characters), optional summary (up to 500), Markdown source body (up to 200,000 bytes), `draft` or `archived` status, integer version, original author account, last editor account, and creation, modification and archive timestamps. The type, original author and creation time are immutable, and SQL triggers enforce one-step version increments.

Bodies are Markdown source text only. Raw HTML is stored inert and is never trusted. Any future renderer must escape or strip it.

Three link tables (`content_item_counties`, `content_item_people`, `content_item_organizations`) hold explicit county FIPS, Website person ID and Website organization ID references with restrictive foreign keys. They provide navigation and context only. They never assert employment, identity or a personnel fact, and nothing is derived from names. At most 50 targets of each kind per item.

## Service behavior

`createContentService(database, { authorize })` provides `createDraft`, `getDraft`, `updateDraft`, `setRelationships`, `listDrafts`, `archiveDraft` and `restoreDraft`.

- Every modification requires an expected version. A stale version fails with `StaleVersionError` and changes nothing. A successful edit increments the version once.
- Content fields and relationships change in one transaction. An invalid target rolls back the whole change, including the audit event.
- Relationship input replaces only the kinds supplied. An empty array clears that kind.
- Archived items cannot be edited until restored. Archive and restore each increment the version.
- Listing returns summaries without bodies, ordered by ID with an opaque-by-convention `afterId` cursor and a page size of 1 to 100 (default 25).

## Security and audit

Callers pass the M0-C `TrustedPrincipal`. Each call first rechecks that the account is active and the identity is unrevoked and unexpired (`isCurrentPrincipal`), then asks an injected policy. With no policy supplied the service denies every action. The policy must return exactly `true`, and a throwing policy is a denial. Mutations repeat the check inside the transaction. No account role is granted content access by this change and no capability was added.

Each mutation writes an append-only `audit_events` row attributed to the acting account. Audit details record field names and versions, never titles, bodies or credentials.

## Limits

No revision snapshots are kept beyond the audit trail, so earlier body text is not recoverable from the Website yet. There is no publication state, approval workflow or hosted D1 verification of migration 0009.

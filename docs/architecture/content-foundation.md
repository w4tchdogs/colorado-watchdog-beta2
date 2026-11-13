# Native Posts and Stories foundation

Migration `0009_content_foundation.sql`, `src/contracts/content.ts` and `src/services/content.ts` add the first internal content model. Migration `0010_content_revisions.sql` and `src/transport/content-api.ts` (M3-B) add durable revisions and an internal editorial API. None of this adds public routes, an editor, publication, media or WordPress integration. The service and the transport are not registered in `ApplicationServices`, the application, the Worker or MCP.

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

## Revision history (M3-B)

`content_revisions` is append-only. Each row is an immutable snapshot of the editable state at one content version: title, summary, exact Markdown body, `draft` or `archived` status, county, person and organization IDs (bounded JSON arrays), the editing account, the timestamp, and a `change_kind`. Triggers block updates and deletes, require the revision to match the current content version, and the restrictive foreign key blocks deleting content that has history. `content_items` stays the current state.

- Every successful create, update, relationship replacement, archive, draft restore and revision restore writes exactly one revision in the same transaction as the content change and its audit event. A failure, including a failed revision insert, rolls all three back. Stale and denied calls write nothing.
- Migration 0010 snapshots each existing item once as a `baseline` revision at its current version. Earlier versions that were never captured are not fabricated and cannot be restored.
- `restoreRevision(principal, id, expectedVersion, revisionVersion)` copies an earlier revision's title, summary, body and relationships into a new current version. The historical row is untouched, and the new row is `restore_revision` with `restoredFromVersion`. It requires the current expected version and a revision older than it. It needs a draft, so archived content must first be restored with `restoreDraft`. Identity, type, original author and creation time never change. A relationship target that no longer exists fails the whole restore with `ContentRelationshipError` and changes nothing.
- `listRevisions` (newest first, `limit` 1 to 100, `beforeVersion` cursor, no bodies) and `getRevision` need `content.revision.read`. `restoreRevision` needs `content.revision.restore`. Neither depends on `content.read` or `content.update`.

## Internal editorial API (M3-B)

`createContentApiTransport(dependencies)` is a standard Request/Response adapter. Every route is `POST` with a JSON body of at most 600,000 bytes and no query string. `createContentTransportOperations(service)` binds the handlers to the content service so business rules are not duplicated.

| Path | Operation |
| --- | --- |
| `/internal/content/drafts/create` `get` `list` `update` `relationships` `archive` `restore` | draft operations |
| `/internal/content/revisions/list` `get` `restore` | revision operations |

Order of checks: route, method, query, content type and declared length, then the principal (401), a per-operation `authorize` callback (403) and the presence of a handler (503). Only then is the body read and parsed. With nothing configured every route returns 401. Bodies use closed key sets, validated IDs, positive integer versions on every change, and bounded pagination. Service errors map to fixed codes (`invalid_request`, `forbidden`, `not_found`, `version_conflict`, `invalid_state`, `invalid_relationship`, `internal_error`). Messages, article text and account details such as names or email addresses are never returned in errors. Responses use explicit field lists, `application/json`, `nosniff` and `no-store`.

The content service also keeps its own injected default-deny policy, so transport authorization alone grants nothing. The new actions are `content.revision.read` and `content.revision.restore`. No role received any content permission.

## Content safety

Bodies, including stored HTML, Markdown links and embedded content, are inert source text. The API returns them only as JSON strings with `bodyFormat: "markdown"`. No renderer exists. A future preview or publication renderer must escape or strip raw HTML and sanitize link targets.

## Limits

Every revision stores a full copy of the body, so storage grows with edits and no retention or compaction exists. There is no publication state, approval workflow or hosted D1 verification of migrations 0009 and 0010. SQL.js tests do not prove hosted D1 behavior. Principal resolution for the transport is supplied by the host and no production wiring exists.

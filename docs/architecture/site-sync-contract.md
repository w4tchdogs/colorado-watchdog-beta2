# Website synchronization contract (M2-A)

**Status: M2-A design, M2-B dry-run planning, M2-C commit/replay, and M2-D local batch lookup/reversal are implemented.** These services remain internal: no route, ApplicationServices entry, production authorization, or hosted D1 behavior is enabled. Hosted compatibility remains unverified.

## M2-C local commit implementation

The internal `commitSyncChangeset` accepts only the M2-B `m2-sync/v1` commit envelope, a branded active M0-C principal, and a separate bounded idempotency key. It rechecks that principal before replay and again inside the transaction using the existing privileged account check; no sync capability, role grant, transport route, or application service is added. The service is not exported through `src/services/index.ts`.

Processing validates the bounded envelope and key, computes SHA-256 over canonical JSON containing a fixed commit-domain marker, contract version, ordered changes, and duplicate flags (absent flags normalize to an empty array), then checks the actor-scoped key. `requestId` and object property insertion order do not affect the fingerprint. For an exact committed match it returns the stored original result before state-sensitive planning. A mismatch returns `idempotency_mismatch`. A previously unused key reaches the unchanged dry-run planner, then the same planner runs again within the one owning `BEGIN IMMEDIATE` transaction before any writes.

Migration `0005_m2_sync_batches.sql` adds `sync_batches` with a unique `(actor_account_id, idempotency_key)` and `sync_batch_items` with exact item mappings, outcomes, row versions, dependencies and compact inverse fields. It stores no complete request body. Creates receive Website-generated UUIDs; earlier temporary references resolve through the in-memory mapping. Compatible exact-URL sources can be reused. Updates use the established conditional version writer only after M2-B's narrower field validation.

One transaction contains state revalidation, all inserts/updates, batch and item results, and one attributable `sync.batch.commit` audit row. The audit insertion helper does not open a transaction. Any late constraint, stale write, batch insert or audit failure rolls back all evidence and mutations; preflight and transaction rejection do not consume the key. Local same-connection contenders are serialized by SQLite `BEGIN IMMEDIATE` and the unique key. This is not evidence of cross-process or hosted concurrency behavior.

The batch result is retained for replay after closing and reopening a file-backed local database. It preserves the original batch ID, original request ID, result mapping, outcome, row version and commit timestamp. The Profiles client must durably persist its idempotency key and request fingerprint before submission and reuse that key after an uncertain outcome. M2-C does not add Profiles-side mapping or synchronization.

M2-C retains compact inverse metadata: created/reused distinction, entity and Website ID, committed version, changed prior field values and version for updates, item order and dependencies. M2-D adds actor-scoped read-only result lookup and local atomic reversal. Reversal state is additive and does not mutate the committed batch. Committed idempotency, inverse, and reversal records have no automatic expiry or pruning.

This remains a local fictional-data foundation. It does not enable production callers, add sync capabilities, expose batch-result lookup, certify D1 transaction semantics, or implement hosted concurrency. `source_checked_at`'s existing local validation skew remains a validator default rather than a production policy.

## M2-B pinned request and planning contract

This section resolves M2-A acceptance findings M2A-ACC-1 through 4 and 10 and is authoritative over conflicting proposed wire details below. Requests use `contractVersion: "m2-sync/v1"`, a UUID `requestId`, `intent: "dry_run"`, 1–200 ordered `changes`, and optional advisory `duplicateFlags`. Unknown envelope and item keys are rejected; the envelope-level `expectedVersions` map and transport fields such as `idempotencyKey`, `actorId`, `originSystem`, and `createdAt` are not part of this M2-B shape. `commit` intent is structurally recognized but returns `commit_not_supported` without planning writes.

Create items use `{op, entity, clientRef, fields}`. `entity` must match the operation's one M1-A table. The create operations are `create_organization`, `add_county_affiliation`, `create_person`, `create_position`, `register_source`, and `create_person_role`. Create items never accept persistent IDs. Relationship fields use the existing ID (`*_id`) or same-request temporary reference (`*_ref`) spelling. A pair supplies exactly one form, except an organization root may omit its optional parent fields or set both parent ID and relationship to null. A temporary ref must name one unique, compatible create item earlier in array order; forward, self, unknown, duplicate and wrong-entity refs are rejected. Plans preserve input order and return dependency refs. References to existing records are checked for existence and relationship validity; they need no version pin unless updated.

An update item is exactly `{"op":"update_record","entity":"organizations","targetId":"existing-website-id","expectedVersion":3,"fields":{"name":"Updated organization name"}}`. Its target must already exist; its expected version is a positive integer; one target may be updated only once per changeset. Duplicate targets return `duplicate_target`; a stale version returns `stale_version` with only the safe current version. Missing targets never become creates. The shared `MUTABLE_COLUMNS` object is not a sync allowlist. Permitted update fields are: organizations `name`, `organization_type`, `county_fips`, `parent_organization_id`, `parent_relationship`; people `display_name`; positions `title`; role_sources `title`; person_roles `start_date`, `end_date`, `source_checked_at`, and `source_id` only when a valid replacement source and new `source_checked_at` are supplied. Affiliations have no update fields. `update_organization` is superseded by `update_record`. All other tables and fields, including account/security fields and relationship retargeting, are rejected.

Dates are real calendar dates in `YYYY-MM-DD`; role end dates cannot precede start dates. `source_checked_at` is RFC 3339 UTC, is evidence-check time rather than employment time, and cannot exceed the injected trusted clock by more than five minutes. This skew is a local validator default, not an approved production freshness policy. Source URLs must be absolute HTTP(S), contain a host, contain no userinfo, and fit 2,048 UTF-8 bytes. URLs are syntax-checked only; the planner never fetches them. `example.invalid` is accepted for synthetic fixtures. Source reuse compares the exact supplied URL bytes and requires identical title and source type; conflicting metadata is a safe conflict. No URL normalization is used for identity. Source types follow the M1-A enum.

Limits apply together: 512 KiB total request, 1–200 changes, 32 KiB per change, 25 source citations, 20 duplicate flags, and at most 200 planned changed rows. Field caps are 500 UTF-8 bytes for names/titles/reasons and 128 ASCII bytes for IDs and client refs. The planner performs bounded primary-key/county/uniqueness lookups and organization walks up to 64 ancestors; no write transaction is used. Results contain ordered `would_create`, `would_update`, `would_reuse` or `invalid` items, existing IDs only when already persisted, and bounded sanitized errors. Dry runs do not write rows, versions, audits, operations, sync state, flags or idempotency state, and generate no persistent Website IDs.

Duplicate flags are optional advisory input. Only bounded, well-formed person flags with `nonblocking: true` are accepted; their references are checked and summaries may be returned in the plan. M2-B does not persist flags or implement their lifecycle.

M2-B keeps validation/planning as internal functions with no principal parameter. M2-C consumes that planner without modifying its dry-run-only behavior. The M2-B dry-run portion covers acceptance matrix cases 1–10, 16, 22 and 23; local commit, atomicity and replay are now covered by the internal M2-C service. Stale conflicts include no row projection.

The design is grounded in the accepted Website foundation at M1-A/M1-B and the owner directions in [decisions.md](../decisions.md). Owner directions include local research and screening, Website-assigned public IDs, version-checked changesets, one verified official county webpage directly connecting a person's name to a role as sufficient source evidence, and nonblocking duplicate flags. Technical choices below are recommendations, not new owner policy. The document is for the Website track; it does not authorize or require changes to Profiles.

## Current baseline and system boundary

At the `e233c278847b61357d8808c4f4bfb4ab99736954` main baseline, M1-A migration `website/migrations/0004_m1_county_roles.sql` defines organizations, county affiliations, people, positions, public role sources and source-backed person roles, each with a stable text ID and integer row version. The accepted `src/database/versioned-writes.ts` helper allowlists mutable fields and requires an expected version. M1-B provides bounded, read-only `listCountyOrganizations` and `listCountyRoleEntries` service contracts with stable IDs and versions. Neither M1-B nor this proposal provides sync writes.

The current service boundary in `src/services/index.ts` exposes no sync operation or sync capability. The internal M2-C service and its durable Website batch tables are not part of that boundary. Duplicate-flag lifecycle persistence remains future work. No production D1, hosted route, or Profiles connection is assumed.

Data flow:

```text
Private Profiles research (evidence, screening, local IDs)
        | compact, validated changeset; no private notes/captures
        v
Future authenticated Website service
        | validate + resolve temporary refs + atomic Website DB transaction
        v
Website entities + proposed sync batch/audit records
        | result: Website IDs, versions, batch status
        v
Profiles local ID-to-Website ID mapping
```

Only the Website database transaction is atomic. The local Profiles SQLite database is updated separately after the Website returns or can be queried for a durable prior result.

## Scope and boundaries

The contract must allow the Profiles system to submit compact, version-checked Website changesets while the Website keeps control of persistent public identifiers, relational validation, audit records, retries, and reversible batches.

This design includes:

- version-checked changeset envelopes
- Website-assigned persistent IDs
- bounded reads and preflight validation
- dry-run and commit modes
- idempotent retries and safe replays
- transactional application
- conflict detection and reporting
- audit entries and sync history
- reversal of recent sync batches
- source-backed person-role proofs
- nonblocking duplicate flags
- privacy and authorization boundaries

This design deliberately does not include:

- unrestricted table writes
- generic SQL execution or arbitrary database mutation
- automatic identity merging or deduplication by name similarity
- deletion-by-bulk or destructive mutation outside a reversible batch
- any requirement to import real data or private research notes into the Website
- hosted D1/R2 work, deployment, or production verification

## Core principles

1. The Website assigns all public stable IDs for organizations, people, positions, role sources and person-role links.
2. Profiles keeps the local-to-Website mapping and can retry safely with the same idempotency key.
3. Existing Website row versions are required for updated records.
4. Each batch is atomic: either the whole commit succeeds or nothing changes.
5. A source-backed role needs a public citation attached to the Website record.
6. Duplicate flags are advisory only; they never trigger automatic merge or delete behavior.
7. Consent, authentication, auditing and capability checks follow the current Website security model, not a new privilege scheme.

## Contract versioning

The contract uses a single explicit version string at the envelope level and a per-item schema version when needed.

Required envelope fields:

- `contractVersion`: string; example value `"m2-sync/v1"`
- `requestId`: UUID; unique per submission
- `idempotencyKey`: opaque client-generated string; scoped to the authenticated origin account/system and stable across retries
- `originSystem`: `"profiles-research"` or equivalent client identifier
- `createdAt`: RFC 3339 UTC timestamp
- `intent`: `"dry_run" | "commit"`
- `changes`: ordered array of change items; length must be 1..200
- M2-B updates carry their required positive `expectedVersion` on each update item; no envelope-level version map is accepted
- Each create item must have a unique request-local `clientRef`; references may be used only by dependent items in the same request
- Public source metadata is carried by an allowlisted `register_source` or `use_existing_source` item and referenced by `source_ref` on a role

Optional fields:

- `researchBatchId`: opaque local research batch identifier, for correlation only
- `correlationId`
- `duplicateFlags`: advisory possible-match information; duplicates within the request or already-open equivalent flags should be handled idempotently

The authenticated principal is authoritative for actor attribution. The caller must not provide an `actorAccountId` or other field that can override it. A per-item source operation carries the `role_sources` fields; the role item carries the required `source_ref` and `source_checked_at`.

Prohibited fields:

- raw private research notes or screenshots
- arbitrary database SQL
- direct credential material, secrets, or bearer tokens
- per-row merge commands or deletion instructions outside the reversible-batch path
- unbounded free-form metadata that bypasses size caps
- caller-supplied actor identity or public IDs for newly created Website entities

### Proposed technical defaults

The following are defaults for the first implementation attempt, not production policy decisions:

- max request size: 512 KiB
- max changes: 200 items
- max source citations per request: 25
- max duplicate flags per request: 20
- max changed rows per batch: 200
- max audit detail string length: 4096 bytes per item
- max change payload size per item: 32 KiB

These defaults should be enforced by the Website before database writes begin.

## Change envelope example

```json
{
  "contractVersion": "m2-sync/v1",
  "requestId": "6b5f57a2-84b7-4a4d-b300-33aea9feeb19",
  "intent": "dry_run",
  "changes": [
    {
      "op": "create_organization",
      "clientRef": "org-001",
      "entity": "organizations",
      "fields": {
        "name": "Boulder County Clerk and Recorder",
        "organization_type": "office",
        "county_fips": "08013",
        "parent_organization_id": null,
        "parent_relationship": null
      }
    },
    {
      "op": "create_position",
      "clientRef": "pos-010",
      "entity": "positions",
      "fields": {
        "organization_ref": "org-001",
        "title": "Deputy Clerk"
      }
    },
    {
      "op": "create_person",
      "clientRef": "person-010",
      "entity": "people",
      "fields": {
        "display_name": "Ariana Lee"
      }
    },
    {
      "op": "register_source",
      "clientRef": "src-1001",
      "entity": "role_sources",
      "fields": {
        "url": "https://example.invalid/county/clerk-directory",
        "title": "Synthetic county clerk staff directory",
        "source_type": "official_page"
      }
    },
    {
      "op": "create_person_role",
      "clientRef": "role-007",
      "entity": "person_roles",
      "fields": {
        "person_ref": "person-010",
        "position_ref": "pos-010",
        "source_ref": "src-1001",
        "start_date": "2024-01-01",
        "end_date": null,
        "source_checked_at": "2026-11-12T12:00:00Z"
      }
    }
  ],
  "duplicateFlags": [
    {
      "targetType": "person",
      "targetRef": "person-010",
      "possibleDuplicateOf": "website-person-existing",
      "category": "possible_match",
      "reason": "possible match; name alone is not identity evidence",
      "evidenceSourceRefs": ["src-1001"],
      "nonblocking": true
    }
  ]
}
```

This is a synthetic dry-run example. The reserved `example.invalid` host is accepted as syntactically valid test data; the planner does not fetch or verify URLs. A real public citation must be verified by the local research process. The example uses a five-digit Colorado FIPS value (`08013`) and earlier same-request temporary references. An update item carries its own `targetId` and positive `expectedVersion` as described in the M2-B pinned section; there is no envelope-level `expectedVersions` map.

## Supported entity operations

The initial implementation should allow only a small, allowlisted operation set that maps directly to the accepted M1 schema and the existing optimistic version conventions.

### Initial operation set

1. `create_organization`
   - creates a row in `organizations`
   - requires a valid `name`, `organization_type`, and county rule compliance
   - does not accept unbounded `details_json` or arbitrary schema extension

2. `update_record`
   - canonical version-checked update operation for the per-entity fields pinned above
   - supersedes `update_organization`; no second update operation is supported

3. `add_county_affiliation`
   - creates a row in `organization_county_affiliations`
   - supports only `organization_id`, `county_fips`, and `relationship_type`
   - no direct mutation of unrelated tables

4. `create_person`
   - creates a row in `people`
   - requires a nonblank `display_name`
   - retains a stable Website ID and returns the mapped `websiteId`

5. `create_position`
   - creates a row in `positions`
   - requires an existing `organization_id` or same-request `organization_ref`, and nonblank `title`

6. `register_source`
   - creates or reuses a row in `role_sources`
   - requires `url`, `title`, and `source_type`
   - URL is bounded and syntax-checked as absolute HTTP(S); same exact URL and same metadata can be planned as reuse, while conflicting metadata returns `source_metadata_conflict`

7. `create_person_role`
   - creates the source-backed `person_roles` row
   - requires existing IDs or matching same-request refs for `person_id`, `position_id`, and `source_id`, plus valid date semantics
   - source_checked_at is required; no role can be created without a citation

8. `update_record`
   - generic version-checked update only for the narrow per-entity field table in the M2-B pinned section
   - does not use or expose the broader `MUTABLE_COLUMNS` allowlist
   - affiliations, security tables and relationship-retargeting fields cannot be updated

`update_record` is an internal dispatch over a fixed entity/field allowlist, not a caller-selected SQL table or column. Updates require a persistent Website ID and per-item expected version. Create operations use temporary refs only; they never accept caller-selected Website IDs. Existing source URLs may be reused by exact bounded lookup; changed source metadata must not silently change historical role facts.

### Deferred for later milestones

- bulk batch insert of many rows with no explicit per-row source mapping
- arbitrary table writes beyond the accepted M1 schema
- row deletion as an ordinary operation
- identity merge or duplicate-resolution actions
- unrestricted bulk county import or statewide re-parenting
- cross-entity relationship creation beyond the existing schema rules

The Website should reject any operation not explicitly in the allowlist.

## Identity and local-to-Website mapping

Profiles retains a mapping between local research IDs and Website IDs. The Website never trusts a client-supplied public ID for a new record; it assigns the actual permanent ID. The client sees this mapping in the response payload:

```json
{
  "applied": [
    {
      "clientRef": "person-010",
      "websiteTable": "people",
      "websiteId": "eb377d41-0a16-4d5d-9a76-9d00e8d0e2b9",
      "version": 1
    }
  ]
}
```

This mapping is required for safe retries and later reversal. The Website stores it in the sync batch item/result; the audit event references the batch and affected Website ID without duplicating request data. The mapping is never stored in a private or hidden Website research record.

Temporary refs are unique within one request, case-sensitive, bounded ASCII identifiers, and valid only for that request's dependency graph. Every create has exactly one ref; duplicate refs, unresolved refs, self-reference and cycles are rejected. Relationship fields ending in `_ref` resolve only to a declared temporary ref; fields ending in `_id` identify an existing Website record and are never interpreted as a ref. The Website generates opaque persistent IDs only inside the commit transaction. An exact replay returns the original mapping; a failed/rolled-back transaction exposes no committed mapping and creates no rows. The caller persists the returned mapping locally only after a confirmed or replayed commit result. A bounded batch-result lookup resolves uncertain responses without downloading the directory.

The Website does not use a person's name, nickname, or other name-derived key to generate or reconcile IDs.

## Bounded reads and preflight validation

Before commit, the Website should run a bounded preflight validation over the request payload itself and the target rows that are touched. Preflight must not read whole tables or perform open-ended scans.

Required preflight checks:

- request shape and contract version are valid
- each change item is allowlisted and within request size bounds
- each row ID exists or is new as expected
- each organization, position, person, or source record passes table-specific validation
- every `source_ref` resolves to a valid `role_sources` row or newly created source
- every `person_role` has at least one public source citation and date semantics are valid
- each update item's `expectedVersion` matches the current Website row version before any future write
- duplicates and possible-match flags are advisory only and do not trigger a merge
- `dry_run` simulates all reads and validation without writing the database

Any failed preflight returns a structured error list with the offending `clientRef` and a stable reason code such as `invalid_source`, `stale_version`, `forbidden_operation`, or `name_missing`.

M1-B's `listCountyOrganizations` and `listCountyRoleEntries` remain the starting read contracts; do not duplicate or replace their paging logic. A future M2 service may add only:

- a bounded lookup by stable entity ID for the minimal editable/public fields and version needed for updates;
- a lookup for an existing public source by stable ID or exact URL, with uniqueness conflict behavior;
- a bounded idempotency/batch-result read to resolve a lost commit response and retrieve its ID mapping.

All such reads need explicit limits and capability checks. No full-table exports or full-database reconciliation are required. Pagination is not a snapshot, so commit still checks versions transactionally.

## Dry-run behavior

`intent: "dry_run"` validates the whole proposed changeset without committing any Website changes. It must not create live rows, consume an idempotency key, increment versions, write durable sync-batch records, create mutation audit events, or reserve/lock records. It performs no durable write; an implementation may use read-only preflight plus an in-memory dependency plan.

Dry-run report fields:

- `eligible`: whether the complete changeset passes current preflight
- valid and invalid item counts
- item-specific error codes and safe messages
- missing/invalid dependency and temporary-reference errors
- expected-version conflicts, including current version and a minimal safe public projection where authorized
- duplicate `clientRef` values and unsupported operations
- proposed create/update/relationship effects, with no persistent ID promise for new rows
- necessary follow-up information, such as a refreshed entity version

Dependencies on proposed changes are evaluated as an in-memory plan: validate references and dependency graph, resolve refs to provisional plan nodes, and validate relationships against both existing bounded reads and planned values. Reject duplicate refs, unknown refs, and cycles before commit. A successful dry run does not guarantee a later commit: Website state may change after preflight, and commit revalidates versions and constraints.

## Idempotency and safe retries

The goal is safe, effectively once-only application of a committed request, not exactly-once network delivery. An idempotency key is unique within the authenticated origin account/system scope. Persist a canonical request fingerprint, based on a documented normalized representation that excludes transport-only fields but includes all mutation-affecting fields (`intent`, operation order/dependencies, expected versions, refs, public source data and flags).

Commit replay behavior:

- First valid commit: atomically persist the batch/idempotency record with all Website mutations and their audit records. A rollback leaves no committed idempotency record or partial mutations.
- Exact retry after success or lost response: return the original batch ID, result, generated IDs and versions; do not execute mutations again.
- Network timeout or server restart with unknown client outcome: the client retries with the same key or performs a bounded batch-result lookup. If the transaction committed, replay the stored result; if it rolled back, accept the retry.
- Same key with changed mutation content: reject with `idempotency_mismatch`; do not overwrite the stored request/result.
- Same changeset under a new key: it is a new request. To prevent accidental duplicate creates, apply relational uniqueness and explicit client mapping/reconciliation, not a person-name key. Names are never identity keys. A separate semantically identical create may create a distinct person only when it is a genuinely new authorized request.
- Concurrent requests with the same key: serialize or enforce a unique scoped-key constraint; the winner commits, and the other returns the winning status/result or a deterministic in-progress response.
- Failed preflight: creates no durable sync batch and consumes no key; corrected input can use the same key because no commit attempt was recorded.
- Transaction rollback: no mutation or committed idempotency result remains; retry is safe.
- Repeated `requestId`: same payload and key resolve to the same status; a request ID alone is not the idempotency mechanism.

Store a stable result sufficient to reproduce the mapping and outcome. Retention and key-reuse policy are future implementation decisions; do not invent automatic expiry or deletion that weakens replay safety. A proposed default is to retain compact idempotency/result metadata for at least as long as the associated batch is reversible, with longer-term retention decided before implementation.

Dry-run does not participate in this state model and does not reserve a key.

## Transactional application

For `intent: "commit"`, the initial boundary is one Website database transaction: all accepted changes commit or none do. Local Profiles SQLite writes and network responses are outside that transaction. R2/external side effects are excluded from the initial contract.

Recommended sequence:

1. Authenticate and resolve a trusted principal; recheck the proposed future sync capability.
2. Enforce request byte/item bounds, contract version, allowlisted operations and payload shape.
3. Run bounded preflight and build the temporary-reference dependency plan.
4. Begin the database transaction and revalidate all referenced records, expected versions, uniqueness and relational constraints against current state.
5. Generate Website IDs for new records; resolve refs only in transaction-local state.
6. Apply allowlisted writes with foreign keys enabled and exactly-one version increments for updated rows.
7. Persist the sync-batch summary, request fingerprint, ref-to-ID mapping, outcomes and audit event(s) in the same transaction. Use `operations` only where its existing semantics add value; do not create a duplicate ledger.
8. Commit and return the stored result. The caller then records the returned mapping in its own local transaction.

Any exception, stale version, duplicate constraint, or invalid dependency aborts the complete changeset. Revalidation inside the transaction closes the race between dry-run/preflight and mutation. If the transaction commits but the response is lost, the durable idempotency record resolves the retry.

## Conflict detection and reporting

The Website should return structured conflicts rather than raw SQL exceptions. Use stable codes, safe messages, and only public/current fields that the caller is authorized to read. A missing target returns `missing_record`; a stale version returns current version and, when safe, a minimal current projection. Never include private Profiles content, credentials, or raw database errors.

Conflict categories:

- `stale_version`: expected version does not match current row version
- `forbidden_operation`: operation not in allowlist
- `invalid_source`: URL missing, source type invalid, or source record fails validation
- `county_violation`: county relationship would break county scoping
- `relationship_cycle`: parent-child hierarchy would create a cycle
- `missing_record`: the referenced client or website ID is not found
- `duplicate_key`: a unique key is already present with different data
- `idempotency_mismatch`: same idempotency key but different payload

For the initial contract, one material item conflict rejects the complete batch. This keeps the ref mapping and role/source relationships coherent, avoids a hidden partial-success client protocol, and makes rollback/retry auditable. Nonblocking duplicate flags are not material conflicts. Validation may report multiple independent item errors together; commit still revalidates and fails atomically.

An update identifies the existing Website entity ID and exact expected integer version. A missing target never becomes an implicit create; a stale version never overwrites newer data. If a referenced entity changes while processing, transaction-time constraints/version checks reject the batch.

## Error and response contract

Responses are service results, not route-specific business logic. A common result contains `contractVersion`, `requestId`, `status`, `summary`, `items`, and `errors`; commit/replay results also contain `batchId`, `committedAt`, and the `clientRef` to Website ID/version mapping. Error values contain a stable `code`, optional `clientRef`, and sanitized message. No raw SQL errors or private Profiles data are returned.

The result categories should distinguish `invalid_request`, `unsupported_contract`, `unauthenticated`, `forbidden`, `invalid_county_or_organization`, `invalid_source`, `missing_dependency`, `stale_version`, `idempotency_mismatch`, `replayed_success`, `transaction_rejected`, `reversal_blocked`, `dependency_unavailable`, and `internal_failure`. Item validation may return several independent errors; a material commit conflict still rejects the entire changeset.

Suggested future HTTP mappings are `400` invalid request, `401` unauthenticated, `403` forbidden, `404` missing batch/entity, `409` stale version/idempotency/unique conflict, `413` over limit, `422` semantic validation or transactional rejection, `503` dependency unavailable, and `500` sanitized internal failure. An exact replay is a successful response with `replayed: true`; precise transport choices remain implementation details.

Representative response examples:

Successful dry run (200):

```json
{"requestId":"req-1","status":"validated","eligible":true,"counts":{"valid":2,"invalid":0},"items":[{"clientRef":"person-1","result":"would_create"},{"clientRef":"role-1","result":"would_create"}],"errors":[],"idempotencyKeyConsumed":false}
```

Rejected dry run (422):

```json
{"requestId":"req-2","status":"invalid","eligible":false,"counts":{"valid":1,"invalid":1},"items":[{"clientRef":"role-1","result":"invalid"}],"errors":[{"code":"invalid_source","clientRef":"role-1","message":"A public role source is required."}],"idempotencyKeyConsumed":false}
```

Successful commit (201):

```json
{"requestId":"req-3","status":"committed","batchId":"batch-1","committedAt":"2026-11-13T12:00:00Z","replayed":false,"items":[{"clientRef":"person-1","websiteId":"person-id-1","entity":"people","version":1}],"errors":[]}
```

Exact commit replay (200):

```json
{"requestId":"req-3","status":"committed","batchId":"batch-1","replayed":true,"items":[{"clientRef":"person-1","websiteId":"person-id-1","entity":"people","version":1}],"errors":[]}
```

Version conflict (409):

```json
{"requestId":"req-4","status":"rejected","errors":[{"code":"stale_version","clientRef":"org-1","currentVersion":5,"message":"The organization changed; read the current public record before retrying."}]}
```

Same key with changed content (409):

```json
{"requestId":"req-5","status":"rejected","errors":[{"code":"idempotency_mismatch","message":"This idempotency key is already associated with a different request."}]}
```

Successful reversal (200):

```json
{"requestId":"revert-1","status":"reverted","batchId":"batch-1","reversalBatchId":"batch-2","replayed":false,"errors":[]}
```

Reversal blocked by later edit (409):

```json
{"requestId":"revert-2","status":"reversal_blocked","batchId":"batch-1","errors":[{"code":"reversal_blocked","clientRef":"person-1","currentVersion":3,"message":"A later Website change depends on this record; no reversal was applied."}]}
```

## Audit events and synchronization history

Every committed changeset should have a proposed durable Website sync-batch record and attributable audit evidence. A failed preflight/dry-run writes none. A rejected commit may return errors without a persistent batch unless a future operational need justifies a separate bounded rejection record; do not make durable rejected-request logging mandatory in a way that stores sensitive payloads.

Proposed persisted metadata for a sync batch (future schema; not present in the current M1 database):

- `sync_batch_id`
- `origin_system`
- `request_id`
- `idempotency_key`
- `contract_version`
- `intent` (`dry_run` or `commit`)
- `status` (`received`, `validated`, `committed`, `rejected`, `reverted`)
- `created_at`
- `completed_at`
- `actor_account_id`
- `operation_id`
- `request_hash`
- `summary` and `error_code` if needed

For each change item, persist only the information needed for outcome, mapping and safe reversal (not request payload copies):

- `sync_batch_item_id`
- `sync_batch_id`
- `client_ref`
- `entity`
- `operation`
- `target_table`
- `target_id`
- `result` (`applied`, `skipped`, `rejected`, `reverted`)
- `details_json` for reasons and mapped IDs

Audit rows should remain append-only and protect secrets. They should reference the batch and row-level action. `operations` tracks operational lifecycle/progress and failure; `audit_events` records who performed an action and what changed; a sync batch records request identity, outcome, mappings, and reversal metadata. These are complementary, not three copies of source payloads. Profiles-local `sync_batches`, `sync_items`, and `site_links` remain private local records with a different purpose: local research provenance, item state, and local-to-site mapping. The Website must not copy their raw research data or credentials.

The batch's request identity/fingerprint and original/new row versions are immutable once committed. A small lifecycle status may advance (for example committed to reverted); each transition is an append-only audit event. Store only a compact inverse record for fields actually changed, not a full Website database snapshot.

## Reversible synchronization batches

The Website should support a version-aware compensating reversal of a committed batch, not unrestricted rollback or database restore. Reversal uses a new request/idempotency key and itself has a durable result, so retry after an unknown outcome returns the original reversal result. Reversing an already reversed batch returns that same result or a stable `already_reverted` outcome; it never reverses twice.

For each mutation, retain the minimal inverse data needed: created entity ID/type and commit version, plus prior values and prior version for fields changed by an update. Reversal checks all affected current versions and dependency constraints before writing, then runs as one atomic Website transaction. It applies inverse operations in reverse dependency order.

Reversal cases:

- **Created record:** remove the batch's relationship/role first, then remove newly created source, position, person, affiliation or organization only if no current relationship depends on it. Where hard deletion would violate retained history or foreign keys, mark the operation as compensated and retain the record rather than delete it.
- **Updated record:** restore only changed fields with a new version increment; never decrement the row version. The current row must still equal the batch's recorded post-commit version and values.
- **Relationship assignment or role:** remove/restore the specific association only if no later change depends on it and expected current version matches.
- **Later Website edits or dependent batches:** fail closed before mutation with `reversal_blocked`; return affected public IDs and current versions only. A corrective change is a separately scoped operation.
- **Already reversed batch:** return a stable prior result; no-op.
- **Unknown reversal outcome:** retry with same reversal idempotency key to retrieve the stored result.

The reversal is explicit, capability-gated and audited. A reversible-until duration is a provisional implementation setting, not owner-approved retention policy; do not expire required inverse data before the committed batch can no longer be reversed. Reversal does not erase audit history, historical citations or unrelated shared source records. No general production restore or archival deletion mechanism is part of this design.

## Public source citations

Every `person_roles` association must retain a public source citation in the Website record. The accepted standard remains:

- one verified official county webpage directly connecting the person's name to the role is sufficient
- the URL, title, and source type remain public and attributable
- `source_checked_at` records the time of verification
- a role without a valid public source is not accepted as a source-backed Website entry

The synchronization contract should therefore require `source_ref` on every role-creating item and should reject any item that tries to create a role without a valid cited source.

An existing source is reused by stable Website source ID or an exact URL lookup that returns one unambiguous record. Same URL with conflicting metadata is a `duplicate_key` conflict, not an implicit update. Source updates require the source's expected version and must not rewrite a role's checked date. The stable `person_roles.source_id` preserves the relationship, but updating a shared source record changes its displayed title/URL for every referencing role; a different citation for one role should use a new source and version-checked role update. `source_checked_at` is evidence-check time, not an employment start date. The existing M1-A foreign key enforces the source relationship. The sync service records supplied public citations and does not fetch caller-provided URLs; source verification belongs to the local research process, and the Website must not require a second citation.

## Nonblocking duplicate flags

Duplicate flags are advisory and never force merging, block a valid changeset, or delete/rewrite identities.

The request payload may include:

- `targetRef` for a new person in this request or stable Website person ID
- `possibleDuplicateOf` with the distinct second Website person ID
- a small `category` such as `possible_match`, concise reason, and optional source refs
- `nonblocking: true`

The initial contract can persist flags as compact batch metadata with `open`, `dismissed`, and `resolved` lifecycle concepts (a schema/UI is future work). Repeated identical submissions under the same idempotency key replay the same result; semantically duplicate flags on a new request should not erase a prior dismissal. Record created/last-reviewed actor and time if a later lifecycle implementation needs them. A later evidence-supported identity operation must be separately authorized and scoped; merging is not part of this contract. Identical names and nicknames alone are never evidence of identity.

## Authentication, authorization, privacy, and bounds

This contract should use the existing Website security boundary, not a separate trust model.

- The caller must authenticate as a trusted Website principal through the existing principal resolution flow.
- The future sync service must require explicit capabilities such as `sync.apply`, `sync.read`, and `sync.revert`, default-deny unknown operations, and re-check the currently active principal/capability at mutation time. These capabilities are proposals only; current M0-C capabilities do not include sync permissions, and none are implemented or activated here.
- A proposed initial grant is restricted to specifically authorized owner/administrator or agent accounts; contributor permissions must not be inferred. The owner-approved exact role matrix remains for future implementation.
- The batch payload must never include raw private notes, unreconciled source documents, screenshots, or credential-bearing blobs.
- All request fields must be sanitized and bounded before database writes.
- The Website should reject unsupported or overlarge payloads before any row is touched.
- Bind audit attribution to the trusted principal resolved by M0-C; ignore/reject caller-supplied actor IDs. Disabled accounts and expired/revoked agent identities must fail authorization.
- Use typed operation dispatch and fixed per-entity field allowlists. Never interpolate caller-selected table/column names.
- Enforce county registry, same-county organization hierarchy, foreign keys, cycle checks and request-size limits before and inside the transaction as applicable.
- Return sanitized errors; do not log bearer credentials, raw research rows, private notes or full submitted payloads.

This preserves the current separation between the local Profiles research workspace and the public Website database.

## Acceptance testing

Use synthetic data and `example.invalid` sources. M2-B locally exercises dry-run planning for cases 1–10, 16, 22 and 23; its focused tests include same-target updates, source-integrity rejection, dry-run state preservation, and representative planner/SQLite constraint parity. The matrix's commit, replay, authorization and reversal outcomes remain future milestones. Local SQL.js tests do not establish hosted D1 behavior.

| # | Synthetic scenario / invariant | Expected outcome | Suggested test layer |
|---|---|---|---|
| 1 | Create a county organization and position in one changeset | Website IDs assigned; county and organization refs resolve; batch atomic | Service + DB |
| 2 | Reference an existing organization with its current version | Change validates and relates to that exact Website ID | Service |
| 3 | Create a person and role with a source-backed citation | Person/role IDs assigned; source FK and checked date retained | Service + DB |
| 4 | One person has two distinct roles | Both role rows remain distinct and cite valid source/position | DB + service |
| 5 | Two distinct people have identical names | Both remain distinct; no name-based association or merge | Service + DB |
| 6 | Regional organization explicitly serves multiple counties | Affiliations are explicit; no false county-government hierarchy | DB |
| 7 | Cross-county reporting hierarchy | Rejected by validation/constraint; no writes | Service + DB |
| 8 | Missing or invalid public role source | Role item rejected with stable error; batch unchanged | Service + DB |
| 9 | Stale expected version in otherwise valid update | Whole batch rejected; current row unchanged and safe current version returned | Service + DB |
| 10 | Valid dry run | Complete plan returned; no rows, version, idempotency, batch or mutation-audit changes | Service + DB |
| 11 | One invalid item in an otherwise valid commit | Complete transaction rolls back; no partial IDs/results committed | Service + DB |
| 12 | Exact retry after successful commit | Original batch result, IDs and versions replayed; no duplicate rows | Service + DB |
| 13 | Same idempotency key with changed payload | `idempotency_mismatch`; stored result unchanged | Service |
| 14 | Concurrent identical commits | One commit; other call returns same result or deterministic in-progress state | Service + DB |
| 15 | Commit response lost, client retries | Durable result and original ID map returned; no second application | Service + DB |
| 16 | Duplicate or unresolved temporary entity ref | Request rejected before mutation with item-specific dependency error | Service |
| 17 | Possible-duplicate flag submitted | Advisory flag only; people remain separate and changeset is not blocked | Service + DB |
| 18 | Reverse a batch with no later dependencies | Atomic compensation succeeds; audit history remains | Service + DB |
| 19 | Reverse a batch after newer edit to an affected row | `reversal_blocked`; no row is overwritten or deleted | Service + DB |
| 20 | Replay a completed reversal | Original reversal result returned; no second reversal | Service + DB |
| 21 | Expired/revoked agent credential | Authentication/capability denied; no sync mutation | Security |
| 22 | Malformed, oversized or unsupported request | Sanitized typed rejection before write-time work | Contract + service |
| 23 | Request contains private Profiles notes/captures | Reject unsupported/private fields; never persist, log or return their values | Contract + security |
| 24 | Retry after uncertain result or transaction rollback | Committed result replays; rolled-back request can safely retry | Service + DB |

Acceptance of a future milestone requires all applicable rows to pass in that implementation layer. M2-B completion does not claim that commit, replay, production authorization or reversal has been executed.

## Design decisions and assumptions

| Decision | Chosen approach and reason | Simpler alternative | Basis and revisability |
|---|---|---|---|
| Whole changeset atomicity | Commit all items or none; keeps relationships, ID mappings and audit coherent | Partial success per item | Required preferred boundary; revise only with demonstrated need for partial success |
| Request-local temporary refs | Use bounded unique client refs for not-yet-created dependencies | Multi-request staging/reservation | Small and transaction-local; implementation may tune syntax |
| Website IDs | Generate opaque IDs inside transaction; return stable mapping | Client-generated public IDs | Preserves Website ownership; never use names as keys |
| Version checks | Require exact current integer version for every update and recheck in transaction | Last-write-wins | Matches M0/M1 convention; fixed requirement |
| Idempotency | Durable scoped key + canonical fingerprint + stored result | Assume network retries do not happen | Required for lost-response safety; canonical encoding is implementation detail |
| Dry run | Read-only full plan with no key reservation, batch or mutation audit | Persist preview operation | Meets explicit no-side-effects requirement; diagnostics may be revisited without durable writes |
| Source reuse | Reuse by stable ID or unambiguous exact URL; conflicting metadata is a conflict | Auto-update source on URL match | Preserves citation stability; implementation can refine lookup |
| Reversal | Version-aware atomic compensation; stop on drift/dependencies | Blind inverse or restore snapshot | Protects later edits; exact reversible window requires future operational configuration |
| Duplicate flags | Advisory, nonblocking metadata separate from identity | Auto-match or merge | Owner identity direction; lifecycle storage/UI is future work |
| Resource limits | Start with listed bounded proposal, measure and adjust | Unbounded bulk requests | Technical defaults only, not production-approved policy |

## Candidate implementation sequence (not authorized by this design)

These are suggestions for separately scoped future tasks; they are not automatic approvals.

| Candidate | Main contract and dependencies | Acceptance evidence | Excludes |
|---|---|---|---|
| M2-B: validation and dry run | Typed allowlisted changeset validation, bounded lookups, dependency plan; uses M1-A schema and M1-B reads | Matrix cases 1-10, 16, 22-23; no persistent side effects | Commit, migration, production endpoint |
| M2-C: atomic commit and replay | Implemented locally: additive batch schema, Website IDs, one transaction, audit and durable replay; no sync capability or route | Synthetic dependency, key scope, canonical fingerprint, rollback, replay and restart tests | Hosted D1, cross-process concurrency, reversal, live deployment |
| M2-D: batch result and reversal | Bounded result lookup and fail-closed compensating transactions; depends on commit inverse metadata | Matrix cases 12, 15, 18-20, 24 | General restore, destructive archival |
| M2-E: duplicate-flag lifecycle/API integration | Nonblocking flags and bounded transport wiring; depends on authorization, persistence and source contract | Matrix cases 5, 17, 21-23 | Identity merge, name matching, deployment without separate authorization |

The sequence may be consolidated or reordered based on implementation evidence; no code or database changes are part of M2-A.

## Deferred and unresolved implementation choices

Deferred: HTTP route shape, hosted D1 compatibility, exact capability grants, idempotency retention and key reuse policy, reversal window and operator UX, duplicate-flag persistence/lifecycle UI, request/rate limits after measurement, and any production credential provisioning. M2-C retains committed replay and inverse records indefinitely in the local schema; no automatic expiry is implemented. These do not prevent the local M2-C foundation from being complete. No production service or data import is authorized.

## Summary

M2-A is a design document only. It proposes one versioned request envelope, a narrow allowlist of M1-aligned operations, Website-assigned IDs, source-backed roles, optimistic row-version checks, side-effect-free dry runs, durable idempotency, whole-changeset transactions, bounded conflict responses, and fail-closed compensating reversals. It preserves Website ownership of public IDs and data integrity without granting arbitrary write access. Implementation, migrations, runtime services, routes, and deployments remain future separately scoped work.

# Website foundation status

This document describes the implemented M0-A application boundary, M0-B local
database foundation, M0-C accounts, identities, authorization, and auditing,
and the M0-D local checkpoint foundation. It is not evidence that a hosted
Site, production D1, or a production backup system exists.

## M0-A application

- `src/worker.ts` exports a module-style Fetch handler with a typed runtime
  environment.
- `src/application.ts` handles minimal internal health routing and delegates to
  `ApplicationServices`; it contains no storage queries.
- `src/services/` is the shared service entry point for future dashboard, API,
  and MCP callers.
- `src/contracts/` contains runtime and storage-probe interfaces.
- `src/local/storage-probe.ts` uses an injected SQLite connection for a local
  health check. It is not business storage logic.
- `scripts/dev.mjs` runs the application locally on Node's standard HTTP server.

The application uses standard `Request`/`Response` APIs and has no web
framework or Cloudflare-specific deployment dependency. Node 22 is the verified
local development and CI runtime. Compatibility with ChatGPT Sites and its
hosting environment remains unverified.

## M0-B local database foundation

- `website/migrations/` contains ordered, checksummed SQL migrations. The M0
  migrations create counties, accounts, identities, audit events, operations,
  and checkpoints. Migration 0004 adds the M1-A organization, county
  affiliation, people, position, role-source, and person-role tables without
  changing accepted M0 migrations. The first migration seeds the public
  64-county FIPS registry; migration 0003 adds the Colorado `08` FIPS-prefix
  constraint.
- `src/database/migrations.ts` validates contiguous versions, stored checksums,
  and unmanaged or incompatible databases. Each migration and its history row
  is applied in a local SQLite transaction; changed applied migrations are
  rejected rather than rewritten.
- `src/database/sqlite.ts` opens the local SQL.js WebAssembly SQLite adapter
  with foreign keys enabled. The adapter requires SQLite 3.37+ for `STRICT`
  tables and JSON validation, and exports optional local file databases on
  close.
- `src/database/versioned-writes.ts` performs allowlisted, conditional updates
  by expected row version. Mutable rows must advance exactly one version.
- The local harness runs migrations against an in-memory database by default.
  `DATABASE_PATH` can select an isolated local Website database file. Do not
  point it at the separate Profiles research database.
- Synthetic tests verify migrations, constraints, county identifiers,
  versioned updates, and migration rollback. No research records, D1/R2
  resources, credentials, or hosted services are used.

The migration SQL is exercised with SQLite compiled to WebAssembly. Its use of
SQLite-compatible DDL is intended to support D1, but no live D1 execution or
ChatGPT Sites runtime compatibility has been verified. SQL.js and the local
migration tooling are development/test dependencies; the Worker entrypoint
does not import them.

## M0-C accounts, identities, and audit

- One account model represents human and agent accounts. Human sign-in is
  behind an injectable identity adapter; only a test adapter is implemented.
  A request resolves to one active account or no principal.
- Agent credentials are 256-bit random bearer values with a `cwa_` prefix.
  Only their SHA-256 hashes are stored. The secret is returned only by the
  issuing call; identity subject, audit events, summaries, and logs never
  contain it. Credential identities support expiry and versioned revocation.
- Capability checks are centralized and default deny. The owner and
  administrator roles have the M0-D checkpoint capabilities
  `checkpoint.create`, `checkpoint.verify`, and `checkpoint.read`.
  `checkpoint.prune` is denied even to the owner. Contributor/editor roles have
  no capabilities in M0-C.
- The internal principal endpoint derives identity from authentication, never
  from a caller-supplied account ID. Account creation is routed through the
  shared service layer; account and identity services re-check the active
  account and capability before mutation.
- `runAuditedMutation` executes a mutation and its single audit event in one
  transaction. It accepts a trusted actor and optional operation ID, so M0-D
  can attribute checkpoint actions without a new transaction/audit mechanism.
  Account creation/updates, role changes, identity linking/issuance/revocation,
  and operation creation are audited. Audit rows are append-only and do not
  include PII or credentials.
- Account role updates use the existing optimistic version helper. M0-C
  extends its allowlist to `accounts.role`; schema triggers still require each
  mutable-row version to advance exactly once.
- `/_internal/live` reports process liveness without dependencies.
  `/_internal/ready` requires the local database/storage dependency;
  `/_internal/health` remains a readiness-compatible alias. The local harness
  forwards request headers and bodies. Worker and local-harness failures return
  sanitized responses and do not log exception details.
- Bootstrap of the first owner remains an environment-specific operation and
  is not exposed as an unauthenticated route. Tests seed only synthetic owners,
  accounts, and keys.

This adds no D1 binding or hosted compatibility claim. The Worker package still
uses the platform-standard Fetch surface; local database services are injected
and tested using SQL.js only.

## M0-D local checkpoints

- `src/local/checkpoints/` produces an immutable checkpoint bundle of the
  Website database and local file storage, verifies it by restoring into
  scratch storage, and tracks state in `operations` and `checkpoints`.
- Only a local directory destination exists. Pruning is refused. No off-site
  destination, encryption, schedule or hosted D1/R2 behavior is implemented.
- Every entrypoint requires an M0-C trusted principal with the matching
  checkpoint capability, and state changes are audited in the same
  transaction. No HTTP route exposes checkpoints. See
  [checkpoints](checkpoints.md) for format, guarantees and limits.

## M1-B bounded directory reads

- `src/contracts/directory.ts` defines page inputs and typed public projections.
  `src/services/directory.ts` exposes `listCountyOrganizations` and
  `listCountyRoleEntries` through the shared `ApplicationServices` boundary.
- Both operations validate a five-digit Colorado FIPS value against the seeded
  public county registry, default to 25 rows, cap requests at 100, and return
  deterministic keyset pages ordered by binary stable ID. `nextCursor` is the
  last returned organization ID or person-role ID; pass it back as `afterId`.
  An unknown but well-formed county returns an empty page. Pagination across
  concurrent writes does not provide a single point-in-time snapshot.
- Organizations report direct county membership separately from explicit
  county affiliation types. An organization reached by both paths appears once
  with both facts. `reports_to` and `grouped_under` remain the stored hierarchy
  relationship; a regional or partner affiliation does not imply reporting.
- Role entries preserve distinct role and person IDs, including same-name
  people and multiple roles. Projections include display name, role dates and
  source check date, position title, organization county association, public
  source title/URL/type, and stable IDs and row versions. No absent end date is
  interpreted as proof of current employment.
- These reads are read-only and add no audit events or row changes. Local tests
  use SQL.js and synthetic records; that does not prove compatibility with
  production D1 or ChatGPT Sites hosting. No public HTTP routes or hosted
  deployment are included.

## M1-C public person-profile reads

- `GET /api/people/{personId}` reads a person by stable Website ID and returns
  the display name and row version with a bounded page of documented roles.
  `limit` defaults to 25 and is capped at 100; `afterRoleId` continues in
  binary role-ID order.
- Role projections include stored role dates, source-check timestamp, position,
  organization, source citation, and row versions. Direct organization county
  assignments and explicit county affiliations are represented separately;
  affiliation IDs, relationship types, and versions are retained. No county
  membership is inferred from organizational hierarchy.
- Missing people return 404, malformed IDs or parameters return 400, and
  unsupported methods return 405. These public reads do not authenticate,
  mutate records, write audit events, or determine current employment.
- Synthetic Website tests exercise the local SQL.js adapter. Hosted D1 and
  production deployment compatibility remain unverified.

## M1-E public county overview

- `GET /api/counties/{countyFips}` returns the stored five-digit Colorado
  county FIPS code and name, `organizationCounts` (`total`, `direct`, and
  `affiliated`), and `documentedRoleCount`. It is read-only and uses only
  Website database records.
- `direct` counts distinct organizations whose `county_fips` names the county.
  `affiliated` counts distinct organizations with an explicit county
  affiliation. An organization associated both ways contributes to both
  subtotals but only once to `total`, which counts the union.
- `documentedRoleCount` counts source-backed role records associated with any
  organization in that union. It counts role records, not unique people, and
  includes records regardless of stored end date. The totals describe records
  in the Website database; they do not measure real-world staffing or
  completeness, imply current employment or vacancies, or classify a regional
  affiliate as a county department.
- A malformed or non-Colorado FIPS value returns 400 `invalid_request`; a
  well-formed but unknown county returns 404 `not_found`. Query parameters are
  not accepted. The existing county organization/role, person-profile, and
  organization-profile reads remain unchanged.
- The overview uses aggregate SQL over Website tables and does not read the
  separate private Profiles database. Synthetic Website tests use the local
  SQL.js adapter; hosted D1 and production deployment compatibility remain
  unverified.

## M1-F public directory discovery

- `GET /api/people?query=...` and `GET /api/organizations?query=...` search
  stored Website display names. `query` is required and trimmed; it must
  contain 2–100 characters. `limit` defaults to 25 and is capped at 100;
  `cursor` continues the matching collection and query using the previous
  `nextCursor`. Responses use `items`, `hasMore`, and `nextCursor`.
- People results contain only stable ID, stored display name, and version.
  Organization results contain stable ID, stored name, organization type, and
  version; they do not imply county department status or include county
  relationships. Existing person and organization profile routes retain their
  detailed records.
- Results are ordered by name using SQLite `NOCASE`, then stable ID using
  binary ordering. Keyset cursors are opaque and bound to the exact trimmed
  query and collection; malformed, stale, or mismatched cursors return 400.
  Each response is bounded, but pagination across concurrent record changes
  does not provide a point-in-time snapshot.
- Name matching uses parameterized SQLite `LIKE` with `%`, `_`, and the escape
  character treated literally in caller input. SQLite's default case
  insensitivity covers ASCII, not general Unicode case folding. Substring
  matching uses a leading wildcard and has no supporting index or FTS
  migration, so database work can scan and sort matching rows.
- These read-only endpoints use only Website records, do not match identities,
  merge identical names, or access the private Profiles database. Local
  synthetic tests exercise SQL.js; hosted D1 and production deployment
  compatibility remain unverified.

## M4 public website alpha

- `src/site/` renders the public HTML site from the shared service layer and
  is composed with the unchanged JSON application for the local preview
  (`npm run site:dev`). The service layer gains only `listCounties()`. See
  [public website alpha](public-site.md). No hosted deployment is included or
  verified.

## Deferred milestones

- **M1:** attach organization, person, employment, and role-source tables to
  the Website schema using its version convention. County organizations can
  retain their own structures; regional or partner offices can serve a county
  without being county departments.
- **M1-A:** migration 0004 adds county-scoped organization hierarchies with
  county-government records bound to their county, explicit reporting or
  grouping relationships, separate regional/partner county affiliations,
  people, positions, public role sources, and source-backed person-role
  associations. These tables contain no seeded personnel data and have no
  identity-merge, UI, or hosted-service behavior.
- **M2:** M2-B implements the internal read-only planner. M2-C adds the local
  atomic commit and durable replay foundation with compact future reversal
  metadata. It is intentionally not exposed through the shared service layer
  and does not grant production sync capabilities. Hosted D1 behavior, API
  integration, duplicate-flag lifecycle and reversal remain deferred. The
  current contract and limits are recorded in
  [site-sync-contract.md](site-sync-contract.md).

These are scope boundaries, not claims that the deferred capabilities exist.

The local database uses SQL.js WebAssembly rather than a native SQLite binding:
clean dependency installation must work on Windows without a C++ toolchain.
This changes only the local adapter choice; the Website schema remains SQLite
DDL. Hosted D1 behavior has not been tested.

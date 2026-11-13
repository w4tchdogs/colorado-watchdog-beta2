# Website foundation status

This document describes the implemented M0-A application boundary, M0-B local
database foundation, and M0-C accounts, identities, authorization, and auditing.
It is not evidence that M0-D, a hosted Site, or production D1 exists.

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

- `website/migrations/` contains ordered, checksummed SQL migrations for the
  six Website tables: counties, accounts, identities, audit events, operations,
  and checkpoints. The first migration seeds the public 64-county FIPS registry;
  migration 0003 adds the Colorado `08` FIPS-prefix constraint without changing
  the accepted M0-B migrations.
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

## Deferred milestones

- **M0-D:** checkpoint production, verification/restore, and local destination
  adapter. Only the authorization and transactional audit extension contract
  is present; no checkpoint producer, verifier, restore path, destination
  adapter, or prune operation is implemented. Off-site destination remains
  undecided until one is configured.
- **M1:** attach organization, person, employment, and role-source tables to
  the Website schema using its version convention. County organizations can
  retain their own structures; regional or partner offices can serve a county
  without being county departments.
- **M2:** add bounded reads and version-checked changesets, sync batches,
  duplicate flags, and reversible operations using versions, operations, and
  audit events through the shared service layer.

These are scope boundaries, not claims that the deferred capabilities exist.

The local database uses SQL.js WebAssembly rather than a native SQLite binding:
clean dependency installation must work on Windows without a C++ toolchain.
This changes only the local adapter choice; the Website schema remains SQLite
DDL. Hosted D1 behavior has not been tested.

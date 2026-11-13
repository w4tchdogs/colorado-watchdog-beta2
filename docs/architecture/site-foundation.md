# Website foundation status

This document describes the implemented M0-A application boundary and M0-B
local database foundation. It is not evidence that the full M0 foundation, a
hosted Site, or production D1 exists.

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
  and checkpoints. The first migration seeds the public 64-county FIPS registry.
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
does not import them. The migration history, version helper and append-only
audit-table constraints are foundations, not M0-C audit service behavior.

## Deferred milestones

- **M0-C:** account and identity services, human/agent authentication,
  default-deny capabilities, and transactional audit writes.
- **M0-D:** checkpoint production, restore verification, and local destination
  adapter. Off-site destination remains undecided until one is configured.
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

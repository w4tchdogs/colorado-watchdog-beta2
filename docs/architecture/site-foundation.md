# Website foundation status

This document describes the implemented M0-A application boundary only. It is
not evidence that the full M0 foundation, a hosted Site, or production D1
exists.

## M0-A application

- `src/worker.ts` exports a module-style Fetch handler with a typed runtime
  environment.
- `src/application.ts` handles minimal internal health routing and delegates to
  `ApplicationServices`; it contains no storage queries.
- `src/services/` is the shared service entry point for future dashboard, API,
  and MCP callers.
- `src/contracts/` contains runtime and storage-probe interfaces.
- `src/local/storage-probe.ts` is a deterministic test/development fake. It is
  not persistent storage.
- `scripts/dev.mjs` runs the application locally on Node's standard HTTP server.

The application uses standard `Request`/`Response` APIs and has no web
framework or Cloudflare-specific deployment dependency. Node 22 is the verified
local development and CI runtime. Compatibility with ChatGPT Sites and its
hosting environment remains unverified. No D1/R2 binding, SQLite database,
credential, Site, or deployment is included.

## Deferred milestones

- **M0-B:** Website D1-compatible schema and migrations, county seed, common
  version/timestamp conventions, and relational constraints.
- **M0-C:** accounts, identities, human/agent authentication, default-deny
  capabilities, and transactional audit events.
- **M0-D:** checkpoint production, restore verification, and local destination
  adapter. Off-site destination remains undecided until one is configured.
- **M1:** attach organization, person, employment, and role-source tables to
  the Website schema using its version convention.
- **M2:** add bounded reads and version-checked changesets, sync batches,
  duplicate flags, and reversible operations using versions, operations, and
  audit events.

These are scope boundaries, not claims that the deferred capabilities exist.

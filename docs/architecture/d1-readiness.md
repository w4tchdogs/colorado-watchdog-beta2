# D1 compatibility readiness

Status: **not ready for D1 integration**. This note records a local compatibility
probe and the database work that remains. No D1 database was provisioned or
written during this work.

## Verified locally

The Website boundary in `src/database/sqlite.ts` is synchronous SQL.js:

- `prepare().get()`, `all()`, and `run()` return synchronously.
- `transaction(callback)` returns a thunk. Invoking it starts `BEGIN IMMEDIATE`,
  runs a synchronous callback, then commits or rolls back.
- Foreign keys are enabled before migrations. The local migration runner checks
  migration names and checksums, applies each new migration in a local
  transaction, and runs `foreign_key_check` afterward.
- Migrations 0005–0008 apply locally on SQLite 3.37+ and add the sync batch,
  reversal, duplicate-flag, and observation tables and indexes. Existing tests
  cover migration reapplication; the D1 readiness probe also checks foreign-key
  enforcement, actor/idempotency uniqueness, and rollback of data, batch, and
  audit writes together.

These checks describe SQL.js/SQLite behavior only. They do not establish D1
compatibility or production readiness.

## D1 gaps

D1 prepared statement calls are asynchronous (`first()`, `all()`, and `run()`)
and return D1 result shapes. The current services expect synchronous row values
throughout planning and commit/reversal. D1 `batch()` runs a submitted sequence
of prepared statements sequentially as one transaction and rolls back the
sequence if a statement fails, but the current sync algorithms perform reads,
branch on those results, and then write inside a synchronous callback. A D1
implementation must redesign that boundary and prove that every data-dependent
decision and its guarded writes are covered by an appropriate atomic unit.

The local `BEGIN IMMEDIATE` writer serialization has not been demonstrated for
D1. D1's single-threaded database execution and atomic batch semantics do not by
themselves prove the current read/plan/write race behavior, concurrent
idempotency winner handling, or commit/reversal behavior across separate
requests. The stored idempotency and reversal rows are useful durable replay
records, but uncertain hosted outcomes and retries still need D1-specific tests.

The Website migration runner is custom and uses synchronous `exec`, `pragma`,
and statement APIs. The SQL in migrations 0005–0008 has not been applied through
Wrangler or checked against a hosted D1 database. Local acceptance of `STRICT`,
JSON checks, indexes, and the migration 0008 window-function backfill is not
proof of compatibility with the configured D1 migration path.

## Required before claiming readiness

1. Introduce an explicitly asynchronous database/service boundary; do not adapt
   D1 to the synchronous `WebsiteDatabase` shape.
2. Apply migrations 0001–0008 to an isolated D1 database and verify schema,
   foreign keys, unique constraints, and migration replay behavior.
3. Exercise commit plus audit, idempotency replay, reversal plus audit, rollback
   on an injected failure, concurrent identical and conflicting requests, and
   retries after an uncertain response using the real D1 binding/API.
4. Confirm actor scoping, current authorization checks, and restored state after
   process/request boundaries. Keep sync authorization default-deny and routes
   unregistered until those checks and a separate activation authorization are
   complete.

References: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

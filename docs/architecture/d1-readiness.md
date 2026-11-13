# D1 compatibility readiness

Status: **local Wrangler D1 compatibility is exercised; Website integration with
D1 is not ready**. All tests use synthetic rows in a disposable local database.
They do not access hosted D1, production resources or credentials.

## Verified SQL.js behavior

The Website boundary in `src/database/sqlite.ts` is synchronous SQL.js:

- `prepare().get()`, `all()`, and `run()` return synchronously.
- `transaction(callback)` returns a thunk. Invoking it starts `BEGIN IMMEDIATE`,
  runs a synchronous callback, then commits or rolls back.
- The Website migration runner validates ordered migration names and SHA-256
  checksums in its custom `schema_migrations` table, applies new migrations in
  a local transaction, and runs `foreign_key_check` afterward.
- Existing Website tests establish SQL.js behavior for constraints, schema,
  migration reapplication and the current synchronous transactions. They are
  not D1 evidence.

## Verified Wrangler local-D1 behavior

`npm run test:d1` uses the pinned Wrangler development tool with
`wrangler.d1-test.toml`. It explicitly selects `--local`, writes persistence to
a unique temporary directory, starts `wrangler dev` on loopback, and removes
the directory and Worker process in `finally`. Its synthetic database ID is a
local config identifier only. No remote operation or deployment is used.

The harness applies the unchanged Website migrations 0001–0009 in version
order using Wrangler's local D1 execution. It creates and inspects the Website's
existing `schema_migrations(version, name, sha256)` model and records each
source migration's normalized SHA-256. It does not configure or rely on
Wrangler's separate migration-history facility. The setup inserts the Website
history entry immediately after executing each migration; this is test setup,
not an atomic production migration runner.

Before migration 0008 it seeds one synthetic legacy duplicate flag, batch,
people and actor, then checks that 0008's `ROW_NUMBER()` backfill preserves the
expected observation links. It also checks ordered history, schema objects,
`STRICT` tables, migration 0009 content relationship tables, foreign-key
integrity. The runtime rejects `PRAGMA integrity_check` with `SQLITE_AUTH`
through both the Worker binding and `wrangler d1 execute --local`, so the
harness cannot run SQLite's full integrity pragma through supported local D1
interfaces. It does not replace that check with SQL.js.

The local D1 Worker checks asynchronous prepared-statement `bind()`, `first()`
and `all()` calls and returned values; JSON and foreign-key constraint failures;
`batch()` rollback after a later statement fails; unique actor/idempotency-key
enforcement; and a version-guarded update that rejects a stale version. Separate
Worker requests verify the inserted row remains available across requests in
the same Wrangler local session. These checks describe this installed local
Wrangler/workerd D1 implementation, not hosted D1 service behavior.

## Still unverified on hosted D1

No hosted D1 database was accessed. Hosted execution/version differences,
operational limits, concurrent requests, uncertain-response retries, remote
backup/restore and production migration operations remain unverified.

Local `batch()` rollback demonstrates D1 batch atomicity for a predetermined
sequence. It does **not** prove that the current synchronous M2 commit or
reversal algorithm is safe on D1, nor does it establish atomicity for a
read/plan/write flow whose decisions depend on earlier query results.

## Remaining work before D1 integration

1. Introduce and adopt an explicitly asynchronous database and service boundary;
   do not adapt D1 to the synchronous `WebsiteDatabase` shape.
2. Design async commit and reversal paths so data-dependent reads, authorization,
   uniqueness/idempotency decisions, guarded writes and audit rows are covered
   by suitable atomic operations.
3. Test commit plus audit, replay, reversal plus audit, injected failure,
   concurrent identical/conflicting requests and uncertain-response retries
   against a D1-capable isolated environment. Keep synchronization routes
   unregistered and default-deny until that work and separate activation
   authorization are complete.
4. Separately authorize and verify any hosted-D1 migration or operational test.

References: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
[D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/),
and [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/).

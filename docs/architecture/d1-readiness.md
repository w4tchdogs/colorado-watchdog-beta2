# D1 compatibility readiness

Status: **the internal asynchronous M2 commit/replay path is implemented and
exercised on disposable local Wrangler D1**. All tests use synthetic rows. They
do not access hosted D1, production resources or credentials. Production routes
and synchronization capabilities remain disabled.

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

The harness applies Website migrations 0001–0011 in version
order using Wrangler's local D1 execution. It also applies all ten migrations
to a second independent empty local store and checks the content tables, the
revision index and triggers, exact migration names and normalized SHA-256
checksums, contiguous history and the absence of baselines for an empty store.
It creates and inspects the Website's
existing `schema_migrations(version, name, sha256)` model and records each
source migration's normalized SHA-256. It does not configure or rely on
Wrangler's separate migration-history facility. The setup inserts the Website
history entry immediately after executing each migration; this is test setup,
not an atomic production migration runner.

Before migration 0008 it seeds one synthetic legacy duplicate flag, batch,
people and actor, then checks that 0008's `ROW_NUMBER()` backfill preserves the
expected observation links. After migration 0009 and before 0010, it seeds
synthetic content with non-default versions, Markdown, metadata, timestamps,
accounts and explicit county/person/organization links. The 0010 checks confirm
one baseline per item at its actual version, exact content and timestamp
preservation, binary-sorted relationship JSON, no earlier fabricated
revisions, required table/index/triggers, append-only enforcement,
matching-version insertion, revision CHECK constraints and revision foreign
keys. It also checks ordered history, schema objects, `STRICT` tables, 0009
relationship tables and `foreign_key_check`. The runtime rejects `PRAGMA integrity_check` with `SQLITE_AUTH`
through both the Worker binding and `wrangler d1 execute --local`, so the
harness cannot run SQLite's full integrity pragma through supported local D1
interfaces. It does not replace that check with SQL.js.

The local D1 Worker checks asynchronous prepared-statement `bind()`, `first()`
and `all()` calls and returned values; JSON and foreign-key constraint failures;
`batch()` rollback after a later statement fails; unique actor/idempotency-key
enforcement; and a version-guarded update that rejects a stale version. It also
commits a content/revision/audit batch and injects a mismatched revision version
into a second batch, confirming that none of its three records remain after
failure. Separate Worker requests verify the inserted row remains available
across requests in the same Wrangler local session. The Website SQL.js tests
continue to cover migration-runner reapplication: recorded migrations are
checksum-validated and skipped without changing history or schema. Migration
0010 itself is a one-time, non-idempotent SQL migration; the local D1 harness
checks its recorded source checksum and completed state instead of replaying
its DDL. These checks describe this installed local Wrangler/workerd D1
implementation, not hosted D1 service behavior.

Migration 0011 adds the Website dependency generation and INSERT, UPDATE and
DELETE triggers for all current application tables. Local D1 checks verify all
66 triggers, a valid generation assertion against an active synthetic principal,
and atomic rollback when the captured generation is stale.

The production-code asynchronous M2 planner and commit/replay service also run
through the same local D1 Worker. They verify complete six-item dependent
commits, generated ID mappings, inverse metadata, duplicate-flag observations,
audit attribution, replay after a changed request ID, competing idempotency-key
requests, and same-row expected-version contention. Injected failures at record,
batch-item, duplicate-observation and audit insertion each leave no partial
state. Separate SQL.js-backed tests compare the asynchronous planner's result
with the accepted synchronous planner. These results do not certify hosted D1.

## Still unverified on hosted D1

No hosted D1 database was accessed. Hosted execution/version differences,
operational limits, concurrent requests, uncertain-response retries, remote
backup/restore and production migration operations remain unverified.

Local `batch()` tests do not certify hosted D1 behavior or remote operational
limits. No hosted D1 was accessed.

## Remaining boundaries

1. Hosted D1 compatibility, concurrency, operational limits, remote
   migration/backup/restore and uncertain transport response behavior remain
   unverified.
2. The asynchronous engine remains internal, default-deny and unregistered. Its
   test-only authorizer is synthetic; no production `sync.apply` grant or route
   exists.
3. D1 reversal remains unimplemented and must not be exposed until a separately
   guarded implementation is complete.
4. Any hosted-D1 migration or operational test needs its own authorization.

References: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
[D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/),
and [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/).

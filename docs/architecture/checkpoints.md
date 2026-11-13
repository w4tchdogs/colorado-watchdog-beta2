# Website checkpoints and restore verification (M0-D)

Status: implemented and tested locally with synthetic data. This is a local
checkpoint and recovery-verification foundation. It is not a production
disaster-recovery system. Nothing here has run against hosted D1 or R2.

## What is implemented

| Component | Location | Role |
| --- | --- | --- |
| Contracts | `src/contracts/checkpoints.ts` | Manifest, file store, destination and report types. No Node imports |
| Producer | `src/local/checkpoints/producer.ts` | Captures the database and files and publishes one bundle |
| Database snapshot | `src/local/checkpoints/database-snapshot.ts` | Consistent export and scratch restore |
| Verifier | `src/local/checkpoints/verifier.ts` | Restores a bundle into scratch storage and compares it with the manifest |
| File store | `src/local/checkpoints/file-store.ts` | Local directory standing in for R2 |
| Destination | `src/local/checkpoints/destination.ts` | Local immutable destination with `put`, `list`, `get`, `prune` |
| Lifecycle | `src/local/checkpoints/lifecycle.ts` | State in `operations` and `checkpoints`, crash recovery, M0-C authorization and audit |

All filesystem and SQL.js code is under `src/local/`. The Worker entrypoint
and `src/services/index.ts` import only the contract types. There is no HTTP
route and no command-line script for checkpoints.

## Bundle format, version 1

```text
<checkpoint-id>/
  manifest.json                 canonical JSON, written last
  db/schema.json                canonical JSON: user_version and every CREATE statement
  db/tables/<table>.jsonl       one canonical row per line, sorted
  files/<sha256>                file contents, stored once per distinct digest
```

The manifest records the format version, checkpoint identifier, creation
time, application commit, migration history and version, the schema member
digest, each table's columns, row count, size and SHA-256, each file's key,
size and SHA-256, and totals. The bundle contains the actual file bytes. The
application itself is identified by commit and is not copied into the bundle.

Canonical rules:

- **JSON documents:** keys sorted by UTF-16 code unit, no whitespace, integers
  only. A manifest that does not re-serialize to identical bytes is rejected.
- **Rows:** a JSON array in column order. `null` is SQL NULL. Other cells are
  `[tag, text]` pairs: `i` integer as decimal text (full 64-bit range), `r`
  real as its shortest round-trip decimal (negative zero is `-0`), `t` valid UTF-8 text, `x` text
  whose stored bytes are not valid UTF-8 (hex), `b` blob (hex). Non-ASCII
  characters are escaped, so table files are pure ASCII.
- **Negative zero:** `-0` is the only non-`String(Number)` real text, so the
  sign survives restore. SQLite itself normalizes `-0.0` to `0.0` when it is
  stored in a column with REAL or NUMERIC affinity, so only untyped or `ANY`
  columns can hold it, and a checkpoint records what is actually stored. The
  SQL.js adapter drops the sign of a numeric `-0` bound as a parameter, so the
  restore binds `-0` as text and casts it to REAL.
- **JSON columns:** stored by SQLite as text and preserved byte for byte. They
  are not parsed or reformatted.
- **Row order:** lines are sorted before hashing, so a digest does not depend
  on physical row order or on a primary key.
- **Table files:** lowercase identifier names are used directly. Any other
  name maps to `x-<32 hex of sha256(name)>.jsonl`.

Every table is discovered from the database at capture time, so a table added
by a later migration is included without code changes. Names with SQLite's
reserved `sqlite_` prefix are engine-internal and skipped, except
`sqlite_sequence`, which holds AUTOINCREMENT counters and is captured.
Generated columns are recomputed from the schema. Virtual tables are refused
rather than silently omitted.

## Snapshot consistency

The SQL.js adapter is synchronous and uses one connection. The whole database
capture (schema, migration history, table list and all rows) runs inside one
`BEGIN IMMEDIATE` transaction in a single synchronous call, before the
producer first awaits. No other statement can run in between. Capture fails
if called inside an open transaction. Capture also compares SQLite's
`total_changes()` before and after. That counter is cumulative for the
capture connection only, so the comparison confirms that this connection ran
no additional changing statement during capture. It does not detect writes
made through any other connection. Within the single synchronous connection
that no such writer exists, which is what makes the guarantee hold locally.

Limits of this guarantee:

- It holds for the local single-process SQL.js adapter only. Hosted D1 has no
  equivalent verified here. A D1 producer must prove its own consistent read
  or export before the same claim is made.
- The export is held in memory and bounded by `CheckpointLimits`.
- Files are captured after the database. There is no cross-store snapshot.
  Each file is read twice (inventory, then copy) and both reads must agree on
  digest, size and revision token. The store is listed again before the
  manifest is written. Any change fails the checkpoint and nothing is
  published. The local revision token is modification time, inode and size,
  so a rewrite that preserves all three and the content digest is not a
  change. Coordinated D1 and R2 snapshots remain future work.

## Verification

A checkpoint is verified only by restoring it. The verifier:

1. Reads the manifest, checks it against the digest recorded at production
   when one exists, and validates its structure strictly.
2. Requires the migration history to be a prefix of the migrations known to
   this checkout. An unknown version or changed migration fails.
3. Requires the member set to match exactly. Missing members, unexpected
   files and unexpected directories fail. Symlinks and special files fail.
4. Checks each member's size and SHA-256.
5. Restores the database into an empty scratch SQL.js database, runs
   `PRAGMA foreign_key_check` and `PRAGMA integrity_check`, re-exports the
   scratch copy with the producer's exporter and compares the schema digest,
   migration history and every table's row count and content digest.
6. Restores every file into a scratch directory, lists it and re-hashes it.

The live database, live file storage and the bundle are only read. The
scratch directory is removed afterwards.

Bundle defects produce a failed report with bounded, sanitized diagnostics
that name tables, keys and members, never row values or file contents. A
bundle author controls schema identifiers, so SQLite's restore error text is
never echoed. A rejected restore reports a fixed description chosen from the
error's message prefix (for example "a CHECK constraint failed") or generic
fixed text, and the subject is always `database`. An
environmental failure (for example a scratch disk error) throws instead, so
an interrupted run is never recorded as a verdict.

A bundle is a full copy of the Website database and files, including account
emails and credential hashes. It is unencrypted and must be protected like
the database itself.

**Integrity is not provenance.** SHA-256 digests prove a bundle is consistent
with the manifest supplied. Someone who can rewrite a bundle can rewrite its
manifest to match. The digest stored in the `checkpoints` row at production
time detects that for recorded checkpoints. There is no signing, encryption
or key custody in M0-D.

## Destination

`LocalDirectoryDestination` stages a bundle under `staging/<id>-<random>/`
and publishes it with one directory rename into `published/<id>/`. Only
`published/` is listed. An existing identifier is rejected and never merged or
replaced. Members are created exclusively and read-only. The class has no
update or delete path for published bundles. A failed `put` removes only its
own unpublished staging directory. Staging left by a crash is ignored and can
be removed by hand.

`prune` always throws `prune_disabled`. No retention policy, schedule or
off-site destination is configured. Pruning is disabled unconditionally. It
is not an authorized operation for any principal.

## Lifecycle and crash recovery

| State | `operations` | `checkpoints` |
| --- | --- | --- |
| Capturing | `running`, phase `capturing` | no row |
| Publishing | `running`, phase `publishing`, manifest digest recorded | no row |
| Failed production | `failed`, phase `failed_before_publication` | no row |
| Published, unverified | `succeeded`, verification `pending` | `pending` |
| Published, not recorded | `failed` `record_failed`, or `running` after a crash | no row |
| Restore verified | verify operation `succeeded` | `verified` with `verified_at` |
| Failed verification | verify operation `failed` `verification_failed` | `failed` |
| Interrupted verification | verify operation `failed` or left `running` | unchanged |

A `checkpoints` row exists only for a published bundle and always starts as
`pending`. Creating a checkpoint never reports it as verified.

The row, the operation update and the audit event are written in one
database transaction. Publishing files cannot be part of that transaction.
The boundary is handled explicitly:

- **Crash while staging:** nothing is published. The identifier can be reused.
- **Crash after publication, before the row:** the bundle is an orphan. A
  retry with the same identifier is rejected. `reconcile` records it only if
  a create operation recorded the same manifest digest before publication and
  a full restore verification passes. Otherwise it is reported as untrusted
  and left in place.
- **Crash during scratch restore, or before the verdict is recorded:** the
  checkpoint keeps its previous status. Verification can be run again.
- **Operations left `pending` or `running`:** `reconcile` marks them `failed`
  with `interrupted`.
- **Row without a bundle:** reported by `reconcile`. Verifying it records
  `failed` with `bundle_missing`.

Repeated verification re-runs the restore. The row always holds the latest
completed verdict and earlier verdicts remain in the audit trail.

## M0-C authorization and audit

M0-C (PR #18) merged while M0-D was in progress, and the lifecycle uses its
accepted contracts directly. There is no separate checkpoint identity or
authorization mechanism.

- Every operational entrypoint (`create`, `verify`, `reconcile`, `list`,
  `read`) takes an M0-C `TrustedPrincipal` and calls `requireCapability` with
  `checkpoint.create`, `checkpoint.verify` or `checkpoint.read`. `reconcile`
  requires both create and verify. No entrypoint accepts an account identifier
  from its caller. `prune` is the one exception: it takes no principal and
  performs no capability check, because there is nothing to authorize.
- Operations are created through M0-C `createOperation`, which attributes and
  audits them.
- Each checkpoint state change and its audit event commit in one transaction
  through `runAuditedMutation`. Actions: `checkpoint.created`,
  `checkpoint.verified`, `checkpoint.verification_failed`,
  `checkpoint.reconciled`. A failed or denied action writes no checkpoint
  audit event.
- `prune` is refused unconditionally, for owner, administrator, agent,
  contributor and absent or invalid principals alike, and deletes nothing.
  M0-C independently denies `checkpoint.prune` to every role, so no principal
  could pass a capability check even if one were added. Do not add a permitted
  pruning capability or a code path past `prune_disabled` without a separately
  scoped assignment.
- `ApplicationServices.checkpoints()` returns the service when a host injects
  one and otherwise throws. The Worker and the local harness inject none, and
  no route calls it.

Capability is checked when a call starts. A long-running create or verify is
not re-authorized when it records its result.

## Not implemented

- Hosted D1 export, R2 capture or any hosted verification.
- Off-site destination, encryption, signing or key custody.
- Schedules, retention or pruning.
- Restore into a live Website database.
- Streaming for very large tables or files. Exports are bounded in memory.
- File keys outside the conservative local grammar (letters, digits, `.`,
  `_`, `-`, with `/` separators).

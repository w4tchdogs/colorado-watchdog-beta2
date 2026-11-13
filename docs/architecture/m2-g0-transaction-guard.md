# M2-G0 cross-writer transaction guard

## Finding

The M2-C transaction is safe today because SQL.js opens `BEGIN IMMEDIATE` before
its in-transaction authorization and planner reads. A D1 implementation cannot
perform those reads synchronously inside the existing transaction callback.
A D1 batch is atomic, but a read and plan done before that batch can be stale.
Row versions and uniqueness constraints cover only some of the planner's
assumptions.

The smallest candidate that covers missing rows and multi-row dependencies is
a single monotonically increasing Website dependency generation. Database
triggers advance it on every insert, update, and delete in the tables that can
affect a sync decision. Planning reads the generation before its async lookups.
The commit batch begins with an insert-select assertion against the captured
generation into a one-row table whose `CHECK (valid = 1)` makes a mismatch fail.
The batch deletes that assertion row after writing; rollback also removes it.
The same D1 batch contains all writes, batch/item results, duplicate flags,
generation-changing triggers, and the audit row. A concurrent change committed
before the batch makes the assertion fail; one ordered after it sees a complete
commit. D1's batch transaction supplies the serialization point. No Worker
mutex or Sessions bookmark is involved.

The test fixture in `tests/d1/worker.mjs` and
`scripts/d1-local-check.mjs` is an executable prototype, not a production
migration or an implemented async M2 commit. It installs triggers only in the
disposable Wrangler local database. The assertion is deliberately the first
batch statement, and its CHECK failure is the actual rollback mechanism.

## Dependency map and current enforcement

| Planner dependency | Existing protection | Generation trigger needed |
|---|---|---|
| Current actor, status, identity and credential validity | M0-C service reads; account/identity version triggers; foreign keys | `accounts`, `identities` |
| Capability and authorization state | Current capability check reads current Website state; no sync grants are active | Account/identity and any future capability/grant tables |
| Actor-scoped idempotency key and fingerprint | `UNIQUE(actor_account_id, idempotency_key)`; service fingerprint comparison | `sync_batches` |
| Updated row version and row existence | `version` checks and version-increment triggers; conditional versioned writes | Six M1 sync entities |
| County existence and organization county membership | county foreign keys; parent/county and child/split triggers; planner checks | `counties`, `organizations` |
| Parent/child hierarchy, cycle and county consistency | FK, self-parent check, insert/update county triggers and update cycle trigger; deeper planner checks remain app-level | `organizations` |
| County affiliations and absence of the requested relation | Unique `(organization_id, county_fips, relationship_type)` and FKs | `organization_county_affiliations` |
| Person, position, role and source references | Foreign keys; planner checks; role/source relationship has no planner-wide snapshot | `people`, `positions`, `person_roles`, `role_sources` |
| Reusable source URL and metadata | `role_sources.url UNIQUE`; metadata equality is application-checked | `role_sources` |
| Missing rows / candidate sets | No generic constraint can guard an arbitrary earlier absence check | Every table read to decide the plan |
| Duplicate pair, ownership and observations | Unique normalized person pair; FKs; unique `(batch_id, report_position)` | `person_duplicate_flags`, observations, source/person tables |
| Batch items and audit attribution/evidence | FKs, checks, audit append-only triggers; transaction-owned app insertion | `sync_batches`, items, reversals, `audit_events`, accounts |

The fixture additionally advances the generation for content tables, to model a
single Website-wide generation. A production implementation could narrow the
set only after proving no planner dependency crosses the boundary. County
registry maintenance, normal account/identity services, sync commit, sync
reversal, duplicate-flag lifecycle services, and any direct SQL/admin/import
writer for these tables must all be covered. Triggers are the enforcement
boundary: service wrappers alone are insufficient. Future relevant tables
must add triggers in their migration. A database file where a table is
modified outside SQLite (or a writer with triggers disabled) is outside the
proof.

## Local race evidence

The disposable local Wrangler Worker test coordinates distinct HTTP requests
in a deterministic read/change/commit order. It verifies:

- A planner reads a version-1 organization, a second request updates it, and
  the first request's guarded same-row update rejects without overwriting the
  competing version.
- A hierarchy row/version change, newly inserted related position, new source
  URL, new county affiliation, actor deactivation, and competing actor-scoped
  idempotency key each invalidate the captured generation.
- Every failed assertion rolls back the probe write and audit together.
- A successful assertion commits its write and audit together.
- Two commit requests using one captured generation and row version produce
  one complete winner and one stale-generation rejection.

These are local Wrangler/workerd results, not hosted D1 results. The proof
establishes the trigger-plus-batch mechanism for the synthetic mutations above;
it does not prove production trigger completeness, hosted D1 behavior, response
loss/retry handling, contention limits, or the complete async M2 service.

## M2-G1 resumption conditions

M2-G1 can resume only by introducing an explicitly async boundary and applying
this generation assertion inside every commit and reversal batch. The
production migration must enumerate all planner-read tables and add insert,
update, and delete triggers. Every audit/batch/result write stays in that same
batch. The service must recheck current principal/capability and idempotency
ownership within the guarded operation and preserve row-version checks as an
additional per-record condition. A local mutation-path inventory and races
must cover every participating writer before any hosted operation is
considered. Hosted D1 remains a separate, unverified operational scope.

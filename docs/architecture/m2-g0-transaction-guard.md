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

Migration 0011 and the disposable D1 harness implement and verify the guard.
The local async M2 commit path uses it; the assertion is deliberately the first
batch statement, and its CHECK failure is the actual rollback mechanism.

## Dependency map and current enforcement

| Planner dependency                                        | Existing protection                                                                                                   | Generation trigger needed                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Current actor, status, identity and credential validity   | M0-C service reads; account/identity version triggers; foreign keys                                                   | `accounts`, `identities`                                     |
| Capability and authorization state                        | Current capability check reads current Website state; no sync grants are active                                       | Account/identity and any future capability/grant tables      |
| Actor-scoped idempotency key and fingerprint              | `UNIQUE(actor_account_id, idempotency_key)`; service fingerprint comparison                                           | `sync_batches`                                               |
| Updated row version and row existence                     | `version` checks and version-increment triggers; conditional versioned writes                                         | Six M1 sync entities                                         |
| County existence and organization county membership       | county foreign keys; parent/county and child/split triggers; planner checks                                           | `counties`, `organizations`                                  |
| Parent/child hierarchy, cycle and county consistency      | FK, self-parent check, insert/update county triggers and update cycle trigger; deeper planner checks remain app-level | `organizations`                                              |
| County affiliations and absence of the requested relation | Unique `(organization_id, county_fips, relationship_type)` and FKs                                                    | `organization_county_affiliations`                           |
| Person, position, role and source references              | Foreign keys; planner checks; role/source relationship has no planner-wide snapshot                                   | `people`, `positions`, `person_roles`, `role_sources`        |
| Reusable source URL and metadata                          | `role_sources.url UNIQUE`; metadata equality is application-checked                                                   | `role_sources`                                               |
| Missing rows / candidate sets                             | No generic constraint can guard an arbitrary earlier absence check                                                    | Every table read to decide the plan                          |
| Duplicate pair, ownership and observations                | Unique normalized person pair; FKs; unique `(batch_id, report_position)`                                              | `person_duplicate_flags`, observations, source/person tables |
| Batch items and audit attribution/evidence                | FKs, checks, audit append-only triggers; transaction-owned app insertion                                              | `sync_batches`, items, reversals, `audit_events`, accounts   |

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

## M2-G1 implementation status

Migration `0011_m2_dependency_generation.sql` implements the database-enforced
generation for the current schema. It adds the singleton
`website_dependency_generation` and all INSERT, UPDATE and DELETE triggers for
the 22 application tables: accounts, identities, operations, audits, checkpoints,
counties, organizations, affiliations, people, positions, role sources, roles,
sync batches/items/reversals, duplicate flags/observations, content items and
their three relationship tables, and content revisions. The disposable D1
harness checks all 66 trigger objects, a valid generation assertion, and rollback
after a stale assertion.

`schema_migrations` is excluded because migration bookkeeping cannot affect a
planner, authorization, idempotency, duplicate-flag or commit decision. The
dependency and per-row assertion tables are excluded because they are scratch
state written only inside a guarded batch; they do not feed any business query.
The generation singleton is changed only by its table triggers, so no recursive
trigger is created. Every future migration that adds a table
read by a synchronization decision must add the same three generation triggers;
the completeness check in the D1 harness must be updated with it.

The production-code asynchronous M2 planner and commit/replay service now use
this migration and boundary. `commitSyncChangesetD1` remains internal, has no
registered Website route, and defaults to denying `sync.apply` unless a caller
provides an authorizer. The local Wrangler harness supplies synthetic test
authorization. It verifies complete commits/replays, same-key and same-row
contention, and rollback when record, batch-item, duplicate-observation or audit
statements fail. See [d1-readiness.md](d1-readiness.md) for the full evidence and
hosted-D1 limits.

## Guard invariants retained

Every async commit captures the generation before planning reads, revalidates
clock-sensitive rules immediately before writing, and starts its atomic batch
with an assertion on both the captured generation and current principal. Exact
row-version assertions follow before mutations. All entity changes, batch/item
results, inverse metadata, duplicate-flag observations and audit records remain
in the same batch. Failed assertions or later SQL statements roll back the
entire batch. No Worker mutex, process-local coordination or D1 Sessions bookmark
is part of this guarantee. D1 reversal is not implemented by M2-G1.

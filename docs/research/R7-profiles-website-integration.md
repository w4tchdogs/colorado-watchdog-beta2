# R7 — Profiles to Website changesets and reconciliation

R7 adds a read-only, deterministic generator in `research/sync.py`. It emits
bounded `m2-sync/v1` changesets from selected research observations with explicit
structure and evidence-supported identity associations. The generator excludes
unresolved identities, unclassified source types, unsupported organization
hierarchy, non-current roles and private notes. It uses local permanent research
IDs as deterministic request references; equal names never associate people.

Website source types are accepted only when `sources.publisher_classification`
is `official`, `sources.page_type` is explicitly `official_page`,
`public_document` or `other_public`, and citation URL bytes equal the retained
source URL. `page_type` describes the page or document; it does not establish
the publisher. Unofficial and unresolved publishers are omitted for review. Organization
parentage is emitted only from an existing explicit local parent decision with
its evidence. Partner organizations have no county department parent; county
coverage is represented with `organization_county_affiliations`.

`prepare_research_submission` stores the exact compact request through the R6
`research/submission.py` client, then stores item-to-research lineage locally.
There is no default transport or production sender. `reconcile_submission`
accepts only the authoritative committed receipt durably stored by R6; pending
or uncertain outcomes never create a Website ID mapping. Repeated matching
receipts are no-ops. A conflicting Website ID, entity, request item or receipt
fails closed. Rejections are retained locally without ID assignment.

Migration `003_site_entity_reconciliation.sql` adds a Profiles-only mapping for
organizations, county affiliations, people, positions, public sources and roles,
plus source/claim lineage and receipt history. Existing person-only `site_links`
are carried forward as active mappings. Website-assigned IDs and versions remain
authoritative; no research tables or notes are copied into Website D1. Explicit
updates require a durable local approval record pinned to the mapped Website
version and evidence. Reversal receipts preserve mappings: reverted creates are
tombstoned, reversed updates require a fresh Website read, and reused rows remain
active. No mapping is silently deleted or regenerated after reversal.

The integration fixture is fictional and disposable. It exercises the existing
Website D1 planner, commit/replay and reversal implementations through a local
SQLite-backed D1 adapter, the existing directory reads, an injected R6 callback,
uncertain retry, receipt replay and a version-pinned update. This verifies local
service behavior only; it does not establish hosted D1 or network behavior.
Website migrations, Worker routes, account/auth services and public UI are not
modified. No production credentials or real county records are used.

# R6 — durable local Website submission client

R6 adds an additive research-database migration and a Python client boundary for
prepared `m2-sync/v1` commit requests. It stores the exact UTF-8 JSON text,
site-scoped idempotency key, canonical request fingerprint, attempt metadata,
and terminal response before considering a submission complete. Reusing a key
for the same canonical JSON returns the original prepared record without
replacing its payload; reusing it for different request content is rejected.

`prepare_submission` persists first. `submit_prepared` requires a caller-supplied
transport callback and passes the site key, commit path, JSON content type,
persisted idempotency key, and exact stored bytes. There is no default network
transport, credential lookup, CLI command, Website route registration, or
automatic send. A timeout, malformed success, or server error leaves the record
pending, so the caller can reopen the local database and retry the same bytes
with the same key. A valid committed receipt is stored once and returned on
subsequent calls without transport. A definite 4xx rejection is retained as
terminal. Transport errors are reduced to an `uncertain` result; their message
and request data are not written to logs.

The client does not build changesets from source observations or role claims.
The caller must prepare and review the Website contract explicitly; source
wording, historical status, identity decisions, evidence lineage, and local
claim state are not rewritten by this module. Website and Profiles databases
remain separate. Existing local `sync_batches`/`sync_items` remain distinct
from the new submission-request ledger.

R7 adds the bounded local generator and receipt mapping on top of this client;
see [R7 Profiles-to-Website integration](R7-profiles-website-integration.md).

Tests use temporary fictional databases and injected callbacks only. They cover
upgrade from a populated schema at migration 001, persistence before send,
restart/retry after uncertain delivery, exact payload and key reuse, canonical
fingerprint behavior, cross-site key scope, terminal acknowledgement/rejection,
and invalid/ambiguous request rejection. No permanent private database or real
county request was opened or changed. The Website sync route is still
unregistered, production grants remain absent, and hosted D1 behavior remains
unverified.

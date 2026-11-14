# R8 — Profiles synchronization operator workflow

R8 exposes the merged R7 generator and reconciliation path through the local
Profiles CLI. All commands require an explicit absolute SQLite path outside the
source checkout and emit JSON. No command sends a Website request.

## Commands

```powershell
python -m research sync-eligibility D:\private\profiles.sqlite --site-key colorado_watchdog_alpha1
python -m research sync-preview D:\private\profiles.sqlite --site-key colorado_watchdog_alpha1
python -m research sync-prepare D:\private\profiles.sqlite --site-key colorado_watchdog_alpha1 `
  --idempotency-key operator-batch-001 --select all --expect-fingerprint <sha256>
python -m research sync-status D:\private\profiles.sqlite --submission-id <submission-id>
python -m research sync-reconcile D:\private\profiles.sqlite --submission-id <submission-id>
```

`sync-eligibility` returns the eligible/excluded counts, reason-coded exclusions,
and the deterministic changeset fingerprint. `sync-preview` also returns the
proposed public-contract request. Both are read-only. R7 excludes unresolved
identity associations, unsupported organization or position relationships,
unselected claims, insufficient source classification, private notes, and
updates without explicit evidence-backed approval pinned to the current Website
version. Output excludes local evidence bodies, research notes, and stored
submission response bodies.

Preparation requires `--select all` to make the operator's selection explicit
and `--expect-fingerprint` to match the current preview. The 200-change R7
maximum remains in force. The request and idempotency key are persisted through
the R6 client before any sender could be invoked. Repeating the same command is
idempotent; a different request under the same idempotency key is rejected.
There is no CLI sender. If another explicitly injected caller ever attempts
delivery, R6 retains uncertain outcomes as pending and requires retrying the
same stored request. Reconciliation accepts only the authoritative receipt
stored by R6 and delegates entity mappings to R7; it cannot infer success from
a timeout or missing receipt. R7 reversal reconciliation retains mappings and
applies tombstone/refresh rules from its verified-receipt boundary.

All verification uses synthetic disposable research and Website databases.
Hosted D1 behavior, credentials, authorization grants, network transport, and
production synchronization remain prerequisites outside R8.

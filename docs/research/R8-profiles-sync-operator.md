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
proposed public-contract request. Both are read-only. Add `--county-fips 08001`
to either command for one canonical Colorado county. R7 first limits claim
observations and required organization dependencies to that county, then applies
the existing maximum 200-operation cap. Parent organizations required by those
observations remain in parent-before-child order; shared people, positions,
sources and organizations are emitted once. Without the flag, statewide
behavior is unchanged. County-scoped preview is an eligibility diagnostic;
`sync-prepare` remains the existing explicitly reviewed statewide workflow.

## Owner profile rule and implementation status

The owner decision recorded in docs/decisions.md (November 16, 2026) is implemented in the identity planner, the R7 builder and the local Website reads. A Profile needs a county, a name, and at least one of an office, a position or a job description. Same-county claims with the same name merge only when an office, a position or a job description aligns, and the plan records which detail aligned. Same-name claims with no aligned detail stay distinct profiles, and the plan counts those groups. Unknown organization type or unresolved hierarchy never excludes a role. The live Adams batch remains unselected.

Preview diagnostics report candidate claims, claims skipped because their batch
is unselected, selected-batch claims evaluated, distinct people, claims excluded
by reason, eligible claims, distinct eligible profiles, structured and
unstructured roles planned, planned operations by Website entity, and truncation
separately. The preview lists at most 200 individual
exclusions. Both commands remain read-only. R7 excludes unresolved
identity associations, unsupported organization or position relationships,
unselected claims, insufficient source classification, private notes, and
updates without explicit evidence-backed approval pinned to the current Website
version. Output excludes local evidence bodies, research notes, and stored
submission response bodies.

## Reviewed batch selection

Changing which existing family member is selected for eligibility analysis is
a separate local operator action. Preview writes a row-level plan outside the
source checkout. If another family version is selected, the preview displays
the batch that would be replaced. The plan records the intended operator and
reason, before/after selection, full family membership and latest decision
state. Apply requires the exact plan SHA and performs the selection update and
audit event in one immediate transaction. A repeated apply is idempotent.
Reversals are previewed and applied separately; they can restore the previous
batch or restore no selection. A stale plan or reversal after a later family
decision is rejected.

```powershell
$db = 'D:/ChatGPT/Watchdog/profiles/database/research.sqlite'
$plan = 'D:/ChatGPT/Watchdog/profiles/reports/adams-selection-plan-YYYY-MM-DD-v1.json'
python -B -m research preview-batch-selection $db --batch-id <existing-batch-id> `
  --actor 'operator' --reason 'Documented selection reason' --output $plan
python -B -m research apply-batch-selection $db --plan $plan --expect-plan-sha256 <plan-sha256>
python -B -m research sync-eligibility $db --site-key colorado_watchdog_alpha1 --county-fips 08001
python -B -m research sync-preview $db --site-key colorado_watchdog_alpha1 --county-fips 08001
```

To restore a previously selected state, use the audit event ID from the applied
operation and create a new private reversal plan:

```powershell
$reverse = 'D:/ChatGPT/Watchdog/profiles/reports/adams-selection-reversal-YYYY-MM-DD-v1.json'
python -B -m research preview-batch-selection-reversal $db --event-id <selection-event-id> `
  --actor 'operator' --reason 'Documented reversal reason' --output $reverse
python -B -m research apply-batch-selection-reversal $db --plan $reverse `
  --expect-plan-sha256 <plan-sha256>
```

Selection changes only existing batch `selected` flags and adds an audit run and
event. It does not alter identities, organization relationships or evidence.
No command here prepares or sends a Website changeset. Keep all plans and
identifiers in the private workspace.

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

Publisher classification and local exports are documented separately in
[publisher classification and private export](publisher-classification-and-private-export.md).
Those exports remain in the owner's private Watchdog workspace and do not
invoke R6 or create a Website changeset.

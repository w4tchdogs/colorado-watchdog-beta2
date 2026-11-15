# Statewide identity-backlog triage

`research.identity_triage` classifies every currently unassigned role claim using
the accepted `research.identity` planner. It does not infer identity from names,
departments, titles, dates, or similarity. It never searches for candidate people
outside the claim's county.

## Preview, apply, and verify

The report is private because it contains names, source URLs, claim/evidence IDs,
and retained evidence excerpts. Write it only to the owner's private Profiles
reports directory, outside the source checkout.

In the commands below, `<private-root>` is the owner's private Profiles folder
(`profiles\` in the local Watchdog workspace, outside this checkout).

```powershell
python -B -m research preview-identity-triage $db `
  --output '<private-root>\reports\identity-triage.json'

python -B -m research apply-identity-triage $db `
  --report '<private-root>\reports\identity-triage.json' `
  --expect-report-sha256 <file-sha256-from-preview> `
  --actor 'identity-backlog-triage'

python -B -m research verify-identity-triage $db `
  --report '<private-root>\reports\identity-triage.json' `
  --expect-report-sha256 <file-sha256-from-preview>
```

Preview is read-only. The outer report digest binds the complete triage and its
embedded identity plan. Application delegates to the existing county-transaction,
state-fingerprint, stale-plan, and audit validation in `research.identity`.
Only supported source classifications and person/claim decisions are written.
When the plan has no decisions, application returns `no_changes`, verification
returns `no_changes_verified`, and it creates no database run or event. New plans
audit actual decisions only; old plans retain their original event verification.

## Dispositions

Every unassigned claim appears once in the private `cases` list. The primary
disposition is one of:

- `automatically_resolvable`: the existing identity planner has a supported
  person bootstrap or direct claim association in the exact plan.
- `source_authority_review`: retained name/role evidence is direct, but the
  source's official authority is not established.
- `potential_identity_connection`: one or more existing same-county people are
  relevant candidates; a direct link is still required.
- `genuinely_ambiguous`: available evidence does not distinguish the identity
  or establish a direct connection.
- `version_or_lineage_dependent`: alternative or unselected corrected evidence
  cannot establish an identity under current selection rules.
- `ineligible`: the observation fails current person/role evidence criteria.

Authority is also reported as a blocker when it overlaps another primary
disposition. County and reason counts are mutually reconciled. The source queue
groups claims by exact source ID and URL, and ranks sources by affected claim
count. It names the smallest additional evidence requirement for each case.

## Source authority

Restricted `.gov` provenance is handled under the existing direct-name-and-role
rule. A non-`.gov` source can be proposed only when retained evidence attached to
that exact source URL explicitly identifies the cited page as the official
publication of the claim's county government. The planner records the evidence
ID and exact statement in its source-classification basis. This rule does not
trust a domain suffix, every page on one domain, or every county-related URL.
It does not create a source visit or claim fresh URL verification. Source
authority remains separate from identity association.

Triage findings are kept in the private report and do not create one event per
unresolved claim. Existing identity audit records and historical classifications
remain unchanged.

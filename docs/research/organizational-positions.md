# Evidence-led organizational and position foundation

`research.structure` plans and applies county-scoped units and documented
position types from existing `role_claims` and their linked `evidence_links`.
It does not fetch pages, create people, change identity decisions, select a
batch version, alter source visits, or change coverage. It adds no schema
migration and leaves the accepted `001_foundation.sql` checksum unchanged.

## Decision rules

- The exact county and source label are part of a unit's identity. Equal labels
  in different counties never share a unit. Exact source spelling is retained
  in `org_units.source_label` and each evidence-backed `org_names` row.
- `Directory display fallback` creates a `navigation` unit and a navigation
  source link. It does not establish a county office or position association.
- `Needs editorial review` and unsupported grouping bases remain `unknown`.
  The source's original department/division fields remain on the claim.
- An official `division_label` supports a `division`. A `department_label`
  supports `department` only when the exact label says Department/Dept. Other
  office labels remain `unknown`; elected/appointed status is never inferred
  from a familiar title or county convention.
- A regional, joint, multi-county, or judicial-district attorney label, or an
  explicit affiliation field, is classified as `partner`, retaining its exact
  label and county-scoped source evidence. It is not made a county department.
- An administrative parent link is recorded only when an official-structure
  observation supplies both a division and department label and all imported
  observations for that division agree on one exact parent. Conflicts and
  earlier recorded parent decisions are preserved as unresolved.
- A position target is one documented title type per county-local unit and is
  created only from an official-structure claim with a nonempty title and
  `Listed` source status. Exact titles are retained. Targets do not represent
  employment seats; occupancy remains `unknown`. Former/unclear observations
  can link to a separately supported target but cannot create one by
  themselves. Missing titles stay unresolved.
- All imported claims are evaluated, including unselected original and
  superseded versions. Their batches, evidence and nonadditive lineage are not
  changed. The planner does not count alternate versions as additional
  counties or identities.
- Every new association, evidence-backed name, target and unresolved case is
  recorded in `research_events` under one deterministic mapping run. Rerunning
  the same preview verifies the complete result and makes no writes.

These rules prefer a recorded `unknown` kind or an unresolved association when
the source does not support a narrower decision. The process never interprets
CSV checked dates as source visits, current employment dates, vacancy evidence,
or coverage review.

## Private preview and application

Use explicit database and plan paths outside the repository. A preview is
inspectable JSON and may contain private claim identifiers, titles, source IDs,
and organizational labels. Keep it in the private Profiles reports directory.
It contains no person names or private review notes.

In the commands below, `<private-root>` is the owner's private Profiles folder
(`profiles\` in the local Watchdog workspace, outside this checkout).

```powershell
python -B -m research preview-structure `
  "<private-root>\database\research.sqlite" `
  --output "<private-root>\reports\org-positions-plan.json"

python -B -m research apply-structure `
  "<private-root>\database\research.sqlite" `
  --plan "<private-root>\reports\org-positions-plan.json" `
  --expect-plan-sha256 <SHA256-from-preview> --actor "org-position-foundation" --apply

python -B -m research verify-structure `
  "<private-root>\database\research.sqlite" `
  --plan "<private-root>\reports\org-positions-plan.json"
```

Application recomputes the preview under an immediate SQLite write lock and
requires an exact plan hash. All writes occur in one transaction. A changed
source state, conflicting existing association, integrity failure, or foreign
key failure rolls back the entire operation. No runtime path may point into
this repository; preview and apply are local Profiles operations only.

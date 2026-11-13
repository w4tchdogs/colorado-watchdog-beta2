# R2 evidence-led identity bootstrap

R2 adds a local, transactional workflow for creating a research-person record from an existing source-backed role claim. It uses the R0 schema without migrations. It does not choose among existing people, infer identity from similar strings, resolve possible matches, merge records, or fetch sources.

## Bootstrap one person from one claim

Choose an existing unassigned claim and provide its county, exact published name, and evidence ID. The source must already be classified `official` in `sources.official_status`. The evidence must be the exact evidence attached to the claim, and its raw observation or quotation must contain the exact published name and a documented title or responsibility.

```text
python -B -m research bootstrap-person DB --county-fips 08107 --claim-id claim_fixture_1 --published-name "Synthetic Rowan Example" --evidence-id evidence_fixture_1 --actor "synthetic-operator" --rationale "The official fixture directory lists this exact name with the coordinator position."
```

The command copies the published name verbatim into `research_people.display_name` and creates its initial `published` name variant with the supplied evidence. It marks the person `evidence_supported`, then assigns the selected claim. One screening run and three auditable events record person creation, variant registration, and claim association. These writes commit or roll back together. The county and claim must agree; no duplicate-name check blocks a separately supported person.

The command intentionally requires a claim context and always associates that claim. It does not accept a normalized display name separate from the published source form.

## Add a name variant to an existing person

The cited official evidence must include the exact candidate form and an established name for the selected person, connected explicitly in the text. Supported link language includes forms such as “also known as”, “aka”, “formerly listed as”, or “name changed from”. Text that only places similar names near each other is rejected.

```text
python -B -m research add-name-variant DB --person-id person_fixture_1 --published-name "Rowan R. Example" --kind alternative --evidence-id evidence_fixture_alias --actor "synthetic-operator" --rationale "The official record explicitly connects the two name forms."
```

Allowed kinds are `published`, `nickname`, `former`, and `alternative`. Exact wording and punctuation are retained. Repeating the same person/name/type/evidence submission returns the existing variant with `created: false` and does not add a run or event. Evidence from another batch county is rejected; nonbatch evidence must already be tied to that person's county through the same source as a known name or an evidenced source-unit link.

## Identity boundary

Each bootstrap creates a new person row, even if an existing person has the same display name. A source-backed person record does not prove that two observations or two existing person records refer to the same individual. R2 does not create or resolve `possible_matches` automatically. Continue to use the existing possible-match workflow for unresolved identity questions. The existing `associate-claim` command remains available for explicitly selected existing people and retains its R1 evidence checks.

All examples use fictional IDs and the test suite uses only `example.invalid` sources and synthetic records.

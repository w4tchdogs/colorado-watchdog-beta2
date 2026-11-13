# Evidence-based people and identity foundation

`research.identity` plans and applies evidence-supported identity records from
the retained county role observations. It reuses the existing research schema
and migration history; it does not fetch sources, change batch selection, edit
role/evidence wording, or modify organization and position associations.

## Evidence and identity rules

- A source-backed claim can establish a person only when its exact published
  name and a documented title or responsibility both appear in the retained
  evidence, the name is plausible person text, and the source is already
  classified `official` or has verified official provenance under the rule
  below.
- An unknown source is proposed as `official` only when its exact cited URL is
  within the restricted `.gov` namespace and its retained observation directly
  contains that claim's exact name and role. The source classification and its
  evidence reference are audited. A source visit is never invented. Other
  hosts, including `.org`, `.us`, commercial hosting, and generic CSV labels,
  remain unclassified until their authority is established separately.
- County and exact-name equality, nickname/initial similarity, department,
  title, dates, and similarity scores never establish a person association.
  If several unlinked source observations in one county publish the same exact
  name, the planner leaves them unresolved instead of assigning them together.
- A claim may share a person with another claim when selected corrected-batch
  lineage directly links the source records within the same county and batch
  family, or when one official evidence record explicitly connects the exact
  published name to both documented roles. The operator also provides a
  separate command for a direct official connection between names and a role.
- A literal value in the same official record's `Nicknames` field can be added
  as a nickname variant. Unstructured, ambiguous, or unsupported forms remain
  unchanged in the source record and are not promoted to identity links.
- Original and complementary observations remain eligible. Only selected
  corrected versions are used as the active corrected observation; alternative
  versions are retained but do not create people or independent corroboration.
  Explicit correction links may associate the selected observation with its
  historical predecessor while preserving both claims and exact names.
- Historical and former-role claims can support identity, but the operation
  does not assert current employment. Regional and partner affiliations remain
  on their original claims and organizational units.
- Existing person assignments and identifiers are preserved. The operation
  never merges or deletes people, reassigns an already-associated claim, or
  changes a claim's unit or position target.

An unresolved case is recorded as a `research_events` entry with the claim and
evidence IDs, county, reason, and specific evidence that would resolve it.
`possible_matches` remains nonbinding and is not populated from exact names
alone. The current collection can therefore retain open claim-to-person
questions without inventing person pairs or forcing a merge.

## Private preview, application, and verification

Use absolute database and plan paths outside this repository. A plan contains
private names and claim/evidence IDs; keep it in the owner's private Profiles
reports directory.

```powershell
python -B -m research preview-identity `
  "C:\Users\n\AppData\Local\ColoradoWatchdog\Profiles\database\research.sqlite" `
  --output "C:\Users\n\AppData\Local\ColoradoWatchdog\Profiles\reports\identity-plan.json"

python -B -m research apply-identity `
  "C:\Users\n\AppData\Local\ColoradoWatchdog\Profiles\database\research.sqlite" `
  --plan "C:\Users\n\AppData\Local\ColoradoWatchdog\Profiles\reports\identity-plan.json" `
  --expect-plan-sha256 <SHA256-from-preview> --actor "evidence-based-identity-foundation"

python -B -m research verify-identity `
  "C:\Users\n\AppData\Local\ColoradoWatchdog\Profiles\database\research.sqlite" `
  --plan "C:\Users\n\AppData\Local\ColoradoWatchdog\Profiles\reports\identity-plan.json"
```

The plan records source classifications, person creation, supported claim
associations, name variants, nonbinding candidates, unresolved observations,
and ineligible observations separately. Application checks the plan digest,
revalidates all not-yet-applied counties before its first write, and commits the
source classification stage and each county atomically with deterministic
audit IDs. A stale or conflicting county is rejected without overwriting an
existing decision. An interrupted operation can resume by applying the same
plan; completed counties are verified and skipped. A repeated application adds
no records or events. Verification checks exact identities and audit rows,
foreign keys, and SQLite integrity.

The input scan is county-bounded. A county's claims and supporting evidence
are processed as one in-memory unit; the planner does not load the full research
database into memory. No schema migration is needed, and
`001_foundation.sql` remains unchanged.

## Direct operator associations

The strict exact-source association remains available. These narrowly scoped
extensions support cases that the original operator contract did not express:

```text
python -B -m research associate-claim-by-connection DB --claim-id CLAIM --person-id PERSON --evidence-id EVIDENCE --rationale "The official record directly connects this person to the documented role" --actor "operator-id"

python -B -m research associate-claim-by-correction-lineage DB --claim-id CLAIM --person-id PERSON --anchor-claim-id ANCHOR --rationale "The selected corrected batch explicitly supersedes this source record" --actor "operator-id"
```

Both operations retain county boundaries, require official direct evidence,
reject already-assigned claims, and record the supporting link and rationale
inside the same transaction as the association.

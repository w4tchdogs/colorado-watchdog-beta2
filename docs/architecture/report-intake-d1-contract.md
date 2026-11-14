# Proposed D1 report-intake contract (SUB-1A)

This is a coordination proposal, not a migration. Reports are private records and
are allegations, never findings or public content. No public read projection is
defined. Reporter tracking credentials do not authorize staff operations.

## Records and boundaries

- `reports`: server-generated opaque `id`; `county_id`; nullable typed
  `subject_kind`/`subject_id`; private description; reporter account reference
  (nullable), name/email and attribution/contact preferences; status; monotonically
  increasing version; server timestamps. Require confidential/private by default.
- `report_receipts`: one-to-one report ID; public-format random reference; salted
  or keyed hash of high-entropy recovery credential; creation timestamp. Never
  persist the raw recovery key or return it except on initial successful receipt.
- `report_idempotency`: actor scope and idempotency key under a unique constraint,
  request fingerprint and report ID. Atomic retries with same fingerprint return
  the same reference but never redisclose the recovery key; changed payload under
  the same key conflicts. The initial successful response is the only disclosure.
- `report_evidence`: report ID, stable evidence ID, private title/URL/note and
  optional later R2 object reference. R2 keys are opaque and never public. SUB-1A
  does not upload files or establish publication permissions.
- `report_status_history`: append-only report ID, prior/next status, version,
  trusted actor kind/ID, timestamp and private note. Unique `(report_id, version)`.
- `report_audit`: append-only structured action, report ID, trusted actor,
  timestamp and version; avoid body/contact/evidence values in audit metadata.

## Index/transaction contract

Unique receipt reference; unique `(actor_scope, idempotency_key)`; unique
`(report_id, version)` history; indexes `(status, created_at)` for staff queues,
`(county_id, created_at)` and `(subject_kind, subject_id, created_at)` for bounded
private review, and reporter account plus creation time for private account
tracking. No index or API exposes receipt hashes, contact data or body text.
Create writes the report, evidence metadata, receipt digest, history, audit and
idempotency row in one D1 transaction. Status changes use
`UPDATE ... WHERE id=? AND version=?`, then append history and audit in the same
transaction. Read authorization precedes private row lookup; tracking uses
reference plus constant-time credential verification and returns only an
allowlisted reporter projection. Public queries must never include this data.

## Legacy behaviors reviewed

Beta-1 materials describe anonymous and account submissions, private review,
guest reference plus separate recovery key shown once (not emailed), private
tracking, optional contact, private attachments, and distinct staff review history.
Preserve those privacy boundaries and attributable status history. Do not carry
forward implicit trust in caller-supplied IDs, direct uploads/publication,
unscoped lookup, coupled public/private review projections, or any behavior that
treats an allegation as a verified finding. This review used local source/docs
read-only; no report records, databases, credentials, or user information were
copied. Fable revision 4's Drive document was not accessible in this session;
repository decisions summary was consulted.

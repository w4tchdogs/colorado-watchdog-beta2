# R4-H1 — intake provenance and preflight hardening

R4-H1 adds a private quarantine operation for rejected **original** CSV deliveries, checks that a previewed county is registered under its canonical public name, and adds an attributed source-classification operation. It does not change the CSV mapping contracts, schema, migrations, or successful-delivery semantics.

## Rejected-original quarantine

`preview-csv` remains read-only. It does not save or move any file. To explicitly preserve an ineligible original delivery, first choose an existing private directory outside the repository and run:

```powershell
python -B -m research quarantine-invalid "D:/private/Profiles/database/research.sqlite" `
  --file "D:/private/Profiles/intake/08037/rejected-original.csv" `
  --root "D:/private/Profiles/quarantine" `
  --version legacy-17/v1 `
  --version-label rejected-original-v1 `
  --lineage-kind original `
  --provenance legacy_delivery
```

The command reuses the read-only preview rules and only stores an ineligible delivery. It requires an explicit mapping, version label, original lineage and an existing absolute quarantine root outside the source checkout. The root and content-addressed child are checked for symlinks/reparse points. The original filename is recorded as a basename; it is not used as a filesystem path.

Each completed artifact is stored under its SHA-256 digest with fixed filenames `source.bin` and `manifest.json`. `source.bin` contains the exact input bytes, including any BOM, malformed quoting and valid or invalid rows. The JSON manifest records the filename, digest, byte size, mapping version, delivery label, original lineage, provenance, first attempt time, bounded sanitized findings and known record/physical-line locators. Structurally unreadable records keep a null record number; only a physical line reported by the CSV parser is retained. No source cell values, notes or URLs are copied into diagnostics.

The operation writes a private temporary directory and atomically renames it to the digest path after both files are flushed. It refuses existing or incomplete entries and does not replace artifacts. Repeating the same bytes and metadata returns `already_present` without altering the first attempt time. The same bytes with different metadata fail closed. A failed write removes only its incomplete staging directory. Completed quarantine entries have no automatic cleanup.

Quarantine is not ingestion. It writes no county, batch, source, evidence, claim, person, run, event or selection to SQLite. The full rejected delivery remains outside GitHub and the Website. Select a root whose Windows permissions are appropriate for the private research material; this command does not change or independently certify the root's ACLs or encryption.

## County registry preflight

The explicit mapping still validates the FIPS/name pair. Preview now also checks that the target database contains the same FIPS with the canonical name from the one public `COUNTIES` mapping. A missing row yields `county_not_registered`; a different registered name yields `county_registry_conflict`. These bounded diagnostics do not expose row contents. Preview never seeds or repairs counties.

Intentional commit uses the same preview check and `research.store.ingest_csv()` repeats the registry check after acquiring its write transaction, before replay, selection or inserts. If the registry changes between preview and commit, commit fails with no partial records. The registry must be initialized separately; R4-H1 does not add a county-seeding command or migration.

The existing refusal of WAL-mode CSV preview remains in place. Registry preflight uses read-only SQL and does not switch journal mode or create sidecars.

## Explicit source classification

Sources start as `unknown`. Classify an existing source only when an operator can state a documented basis; optional supporting evidence must already belong to that exact source.

```powershell
python -B -m research classify-source "D:/private/Profiles/database/research.sqlite" `
  --source-id SOURCE_ID `
  --status official `
  --actor operator-id `
  --basis "Reviewed the cited county page's own official directory context." `
  --evidence-id EVIDENCE_ID
```

The status must be one of `unknown`, `official`, `partner` or `other`. The actor and basis are required. A hostname, filename, county label or legacy CSV presence alone is not an adequate basis. A county-listed partner remains a partner source; this operation does not classify a person as a county employee.

A changed classification, its screening run, and a `source_classified` audit event commit in one transaction. The event records the previous/new statuses, actor, basis and optional evidence ID. Evidence from another source is rejected. Repeating a request that exactly matches the latest classification audit is a no-op; if a status already exists without a matching audit, one `source_classification_confirmed` event records the new basis without changing the status. A rationale-only operation is attributed as reconstructed; when evidence is supplied, the screening run preserves that evidence's provenance. This operation creates no source visit, fetch result, content hash, date, source version or personnel verification.

## Verification boundary

Regression coverage uses temporary databases, fictional people and `example.invalid` sources. It checks exact quarantine bytes and hashes, mixed valid/invalid rows, BOMs, commas, multiline and malformed records, widths, sanitized findings/locators, content-addressed retry, metadata conflicts, traversal/symlink refusal, partial-write cleanup, preview read-only behavior, county registration parity, classification audit and rollback, and the established replay/correction contracts. The full test suite remains the final source of truth for the current count.

R4-H1 does not implement the separate R5A readiness assignment, initialize a permanent database, import real county data, fetch sources, match identities, infer hierarchy, or publish anything.

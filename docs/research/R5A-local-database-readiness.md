# R5A — private local database readiness and synthetic rehearsal

R5A implements a safe local operating path for the separate Profiles research database. The database remains ordinary SQLite for DB Browser for SQLite. Private inputs, quarantine, encrypted backups, scratch restores, and operational reports stay outside this checkout. Tests use temporary fixtures and invented data only.

R5A does not create the owner's permanent workspace, open or ingest real county packages, or begin the Eagle County pilot. The pilot procedure below is preparation only and requires a separate authorization for real intake.

## Private Windows workspace

Choose a non-repository NTFS location and verify that its ACLs grant access only to the intended Windows account and administrators. Keep the root path explicit in each command; do not rely on the shell's current directory. A useful layout is:

```text
<private-root>/
  database/       research.sqlite and deliberate verified restores
  originals/      immutable owner-supplied source packages, by county FIPS
  intake/         explicitly named working copies
  quarantine/     rejected original bytes and sanitized manifests
  backups/        encrypted .cwdb artifacts
  scratch/        disposable restore checks, removed after verification
  reports/        private operator reports and local logs
```

Use a Windows account protected by a strong sign-in method and keep the directory out of OneDrive or other sync locations unless their access, encryption, and recovery behavior is intentionally reviewed. Do not place private files, personal notes, source captures, backups, database files, or keys in Git, this repository, the Website, or a beta-1 checkout. This code does not set or certify Windows ACLs, BitLocker, or a backup destination's protection.

The checked-in `research init` behavior is unchanged: it exclusively creates an empty database and applies the existing checksum-verified migration. County reference data is a separate explicit step:

```powershell
python -B -m research init "<private-root>/database/research.sqlite"
python -B -m research check "<private-root>/database/research.sqlite"
python -B -m research seed-counties "<private-root>/database/research.sqlite"
python -B -m research counties "<private-root>/database/research.sqlite" --limit 100
```

`seed-counties` inserts the 64 canonical FIPS/name pairs from `research.mapping.COUNTIES`, including Broomfield `08014`, Elbert `08039`, and El Paso `08041`. It verifies migration history, checksums, integrity, and foreign keys in one write transaction. It never updates a conflicting row. Existing correct subsets are preserved; a repeat reports `already_present`. Any unexpected FIPS/name association returns a conflict and commits no registry changes. R4-H1's preview and commit registry checks remain authoritative and are not duplicated here.

## Encrypted SQLite-consistent backups

The backup artifact is protected with Windows Data Protection API (DPAPI), using the current Windows user's profile keys. Microsoft's `CryptProtectData` encrypts the data and adds a keyed integrity check; `CryptUnprotectData` verifies integrity during decryption ([CryptProtectData](https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata), [CryptUnprotectData](https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)). DPAPI is part of Windows; R5A adds no cryptography package and no key file. The framing format is local to this application, while confidentiality and authentication come from DPAPI. A per-record sequence and protected final manifest detect missing, reordered, truncated, or modified records. The manifest contains a unique backup ID, database file digest, size, migration version, all table counts, and a logical row digest; it is encrypted with the database content.

The destination must be a new absolute path outside the checkout, in an existing directory with appropriate private permissions. Backup reads the source through SQLite's online backup API, so rollback-journal and WAL databases are handled by SQLite snapshot semantics. It validates the 19 research tables, migration checksums, foreign keys, SQLite integrity, row counts, and logical contents before publishing an encrypted artifact. An incomplete artifact is never published; an existing file is never replaced.

By default the artifact is decryptable only with the same Windows user's logon credentials on the same computer. Copying the artifact alone to another account or Windows installation does not make it restorable. Loss of the profile or DPAPI master keys can mean permanent loss; recovery depends on Windows account/profile recovery and must be rehearsed before relying on these backups. R5A does not export or store a separate key and does not claim cross-platform portability. The container reveals approximate backup size through encrypted chunk framing, but not database rows or its encrypted manifest. The artifact does not provide off-site resilience or a managed retention service.

Restore authenticates and decrypts into an isolated temporary directory, opens the restored database separately from its source, validates migration history, schema, integrity, foreign keys, table counts and row digest, and only then publishes a new ordinary SQLite file at the explicitly selected restore path. That resulting path is the intended plaintext working database. Temporary plaintext snapshots are removed on normal completion and failure; Windows temporary storage, crash remnants, filesystem journaling, SSD remanence, and secure erasure are outside this guarantee. Restore never overwrites an existing destination or modifies the encrypted backup.

Example commands use placeholders, not universal drive paths:

```powershell
python -B -m research backup "<private-root>/database/research.sqlite" `
  "<private-root>/backups/research-unique-id.cwdb"

python -B -m research restore "<private-root>/backups/research-unique-id.cwdb" `
  "<private-root>/scratch/restore-check.sqlite"

python -B -m research check "<private-root>/scratch/restore-check.sqlite"
```

Keep an encrypted artifact until a later artifact and isolated restore have both passed. Restore checks to a new scratch file first. Do not replace the active database as part of this workflow. A regular SQLite file or SHA-256 digest is not an encrypted backup.

## Synthetic rehearsal

`tests/test_readiness.py` uses disposable SQLite files, temporary folders, fictional names, and `example.invalid` URLs. It verifies all 64 public county rows, idempotent seeding, conflict refusal and rollback, and the current 19-table/checksum baseline. On Windows, the CLI rehearsal initializes and seeds a temporary database, runs a read-only synthetic 17-column preview, explicitly commits it with the expected hash, verifies replay returns the same batch without additional writes, creates an encrypted DPAPI artifact, restores it, and inspects the restored claims and sources. Tests also exercise rollback-journal and WAL snapshots, a pending uncommitted writer, authentication failure, tampering, truncation, partial-write cleanup, and restore without the original database. On systems without DPAPI, the backup commands fail closed. No people are created automatically.

The broader accepted test suite additionally covers all three exact legacy mappings, complementary/corrected/alternative lineage, explicit correction links, selection, failed commits, R4-H1 quarantine and source classification, and all PR #17 acceptance repairs. The registry is never implicitly created by preview or intake.

## Eagle County pilot preparation — not executed

This procedure is a readiness checklist only. No Eagle County CSV, source package, or live research database was opened for R5A. A separate owner authorization is required before any real-data operation.

### Inputs and readiness gates

1. Obtain explicit approval for the private Windows workspace and for the exact source package, expected file hash, and planned mapping. Keep the original package unchanged under `originals/08037/`; create a separately named working copy under `intake/08037/`. Do not assume a mapping from a filename or column count.
2. Confirm the selected CSV header exactly matches one supported contract: `legacy-11/v1`, `legacy-16/v1`, or `legacy-17/v1`. Verify UTF-8/BOM handling, field widths, FIPS `08037`, county name, and source URL fields against that contract. Preserve the original bytes and hash.
3. Initialize a separate database only after authorization; run `check`, `seed-counties`, and read-only county inspection. Confirm `08037` is registered as canonical Eagle County and that the schema and migration checksums are valid.
4. Before intake, create a DPAPI-encrypted backup and restore it to a new scratch path. Verify migration history, SQLite integrity, foreign keys, table counts, and logical digest. Confirm the same Windows identity/profile can unlock it. Record the backup ID and result in a private report.

### Preview and decision review

5. Run `preview-csv` on the working copy using the explicitly selected mapping, delivery label, lineage, and provenance. Record its SHA-256, county, valid/invalid/duplicate counts, distinct source URL count, source metadata counts, and bounded diagnostics in the private report. Preview must leave the database and its auxiliary files unchanged.
6. Check every diagnostic and compare record/source-observation counts with an owner-provided expected inventory if one exists. Preserve all source URLs and original published wording. Do not treat row count as people count. Investigate repeated rows, missing sources, historical observations, and any difference from the expected file hash before proceeding.
7. Choose `original` for a first delivery. Use `complementary` only when it is a distinct additive delivery with no parent. Use `corrected` or `alternative` only with the explicit parent batch and intended nonadditive family semantics. Provide correction links only for record-to-claim matches that are explicitly documented; never infer row correspondence. Invalid originals remain rejected and may be preserved with `quarantine-invalid` outside the repository.
8. Keep uncertain identities, spelling differences, nicknames, same-name cases, role dates, unit hierarchy, vacancies, and source classifications unresolved unless supported by direct evidence and handled through their explicit audited operation. A CSV label or hostname does not prove identity, employment, hierarchy, or official status.

### Commit, audit, and recovery boundaries

9. Do not commit until the owner separately authorizes the exact file hash, mapping version, label, lineage, and provenance. Use `intake-csv --expect-sha256 <preview-hash> --commit`. The CLI revalidates the file and database; a registry conflict or changed file must stop without partial records.
10. Inspect batch/family selection, source/evidence/claim counts, raw record hashes and locators, source classification events, and audit history. Confirm claims remain unassigned unless a separate evidence-supported identity action was authorized. Repeat the exact intake to verify idempotent replay.
11. Create and independently restore another encrypted backup after the authorized commit. Keep the source package and encrypted backups unchanged. If a failure is detected, stop further writes, preserve the original and artifacts, and restore only to a separate path for comparison. Do not overwrite the active database or delete historical material as a rollback shortcut.
12. Produce a private sanitized acceptance report with input hash, explicit mapping, preview findings, commit/replay IDs, audit counts, backup ID, restore verification, unresolved cases, and any recovery limitation. No private rows, notes, source captures, or operational database enter GitHub or the Website.

Acceptance checkpoints: owner-authorized package and hash; exact supported header; valid `08037` registry; clean read-only preview; verified encrypted pre-intake backup and restore; explicit commit authorization; consistent claims/evidence/audit; idempotent replay; successful post-intake backup and restore; private report. If any checkpoint fails, do not guess or commit. Leave ambiguity and historical conflicts unresolved for review.

## Scope and readiness status

R5A implements public county seeding, authenticated encrypted SQLite backup, isolated restore verification, and synthetic rehearsal. It does not create a permanent private workspace, certify owner ACLs or BitLocker, configure an independent off-site destination, exercise DB Browser's GUI, or access Eagle County data. DPAPI key/profile portability is limited as described above. Eagle County pilot preparation is documented but not executed; actual intake requires its own authorization.

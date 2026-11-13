# REFERENCE ONLY. NOT AN ACTIVE IMPLEMENTATION.

This folder preserves unpublished M0-B reference work written by Claude on November 12, 2026, before M0-A was accepted. It is kept so its schema ideas can be reused. Do not merge this branch and do not open a PR from it.

- Base commit: `5104e33`, which predates M0-A (PR #15).
- The standalone `site/` application structure is superseded by the M0-A layout at the repository root.
- Verification when written: 23 of 24 tests passed. The one failure is a test assertion in `tests/counties.test.ts`: `node:sqlite` returns rows with a null prototype, so `deepEqual` against a plain object literal fails although the values match. The fix is to spread the row before comparing.
- Useful for M0-B: `src/db/schema.ts`, `migrations/`, `src/db/versioned.ts`, `src/db/client.ts`, `src/db/d1.ts`, `src/db/node-sqlite.ts`, `src/db/migrate.ts`, and the test cases under `tests/`.
- Everything here is source or synthetic test data. County names and FIPS codes are public reference data.

See Issue #6 for the handoff note.

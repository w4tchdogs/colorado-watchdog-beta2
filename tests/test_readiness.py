"""Synthetic county-registry, backup, restore, and CLI readiness checks."""

import json
import os
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from research import backup as backup_module
from research.backup import backup_database, restore_database
from research.db import connect, migrate, seed_counties, validate_migration_history
from research.intake import preview_csv, quarantine_validation_report
from research.mapping import COUNTIES, FIELDS_17, HEADERS_17
from research.operator import classify_source
from research.quarantine import quarantine_invalid_original
from research.store import ingest_csv
from tests.research_fixtures import csv_bytes, observation


NOW = "2026-11-13T12:00:00+00:00"


def synthetic_csv():
    first = dict(zip(FIELDS_17, observation(fips="08037"), strict=True))
    first.update(county_fips="08037", county="Eagle", full_name="Synthetic Pilot Example",
                 source_title="Invented Eagle directory",
                 source_url="https://example.invalid/eagle/directory",
                 private_note="SYNTHETIC ONLY")
    second = dict(first, full_name="Synthetic Morgan Example", title="Fixture Analyst",
                  source_url="https://example.invalid/eagle/staff")
    row = lambda values: [values[field] for field in FIELDS_17]
    return csv_bytes([row(first), row(first), row(second)], HEADERS_17)


class ReadinessCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "research.sqlite"
        self.db = connect(self.database)
        migrate(self.db)

    def tearDown(self):
        if self.db is not None:
            self.db.close()
        self.temporary.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, "-B", "-m", "research", *map(str, args)],
                              capture_output=True, text=True, check=False)

    def seed(self):
        return seed_counties(self.db)

    def test_backup_snapshot_requires_exact_migration_derived_schema(self):
        self.assertEqual(backup_module._database_snapshot(self.db)["schema_version"], 4)
        alterations = {
            "missing county index": "DROP INDEX claims_county_person",
            "missing lineage trigger": "DROP TRIGGER batch_lineage_update",
            "altered same-name index": "DROP INDEX claims_county_person; "
                "CREATE INDEX claims_county_person ON role_claims(person_id, county_fips)",
            "altered same-name trigger": "DROP TRIGGER batch_lineage_update; "
                "CREATE TRIGGER batch_lineage_update BEFORE UPDATE ON role_claims "
                "BEGIN SELECT RAISE(ABORT, 'altered'); END",
            "altered same-name view": "DROP VIEW selected_role_claims; "
                "CREATE VIEW selected_role_claims AS SELECT c.id FROM role_claims c",
            "unexpected index": "CREATE INDEX unexpected_managed_index ON role_claims(county_fips)",
            "unexpected trigger": "CREATE TRIGGER unexpected_managed_trigger AFTER INSERT ON role_claims "
                "BEGIN SELECT 1; END",
            "unexpected view": "CREATE VIEW unexpected_managed_view AS SELECT id FROM role_claims",
        }
        for label, sql in alterations.items():
            with self.subTest(schema_change=label):
                candidate = sqlite3.connect(":memory:")
                try:
                    candidate.execute("PRAGMA foreign_keys=ON")
                    migrate(candidate)
                    candidate.executescript(sql)
                    with self.assertRaisesRegex(ValueError, "canonical packaged migration schema"):
                        backup_module._database_snapshot(candidate)
                finally:
                    candidate.close()

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_noncanonical_backup_fails_without_publishing_destination(self):
        for name, sql in (("index", "DROP INDEX claims_county_person"),
                          ("trigger", "DROP TRIGGER batch_lineage_update")):
            with self.subTest(missing=name):
                damaged = self.root / f"missing-{name}.sqlite"
                backup_module._copy_database(self.database, damaged)
                altered = sqlite3.connect(damaged)
                try:
                    altered.executescript(sql)
                finally:
                    altered.close()
                destination = self.root / f"missing-{name}.cwdb"
                with self.assertRaisesRegex(ValueError, "canonical packaged migration schema"):
                    backup_database(damaged, destination)
                self.assertFalse(destination.exists())

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_authenticated_historical_artifact_cannot_bypass_schema_validation(self):
        canonical_snapshot = backup_module._database_snapshot(self.db)
        altered_db_path = self.root / "historical-noncanonical.sqlite"
        backup_module._copy_database(self.database, altered_db_path)
        altered_db = sqlite3.connect(altered_db_path)
        try:
            altered_db.executescript(
                "DROP INDEX claims_county_person; DROP TRIGGER batch_lineage_update;")
        finally:
            altered_db.close()

        # Build an artifact with the legacy authenticated framing and a matching,
        # authentic file digest but a manifest captured from the canonical rows.
        artifact = self.root / "historical-noncanonical.cwdb"
        backup_module._encrypt_snapshot(altered_db_path, artifact, canonical_snapshot)
        destination = self.root / "must-not-publish-restored.sqlite"
        with self.assertRaisesRegex(ValueError, "canonical packaged migration schema"):
            restore_database(artifact, destination)
        self.assertFalse(destination.exists())

    def test_fresh_seed_produces_all_public_counties_and_is_idempotent(self):
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties").fetchone()[0], 0)
        first = self.seed()
        self.assertEqual(first["status"], "seeded")
        self.assertEqual(len(first["inserted"]), 64)
        self.assertEqual(first["already_present"], [])
        self.assertEqual(first["conflicts"], [])
        self.assertEqual(dict(self.db.execute("SELECT fips,name FROM counties")), COUNTIES)
        self.assertEqual(self.db.execute("SELECT name FROM counties WHERE fips='08014'").fetchone()[0],
                         "Broomfield")
        self.assertEqual(self.db.execute("SELECT name FROM counties WHERE fips='08039'").fetchone()[0],
                         "Elbert")
        self.assertEqual(self.db.execute("SELECT name FROM counties WHERE fips='08041'").fetchone()[0],
                         "El Paso")
        second = self.seed()
        self.assertEqual(second["status"], "already_present")
        self.assertEqual(second["inserted"], [])
        self.assertEqual(len(second["already_present"]), 64)

    def test_correct_rows_and_existing_research_are_preserved(self):
        self.db.execute("INSERT INTO counties VALUES ('08037','Eagle')")
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                        ("run_synthetic", "mapping", "synthetic", NOW))
        self.db.commit()
        result = self.seed()
        self.assertEqual(result["status"], "seeded")
        self.assertEqual(result["already_present"], [{"fips": "08037", "name": "Eagle"}])
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties").fetchone()[0], 64)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs WHERE id='run_synthetic'").fetchone()[0], 1)

    def test_wrong_existing_mapping_returns_conflict_without_partial_writes(self):
        self.db.execute("INSERT INTO counties VALUES ('08037','Not Eagle')")
        self.db.commit()
        before = list(map(tuple, self.db.execute("SELECT fips,name FROM counties ORDER BY fips")))
        result = self.seed()
        after = list(map(tuple, self.db.execute("SELECT fips,name FROM counties ORDER BY fips")))
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(result["inserted"], [])
        self.assertEqual(result["conflicts"][0]["reason"], "name_mismatch")
        self.assertEqual(after, before)

    def test_seed_insert_failure_rolls_back_the_entire_registry(self):
        self.db.execute("CREATE TRIGGER fail_registry_insert BEFORE INSERT ON counties "
                        "WHEN NEW.fips='08041' BEGIN SELECT RAISE(ABORT,'synthetic seed failure'); END")
        self.db.commit()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "synthetic seed failure"):
            seed_counties(self.db)
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties").fetchone()[0], 0)

    def test_county_change_after_preview_is_rejected_before_any_ingestion_write(self):
        self.seed()
        payload = synthetic_csv()
        report = preview_csv(self.db, payload, file_name="synthetic.csv", version="legacy-17/v1",
                             version_label="r5a-race-v1", provenance="synthetic")
        self.assertTrue(report["eligible"])
        self.db.execute("UPDATE counties SET name='Synthetic Changed County' WHERE fips='08037'")
        self.db.commit()
        before = {table: self.db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                  for table in ("scrape_batches", "research_runs", "sources", "evidence_links", "role_claims",
                                "research_events")}
        with self.assertRaisesRegex(ValueError, "canonical FIPS mapping"):
            ingest_csv(self.db, payload, file_name="synthetic.csv", version_label="r5a-race-v1",
                       version="legacy-17/v1", provenance="synthetic")
        after = {table: self.db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                 for table in before}
        self.assertEqual(after, before)

    def test_wrong_name_fips_assignment_is_detected_without_writes(self):
        self.db.execute("INSERT INTO counties VALUES ('08001','Eagle')")
        self.db.commit()
        result = self.seed()
        self.assertEqual(result["status"], "conflict")
        self.assertTrue(any(item["reason"] in ("name_mismatch", "name_assigned_to_different_fips")
                            for item in result["conflicts"]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties").fetchone()[0], 1)

    def test_unexpected_fips_is_refused_without_partial_seeding(self):
        self.db.execute("INSERT INTO counties VALUES ('08999','Synthetic Unknown County')")
        self.db.commit()
        result = self.seed()
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(result["inserted"], [])
        self.assertEqual(result["conflicts"], [{"fips": "08999", "reason": "unexpected_fips"}])
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties").fetchone()[0], 1)

    def test_seed_rejects_unmanaged_database_and_unchanged_migration_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            unmanaged = Path(directory, "unmanaged.sqlite")
            raw = sqlite3.connect(unmanaged)
            raw.execute("CREATE TABLE unrelated(value TEXT)")
            raw.commit()
            raw.close()
            db = connect(unmanaged)
            try:
                with self.assertRaisesRegex(ValueError, "migration history"):
                    seed_counties(db)
                self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()[0][0],
                                 "unrelated")
            finally:
                db.close()
        baseline = connect(":memory:")
        migrate(baseline)
        validate_migration_history(baseline)
        self.assertEqual(baseline.execute("SELECT count(*) FROM counties").fetchone()[0], 0)
        baseline.close()

    def test_seed_rejects_incorrect_migration_history_without_changes(self):
        self.db.execute("UPDATE schema_migrations SET sha256=? WHERE name='001_foundation.sql'", ("0" * 64,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Applied migration changed"):
            self.seed()
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties").fetchone()[0], 0)

    def test_safe_path_check_rejects_database_inside_checkout(self):
        inside = Path(__file__).resolve().parents[1] / "must-not-be-created.sqlite"
        result = self.cli("init", inside)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside the source checkout", result.stderr)
        self.assertFalse(inside.exists())

    def test_cli_seed_and_read_only_inspection_work_after_seeding(self):
        cli_database = self.root / "cli-rehearsal.sqlite"
        initialized = self.cli("init", cli_database)
        self.assertEqual(initialized.returncode, 0, initialized.stderr)
        seeded = self.cli("seed-counties", cli_database)
        self.assertEqual(seeded.returncode, 0, seeded.stderr)
        payload = json.loads(seeded.stdout)
        self.assertEqual(len(payload["inserted"]), 64)
        before = cli_database.read_bytes()
        inspected = self.cli("counties", cli_database, "--county", "08037")
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        self.assertIn("Eagle", inspected.stdout)
        self.assertEqual(cli_database.read_bytes(), before)

    def test_full_preview_commit_and_replay_cli_after_registry_seed(self):
        cli_database = self.root / "end-to-end.sqlite"
        csv_path = self.root / "synthetic-eagle.csv"
        csv_path.write_bytes(synthetic_csv())
        initialized = self.cli("init", cli_database)
        self.assertEqual(initialized.returncode, 0, initialized.stderr)
        seeded = self.cli("seed-counties", cli_database)
        self.assertEqual(seeded.returncode, 0, seeded.stderr)
        args = (cli_database, "--file", csv_path, "--version", "legacy-17/v1",
                "--version-label", "r5a-synthetic-eagle-v1", "--lineage-kind", "original",
                "--provenance", "synthetic")
        bytes_before = cli_database.read_bytes()
        files_before = sorted(item.name for item in self.root.iterdir())
        preview = self.cli("preview-csv", *args)
        self.assertEqual(preview.returncode, 0, preview.stderr)
        preview_result = json.loads(preview.stdout)
        self.assertTrue(preview_result["eligible"])
        self.assertEqual(preview_result["header_match"], True)
        self.assertEqual(preview_result["records"]["total"], 3)
        self.assertEqual(preview_result["records"]["valid"], 3)
        self.assertEqual(preview_result["records"]["duplicate_rows"], 1)
        self.assertEqual(preview_result["source_urls"]["distinct"], 2)
        self.assertEqual(preview_result["county"], {"fips": "08037", "name": "Eagle"})
        self.assertEqual(preview_result["lineage"]["kind"], "original")
        self.assertEqual(cli_database.read_bytes(), bytes_before)
        self.assertEqual(sorted(item.name for item in self.root.iterdir()), files_before)
        commit_args = (*args, "--expect-sha256", preview_result["file_sha256"], "--commit")
        committed = self.cli("intake-csv", *commit_args)
        self.assertEqual(committed.returncode, 0, committed.stderr)
        commit_result = json.loads(committed.stdout)
        self.assertTrue(commit_result["created"])
        self.assertEqual(commit_result["distinct_claims"], 2)
        self.assertEqual(commit_result["duplicate_rows"], 1)
        counts_before_replay = self._counts(cli_database)
        replay = self.cli("intake-csv", *commit_args)
        self.assertEqual(replay.returncode, 3, replay.stderr)
        replay_result = json.loads(replay.stdout)
        self.assertFalse(replay_result["created"])
        self.assertEqual(replay_result["batch_id"], commit_result["batch_id"])
        self.assertEqual(self._counts(cli_database), counts_before_replay)
        if os.name != "nt":
            artifact = self.root / "must-not-publish.cwdb"
            unavailable = self.cli("backup", cli_database, artifact)
            self.assertNotEqual(unavailable.returncode, 0)
            self.assertIn("Windows DPAPI", unavailable.stderr)
            self.assertFalse(artifact.exists())
            return
        backup_dir, restore_dir = self.root / "cli-backup", self.root / "cli-restore"
        backup_dir.mkdir()
        restore_dir.mkdir()
        backup = backup_dir / "research.sqlite"
        restored = restore_dir / "research.sqlite"
        backup_result = self.cli("backup", cli_database, backup)
        self.assertEqual(backup_result.returncode, 0, backup_result.stderr)
        restore_result = self.cli("restore", backup, restored)
        self.assertEqual(restore_result.returncode, 0, restore_result.stderr)
        inspection = self.cli("sources", restored, "--county", "08037")
        self.assertEqual(inspection.returncode, 0, inspection.stderr)
        self.assertIn("example.invalid", inspection.stdout)
        restored_db = connect(restored)
        try:
            self.assertEqual(restored_db.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)
            self.assertEqual(restored_db.execute("SELECT count(*) FROM role_claims").fetchone()[0], 2)
        finally:
            restored_db.close()

    def test_r4_h1_preflight_quarantine_and_classification_stay_explicit(self):
        self.seed()
        valid = synthetic_csv()
        preview = preview_csv(self.db, valid, file_name="synthetic.csv", version="legacy-17/v1",
                              version_label="r5a-fixture-v1", provenance="synthetic")
        self.assertTrue(preview["eligible"])
        invalid = valid.replace(b"08037,Eagle", b"08001,Eagle", 1)
        rejected = quarantine_validation_report(self.db, invalid, file_name="synthetic-rejected.csv",
                                                version="legacy-17/v1", version_label="rejected-fixture-v1")
        self.assertFalse(rejected["eligible"])
        quarantine_root = self.root / "quarantine"
        quarantine_root.mkdir()
        tables = [row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        before = {table: self.db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                  for table in tables}
        quarantined = quarantine_invalid_original(
            quarantine_root, invalid, file_name="synthetic-rejected.csv", version="legacy-17/v1",
            version_label="rejected-fixture-v1", validation_report=rejected, provenance="synthetic")
        self.assertEqual(Path(quarantined["path"], "source.bin").read_bytes(), invalid)
        after = {table: self.db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                 for table in tables}
        self.assertEqual(after, before)
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,actor,recorded_at) VALUES (?,?,?,?,?)",
                        ("run_classification_fixture", "mapping", "synthetic", "fixture", NOW))
        self.db.execute("INSERT INTO sources(id,original_url,recorded_at) VALUES (?,?,?)",
                        ("source_classification_fixture", "https://example.invalid/classification", NOW))
        self.db.execute("INSERT INTO evidence_links(id,source_id,observed_title,observed_url,locator,run_id,recorded_at) "
                        "VALUES (?,?,?,?,?,?,?)",
                        ("evidence_classification_fixture", "source_classification_fixture", "Synthetic source",
                         "https://example.invalid/classification", "synthetic fixture", "run_classification_fixture", NOW))
        self.db.commit()
        classified = classify_source(
            self.db, source_id="source_classification_fixture", status="partner", actor="synthetic-operator",
            basis="Synthetic exercise; the source status is explicitly assigned for the fixture.",
            evidence_id="evidence_classification_fixture")
        self.assertTrue(classified["changed"])
        self.assertEqual(self.db.execute("SELECT official_status FROM sources WHERE id=?",
                                         ("source_classification_fixture",)).fetchone()[0], "partner")
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT kind FROM research_events WHERE entity_id=?",
                                         ("source_classification_fixture",)).fetchone()[0], "source_classified")

    @staticmethod
    def _counts(path):
        db = connect(path)
        try:
            return {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                    for table in ("scrape_batches", "research_runs", "sources", "evidence_links",
                                  "role_claims", "research_events", "research_people")}
        finally:
            db.close()

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_backup_restore_validates_counts_provenance_and_replay_state(self):
        seed_counties(self.db)
        self.db.commit()
        batch_id = ingest_csv(self.db, synthetic_csv(), file_name="synthetic-eagle.csv",
                              version_label="r5a-fixture-v1", version="legacy-17/v1",
                              provenance="synthetic")
        replayed = ingest_csv(self.db, synthetic_csv(), file_name="synthetic-eagle.csv",
                              version_label="r5a-fixture-v1", version="legacy-17/v1",
                              provenance="synthetic", return_result=True)
        self.assertEqual((replayed["batch_id"], replayed["status"]), (batch_id, "replayed"))
        counts_before = {table: self.db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                         for table in ("counties", "scrape_batches", "sources", "evidence_links", "role_claims",
                                       "research_runs", "research_events", "research_people")}
        source_row = self.db.execute(
            "SELECT e.raw_record_json,e.raw_record_sha256,e.source_id,b.id,b.family_id,b.mapping_version "
            "FROM evidence_links e JOIN scrape_batches b ON b.id=e.batch_id WHERE b.id=?", (batch_id,)
        ).fetchone()
        backup = self.root / "backups" / "synthetic-backup.sqlite"
        backup.parent.mkdir()
        created = backup_database(self.database, backup)
        self.assertEqual(created["status"], "completed")
        self.assertEqual(created["table_counts"]["counties"], 64)
        self.assertEqual(created["table_counts"]["role_claims"], 2)
        self.assertEqual(len(created["sha256"]), 64)
        restored = self.root / "restore" / "restored.sqlite"
        restored.parent.mkdir()
        outcome = restore_database(backup, restored)
        self.assertEqual(outcome["status"], "restored_and_verified")
        self.assertEqual(outcome["logical_sha256"], created["logical_sha256"])
        self.assertEqual(outcome["table_counts"], created["table_counts"])
        reopened = connect(restored)
        try:
            self.assertEqual(validate_migration_history(reopened)["integrity"], "ok")
            counts_after = {table: reopened.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                            for table in counts_before}
            self.assertEqual(counts_after, counts_before)
            restored_row = reopened.execute(
                "SELECT e.raw_record_json,e.raw_record_sha256,e.source_id,b.id,b.family_id,b.mapping_version "
                "FROM evidence_links e JOIN scrape_batches b ON b.id=e.batch_id WHERE b.id=?", (batch_id,)
            ).fetchone()
            self.assertEqual(tuple(restored_row), tuple(source_row))
            self.assertEqual(reopened.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)
        finally:
            reopened.close()

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_backup_is_authenticated_encrypted_and_restores_without_original(self):
        self.seed()
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                        ("run_private_fixture", "mapping", "synthetic", NOW))
        self.db.execute("INSERT INTO sources(id,original_url,recorded_at) VALUES (?,?,?)",
                        ("source_private_fixture", "https://example.invalid/private-fixture", NOW))
        self.db.commit()
        artifact = self.root / "encrypted.cwdb"
        with patch("research.backup.tempfile.tempdir", str(self.root)):
            created = backup_database(self.database, artifact)
        payload = artifact.read_bytes()
        self.assertTrue(payload.startswith(b"CW-R5A-DPAPI\x00\x01"))
        self.assertNotIn(b"SQLite format 3\x00", payload)
        self.assertNotIn(b"private-fixture", payload)
        self.assertNotIn(b"run_private_fixture", payload)
        self.assertEqual(created["status"], "completed")
        self.assertTrue(created["backup_id"])
        self.assertEqual(created["table_counts"]["sources"], 1)
        self.db.close()
        self.db = None
        self.database.unlink()
        restored_path = self.root / "restored-without-source.sqlite"
        with patch("research.backup.tempfile.tempdir", str(self.root)):
            restored = restore_database(artifact, restored_path)
        self.assertEqual(restored["status"], "restored_and_verified")
        self.assertEqual(restored["backup_id"], created["backup_id"])
        self.assertEqual(list(self.root.glob("cw-r5a-*/")), [])
        independent = connect(restored_path)
        try:
            self.assertEqual(independent.execute("SELECT count(*) FROM sources").fetchone()[0], 1)
            self.assertEqual(independent.execute("SELECT count(*) FROM counties").fetchone()[0], 64)
        finally:
            independent.close()

    def test_dpapi_authenticates_records_and_wrong_unlock_fails_closed(self):
        if os.name != "nt":
            with self.assertRaisesRegex(RuntimeError, "requires Windows DPAPI"):
                backup_module._protect(b"fixture", b"entropy")
            artifact = self.root / "dpapi-required.cwdb"
            artifact.write_bytes(backup_module._MAGIC + struct.pack(">BI", 1, 1) + b"x")
            destination = self.root / "dpapi-required.sqlite"
            with patch("research.backup.tempfile.tempdir", str(self.root)):
                with self.assertRaisesRegex(RuntimeError, "requires Windows DPAPI"):
                    restore_database(artifact, destination)
            self.assertFalse(destination.exists())
            self.assertEqual(list(self.root.glob("cw-r5a-restore-*/")), [])
            return
        protected = backup_module._protect(b"synthetic authenticated payload", b"fixture entropy")
        self.assertNotEqual(protected, b"synthetic authenticated payload")
        self.assertEqual(backup_module._unprotect(protected, b"fixture entropy"),
                         b"synthetic authenticated payload")
        with self.assertRaisesRegex(ValueError, "authenticate or unlock"):
            backup_module._unprotect(protected, b"wrong fixture entropy")

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_backup_uses_sqlite_snapshot_in_rollback_and_wal_modes(self):
        for journal_mode in ("DELETE", "WAL"):
            with self.subTest(journal_mode=journal_mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "source.sqlite"
                db = connect(source)
                try:
                    migrate(db)
                    seed_counties(db)
                    db.commit()
                    actual = db.execute(f"PRAGMA journal_mode={journal_mode}").fetchone()[0].upper()
                    self.assertEqual(actual, journal_mode)
                    db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                               (f"run_{journal_mode}", "mapping", "synthetic", NOW))
                    db.commit()
                    # An uncommitted writer remains invisible to the separate consistent snapshot.
                    db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                               (f"run_uncommitted_{journal_mode}", "mapping", "synthetic", NOW))
                    backup = root / "snapshot.cwdb"
                    result = backup_database(source, backup)
                    self.assertEqual(result["table_counts"]["research_runs"], 1)
                    restore_path = root / "restored.sqlite"
                    restore_database(backup, restore_path)
                    restored = connect(restore_path)
                    try:
                        ids = {row[0] for row in restored.execute("SELECT id FROM research_runs")}
                        self.assertEqual(ids, {f"run_{journal_mode}"})
                    finally:
                        restored.close()
                    db.rollback()
                finally:
                    db.close()

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_tampered_truncated_and_wrong_key_backups_never_publish_restore(self):
        backup = self.root / "valid.cwdb"
        backup_database(self.database, backup)
        original = backup.read_bytes()
        cases = {}
        first_payload = len(b"CW-R5A-DPAPI\x00\x01") + 5
        tampered = bytearray(original)
        tampered[first_payload + 25] ^= 0x01
        cases["tampered"] = bytes(tampered)
        cases["truncated"] = original[:-7]
        for label, payload in cases.items():
            with self.subTest(case=label):
                damaged = self.root / f"{label}.cwdb"
                damaged.write_bytes(payload)
                target = self.root / f"{label}-restore.sqlite"
                with self.assertRaises(ValueError):
                    restore_database(damaged, target)
                self.assertFalse(target.exists())
                self.assertEqual(backup.read_bytes(), original)
        target = self.root / "wrong-key-restore.sqlite"
        original_unprotect = backup_module._unprotect

        def wrong_entropy(payload, entropy):
            return original_unprotect(payload, entropy + b"wrong")

        with patch("research.backup._unprotect", side_effect=wrong_entropy):
            with self.assertRaises(ValueError):
                restore_database(backup, target)
        self.assertFalse(target.exists())
        self.assertEqual(backup.read_bytes(), original)

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_encryption_failure_and_interrupted_restore_publish_no_partial_files(self):
        destination = self.root / "not-published.cwdb"

        def fail_encryption(_source, temporary, _snapshot):
            Path(temporary).write_bytes(b"partial encrypted artifact")
            raise OSError("synthetic encryption interruption")

        with patch("research.backup.tempfile.tempdir", str(self.root)):
            with patch("research.backup._encrypt_snapshot", side_effect=fail_encryption):
                with self.assertRaisesRegex(OSError, "interruption"):
                    backup_database(self.database, destination)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".cw-r5a-*.tmp")), [])
        self.assertEqual(list(self.root.glob("cw-r5a-snapshot-*/")), [])
        backup = self.root / "valid.cwdb"
        backup_database(self.database, backup)
        restored = self.root / "interrupted-restore.sqlite"

        def fail_restore(_artifact, temporary):
            Path(temporary).write_bytes(b"partial plaintext restore")
            raise ValueError("synthetic restore interruption")

        with patch("research.backup.tempfile.tempdir", str(self.root)):
            with patch("research.backup._decrypt_snapshot", side_effect=fail_restore):
                with self.assertRaisesRegex(ValueError, "interruption"):
                    restore_database(backup, restored)
        self.assertFalse(restored.exists())
        self.assertTrue(backup.exists())
        self.assertEqual(list(self.root.glob("cw-r5a-restore-*/")), [])

    def test_explicit_backup_paths_refuse_relative_and_symlink_destinations(self):
        with self.assertRaisesRegex(ValueError, "absolute path"):
            backup_database(self.database, "relative-backup.cwdb")
        with self.assertRaisesRegex(ValueError, "absolute path"):
            restore_database("relative-backup.cwdb", self.root / "restore.sqlite")
        with self.assertRaises(FileNotFoundError):
            backup_database(self.root / "missing.sqlite", self.root / "missing.cwdb")
        self.assertFalse((self.root / "missing.cwdb").exists())
        in_checkout = Path(__file__).resolve().parents[1]
        destination = self.root / "must-not-use-checkout-temp.cwdb"
        with patch("research.backup.tempfile.tempdir", str(in_checkout)):
            with self.assertRaisesRegex(ValueError, "Temporary private workspace must be outside"):
                backup_database(self.database, destination)
        self.assertFalse(destination.exists())
        alias = self.root / "alias"
        try:
            os.symlink(self.root, alias, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Windows symlink creation is not available in this test environment")
        with self.assertRaisesRegex(ValueError, "reparse points"):
            backup_database(self.database, alias / "backup.cwdb")

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_backup_never_overwrites_valid_backup_or_leaves_partial_target(self):
        backup = self.root / "known-good.sqlite"
        backup_database(self.database, backup)
        before = backup.read_bytes()
        with self.assertRaisesRegex(FileExistsError, "overwrite"):
            backup_database(self.database, backup)
        self.assertEqual(backup.read_bytes(), before)
        failed_target = self.root / "must-not-publish.sqlite"

        def fail_after_partial_write(_source, temporary):
            Path(temporary).write_bytes(b"incomplete synthetic backup")
            raise OSError("synthetic injected copy failure")

        with patch("research.backup._copy_database", side_effect=fail_after_partial_write):
            with self.assertRaisesRegex(OSError, "injected"):
                backup_database(self.database, failed_target)
        self.assertFalse(failed_target.exists())
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(list(self.root.glob(".cw-r5a-*.tmp")), [])

    def test_restore_refuses_invalid_backup_without_target(self):
        invalid = self.root / "invalid.sqlite"
        invalid.write_bytes(b"not an authenticated backup artifact")
        target = self.root / "restore.sqlite"
        with self.assertRaises(ValueError):
            restore_database(invalid, target)
        self.assertFalse(target.exists())
    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_restore_refuses_existing_target(self):
        valid = self.root / "valid.cwdb"
        backup_database(self.database, valid)
        target = self.root / "restore.sqlite"
        target.write_bytes(b"keep existing")
        before = target.read_bytes()
        with self.assertRaisesRegex(FileExistsError, "overwrite"):
            restore_database(valid, target)
        self.assertEqual(target.read_bytes(), before)

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_cli_backup_and_restore_are_outside_checkout_and_verified(self):
        backup_dir = self.root / "backup"
        restore_dir = self.root / "restore"
        backup_dir.mkdir()
        restore_dir.mkdir()
        backup = backup_dir / "rehearsal.sqlite"
        restored = restore_dir / "reopened.sqlite"
        seeded = self.cli("seed-counties", self.database)
        self.assertEqual(seeded.returncode, 0, seeded.stderr)
        created = self.cli("backup", self.database, backup)
        self.assertEqual(created.returncode, 0, created.stderr)
        created_result = json.loads(created.stdout)
        self.assertEqual(created_result["status"], "completed")
        result = self.cli("restore", backup, restored)
        self.assertEqual(result.returncode, 0, result.stderr)
        restored_result = json.loads(result.stdout)
        self.assertEqual(restored_result["status"], "restored_and_verified")
        self.assertEqual(restored_result["table_counts"]["counties"], 64)

    @unittest.skipUnless(os.name == "nt", "authenticated backup uses Windows DPAPI")
    def test_cli_refuses_restore_destination_inside_checkout(self):
        backup = self.root / "backup.sqlite"
        backup_database(self.database, backup)
        inside = Path(__file__).resolve().parents[1] / "must-not-be-restored.sqlite"
        result = self.cli("restore", backup, inside)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside the source checkout", result.stderr)
        self.assertFalse(inside.exists())


if __name__ == "__main__":
    unittest.main()

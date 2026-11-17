"""Synthetic rejection preservation tests for explicit private CSV quarantine."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from research.db import connect, migrate
from research.intake import quarantine_validation_report
from research.mapping import COUNTIES, HEADERS_17
from research.quarantine import quarantine_invalid_original
from tests.research_fixtures import csv_bytes
from tests.test_csv_intake import fixture_csv, fixture_row


class QuarantineCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "research.sqlite"
        db = connect(self.database)
        migrate(db)
        db.execute("INSERT INTO county VALUES (?,?)", ("08107", COUNTIES["08107"]))
        db.commit()
        db.close()
        self.csv_path = self.root / "rejected-original.csv"
        self.quarantine_root = self.root / "private-quarantine"
        self.quarantine_root.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, "-B", "-m", "research", *map(str, args)],
                              capture_output=True, text=True, check=False)

    def invalid_payload(self):
        valid = fixture_row(full_name="Synthetic Rowan, Jr.\nSecond line",
                            source_title="Invented Directory, Public Listing")
        invalid = fixture_row(full_name="SYNTHETIC_PRIVATE_SENTINEL",
                              source_url="file:///synthetic/private",
                              private_note="SYNTHETIC_NOTE_SENTINEL")
        return b"\xef\xbb\xbf" + fixture_csv(rows=[valid, invalid])

    def counts(self):
        db = connect(self.database)
        try:
            return {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                    for table in ("research_scrapes", "research_runs", "research_sources", "research_evidence",
                                  "profile_research_role", "research_history", "profile_research")}
        finally:
            db.close()

    def report(self, payload, *, label="rejected-v1", version="legacy-17/v1"):
        db = connect(self.database)
        try:
            return quarantine_validation_report(db, payload, file_name=self.csv_path.name,
                                                version=version, version_label=label,
                                                lineage_kind="original")
        finally:
            db.close()

    def quarantine_args(self, label="rejected-v1"):
        return ("quarantine-invalid", self.database, "--file", self.csv_path,
                "--root", self.quarantine_root, "--version", "legacy-17/v1",
                "--version-label", label, "--lineage-kind", "original",
                "--provenance", "synthetic")

    def test_quarantine_preserves_exact_mixed_invalid_bytes_and_sanitized_locators(self):
        payload = self.invalid_payload()
        self.csv_path.write_bytes(payload)
        db_before = self.database.read_bytes()
        result = self.cli("preview-csv", self.database, "--file", self.csv_path,
                          "--version", "legacy-17/v1", "--version-label", "rejected-v1",
                          "--lineage-kind", "original", "--provenance", "synthetic")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn("SYNTHETIC_PRIVATE_SENTINEL", result.stdout)
        self.assertNotIn("SYNTHETIC_NOTE_SENTINEL", result.stdout)
        self.assertEqual(self.list_artifacts(), [])
        self.assertEqual(self.database.read_bytes(), db_before)
        self.assertEqual(sum(self.counts().values()), 0)

        quarantined = self.cli(*self.quarantine_args())
        self.assertEqual(quarantined.returncode, 0, quarantined.stderr)
        receipt = json.loads(quarantined.stdout)
        self.assertEqual(receipt["status"], "quarantined")
        self.assertEqual(receipt["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(receipt["size_bytes"], len(payload))
        self.assertNotIn("SYNTHETIC_PRIVATE_SENTINEL", quarantined.stdout)
        self.assertNotIn("SYNTHETIC_NOTE_SENTINEL", quarantined.stdout)
        artifact = Path(receipt["path"])
        self.assertEqual((artifact / "source.bin").read_bytes(), payload)
        manifest_bytes = (artifact / "manifest.json").read_bytes()
        self.assertNotIn(b"SYNTHETIC_PRIVATE_SENTINEL", manifest_bytes)
        self.assertNotIn(b"SYNTHETIC_NOTE_SENTINEL", manifest_bytes)
        manifest = json.loads(manifest_bytes)
        diagnostic = manifest["validation"]["errors"][0]
        self.assertEqual((diagnostic["record_number"], diagnostic["line_start"], diagnostic["line_end"]),
                         (2, 4, 4))
        self.assertEqual(diagnostic["category"], "invalid_url")
        self.assertEqual(manifest["lineage"], {"kind": "original", "parent_batch_id": None,
                                               "provenance": "synthetic"})
        self.assertEqual(sum(self.counts().values()), 0)

    def test_repeated_quarantine_is_idempotent_and_conflicting_metadata_refuses(self):
        payload = self.invalid_payload()
        self.csv_path.write_bytes(payload)
        first = json.loads(self.cli(*self.quarantine_args()).stdout)
        attempted_at = first["attempted_at"]
        repeated = self.cli(*self.quarantine_args())
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        second = json.loads(repeated.stdout)
        self.assertEqual(second["status"], "already_present")
        self.assertEqual(second["path"], first["path"])
        self.assertEqual(second["attempted_at"], attempted_at)
        changed = self.cli(*self.quarantine_args(label="different-label"))
        self.assertEqual(changed.returncode, 2)
        self.assertIn("conflicting metadata", changed.stdout)
        self.assertEqual(self.list_artifacts(), [Path(first["path"]).name])

    def test_malformed_csv_has_only_known_physical_line_and_no_invented_record(self):
        payload = b"\xef\xbb\xbf" + ",".join(HEADERS_17).encode() + b"\r\n\"unfinished field\r\n"
        report = self.report(payload)
        self.assertFalse(report["eligible"])
        self.assertEqual(report["errors"][0]["category"], "malformed_csv")
        self.assertIsNone(report["errors"][0]["record_number"])
        self.assertEqual((report["errors"][0]["line_start"], report["errors"][0]["line_end"]), (2, 2))
        self.csv_path.write_bytes(payload)
        result = json.loads(self.cli(*self.quarantine_args()).stdout)
        manifest = json.loads((Path(result["path"]) / "manifest.json").read_text(encoding="utf-8"))
        self.assertIsNone(manifest["validation"]["errors"][0]["record_number"])
        self.assertEqual((manifest["validation"]["errors"][0]["line_start"],
                          manifest["validation"]["errors"][0]["line_end"]), (2, 2))
        self.assertEqual((Path(result["path"]) / "source.bin").read_bytes(), payload)

    def test_wrong_width_keeps_known_record_and_line_locator(self):
        payload = csv_bytes([["too", "short"]], HEADERS_17)
        report = self.report(payload)
        error = report["errors"][0]
        self.assertEqual((error["category"], error["record_number"], error["line_start"], error["line_end"]),
                         ("record_width", 1, 2, 2))

    def test_malformed_tail_keeps_prior_diagnostics_without_inventing_bad_record_number(self):
        invalid = fixture_row(source_url="file:///synthetic/invalid")
        payload = fixture_csv(rows=[invalid]) + b'"unreadable\r\ncontinued without a close'
        report = self.report(payload)
        self.assertEqual(len(report["errors"]), 2)
        self.assertEqual((report["errors"][0]["record_number"], report["errors"][0]["line_start"],
                          report["errors"][0]["line_end"]), (1, 2, 2))
        self.assertEqual((report["errors"][1]["record_number"], report["errors"][1]["line_start"],
                          report["errors"][1]["line_end"]), (None, 3, 4))
        self.csv_path.write_bytes(payload)
        completed = self.cli(*self.quarantine_args())
        self.assertEqual(completed.returncode, 0, completed.stderr)
        receipt = json.loads(completed.stdout)
        manifest = json.loads((Path(receipt["path"]) / "manifest.json").read_text(encoding="utf-8"))
        errors = manifest["validation"]["errors"]
        self.assertEqual((errors[0]["record_number"], errors[0]["line_start"], errors[0]["line_end"]),
                         (1, 2, 2))
        self.assertEqual((errors[1]["record_number"], errors[1]["line_start"], errors[1]["line_end"]),
                         (None, 3, 4))

    def test_rejects_traversal_filename_and_unsafe_root(self):
        payload = self.invalid_payload()
        report = self.report(payload)
        with self.assertRaisesRegex(ValueError, "basename"):
            quarantine_invalid_original(self.quarantine_root, payload, file_name="../escape.csv",
                                        version="legacy-17/v1", version_label="v1",
                                        validation_report=report, provenance="synthetic")
        with self.assertRaisesRegex(ValueError, "outside the source checkout"):
            quarantine_invalid_original(Path(__file__).resolve().parents[1], payload,
                                        file_name="rejected.csv", version="legacy-17/v1",
                                        version_label="v1", validation_report=report,
                                        provenance="synthetic")
        self.assertEqual(self.list_artifacts(), [])

    def test_rejects_symlinked_quarantine_root_when_platform_allows_symlink_creation(self):
        linked_root = self.root / "quarantine-link"
        try:
            linked_root.symlink_to(self.quarantine_root, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Symlink creation is unavailable: {error.__class__.__name__}")
        payload = self.invalid_payload()
        report = self.report(payload)
        with self.assertRaisesRegex(ValueError, "symbolic links or reparse points"):
            quarantine_invalid_original(linked_root, payload, file_name=self.csv_path.name,
                                        version="legacy-17/v1", version_label="v1",
                                        validation_report=report, provenance="synthetic")
        self.assertEqual(self.list_artifacts(), [])

    def test_partial_write_failure_removes_staging_and_publishes_nothing(self):
        payload = self.invalid_payload()
        report = self.report(payload)
        write_file = __import__("research.quarantine", fromlist=["_write_file"])._write_file
        calls = 0

        def fail_second(path, content):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic manifest write failure")
            write_file(path, content)

        with patch("research.quarantine._write_file", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "synthetic manifest"):
                quarantine_invalid_original(self.quarantine_root, payload, file_name=self.csv_path.name,
                                            version="legacy-17/v1", version_label="v1",
                                            validation_report=report, provenance="synthetic")
        self.assertEqual(self.list_artifacts(), [])
        self.assertEqual(list(self.quarantine_root.iterdir()), [])

    def test_invalid_encoding_is_preserved_without_decoding_or_record_locator(self):
        payload = b"\xff\xfe\x00\x81 malformed bytes"
        report = self.report(payload)
        self.assertFalse(report["eligible"])
        self.assertEqual(report["errors"][0]["category"], "invalid_encoding")
        self.assertIsNone(report["errors"][0]["record_number"])
        self.csv_path.write_bytes(payload)
        result = self.cli(*self.quarantine_args())
        self.assertEqual(result.returncode, 0, result.stderr)
        artifact = json.loads(result.stdout)
        self.assertEqual((Path(artifact["path"]) / "source.bin").read_bytes(), payload)

    def list_artifacts(self):
        return sorted(item.name for item in self.quarantine_root.iterdir())


if __name__ == "__main__":
    unittest.main()

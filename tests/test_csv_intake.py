"""Synthetic CLI and preview coverage for safe CSV intake."""

import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from research.db import connect, migrate
from research.intake import preview_csv
from research.mapping import (COUNTIES, FIELDS_11, FIELDS_16, FIELDS_17, HEADERS_11,
                              HEADERS_16, HEADERS_17, canonical_json)
from research.store import ingest_csv
from tests.research_fixtures import csv_bytes


VERSIONS = {
    "legacy-11/v1": (HEADERS_11, FIELDS_11),
    "legacy-16/v1": (HEADERS_16, FIELDS_16),
    "legacy-17/v1": (HEADERS_17, FIELDS_17),
}


def fixture_row(fips="08107", **changes):
    values = dict.fromkeys(FIELDS_17, "")
    values.update(county_fips=fips, county=COUNTIES[fips], full_name="Synthetic Riley Example",
                  department="Fixture Office", title="Fixture Coordinator",
                  grouping_basis="Official county structure",
                  listing_status="Listed in official source", source_title="Invented directory",
                  source_url=f"https://example.invalid/{fips}/directory", source_date="2025-03",
                  checked_date="2026-11-12", private_note="SYNTHETIC ONLY")
    values.update(changes)
    return values


def fixture_csv(version="legacy-17/v1", rows=None):
    headers, fields = VERSIONS[version]
    rows = [fixture_row()] if rows is None else rows
    return csv_bytes([[row[field] for field in fields] for row in rows], headers)


class CsvIntakeCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "research.sqlite"
        self.csv_path = self.root / "fixture.csv"
        db = connect(self.database)
        migrate(db)
        db.executemany("INSERT INTO counties VALUES (?,?)",
                       [(fips, COUNTIES[fips]) for fips in ("08107", "08031", "08123")])
        db.commit()
        db.close()

    def tearDown(self):
        self.temporary.cleanup()

    def call_cli(self, *arguments):
        return subprocess.run([sys.executable, "-B", "-m", "research", *map(str, arguments)],
                              capture_output=True, text=True, check=False)

    def write_csv(self, payload):
        self.csv_path.write_bytes(payload)
        return self.csv_path

    def preview_args(self, version="legacy-17/v1", *, path=None, kind="original", extra=()):
        return ("preview-csv", self.database, "--file", path or self.csv_path,
                "--version", version, "--lineage-kind", kind, *extra)

    def intake_args(self, version="legacy-17/v1", *, path=None, kind="original", label="fixture-v1", extra=()):
        return ("intake-csv", self.database, "--file", path or self.csv_path,
                "--version", version, "--version-label", label,
                "--lineage-kind", kind, "--commit", *extra)

    def result(self, completed):
        self.assertTrue(completed.stdout.strip(), completed.stderr)
        return json.loads(completed.stdout)

    def counts(self):
        db = connect(self.database)
        try:
            return {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                    for table in ("scrape_batches", "research_runs", "sources", "evidence_links",
                                  "role_claims", "research_events", "source_visits", "research_people")}
        finally:
            db.close()

    def test_preview_accepts_each_explicit_version_without_row_content(self):
        for version in VERSIONS:
            with self.subTest(version=version):
                rows = None
                if version == "legacy-11/v1":
                    rows = [fixture_row(county_fips=" 08107 ", county=" Routt ",
                                        listing_status=" Listed in official source ")]
                self.write_csv(fixture_csv(version, rows=rows))
                completed = self.call_cli(*self.preview_args(version))
                self.assertEqual(completed.returncode, 0, completed.stderr)
                result = self.result(completed)
                self.assertTrue(result["eligible"])
                self.assertEqual(result["mapping_version"], version)
                self.assertEqual(result["column_count"], len(VERSIONS[version][0]))
                self.assertEqual(result["county"], {"fips": "08107", "name": "Routt"})
                self.assertEqual(result["records"], {"total": 1, "valid": 1, "invalid": 0,
                                                      "duplicate_rows": 0, "expected_distinct_claims": 1})
                self.assertEqual(result["source_metadata"], {"records_with_title": 1,
                                                               "records_with_source_date": 1,
                                                               "records_with_checked_date": 1})
                self.assertNotIn("Synthetic Riley Example", completed.stdout)
                self.assertNotIn("SYNTHETIC ONLY", completed.stdout)

    def test_preview_and_commit_require_matching_registered_county(self):
        self.write_csv(fixture_csv(rows=[fixture_row(fips="08037")]))
        before_counts = self.counts()
        before_bytes = self.database.read_bytes()
        before_files = sorted(item.name for item in self.root.iterdir())
        preview = self.result(self.call_cli(*self.preview_args()))
        self.assertFalse(preview["eligible"])
        self.assertIn("county_not_registered", [item["category"] for item in preview["errors"]])
        self.assertEqual(self.call_cli(*self.intake_args()).returncode, 2)
        self.assertEqual(self.counts(), before_counts)
        self.assertEqual(self.database.read_bytes(), before_bytes)
        self.assertEqual(sorted(item.name for item in self.root.iterdir()), before_files)

        db = connect(self.database)
        db.execute("INSERT INTO counties VALUES ('08037','Eagle')")
        db.commit()
        db.close()
        registered = self.result(self.call_cli(*self.preview_args()))
        self.assertTrue(registered["eligible"])
        self.assertEqual(self.call_cli(*self.intake_args()).returncode, 0)

    def test_preview_and_commit_fail_closed_on_conflicting_county_name(self):
        db = connect(self.database)
        db.execute("INSERT INTO counties VALUES ('08037','Synthetic Wrong County')")
        db.commit()
        db.close()
        self.write_csv(fixture_csv(rows=[fixture_row(fips="08037")]))
        before_counts = self.counts()
        preview = self.result(self.call_cli(*self.preview_args()))
        self.assertFalse(preview["eligible"])
        self.assertIn("county_registry_conflict", [item["category"] for item in preview["errors"]])
        committed = self.call_cli(*self.intake_args())
        self.assertEqual(committed.returncode, 2, committed.stderr)
        self.assertEqual(self.counts(), before_counts)

    def test_mapping_version_is_required_and_never_guessed(self):
        self.write_csv(fixture_csv("legacy-11/v1"))
        missing = self.call_cli("preview-csv", self.database, "--file", self.csv_path)
        self.assertEqual(missing.returncode, 2)
        wrong = self.call_cli(*self.preview_args("legacy-17/v1"))
        self.assertEqual(wrong.returncode, 1)
        wrong_result = self.result(wrong)
        self.assertEqual(wrong_result["errors"][0]["category"], "unsupported_header")
        self.assertFalse(wrong_result["header_match"])
        self.assertEqual(wrong_result["column_count"], 11)
        self.assertEqual(sum(self.counts().values()), 0)

    def test_report_collects_multiple_sanitized_diagnostics_and_line_ranges(self):
        bad_one = fixture_row(county="Boulder", full_name="Private synthetic row A")
        bad_two = fixture_row(listing_status="Unknown", source_date="not a date", source_url="file:///private",
                              private_note="SENSITIVE SYNTHETIC NOTE")
        good = fixture_row(full_name='Synthetic "Comma, Line\nExample"')
        payload = fixture_csv(rows=[bad_one, bad_two, good])
        self.write_csv(payload)
        completed = self.call_cli(*self.preview_args())
        self.assertEqual(completed.returncode, 1)
        result = self.result(completed)
        self.assertEqual(result["records"]["total"], 3)
        self.assertEqual(result["records"]["valid"], 1)
        self.assertEqual(result["records"]["invalid"], 2)
        self.assertGreaterEqual(len(result["errors"]), 3)
        self.assertTrue(all(error["record_number"] and error["line_start"] and error["line_end"]
                            for error in result["errors"]))
        self.assertTrue({error["field"] for error in result["errors"]} >= {"county", "listing_status", "source_date", "source_url"})
        self.assertNotIn("Private synthetic row A", completed.stdout)
        self.assertNotIn("SENSITIVE SYNTHETIC NOTE", completed.stdout)

    def test_width_errors_bom_multiline_and_within_file_duplicates(self):
        one = fixture_row(full_name="Synthetic Rowan, Jr.\nSecond line")
        payload = b"\xef\xbb\xbf" + fixture_csv(rows=[one, one])
        self.write_csv(payload)
        completed = self.call_cli(*self.preview_args())
        result = self.result(completed)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(result["records"]["duplicate_rows"], 1)
        self.assertEqual(result["records"]["expected_distinct_claims"], 1)
        self.assertEqual(result["column_count"], 17)

        malformed_width = csv_bytes([["only", "two"]], HEADERS_17)
        self.write_csv(malformed_width)
        failed = self.call_cli(*self.preview_args())
        result = self.result(failed)
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(result["errors"][0]["category"], "record_width")
        self.assertEqual(result["errors"][0]["record_number"], 1)
        self.assertEqual(result["errors"][0]["line_start"], 2)

        malformed_quote = b",".join(value.encode() for value in HEADERS_17) + b"\r\n\"unterminated"
        self.write_csv(malformed_quote)
        malformed = self.call_cli(*self.preview_args())
        self.assertEqual(malformed.returncode, 1)
        malformed_result = self.result(malformed)
        self.assertEqual(malformed_result["errors"][0]["category"], "malformed_csv")
        self.assertEqual(malformed_result["column_count"], 17)
        self.assertEqual(malformed_result["errors"][0]["line_start"], 2)

    def test_preview_is_read_only_and_does_not_create_auxiliary_files(self):
        self.write_csv(fixture_csv())
        before_bytes = self.database.read_bytes()
        before_mtime = self.database.stat().st_mtime_ns
        before_files = {item.name for item in self.root.iterdir()}
        completed = self.call_cli(*self.preview_args())
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.database.read_bytes(), before_bytes)
        self.assertEqual(self.database.stat().st_mtime_ns, before_mtime)
        self.assertEqual({item.name for item in self.root.iterdir()}, before_files)
        self.assertEqual(sum(self.counts().values()), 0)

    def test_preview_flags_existing_replay_and_commit_is_idempotent(self):
        self.write_csv(fixture_csv())
        first = self.call_cli(*self.intake_args())
        self.assertEqual(first.returncode, 0, first.stderr)
        first_result = self.result(first)
        before = self.counts()
        preview = self.call_cli(*self.preview_args(extra=("--version-label", "fixture-v1")))
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertEqual(self.result(preview)["replay"]["status"], "replay_match")
        replay = self.call_cli(*self.intake_args(extra=("--select",)))
        self.assertEqual(replay.returncode, 3, replay.stderr)
        replay_result = self.result(replay)
        self.assertEqual(replay_result["status"], "replayed")
        self.assertEqual(replay_result["batch_id"], first_result["batch_id"])
        self.assertFalse(replay_result["selected"])
        self.assertEqual(self.counts(), before)

    def test_replay_with_logically_incomplete_delivery_fails_sanitized(self):
        self.write_csv(fixture_csv())
        self.assertEqual(self.call_cli(*self.intake_args()).returncode, 0)
        db = connect(self.database)
        db.execute("DELETE FROM role_claims")
        db.commit()
        before = self.counts()
        with self.assertRaisesRegex(ValueError, "missing a claim"):
            ingest_csv(db, fixture_csv(), file_name="fixture.csv", version_label="fixture-v1",
                       provenance="legacy_delivery")
        self.assertEqual(self.counts(), before)
        db.close()
        completed = self.call_cli(*self.intake_args())
        self.assertEqual(completed.returncode, 2)
        result = self.result(completed)
        self.assertEqual(result["errors"][0]["category"], "replay_conflict")
        self.assertNotIn("Traceback", completed.stderr)
        self.assertNotIn("Synthetic Riley Example", completed.stdout)
        self.assertEqual(self.counts(), before)

    def test_conflicting_replay_metadata_is_rejected_without_writes(self):
        self.write_csv(fixture_csv())
        self.assertEqual(self.call_cli(*self.intake_args()).returncode, 0)
        before = self.counts()
        preview = self.call_cli(*self.preview_args(extra=("--version-label", "different-label")))
        self.assertEqual(preview.returncode, 1)
        self.assertEqual(self.result(preview)["replay"]["status"], "metadata_conflict")
        conflict = self.call_cli(*self.intake_args(label="different-label"))
        self.assertEqual(conflict.returncode, 2)
        self.assertEqual(self.counts(), before)

    def test_hash_binding_rejects_changed_file_without_writes(self):
        first_bytes = fixture_csv()
        self.write_csv(first_bytes)
        preview = self.call_cli(*self.preview_args())
        expected = self.result(preview)["file_sha256"]
        changed = fixture_csv(rows=[fixture_row(title="Changed synthetic title")])
        self.write_csv(changed)
        before = self.counts()
        completed = self.call_cli(*self.intake_args(extra=("--expect-sha256", expected)))
        self.assertEqual(completed.returncode, 2)
        result = self.result(completed)
        self.assertEqual(result["errors"][0]["category"], "input_hash_mismatch")
        self.assertEqual(result["file_sha256"], hashlib.sha256(changed).hexdigest())
        self.assertEqual(self.counts(), before)

    def test_commit_requires_unmistakable_flag_and_explicit_version(self):
        self.write_csv(fixture_csv())
        no_commit = self.call_cli("intake-csv", self.database, "--file", self.csv_path,
                                  "--version", "legacy-17/v1", "--version-label", "v1",
                                  "--lineage-kind", "original")
        no_version = self.call_cli("intake-csv", self.database, "--file", self.csv_path,
                                   "--version-label", "v1", "--lineage-kind", "original", "--commit")
        self.assertEqual(no_commit.returncode, 2)
        self.assertEqual(no_version.returncode, 2)
        self.assertEqual(sum(self.counts().values()), 0)

    def test_commit_preserves_raw_provenance_and_never_infers_identity(self):
        row = fixture_row(full_name='Synthetic "Quoted,\nName"', private_note="private synthetic note")
        payload = b"\xef\xbb\xbf" + fixture_csv(rows=[row])
        self.write_csv(payload)
        completed = self.call_cli(*self.intake_args(extra=("--expect-sha256", hashlib.sha256(payload).hexdigest())))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = self.result(completed)
        self.assertEqual(result["status"], "created")
        self.assertTrue(result["created"])
        self.assertEqual(result["mapping_version"], "legacy-17/v1")
        self.assertEqual(result["file_sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result["record_count"], 1)
        self.assertEqual(result["distinct_claims"], 1)
        db = connect(self.database)
        try:
            evidence = db.execute("SELECT * FROM evidence_links").fetchone()
            raw = json.loads(evidence["raw_record_json"])
            self.assertEqual(raw["cells"][2], row["full_name"])
            occurrence = json.loads(evidence["occurrences_json"])[0]
            self.assertIn('"Quoted,\nName"', occurrence["raw_text"])
            self.assertEqual((occurrence["line_start"], occurrence["line_end"]), (2, 3))
            self.assertEqual(evidence["raw_record_sha256"],
                             hashlib.sha256(canonical_json(raw["cells"]).encode()).hexdigest())
            batch = db.execute("SELECT file_sha256,mapping_version,original_file_name,lineage_kind FROM scrape_batches").fetchone()
            self.assertEqual(tuple(batch), (hashlib.sha256(payload).hexdigest(), "legacy-17/v1",
                                             "fixture.csv", "original"))
            source = db.execute("SELECT original_url FROM sources WHERE id=?", (evidence["source_id"],)).fetchone()
            self.assertEqual(source[0], row["source_url"])
            claim = db.execute("SELECT person_id,unit_id,employment_start,employment_end FROM role_claims").fetchone()
            self.assertEqual(tuple(claim), (None, None, None, None))
            self.assertEqual(db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)
        finally:
            db.close()

    def test_complementary_is_additive_and_corrected_is_nonadditive_when_selected(self):
        self.write_csv(fixture_csv())
        original = self.result(self.call_cli(*self.intake_args(extra=("--select",))))
        db = connect(self.database)
        claim_id = db.execute("SELECT id FROM role_claims").fetchone()[0]
        db.close()

        complementary_path = self.root / "complementary.csv"
        complementary_path.write_bytes(fixture_csv(rows=[fixture_row(title="Second fixture role")]))
        complementary = self.call_cli(*self.intake_args(path=complementary_path, kind="complementary",
                                                        label="complement-v1", extra=("--select",)))
        self.assertEqual(complementary.returncode, 0, complementary.stderr)
        complementary_result = self.result(complementary)

        corrected_path = self.root / "corrected.csv"
        corrected_path.write_bytes(fixture_csv(rows=[fixture_row(title="Corrected fixture role")]))
        links = self.root / "supersedes.json"
        links.write_text(json.dumps({"1": claim_id}), encoding="utf-8")
        corrected = self.call_cli(*self.intake_args(path=corrected_path, kind="corrected", label="corrected-v1",
                                                    extra=("--parent-batch-id", original["batch_id"],
                                                           "--supersedes-json", links, "--select")))
        self.assertEqual(corrected.returncode, 0, corrected.stderr)
        corrected_result = self.result(corrected)
        self.assertEqual(corrected_result["parent_batch_id"], original["batch_id"])
        self.assertNotEqual(complementary_result["family_id"], original["family_id"])
        alternative_path = self.root / "alternative.csv"
        alternative_path.write_bytes(fixture_csv(rows=[fixture_row(title="Alternative fixture role")]))
        alternative = self.call_cli(*self.intake_args(path=alternative_path, kind="alternative", label="alternative-v1",
                                                      extra=("--parent-batch-id", original["batch_id"],
                                                             "--supersedes-json", links)))
        self.assertEqual(alternative.returncode, 0, alternative.stderr)
        alternative_result = self.result(alternative)
        self.assertFalse(alternative_result["selected"])
        db = connect(self.database)
        try:
            selected = db.execute("SELECT id,supersedes_id FROM selected_role_claims ORDER BY id").fetchall()
            self.assertEqual(len(selected), 2)
            self.assertEqual({row["supersedes_id"] for row in selected}, {None, claim_id})
            family = db.execute("SELECT selected FROM scrape_batches WHERE id=?", (original["batch_id"],)).fetchone()
            self.assertEqual(family[0], 0)
            alternative_batch = db.execute("SELECT selected,family_id FROM scrape_batches WHERE id=?",
                                           (alternative_result["batch_id"],)).fetchone()
            self.assertEqual(alternative_batch["selected"], 0)
            self.assertEqual(alternative_batch["family_id"], original["family_id"])
        finally:
            db.close()

    def test_missing_and_cross_county_parents_are_reported(self):
        self.write_csv(fixture_csv())
        missing = self.call_cli(*self.preview_args(kind="corrected", extra=("--parent-batch-id", "missing")))
        self.assertEqual(missing.returncode, 1)
        self.assertTrue(any(error["category"] == "missing_parent" for error in self.result(missing)["errors"]))
        self.assertEqual(sum(self.counts().values()), 0)

        db = connect(self.database)
        parent = ingest_csv(db, fixture_csv(), file_name="parent.csv", version_label="parent-v1",
                            version="legacy-17/v1", provenance="synthetic", selected=True)
        db.close()
        # A real parent from another county is valid database state but cannot parent this delivery.
        other = fixture_row("08031")
        other_path = self.root / "other.csv"
        other_path.write_bytes(fixture_csv(rows=[other]))
        db = connect(self.database)
        other_parent = ingest_csv(db, other_path.read_bytes(), file_name="other.csv", version_label="other-v1",
                                  version="legacy-17/v1", provenance="synthetic", selected=True)
        db.close()
        cross = self.call_cli(*self.preview_args(kind="alternative", extra=("--parent-batch-id", other_parent)))
        self.assertEqual(cross.returncode, 1)
        self.assertTrue(any(error["category"] == "parent_county_mismatch" for error in self.result(cross)["errors"]))

    def test_commit_revalidates_database_after_preview(self):
        payload = fixture_csv()
        self.write_csv(payload)
        preview = self.call_cli(*self.preview_args(extra=("--version-label", "fixture-v1")))
        self.assertEqual(preview.returncode, 0)
        preview_hash = self.result(preview)["file_sha256"]
        db = connect(self.database)
        existing = ingest_csv(db, payload, file_name="fixture.csv", version_label="fixture-v1",
                              version="legacy-17/v1", provenance="legacy_delivery", selected=False)
        db.close()
        before = self.counts()
        committed = self.call_cli(*self.intake_args(extra=("--expect-sha256", preview_hash)))
        self.assertEqual(committed.returncode, 3)
        result = self.result(committed)
        self.assertEqual(result["status"], "replayed")
        self.assertEqual(result["batch_id"], existing)
        self.assertEqual(self.counts(), before)

    def test_late_transaction_failure_rolls_back_every_table_and_selection(self):
        self.write_csv(fixture_csv())
        db = connect(self.database)
        db.execute("CREATE TRIGGER fail_intake_event BEFORE INSERT ON research_events "
                   "WHEN NEW.kind='delivery_mapped' BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END")
        db.commit()
        db.close()
        before = self.counts()
        completed = self.call_cli(*self.intake_args(extra=("--select",)))
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(self.result(completed)["errors"][0]["category"], "commit_failed")
        self.assertEqual(self.counts(), before)

    def test_correction_links_and_stale_database_metadata_reject_cleanly(self):
        self.write_csv(fixture_csv(rows=[fixture_row(title="Corrected role")]))
        missing_parent = self.call_cli(*self.intake_args(kind="corrected", label="corrected-v1",
                                                         extra=("--parent-batch-id", "no-such-parent")))
        self.assertEqual(missing_parent.returncode, 2)
        self.assertEqual(sum(self.counts().values()), 0)

        db = connect(self.database)
        parent = ingest_csv(db, fixture_csv(), file_name="parent.csv", version_label="parent-v1",
                            version="legacy-17/v1", provenance="synthetic", selected=True)
        db.close()
        links = self.root / "invalid-links.json"
        links.write_text(json.dumps({"1": "claim-not-in-parent"}), encoding="utf-8")
        before = self.counts()
        invalid = self.call_cli(*self.intake_args(kind="corrected", label="corrected-v1",
                                                 extra=("--parent-batch-id", parent,
                                                        "--supersedes-json", links)))
        self.assertEqual(invalid.returncode, 2)
        self.assertEqual(self.result(invalid)["errors"][0]["category"], "invalid_correction_reference")
        self.assertEqual(self.counts(), before)

    def test_invalid_correction_targets_do_not_create_secondary_conflicts(self):
        parent_path = self.root / "parent.csv"
        parent_path.write_bytes(fixture_csv(rows=[fixture_row(title="Parent role one"),
                                                   fixture_row(title="Parent role two")]))
        original = self.result(self.call_cli(*self.intake_args(path=parent_path, label="parent-v1")))
        db = connect(self.database)
        valid_claims = [row[0] for row in db.execute("SELECT id FROM role_claims ORDER BY id")]
        db.close()

        duplicate_path = self.root / "duplicate.csv"
        duplicate_path.write_bytes(fixture_csv(rows=[fixture_row(title="Same fixture role"),
                                                      fixture_row(title="Same fixture role")]))

        invalid_links = self.root / "invalid-links.json"
        invalid_links.write_text(json.dumps({"1": "claim_fixture_missing_a", "2": "claim_fixture_missing_b"}),
                                 encoding="utf-8")
        invalid = self.call_cli(*self.preview_args(kind="corrected", path=duplicate_path,
                                                   extra=("--parent-batch-id", original["batch_id"],
                                                          "--supersedes-json", invalid_links)))
        self.assertEqual(invalid.returncode, 1)
        invalid_errors = self.result(invalid)["errors"]
        self.assertEqual(sum(error["category"] == "invalid_correction_reference" for error in invalid_errors), 2)
        self.assertFalse(any(error["category"] == "duplicate_correction_conflict" for error in invalid_errors))

        valid_links = self.root / "valid-links.json"
        valid_links.write_text(json.dumps({"1": valid_claims[0], "2": valid_claims[1]}), encoding="utf-8")
        conflicting = self.call_cli(*self.preview_args(kind="corrected", path=duplicate_path,
                                                       extra=("--parent-batch-id", original["batch_id"],
                                                              "--supersedes-json", valid_links)))
        self.assertEqual(conflicting.returncode, 1)
        self.assertTrue(any(error["category"] == "duplicate_correction_conflict"
                            for error in self.result(conflicting)["errors"]))
        self.assertEqual(self.counts(), {"scrape_batches": 1, "research_runs": 1, "sources": 1,
                                         "evidence_links": 2, "role_claims": 2, "research_events": 1,
                                         "source_visits": 0, "research_people": 0})

    def test_read_only_migration_history_validation_rejects_incomplete_db(self):
        bad_path = self.root / "unmanaged.sqlite"
        sqlite3.connect(bad_path).close()
        csv_path = self.write_csv(fixture_csv())
        before = bad_path.read_bytes()
        completed = self.call_cli("preview-csv", bad_path, "--file", csv_path,
                                  "--version", "legacy-17/v1")
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(self.result(completed)["errors"][0]["category"], "preview_failed")
        self.assertEqual(bad_path.read_bytes(), before)

    def test_preview_refuses_wal_mode_without_creating_or_touching_sidecars(self):
        wal_database = self.root / "wal.sqlite"
        db = connect(wal_database)
        migrate(db)
        db.execute("INSERT INTO counties VALUES ('08107','Routt')")
        db.commit()
        self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
        db.close()
        self.write_csv(fixture_csv())
        before = {item.name: item.read_bytes() for item in self.root.iterdir() if item.is_file()}
        completed = self.call_cli("preview-csv", wal_database, "--file", self.csv_path,
                                  "--version", "legacy-17/v1")
        self.assertEqual(completed.returncode, 1)
        result = self.result(completed)
        self.assertIn("WAL-mode", result["errors"][0]["message"])
        after = {item.name: item.read_bytes() for item in self.root.iterdir() if item.is_file()}
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()

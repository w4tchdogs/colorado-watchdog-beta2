import json
import sqlite3
import tempfile
import unittest
import subprocess
import sys
from contextlib import closing
from pathlib import Path

from research.db import connect, migrate, validate_database, MIGRATIONS
from research.mapping import (
    parse_csv, date_precision, HEADERS_11, FIELDS_11, LEGACY_11, HEADERS_16, FIELDS_16, LEGACY_16,
    HEADERS_17, FIELDS_17, LEGACY_17,
    MappingSpec, register_mapping, COUNTIES,
)
from research.store import ingest_csv, set_parent
from tests.research_fixtures import observation, csv_bytes

NOW = "2026-11-12T12:00:00+00:00"


def legacy_payload(spec, fips="08107", **changes):
    values = dict.fromkeys(FIELDS_17, "")
    values.update(county_fips=fips, county=COUNTIES[fips], full_name="Synthetic Casey Example",
                  department="Fixture Department", title="Fixture Role",
                  listing_status="Listed in official source", source_title="Invented source",
                  source_url=f"https://example.invalid/{fips}/legacy", source_date="2025-03",
                  checked_date="2026-11-12", private_note="synthetic only")
    values.update(changes)
    return csv_bytes([[values[field] for field in spec.fields]], spec.headers)


class DatabaseCase(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO counties VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08107", "08031", "08123")])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def ingest(self, rows=None, **options):
        settings = {"file_name": "synthetic.csv", "version_label": "fixture-v1", "selected": True}
        settings.update(options)
        return ingest_csv(self.db, csv_bytes(rows or [observation()]), **settings)

    def citation(self, suffix="a", source=None):
        source = source or f"source-{suffix}"
        self.db.execute("INSERT OR IGNORE INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                        ("run", "screening", "synthetic", NOW))
        self.db.execute("INSERT OR IGNORE INTO sources(id,original_url,recorded_at) VALUES (?,?,?)",
                        (source, f"https://example.invalid/{source}", NOW))
        evidence = f"evidence-{suffix}"
        self.db.execute(
            "INSERT INTO evidence_links(id,source_id,observed_url,locator,run_id,recorded_at) VALUES (?,?,?,?,?,?)",
            (evidence, source, f"https://example.invalid/{source}", "synthetic section", "run", NOW),
        )
        self.db.commit()
        return evidence

    def unit(self, unit_id="u1", county="08107", kind="department", **extra):
        values = {"id": unit_id, "county_fips": county, "source_label": f"Synthetic {unit_id}", "kind": kind, **extra}
        columns = ','.join(values)
        self.db.execute(f"INSERT INTO org_units({columns}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
        self.db.commit()

    def assert_rejected(self, sql, values=()):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql, values)
        self.db.rollback()


class MigrationTests(DatabaseCase):
    def test_disk_database_reopens_with_identical_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "synthetic.sqlite")
            db = connect(path)
            migrate(db)
            db.execute("INSERT INTO counties VALUES ('08107','Routt')")
            db.commit()
            batch = ingest_csv(db, csv_bytes([observation()]), file_name="fixture.csv", version_label="v1")
            claim = db.execute("SELECT id FROM role_claims").fetchone()[0]
            db.close()
            db = connect(path)
            migrate(db)
            self.assertEqual(db.execute("SELECT id FROM role_claims").fetchone()[0], claim)
            self.assertEqual(db.execute("SELECT id FROM scrape_batches").fetchone()[0], batch)
            self.assertEqual(validate_database(db)["integrity"], "ok")
            db.close()

    def test_cli_init_and_readonly_check_and_existing_file_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "empty.sqlite")
            command = [sys.executable, "-B", "-m", "research"]
            initialized = subprocess.run(command + ["init", str(path)], capture_output=True, text=True)
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            before = path.read_bytes()
            checked = subprocess.run(command + ["check", str(path)], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertEqual(path.read_bytes(), before)
            again = subprocess.run(command + ["init", str(path)], capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertEqual(path.read_bytes(), before)
            missing = Path(directory, "missing.sqlite")
            self.assertNotEqual(subprocess.run(command + ["check", str(missing)], capture_output=True).returncode, 0)
            self.assertFalse(missing.exists())

    def test_disabled_foreign_keys_and_inconsistent_schema_version_rejected(self):
        self.db.execute("PRAGMA foreign_keys=OFF")
        with self.assertRaisesRegex(ValueError, "Foreign keys"):
            migrate(self.db)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA user_version=2")
        with self.assertRaisesRegex(ValueError, "Schema version"):
            migrate(self.db)

    def test_nineteen_domain_tables_and_integrity(self):
        tables = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(len(tables - {"schema_migrations"}), 19)
        self.assertEqual(validate_database(self.db), {"integrity": "ok", "foreign_keys": [], "schema_version": 1})
        self.assertEqual(self.db.execute("PRAGMA foreign_keys").fetchone()[0], 1)

    def test_repeat_migration_preserves_rows(self):
        self.ingest()
        before = self.db.execute("SELECT id FROM role_claims").fetchone()[0]
        migrate(self.db)
        self.assertEqual(self.db.execute("SELECT id FROM role_claims").fetchone()[0], before)

    def test_changed_migration_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "001_foundation.sql"
            path.write_text(MIGRATIONS.joinpath(path.name).read_text() + "\n-- changed\n")
            with self.assertRaisesRegex(ValueError, "changed"):
                migrate(self.db, directory)

    def test_failed_migration_is_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            with closing(connect()) as db:
                Path(directory, "001_bad.sql").write_text("CREATE TABLE partial(id TEXT); INVALID SQL;")
                with self.assertRaises(sqlite3.OperationalError):
                    migrate(db, directory)
                self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [])

    def test_unknown_history_and_unmanaged_database_rejected(self):
        self.db.execute("INSERT INTO schema_migrations VALUES ('999_future.sql','fake')")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "history"):
            migrate(self.db)
        with closing(connect()) as db:
            db.execute("CREATE TABLE external_data(id TEXT)")
            with self.assertRaisesRegex(ValueError, "unmanaged"):
                migrate(db)

    def test_strict_types_foreign_keys_and_unique_sources(self):
        self.assert_rejected("INSERT INTO org_units(id,county_fips,source_label,kind) VALUES ('u','08999','x','department')")
        self.citation()
        self.assert_rejected("INSERT INTO sources(id,original_url,recorded_at) VALUES ('other','https://example.invalid/source-a',?)", (NOW,))
        self.assert_rejected("INSERT INTO source_visits(id,source_id,run_id,provenance,duration_ms) VALUES ('v','source-a','run','synthetic','slow')")


class MappingTests(unittest.TestCase):
    def test_exact_contract_bom_unicode_quotes_and_multiline(self):
        row = observation(full_name='Synthetic Zoë "Example", Jr.', private_note="first line\nsecond line")
        payload = b'\xef\xbb\xbf' + csv_bytes([row])
        mapped = parse_csv(payload)
        self.assertEqual(mapped["rows"][0]["cells"], row)
        self.assertEqual(mapped["rows"][0]["line_start"], 2)
        self.assertEqual(mapped["rows"][0]["line_end"], 3)
        self.assertEqual(mapped["rows"][0]["source_date_precision"], "month")
        self.assertEqual(parse_csv(payload), mapped)

    def test_malformed_width_header_and_quoting(self):
        for payload in (csv_bytes([observation() + ["extra"]]), csv_bytes([observation()[:-1]]),
                        csv_bytes([observation()], tuple(reversed(HEADERS_17))),
                        csv_bytes([]) + b'"unterminated', b''):
            with self.subTest(payload=payload[:20]), self.assertRaises(ValueError):
                parse_csv(payload)

    def test_invalid_fips_status_url_dates_and_name(self):
        for change in ({"county_fips": "8107"}, {"county": "Weld"}, {"listing_status": "Active"},
                       {"source_url": "file:///private"}, {"source_url": "https://user:pass@example.invalid"},
                       {"source_date": "2025-02-30"}, {"checked_date": "2025-01"}, {"full_name": " "}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                parse_csv(csv_bytes([observation(**change)]))

    def test_date_precision_and_blank_unknowns(self):
        self.assertEqual([date_precision(x) for x in ("", "2024", "2024-02", "2024-02-29")],
                         [None, "year", "month", "day"])
        row = parse_csv(csv_bytes([observation(source_date="", checked_date="", title="", nicknames="")]))["rows"][0]
        self.assertEqual(row["values"]["title"], "")
        self.assertIsNone(row["source_date_precision"])

    def test_explicit_future_mappings_no_width_guessing(self):
        for width in (11, 16):
            # These are synthetic extension maps, not asserted legacy contracts.
            fields = list(FIELDS_17)
            for field in ("nicknames", "private_note", "display_group", "grouping_basis", "division", "program_location"):
                if len(fields) > width:
                    fields.remove(field)
            headers = tuple(f"fixture {field}" for field in fields)
            spec = MappingSpec(f"synthetic-{width}/v1", headers, tuple(fields))
            registry = {LEGACY_17.version: LEGACY_17}
            register_mapping(spec, registry)
            raw = dict(zip(FIELDS_17, observation(), strict=True))
            payload = csv_bytes([[raw[f] for f in fields]], headers)
            with self.assertRaises(ValueError):
                parse_csv(payload)
            mapped = parse_csv(payload, spec.version, registry)
            self.assertIsNone(mapped["rows"][0]["values"]["nicknames"])
            with self.assertRaises(ValueError):
                register_mapping(spec, registry)

    def test_mapping_definition_and_county_map(self):
        self.assertEqual(len(COUNTIES), 64)
        self.assertEqual((COUNTIES["08031"], COUNTIES["08014"], COUNTIES["08123"]), ("Denver", "Broomfield", "Weld"))
        with self.assertRaises(ValueError):
            MappingSpec("bad", HEADERS_17, ("full_name",) * 17)

    def test_verified_legacy_11_header_mapping_and_historical_county_names(self):
        values = dict.fromkeys(FIELDS_17, "")
        values.update(county_fips=" 08031 ", county=" City and County of Denver ",
                      full_name=" Synthetic Rowan Example ", listing_status=" Listed in official source ",
                      source_title="", source_url="https://example.invalid/denver/people",
                      source_date="2025", checked_date="", private_note="synthetic note")
        payload = b"\xef\xbb\xbf" + csv_bytes([[values[field] for field in FIELDS_11]], HEADERS_11)
        parsed = parse_csv(payload, LEGACY_11.version)
        row = parsed["rows"][0]
        self.assertEqual(parsed["mapping"], LEGACY_11)
        self.assertIsNone(row["values"]["nicknames"])
        self.assertIsNone(row["values"]["display_group"])
        self.assertEqual(row["values"]["source_date"], "2025")
        self.assertEqual(row["source_date_precision"], "year")
        self.assertEqual(row["values"]["private_note"], "synthetic note")
        self.assertEqual(row["cells"], [values[field] for field in FIELDS_11])
        self.assertEqual(row["values"]["county_fips"], "08031")
        self.assertEqual(row["values"]["full_name"], "Synthetic Rowan Example")
        self.assertEqual(row["line_start"], 2)

    def test_verified_legacy_16_mapping_preserves_extended_labels(self):
        values = dict.fromkeys(FIELDS_17, "")
        values.update(county_fips="08014", county="Broomfield County",
                      full_name="Synthetic Jordan Example", display_group="Fixture display",
                      grouping_basis="Fixture grouping wording", department="Fixture Office",
                      division="Fixture Division", program_location="Fixture Site",
                      title="Fixture Coordinator", responsibility="Invented responsibility",
                      listing_status="Unclear", source_title="Invented source",
                      source_url="https://example.invalid/broomfield/source", source_date="2025-02-03",
                      checked_date="2026-11-12", private_note="synthetic only")
        parsed = parse_csv(csv_bytes([[values[field] for field in FIELDS_16]], HEADERS_16), LEGACY_16.version)
        row = parsed["rows"][0]
        self.assertEqual(parsed["mapping"], LEGACY_16)
        self.assertEqual(row["values"]["display_group"], "Fixture display")
        self.assertEqual(row["values"]["grouping_basis"], "Fixture grouping wording")
        self.assertEqual(row["values"]["division"], "Fixture Division")
        self.assertEqual(row["values"]["program_location"], "Fixture Site")
        self.assertEqual(row["values"]["responsibility"], "Invented responsibility")
        self.assertIsNone(row["values"]["nicknames"])
        self.assertEqual(row["source_date_precision"], "day")

    def test_legacy_mappings_reject_variations_bad_values_and_oversized_fields(self):
        for spec, fields, changes in (
            (LEGACY_11, FIELDS_11, {"county": "Boulder"}),
            (LEGACY_11, FIELDS_11, {"listing_status": "Listed"}),
            (LEGACY_16, FIELDS_16, {"source_date": "2025-02-30"}),
            (LEGACY_11, FIELDS_11, {"full_name": "x" * 201}),
            (LEGACY_16, FIELDS_16, {"responsibility": "x" * 2001}),
        ):
            values = dict.fromkeys(FIELDS_17, "")
            values.update(county_fips="08107", county="Routt", full_name="Synthetic Example",
                          listing_status="Listed in official source", source_url="https://example.invalid/source")
            values.update(changes)
            payload = csv_bytes([[values[field] for field in fields]], spec.headers)
            with self.subTest(version=spec.version, changes=tuple(changes)), self.assertRaises(ValueError):
                parse_csv(payload, spec.version)
        valid = dict.fromkeys(FIELDS_17, "")
        valid.update(county_fips="08107", county="Routt", full_name="Synthetic Example",
                     listing_status="Listed in official source", source_url="https://example.invalid/source")
        cells = [valid[field] for field in FIELDS_11]
        for altered in (HEADERS_11[:-1], HEADERS_11[1:] + HEADERS_11[:1], HEADERS_11 + ("Extra",)):
            with self.assertRaises(ValueError):
                parse_csv(csv_bytes([cells], altered), LEGACY_11.version)


class ProvenanceTests(DatabaseCase):
    def test_legacy_versions_ingest_with_raw_provenance_and_lineage(self):
        original = ingest_csv(self.db, legacy_payload(LEGACY_11), file_name="legacy11.csv",
                              version_label="legacy-fixture-v1", version=LEGACY_11.version,
                              provenance="synthetic", selected=True)
        first_claim = self.db.execute("SELECT id FROM role_claims").fetchone()[0]
        corrected = ingest_csv(self.db, legacy_payload(LEGACY_11, title="Corrected fixture title"),
                               file_name="legacy11-corrected.csv", version_label="legacy-fixture-v2",
                               version=LEGACY_11.version, provenance="synthetic", lineage_kind="corrected",
                               parent_batch_id=original, supersedes={1: first_claim}, selected=False)
        self.assertEqual(self.db.execute("SELECT mapping_version FROM scrape_batches WHERE id=?", (original,)).fetchone()[0],
                         "legacy-11/v1")
        self.assertEqual(self.db.execute("SELECT count(*) FROM selected_role_claims").fetchone()[0], 1)
        mapping_json = json.loads(self.db.execute("SELECT mapping_json FROM scrape_batches WHERE id=?", (original,)).fetchone()[0])
        self.assertEqual(mapping_json["headers"], list(HEADERS_11))
        self.assertEqual(mapping_json["county_name_policy"], "beta1")
        evidence = self.db.execute("SELECT * FROM evidence_links WHERE batch_id=?", (original,)).fetchone()
        self.assertEqual(json.loads(evidence["raw_record_json"])["headers"], list(HEADERS_11))
        self.assertEqual(json.loads(evidence["occurrences_json"])[0]["record_number"], 1)
        self.assertIsNone(evidence["source_version_key"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
        self.assertEqual(ingest_csv(self.db, legacy_payload(LEGACY_11), file_name="legacy11.csv",
                                    version_label="legacy-fixture-v1", version=LEGACY_11.version,
                                    provenance="synthetic", selected=True), original)

        complementary = ingest_csv(self.db, legacy_payload(LEGACY_16, fips="08031", county="Denver",
                                                           full_name="Synthetic Morgan Example"),
                                   file_name="legacy16.csv", version_label="legacy16-v1",
                                   version=LEGACY_16.version, provenance="synthetic",
                                   lineage_kind="complementary", selected=True)
        self.assertEqual(self.db.execute("SELECT mapping_version FROM scrape_batches WHERE id=?", (complementary,)).fetchone()[0],
                         "legacy-16/v1")
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)

    def test_legacy_parse_failure_writes_nothing(self):
        before = {table: self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                  for table in ("scrape_batches", "research_runs", "sources", "evidence_links", "role_claims")}
        payload = legacy_payload(LEGACY_11, listing_status="Unknown status")
        with self.assertRaisesRegex(ValueError, "listing status"):
            ingest_csv(self.db, payload, file_name="bad-legacy.csv", version_label="bad",
                       version=LEGACY_11.version, provenance="synthetic")
        after = {table: self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                 for table in before}
        self.assertEqual(after, before)

    def test_alternative_version_preserves_selected_original(self):
        original = self.ingest()
        alternative = self.ingest([observation(source_title="Alternative source title")],
                                  lineage_kind="alternative", parent_batch_id=original, selected=False)
        self.assertNotEqual(original, alternative)
        self.assertEqual(self.db.execute("SELECT count(*) FROM selected_role_claims").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM evidence_links").fetchone()[0], 2)
        self.assert_rejected("UPDATE scrape_batches SET selected=1 WHERE id=?", (alternative,))
        self.assert_rejected("UPDATE scrape_batches SET parent_batch_id=id WHERE id=?", (alternative,))

    def test_replay_correction_links_cannot_silently_change(self):
        original = self.ingest()
        prior = self.db.execute("SELECT id FROM role_claims").fetchone()[0]
        rows = [observation(title="Corrected"), observation(title="Corrected")]
        opts = {"lineage_kind": "corrected", "parent_batch_id": original, "supersedes": {1: prior}}
        corrected = self.ingest(rows, **opts)
        self.assertEqual(self.ingest(rows, **opts), corrected)
        with self.assertRaisesRegex(ValueError, "Replay correction"):
            self.ingest(rows, lineage_kind="corrected", parent_batch_id=original)

    def test_replay_rejects_changed_mapping_definition(self):
        self.ingest()
        fields = list(FIELDS_17)
        fields[8], fields[9] = fields[9], fields[8]
        changed = MappingSpec(LEGACY_17.version, HEADERS_17, tuple(fields))
        with self.assertRaisesRegex(ValueError, "Mapping definition"):
            self.ingest(registry={changed.version: changed})

    def test_blank_title_and_former_role_preserved_without_person_status(self):
        self.ingest([observation(title="", listing_status="Explicitly former", source_date="2024")])
        claim = self.db.execute("SELECT * FROM role_claims").fetchone()
        self.assertIsNone(claim["published_title"])
        self.assertEqual(claim["source_listing_status"], "Explicitly former")
        self.assertIsNone(claim["employment_end"])

    def test_all_fields_retained_and_unknown_telemetry_null(self):
        original = observation(nicknames="Synthetic Ro", program_location="Fixture room", private_note="private synthetic")
        self.ingest([original])
        evidence = self.db.execute("SELECT * FROM evidence_links").fetchone()
        self.assertEqual(json.loads(evidence["raw_record_json"])["cells"], original)
        self.assertEqual(json.loads(evidence["occurrences_json"])[0]["raw_text"], csv_bytes([original]).decode().split('\r\n', 1)[1])
        self.assertIsNone(evidence["source_version_key"])
        source = self.db.execute("SELECT * FROM sources").fetchone()
        for column in ("first_discovered_at", "last_checked_at", "last_successful_fetch_at", "content_sha256", "etag", "last_modified"):
            self.assertIsNone(source[column])
        claim = self.db.execute("SELECT * FROM role_claims").fetchone()
        for column in ("person_id", "unit_id", "employment_start", "employment_end", "affiliation"):
            self.assertIsNone(claim[column])
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)

    def test_only_complete_exact_rows_coalesce_and_locators_survive(self):
        self.ingest([observation(), observation(), observation(private_note="different note"), observation(title="Different role")])
        self.assertEqual(self.db.execute("SELECT count(*) FROM role_claims").fetchone()[0], 3)
        lengths = [len(json.loads(r[0])) for r in self.db.execute("SELECT occurrences_json FROM evidence_links")]
        self.assertEqual(sorted(lengths), [1, 1, 2])
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)

    def test_replay_is_idempotent_and_ids_stable(self):
        first = self.ingest()
        ids = [r[0] for r in self.db.execute("SELECT id FROM role_claims")]
        self.assertEqual(self.ingest(), first)
        self.assertEqual([r[0] for r in self.db.execute("SELECT id FROM role_claims")], ids)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0], 1)
        with self.assertRaisesRegex(ValueError, "metadata"):
            self.ingest(version_label="different")

    def test_weld_corrected_delivery_is_nonadditive_with_explicit_lineage(self):
        original = self.ingest([observation("08123")])
        prior = self.db.execute("SELECT id FROM role_claims").fetchone()[0]
        corrected = self.ingest([observation("08123", display_group="Corrected synthetic display")],
                                version_label="fixture-v2", lineage_kind="corrected", parent_batch_id=original,
                                supersedes={1: prior})
        self.assertNotEqual(corrected, original)
        self.assertEqual(self.db.execute("SELECT count(*) FROM role_claims").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM selected_role_claims").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT supersedes_id FROM selected_role_claims").fetchone()[0], prior)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sources").fetchone()[0], 1)

    def test_denver_complementary_batches_are_additive(self):
        self.ingest([observation("08031")])
        self.ingest([observation("08031", title="Second synthetic role")], lineage_kind="complementary")
        self.assertEqual(self.db.execute("SELECT count(*) FROM selected_role_claims").fetchone()[0], 2)

    def test_bad_correction_rolls_back_selection_and_all_writes(self):
        original = self.ingest()
        counts = self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "Correction"):
            self.ingest([observation(title="new")], lineage_kind="corrected", parent_batch_id=original,
                        supersedes={1: "nonexistent"})
        self.assertEqual(self.db.execute("SELECT selected FROM scrape_batches WHERE id=?", (original,)).fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0], counts)

    def test_mixed_county_and_cross_county_lineage_rejected(self):
        with self.assertRaises(ValueError):
            self.ingest([observation(), observation("08031")])
        original = self.ingest()
        with self.assertRaises(ValueError):
            self.ingest([observation("08123")], lineage_kind="corrected", parent_batch_id=original)

    def test_claim_county_must_match_raw_delivery(self):
        self.ingest()
        self.assert_rejected("UPDATE role_claims SET county_fips='08123'")

    def test_reconstructed_blocked_and_zero_yield_visits_do_not_change_roles(self):
        self.ingest()
        evidence = self.citation()
        self.db.execute(
            "INSERT INTO source_visits(id,source_id,run_id,provenance,evidence_id,outcome) VALUES ('v','source-a','run','reconstructed',?,'blocked')",
            (evidence,),
        )
        visit = self.db.execute("SELECT * FROM source_visits").fetchone()
        for column in ("attempted_at", "http_status", "duration_ms", "attempt", "actor", "result_count"):
            self.assertIsNone(visit[column])
        self.db.execute("UPDATE sources SET usefulness='coverage_only' WHERE id='source-a'")
        self.assertEqual(self.db.execute("SELECT source_listing_status FROM role_claims").fetchone()[0], "Listed")


class StructureTests(DatabaseCase):
    def test_audited_parent_change_retains_old_relationship_and_rolls_back_errors(self):
        evidence = self.citation()
        self.unit("parent")
        self.unit("child")
        set_parent(self.db, unit_id="child", parent_id="parent", relation="administrative", evidence_id=evidence, run_id="run")
        set_parent(self.db, unit_id="child", parent_id=None, relation=None, evidence_id=None, run_id="run")
        events = [json.loads(r[0]) for r in self.db.execute("SELECT detail_json FROM research_events ORDER BY rowid")]
        self.assertEqual(events[1]["before"]["parent_id"], "parent")
        self.assertIsNone(events[1]["after"]["parent_id"])
        with self.assertRaises(sqlite3.IntegrityError):
            set_parent(self.db, unit_id="child", parent_id="parent", relation="administrative", evidence_id=evidence, run_id="missing")
        self.assertIsNone(self.db.execute("SELECT parent_id FROM org_units WHERE id='child'").fetchone()[0])
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], 2)

    def test_evidence_source_must_match_registry_link_and_visit(self):
        first = self.citation("a")
        self.citation("b")
        self.unit()
        self.assert_rejected("INSERT INTO source_unit_links VALUES ('source-b','u1','coverage_lead',?)", (first,))
        self.assert_rejected("INSERT INTO source_visits(id,source_id,run_id,provenance,evidence_id) VALUES ('v','source-b','run','reconstructed',?)", (first,))

    def test_same_person_can_hold_multiple_distinct_roles(self):
        self.ingest([observation(), observation(title="Another documented role")])
        evidence = self.citation()
        self.db.execute("INSERT INTO research_people(id,county_fips,display_name,identity_state,identity_evidence_id) VALUES ('p','08107','Synthetic person','evidence_supported',?)", (evidence,))
        self.db.execute("UPDATE role_claims SET person_id='p'")
        self.assertEqual(self.db.execute("SELECT count(*) FROM role_claims WHERE person_id='p'").fetchone()[0], 2)

    def test_evidence_required_for_parent_and_cross_county_parent_rejected(self):
        evidence = self.citation()
        self.unit()
        self.assert_rejected("INSERT INTO org_units(id,county_fips,source_label,kind,parent_id) VALUES ('u2','08107','x','division','u1')")
        self.assert_rejected(
            "INSERT INTO org_units(id,county_fips,source_label,kind,parent_id,parent_relation,parent_evidence_id) VALUES ('u2','08123','x','division','u1','administrative',?)",
            (evidence,),
        )

    def test_routt_style_subunits_cycles_and_stable_renames(self):
        evidence = self.citation()
        self.unit("clerk", kind="elected_office")
        self.unit("elections", kind="division", parent_id="clerk", parent_relation="administrative", parent_evidence_id=evidence)
        self.assert_rejected("UPDATE org_units SET parent_id='elections',parent_relation='administrative',parent_evidence_id=? WHERE id='clerk'", (evidence,))
        self.db.execute("UPDATE org_units SET source_label='Renamed synthetic unit' WHERE id='elections'")
        self.assertEqual(self.db.execute("SELECT parent_id FROM org_units WHERE id='elections'").fetchone()[0], "clerk")

    def test_denver_appointed_structure_and_navigation_not_authority(self):
        evidence = self.citation()
        self.unit("nav", "08031", "navigation")
        self.unit("appointed", "08031", "appointed_office", parent_id="nav", parent_relation="navigation", parent_evidence_id=evidence)
        self.assert_rejected("UPDATE org_units SET parent_relation='statutory' WHERE id='appointed'")

    def test_four_axes_are_independent_and_reviewed_is_not_complete(self):
        evidence = self.citation()
        self.unit()
        self.db.execute("UPDATE unit_coverage SET status='reviewed',evidence_id=?,run_id='run',limitations='partial source access' WHERE unit_id='u1' AND axis='structure'", (evidence,))
        statuses = dict(self.db.execute("SELECT axis,status FROM unit_coverage"))
        self.assertEqual(statuses, {"structure": "reviewed", "leadership": "not_started", "named_staff": "not_started", "positions": "not_started"})
        self.db.commit()
        self.assert_rejected("UPDATE unit_coverage SET status='complete' WHERE axis='structure'")

    def test_role_target_unknown_is_not_vacant(self):
        evidence = self.citation()
        self.unit()
        self.db.execute("INSERT INTO role_targets(id,unit_id,county_fips,documented_title,evidence_id) VALUES ('t','u1','08107','Synthetic Director',?)", (evidence,))
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT occupancy FROM role_targets").fetchone()[0], "unknown")
        self.assert_rejected("UPDATE role_targets SET occupancy='explicitly_vacant' WHERE id='t'")

    def test_same_name_people_and_possible_match_without_merge(self):
        evidence = self.citation()
        self.db.executemany("INSERT INTO research_people(id,county_fips,display_name) VALUES (?,'08107','Synthetic Alex Example')", [("a",), ("b",)])
        self.db.execute("INSERT INTO possible_matches(id,county_fips,person_a,person_b,rationale) VALUES ('m','08107','a','b','Identical name only')")
        self.db.commit()
        self.assert_rejected("UPDATE possible_matches SET status='same_supported'")
        self.db.execute("UPDATE possible_matches SET status='same_supported',decision_basis='official_connection',resolution_evidence_id=?", (evidence,))
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_people").fetchone()[0], 2)
        self.db.commit()
        self.assert_rejected("INSERT INTO possible_matches(id,county_fips,person_a,person_b,rationale) VALUES ('reverse','08107','b','a','same pair')")

    def test_sync_tables_empty_and_update_requires_expected_version(self):
        self.ingest()
        for table in ("site_links", "sync_batches", "sync_items"):
            self.assertEqual(self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)
        self.db.execute("INSERT INTO sync_batches(id,site_key,client_batch_id,contract_version,created_at) VALUES ('s','synthetic-site','b','future-v1',?)", (NOW,))
        self.db.commit()
        claim = self.db.execute("SELECT id FROM role_claims").fetchone()[0]
        self.assert_rejected("INSERT INTO sync_items(id,batch_id,claim_id,operation,payload_json) VALUES ('i','s',?,'update','{}')", (claim,))


if __name__ == "__main__":
    unittest.main()

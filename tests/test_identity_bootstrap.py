import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from research.db import connect, migrate
from research.mapping import COUNTIES
from research.operator import add_name_variant, bootstrap_person
from research.store import ingest_csv, new_id, timestamp
from tests.research_fixtures import observation, csv_bytes


class IdentityBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO county VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08107", "08031")])
        self.db.commit()
        self.batch_id = ingest_csv(self.db, csv_bytes([observation()]), file_name="synthetic.csv",
                                   version_label="synthetic-v1", selected=True)
        self.claim = self.db.execute('SELECT "Role claim ID" AS id, "County code" AS county_fips, "Evidence record ID" AS evidence_id, "Linked profile" AS person_id, "Linked office or unit" AS unit_id, "Linked position" AS target_id, "Name as published" AS published_name, "Position as published" AS published_title, "Job description or duties" AS responsibility, "Listing status" AS source_listing_status, "Original display group" AS legacy_display_group, "Reason for grouping" AS grouping_basis, "Office or department as published" AS department_label, "Division or unit as published" AS division_label, "Program or location as published" AS program_location, "Program or location type" AS program_context_type, "Affiliation" AS affiliation, "Employment start date" AS employment_start, "Employment end date" AS employment_end, "Private review notes" AS private_note, "Earlier claim this replaces" AS supersedes_id FROM profile_research_role').fetchone()
        self.evidence_id = self.claim["evidence_id"]
        self.source_id = self.db.execute('SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?',
                                         (self.evidence_id,)).fetchone()[0]
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (self.source_id,))
        self.db.commit()
        self.baseline_runs = self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0]
        self.baseline_events = self.db.execute("SELECT count(*) FROM research_history").fetchone()[0]

    def tearDown(self):
        self.db.close()

    def bootstrap(self, **changes):
        values = {"county_fips": "08107", "claim_id": self.claim["id"],
                  "published_name": self.claim["published_name"], "evidence_id": self.evidence_id,
                  "actor": "synthetic-operator", "rationale": "Official fixture record links the exact name to the position"}
        values.update(changes)
        return bootstrap_person(self.db, **values)

    def quote_evidence(self, quote, *, source_id=None, observed_url=None):
        source_id = source_id or self.source_id
        source_url = observed_url or self.db.execute('SELECT "Original source URL" AS original_url FROM research_sources WHERE "Source ID"=?',
                                                     (source_id,)).fetchone()[0]
        run_id, evidence_id, now = new_id("run"), new_id("evidence"), timestamp()
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                        (run_id, "screening", "synthetic", now))
        self.db.execute('INSERT INTO research_evidence("Evidence record ID","Source ID","Source URL as observed","Evidence location","Evidence excerpt","Research run ID","Recorded on") '
                        "VALUES (?,?,?,?,?,?,?)",
                        (evidence_id, source_id, source_url, "synthetic quotation", quote, run_id, now))
        self.db.commit()
        return evidence_id

    def test_bootstrap_creates_supported_person_variant_claim_and_attributed_events(self):
        raw_before = self.db.execute('SELECT "Original record" AS raw_record_json FROM research_evidence WHERE "Evidence record ID"=?',
                                     (self.evidence_id,)).fetchone()[0]
        lineage_before = tuple(self.db.execute("SELECT id,family_id,selected,file_sha256 FROM research_scrapes WHERE id=?",
                                               (self.batch_id,)).fetchone())
        result = self.bootstrap()
        person = self.db.execute('SELECT "County code" AS county_fips,"Full name" AS display_name,"Identity review status" AS identity_state,"Evidence for identity" AS identity_evidence_id '
                                 'FROM profile_research WHERE "Profile ID"=?', (result["person_id"],)).fetchone()
        self.assertEqual(tuple(person), ("08107", "Synthetic Rowan Example", "evidence_supported", self.evidence_id))
        variant = self.db.execute('SELECT "Name as published" AS published_name,"Name type" AS kind,"Evidence for this name" AS evidence_id FROM profile_research_name WHERE "Name record ID"=?',
                                  (result["variant_id"],)).fetchone()
        self.assertEqual(tuple(variant), ("Synthetic Rowan Example", "published", self.evidence_id))
        self.assertEqual(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?',
                                         (self.claim["id"],)).fetchone()[0], result["person_id"])
        self.assertEqual(self.db.execute('SELECT "Original record" AS raw_record_json FROM research_evidence WHERE "Evidence record ID"=?',
                                         (self.evidence_id,)).fetchone()[0], raw_before)
        self.assertEqual(tuple(self.db.execute("SELECT id,family_id,selected,file_sha256 FROM research_scrapes WHERE id=?",
                                               (self.batch_id,)).fetchone()), lineage_before)
        run = self.db.execute("SELECT actor,kind FROM research_runs WHERE id=?", (result["run_id"],)).fetchone()
        self.assertEqual(tuple(run), ("synthetic-operator", "screening"))
        events = self.db.execute("SELECT kind,entity_id,detail_json FROM research_history WHERE run_id=? ORDER BY rowid",
                                 (result["run_id"],)).fetchall()
        self.assertEqual([row["kind"] for row in events],
                         ["research_person_created", "name_variant_registered", "claim_person_associated"])
        self.assertEqual([row["entity_id"] for row in events],
                         [result["person_id"], result["variant_id"], self.claim["id"]])
        for event in events:
            detail = json.loads(event["detail_json"])
            self.assertEqual(detail["operator"], "synthetic-operator")
            self.assertIn("rationale", detail)
            self.assertEqual(detail["supporting_evidence_id"], self.evidence_id)

    def test_nonofficial_or_mismatched_evidence_rolls_back_everything(self):
        unsupported = self.quote_evidence("Synthetic Rowan Example, Fixture Coordinator")
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='unknown',\"Publisher type\"='unresolved' WHERE \"Source ID\"=?", (self.source_id,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "official"):
            self.bootstrap()
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (self.source_id,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "exact observation"):
            self.bootstrap(evidence_id=unsupported)
        with self.assertRaisesRegex(ValueError, "Published name must exactly"):
            self.bootstrap(published_name="Synthetic Rowan example")
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()[0], 0)
        self.assertIsNone(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?',
                                          (self.claim["id"],)).fetchone()[0])
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0], self.baseline_runs + 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_history").fetchone()[0], self.baseline_events)

    def test_wrong_explicit_county_is_rejected_without_person_creation(self):
        with self.assertRaisesRegex(ValueError, "explicit county"):
            self.bootstrap(county_fips="08031")
        with self.assertRaisesRegex(ValueError, "Unknown county"):
            self.bootstrap(county_fips="08999")
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 0)

    def test_identical_supported_names_remain_separate_and_are_not_auto_matched(self):
        self.db.execute("INSERT INTO profile_research(\"Profile ID\",\"County code\",\"Full name\") VALUES ('preexisting','08107','Synthetic Rowan Example')")
        self.db.commit()
        first = self.bootstrap()
        second_claim = observation(department="Fixture Services North")
        second_batch = ingest_csv(self.db, csv_bytes([second_claim]), file_name="synthetic-2.csv",
                                  version_label="synthetic-v2", selected=False)
        claim2 = self.db.execute('SELECT "Role claim ID" AS id,"Evidence record ID" AS evidence_id,"Name as published" AS published_name FROM profile_research_role WHERE "Role claim ID"<>? ORDER BY id',
                                 (self.claim["id"],)).fetchone()
        second = self.bootstrap(claim_id=claim2["id"], evidence_id=claim2["evidence_id"])
        self.assertNotEqual(first["person_id"], second["person_id"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research WHERE \"Full name\"='Synthetic Rowan Example'").fetchone()[0], 3)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research_duplicates").fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?', (claim2["id"],)).fetchone()[0], second["person_id"])
        self.assertEqual(self.db.execute("SELECT id FROM research_scrapes WHERE id=?", (second_batch,)).fetchone()[0], second_batch)

    def test_event_failure_rolls_back_run_person_variant_and_association(self):
        self.db.execute("CREATE TRIGGER reject_variant_audit BEFORE INSERT ON research_history "
                        "WHEN NEW.kind='name_variant_registered' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.bootstrap()
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()[0], 0)
        self.assertIsNone(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?',
                                          (self.claim["id"],)).fetchone()[0])
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0], self.baseline_runs)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_history").fetchone()[0], self.baseline_events)

    def test_already_assigned_claim_cannot_be_bootstrapped_again(self):
        self.bootstrap()
        counts = (self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0],
                  self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()[0],
                  self.db.execute("SELECT count(*) FROM research_history").fetchone()[0])
        with self.assertRaisesRegex(ValueError, "already assigned"):
            self.bootstrap()
        self.assertEqual((self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0],
                          self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()[0],
                          self.db.execute("SELECT count(*) FROM research_history").fetchone()[0]), counts)

    def test_additional_variant_requires_explicit_official_name_connection(self):
        person = self.bootstrap()["person_id"]
        evidence_id = self.quote_evidence("Synthetic Rowan Example, also known as Rowan R. Example.")
        result = add_name_variant(self.db, person_id=person, published_name="Rowan R. Example", kind="alternative",
                                  evidence_id=evidence_id, actor="synthetic-operator",
                                  rationale="Official fixture explicitly connects both forms")
        self.assertTrue(result["created"])
        row = self.db.execute('SELECT "Name as published" AS published_name,"Name type" AS kind,"Evidence for this name" AS evidence_id FROM profile_research_name WHERE "Name record ID"=?',
                              (result["variant_id"],)).fetchone()
        self.assertEqual(tuple(row), ("Rowan R. Example", "alternative", evidence_id))
        event = self.db.execute("SELECT detail_json FROM research_history WHERE entity_id=?", (result["variant_id"],)).fetchone()
        self.assertEqual(json.loads(event[0])["operator"], "synthetic-operator")

    def test_similar_name_without_explicit_link_is_rejected(self):
        person = self.bootstrap()["person_id"]
        unsupported_quotes = (
            "Synthetic Rowan Example and Rowan Example share Fixture Services.",
            "Synthetic Rowan Example is not also known as Rowan R. Example.",
        )
        for index, quote in enumerate(unsupported_quotes):
            evidence_id = self.quote_evidence(quote)
            with self.assertRaisesRegex(ValueError, "explicitly connect"):
                add_name_variant(self.db, person_id=person, published_name=("Rowan Example" if index == 0 else "Rowan R. Example"),
                                 kind="nickname", evidence_id=evidence_id, actor="synthetic-operator",
                                 rationale="The cited record does not establish a name relationship")
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_research_name WHERE "Profile ID"=?', (person,)).fetchone()[0], 1)

    def test_duplicate_variant_submission_returns_existing_row_without_new_event(self):
        person = self.bootstrap()["person_id"]
        evidence_id = self.quote_evidence("Synthetic Rowan Example, also known as Rowan R. Example.")
        args = dict(person_id=person, published_name="Rowan R. Example", kind="nickname", evidence_id=evidence_id,
                    actor="synthetic-operator", rationale="Explicitly linked in the synthetic official record")
        first = add_name_variant(self.db, **args)
        counts = (self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()[0],
                  self.db.execute("SELECT count(*) FROM research_history").fetchone()[0],
                  self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0])
        second = add_name_variant(self.db, **args)
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["variant_id"], second["variant_id"])
        self.assertEqual((self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()[0],
                          self.db.execute("SELECT count(*) FROM research_history").fetchone()[0],
                          self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0]), counts)

    def test_nonofficial_or_cross_county_variant_evidence_is_rejected(self):
        person = self.bootstrap()["person_id"]
        evidence_id = self.quote_evidence("Synthetic Rowan Example, also known as Rowan R. Example.")
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='other',\"Publisher type\"='unresolved' WHERE \"Source ID\"=?", (self.source_id,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "official"):
            add_name_variant(self.db, person_id=person, published_name="Rowan R. Example", kind="alternative",
                             evidence_id=evidence_id, actor="operator", rationale="test")
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (self.source_id,))
        self.db.commit()
        second = ingest_csv(self.db, csv_bytes([observation(fips="08031", full_name="Synthetic Rowan Example")]),
                            file_name="other-county.csv", version_label="synthetic-other-county")
        other_evidence = self.db.execute('SELECT "Evidence record ID" AS evidence_id FROM profile_research_role WHERE "Role claim ID"<>?', (self.claim["id"],)).fetchone()[0]
        other_source = self.db.execute('SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?', (other_evidence,)).fetchone()[0]
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (other_source,))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "different county"):
            add_name_variant(self.db, person_id=person, published_name="Rowan R. Example", kind="alternative",
                             evidence_id=other_evidence, actor="operator", rationale="cross-county evidence")
        self.assertTrue(second)
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_research_name WHERE "Profile ID"=?', (person,)).fetchone()[0], 1)

    def test_cli_bootstrap_and_variant_commands_work_on_reopened_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "synthetic.sqlite")
            disk = connect(path)
            migrate(disk)
            disk.executemany("INSERT INTO county VALUES (?,?)",
                             [(fips, COUNTIES[fips]) for fips in ("08107", "08031")])
            disk.commit()
            batch_id = ingest_csv(disk, csv_bytes([observation()]), file_name="synthetic.csv",
                                  version_label="synthetic-v1")
            claim_id, evidence_id, source_id = disk.execute(
                'SELECT c."Role claim ID" AS id,c."Evidence record ID" AS evidence_id,e."Source ID" AS source_id FROM profile_research_role c '
                'JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" WHERE e."Import batch ID"=?', (batch_id,)).fetchone()
            disk.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (source_id,))
            disk.commit()
            disk.close()
            command = [sys.executable, "-B", "-m", "research"]
            boot = subprocess.run(command + ["bootstrap-person", str(path), "--county-fips", "08107",
                                             "--claim-id", claim_id, "--published-name", "Synthetic Rowan Example",
                                             "--evidence-id", evidence_id, "--actor", "synthetic-operator",
                                             "--rationale", "Synthetic official listing"],
                                  capture_output=True, text=True)
            self.assertEqual(boot.returncode, 0, boot.stderr)
            person_id = json.loads(boot.stdout)["person_id"]
            reopened = connect(path)
            quote_id = self.quote_evidence_for_disk(reopened, source_id,
                                                    "Synthetic Rowan Example, also known as Rowan R. Example.")
            reopened.close()
            variant = subprocess.run(command + ["add-name-variant", str(path), "--person-id", person_id,
                                                "--published-name", "Rowan R. Example", "--kind", "alternative",
                                                "--evidence-id", quote_id, "--actor", "synthetic-operator",
                                                "--rationale", "Explicit synthetic official cross-reference"],
                                     capture_output=True, text=True)
            self.assertEqual(variant.returncode, 0, variant.stderr)
            self.assertTrue(json.loads(variant.stdout)["created"])
            reopened = connect(path)
            self.assertEqual(reopened.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?', (claim_id,)).fetchone()[0], person_id)
            self.assertEqual(reopened.execute('SELECT count(*) FROM profile_research_name WHERE "Profile ID"=?', (person_id,)).fetchone()[0], 2)
            reopened.close()

    @staticmethod
    def quote_evidence_for_disk(db, source_id, quote):
        source_url = db.execute('SELECT "Original source URL" AS original_url FROM research_sources WHERE "Source ID"=?', (source_id,)).fetchone()[0]
        run_id, evidence_id, now = new_id("run"), new_id("evidence"), timestamp()
        db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                   (run_id, "screening", "synthetic", now))
        db.execute('INSERT INTO research_evidence("Evidence record ID","Source ID","Source URL as observed","Evidence location","Evidence excerpt","Research run ID","Recorded on") '
                   "VALUES (?,?,?,?,?,?,?)", (evidence_id, source_id, source_url, "synthetic quote", quote, run_id, now))
        db.commit()
        return evidence_id


if __name__ == "__main__":
    unittest.main()

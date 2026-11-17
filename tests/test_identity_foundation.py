"""Synthetic tests for the county-scoped evidence-based identity foundation."""

import json
import tempfile
import unittest

from research import identity, operator
from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv, new_id, timestamp
from tests.research_fixtures import csv_bytes, observation


class IdentityFoundationTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO county VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08107", "08031")])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_batch(self, rows, *, url="https://fixture.example.gov/directory", name="synthetic.csv",
                  kind="original", parent=None, selected=False, supersedes=None, fips="08107"):
        payload = csv_bytes([observation(fips=fips, source_url=url, **row) for row in rows])
        batch = ingest_csv(self.db, payload, file_name=name, version_label=name, selected=selected,
                           lineage_kind=kind, parent_batch_id=parent, supersedes=supersedes,
                           return_result=False)
        claims = [dict(row) for row in self.db.execute(
            'SELECT c."Role claim ID" AS id,c."Evidence record ID" AS evidence_id,c."Name as published" AS published_name,c."Position as published" AS published_title,e."Source ID" AS source_id '
            'FROM profile_research_role c JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" '
            'WHERE e."Import batch ID"=? ORDER BY e."Evidence location"', (batch,))]
        return batch, claims

    def quote_evidence(self, source_id, quote, *, county="08107"):
        source_url = self.db.execute('SELECT "Original source URL" AS original_url FROM research_sources WHERE "Source ID"=?', (source_id,)).fetchone()[0]
        run_id, evidence_id, now = new_id("run"), new_id("evidence"), timestamp()
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                        (run_id, "screening", "synthetic", now))
        self.db.execute('INSERT INTO research_evidence("Evidence record ID","Source ID","Source URL as observed","Evidence location","Evidence excerpt","Research run ID","Recorded on") '
                        "VALUES (?,?,?,?,?,?,?)", (evidence_id, source_id, source_url,
                                                    "synthetic official connection", quote, run_id, now))
        self.db.commit()
        return evidence_id

    def test_supported_person_creation_source_classification_and_exact_preservation(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example", "nicknames": "Rowan, Ro"}])
        before_raw = self.db.execute('SELECT "Original record" AS raw_record_json FROM research_evidence WHERE "Evidence record ID"=?',
                                     (claim["evidence_id"],)).fetchone()[0]
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["counties_processed"], 1)
        self.assertEqual(plan["summary"]["new_research_people"], 1)
        self.assertEqual(plan["summary"]["claims_associated"], 1)
        self.assertEqual(plan["summary"]["source_classifications_to_official"], 1)
        self.assertEqual([item["published_name"] for item in plan["counties"][0]["name_variants"]],
                         ["Ro", "Rowan", "Synthetic Rowan Example"])
        result = identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(result["status"], "applied")
        person = self.db.execute('SELECT "County code" AS county_fips,"Full name" AS display_name,"Identity review status" AS identity_state,"Evidence for identity" AS identity_evidence_id '
                                 "FROM profile_research").fetchone()
        self.assertEqual(tuple(person), ("08107", "Synthetic Rowan Example", "evidence_supported", claim["evidence_id"]))
        self.assertEqual(self.db.execute('SELECT "Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?',
                                         (claim["source_id"],)).fetchone()[0], "official")
        self.assertEqual(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?',
                                         (claim["id"],)).fetchone()[0], self.db.execute(
                                             'SELECT "Profile ID" AS id FROM profile_research').fetchone()[0])
        self.assertEqual(self.db.execute('SELECT "Original record" AS raw_record_json FROM research_evidence WHERE "Evidence record ID"=?',
                                         (claim["evidence_id"],)).fetchone()[0], before_raw)
        self.assertEqual(identity.verify_identity_application(self.db, plan)["integrity"], "ok")

    def test_name_variant_operation_accepts_only_literal_nicknames_field_links(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example", "nicknames": "Rowan"}])
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (claim["source_id"],))
        self.db.commit()
        created = operator.bootstrap_person(self.db, county_fips="08107", claim_id=claim["id"],
                                            published_name=claim["published_name"], evidence_id=claim["evidence_id"],
                                            actor="fixture-operator", rationale="Synthetic official listing")
        result = operator.add_name_variant(self.db, person_id=created["person_id"], published_name="Rowan",
                                           kind="nickname", evidence_id=claim["evidence_id"], actor="fixture-operator",
                                           rationale="The official fixture row has an explicit Nicknames field")
        self.assertTrue(result["created"])
        self.assertEqual(tuple(self.db.execute('SELECT "Name as published" AS published_name,"Name type" AS kind FROM profile_research_name WHERE "Name record ID"=?',
                                               (result["variant_id"],)).fetchone()), ("Rowan", "nickname"))
        with self.assertRaisesRegex(ValueError, "explicitly connect"):
            operator.add_name_variant(self.db, person_id=created["person_id"], published_name="Rowen",
                                      kind="nickname", evidence_id=claim["evidence_id"], actor="fixture-operator",
                                      rationale="This spelling is not present in the field")

    def test_two_documented_roles_share_a_person_only_with_direct_official_connection(self):
        _, claims = self.add_batch([
            {"full_name": "Synthetic Rowan Example", "title": "Fixture Treasurer"},
            {"full_name": "Synthetic Rowan Example", "title": "Fixture Coordinator"},
        ])
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (claims[0]["source_id"],))
        self.db.commit()
        created = operator.bootstrap_person(self.db, county_fips="08107", claim_id=claims[0]["id"],
                                            published_name=claims[0]["published_name"], evidence_id=claims[0]["evidence_id"],
                                            actor="fixture-operator", rationale="Synthetic official role listing")
        link = self.quote_evidence(claims[0]["source_id"],
                                   "Synthetic Rowan Example, Fixture Treasurer, also serves as fixture coordinator.")
        associated = operator.associate_claim_by_connection(
            self.db, claim_id=claims[1]["id"], person_id=created["person_id"], evidence_id=link,
            actor="fixture-operator", rationale="One official record explicitly connects the person to the second role")
        self.assertEqual(associated["person_id"], created["person_id"])
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_research_role WHERE "Linked profile"=?',
                                         (created["person_id"],)).fetchone()[0], 2)

    def test_statewide_planner_uses_direct_official_role_connection(self):
        _, claims = self.add_batch([
            {"full_name": "Synthetic Rowan Example", "title": "Fixture Treasurer"},
            {"full_name": "Synthetic Rowan Example", "title": "Fixture Coordinator"},
        ])
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (claims[0]["source_id"],))
        self.db.commit()
        self.quote_evidence(claims[0]["source_id"],
                            "Synthetic Rowan Example, Fixture Treasurer, also serves as fixture coordinator.")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["new_research_people"], 1)
        self.assertEqual(plan["summary"]["claims_associated"], 2)
        self.assertEqual({item["method"] for item in plan["counties"][0]["associations"]},
                         {"bootstrap", "official_connection"})
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute('SELECT count(DISTINCT "Linked profile") FROM profile_research_role WHERE "Linked profile" IS NOT NULL').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_research_role WHERE "Linked profile" IS NOT NULL').fetchone()[0], 2)

    def test_generic_responsibility_never_counts_as_a_duty_for_alignment(self):
        _, claims = self.add_batch([
            {"full_name": "Synthetic Rowan Example", "title": "Fixture Treasurer",
             "responsibility": "Listed in official source"},
            {"full_name": "Synthetic Rowan Example", "title": "Fixture Coordinator",
             "responsibility": "Listed in official source"},
        ])
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (claims[0]["source_id"],))
        self.db.commit()
        self.quote_evidence(claims[0]["source_id"],
                            "Synthetic Rowan Example, Fixture Treasurer, also listed as Listed in official source.")
        plan = identity.build_identity_plan(self.db)
        # The two titles differ and the placeholder responsibility is not a duty.
        # The shared office label is the only aligned detail, so it is what merges them.
        self.assertEqual(plan["summary"]["new_research_people"], 1)
        self.assertEqual(plan["summary"]["claims_associated"], 2)
        aligned = [item for item in plan["counties"][0]["associations"]
                   if item["method"] == "same_name_detail_alignment"]
        self.assertEqual([item["aligned_details"] for item in aligned], [["office"]])
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 1)

    def test_same_name_without_an_aligned_detail_stays_distinct(self):
        _, claims = self.add_batch([
            {"full_name": "Synthetic Rowan Example", "department": "Fixture Services North",
             "title": "Fixture Planner", "responsibility": "Plans the north district"},
            {"full_name": "Synthetic Rowan Example", "department": "Fixture Services South",
             "title": "Fixture Inspector", "responsibility": "Inspects the south district"},
        ])
        plan = identity.build_identity_plan(self.db)
        county = plan["counties"][0]
        self.assertEqual(len(county["new_people"]), 2)
        self.assertEqual({item["method"] for item in county["associations"]}, {"bootstrap"})
        self.assertEqual(county["unresolved"], [])
        self.assertEqual(county["same_name_profile_groups_left_distinct"], 1)
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research_duplicates").fetchone()[0], 0)
        self.assertEqual(identity.verify_identity_application(self.db, plan)["integrity"], "ok")
        # A rerun after application is deterministic and changes nothing.
        again = identity.build_identity_plan(self.db)
        self.assertEqual(again["summary"]["new_research_people"], 0)
        self.assertEqual(again["summary"]["claims_associated"], 0)

    def test_each_merge_criterion_merges_same_name_claims(self):
        base = {"full_name": "Synthetic Rowan Example"}
        cases = {
            "office": ({"department": "Fixture Office Alpha", "title": "Fixture Planner A", "responsibility": "Duty one"},
                       {"department": "Fixture Office Alpha", "title": "Fixture Planner B", "responsibility": "Duty two"}),
            "position": ({"department": "Fixture Office Beta", "title": "Fixture Planner", "responsibility": "Duty three"},
                         {"department": "Fixture Office Gamma", "title": "Fixture Planner", "responsibility": "Duty four"}),
            "duties": ({"department": "Fixture Office Delta", "title": "Fixture Planner C", "responsibility": "Reviews permits"},
                       {"department": "Fixture Office Epsilon", "title": "Fixture Planner D", "responsibility": "Reviews permits"}),
        }
        for kind, (first, second) in cases.items():
            with self.subTest(kind=kind):
                self.tearDown()
                self.setUp()
                self.add_batch([{**base, **first}, {**base, **second}])
                plan = identity.build_identity_plan(self.db)
                county = plan["counties"][0]
                self.assertEqual(len(county["new_people"]), 1)
                aligned = [item for item in county["associations"] if item["method"] == "same_name_detail_alignment"]
                self.assertEqual([item["aligned_details"] for item in aligned], [[kind]])

    def test_same_name_in_different_counties_never_merges(self):
        base = {"full_name": "Synthetic Rowan Example", "department": "Fixture Office", "title": "Fixture Planner",
                "responsibility": "Reviews permits"}
        self.add_batch([base], fips="08107")
        self.add_batch([base], fips="08031", url="https://fixture.example.gov/other")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["new_research_people"], 2)
        self.assertEqual({county["county_fips"] for county in plan["counties"]}, {"08107", "08031"})
        self.assertEqual({item["method"] for county in plan["counties"] for item in county["associations"]}, {"bootstrap"})

    def test_historical_succession_creates_separate_people_and_never_matches_by_title(self):
        _, claims = self.add_batch([
            {"full_name": "Synthetic Rowan Example", "title": "County Treasurer", "listing_status": "Explicitly former"},
            {"full_name": "Synthetic Arden Example", "title": "County Treasurer", "listing_status": "Listed in official source"},
        ])
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["new_research_people"], 2)
        self.assertEqual(plan["summary"]["claims_associated"], 2)
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        people = list(self.db.execute('SELECT "Full name" AS display_name FROM profile_research ORDER BY display_name'))
        self.assertEqual([row[0] for row in people], ["Synthetic Arden Example", "Synthetic Rowan Example"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research_duplicates").fetchone()[0], 0)

    def test_non_gov_hostname_and_csv_label_do_not_promote_source_authority(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example"}], url="https://fixture.invalid/directory")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["source_classifications"], [])
        self.assertEqual(plan["summary"]["new_research_people"], 0)
        self.assertEqual(plan["counties"][0]["unresolved"][0]["reason"], "source_authority_not_established")
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute('SELECT "Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?',
                                         (claim["source_id"],)).fetchone()[0], "unknown")

    def test_non_gov_source_requires_retained_exact_official_publication_evidence(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example"}],
                                    url="https://sampleville.org/departments")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["source_classifications"], [])
        self.assertEqual(plan["summary"]["new_research_people"], 0)
        self.quote_evidence(claim["source_id"],
                            "For source details, see the official website of the City of Sampleville.")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["source_classifications"], [])
        evidence_id = self.quote_evidence(
            claim["source_id"], "Official website of the City of Sampleville.")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(len(plan["source_classifications"]), 1)
        proposal = plan["source_classifications"][0]
        self.assertEqual(proposal["source_id"], claim["source_id"])
        self.assertEqual(proposal["evidence_id"], evidence_id)
        self.assertIn("City of Sampleville", proposal["basis"])
        self.assertEqual(proposal["authority_evidence_type"], "retained_exact_page_official_statement")
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute('SELECT "Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?',
                                         (claim["source_id"],)).fetchone()[0], "official")
        event = self.db.execute(
            "SELECT detail_json FROM research_history WHERE kind='source_classified' AND entity_id=?",
            (claim["source_id"],)).fetchone()
        self.assertIsNotNone(event)
        detail = json.loads(event[0])
        self.assertEqual(detail["authority_evidence_type"], "retained_exact_page_official_statement")
        self.assertIn("source_host", detail)
        self.assertNotIn("verified_host", detail)
        self.assertFalse(detail["source_visit_recorded"])

    def test_no_decision_identity_plan_writes_no_triage_events_or_runs(self):
        self.add_batch([{"full_name": "Synthetic Rowan Example"},
                        {"full_name": "Synthetic Rowan Example", "department": "Second Department"}],
                       url="https://directory.example.org/officials")
        plan = identity.build_identity_plan(self.db)
        before = (self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0],
                  self.db.execute("SELECT count(*) FROM research_history").fetchone()[0])
        result = identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        after = (self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0],
                 self.db.execute("SELECT count(*) FROM research_history").fetchone()[0])
        self.assertEqual(result["status"], "no_changes")
        self.assertEqual(after, before)
        self.assertEqual(identity.verify_identity_application(self.db, plan)["status"], "no_changes_verified")

    def test_legacy_identity_plan_keeps_its_original_triage_event_contract(self):
        self.add_batch([{"full_name": "Synthetic Rowan Example"},
                        {"full_name": "Synthetic Rowan Example", "department": "Second Department"}],
                       url="https://directory.example.org/officials")
        plan = identity.build_identity_plan(self.db)
        plan.pop("event_policy")
        plan["plan_sha256"] = identity._digest({key: value for key, value in plan.items()
                                                if key != "plan_sha256"})
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM research_history WHERE kind='identity_unresolved_recorded'").fetchone()[0], 2)
        self.assertEqual(identity.verify_identity_application(self.db, plan)["status"], "verified")

    def test_selected_correction_lineage_associates_one_observation_without_duplicate_person(self):
        original, [parent_claim] = self.add_batch([{"full_name": "Synthetic Rowan Example",
                                                    "title": "Fixture Treasurer"}], name="original.csv")
        _, [child_claim] = self.add_batch([{"full_name": "Synthetic Rowan Example",
                                            "title": "Fixture Coordinator"}], name="corrected.csv",
                                          kind="corrected", parent=original, selected=True,
                                          supersedes={1: parent_claim["id"]})
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["new_research_people"], 1)
        self.assertEqual(plan["summary"]["claims_associated"], 2)
        self.assertEqual({item["method"] for item in plan["counties"][0]["associations"]},
                         {"bootstrap", "correction_lineage"})
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_research_role WHERE "Linked profile" IS NOT NULL').fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?',
                                         (parent_claim["id"],)).fetchone()[0], self.db.execute(
                                             'SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?',
                                             (child_claim["id"],)).fetchone()[0])

    def test_alternative_batch_is_not_a_new_person_or_independent_support(self):
        original, [parent_claim] = self.add_batch([{"full_name": "Synthetic Rowan Example"}], name="original.csv")
        _, [alternate] = self.add_batch([{"full_name": "Synthetic Rowan Example", "title": "Alternate Role"}],
                                        name="alternative.csv", kind="alternative", parent=original,
                                        selected=False, supersedes={1: parent_claim["id"]})
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["new_research_people"], 1)
        self.assertEqual(plan["summary"]["claims_associated"], 1)
        self.assertIn(alternate["id"], {item["claim_id"] for item in plan["counties"][0]["unresolved"]})
        self.assertEqual(next(item for item in plan["counties"][0]["unresolved"]
                              if item["claim_id"] == alternate["id"])["reason"],
                         "alternative_batch_is_not_independent_identity_evidence")

    def test_cross_county_connection_association_is_rejected(self):
        _, [home] = self.add_batch([{"full_name": "Synthetic Rowan Example"}])
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official' WHERE \"Source ID\"=?", (home["source_id"],))
        self.db.commit()
        created = operator.bootstrap_person(self.db, county_fips="08107", claim_id=home["id"],
                                            published_name=home["published_name"], evidence_id=home["evidence_id"],
                                            actor="fixture-operator", rationale="Synthetic official listing")
        _, [other] = self.add_batch([{"full_name": "Synthetic Rowan Example"}],
                                    url="https://other.example.gov/directory", name="other-county.csv",
                                    fips="08031")
        other_county = other["id"]
        evidence = self.quote_evidence(home["source_id"],
                                       "Synthetic Rowan Example also serves as Fixture Coordinator.")
        with self.assertRaisesRegex(ValueError, "same county"):
            operator.associate_claim_by_connection(self.db, claim_id=other_county, person_id=created["person_id"],
                                                   evidence_id=evidence, actor="fixture-operator",
                                                   rationale="Cross-county fixture rejection")

    def test_stale_plan_rejected_before_source_or_identity_writes(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example"}])
        plan = identity.build_identity_plan(self.db)
        self.db.execute("UPDATE profile_research_role SET \"Position as published\"='Changed after preview' WHERE \"Role claim ID\"=?", (claim["id"],))
        self.db.commit()
        baseline_events = self.db.execute("SELECT count(*) FROM research_history").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "changed after the identity preview"):
            identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute('SELECT "Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?',
                                         (claim["source_id"],)).fetchone()[0], "unknown")
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_history").fetchone()[0], baseline_events)

    def test_county_transaction_rolls_back_and_same_plan_can_resume(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example"}])
        plan = identity.build_identity_plan(self.db)
        self.db.execute("CREATE TRIGGER reject_identity_association BEFORE INSERT ON research_history "
                        "WHEN NEW.kind='claim_person_associated' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
        self.db.commit()
        with self.assertRaises(Exception):
            identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 0)
        self.assertIsNone(self.db.execute('SELECT "Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?', (claim["id"],)).fetchone()[0])
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM research_runs WHERE note LIKE '%:sources'").fetchone())
        self.db.execute("DROP TRIGGER reject_identity_association")
        self.db.commit()
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 1)

    def test_replay_is_idempotent_and_organizational_links_are_preserved(self):
        _, [claim] = self.add_batch([{"full_name": "Synthetic Rowan Example"}])
        evidence_id = claim["evidence_id"]
        self.db.execute("INSERT INTO county_research_unit_structure(\"Office or unit ID\",\"County code\",\"Office or unit label as published\",\"Organization type\") VALUES ('unit_fixture','08107','Fixture Services','department')")
        self.db.execute('INSERT INTO county_research_positions("Position ID","Office or unit ID","County code","Documented position title","Evidence for position") '
                        "VALUES ('target_fixture','unit_fixture','08107','Fixture Coordinator',?)", (evidence_id,))
        self.db.execute("UPDATE profile_research_role SET \"Linked office or unit\"='unit_fixture',\"Linked position\"='target_fixture' WHERE \"Role claim ID\"=?",
                        (claim["id"],))
        self.db.commit()
        plan = identity.build_identity_plan(self.db)
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        before = tuple(self.db.execute("SELECT count(*) FROM profile_research").fetchone()) + tuple(
            self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()) + tuple(
            self.db.execute("SELECT count(*) FROM research_history").fetchone())
        result = identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        after = tuple(self.db.execute("SELECT count(*) FROM profile_research").fetchone()) + tuple(
            self.db.execute("SELECT count(*) FROM profile_research_name").fetchone()) + tuple(
            self.db.execute("SELECT count(*) FROM research_history").fetchone())
        self.assertEqual(result["status"], "already_applied")
        self.assertEqual(before, after)
        self.assertEqual(tuple(self.db.execute('SELECT "Linked office or unit" AS unit_id,"Linked position" AS target_id FROM profile_research_role WHERE "Role claim ID"=?',
                                               (claim["id"],)).fetchone()), ("unit_fixture", "target_fixture"))
        self.assertEqual(identity.verify_identity_application(self.db, plan)["foreign_key_violations"], 0)

    def test_realistic_two_thousand_claim_preview_and_application(self):
        def alpha(index):
            chars = ""
            value = index
            while True:
                chars = chr(ord("A") + value % 26) + chars
                value = value // 26 - 1
                if value < 0:
                    return chars

        rows = [{"full_name": f"Synthetic {alpha(index)} Example"} for index in range(2000)]
        self.add_batch(rows, name="synthetic-volume.csv")
        plan = identity.build_identity_plan(self.db)
        self.assertEqual(plan["summary"]["role_claims_evaluated"], 2000)
        self.assertEqual(plan["summary"]["new_research_people"], 2000)
        result = identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(result["claims_associated"], 2000)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_research").fetchone()[0], 2000)


if __name__ == "__main__":
    unittest.main()

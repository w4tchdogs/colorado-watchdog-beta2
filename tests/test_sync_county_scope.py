"""County-first R7 scoping tests use only invented synthetic records."""

import unittest

from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv
from research.sync import build_changeset
from tests.research_fixtures import csv_bytes, observation


SITE = "synthetic-county-scope-site"


class CountyScopedR7Tests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO counties VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08001", "08003")])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_claim(self, county, tag, *, selected=True, assigned=True, unit_parent=None, role_claim_count=1):
        payload = csv_bytes([observation(county, full_name=f"Synthetic Person {tag} {index}",
                                         source_url=f"https://example.invalid/{county}/{tag}")
                             for index in range(role_claim_count)])
        batch = ingest_csv(self.db, payload, file_name=f"{tag}.csv", version_label=tag,
                           provenance="synthetic", selected=selected)
        claims = list(self.db.execute("SELECT id,evidence_id FROM role_claims WHERE evidence_id IN "
                                      "(SELECT id FROM evidence_links WHERE batch_id=?) ORDER BY id", (batch,)))
        claim_id, evidence_id = claims[0]["id"], claims[0]["evidence_id"]
        source_id = self.db.execute("SELECT source_id FROM evidence_links WHERE id=?", (evidence_id,)).fetchone()[0]
        self.db.execute("UPDATE sources SET official_status='official',publisher_classification='official',"
                        "page_type='official_page' WHERE id=?", (source_id,))
        self.db.execute("UPDATE evidence_links SET observed_title=?,observed_url=? WHERE id=?",
                        (f"Synthetic source {tag}", f"https://example.invalid/{county}/{tag}", evidence_id))
        parent_id = f"unit-parent-{tag}" if unit_parent else None
        if parent_id:
            self.db.execute("INSERT INTO org_units(id,county_fips,source_label,kind) VALUES(?,?,?,'department')",
                            (parent_id, county, f"Synthetic Parent {tag}"))
            self.db.execute("INSERT INTO org_names(id,unit_id,name,kind,evidence_id) VALUES(?,?,?,'published',?)",
                            (f"name-parent-{tag}", parent_id, f"Synthetic Parent {tag}", evidence_id))
        unit_id = f"unit-{tag}"
        self.db.execute("INSERT INTO org_units(id,county_fips,source_label,kind,parent_id,parent_relation,parent_evidence_id) "
                        "VALUES(?,?,?,'division',?,?,?)",
                        (unit_id, county, f"Synthetic Unit {tag}", parent_id,
                         "administrative" if parent_id else None, evidence_id if parent_id else None))
        self.db.execute("INSERT INTO org_names(id,unit_id,name,kind,evidence_id) VALUES(?,?,?,'published',?)",
                        (f"name-{tag}", unit_id, f"Synthetic Unit {tag}", evidence_id))
        if not selected:
            self.db.execute("UPDATE role_claims SET unit_id=?,published_name=?,published_title=? WHERE id=?",
                            (unit_id, f"Synthetic Person {tag}", f"Synthetic Role {tag}", claim_id))
            self.db.commit()
            return {"batch_id": batch, "claim_id": claim_id, "claim_ids": [claim["id"] for claim in claims],
                    "evidence_id": evidence_id, "source_id": source_id, "unit_id": unit_id,
                    "parent_id": parent_id}
        target_id, person_id = f"target-{tag}", f"person-{tag}"
        self.db.execute("INSERT INTO role_targets(id,unit_id,county_fips,documented_title,evidence_id) VALUES(?,?,?,?,?)",
                        (target_id, unit_id, county, f"Synthetic Role {tag}", evidence_id))
        if assigned:
            self.db.execute("INSERT INTO research_people(id,county_fips,display_name,identity_state,identity_evidence_id) "
                            "VALUES(?,?,?,'evidence_supported',?)",
                            (person_id, county, f"Synthetic Person {tag}", evidence_id))
        self.db.executemany("UPDATE role_claims SET person_id=?,unit_id=?,target_id=?,published_name=?,published_title=? "
                            "WHERE id=?",
                            [(person_id if assigned else None, unit_id, target_id,
                              f"Synthetic Person {tag}", f"Synthetic Role {tag}", claim["id"])
                             for claim in claims])
        self.db.commit()
        return {"batch_id": batch, "claim_id": claim_id, "claim_ids": [claim["id"] for claim in claims],
                "evidence_id": evidence_id,
                "source_id": source_id, "unit_id": unit_id, "parent_id": parent_id,
                "target_id": target_id, "person_id": person_id}

    def test_county_scope_precedes_cap_and_keeps_only_ordered_shared_dependencies(self):
        crowded = self.add_claim("08001", "adams", unit_parent=True)
        scoped = self.add_claim("08003", "alamosa", unit_parent=True, role_claim_count=2)
        self.add_claim("08003", "unselected", selected=False)
        self.db.commit()

        statewide = build_changeset(self.db, SITE, max_changes=1)
        county_bounded = build_changeset(self.db, SITE, max_changes=1, county_fips="08003")
        county = build_changeset(self.db, SITE, max_changes=20, county_fips="08003")
        self.assertEqual(statewide["request"]["changes"][0]["fields"]["county_fips"], "08001")
        self.assertEqual(county_bounded["request"]["changes"][0]["fields"]["county_fips"], "08003")
        self.assertTrue(county_bounded["truncated"])
        self.assertEqual(statewide["eligibility_summary"]["role_claims_skipped_by_batch_selection"], 1)
        self.assertEqual(county["county_fips"], "08003")
        self.assertTrue(county["truncated"] is False)
        self.assertEqual(county["eligibility_summary"]["role_claims_in_scope"], 3)
        self.assertEqual(county["eligibility_summary"]["role_claims_skipped_by_batch_selection"], 1)
        self.assertEqual(county["eligibility_summary"]["role_claims_evaluated"], 2)
        self.assertEqual(county["eligibility_summary"]["role_claims_planned"], 2)
        self.assertEqual(county["eligibility_summary"]["distinct_people_in_selected_batches"], 1)
        self.assertEqual(county["eligibility_summary"]["distinct_people_with_planned_roles"], 1)
        self.assertEqual(county["planned_operations_by_entity"], {
            "organizations": 3, "people": 1, "person_roles": 2, "positions": 1, "role_sources": 1})
        orgs = [item["local_entity_id"] for item in county["items"]
                if item["local_entity_type"] == "org_unit"]
        self.assertIn("unit-unselected", orgs)
        self.assertLess(orgs.index(scoped["parent_id"]), orgs.index(scoped["unit_id"]))
        self.assertNotIn(crowded["unit_id"], orgs)
        self.assertNotIn(crowded["person_id"], {item["local_entity_id"] for item in county["items"]})

    def test_county_selector_rejects_noncanonical_codes(self):
        self.add_claim("08001", "valid")
        for value in ("801", "08000", "08002", "08003 "):
            with self.subTest(county=value), self.assertRaises(ValueError):
                build_changeset(self.db, SITE, county_fips=value)


if __name__ == "__main__":
    unittest.main()

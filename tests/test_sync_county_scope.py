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
        self.db.executemany("INSERT INTO county VALUES (?,?)",
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
        claims = list(self.db.execute('SELECT "Role claim ID" AS id,"Evidence record ID" AS evidence_id FROM profile_research_role WHERE "Evidence record ID" IN '
                                      '(SELECT "Evidence record ID" FROM research_evidence WHERE "Import batch ID"=?) ORDER BY id', (batch,)))
        claim_id, evidence_id = claims[0]["id"], claims[0]["evidence_id"]
        source_id = self.db.execute('SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?', (evidence_id,)).fetchone()[0]
        self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official',"
                        "\"Document type\"='official_page' WHERE \"Source ID\"=?", (source_id,))
        self.db.execute('UPDATE research_evidence SET "Source title as observed"=?,"Source URL as observed"=? WHERE "Evidence record ID"=?',
                        (f"Synthetic source {tag}", f"https://example.invalid/{county}/{tag}", evidence_id))
        parent_id = f"unit-parent-{tag}" if unit_parent else None
        if parent_id:
            self.db.execute("INSERT INTO county_research_unit_structure(\"Office or unit ID\",\"County code\",\"Office or unit label as published\",\"Organization type\") VALUES(?,?,?,'department')",
                            (parent_id, county, f"Synthetic Parent {tag}"))
            self.db.execute("INSERT INTO county_research_unit_names(\"Office name record ID\",\"Office or unit ID\",\"Name\",\"Name type\",\"Evidence for this name\") VALUES(?,?,?,'published',?)",
                            (f"name-parent-{tag}", parent_id, f"Synthetic Parent {tag}", evidence_id))
        unit_id = f"unit-{tag}"
        self.db.execute('INSERT INTO county_research_unit_structure("Office or unit ID","County code","Office or unit label as published","Organization type","Parent office or unit","Relationship to parent","Evidence for parent relationship") '
                        "VALUES(?,?,?,'division',?,?,?)",
                        (unit_id, county, f"Synthetic Unit {tag}", parent_id,
                         "administrative" if parent_id else None, evidence_id if parent_id else None))
        self.db.execute("INSERT INTO county_research_unit_names(\"Office name record ID\",\"Office or unit ID\",\"Name\",\"Name type\",\"Evidence for this name\") VALUES(?,?,?,'published',?)",
                        (f"name-{tag}", unit_id, f"Synthetic Unit {tag}", evidence_id))
        if not selected:
            self.db.execute('UPDATE profile_research_role SET "Linked office or unit"=?,"Name as published"=?,"Position as published"=? WHERE "Role claim ID"=?',
                            (unit_id, f"Synthetic Person {tag}", f"Synthetic Role {tag}", claim_id))
            self.db.commit()
            return {"batch_id": batch, "claim_id": claim_id, "claim_ids": [claim["id"] for claim in claims],
                    "evidence_id": evidence_id, "source_id": source_id, "unit_id": unit_id,
                    "parent_id": parent_id}
        target_id, person_id = f"target-{tag}", f"person-{tag}"
        self.db.execute('INSERT INTO county_research_positions("Position ID","Office or unit ID","County code","Documented position title","Evidence for position") VALUES(?,?,?,?,?)',
                        (target_id, unit_id, county, f"Synthetic Role {tag}", evidence_id))
        if assigned:
            self.db.execute('INSERT INTO profile_research("Profile ID","County code","Full name","Identity review status","Evidence for identity") '
                            "VALUES(?,?,?,'evidence_supported',?)",
                            (person_id, county, f"Synthetic Person {tag}", evidence_id))
        self.db.executemany('UPDATE profile_research_role SET "Linked profile"=?,"Linked office or unit"=?,"Linked position"=?,"Name as published"=?,"Position as published"=? '
                            'WHERE "Role claim ID"=?',
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

    def _official_role_support(self, claim):
        """Separate official identity/organization evidence from role evidence."""
        payload = csv_bytes([observation(
            "08001", full_name="Synthetic Person citation", title="Synthetic Role citation",
            source_url="https://example.invalid/08001/official-support",
        )])
        batch = ingest_csv(self.db, payload, file_name="official-support.csv",
                           version_label="official-support", provenance="synthetic", selected=False)
        evidence_id = self.db.execute(
            'SELECT "Evidence record ID" AS id FROM research_evidence WHERE "Import batch ID"=?', (batch,)
        ).fetchone()[0]
        source_id = self.db.execute(
            'SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?', (evidence_id,)
        ).fetchone()[0]
        self.db.execute(
            "UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official',"
            "\"Document type\"='official_page' WHERE \"Source ID\"=?", (source_id,)
        )
        self.db.execute('UPDATE county_research_unit_names SET "Evidence for this name"=? WHERE "Office or unit ID"=?',
                        (evidence_id, claim["unit_id"]))
        self.db.execute('UPDATE county_research_positions SET "Evidence for position"=? WHERE "Position ID"=?',
                        (evidence_id, claim["target_id"]))
        self.db.execute('UPDATE profile_research SET "Evidence for identity"=? WHERE "Profile ID"=?',
                        (evidence_id, claim["person_id"]))
        self.db.commit()
        return evidence_id

    def test_official_role_citation_is_accepted_and_preserved(self):
        claim = self.add_claim("08001", "official-role")
        result = build_changeset(self.db, SITE, county_fips="08001")
        citation = next(change for change in result["request"]["changes"]
                        if change["op"] == "register_source")
        role = next(change for change in result["request"]["changes"]
                    if change["op"] == "create_person_role")

        self.assertEqual(citation["fields"]["publisher_classification"], "official")
        self.assertEqual(citation["fields"]["source_type"], "official_page")
        self.assertEqual(citation["fields"]["url"],
                         "https://example.invalid/08001/official-role")
        self.assertEqual(citation["fields"]["title"], "Synthetic source official-role")
        self.assertIn("source_checked_at", role["fields"])
        self.assertEqual(result["eligibility_summary"]["role_claims_planned"], 1)

    def test_verified_unofficial_role_citation_is_accepted_without_relaxing_identity(self):
        claim = self.add_claim("08001", "unofficial-role")
        self._official_role_support(claim)
        self.db.execute("UPDATE research_sources SET \"Publisher type\"='unofficial' "
                        'WHERE "Source ID"=?', (claim["source_id"],))
        self.db.commit()

        result = build_changeset(self.db, SITE, county_fips="08001")
        citation = next(change for change in result["request"]["changes"]
                        if change["op"] == "register_source")
        self.assertEqual(citation["fields"]["publisher_classification"], "unofficial")
        self.assertEqual(citation["fields"]["source_type"], "official_page")
        self.assertEqual(result["eligibility_summary"]["role_claims_planned"], 1)

    def test_unresolved_publisher_is_rejected_for_role_citation(self):
        claim = self.add_claim("08001", "unresolved-role")
        self._official_role_support(claim)
        self.db.execute("UPDATE research_sources SET \"Publisher type\"='unresolved' "
                        'WHERE "Source ID"=?', (claim["source_id"],))
        self.db.commit()

        result = build_changeset(self.db, SITE, county_fips="08001")
        reasons = [row["reason"] for row in result["excluded"]
                   if row["entity_type"] == "role_claim"]
        self.assertIn("source_publisher_unresolved", reasons)
        self.assertEqual(result["eligibility_summary"]["role_claims_planned"], 0)

    def test_unclear_role_listing_is_rejected_as_insufficient_role_evidence(self):
        claim = self.add_claim("08001", "insufficient-role")
        self._official_role_support(claim)
        self.db.execute("UPDATE profile_research_role SET \"Listing status\"='Unclear' WHERE \"Role claim ID\"=?",
                        (claim["claim_id"],))
        self.db.commit()

        result = build_changeset(self.db, SITE, county_fips="08001")
        reasons = [row["reason"] for row in result["excluded"]
                   if row["entity_type"] == "role_claim"]
        self.assertIn("not_currently_listed", reasons)
        self.assertEqual(result["eligibility_summary"]["role_claims_planned"], 0)


if __name__ == "__main__":
    unittest.main()

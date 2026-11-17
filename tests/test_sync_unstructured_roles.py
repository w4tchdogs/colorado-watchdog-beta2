"""R7 roles that rest on documented text alone, using only invented synthetic records."""

import unittest

from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv
from research.sync import build_changeset
from tests.research_fixtures import csv_bytes, observation

SITE = "synthetic-unstructured-role-site"
COUNTY = "08001"


class UnstructuredRoleTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO county VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08001", "08003")])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_role(self, tag, *, office=None, title=None, duties=None, county=COUNTY,
                 publisher="official", structured=False, cite=True, selected=True):
        payload = csv_bytes([observation(county, full_name=f"Synthetic Person {tag}",
                                         source_url=f"https://example.invalid/{county}/{tag}")])
        batch = ingest_csv(self.db, payload, file_name=f"{tag}.csv", version_label=tag,
                           provenance="synthetic", selected=selected)
        claim = self.db.execute(
            'SELECT c."Role claim ID" AS id,c."Evidence record ID" AS evidence_id,e."Source ID" AS source_id '
            'FROM profile_research_role c JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" '
            'WHERE e."Import batch ID"=?', (batch,)).fetchone()
        if cite:
            self.db.execute("UPDATE research_sources SET \"Previous source category\"=?,\"Publisher type\"=?,"
                            "\"Document type\"='official_page' WHERE \"Source ID\"=?",
                            ({"official": "official", "unofficial": "other", "unresolved": "unknown"}[publisher],
                             publisher, claim["source_id"]))
            self.db.execute('UPDATE research_evidence SET "Source title as observed"=?,"Source URL as observed"=? WHERE "Evidence record ID"=?',
                            (f"Synthetic source {tag}", f"https://example.invalid/{county}/{tag}", claim["evidence_id"]))
        person_id = f"person-{tag}"
        self.db.execute('INSERT INTO profile_research("Profile ID","County code","Full name","Identity review status","Evidence for identity") '
                        "VALUES(?,?,?,'evidence_supported',?)",
                        (person_id, county, f"Synthetic Person {tag}", claim["evidence_id"]))
        self.db.execute('UPDATE profile_research_role SET "Linked profile"=?,"Position as published"=?,"Job description or duties"=?,'
                        '"Office or department as published"=?,"Division or unit as published"=NULL WHERE "Role claim ID"=?',
                        (person_id, title, duties, office, claim["id"]))
        if structured:
            unit_id, target_id = f"unit-{tag}", f"target-{tag}"
            self.db.execute('INSERT INTO county_research_unit_structure("Office or unit ID","County code","Office or unit label as published","Organization type") '
                            "VALUES(?,?,?,'department')", (unit_id, county, f"Synthetic Unit {tag}"))
            self.db.execute("INSERT INTO county_research_unit_names(\"Office name record ID\",\"Office or unit ID\",\"Name\",\"Name type\",\"Evidence for this name\") VALUES(?,?,?,'published',?)",
                            (f"name-{tag}", unit_id, f"Synthetic Unit {tag}", claim["evidence_id"]))
            self.db.execute('INSERT INTO county_research_positions("Position ID","Office or unit ID","County code","Documented position title","Evidence for position") VALUES(?,?,?,?,?)',
                            (target_id, unit_id, county, title, claim["evidence_id"]))
            self.db.execute('UPDATE profile_research_role SET "Linked office or unit"=?,"Linked position"=? WHERE "Role claim ID"=?',
                            (unit_id, target_id, claim["id"]))
        self.db.commit()
        return claim["id"]

    def role_fields(self, generated, claim_id):
        for item in generated["items"]:
            if item["local_entity_type"] == "role_claim" and item["local_entity_id"] == claim_id:
                return generated["request"]["changes"][item["item_index"]]["fields"]
        return None

    def reasons(self, generated):
        return {item["entity_id"]: item["reason"] for item in generated["excluded"]
                if item.get("entity_type") == "role_claim"}

    def test_office_only_role_keeps_the_office_and_county_without_structure(self):
        claim = self.add_role("office", office="Synthetic Assessor Office")
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        fields = self.role_fields(generated, claim)
        self.assertEqual(fields["published_office"], "Synthetic Assessor Office")
        self.assertEqual(fields["county_fips"], COUNTY)
        self.assertNotIn("published_title", fields)
        self.assertNotIn("job_description", fields)
        self.assertFalse({"position_ref", "position_id"} & set(fields))
        self.assertEqual(generated["planned_operations_by_entity"], {"people": 1, "person_roles": 1, "role_sources": 1})
        self.assertEqual(generated["eligibility_summary"]["unstructured_roles_planned"], 1)
        self.assertFalse(generated["truncated"])

    def test_source_link_uses_recorded_discovery_day_and_allows_unknown_date(self):
        claim = self.add_role("citationdate", title="Synthetic Deputy")
        self.db.execute('UPDATE research_evidence SET "Reported check date"=NULL '
                        'WHERE "Evidence record ID"=(SELECT "Evidence record ID" FROM profile_research_role '
                        'WHERE "Role claim ID"=?)', (claim,))
        self.db.commit()
        fields = self.role_fields(build_changeset(self.db, SITE, county_fips=COUNTY), claim)
        self.assertIsNone(fields["source_checked_at"])
        self.db.execute('UPDATE research_evidence SET "Reported check date"=? '
                        'WHERE "Evidence record ID"=(SELECT "Evidence record ID" FROM profile_research_role '
                        'WHERE "Role claim ID"=?)', ("2026-11-02", claim))
        self.db.commit()
        fields = self.role_fields(build_changeset(self.db, SITE, county_fips=COUNTY), claim)
        self.assertEqual(fields["source_checked_at"], "2026-11-02")

    def test_duties_only_role_keeps_duties_separate_and_leaves_the_title_empty(self):
        claim = self.add_role("duties", duties="Reviews building permits")
        fields = self.role_fields(build_changeset(self.db, SITE, county_fips=COUNTY), claim)
        self.assertEqual(fields["job_description"], "Reviews building permits")
        self.assertNotIn("published_title", fields)
        self.assertNotIn("published_office", fields)

    def test_title_without_a_resolved_organization_stays_a_published_title(self):
        claim = self.add_role("title", title="Synthetic Deputy")
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        fields = self.role_fields(generated, claim)
        self.assertEqual(fields["published_title"], "Synthetic Deputy")
        self.assertFalse({"position_ref", "position_id"} & set(fields))
        self.assertNotIn("organizations", generated["planned_operations_by_entity"])
        self.assertNotIn("positions", generated["planned_operations_by_entity"])

    def test_unknown_organization_type_does_not_block_the_role(self):
        claim = self.add_role("unknownkind", title="Synthetic Registrar", structured=True)
        self.db.execute("UPDATE county_research_unit_structure SET \"Organization type\"='unknown' WHERE \"Office or unit ID\"='unit-unknownkind'")
        self.db.commit()
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        fields = self.role_fields(generated, claim)
        self.assertEqual(fields["published_title"], "Synthetic Registrar")
        self.assertFalse({"position_ref", "position_id"} & set(fields))

    def test_structured_role_keeps_its_position_link_and_adds_the_county(self):
        claim = self.add_role("structured", title="Synthetic Director", structured=True)
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        fields = self.role_fields(generated, claim)
        self.assertIn("position_ref", fields)
        self.assertEqual(fields["county_fips"], COUNTY)
        self.assertNotIn("published_title", fields)
        self.assertEqual(generated["planned_operations_by_entity"],
                         {"organizations": 1, "people": 1, "person_roles": 1, "positions": 1, "role_sources": 1})
        self.assertEqual(generated["eligibility_summary"]["structured_roles_planned"], 1)

    def test_role_without_any_documented_detail_is_rejected(self):
        claim = self.add_role("nodetail")
        self.db.execute('UPDATE profile_research_role SET "Position as published"=NULL,"Job description or duties"="Listed in official source",'
                        '"Office or department as published"=NULL WHERE "Role claim ID"=?', (claim,))
        self.db.commit()
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertEqual(self.reasons(generated)[claim], "no_documented_office_position_or_duties")
        self.assertEqual(generated["request"]["changes"], [])

    def test_role_without_a_verified_citation_is_rejected(self):
        claim = self.add_role("nocite", office="Synthetic Office", cite=False)
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertIn(claim, self.reasons(generated))
        self.assertEqual(generated["request"]["changes"], [])

    def test_unresolved_publisher_is_not_a_verified_citation(self):
        claim = self.add_role("unresolved", office="Synthetic Office", publisher="unresolved")
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertIn(claim, self.reasons(generated))

    def test_verified_unofficial_public_citation_is_still_accepted(self):
        claim = self.add_role("unofficial", office="Synthetic Office", publisher="unofficial")
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertIsNotNone(self.role_fields(generated, claim))
        source = next(change for change in generated["request"]["changes"] if change["entity"] == "role_sources")
        self.assertEqual(source["fields"]["publisher_classification"], "unofficial")

    def test_truncation_is_reported_apart_from_eligibility(self):
        self.add_role("one", office="Synthetic Office One")
        self.add_role("two", office="Synthetic Office Two")
        generated = build_changeset(self.db, SITE, county_fips=COUNTY, max_changes=3)
        summary = generated["eligibility_summary"]
        self.assertTrue(generated["truncated"])
        self.assertEqual(summary["eligible_claims"], 2)
        self.assertEqual(summary["distinct_eligible_profiles"], 2)
        self.assertEqual(summary["role_claims_planned"], 1)
        self.assertEqual(summary["eligible_claims_not_planned_because_of_request_size"], 1)
        self.assertEqual(summary["operations_planned"], 3)

    def test_there_is_no_count_cap_on_changes_or_citations(self):
        # 250 people, 30 distinct citations: beyond the former 200-change and 25-citation caps.
        payload = csv_bytes([observation(COUNTY, full_name=f"Synthetic Person {index}",
                                         source_url=f"https://example.invalid/{COUNTY}/source-{index % 30}")
                             for index in range(250)])
        batch = ingest_csv(self.db, payload, file_name="bulk.csv", version_label="bulk",
                           provenance="synthetic", selected=True)
        claims = list(self.db.execute(
            'SELECT c."Role claim ID" AS id,c."Evidence record ID" AS evidence_id,e."Source ID" AS source_id '
            'FROM profile_research_role c JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" '
            'WHERE e."Import batch ID"=? ORDER BY c."Role claim ID"', (batch,)))
        for source_id in {claim["source_id"] for claim in claims}:
            self.db.execute("UPDATE research_sources SET \"Previous source category\"='official',\"Publisher type\"='official',"
                            "\"Document type\"='official_page' WHERE \"Source ID\"=?", (source_id,))
        for index, claim in enumerate(claims):
            self.db.execute('UPDATE research_evidence SET "Source title as observed"=? WHERE "Evidence record ID"=?',
                            (f"Synthetic source {claim['source_id']}", claim["evidence_id"]))
            self.db.execute('INSERT INTO profile_research("Profile ID","County code","Full name","Identity review status","Evidence for identity") '
                            "VALUES(?,?,?,'evidence_supported',?)",
                            (f"person-bulk-{index}", COUNTY, f"Synthetic Person {index}", claim["evidence_id"]))
            self.db.execute('UPDATE profile_research_role SET "Linked profile"=?,"Office or department as published"=? WHERE "Role claim ID"=?',
                            (f"person-bulk-{index}", f"Synthetic Office {index}", claim["id"]))
        self.db.commit()
        generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        summary = generated["eligibility_summary"]
        self.assertFalse(generated["truncated"])
        self.assertEqual(summary["role_claims_planned"], 250)
        self.assertEqual(summary["distinct_eligible_profiles"], 250)
        self.assertEqual(generated["planned_operations_by_entity"]["role_sources"], 30)
        self.assertEqual(summary["operations_planned"], 530)
        self.assertLess(len(str(generated["request"])), 8 * 1024 * 1024)

    def test_changeset_ends_at_the_request_size_limit(self):
        from research import sync
        original = sync.MAX_REQUEST_BYTES
        sync.MAX_REQUEST_BYTES = 2500
        try:
            for tag in ("a", "b", "c", "d", "e", "f"):
                self.add_role(tag, office="Synthetic Office " + tag)
            generated = build_changeset(self.db, SITE, county_fips=COUNTY)
        finally:
            sync.MAX_REQUEST_BYTES = original
        self.assertTrue(generated["truncated"])
        self.assertLess(0, generated["eligibility_summary"]["role_claims_planned"])
        self.assertLess(generated["eligibility_summary"]["role_claims_planned"], 6)
        self.assertEqual(generated["eligibility_summary"]["eligible_claims"], 6)

    def test_county_scope_and_reruns_are_deterministic(self):
        self.add_role("a", office="Synthetic Office A")
        self.add_role("b", duties="Synthetic duties B", county="08003")
        first = build_changeset(self.db, SITE, county_fips=COUNTY)
        second = build_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertEqual(first["request"], second["request"])
        self.assertEqual(first["eligibility_summary"]["eligible_claims"], 1)
        self.assertEqual(first["eligibility_summary"]["distinct_eligible_profiles"], 1)
        self.assertEqual(first["eligibility_summary"]["operations_planned"], 3)
        self.assertEqual({change["fields"].get("county_fips") for change in first["request"]["changes"]
                          if change["entity"] == "person_roles"}, {COUNTY})


if __name__ == "__main__":
    unittest.main()

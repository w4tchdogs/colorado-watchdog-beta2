"""Synthetic county Profiles export tests; no private database data is used."""

import json
import tempfile
import unittest
from pathlib import Path

from research.db import connect, migrate
from research.export import build_export, MAX_PROFILE_EXPORT
from research.mapping import canonical_json

NOW = "2026-11-15T12:00:00+00:00"


class ProfilesExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "synthetic.sqlite"
        self.db = connect(self.path)
        migrate(self.db)
        self.db.execute("PRAGMA foreign_keys=OFF")
        self.db.executemany('INSERT INTO counties("County code","County name") VALUES(?,?)',
                            [("08001", "Adams"), ("08003", "Alamosa")])
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at) "
                        "VALUES('run_synth','mapping','synthetic','fixture',?,?,?)", (NOW, NOW, NOW))
        sources = [("src_gov", "official", "https://example.invalid/gov/report.pdf"),
                   ("src_unofficial", "unofficial", "https://example.invalid/news/item"),
                   ("src_unresolved", "unresolved", "https://example.invalid/unclear")]
        for source_id, classification, url in sources:
            self.db.execute('INSERT INTO sources("Source ID","Original source URL","Document type","Previous source category","Publisher type","Recorded on") '
                            "VALUES(?,?,?,'unknown',?,?)",
                            (source_id, url, "public_document" if source_id == "src_gov" else "official_page",
                             classification, NOW))
        self.db.executemany("INSERT INTO research_people(\"Profile ID\",\"County code\",\"Full name\",\"Identity review status\") VALUES(?,?,?,'provisional')",
                            [("person_a", "08001", "Synthetic Avery Example"),
                             ("person_source_less", "08001", "Synthetic Casey Example")])
        for index, (source_id, county, person) in enumerate([
                ("src_gov", "08001", "person_a"),
                ("src_unofficial", "08001", "person_a"),
                ("src_unresolved", "08001", "person_a"),
                ("src_gov", "08003", "person_a"),
                ("src_unofficial", "08001", None)], 1):
            # The fourth fixture deliberately models a person with claims across counties.
            # The production schema currently rejects that association; the exporter must still
            # deduplicate by person ID and preserve every selected county/role link.
            url = dict((key, value) for key, _, value in sources)[source_id]
            evidence_id = f"ev_claim_{index}"
            self.db.execute('INSERT INTO evidence_links("Evidence record ID","Source ID","Source title as observed","Source URL as observed","Evidence location","Research run ID","Recorded on") '
                            "VALUES(?,?,?,?,?,'run_synth',?)",
                            (evidence_id, source_id, "Synthetic citation", url, "section 1", NOW))
            self.db.execute('INSERT INTO role_claims("Role claim ID","County code","Evidence record ID","Linked profile","Name as published","Position as published",'
                            "\"Listing status\") VALUES(?,?,?,?,?,?, 'Listed')",
                            (f"claim_{index}", county, evidence_id, person,
                             "Synthetic Avery Example" if person else "Synthetic Jordan Example", "Synthetic Clerk"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_county_scope_dedup_sources_and_true_null_for_sourceless_profile(self):
        result = build_export(self.db, counties=["08001"])
        self.assertEqual(result["summary"]["distinct_profiles"], 2)
        self.assertEqual(result["summary"]["role_claims"], 4)
        self.assertEqual(result["summary"]["unassigned_role_claims"], 1)
        self.assertEqual(result["summary"]["official_sources"], 1)
        self.assertEqual(result["summary"]["unofficial_sources"], 1)
        self.assertEqual(result["summary"]["unresolved_publishers"], 1)
        source_less = next(p for p in result["profiles"] if p["profile_id"] == "person_source_less")
        self.assertIsNone(source_less["source_classification"])
        self.assertEqual(source_less["sources"], [])
        profile = next(p for p in result["profiles"] if p["profile_id"] == "person_a")
        self.assertEqual({s["source_classification"] for s in profile["sources"]},
                         {"official", "unofficial", "unresolved"})
        self.assertEqual({r["county_fips"] for r in profile["roles"]}, {"08001"})
        gov = next(s for s in profile["sources"] if s["source_id"] == "src_gov")
        self.assertEqual(gov["source_classification"], "official")
        self.assertEqual(gov["citation"]["url"], "https://example.invalid/gov/report.pdf")
        self.assertNotIn("raw_record_json", json.dumps(result))
        self.assertNotIn("private_note", json.dumps(result))

    def test_cross_county_person_is_one_profile_and_keeps_each_selected_role_link(self):
        result = build_export(self.db, counties=["08001", "08003"])
        self.assertEqual(sum(p["profile_id"] == "person_a" for p in result["profiles"]), 1)
        profile = next(p for p in result["profiles"] if p["profile_id"] == "person_a")
        self.assertEqual(profile["counties"], ["08001", "08003"])
        self.assertEqual({r["county_fips"] for r in profile["roles"]}, {"08001", "08003"})

    def test_scope_before_limit_hard_cap_and_repeatable_continuation(self):
        self.db.executemany('INSERT INTO research_people("Profile ID","County code","Full name","Identity review status") '
                            "VALUES(?, '08001', ?, 'provisional')",
                            [(f"person_{i:05d}", f"Synthetic Person {i:05d}") for i in range(10_002)])
        self.db.commit()
        first = build_export(self.db, counties=["08001"], limit=MAX_PROFILE_EXPORT)
        self.assertEqual(first["summary"]["distinct_profiles"], 10_000)
        self.assertTrue(first["summary"]["truncated"])
        cursor = first["continuation"]["after_profile_id"]
        page_a = build_export(self.db, counties=["08001"], limit=MAX_PROFILE_EXPORT, after_profile_id=cursor)
        page_b = build_export(self.db, counties=["08001"], limit=MAX_PROFILE_EXPORT, after_profile_id=cursor)
        self.assertEqual([p["profile_id"] for p in page_a["profiles"]],
                         [p["profile_id"] for p in page_b["profiles"]])
        self.assertEqual(page_a["summary"]["distinct_profiles"], 4)
        self.assertFalse(page_a["summary"]["truncated"])
        with self.assertRaises(ValueError):
            build_export(self.db, counties=["08001"], limit=10_001)

    def test_scope_requires_canonical_county_or_explicit_statewide(self):
        for options in ({}, {"statewide": True, "counties": ["08001"]},
                        {"counties": ["801"]}, {"counties": ["99999"]}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                build_export(self.db, **options)


if __name__ == "__main__":
    unittest.main()

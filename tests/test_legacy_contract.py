"""Synthetic regression cases for the published legacy CSV contract."""
import json
import unittest
from contextlib import closing

from research.db import connect, migrate
from research.mapping import COUNTIES, parse_csv
from research.store import ingest_csv
from tests.research_fixtures import observation, csv_bytes


class LegacyContractTests(unittest.TestCase):
    def test_legacy_listing_status_preserved_and_explicitly_normalized(self):
        with closing(connect()) as db, db:
            migrate(db)
            db.execute("INSERT INTO counties VALUES ('08107','Routt')")
            db.commit()
            raw = observation()
            ingest_csv(db, csv_bytes([raw]), file_name="synthetic.csv",
                       version_label="synthetic-v1")
            evidence = db.execute('SELECT "Original record" AS raw_record_json FROM evidence_links').fetchone()[0]
            self.assertEqual(json.loads(evidence)["cells"][11], "Listed in official source")
            self.assertEqual(db.execute('SELECT "Listing status" AS source_listing_status FROM role_claims').fetchone()[0],
                             "Listed")
            self.assertEqual(db.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)

    def test_internal_short_status_is_not_legacy_input(self):
        with self.assertRaisesRegex(ValueError, "listing status"):
            parse_csv(csv_bytes([observation(listing_status="Listed")]))

    def test_all_supported_grouping_bases_and_invalid_values(self):
        for basis in ("Official county structure", "Directory display fallback", "Needs editorial review",
                      "Official county source role"):
            with self.subTest(basis=basis):
                self.assertEqual(parse_csv(csv_bytes([observation(grouping_basis=basis)]))["rows"][0]
                                 ["values"]["grouping_basis"], basis)
        for basis in ("", "synthetic mapping case", "official county structure", " Official county structure"):
            with self.subTest(basis=basis), self.assertRaisesRegex(ValueError, "grouping basis"):
                parse_csv(csv_bytes([observation(grouping_basis=basis)]))

    def test_elbert_el_paso_are_not_swapped(self):
        self.assertEqual(COUNTIES["08039"], "Elbert")
        self.assertEqual(COUNTIES["08041"], "El Paso")
        for fips, county in (("08039", "Elbert"), ("08041", "El Paso")):
            with self.subTest(fips=fips):
                parse_csv(csv_bytes([observation(fips, county=county)]))
                wrong = "El Paso" if county == "Elbert" else "Elbert"
                with self.assertRaisesRegex(ValueError, "county/FIPS"):
                    parse_csv(csv_bytes([observation(fips, county=wrong)]))

    def test_invalid_grouping_ingestion_writes_nothing(self):
        with closing(connect()) as db, db:
            migrate(db)
            db.execute("INSERT INTO counties VALUES ('08107','Routt')")
            db.commit()
            with self.assertRaisesRegex(ValueError, "grouping basis"):
                ingest_csv(db, csv_bytes([observation(grouping_basis="invalid")]),
                           file_name="synthetic.csv", version_label="synthetic-v1")
            for table in ("scrape_batches", "role_claims", "evidence_links", "research_runs"):
                self.assertEqual(db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)

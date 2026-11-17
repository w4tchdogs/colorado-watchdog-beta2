import hashlib
import re
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from research import backup as backup_module
from research.backup import backup_database, restore_database
from research.db import MIGRATIONS, connect, migrate, validate_database

NOW = "2026-11-17T12:00:00+00:00"
FP = lambda text: hashlib.sha256(text.encode()).hexdigest()  # noqa: E731
TABLES = """county county_research_coverage county_research_positions county_research_unit_names
county_research_unit_sources county_research_unit_structure profile profile_county profile_county_unit
profile_evidence profile_evidence_citation profile_evidence_role profile_position profile_research
profile_research_duplicates profile_research_name profile_research_role profile_revisions profile_role
research_evidence research_history research_runs research_scrapes research_source_visits research_sources
schema_migrations website_change_receipts website_id_evidence website_ids website_request_changes
website_request_receipts website_requests website_reversal_receipts website_update_approvals""".split()
VIEWS = ["county_research_conclusions", "profile_research_conclusions",
         "profile_research_role_selected", "profiles_overview"]


def seed_research(db):
    """Populated synthetic v6 research rows plus pending, committed and reversed Website state."""
    db.executescript(f"""
        INSERT INTO county VALUES ('08107','Routt'),('08031','Denver');
        INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES ('run','screening','synthetic','{NOW}');
        INSERT INTO research_sources("Source ID","Original source URL","Recorded on","Publisher type")
            VALUES ('src','https://example.invalid/routt/staff','{NOW}','official'),
                   ('src2','https://example.invalid/routt/other','{NOW}','unofficial');
        INSERT INTO research_scrapes(id,county_fips,family_id,lineage_kind,selected,version_label,original_file_name,
            file_sha256,mapping_version,mapping_json,provenance_type,run_id,recorded_at)
            VALUES ('batch-on','08107','batch-on','original',1,'v1','a.csv','{"0"*64}','legacy-17/v1','{{}}','synthetic','run','{NOW}'),
                   ('batch-off','08107','batch-off','complementary',0,'v1','b.csv','{"1"*64}','legacy-17/v1','{{}}','synthetic','run','{NOW}');
        INSERT INTO research_evidence("Evidence record ID","Source ID","Source URL as observed","Evidence location",
            "Research run ID","Recorded on","Import batch ID","Original record","Original record fingerprint","Where the record appeared")
            VALUES ('ev-1','src','https://example.invalid/routt/staff','row 1','run','{NOW}','batch-on','{{}}','f1','[]'),
                   ('ev-2','src','https://example.invalid/routt/staff','row 2','run','{NOW}','batch-off','{{}}','f2','[]'),
                   ('ev-3','src','https://example.invalid/routt/staff','row 3','run','{NOW}',NULL,NULL,NULL,NULL),
                   ('ev-4','src2','https://example.invalid/routt/other','row 4','run','{NOW}',NULL,NULL,NULL,NULL),
                   ('ev-d','src','https://example.invalid/denver','row 5','run','{NOW}',NULL,NULL,NULL,NULL);
        INSERT INTO county_research_unit_structure("Office or unit ID","County code","Office or unit label as published","Organization type")
            VALUES ('u-parent','08107','Synthetic Department','department');
        INSERT INTO county_research_unit_structure VALUES
            ('u-child','08107','Synthetic Division','division','u-parent','administrative','ev-3',NULL,NULL),
            ('u-den','08031','Denver Unit','department',NULL,NULL,NULL,NULL,NULL);
        INSERT INTO county_research_positions("Position ID","Office or unit ID","County code","Documented position title","Evidence for position")
            VALUES ('pos-1','u-child','08107','Synthetic Coordinator','ev-3');
        INSERT INTO profile_research("Profile ID","County code","Full name","Identity review status","Evidence for identity")
            VALUES ('rp-1','08107','Synthetic Casey Example','evidence_supported','ev-1'),
                   ('rp-2','08107','Synthetic Provisional Person','provisional',NULL);
        INSERT INTO profile_research_role("Role claim ID","County code","Evidence record ID","Linked profile","Linked office or unit",
            "Linked position","Name as published","Position as published","Listing status")
            VALUES ('c-1','08107','ev-1','rp-1','u-child','pos-1','Synthetic Casey Example','Coordinator','Listed'),
                   ('c-2','08107','ev-2','rp-1',NULL,NULL,'Synthetic Casey Example','Old Title','Listed'),
                   ('c-3','08107','ev-3','rp-1',NULL,NULL,'Synthetic Casey Example','Unbatched','Explicitly former');
        INSERT INTO website_requests(id,site_key,idempotency_key,contract_version,request_fingerprint,request_json,state,attempt_count,created_at,updated_at)
            VALUES ('req-pending','site','key-pending','m2-sync/v1','{FP("p")}','{{"pending": true}}','pending',1,'{NOW}','{NOW}');
        INSERT INTO website_requests(id,site_key,idempotency_key,contract_version,request_fingerprint,request_json,state,attempt_count,
            created_at,updated_at,response_status,response_json,remote_batch_id)
            VALUES ('req-ok','site','key-ok','m2-sync/v1','{FP("o")}','{{"ok": true}}','acknowledged',1,'{NOW}','{NOW}',200,'{{}}','wb-ok'),
                   ('req-rev','site','key-rev','m2-sync/v1','{FP("r")}','{{"rev": true}}','acknowledged',1,'{NOW}','{NOW}',200,'{{}}','wb-rev'),
                   ('req-bad','site','key-bad','m2-sync/v1','{FP("b")}','{{"bad": true}}','acknowledged',1,'{NOW}','{NOW}',200,'{{}}','wb-bad');
        INSERT INTO website_request_receipts VALUES ('req-ok','committed','wb-ok','{{}}','{NOW}'),
            ('req-rev','committed','wb-rev','{{}}','{NOW}'),('req-bad','committed','wb-bad','{{}}','{NOW}');
        INSERT INTO website_request_changes(submission_id,item_index,client_ref,website_entity,request_item_json)
            VALUES ('req-ok',0,'a','people','{{}}'),('req-rev',0,'a','people','{{}}'),('req-bad',0,'a','people','{{}}');
        INSERT INTO website_reversal_receipts VALUES ('rv-1','site','wb-rev','{FP("rv")}','reverted','{{}}','{NOW}');
    """)
    db.executemany("INSERT INTO website_change_receipts(submission_id,item_index,client_ref,website_entity,website_id,website_version,"
                   "outcome,status,result_json) VALUES (?,0,'a','people','w1',1,'created','committed','{}')",
                   [("req-ok",), ("req-rev",)])
    db.execute("INSERT INTO website_change_receipts(submission_id,item_index,client_ref,website_entity,status,result_json) "
               "VALUES ('req-bad',0,'a','people','rejected','{}')")
    db.commit()


def all_rows(db):
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY 1")]
    return {name: [tuple(r) for r in db.execute(f'SELECT * FROM "{name}" ORDER BY 1,2')] for name in names}


def promote(db, profile="p-1", county="08107", research="rp-1", evidence="ev-1"):
    """One reviewed promotion transaction: profile, county, evidence."""
    with db:
        db.execute("BEGIN")
        db.execute('INSERT INTO profile_county VALUES (?,?,?)', (profile, county, NOW))
        db.execute('INSERT INTO profile VALUES (?,?,?,?,?,?)',
                   (profile, "Synthetic Casey Example", "Reviewer", NOW, None, NOW))
        db.execute('INSERT INTO profile_evidence VALUES (?,?,?,?,?,?,?)',
                   (f"pe-{profile}", profile, county, research, evidence, None, NOW))


class UpgradeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = connect(self.root / "r.sqlite")
        migrate(self.db, through_version=6)
        seed_research(self.db)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_upgrade_preserves_everything_and_adds_expected_objects(self):
        before = all_rows(self.db)
        history = [tuple(r) for r in self.db.execute("SELECT * FROM schema_migrations ORDER BY name")]
        migrate(self.db)
        migrate(self.db)
        after = all_rows(self.db)
        new_tables = {"profile", "profile_county", "profile_county_unit", "profile_evidence", "profile_evidence_citation",
                      "profile_evidence_role", "profile_position", "profile_revisions", "profile_role"}
        for table, rows in before.items():
            if table != "schema_migrations":
                self.assertEqual(after[table], rows, table)
        for table in new_tables:
            self.assertEqual(after[table], [], table)
        self.assertEqual(sorted(after), sorted(TABLES))
        self.assertEqual(len(after), 34)
        self.assertEqual(sorted(r[0] for r in self.db.execute("SELECT name FROM sqlite_schema WHERE type='view'")), VIEWS)
        ledger = [tuple(r) for r in self.db.execute("SELECT * FROM schema_migrations ORDER BY name")]
        self.assertEqual(ledger[:-1], history)
        self.assertEqual(ledger[-1][0], "007_confirmed_profiles.sql")
        self.assertEqual(validate_database(self.db), {"integrity": "ok", "foreign_keys": [], "schema_version": 7})
        # Pending request bytes and idempotency key survive exactly.
        row = self.db.execute("SELECT request_json,idempotency_key,request_fingerprint,state FROM website_requests WHERE id='req-pending'").fetchone()
        self.assertEqual(tuple(row), ('{"pending": true}', "key-pending", FP("p"), "pending"))

    def test_migrations_001_to_006_are_unchanged_and_checksums_recorded(self):
        digests = {p.name: hashlib.sha256(p.read_text(encoding="utf-8").encode()).hexdigest()
                   for p in sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))}
        migrate(self.db)
        self.assertEqual(dict(tuple(r) for r in self.db.execute("SELECT name,sha256 FROM schema_migrations")), digests)
        self.assertEqual(len(digests), 7)

    def test_backup_restore_matches_v7_schema(self):
        migrate(self.db)
        self.db.commit()
        with patch.object(backup_module, "_protect", side_effect=lambda payload, _: payload), \
                patch.object(backup_module, "_unprotect", side_effect=lambda payload, _: payload):
            made = backup_database(self.root / "r.sqlite", self.root / "x.cwbackup")
            restored = restore_database(self.root / "x.cwbackup", self.root / "restored.sqlite")
        self.assertEqual(made["schema_version"], 7)
        self.assertEqual(restored["logical_sha256"], made["logical_sha256"])
        self.assertEqual(restored["table_counts"], made["table_counts"])
        self.assertEqual(restored["table_counts"]["profile"], 0)
        with closing(connect(self.root / "restored.sqlite")) as copy:
            self.assertEqual(validate_database(copy)["foreign_keys"], [])

    def test_migration_text_is_lf_stable(self):
        text = (MIGRATIONS / "007_confirmed_profiles.sql").read_bytes()
        self.assertNotIn(b"\r", text)


class ProfilesCase(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db, through_version=6)
        seed_research(self.db)
        migrate(self.db)

    def tearDown(self):
        self.db.close()

    def fails(self, sql, params=(), pattern=None):
        with self.assertRaisesRegex(sqlite3.IntegrityError, pattern or ".*"):
            with self.db:
                self.db.execute(sql, params)

    def test_required_single_county(self):
        # A profile alone, or a county row alone, cannot be committed.
        self.fails('INSERT INTO profile VALUES (?,?,?,?,?,?)', ("p-x", "Synthetic Name", "R", NOW, None, NOW))
        self.fails('INSERT INTO profile_county VALUES (?,?,?)', ("p-y", "08107", NOW))
        promote(self.db)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile").fetchone()[0], 1)
        # One authoritative county link and a canonical county code only.
        self.fails('INSERT INTO profile_county VALUES (?,?,?)', ("p-1", "08031", NOW), "UNIQUE|PRIMARY")
        self.fails('UPDATE profile_county SET "County code"=\'08999\' WHERE "Profile ID"=\'p-1\'', pattern="FOREIGN KEY|CHECK")
        # The county row cannot be removed while the profile remains, and vice versa.
        self.fails('DELETE FROM profile_county WHERE "Profile ID"=\'p-1\'', pattern="FOREIGN KEY")
        self.fails('DELETE FROM profile WHERE "Profile ID"=\'p-1\'', pattern="FOREIGN KEY")
        with self.db:
            self.db.execute("BEGIN")
            self.db.execute('DELETE FROM profile_evidence')
            self.db.execute('DELETE FROM profile WHERE "Profile ID"=\'p-1\'')
            self.db.execute('DELETE FROM profile_county WHERE "Profile ID"=\'p-1\'')
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_promotion_needs_supported_identity_and_county_match(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "evidence_supported"):
            promote(self.db, profile="p-2", research="rp-2")
        with self.assertRaises(sqlite3.IntegrityError):
            promote(self.db, profile="p-3", county="08031")  # research identity belongs to Routt
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile").fetchone()[0], 0)
        promote(self.db)
        self.fails('UPDATE profile_evidence SET "Research profile ID" = ?', ("rp-2",), "evidence_supported")

    def populate(self):
        promote(self.db)
        with self.db:
            self.db.execute("BEGIN")
            self.db.execute('INSERT INTO profile_county_unit VALUES (?,?,?,?,?,?,?,?,?)',
                            ("cu-parent", "08107", "Synthetic Department", "department", "u-parent", None, "ev-3", "R", NOW))
            self.db.execute('INSERT INTO profile_county_unit VALUES (?,?,?,?,?,?,?,?,?)',
                            ("cu-child", "08107", "Synthetic Division", "division", "u-child", "cu-parent", "ev-3", "R", NOW))
            self.db.execute('INSERT INTO profile_position VALUES (?,?,?,?,?,?,?)',
                            ("pp-1", "08107", "cu-child", "Synthetic Coordinator", "u-child", "pos-1", "ev-3"))
            self.db.execute('INSERT INTO profile_role("Role ID","Profile ID","County code","County unit ID","Profile position ID") VALUES (?,?,?,?,?)',
                            ("r-1", "p-1", "08107", "cu-child", "pp-1"))
            # A role with no resolved structured unit, supported by a documented title only.
            self.db.execute('INSERT INTO profile_role("Role ID","Profile ID","County code","Position title","Office or department") VALUES (?,?,?,?,?)',
                            ("r-2", "p-1", "08107", "Synthetic Liaison", "Synthetic Office"))
            self.db.execute('INSERT INTO profile_evidence_citation VALUES (?,?,?,?,?,?,?,?)',
                            ("cit-1", "pe-p-1", "src", "https://example.invalid/routt/staff", "Staff page", "official", "staff directory", "2026-11-17"))
            self.db.execute('INSERT INTO profile_evidence_role VALUES (?,?,?,?,?,?)',
                            ("r-1", "c-1", "pe-p-1", "p-1", "08107", "cit-1"))
            self.db.execute('INSERT INTO profile_evidence_role VALUES (?,?,?,?,?,?)',
                            ("r-1", "c-3", "pe-p-1", "p-1", "08107", None))

    def test_unit_county_parent_and_role_relationships(self):
        self.populate()
        # County comes from the researched unit: a Denver county with a Routt research unit fails.
        self.fails('INSERT INTO profile_county_unit VALUES (?,?,?,?,?,?,?,?,?)',
                   ("cu-bad", "08031", "Wrong", "department", "u-child", None, "ev-d", "R", NOW), "FOREIGN KEY")
        # A confirmed parent must match the researched parent.
        self.fails('INSERT INTO profile_county_unit VALUES (?,?,?,?,?,?,?,?,?)',
                   ("cu-orphan", "08107", "Other", "division", "u-parent", "cu-child", "ev-3", "R", NOW), "researched unit parent")
        # Role county follows the profile's county, unit and position must agree.
        self.fails('INSERT INTO profile_role("Role ID","Profile ID","County code","Position title") VALUES (?,?,?,?)',
                   ("r-x", "p-1", "08031", "Wrong county"), "FOREIGN KEY")
        self.fails('INSERT INTO profile_role("Role ID","Profile ID","County code") VALUES (?,?,?)', ("r-y", "p-1", "08107"), "CHECK")
        self.fails('INSERT INTO profile_role("Role ID","Profile ID","County code","County unit ID","Profile position ID") VALUES (?,?,?,?,?)',
                   ("r-z", "p-1", "08107", "cu-parent", "pp-1"), "FOREIGN KEY")
        self.fails('INSERT INTO profile_role("Role ID","Profile ID","County code","Position title","Affiliation") VALUES (?,?,?,?,?)',
                   ("r-w", "p-1", "08107", "T", "Partner Org"), "CHECK")
        self.db.execute('INSERT INTO profile_role("Role ID","Profile ID","County code","Position title","Affiliation","Affiliation evidence record ID") VALUES (?,?,?,?,?,?)',
                        ("r-aff", "p-1", "08107", "T", "Partner Org", "ev-4"))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_role").fetchone()[0], 3)

    def test_evidence_and_citation_consistency(self):
        self.populate()
        self.fails('INSERT INTO profile_evidence_citation VALUES (?,?,?,?,?,?,?,?)',
                   ("cit-bad", "pe-p-1", "src2", "https://example.invalid/x", "T", "official", "page", "2026-11-17"), "source must match")
        self.fails('INSERT INTO profile_evidence_citation VALUES (?,?,?,?,?,?,?,?)',
                   ("cit-js", "pe-p-1", "src", "javascript:alert(1)", "T", "official", "page", "2026-11-17"), "CHECK")
        # An observation linked to a different research identity cannot support the role.
        with self.db:
            self.db.execute('UPDATE profile_research_role SET "Linked profile"=NULL WHERE "Role claim ID"=\'c-2\'')
        self.fails('INSERT INTO profile_evidence_role VALUES (?,?,?,?,?,?)', ("r-2", "c-2", "pe-p-1", "p-1", "08107", None), "linked to the research identity")
        self.fails('UPDATE profile_evidence_role SET "Role claim ID" = ? WHERE "Role claim ID" = ?',
                   ("c-2", "c-1"), "linked to the research identity")
        self.fails('UPDATE profile_evidence SET "Evidence record ID" = ?', ("ev-4",), "source must match")
        # Multiple supporting observations stay for one role.
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_evidence_role WHERE "Role ID"=\'r-1\'').fetchone()[0], 2)
        self.fails('INSERT INTO profile_evidence_role VALUES (?,?,?,?,?,?)', ("r-2", "c-3", "pe-p-1", "p-1", "08107", "cit-9"), "FOREIGN KEY|same profile evidence")
        self.db.execute('INSERT INTO profile_evidence VALUES (?,?,?,?,?,?,?)',
                        ("pe-other", "p-1", "08107", "rp-1", "ev-3", None, NOW))
        self.fails('UPDATE profile_evidence_citation SET "Profile evidence ID" = ?', ("pe-other",), "FOREIGN KEY")

    def test_research_conclusion_views(self):
        self.populate()
        row = self.db.execute("SELECT * FROM profile_research_conclusions").fetchall()
        self.assertEqual(len(row), 1)  # the provisional identity is not a conclusion
        row = row[0]
        self.assertEqual((row["Research profile ID"], row["County name"], row["Identity source publisher"]), ("rp-1", "Routt", "official"))
        # c-2 is in an unselected batch, so only c-1 (selected) and c-3 (no batch) are current.
        self.assertEqual((row["Current role observations"], row["Listed role observations"]), (2, 1))
        self.assertEqual((row["Confirmed profile ID"], row["Promotion state"]), ("p-1", "Promoted"))
        units = {r["Office or unit ID"]: r for r in self.db.execute("SELECT * FROM county_research_conclusions")}
        self.assertEqual(set(units), {"u-parent", "u-child", "u-den"})
        child = units["u-child"]
        self.assertEqual((child["Parent office or unit"], child["Parent label as published"], child["County name"]),
                         ("u-parent", "Synthetic Department", "Routt"))
        self.assertEqual((child["Documented positions"], child["Current role observations"], child["Confirmed county units"]), (1, 1, 1))
        self.assertEqual(units["u-den"]["Parent label as published"], None)

    def revision(self, number, status, request=None, text=None):
        reviewed = ("R", NOW) if status != "proposed" else (None, None)
        self.db.execute(
            'INSERT INTO profile_revisions("Revision ID","Profile ID","Revision number","Revision status","Public revision",'
            '"Revision fingerprint","Proposed by","Proposed on","Reviewed by","Reviewed on","Website request ID") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (f"rev-{number}", "p-1", number, status, '{"name":"x"}', FP(text or f"rev-{number}"), "Editor", NOW, *reviewed, request))
        self.db.commit()

    def overview(self):
        return tuple(self.db.execute('SELECT "Full name","County name","Roles","Role count","Sync state" FROM profiles_overview').fetchone())

    def test_overview_sync_states(self):
        self.populate()
        name, county, roles, count, state = self.overview()
        self.assertEqual((name, county, count, state), ("Synthetic Casey Example", "Routt", 2, "Confirmed"))
        self.assertIn("Synthetic Liaison (Synthetic Office)", roles)
        self.assertIn("Synthetic Division", roles)  # role r-1 has only a unit, so the unit name labels it
        self.revision(1, "approved")
        self.assertEqual(self.overview()[4], "Ready to sync")
        steps = [("req-pending", "Pending submission"), ("req-bad", "Ready to sync"), ("req-rev", "Ready to sync"), ("req-ok", "Synced")]
        for number, (request, expected) in enumerate(steps, start=2):
            self.db.execute("UPDATE profile_revisions SET \"Revision status\"='superseded' WHERE \"Revision status\"='approved'")
            self.revision(number, "approved", request)
            self.assertEqual(self.overview()[4], expected, request)
        # Any newer proposed edit returns the profile to review without disturbing the approved revision.
        self.revision(9, "proposed")
        self.assertEqual(self.overview()[4], "Changes to review")
        self.assertEqual(self.db.execute('SELECT "Approved revision" FROM profiles_overview').fetchone()[0], 5)

    def test_overview_requires_current_revision_and_matching_item_receipts(self):
        self.populate()
        self.revision(1, "approved", "req-ok")
        self.assertEqual(self.overview()[4], "Synced")
        self.db.execute("UPDATE website_change_receipts SET client_ref='other' WHERE submission_id='req-ok'")
        self.assertEqual(self.overview()[4], "Ready to sync")
        self.db.execute("UPDATE website_change_receipts SET client_ref='a' WHERE submission_id='req-ok'")
        self.db.execute("INSERT INTO website_request_changes(submission_id,item_index,client_ref,website_entity,request_item_json) "
                        "VALUES ('req-ok',1,'b','people','{}')")
        self.assertEqual(self.overview()[4], "Ready to sync")
        self.db.execute("DELETE FROM website_request_changes WHERE submission_id='req-ok' AND item_index=1")
        self.assertEqual(self.overview()[4], "Synced")
        self.revision(2, "rejected")
        self.assertEqual(self.overview()[4], "Confirmed")

    def test_approved_revision_is_immutable(self):
        self.populate()
        self.revision(1, "approved")
        for sql in ("UPDATE profile_revisions SET \"Public revision\"='{\"name\":\"y\"}'",
                    f"UPDATE profile_revisions SET \"Revision fingerprint\"='{FP('z')}'",
                    "UPDATE profile_revisions SET \"Revision ID\"='other'",
                    "UPDATE profile_revisions SET \"Review reason\"='other'",
                    "UPDATE profile_revisions SET \"Revision status\"='proposed'",
                    "DELETE FROM profile_revisions"):
            self.fails(sql, pattern="immutable|cannot be deleted")
        # The sending link may be recorded once, and supersession is allowed.
        with self.db:
            self.db.execute("UPDATE profile_revisions SET \"Website request ID\"='req-pending'")
        self.fails("UPDATE profile_revisions SET \"Website request ID\"='req-ok'", pattern="immutable")
        with self.db:
            self.db.execute("UPDATE profile_revisions SET \"Revision status\"='superseded'")
        for sql in ("UPDATE profile_revisions SET \"Public revision\"='{}'",
                    "UPDATE profile_revisions SET \"Revision status\"='approved'",
                    "DELETE FROM profile_revisions WHERE \"Revision ID\"='rev-1'"):
            self.fails(sql, pattern="immutable|cannot be deleted")
        self.fails("INSERT OR REPLACE INTO profile_revisions(\"Revision ID\",\"Profile ID\",\"Revision number\",\"Public revision\","
                   "\"Revision fingerprint\",\"Proposed by\",\"Proposed on\") "
                   "VALUES ('dup','p-1',1,'{}',?, 'E', ?)", (FP("q"), NOW), "immutable")
        self.revision(2, "proposed")
        self.fails("UPDATE OR REPLACE profile_revisions SET \"Revision number\"=1 WHERE \"Revision ID\"='rev-2'",
                   pattern="immutable")


if __name__ == "__main__":
    unittest.main()

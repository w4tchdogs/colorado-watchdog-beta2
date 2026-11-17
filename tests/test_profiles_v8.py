"""Synthetic populated v7 upgrade and private Website review projection."""

import hashlib
import json
import sqlite3
import unittest

from research.db import connect, migrate, validate_database
from tests.test_profiles_v7 import NOW, all_rows, promote, seed_research


class ReviewGridCase(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db, through_version=7)
        seed_research(self.db)
        promote(self.db)
        with self.db:
            self.db.execute('INSERT INTO county_research_unit_structure('
                            '"Office or unit ID","County code","Office or unit label as published","Organization type") '
                            "VALUES ('u-pw','08107','Public Works','department')")
            for unit, name, parent, kind in [('u-road', 'Road and Bridge', 'u-pw', 'division'),
                                             ('u-fleet', 'Fleet Services', 'u-road', 'subunit'),
                                             ('u-group', 'Directory grouping', 'u-pw', 'navigation'),
                                             ('u-unresolved', 'Unresolved Team', 'u-pw', 'subunit')]:
                self.db.execute('INSERT INTO county_research_unit_structure('
                                '"Office or unit ID","County code","Office or unit label as published",'
                                '"Organization type","Parent office or unit","Relationship to parent",'
                                '"Evidence for parent relationship") VALUES (?,?,?,?,?,?,?)',
                                (unit, '08107', name, kind, parent,
                                 'navigation' if unit == 'u-group' else 'administrative', 'ev-3'))
            for unit, name, parent, kind, research in [
                ('cu-pw', 'Public Works', None, 'department', 'u-pw'),
                ('cu-road', 'Road and Bridge', 'cu-pw', 'division', 'u-road'),
                ('cu-fleet', 'Fleet Services', 'cu-road', 'subunit', 'u-fleet'),
                ('cu-group', 'Directory grouping', 'cu-pw', 'navigation', 'u-group'),
                ('cu-unresolved', 'Unresolved Team', None, 'subunit', 'u-unresolved')]:
                self.db.execute('INSERT INTO profile_county_unit VALUES (?,?,?,?,?,?,?,?,?)',
                                (unit, '08107', name, kind, research, parent, 'ev-3', 'R', NOW))
            for role_id, unit, office, title, duties in [
                ('r-pw', 'cu-pw', None, 'Director', 'Directs public works'),
                ('r-fleet', 'cu-fleet', None, 'Supervisor', 'Manages fleet'),
                ('r-unresolved', 'cu-unresolved', None, 'Coordinator', None),
                ('r-group', 'cu-group', None, 'Member', None),
                ('r-office', None, 'County Clerk', None, None),
                ('r-duties', None, None, None, 'Processes public records')]:
                self.db.execute('INSERT INTO profile_role('
                                '"Role ID","Profile ID","County code","County unit ID",'
                                '"Office or department","Position title","Job description or duties") '
                                'VALUES (?,?,?,?,?,?,?)',
                                (role_id, 'p-1', '08107', unit, office, title, duties))
            self.db.execute('INSERT INTO profile_evidence_citation VALUES (?,?,?,?,?,?,?,?)',
                            ('cit', 'pe-p-1', 'src', 'https://example.invalid/routt/staff',
                             'Private citation title', 'official', 'directory', '2026-11-16'))
            self.db.execute('INSERT INTO profile_revisions('
                            '"Revision ID","Profile ID","Revision number","Revision status",'
                            '"Public revision","Revision fingerprint","Proposed by","Proposed on",'
                            '"Reviewed by","Reviewed on","Website request ID") '
                            'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                            ('rev-v7', 'p-1', 1, 'approved', '{"legacy":"snapshot"}',
                             hashlib.sha256(b'v7 revision').hexdigest(), 'Editor', NOW,
                             'Reviewer', NOW, 'req-ok'))
            self.db.execute('INSERT INTO website_update_approvals VALUES (?,?,?,?,?,?,?,?,?,?)',
                            ('approval-v7', 'site', 'role_claim', 'c-1', '{}', 1,
                             'ev-1', 'approved', NOW, None))
        self.before = all_rows(self.db)
        self.before_schema = list(self.db.execute('SELECT name,sha256 FROM schema_migrations ORDER BY name'))
        migrate(self.db)

    def tearDown(self):
        self.db.close()

    def rows(self):
        return list(self.db.execute('SELECT * FROM profiles_website_review'))

    def test_populated_upgrade_and_grid(self):
        after = all_rows(self.db)
        for table, rows in self.before.items():
            if table == 'profile':
                self.assertEqual([row[:6] for row in after[table]], rows)
                self.assertTrue(all(row[6:] == (None, None, None, None) for row in after[table]))
            elif table != 'schema_migrations':
                self.assertEqual(after[table], rows, table)
        self.assertEqual([tuple(r) for r in self.db.execute(
            'SELECT name,sha256 FROM schema_migrations ORDER BY name')][:-1],
            [tuple(r) for r in self.before_schema])
        self.assertEqual(validate_database(self.db),
                         {'integrity': 'ok', 'foreign_keys': [], 'schema_version': 8})
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_alternate_name').fetchone()[0], 0)
        self.assertEqual(len(self.rows()), 6)
        row = {r['Position']: r for r in self.rows()}
        self.assertEqual((row['Director']['County Unit'], row['Director']['County Sub Unit']),
                         ('Public Works', ''))
        self.assertEqual((row['Supervisor']['County Unit'], row['Supervisor']['County Sub Unit']),
                         ('Public Works', 'Road and Bridge › Fleet Services'))
        self.assertEqual((row['Coordinator']['County Unit'], row['Coordinator']['County Sub Unit']),
                         ('Unresolved Team', ''))
        self.assertEqual((row['Member']['County Unit'], row['Member']['County Sub Unit']),
                         ('Public Works', 'Grouped under: Directory grouping'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM profiles_website_review '
                                         'WHERE "County Unit"="County Clerk" AND "County Sub Unit"=""').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM profiles_website_review '
                                         'WHERE "Role"="Processes public records" AND "Position"=""').fetchone()[0], 1)
        self.assertTrue(all(r['First Name'] == '' and r['Date Reviewed'] is None for r in self.rows()))
        self.assertFalse(any('Private citation' in str(tuple(r)) or 'example.invalid' in str(tuple(r))
                             for r in self.rows()))
        self.assertEqual([d[0] for d in self.db.execute('SELECT * FROM profiles_website_review').description],
                         ['First Name', 'Middle Name', 'Last Name', 'Alternate Name 1', 'Alternate Name 2',
                          'County', 'County Unit', 'County Sub Unit', 'Position', 'Role', 'Date Reviewed'])

    def test_verified_names_order_and_matching_approval(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'evidence'):
            self.db.execute('UPDATE profile SET "First Name"="Casey"')
        with self.db:
            self.db.execute('UPDATE profile SET "First Name"=?,"Middle Name"=?,"Last Name"=?,'
                            '"Name components evidence ID"=? WHERE "Profile ID"=?',
                            ('Casey', 'Q.', 'Example', 'pe-p-1', 'p-1'))
            for key, name, order in [('a3', 'C. Example', 3), ('a1', 'Casey Example', 1),
                                     ('a2', 'C. Q. Example', 2)]:
                self.db.execute('INSERT INTO profile_alternate_name VALUES (?,?,?,?,?,?)',
                                (key, 'p-1', name, 'pe-p-1', order, NOW))
        self.assertEqual(self.db.execute('SELECT "Full name" FROM profile').fetchone()[0],
                         'Synthetic Casey Example')
        self.assertEqual((self.rows()[0]['Alternate Name 1'], self.rows()[0]['Alternate Name 2']),
                         ('Casey Example', 'C. Q. Example'))
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'evidence'):
            self.db.execute('INSERT INTO profile_alternate_name VALUES (?,?,?,?,?,?)',
                            ('bad', 'p-1', 'Unsupported', 'missing', 4, NOW))
        self.db.rollback()
        snapshot = []
        details = {('Director', 'Directs public works'): 'r-pw',
                   ('Supervisor', 'Manages fleet'): 'r-fleet',
                   ('Coordinator', ''): 'r-unresolved', ('Member', ''): 'r-group',
                   ('', ''): 'r-office', ('', 'Processes public records'): 'r-duties'}
        for row in self.rows():
            role_id = details[(row['Position'], row['Role'])]
            snapshot.append(dict(role_id=role_id, county_code='08107', county=row['County'], first_name=row['First Name'],
                                 middle_name=row['Middle Name'], last_name=row['Last Name'],
                                 alternate_name_1=row['Alternate Name 1'], alternate_name_2=row['Alternate Name 2'],
                                 county_unit=row['County Unit'], county_sub_unit=row['County Sub Unit'],
                                 position=row['Position'], role=row['Role']))
        public_revision = json.dumps({'website_review': {'roles': snapshot}})
        fingerprint = hashlib.sha256(public_revision.encode()).hexdigest()
        with self.db:
            self.db.execute('INSERT INTO profile_revisions('
                            '"Revision ID","Profile ID","Revision number","Revision status",'
                            '"Public revision","Revision fingerprint","Proposed by","Proposed on",'
                            '"Reviewed by","Reviewed on") VALUES (?,?,?,?,?,?,?,?,?,?)',
                            ('rev-approved', 'p-1', 2, 'approved', public_revision, fingerprint,
                             'Editor', NOW, 'Reviewer', '2026-11-18T10:00:00+00:00'))
        self.assertTrue(all(r['Date Reviewed'] == '2026-11-18' for r in self.rows()))
        with self.db:
            self.db.execute('UPDATE profile_role SET "Job description or duties"=? WHERE "Role ID"=?',
                            ('Manages vehicle fleet', 'r-fleet'))
            self.db.execute('INSERT INTO profile_revisions('
                            '"Revision ID","Profile ID","Revision number","Public revision",'
                            '"Revision fingerprint","Proposed by","Proposed on") VALUES (?,?,?,?,?,?,?)',
                            ('rev-draft', 'p-1', 3, '{}', hashlib.sha256(b'draft').hexdigest(), 'Editor', NOW))
        dates = [r['Date Reviewed'] for r in self.rows()]
        self.assertEqual(dates.count(None), 1)
        self.assertEqual(dates.count('2026-11-18'), 5)
        self.assertEqual(validate_database(self.db)['foreign_keys'], [])


if __name__ == '__main__':
    unittest.main()

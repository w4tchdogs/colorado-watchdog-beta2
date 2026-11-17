"""Interim hosted batch sizing and sequential multi-batch submission, with synthetic records only."""

import io
import json
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from research import __main__ as cli
from research import sync
from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv
from research.submission import get_submission, submit_prepared
from research.sync import (
    build_hosted_changeset,
    classify_workload,
    prepare_research_submission,
    reconcile_submission,
)
from tests.research_fixtures import csv_bytes, observation

SITE = "synthetic-hosted-batching-site"
COUNTY = "08001"


def seed(db, claims=12, people=8, sources=3, county=COUNTY):
    """Claims beyond `people` reuse an earlier person, so later batches reference existing records."""
    db.executemany("INSERT OR IGNORE INTO counties VALUES (?,?)", [(county, COUNTIES[county])])
    db.commit()
    payload = csv_bytes([observation(county, full_name=f"Synthetic Person {county} {i % people}",
                                     source_url=f"https://example.invalid/{county}/source-{i % sources}")
                         for i in range(claims)])
    batch = ingest_csv(db, payload, file_name=f"hosted-{county}.csv", version_label=f"hosted-{county}",
                       provenance="synthetic", selected=True)
    rows = list(db.execute(
        'SELECT c."Role claim ID" AS id,c."Evidence record ID" AS evidence_id,e."Source ID" AS source_id '
        'FROM role_claims c JOIN evidence_links e ON e."Evidence record ID"=c."Evidence record ID" '
        'WHERE e."Import batch ID"=? ORDER BY c."Role claim ID"', (batch,)))
    for source_id in {row["source_id"] for row in rows}:
        db.execute("UPDATE sources SET \"Previous source category\"='official',\"Publisher type\"='official',"
                   "\"Document type\"='official_page' WHERE \"Source ID\"=?", (source_id,))
    seen = set()
    for index, row in enumerate(rows):
        db.execute('UPDATE evidence_links SET "Source title as observed"=? WHERE "Evidence record ID"=?',
                   (f"Synthetic source {row['source_id']}", row["evidence_id"]))
        profile = f"person-hosted-{county}-{index % people}"
        if profile not in seen:
            seen.add(profile)
            db.execute('INSERT INTO research_people("Profile ID","County code","Full name","Identity review status",'
                       '"Evidence for identity") VALUES(?,?,?,\'evidence_supported\',?)',
                       (profile, county, f"Synthetic Person {county} {index % people}", row["evidence_id"]))
        db.execute('UPDATE role_claims SET "Linked profile"=?,"Office or department as published"=? '
                   'WHERE "Role claim ID"=?', (profile, f"Synthetic Office {index}", row["id"]))
    db.commit()


def receipt_transport(log=None, fail_first=False):
    """A fake Website that echoes a committed receipt for the exact request it receives."""
    state = {"calls": 0, "committed": {}}

    def transport(_site, _path, headers, body):
        state["calls"] += 1
        key = headers["idempotency-key"]
        if fail_first and state["calls"] == 1:
            raise TimeoutError("synthetic timeout")
        if key not in state["committed"]:
            request = json.loads(body)
            state["committed"][key] = {
                "status": "committed", "batchId": f"synthetic-batch-{len(state['committed']) + 1}",
                "items": [{"itemIndex": index, "clientRef": change.get("clientRef"), "entity": change["entity"],
                           "websiteId": str(uuid.uuid4()), "version": 1, "outcome": "created"}
                          for index, change in enumerate(request["changes"])]}
            if log is not None:
                log.append(request)
        return 200, json.dumps(state["committed"][key]).encode()

    transport.state = state
    return transport


class ClassifyTests(unittest.TestCase):
    def change(self, op, entity, **fields):
        return {"op": op, "entity": entity, "clientRef": "x", "fields": fields}

    def test_references_inside_the_request_are_self_contained(self):
        request = {"changes": [
            self.change("create_person", "people", display_name="Synthetic"),
            self.change("create_person_role", "person_roles", person_ref="p", source_ref="s", county_fips="08001"),
        ]}
        self.assertEqual(classify_workload(request), "self_contained")

    def test_any_existing_record_reference_is_reference_heavy(self):
        for field in ("person_id", "source_id", "position_id", "organization_id", "parent_organization_id"):
            request = {"changes": [self.change("create_person_role", "person_roles", **{field: "existing"})]}
            self.assertEqual(classify_workload(request), "reference_heavy", field)

    def test_updates_and_unrecognised_work_is_unknown_so_the_lower_default_applies(self):
        for changes in (
            [{"op": "update_record", "entity": "people", "targetId": "t", "expectedVersion": 1, "fields": {}}],
            [{"op": "create_person", "entity": "organizations", "fields": {}}],
            [{"op": "mystery", "entity": "people", "fields": {}}],
            ["not an object"],
            [{"op": "create_person", "entity": "people", "fields": "bad"}],
        ):
            self.assertEqual(classify_workload({"changes": changes}), "unknown")
        self.assertEqual(classify_workload({}), "unknown")
        self.assertEqual(classify_workload(None), "unknown")


class HostedBatchingTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        seed(self.db)

    def tearDown(self):
        self.db.close()

    def test_defaults_are_the_documented_interim_values(self):
        self.assertEqual(sync.HOSTED_MAX_CHANGES_SELF_CONTAINED, 260)
        self.assertEqual(sync.HOSTED_MAX_CHANGES_REFERENCE_HEAVY, 100)

    def test_local_planning_keeps_no_count_cap(self):
        generated = sync.build_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertFalse(generated["truncated"])
        self.assertNotIn("batching", generated)

    def test_a_self_contained_first_changeset_gets_the_larger_cap(self):
        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 12), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            generated = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
        batching = generated["batching"]
        self.assertEqual(batching["workload"], "self_contained")
        self.assertEqual(batching["max_changes"], 12)
        self.assertLessEqual(generated["eligible_count"], 12)
        self.assertTrue(batching["more_batches_expected"])
        self.assertTrue(batching["each_changeset_is_atomic"])
        self.assertTrue(batching["partial_completion_possible_between_commits"])

    def test_multi_batch_run_follows_dependency_order_without_duplicate_operations(self):
        sent = []
        transport = receipt_transport(sent)
        seen_locals = []
        workloads = []
        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 12), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            for number in range(1, 30):
                generated = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
                if not generated["request"]["changes"]:
                    break
                batching = generated["batching"]
                workloads.append((batching["workload"], generated["eligible_count"], batching["max_changes"]))
                self.assertLessEqual(generated["eligible_count"], batching["max_changes"])
                seen_locals += [(item["local_entity_type"], item["local_entity_id"])
                                for item in generated["items"] if item["local_entity_type"]]
                prepared = prepare_research_submission(self.db, SITE, f"batch-{number}", generated)
                result = submit_prepared(self.db, prepared["submission_id"], transport)
                self.assertEqual(result["state"], "acknowledged")
                self.assertEqual(reconcile_submission(self.db, prepared["submission_id"])["state"], "committed")
            else:
                self.fail("The import did not finish")
        self.assertEqual(len(seen_locals), len(set(seen_locals)), "an operation was planned twice")
        by_entity = {}
        for request in sent:
            for change in request["changes"]:
                by_entity[change["entity"]] = by_entity.get(change["entity"], 0) + 1
        self.assertEqual(by_entity["person_roles"], 12)
        self.assertEqual(by_entity["people"], 8)
        self.assertEqual(by_entity["role_sources"], 3)
        kinds = {kind for kind, _count, _limit in workloads}
        self.assertEqual(kinds, {"self_contained", "reference_heavy"}, "a mixed workload uses both sizes")
        # A role in a later batch refers to the person already created, by Website ID.
        later_fields = [change["fields"] for request in sent[1:] for change in request["changes"]
                        if change["entity"] == "person_roles"]
        self.assertTrue(any("person_id" in fields for fields in later_fields))
        for kind, count, limit in workloads:
            if kind == "reference_heavy":
                self.assertLessEqual(count, 5)

    def test_the_next_changeset_waits_for_the_previous_receipt_and_reconciliation(self):
        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 9), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            first = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
            prepared = prepare_research_submission(self.db, SITE, "first", first)
            # Prepared but never sent: its outcome is not known to be anything yet.
            sid = prepared["submission_id"]
            self.assertEqual(get_submission(self.db, sid)["state"], "pending")
            second = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
            self.assertEqual(second["request"]["changes"], first["request"]["changes"],
                             "nothing is mapped yet, so the same work is planned")
            with self.assertRaisesRegex(ValueError, "uncertain outcome"):
                prepare_research_submission(self.db, SITE, "second", second)
            # Repeating the same key stays idempotent.
            again = prepare_research_submission(self.db, SITE, "first", first)
            self.assertEqual(again, {"submission_id": sid, "created": False})

    def test_an_interrupted_submission_resolves_by_retrying_the_same_key(self):
        transport = receipt_transport(fail_first=True)
        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 9), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            first = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
            prepared = prepare_research_submission(self.db, SITE, "first", first)
            sid = prepared["submission_id"]
            self.assertEqual(submit_prepared(self.db, sid, transport)["state"], "uncertain")
            with self.assertRaisesRegex(ValueError, "retry the exact prepared request"):
                reconcile_submission(self.db, sid)
            with self.assertRaisesRegex(ValueError, "uncertain outcome"):
                prepare_research_submission(self.db, SITE, "second", first)
            # The same stored request and key resolve it, and the Website replays one batch.
            self.assertEqual(submit_prepared(self.db, sid, transport)["state"], "acknowledged")
            self.assertEqual(len(transport.state["committed"]), 1)
            with self.assertRaisesRegex(ValueError, "not reconciled"):
                prepare_research_submission(self.db, SITE, "second", first)
            reconcile_submission(self.db, sid)
            second = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
            self.assertNotEqual(second["request"]["changes"], first["request"]["changes"])
            planned_before = {(i["local_entity_type"], i["local_entity_id"]) for i in first["items"]}
            planned_after = {(i["local_entity_type"], i["local_entity_id"]) for i in second["items"]}
            self.assertFalse(planned_before & planned_after - {(None, None)}, "continuation repeats nothing")
            prepare_research_submission(self.db, SITE, "second", second)

    def test_a_rejected_submission_maps_nothing_and_does_not_block_the_next(self):
        def reject(*_args):
            return 422, json.dumps({"status": "rejected"}).encode()

        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 9), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            first = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
            prepared = prepare_research_submission(self.db, SITE, "first", first)
            self.assertEqual(submit_prepared(self.db, prepared["submission_id"], reject)["state"], "rejected")
            again = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
            self.assertEqual(again["request"]["changes"], first["request"]["changes"])
            prepare_research_submission(self.db, SITE, "second", again)

    def test_an_unclassifiable_changeset_gets_the_lower_default(self):
        unknown = {"changes": [{"op": "update_record", "entity": "people", "targetId": "t",
                                "expectedVersion": 1, "fields": {"display_name": "x"}}]}
        real = sync.build_changeset

        def build(db, site_key, **kwargs):
            result = real(db, site_key, **kwargs)
            if kwargs.get("max_changes") == sync.HOSTED_MAX_CHANGES_SELF_CONTAINED:
                result["request"] = {**result["request"], "changes": unknown["changes"]}
            return result

        with patch.object(sync, "build_changeset", side_effect=build):
            generated = build_hosted_changeset(self.db, SITE, county_fips=COUNTY)
        self.assertEqual(generated["batching"]["workload"], "unknown")
        self.assertEqual(generated["batching"]["max_changes"], sync.HOSTED_MAX_CHANGES_REFERENCE_HEAVY)


class HostedCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name, "fictional.sqlite")
        self.db = connect(self.path)
        migrate(self.db)
        seed(self.db)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def run_command(self, command, **kwargs):
        return cli._sync_command(SimpleNamespace(command=command, database=self.path, **kwargs), self.path)

    def test_hosted_preview_reports_the_batching_and_prepare_matches_its_fingerprint(self):
        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 9), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            preview, _ = self.run_command("sync-preview", site_key=SITE, max_changes=None,
                                          county_fips=COUNTY, hosted=True)
            self.assertEqual(preview["batching"]["max_changes"], 9)
            self.assertTrue(preview["truncated"])
            prepared, _ = self.run_command("sync-prepare", site_key=SITE, idempotency_key="first",
                                           select="all", expect_fingerprint=preview["changeset_fingerprint"],
                                           max_changes=None, hosted=True)
            self.assertEqual(prepared["status"], "prepared")
            self.assertEqual(prepared["change_count"], preview["planned_operations"])

    def test_hosted_cannot_be_combined_with_an_explicit_limit(self):
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            self.run_command("sync-preview", site_key=SITE, max_changes=50, county_fips=COUNTY, hosted=True)

    def test_without_the_flag_the_local_preview_has_no_count_cap_and_no_batching_note(self):
        preview, _ = self.run_command("sync-preview", site_key=SITE, max_changes=None, county_fips=COUNTY)
        self.assertNotIn("batching", preview)
        self.assertFalse(preview["truncated"])


OTHER_COUNTY = "08003"


class CountyScopedCliTests(unittest.TestCase):
    """sync-prepare rebuilds the same county scope that sync-preview reviewed."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name, "fictional.sqlite")
        db = connect(self.path)
        migrate(db)
        seed(db, claims=4, people=3, sources=2, county=COUNTY)
        seed(db, claims=3, people=2, sources=1, county=OTHER_COUNTY)
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            status = cli.main([argv[0], str(self.path), *argv[1:]])
        return status, json.loads(out.getvalue())

    def prepare(self, key, fingerprint, *extra):
        return self.cli("sync-prepare", "--site-key", SITE, "--idempotency-key", key,
                        "--select", "all", "--expect-fingerprint", fingerprint, *extra)

    def test_county_preview_and_prepare_share_one_scope_and_exclude_other_counties(self):
        status, statewide = self.cli("sync-preview", "--site-key", SITE)
        self.assertEqual(status, 0)
        self.assertIn(f"/{OTHER_COUNTY}/", json.dumps(statewide["request"]))
        status, county = self.cli("sync-preview", "--site-key", SITE, "--county-fips", COUNTY, "--hosted")
        self.assertEqual(status, 0)
        self.assertNotEqual(county["changeset_fingerprint"], statewide["changeset_fingerprint"])
        text = json.dumps(county["request"])
        self.assertIn(f"/{COUNTY}/", text)
        self.assertNotIn(f"/{OTHER_COUNTY}/", text)
        self.assertNotIn(f"Synthetic Person {OTHER_COUNTY}", text)

        # Without the scope, prepare rebuilds statewide and refuses the county fingerprint.
        status, refused = self.prepare("county-1", county["changeset_fingerprint"], "--hosted")
        self.assertEqual(status, 2)
        self.assertIn("differs from the reviewed preview", json.dumps(refused))

        status, prepared = self.prepare("county-1", county["changeset_fingerprint"],
                                        "--county-fips", COUNTY, "--hosted")
        self.assertEqual(status, 0, prepared)
        self.assertEqual(prepared["county_fips"], COUNTY)
        self.assertEqual(prepared["changeset_fingerprint"], county["changeset_fingerprint"])
        self.assertEqual(prepared["change_count"], county["planned_operations"])
        db = connect(self.path)
        try:
            stored = db.execute("SELECT request_json FROM sync_submissions WHERE id=?",
                                (prepared["submission_id"],)).fetchone()[0]
            claim_counties = {row[0] for row in db.execute(
                'SELECT c."County code" FROM sync_submission_items i JOIN role_claims c '
                'ON c."Role claim ID"=i.claim_id WHERE i.submission_id=?', (prepared["submission_id"],))}
        finally:
            db.close()
        self.assertEqual(json.loads(stored), county["request"])
        self.assertEqual(claim_counties, {COUNTY})

    def test_statewide_preview_and_prepare_are_unchanged_without_the_option(self):
        status, statewide = self.cli("sync-preview", "--site-key", SITE)
        self.assertEqual(status, 0)
        status, prepared = self.prepare("statewide-1", statewide["changeset_fingerprint"])
        self.assertEqual(status, 0, prepared)
        self.assertIsNone(prepared["county_fips"])
        self.assertEqual(prepared["change_count"], statewide["planned_operations"])

    def test_a_scope_that_is_not_a_canonical_fips_is_refused(self):
        status, _ = self.prepare("bad", "0" * 64, "--county-fips", "8001")
        self.assertEqual(status, 2)


class ConcurrentPrepareTests(unittest.TestCase):
    """The unresolved-submission guard and the insert share one SQLite write transaction."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name, "fictional.sqlite")
        db = connect(self.path)
        migrate(db)
        seed(db)
        with patch.object(sync, "HOSTED_MAX_CHANGES_SELF_CONTAINED", 9), \
                patch.object(sync, "HOSTED_MAX_CHANGES_REFERENCE_HEAVY", 5):
            self.generated = build_hosted_changeset(db, SITE, county_fips=COUNTY)
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_two_connections_with_different_keys_cannot_both_leave_a_submission_unresolved(self):
        first = connect(self.path)
        real_guard = sync.require_previous_submission_resolved
        started, errors, results = threading.Event(), [], {}

        def prepare_second():
            second = connect(self.path)
            try:
                results["second"] = prepare_research_submission(second, SITE, "key-b", self.generated)
            except Exception as error:  # recorded so the assertion shows any unexpected failure
                errors.append(f"{type(error).__name__}: {error}")
            finally:
                second.close()

        worker = threading.Thread(target=prepare_second)

        def guard_then_let_the_other_connection_race(conn, site_key, key):
            real_guard(conn, site_key, key)
            if key == "key-a" and not started.is_set():
                started.set()
                worker.start()
                # The second connection would pass a guard run outside this transaction now.
                time.sleep(0.5)

        try:
            with patch.object(sync, "require_previous_submission_resolved",
                              side_effect=guard_then_let_the_other_connection_race):
                results["first"] = prepare_research_submission(first, SITE, "key-a", self.generated)
                worker.join(10)
            self.assertFalse(worker.is_alive())
            self.assertTrue(results["first"]["created"])
            self.assertNotIn("second", results)
            self.assertEqual(len(errors), 1, errors)
            self.assertTrue(errors[0].startswith("ValueError"), errors)
            self.assertIn("uncertain outcome", errors[0])
            unresolved = first.execute(
                "SELECT count(*) FROM sync_submissions WHERE site_key=? AND state IN ('pending','acknowledged')",
                (SITE,)).fetchone()[0]
            self.assertEqual(unresolved, 1)
            again = prepare_research_submission(first, SITE, "key-a", self.generated)
            self.assertEqual(again, {"submission_id": results["first"]["submission_id"], "created": False})
        finally:
            first.close()

    def test_a_mismatched_request_under_an_existing_key_is_still_rejected(self):
        db = connect(self.path)
        try:
            prepare_research_submission(db, SITE, "key-a", self.generated)
            other = json.loads(json.dumps(self.generated))
            other["request"]["changes"] = other["request"]["changes"][:1]
            with self.assertRaises(Exception) as caught:
                prepare_research_submission(db, SITE, "key-a", other)
            self.assertIn("different request", str(caught.exception))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()

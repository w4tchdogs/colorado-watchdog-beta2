"""Interim hosted batch sizing and sequential multi-batch submission, with synthetic records only."""

import json
import tempfile
import unittest
import uuid
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


def seed(db, claims=12, people=8, sources=3):
    """Claims beyond `people` reuse an earlier person, so later batches reference existing records."""
    db.executemany("INSERT INTO counties VALUES (?,?)", [(COUNTY, COUNTIES[COUNTY])])
    db.commit()
    payload = csv_bytes([observation(COUNTY, full_name=f"Synthetic Person {i % people}",
                                     source_url=f"https://example.invalid/{COUNTY}/source-{i % sources}")
                         for i in range(claims)])
    batch = ingest_csv(db, payload, file_name="hosted.csv", version_label="hosted",
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
        profile = f"person-hosted-{index % people}"
        if profile not in seen:
            seen.add(profile)
            db.execute('INSERT INTO research_people("Profile ID","County code","Full name","Identity review status",'
                       '"Evidence for identity") VALUES(?,?,?,\'evidence_supported\',?)',
                       (profile, COUNTY, f"Synthetic Person {index % people}", row["evidence_id"]))
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


if __name__ == "__main__":
    unittest.main()

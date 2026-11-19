"""Synthetic coverage for update_record receipts in the R6 backed Website MCP driver.

The Website commit response omits clientRef on an item whose request carried none,
while the persisted batch item returned by paged lookup carries the default
item-N reference. These tests keep exact matching for every other receipt field.
"""

import copy
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from research import mcp_sync_driver, submission, sync
from research.db import connect, migrate
from research.mapping import canonical_json
from research.submission import export_prepared_request, get_submission


SITE = "synthetic-update-site"
KEY = "synthetic-update-receipt-key"
REQUEST_ID = "0f6f6b02-7d0f-4c7e-9a52-3f1c8f0c5b11"


def change_for(kind, index):
    if kind == "create":
        return {
            "op": "create_person",
            "entity": "people",
            "clientRef": f"synthetic-person-{index}",
            "fields": {"display_name": f"Synthetic Person {index}"},
        }
    return {
        "op": "update_record",
        "entity": "people",
        "targetId": f"synthetic-website-person-{index}",
        "expectedVersion": 1,
        "fields": {"display_name": f"Synthetic Updated Person {index}"},
    }


def prepared_fixture(db, directory, kinds):
    changes = [change_for(kind, index) for index, kind in enumerate(kinds)]
    generated = {
        "request": {
            "contractVersion": "m2-sync/v1",
            "requestId": REQUEST_ID,
            "intent": "commit",
            "changes": changes,
        },
        "items": [
            {
                "item_index": index,
                # The R8 generator records item-N for update_record items.
                "client_ref": change.get("clientRef", f"item-{index}"),
                "website_entity": "people",
                "local_entity_type": None,
                "local_entity_id": None,
                "evidence_id": None,
                "claim_id": None,
                "request_item_json": canonical_json(change),
            }
            for index, change in enumerate(changes)
        ],
    }
    prepared = sync.prepare_research_submission(db, SITE, KEY, generated)
    request_file = Path(directory, "prepared-synthetic-update.json")
    export_prepared_request(db, prepared["submission_id"], request_file)
    return prepared["submission_id"], request_file, request_file.read_bytes()


class FakeServer:
    def __init__(self):
        self.batch_create_count = 0
        self.created = False


class UpdateReceiptClient:
    """Fake Website MCP client that mirrors the real commit versus lookup shapes."""

    def __init__(self, request_bytes, kinds, *, server=None, lose_first_commit=False):
        self.request_bytes = request_bytes
        self.kinds = kinds
        self.server = server or FakeServer()
        self.lose_first_commit = lose_first_commit
        self.lost = False
        self.commit_calls = []
        self.tool_calls = []
        self.batch_id = "synthetic-update-batch-1"
        self.committed_at = "2026-11-18T12:00:00Z"
        # Persisted items, as paged lookup returns them (default item-N refs).
        self.lookup_items = []
        # Commit response items, as the Website returns them (no ref for updates).
        self.commit_items = []
        for index, kind in enumerate(kinds):
            if kind == "create":
                item = {
                    "itemIndex": index,
                    "clientRef": f"synthetic-person-{index}",
                    "entity": "people",
                    "websiteId": f"synthetic-created-person-{index}",
                    "version": 1,
                    "outcome": "created",
                }
                self.lookup_items.append(item)
                self.commit_items.append(dict(item))
            else:
                item = {
                    "itemIndex": index,
                    "clientRef": f"item-{index}",
                    "entity": "people",
                    "websiteId": f"synthetic-website-person-{index}",
                    "version": 2,
                    "outcome": "updated",
                }
                self.lookup_items.append(item)
                self.commit_items.append(
                    {key: value for key, value in item.items() if key != "clientRef"}
                )

    def counts(self):
        return dict(Counter(f"{item['entity']}:{item['outcome']}" for item in self.lookup_items))

    def discover_and_check_tools(self):
        return None

    def ensure_commit_fits(self, idempotency_key, request_bytes):
        if request_bytes != self.request_bytes:
            raise AssertionError("Driver validated different prepared bytes")

    def call_tool(self, name, arguments):
        self.tool_calls.append((name, arguments))
        if name == "website_sync_dry_run":
            return {"eligible": True, "itemCount": len(self.lookup_items), "errors": []}
        if name == "website_sync_lookup":
            limit = arguments["itemLimit"]
            offset = arguments["itemOffset"]
            page = self.lookup_items[offset : offset + limit]
            more = offset + len(page) < len(self.lookup_items)
            return {
                "status": "committed",
                "batchId": self.batch_id,
                "committedAt": self.committed_at,
                "reversedAt": None,
                "itemCount": len(self.lookup_items),
                "counts": self.counts(),
                "itemOffset": offset,
                "items": page,
                "nextItemOffset": offset + len(page) if more else None,
            }
        raise AssertionError(f"Unexpected tool: {name}")

    def commit_raw(self, idempotency_key, request_bytes):
        self.commit_calls.append((idempotency_key, request_bytes))
        if request_bytes != self.request_bytes:
            raise AssertionError("Driver did not pass the exact prepared bytes")
        replayed = self.server.created
        if not self.server.created:
            self.server.created = True
            self.server.batch_create_count += 1
        result = {
            "status": "committed",
            "batchId": self.batch_id,
            "requestId": REQUEST_ID,
            "committedAt": self.committed_at,
            "replayed": replayed,
            "itemCount": len(self.commit_items),
            "counts": self.counts(),
            "items": self.commit_items[:100],
        }
        if self.lose_first_commit and not self.lost:
            self.lost = True
            raise OSError("synthetic response lost after server commit")
        complete = mcp_sync_driver.McpHttpClient._complete_receipt(
            self, result, expected_request_id=REQUEST_ID
        )
        return 200, json.dumps(complete).encode("utf-8")


class UpdateReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dbs = []

    def tearDown(self):
        for db in self.dbs:
            db.close()
        self.temp.cleanup()

    def prepare(self, kinds, name="profiles-synthetic.sqlite"):
        db = connect(str(Path(self.temp.name, name)))
        self.dbs.append(db)
        migrate(db)
        directory = Path(self.temp.name, name + ".dir")
        directory.mkdir()
        sid, request_file, request_bytes = prepared_fixture(db, directory, kinds)
        return db, sid, request_file, request_bytes

    def assert_acknowledged_and_reconciled(self, db, sid, result, kinds):
        self.assertEqual(result["state"], "acknowledged")
        self.assertEqual(result["item_count"], len(kinds))
        receipt = get_submission(db, sid)["response"]
        self.assertEqual([item["itemIndex"] for item in receipt["items"]], list(range(len(kinds))))
        for index, (kind, item) in enumerate(zip(kinds, receipt["items"])):
            # The stored receipt is the persisted lookup view.
            expected = f"synthetic-person-{index}" if kind == "create" else f"item-{index}"
            self.assertEqual(item["clientRef"], expected)
        self.assertEqual(sync.reconcile_submission(db, sid)["state"], "committed")
        rows = list(
            db.execute(
                "SELECT item_index,client_ref,outcome,status FROM website_change_receipts "
                "WHERE submission_id=? ORDER BY item_index",
                (sid,),
            )
        )
        self.assertEqual(len(rows), len(kinds))
        for row, kind in zip(rows, kinds):
            self.assertEqual(row["status"], "committed")
            self.assertEqual(row["outcome"], "created" if kind == "create" else "updated")

    def assert_unacknowledged(self, db, sid, result):
        self.assertEqual(result["state"], "uncertain")
        record = get_submission(db, sid)
        self.assertEqual(record["state"], "pending")
        self.assertIsNone(record.get("response"))
        self.assertEqual(
            db.execute(
                "SELECT count(*) FROM website_request_receipts WHERE submission_id=?", (sid,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            db.execute(
                "SELECT count(*) FROM website_change_receipts WHERE submission_id=?", (sid,)
            ).fetchone()[0],
            0,
        )
        with self.assertRaises(ValueError):
            sync.reconcile_submission(db, sid)

    def test_update_only_batch_without_client_refs_is_acknowledged(self):
        kinds = ["update"] * 3
        db, sid, request_file, request_bytes = self.prepare(kinds)
        client = UpdateReceiptClient(request_bytes, kinds)
        # Reproduces the report: the commit page carries no clientRef, lookup does.
        self.assertTrue(all("clientRef" not in item for item in client.commit_items))
        self.assertEqual([item["clientRef"] for item in client.lookup_items], ["item-0", "item-1", "item-2"])
        result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
        self.assert_acknowledged_and_reconciled(db, sid, result, kinds)

    def test_mixed_create_and_update_batch_is_acknowledged(self):
        kinds = ["create", "update", "create", "update", "update"]
        db, sid, request_file, request_bytes = self.prepare(kinds)
        client = UpdateReceiptClient(request_bytes, kinds)
        result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
        self.assert_acknowledged_and_reconciled(db, sid, result, kinds)

    def test_paged_lookup_acknowledges_mixed_batch_past_the_endpoint_maximum(self):
        kinds = ["update" if index % 2 else "create" for index in range(251)]
        db, sid, request_file, request_bytes = self.prepare(kinds)
        client = UpdateReceiptClient(request_bytes, kinds)
        result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
        self.assert_acknowledged_and_reconciled(db, sid, result, kinds)
        offsets = [a["itemOffset"] for n, a in client.tool_calls if n == "website_sync_lookup"]
        self.assertEqual(offsets, [0, 250])

    def test_same_key_replay_after_uncertain_response_acknowledges_updates(self):
        kinds = ["update", "create", "update"]
        db, sid, request_file, request_bytes = self.prepare(kinds)
        client = UpdateReceiptClient(request_bytes, kinds, lose_first_commit=True)
        first = mcp_sync_driver.send_prepared(db, sid, request_file, client)
        self.assertEqual(first["state"], "uncertain")
        self.assertEqual(get_submission(db, sid)["state"], "pending")
        restarted = UpdateReceiptClient(request_bytes, kinds, server=client.server)
        result = mcp_sync_driver.send_prepared(db, sid, request_file, restarted)
        self.assert_acknowledged_and_reconciled(db, sid, result, kinds)
        self.assertEqual(restarted.commit_calls, [(KEY, request_bytes)])
        self.assertEqual(client.commit_calls[0][0], KEY)
        self.assertEqual(client.server.batch_create_count, 1)
        self.assertTrue(get_submission(db, sid)["response"]["replayed"])

    def test_explicit_client_reference_must_still_match(self):
        kinds = ["create", "create"]
        db, sid, request_file, request_bytes = self.prepare(kinds)
        client = UpdateReceiptClient(request_bytes, kinds)
        client.lookup_items[1]["clientRef"] = "synthetic-person-other"
        result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
        self.assert_unacknowledged(db, sid, result)

    def test_explicit_client_reference_on_an_update_response_must_match_lookup(self):
        kinds = ["update", "update"]
        db, sid, request_file, request_bytes = self.prepare(kinds)
        client = UpdateReceiptClient(request_bytes, kinds)
        client.commit_items[0]["clientRef"] = "synthetic-explicit-ref"
        result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
        self.assert_unacknowledged(db, sid, result)

    def test_genuine_receipt_mismatch_leaves_submission_unacknowledged(self):
        def lookup(index, key, value):
            return lambda client: client.lookup_items[index].__setitem__(key, value)

        def commit(index, key, value):
            return lambda client: client.commit_items[index].__setitem__(key, value)

        cases = {
            "version differs": lookup(1, "version", 3),
            "outcome differs": lookup(1, "outcome", "reused"),
            "target differs": lookup(1, "websiteId", "synthetic-other-target"),
            "entity differs": lookup(1, "entity", "organizations"),
            "item index differs": lookup(1, "itemIndex", 5),
            "default reference for another item": lookup(1, "clientRef", "item-0"),
            "non default reference": lookup(1, "clientRef", "update-1"),
            "empty reference": lookup(1, "clientRef", ""),
            "null reference": lookup(1, "clientRef", None),
            "commit version differs": commit(1, "version", 3),
            "commit target differs": commit(1, "websiteId", "synthetic-other-target"),
            "commit outcome differs": commit(1, "outcome", "reused"),
            "commit entity differs": commit(1, "entity", "organizations"),
            "batch id differs": lambda client: setattr(client, "batch_id", "x") or client.lookup_items.__setitem__(
                slice(None), client.lookup_items
            ),
        }
        for name, tamper in cases.items():
            with self.subTest(name):
                kinds = ["update", "update", "update"]
                db, sid, request_file, request_bytes = self.prepare(kinds, name=f"mismatch-{abs(hash(name))}.sqlite")
                client = UpdateReceiptClient(request_bytes, kinds)
                if name == "batch id differs":
                    original = client.call_tool

                    def other_batch(tool, arguments, original=original):
                        page = copy.deepcopy(original(tool, arguments))
                        if tool == "website_sync_lookup":
                            page["batchId"] = "synthetic-different-batch"
                        return page

                    client.call_tool = other_batch
                else:
                    tamper(client)
                result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
                self.assert_unacknowledged(db, sid, result)

    def test_r6_reconciliation_still_rejects_a_forged_update_reference(self):
        kinds = ["update", "update"]
        for label, ref in (("wrong default", "item-0"), ("other", "synthetic-ref")):
            with self.subTest(label):
                db, sid, _file, _bytes = self.prepare(kinds, name=f"forged-{label.replace(' ', '-')}.sqlite")
                items = [
                    {"itemIndex": 0, "entity": "people", "websiteId": "synthetic-website-person-0", "version": 2, "outcome": "updated", "clientRef": "item-0"},
                    {"itemIndex": 1, "entity": "people", "websiteId": "synthetic-website-person-1", "version": 2, "outcome": "updated", "clientRef": ref},
                ]
                body = json.dumps(
                    {"status": "committed", "batchId": "synthetic-forged-batch", "requestId": REQUEST_ID,
                     "committedAt": "2026-11-18T12:00:00Z", "replayed": False, "itemCount": 2,
                     "counts": {"people:updated": 2}, "items": items}
                ).encode("utf-8")
                result = submission.submit_prepared(db, sid, lambda *a: (200, body))
                self.assertEqual(result["state"], "acknowledged")
                with self.assertRaises(ValueError):
                    sync.reconcile_submission(db, sid)
                self.assertEqual(
                    db.execute("SELECT count(*) FROM website_change_receipts WHERE submission_id=?", (sid,)).fetchone()[0],
                    0,
                )


if __name__ == "__main__":
    unittest.main()

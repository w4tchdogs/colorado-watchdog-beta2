"""Synthetic end-to-end coverage for the R6 backed Website MCP driver."""

import json
import tempfile
import unittest
from pathlib import Path

from research import mcp_sync_driver, sync
from research.db import connect, migrate
from research.mapping import canonical_json
from research.submission import export_prepared_request, get_submission


SITE = "synthetic-site"
KEY = "synthetic-r6-mcp-key"
REQUEST_ID = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19"


def prepared_fixture(db, directory, count=3):
    changes = [
        {
            "op": "create_person",
            "entity": "people",
            "clientRef": f"synthetic-person-{index}",
            "fields": {"display_name": f"Synthetic Person {index}"},
        }
        for index in range(count)
    ]
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
                "client_ref": change["clientRef"],
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
    request_file = Path(directory, "prepared-synthetic.json")
    exported = export_prepared_request(db, prepared["submission_id"], request_file)
    return prepared["submission_id"], request_file, request_file.read_bytes(), exported


class FakeServer:
    def __init__(self):
        self.batch_created = False
        self.batch_create_count = 0
        self.reversed = False


class FakeMcpClient:
    def __init__(self, request_bytes, *, server=None, lose_first_commit=False):
        self.request_bytes = request_bytes
        self.lose_first_commit = lose_first_commit
        self.lost = False
        self.server = server or FakeServer()
        self.commit_calls = []
        self.tool_calls = []
        self.batch_id = "synthetic-website-batch-1"
        self.committed_at = "2026-11-16T12:00:00Z"
        self.items = [
            {
                "itemIndex": index,
                "clientRef": f"synthetic-person-{index}",
                "entity": "people",
                "websiteId": f"synthetic-website-person-{index}",
                "version": 1,
                "outcome": "created",
            }
            for index in range(3)
        ]

    def discover_and_check_tools(self):
        return None

    def ensure_commit_fits(self, idempotency_key, request_bytes):
        if request_bytes != self.request_bytes:
            raise AssertionError("Driver validated different prepared bytes")

    def call_tool(self, name, arguments):
        self.tool_calls.append((name, arguments))
        if name == "website_sync_dry_run":
            return {"eligible": True, "itemCount": len(self.items), "errors": []}
        if name == "website_sync_lookup":
            limit = arguments["itemLimit"]
            offset = arguments["itemOffset"]
            page = self.items[offset : offset + limit]
            return {
                "status": "reverted" if self.server.reversed else "committed",
                "batchId": self.batch_id,
                "committedAt": self.committed_at,
                "reversedAt": "2026-11-16T12:02:00Z" if self.server.reversed else None,
                "itemCount": len(self.items),
                "counts": {"people:created": len(self.items)},
                "itemOffset": offset,
                "items": page,
                "nextItemOffset": offset + len(page) if offset + len(page) < len(self.items) else None,
            }
        if name == "website_sync_reverse":
            self.server.reversed = True
            return {
                "status": "reverted",
                "batchId": self.batch_id,
                "reversalId": "synthetic-reversal-1",
                "reversedAt": "2026-11-16T12:02:00Z",
                "replayed": False,
            }
        raise AssertionError(f"Unexpected tool: {name}")

    def commit_raw(self, idempotency_key, request_bytes):
        self.commit_calls.append((idempotency_key, request_bytes))
        if request_bytes != self.request_bytes:
            raise AssertionError("Driver did not pass the exact prepared bytes")
        replayed = self.server.batch_created
        if not self.server.batch_created:
            self.server.batch_created = True
            self.server.batch_create_count += 1
        result = {
            "status": "committed",
            "batchId": self.batch_id,
            "requestId": REQUEST_ID,
            "committedAt": self.committed_at,
            "replayed": replayed,
            "itemCount": len(self.items),
            "counts": {"people:created": len(self.items)},
            "items": self.items[:100],
        }
        if self.lose_first_commit and not self.lost:
            self.lost = True
            raise OSError("synthetic response lost after server commit")
        complete = mcp_sync_driver.McpHttpClient._complete_receipt(
            self, result, expected_request_id=REQUEST_ID
        )
        return 200, json.dumps(complete).encode("utf-8")


class McpSyncDriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name, "profiles-synthetic.sqlite")
        self.db = connect(str(self.db_path))
        migrate(self.db)
        self.sid, self.request_file, self.request_bytes, self.export = prepared_fixture(
            self.db, self.temp.name
        )

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_raw_rpc_wrapper_preserves_prepared_changeset_bytes(self):
        request = b'{ "contractVersion" : "m2-sync/v1", "changes": [] }'
        arguments = b'{"idempotencyKey":"synthetic-key","changeset":' + request + b'}'
        body = mcp_sync_driver.build_tool_call_body(7, "website_sync_commit", arguments)
        self.assertIn(b'"arguments":' + arguments, body)
        self.assertIn(b'"protocolVersion":"2026-07-28"', body)
        self.assertNotIn(b"bearer", body.lower())

    def test_http_client_uses_supported_protocol_and_retains_complete_receipt(self):
        items = [
            {
                "itemIndex": index,
                "clientRef": f"synthetic-{index}",
                "entity": "people",
                "websiteId": f"website-{index}",
                "version": 1,
                "outcome": "created",
            }
            for index in range(3)
        ]
        calls = []

        class Response:
            status = 200

            def __init__(self, value):
                self.raw = json.dumps(value).encode()

            def read(self, size=-1):
                return self.raw[:size]

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        class Opener:
            def open(self, request, timeout):
                raw = request.data
                envelope = json.loads(raw)
                calls.append((envelope, raw, request.get_header("Authorization")))
                method = envelope["method"]
                if method == "server/discover":
                    result = {"supportedVersions": ["2026-07-28"]}
                elif method == "tools/list":
                    result = {"tools": [{"name": name} for name in mcp_sync_driver.TOOLS]}
                else:
                    params = envelope["params"]
                    self.assert_meta(params)
                    name, args = params["name"], params["arguments"]
                    if name == "website_sync_commit":
                        self.commit_raw = raw
                        value = {
                            "status": "committed",
                            "batchId": "synthetic-http-batch",
                            "requestId": REQUEST_ID,
                            "committedAt": "2026-11-16T12:00:00Z",
                            "replayed": False,
                            "itemCount": 3,
                            "counts": {"people:created": 3},
                            "items": items,
                        }
                    elif name == "website_sync_lookup":
                        value = {
                            "status": "committed",
                            "batchId": "synthetic-http-batch",
                            "committedAt": "2026-11-16T12:00:00Z",
                            "itemCount": 3,
                            "counts": {"people:created": 3},
                            "itemOffset": args["itemOffset"],
                            "items": items,
                            "nextItemOffset": None,
                        }
                    else:
                        raise AssertionError(name)
                    result = {"content": [{"text": json.dumps(value)}]}
                return Response({"jsonrpc": "2.0", "id": envelope["id"], "result": result})

            @staticmethod
            def assert_meta(params):
                if params.get("_meta", {}).get("protocolVersion") != "2026-07-28":
                    raise AssertionError("Wrong MCP protocol metadata")

        client = mcp_sync_driver.McpHttpClient(
            "https://synthetic.invalid/mcp", "synthetic-secret"
        )
        client._opener = Opener()
        try:
            client.discover_and_check_tools()
            receipt_status, receipt_bytes = client.commit_raw(KEY, self.request_bytes)
        finally:
            client.close()
        self.assertEqual(receipt_status, 200)
        receipt = json.loads(receipt_bytes)
        self.assertEqual(receipt["batchId"], "synthetic-http-batch")
        self.assertEqual([item["itemIndex"] for item in receipt["items"]], [0, 1, 2])
        self.assertIn(b'"changeset":' + self.request_bytes, client._opener.commit_raw)
        self.assertEqual([call[0]["method"] for call in calls], [
            "server/discover", "tools/list", "tools/call", "tools/call"
        ])
        self.assertTrue(all(call[2] == "Bearer synthetic-secret" for call in calls))

    def test_lost_commit_response_retries_same_key_and_reconciles_one_batch(self):
        client = FakeMcpClient(self.request_bytes, lose_first_commit=True)
        first = mcp_sync_driver.send_prepared(self.db, self.sid, self.request_file, client)
        self.assertEqual(first["state"], "uncertain")
        record = get_submission(self.db, self.sid)
        self.assertEqual(record["state"], "pending")
        self.assertEqual(record["attempt_count"], 1)
        self.assertIsNone(record.get("response"))
        calls_before_restart = len(client.tool_calls)

        # New driver/client process model: the same file and R6 row recover the key.
        restarted = FakeMcpClient(self.request_bytes, server=client.server)
        restarted.commit_calls = []
        result = mcp_sync_driver.send_prepared(self.db, self.sid, self.request_file, restarted)
        self.assertEqual(result["state"], "acknowledged")
        self.assertEqual(result["item_count"], 3)
        self.assertEqual(len(restarted.commit_calls), 1)
        self.assertEqual(restarted.commit_calls[0], (KEY, self.request_bytes))
        self.assertEqual(len(client.commit_calls), 1)
        # The retry used the same idempotency key; the simulated Website created one batch.
        self.assertEqual(client.server.batch_create_count, 1)
        self.assertGreater(calls_before_restart, 0)
        receipt = get_submission(self.db, self.sid)["response"]
        self.assertEqual(receipt["batchId"], restarted.batch_id)
        self.assertTrue(receipt["replayed"])
        self.assertEqual([x["itemIndex"] for x in receipt["items"]], [0, 1, 2])
        self.assertEqual(sync.reconcile_submission(self.db, self.sid)["state"], "committed")
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM website_change_receipts WHERE submission_id=?", (self.sid,)
        ).fetchone()[0], 3)

    def test_bad_lookup_batch_leaves_r6_pending_instead_of_storing_partial_receipt(self):
        class WrongBatch(FakeMcpClient):
            def call_tool(self, name, arguments):
                if name == "website_sync_lookup":
                    raise mcp_sync_driver.McpDriverError("synthetic lookup returned a different batch")
                return super().call_tool(name, arguments)

        client = WrongBatch(self.request_bytes)
        result = mcp_sync_driver.send_prepared(self.db, self.sid, self.request_file, client)
        self.assertEqual(result["state"], "uncertain")
        record = get_submission(self.db, self.sid)
        self.assertEqual(record["state"], "pending")
        self.assertIsNone(record.get("response"))

    def test_receipt_paginates_past_endpoint_maximum_and_checks_order(self):
        db = connect(str(Path(self.temp.name, "paged-profiles-synthetic.sqlite")))
        migrate(db)
        try:
            paged_dir = Path(self.temp.name, "paged")
            paged_dir.mkdir()
            sid, request_file, request_bytes, _ = prepared_fixture(
                db, paged_dir, count=251
            )
        except Exception:
            db.close()
            raise
        client = FakeMcpClient(request_bytes)
        client.items = [
            {
                "itemIndex": index,
                "clientRef": f"synthetic-person-{index}",
                "entity": "people",
                "websiteId": f"synthetic-website-person-{index}",
                "version": 1,
                "outcome": "created",
            }
            for index in range(251)
        ]
        try:
            result = mcp_sync_driver.send_prepared(db, sid, request_file, client)
            self.assertEqual(result["state"], "acknowledged")
            receipt = get_submission(db, sid)["response"]
            self.assertEqual(receipt["itemCount"], 251)
            self.assertEqual(len(receipt["items"]), 251)
            self.assertEqual(
                [item["itemIndex"] for item in receipt["items"]], list(range(251))
            )
            offsets = [args["itemOffset"] for name, args in client.tool_calls if name == "website_sync_lookup"]
            self.assertEqual(offsets, [0, 250])
        finally:
            db.close()

    def test_export_is_exact_exclusive_and_file_mismatch_sends_nothing(self):
        self.assertEqual(self.export["request_bytes"], len(self.request_bytes))
        self.assertEqual(self.request_file.read_bytes(), self.request_bytes)
        with self.assertRaises(FileExistsError):
            export_prepared_request(self.db, self.sid, self.request_file)
        self.request_file.write_bytes(self.request_bytes + b" ")
        client = FakeMcpClient(self.request_bytes)
        with self.assertRaisesRegex(ValueError, "differs from the R6 stored request"):
            mcp_sync_driver.send_prepared(self.db, self.sid, self.request_file, client)
        self.assertEqual(client.tool_calls, [])
        self.assertEqual(client.commit_calls, [])

    def test_reversal_is_read_back_and_reconciled_locally(self):
        client = FakeMcpClient(self.request_bytes)
        result = mcp_sync_driver.run_synthetic_roundtrip(
            self.db, self.sid, self.request_file, "synthetic-reversal-key", client
        )
        self.assertEqual(result["state"], "complete")
        self.assertTrue(result["reconciled"])
        self.assertEqual(result["reversal_state"], "reverted")
        self.assertTrue(result["reversal_reconciled"])
        replay = mcp_sync_driver.run_synthetic_roundtrip(
            self.db, self.sid, self.request_file, "synthetic-reversal-key", client
        )
        self.assertEqual(replay["state"], "complete")
        self.assertEqual(client.server.batch_create_count, 1)
        stored = self.db.execute(
            "SELECT state,receipt_json FROM website_reversal_receipts WHERE website_batch_id=?",
            (client.batch_id,),
        ).fetchone()
        self.assertEqual(stored["state"], "reverted")
        self.assertEqual(json.loads(stored["receipt_json"])["reversalId"], "synthetic-reversal-1")
        self.assertTrue(client.server.reversed)

    def test_roundtrip_mode_refuses_non_synthetic_request_before_network(self):
        client = FakeMcpClient(self.request_bytes)
        self.db.execute(
            "UPDATE website_requests SET site_key='colorado_watchdog_alpha1' WHERE id=?",
            (self.sid,),
        )
        with self.assertRaisesRegex(ValueError, "only at most five synthetic people"):
            mcp_sync_driver.run_synthetic_roundtrip(
                self.db, self.sid, self.request_file, "synthetic-reversal-key", client
            )
        self.assertEqual(client.tool_calls, [])
        self.assertEqual(client.commit_calls, [])



class UnreadableResponseDiagnosticsTest(unittest.TestCase):
    def test_unreadable_response_reports_only_sanitized_metadata(self):
        class Response:
            status = 200
            headers = {"content-type": "text/event-stream; charset=utf-8"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _n):
                return b"data: SECRET-BODY-TEXT"

        class Opener:
            def open(self, request, timeout=None):
                return Response()

        client = mcp_sync_driver.McpHttpClient("https://synthetic.invalid/mcp", "synthetic-secret")
        client._opener = Opener()
        with self.assertRaises(mcp_sync_driver.McpDriverError) as caught:
            client._post(b"{}")
        message = str(caught.exception)
        self.assertIn("HTTP 200", message)
        self.assertIn("text/event-stream", message)
        self.assertIn("event-stream", message)
        self.assertNotIn("SECRET", message)
        self.assertNotIn("synthetic-secret", message)

if __name__ == "__main__":
    unittest.main()

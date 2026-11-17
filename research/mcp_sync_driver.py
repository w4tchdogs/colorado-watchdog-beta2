"""Disk-backed HTTP MCP transport for the R6 Profiles submission ledger.

The endpoint implements the Website's bounded protocol 2026-07-28 exchange,
not the MCP SDK initialize handshake. Credentials are supplied by the caller,
kept only in memory, and never included in diagnostics.
"""

import getpass
import json
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from research import submission, sync

PROTOCOL_VERSION = "2026-07-28"
MCP_MAX_BYTES = 2 * 1024 * 1024
PAGE_SIZE = 250
TOOLS = {
    "website_sync_dry_run",
    "website_sync_commit",
    "website_sync_lookup",
    "website_sync_reverse",
}


class McpDriverError(ValueError):
    """A sanitized driver error that never contains a request or credential."""


class McpToolError(McpDriverError):
    def __init__(self, code, details=None):
        self.code = code if isinstance(code, str) else "sync_failed"
        self.details = details if isinstance(details, dict) else {}
        super().__init__(self.code)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise McpDriverError("MCP endpoint redirected; credentials were not forwarded")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise McpDriverError("The MCP response contains duplicate JSON keys")
        result[key] = value
    return result


def _json_bytes(value):
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def build_tool_call_body(request_id, name, arguments_json, *, item_meta=True):
    """Wrap argument JSON while preserving a changeset's stored bytes exactly."""
    if not re.fullmatch(r"website_sync_(dry_run|commit|lookup|reverse)", name):
        raise McpDriverError("Unsupported sync tool")
    if not isinstance(arguments_json, bytes):
        raise McpDriverError("Tool arguments must be UTF-8 JSON bytes")
    try:
        json.loads(arguments_json.decode("utf-8"), object_pairs_hook=_unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise McpDriverError("Prepared request is not valid JSON") from error
    params = (
        b'{"name":'
        + _json_bytes(name)
        + b',"arguments":'
        + arguments_json
    )
    if item_meta:
        params += b',"_meta":{"protocolVersion":"' + PROTOCOL_VERSION.encode()
        params += b'","clientInfo":{"name":"watchdog-r6-driver","version":"1"}'
        params += b',"clientCapabilities":{}}'
    params += b"}"
    return (
        b'{"jsonrpc":"2.0","id":'
        + str(request_id).encode("ascii")
        + b',"method":"tools/call","params":'
        + params
        + b"}"
    )


class McpHttpClient:
    """Small standard-library client for the endpoint's supported HTTP protocol."""

    def __init__(self, endpoint, credential, *, timeout=30):
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.path.rstrip("/") != "/mcp"
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise McpDriverError("Endpoint must be an HTTPS URL without embedded credentials")
        if not isinstance(credential, str) or not credential.strip():
            raise McpDriverError("A bearer credential is required")
        self.endpoint = endpoint
        self._credential = credential.strip()
        self.timeout = timeout
        self._request_id = 0
        self._opener = urllib.request.build_opener(_NoRedirect())

    def close(self):
        self._credential = ""

    def _post(self, body):
        if len(body) > MCP_MAX_BYTES:
            raise McpDriverError("MCP request exceeds the endpoint byte limit")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self._credential}",
            },
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                status = response.status
                raw = response.read(MCP_MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read(MCP_MAX_BYTES + 1)
        except Exception as error:
            raise McpDriverError("MCP transport outcome is uncertain") from error
        if len(raw) > MCP_MAX_BYTES:
            raise McpDriverError("MCP response exceeds the endpoint byte limit")
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        except (UnicodeError, json.JSONDecodeError) as error:
            raise McpDriverError("MCP endpoint returned an unreadable response") from error
        if not isinstance(value, dict):
            raise McpDriverError("MCP endpoint returned an invalid response")
        return status, value

    def _rpc(self, method, params):
        self._request_id += 1
        body = _json_bytes(
            {"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params}
        )
        status, response = self._post(body)
        if status != 200:
            raise McpDriverError(f"MCP endpoint returned HTTP {status}")
        if response.get("id") != self._request_id:
            raise McpDriverError("MCP response ID did not match the request")
        if "error" in response:
            error = response["error"]
            code = error.get("code") if isinstance(error, dict) else None
            raise McpDriverError(f"MCP protocol error {code}")
        return response.get("result")

    def discover_and_check_tools(self):
        discovered = self._rpc("server/discover", {})
        versions = discovered.get("supportedVersions") if isinstance(discovered, dict) else None
        if not isinstance(versions, list) or PROTOCOL_VERSION not in versions:
            raise McpDriverError("Endpoint does not advertise the supported MCP protocol")
        listing = self._rpc("tools/list", {})
        tools = listing.get("tools") if isinstance(listing, dict) else None
        names = {item.get("name") for item in tools or [] if isinstance(item, dict)}
        if not TOOLS.issubset(names):
            raise McpDriverError("Endpoint is missing one or more Profiles sync tools")

    def call_tool(self, name, arguments):
        self._request_id += 1
        body = _json_bytes(
            {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments,
                    "_meta": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "clientInfo": {"name": "watchdog-r6-driver", "version": "1"},
                        "clientCapabilities": {},
                    },
                },
            }
        )
        status, response = self._post(body)
        if status != 200:
            raise McpDriverError(f"MCP endpoint returned HTTP {status}")
        if response.get("id") != self._request_id:
            raise McpDriverError("MCP response ID did not match the request")
        result = response.get("result")
        if not isinstance(result, dict):
            raise McpDriverError("MCP tool returned an invalid result")
        content = result.get("content")
        if not isinstance(content, list) or not content or not isinstance(content[0], dict):
            raise McpDriverError("MCP tool returned no result content")
        try:
            value = json.loads(content[0]["text"], object_pairs_hook=_unique_object)
        except (KeyError, TypeError, UnicodeError, json.JSONDecodeError) as error:
            raise McpDriverError("MCP tool returned unreadable result content") from error
        if result.get("isError"):
            code = value.get("error") if isinstance(value, dict) else None
            raise McpToolError(code, value if isinstance(value, dict) else None)
        if not isinstance(value, dict):
            raise McpDriverError("MCP tool returned an invalid payload")
        return value

    def commit_raw(self, idempotency_key, request_bytes):
        self._request_id += 1
        body = self._commit_body(self._request_id, idempotency_key, request_bytes)
        status, response = self._post(body)
        if status != 200:
            raise McpDriverError(f"MCP endpoint returned HTTP {status}")
        if response.get("id") != self._request_id:
            raise McpDriverError("MCP response ID did not match the request")
        result = response.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("content"), list):
            raise McpDriverError("MCP commit returned an invalid result")
        try:
            value = json.loads(result["content"][0]["text"], object_pairs_hook=_unique_object)
        except (KeyError, IndexError, TypeError, UnicodeError, json.JSONDecodeError) as error:
            raise McpDriverError("MCP commit returned unreadable result content") from error
        if result.get("isError"):
            code = value.get("error") if isinstance(value, dict) else None
            if code in ("authentication_required", "not_authorized", "request_too_large", "invalid_arguments"):
                status_map = {
                    "authentication_required": 401,
                    "not_authorized": 403,
                    "request_too_large": 413,
                    "invalid_arguments": 400,
                }
                return status_map[code], _json_bytes({"error": code})
            if code == "commit_rejected" and isinstance(value, dict):
                return 422, _json_bytes({"status": "rejected", "errors": value.get("errors", [])})
            raise McpDriverError("MCP commit result is uncertain")
        if not isinstance(value, dict) or value.get("status") != "committed":
            raise McpDriverError("MCP commit receipt is incomplete")
        try:
            expected_request_id = json.loads(
                request_bytes.decode("utf-8"), object_pairs_hook=_unique_object
            ).get("requestId")
        except (UnicodeError, json.JSONDecodeError, AttributeError) as error:
            raise McpDriverError("Prepared request identity could not be verified") from error
        receipt = self._complete_receipt(value, expected_request_id=expected_request_id)
        return 200, _json_bytes(receipt)

    @staticmethod
    def _commit_body(request_id, idempotency_key, request_bytes):
        args = (
            b'{"idempotencyKey":'
            + _json_bytes(idempotency_key)
            + b',"changeset":'
            + request_bytes
            + b"}"
        )
        return build_tool_call_body(request_id, "website_sync_commit", args)

    def ensure_commit_fits(self, idempotency_key, request_bytes):
        body = self._commit_body(self._request_id + 1, idempotency_key, request_bytes)
        if len(body) > MCP_MAX_BYTES:
            raise McpDriverError("Prepared request exceeds the Website MCP body limit")

    def _complete_receipt(self, commit, *, expected_request_id=None):
        batch_id = commit.get("batchId")
        item_count = commit.get("itemCount")
        initial_items = commit.get("items")
        if (
            not isinstance(batch_id, str)
            or not batch_id
            or type(item_count) is not int
            or item_count < 1
            or not isinstance(initial_items, list)
            or not 1 <= len(initial_items) <= min(PAGE_SIZE, item_count)
            or commit.get("requestId") != expected_request_id
        ):
            raise McpDriverError("MCP commit receipt metadata is incomplete")
        all_items = []
        first_metadata = None
        offset = 0
        while True:
            page = self.call_tool(
                "website_sync_lookup",
                {"batchId": batch_id, "itemOffset": offset, "itemLimit": PAGE_SIZE},
            )
            metadata = (
                page.get("status"),
                page.get("batchId"),
                page.get("committedAt"),
                page.get("itemCount"),
                page.get("counts"),
            )
            if first_metadata is None:
                first_metadata = metadata
            if metadata != first_metadata:
                raise McpDriverError("Paged receipt metadata changed between pages")
            if (
                page.get("status") != "committed"
                or page.get("batchId") != batch_id
                or page.get("itemCount") != item_count
                or page.get("itemOffset") != offset
            ):
                raise McpDriverError("Paged receipt does not match the committed batch")
            items = page.get("items")
            if not isinstance(items, list) or not items or offset + len(items) > item_count:
                raise McpDriverError("Paged receipt has a missing or excessive item page")
            all_items.extend(items)
            next_offset = page.get("nextItemOffset")
            expected_next = offset + len(items)
            if next_offset is None:
                if expected_next != item_count:
                    raise McpDriverError("Paged receipt ended before every item was recovered")
                break
            if type(next_offset) is not int or next_offset != expected_next:
                raise McpDriverError("Paged receipt has a gap, overlap, or invalid cursor")
            offset = next_offset
        if len(all_items) != item_count:
            raise McpDriverError("Paged receipt item count does not match the commit")
        if (
            first_metadata[2] != commit.get("committedAt")
            or first_metadata[4] != commit.get("counts")
        ):
            raise McpDriverError("Commit and lookup receipt metadata disagree")
        indices = [item.get("itemIndex") if isinstance(item, dict) else None for item in all_items]
        if indices != list(range(item_count)):
            raise McpDriverError("Paged receipt items are not a complete ordered sequence")
        if not isinstance(initial_items, list) or initial_items != all_items[: len(initial_items)]:
            raise McpDriverError("Lookup receipt does not match the commit response page")
        return {
            "status": "committed",
            "batchId": batch_id,
            "requestId": commit.get("requestId"),
            "committedAt": commit.get("committedAt"),
            "replayed": commit.get("replayed"),
            "itemCount": item_count,
            "counts": first_metadata[4],
            "items": all_items,
        }


def _stored_request(db, submission_id, request_file):
    row = db.execute(
        "SELECT id,site_key,idempotency_key,request_json,state,attempt_count "
        "FROM sync_submissions WHERE id=?",
        (submission_id,),
    ).fetchone()
    if row is None:
        raise McpDriverError("Prepared submission was not found")
    try:
        disk_bytes = request_file.read_bytes()
    except OSError as error:
        raise McpDriverError("Prepared changeset file could not be read") from error
    if disk_bytes != row["request_json"].encode("utf-8"):
        raise McpDriverError("Prepared changeset file differs from the R6 stored request")
    if len(disk_bytes) > submission.MAX_REQUEST_BYTES:
        raise McpDriverError("Prepared changeset exceeds the R6 request limit")
    try:
        request = json.loads(disk_bytes.decode("utf-8"), object_pairs_hook=_unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise McpDriverError("Prepared changeset file is not valid JSON") from error
    return row, disk_bytes, request


def send_prepared(db, submission_id, request_file, client):
    """Dry-run then send through R6; R6 stores only a complete verified receipt."""
    row, request_bytes, request = _stored_request(db, submission_id, request_file)
    client.discover_and_check_tools()
    client.ensure_commit_fits(row["idempotency_key"], request_bytes)
    if row["state"] == "pending" and row["attempt_count"] == 0:
        planned = client.call_tool("website_sync_dry_run", {"changeset": request})
        if (
            planned.get("eligible") is not True
            or planned.get("itemCount") != len(request["changes"])
        ):
            raise McpDriverError("Synthetic changeset was not eligible in Website dry run")

    def transport(site_key, path, headers, body):
        if (
            site_key != row["site_key"]
            or path != submission.COMMIT_PATH
            or headers.get("idempotency-key") != row["idempotency_key"]
            or body != request_bytes
        ):
            raise McpDriverError("R6 attempted to send a request different from the prepared record")
        return client.commit_raw(headers["idempotency-key"], body)

    result = submission.submit_prepared(db, submission_id, transport)
    if result["state"] == "acknowledged":
        receipt = result.get("response")
        if not isinstance(receipt, dict) or len(receipt.get("items", [])) != receipt.get("itemCount"):
            raise McpDriverError("R6 stored an incomplete Website receipt")
    return {
        "state": result["state"],
        "submission_id": submission_id,
        "remote_batch_id": result.get("remote_batch_id"),
        "response_status": result.get("response_status"),
        "item_count": result.get("response", {}).get("itemCount")
        if isinstance(result.get("response"), dict)
        else None,
    }


def reverse_and_reconcile(db, site_key, batch_id, idempotency_key, client):
    """Reverse one owned batch, verify its readback, and record its R7 receipt."""
    local = db.execute(
        "SELECT s.id FROM sync_submissions s JOIN sync_submission_receipts r "
        "ON r.submission_id=s.id WHERE s.site_key=? AND s.remote_batch_id=? "
        "AND r.state='committed' LIMIT 1",
        (site_key, batch_id),
    ).fetchone()
    if local is None:
        raise McpDriverError("Batch has no reconciled local R8 submission")
    client.discover_and_check_tools()
    before = client.call_tool(
        "website_sync_lookup", {"batchId": batch_id, "itemOffset": 0, "itemLimit": 1}
    )
    if before.get("status") != "committed" or before.get("batchId") != batch_id:
        raise McpDriverError("Website batch is not in committed state")
    receipt = client.call_tool(
        "website_sync_reverse", {"batchId": batch_id, "idempotencyKey": idempotency_key}
    )
    if receipt.get("status") not in ("reverted", "already_reverted") or receipt.get("batchId") != batch_id:
        raise McpDriverError("Website reversal was not confirmed")
    after = client.call_tool(
        "website_sync_lookup", {"batchId": batch_id, "itemOffset": 0, "itemLimit": 1}
    )
    if after.get("status") != "reverted" or after.get("batchId") != batch_id:
        raise McpDriverError("Website batch did not read back as reverted")
    reconciled = sync.reconcile_reversal(db, site_key, batch_id, receipt)
    return {"status": receipt["status"], "batch_id": batch_id, **reconciled}


def prompt_credential():
    """Read a bearer secret without echoing it; callers must not log the result."""
    return getpass.getpass("Website sync bearer credential (hidden): ")

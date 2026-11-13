"""Authenticated, SQLite-consistent local backup and isolated restore helpers.

Backup artifacts use Windows DPAPI under the current user profile. The small
container format is only framing; all confidential records and the final
integrity manifest are protected by DPAPI.
"""

import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import sqlite3
import struct
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from research.db import validate_migration_history

_MAGIC = b"CW-R5A-DPAPI\x00\x01"
_CHUNK = 1
_FOOTER = 255
_CHUNK_BYTES = 1024 * 1024
_MAX_RECORD = _CHUNK_BYTES + 65536
_CHUNK_ENTROPY = b"colorado-watchdog/r5a/backup/chunk/v1"
_MANIFEST_ENTROPY = b"colorado-watchdog/r5a/backup/manifest/v1"
_DOMAIN_TABLES = frozenset({
    "counties", "org_units", "org_names", "role_targets", "unit_coverage", "source_unit_links",
    "research_people", "name_variants", "role_claims", "possible_matches", "sources", "evidence_links",
    "scrape_batches", "research_runs", "source_visits", "site_links", "sync_batches", "sync_items",
    "research_events",
})


def _read_only(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA busy_timeout=5000")
    return db


def _encode_value(value):
    if isinstance(value, bytes):
        return {"blob_base64": base64.b64encode(value).decode("ascii")}
    return value


def _database_snapshot(db):
    history = validate_migration_history(db)
    tables = [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    if set(tables) != _DOMAIN_TABLES | {"schema_migrations"}:
        raise ValueError("Database does not contain the expected 19-table research schema")
    row_counts = {}
    digest = hashlib.sha256()
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        columns = [row[1] for row in db.execute(f"PRAGMA table_info({quoted})")]
        count = 0
        order = ",".join(str(index) for index in range(1, len(columns) + 1))
        for row in db.execute(f"SELECT * FROM {quoted} ORDER BY {order}"):
            values = [_encode_value(value) for value in row]
            digest.update(json.dumps([table, values], ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8"))
            digest.update(b"\n")
            count += 1
        row_counts[table] = count
    return {"migration_count": history["migration_count"],
            "schema_version": history["schema_version"],
            "integrity": history["integrity"],
            "table_counts": row_counts,
            "logical_sha256": digest.hexdigest()}


def _copy_database(source, destination):
    """Use SQLite's online backup API; never copy a live database file."""
    source_db = _read_only(source)
    destination_db = sqlite3.connect(destination, timeout=5)
    try:
        source_db.backup(destination_db, pages=256, sleep=0.05)
        destination_db.commit()
    finally:
        destination_db.close()
        source_db.close()


def _dpapi_transform(payload, *, protect, entropy):
    if os.name != "nt":
        raise RuntimeError("Authenticated backup encryption requires Windows DPAPI")
    if not isinstance(payload, bytes) or not payload:
        raise ValueError("Encrypted backup records must contain bytes")

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    def blob(data):
        buffer = ctypes.create_string_buffer(data, len(data))
        return DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer

    input_blob, input_buffer = blob(payload)
    entropy_blob, entropy_buffer = blob(entropy)
    output_blob = DataBlob()
    crypt32 = ctypes.WinDLL("Crypt32.dll", use_last_error=True)
    kernel32 = ctypes.WinDLL("Kernel32.dll", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    function = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if protect:
        function.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_wchar_p,
                             ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                             wintypes.DWORD, ctypes.POINTER(DataBlob)]
        function.restype = wintypes.BOOL
        succeeded = function(ctypes.byref(input_blob), "Colorado Watchdog R5A backup",
                             ctypes.byref(entropy_blob), None, None, 0x1,
                             ctypes.byref(output_blob))
    else:
        function.argtypes = [ctypes.POINTER(DataBlob), ctypes.POINTER(ctypes.c_wchar_p),
                             ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                             wintypes.DWORD, ctypes.POINTER(DataBlob)]
        function.restype = wintypes.BOOL
        description = ctypes.c_wchar_p()
        succeeded = function(ctypes.byref(input_blob), ctypes.byref(description),
                             ctypes.byref(entropy_blob), None, None, 0x1,
                             ctypes.byref(output_blob))
        if description:
            kernel32.LocalFree(ctypes.cast(description, ctypes.c_void_p))
    if not succeeded:
        code = ctypes.get_last_error()
        raise ValueError("Windows could not authenticate or unlock this backup record" if not protect
                         else f"Windows DPAPI could not protect the backup record (error {code})")
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))
        _ = input_buffer, entropy_buffer


def _protect(payload, entropy):
    return _dpapi_transform(payload, protect=True, entropy=entropy)


def _unprotect(payload, entropy):
    return _dpapi_transform(payload, protect=False, entropy=entropy)


def _write_record(stream, kind, payload):
    if not payload or len(payload) > _MAX_RECORD:
        raise ValueError("Backup record exceeds the supported size")
    stream.write(struct.pack(">BI", kind, len(payload)))
    stream.write(payload)


def _read_exact(stream, size):
    result = stream.read(size)
    if len(result) != size:
        raise ValueError("Encrypted backup is incomplete")
    return result


def _encrypt_snapshot(snapshot_path, artifact_path, snapshot):
    content_hash = hashlib.sha256()
    content_size = 0
    chunk_count = 0
    with snapshot_path.open("rb") as plain, artifact_path.open("wb") as artifact:
        artifact.write(_MAGIC)
        while True:
            chunk = plain.read(_CHUNK_BYTES)
            if not chunk:
                break
            content_hash.update(chunk)
            content_size += len(chunk)
            clear = b"R5ACHUNK1" + struct.pack(">Q", chunk_count) + chunk
            _write_record(artifact, _CHUNK, _protect(clear, _CHUNK_ENTROPY))
            chunk_count += 1
        manifest = {"format": "colorado-watchdog-r5a-encrypted-backup/v1",
                    "backup_id": str(uuid4()),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "chunk_count": chunk_count,
                    "size_bytes": content_size,
                    "file_sha256": content_hash.hexdigest(),
                    "snapshot": snapshot}
        clear_manifest = b"R5AMANIFEST1" + json.dumps(
            manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        _write_record(artifact, _FOOTER, _protect(clear_manifest, _MANIFEST_ENTROPY))
        artifact.flush()
        os.fsync(artifact.fileno())
    return manifest


def _decrypt_snapshot(artifact_path, snapshot_path):
    digest = hashlib.sha256()
    size = 0
    count = 0
    manifest = None
    with artifact_path.open("rb") as artifact, snapshot_path.open("wb") as plain:
        if _read_exact(artifact, len(_MAGIC)) != _MAGIC:
            raise ValueError("Encrypted backup format is unsupported")
        while True:
            kind, length = struct.unpack(">BI", _read_exact(artifact, 5))
            if not 0 < length <= _MAX_RECORD:
                raise ValueError("Encrypted backup record size is invalid")
            protected = _read_exact(artifact, length)
            if kind == _CHUNK:
                clear = _unprotect(protected, _CHUNK_ENTROPY)
                if len(clear) <= 17 or not clear.startswith(b"R5ACHUNK1"):
                    raise ValueError("Encrypted backup chunk is invalid")
                index = struct.unpack(">Q", clear[9:17])[0]
                if index != count:
                    raise ValueError("Encrypted backup chunks are missing or reordered")
                chunk = clear[17:]
                plain.write(chunk)
                digest.update(chunk)
                size += len(chunk)
                count += 1
                continue
            if kind != _FOOTER or manifest is not None:
                raise ValueError("Encrypted backup record sequence is invalid")
            clear = _unprotect(protected, _MANIFEST_ENTROPY)
            if not clear.startswith(b"R5AMANIFEST1"):
                raise ValueError("Encrypted backup manifest is invalid")
            try:
                manifest = json.loads(clear[len(b"R5AMANIFEST1"):].decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("Encrypted backup manifest is invalid") from error
            if artifact.read(1):
                raise ValueError("Encrypted backup has trailing data")
            break
        plain.flush()
        os.fsync(plain.fileno())
    if not isinstance(manifest, dict) or manifest.get("format") != "colorado-watchdog-r5a-encrypted-backup/v1":
        raise ValueError("Encrypted backup manifest version is unsupported")
    if (manifest.get("chunk_count") != count or manifest.get("size_bytes") != size
            or manifest.get("file_sha256") != digest.hexdigest()):
        raise ValueError("Encrypted backup content does not match its authenticated manifest")
    if not isinstance(manifest.get("snapshot"), dict) or not manifest.get("backup_id"):
        raise ValueError("Encrypted backup manifest is incomplete")
    return manifest


def _is_reparse(path):
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(getattr(details, "st_file_attributes", 0) & 0x400)


def _explicit_external_path(value, label, *, must_exist=False):
    raw = Path(value)
    if not raw.is_absolute() or ".." in raw.parts:
        raise ValueError(f"{label} must be an explicit absolute path without traversal")
    for component in reversed((raw, *raw.parents)):
        if _is_reparse(component):
            raise ValueError(f"{label} cannot include symbolic links or reparse points")
    path = raw.resolve(strict=must_exist)
    checkout = Path(__file__).resolve().parents[1]
    if path == checkout or checkout in path.parents:
        raise ValueError(f"{label} must be outside the source checkout")
    return path


def _destination(path, label):
    path = _explicit_external_path(path, label)
    if not path.parent.is_dir():
        raise ValueError("Destination parent directory must already exist")
    if _is_reparse(path.parent) or path.exists():
        raise FileExistsError("Refusing to overwrite an existing or redirected destination")
    return path


def _temporary_directory(prefix):
    directory = _explicit_external_path(tempfile.gettempdir(), "Temporary private workspace", must_exist=True)
    if not directory.is_dir():
        raise ValueError("Temporary private workspace must be an existing directory")
    return tempfile.TemporaryDirectory(prefix=prefix, dir=directory)


def _publish(destination, writer):
    descriptor, temporary_name = tempfile.mkstemp(prefix=".cw-r5a-", suffix=".tmp",
                                                   dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        result = writer(temporary)
        with temporary.open("r+b") as artifact:
            os.fsync(artifact.fileno())
        os.link(temporary, destination)
        return result
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def backup_database(database, destination):
    """Create an authenticated encrypted backup from a consistent SQLite snapshot."""
    database = _explicit_external_path(database, "Research database", must_exist=True)
    if not database.is_file():
        raise ValueError("Research database must be an existing regular file")
    destination = _destination(destination, "Backup destination")
    if database == destination:
        raise ValueError("Backup destination must differ from the source database")
    _protect(b"DPAPI readiness check", _MANIFEST_ENTROPY)
    with _temporary_directory(prefix="cw-r5a-snapshot-") as temporary_root:
        snapshot_path = Path(temporary_root) / "snapshot.sqlite"
        _copy_database(database, snapshot_path)
        with closing(_read_only(snapshot_path)) as snapshot_db:
            snapshot = _database_snapshot(snapshot_db)

        def publish(encrypted_temporary):
            manifest = _encrypt_snapshot(snapshot_path, encrypted_temporary, snapshot)
            with _temporary_directory(prefix="cw-r5a-verify-") as verify_root:
                verification_path = Path(verify_root) / "verified.sqlite"
                verified_manifest = _decrypt_snapshot(encrypted_temporary, verification_path)
                with closing(_read_only(verification_path)) as verified_db:
                    verified_snapshot = _database_snapshot(verified_db)
                if verified_manifest != manifest or verified_snapshot != snapshot:
                    raise ValueError("Encrypted backup failed isolated restore verification")
            digest, size = _file_digest(encrypted_temporary)
            return {"status": "completed", "backup_id": manifest["backup_id"],
                    "sha256": digest, "size_bytes": size, **snapshot}

        return _publish(destination, publish)


def restore_database(backup, destination):
    """Authenticate an encrypted backup and verify its independent SQLite restore."""
    backup = _explicit_external_path(backup, "Encrypted backup", must_exist=True)
    if not backup.is_file():
        raise ValueError("Encrypted backup must be an existing regular file")
    destination = _destination(destination, "Restore destination")
    if backup == destination:
        raise ValueError("Restore destination must differ from the encrypted backup")
    with _temporary_directory(prefix="cw-r5a-restore-") as temporary_root:
        restored_path = Path(temporary_root) / "restored.sqlite"
        manifest = _decrypt_snapshot(backup, restored_path)
        with closing(_read_only(restored_path)) as restored_db:
            actual = _database_snapshot(restored_db)
        if actual != manifest["snapshot"]:
            raise ValueError("Restored database failed integrity or logical-content verification")

        def publish(temporary):
            with restored_path.open("rb") as source, temporary.open("wb") as target:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            return {"status": "restored_and_verified", "backup_id": manifest["backup_id"],
                    "restored_sha256": _file_digest(temporary)[0], **actual}

        return _publish(destination, publish)


def _file_digest(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as content:
        for chunk in iter(lambda: content.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size

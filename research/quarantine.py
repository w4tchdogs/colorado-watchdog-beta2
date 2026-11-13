"""Explicit content-addressed quarantine for rejected original CSV deliveries."""

import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from research.mapping import MAPPINGS

FORMAT = "colorado-watchdog-invalid-csv/v1"
_SAFE_MESSAGES = {
    "county_fips_mismatch": "County and FIPS do not match the selected mapping.",
    "required": "A required source field is missing.",
    "invalid_value": "A source field has an unsupported value.",
    "invalid_url": "The source URL is missing or invalid.",
    "invalid_date": "A source date is invalid.",
    "field_limit": "A source field exceeds the selected mapping limit.",
    "record_width": "A CSV record width differs from the selected mapping.",
    "empty_delivery": "CSV contains no observation records.",
    "multiple_counties": "A delivery contains more than one county.",
    "county_unavailable": "No valid county identifier is available.",
    "county_not_registered": "County is missing from the target database registry.",
    "county_registry_conflict": "Registered county name conflicts with the canonical FIPS mapping.",
    "invalid_provenance": "Delivery provenance is unsupported.",
    "invalid_filename": "An input filename is required.",
    "invalid_version_label": "A delivery version label is invalid.",
    "invalid_lineage_kind": "Delivery lineage is unsupported.",
    "unexpected_parent": "Original delivery cannot specify a parent.",
    "missing_parent": "A required parent delivery is missing.",
    "unexpected_correction_links": "Original delivery cannot specify correction links.",
    "unknown_record_reference": "Correction mapping references an unknown record.",
    "invalid_correction_reference": "Correction target is not in the specified parent delivery.",
    "duplicate_correction_conflict": "Identical rows have conflicting correction targets.",
    "replay_conflict": "Existing delivery has incompatible metadata.",
    "unsupported_header": "Header does not exactly match the selected mapping.",
    "malformed_csv": "CSV structure is malformed.",
    "invalid_encoding": "CSV input is not valid UTF-8.",
    "missing_header": "CSV has no header.",
}


def _is_reparse_point(path):
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(getattr(details, "st_file_attributes", 0) & 0x400)


def _safe_root(root):
    candidate = Path(root)
    if not candidate.is_absolute():
        raise ValueError("Quarantine root must be an explicit absolute path")
    if ".." in candidate.parts:
        raise ValueError("Quarantine root cannot contain parent-directory traversal")
    for path in reversed((candidate, *candidate.parents)):
        if _is_reparse_point(path):
            raise ValueError("Quarantine root cannot contain symbolic links or reparse points")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_dir() or resolved == Path(resolved.anchor):
        raise ValueError("Quarantine root must be an existing non-root directory")
    checkout = Path(__file__).resolve().parents[1]
    if resolved == checkout or checkout in resolved.parents:
        raise ValueError("Quarantine root must be outside the source checkout")
    return resolved


def _safe_name(file_name):
    if (not isinstance(file_name, str) or not file_name or file_name in (".", "..")
            or Path(file_name).name != file_name or Path(file_name).name in (".", "..")
            or re.search(r"[/\\\x00-\x1f]", file_name)):
        raise ValueError("Original filename must be a basename without path separators")
    return file_name


def _safe_diagnostics(report):
    diagnostics = report.get("errors")
    if not isinstance(diagnostics, list) or not diagnostics:
        raise ValueError("Invalid CSV quarantine requires sanitized validation findings")
    if len(diagnostics) > 500:
        raise ValueError("Validation findings exceed the quarantine diagnostic limit")
    clean = []
    for item in diagnostics:
        if not isinstance(item, dict):
            raise ValueError("Validation finding is malformed")
        record = item.get("record_number")
        start, end = item.get("line_start"), item.get("line_end")
        if any(value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 1)
               for value in (record, start, end)):
            raise ValueError("Validation finding has an invalid record locator")
        category = item.get("category")
        if not isinstance(category, str) or not re.fullmatch(r"[a-z0-9_]{1,64}", category):
            raise ValueError("Validation finding has an invalid category")
        field = item.get("field")
        if field is not None and (not isinstance(field, str) or not re.fullmatch(r"[a-z_]{1,64}", field)):
            raise ValueError("Validation finding has an invalid field locator")
        clean.append({"record_number": record, "line_start": start, "line_end": end,
                      "field": field, "category": category,
                      "message": _SAFE_MESSAGES.get(category, "CSV validation failed.")})
    return clean


def _write_file(path, payload):
    with path.open("xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def _load_complete(target, metadata, payload):
    if _is_reparse_point(target) or not target.is_dir():
        raise ValueError("Existing content-addressed quarantine entry is not a safe directory")
    manifest_path, source_path = target / "manifest.json", target / "source.bin"
    if any(_is_reparse_point(path) or not path.is_file() for path in (manifest_path, source_path)):
        raise ValueError("Existing quarantine entry is incomplete or contains unsafe paths")
    if sorted(path.name for path in target.iterdir()) != ["manifest.json", "source.bin"]:
        raise ValueError("Existing quarantine entry contains unexpected files")
    try:
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("Existing quarantine manifest is unreadable") from error
    if source_path.read_bytes() != payload:
        raise ValueError("Content-addressed quarantine hash collision or corrupt payload")
    expected = {key: value for key, value in metadata.items() if key != "attempted_at"}
    actual = {key: value for key, value in existing.items() if key != "attempted_at"}
    if actual != expected:
        raise ValueError("Identical source bytes were already quarantined with conflicting metadata")
    return existing


def quarantine_invalid_original(root, payload, *, file_name, version, version_label,
                                validation_report, provenance="legacy_delivery"):
    """Atomically preserve exact bytes and sanitized findings outside the repository."""
    if not isinstance(payload, bytes):
        raise ValueError("Quarantine payload must be the original CSV bytes")
    if version not in MAPPINGS:
        raise ValueError("An explicitly registered mapping version is required")
    if not isinstance(version_label, str) or not version_label.strip():
        raise ValueError("A nonblank delivery version label is required")
    if provenance not in ("synthetic", "legacy_delivery"):
        raise ValueError("Delivery provenance must be synthetic or legacy_delivery")
    if validation_report.get("eligible") is not False:
        raise ValueError("Only an ineligible delivery can be quarantined")
    if validation_report.get("mapping_version") != version:
        raise ValueError("Validation findings use a different mapping version")
    lineage = validation_report.get("lineage")
    if not isinstance(lineage, dict) or lineage.get("kind") != "original" or lineage.get("parent_batch_id") is not None:
        raise ValueError("Only rejected original deliveries without a parent can be quarantined")
    file_name = _safe_name(file_name)
    root = _safe_root(root)
    digest = hashlib.sha256(payload).hexdigest()
    metadata = {
        "format": FORMAT,
        "sha256": digest,
        "size_bytes": len(payload),
        "original_file_name": file_name,
        "mapping_version": version,
        "version_label": version_label,
        "lineage": {"kind": "original", "parent_batch_id": None, "provenance": provenance},
        "validation": {
            "header_match": validation_report.get("header_match"),
            "column_count": validation_report.get("column_count"),
            "records": validation_report.get("records"),
            "errors": _safe_diagnostics(validation_report),
            "diagnostics_truncated": bool(validation_report.get("diagnostics_truncated", False)),
        },
    }
    target = root / digest
    if _is_reparse_point(target):
        raise ValueError("Content-addressed quarantine path cannot be a symbolic link or reparse point")
    if target.exists():
        existing = _load_complete(target, metadata, payload)
        return {"status": "already_present", "sha256": digest, "size_bytes": len(payload),
                "path": str(target), "attempted_at": existing["attempted_at"],
                "diagnostic_count": len(metadata["validation"]["errors"])}

    stage = root / f".{digest}.{uuid4().hex}.tmp"
    stage.mkdir(mode=0o700)
    manifest = {**metadata, "attempted_at": datetime.now(timezone.utc).isoformat()}
    try:
        _write_file(stage / "source.bin", payload)
        _write_file(stage / "manifest.json", (json.dumps(manifest, ensure_ascii=False,
                                                          sort_keys=True, separators=(",", ":")) + "\n")
                    .encode("utf-8"))
        try:
            os.rename(stage, target)
        except FileExistsError:
            existing = _load_complete(target, metadata, payload)
            return {"status": "already_present", "sha256": digest, "size_bytes": len(payload),
                    "path": str(target), "attempted_at": existing["attempted_at"],
                    "diagnostic_count": len(metadata["validation"]["errors"])}
    finally:
        if stage.parent == root and stage.name.startswith(f".{digest}."):
            if _is_reparse_point(stage):
                stage.unlink()
            elif stage.exists():
                shutil.rmtree(stage)
    return {"status": "quarantined", "sha256": digest, "size_bytes": len(payload),
            "path": str(target), "attempted_at": manifest["attempted_at"],
            "diagnostic_count": len(metadata["validation"]["errors"])}

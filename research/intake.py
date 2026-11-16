"""Read-only intake previews over the established R0 mapping and delivery model."""

from collections import defaultdict
import hashlib

from research.db import validate_migration_history
from research.mapping import (COUNTIES, CsvHeaderMismatch, CsvStructureError, canonical_json,
                              mapping_definition, parse_csv_report)


def preview_csv(db, payload, *, file_name, version, version_label=None,
                lineage_kind="original", parent_batch_id=None, selected=False,
                provenance="legacy_delivery", supersedes=None, max_errors=100):
    """Validate one delivery without writes or exposing row contents."""
    history = validate_migration_history(db)
    parsed = parse_csv_report(payload, version, max_errors=max_errors)
    rows = parsed["rows"]
    supersedes = {} if supersedes is None else supersedes
    errors = list(parsed["errors"])
    diagnostics_truncated = parsed["diagnostics_truncated"]

    def add_error(category, message, *, record_number=None, field=None, line_start=None, line_end=None):
        nonlocal diagnostics_truncated
        if len(errors) < max_errors:
            item = {"record_number": record_number, "line_start": line_start, "line_end": line_end,
                    "field": field, "category": category, "message": message}
            errors.append(item)
        else:
            diagnostics_truncated = True

    record_numbers = {row["record_number"] for row in rows}
    if not parsed["record_count"]:
        add_error("empty_delivery", "CSV contains no observation records")
    counties = set(parsed["county_fips_values"])
    if len(counties) > 1:
        add_error("multiple_counties", "A delivery must contain observations for exactly one county")
    county_fips = next(iter(counties)) if len(counties) == 1 else None
    if county_fips is None and rows and len(counties) == 0:
        add_error("county_unavailable", "No valid county identifier is available for lineage checks")
    if county_fips is not None:
        registered = db.execute('SELECT "County name" AS name FROM counties WHERE "County code"=?', (county_fips,)).fetchone()
        if registered is None:
            add_error("county_not_registered", "County is missing from the target database registry",
                      field="county_fips")
        elif registered["name"] != COUNTIES[county_fips]:
            add_error("county_registry_conflict", "Registered county name conflicts with the canonical FIPS mapping",
                      field="county_fips")
    if provenance not in ("synthetic", "legacy_delivery"):
        add_error("invalid_provenance", "Provenance must be synthetic or legacy_delivery")
    if not file_name or not file_name.strip():
        add_error("invalid_filename", "Input filename is required")
    if version_label is not None and not version_label.strip():
        add_error("invalid_version_label", "Version label cannot be blank")
    if lineage_kind not in ("original", "complementary", "corrected", "alternative"):
        add_error("invalid_lineage_kind", "Unsupported delivery lineage kind")
    elif lineage_kind in ("original", "complementary") and parent_batch_id is not None:
        add_error("unexpected_parent", "Original and complementary deliveries cannot specify a parent batch")
    elif lineage_kind in ("corrected", "alternative") and parent_batch_id is None:
        add_error("missing_parent", "Corrected and alternative deliveries require a parent batch")
    if supersedes and lineage_kind not in ("corrected", "alternative"):
        add_error("unexpected_correction_links", "Record correction links require corrected or alternative lineage")
    unknown_records = set(supersedes) - record_numbers
    for record_number in sorted(unknown_records):
        add_error("unknown_record_reference", "Correction link references a record that did not validate",
                  record_number=record_number, field="supersedes")

    parent = None
    if parent_batch_id is not None:
        parent = db.execute("SELECT id,county_fips,family_id,selected FROM scrape_batches WHERE id=?",
                            (parent_batch_id,)).fetchone()
        if parent is None:
            add_error("missing_parent", "Parent delivery does not exist")
        elif county_fips is not None and parent["county_fips"] != county_fips:
            add_error("parent_county_mismatch", "Parent delivery belongs to a different county")

    if supersedes and parent is not None and county_fips == parent["county_fips"]:
        grouped_targets = defaultdict(set)
        row_by_number = {row["record_number"]: row for row in rows}
        for record_number, claim_id in supersedes.items():
            if record_number not in record_numbers:
                continue
            claim = db.execute(
                'SELECT 1 FROM role_claims c JOIN evidence_links e ON e."Evidence record ID"=c."Evidence record ID" '
                'WHERE c."Role claim ID"=? AND c."County code"=? AND e."Import batch ID"=?',
                (claim_id, county_fips, parent_batch_id),
            ).fetchone()
            if claim is None:
                add_error("invalid_correction_reference", "Correction target is not a claim in the parent delivery",
                          record_number=record_number, field="supersedes",
                          line_start=row_by_number[record_number]["line_start"],
                          line_end=row_by_number[record_number]["line_end"])
                continue
            grouped_targets[row_by_number[record_number]["row_sha256"]].add(claim_id)
        for digest, targets in grouped_targets.items():
            if len(targets) > 1:
                row = next(row for row in rows if row["row_sha256"] == digest)
                add_error("duplicate_correction_conflict",
                          "Identical rows cannot supersede different parent claims",
                          record_number=row["record_number"], field="supersedes",
                          line_start=row["line_start"], line_end=row["line_end"])

    grouped = defaultdict(list)
    for row in rows:
        grouped[row["row_sha256"]].append(row)
    distinct_urls = {row["values"]["source_url"] for row in rows}
    replay = {"status": "new", "batch_id": None, "selected": None, "conflicts": []}
    if county_fips is not None:
        existing = db.execute(
            "SELECT * FROM scrape_batches WHERE county_fips=? AND file_sha256=? AND mapping_version=?",
            (county_fips, parsed["file_sha256"], version),
        ).fetchone()
        if existing:
            conflicts = []
            if existing["original_file_name"] != file_name:
                conflicts.append("original filename differs")
            if version_label is not None and existing["version_label"] != version_label:
                conflicts.append("version label differs")
            if (existing["lineage_kind"], existing["parent_batch_id"], existing["provenance_type"]) != (
                    lineage_kind, parent_batch_id, provenance):
                conflicts.append("lineage metadata differs")
            if existing["mapping_json"] != canonical_json(mapping_definition(parsed["mapping"])):
                conflicts.append("mapping definition differs")
            for digest in grouped:
                old = db.execute(
                    'SELECT c."Earlier claim this replaces" AS supersedes_id FROM role_claims c JOIN evidence_links e ON e."Evidence record ID"=c."Evidence record ID" '
                    'WHERE e."Import batch ID"=? AND e."Original record fingerprint"=?',
                    (existing["id"], digest),
                ).fetchone()
                target = next((supersedes[o["record_number"]] for o in grouped[digest]
                               if o["record_number"] in supersedes), None)
                if old is None or old[0] != target:
                    conflicts.append("correction relationships differ")
                    break
            replay = {"status": "metadata_conflict" if conflicts else
                      ("replay_match" if version_label is not None else "replay_candidate"),
                      "batch_id": existing["id"], "selected": bool(existing["selected"]),
                      "conflicts": conflicts}
            if conflicts:
                add_error("replay_conflict", "Existing delivery has incompatible metadata: " + "; ".join(conflicts))

    return {
        "mode": "preview", "mapping_version": version, "file_name": file_name,
        "file_sha256": parsed["file_sha256"], "file_size_bytes": len(payload),
        "column_count": parsed["column_count"], "header_match": True,
        "county": ({"fips": county_fips, "name": COUNTIES[county_fips]} if county_fips else None),
        "records": {"total": parsed["record_count"], "valid": len(rows),
                    "invalid": parsed["invalid_record_count"],
                    "duplicate_rows": len(rows) - len(grouped),
                    "expected_distinct_claims": len(grouped)},
        "source_urls": {"records_with_url": sum(len(items) for items in grouped.values()),
                        "distinct": len(distinct_urls)},
        "source_metadata": {"records_with_title": sum(bool(row["values"]["source_title"]) for row in rows),
                            "records_with_source_date": sum(bool(row["values"]["source_date"]) for row in rows),
                            "records_with_checked_date": sum(bool(row["values"]["checked_date"]) for row in rows)},
        "lineage": {"kind": lineage_kind, "parent_batch_id": parent_batch_id,
                    "family_id": parent["family_id"] if parent else None,
                    "parent_selected": bool(parent["selected"]) if parent else None,
                    "selected_requested": bool(selected)},
        "replay": replay, "migration_check": history,
        "errors": errors, "warnings": [], "diagnostics_truncated": diagnostics_truncated,
        "eligible": not errors,
    }


def quarantine_validation_report(db, payload, *, file_name, version, version_label,
                                 lineage_kind="original", max_errors=100):
    """Return preview-compatible sanitized findings even for unreadable CSV structure."""
    history = validate_migration_history(db)
    common = {"mode": "preview", "mapping_version": version, "file_name": file_name,
              "file_sha256": hashlib.sha256(payload).hexdigest(), "file_size_bytes": len(payload),
              "county": None, "records": {"total": None, "valid": 0, "invalid": None,
                                                "duplicate_rows": 0, "expected_distinct_claims": 0},
              "source_urls": {"records_with_url": 0, "distinct": 0},
              "source_metadata": {"records_with_title": 0, "records_with_source_date": 0,
                                  "records_with_checked_date": 0},
              "lineage": {"kind": lineage_kind, "parent_batch_id": None, "family_id": None,
                          "parent_selected": None, "selected_requested": False},
              "replay": {"status": "not_assessed", "batch_id": None, "selected": None,
                         "conflicts": []},
              "migration_check": history, "warnings": [], "diagnostics_truncated": False,
              "eligible": False}
    try:
        return preview_csv(db, payload, file_name=file_name, version=version,
                           version_label=version_label, lineage_kind=lineage_kind,
                           max_errors=max_errors)
    except CsvHeaderMismatch as error:
        common.update({"column_count": error.column_count, "header_match": False,
                       "errors": [{"record_number": None, "line_start": None, "line_end": None,
                                   "field": None, "category": "unsupported_header",
                                   "message": "Header does not exactly match the selected mapping"}]})
    except CsvStructureError as error:
        partial = error.partial_report or {}
        prior_errors = list(partial.get("errors", []))
        structural_error = {"record_number": None, "line_start": error.line_start or error.line,
                            "line_end": error.line, "field": None,
                            "category": "malformed_csv", "message": "Malformed CSV structure"}
        if len(prior_errors) < max_errors:
            prior_errors.append(structural_error)
        else:
            common["diagnostics_truncated"] = True
        rows = partial.get("rows", [])
        common["records"] = {"total": partial.get("record_count"), "valid": len(rows),
                              "invalid": partial.get("invalid_record_count"),
                              "duplicate_rows": 0, "expected_distinct_claims": len(rows)}
        common.update({"column_count": error.column_count, "header_match": error.column_count is not None,
                       "errors": prior_errors,
                       "diagnostics_truncated": (common["diagnostics_truncated"]
                                                  or partial.get("diagnostics_truncated", False))})
    except UnicodeDecodeError:
        common.update({"column_count": None, "header_match": None,
                       "errors": [{"record_number": None, "line_start": None, "line_end": None,
                                   "field": None, "category": "invalid_encoding",
                                   "message": "CSV input is not valid UTF-8"}]})
    except ValueError as error:
        if str(error) != "CSV has no header":
            raise
        common.update({"column_count": None, "header_match": False,
                       "errors": [{"record_number": None, "line_start": None, "line_end": None,
                                   "field": None, "category": "missing_header",
                                   "message": "CSV has no header"}]})
    return common

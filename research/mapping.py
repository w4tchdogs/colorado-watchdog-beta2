"""Explicit versioned legacy mappings. Validation never repairs source wording."""

import csv
import hashlib
import io
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from urllib.parse import urlsplit

HEADERS_17 = (
    "County FIPS", "County", "Full name", "Nicknames", "Display group (proposed)",
    "Grouping basis", "Department / office", "Division / unit", "Program / location",
    "Position / title", "Other documented responsibility", "Listing status",
    "Official source title", "Official source URL", "Source date", "Checked date",
    "Private review note",
)
FIELDS_17 = (
    "county_fips", "county", "full_name", "nicknames", "display_group", "grouping_basis",
    "department", "division", "program_location", "title", "responsibility",
    "listing_status", "source_title", "source_url", "source_date", "checked_date", "private_note",
)
HEADERS_11 = (
    "County FIPS", "County", "Full name", "Department / office", "Position / title",
    "Listing status", "Official source title", "Official source URL", "Source date",
    "Checked date", "Private review note",
)
FIELDS_11 = (
    "county_fips", "county", "full_name", "department", "title", "listing_status",
    "source_title", "source_url", "source_date", "checked_date", "private_note",
)
HEADERS_16 = (
    "County FIPS", "County", "Full name", "Display group (proposed)", "Grouping basis",
    "Department / office", "Division / unit", "Program / location", "Position / title",
    "Other documented responsibility", "Listing status", "Official source title",
    "Official source URL", "Source date", "Checked date", "Private review note",
)
FIELDS_16 = (
    "county_fips", "county", "full_name", "display_group", "grouping_basis", "department",
    "division", "program_location", "title", "responsibility", "listing_status",
    "source_title", "source_url", "source_date", "checked_date", "private_note",
)
# Public geographic identifiers, not county research or a statewide office template.
COUNTIES = dict(zip(
    [f"08{i:03d}" for i in range(1, 126, 2)] + ["08014"],
    ("Adams|Alamosa|Arapahoe|Archuleta|Baca|Bent|Boulder|Chaffee|Cheyenne|Clear Creek|"
     "Conejos|Costilla|Crowley|Custer|Delta|Denver|Dolores|Douglas|Eagle|Elbert|El Paso|"
     "Fremont|Garfield|Gilpin|Grand|Gunnison|Hinsdale|Huerfano|Jackson|Jefferson|Kiowa|"
     "Kit Carson|Lake|La Plata|Larimer|Las Animas|Lincoln|Logan|Mesa|Mineral|Moffat|"
     "Montezuma|Montrose|Morgan|Otero|Ouray|Park|Phillips|Pitkin|Prowers|Pueblo|Rio Blanco|"
     "Rio Grande|Routt|Saguache|San Juan|San Miguel|Sedgwick|Summit|Teller|Washington|"
     "Weld|Yuma|Broomfield").split("|"), strict=True,
))


@dataclass(frozen=True)
class MappingSpec:
    version: str
    headers: tuple
    fields: tuple
    county_name_policy: str = "exact"
    legacy_field_limits: bool = False
    grouping_basis_policy: str = "r0"

    def __post_init__(self):
        required = {"county_fips", "county", "full_name", "listing_status", "source_url"}
        if not self.version or len(self.headers) not in (11, 16, 17):
            raise ValueError("An explicit version and 11, 16, or 17 headers are required")
        if len(self.headers) != len(self.fields) or len(set(self.headers)) != len(self.headers):
            raise ValueError("Headers and fields must be one-to-one")
        if len(set(self.fields)) != len(self.fields) or not set(self.fields) <= set(FIELDS_17):
            raise ValueError("Unknown or repeated destination fields")
        if not required <= set(self.fields):
            raise ValueError("Mapping omits a required field")
        if self.county_name_policy not in ("exact", "beta1"):
            raise ValueError("Unknown county-name policy")
        if self.grouping_basis_policy not in ("r0", "raw"):
            raise ValueError("Unknown grouping-basis policy")
        if self.legacy_field_limits and self.version == "legacy-17/v1":
            raise ValueError("The existing 17-column mapping cannot change validation policy")


LEGACY_17 = MappingSpec("legacy-17/v1", HEADERS_17, FIELDS_17)
LEGACY_11 = MappingSpec("legacy-11/v1", HEADERS_11, FIELDS_11, "beta1", True, "raw")
LEGACY_16 = MappingSpec("legacy-16/v1", HEADERS_16, FIELDS_16, "beta1", True, "raw")
MAPPINGS = {spec.version: spec for spec in (LEGACY_17, LEGACY_11, LEGACY_16)}


def _normalize_county_name(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _county_name_matches(fips, value, policy):
    if policy == "exact":
        return value == COUNTIES[fips]
    name = COUNTIES[fips]
    aliases = {name, name + " County"}
    if name in ("Denver", "Broomfield"):
        aliases.add("City and County of " + name)
    normalized = _normalize_county_name(value)
    return any(normalized == _normalize_county_name(alias) for alias in aliases)


def register_mapping(spec, registry):
    """Callers may register explicit future 11/16 maps; width is never guessed."""
    if spec.version in registry:
        raise ValueError("Mapping versions cannot be replaced")
    registry[spec.version] = spec


def date_precision(value):
    if value is None or value == "":
        return None
    if not re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", value):
        raise ValueError("Expected YYYY, YYYY-MM, or YYYY-MM-DD")
    date.fromisoformat(value + {4: "-01-01", 7: "-01", 10: ""}[len(value)])
    return {4: "year", 7: "month", 10: "day"}[len(value)]


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def mapping_definition(spec):
    definition = {"headers": spec.headers, "fields": spec.fields}
    if spec.version != "legacy-17/v1":
        definition["county_name_policy"] = spec.county_name_policy
        definition["legacy_field_limits"] = spec.legacy_field_limits
        definition["grouping_basis_policy"] = spec.grouping_basis_policy
    return definition


class CsvHeaderMismatch(ValueError):
    def __init__(self, message, column_count):
        super().__init__(message)
        self.column_count = column_count


class CsvStructureError(ValueError):
    def __init__(self, message, column_count=None, line=None, *, line_start=None, partial_report=None):
        super().__init__(message)
        self.column_count = column_count
        self.line = line
        self.line_start = line_start
        self.partial_report = partial_report


def _record_errors(record_number, values, spec):
    errors = []

    def add(field, category, message):
        errors.append({"record_number": record_number, "field": field,
                       "category": category, "message": f"Record {record_number}: {message}"})

    fips = values["county_fips"]
    if fips not in COUNTIES or not _county_name_matches(fips, values["county"], spec.county_name_policy):
        add("county", "county_fips_mismatch", "county/FIPS mismatch")
    if not values["full_name"].strip():
        add("full_name", "required", "missing published name")
    if values["listing_status"] not in ("Listed in official source", "Explicitly former", "Unclear"):
        add("listing_status", "invalid_value", "invalid listing status")
    if spec.grouping_basis_policy == "r0" and values["grouping_basis"] is not None and values["grouping_basis"] not in (
        "Official county structure", "Directory display fallback", "Needs editorial review",
    ):
        add("grouping_basis", "invalid_value", "invalid grouping basis")
    try:
        url = urlsplit(values["source_url"])
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            add("source_url", "invalid_url", "invalid source URL")
    except ValueError:
        add("source_url", "invalid_url", "invalid source URL")
    try:
        precision = date_precision(values["source_date"])
    except (ValueError, TypeError, KeyError):
        precision = None
        add("source_date", "invalid_date", "invalid source date")
    try:
        checked_precision = date_precision(values["checked_date"])
        if checked_precision not in (None, "day"):
            add("checked_date", "invalid_date", "checked date must be a full date")
    except (ValueError, TypeError, KeyError):
        checked_precision = None
        add("checked_date", "invalid_date", "invalid checked date")
    if spec.legacy_field_limits:
        limits = {"full_name": 200, "department": 200, "title": 200,
                  "source_title": 2000, "source_url": 2000, "private_note": 8000,
                  "display_group": 2000, "grouping_basis": 2000,
                  "division": 2000, "program_location": 2000,
                  "responsibility": 2000}
        for field, limit in limits.items():
            value = values[field]
            if value is not None and len(value) > limit:
                add(field, "field_limit", f"{field} exceeds {limit} characters")
    return errors, precision, checked_precision


def parse_csv_report(payload, version="legacy-17/v1", registry=None, *, max_errors=100,
                     stop_on_first_error=False):
    """Parse CSV using the ingestion rules and report bounded per-record errors.

    Structural/header failures raise ValueError. Invalid logical records are returned
    as sanitized diagnostics and are omitted from ``rows``.
    """
    registry = MAPPINGS if registry is None else registry
    if version not in registry:
        raise ValueError(f"Unregistered mapping: {version}")
    if not isinstance(payload, bytes):
        raise ValueError("CSV input must be bytes")
    if not isinstance(max_errors, int) or max_errors < 1:
        raise ValueError("Diagnostic limit must be a positive integer")
    spec = registry[version]
    text = payload.decode("utf-8-sig", errors="strict")
    lines = text.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    try:
        header = tuple(next(reader))
        if header != spec.headers:
            raise CsvHeaderMismatch("Header does not exactly match the selected mapping", len(header))
        previous_line = reader.line_num
        rows = []
        errors = []
        invalid_records = 0
        total_records = 0
        diagnostics_truncated = False
        county_fips_values = set()
        for record_number, cells in enumerate(reader, 1):
            total_records += 1
            line_end = reader.line_num
            if len(cells) != len(spec.headers):
                invalid_records += 1
                if len(errors) < max_errors:
                    errors.append({"record_number": record_number, "field": None, "category": "record_width",
                                   "line_start": previous_line + 1, "line_end": line_end,
                                   "message": f"Record {record_number}: expected {len(spec.headers)} fields, got {len(cells)}"})
                else:
                    diagnostics_truncated = True
                previous_line = line_end
                if stop_on_first_error:
                    diagnostics_truncated = True
                    break
                continue
            values = dict.fromkeys(FIELDS_17)
            values.update(zip(spec.fields, cells, strict=True))
            if spec.legacy_field_limits:
                for field in ("county_fips", "county", "full_name", "department", "title",
                              "listing_status", "source_title", "source_url", "source_date",
                              "checked_date", "private_note"):
                    if values[field] is not None:
                        values[field] = values[field].strip()
            if values["county_fips"] in COUNTIES:
                county_fips_values.add(values["county_fips"])
            row_errors, precision, _ = _record_errors(record_number, values, spec)
            for error in row_errors:
                error.update({"line_start": previous_line + 1, "line_end": line_end})
            if row_errors:
                invalid_records += 1
                remaining = max_errors - len(errors)
                errors.extend(row_errors[:remaining])
                if len(row_errors) > remaining:
                    diagnostics_truncated = True
                previous_line = line_end
                if stop_on_first_error:
                    diagnostics_truncated = True
                    break
                if len(errors) >= max_errors:
                    diagnostics_truncated = True
                continue
            rows.append({
                "record_number": record_number, "line_start": previous_line + 1,
                "line_end": line_end, "raw_text": "".join(lines[previous_line:line_end]),
                "cells": cells, "values": values, "source_date_precision": precision,
                "row_sha256": hashlib.sha256(canonical_json(cells).encode()).hexdigest(),
            })
            previous_line = line_end
    except StopIteration as error:
        raise ValueError("CSV has no header") from error
    except csv.Error as error:
        partial_report = None
        if "rows" in locals():
            partial_report = {
                "rows": rows,
                "errors": errors,
                "record_count": total_records,
                "invalid_record_count": invalid_records,
                "diagnostics_truncated": diagnostics_truncated,
                "last_complete_line": previous_line,
            }
        raise CsvStructureError(f"Malformed CSV near physical line {reader.line_num}",
                                len(header) if "header" in locals() else None,
                                reader.line_num,
                                line_start=(previous_line + 1 if "previous_line" in locals() else None),
                                partial_report=partial_report) from error
    return {"mapping": spec, "file_sha256": hashlib.sha256(payload).hexdigest(),
            "header": header, "column_count": len(header), "rows": rows,
            "errors": errors, "record_count": total_records,
            "invalid_record_count": invalid_records, "county_fips_values": sorted(county_fips_values),
            "diagnostics_truncated": diagnostics_truncated}


def parse_csv(payload, version="legacy-17/v1", registry=None):
    report = parse_csv_report(payload, version, registry, max_errors=100, stop_on_first_error=True)
    if report["errors"]:
        raise ValueError(report["errors"][0]["message"])
    return {key: report[key] for key in ("mapping", "file_sha256", "rows")}

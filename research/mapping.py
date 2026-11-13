"""Explicit versioned legacy mappings. Validation never repairs source wording."""

import csv
import hashlib
import io
import json
import re
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


LEGACY_17 = MappingSpec("legacy-17/v1", HEADERS_17, FIELDS_17)
MAPPINGS = {LEGACY_17.version: LEGACY_17}


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


def parse_csv(payload, version="legacy-17/v1", registry=None):
    registry = MAPPINGS if registry is None else registry
    if version not in registry:
        raise ValueError(f"Unregistered mapping: {version}")
    spec = registry[version]
    text = payload.decode("utf-8-sig", errors="strict")
    lines = text.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    try:
        if tuple(next(reader)) != spec.headers:
            raise ValueError("Header does not exactly match the selected mapping")
        previous_line = reader.line_num
        rows = []
        for record_number, cells in enumerate(reader, 1):
            line_end = reader.line_num
            if len(cells) != len(spec.headers):
                raise ValueError(f"Record {record_number}: expected {len(spec.headers)} fields, got {len(cells)}")
            values = dict.fromkeys(FIELDS_17)
            values.update(zip(spec.fields, cells, strict=True))
            fips = values["county_fips"]
            if fips not in COUNTIES or values["county"] != COUNTIES[fips]:
                raise ValueError(f"Record {record_number}: county/FIPS mismatch")
            if not values["full_name"].strip():
                raise ValueError(f"Record {record_number}: missing published name")
            if values["listing_status"] not in ("Listed in official source", "Explicitly former", "Unclear"):
                raise ValueError(f"Record {record_number}: invalid listing status")
            if values["grouping_basis"] is not None and values["grouping_basis"] not in (
                "Official county structure", "Directory display fallback", "Needs editorial review",
            ):
                raise ValueError(f"Record {record_number}: invalid grouping basis")
            url = urlsplit(values["source_url"])
            if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
                raise ValueError(f"Record {record_number}: invalid source URL")
            precision = date_precision(values["source_date"])
            checked_precision = date_precision(values["checked_date"])
            if checked_precision not in (None, "day"):
                raise ValueError(f"Record {record_number}: checked date must be a full date")
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
        raise ValueError(f"Malformed CSV near physical line {reader.line_num}") from error
    return {"mapping": spec, "file_sha256": hashlib.sha256(payload).hexdigest(), "rows": rows}

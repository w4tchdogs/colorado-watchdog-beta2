"""Invented people, units, and example.invalid URLs; counties are mapping cases only."""

import csv
import io

from research.mapping import HEADERS_17, FIELDS_17, COUNTIES


def observation(fips="08107", **changes):
    values = dict.fromkeys(FIELDS_17, "")
    values.update(
        county_fips=fips, county=COUNTIES[fips], full_name="Synthetic Rowan Example",
        department="Fixture Services", title="Fixture Coordinator", listing_status="Listed in official source",
        source_title="Invented directory", source_url=f"https://example.invalid/{fips}/directory",
        source_date="2025-03", checked_date="2026-11-12",
        display_group="Illustrative display", grouping_basis="Official county structure",
        private_note="SYNTHETIC ONLY; no actual personnel or county hierarchy assertion.",
    )
    values.update(changes)
    return [values[key] for key in FIELDS_17]


def csv_bytes(rows, headers=HEADERS_17):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")

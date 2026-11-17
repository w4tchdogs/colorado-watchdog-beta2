"""Dates carried by retained source evidence."""

from datetime import date, datetime


def source_found_on(first_discovered, reported_check_date):
    """Return a recorded discovery day without substituting an import date."""
    for value in (first_discovered, reported_check_date):
        if not isinstance(value, str) or not value.strip():
            continue
        value = value.strip()
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
            except ValueError:
                continue
    return None

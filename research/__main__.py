"""Explicit local initialization and read-only integrity inspection."""

import argparse
import json
import sqlite3
from pathlib import Path

from research.db import connect, migrate, validate_database


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "check"))
    parser.add_argument("database", type=Path, help="Explicit path outside the source checkout")
    args = parser.parse_args()
    path = args.database.resolve()
    repo = Path(__file__).resolve().parents[1]
    if path == repo or repo in path.parents:
        parser.error("Research databases must be outside the source checkout")
    if args.command == "init":
        # Exclusive create preserves existing files. Migrations are separately reusable.
        with path.open("xb"):
            pass
        db = connect(path)
        try:
            migrate(db)
            print(json.dumps(validate_database(db)))
        finally:
            db.close()
    else:
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        try:
            result = validate_database(db)
            print(json.dumps(result))
            if result["integrity"] != "ok" or result["foreign_keys"] or result["schema_version"] != 1:
                raise SystemExit(1)
        finally:
            db.close()


if __name__ == "__main__":
    main()

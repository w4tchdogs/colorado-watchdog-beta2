"""SQLite connections and transactional, checksum-verified migrations."""

import hashlib
import sqlite3
from pathlib import Path

from research.mapping import COUNTIES

MIGRATIONS = Path(__file__).parent / "migrations"


def connect(path=":memory:"):
    if sqlite3.sqlite_version_info < (3, 37, 0):
        raise RuntimeError("SQLite 3.37+ is required for STRICT tables")
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 5000")
    return db


def migrate(db, directory=MIGRATIONS):
    """Apply packaged migrations atomically; refuse edited/applied or unknown history."""
    if db.in_transaction:
        raise ValueError("Finish the current transaction before migrating")
    if db.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise ValueError("Foreign keys must be enabled")
    files = sorted(Path(directory).glob("[0-9][0-9][0-9]_*.sql"))
    if not files:
        raise ValueError("No migrations found")
    names = [p.name for p in files]
    versions = [int(p.name[:3]) for p in files]
    if versions != list(range(1, len(files) + 1)):
        raise ValueError("Migration versions must be contiguous from 001")
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if tables and "schema_migrations" not in tables:
        raise ValueError("Refusing to adopt an unmanaged database")
    applied = list(db.execute("SELECT name, sha256 FROM schema_migrations ORDER BY name")) if tables else []
    if [r[0] for r in applied] != names[:len(applied)]:
        raise ValueError("Unknown or noncontiguous migration history")
    if db.execute("PRAGMA user_version").fetchone()[0] != len(applied):
        raise ValueError("Schema version differs from migration history")
    for index, path in enumerate(files):
        # Hash logical LF text so Windows and Linux use the same migration identity.
        sql = path.read_text(encoding="utf-8")
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if index < len(applied):
            if applied[index][1] != digest:
                raise ValueError(f"Applied migration changed: {path.name}")
            continue
        name = path.name.replace("'", "''")
        script = (
            "BEGIN IMMEDIATE;\n"
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "name TEXT PRIMARY KEY, sha256 TEXT NOT NULL) STRICT;\n"
            + sql
            + f"\nINSERT INTO schema_migrations VALUES ('{name}', '{digest}');\n"
            + f"PRAGMA user_version = {index + 1};\nCOMMIT;"
        )
        try:
            db.executescript(script)
        except Exception:
            db.rollback()
            raise
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Foreign-key violations present")


def validate_database(db):
    return {
        "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
        "foreign_keys": [tuple(row) for row in db.execute("PRAGMA foreign_key_check")],
        "schema_version": db.execute("PRAGMA user_version").fetchone()[0],
    }


def validate_migration_history(db, directory=MIGRATIONS):
    """Read-only verification that every packaged migration is already applied."""
    files = sorted(Path(directory).glob("[0-9][0-9][0-9]_*.sql"))
    names = [path.name for path in files]
    versions = [int(name[:3]) for name in names]
    if not files or versions != list(range(1, len(files) + 1)):
        raise ValueError("Packaged migration versions are missing or noncontiguous")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "schema_migrations" not in tables:
        raise ValueError("Database has no managed migration history")
    applied = list(db.execute("SELECT name,sha256 FROM schema_migrations ORDER BY name"))
    if [row[0] for row in applied] != names:
        raise ValueError("Database migration history is incomplete or differs from this checkout")
    if db.execute("PRAGMA user_version").fetchone()[0] != len(files):
        raise ValueError("Schema version differs from migration history")
    for path, row in zip(files, applied, strict=True):
        digest = hashlib.sha256(path.read_text(encoding="utf-8").encode()).hexdigest()
        if row[1] != digest:
            raise ValueError(f"Applied migration changed: {path.name}")
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Foreign-key violations present")
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise ValueError(f"Database integrity check failed: {integrity}")
    return {"integrity": integrity, "schema_version": len(files), "migration_count": len(files)}


def seed_counties(db):
    """Add the canonical public county registry without repairing conflicting rows."""
    if db.in_transaction:
        raise ValueError("Finish the current transaction before seeding counties")
    if not isinstance(COUNTIES, dict) or len(COUNTIES) != 64:
        raise ValueError("Canonical Colorado county mapping is incomplete")
    if any(not isinstance(fips, str) or len(fips) != 5 or not fips.startswith("08")
           or not isinstance(name, str) or not name.strip()
           for fips, name in COUNTIES.items()):
        raise ValueError("Canonical Colorado county mapping contains an invalid entry")
    with db:
        db.execute("BEGIN IMMEDIATE")
        validate_migration_history(db)
        rows = list(db.execute("SELECT fips,name FROM counties ORDER BY fips"))
        existing = {row["fips"]: row["name"] for row in rows}
        names = {row["name"]: row["fips"] for row in rows}
        present = [{"fips": fips, "name": name} for fips, name in sorted(existing.items())
                   if COUNTIES.get(fips) == name]
        conflicts = []
        for fips, name in sorted(existing.items()):
            expected = COUNTIES.get(fips)
            if expected is None:
                conflicts.append({"fips": fips, "reason": "unexpected_fips"})
            elif expected != name:
                conflicts.append({"fips": fips, "reason": "name_mismatch"})
        for name, fips in sorted(names.items()):
            expected_fips = next((key for key, value in COUNTIES.items() if value == name), None)
            if expected_fips is not None and expected_fips != fips and not any(
                    conflict["fips"] == fips for conflict in conflicts):
                conflicts.append({"fips": fips, "reason": "name_assigned_to_different_fips"})
        if conflicts:
            db.rollback()
            return {"status": "conflict", "inserted": [], "already_present": present,
                    "conflicts": conflicts}
        missing = [(fips, name) for fips, name in sorted(COUNTIES.items()) if fips not in existing]
        db.executemany("INSERT INTO counties(fips,name) VALUES (?,?)", missing)
        return {"status": "seeded" if missing else "already_present",
                "inserted": [{"fips": fips, "name": name} for fips, name in missing],
                "already_present": present, "conflicts": []}

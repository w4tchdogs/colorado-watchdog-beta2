"""SQLite connections and transactional, checksum-verified migrations."""

import hashlib
import sqlite3
from pathlib import Path

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

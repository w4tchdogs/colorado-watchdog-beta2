"""Create a disposable, empty synthetic Profiles database for MCP tests."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from research.db import connect, migrate


def main():
    path = Path(sys.argv[1]).resolve()
    db = connect(path)
    try:
        migrate(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()

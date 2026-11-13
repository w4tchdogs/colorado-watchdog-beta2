"""Local research database initialization, inspection, and evidence-led operations."""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from research import operator
from research.db import connect, migrate, validate_database


def parser_for():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    def database_command(name, help_text):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("database", type=Path, help="Explicit database path outside the source checkout")
        return command

    database_command("init", "exclusively create and initialize an empty database")
    database_command("check", "validate an existing database without writing")

    def inspection(name, help_text):
        command = database_command(name, help_text)
        command.add_argument("--county")
        command.add_argument("--limit", type=int, default=50)
        return command

    inspection("counties", "list county registry rows")
    units = inspection("units", "inspect organizational units")
    units.add_argument("--unit-id")
    people = inspection("people", "inspect research people and their claims")
    people.add_argument("--person-id")
    claims = inspection("claims", "inspect role claims")
    claims.add_argument("--claim-id")
    claims.add_argument("--status", choices=("Listed", "Explicitly former", "Unclear"))
    claims.add_argument("--unassigned", action="store_true")
    inspection("unassigned", "inspect claims with no person association")
    sources = inspection("sources", "inspect sources, evidence, and visit telemetry")
    sources.add_argument("--source-id")
    matches = inspection("matches", "inspect possible identity matches")
    matches.add_argument("--status", choices=("open", "same_supported", "different_supported"))
    matches.add_argument("--person-id")
    coverage = inspection("coverage", "inspect independent organizational coverage dimensions")
    coverage.add_argument("--unit-id")
    coverage.add_argument("--axis", choices=operator.AXES)
    coverage.add_argument("--status", choices=operator.COVERAGE)
    events = database_command("events", "inspect recorded research events and provenance")
    events.add_argument("--run-id")
    events.add_argument("--entity-type")
    events.add_argument("--entity-id")
    events.add_argument("--kind")
    events.add_argument("--limit", type=int, default=50)

    associate = database_command("associate-claim", "link one claim to one person using documented support")
    associate.add_argument("--claim-id", required=True)
    associate.add_argument("--person-id", required=True)
    associate.add_argument("--evidence-id", required=True)
    associate.add_argument("--rationale", required=True)
    associate.add_argument("--actor", required=True)

    bootstrap = database_command("bootstrap-person", "create a source-supported person and assign one claim atomically")
    bootstrap.add_argument("--county-fips", required=True)
    bootstrap.add_argument("--claim-id", required=True)
    bootstrap.add_argument("--published-name", required=True)
    bootstrap.add_argument("--evidence-id", required=True)
    bootstrap.add_argument("--actor", required=True)
    bootstrap.add_argument("--rationale", required=True)

    variant = database_command("add-name-variant", "record an evidence-linked name form for an existing person")
    variant.add_argument("--person-id", required=True)
    variant.add_argument("--published-name", required=True)
    variant.add_argument("--kind", choices=("published", "nickname", "former", "alternative"), required=True)
    variant.add_argument("--evidence-id", required=True)
    variant.add_argument("--actor", required=True)
    variant.add_argument("--rationale", required=True)

    visit = database_command("record-visit", "record a source visit or attempt without fetching")
    visit.add_argument("--source-id", required=True)
    visit.add_argument("--run-id", required=True)
    visit.add_argument("--provenance", choices=operator.VISIT_PROVENANCE, required=True)
    visit.add_argument("--outcome", choices=operator.VISIT_OUTCOMES, required=True)
    visit.add_argument("--actor", required=True)
    visit.add_argument("--evidence-id")
    visit.add_argument("--reported-checked-date")
    visit.add_argument("--attempted-at")
    visit.add_argument("--attempt", type=int)
    visit.add_argument("--http-status", type=int)
    visit.add_argument("--duration-ms", type=int)
    visit.add_argument("--content-sha256")
    visit.add_argument("--etag")
    visit.add_argument("--last-modified")
    visit.add_argument("--result-count", type=int)
    visit.add_argument("--note")

    coverage_set = database_command("set-coverage", "update exactly one coverage dimension")
    coverage_set.add_argument("--unit-id", required=True)
    coverage_set.add_argument("--axis", choices=operator.AXES, required=True)
    coverage_set.add_argument("--status", choices=operator.COVERAGE, required=True)
    coverage_set.add_argument("--evidence-id")
    coverage_set.add_argument("--run-id", required=True)
    coverage_set.add_argument("--actor", required=True)
    coverage_set.add_argument("--rationale", required=True)
    coverage_set.add_argument("--assessed-at")
    coverage_set.add_argument("--limitations")
    coverage_set.add_argument("--next-task")
    return parser


def _path(args, parser):
    path = args.database.resolve()
    repo = Path(__file__).resolve().parents[1]
    if path == repo or repo in path.parents:
        parser.error("Research databases must be outside the source checkout")
    return path


def _read_only(path):
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def main(argv=None):
    parser = parser_for()
    args = parser.parse_args(argv)
    path = _path(args, parser)
    if args.command == "init":
        try:
            with path.open("xb"):
                pass
            db = connect(path)
            try:
                migrate(db)
                print(json.dumps(validate_database(db), sort_keys=True))
            finally:
                db.close()
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    if not path.is_file():
        print("error: database file does not exist", file=sys.stderr)
        return 2
    try:
        if args.command in {"check", "counties", "units", "people", "claims", "unassigned", "sources",
                            "matches", "coverage", "events"}:
            db = _read_only(path)
            try:
                if args.command == "check":
                    result = validate_database(db)
                    print(json.dumps(result, sort_keys=True))
                    return 0 if result["integrity"] == "ok" and not result["foreign_keys"] and result["schema_version"] == 1 else 1
                limit = operator._limit(args.limit)
                if args.command == "counties":
                    result = operator.inspect_counties(db, county=args.county, limit=limit)
                elif args.command == "units":
                    result = operator.inspect_units(db, county=args.county, unit_id=args.unit_id, limit=limit)
                elif args.command == "people":
                    result = operator.inspect_people(db, county=args.county, person_id=args.person_id, limit=limit)
                elif args.command == "claims":
                    result = operator.inspect_claims(db, county=args.county, claim_id=args.claim_id,
                                                     status=args.status, unassigned=args.unassigned, limit=limit)
                elif args.command == "unassigned":
                    result = operator.inspect_claims(db, county=args.county, unassigned=True, limit=limit)
                elif args.command == "sources":
                    result = operator.inspect_sources(db, county=args.county, source_id=args.source_id, limit=limit)
                elif args.command == "matches":
                    result = operator.inspect_matches(db, county=args.county, status=args.status,
                                                      person_id=args.person_id, limit=limit)
                elif args.command == "coverage":
                    result = operator.inspect_coverage(db, county=args.county, unit_id=args.unit_id,
                                                       axis=args.axis, status=args.status, limit=limit)
                else:
                    result = operator.inspect_events(db, run_id=args.run_id, entity_type=args.entity_type,
                                                     entity_id=args.entity_id, kind=args.kind, limit=limit)
            finally:
                db.close()
        else:
            db = connect(path)
            try:
                if args.command == "associate-claim":
                    result = operator.associate_claim(db, claim_id=args.claim_id, person_id=args.person_id,
                                                      evidence_id=args.evidence_id, rationale=args.rationale,
                                                      actor=args.actor)
                elif args.command == "bootstrap-person":
                    result = operator.bootstrap_person(db, county_fips=args.county_fips, claim_id=args.claim_id,
                                                       published_name=args.published_name, evidence_id=args.evidence_id, actor=args.actor,
                                                       rationale=args.rationale)
                elif args.command == "add-name-variant":
                    result = operator.add_name_variant(db, person_id=args.person_id,
                                                       published_name=args.published_name, kind=args.kind,
                                                       evidence_id=args.evidence_id, actor=args.actor,
                                                       rationale=args.rationale)
                elif args.command == "record-visit":
                    result = operator.record_visit(db, source_id=args.source_id, run_id=args.run_id,
                                                   provenance=args.provenance, outcome=args.outcome, actor=args.actor,
                                                   **{key: getattr(args, key) for key in (
                                                       "evidence_id", "reported_checked_date", "attempted_at", "attempt",
                                                       "http_status", "duration_ms", "content_sha256", "etag",
                                                       "last_modified", "result_count", "note")})
                else:
                    result = operator.update_coverage(db, unit_id=args.unit_id, axis=args.axis, status=args.status,
                                                      evidence_id=args.evidence_id, run_id=args.run_id,
                                                      actor=args.actor, rationale=args.rationale,
                                                      assessed_at=args.assessed_at, limitations=args.limitations,
                                                      next_task=args.next_task)
            finally:
                db.close()
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

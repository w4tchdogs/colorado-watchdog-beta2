"""Local research database initialization, inspection, and evidence-led operations."""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

from research import operator
from research import identity
from research import identity_triage, source_types, publisher, export as profiles_export
from research import batch_selection
from research import submission, sync
from research.backup import backup_database, restore_database
from research.db import connect, migrate, seed_counties, validate_database, validate_migration_history
from research.intake import preview_csv, quarantine_validation_report
from research.mapping import CsvHeaderMismatch, CsvStructureError, MAPPINGS
from research.quarantine import quarantine_invalid_original
from research.store import ingest_csv
from research.structure import (ACTOR_DEFAULT, apply_structure_plan, build_structure_plan,
                                read_plan, verify_structure_application, write_plan)


def parser_for():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    def database_command(name, help_text):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("database", type=Path, help="Explicit database path outside the source checkout")
        return command

    database_command("init", "exclusively create and initialize an empty database")
    database_command("check", "validate an existing database without writing")
    database_command("migrate", "apply pending checksum-verified research schema migrations")
    database_command("seed-counties", "explicitly seed the canonical public Colorado county registry")
    backup = database_command("backup", "create an authenticated SQLite-consistent encrypted backup")
    backup.add_argument("destination", type=Path, help="New encrypted artifact path outside the checkout")
    restore = database_command("restore", "verify and restore an authenticated encrypted backup")
    restore.add_argument("destination", type=Path, help="New restored database path outside the checkout")

    def csv_intake(name, help_text):
        command = database_command(name, help_text)
        command.add_argument("--file", type=Path, required=True, help="Explicit CSV input path")
        command.add_argument("--version", choices=tuple(MAPPINGS), required=True,
                             help="Explicit registered mapping version")
        command.add_argument("--parent-batch-id", help="Existing parent batch for corrected/alternative deliveries")
        command.add_argument("--supersedes-json", type=Path,
                             help="JSON object mapping CSV record numbers to parent claim IDs")
        command.add_argument("--select", action="store_true",
                             help="Explicitly select this batch within its family")
        command.add_argument("--provenance", choices=("legacy_delivery", "synthetic"), default="legacy_delivery")
        return command

    preview = csv_intake("preview-csv", "read-only validation preview of an explicitly mapped CSV")
    preview.add_argument("--version-label", help="Optional delivery label for replay comparison")
    preview.add_argument("--lineage-kind", choices=("original", "complementary", "corrected", "alternative"),
                         default="original")
    preview.add_argument("--max-errors", type=int, default=100, help="Maximum diagnostic count (1–500)")

    intake = csv_intake("intake-csv", "commit one explicitly described CSV delivery")
    intake.add_argument("--version-label", required=True)
    intake.add_argument("--lineage-kind", choices=("original", "complementary", "corrected", "alternative"),
                        required=True)
    intake.add_argument("--expect-sha256", help="Require the exact file hash reported by preview")
    intake.add_argument("--commit", action="store_true", required=True,
                        help="Required explicit confirmation that this command may write")

    quarantine = database_command("quarantine-invalid", "explicitly preserve a rejected original CSV outside the checkout")
    quarantine.add_argument("--file", type=Path, required=True, help="Explicit original CSV path")
    quarantine.add_argument("--root", type=Path, required=True,
                            help="Existing private quarantine directory outside the source checkout")
    quarantine.add_argument("--version", choices=tuple(MAPPINGS), required=True,
                            help="Explicit registered mapping version")
    quarantine.add_argument("--version-label", required=True)
    quarantine.add_argument("--lineage-kind", choices=("original",), required=True)
    quarantine.add_argument("--provenance", choices=("legacy_delivery", "synthetic"),
                            default="legacy_delivery")

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

    connection = database_command("associate-claim-by-connection", "associate a role through an explicit official identity connection")
    connection.add_argument("--claim-id", required=True)
    connection.add_argument("--person-id", required=True)
    connection.add_argument("--evidence-id", required=True)
    connection.add_argument("--rationale", required=True)
    connection.add_argument("--actor", required=True)

    correction_link = database_command("associate-claim-by-correction-lineage", "associate a corrected observation through its selected source lineage")
    correction_link.add_argument("--claim-id", required=True)
    correction_link.add_argument("--person-id", required=True)
    correction_link.add_argument("--anchor-claim-id", required=True)
    correction_link.add_argument("--rationale", required=True)
    correction_link.add_argument("--actor", required=True)

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

    classify = database_command("classify-source", "explicitly classify one registered source with an audit event")
    classify.add_argument("--source-id", required=True)
    classify.add_argument("--status", choices=operator.SOURCE_CLASSIFICATIONS, required=True)
    classify.add_argument("--actor", required=True)
    classify.add_argument("--basis", required=True,
                          help="Documented reason for the classification; hostnames alone are insufficient")
    classify.add_argument("--evidence-id", help="Optional evidence already associated with this exact source")

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

    structure_preview = database_command("preview-structure", "create a private, inspectable statewide organization and position plan")
    structure_preview.add_argument("--output", type=Path, required=True,
                                   help="New private plan path outside the source checkout")

    structure_apply = database_command("apply-structure", "apply one exact reviewed statewide structure plan")
    structure_apply.add_argument("--plan", type=Path, required=True)
    structure_apply.add_argument("--expect-plan-sha256", required=True)
    structure_apply.add_argument("--actor", default=ACTOR_DEFAULT)
    structure_apply.add_argument("--apply", action="store_true", required=True,
                                 help="Required explicit confirmation to write the reviewed plan")

    structure_verify = database_command("verify-structure", "verify a completed organization and position application")
    structure_verify.add_argument("--plan", type=Path, required=True)

    identity_preview = database_command("preview-identity", "create a private county-scoped evidence-based identity plan")
    identity_preview.add_argument("--output", type=Path, required=True,
                                  help="New private plan path outside the source checkout")

    identity_apply = database_command("apply-identity", "apply one hash-checked identity plan by county")
    identity_apply.add_argument("--plan", type=Path, required=True)
    identity_apply.add_argument("--expect-plan-sha256", required=True)
    identity_apply.add_argument("--actor", default=identity.ACTOR_DEFAULT)

    identity_verify = database_command("verify-identity", "verify a completed identity plan and audit history")
    identity_verify.add_argument("--plan", type=Path, required=True)

    triage_preview = database_command("preview-identity-triage", "create a read-only statewide identity-backlog triage report")
    triage_preview.add_argument("--output", type=Path, required=True,
                                help="New private statewide report path")
    triage_apply = database_command("apply-identity-triage", "apply only hash-checked supported identity decisions")
    triage_apply.add_argument("--report", type=Path, required=True)
    triage_apply.add_argument("--expect-report-sha256", required=True)
    triage_apply.add_argument("--actor", default=identity.ACTOR_DEFAULT)
    triage_verify = database_command("verify-identity-triage", "verify a triage application or no-change result")
    triage_verify.add_argument("--report", type=Path, required=True)
    triage_verify.add_argument("--expect-report-sha256", required=True)

    page_preview = database_command("preview-source-types", "create a read-only plan that sets sources.page_type")
    page_preview.add_argument("--output", type=Path, required=True,
                              help="New private plan path outside the checkout")
    page_apply = database_command("apply-source-types", "apply one hash-checked page type plan")
    page_apply.add_argument("--plan", type=Path, required=True)
    page_apply.add_argument("--expect-plan-sha256", required=True)
    page_apply.add_argument("--actor", default=source_types.ACTOR_DEFAULT)
    page_verify = database_command("verify-source-types", "verify a page type plan was applied")
    page_verify.add_argument("--plan", type=Path, required=True)
    page_verify.add_argument("--expect-plan-sha256", required=True)

    publisher_preview = database_command("preview-publisher-classifications", "create a read-only evidence-led source publisher plan")
    publisher_preview.add_argument("--output", type=Path, required=True,
                                   help="New private plan path outside the source checkout")
    publisher_apply = database_command("apply-publisher-classifications", "apply one hash-checked publisher plan")
    publisher_apply.add_argument("--plan", type=Path, required=True)
    publisher_apply.add_argument("--expect-plan-sha256", required=True)
    publisher_apply.add_argument("--actor", default=publisher.ACTOR_DEFAULT)
    publisher_verify = database_command("verify-publisher-classifications", "verify a publisher classification plan")
    publisher_verify.add_argument("--plan", type=Path, required=True)
    publisher_verify.add_argument("--expect-plan-sha256", required=True)

    publisher_classify = database_command("classify-publisher", "classify one publisher using source-specific evidence")
    publisher_classify.add_argument("--source-id", required=True)
    publisher_classify.add_argument("--classification", choices=operator.PUBLISHER_CLASSIFICATIONS, required=True)
    publisher_classify.add_argument("--evidence-id", required=True)
    publisher_classify.add_argument("--actor", required=True)
    publisher_classify.add_argument("--basis", required=True)

    selection_preview = database_command("preview-batch-selection", "write a private hash-checked batch selection plan")
    selection_target = selection_preview.add_mutually_exclusive_group(required=True)
    selection_target.add_argument("--batch-id", help="Select this existing family member")
    selection_target.add_argument("--clear-family-id", help="Plan to leave this batch family with no selection")
    selection_preview.add_argument("--actor", required=True)
    selection_preview.add_argument("--reason", required=True)
    selection_preview.add_argument("--output", type=Path, required=True,
                                   help="New private plan path outside the source checkout")

    selection_apply = database_command("apply-batch-selection", "apply one exact reviewed batch selection plan")
    selection_apply.add_argument("--plan", type=Path, required=True)
    selection_apply.add_argument("--expect-plan-sha256", required=True)

    reversal_preview = database_command("preview-batch-selection-reversal", "write a private plan to reverse the latest family selection")
    reversal_preview.add_argument("--event-id", required=True)
    reversal_preview.add_argument("--actor", required=True)
    reversal_preview.add_argument("--reason", required=True)
    reversal_preview.add_argument("--output", type=Path, required=True,
                                  help="New private plan path outside the source checkout")

    reversal_apply = database_command("apply-batch-selection-reversal", "apply one exact reviewed selection reversal")
    reversal_apply.add_argument("--plan", type=Path, required=True)
    reversal_apply.add_argument("--expect-plan-sha256", required=True)

    profile_export = database_command("profiles-export", "write a private, county-scoped Profiles export")
    scope = profile_export.add_mutually_exclusive_group(required=True)
    scope.add_argument("--county", action="append", help="Canonical five-digit county FIPS; repeat to select several")
    scope.add_argument("--statewide", action="store_true", help="Explicitly select statewide scope")
    profile_export.add_argument("--output", type=Path, required=True, help="New private output path outside the source checkout")
    profile_export.add_argument("--limit", type=int, default=profiles_export.MAX_PROFILE_EXPORT)
    profile_export.add_argument("--after-profile-id", help="Resume after the last profile ID in the previous page")

    for name, help_text in (
        ("sync-eligibility", "inspect bounded Website synchronization eligibility"),
        ("sync-preview", "preview a deterministic Website changeset without writing"),
    ):
        command = database_command(name, help_text)
        command.add_argument("--site-key", required=True)
        command.add_argument("--max-changes", type=int, default=None,
                             help="Optional voluntary limit. By default a changeset holds as much as fits the 8 MiB request limit")
        command.add_argument("--county-fips", help="Optional canonical Colorado county FIPS")

    database_command(
        "mcp-readiness-summary",
        "return a read-only, privacy-bounded Profiles synchronization summary",
    )

    prepare = database_command("sync-prepare", "durably prepare one explicitly selected Website changeset")
    prepare.add_argument("--site-key", required=True)
    prepare.add_argument("--idempotency-key", required=True)
    prepare.add_argument("--select", choices=("all",), required=True,
                         help="Explicitly select all eligible changes in the reviewed preview")
    prepare.add_argument("--expect-fingerprint", required=True,
                         help="Changeset SHA-256 shown by sync-preview")
    prepare.add_argument("--max-changes", type=int, default=None)

    status = database_command("sync-status", "inspect sanitized local submission status")
    status.add_argument("--submission-id", required=True)

    reconcile = database_command("sync-reconcile", "reconcile a verified receipt stored by the R6 client")
    reconcile.add_argument("--submission-id", required=True)
    return parser


def _path(args, parser):
    return _external_path(args.database, parser, "Research databases")


def _external_path(candidate, parser, label):
    path = candidate.resolve()
    repo = Path(__file__).resolve().parents[1]
    if path == repo or repo in path.parents:
        parser.error(f"{label} must be outside the source checkout")
    return path


def _absolute_external_path(candidate, parser, label):
    if not candidate.is_absolute():
        parser.error(f"{label} must be an explicit absolute path")
    return _external_path(candidate, parser, label)


def _sync_preview(db, site_key, max_changes, county_fips=None):
    kwargs = {"max_changes": max_changes}
    if county_fips is not None:
        kwargs["county_fips"] = county_fips
    generated = sync.build_changeset(db, site_key, **kwargs)
    fingerprint = hashlib.sha256(
        json.dumps(generated["request"], ensure_ascii=False, sort_keys=True,
                   separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()
    return generated, fingerprint


def _profiles_readiness_summary(db):
    """Aggregate the R7/R8 read-only preview without returning request records."""
    history = validate_migration_history(db)
    generated = sync.build_changeset(
        db, "colorado_watchdog_alpha1"
    )
    changes = generated["request"]["changes"]
    eligible_by_entity = {}
    for change in changes:
        entity = change.get("entity")
        if entity not in {
            "organizations",
            "organization_county_affiliations",
            "people",
            "positions",
            "role_sources",
            "person_roles",
        }:
            raise ValueError("Unexpected entity in synchronization preview")
        eligible_by_entity[entity] = eligible_by_entity.get(entity, 0) + 1
    excluded_by_reason = {}
    for item in generated["excluded"]:
        reason = item.get("reason")
        if not isinstance(reason, str) or len(reason) > 96:
            raise ValueError("Unexpected exclusion reason")
        excluded_by_reason[reason] = excluded_by_reason.get(reason, 0) + 1
    selected_counties = [
        row["county_fips"]
        for row in db.execute(
            "SELECT DISTINCT county_fips FROM scrape_batches WHERE selected = 1 "
            "ORDER BY county_fips LIMIT 64"
        )
        if isinstance(row["county_fips"], str)
        and len(row["county_fips"]) == 5
        and row["county_fips"].isdigit()
    ]
    mapped_count = db.execute(
        "SELECT COUNT(*) FROM site_entity_links "
        "WHERE site_key = ? AND link_state = 'active'",
        ("colorado_watchdog_alpha1",),
    ).fetchone()[0]
    request_size = len(
        json.dumps(
            generated["request"],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    )
    return {
        "databaseReadiness": "ready",
        "schemaVersion": history["schema_version"],
        "migrationCount": history["migration_count"],
        "selectedCountyFips": selected_counties,
        "eligibleEntityCounts": eligible_by_entity,
        "eligibleCount": generated["eligible_count"],
        "excludedCount": len(generated["excluded"]),
        "excludedCountsByReason": excluded_by_reason,
        "changesetSizeBytes": request_size,
        "changesetLimit": {"maxChanges": None, "maxRequestBytes": 8388608},
        "previewTruncated": bool(generated["truncated"]),
        "websiteMappingsPresent": int(mapped_count) > 0,
        "websiteMappingCount": int(mapped_count),
        "readOnlyPreviewPossible": True,
        "privateInformation": "person_records_notes_source_content_and_request_payloads_omitted",
    }


def _sync_command(args, path):
    read_only = args.command in {"sync-eligibility", "sync-preview", "sync-status"}
    db = _read_only(path) if read_only else connect(path)
    try:
        if args.command in {"sync-eligibility", "sync-preview"}:
            generated, fingerprint = _sync_preview(
                db, args.site_key, args.max_changes, getattr(args, "county_fips", None))
            result = {
                "mode": args.command,
                "status": "previewed",
                "changeset_fingerprint": fingerprint,
                "eligible_count": generated["eligible_count"],
                "excluded_count": len(generated["excluded"]),
                "excluded_truncated": len(generated["excluded"]) > 200,
                "safety": {
                    "private_information": "never_emitted",
                    "updates": "require_approved_evidence_and_current_website_version",
                },
                "truncated": generated["truncated"],
                "scope": {"county_fips": generated.get("county_fips"),
                          "applied_before_changeset_cap": generated.get("county_fips") is not None},
                "eligibility": generated.get("eligibility_summary", {}),
                "planned_operations": generated["eligible_count"],
                "planned_operations_by_entity": generated.get("planned_operations_by_entity", {}),
                "exclusion_counts_by_reason": generated.get("exclusion_counts_by_reason", {}),
                "excluded": generated["excluded"][:200],
            }
            if args.command == "sync-preview":
                result["request"] = generated["request"]
            return result, 0
        if args.command == "sync-prepare":
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_fingerprint):
                raise ValueError("--expect-fingerprint must be a 64-character SHA-256 value")
            generated, fingerprint = _sync_preview(db, args.site_key, args.max_changes)
            if fingerprint != args.expect_fingerprint.lower():
                raise ValueError("Changeset fingerprint differs from the reviewed preview")
            if not generated["request"]["changes"]:
                raise ValueError("No eligible changes are available to prepare")
            prepared = sync.prepare_research_submission(
                db, args.site_key, args.idempotency_key, generated
            )
            return {
                "mode": args.command,
                "status": "prepared",
                "submission_id": prepared["submission_id"],
                "created": prepared["created"],
                "changeset_fingerprint": fingerprint,
                "selected": "all",
                "change_count": generated["eligible_count"],
            }, 0
        if args.command == "sync-status":
            record = submission.get_submission(db, args.submission_id)
            if record is None:
                raise ValueError("Unknown prepared submission")
            return {
                "mode": args.command,
                "submission_id": record["id"],
                "state": record["state"],
                "request_fingerprint": record["request_fingerprint"],
                "attempt_count": record["attempt_count"],
                "created_at": record["created_at"],
                "updated_at": record["updated_at"],
                "last_attempt_at": record["last_attempt_at"],
                "response_status": record["response_status"],
                "remote_batch_id": record["remote_batch_id"],
            }, 0
        reconciled = sync.reconcile_submission(db, args.submission_id)
        return {"mode": args.command, **reconciled}, 0
    finally:
        db.close()


def _read_only(path):
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def _ensure_preview_journal_safe(path):
    with path.open("rb") as database_file:
        header = database_file.read(20)
    if header.startswith(b"SQLite format 3\x00") and header[18:20] == b"\x02\x02":
        raise ValueError("CSV preview does not support WAL-mode databases because SQLite may modify auxiliary files")


def _read_supersedes(path):
    if path is None:
        return {}
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("Correction mapping must be an existing JSON file no larger than 1 MiB")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Correction mapping contains duplicate JSON keys")
            result[key] = value
        return result

    payload = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(payload, dict):
        raise ValueError("Correction mapping must be a JSON object of record numbers to claim IDs")
    result = {}
    for record, claim in payload.items():
        if (not re.fullmatch(r"[1-9][0-9]*", str(record)) or not isinstance(claim, str)
                or not claim.strip() or claim != claim.strip()):
            raise ValueError("Correction mapping keys must be positive record numbers and values nonblank claim IDs")
        number = int(record)
        if number in result:
            raise ValueError("Correction mapping contains duplicate record numbers")
        result[number] = claim
    return result


def _csv_input(path):
    file_path = path.resolve()
    if not file_path.is_file():
        raise ValueError("CSV input file does not exist")
    return file_path.name, file_path.read_bytes()


def _json_error(mode, category, message, *, file_name=None, file_sha256=None):
    return {"mode": mode, "status": "failed", "eligible": False,
            "file_name": file_name, "file_sha256": file_sha256,
            "errors": [{"record_number": None, "line_start": None, "line_end": None,
                        "field": None, "category": category, "message": message}]}


def _run_csv_command(args, path):
    mode = args.command
    file_name = None
    file_hash = None
    file_size = None
    try:
        file_name, payload = _csv_input(args.file)
        file_size = len(payload)
        file_hash = hashlib.sha256(payload).hexdigest()
        supersedes = _read_supersedes(args.supersedes_json)
        if mode == "preview-csv" and not 1 <= args.max_errors <= 500:
            raise ValueError("--max-errors must be between 1 and 500")
        if mode == "intake-csv" and args.expect_sha256:
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_sha256):
                raise ValueError("--expect-sha256 must be a 64-character SHA-256 value")
            if file_hash != args.expect_sha256.lower():
                result = _json_error(mode, "input_hash_mismatch", "CSV file no longer matches the previewed SHA-256",
                                     file_name=file_name, file_sha256=file_hash)
                result["expected_sha256"] = args.expect_sha256.lower()
                result["mapping_version"] = args.version
                result["file_size_bytes"] = file_size
                return result, 2
        if mode == "preview-csv":
            _ensure_preview_journal_safe(path)
            db = _read_only(path)
            try:
                result = preview_csv(db, payload, file_name=file_name, version=args.version,
                                     version_label=args.version_label, lineage_kind=args.lineage_kind,
                                     parent_batch_id=args.parent_batch_id, selected=args.select,
                                     provenance=args.provenance, supersedes=supersedes,
                                     max_errors=args.max_errors)
            finally:
                db.close()
            return result, 0 if result["eligible"] else 1

        if not args.version_label.strip():
            raise ValueError("--version-label cannot be blank")
        db = connect(path)
        try:
            preview_result = preview_csv(db, payload, file_name=file_name, version=args.version,
                                         version_label=args.version_label, lineage_kind=args.lineage_kind,
                                         parent_batch_id=args.parent_batch_id, selected=args.select,
                                         provenance=args.provenance, supersedes=supersedes)
            if not preview_result["eligible"]:
                result = {"mode": mode, "status": "failed", "eligible": False,
                          "file_name": file_name, "file_sha256": file_hash,
                          "mapping_version": args.version, "lineage": preview_result["lineage"],
                          "replay": preview_result["replay"], "records": preview_result["records"],
                          "errors": preview_result["errors"],
                          "diagnostics_truncated": preview_result["diagnostics_truncated"]}
                return result, 2
            committed = ingest_csv(db, payload, file_name=file_name, version_label=args.version_label,
                                   version=args.version, provenance=args.provenance,
                                   lineage_kind=args.lineage_kind, parent_batch_id=args.parent_batch_id,
                                   selected=args.select, supersedes=supersedes, return_result=True)
            result = {"mode": mode, **committed, "file_name": file_name,
                      "version_label": args.version_label,
                      "preview_counts": preview_result["records"],
                      "expected_sha256": args.expect_sha256}
        finally:
            db.close()
        return result, 0 if committed["created"] else 3
    except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
        category = "commit_failed" if mode == "intake-csv" else "preview_failed"
        if isinstance(error, CsvHeaderMismatch):
            category = "unsupported_header"
        elif isinstance(error, CsvStructureError):
            category = "malformed_csv"
        result = _json_error(mode, category, str(error), file_name=file_name, file_sha256=file_hash)
        if isinstance(error, CsvHeaderMismatch):
            result["mapping_version"] = args.version
            result["column_count"] = error.column_count
            result["header_match"] = False
            result["file_size_bytes"] = file_size
        elif isinstance(error, CsvStructureError) and error.column_count is not None:
            result["mapping_version"] = args.version
            result["column_count"] = error.column_count
            result["header_match"] = True
            result["file_size_bytes"] = file_size
            result["errors"][0]["line_start"] = error.line_start or error.line
            result["errors"][0]["line_end"] = error.line
        line = re.search(r"(?:physical line|line) (\d+)", str(error))
        if line and result["errors"][0]["line_start"] is None:
            result["errors"][0]["line_start"] = int(line.group(1))
            result["errors"][0]["line_end"] = int(line.group(1))
        return result, (2 if mode == "intake-csv" else 1)


def _run_quarantine_command(args, path):
    file_name = None
    file_hash = None
    try:
        file_name, payload = _csv_input(args.file)
        file_hash = hashlib.sha256(payload).hexdigest()
        db = _read_only(path)
        try:
            report = quarantine_validation_report(
                db, payload, file_name=file_name, version=args.version,
                version_label=args.version_label, lineage_kind=args.lineage_kind,
            )
        finally:
            db.close()
        if report["eligible"]:
            return {"mode": "quarantine", "status": "refused_valid_delivery", "eligible": True,
                    "sha256": file_hash,
                    "errors": [{"category": "delivery_is_valid",
                                "message": "Valid deliveries are not eligible for rejected-original quarantine"}]}, 1
        result = quarantine_invalid_original(
            args.root, payload, file_name=file_name, version=args.version,
            version_label=args.version_label, validation_report=report, provenance=args.provenance,
        )
        return {"mode": "quarantine", **result}, 0
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
        message = str(error) if isinstance(error, ValueError) else "Quarantine failed before a complete artifact was published"
        return {"mode": "quarantine", "status": "failed", "eligible": False,
                "sha256": file_hash,
                "errors": [{"category": "quarantine_failed", "message": message}]}, 2


def main(argv=None):
    parser = parser_for()
    args = parser.parse_args(argv)
    path = _path(args, parser)
    if args.command == "seed-counties":
        _absolute_external_path(args.database, parser, "Research database")
    if args.command in {"backup", "restore"}:
        _absolute_external_path(args.database, parser,
                                "Research database" if args.command == "backup" else "Encrypted backup")
        args.destination = _absolute_external_path(
            args.destination, parser, "Backup destination" if args.command == "backup" else "Restore destination")
    if args.command == "preview-structure":
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.output, parser, "Private structure plan")
    if args.command == "preview-identity":
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.output, parser, "Private identity plan")
    if args.command in {"apply-structure", "verify-structure"}:
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.plan, parser, "Private structure plan")
    if args.command in {"apply-identity", "verify-identity"}:
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.plan, parser, "Private identity plan")
    if args.command.startswith("sync-"):
        _absolute_external_path(args.database, parser, "Research database")
    if args.command in {"preview-batch-selection", "apply-batch-selection",
                        "preview-batch-selection-reversal", "apply-batch-selection-reversal"}:
        _absolute_external_path(args.database, parser, "Research database")
        if hasattr(args, "output"):
            _absolute_external_path(args.output, parser, "Private batch selection plan")
        if hasattr(args, "plan"):
            _absolute_external_path(args.plan, parser, "Private batch selection plan")
    if args.command == "mcp-readiness-summary":
        _absolute_external_path(args.database, parser, "Research database")
    if args.command == "quarantine-invalid":
        _external_path(args.root, parser, "Quarantine roots")
    if args.command in {"preview-batch-selection", "preview-batch-selection-reversal"}:
        try:
            db = _read_only(path)
            try:
                if args.command == "preview-batch-selection":
                    plan = batch_selection.build_selection_plan(
                        db, batch_id=args.batch_id, family_id=args.clear_family_id,
                        actor=args.actor, rationale=args.reason)
                else:
                    plan = batch_selection.build_reversal_plan(
                        db, event_id=args.event_id, actor=args.actor, rationale=args.reason)
            finally:
                db.close()
            file_sha256 = batch_selection.write_plan(
                plan, args.output, repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"mode": args.command, "status": "previewed",
                              "plan_path": str(args.output.resolve()),
                              "plan_file_sha256": file_sha256,
                              "plan_sha256": plan["plan_sha256"], "action": plan["action"],
                              "family_id": plan["family_id"], "county_fips": plan["county_fips"],
                              "before_batch_id": plan["before_batch_id"],
                              "after_batch_id": plan["after_batch_id"],
                              "replaced_batch_id": plan["before_batch_id"],
                              "reverses_event_id": plan["reverses_event_id"]},
                             ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "batch_selection_preview_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command in {"apply-batch-selection", "apply-batch-selection-reversal"}:
        try:
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_plan_sha256):
                raise ValueError("--expect-plan-sha256 must be a 64-character SHA-256 value")
            plan = batch_selection.read_plan(
                args.plan, repository_root=Path(__file__).resolve().parents[1])
            if plan["plan_sha256"] != args.expect_plan_sha256.lower():
                raise ValueError("Expected plan SHA-256 does not match the inspected plan")
            db = connect(path)
            try:
                result = batch_selection.apply_plan(
                    db, plan, expected_sha256=args.expect_plan_sha256.lower())
            finally:
                db.close()
            print(json.dumps({"mode": args.command, "plan_sha256": plan["plan_sha256"], **result},
                             ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "batch_selection_apply_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
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
        if args.command in {"preview-csv", "intake-csv"}:
            print(json.dumps(_json_error(args.command, "database_missing", "Database file does not exist"),
                             sort_keys=True))
            return 2
        print("error: database file does not exist", file=sys.stderr)
        return 2
    if args.command == "quarantine-invalid":
        result, status = _run_quarantine_command(args, path)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return status
    if args.command.startswith("sync-"):
        try:
            result, status = _sync_command(args, path)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return status
        except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
            message = str(error) if isinstance(error, ValueError) else (
                "Synchronization operation failed; no private record details are included"
            )
            print(json.dumps(_json_error(args.command, "sync_operation_failed", message),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command == "mcp-readiness-summary":
        try:
            db = _read_only(path)
            try:
                result = _profiles_readiness_summary(db)
            finally:
                db.close()
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 0
        except Exception:
            print(json.dumps({"error": "profiles_database_unavailable"}, sort_keys=True))
            return 2
    if args.command in {"preview-csv", "intake-csv"}:
        result, status = _run_csv_command(args, path)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return status
    if args.command == "preview-structure":
        try:
            db = _read_only(path)
            try:
                plan = build_structure_plan(db)
            finally:
                db.close()
            file_sha256 = write_plan(plan, args.output, repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"mode": args.command, "status": "previewed",
                              "plan_path": str(args.output.resolve()),
                              "plan_sha256": plan["plan_sha256"],
                              "file_sha256": file_sha256, **plan["summary"]},
                             ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "structure_preview_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command in {"apply-structure", "verify-structure"}:
        try:
            plan = read_plan(args.plan, repository_root=Path(__file__).resolve().parents[1])
            if args.command == "verify-structure":
                db = _read_only(path)
                try:
                    result = verify_structure_application(db, plan)
                finally:
                    db.close()
            else:
                if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_plan_sha256):
                    raise ValueError("--expect-plan-sha256 must be a 64-character SHA-256 value")
                db = connect(path)
                try:
                    result = apply_structure_plan(db, plan,
                                                  expected_sha256=args.expect_plan_sha256.lower(),
                                                  actor=args.actor)
                finally:
                    db.close()
            print(json.dumps({"mode": args.command, **result}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "structure_operation_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command == "preview-identity":
        try:
            db = _read_only(path)
            try:
                plan = identity.build_identity_plan(db)
            finally:
                db.close()
            file_sha256 = identity.write_identity_plan(
                plan, args.output, repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"mode": args.command, "status": "previewed",
                              "plan_path": str(args.output.resolve()),
                              "plan_sha256": plan["plan_sha256"], "file_sha256": file_sha256,
                              **plan["summary"]}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "identity_preview_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command == "preview-identity-triage":
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.output, parser, "Private identity triage report")
        try:
            db = _read_only(path)
            try:
                identity_plan = identity.build_identity_plan(db)
                report = identity_triage.build_identity_triage_report(db, identity_plan)
            finally:
                db.close()
            file_sha256 = identity_triage.write_triage_report(
                report, args.output, repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"mode": args.command, "status": "previewed",
                              "report_path": str(args.output.resolve()),
                              "report_file_sha256": file_sha256,
                              "triage_sha256": report["triage_sha256"],
                              "identity_plan_sha256": identity_plan["plan_sha256"],
                              **report["summary"]}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "identity_triage_preview_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command == "preview-source-types":
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.output, parser, "Private source page type plan")
        try:
            db = _read_only(path)
            try:
                plan = source_types.build_page_type_plan(db)
            finally:
                db.close()
            file_sha256 = source_types.write_page_type_plan(
                plan, args.output, repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"mode": args.command, "status": "previewed",
                              "plan_path": str(args.output.resolve()), "plan_file_sha256": file_sha256,
                              "plan_sha256": plan["plan_sha256"], "rule_version": plan["rule_version"],
                              **plan["summary"]}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "source_type_preview_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command == "preview-publisher-classifications":
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.output, parser, "Private publisher classification plan")
        try:
            db = _read_only(path)
            try:
                plan = publisher.build_plan(db)
            finally:
                db.close()
            file_sha256 = publisher.write_plan(plan, args.output,
                                               repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"mode": args.command, "status": "previewed", "plan_path": str(args.output.resolve()),
                              "plan_file_sha256": file_sha256, "plan_sha256": plan["plan_sha256"],
                              **plan["summary"]}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "publisher_preview_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command in {"apply-publisher-classifications", "verify-publisher-classifications"}:
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.plan, parser, "Private publisher classification plan")
        try:
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_plan_sha256):
                raise ValueError("--expect-plan-sha256 must be a 64-character SHA-256 value")
            plan = publisher.read_plan(args.plan, repository_root=Path(__file__).resolve().parents[1])
            if plan["plan_sha256"] != args.expect_plan_sha256.lower():
                raise ValueError("Expected plan SHA-256 does not match the inspected plan")
            db = _read_only(path) if args.command == "verify-publisher-classifications" else connect(path)
            try:
                result = (publisher.verify_plan(db, plan) if args.command == "verify-publisher-classifications"
                          else publisher.apply_plan(db, plan, expected_sha256=args.expect_plan_sha256.lower(),
                                                    actor=args.actor))
            finally:
                db.close()
            print(json.dumps({"mode": args.command, "plan_sha256": plan["plan_sha256"], **result},
                             ensure_ascii=False, sort_keys=True))
            return 0 if result.get("status") != "mismatch" else 1
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "publisher_operation_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command == "profiles-export":
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.output, parser, "Private Profiles export")
        try:
            db = _read_only(path)
            try:
                value = profiles_export.build_export(db, counties=args.county, statewide=args.statewide,
                                                     limit=args.limit, after_profile_id=args.after_profile_id)
            finally:
                db.close()
            size = profiles_export.write_export(value, args.output,
                                                repository_root=Path(__file__).resolve().parents[1])
            print(json.dumps({"status": "exported", "output_path": str(args.output.resolve()),
                              "size_bytes": size, **value["summary"],
                              "continuation": value["continuation"]}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "profiles_export_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command in {"apply-source-types", "verify-source-types"}:
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.plan, parser, "Private source page type plan")
        try:
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_plan_sha256):
                raise ValueError("--expect-plan-sha256 must be a 64-character SHA-256 value")
            plan = source_types.read_page_type_plan(
                args.plan, repository_root=Path(__file__).resolve().parents[1])
            if plan["plan_sha256"] != args.expect_plan_sha256.lower():
                raise ValueError("Expected plan SHA-256 does not match the inspected plan")
            if args.command == "verify-source-types":
                db = _read_only(path)
                try:
                    result = source_types.verify_page_type_plan(db, plan)
                finally:
                    db.close()
            else:
                db = connect(path)
                try:
                    result = source_types.apply_page_type_plan(
                        db, plan, expected_sha256=plan["plan_sha256"], actor=args.actor)
                finally:
                    db.close()
            print(json.dumps({"mode": args.command, "plan_sha256": plan["plan_sha256"], **result},
                             ensure_ascii=False, sort_keys=True))
            return 0 if result.get("status") != "mismatch" else 1
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "source_type_operation_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command in {"apply-identity-triage", "verify-identity-triage"}:
        _absolute_external_path(args.database, parser, "Research database")
        _absolute_external_path(args.report, parser, "Private identity triage report")
        try:
            if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_report_sha256):
                raise ValueError("--expect-report-sha256 must be a 64-character SHA-256 value")
            report_path = args.report.resolve(strict=True)
            report_file_sha256 = hashlib.sha256(report_path.read_bytes()).hexdigest()
            if report_file_sha256 != args.expect_report_sha256.lower():
                raise ValueError("Expected triage report SHA-256 does not match the inspected report")
            report = identity_triage.read_triage_report(
                args.report, repository_root=Path(__file__).resolve().parents[1])
            if args.command == "verify-identity-triage":
                db = _read_only(path)
                try:
                    result = identity.verify_identity_application(db, report["identity_plan"])
                finally:
                    db.close()
            else:
                db = connect(path)
                try:
                    result = identity.apply_identity_plan(
                        db, report["identity_plan"],
                        expected_sha256=report["identity_plan"]["plan_sha256"], actor=args.actor)
                finally:
                    db.close()
            print(json.dumps({"mode": args.command, "report_file_sha256": report_file_sha256,
                              "triage_sha256": report["triage_sha256"], **result},
                             ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "identity_triage_operation_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    if args.command in {"apply-identity", "verify-identity"}:
        try:
            plan = identity.read_identity_plan(args.plan, repository_root=Path(__file__).resolve().parents[1])
            if args.command == "verify-identity":
                db = _read_only(path)
                try:
                    result = identity.verify_identity_application(db, plan)
                finally:
                    db.close()
            else:
                if not re.fullmatch(r"[0-9a-fA-F]{64}", args.expect_plan_sha256):
                    raise ValueError("--expect-plan-sha256 must be a 64-character SHA-256 value")
                db = connect(path)
                try:
                    result = identity.apply_identity_plan(db, plan,
                                                          expected_sha256=args.expect_plan_sha256.lower(),
                                                          actor=args.actor)
                finally:
                    db.close()
            print(json.dumps({"mode": args.command, **result}, ensure_ascii=False, sort_keys=True))
            return 0
        except (OSError, sqlite3.Error, ValueError, RuntimeError, json.JSONDecodeError) as error:
            print(json.dumps(_json_error(args.command, "identity_operation_failed", str(error)),
                             ensure_ascii=False, sort_keys=True))
            return 2
    try:
        if args.command == "migrate":
            db = connect(path)
            try:
                migrate(db)
                result = validate_migration_history(db)
            finally:
                db.close()
            print(json.dumps({"status": "migrated", **result}, sort_keys=True))
            return 0
        if args.command == "seed-counties":
            db = connect(path)
            try:
                result = seed_counties(db)
            finally:
                db.close()
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 2 if result["status"] == "conflict" else 0
        if args.command == "backup":
            result = backup_database(path, args.destination)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 0
        if args.command == "restore":
            result = restore_database(path, args.destination)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 0
        if args.command in {"check", "counties", "units", "people", "claims", "unassigned", "sources",
                            "matches", "coverage", "events"}:
            db = _read_only(path)
            try:
                if args.command == "check":
                    result = validate_database(db)
                    print(json.dumps(result, sort_keys=True))
                    validate_migration_history(db)
                    return 0 if result["integrity"] == "ok" and not result["foreign_keys"] else 1
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
                elif args.command == "associate-claim-by-connection":
                    result = operator.associate_claim_by_connection(
                        db, claim_id=args.claim_id, person_id=args.person_id, evidence_id=args.evidence_id,
                        rationale=args.rationale, actor=args.actor)
                elif args.command == "associate-claim-by-correction-lineage":
                    result = operator.associate_claim_by_correction_lineage(
                        db, claim_id=args.claim_id, person_id=args.person_id,
                        anchor_claim_id=args.anchor_claim_id, rationale=args.rationale, actor=args.actor)
                elif args.command == "bootstrap-person":
                    result = operator.bootstrap_person(db, county_fips=args.county_fips, claim_id=args.claim_id,
                                                       published_name=args.published_name, evidence_id=args.evidence_id, actor=args.actor,
                                                       rationale=args.rationale)
                elif args.command == "add-name-variant":
                    result = operator.add_name_variant(db, person_id=args.person_id,
                                                       published_name=args.published_name, kind=args.kind,
                                                       evidence_id=args.evidence_id, actor=args.actor,
                                                       rationale=args.rationale)
                elif args.command == "classify-source":
                    result = operator.classify_source(db, source_id=args.source_id, status=args.status,
                                                      actor=args.actor, basis=args.basis,
                                                      evidence_id=args.evidence_id)
                elif args.command == "classify-publisher":
                    result = operator.classify_publisher(
                        db, source_id=args.source_id, classification=args.classification,
                        actor=args.actor, basis=args.basis, evidence_id=args.evidence_id)
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

"""Evidence-led publisher classification plans and audited application."""

import hashlib
import json
from collections import Counter

from research import identity
from research.identity_triage import _validate_private_path
from research.mapping import canonical_json
from research.store import new_id, timestamp

PLAN_FORMAT = "colorado-watchdog/publisher-classification-plan/v1"
ACTOR_DEFAULT = "publisher-classification-operator"


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _state(db):
    sources = [tuple(row) for row in db.execute(
        'SELECT "Source ID" AS id,"Original source URL" AS original_url,"Previous source category" AS official_status,"Publisher type" AS publisher_classification FROM research_sources ORDER BY id')]
    evidence = [tuple(row) for row in db.execute(
        'SELECT "Evidence record ID" AS id,"Source ID" AS source_id,"Source title as observed" AS observed_title,"Source URL as observed" AS observed_url,"Source date" AS source_date,"How the source date was determined" AS source_date_basis,"Evidence location" AS locator,"Evidence excerpt" AS quotation,'
        '"Original record fingerprint" AS raw_record_sha256,"Earlier evidence record this replaces" AS supersedes_id FROM research_evidence ORDER BY id')]
    events = [tuple(row) for row in db.execute(
        "SELECT id,entity_id,detail_json FROM research_history WHERE entity_type='sources' "
        "AND kind='source_classified' ORDER BY id")]
    batches = [tuple(row) for row in db.execute(
        "SELECT id,county_fips,family_id,lineage_kind,selected,parent_batch_id FROM research_scrapes ORDER BY id")]
    people = [tuple(row) for row in db.execute(
        'SELECT "Profile ID" AS id,"County code" AS county_fips,"Identity review status" AS identity_state,"Evidence for identity" AS identity_evidence_id FROM profile_research ORDER BY id')]
    claims = [tuple(row) for row in db.execute(
        'SELECT "Role claim ID" AS id,"County code" AS county_fips,"Evidence record ID" AS evidence_id,"Linked profile" AS person_id,"Linked office or unit" AS unit_id,"Linked position" AS target_id,"Name as published" AS published_name,"Position as published" AS published_title,'
        '"Job description or duties" AS responsibility,"Listing status" AS source_listing_status,"Earlier claim this replaces" AS supersedes_id FROM profile_research_role ORDER BY id')]
    units = [tuple(row) for row in db.execute(
        'SELECT "Office or unit ID" AS id,"County code" AS county_fips,"Organization type" AS kind,"Parent office or unit" AS parent_id,"Relationship to parent" AS parent_relation,"Evidence for parent relationship" AS parent_evidence_id FROM county_research_unit_structure ORDER BY id')]
    targets = [tuple(row) for row in db.execute(
        'SELECT "Position ID" AS id,"Office or unit ID" AS unit_id,"County code" AS county_fips,"Evidence for position" AS evidence_id FROM county_research_positions ORDER BY id')]
    source_units = [tuple(row) for row in db.execute(
        "SELECT source_id,unit_id,relation,evidence_id FROM county_research_unit_sources ORDER BY source_id,unit_id,relation")]
    return {"source_count": len(sources), "evidence_count": len(evidence),
            "sources_sha256": _digest(sources), "evidence_sha256": _digest(evidence),
            "classification_history_sha256": _digest(events),
            "batch_selection_sha256": _digest(batches), "identity_links_sha256": _digest(people),
            "role_relationships_sha256": _digest(claims), "organization_hierarchy_sha256": _digest(units),
            "position_targets_sha256": _digest(targets), "source_unit_links_sha256": _digest(source_units)}


def build_plan(db):
    """Plan only prior audited official classifications and the existing evidence rule.

    Unofficial classifications stay manual until retained evidence explicitly identifies
    the publisher. A URL, suffix, or page type alone never establishes publisher identity.
    """
    from research.db import validate_migration_history
    validate_migration_history(db)
    rows = {row["id"]: dict(row) for row in db.execute(
        'SELECT "Source ID" AS id,"Original source URL" AS original_url,"Previous source category" AS official_status,"Publisher type" AS publisher_classification FROM research_sources ORDER BY id')}
    evidence = {row["id"]: row["source_id"] for row in db.execute('SELECT "Evidence record ID" AS id,"Source ID" AS source_id FROM research_evidence')}
    prior = {}
    for row in db.execute(
            "SELECT entity_id,detail_json FROM research_history WHERE entity_type='sources' "
            "AND kind='source_classified' ORDER BY id"):
        try:
            detail = json.loads(row["detail_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        support = detail.get("supporting_evidence_id")
        if (detail.get("after", {}).get("official_status") == "official"
                and support and evidence.get(support) == row["entity_id"]):
            prior[row["entity_id"]] = support

    proposals = {}
    for source_id, evidence_id in prior.items():
        source = rows.get(source_id)
        if source and source["official_status"] == "official" and source["publisher_classification"] == "unresolved":
            proposals[source_id] = {"source_id": source_id, "evidence_id": evidence_id,
                                    "from_classification": "unresolved", "to_classification": "official",
                                    "from_official_status": source["official_status"],
                                    "to_official_status": "official",
                                    "basis": "Retained source-specific audit records a prior official classification with attached evidence."}

    for item in identity._source_proposals(db):
        source = rows.get(item["source_id"])
        if source and source["publisher_classification"] == "unresolved":
            proposals.setdefault(item["source_id"], {
                "source_id": item["source_id"], "evidence_id": item["evidence_id"],
                "from_classification": "unresolved", "to_classification": "official",
                "from_official_status": source["official_status"], "to_official_status": "official",
                "basis": item["basis"],
            })

    entries = sorted(proposals.values(), key=lambda item: item["source_id"])
    totals = Counter(row["publisher_classification"] for row in rows.values())
    unresolved_publisher = sum(row["publisher_classification"] == "unresolved" for row in rows.values())
    plan = {"format": PLAN_FORMAT, "rule_version": "retained-publisher-evidence/v1",
            "input_state": _state(db),
            "summary": {"sources_total": len(rows), "proposed": len(entries),
                        "proposed_by_classification": dict(sorted(Counter(e["to_classification"] for e in entries).items())),
                        "currently_by_classification": dict(sorted(totals.items())),
                        "unresolved_publishers_after_plan": unresolved_publisher - len(entries),
                        "unofficial_proposed": 0,
                        "exception_counts": {"publisher_not_established_from_retained_evidence": unresolved_publisher - len(entries)}},
            "entries": entries}
    plan["plan_sha256"] = _digest(plan)
    return plan


def plan_sha256(plan):
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise ValueError("Unsupported publisher classification plan")
    actual = _digest({key: value for key, value in plan.items() if key != "plan_sha256"})
    if plan.get("plan_sha256") != actual:
        raise ValueError("Publisher classification plan digest is invalid")
    for entry in plan.get("entries", []):
        if entry.get("to_classification") not in {"official", "unofficial"}:
            raise ValueError("Unsupported publisher classification in plan")
    return actual


def write_plan(plan, destination, *, repository_root):
    plan_sha256(plan)
    path = _validate_private_path(destination, repository_root, must_be_new=True)
    content = json.dumps(plan, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return hashlib.sha256(content.encode()).hexdigest()


def read_plan(path, *, repository_root):
    path = _validate_private_path(path, repository_root, must_be_new=False)
    plan = json.loads(path.read_text(encoding="utf-8"))
    plan_sha256(plan)
    return plan


def _event(db, run_id, item, actor, now):
    before = {"publisher_classification": item["from_classification"],
              "official_status": item["from_official_status"]}
    after = {"publisher_classification": item["to_classification"],
             "official_status": item["to_official_status"]}
    detail = {"before": before, "after": after, "supporting_evidence_id": item["evidence_id"],
              "basis": item["basis"], "operator": actor}
    db.execute("INSERT INTO research_history(id,run_id,kind,entity_type,entity_id,occurred_at,recorded_at,provenance,detail_json) "
               "VALUES (?,?,?,?,?,?,?,?,?)",
               (new_id("event"), run_id, "source_publisher_classified", "sources", item["source_id"],
                now, now, "reconstructed", canonical_json(detail)))


def apply_plan(db, plan, *, expected_sha256, actor=ACTOR_DEFAULT):
    if plan_sha256(plan) != expected_sha256:
        raise ValueError("Expected plan SHA-256 does not match the plan")
    if not isinstance(actor, str) or not actor.strip():
        raise ValueError("An operator name is required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        audited = set()
        for event in db.execute("SELECT entity_id,detail_json FROM research_history "
                                "WHERE kind='source_publisher_classified' AND entity_type='sources'"):
            try:
                detail = json.loads(event["detail_json"])
            except (TypeError, json.JSONDecodeError):
                continue
            audited.add((event["entity_id"], detail.get("supporting_evidence_id"),
                         detail.get("after", {}).get("publisher_classification")))
        already_applied = bool(plan["entries"])
        for item in plan["entries"]:
            row = db.execute('SELECT "Publisher type" AS publisher_classification,"Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?',
                             (item["source_id"],)).fetchone()
            if (row is None or row["publisher_classification"] != item["to_classification"]
                    or row["official_status"] != item["to_official_status"]):
                already_applied = False
                break
            if (item["source_id"], item["evidence_id"], item["to_classification"]) not in audited:
                already_applied = False
                break
        if already_applied:
            db.commit()
            return {"status": "already_applied", "applied": len(plan["entries"]),
                    "remaining_unresolved": plan["summary"]["unresolved_publishers_after_plan"]}
        if _state(db) != plan["input_state"]:
            raise ValueError("Source, evidence, or classification history changed after preview")
        for item in plan["entries"]:
            row = db.execute('SELECT "Publisher type" AS publisher_classification,"Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?', (item["source_id"],)).fetchone()
            if (row is None or row["publisher_classification"] != item["from_classification"]
                    or row["official_status"] != item["from_official_status"]):
                raise ValueError("A planned source classification is stale")
            evidence = db.execute('SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?', (item["evidence_id"],)).fetchone()
            if evidence is None or evidence[0] != item["source_id"]:
                raise ValueError("Supporting evidence no longer belongs to the planned source")
        if not plan["entries"]:
            db.commit()
            return {"status": "already_current", "applied": 0, "remaining_unresolved": plan["summary"]["unresolved_publishers_after_plan"]}
        now, run_id = timestamp(), new_id("run")
        db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at,note) "
                   "VALUES (?,?,?,?,?,?,?,?)", (run_id, "screening", "reconstructed", actor, now, now, now,
                   "Evidence-led publisher classification"))
        for item in plan["entries"]:
            changed = db.execute('UPDATE research_sources SET "Publisher type"=?,"Previous source category"=? '
                                 'WHERE "Source ID"=? AND "Publisher type"=? AND "Previous source category"=?',
                                 (item["to_classification"], item["to_official_status"], item["source_id"],
                                  item["from_classification"], item["from_official_status"])).rowcount
            if changed != 1:
                raise ValueError("A planned source changed during application")
            _event(db, run_id, item, actor, now)
        db.commit()
        return {"status": "applied", "applied": len(plan["entries"]), "run_id": run_id,
                "remaining_unresolved": plan["summary"]["unresolved_publishers_after_plan"]}
    except Exception:
        db.rollback()
        raise


def verify_plan(db, plan):
    plan_sha256(plan)
    mismatches = 0
    for item in plan["entries"]:
        row = db.execute('SELECT "Publisher type" AS publisher_classification,"Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?', (item["source_id"],)).fetchone()
        if (row is None or row["publisher_classification"] != item["to_classification"]
                or row["official_status"] != item["to_official_status"]):
            mismatches += 1
    return {"status": "verified" if not mismatches else "mismatch",
            "planned": len(plan["entries"]), "mismatches": mismatches}

"""Audited, hash-checked selection changes for existing import batches."""

import hashlib
import json
from pathlib import Path

from research.identity_triage import _validate_private_path
from research.mapping import canonical_json
from research.store import new_id, timestamp

PLAN_FORMAT = "colorado-watchdog/batch-selection-plan/v1"
SELECTION_EVENTS = ("batch_selection_changed", "batch_selection_reversed")


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _family_state(db, family_id):
    members = [dict(row) for row in db.execute(
        "SELECT id,selected FROM research_scrapes WHERE family_id=? ORDER BY id", (family_id,))]
    if not members:
        raise ValueError("Unknown batch family")
    selected = [row["id"] for row in members if row["selected"]]
    if len(selected) > 1:
        raise ValueError("Batch family has more than one selected member")
    latest = db.execute(
        "SELECT id,detail_json FROM research_history WHERE entity_type='batch_family' AND entity_id=? "
        "AND kind IN ('batch_selection_changed','batch_selection_reversed') ORDER BY rowid DESC LIMIT 1",
        (family_id,),
    ).fetchone()
    return {"members": members, "selected_batch_id": selected[0] if selected else None,
            "latest_event_id": latest["id"] if latest else None,
            "latest_event_sha256": _digest(latest["detail_json"]) if latest else None}


def _make_plan(db, *, family_id, target_batch_id, action, actor, rationale, reverses_event_id=None):
    if not isinstance(actor, str) or not actor.strip() or len(actor) > 200:
        raise ValueError("A bounded operator name is required")
    if not isinstance(rationale, str) or not rationale.strip() or len(rationale) > 2000:
        raise ValueError("A documented reason of at most 2,000 characters is required")
    state = _family_state(db, family_id)
    if target_batch_id is not None:
        target = db.execute("SELECT family_id FROM research_scrapes WHERE id=?", (target_batch_id,)).fetchone()
        if target is None or target["family_id"] != family_id:
            raise ValueError("Target batch does not belong to the selected family")
    plan = {"format": PLAN_FORMAT, "action": action, "family_id": family_id,
            "county_fips": db.execute("SELECT county_fips FROM research_scrapes WHERE family_id=? LIMIT 1",
                                       (family_id,)).fetchone()[0],
            "before_batch_id": state["selected_batch_id"], "after_batch_id": target_batch_id,
            "input_state": state, "input_state_sha256": _digest(state),
            "actor": actor.strip(), "rationale": rationale.strip(),
            "reverses_event_id": reverses_event_id}
    plan["plan_sha256"] = _digest(plan)
    return plan


def build_selection_plan(db, *, actor, rationale, batch_id=None, family_id=None):
    if (batch_id is None) == (family_id is None):
        raise ValueError("Select exactly one existing batch or family")
    if batch_id is not None:
        row = db.execute("SELECT family_id FROM research_scrapes WHERE id=?", (batch_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown batch")
        family_id = row["family_id"]
        target = batch_id
    else:
        target = None
    return _make_plan(db, family_id=family_id, target_batch_id=target, action="select",
                      actor=actor, rationale=rationale)


def build_reversal_plan(db, *, event_id, actor, rationale):
    event = db.execute(
        "SELECT id,entity_id,detail_json FROM research_history WHERE id=? AND entity_type='batch_family' "
        "AND kind IN ('batch_selection_changed','batch_selection_reversed')", (event_id,),
    ).fetchone()
    if event is None:
        raise ValueError("Unknown batch selection event")
    latest = db.execute(
        "SELECT id FROM research_history WHERE entity_type='batch_family' AND entity_id=? "
        "AND kind IN ('batch_selection_changed','batch_selection_reversed') ORDER BY rowid DESC LIMIT 1",
        (event["entity_id"],),
    ).fetchone()
    if latest is None or latest["id"] != event_id:
        raise ValueError("Cannot reverse a selection that has a later family decision")
    detail = json.loads(event["detail_json"])
    state = _family_state(db, event["entity_id"])
    if state["selected_batch_id"] != detail.get("after_batch_id"):
        raise ValueError("Current selection no longer matches the event being reversed")
    return _make_plan(db, family_id=event["entity_id"], target_batch_id=detail.get("before_batch_id"),
                      action="reverse", actor=actor, rationale=rationale, reverses_event_id=event_id)


def plan_sha256(plan):
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise ValueError("Unsupported batch selection plan")
    actual = _digest({key: value for key, value in plan.items() if key != "plan_sha256"})
    if plan.get("plan_sha256") != actual:
        raise ValueError("Batch selection plan digest is invalid")
    if plan.get("action") not in {"select", "reverse"}:
        raise ValueError("Unsupported batch selection action")
    return actual


def write_plan(plan, destination, *, repository_root):
    plan_sha256(plan)
    path = _validate_private_path(destination, repository_root, must_be_new=True)
    content = json.dumps(plan, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_plan(path, *, repository_root):
    path = _validate_private_path(path, repository_root, must_be_new=False)
    if not path.is_file():
        raise ValueError("Private batch selection plan must be a regular file")
    plan = json.loads(path.read_text(encoding="utf-8"))
    plan_sha256(plan)
    return plan


def apply_plan(db, plan, *, expected_sha256):
    actual = plan_sha256(plan)
    if actual != expected_sha256:
        raise ValueError("Expected SHA-256 does not match the reviewed batch selection plan")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before batch selection")
    try:
        db.execute("BEGIN IMMEDIATE")
        state = _family_state(db, plan["family_id"])
        latest_plan = None
        if state["latest_event_id"]:
            latest = db.execute("SELECT detail_json FROM research_history WHERE id=?",
                                (state["latest_event_id"],)).fetchone()
            latest_plan = json.loads(latest["detail_json"]).get("plan_sha256")
        if state["selected_batch_id"] == plan["after_batch_id"] and latest_plan == actual:
            db.commit()
            return {"status": "already_applied", "family_id": plan["family_id"],
                    "selected_batch_id": state["selected_batch_id"]}
        if state == plan["input_state"]:
            if plan["before_batch_id"] == plan["after_batch_id"]:
                db.commit()
                return {"status": "already_current", "family_id": plan["family_id"],
                        "selected_batch_id": state["selected_batch_id"]}
        else:
            raise ValueError("Batch family selection or audit history changed after preview")
        if state["selected_batch_id"] != plan["before_batch_id"]:
            raise ValueError("Current family selection differs from the reviewed before state")
        if plan["action"] == "reverse":
            current_event = db.execute("SELECT id FROM research_history WHERE id=?", (plan["reverses_event_id"],)).fetchone()
            if current_event is None or state["latest_event_id"] != plan["reverses_event_id"]:
                raise ValueError("Cannot reverse a selection after a later family decision")
        db.execute("UPDATE research_scrapes SET selected=0 WHERE family_id=? AND selected=1",
                   (plan["family_id"],))
        if plan["after_batch_id"] is not None:
            changed = db.execute("UPDATE research_scrapes SET selected=1 WHERE id=? AND family_id=? AND selected=0",
                                 (plan["after_batch_id"], plan["family_id"])).rowcount
            if changed != 1:
                raise ValueError("Target batch changed during selection")
        now, run_id, event_id = timestamp(), new_id("run"), new_id("event")
        db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at,note) "
                   "VALUES (?,?,?,?,?,?,?,?)",
                   (run_id, "mapping", "observed", plan["actor"], now, now, now,
                    "Batch selection: " + plan["rationale"][:500]))
        detail = {"before_batch_id": plan["before_batch_id"], "after_batch_id": plan["after_batch_id"],
                  "operator": plan["actor"], "rationale": plan["rationale"], "plan_sha256": actual,
                  "reverses_event_id": plan["reverses_event_id"]}
        kind = "batch_selection_reversed" if plan["action"] == "reverse" else "batch_selection_changed"
        db.execute("INSERT INTO research_history(id,run_id,kind,entity_type,entity_id,occurred_at,recorded_at,provenance,detail_json) "
                   "VALUES (?,?,?,?,?,?,?,?,?)",
                   (event_id, run_id, kind, "batch_family", plan["family_id"], now, now, "observed",
                    canonical_json(detail)))
        db.commit()
        return {"status": "applied", "family_id": plan["family_id"], "event_id": event_id,
                "before_batch_id": plan["before_batch_id"], "after_batch_id": plan["after_batch_id"],
                "run_id": run_id, "plan_sha256": actual}
    except Exception:
        db.rollback()
        raise

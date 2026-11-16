"""Hash-checked, evidence-preserving classification of `sources.page_type`.

R7 accepts a source for Website sync only when `page_type` is explicitly one of
official_page, public_document or other_public. No earlier command wrote it.
This module plans the value deterministically from the stored URL, applies it
once under a hash check, and records one research event per source. Only
sources already classified `official` are planned. Existing values are never
overwritten. `other_public` is never assigned automatically.
"""

import hashlib
import json
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit

from research.identity_triage import _validate_private_path
from research.mapping import canonical_json
from research.store import new_id, timestamp

PLAN_FORMAT = "colorado-watchdog/source-page-type-plan/v1"
RULE_VERSION = "url-extension/v1"
ACTOR_DEFAULT = "source-page-type-rule-v1"
DOCUMENT_EXTENSIONS = frozenset(
    {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".txt", ".rtf"}
)


def _sha256(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def classify_url(url):
    """Return the planned page_type for one stored URL (documents by file extension)."""
    path = unquote(urlsplit(url).path or "").lower()
    suffix = "." + path.rsplit(".", 1)[1] if "." in path.rsplit("/", 1)[-1] else ""
    return "public_document" if suffix in DOCUMENT_EXTENSIONS else "official_page"


def build_page_type_plan(db):
    rows = db.execute(
        'SELECT "Source ID" AS id,"Original source URL" AS original_url,"Document type" AS page_type,"Previous source category" AS official_status FROM sources ORDER BY id'
    ).fetchall()
    entries, skipped = [], Counter()
    for row in rows:
        if row["page_type"] is not None and str(row["page_type"]).strip():
            skipped["already_has_page_type"] += 1
        elif row["official_status"] != "official":
            skipped["not_classified_official"] += 1
        else:
            entries.append(
                {
                    "source_id": row["id"],
                    "url": row["original_url"],
                    "page_type": classify_url(row["original_url"]),
                }
            )
    plan = {
        "format": PLAN_FORMAT,
        "rule_version": RULE_VERSION,
        "summary": {
            "sources_total": len(rows),
            "planned": len(entries),
            "planned_by_page_type": dict(sorted(Counter(e["page_type"] for e in entries).items())),
            "skipped_by_reason": dict(sorted(skipped.items())),
        },
        "entries": entries,
    }
    plan["plan_sha256"] = _sha256({k: v for k, v in plan.items() if k != "plan_sha256"})
    return plan


def plan_sha256(plan):
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise ValueError("Unsupported source page type plan")
    actual = _sha256({k: v for k, v in plan.items() if k != "plan_sha256"})
    if plan.get("plan_sha256") != actual:
        raise ValueError("Source page type plan digest is invalid")
    for entry in plan["entries"]:
        if entry["page_type"] not in {"official_page", "public_document"}:
            raise ValueError("Plan contains a page type this rule never assigns")
    return actual


def write_page_type_plan(plan, destination, *, repository_root):
    plan_sha256(plan)
    resolved = _validate_private_path(destination, repository_root, must_be_new=True)
    content = json.dumps(plan, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_page_type_plan(path, *, repository_root):
    resolved = _validate_private_path(path, repository_root, must_be_new=False)
    if not resolved.is_file():
        raise ValueError("Source page type plan must be a regular private file")
    plan = json.loads(resolved.read_text(encoding="utf-8"))
    plan_sha256(plan)
    return plan


def apply_page_type_plan(db, plan, *, expected_sha256, actor=ACTOR_DEFAULT):
    """Apply a verified plan in one transaction. Any drift aborts everything."""
    if plan_sha256(plan) != expected_sha256:
        raise ValueError("Expected plan SHA-256 does not match the plan")
    if not isinstance(actor, str) or not actor.strip():
        raise ValueError("An operator name is required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        now = timestamp()
        run_id = new_id("run")
        db.execute(
            "INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at,note) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (run_id, "screening", "reconstructed", actor, now, now, now,
             f"Source page type classification {RULE_VERSION}"),
        )
        for entry in plan["entries"]:
            row = db.execute(
                'SELECT "Original source URL" AS original_url,"Document type" AS page_type,"Previous source category" AS official_status FROM sources WHERE "Source ID"=?',
                (entry["source_id"],),
            ).fetchone()
            if (
                row is None
                or row["original_url"] != entry["url"]
                or row["official_status"] != "official"
                or (row["page_type"] is not None and str(row["page_type"]).strip())
            ):
                raise ValueError("Database changed since the plan; create a new preview")
            db.execute(
                'UPDATE sources SET "Document type"=? WHERE "Source ID"=? AND "Document type" IS NULL',
                (entry["page_type"], entry["source_id"]),
            )
            if db.execute("SELECT changes()").fetchone()[0] != 1:
                raise ValueError("Source page type was not updated")
            db.execute(
                "INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
                (new_id("event"), run_id, "source_page_type_set", "sources", entry["source_id"],
                 now, now, "reconstructed",
                 canonical_json({"before": {"page_type": None},
                                 "after": {"page_type": entry["page_type"]},
                                 "rule_version": RULE_VERSION,
                                 "plan_sha256": plan["plan_sha256"], "operator": actor})),
            )
        db.commit()
        return {"status": "applied", "run_id": run_id, "updated": len(plan["entries"])}
    except Exception:
        db.rollback()
        raise


def verify_page_type_plan(db, plan):
    plan_sha256(plan)
    mismatched = 0
    for entry in plan["entries"]:
        row = db.execute(
            'SELECT "Document type" AS page_type FROM sources WHERE "Source ID"=?', (entry["source_id"],)
        ).fetchone()
        if row is None or row["page_type"] != entry["page_type"]:
            mismatched += 1
    return {"status": "verified" if mismatched == 0 else "mismatch",
            "checked": len(plan["entries"]), "mismatched": mismatched}

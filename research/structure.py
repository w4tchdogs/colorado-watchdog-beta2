"""Evidence-led, county-scoped organizational and position foundation."""

import hashlib
import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

from research.db import validate_migration_history
from research.mapping import canonical_json
from research.store import timestamp

PLAN_FORMAT = "colorado-watchdog/org-position-plan/v1"
ACTOR_DEFAULT = "org-position-foundation"

_BASIS_OFFICIAL = "Official county structure"
_BASIS_NAVIGATION = "Directory display fallback"
_BASIS_REVIEW = "Needs editorial review"
_VALID_KINDS = {
    "unknown", "elected_office", "appointed_office", "department", "division",
    "subunit", "partner", "navigation",
}


def _stable_id(prefix, *parts):
    key = canonical_json(list(parts)).encode("utf-8")
    return f"{prefix}_{hashlib.sha256(key).hexdigest()[:32]}"


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def _regional_partner(label, affiliation):
    if _nonempty(affiliation):
        return True
    normalized = " ".join(label.casefold().split())
    if any(term in normalized for term in ("regional", "multi-county", "multicounty", "joint district")):
        return True
    # A numbered or named judicial district is a regional affiliation, not a
    # county department. Do not broaden this to every label containing “district”.
    return "judicial district" in normalized and "attorney" in normalized


def _classify(label, field, basis, affiliation):
    if basis == _BASIS_NAVIGATION:
        return "navigation"
    if basis != _BASIS_OFFICIAL:
        return "unknown"
    if field == "division_label":
        return "division"
    if _regional_partner(label, affiliation):
        return "partner"
    folded = f" {label.casefold()} "
    if re.search(r"\b(department|dept\.?)(\b|\s)", folded):
        return "department"
    # The source labels mix offices and organizational groups. The table has no
    # generic “office” kind, so do not infer elected/appointed status from a name.
    return "unknown"


def _unit_key(county_fips, kind, label):
    return (county_fips, kind, label)


def _row_input(row):
    return {
        "claim_id": row["claim_id"], "county_fips": row["county_fips"],
        "evidence_id": row["evidence_id"], "source_id": row["source_id"],
        "batch_id": row["batch_id"], "family_id": row["family_id"],
        "lineage_kind": row["lineage_kind"], "selected": row["selected"],
        "department_label": row["department_label"], "division_label": row["division_label"],
        "legacy_display_group": row["legacy_display_group"], "grouping_basis": row["grouping_basis"],
        "affiliation": row["affiliation"], "published_title": row["published_title"],
        "source_listing_status": row["source_listing_status"],
    }


def _load_inputs(db):
    rows = list(db.execute(
        "SELECT c.id claim_id,c.county_fips,c.evidence_id,e.source_id,e.batch_id,"
        "b.family_id,b.lineage_kind,b.selected,c.department_label,c.division_label,"
        "c.legacy_display_group,c.grouping_basis,c.affiliation,c.published_title,"
        "c.source_listing_status FROM role_claims c "
        "JOIN evidence_links e ON e.id=c.evidence_id "
        "LEFT JOIN scrape_batches b ON b.id=e.batch_id "
        "ORDER BY c.county_fips,c.id"))
    if not rows:
        raise ValueError("No imported role claims are available for structure planning")
    return rows


def _existing_units(db):
    grouped = defaultdict(list)
    for row in db.execute("SELECT id,county_fips,source_label,kind FROM org_units ORDER BY id"):
        grouped[(row["county_fips"], row["kind"], row["source_label"])].append(row["id"])
    return grouped


def _resolve_unit_id(key, existing):
    county_fips, kind, label = key
    matches = existing.get(key, [])
    if len(matches) > 1:
        raise ValueError("Multiple existing units have the same county, kind, and exact source label")
    return matches[0] if matches else _stable_id("unit", county_fips, kind, label)


def build_structure_plan(db):
    """Build a deterministic, inspectable plan without writing to SQLite."""
    validate_migration_history(db)
    rows = _load_inputs(db)
    existing = _existing_units(db)
    units = {}
    claim_specs = {}
    unresolved = []
    parent_candidates = defaultdict(lambda: defaultdict(set))
    batch_versions = {}

    def register_unit(county_fips, label, kind, evidence_id, *, basis, field):
        if not _nonempty(label):
            return None
        if kind not in _VALID_KINDS:
            raise ValueError("Planner produced an unsupported organization kind")
        key = _unit_key(county_fips, kind, label)
        if key not in units:
            units[key] = {
                "id": _resolve_unit_id(key, existing), "county_fips": county_fips,
                "source_label": label, "kind": kind, "evidence_ids": set(),
                "name_evidence_ids": set(), "decision_basis": set(),
                "source_fields": set(), "parent_id": None,
                "parent_evidence_id": None, "parent_relation": None,
            }
        units[key]["evidence_ids"].add(evidence_id)
        units[key]["name_evidence_ids"].add(evidence_id)
        units[key]["decision_basis"].add(basis or "unknown")
        units[key]["source_fields"].add(field)
        return key

    for row in rows:
        item = _row_input(row)
        basis = item["grouping_basis"] or "unknown"
        dept = item["department_label"]
        division = item["division_label"]
        display = item["legacy_display_group"]

        if basis == _BASIS_NAVIGATION:
            selected_label = display if _nonempty(display) else dept
            key = register_unit(item["county_fips"], selected_label, "navigation", item["evidence_id"],
                                basis=basis, field="legacy_display_group")
            unit_reason = "directory_display_fallback"
        elif _nonempty(division):
            kind = _classify(division, "division_label", basis, item["affiliation"])
            key = register_unit(item["county_fips"], division, kind, item["evidence_id"],
                                basis=basis, field="division_label")
            unit_reason = "documented_division_label" if basis == _BASIS_OFFICIAL else "review_required"
            if basis == _BASIS_OFFICIAL and _nonempty(dept):
                parent_kind = _classify(dept, "department_label", basis, item["affiliation"])
                parent_key = register_unit(item["county_fips"], dept, parent_kind, item["evidence_id"],
                                            basis=basis, field="department_label")
                parent_candidates[key][parent_key].add(item["evidence_id"])
        elif _nonempty(dept):
            kind = _classify(dept, "department_label", basis, item["affiliation"])
            key = register_unit(item["county_fips"], dept, kind, item["evidence_id"],
                                basis=basis, field="department_label")
            unit_reason = "documented_department_or_office_label" if basis == _BASIS_OFFICIAL else "review_required"
        elif _nonempty(display):
            key = register_unit(item["county_fips"], display, "unknown", item["evidence_id"],
                                basis=basis, field="legacy_display_group")
            unit_reason = "missing_department_label"
        else:
            key = None
            unit_reason = "missing_organizational_label"

        unit_id = _resolve_unit_id(key, existing) if key is not None else None
        unit_kind = key[1] if key is not None else None
        if unit_id is None:
            unresolved.append({"claim_id": item["claim_id"], "evidence_id": item["evidence_id"],
                               "category": "organization", "reason": unit_reason})
        elif unit_kind in ("unknown", "navigation"):
            unresolved.append({"claim_id": item["claim_id"], "evidence_id": item["evidence_id"],
                               "category": "organization", "reason": unit_reason if unit_kind == "unknown"
                               else "navigation_is_not_an_organizational_unit"})

        claim_specs[item["claim_id"]] = {**item, "unit_key": key, "unit_id": unit_id,
                                           "unit_kind": unit_kind, "unit_reason": unit_reason}
        if item["batch_id"]:
            batch_versions[item["batch_id"]] = {
                "batch_id": item["batch_id"], "family_id": item["family_id"],
                "county_fips": item["county_fips"], "lineage_kind": item["lineage_kind"],
                "selected": item["selected"],
            }

    # A division has one parent only when every directly documented official
    # pairing agrees on one exact department label. Conflicts stay unresolved.
    unresolved_parents = []
    for division_key, parents in parent_candidates.items():
        if len(parents) != 1:
            unresolved_parents.append({
                "unit_id": units[division_key]["id"],
                "reason": "multiple_documented_parent_labels",
                "evidence_ids": sorted({e for values in parents.values() for e in values}),
            })
            continue
        parent_key, evidence_ids = next(iter(parents.items()))
        units[division_key]["parent_id"] = units[parent_key]["id"]
        units[division_key]["parent_relation"] = "administrative"
        units[division_key]["parent_evidence_id"] = sorted(evidence_ids)[0]

    # Existing parent links are immutable decisions for this automated process.
    for unit in units.values():
        current = db.execute(
            "SELECT parent_id,parent_relation,parent_evidence_id FROM org_units WHERE id=?",
            (unit["id"],),
        ).fetchone()
        if current is not None and any(current[index] is not None for index in range(3)):
            if (current["parent_id"], current["parent_relation"], current["parent_evidence_id"]) != (
                    unit["parent_id"], unit["parent_relation"], unit["parent_evidence_id"]):
                # Preserve a recorded owner/researcher decision; do not overwrite it.
                unit["parent_id"] = current["parent_id"]
                unit["parent_relation"] = current["parent_relation"]
                unit["parent_evidence_id"] = current["parent_evidence_id"]
                unresolved_parents.append({"unit_id": unit["id"],
                                           "reason": "existing_parent_decision_preserved",
                                           "evidence_ids": [unit["parent_evidence_id"]]
                                           if unit["parent_evidence_id"] else []})

    # Position targets describe exact title types, not employment seats.
    # A target is created only from a directly labeled official-structure claim
    # with a non-empty title and Listed source status. Historical claims may link
    # to such a type but never create one by themselves.
    target_claims = defaultdict(list)
    for spec in claim_specs.values():
        if (spec["unit_id"] and spec["grouping_basis"] == _BASIS_OFFICIAL
                and spec["source_listing_status"] == "Listed"
                and _nonempty(spec["published_title"]) and spec["unit_kind"] != "navigation"):
            target_claims[(spec["unit_id"], spec["county_fips"], spec["published_title"])].append(spec)

    existing_targets = defaultdict(list)
    for row in db.execute(
            "SELECT id,unit_id,county_fips,documented_title,evidence_id,occupancy,occupancy_evidence_id "
            "FROM role_targets ORDER BY id"):
        existing_targets[(row["unit_id"], row["county_fips"], row["documented_title"])].append(dict(row))

    targets = []
    target_by_key = {}
    for key, support in sorted(target_claims.items()):
        unit_id, county_fips, title = key
        old = existing_targets.get(key, [])
        if len(old) > 1:
            unresolved.append({"claim_id": support[0]["claim_id"],
                               "evidence_id": support[0]["evidence_id"],
                               "category": "position", "reason": "duplicate_existing_position_targets"})
            continue
        if old:
            target_id = old[0]["id"]
            evidence_id = old[0]["evidence_id"]
            if old[0]["occupancy"] != "unknown" or old[0]["occupancy_evidence_id"] is not None:
                # Occupancy decisions are outside this foundation process.
                pass
        else:
            target_id = _stable_id("target", unit_id, title)
            evidence_id = sorted({claim["evidence_id"] for claim in support})[0]
        target = {"id": target_id, "unit_id": unit_id, "county_fips": county_fips,
                  "documented_title": title, "evidence_id": evidence_id,
                  "occupancy": old[0]["occupancy"] if old else "unknown",
                  "occupancy_evidence_id": old[0]["occupancy_evidence_id"] if old else None,
                  "claim_ids": sorted(claim["claim_id"] for claim in support)}
        targets.append(target)
        target_by_key[key] = target_id

    claim_links = []
    source_links = {}
    for spec in claim_specs.values():
        target_id = None
        title = spec["published_title"]
        if (spec["unit_id"] and _nonempty(title)
                and spec["grouping_basis"] == _BASIS_OFFICIAL
                and spec["unit_kind"] != "navigation"):
            target_id = target_by_key.get((spec["unit_id"], spec["county_fips"], title))
        claim_links.append({"claim_id": spec["claim_id"], "county_fips": spec["county_fips"],
                            "evidence_id": spec["evidence_id"], "source_id": spec["source_id"],
                            "batch_id": spec["batch_id"], "family_id": spec["family_id"],
                            "lineage_kind": spec["lineage_kind"], "selected": spec["selected"],
                            "unit_id": spec["unit_id"], "target_id": target_id,
                            "unit_kind": spec["unit_kind"],
                            "link_relation": "navigation" if spec["unit_kind"] == "navigation" else "personnel",
                            "unit_reason": spec["unit_reason"],
                            "source_listing_status": spec["source_listing_status"],
                            "has_title": _nonempty(title),
                            "grouping_basis": spec["grouping_basis"]})
        if spec["unit_id"] and spec["source_id"]:
            relation = "navigation" if spec["unit_kind"] == "navigation" else "personnel"
            source_key = (spec["source_id"], spec["unit_id"], relation)
            source_links.setdefault(source_key, spec["evidence_id"])
            if spec["evidence_id"] < source_links[source_key]:
                source_links[source_key] = spec["evidence_id"]
        if not _nonempty(title):
            unresolved.append({"claim_id": spec["claim_id"], "evidence_id": spec["evidence_id"],
                               "category": "position", "reason": "missing_documented_title"})
        elif target_id is None:
            if spec["unit_kind"] == "navigation":
                reason = "navigation_group_does_not_establish_position_organization"
            elif spec["grouping_basis"] != _BASIS_OFFICIAL:
                reason = "organizational_grouping_requires_review"
            elif spec["source_listing_status"] == "Explicitly former":
                reason = "former_observation_cannot_create_current_position_target"
            elif spec["source_listing_status"] == "Unclear":
                reason = "unclear_listing_status_cannot_create_position_target"
            else:
                reason = "position_target_association_unresolved"
            unresolved.append({"claim_id": spec["claim_id"], "evidence_id": spec["evidence_id"],
                               "category": "position", "reason": reason})

    unit_rows = []
    name_rows = []
    for key, unit in sorted(units.items()):
        unit_rows.append({**unit, "evidence_ids": sorted(unit["evidence_ids"]),
                          "name_evidence_ids": sorted(unit["name_evidence_ids"]),
                          "decision_basis": sorted(unit["decision_basis"]),
                          "source_fields": sorted(unit["source_fields"])})
        for evidence_id in sorted(unit["name_evidence_ids"]):
            name_rows.append({"id": _stable_id("orgname", unit["id"], unit["source_label"],
                                               "published", evidence_id),
                              "unit_id": unit["id"], "name": unit["source_label"],
                              "kind": "published", "evidence_id": evidence_id})

    source_link_rows = []
    for (source_id, unit_id, relation), evidence_id in sorted(source_links.items()):
        prior = db.execute("SELECT evidence_id FROM source_unit_links "
                           "WHERE source_id=? AND unit_id=? AND relation=?",
                           (source_id, unit_id, relation)).fetchone()
        if prior is not None:
            linked_source = db.execute("SELECT source_id FROM evidence_links WHERE id=?",
                                       (prior["evidence_id"],)).fetchone()
            if linked_source is None or linked_source["source_id"] != source_id:
                raise ValueError("Existing source-to-unit link has invalid evidence lineage")
            evidence_id = prior["evidence_id"]
        source_link_rows.append({"source_id": source_id, "unit_id": unit_id,
                                 "relation": relation, "evidence_id": evidence_id})
    claim_links.sort(key=lambda item: item["claim_id"])
    targets.sort(key=lambda item: (item["county_fips"], item["unit_id"], item["documented_title"]))
    unresolved.sort(key=lambda item: (item["category"], item["reason"], item["claim_id"]))
    unresolved_parents.sort(key=lambda item: (item["unit_id"], item["reason"]))

    batch_rows = sorted(batch_versions.values(), key=lambda item: item["batch_id"])
    counts_by_county = defaultdict(int)
    for claim in claim_links:
        counts_by_county[claim["county_fips"]] += 1
    unit_kinds = defaultdict(int)
    for unit in unit_rows:
        unit_kinds[unit["kind"]] += 1
    claim_unit_count = sum(link["unit_id"] is not None for link in claim_links)
    claim_target_count = sum(link["target_id"] is not None for link in claim_links)
    unresolved_position_cases = [case for case in unresolved if case["category"] == "position"]
    position_without_target = [link for link in claim_links if link["has_title"] and link["target_id"] is None]
    missing_titles = [link for link in claim_links if not link["has_title"]]

    # The planner is statewide so it can validate the complete preserved graph,
    # but audit only decisions that have not already been recorded. Historical
    # role-claim structure events provide the durable processed marker; this
    # keeps incremental previews from re-auditing every prior claim.
    processed_claim_ids = {
        row[0] for row in db.execute(
            "SELECT DISTINCT entity_id FROM research_events "
            "WHERE entity_type='role_claims' AND kind='role_claim_structure_linked'")
    }
    new_claim_ids = sorted({claim["claim_id"] for claim in claim_links
                            if claim["claim_id"] not in processed_claim_ids})
    existing_unit_rows = {row["id"]: row for row in db.execute(
        "SELECT id,parent_id,parent_relation,parent_evidence_id FROM org_units")}
    existing_name_ids = {row[0] for row in db.execute("SELECT id FROM org_names")}
    existing_target_ids = {row[0] for row in db.execute("SELECT id FROM role_targets")}
    existing_source_links = {tuple(row) for row in db.execute(
        "SELECT source_id,unit_id,relation FROM source_unit_links")}
    new_units = sorted(unit["id"] for unit in unit_rows
                       if unit["id"] not in existing_unit_rows)
    new_parents = sorted(unit["id"] for unit in unit_rows if unit["parent_id"] and
                         (unit["id"] in new_units or
                          ((row := existing_unit_rows.get(unit["id"])) is not None and
                           (row["parent_id"], row["parent_relation"], row["parent_evidence_id"]) ==
                           (None, None, None))))
    new_names = sorted(name["id"] for name in name_rows
                       if name["id"] not in existing_name_ids)
    new_targets = sorted(target["id"] for target in targets
                         if target["id"] not in existing_target_ids)
    new_source_links = sorted(
        f"{link['source_id']}:{link['unit_id']}:{link['relation']}"
        for link in source_link_rows
        if (link["source_id"], link["unit_id"], link["relation"]) not in existing_source_links
    )
    new_evidence_ids = {claim["evidence_id"] for claim in claim_links if claim["claim_id"] in new_claim_ids}
    unresolved_parent_units = sorted(
        {case["unit_id"] for case in unresolved_parents
         if case["unit_id"] in new_units or any(
             evidence_id in new_evidence_ids
             for unit in unit_rows if unit["id"] == case["unit_id"]
             for evidence_id in unit["evidence_ids"])}
    )
    event_changes = {
        "units": new_units,
        "parents": new_parents,
        "names": new_names,
        "targets": new_targets,
        "source_links": new_source_links,
        "claims": new_claim_ids,
        "unresolved_parent_units": unresolved_parent_units,
    }
    payload = {
        "format": PLAN_FORMAT,
        "event_policy": "incremental-decisions/v1",
        "event_changes": event_changes,
        "input": {"claim_count": len(rows), "county_count": len(counts_by_county),
                  "batch_count": len(batch_rows), "batch_versions": batch_rows,
                  "claims_by_county": dict(sorted(counts_by_county.items()))},
        "units": unit_rows,
        "names": name_rows,
        "targets": targets,
        "source_links": source_link_rows,
        "claim_links": claim_links,
        "unresolved": unresolved,
        "unresolved_parents": unresolved_parents,
        "summary": {
            "counties_processed": len(counts_by_county),
            "claims_evaluated": len(claim_links),
            "organizational_units_by_kind": dict(sorted(unit_kinds.items())),
            "organizational_units": len(unit_rows),
            "position_targets": len(targets),
            "claims_linked_to_units": claim_unit_count,
            "claims_linked_to_positions": claim_target_count,
            "claims_with_unresolved_organization_association": sum(link["unit_id"] is None for link in claim_links),
            "claims_linked_to_unknown_kind_units": sum(link["unit_kind"] == "unknown" for link in claim_links),
            "claims_linked_to_navigation_groups": sum(link["unit_kind"] == "navigation" for link in claim_links),
            "claims_with_unresolved_position_association": len(position_without_target),
            "claims_missing_documented_title": len(missing_titles),
            "claims_with_any_unresolved_position_case": len({case["claim_id"] for case in unresolved_position_cases}),
            "unresolved_position_cases": len(unresolved_position_cases),
            "unresolved_parent_relationships": len(unresolved_parents),
            "identity_records_to_change": 0,
            "coverage_rows_to_change": 0,
            "new_coverage_rows_defaulted_to_not_started": len(unit_rows) * 4,
            "source_unit_links": len(source_link_rows),
            "published_unit_name_evidence_rows": len(name_rows),
            "source_visits_to_create": 0,
            "batch_or_evidence_rows_to_change": 0,
            "incremental_audit_events": sum(len(values) for values in event_changes.values())
                + sum(case["claim_id"] in set(new_claim_ids) for case in unresolved),
        },
    }
    digest = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    return {**payload, "plan_sha256": digest}


def plan_sha256(plan):
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise ValueError("Unsupported organization plan format")
    payload = {key: value for key, value in plan.items() if key != "plan_sha256"}
    actual = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    if plan.get("plan_sha256") != actual:
        raise ValueError("Organization plan integrity check failed")
    return actual


def _event_id(run_id, kind, entity_type, entity_id):
    return _stable_id("event", run_id, kind, entity_type, entity_id)


def _insert_event(db, run_id, kind, entity_type, entity_id, detail, *, now):
    db.execute(
        "INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
        (_event_id(run_id, kind, entity_type, entity_id), run_id, kind, entity_type,
         entity_id, now, now, "reconstructed", canonical_json(detail)),
    )


def _existing_run(db, run_id, digest, expected_events):
    row = db.execute("SELECT note FROM research_runs WHERE id=?", (run_id,)).fetchone()
    if row is None:
        return None
    if row["note"] != f"org-position-foundation/v1:{digest}":
        raise ValueError("A conflicting research run uses the deterministic organization run ID")
    actual_events = db.execute("SELECT count(*) FROM research_events WHERE run_id=?", (run_id,)).fetchone()[0]
    if actual_events != expected_events:
        raise ValueError("Previously applied organization run has an incomplete or changed audit history")
    return {"status": "already_applied", "run_id": run_id,
            "plan_sha256": digest, "audit_events": actual_events}


def _expected_event_count(plan):
    changes = plan.get("event_changes")
    if plan.get("event_policy") == "incremental-decisions/v1" and isinstance(changes, dict):
        return (sum(len(changes.get(key, [])) for key in (
            "units", "parents", "names", "targets", "source_links", "claims", "unresolved_parent_units"))
            + sum(case["claim_id"] in set(changes["claims"]) for case in plan["unresolved"]))
    return (len(plan["units"]) + len(plan["targets"]) + len(plan["claim_links"])
            + len(plan["names"]) + len(plan["source_links"])
            + len([u for u in plan["units"] if u["parent_id"]])
            + len(plan["unresolved"]) + len(plan["unresolved_parents"]))


def _same_decision_plan(left, right):
    """Compare the reviewed structural result while ignoring post-apply event deltas."""
    left_payload = {key: value for key, value in left.items()
                    if key not in {"plan_sha256", "event_changes"}}
    right_payload = {key: value for key, value in right.items()
                     if key not in {"plan_sha256", "event_changes"}}
    for payload in (left_payload, right_payload):
        payload["summary"] = dict(payload["summary"])
        payload["summary"].pop("incremental_audit_events", None)
    return left_payload == right_payload


def _check_same_county(db, child, parent):
    rows = db.execute("SELECT id,county_fips,kind FROM org_units WHERE id IN (?,?)", (child, parent)).fetchall()
    if len(rows) != 2 or rows[0]["county_fips"] != rows[1]["county_fips"]:
        raise ValueError("Cross-county organizational parent relationship rejected")
    return {row["id"]: row for row in rows}


def _verify_unit(db, unit):
    row = db.execute("SELECT county_fips,source_label,kind,parent_id,parent_relation,parent_evidence_id "
                     "FROM org_units WHERE id=?", (unit["id"],)).fetchone()
    expected = (unit["county_fips"], unit["source_label"], unit["kind"], unit["parent_id"],
                unit["parent_relation"], unit["parent_evidence_id"])
    if row is None or tuple(row) != expected:
        raise ValueError("Existing organization unit does not match the planned evidence-led unit")


def _verify_applied(db, plan, run_id):
    for unit in plan["units"]:
        _verify_unit(db, unit)
    for name in plan["names"]:
        row = db.execute("SELECT unit_id,name,kind,evidence_id FROM org_names WHERE id=?", (name["id"],)).fetchone()
        if row is None or tuple(row) != (name["unit_id"], name["name"], name["kind"], name["evidence_id"]):
            raise ValueError("Previously applied published unit name is missing or changed")
    for target in plan["targets"]:
        row = db.execute("SELECT unit_id,county_fips,documented_title,evidence_id,occupancy,occupancy_evidence_id "
                         "FROM role_targets WHERE id=?", (target["id"],)).fetchone()
        expected = (target["unit_id"], target["county_fips"], target["documented_title"],
                    target["evidence_id"], target["occupancy"], target["occupancy_evidence_id"])
        if row is None or tuple(row) != expected:
            raise ValueError("Previously applied documented position target is missing or changed")
    for link in plan["source_links"]:
        row = db.execute("SELECT evidence_id FROM source_unit_links WHERE source_id=? AND unit_id=? AND relation=?",
                         (link["source_id"], link["unit_id"], link["relation"])).fetchone()
        if row is None or row["evidence_id"] != link["evidence_id"]:
            raise ValueError("Previously applied source-to-unit link is missing")
    for claim in plan["claim_links"]:
        row = db.execute("SELECT unit_id,target_id FROM role_claims WHERE id=?", (claim["claim_id"],)).fetchone()
        if row is None or tuple(row) != (claim["unit_id"], claim["target_id"]):
            raise ValueError("Previously applied role-claim association is missing or changed")
    return _existing_run(db, run_id, plan["plan_sha256"], _expected_event_count(plan))


def apply_structure_plan(db, plan, *, expected_sha256, actor=ACTOR_DEFAULT):
    """Apply one exact preview in a single transaction; repeated application is a no-op."""
    digest = plan_sha256(plan)
    if digest != expected_sha256:
        raise ValueError("Expected plan SHA-256 does not match the inspected preview")
    if not isinstance(actor, str) or not actor.strip():
        raise ValueError("An attributable operator is required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before applying the organization plan")
    run_id = _stable_id("run", PLAN_FORMAT, digest)
    now = timestamp()
    db.execute("BEGIN IMMEDIATE")
    try:
        validate_migration_history(db)
        already = _existing_run(db, run_id, digest, _expected_event_count(plan))
        if already:
            db.rollback()
            _verify_applied(db, plan, run_id)
            return already

        for name in plan["names"]:
            row = db.execute("SELECT unit_id,name,kind,evidence_id FROM org_names WHERE id=?", (name["id"],)).fetchone()
            if row is not None and tuple(row) != (name["unit_id"], name["name"], name["kind"], name["evidence_id"]):
                raise ValueError("Conflicting existing organization name record")

        fresh = build_structure_plan(db)
        if fresh["plan_sha256"] != digest:
            raise ValueError("Research evidence or structure changed after the preview was generated")

        changes = plan.get("event_changes", {})
        changed_units = set(changes.get("units", []))
        changed_parents = set(changes.get("parents", []))
        changed_names = set(changes.get("names", []))
        changed_targets = set(changes.get("targets", []))
        changed_source_links = set(changes.get("source_links", []))
        changed_claims = set(changes.get("claims", []))
        changed_unresolved_parent_units = set(changes.get("unresolved_parent_units", []))

        db.execute("INSERT INTO research_runs VALUES (?,?,?,?,?,?,?,?)",
                   (run_id, "mapping", "reconstructed", actor, now, now, now,
                    f"org-position-foundation/v1:{digest}"))

        for unit in plan["units"]:
            existing = db.execute("SELECT county_fips,source_label,kind,parent_id,parent_relation,parent_evidence_id "
                                  "FROM org_units WHERE id=?", (unit["id"],)).fetchone()
            if existing is None:
                # Parent edges are applied only after both county-local units exist.
                db.execute("INSERT INTO org_units(id,county_fips,source_label,kind) VALUES (?,?,?,?)",
                           (unit["id"], unit["county_fips"], unit["source_label"], unit["kind"]))
            else:
                core = (existing["county_fips"], existing["source_label"], existing["kind"])
                if core != (unit["county_fips"], unit["source_label"], unit["kind"]):
                    raise ValueError("Conflicting existing organization unit")
            if unit["id"] in changed_units:
                _insert_event(db, run_id, "org_unit_evidence_reconciled", "org_units", unit["id"], {
                "county_fips": unit["county_fips"], "source_label": unit["source_label"],
                "kind": unit["kind"], "basis": unit["decision_basis"],
                "source_fields": unit["source_fields"], "evidence_ids": unit["evidence_ids"],
                "rule": "exact county-local label; kind remains unknown unless the source field or label supports a narrower class",
                }, now=now)

        for unit in plan["units"]:
            if not unit["parent_id"]:
                continue
            _check_same_county(db, unit["id"], unit["parent_id"])
            current = db.execute("SELECT parent_id,parent_relation,parent_evidence_id FROM org_units WHERE id=?",
                                 (unit["id"],)).fetchone()
            expected = (unit["parent_id"], unit["parent_relation"], unit["parent_evidence_id"])
            if tuple(current) == (None, None, None):
                db.execute("UPDATE org_units SET parent_id=?,parent_relation=?,parent_evidence_id=? WHERE id=?",
                           (*expected, unit["id"]))
            elif tuple(current) != expected:
                raise ValueError("Conflicting existing parent decision; no structural changes were committed")
            if unit["id"] in changed_parents:
                _insert_event(db, run_id, "org_unit_parent_reconciled", "org_units", unit["id"], {
                "parent_id": unit["parent_id"], "relation": unit["parent_relation"],
                "evidence_id": unit["parent_evidence_id"],
                "rule": "official-structure claim explicitly provides both division and department labels",
                }, now=now)

        for name in plan["names"]:
            row = db.execute("SELECT unit_id,name,kind,evidence_id FROM org_names WHERE id=?", (name["id"],)).fetchone()
            if row is None:
                db.execute("INSERT INTO org_names VALUES (?,?,?,?,?,?,?)",
                           (name["id"], name["unit_id"], name["name"], name["kind"],
                            name["evidence_id"], None, None))
            elif tuple(row) != (name["unit_id"], name["name"], name["kind"], name["evidence_id"]):
                raise ValueError("Conflicting existing organization name record")
            if name["id"] in changed_names:
                _insert_event(db, run_id, "org_name_evidence_reconciled", "org_names", name["id"], {
                "unit_id": name["unit_id"], "evidence_id": name["evidence_id"],
                "name": name["name"], "name_kind": "published",
                }, now=now)

        for target in plan["targets"]:
            row = db.execute("SELECT unit_id,county_fips,documented_title,evidence_id,occupancy,occupancy_evidence_id "
                             "FROM role_targets WHERE id=?", (target["id"],)).fetchone()
            if row is None:
                db.execute("INSERT INTO role_targets(id,unit_id,county_fips,documented_title,evidence_id,occupancy) "
                           "VALUES (?,?,?,?,?,'unknown')",
                           (target["id"], target["unit_id"], target["county_fips"],
                            target["documented_title"], target["evidence_id"]))
            else:
                expected = (target["unit_id"], target["county_fips"], target["documented_title"],
                            target["evidence_id"], target["occupancy"], target["occupancy_evidence_id"])
                if tuple(row) != expected:
                    raise ValueError("Conflicting existing position target; no structural changes were committed")
            if target["id"] in changed_targets:
                _insert_event(db, run_id, "role_target_evidence_reconciled", "role_targets", target["id"], {
                "unit_id": target["unit_id"], "title": target["documented_title"],
                "evidence_id": target["evidence_id"], "claim_ids": target["claim_ids"],
                "occupancy": target["occupancy"],
                "rule": "exact published title and county-local unit; Listed observation; one target per title type, not per employment seat",
                }, now=now)

        for link in plan["source_links"]:
            row = db.execute("SELECT evidence_id FROM source_unit_links WHERE source_id=? AND unit_id=? AND relation=?",
                             (link["source_id"], link["unit_id"], link["relation"])).fetchone()
            if row is None:
                db.execute("INSERT INTO source_unit_links VALUES (?,?,?,?)",
                           (link["source_id"], link["unit_id"], link["relation"], link["evidence_id"]))
            elif row["evidence_id"] != link["evidence_id"]:
                raise ValueError("Source-to-unit link changed after preview")
            source_link_key = f"{link['source_id']}:{link['unit_id']}:{link['relation']}"
            if source_link_key in changed_source_links:
                _insert_event(db, run_id, "source_unit_evidence_reconciled", "source_unit_links",
                          f"{link['source_id']}:{link['unit_id']}:{link['relation']}", {
                              "source_id": link["source_id"], "unit_id": link["unit_id"],
                              "relation": link["relation"], "evidence_id": link["evidence_id"],
                              }, now=now)

        for claim in plan["claim_links"]:
            row = db.execute("SELECT unit_id,target_id FROM role_claims WHERE id=?", (claim["claim_id"],)).fetchone()
            if row is None:
                raise ValueError("A planned role claim no longer exists")
            current_unit, current_target = tuple(row)
            if current_unit not in (None, claim["unit_id"]) or current_target not in (None, claim["target_id"]):
                raise ValueError("A role claim has a conflicting existing structural association")
            if current_unit is None or current_target is None:
                db.execute("UPDATE role_claims SET unit_id=?,target_id=? WHERE id=?",
                           (claim["unit_id"], claim["target_id"], claim["claim_id"]))
            if claim["claim_id"] in changed_claims:
                _insert_event(db, run_id, "role_claim_structure_linked", "role_claims", claim["claim_id"], {
                "before": {"unit_id": current_unit, "target_id": current_target},
                "after": {"unit_id": claim["unit_id"], "target_id": claim["target_id"]},
                "evidence_id": claim["evidence_id"], "batch_id": claim["batch_id"],
                "family_id": claim["family_id"], "lineage_kind": claim["lineage_kind"],
                "selected": claim["selected"], "unit_reason": claim["unit_reason"],
                "basis": claim["grouping_basis"],
                }, now=now)

        for case in plan["unresolved"]:
            if case["claim_id"] not in changed_claims:
                continue
            _insert_event(db, run_id, f"{case['category']}_association_unresolved",
                          "role_claims", case["claim_id"], {
                              "evidence_id": case["evidence_id"], "reason": case["reason"],
                              "claim_id": case["claim_id"],
                          }, now=now)
        for case in plan["unresolved_parents"]:
            if case["unit_id"] not in changed_unresolved_parent_units:
                continue
            _insert_event(db, run_id, "org_parent_relationship_unresolved", "org_units",
                          case["unit_id"], {"reason": case["reason"],
                                            "evidence_ids": case["evidence_ids"]}, now=now)

        final = build_structure_plan(db)
        if not _same_decision_plan(final, plan):
            raise ValueError("Applied structure does not reproduce the reviewed preview")
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise ValueError("Foreign-key integrity failed during structure application")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite integrity failed during structure application")
        db.commit()
        return {"status": "applied", "run_id": run_id, "plan_sha256": digest,
                "audit_events": _expected_event_count(plan), **plan["summary"]}
    except Exception:
        db.rollback()
        raise


def verify_structure_application(db, plan):
    """Read-only consistency report for one applied preview."""
    digest = plan_sha256(plan)
    run_id = _stable_id("run", PLAN_FORMAT, digest)
    already = _verify_applied(db, plan, run_id)
    if already is None:
        raise ValueError("This organization plan has not been applied")
    result = {"status": "verified", "run_id": run_id, "plan_sha256": digest,
              "audit_events": already["audit_events"], **plan["summary"]}
    return result


def write_plan(plan, destination, *, repository_root):
    """Write a private preview once, refusing repository and reparse paths."""
    destination = Path(destination)
    root = Path(repository_root).resolve()
    if not destination.is_absolute() or ".." in destination.parts:
        raise ValueError("Plan destination must be an explicit absolute path without traversal")
    current = Path(destination.anchor)
    for part in destination.parts[1:]:
        current /= part
        try:
            details = current.lstat()
        except FileNotFoundError:
            continue
        if current.is_symlink() or bool(getattr(details, "st_file_attributes", 0) & 0x400):
            raise ValueError("Plan destination cannot contain symbolic links or reparse points")
    resolved = destination.resolve()
    if resolved == root or root in resolved.parents:
        raise ValueError("Private structure plan must be stored outside the source checkout")
    if not resolved.parent.is_dir() or resolved.exists():
        raise FileExistsError("Plan destination parent must exist and destination must be new")
    content = json.dumps(plan, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_plan(path, *, repository_root):
    path = Path(path)
    root = Path(repository_root).resolve()
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Plan file must be an explicit absolute path without traversal")
    resolved = path.resolve(strict=True)
    if resolved == root or root in resolved.parents or not resolved.is_file():
        raise ValueError("Plan file must be a regular private file outside the checkout")
    plan = json.loads(resolved.read_text(encoding="utf-8"))
    plan_sha256(plan)
    return plan

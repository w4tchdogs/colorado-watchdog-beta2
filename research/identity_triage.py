"""Read-only, evidence-specific classification of the identity backlog."""

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from research import identity
from research.mapping import canonical_json

TRIAGE_FORMAT = "colorado-watchdog/identity-backlog-triage/v1"
TRIAGE_EVENT_POLICY = "decisions-only/v2"

_LINEAGE_REASONS = {
    "alternative_batch_is_not_independent_identity_evidence",
    "corrected_batch_version_is_not_selected",
}
_INELIGIBLE_REASONS = {
    "published_text_not_a_plausible_person_name",
    "evidence_does_not_directly_link_exact_name_and_role",
}
_AMBIGUOUS_REASONS = {
    "same_name_has_multiple_unlinked_source_observations",
    "existing_same_name_profile_requires_direct_identity_link",
    "identity_component_conflict_or_existing_association",
    "identity_link_not_established",
    "evidence_does_not_directly_link_exact_name_and_role",
}
_EVIDENCE_REQUIREMENTS = {
    "source_authority_not_established": (
        "Retained official publication or source-owner documentation that identifies this exact source as government-owned or officially published; then evaluate identity evidence separately.",
    ),
    "same_name_has_multiple_unlinked_source_observations": (
        "A direct official record connecting the exact person to the distinct documented roles, a documented unique personal identifier, or source evidence that distinguishes the entries.",
    ),
    "existing_same_name_profile_requires_direct_identity_link": (
        "A direct official identity link between this exact claim and the cited existing person; name equality is insufficient.",
    ),
    "identity_component_conflict_or_existing_association": (
        "Direct evidence resolving the conflicting existing assignment or identity component without reassigning an established claim.",
    ),
    "evidence_does_not_directly_link_exact_name_and_role": (
        "A retained official record that directly connects the exact published name to the documented title or responsibility.",
    ),
    "identity_link_not_established": (
        "A direct official identity connection, documented unique personal identifier, or selected correction lineage that links these exact observations.",
    ),
    "published_text_not_a_plausible_person_name": (
        "A corrected source observation that identifies a person by name and directly documents a role; otherwise retain the observation as ineligible.",
    ),
}


def _sha256(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _disposition(item, *, ineligible=False):
    reason = item["reason"]
    if ineligible:
        if reason not in _INELIGIBLE_REASONS:
            raise ValueError(f"Unrecognized ineligible identity reason: {reason}")
        return "ineligible"
    if reason in _LINEAGE_REASONS:
        return "version_or_lineage_dependent"
    if reason == "source_authority_not_established":
        return "source_authority_review"
    if reason in _AMBIGUOUS_REASONS and item.get("candidate_person_ids"):
        return "potential_identity_connection"
    if reason in _AMBIGUOUS_REASONS:
        return "genuinely_ambiguous"
    raise ValueError(f"Unrecognized unresolved identity reason: {reason}")


def _priority(disposition):
    if disposition == "automatically_resolvable":
        return 0
    if disposition == "source_authority_review":
        return 1
    if disposition == "potential_identity_connection":
        return 2
    if disposition == "version_or_lineage_dependent":
        return 3
    if disposition == "genuinely_ambiguous":
        return 4
    return 5


def _fields(raw_record_json):
    try:
        record = json.loads(raw_record_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    headers, cells = record.get("headers"), record.get("cells")
    if not isinstance(headers, list) or not isinstance(cells, list) or len(headers) != len(cells):
        return {}
    return {str(header): value for header, value in zip(headers, cells, strict=True)}


def _clip(value, limit=1000):
    if not isinstance(value, str):
        return value
    return value if len(value) <= limit else value[:limit] + "…[truncated]"


def _contexts_by_county(db, county_fips):
    rows = db.execute(
        "SELECT c.id,c.county_fips,c.person_id,c.published_name,c.published_title,c.responsibility,"
        "c.source_listing_status,c.unit_id,c.target_id,c.supersedes_id,c.affiliation,c.department_label,"
        "c.employment_start,c.employment_end,e.id AS evidence_id,e.source_id,e.source_version_key,"
        "e.observed_title,e.observed_url,e.quotation,e.locator,e.raw_record_json,e.raw_record_sha256,"
        "s.original_url,s.official_status,s.page_type,b.id AS batch_id,b.lineage_kind,b.selected,"
        "b.family_id,b.parent_batch_id,b.version_label FROM role_claims c "
        "JOIN evidence_links e ON e.id=c.evidence_id JOIN sources s ON s.id=e.source_id "
        "LEFT JOIN scrape_batches b ON b.id=e.batch_id WHERE c.county_fips=? ORDER BY c.id",
        (county_fips,),
    )
    return {row["id"]: dict(row) for row in rows}


def _claim_evidence(row):
    fields = _fields(row["raw_record_json"])
    name = row["published_name"] or ""
    roles = [value for value in (row["published_title"], row["responsibility"]) if value]
    direct_fields = {}
    for key, value in fields.items():
        if not isinstance(value, str):
            continue
        if value == name or any(role.casefold() in value.casefold() for role in roles):
            direct_fields[key] = _clip(value)
    return {
        "source_id": row["source_id"],
        "source_url": row["original_url"],
        "observed_url": row["observed_url"],
        "source_page_type": row["page_type"],
        "source_authority_status": row["official_status"],
        "evidence_id": row["evidence_id"],
        "source_version_key": row["source_version_key"],
        "locator": row["locator"],
        "quotation": _clip(row["quotation"]),
        "observed_title": _clip(row["observed_title"]),
        "published_title": row["published_title"],
        "responsibility": row["responsibility"],
        "name_and_role_fields": direct_fields,
        "raw_record_sha256": row["raw_record_sha256"],
        "batch": {"batch_id": row["batch_id"], "family_id": row["family_id"],
                  "lineage_kind": row["lineage_kind"], "selected": row["selected"],
                  "parent_batch_id": row["parent_batch_id"], "version_label": row["version_label"]},
    }


def _candidate_people_by_county(db, county_fips, person_ids):
    if not person_ids:
        return {}
    people = {}
    for row in db.execute(
            "SELECT p.id,p.display_name,p.identity_state,p.identity_evidence_id,"
            "count(c.id) AS assigned_claim_count FROM research_people p "
            "LEFT JOIN role_claims c ON c.person_id=p.id WHERE p.county_fips=? "
            "GROUP BY p.id ORDER BY p.id", (county_fips,)):
        if row["id"] in person_ids:
            people[row["id"]] = {"person_id": row["id"], "display_name": row["display_name"],
                                  "identity_state": row["identity_state"],
                                  "identity_evidence_id": row["identity_evidence_id"],
                                  "assigned_claim_count": row["assigned_claim_count"]}
    return people


def _make_case(item, context, *, ineligible=False, association=None, person=None,
               source_proposal=None):
    reason = item.get("reason")
    disposition = "automatically_resolvable" if association is not None else _disposition(item, ineligible=ineligible)
    blockers = []
    source_status = context["official_status"]
    if source_status != "official" and source_proposal is None:
        blockers.append("source_authority_not_established")
    if reason in _LINEAGE_REASONS:
        blockers.append(reason)
    if reason and reason not in _LINEAGE_REASONS and reason != "source_authority_not_established":
        blockers.append(reason)
    requirement = _EVIDENCE_REQUIREMENTS.get(reason, ())
    if source_status != "official" and source_proposal is None and "source_authority_not_established" not in blockers:
        requirement = ("Retained source-owner or official-publication evidence for the exact cited source, then the listed identity evidence.", *requirement)
    case = {
        "claim_id": context["id"],
        "county_fips": context["county_fips"],
        "published_name": context["published_name"],
        "published_title": context["published_title"],
        "responsibility": context["responsibility"],
        "current_person_id": context["person_id"],
        "current_unresolved_reason": reason,
        "disposition": disposition,
        "priority": _priority(disposition),
        "blockers": sorted(set(blockers)),
        "candidate_person_ids": sorted(item.get("candidate_person_ids", [])),
        "candidate_people": person or [],
        "identity_method_if_applied": association.get("method") if association else None,
        "associated_person_id_if_applied": association.get("person_id") if association else None,
        "supporting_identity_evidence_id": (association or {}).get("evidence_id") or context["evidence_id"],
        "existing_direct_connection_status": (
            "supported_and_in_plan" if association and association.get("method") in
            ("official_connection", "correction_lineage") else "no_supported_direct_connection_found"),
        "identity_evaluation": "County-scoped accepted planner evaluated selected correction lineage and direct official role connections; this triage did not add identity edges.",
        "source_classification_if_applied": source_proposal,
        "smallest_evidence_requirement": list(requirement),
        "evidence": _claim_evidence(context),
        "organizational_links_preserved": {"unit_id": context["unit_id"], "position_target_id": context["target_id"],
                                            "affiliation": context["affiliation"], "department": context["department_label"],
                                            "employment_start": context["employment_start"],
                                            "employment_end": context["employment_end"],
                                            "listing_status": context["source_listing_status"]},
    }
    return case


def _count_by_reason(cases):
    counts = Counter((case["current_unresolved_reason"] or "automatically_resolvable") for case in cases)
    return dict(sorted(counts.items()))


def build_identity_triage_report(db, identity_plan):
    """Classify every current unassigned claim using the accepted identity planner."""
    identity.plan_sha256(identity_plan)
    cases = []
    source_authority_claims = Counter()
    source_queue = {}
    planned_source_classifications = {item["source_id"]: item
                                      for item in identity_plan["source_classifications"]}
    categorized_by_county = defaultdict(Counter)
    for county in identity_plan["counties"]:
        fips = county["county_fips"]
        contexts = _contexts_by_county(db, fips)
        candidate_ids = {person_id for item in county["unresolved"]
                         for person_id in item.get("candidate_person_ids", [])}
        candidate_people = _candidate_people_by_county(db, fips, candidate_ids)
        groups = (
            (county["associations"], False, "association"),
            (county["unresolved"], False, "unresolved"),
            (county["rejected"], True, "rejected"),
        )
        for items, ineligible, group in groups:
            for item in items:
                context = contexts.get(item["claim_id"])
                if context is None:
                    raise ValueError("Triage plan references a claim outside its county")
                people = [candidate_people[person_id] for person_id in item.get("candidate_person_ids", [])
                          if person_id in candidate_people]
                case = _make_case(item, context, ineligible=ineligible,
                                  association=item if group == "association" else None,
                                  person=people,
                                  source_proposal=planned_source_classifications.get(context["source_id"]))
                if group == "rejected":
                    case["disposition"] = "ineligible"
                    case["priority"] = 5
                    case["smallest_evidence_requirement"] = list(_EVIDENCE_REQUIREMENTS.get(item["reason"], ()))
                cases.append(case)
                categorized_by_county[fips][case["disposition"]] += 1
                if context["official_status"] != "official" and context["source_id"] not in planned_source_classifications:
                    source_authority_claims[context["source_id"]] += 1
                    record = source_queue.setdefault(context["source_id"], {
                        "source_id": context["source_id"], "source_url": context["original_url"],
                        "current_authority_status": context["official_status"], "page_type": context["page_type"],
                        "counties": set(), "claim_count": 0, "claim_ids": [], "evidence_ids": set(),
                        "supporting_raw_record_hashes": set(),
                    })
                    record["counties"].add(fips)
                    record["claim_count"] += 1
                    record["claim_ids"].append(context["id"])
                    record["evidence_ids"].add(context["evidence_id"])
                    if context["raw_record_sha256"]:
                        record["supporting_raw_record_hashes"].add(context["raw_record_sha256"])

    case_ids = [case["claim_id"] for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("A role claim appeared in more than one triage disposition")
    expected_unassigned = identity_plan["summary"]["role_claims_unassigned_before"]
    if len(cases) != expected_unassigned:
        raise ValueError("Triage dispositions do not reconcile to the current unassigned claim count")
    counts = Counter(case["disposition"] for case in cases)
    unresolved = sum(counts[name] for name in (
        "automatically_resolvable", "source_authority_review", "potential_identity_connection",
        "genuinely_ambiguous", "version_or_lineage_dependent"))
    ineligible = counts["ineligible"]
    if unresolved + ineligible != expected_unassigned:
        raise ValueError("Unresolved and ineligible triage counts do not reconcile")
    expected_unresolved = identity_plan["summary"]["unresolved_claims"]
    if unresolved - counts["automatically_resolvable"] != expected_unresolved:
        raise ValueError("Current unresolved count differs from the identity planner's full classification")

    for county, item_counts in categorized_by_county.items():
        item_counts["total_unassigned_accounted"] = sum(
            value for key, value in item_counts.items() if key != "total_unassigned_accounted")
    source_authority_queue = []
    for item in source_queue.values():
        source_authority_queue.append({**item,
            "counties": sorted(item["counties"]), "claim_ids": sorted(item["claim_ids"]),
            "evidence_ids": sorted(item["evidence_ids"]),
            "supporting_raw_record_hashes": sorted(item["supporting_raw_record_hashes"]),
            "smallest_evidence_requirement": (
                "Retained government source-owner documentation or an official publication that explicitly identifies this exact host; do not infer authority from the domain suffix, county name, or vendor relationship.",
            ),
        })
    source_authority_queue.sort(key=lambda item: (-item["claim_count"], item["source_url"], item["source_id"]))
    cases.sort(key=lambda case: (case["priority"], case["county_fips"], case["claim_id"]))
    payload = {
        "format": TRIAGE_FORMAT,
        "event_policy": TRIAGE_EVENT_POLICY,
        "identity_plan": identity_plan,
        "summary": {
            "counties_processed": identity_plan["summary"]["counties_processed"],
            "role_claims_evaluated": identity_plan["summary"]["role_claims_evaluated"],
            "role_claims_assigned_before": identity_plan["summary"]["role_claims_assigned_before"],
            "role_claims_unassigned_before": expected_unassigned,
            "starting_unresolved_claims": unresolved,
            "automatically_resolvable": counts["automatically_resolvable"],
            "source_authority_review": counts["source_authority_review"],
            "potential_identity_connection": counts["potential_identity_connection"],
            "genuinely_ambiguous": counts["genuinely_ambiguous"],
            "version_or_lineage_dependent": counts["version_or_lineage_dependent"],
            "ineligible": ineligible,
            "source_authority_unestablished_claims": sum(source_authority_claims.values()),
            "distinct_sources_with_unestablished_authority": len(source_authority_claims),
            "claims_associated_if_applied": identity_plan["summary"]["claims_associated"],
            "new_people_if_applied": identity_plan["summary"]["new_research_people"],
            "source_classifications_if_applied": identity_plan["summary"]["source_classifications_to_official"],
            "unresolved_after_supported_actions": unresolved - counts["automatically_resolvable"],
            "cross_county_candidate_search": False,
            "publication_changes": 0,
        },
        "counts_by_county": {county: dict(sorted(counts_.items()))
                             for county, counts_ in sorted(categorized_by_county.items())},
        "counts_by_current_reason": _count_by_reason(cases),
        "source_authority_queue": source_authority_queue,
        "supported_source_classifications": [
            {**item, "source_url": db.execute("SELECT original_url FROM sources WHERE id=?",
                                               (item["source_id"],)).fetchone()[0]}
            for item in identity_plan["source_classifications"]
        ],
        "cases": cases,
    }
    payload["triage_sha256"] = _sha256(payload)
    return payload


def triage_sha256(report):
    if not isinstance(report, dict) or report.get("format") != TRIAGE_FORMAT:
        raise ValueError("Unsupported identity backlog triage report")
    actual = _sha256({key: value for key, value in report.items() if key != "triage_sha256"})
    if report.get("triage_sha256") != actual:
        raise ValueError("Identity backlog triage report digest is invalid")
    identity.plan_sha256(report.get("identity_plan"))
    return actual


def _validate_private_path(path, repository_root, *, must_be_new):
    path = Path(path)
    root = Path(repository_root).resolve()
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Private triage report path must be absolute and contain no traversal")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            details = current.lstat()
        except FileNotFoundError:
            continue
        if current.is_symlink() or bool(getattr(details, "st_file_attributes", 0) & 0x400):
            raise ValueError("Private triage report path cannot contain symbolic links or reparse points")
    resolved = path.resolve()
    if resolved == root or root in resolved.parents or not resolved.parent.is_dir():
        raise ValueError("Private triage reports must be outside the source checkout")
    if must_be_new and resolved.exists():
        raise FileExistsError("Private triage report destination already exists")
    return resolved


def write_triage_report(report, destination, *, repository_root):
    triage_sha256(report)
    resolved = _validate_private_path(destination, repository_root, must_be_new=True)
    content = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_triage_report(path, *, repository_root):
    resolved = _validate_private_path(path, repository_root, must_be_new=False)
    if not resolved.is_file():
        raise ValueError("Identity triage report must be a regular private file")
    report = json.loads(resolved.read_text(encoding="utf-8"))
    triage_sha256(report)
    return report

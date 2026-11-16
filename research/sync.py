"""Deterministic, privacy-bounded Profiles to m2-sync/v1 changesets.

This is a local generator and receipt reconciler. It intentionally has no network
transport; sending remains the caller-injected R6 submission boundary.
"""

import hashlib
import json
from collections import Counter, defaultdict
from urllib.parse import urlsplit
from datetime import datetime, timezone
from datetime import date as calendar_date
from uuid import UUID, uuid5, NAMESPACE_URL

from research.mapping import canonical_json
from research.store import timestamp
from research.submission import prepare_submission

SITE_ENTITY_TYPES = {
    "org_unit",
    "research_person",
    "role_target",
    "source",
    "role_claim",
}
ORG_TYPES = {
    "elected_office": "office",
    "appointed_office": "office",
    "department": "department",
    "division": "division",
    "subunit": "other",
    "partner": "partner",
}
SOURCE_TYPES = {
    "official_page": "official_page",
    "public_document": "public_document",
    "other_public": "other_public",
}


def _ref(entity_type, local_id):
    digest = hashlib.sha256(f"{entity_type}\0{local_id}".encode()).hexdigest()[:24]
    return f"{entity_type.replace('_', '-')}-{digest}"


def _source_ok(db, evidence_id, *, allowed_publishers=("official",)):
    row = db.execute(
        "SELECT e.id,e.source_id,e.observed_title,e.observed_url,e.recorded_at,s.original_url,"
        "s.official_status,s.publisher_classification,s.page_type FROM evidence_links e JOIN sources s ON s.id=e.source_id "
        "WHERE e.id=?",
        (evidence_id,),
    ).fetchone()
    if row is None:
        return None, "source_not_classified_official"
    if row["publisher_classification"] not in allowed_publishers:
        if row["publisher_classification"] == "unresolved":
            return None, "source_publisher_unresolved"
        return None, "source_publisher_not_accepted"
    source_type = SOURCE_TYPES.get((row["page_type"] or "").strip().lower())
    if source_type is None:
        return None, "ambiguous_source_classification"
    if not row["observed_title"] or row["observed_url"] != row["original_url"]:
        return None, "citation_metadata_missing_or_changed"
    try:
        parsed_url = urlsplit(row["observed_url"])
        if (
            parsed_url.scheme.lower() not in ("http", "https")
            or not parsed_url.hostname
            or parsed_url.username is not None
            or parsed_url.password is not None
            or len(row["observed_url"].encode("utf-8")) > 2048
        ):
            return None, "invalid_public_citation_url"
    except (ValueError, UnicodeError):
        return None, "invalid_public_citation_url"
    if len(row["observed_title"].encode("utf-8")) > 500:
        return None, "citation_title_too_long"
    checked = row["recorded_at"]
    try:
        parsed = datetime.fromisoformat(checked.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None, "source_check_time_not_utc"
        checked = (
            parsed.astimezone(timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
    except (ValueError, AttributeError):
        return None, "source_check_time_invalid"
    return {
        "source_id": row["source_id"],
        "url": row["observed_url"],
        "title": row["observed_title"],
        "publisher_classification": row["publisher_classification"],
        "source_type": source_type,
        "source_checked_at": checked,
    }, None


def _linked(db, site_key, local_type, local_id):
    return db.execute(
        "SELECT website_entity,website_id,website_version,link_state FROM site_entity_links "
        "WHERE site_key=? AND local_entity_type=? AND local_entity_id=?",
        (site_key, local_type, local_id),
    ).fetchone()


def build_changeset(db, site_key, *, request_id=None, max_changes=200, county_fips=None):
    """Return a stable request plus eligibility/exclusion diagnostics (never private notes)."""
    if not isinstance(site_key, str) or not site_key.strip() or len(site_key) > 128:
        raise ValueError("A bounded Site key is required")
    if not 1 <= max_changes <= 200:
        raise ValueError("max_changes must be between 1 and 200")
    if county_fips is not None:
        from research.mapping import COUNTIES
        if not isinstance(county_fips, str) or county_fips not in COUNTIES:
            raise ValueError("County scope must be a canonical Colorado FIPS code")

    candidate_sql = (
        "SELECT c.id,c.person_id,c.unit_id,c.target_id,e.source_id,b.selected "
        "FROM role_claims c JOIN evidence_links e ON e.id=c.evidence_id "
        "JOIN scrape_batches b ON b.id=e.batch_id "
    )
    candidate_params = []
    if county_fips is not None:
        candidate_sql += "WHERE c.county_fips=? "
        candidate_params.append(county_fips)
    candidate_rows = list(db.execute(candidate_sql + "ORDER BY c.id", candidate_params))
    selected_candidates = [row for row in candidate_rows if row["selected"]]
    skipped_batch_claims = sum(not row["selected"] for row in candidate_rows)
    candidate_people_all = {row["person_id"] for row in candidate_rows if row["person_id"]}
    candidate_people = {row["person_id"] for row in selected_candidates if row["person_id"]}

    scoped_unit_ids = None
    if county_fips is not None:
        # Keep units referenced by county observations (whether or not their
        # batch is selected) and the parent chain needed by R7. Claims still
        # pass the selected-batch gate below, independently of org eligibility.
        scoped_unit_ids = {row["unit_id"] for row in candidate_rows if row["unit_id"]}
        pending_ancestors = list(scoped_unit_ids)
        while pending_ancestors:
            unit_id = pending_ancestors.pop()
            row = db.execute("SELECT parent_id FROM org_units WHERE id=?", (unit_id,)).fetchone()
            if row and row["parent_id"] and row["parent_id"] not in scoped_unit_ids:
                scoped_unit_ids.add(row["parent_id"])
                pending_ancestors.append(row["parent_id"])
    excluded, changes, item_meta = [], [], []
    refs, queued_orgs, queued_people, queued_targets, queued_sources = (
        {},
        set(),
        set(),
        set(),
        set(),
    )

    def add(change, local_type=None, local_id=None, evidence_id=None, claim_id=None):
        if len(changes) >= max_changes:
            return False
        index = len(changes)
        changes.append(change)
        item_meta.append(
            {
                "item_index": index,
                "client_ref": change.get("clientRef", f"update-{index}"),
                "website_entity": change["entity"],
                "local_entity_type": local_type,
                "local_entity_id": local_id,
                "evidence_id": evidence_id,
                "claim_id": claim_id,
                "request_item_json": canonical_json(change),
            }
        )
        return True

    # Only explicitly structured and source-backed units are eligible. Parent
    # refs are emitted before children; unsupported parentage is never guessed.
    unit_sql = (
            "SELECT u.id,u.county_fips,u.source_label,u.kind,u.parent_id,u.parent_relation,"
            "u.parent_evidence_id,(SELECT n.evidence_id FROM org_names n JOIN evidence_links e ON e.id=n.evidence_id "
            "JOIN sources s ON s.id=e.source_id WHERE n.unit_id=u.id AND n.kind='published' "
            "AND s.publisher_classification='official' ORDER BY n.evidence_id LIMIT 1) evidence_id "
            "FROM org_units u "
    )
    unit_params = []
    if scoped_unit_ids is not None:
        if scoped_unit_ids:
            marks = ",".join("?" for _ in scoped_unit_ids)
            unit_sql += f"WHERE u.id IN ({marks}) "
            unit_params.extend(sorted(scoped_unit_ids))
        else:
            unit_sql += "WHERE 0 "
    units = list(db.execute(unit_sql + "ORDER BY u.county_fips,u.id", unit_params))
    units_by_id = {u["id"]: u for u in units}
    for unit in units:
        link = _linked(db, site_key, "org_unit", unit["id"])
        if link is not None and link["link_state"] != "active":
            excluded.append(
                {
                    "entity_type": "org_unit",
                    "entity_id": unit["id"],
                    "reason": "website_mapping_requires_recovery_review",
                }
            )
    pending = {
        u["id"]: u
        for u in units
        if u["kind"] in ORG_TYPES and _linked(db, site_key, "org_unit", u["id"]) is None
    }
    while pending:
        progressed = False
        for local_id, unit in list(pending.items()):
            parent_id = unit["parent_id"]
            if parent_id and unit["parent_relation"] not in (
                "administrative",
                "navigation",
            ):
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "unsupported_hierarchy",
                    }
                )
                del pending[local_id]
                progressed = True
                continue
            if (
                parent_id
                and parent_id not in refs
                and _linked(db, site_key, "org_unit", parent_id) is None
            ):
                if parent_id in pending:
                    continue
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "unsupported_hierarchy",
                    }
                )
                del pending[local_id]
                progressed = True
                continue
            if not unit["evidence_id"]:
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "no_official_name_evidence",
                    }
                )
                del pending[local_id]
                progressed = True
                continue
            if len(unit["source_label"].encode("utf-8")) > 500:
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "organization_name_too_long",
                    }
                )
                del pending[local_id]
                progressed = True
                continue
            _evidence_source, evidence_reason = _source_ok(db, unit["evidence_id"])
            if evidence_reason:
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": evidence_reason,
                    }
                )
                del pending[local_id]
                progressed = True
                continue
            parent_link = (
                _linked(db, site_key, "org_unit", parent_id) if parent_id else None
            )
            if (
                parent_id
                and parent_link
                and parent_link["website_entity"] != "organizations"
            ):
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "conflicting_parent_mapping",
                    }
                )
                del pending[local_id]
                progressed = True
                continue
            client_ref = _ref("org_unit", local_id)
            refs[local_id] = client_ref
            fields = {
                "name": unit["source_label"],
                "organization_type": ORG_TYPES[unit["kind"]],
                "county_fips": (
                    None if unit["kind"] == "partner" else unit["county_fips"]
                ),
            }
            if parent_id:
                if parent_id in refs:
                    fields.update(
                        parent_organization_ref=refs[parent_id],
                        parent_relationship=(
                            "reports_to"
                            if unit["parent_relation"] == "administrative"
                            else "grouped_under"
                        ),
                    )
                else:
                    fields.update(
                        parent_organization_id=parent_link["website_id"],
                        parent_relationship=(
                            "reports_to"
                            if unit["parent_relation"] == "administrative"
                            else "grouped_under"
                        ),
                    )
            change = {
                "op": "create_organization",
                "entity": "organizations",
                "clientRef": client_ref,
                "fields": fields,
            }
            if add(change, "org_unit", local_id, unit["evidence_id"]):
                queued_orgs.add(local_id)
            else:
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "changeset_limit",
                    }
                )
            del pending[local_id]
            progressed = True
        if not progressed:
            for local_id in pending:
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": local_id,
                        "reason": "hierarchy_cycle_or_unresolved_parent",
                    }
                )
            break

    # Explicit partner/other-county affiliations are associations, not county hierarchy.
    for unit in units:
        if unit["kind"] != "partner" or (
            unit["id"] not in refs
            and _linked(db, site_key, "org_unit", unit["id"]) is None
        ):
            continue

        affiliation_sql = (
            "SELECT DISTINCT c.county_fips,c.affiliation,c.evidence_id FROM role_claims c "
            "JOIN evidence_links e ON e.id=c.evidence_id JOIN scrape_batches b ON b.id=e.batch_id "
            "WHERE c.unit_id=? AND b.selected=1 AND c.affiliation IS NOT NULL AND trim(c.affiliation)<>'' "
        )
        affiliation_params = [unit["id"]]
        if county_fips is not None:
            affiliation_sql += "AND c.county_fips=? "
            affiliation_params.append(county_fips)
        rows = db.execute(affiliation_sql + "ORDER BY c.county_fips,c.evidence_id", affiliation_params)
        for row in rows:
            _citation, affiliation_reason = _source_ok(db, row["evidence_id"])
            if affiliation_reason:
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": unit["id"],
                        "reason": "affiliation_" + affiliation_reason,
                    }
                )
                continue
            aff_id = f"{unit['id']}:{row['county_fips']}:partner_for"
            aff_link = _linked(db, site_key, "org_affiliation", aff_id)
            if aff_link is not None:
                if aff_link["link_state"] != "active":
                    excluded.append(
                        {
                            "entity_type": "org_affiliation",
                            "entity_id": aff_id,
                            "reason": "website_mapping_requires_recovery_review",
                        }
                    )
                continue
            partner_link = _linked(db, site_key, "org_unit", unit["id"])
            if partner_link is not None and partner_link["link_state"] != "active":
                excluded.append(
                    {
                        "entity_type": "org_affiliation",
                        "entity_id": aff_id,
                        "reason": "organization_mapping_requires_recovery_review",
                    }
                )
                continue
            change = {
                "op": "add_county_affiliation",
                "entity": "organization_county_affiliations",
                "clientRef": _ref("affiliation", aff_id),
                "fields": {
                    ("organization_ref" if unit["id"] in refs else "organization_id"): (
                        refs[unit["id"]]
                        if unit["id"] in refs
                        else partner_link["website_id"]
                    ),
                    "county_fips": row["county_fips"],
                    "relationship_type": "partner_for",
                },
            }
            if not add(change, "org_affiliation", aff_id, row["evidence_id"]):
                excluded.append(
                    {
                        "entity_type": "org_unit",
                        "entity_id": unit["id"],
                        "reason": "changeset_limit",
                    }
                )
                break

    # Selected, officially classified observations with evidence-supported
    # people, explicit positions, and exact public citations only.
    claims = list(
        db.execute(
            "SELECT c.id claim_id,c.person_id,c.unit_id,c.target_id,c.published_name,c.published_title,"
            "c.employment_start,c.employment_end,c.source_listing_status,c.evidence_id,e.source_id,e.batch_id,"
            "b.selected,p.display_name,p.identity_state,p.identity_evidence_id,u.kind unit_kind,t.documented_title "
            "FROM role_claims c JOIN evidence_links e ON e.id=c.evidence_id "
            "JOIN scrape_batches b ON b.id=e.batch_id LEFT JOIN research_people p ON p.id=c.person_id "
            "LEFT JOIN org_units u ON u.id=c.unit_id LEFT JOIN role_targets t ON t.id=c.target_id "
            + ("WHERE b.selected=1 AND c.county_fips=? " if county_fips is not None else "WHERE b.selected=1 ")
            + "ORDER BY c.id",
            (county_fips,) if county_fips is not None else (),
        )
    )
    for claim in claims:
        role_link = _linked(db, site_key, "role_claim", claim["claim_id"])
        if role_link is not None:
            if role_link["link_state"] != "active":
                excluded.append(
                    {
                        "entity_type": "role_claim",
                        "entity_id": claim["claim_id"],
                        "reason": "website_mapping_requires_recovery_review",
                    }
                )
            continue
        if claim["source_listing_status"] != "Listed":
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "not_currently_listed",
                }
            )
            continue
        if (
            not claim["person_id"]
            or claim["identity_state"] != "evidence_supported"
            or not claim["identity_evidence_id"]
        ):
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "identity_unresolved",
                }
            )
            continue
        if (
            not claim["display_name"]
            or len(claim["display_name"].encode("utf-8")) > 500
            or not claim["documented_title"]
            or len(claim["documented_title"].encode("utf-8")) > 500
        ):
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "person_or_position_text_invalid",
                }
            )
            continue
        if (
            not claim["unit_id"]
            or not claim["target_id"]
            or not claim["documented_title"]
        ):
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "unsupported_position_or_organization",
                }
            )
            continue
        unit = units_by_id.get(claim["unit_id"])
        if unit is None or unit["kind"] not in ORG_TYPES:
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "unsupported_organization",
                }
            )
            continue
        if (
            claim["unit_id"] not in refs
            and _linked(db, site_key, "org_unit", claim["unit_id"]) is None
        ):
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "organization_not_selected",
                }
            )
            continue
        org_link = _linked(db, site_key, "org_unit", claim["unit_id"])
        if org_link is not None and org_link["link_state"] != "active":
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "organization_mapping_requires_recovery_review",
                }
            )
            continue
        # Role citations may be published by a verified government or
        # nongovernment publisher. Identity, organization names, and
        # affiliations continue to use _source_ok's official-only default.
        citation, reason = _source_ok(
            db, claim["evidence_id"], allowed_publishers=("official", "unofficial")
        )
        if reason:
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": reason,
                }
            )
            continue
        try:
            start = (
                calendar_date.fromisoformat(claim["employment_start"])
                if claim["employment_start"]
                else None
            )
            end = (
                calendar_date.fromisoformat(claim["employment_end"])
                if claim["employment_end"]
                else None
            )
            if (
                (start and start.isoformat() != claim["employment_start"])
                or (end and end.isoformat() != claim["employment_end"])
                or (start and end and end < start)
            ):
                raise ValueError
        except ValueError:
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "employment_date_invalid",
                }
            )
            continue

        person_id, target_id, source_id = (
            claim["person_id"],
            claim["target_id"],
            citation["source_id"],
        )
        if (
            _linked(db, site_key, "source", source_id) is None
            and source_id not in queued_sources
            and len(queued_sources) >= 25
        ):
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "changeset_citation_limit",
                }
            )
            continue
        p_link = _linked(db, site_key, "research_person", person_id)
        if p_link is None and person_id not in queued_people:
            pref = _ref("research_person", person_id)
            if add(
                {
                    "op": "create_person",
                    "entity": "people",
                    "clientRef": pref,
                    "fields": {"display_name": claim["display_name"]},
                },
                "research_person",
                person_id,
                claim["identity_evidence_id"],
                claim["claim_id"],
            ):
                queued_people.add(person_id)
                refs[person_id] = pref
            else:
                excluded.append(
                    {
                        "entity_type": "role_claim",
                        "entity_id": claim["claim_id"],
                        "reason": "changeset_limit",
                    }
                )
                continue
        t_link = _linked(db, site_key, "role_target", target_id)
        if t_link is not None and t_link["link_state"] != "active":
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "position_mapping_requires_recovery_review",
                }
            )
            continue
        if t_link is None and target_id not in queued_targets:
            tref = _ref("role_target", target_id)
            org_ref = refs.get(claim["unit_id"])
            org_link = _linked(db, site_key, "org_unit", claim["unit_id"])
            org_fields = (
                {"organization_ref": org_ref}
                if org_ref
                else {"organization_id": org_link["website_id"]}
            )
            if add(
                {
                    "op": "create_position",
                    "entity": "positions",
                    "clientRef": tref,
                    "fields": {"title": claim["documented_title"], **org_fields},
                },
                "role_target",
                target_id,
                claim["evidence_id"],
                claim["claim_id"],
            ):
                queued_targets.add(target_id)
                refs[target_id] = tref
            else:
                excluded.append(
                    {
                        "entity_type": "role_claim",
                        "entity_id": claim["claim_id"],
                        "reason": "changeset_limit",
                    }
                )
                continue
        s_link = _linked(db, site_key, "source", source_id)
        if s_link is not None and s_link["link_state"] != "active":
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "source_mapping_requires_recovery_review",
                }
            )
            continue
        if s_link is None and source_id not in queued_sources:
            sref = _ref("source", source_id)
            if add(
                {
                    "op": "register_source",
                    "entity": "role_sources",
                    "clientRef": sref,
                    "fields": {
                        "url": citation["url"],
                        "title": citation["title"],
                        "publisher_classification": citation["publisher_classification"],
                        "source_type": citation["source_type"],
                    },
                },
                "source",
                source_id,
                claim["evidence_id"],
                claim["claim_id"],
            ):
                queued_sources.add(source_id)
                refs[source_id] = sref
            else:
                excluded.append(
                    {
                        "entity_type": "role_claim",
                        "entity_id": claim["claim_id"],
                        "reason": "changeset_limit",
                    }
                )
                continue

        fields = {"source_checked_at": citation["source_checked_at"]}
        for name, value in (
            ("start_date", claim["employment_start"]),
            ("end_date", claim["employment_end"]),
        ):
            if value:
                fields[name] = value

        def reference(local_type, local_id, link, ref):
            return (
                {
                    (
                        "person_ref"
                        if local_type == "research_person"
                        else (
                            "position_ref"
                            if local_type == "role_target"
                            else "source_ref"
                        )
                    ): ref
                }
                if link is None
                else {
                    (
                        "person_id"
                        if local_type == "research_person"
                        else (
                            "position_id"
                            if local_type == "role_target"
                            else "source_id"
                        )
                    ): link["website_id"]
                }
            )

        p_link, t_link, s_link = (
            _linked(db, site_key, "research_person", person_id),
            _linked(db, site_key, "role_target", target_id),
            _linked(db, site_key, "source", source_id),
        )
        if p_link is not None and p_link["link_state"] != "active":
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "person_mapping_requires_recovery_review",
                }
            )
            continue
        for ref_fields in (
            reference("research_person", person_id, p_link, refs.get(person_id)),
            reference("role_target", target_id, t_link, refs.get(target_id)),
            reference("source", source_id, s_link, refs.get(source_id)),
        ):
            fields.update(ref_fields)
        rref = _ref("role_claim", claim["claim_id"])
        if not add(
            {
                "op": "create_person_role",
                "entity": "person_roles",
                "clientRef": rref,
                "fields": fields,
            },
            "role_claim",
            claim["claim_id"],
            claim["evidence_id"],
            claim["claim_id"],
        ):
            excluded.append(
                {
                    "entity_type": "role_claim",
                    "entity_id": claim["claim_id"],
                    "reason": "changeset_limit",
                }
            )

    # Emit explicitly approved updates against the exact Website version
    # observed when approval was recorded. Update fields are contract allowlists.
    allowed = {
        "org_unit": (
            "organizations",
            {
                "name",
                "organization_type",
                "county_fips",
                "parent_organization_id",
                "parent_relationship",
            },
        ),
        "research_person": ("people", {"display_name"}),
        "role_target": ("positions", {"title"}),
        "source": ("role_sources", {"title"}),
        "role_claim": ("person_roles", {"start_date", "end_date", "source_checked_at"}),
    }
    scoped_ids = None
    if county_fips is not None:
        scoped_ids = {
            "org_unit": scoped_unit_ids or set(),
            "research_person": {row["person_id"] for row in selected_candidates if row["person_id"]},
            "role_target": {row["target_id"] for row in selected_candidates if row["target_id"]},
            "source": {row["source_id"] for row in selected_candidates if row["source_id"]},
            "role_claim": {row["id"] for row in selected_candidates},
        }
    for approval in db.execute(
        "SELECT * FROM site_sync_update_approvals WHERE site_key=? AND state='approved' ORDER BY id",
        (site_key,),
    ):
        if scoped_ids is not None and approval["local_entity_type"] in scoped_ids and \
                approval["local_entity_id"] not in scoped_ids[approval["local_entity_type"]]:
            continue
        info = allowed.get(approval["local_entity_type"])
        link = _linked(
            db, site_key, approval["local_entity_type"], approval["local_entity_id"]
        )
        fields = json.loads(approval["fields_json"])
        if (
            info is None
            or link is None
            or link["website_entity"] != info[0]
            or approval["expected_version"] != link["website_version"]
        ):
            excluded.append(
                {
                    "entity_type": approval["local_entity_type"],
                    "entity_id": approval["local_entity_id"],
                    "reason": "approved_update_mapping_or_version_conflict",
                }
            )
            continue
        if (
            not isinstance(fields, dict)
            or not fields
            or set(fields) - info[1]
            or any(not isinstance(v, (str, type(None))) for v in fields.values())
        ):
            excluded.append(
                {
                    "entity_type": approval["local_entity_type"],
                    "entity_id": approval["local_entity_id"],
                    "reason": "approved_update_fields_invalid",
                }
            )
            continue
        idx = len(changes)
        change = {
            "op": "update_record",
            "entity": info[0],
            "targetId": link["website_id"],
            "expectedVersion": approval["expected_version"],
            "fields": fields,
        }
        if add(
            change,
            approval["local_entity_type"],
            approval["local_entity_id"],
            approval["evidence_id"],
        ):
            item_meta[-1]["approval_id"] = approval["id"]
            item_meta[-1]["client_ref"] = f"item-{idx}"
        else:
            excluded.append(
                {
                    "entity_type": approval["local_entity_type"],
                    "entity_id": approval["local_entity_id"],
                    "reason": "changeset_limit",
                }
            )
    body = {
        "contractVersion": "m2-sync/v1",
        "requestId": request_id or "00000000-0000-5000-8000-000000000000",
        "intent": "commit",
        "changes": changes,
    }
    if request_id is None:
        body["requestId"] = str(uuid5(NAMESPACE_URL, canonical_json(body["changes"])))
    planned_by_entity = Counter(change["entity"] for change in changes)
    planned_role_claims = {item["local_entity_id"] for item in item_meta
                           if item["website_entity"] == "person_roles" and item["local_entity_id"]}
    candidate_person_by_claim = {row["id"]: row["person_id"] for row in selected_candidates}
    excluded_claims_by_reason = defaultdict(set)
    for item in excluded:
        if item.get("entity_type") == "role_claim" and item.get("entity_id"):
            excluded_claims_by_reason[item["reason"]].add(item["entity_id"])
    excluded_claim_ids = set().union(*excluded_claims_by_reason.values()) if excluded_claims_by_reason else set()
    already_mapped_claims = sum(
        (_linked(db, site_key, "role_claim", row["id"]) is not None and
         _linked(db, site_key, "role_claim", row["id"])["link_state"] == "active")
        for row in selected_candidates
    )
    exclusion_counts = Counter(item["reason"] for item in excluded)
    role_exclusions = {reason: len(ids) for reason, ids in sorted(excluded_claims_by_reason.items())}
    return {
        "request": body,
        "items": item_meta,
        "eligible_count": len(changes),
        "excluded": excluded,
        "truncated": any(x["reason"] == "changeset_limit" for x in excluded),
        "county_fips": county_fips,
        "planned_operations_by_entity": dict(sorted(planned_by_entity.items())),
        "exclusion_counts_by_reason": dict(sorted(exclusion_counts.items())),
        "eligibility_summary": {
            "role_claims_in_scope": len(candidate_rows),
            "role_claims_skipped_by_batch_selection": skipped_batch_claims,
            "role_claims_evaluated": len(selected_candidates),
            "role_claims_excluded": len(excluded_claim_ids),
            "role_claims_excluded_by_reason": role_exclusions,
            "role_claims_already_mapped": already_mapped_claims,
            "role_claims_planned": len(planned_role_claims),
            "distinct_people_in_scope": len(candidate_people_all),
            "distinct_people_in_selected_batches": len(candidate_people),
            "distinct_people_with_planned_roles": len({candidate_person_by_claim.get(claim_id)
                                                         for claim_id in planned_role_claims
                                                         if candidate_person_by_claim.get(claim_id)}),
        },
    }


def prepare_research_submission(db, site_key, idempotency_key, generated, *, now=None):
    """Persist the generated exact bytes through R6, plus local-only item lineage."""
    text = json.dumps(
        generated["request"], ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    prepared = prepare_submission(db, site_key, idempotency_key, text, now=now)
    sid = prepared["submission_id"]
    with db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT count(*) FROM sync_submission_items WHERE submission_id=?", (sid,)
        ).fetchone()[0]
        if not existing:
            for item in generated["items"]:
                db.execute(
                    "INSERT INTO sync_submission_items(submission_id,item_index,client_ref,website_entity,local_entity_type,local_entity_id,evidence_id,claim_id,approval_id,request_item_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        sid,
                        item["item_index"],
                        item["client_ref"],
                        item["website_entity"],
                        item["local_entity_type"],
                        item["local_entity_id"],
                        item["evidence_id"],
                        item["claim_id"],
                        item.get("approval_id"),
                        item["request_item_json"],
                    ),
                )
        else:
            saved = list(
                db.execute(
                    "SELECT item_index,client_ref,request_item_json FROM sync_submission_items WHERE submission_id=? ORDER BY item_index",
                    (sid,),
                )
            )
            expected = [
                (x["item_index"], x["client_ref"], x["request_item_json"])
                for x in generated["items"]
            ]
            if [(x[0], x[1], x[2]) for x in saved] != expected:
                raise ValueError(
                    "Prepared request has different local research lineage"
                )
    return prepared


def approve_site_update(
    db,
    site_key,
    local_entity_type,
    local_entity_id,
    fields,
    expected_version,
    evidence_id,
    *,
    approval_id=None,
    now=None,
):
    """Persist a narrow owner-reviewed update against a known Website mapping."""
    allowed = {
        "org_unit": {
            "name",
            "organization_type",
            "county_fips",
            "parent_organization_id",
            "parent_relationship",
        },
        "research_person": {"display_name"},
        "role_target": {"title"},
        "source": {"title"},
        "role_claim": {"start_date", "end_date", "source_checked_at"},
    }
    if (
        local_entity_type not in allowed
        or not isinstance(fields, dict)
        or not fields
        or set(fields) - allowed[local_entity_type]
    ):
        raise ValueError("Update fields are outside the supported Website allowlist")
    if any(
        value is not None and not isinstance(value, str) for value in fields.values()
    ):
        raise ValueError("Approved update field values must be explicit text or null")
    link = _linked(db, site_key, local_entity_type, local_entity_id)
    if (
        link is None
        or link["link_state"] != "active"
        or link["website_version"] != expected_version
    ):
        raise ValueError("Update approval must pin the current mapped Website version")
    if (
        db.execute("SELECT 1 FROM evidence_links WHERE id=?", (evidence_id,)).fetchone()
        is None
    ):
        raise ValueError("Update approval requires retained research evidence")
    approval_id = (
        approval_id
        or f"approval_{uuid5(NAMESPACE_URL,site_key+'|'+local_entity_type+'|'+local_entity_id+'|'+str(expected_version)+'|'+canonical_json(fields))}"
    )
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO site_sync_update_approvals(id,site_key,local_entity_type,local_entity_id,fields_json,expected_version,evidence_id,state,approved_at) VALUES(?,?,?,?,?,?,?,'approved',?)",
            (
                approval_id,
                site_key,
                local_entity_type,
                local_entity_id,
                canonical_json(fields),
                expected_version,
                evidence_id,
                now or timestamp(),
            ),
        )
    return approval_id


def reconcile_submission(db, submission_id, *, now=None):
    """Apply only a stored R6 committed receipt; timeouts and rejections map no IDs."""
    stamp = now or timestamp()
    sub = db.execute(
        "SELECT state,response_status,response_json,remote_batch_id FROM sync_submissions WHERE id=?",
        (submission_id,),
    ).fetchone()
    if sub is None:
        raise ValueError("Unknown prepared submission")
    if sub["state"] == "pending":
        raise ValueError(
            "Submission outcome is uncertain; retry the exact prepared request first"
        )
    if sub["response_json"] is None:
        raise ValueError("Submission has no authoritative stored response")
    receipt = json.loads(sub["response_json"])
    prior = db.execute(
        "SELECT state,website_batch_id,receipt_json FROM sync_submission_receipts WHERE submission_id=?",
        (submission_id,),
    ).fetchone()
    encoded = canonical_json(receipt)
    if prior:
        if (
            prior["receipt_json"] != encoded
            or prior["website_batch_id"] != sub["remote_batch_id"]
        ):
            raise ValueError(
                "Repeated receipt conflicts with the durable reconciliation"
            )
        return {
            "state": prior["state"],
            "replayed": True,
            "batch_id": prior["website_batch_id"],
        }
    if sub["state"] == "rejected":
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO sync_submission_receipts VALUES(?,?,?,?,?)",
                (submission_id, "rejected", None, encoded, stamp),
            )
            for item in db.execute(
                "SELECT * FROM sync_submission_items WHERE submission_id=? ORDER BY item_index",
                (submission_id,),
            ):
                db.execute(
                    "INSERT INTO sync_item_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        submission_id,
                        item["item_index"],
                        item["client_ref"],
                        item["website_entity"],
                        item["local_entity_type"],
                        item["local_entity_id"],
                        None,
                        None,
                        None,
                        "rejected",
                        encoded,
                    ),
                )
                if item["approval_id"]:
                    db.execute(
                        "UPDATE site_sync_update_approvals SET state='rejected' WHERE id=? AND state='approved'",
                        (item["approval_id"],),
                    )
        return {"state": "rejected", "replayed": False, "batch_id": None}
    if (
        not isinstance(receipt, dict)
        or receipt.get("status") != "committed"
        or receipt.get("batchId") != sub["remote_batch_id"]
        or not isinstance(receipt.get("items"), list)
    ):
        raise ValueError("Stored response is not an authoritative committed receipt")
    expected = list(
        db.execute(
            "SELECT * FROM sync_submission_items WHERE submission_id=? ORDER BY item_index",
            (submission_id,),
        )
    )
    by_index = {
        item["itemIndex"]: item
        for item in receipt["items"]
        if isinstance(item, dict) and type(item.get("itemIndex")) is int
    }
    if len(by_index) != len(receipt["items"]) or set(by_index) != set(
        range(len(expected))
    ):
        raise ValueError(
            "Committed receipt does not exactly match prepared item references"
        )
    validated = []
    for meta in expected:
        item = by_index[meta["item_index"]]
        request_item = json.loads(meta["request_item_json"])
        if (
            isinstance(request_item.get("clientRef"), str)
            and item.get("clientRef") != request_item["clientRef"]
        ):
            raise ValueError(
                "Committed receipt client reference does not match the prepared item"
            )
        if (
            item.get("clientRef") is not None
            and item.get("clientRef") != meta["client_ref"]
        ):
            raise ValueError(
                "Committed receipt client reference conflicts with prepared request"
            )
        if (
            item.get("entity") != meta["website_entity"]
            or not isinstance(item.get("websiteId"), str)
            or not item["websiteId"].strip()
            or type(item.get("version")) is not int
            or item["version"] < 1
            or item.get("outcome") not in ("created", "updated", "reused")
        ):
            raise ValueError(
                "Committed item receipt is malformed or has a conflicting entity"
            )
        validated.append((meta, item))
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO sync_submission_receipts VALUES(?,?,?,?,?)",
            (submission_id, "committed", sub["remote_batch_id"], encoded, stamp),
        )
        for meta, item in validated:
            db.execute(
                "INSERT INTO sync_item_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    submission_id,
                    meta["item_index"],
                    meta["client_ref"],
                    meta["website_entity"],
                    meta["local_entity_type"],
                    meta["local_entity_id"],
                    item["websiteId"],
                    item["version"],
                    item["outcome"],
                    "committed",
                    canonical_json(item),
                ),
            )
            if meta["local_entity_type"]:
                old = _linked(
                    db,
                    db.execute(
                        "SELECT site_key FROM sync_submissions WHERE id=?",
                        (submission_id,),
                    ).fetchone()[0],
                    meta["local_entity_type"],
                    meta["local_entity_id"],
                )
                site = db.execute(
                    "SELECT site_key FROM sync_submissions WHERE id=?", (submission_id,)
                ).fetchone()[0]
                if old and (
                    old["website_entity"] != meta["website_entity"]
                    or old["website_id"] != item["websiteId"]
                ):
                    raise ValueError(
                        "Local research identity is already mapped to a different Website entity"
                    )
                if old and item["version"] < old["website_version"]:
                    raise ValueError(
                        "Receipt is older than the accepted Website row version"
                    )
                if old:
                    db.execute(
                        "UPDATE site_entity_links SET website_version=?,last_outcome=?,last_batch_id=?,updated_at=? WHERE site_key=? AND local_entity_type=? AND local_entity_id=?",
                        (
                            item["version"],
                            item["outcome"],
                            sub["remote_batch_id"],
                            stamp,
                            site,
                            meta["local_entity_type"],
                            meta["local_entity_id"],
                        ),
                    )
                    link_id = db.execute(
                        "SELECT id FROM site_entity_links WHERE site_key=? AND local_entity_type=? AND local_entity_id=?",
                        (site, meta["local_entity_type"], meta["local_entity_id"]),
                    ).fetchone()[0]
                else:
                    link_id = f"link_{uuid5(NAMESPACE_URL,site+'|'+meta['local_entity_type']+'|'+meta['local_entity_id'])}"
                    db.execute(
                        "INSERT INTO site_entity_links VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            link_id,
                            site,
                            meta["local_entity_type"],
                            meta["local_entity_id"],
                            meta["website_entity"],
                            item["websiteId"],
                            item["version"],
                            item["outcome"],
                            sub["remote_batch_id"],
                            "active",
                            stamp,
                        ),
                    )
                if meta["evidence_id"]:
                    db.execute(
                        "INSERT OR IGNORE INTO site_entity_lineage(link_id,evidence_id,claim_id) VALUES(?,?,?)",
                        (link_id, meta["evidence_id"], meta["claim_id"]),
                    )
                if meta["approval_id"]:
                    updated = db.execute(
                        "UPDATE site_sync_update_approvals SET state='consumed',consumed_submission_id=? WHERE id=? AND state='approved' AND expected_version=?",
                        (
                            submission_id,
                            meta["approval_id"],
                            db.execute(
                                "SELECT expected_version FROM site_sync_update_approvals WHERE id=?",
                                (meta["approval_id"],),
                            ).fetchone()[0],
                        ),
                    )
                    if updated.rowcount != 1:
                        raise ValueError(
                            "Approved update changed during receipt reconciliation"
                        )
    return {
        "state": "committed",
        "replayed": False,
        "batch_id": sub["remote_batch_id"],
        "mapped": len(validated),
    }


def reconcile_reversal(db, site_key, website_batch_id, receipt, *, now=None):
    """Record an authoritative Website reversal without deleting or guessing IDs.

    Created mappings become tombstones; updated mappings require a fresh Website
    read before another version-pinned update. Reused mappings remain active.
    """
    if (
        not isinstance(receipt, dict)
        or receipt.get("batchId") != website_batch_id
        or receipt.get("status")
        not in ("reverted", "already_reverted", "reversal_blocked")
    ):
        raise ValueError("A matching authoritative Website reversal result is required")
    if receipt["status"] == "reverted" and (
        not isinstance(receipt.get("reversalId"), str)
        or not receipt["reversalId"].strip()
        or not isinstance(receipt.get("reversedAt"), str)
    ):
        raise ValueError(
            "A successful reversal requires its Website reversal ID and timestamp"
        )
    if receipt["status"] == "already_reverted" and not isinstance(
        receipt.get("reversedAt"), str
    ):
        raise ValueError("An already-reverted result requires its Website timestamp")
    encoded = canonical_json(receipt)
    receipt_sha = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    old = db.execute(
        "SELECT state,receipt_json FROM sync_reversal_receipts WHERE site_key=? AND website_batch_id=? AND receipt_sha256=?",
        (site_key, website_batch_id, receipt_sha),
    ).fetchone()
    if old:
        if old["receipt_json"] != encoded:
            raise ValueError(
                "Repeated reversal receipt conflicts with the durable result"
            )
        return {"state": old["state"], "replayed": True}
    state = receipt["status"]
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO sync_reversal_receipts VALUES(?,?,?,?,?,?,?)",
            (
                f"reversal_{uuid5(NAMESPACE_URL,site_key+'|'+website_batch_id+'|'+receipt_sha)}",
                site_key,
                website_batch_id,
                receipt_sha,
                state,
                encoded,
                now or timestamp(),
            ),
        )
        if state in ("reverted", "already_reverted"):
            rows = list(
                db.execute(
                    "SELECT l.id,r.outcome FROM site_entity_links l JOIN sync_item_receipts r "
                    "ON r.website_id=l.website_id JOIN sync_submission_receipts sr ON sr.submission_id=r.submission_id "
                    "WHERE sr.website_batch_id=? AND l.site_key=? AND l.last_batch_id=? AND r.status='committed'",
                    (website_batch_id, site_key, website_batch_id),
                )
            )
            # Item receipts are the local record of the exact commit outcome.
            for row in rows:
                link_state = (
                    "reverted"
                    if row["outcome"] == "created"
                    else "needs_refresh" if row["outcome"] == "updated" else "active"
                )
                db.execute(
                    "UPDATE site_entity_links SET link_state=?,updated_at=? WHERE id=?",
                    (link_state, now or timestamp(), row["id"]),
                )
    return {"state": state, "replayed": False}

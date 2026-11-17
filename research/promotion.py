"""Reviewed, local-only, county-batch promotion into confirmed Profiles."""

import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid5, NAMESPACE_URL

from research.db import validate_migration_history
from research.evidence_dates import source_found_on
from research.mapping import canonical_json

PLAN_FORMAT = "colorado-watchdog/profile-promotion/v1"
_TOP = {"format", "county_code", "batch_id", "manifest_sha256", "reviewed_by", "reviewed_on", "profiles"}
_PROFILE = {"research_profile_id", "full_name", "reviewer_notes", "roles"}
_ROLE = {"role_claim_ids", "office_or_department", "position_title", "duties",
         "employment_start_date", "employment_end_date", "citations"}
_CITATION = {"claim_id", "verified_on"}
_COUNTY_IN_TITLE = re.compile(r"\bcounty\b(?:['’]s\b|\s*[-–—]\s*)?", re.IGNORECASE)
_TITLE_CONJUNCTION = re.compile(r"\s*(?:&|\band\b)\s*")


def _id(prefix, *parts):
    return f"{prefix}_{uuid5(NAMESPACE_URL, canonical_json(list(parts)))}"


def _text(value, name, *, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f"{name} must be nonblank text without surrounding whitespace")
    return value


def _date(value, name):
    _text(value, name)
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError
    except ValueError as error:
        raise ValueError(f"{name} must use YYYY-MM-DD") from error


def _fingerprint(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def read_plan(path, *, repository_root=None):
    path = Path(path).resolve()
    if repository_root is not None and (path == repository_root or repository_root in path.parents):
        raise ValueError("Private promotion plan must be outside the source checkout")
    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Promotion plan must be an existing JSON file no larger than 2 MiB")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Promotion plan contains duplicate JSON keys")
            result[key] = value
        return result

    plan = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(plan, dict):
        raise ValueError("Promotion plan must be a JSON object")
    return plan


def _normalize(plan):
    if not isinstance(plan, dict) or set(plan) != _TOP or plan.get("format") != PLAN_FORMAT:
        raise ValueError("Promotion plan has an unsupported format or fields")
    county = _text(plan["county_code"], "county_code")
    if not re.fullmatch(r"08[0-9]{3}", county):
        raise ValueError("county_code must be a canonical five-digit Colorado FIPS code")
    batch_id = _text(plan["batch_id"], "batch_id")
    manifest_hash = _text(plan["manifest_sha256"], "manifest_sha256")
    if not re.fullmatch(r"[0-9a-f]{64}", manifest_hash):
        raise ValueError("manifest_sha256 must be lowercase hexadecimal")
    reviewer = _text(plan["reviewed_by"], "reviewed_by")
    _date(plan["reviewed_on"], "reviewed_on")
    profiles = plan["profiles"]
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("At least one reviewed Profile is required")
    seen_people, seen_claims = set(), set()
    normalized_profiles = []
    for person in profiles:
        if not isinstance(person, dict) or set(person) != _PROFILE:
            raise ValueError("Each Profile must contain exactly the documented fields")
        research_id = _text(person["research_profile_id"], "research_profile_id")
        full_name = _text(person["full_name"], "full_name")
        notes = _text(person["reviewer_notes"], "reviewer_notes", optional=True)
        if research_id in seen_people:
            raise ValueError("A research identity cannot appear twice in one batch plan")
        seen_people.add(research_id)
        roles = person["roles"]
        if not isinstance(roles, list) or not roles:
            raise ValueError("Each Profile requires at least one exact reviewed role grouping")
        normalized_roles = []
        for role in roles:
            if not isinstance(role, dict) or set(role) != _ROLE:
                raise ValueError("Each role must contain exactly the documented fields and citation links")
            claim_ids = role["role_claim_ids"]
            if not isinstance(claim_ids, list) or not claim_ids:
                raise ValueError("Each role grouping must name exact research claim IDs")
            if any(not isinstance(claim, str) or not claim.strip() or claim != claim.strip()
                   for claim in claim_ids):
                raise ValueError("role_claim_ids must be nonblank exact IDs")
            if len(set(claim_ids)) != len(claim_ids) or seen_claims.intersection(claim_ids):
                raise ValueError("A research claim may be assigned to only one role")
            seen_claims.update(claim_ids)
            office = _text(role["office_or_department"], "office_or_department", optional=True)
            title = _text(role["position_title"], "position_title", optional=True)
            duties = _text(role["duties"], "duties", optional=True)
            if not any((office, title, duties)):
                raise ValueError("A role needs a documented office, title, or job description")
            start = _text(role["employment_start_date"], "employment_start_date", optional=True)
            end = _text(role["employment_end_date"], "employment_end_date", optional=True)
            for label, value in (("employment_start_date", start), ("employment_end_date", end)):
                if value is not None:
                    _date(value, label)
            if start and end and end < start:
                raise ValueError("employment_end_date cannot precede employment_start_date")
            citations = role["citations"]
            if not isinstance(citations, list) or any(
                    not isinstance(citation, dict) or set(citation) != _CITATION for citation in citations):
                raise ValueError("Every selected claim requires an explicit citation entry")
            citation_map = {}
            for citation in citations:
                claim = _text(citation["claim_id"], "citation claim_id")
                if citation["verified_on"] is not None:
                    _date(citation["verified_on"], "citation verified_on")
                if claim in citation_map:
                    raise ValueError("Duplicate citation claim IDs are not allowed")
                citation_map[claim] = citation["verified_on"]
            if set(citation_map) != set(claim_ids):
                raise ValueError("Citation entries must cover exactly the selected role claims")
            normalized_roles.append({
                "role_claim_ids": sorted(claim_ids), "office_or_department": office,
                "position_title": title, "duties": duties,
                "employment_start_date": start, "employment_end_date": end,
                "citations": [{"claim_id": claim, "verified_on": citation_map[claim]}
                              for claim in sorted(citation_map)],
            })
        normalized_profiles.append({"research_profile_id": research_id, "full_name": full_name,
                                    "reviewer_notes": notes, "roles": normalized_roles})
    return {"format": PLAN_FORMAT, "county_code": county, "batch_id": batch_id,
            "manifest_sha256": manifest_hash,
            "reviewed_by": reviewer, "reviewed_on": plan["reviewed_on"],
            "profiles": normalized_profiles}


def _claim_snapshot(db, claim_id, county, batch_id, research_profile_id, full_name):
    row = db.execute(
        'SELECT c."Role claim ID" AS claim_id,c."County code" AS county,c."Evidence record ID" AS evidence_id,'
        'c."Linked profile" AS research_profile_id,c."Name as published" AS published_name,'
        'c."Position as published" AS title,c."Job description or duties" AS duties,'
        'c."Office or department as published" AS office,c."Employment start date" AS employment_start,'
        'c."Employment end date" AS employment_end,c."Listing status" AS listing_status,'
        'c."Earlier claim this replaces" AS replaces,e."Source ID" AS source_id,'
        'EXISTS(SELECT 1 FROM profile_research_role newer WHERE newer."Earlier claim this replaces"=c."Role claim ID") AS is_superseded,'
        'e."Source title as observed" AS source_title,e."Source URL as observed" AS observed_url,'
        'e."Source version ID" AS source_version_id,e."Evidence excerpt" AS evidence_excerpt,'
        'e."Reported check date" AS reported_check_date,s."First discovered on" AS first_discovered,'
        'e."Import batch ID" AS batch_id,e."Original record fingerprint" AS record_fingerprint,'
        'e."Original record" AS original_record,e."Where the record appeared" AS occurrence_locator,'
        's."Original source URL" AS source_url,s."Publisher type" AS publisher_type,'
        's."Document type" AS page_type '
        'FROM profile_research_role c JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" '
        'JOIN research_sources s ON s."Source ID"=e."Source ID" WHERE c."Role claim ID"=?', (claim_id,)
    ).fetchone()
    if row is None or row["county"] != county or row["batch_id"] != batch_id:
        raise ValueError("Every selected claim must belong to the exact reviewed county and batch")
    if row["research_profile_id"] != research_profile_id:
        raise ValueError("Every selected claim must already link to its evidence-supported research identity")
    if row["is_superseded"]:
        raise ValueError("Superseded claims require separate review")
    if row["listing_status"] not in {"Listed", "Explicitly former"}:
        raise ValueError("Claims with unclear listing status require separate review")
    if not row["published_name"] or row["published_name"].strip().casefold() != full_name.strip().casefold():
        raise ValueError("Reviewed Profile name does not match the selected claim")
    return row


def _has_public_citation_metadata(row):
    """Retain role evidence even when its public citation metadata is incomplete."""
    if row["publisher_type"] not in {"official", "unofficial"} or row["page_type"] not in {
            "official_page", "public_document", "other_public"}:
        return False
    if not row["source_title"] or row["observed_url"] != row["source_url"]:
        return False
    try:
        parsed = urlsplit(row["observed_url"])
        valid_url = (parsed.scheme.lower() in {"http", "https"} and parsed.hostname
                     and parsed.username is None and parsed.password is None
                     and len(row["observed_url"].encode("utf-8")) <= 2048)
    except (ValueError, UnicodeError):
        valid_url = False
    return bool(valid_url and len(row["source_title"].encode("utf-8")) <= 500)


def _display_position_title(title):
    if title is None or not _COUNTY_IN_TITLE.search(title):
        return title
    return " ".join(_COUNTY_IN_TITLE.sub("", title).split()).strip(" ,–—-") or None


def _title_matches(title, observed):
    if title == observed:
        return True
    reviewed = _display_position_title(title)
    source = _display_position_title(observed)
    if reviewed is None or source is None:
        return False
    return (_TITLE_CONJUNCTION.sub(" and ", reviewed.casefold())
            == _TITLE_CONJUNCTION.sub(" and ", source.casefold()))


def _bind_fields(role, rows):
    title = role["position_title"]
    if title is not None and not any(_title_matches(title, row["title"]) for row in rows):
        raise ValueError("Reviewed position_title must match a selected research observation")
    for field, source_field in (("office_or_department", "office"),
                                ("duties", "duties"),
                                ("employment_start_date", "employment_start"),
                                ("employment_end_date", "employment_end")):
        value = role[field]
        if value is not None and not any(row[source_field] == value for row in rows):
            raise ValueError(f"Reviewed {field} must exactly match a selected research observation")
    for row in rows:
        title_supported = title is not None and _title_matches(title, row["title"])
        details_supported = any(
                role[field] is not None and role[field] == row[source_field]
                for field, source_field in (("office_or_department", "office"), ("duties", "duties")))
        if not (title_supported or details_supported):
            raise ValueError("Each selected claim must support at least one promoted role field")


def build_preview(db, plan):
    """Read-only preview bound to the selected source, identity, claims and evidence state."""
    checked = _normalize(plan)
    history = validate_migration_history(db)
    if history["schema_version"] < 7:
        raise ValueError("Profile promotion requires accepted schema version 7 or later")
    county_row = db.execute('SELECT "County name" AS name FROM county WHERE "County code"=?',
                            (checked["county_code"],)).fetchone()
    if county_row is None:
        raise ValueError("Required county is absent from the canonical county registry")
    batch = db.execute("SELECT id,county_fips,family_id,parent_batch_id,lineage_kind,selected,file_sha256,mapping_version "
                       "FROM research_scrapes WHERE id=?", (checked["batch_id"],)).fetchone()
    if batch is None or batch["county_fips"] != checked["county_code"]:
        raise ValueError("Reviewed intake batch is missing or belongs to another county")

    input_state = {"county_name": county_row["name"], "batch": dict(batch), "profiles": []}
    result_profiles = []
    seen_profile_ids = set()
    cleaned_titles = {}
    missing_cleaned_title = False
    for person in checked["profiles"]:
        research_id = person["research_profile_id"]
        identity = db.execute(
            'SELECT "Profile ID" AS id,"County code" AS county,"Full name" AS name,'
            '"Identity review status" AS status,"Evidence for identity" AS identity_evidence '
            'FROM profile_research WHERE "Profile ID"=? AND "County code"=?',
            (research_id, checked["county_code"]),
        ).fetchone()
        if identity is None or identity["status"] != "evidence_supported" or not identity["identity_evidence"]:
            raise ValueError("Research identity must be evidence_supported with linked identity evidence")
        if identity["name"].strip().casefold() != person["full_name"].strip().casefold():
            raise ValueError("Reviewed Profile name does not match the evidence-supported identity")
        identity_source = db.execute(
            'SELECT e."Evidence record ID" AS evidence_id,e."Source ID" AS source_id,'
            'e."Source title as observed" AS source_title,e."Source URL as observed" AS observed_url,'
            'e."Source version ID" AS source_version_id,e."Evidence excerpt" AS evidence_excerpt,'
            'e."Evidence location" AS evidence_location,e."Original record" AS original_record,'
            'e."Original record fingerprint" AS record_fingerprint,e."Where the record appeared" AS occurrence_locator,'
            's."Original source URL" AS source_url,s."Publisher type" AS publisher_type,'
            's."Document type" AS page_type FROM research_evidence e '
            'JOIN research_sources s ON s."Source ID"=e."Source ID" WHERE e."Evidence record ID"=?',
            (identity["identity_evidence"],),
        ).fetchone()
        if (identity_source is None or identity_source["publisher_type"] != "official"
                or identity_source["page_type"] not in {"official_page", "public_document", "other_public"}
                or not identity_source["source_title"] or identity_source["observed_url"] != identity_source["source_url"]):
            raise ValueError("Research identity requires linked evidence from an existing official public source")
        try:
            identity_url = urlsplit(identity_source["observed_url"])
            identity_url_ok = (identity_url.scheme.lower() in {"http", "https"} and identity_url.hostname
                               and identity_url.username is None and identity_url.password is None
                               and len(identity_source["observed_url"].encode("utf-8")) <= 2048)
        except (ValueError, UnicodeError):
            identity_url_ok = False
        if not identity_url_ok or len(identity_source["source_title"].encode("utf-8")) > 500:
            raise ValueError("Research identity evidence has an invalid public URL or title")
        profile_id = _id("profile", checked["county_code"], research_id)
        if profile_id in seen_profile_ids:
            raise ValueError("Duplicate stable Profile IDs in promotion batch")
        seen_profile_ids.add(profile_id)
        claim_rows = {}
        claim_snapshots = {}
        roles = []
        evidence_dates = {}
        for role in person["roles"]:
            rows = []
            date_map = {item["claim_id"]: item["verified_on"] for item in role["citations"]}
            for claim_id in role["role_claim_ids"]:
                row = _claim_snapshot(db, claim_id, checked["county_code"], checked["batch_id"],
                                      research_id, person["full_name"])
                rows.append(row)
                claim_rows[claim_id] = row
                claim_snapshot = dict(row)
                if date_map[claim_id] is not None:
                    # Explicit-date v1 plans retain their original replay fingerprint.
                    claim_snapshot.pop("first_discovered")
                    claim_snapshot.pop("reported_check_date")
                claim_snapshots[claim_id] = claim_snapshot
                verified_on = date_map[claim_id] or source_found_on(
                    row["first_discovered"], row["reported_check_date"])
                if verified_on is not None:
                    prior_date = evidence_dates.setdefault(row["evidence_id"], verified_on)
                    if prior_date != verified_on:
                        raise ValueError("Claims sharing an evidence record must use one verification date")
            _bind_fields(role, rows)
            role_id = _id("role", profile_id, *role["role_claim_ids"])
            display_title = _display_position_title(role["position_title"])
            if display_title != role["position_title"]:
                cleaned_titles[role_id] = display_title
                missing_cleaned_title |= not any((display_title, role["office_or_department"], role["duties"]))
            roles.append({"id": role_id, "grouping": role, "rows": rows})
        if not roles:
            raise ValueError("Profile has no eligible reviewed roles")
        evidence_items = []
        for evidence_id in sorted({row["evidence_id"] for row in claim_rows.values()}):
            row = next(value for value in claim_rows.values() if value["evidence_id"] == evidence_id)
            evidence_items.append({
                "id": _id("profile_evidence", profile_id, evidence_id),
                "evidence_id": evidence_id, "source_id": row["source_id"],
                "source_url": row["source_url"], "source_title": row["source_title"],
                "publisher_type": row["publisher_type"], "page_type": row["page_type"],
                "verified_on": evidence_dates.get(evidence_id) if _has_public_citation_metadata(row) else None,
                "claim_ids": sorted(claim for claim, c_row in claim_rows.items()
                                     if c_row["evidence_id"] == evidence_id),
            })
        prior = list(db.execute(
            'SELECT DISTINCT "Profile ID" AS profile_id FROM profile_evidence '
            'WHERE "Research profile ID"=? AND "County code"=?',
            (research_id, checked["county_code"]),
        ))
        if any(row["profile_id"] != profile_id for row in prior):
            raise ValueError("Research identity is already linked to a different confirmed Profile ID")
        input_state["profiles"].append({
            "identity": dict(identity), "identity_evidence": dict(identity_source),
            "claims": [claim_snapshots[key] for key in sorted(claim_snapshots)],
            "selected_fields": [{"role": role["grouping"], "claim_ids": role["grouping"]["role_claim_ids"]}
                                for role in roles],
        })
        result_profiles.append({"id": profile_id, "person": person, "roles": roles,
                                "evidence": evidence_items})

    scope = {"plan": checked, "source_state": input_state}
    scope_hash = _fingerprint(scope)
    if cleaned_titles:
        # Existing receipts pin the exact older output. New previews pin their cleaned titles.
        promotion_batch_id = _id("promotion_batch", checked["county_code"], checked["batch_id"],
                                 checked["manifest_sha256"])
        prior_audit = db.execute(
            "SELECT detail_json FROM research_history WHERE entity_type=? AND entity_id=? AND kind=?",
            ("profile_promotion_batch", promotion_batch_id, "profiles_promoted"),
        ).fetchone()
        if prior_audit and json.loads(prior_audit["detail_json"]).get("plan_sha256") == scope_hash:
            cleaned_titles = {}
        else:
            if missing_cleaned_title:
                raise ValueError("Role needs a documented title, office or duties after omitting County")
            scope_hash = _fingerprint({**scope, "confirmed_position_titles": cleaned_titles})
    return {"status": "previewed", "county_code": checked["county_code"],
            "county_name": county_row["name"], "batch_id": checked["batch_id"],
            "manifest_sha256": checked["manifest_sha256"], "plan_sha256": scope_hash,
            "profile_count": len(result_profiles),
            "role_count": sum(len(item["roles"]) for item in result_profiles),
            "role_claim_count": sum(len(role["rows"]) for item in result_profiles for role in item["roles"]),
            "evidence_count": sum(len(item["evidence"]) for item in result_profiles),
            "batch_selected": bool(batch["selected"]),
            "scope": "local_confirmed_profiles_only", "website_sync": "not_requested",
            "_plan": checked, "_source_state": input_state, "_profiles": result_profiles,
            "_confirmed_position_titles": cleaned_titles}


def _expected_rows(preview, now):
    plan = preview["_plan"]
    rows = {"profile_county": [], "profile": [], "profile_evidence": [],
            "profile_evidence_citation": [], "profile_role": [], "profile_evidence_role": []}
    for profile in preview["_profiles"]:
        person, profile_id = profile["person"], profile["id"]
        rows["profile_county"].append((profile_id, plan["county_code"], now))
        rows["profile"].append((profile_id, person["full_name"], plan["reviewed_by"],
                                plan["reviewed_on"], person["reviewer_notes"], now))
        citations_by_evidence = {}
        for evidence in profile["evidence"]:
            citation_id = _id("citation", evidence["id"], evidence["source_id"], evidence["source_url"])
            rows["profile_evidence"].append((evidence["id"], profile_id, plan["county_code"],
                person["research_profile_id"], evidence["evidence_id"], person["reviewer_notes"], now))
            if evidence["verified_on"] is not None:
                citations_by_evidence[evidence["evidence_id"]] = citation_id
                rows["profile_evidence_citation"].append((citation_id, evidence["id"], evidence["source_id"],
                    evidence["source_url"], evidence["source_title"], evidence["publisher_type"],
                    evidence["page_type"], evidence["verified_on"]))
        for role in profile["roles"]:
            grouping = role["grouping"]
            title = preview["_confirmed_position_titles"].get(role["id"], grouping["position_title"])
            rows["profile_role"].append((role["id"], profile_id, plan["county_code"], None, None,
                grouping["office_or_department"], title, grouping["duties"],
                grouping["employment_start_date"], grouping["employment_end_date"], None, None))
            for claim in role["rows"]:
                citation_id = citations_by_evidence.get(claim["evidence_id"])
                evidence_id = _id("profile_evidence", profile_id, claim["evidence_id"])
                rows["profile_evidence_role"].append((role["id"], claim["claim_id"], evidence_id,
                    profile_id, plan["county_code"], citation_id))
    return rows


_TABLES = {
    "profile_county": 'SELECT "Profile ID","County code","Recorded on" FROM profile_county WHERE "Profile ID"=?',
    "profile": 'SELECT "Profile ID","Full name","Promotion reviewed by","Promotion reviewed on","Reviewer notes","Created on" FROM profile WHERE "Profile ID"=?',
    "profile_evidence": 'SELECT "Profile evidence ID","Profile ID","County code","Research profile ID","Evidence record ID","Reviewer notes","Recorded on" FROM profile_evidence WHERE "Profile evidence ID"=?',
    "profile_evidence_citation": 'SELECT "Citation ID","Profile evidence ID","Source ID","Public URL","Public title","Publisher type","Page type","Verified on" FROM profile_evidence_citation WHERE "Citation ID"=?',
    "profile_role": 'SELECT "Role ID","Profile ID","County code","County unit ID","Profile position ID","Office or department","Position title","Job description or duties","Employment start date","Employment end date","Affiliation","Affiliation evidence record ID" FROM profile_role WHERE "Role ID"=?',
    "profile_evidence_role": 'SELECT "Role ID","Role claim ID","Profile evidence ID","Profile ID","County code","Citation ID" FROM profile_evidence_role WHERE "Role ID"=? AND "Role claim ID"=?',
}


def _readback(db, preview, expected):
    for table, table_rows in expected.items():
        for values in table_rows:
            key = values[:2] if table == "profile_evidence_role" else values[:1]
            row = db.execute(_TABLES[table], key).fetchone()
            if row is None or tuple(row) != values:
                raise ValueError("Confirmed Profile rows differ from the exact reviewed plan")
    plan = preview["_plan"]
    profile_ids = [item["id"] for item in preview["_profiles"]]
    promotion_batch_id = _id("promotion_batch", plan["county_code"], plan["batch_id"], plan["manifest_sha256"])
    event_rows = list(db.execute(
        "SELECT id,run_id,detail_json FROM research_history WHERE entity_type=? AND entity_id=? AND kind=?",
        ("profile_promotion_batch", promotion_batch_id, "profiles_promoted")))
    if len(event_rows) != 1:
        raise ValueError("Promotion audit event is missing or duplicated")
    details = json.loads(event_rows[0]["detail_json"])
    if details.get("plan_sha256") != preview["plan_sha256"] or details.get("profile_ids") != profile_ids:
        raise ValueError("Promotion audit event does not match the exact reviewed batch")


def apply_reviewed_plan(db, plan, *, expected_sha256, after_write=None):
    """Revalidate, first-create, and audit an exact county batch atomically."""
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Expected plan SHA-256 must be lowercase hexadecimal")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before Profile promotion")
    try:
        db.execute("BEGIN IMMEDIATE")
        preview = build_preview(db, plan)
        if preview["plan_sha256"] != expected_sha256:
            raise ValueError("Reviewed plan is stale or does not match the exact source state")
        plan_data = preview["_plan"]
        promotion_batch_id = _id("promotion_batch", plan_data["county_code"], plan_data["batch_id"],
                                 plan_data["manifest_sha256"])
        existing = db.execute(
            "SELECT detail_json FROM research_history WHERE entity_type=? AND entity_id=? AND kind=?",
            ("profile_promotion_batch", promotion_batch_id, "profiles_promoted"),
        ).fetchall()
        expected = _expected_rows(preview, "")
        if existing:
            if len(existing) != 1 or json.loads(existing[0]["detail_json"]).get("plan_sha256") != expected_sha256:
                raise ValueError("This batch has a different prior promotion; edits are outside this operation")
            # Created/recorded timestamps are intentionally excluded from deterministic identity,
            # while every review and relationship field is compared to the plan.
            _readback_existing(db, preview, expected)
            db.rollback()
            return {"status": "replayed", "plan_sha256": expected_sha256,
                    "profile_count": preview["profile_count"], "role_count": preview["role_count"]}
        if any(db.execute('SELECT 1 FROM profile WHERE "Profile ID"=?', (item["id"],)).fetchone()
               for item in preview["_profiles"]):
            raise ValueError("A confirmed Profile exists without this batch audit record")
        for person in preview["_profiles"]:
            if db.execute('SELECT 1 FROM profile_evidence WHERE "Research profile ID"=? AND "County code"=?',
                          (person["person"]["research_profile_id"], plan_data["county_code"])).fetchone():
                raise ValueError("Research identity already has a confirmed Profile from another promotion")

        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        expected = _expected_rows(preview, now)
        db.executemany('INSERT INTO profile_county("Profile ID","County code","Recorded on") VALUES (?,?,?)',
                       expected["profile_county"])
        db.executemany('INSERT INTO profile("Profile ID","Full name","Promotion reviewed by","Promotion reviewed on","Reviewer notes","Created on") VALUES (?,?,?,?,?,?)',
                       expected["profile"])
        db.executemany('INSERT INTO profile_evidence("Profile evidence ID","Profile ID","County code","Research profile ID","Evidence record ID","Reviewer notes","Recorded on") VALUES (?,?,?,?,?,?,?)',
                       expected["profile_evidence"])
        db.executemany('INSERT INTO profile_evidence_citation("Citation ID","Profile evidence ID","Source ID","Public URL","Public title","Publisher type","Page type","Verified on") VALUES (?,?,?,?,?,?,?,?)',
                       expected["profile_evidence_citation"])
        db.executemany('INSERT INTO profile_role("Role ID","Profile ID","County code","County unit ID","Profile position ID","Office or department","Position title","Job description or duties","Employment start date","Employment end date","Affiliation","Affiliation evidence record ID") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                       expected["profile_role"])
        db.executemany('INSERT INTO profile_evidence_role("Role ID","Role claim ID","Profile evidence ID","Profile ID","County code","Citation ID") VALUES (?,?,?,?,?,?)',
                       expected["profile_evidence_role"])
        if after_write is not None:
            after_write(db)

        run_id = _id("run", promotion_batch_id, expected_sha256)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at,note) "
                   "VALUES (?,?,?,?,?,?,?,?)",
                   (run_id, "reconstruction", "observed", plan_data["reviewed_by"], now, now, now,
                    "Reviewed local Profile promotion"))
        detail = canonical_json({"plan_sha256": expected_sha256,
                                 "profile_ids": [person["id"] for person in preview["_profiles"]],
                                 "profile_count": preview["profile_count"],
                                 "role_count": preview["role_count"],
                                 "role_claim_count": preview["role_claim_count"],
                                 "evidence_count": preview["evidence_count"]})
        db.execute("INSERT INTO research_history(id,run_id,kind,entity_type,entity_id,occurred_at,recorded_at,provenance,detail_json) "
                   "VALUES (?,?,?,?,?,?,?,?,?)",
                   (_id("event", promotion_batch_id, expected_sha256), run_id,
                    "profiles_promoted", "profile_promotion_batch", promotion_batch_id,
                    now, now, "observed", detail))
        _readback(db, preview, expected)
        db.commit()
        return {"status": "applied", "plan_sha256": expected_sha256,
                "profile_count": preview["profile_count"], "role_count": preview["role_count"],
                "role_claim_count": preview["role_claim_count"], "evidence_count": preview["evidence_count"]}
    except Exception:
        db.rollback()
        raise


def _readback_existing(db, preview, expected):
    for table, rows in expected.items():
        for values in rows:
            if table == "profile_evidence_role":
                sql = _TABLES[table]
                key = values[:2]
            else:
                sql = _TABLES[table]
                key = values[:1]
            row = db.execute(sql, key).fetchone()
            if row is None:
                raise ValueError("Exact promotion replay is missing a confirmed row")
            actual = tuple(row)
            # Existing creation timestamps are retained and checked for consistency,
            # while deterministic fields are compared against plan values.
            if table in {"profile_county", "profile", "profile_evidence"}:
                actual = actual[:-1] + (values[-1],)
            if actual != values:
                raise ValueError("Exact promotion replay differs from the reviewed plan")
    plan = preview["_plan"]
    promotion_batch_id = _id("promotion_batch", plan["county_code"], plan["batch_id"],
                             plan["manifest_sha256"])
    audits = db.execute("SELECT detail_json FROM research_history WHERE entity_type=? AND entity_id=? AND kind=?",
                        ("profile_promotion_batch", promotion_batch_id, "profiles_promoted")).fetchall()
    if len(audits) != 1:
        raise ValueError("Promotion audit event is missing or duplicated")
    detail = json.loads(audits[0]["detail_json"])
    if detail.get("plan_sha256") != preview["plan_sha256"] or detail.get("profile_ids") != [p["id"] for p in preview["_profiles"]]:
        raise ValueError("Promotion audit readback differs from the exact plan")

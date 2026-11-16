"""Private county-scoped Profiles export with profile-level pagination."""

import json
from collections import Counter
from pathlib import Path

from research.identity_triage import _validate_private_path
from research.mapping import COUNTIES

MAX_PROFILE_EXPORT = 10_000
EXPORT_FORMAT = "colorado-watchdog/profiles-export/v1"


def _citation(db, evidence_id):
    row = db.execute(
        "SELECT s.id,s.original_url,s.publisher_classification,e.observed_title,e.locator "
        "FROM evidence_links e JOIN sources s ON s.id=e.source_id WHERE e.id=?", (evidence_id,)
    ).fetchone()
    if row is None:
        return None
    return {"source_id": row["id"],
            "citation": {"url": row["original_url"], "title": row["observed_title"], "locator": row["locator"]},
            "source_classification": row["publisher_classification"]}


def _role(db, row):
    source = _citation(db, row["evidence_id"])
    org = db.execute("SELECT coalesce((SELECT name FROM org_names WHERE unit_id=u.id AND kind='published' "
                      "ORDER BY effective_from DESC LIMIT 1),u.source_label) FROM org_units u WHERE u.id=?",
                     (row["unit_id"],)).fetchone() if row["unit_id"] else None
    target = db.execute("SELECT documented_title FROM role_targets WHERE id=?", (row["target_id"],)).fetchone() \
        if row["target_id"] else None
    return {"claim_id": row["id"], "county_fips": row["county_fips"], "person_id": row["person_id"],
            "published_name": row["published_name"], "title": row["published_title"],
            "responsibility": row["responsibility"], "listing_status": row["source_listing_status"],
            "organization": org[0] if org else None, "position": target[0] if target else None,
            "source": source}


def build_export(db, *, counties=None, statewide=False, limit=MAX_PROFILE_EXPORT, after_profile_id=None):
    if bool(counties) == bool(statewide):
        raise ValueError("Select one or more counties or explicit statewide scope")
    if counties:
        normalized = sorted(set(counties))
        if any(not isinstance(code, str) or code not in COUNTIES for code in normalized):
            raise ValueError("County scope must contain canonical five-digit Colorado FIPS codes")
        counties = normalized
    else:
        counties = []
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PROFILE_EXPORT:
        raise ValueError(f"Profile limit must be from 1 to {MAX_PROFILE_EXPORT}")
    if after_profile_id is not None and (not isinstance(after_profile_id, str) or not after_profile_id.strip()):
        raise ValueError("Continuation profile ID must be nonempty")

    if statewide:
        scope_sql, scope_params = "", []
        role_scope_sql, role_params = "", []
    else:
        marks = ",".join("?" for _ in counties)
        scope_sql = (f"WHERE (p.county_fips IN ({marks}) OR EXISTS (SELECT 1 FROM role_claims rc "
                     f"WHERE rc.person_id=p.id AND rc.county_fips IN ({marks})))")
        scope_params = [*counties, *counties]
        role_scope_sql = f"WHERE c.county_fips IN ({marks})"
        role_params = list(counties)
    cursor_sql = (" AND p.id>?" if scope_sql else " WHERE p.id>?") if after_profile_id is not None else ""
    profile_where = scope_sql + cursor_sql
    params = scope_params + ([after_profile_id] if after_profile_id is not None else [])
    profile_rows = db.execute(
        "SELECT p.id,p.county_fips,p.display_name,p.identity_state,p.identity_evidence_id "
        "FROM research_people p " + profile_where + " ORDER BY p.id LIMIT ?", [*params, limit + 1]
    ).fetchall()
    has_more = len(profile_rows) > limit
    profile_rows = profile_rows[:limit]
    profiles = []
    selected_ids = [row["id"] for row in profile_rows]
    for person in profile_rows:
        claim_params = [person["id"]]
        claim_sql = "SELECT id,county_fips,person_id,evidence_id,published_name,published_title,responsibility,source_listing_status,unit_id,target_id " \
                    "FROM role_claims WHERE person_id=?"
        if not statewide:
            claim_sql += f" AND county_fips IN ({','.join('?' for _ in counties)})"
            claim_params.extend(counties)
        claim_sql += " ORDER BY county_fips,id"
        roles = [_role(db, row) for row in db.execute(claim_sql, claim_params)]
        citations = []
        if person["identity_evidence_id"] and (statewide or person["county_fips"] in counties):
            item = _citation(db, person["identity_evidence_id"])
            if item:
                citations.append(item)
        citations.extend(role["source"] for role in roles if role["source"])
        unique = {item["source_id"]: item for item in citations}
        county_links = {role["county_fips"] for role in roles}
        if statewide or person["county_fips"] in counties:
            county_links.add(person["county_fips"])
        profiles.append({"profile_id": person["id"], "county_fips": person["county_fips"],
                         "counties": sorted(county_links), "display_name": person["display_name"],
                         "identity_state": person["identity_state"], "source_classification": None if not unique else None,
                         "sources": [unique[key] for key in sorted(unique)], "roles": roles})
        # A profile can have multiple source classifications. The per-source values above are authoritative.
        if unique:
            profiles[-1].pop("source_classification")

    role_sql = ("SELECT c.id,c.county_fips,c.person_id,c.evidence_id,c.published_name,c.published_title,"
                "c.responsibility,c.source_listing_status,c.unit_id,c.target_id FROM role_claims c " + role_scope_sql +
                (" AND c.person_id IS NULL" if role_scope_sql else " WHERE c.person_id IS NULL") +
                " ORDER BY c.county_fips,c.id")
    unassigned_roles = ([_role(db, row) for row in db.execute(role_sql, role_params)]
                        if after_profile_id is None else [])
    all_roles = [role for profile in profiles for role in profile["roles"]] + unassigned_roles
    # County eligibility is applied before the profile limit. Unassigned claims are a separate non-profile list.
    source_ids = {role["source"]["source_id"] for role in all_roles if role["source"]}
    source_ids.update(item["source_id"] for profile in profiles for item in profile["sources"])
    classifications = Counter()
    if source_ids:
        placeholders = ",".join("?" for _ in source_ids)
        classifications.update(dict(db.execute(
            f"SELECT publisher_classification,count(*) FROM sources WHERE id IN ({placeholders}) GROUP BY publisher_classification",
            sorted(source_ids)).fetchall()))
    diagnostics = {"profiles_without_linked_source": sum(not profile["sources"] for profile in profiles),
                   "unresolved_publishers": classifications.get("unresolved", 0),
                   "sources_by_classification": dict(sorted(classifications.items()))}
    return {"format": EXPORT_FORMAT, "scope": {"statewide": statewide, "county_fips": counties or None},
            "profile_limit": limit, "profiles": profiles, "unassigned_role_claims": unassigned_roles,
            "summary": {"distinct_profiles": len(profiles), "role_claims": len(all_roles),
                        "unassigned_role_claims": len(unassigned_roles),
                        "sources_by_classification": dict(sorted(classifications.items())),
                        "official_sources": classifications.get("official", 0),
                        "unofficial_sources": classifications.get("unofficial", 0),
                        "profiles_without_linked_source": diagnostics["profiles_without_linked_source"],
                        "unresolved_publishers": diagnostics["unresolved_publishers"],
                        "truncated": has_more,
                        "remaining_profiles": max(0, _profile_count(db, scope_sql, scope_params,
                                                                      after_profile_id) - len(profiles))},
            "continuation": {"after_profile_id": profiles[-1]["profile_id"] if has_more and profiles else None,
                             "has_more": has_more}}


def _profile_count(db, scope_sql, scope_params, after_profile_id):
    # Count after county scope, before applying the current-page limit.
    cursor_sql = (" AND p.id>?" if scope_sql else " WHERE p.id>?") if after_profile_id is not None else ""
    sql = "SELECT count(*) FROM research_people p " + scope_sql + cursor_sql
    params = [*scope_params, *([after_profile_id] if after_profile_id is not None else [])]
    return db.execute(sql, params).fetchone()[0]


def write_export(value, destination, *, repository_root):
    path = _validate_private_path(destination, repository_root, must_be_new=True)
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return path.stat().st_size

"""Bounded, evidence-led local operator actions for the R0 research database."""

import json

from research.mapping import canonical_json
from research.store import new_id, timestamp

MAX_LIMIT = 200
AXES = ("structure", "leadership", "named_staff", "positions")
COVERAGE = ("not_started", "partial", "reviewed", "stale", "blocked")
VISIT_PROVENANCE = ("observed", "reconstructed", "synthetic")
VISIT_OUTCOMES = ("success", "not_modified", "blocked", "failed", "not_found")


def _limit(limit):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"Limit must be between 1 and {MAX_LIMIT}")
    return limit


def _rows(db, sql, params=()):
    return [dict(row) for row in db.execute(sql, params)]


def _transaction(db):
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    db.execute("BEGIN IMMEDIATE")


def _run(db, run_id):
    row = db.execute("SELECT id,provenance,actor FROM research_runs WHERE id=?", (run_id,)).fetchone()
    if row is None:
        raise ValueError("Unknown research run")
    return row


def _event(db, *, run, actor, kind, entity_type, entity_id, detail, provenance=None):
    now = timestamp()
    db.execute("INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
               (new_id("event"), run["id"], kind, entity_type, entity_id, now, now,
                provenance or run["provenance"], canonical_json({**detail, "operator": actor})))


def inspect_counties(db, *, county=None, limit=50):
    limit = _limit(limit)
    where, params = ("WHERE fips=?", [county]) if county else ("", [])
    return _rows(db, f"SELECT fips,name FROM counties {where} ORDER BY fips LIMIT ?", (*params, limit))


def inspect_units(db, *, county=None, unit_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append("u.county_fips=?"); params.append(county)
    if unit_id:
        clauses.append("u.id=?"); params.append(unit_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT u.id,u.county_fips,c.name AS county,u.source_label,u.kind,u.parent_id,"
                      f"u.parent_relation,u.parent_evidence_id,u.effective_from,u.effective_to "
                      f"FROM org_units u JOIN counties c ON c.fips=u.county_fips {where} "
                      "ORDER BY u.county_fips,u.id LIMIT ?", (*params, limit))


def inspect_people(db, *, county=None, person_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append("p.county_fips=?"); params.append(county)
    if person_id:
        clauses.append("p.id=?"); params.append(person_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    people = _rows(db, f"SELECT p.id,p.county_fips,c.name AS county,p.display_name,p.identity_state,"
                        f"p.identity_evidence_id FROM research_people p JOIN counties c ON c.fips=p.county_fips "
                        f"{where} ORDER BY p.county_fips,p.id LIMIT ?", (*params, limit))
    for person in people:
        person["claims"] = _rows(db, "SELECT id,evidence_id,published_name,published_title,source_listing_status,"
                                     "unit_id,target_id,supersedes_id FROM role_claims WHERE person_id=? "
                                     "ORDER BY id LIMIT ?", (person["id"], MAX_LIMIT))
    return people


def inspect_claims(db, *, county=None, status=None, unassigned=False, claim_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append("c.county_fips=?"); params.append(county)
    if status:
        clauses.append("c.source_listing_status=?"); params.append(status)
    if unassigned:
        clauses.append("c.person_id IS NULL")
    if claim_id:
        clauses.append("c.id=?"); params.append(claim_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT c.id,c.county_fips,co.name AS county,c.evidence_id,c.person_id,p.display_name,"
                      f"c.unit_id,c.target_id,c.published_name,c.published_title,c.responsibility,"
                      f"c.source_listing_status,c.legacy_display_group,c.grouping_basis,c.department_label,"
                      f"c.division_label,c.program_location,c.supersedes_id "
                      f"FROM role_claims c JOIN counties co ON co.fips=c.county_fips "
                      f"LEFT JOIN research_people p ON p.id=c.person_id {where} "
                      "ORDER BY c.county_fips,c.id LIMIT ?", (*params, limit))


def inspect_sources(db, *, source_id=None, county=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if source_id:
        clauses.append("s.id=?"); params.append(source_id)
    if county:
        clauses.append("EXISTS (SELECT 1 FROM evidence_links e JOIN scrape_batches b ON b.id=e.batch_id "
                       "WHERE e.source_id=s.id AND b.county_fips=?)"); params.append(county)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sources = _rows(db, f"SELECT s.id,s.original_url,s.page_type,s.official_status,s.availability,s.usefulness,"
                        f"s.recorded_at FROM sources s {where} ORDER BY s.id LIMIT ?", (*params, limit))
    for source in sources:
        source["evidence"] = _rows(db, "SELECT id,source_version_key,observed_title,observed_url,source_date,"
                                        "source_date_precision,source_date_basis,reported_checked_date,locator,"
                                        "batch_id,run_id,recorded_at FROM evidence_links WHERE source_id=? "
                                        "ORDER BY recorded_at,id LIMIT ?", (source["id"], MAX_LIMIT))
        source["visits"] = _rows(db, "SELECT id,run_id,provenance,evidence_id,reported_checked_date,attempted_at,"
                                     "actor,attempt,outcome,http_status,duration_ms,content_sha256,etag,last_modified,"
                                     "result_count FROM source_visits WHERE source_id=? "
                                     "ORDER BY attempted_at DESC,id LIMIT ?", (source["id"], MAX_LIMIT))
    return sources


def inspect_matches(db, *, county=None, status=None, person_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append("m.county_fips=?"); params.append(county)
    if status:
        clauses.append("m.status=?"); params.append(status)
    if person_id:
        clauses.append("(m.person_a=? OR m.person_b=?)"); params.extend((person_id, person_id))
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT m.id,m.county_fips,m.person_a,a.display_name AS person_a_name,"
                      f"m.person_b,b.display_name AS person_b_name,m.status,m.supporting_evidence_id,"
                      f"m.conflicting_evidence_id,m.rationale,m.decision_basis,m.resolution_evidence_id "
                      f"FROM possible_matches m JOIN research_people a ON a.id=m.person_a "
                      f"JOIN research_people b ON b.id=m.person_b {where} "
                      "ORDER BY m.county_fips,m.id LIMIT ?", (*params, limit))


def inspect_coverage(db, *, county=None, unit_id=None, axis=None, status=None, limit=100):
    limit = _limit(limit)
    clauses, params = [], []
    for column, value in (("u.county_fips", county), ("u.id", unit_id), ("c.axis", axis), ("c.status", status)):
        if value is not None:
            clauses.append(f"{column}=?"); params.append(value)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT c.unit_id,u.county_fips,co.name AS county,u.source_label AS unit,c.axis,"
                      f"c.status,c.evidence_id,c.run_id,c.assessed_at,c.limitations,c.next_task "
                      f"FROM unit_coverage c JOIN org_units u ON u.id=c.unit_id "
                      f"JOIN counties co ON co.fips=u.county_fips {where} "
                      "ORDER BY u.county_fips,u.id,c.axis LIMIT ?", (*params, limit))


def inspect_events(db, *, run_id=None, entity_type=None, entity_id=None, kind=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    for column, value in (("e.run_id", run_id), ("e.entity_type", entity_type),
                          ("e.entity_id", entity_id), ("e.kind", kind)):
        if value is not None:
            clauses.append(f"{column}=?"); params.append(value)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    rows = _rows(db, f"SELECT e.id,e.run_id,r.kind AS run_kind,r.provenance AS run_provenance,"
                     f"r.actor AS run_actor,r.recorded_at AS run_recorded_at,e.kind,e.entity_type,e.entity_id,"
                     f"e.occurred_at,e.recorded_at,e.provenance,e.detail_json "
                     f"FROM research_events e JOIN research_runs r ON r.id=e.run_id {where} "
                     f"ORDER BY e.recorded_at DESC,e.id LIMIT ?", (*params, limit))
    for row in rows:
        row["details"] = json.loads(row.pop("detail_json"))
    return rows


def associate_claim(db, *, claim_id, person_id, evidence_id, rationale, actor):
    if not all(isinstance(v, str) and v.strip() for v in (claim_id, person_id, evidence_id, rationale, actor)):
        raise ValueError("Claim, person, supporting evidence, rationale, and operator are required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        claim = db.execute("SELECT id,county_fips,evidence_id,person_id,published_name FROM role_claims WHERE id=?",
                           (claim_id,)).fetchone()
        person = db.execute("SELECT id,county_fips,display_name FROM research_people WHERE id=?", (person_id,)).fetchone()
        if claim is None or person is None:
            raise ValueError("Unknown claim or research person")
        if claim["county_fips"] != person["county_fips"]:
            raise ValueError("Claim and person must belong to the same county")
        if claim["person_id"] is not None:
            raise ValueError("Claim is already assigned; R1 does not reassign identities")
        support = db.execute("SELECT e.id,e.source_id,s.official_status,r.provenance FROM evidence_links e "
                             "JOIN sources s ON s.id=e.source_id JOIN research_runs r ON r.id=e.run_id "
                             "JOIN name_variants n ON n.evidence_id=e.id "
                             "WHERE e.id=? AND n.person_id=? AND n.published_name=? "
                             "AND s.official_status='official'", (evidence_id, person_id, claim["published_name"])).fetchone()
        claim_source = db.execute("SELECT source_id FROM evidence_links WHERE id=?", (claim["evidence_id"],)).fetchone()
        if support is None or claim_source is None or support["source_id"] != claim_source["source_id"]:
            raise ValueError("Supporting evidence must document this person’s exact published name in the claim’s official source")
        run_id, now = new_id("run"), timestamp()
        provenance = support["provenance"]
        db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at,note) "
                   "VALUES (?,?,?,?,?,?,?,?)", (run_id, "screening", provenance, actor, now, now, now,
                                                   "R1 evidence-led claim association"))
        db.execute("UPDATE role_claims SET person_id=? WHERE id=? AND person_id IS NULL", (person_id, claim_id))
        if db.execute("SELECT changes()").fetchone()[0] != 1:
            raise ValueError("Claim assignment changed during the operation")
        run = {"id": run_id, "provenance": provenance}
        _event(db, run=run, actor=actor, kind="claim_person_associated", entity_type="role_claims",
               entity_id=claim_id, detail={"before": {"person_id": None}, "after": {"person_id": person_id},
                                           "supporting_evidence_id": evidence_id, "rationale": rationale})
        db.commit()
        return {"claim_id": claim_id, "person_id": person_id, "run_id": run_id}
    except Exception:
        db.rollback()
        raise


def record_visit(db, *, source_id, run_id, provenance, outcome, actor, evidence_id=None,
                 reported_checked_date=None, attempted_at=None, attempt=None, http_status=None,
                 duration_ms=None, content_sha256=None, etag=None, last_modified=None,
                 result_count=None, note=None):
    if provenance not in VISIT_PROVENANCE or outcome not in VISIT_OUTCOMES:
        raise ValueError("Invalid source visit provenance or outcome")
    if not isinstance(actor, str) or not actor.strip():
        raise ValueError("Operator is required")
    try:
        db.execute("BEGIN IMMEDIATE")
        run = _run(db, run_id)
        source = db.execute("SELECT id FROM sources WHERE id=?", (source_id,)).fetchone()
        if source is None:
            raise ValueError("Unknown source")
        if provenance == "reconstructed" and not evidence_id:
            raise ValueError("Reconstructed visits require supporting evidence")
        if evidence_id:
            evidence = db.execute("SELECT source_id FROM evidence_links WHERE id=?", (evidence_id,)).fetchone()
            if evidence is None or evidence["source_id"] != source_id:
                raise ValueError("Visit evidence must belong to the selected source")
        visit_id = new_id("visit")
        columns = ("id,source_id,run_id,provenance,evidence_id,reported_checked_date,attempted_at,actor,attempt,outcome,"
                   "http_status,duration_ms,content_sha256,etag,last_modified,result_count,note")
        values = (visit_id, source_id, run_id, provenance, evidence_id, reported_checked_date, attempted_at, actor,
                  attempt, outcome, http_status, duration_ms, content_sha256, etag, last_modified, result_count, note)
        db.execute(f"INSERT INTO source_visits({columns}) VALUES ({','.join('?' for _ in values)})", values)
        _event(db, run=run, actor=actor, kind="source_visit_recorded", entity_type="source_visits",
               entity_id=visit_id, detail={"before": None, "after": {
                   "source_id": source_id, "provenance": provenance, "evidence_id": evidence_id,
                   "reported_checked_date": reported_checked_date, "attempted_at": attempted_at,
                   "actor": actor, "attempt": attempt, "outcome": outcome, "http_status": http_status,
                   "duration_ms": duration_ms, "content_sha256": content_sha256, "etag": etag,
                   "last_modified": last_modified, "result_count": result_count,
               }})
        db.commit()
        return {"visit_id": visit_id, "run_id": run_id}
    except Exception:
        db.rollback()
        raise


def update_coverage(db, *, unit_id, axis, status, evidence_id, run_id, actor, rationale,
                    assessed_at=None, limitations=None, next_task=None):
    if axis not in AXES or status not in COVERAGE:
        raise ValueError("Invalid coverage axis or status")
    if not all(isinstance(v, str) and v.strip() for v in (actor, rationale)):
        raise ValueError("Operator and rationale are required")
    if not run_id:
        raise ValueError("A research run is required to audit a coverage update")
    if status != "not_started" and not evidence_id:
        raise ValueError("Coverage other than not_started requires evidence and a research run")
    try:
        db.execute("BEGIN IMMEDIATE")
        unit = db.execute("SELECT id FROM org_units WHERE id=?", (unit_id,)).fetchone()
        if unit is None:
            raise ValueError("Unknown organization unit")
        if evidence_id and db.execute("SELECT 1 FROM evidence_links WHERE id=?", (evidence_id,)).fetchone() is None:
            raise ValueError("Unknown supporting evidence")
        run = _run(db, run_id) if run_id else None
        previous = db.execute("SELECT status,evidence_id,run_id,assessed_at,limitations,next_task "
                              "FROM unit_coverage WHERE unit_id=? AND axis=?", (unit_id, axis)).fetchone()
        if previous is None:
            raise ValueError("Unknown coverage dimension")
        now = assessed_at or timestamp()
        db.execute("UPDATE unit_coverage SET status=?,evidence_id=?,run_id=?,assessed_at=?,limitations=?,next_task=? "
                   "WHERE unit_id=? AND axis=?", (status, evidence_id, run_id, now, limitations, next_task, unit_id, axis))
        after = {"status": status, "evidence_id": evidence_id, "run_id": run_id, "assessed_at": now,
                 "limitations": limitations, "next_task": next_task}
        _event(db, run=run, actor=actor, kind="coverage_axis_updated", entity_type="unit_coverage",
               entity_id=f"{unit_id}:{axis}", detail={"axis": axis, "before": dict(previous), "after": after,
                                                       "rationale": rationale})
        db.commit()
        return {"unit_id": unit_id, "axis": axis, "status": status, "run_id": run["id"]}
    except Exception:
        db.rollback()
        raise

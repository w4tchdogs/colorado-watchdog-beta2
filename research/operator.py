"""Bounded, evidence-led local operator actions for the R0 research database."""

import json
import re

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


def _validate_claim_association(db, *, claim_id, person_id, evidence_id):
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
    return claim, person, support


def _create_screening_run(db, *, provenance, actor, note):
    run_id, now = new_id("run"), timestamp()
    db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at,note) "
               "VALUES (?,?,?,?,?,?,?,?)", (run_id, "screening", provenance, actor, now, now, now, note))
    return {"id": run_id, "provenance": provenance}


def _associate_claim_in_transaction(db, *, claim_id, person_id, evidence_id, rationale, actor, run):
    _validate_claim_association(db, claim_id=claim_id, person_id=person_id, evidence_id=evidence_id)
    db.execute("UPDATE role_claims SET person_id=? WHERE id=? AND person_id IS NULL", (person_id, claim_id))
    if db.execute("SELECT changes()").fetchone()[0] != 1:
        raise ValueError("Claim assignment changed during the operation")
    _event(db, run=run, actor=actor, kind="claim_person_associated", entity_type="role_claims",
           entity_id=claim_id, detail={"before": {"person_id": None}, "after": {"person_id": person_id},
                                       "supporting_evidence_id": evidence_id, "rationale": rationale})


def associate_claim(db, *, claim_id, person_id, evidence_id, rationale, actor):
    """Assign an existing unassigned claim to an explicitly selected, evidenced person."""
    if not all(isinstance(v, str) and v.strip() for v in (claim_id, person_id, evidence_id, rationale, actor)):
        raise ValueError("Claim, person, supporting evidence, rationale, and operator are required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        _, _, support = _validate_claim_association(db, claim_id=claim_id, person_id=person_id,
                                                    evidence_id=evidence_id)
        run = _create_screening_run(db, provenance=support["provenance"], actor=actor,
                                    note="R1 evidence-led claim association")
        _associate_claim_in_transaction(db, claim_id=claim_id, person_id=person_id, evidence_id=evidence_id,
                                        rationale=rationale, actor=actor, run=run)
        db.commit()
        return {"claim_id": claim_id, "person_id": person_id, "run_id": run["id"]}
    except Exception:
        db.rollback()
        raise


def _flatten_text(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [part for item in value.values() for part in _flatten_text(item)]
    if isinstance(value, (list, tuple)):
        return [part for item in value for part in _flatten_text(item)]
    return []


def _evidence_text(evidence):
    parts = [evidence["quotation"] or "", evidence["observed_title"] or ""]
    if evidence["raw_record_json"]:
        try:
            parts.extend(_flatten_text(json.loads(evidence["raw_record_json"])))
        except (TypeError, json.JSONDecodeError):
            pass
    return "\n".join(parts)


def _claim_evidence(db, *, county_fips, claim_id, published_name, evidence_id):
    evidence = db.execute("SELECT e.id,e.source_id,e.raw_record_json,e.quotation,e.observed_title,e.run_id,"
                          "e.batch_id,s.official_status,r.provenance,b.county_fips AS batch_county "
                          "FROM evidence_links e JOIN sources s ON s.id=e.source_id "
                          "JOIN research_runs r ON r.id=e.run_id "
                          "LEFT JOIN scrape_batches b ON b.id=e.batch_id WHERE e.id=?", (evidence_id,)).fetchone()
    claim = db.execute("SELECT id,county_fips,evidence_id,person_id,published_name,published_title,responsibility "
                       "FROM role_claims WHERE id=?", (claim_id,)).fetchone()
    if claim is None:
        raise ValueError("Unknown role claim")
    if db.execute("SELECT 1 FROM counties WHERE fips=?", (county_fips,)).fetchone() is None:
        raise ValueError("Unknown county FIPS")
    if claim["county_fips"] != county_fips:
        raise ValueError("Selected claim does not belong to the explicit county")
    if claim["published_name"] != published_name:
        raise ValueError("Published name must exactly preserve the selected claim’s source wording")
    if claim["person_id"] is not None:
        raise ValueError("Claim is already assigned; R2 bootstrap requires an unassigned claim")
    if evidence is None:
        raise ValueError("Unknown supporting evidence")
    if evidence["id"] != claim["evidence_id"]:
        raise ValueError("Bootstrap evidence must be the exact observation attached to the selected claim")
    if evidence["official_status"] != "official":
        raise ValueError("Supporting evidence must come from a source classified as official")
    if evidence["batch_county"] is not None and evidence["batch_county"] != claim["county_fips"]:
        raise ValueError("Supporting evidence belongs to a different county claim context")
    cells = _flatten_text(json.loads(evidence["raw_record_json"])) if evidence["raw_record_json"] else []
    quote = evidence["quotation"] or ""
    supports_name = claim["published_name"] in cells or claim["published_name"] in quote
    role_values = [value for value in (claim["published_title"], claim["responsibility"]) if value]
    supports_position = any(value in cells or value in quote for value in role_values)
    if not supports_name or not supports_position:
        raise ValueError("Official evidence must contain the claim’s exact published name and a documented position")
    return claim, evidence


def bootstrap_person(db, *, county_fips, claim_id, published_name, evidence_id, actor, rationale):
    """Atomically create a source-grounded person/name variant and assign one claim.

    The display and initial published name are copied verbatim from the selected
    source-backed claim. Existing similar or identical names are intentionally ignored.
    """
    if not all(isinstance(v, str) and v.strip() for v in
               (county_fips, claim_id, published_name, evidence_id, actor, rationale)):
        raise ValueError("County FIPS, claim, published name, supporting evidence, operator, and rationale are required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        claim, evidence = _claim_evidence(db, county_fips=county_fips, claim_id=claim_id,
                                          published_name=published_name, evidence_id=evidence_id)
        person_id, variant_id = new_id("person"), new_id("variant")
        run = _create_screening_run(db, provenance=evidence["provenance"], actor=actor,
                                    note="R2 evidence-led identity bootstrap")
        db.execute("INSERT INTO research_people(id,county_fips,display_name,identity_state,identity_evidence_id) "
                   "VALUES (?,?,?,'evidence_supported',?)",
                   (person_id, claim["county_fips"], claim["published_name"], evidence_id))
        _event(db, run=run, actor=actor, kind="research_person_created", entity_type="research_people",
               entity_id=person_id, detail={"before": None, "after": {"person_id": person_id,
                   "county_fips": claim["county_fips"], "display_name": claim["published_name"],
                   "identity_state": "evidence_supported", "identity_evidence_id": evidence_id},
                   "claim_id": claim_id, "supporting_evidence_id": evidence_id, "rationale": rationale})
        db.execute("INSERT INTO name_variants(id,person_id,published_name,kind,evidence_id) "
                   "VALUES (?,?,?,'published',?)", (variant_id, person_id, claim["published_name"], evidence_id))
        _event(db, run=run, actor=actor, kind="name_variant_registered", entity_type="name_variants",
               entity_id=variant_id, detail={"before": None, "after": {"variant_id": variant_id,
                   "person_id": person_id, "published_name": claim["published_name"], "kind": "published",
                   "evidence_id": evidence_id}, "supporting_evidence_id": evidence_id, "rationale": rationale})
        _associate_claim_in_transaction(db, claim_id=claim_id, person_id=person_id, evidence_id=evidence_id,
                                        rationale=rationale, actor=actor, run=run)
        db.commit()
        return {"person_id": person_id, "variant_id": variant_id, "claim_id": claim_id, "run_id": run["id"]}
    except Exception:
        db.rollback()
        raise


_NAME_LINK_WORDS = (
    "also known as", "a.k.a.", "aka", "also listed as", "formerly known as",
    "previously known as", "formerly listed as", "previously listed as", "listed as",
    "name changed from", "changed name from", "renamed from", "née", "nee",
)


def _explicit_name_link(text, known_names, candidate):
    if not candidate or not any(name for name in known_names):
        return False
    for known in known_names:
        if not known or known == candidate:
            continue
        positions = []
        start = 0
        while True:
            index = text.find(known, start)
            if index < 0:
                break
            positions.append((index, index + len(known)))
            start = index + 1
        candidate_positions = []
        start = 0
        while True:
            index = text.find(candidate, start)
            if index < 0:
                break
            candidate_positions.append((index, index + len(candidate)))
            start = index + 1
        for left in positions:
            for right in candidate_positions:
                if left[1] <= right[0]:
                    between = text[left[1]:right[0]].lower()
                elif right[1] <= left[0]:
                    between = text[right[1]:left[0]].lower()
                else:
                    continue
                if len(between) > 240 or re.search(r"\b(?:not|never|neither|no longer)\b", between):
                    continue
                if any(re.search(r"(?<!\w)" + re.escape(word) + r"(?!\w)", between)
                       for word in _NAME_LINK_WORDS):
                    return True
    return False


def add_name_variant(db, *, person_id, published_name, kind, evidence_id, actor, rationale):
    """Record an exact variant only when official evidence explicitly connects both forms."""
    if not all(isinstance(v, str) and v.strip() for v in
               (person_id, published_name, kind, evidence_id, actor, rationale)):
        raise ValueError("Person, exact name, type, evidence, operator, and rationale are required")
    if kind not in ("published", "nickname", "former", "alternative"):
        raise ValueError("Invalid name variant type")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        person = db.execute("SELECT id,county_fips,display_name,identity_evidence_id FROM research_people WHERE id=?",
                            (person_id,)).fetchone()
        if person is None:
            raise ValueError("Unknown research person")
        evidence = db.execute("SELECT e.id,e.source_id,e.quotation,e.raw_record_json,e.observed_title,"
                              "e.run_id,e.batch_id,s.official_status,r.provenance,b.county_fips AS batch_county "
                              "FROM evidence_links e JOIN sources s ON s.id=e.source_id "
                              "JOIN research_runs r ON r.id=e.run_id "
                              "LEFT JOIN scrape_batches b ON b.id=e.batch_id WHERE e.id=?", (evidence_id,)).fetchone()
        if evidence is None:
            raise ValueError("Unknown supporting evidence")
        if evidence["official_status"] != "official":
            raise ValueError("Name-variant evidence must come from a source classified as official")
        if evidence["batch_county"] is not None and evidence["batch_county"] != person["county_fips"]:
            raise ValueError("Name-variant evidence belongs to a different county")
        if evidence["batch_county"] is None:
            linked = db.execute("SELECT 1 FROM name_variants n JOIN evidence_links known ON known.id=n.evidence_id "
                                "WHERE n.person_id=? AND known.source_id=? UNION ALL "
                                "SELECT 1 FROM source_unit_links l JOIN org_units u ON u.id=l.unit_id "
                                "WHERE l.evidence_id=? AND u.county_fips=? LIMIT 1",
                                (person_id, evidence["source_id"], evidence_id, person["county_fips"])).fetchone()
            if linked is None:
                raise ValueError("Evidence is not established in this person’s county context")
        text = _evidence_text(evidence)
        known_names = [person["display_name"]]
        known_names.extend(row[0] for row in db.execute("SELECT published_name FROM name_variants WHERE person_id=?",
                                                         (person_id,)))
        if not _explicit_name_link(text, known_names, published_name):
            raise ValueError("Official evidence must explicitly connect the exact variant to an established name for this person")
        duplicate = db.execute("SELECT id FROM name_variants WHERE person_id=? AND published_name=? AND kind=? AND evidence_id=?",
                               (person_id, published_name, kind, evidence_id)).fetchone()
        if duplicate:
            db.commit()
            return {"variant_id": duplicate[0], "person_id": person_id, "created": False}
        variant_id = new_id("variant")
        run = _create_screening_run(db, provenance=evidence["provenance"], actor=actor,
                                    note="R2 evidence-supported name variant")
        db.execute("INSERT INTO name_variants(id,person_id,published_name,kind,evidence_id) VALUES (?,?,?,?,?)",
                   (variant_id, person_id, published_name, kind, evidence_id))
        _event(db, run=run, actor=actor, kind="name_variant_registered", entity_type="name_variants",
               entity_id=variant_id, detail={"before": None, "after": {"variant_id": variant_id,
                   "person_id": person_id, "published_name": published_name, "kind": kind,
                   "evidence_id": evidence_id}, "supporting_evidence_id": evidence_id, "rationale": rationale})
        db.commit()
        return {"variant_id": variant_id, "person_id": person_id, "run_id": run["id"], "created": True}
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
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
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
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
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

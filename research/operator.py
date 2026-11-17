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
SOURCE_CLASSIFICATIONS = ("unknown", "official", "partner", "other")
PUBLISHER_CLASSIFICATIONS = ("official", "unofficial")


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
    db.execute("INSERT INTO research_history VALUES (?,?,?,?,?,?,?,?,?)",
               (new_id("event"), run["id"], kind, entity_type, entity_id, now, now,
                provenance or run["provenance"], canonical_json({**detail, "operator": actor})))


def inspect_counties(db, *, county=None, limit=50):
    limit = _limit(limit)
    where, params = ('WHERE "County code"=?', [county]) if county else ("", [])
    return _rows(db, f"SELECT \"County code\" AS fips,\"County name\" AS name FROM county {where} ORDER BY fips LIMIT ?", (*params, limit))


def inspect_units(db, *, county=None, unit_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append('u."County code"=?'); params.append(county)
    if unit_id:
        clauses.append('u."Office or unit ID"=?'); params.append(unit_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT u.\"Office or unit ID\" AS id,u.\"County code\" AS county_fips,c.\"County name\" AS county,u.\"Office or unit label as published\" AS source_label,u.\"Organization type\" AS kind,u.\"Parent office or unit\" AS parent_id,"
                      f"u.\"Relationship to parent\" AS parent_relation,u.\"Evidence for parent relationship\" AS parent_evidence_id,u.\"Applies from\" AS effective_from,u.\"Applies until\" AS effective_to "
                      f"FROM county_research_unit_structure u JOIN county c ON c.\"County code\"=u.\"County code\" {where} "
                      'ORDER BY u."County code",u."Office or unit ID" LIMIT ?', (*params, limit))


def inspect_people(db, *, county=None, person_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append('p."County code"=?'); params.append(county)
    if person_id:
        clauses.append('p."Profile ID"=?'); params.append(person_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    people = _rows(db, f"SELECT p.\"Profile ID\" AS id,p.\"County code\" AS county_fips,c.\"County name\" AS county,p.\"Full name\" AS display_name,p.\"Identity review status\" AS identity_state,"
                        f"p.\"Evidence for identity\" AS identity_evidence_id FROM profile_research p JOIN county c ON c.\"County code\"=p.\"County code\" "
                        f"{where} ORDER BY p.\"County code\",p.\"Profile ID\" LIMIT ?", (*params, limit))
    for person in people:
        person["claims"] = _rows(db, 'SELECT "Role claim ID" AS id,"Evidence record ID" AS evidence_id,"Name as published" AS published_name,"Position as published" AS published_title,"Listing status" AS source_listing_status,'
                                     '"Linked office or unit" AS unit_id,"Linked position" AS target_id,"Earlier claim this replaces" AS supersedes_id FROM profile_research_role WHERE "Linked profile"=? '
                                     "ORDER BY id LIMIT ?", (person["id"], MAX_LIMIT))
    return people


def inspect_claims(db, *, county=None, status=None, unassigned=False, claim_id=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if county:
        clauses.append('c."County code"=?'); params.append(county)
    if status:
        clauses.append('c."Listing status"=?'); params.append(status)
    if unassigned:
        clauses.append('c."Linked profile" IS NULL')
    if claim_id:
        clauses.append('c."Role claim ID"=?'); params.append(claim_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT c.\"Role claim ID\" AS id,c.\"County code\" AS county_fips,co.\"County name\" AS county,c.\"Evidence record ID\" AS evidence_id,c.\"Linked profile\" AS person_id,p.\"Full name\" AS display_name,"
                      f"c.\"Linked office or unit\" AS unit_id,c.\"Linked position\" AS target_id,c.\"Name as published\" AS published_name,c.\"Position as published\" AS published_title,c.\"Job description or duties\" AS responsibility,"
                      f"c.\"Listing status\" AS source_listing_status,c.\"Original display group\" AS legacy_display_group,c.\"Reason for grouping\" AS grouping_basis,c.\"Office or department as published\" AS department_label,"
                      f"c.\"Division or unit as published\" AS division_label,c.\"Program or location as published\" AS program_location,c.\"Earlier claim this replaces\" AS supersedes_id "
                      f"FROM profile_research_role c JOIN county co ON co.\"County code\"=c.\"County code\" "
                      f"LEFT JOIN profile_research p ON p.\"Profile ID\"=c.\"Linked profile\" {where} "
                      'ORDER BY c."County code",c."Role claim ID" LIMIT ?', (*params, limit))


def inspect_sources(db, *, source_id=None, county=None, limit=50):
    limit = _limit(limit)
    clauses, params = [], []
    if source_id:
        clauses.append('s."Source ID"=?'); params.append(source_id)
    if county:
        clauses.append('EXISTS (SELECT 1 FROM research_evidence e JOIN research_scrapes b ON b.id=e."Import batch ID" '
                       'WHERE e."Source ID"=s."Source ID" AND b.county_fips=?)'); params.append(county)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sources = _rows(db, f"SELECT s.\"Source ID\" AS id,s.\"Original source URL\" AS original_url,s.\"Document type\" AS page_type,s.\"Previous source category\" AS official_status,s.\"Publisher type\" AS publisher_classification,"
                        f"s.\"Source availability\" AS availability,s.\"How the source was useful\" AS usefulness,"
                        f"s.\"Recorded on\" AS recorded_at FROM research_sources s {where} ORDER BY s.\"Source ID\" LIMIT ?", (*params, limit))
    for source in sources:
        source["evidence"] = _rows(db, 'SELECT "Evidence record ID" AS id,"Source version ID" AS source_version_key,"Source title as observed" AS observed_title,"Source URL as observed" AS observed_url,"Source date" AS source_date,'
                                        '"Source date precision" AS source_date_precision,"How the source date was determined" AS source_date_basis,"Reported check date" AS reported_checked_date,"Evidence location" AS locator,'
                                        '"Import batch ID" AS batch_id,"Research run ID" AS run_id,"Recorded on" AS recorded_at FROM research_evidence WHERE "Source ID"=? '
                                        "ORDER BY recorded_at,id LIMIT ?", (source["id"], MAX_LIMIT))
        source["visits"] = _rows(db, "SELECT id,run_id,provenance,evidence_id,reported_checked_date,attempted_at,"
                                     "actor,attempt,outcome,http_status,duration_ms,content_sha256,etag,last_modified,"
                                     "result_count FROM research_source_visits WHERE source_id=? "
                                     "ORDER BY attempted_at DESC,id LIMIT ?", (source["id"], MAX_LIMIT))
    return sources


def classify_source(db, *, source_id, status, actor, basis, evidence_id=None):
    """Set one explicit source classification with an atomic research event."""
    if not all(isinstance(value, str) and value.strip() for value in (source_id, actor, basis)):
        raise ValueError("Source, operator, and documented classification basis are required")
    if status not in SOURCE_CLASSIFICATIONS:
        raise ValueError("Invalid source classification")
    if evidence_id is not None and (not isinstance(evidence_id, str) or not evidence_id.strip()):
        raise ValueError("Supporting evidence identifier cannot be blank")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        source = db.execute('SELECT "Source ID" AS id,"Previous source category" AS official_status,"Publisher type" AS publisher_classification FROM research_sources WHERE "Source ID"=?', (source_id,)).fetchone()
        if source is None:
            raise ValueError("Unknown source")
        provenance = "reconstructed"
        if evidence_id is not None:
            evidence = db.execute(
                'SELECT e."Source ID" AS source_id,r.provenance FROM research_evidence e '
                'JOIN research_runs r ON r.id=e."Research run ID" WHERE e."Evidence record ID"=?', (evidence_id,)
            ).fetchone()
            if evidence is None or evidence["source_id"] != source_id:
                raise ValueError("Supporting evidence must belong to the selected source")
            provenance = evidence["provenance"]
        previous = source["official_status"]
        previous_publisher = source["publisher_classification"]
        next_publisher = ("official" if status == "official" else
                          "unresolved" if status == "unknown" else previous_publisher)
        if status == "official" and evidence_id is None:
            raise ValueError("Official publisher classification requires source-specific evidence")
        if previous == status and previous_publisher == next_publisher:
            prior_event = db.execute(
                "SELECT detail_json FROM research_history WHERE kind IN "
                "('source_classified','source_classification_confirmed') "
                "AND entity_type='sources' AND entity_id=? ORDER BY rowid DESC LIMIT 1",
                (source_id,),
            ).fetchone()
            if prior_event:
                try:
                    detail = json.loads(prior_event["detail_json"])
                except json.JSONDecodeError:
                    detail = {}
                if (detail.get("after") == {"official_status": status}
                        and detail.get("supporting_evidence_id") == evidence_id
                        and detail.get("basis") == basis and detail.get("operator") == actor):
                    db.commit()
                    return {"source_id": source_id, "official_status": status,
                            "previous_status": previous, "changed": False,
                            "recorded": False, "run_id": None}
        run = _create_screening_run(db, provenance=provenance, actor=actor,
                                    note="R4-H1 source classification")
        changed = previous != status or previous_publisher != next_publisher
        if changed:
            db.execute('UPDATE research_sources SET "Previous source category"=?,"Publisher type"=? WHERE "Source ID"=?',
                       (status, next_publisher, source_id))
        _event(db, run=run, actor=actor,
               kind="source_classified" if previous != status else "source_classification_confirmed",
               entity_type="sources", entity_id=source_id,
               detail={"before": {"official_status": previous},
                       "after": {"official_status": status},
                       "supporting_evidence_id": evidence_id, "basis": basis})
        if previous_publisher != next_publisher:
            _event(db, run=run, actor=actor, kind="source_publisher_classified",
                   entity_type="sources", entity_id=source_id,
                   detail={"before": {"publisher_classification": previous_publisher,
                                      "official_status": previous},
                           "after": {"publisher_classification": next_publisher,
                                     "official_status": status},
                           "supporting_evidence_id": evidence_id, "basis": basis})
        db.commit()
        return {"source_id": source_id, "official_status": status,
                "publisher_classification": next_publisher,
                "previous_status": previous, "changed": changed,
                "recorded": True, "run_id": run["id"]}
    except Exception:
        db.rollback()
        raise


def classify_publisher(db, *, source_id, classification, actor, basis, evidence_id):
    """Classify the publisher of one exact source using attached evidence."""
    if not all(isinstance(value, str) and value.strip() for value in
               (source_id, actor, basis, evidence_id)):
        raise ValueError("Source, publisher classification, operator, basis, and evidence are required")
    if classification not in PUBLISHER_CLASSIFICATIONS:
        raise ValueError("Invalid publisher classification")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        source = db.execute('SELECT "Publisher type" AS publisher_classification,"Previous source category" AS official_status FROM research_sources WHERE "Source ID"=?', (source_id,)).fetchone()
        if source is None:
            raise ValueError("Unknown source")
        evidence = db.execute('SELECT "Source ID" AS source_id,"Research run ID" AS run_id FROM research_evidence WHERE "Evidence record ID"=?', (evidence_id,)).fetchone()
        if evidence is None or evidence["source_id"] != source_id:
            raise ValueError("Supporting evidence must belong to the selected source")
        previous = source["publisher_classification"]
        previous_legacy = source["official_status"]
        next_legacy = previous_legacy
        if classification == "official" and previous_legacy == "unknown":
            next_legacy = "official"
        elif classification == "unofficial" and previous_legacy == "official":
            next_legacy = "unknown"
        prior_event = db.execute(
            "SELECT detail_json FROM research_history WHERE kind='source_publisher_classified' "
            "AND entity_type='sources' AND entity_id=? ORDER BY rowid DESC LIMIT 1", (source_id,)
        ).fetchone()
        if previous == classification and prior_event:
            detail = json.loads(prior_event["detail_json"])
            if (detail.get("after") == {"publisher_classification": classification,
                                        "official_status": next_legacy}
                    and detail.get("supporting_evidence_id") == evidence_id
                    and detail.get("basis") == basis and detail.get("operator") == actor):
                db.commit()
                return {"source_id": source_id, "publisher_classification": classification,
                        "previous_classification": previous, "changed": False, "recorded": False}
        run = _create_screening_run(db, provenance="reconstructed", actor=actor,
                                    note="Publisher classification")
        changed = previous != classification or previous_legacy != next_legacy
        if changed:
            db.execute('UPDATE research_sources SET "Publisher type"=?,"Previous source category"=? WHERE "Source ID"=?',
                       (classification, next_legacy, source_id))
        _event(db, run=run, actor=actor,
               kind="source_publisher_classified", entity_type="sources", entity_id=source_id,
               detail={"before": {"publisher_classification": previous, "official_status": previous_legacy},
                       "after": {"publisher_classification": classification, "official_status": next_legacy},
                       "supporting_evidence_id": evidence_id, "basis": basis})
        db.commit()
        return {"source_id": source_id, "publisher_classification": classification,
                "previous_classification": previous, "changed": changed, "recorded": True,
                "run_id": run["id"]}
    except Exception:
        db.rollback()
        raise


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
    return _rows(db, f"SELECT m.id,m.county_fips,m.person_a,a.\"Full name\" AS person_a_name,"
                      f"m.person_b,b.\"Full name\" AS person_b_name,m.status,m.supporting_evidence_id,"
                      f"m.conflicting_evidence_id,m.rationale,m.decision_basis,m.resolution_evidence_id "
                      f"FROM profile_research_duplicates m JOIN profile_research a ON a.\"Profile ID\"=m.person_a "
                      f"JOIN profile_research b ON b.\"Profile ID\"=m.person_b {where} "
                      "ORDER BY m.county_fips,m.id LIMIT ?", (*params, limit))


def inspect_coverage(db, *, county=None, unit_id=None, axis=None, status=None, limit=100):
    limit = _limit(limit)
    clauses, params = [], []
    for column, value in (('u."County code"', county), ('u."Office or unit ID"', unit_id), ("c.axis", axis), ("c.status", status)):
        if value is not None:
            clauses.append(f"{column}=?"); params.append(value)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return _rows(db, f"SELECT c.unit_id,u.\"County code\" AS county_fips,co.\"County name\" AS county,u.\"Office or unit label as published\" AS unit,c.axis,"
                      f"c.status,c.evidence_id,c.run_id,c.assessed_at,c.limitations,c.next_task "
                      f"FROM county_research_coverage c JOIN county_research_unit_structure u ON u.\"Office or unit ID\"=c.unit_id "
                      f"JOIN county co ON co.\"County code\"=u.\"County code\" {where} "
                      'ORDER BY u."County code",u."Office or unit ID",c.axis LIMIT ?', (*params, limit))


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
                     f"FROM research_history e JOIN research_runs r ON r.id=e.run_id {where} "
                     f"ORDER BY e.recorded_at DESC,e.id LIMIT ?", (*params, limit))
    for row in rows:
        row["details"] = json.loads(row.pop("detail_json"))
    return rows


def _validate_claim_association(db, *, claim_id, person_id, evidence_id):
    claim = db.execute('SELECT "Role claim ID" AS id,"County code" AS county_fips,"Evidence record ID" AS evidence_id,"Linked profile" AS person_id,"Name as published" AS published_name FROM profile_research_role WHERE "Role claim ID"=?',
                       (claim_id,)).fetchone()
    person = db.execute('SELECT "Profile ID" AS id,"County code" AS county_fips,"Full name" AS display_name FROM profile_research WHERE "Profile ID"=?', (person_id,)).fetchone()
    if claim is None or person is None:
        raise ValueError("Unknown claim or research person")
    if claim["county_fips"] != person["county_fips"]:
        raise ValueError("Claim and person must belong to the same county")
    if claim["person_id"] is not None:
        raise ValueError("Claim is already assigned; R1 does not reassign identities")
    support = db.execute('SELECT e."Evidence record ID" AS id,e."Source ID" AS source_id,s."Publisher type" AS official_status,r.provenance FROM research_evidence e '
                         'JOIN research_sources s ON s."Source ID"=e."Source ID" JOIN research_runs r ON r.id=e."Research run ID" '
                         'JOIN profile_research_name n ON n."Evidence for this name"=e."Evidence record ID" '
                         'WHERE e."Evidence record ID"=? AND n."Profile ID"=? AND n."Name as published"=? '
                         "AND s.\"Previous source category\"='official'", (evidence_id, person_id, claim["published_name"])).fetchone()
    claim_source = db.execute('SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?', (claim["evidence_id"],)).fetchone()
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
    db.execute('UPDATE profile_research_role SET "Linked profile"=? WHERE "Role claim ID"=? AND "Linked profile" IS NULL', (person_id, claim_id))
    if db.execute("SELECT changes()").fetchone()[0] != 1:
        raise ValueError("Claim assignment changed during the operation")
    _event(db, run=run, actor=actor, kind="claim_person_associated", entity_type="role_claims",
           entity_id=claim_id, detail={"before": {"person_id": None}, "after": {"person_id": person_id},
                                       "supporting_evidence_id": evidence_id, "rationale": rationale})


def _correction_ancestry(db, claim_id):
    chain = []
    seen = set()
    current_id = claim_id
    while current_id:
        if current_id in seen:
            raise ValueError("Correction lineage contains a cycle")
        seen.add(current_id)
        row = db.execute(
            'SELECT c."Role claim ID" AS id,c."County code" AS county_fips,c."Evidence record ID" AS evidence_id,c."Earlier claim this replaces" AS supersedes_id,b.family_id,b.lineage_kind,b.selected '
            'FROM profile_research_role c JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" '
            'LEFT JOIN research_scrapes b ON b.id=e."Import batch ID" WHERE c."Role claim ID"=?', (current_id,)
        ).fetchone()
        if row is None:
            raise ValueError("Correction lineage references a missing claim")
        chain.append(dict(row))
        if not row["supersedes_id"]:
            break
        if row["lineage_kind"] != "corrected" or not row["selected"]:
            raise ValueError("Only selected corrected-batch lineage can support identity association")
        parent = db.execute(
            'SELECT c."Role claim ID" AS id,c."County code" AS county_fips,b.family_id FROM profile_research_role c '
            'JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" LEFT JOIN research_scrapes b ON b.id=e."Import batch ID" '
            'WHERE c."Role claim ID"=?', (row["supersedes_id"],)
        ).fetchone()
        if (parent is None or parent["county_fips"] != row["county_fips"] or
                parent["family_id"] != row["family_id"]):
            raise ValueError("Correction lineage crosses a county or batch family")
        current_id = row["supersedes_id"]
    return chain


def validate_correction_lineage_association(db, *, claim_id, person_id, anchor_claim_id):
    """Validate that two same-county claims are one explicitly linked corrected observation."""
    claim = db.execute('SELECT "Role claim ID" AS id,"County code" AS county_fips,"Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?', (claim_id,)).fetchone()
    anchor = db.execute('SELECT "Role claim ID" AS id,"County code" AS county_fips,"Linked profile" AS person_id FROM profile_research_role WHERE "Role claim ID"=?', (anchor_claim_id,)).fetchone()
    person = db.execute('SELECT "Profile ID" AS id,"County code" AS county_fips FROM profile_research WHERE "Profile ID"=?', (person_id,)).fetchone()
    if claim is None or anchor is None or person is None:
        raise ValueError("Unknown correction-linked claim or research person")
    if claim["person_id"] is not None:
        raise ValueError("Claim is already assigned; identity operations do not reassign records")
    if claim["county_fips"] != anchor["county_fips"] or claim["county_fips"] != person["county_fips"]:
        raise ValueError("Claim, anchor, and person must belong to the same county")
    if anchor["person_id"] != person_id:
        raise ValueError("Correction-lineage anchor must already be assigned to the selected person")
    claim_chain = _correction_ancestry(db, claim_id)
    anchor_chain = _correction_ancestry(db, anchor_claim_id)
    claim_ids, anchor_ids = {row["id"] for row in claim_chain}, {row["id"] for row in anchor_chain}
    if claim_id not in anchor_ids and anchor_claim_id not in claim_ids:
        raise ValueError("Claims are not joined by one directed correction lineage")
    support = _claim_evidence(db, county_fips=claim["county_fips"], claim_id=claim_id,
                              published_name=db.execute('SELECT "Name as published" AS published_name FROM profile_research_role WHERE "Role claim ID"=?',
                                                         (claim_id,)).fetchone()[0],
                              evidence_id=db.execute('SELECT "Evidence record ID" AS evidence_id FROM profile_research_role WHERE "Role claim ID"=?',
                                                     (claim_id,)).fetchone()[0])
    anchor_row = db.execute('SELECT "Name as published" AS published_name,"Evidence record ID" AS evidence_id FROM profile_research_role WHERE "Role claim ID"=?',
                            (anchor_claim_id,)).fetchone()
    _claim_evidence(db, county_fips=anchor["county_fips"], claim_id=anchor_claim_id,
                    published_name=anchor_row["published_name"], evidence_id=anchor_row["evidence_id"],
                    allow_assigned_person_id=person_id)
    return {"claim_id": claim_id, "person_id": person_id, "anchor_claim_id": anchor_claim_id,
            "lineage_claim_ids": sorted(claim_ids | anchor_ids), "support": support}


def _associate_claim_by_correction_lineage_in_transaction(db, *, claim_id, person_id,
                                                           anchor_claim_id, rationale, actor, run):
    validated = validate_correction_lineage_association(
        db, claim_id=claim_id, person_id=person_id, anchor_claim_id=anchor_claim_id)
    db.execute('UPDATE profile_research_role SET "Linked profile"=? WHERE "Role claim ID"=? AND "Linked profile" IS NULL',
               (person_id, claim_id))
    if db.execute("SELECT changes()").fetchone()[0] != 1:
        raise ValueError("Claim assignment changed during the operation")
    _event(db, run=run, actor=actor, kind="claim_person_associated", entity_type="role_claims",
           entity_id=claim_id, detail={"before": {"person_id": None}, "after": {"person_id": person_id},
                                      "supporting_evidence_id": validated["support"][1]["id"],
                                      "anchor_claim_id": anchor_claim_id,
                                      "lineage_claim_ids": validated["lineage_claim_ids"],
                                      "decision_basis": "selected_corrected_batch_lineage",
                                      "rationale": rationale})


def associate_claim_by_correction_lineage(db, *, claim_id, person_id, anchor_claim_id, rationale, actor):
    """Associate only when a selected corrected batch explicitly links the claim to its anchor."""
    if not all(isinstance(value, str) and value.strip()
               for value in (claim_id, person_id, anchor_claim_id, rationale, actor)):
        raise ValueError("Claim, person, anchor, rationale, and operator are required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        validated = validate_correction_lineage_association(
            db, claim_id=claim_id, person_id=person_id, anchor_claim_id=anchor_claim_id)
        evidence = validated["support"][1]
        run = _create_screening_run(db, provenance=evidence["provenance"], actor=actor,
                                    note="R2 direct corrected-batch identity association")
        _associate_claim_by_correction_lineage_in_transaction(
            db, claim_id=claim_id, person_id=person_id, anchor_claim_id=anchor_claim_id,
            rationale=rationale, actor=actor, run=run)
        db.commit()
        return {"claim_id": claim_id, "person_id": person_id, "anchor_claim_id": anchor_claim_id,
                "run_id": run["id"]}
    except Exception:
        db.rollback()
        raise


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


_ROLE_CONNECTION_CUES = (
    "also serves as", "also holds", "also works as", "also listed as", "in addition to",
    "same person as", "is the same person", "serves in both", "holds both roles",
)
_NONROLE_RESPONSIBILITIES = {"listed in official source"}


def _optional(row, key):
    try:
        return row[key]
    except (KeyError, IndexError):
        return None


def _documented_role_values(claim):
    """Documented office, position and job-description text (office text only when selected)."""
    return [value for value in (_optional(claim, "office_label"), _optional(claim, "division_label"),
                                _optional(claim, "unit_label"), claim["published_title"], claim["responsibility"])
            if isinstance(value, str) and value.strip()
            and value.strip().casefold() not in _NONROLE_RESPONSIBILITIES]


def validate_claim_connection(db, *, claim_id, person_id, evidence_id):
    """Require one official record to name the person, claim role, and direct link between them."""
    claim = db.execute('SELECT "Role claim ID" AS id,"County code" AS county_fips,"Evidence record ID" AS evidence_id,"Linked profile" AS person_id,"Name as published" AS published_name,"Position as published" AS published_title,"Job description or duties" AS responsibility '
                       'FROM profile_research_role WHERE "Role claim ID"=?', (claim_id,)).fetchone()
    person = db.execute('SELECT "Profile ID" AS id,"County code" AS county_fips,"Full name" AS display_name FROM profile_research WHERE "Profile ID"=?', (person_id,)).fetchone()
    evidence = db.execute('SELECT e."Evidence record ID" AS id,e."Source ID" AS source_id,e."Original record" AS raw_record_json,e."Evidence excerpt" AS quotation,e."Source title as observed" AS observed_title,e."Import batch ID" AS batch_id,'
                          's."Publisher type" AS official_status,b.county_fips AS batch_county,r.provenance '
                          'FROM research_evidence e JOIN research_sources s ON s."Source ID"=e."Source ID" '
                          'JOIN research_runs r ON r.id=e."Research run ID" LEFT JOIN research_scrapes b ON b.id=e."Import batch ID" '
                          'WHERE e."Evidence record ID"=?', (evidence_id,)).fetchone()
    if claim is None or person is None or evidence is None:
        raise ValueError("Unknown claim, person, or identity-link evidence")
    if claim["person_id"] is not None:
        raise ValueError("Claim is already assigned; identity operations do not reassign records")
    if claim["county_fips"] != person["county_fips"]:
        raise ValueError("Claim and person must belong to the same county")
    if evidence["official_status"] != "official":
        raise ValueError("Identity-link evidence must come from a source classified as official")
    if evidence["batch_county"] is not None and evidence["batch_county"] != person["county_fips"]:
        raise ValueError("Identity-link evidence belongs to a different county")
    if evidence["batch_county"] is None:
        linked = db.execute(
            'SELECT 1 FROM profile_research_name n JOIN research_evidence known ON known."Evidence record ID"=n."Evidence for this name" '
            'WHERE n."Profile ID"=? AND known."Source ID"=? UNION ALL '
            'SELECT 1 FROM county_research_unit_sources l JOIN county_research_unit_structure u ON u."Office or unit ID"=l.unit_id '
            'WHERE l.evidence_id=? AND u."County code"=? LIMIT 1',
            (person_id, evidence["source_id"], evidence_id, person["county_fips"]),
        ).fetchone()
        if linked is None:
            linked = db.execute(
                'SELECT 1 FROM profile_research_role c JOIN research_evidence known ON known."Evidence record ID"=c."Evidence record ID" '
                'WHERE known."Source ID"=? GROUP BY known."Source ID" '
                'HAVING count(DISTINCT c."County code")=1 AND min(c."County code")=?',
                (evidence["source_id"], person["county_fips"]),
            ).fetchone()
        if linked is None:
            raise ValueError("Identity-link evidence is not established in this person’s county context")
    known_names = {person["display_name"]}
    known_names.update(row[0] for row in db.execute('SELECT "Name as published" AS published_name FROM profile_research_name WHERE "Profile ID"=?',
                                                    (person_id,)))
    text = _evidence_text(evidence)
    role_values = _documented_role_values(claim)
    folded = text.casefold()
    if claim["published_name"] not in text or not any(value.casefold() in folded for value in role_values):
        raise ValueError("Identity-link evidence must contain the exact claim name and documented role")
    if not any(name in text for name in known_names):
        raise ValueError("Identity-link evidence must name the established person")
    if not any(cue in folded for cue in _ROLE_CONNECTION_CUES):
        raise ValueError("Identity-link evidence must explicitly connect the person to the role")
    return claim, person, evidence


def associate_claim_by_connection(db, *, claim_id, person_id, evidence_id, rationale, actor):
    """Associate a role only when official evidence explicitly connects both names and roles."""
    if not all(isinstance(value, str) and value.strip()
               for value in (claim_id, person_id, evidence_id, rationale, actor)):
        raise ValueError("Claim, person, identity-link evidence, rationale, and operator are required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before an operator update")
    try:
        db.execute("BEGIN IMMEDIATE")
        claim, person, evidence = validate_claim_connection(
            db, claim_id=claim_id, person_id=person_id, evidence_id=evidence_id)
        run = _create_screening_run(db, provenance=evidence["provenance"], actor=actor,
                                    note="R2 direct official role-connection association")
        db.execute('UPDATE profile_research_role SET "Linked profile"=? WHERE "Role claim ID"=? AND "Linked profile" IS NULL',
                   (person_id, claim_id))
        if db.execute("SELECT changes()").fetchone()[0] != 1:
            raise ValueError("Claim assignment changed during the operation")
        _event(db, run=run, actor=actor, kind="claim_person_associated", entity_type="role_claims",
               entity_id=claim_id, detail={"before": {"person_id": None}, "after": {"person_id": person_id},
                                          "supporting_evidence_id": evidence_id,
                                          "decision_basis": "explicit_official_role_connection",
                                          "rationale": rationale})
        db.commit()
        return {"claim_id": claim_id, "person_id": person_id, "evidence_id": evidence_id,
                "run_id": run["id"]}
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


def _claim_evidence(db, *, county_fips, claim_id, published_name, evidence_id,
                    allow_assigned_person_id=None):
    evidence = db.execute('SELECT e."Evidence record ID" AS id,e."Source ID" AS source_id,e."Original record" AS raw_record_json,e."Evidence excerpt" AS quotation,e."Source title as observed" AS observed_title,e."Research run ID" AS run_id,'
                          'e."Import batch ID" AS batch_id,s."Publisher type" AS official_status,r.provenance,b.county_fips AS batch_county '
                          'FROM research_evidence e JOIN research_sources s ON s."Source ID"=e."Source ID" '
                          'JOIN research_runs r ON r.id=e."Research run ID" '
                          'LEFT JOIN research_scrapes b ON b.id=e."Import batch ID" WHERE e."Evidence record ID"=?', (evidence_id,)).fetchone()
    claim = db.execute('SELECT "Role claim ID" AS id,"County code" AS county_fips,"Evidence record ID" AS evidence_id,"Linked profile" AS person_id,"Name as published" AS published_name,"Position as published" AS published_title,"Job description or duties" AS responsibility,'
                       '"Office or department as published" AS office_label,"Division or unit as published" AS division_label,'
                       '(SELECT u."Office or unit label as published" FROM county_research_unit_structure u WHERE u."Office or unit ID"=profile_research_role."Linked office or unit") AS unit_label '
                       'FROM profile_research_role WHERE "Role claim ID"=?', (claim_id,)).fetchone()
    if claim is None:
        raise ValueError("Unknown role claim")
    if db.execute('SELECT 1 FROM county WHERE "County code"=?', (county_fips,)).fetchone() is None:
        raise ValueError("Unknown county FIPS")
    if claim["county_fips"] != county_fips:
        raise ValueError("Selected claim does not belong to the explicit county")
    if claim["published_name"] != published_name:
        raise ValueError("Published name must exactly preserve the selected claim’s source wording")
    if claim["person_id"] is not None and claim["person_id"] != allow_assigned_person_id:
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
    role_values = _documented_role_values(claim)
    folded_cells_and_quote = "\n".join([*cells, quote]).casefold()
    supports_position = any(value.casefold() in folded_cells_and_quote for value in role_values)
    if not supports_name or not supports_position:
        raise ValueError("Official evidence must contain the claim’s exact published name and a documented office, position or job description")
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
        db.execute('INSERT INTO profile_research("Profile ID","County code","Full name","Identity review status","Evidence for identity") '
                   "VALUES (?,?,?,'evidence_supported',?)",
                   (person_id, claim["county_fips"], claim["published_name"], evidence_id))
        _event(db, run=run, actor=actor, kind="research_person_created", entity_type="research_people",
               entity_id=person_id, detail={"before": None, "after": {"person_id": person_id,
                   "county_fips": claim["county_fips"], "display_name": claim["published_name"],
                   "identity_state": "evidence_supported", "identity_evidence_id": evidence_id},
                   "claim_id": claim_id, "supporting_evidence_id": evidence_id, "rationale": rationale})
        db.execute('INSERT INTO profile_research_name("Name record ID","Profile ID","Name as published","Name type","Evidence for this name") '
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


def _nickname_field_link(evidence, known_names, candidate):
    if not evidence["raw_record_json"]:
        return False
    try:
        record = json.loads(evidence["raw_record_json"])
    except (TypeError, json.JSONDecodeError):
        return False
    headers, cells = record.get("headers"), record.get("cells")
    if not isinstance(headers, list) or not isinstance(cells, list) or len(headers) != len(cells):
        return False
    fields = dict(zip(headers, cells, strict=True))
    full_name, nicknames = fields.get("Full name"), fields.get("Nicknames")
    if not isinstance(full_name, str) or full_name not in known_names or not isinstance(nicknames, str):
        return False
    parts = [part.strip() for part in re.split(r"\s*(?:;|\||/|,|\band\b|&)\s*", nicknames, flags=re.IGNORECASE)
             if part.strip()]
    return candidate in parts


def validate_nickname_field_variant(db, *, person_id, published_name, evidence_id):
    """Check a Nicknames-cell link without changing data; safe inside a caller transaction."""
    person = db.execute('SELECT "Profile ID" AS id,"County code" AS county_fips,"Full name" AS display_name FROM profile_research WHERE "Profile ID"=?', (person_id,)).fetchone()
    if person is None:
        raise ValueError("Unknown research person")
    evidence = db.execute('SELECT e."Evidence record ID" AS id,e."Source ID" AS source_id,e."Original record" AS raw_record_json,e."Import batch ID" AS batch_id,s."Publisher type" AS official_status,'
                          "b.county_fips AS batch_county FROM research_evidence e "
                          'JOIN research_sources s ON s."Source ID"=e."Source ID" LEFT JOIN research_scrapes b ON b.id=e."Import batch ID" '
                          'WHERE e."Evidence record ID"=?', (evidence_id,)).fetchone()
    if evidence is None or evidence["official_status"] != "official":
        raise ValueError("Name-variant evidence must come from a source classified as official")
    if evidence["batch_county"] is not None and evidence["batch_county"] != person["county_fips"]:
        raise ValueError("Name-variant evidence belongs to a different county")
    known_names = {person["display_name"]}
    known_names.update(row[0] for row in db.execute('SELECT "Name as published" AS published_name FROM profile_research_name WHERE "Profile ID"=?',
                                                    (person_id,)))
    if evidence["batch_county"] is None:
        linked = db.execute('SELECT 1 FROM profile_research_name n JOIN research_evidence known ON known."Evidence record ID"=n."Evidence for this name" '
                            'WHERE n."Profile ID"=? AND known."Source ID"=? LIMIT 1',
                            (person_id, evidence["source_id"])).fetchone()
        if linked is None:
            raise ValueError("Evidence is not established in this person’s county context")
    if not _nickname_field_link(evidence, known_names, published_name):
        raise ValueError("Official evidence must list the exact nickname in a Nicknames field alongside an established name")
    return {"person_id": person_id, "published_name": published_name, "evidence_id": evidence_id}


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
        person = db.execute('SELECT "Profile ID" AS id,"County code" AS county_fips,"Full name" AS display_name,"Evidence for identity" AS identity_evidence_id FROM profile_research WHERE "Profile ID"=?',
                            (person_id,)).fetchone()
        if person is None:
            raise ValueError("Unknown research person")
        evidence = db.execute('SELECT e."Evidence record ID" AS id,e."Source ID" AS source_id,e."Evidence excerpt" AS quotation,e."Original record" AS raw_record_json,e."Source title as observed" AS observed_title,'
                              'e."Research run ID" AS run_id,e."Import batch ID" AS batch_id,s."Publisher type" AS official_status,r.provenance,b.county_fips AS batch_county '
                              'FROM research_evidence e JOIN research_sources s ON s."Source ID"=e."Source ID" '
                              'JOIN research_runs r ON r.id=e."Research run ID" '
                              'LEFT JOIN research_scrapes b ON b.id=e."Import batch ID" WHERE e."Evidence record ID"=?', (evidence_id,)).fetchone()
        if evidence is None:
            raise ValueError("Unknown supporting evidence")
        if evidence["official_status"] != "official":
            raise ValueError("Name-variant evidence must come from a source classified as official")
        if evidence["batch_county"] is not None and evidence["batch_county"] != person["county_fips"]:
            raise ValueError("Name-variant evidence belongs to a different county")
        if evidence["batch_county"] is None:
            linked = db.execute('SELECT 1 FROM profile_research_name n JOIN research_evidence known ON known."Evidence record ID"=n."Evidence for this name" '
                                'WHERE n."Profile ID"=? AND known."Source ID"=? UNION ALL '
                                'SELECT 1 FROM county_research_unit_sources l JOIN county_research_unit_structure u ON u."Office or unit ID"=l.unit_id '
                                'WHERE l.evidence_id=? AND u."County code"=? LIMIT 1',
                                (person_id, evidence["source_id"], evidence_id, person["county_fips"])).fetchone()
            if linked is None:
                raise ValueError("Evidence is not established in this person’s county context")
        text = _evidence_text(evidence)
        known_names = [person["display_name"]]
        known_names.extend(row[0] for row in db.execute('SELECT "Name as published" AS published_name FROM profile_research_name WHERE "Profile ID"=?',
                                                         (person_id,)))
        nickname_field_link = (kind == "nickname" and
                               _nickname_field_link(evidence, set(known_names), published_name))
        if not _explicit_name_link(text, known_names, published_name) and not nickname_field_link:
            raise ValueError("Official evidence must explicitly connect the exact variant to an established name for this person")
        duplicate = db.execute('SELECT "Name record ID" AS id FROM profile_research_name WHERE "Profile ID"=? AND "Name as published"=? AND "Name type"=? AND "Evidence for this name"=?',
                               (person_id, published_name, kind, evidence_id)).fetchone()
        if duplicate:
            db.commit()
            return {"variant_id": duplicate[0], "person_id": person_id, "created": False}
        variant_id = new_id("variant")
        run = _create_screening_run(db, provenance=evidence["provenance"], actor=actor,
                                    note="R2 evidence-supported name variant")
        db.execute('INSERT INTO profile_research_name("Name record ID","Profile ID","Name as published","Name type","Evidence for this name") VALUES (?,?,?,?,?)',
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
        source = db.execute('SELECT "Source ID" AS id FROM research_sources WHERE "Source ID"=?', (source_id,)).fetchone()
        if source is None:
            raise ValueError("Unknown source")
        if provenance == "reconstructed" and not evidence_id:
            raise ValueError("Reconstructed visits require supporting evidence")
        if evidence_id:
            evidence = db.execute('SELECT "Source ID" AS source_id FROM research_evidence WHERE "Evidence record ID"=?', (evidence_id,)).fetchone()
            if evidence is None or evidence["source_id"] != source_id:
                raise ValueError("Visit evidence must belong to the selected source")
        visit_id = new_id("visit")
        columns = ("id,source_id,run_id,provenance,evidence_id,reported_checked_date,attempted_at,actor,attempt,outcome,"
                   "http_status,duration_ms,content_sha256,etag,last_modified,result_count,note")
        values = (visit_id, source_id, run_id, provenance, evidence_id, reported_checked_date, attempted_at, actor,
                  attempt, outcome, http_status, duration_ms, content_sha256, etag, last_modified, result_count, note)
        db.execute(f"INSERT INTO research_source_visits({columns}) VALUES ({','.join('?' for _ in values)})", values)
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
        unit = db.execute('SELECT "Office or unit ID" AS id FROM county_research_unit_structure WHERE "Office or unit ID"=?', (unit_id,)).fetchone()
        if unit is None:
            raise ValueError("Unknown organization unit")
        if evidence_id and db.execute('SELECT 1 FROM research_evidence WHERE "Evidence record ID"=?', (evidence_id,)).fetchone() is None:
            raise ValueError("Unknown supporting evidence")
        run = _run(db, run_id) if run_id else None
        previous = db.execute("SELECT status,evidence_id,run_id,assessed_at,limitations,next_task "
                              "FROM county_research_coverage WHERE unit_id=? AND axis=?", (unit_id, axis)).fetchone()
        if previous is None:
            raise ValueError("Unknown coverage dimension")
        now = assessed_at or timestamp()
        db.execute("UPDATE county_research_coverage SET status=?,evidence_id=?,run_id=?,assessed_at=?,limitations=?,next_task=? "
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

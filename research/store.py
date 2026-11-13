"""Transactional mapping into the private research model, without identity inference."""

from datetime import datetime, timezone
from uuid import uuid4, uuid5, NAMESPACE_URL

from research.mapping import canonical_json, mapping_definition, parse_csv


def new_id(kind):
    return f"{kind}_{uuid4()}"


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def _delivery_result(batch, *, created, version, file_sha256, county, record_count,
                     claim_count, duplicate_count, lineage_kind, parent_batch_id, family_id, selected):
    return {"batch_id": batch, "mapping_version": version, "file_sha256": file_sha256,
            "county_fips": county, "record_count": record_count, "distinct_claims": claim_count,
            "duplicate_rows": duplicate_count, "family_id": family_id,
            "lineage_kind": lineage_kind, "parent_batch_id": parent_batch_id,
            "selected": bool(selected), "created": created,
            "status": "created" if created else "replayed"}


def ingest_csv(db, payload, *, file_name, version_label, version="legacy-17/v1",
               provenance="synthetic", lineage_kind="original", parent_batch_id=None,
               selected=False, registry=None, supersedes=None, return_result=False):
    """Map one county delivery. Caller supplies lineage; no county/person/unit guessing.

    Exact repeats coalesce only within this file version. Every original occurrence
    retains its raw text and line locator. Corrections are nonadditive family members.
    This API is local only; R0 exercises it exclusively with synthetic input.
    """
    if db.in_transaction:
        raise ValueError("Finish current transaction before ingest")
    parsed = parse_csv(payload, version, registry)
    spec = parsed["mapping"]
    mapping_json = canonical_json(mapping_definition(spec))
    rows = parsed["rows"]
    counties = {r["values"]["county_fips"] for r in rows}
    if len(counties) != 1:
        raise ValueError("A delivery must contain observations for exactly one county")
    county = next(iter(counties))
    if provenance not in ("synthetic", "legacy_delivery"):
        raise ValueError("CSV mapping supports synthetic or legacy_delivery provenance")
    supersedes = {} if supersedes is None else supersedes
    if not set(supersedes) <= {r["record_number"] for r in rows}:
        raise ValueError("Unknown correction record locator")
    if supersedes and lineage_kind not in ("corrected", "alternative"):
        raise ValueError("Correction links require a version relationship")
    grouped = {}
    for row in rows:
        grouped.setdefault(row["row_sha256"], []).append(row)
    correction_links = {}
    for digest, occurrences in grouped.items():
        parents = {supersedes[o["record_number"]] for o in occurrences if o["record_number"] in supersedes}
        if len(parents) > 1:
            raise ValueError("Duplicate observations cannot supersede different claims")
        correction_links[digest] = next(iter(parents), None)
    if lineage_kind not in ("original", "complementary", "corrected", "alternative"):
        raise ValueError("Invalid delivery lineage kind")
    if lineage_kind in ("original", "complementary") and parent_batch_id is not None:
        raise ValueError("Original and complementary deliveries cannot have a parent")
    if lineage_kind in ("corrected", "alternative") and parent_batch_id is None:
        raise ValueError("Corrected and alternative deliveries require a parent batch")
    batch_id, run_id, now = new_id("batch"), new_id("run"), timestamp()
    with db:
        # Serialize replay and selection checks with the write transaction.
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT * FROM scrape_batches WHERE county_fips=? AND file_sha256=? AND mapping_version=?",
            (county, parsed["file_sha256"], version),
        ).fetchone()
        parent = db.execute("SELECT * FROM scrape_batches WHERE id=?", (parent_batch_id,)).fetchone()
        if parent_batch_id and (not parent or parent["county_fips"] != county):
            raise ValueError("Parent batch missing or from another county")
        if existing:
            if (existing["lineage_kind"], existing["parent_batch_id"], existing["version_label"],
                    existing["original_file_name"], existing["provenance_type"]) != (
                    lineage_kind, parent_batch_id, version_label, file_name, provenance):
                raise ValueError("Same delivery bytes already recorded with different metadata")
            if existing["mapping_json"] != mapping_json:
                raise ValueError("Mapping definition changed without a version change")
            for digest in grouped:
                prior = db.execute(
                    "SELECT c.supersedes_id FROM role_claims c JOIN evidence_links e ON e.id=c.evidence_id "
                    "WHERE e.batch_id=? AND e.raw_record_sha256=?",
                    (existing["id"], digest),
                ).fetchone()
                if prior[0] != correction_links[digest]:
                    raise ValueError("Replay correction links differ from recorded lineage")
            if return_result:
                counts = db.execute("SELECT count(*) FROM role_claims c JOIN evidence_links e ON e.id=c.evidence_id "
                                    "WHERE e.batch_id=?", (existing["id"],)).fetchone()[0]
                return _delivery_result(existing["id"], created=False, version=version,
                                        file_sha256=parsed["file_sha256"], county=county,
                                        record_count=len(rows), claim_count=counts,
                                        duplicate_count=len(rows) - len(grouped),
                                        lineage_kind=existing["lineage_kind"],
                                        parent_batch_id=existing["parent_batch_id"],
                                        family_id=existing["family_id"], selected=existing["selected"])
            return existing["id"]
        family_id = parent["family_id"] if parent else batch_id
        run_provenance = "synthetic" if provenance == "synthetic" else "observed"
        db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
                   (run_id, "mapping", run_provenance, now))
        if selected:
            db.execute("UPDATE scrape_batches SET selected=0 WHERE family_id=?", (family_id,))
        db.execute(
            "INSERT INTO scrape_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (batch_id, county, family_id, parent_batch_id, lineage_kind, int(selected), version_label,
             file_name, parsed["file_sha256"], version,
             mapping_json, provenance, run_id, now),
        )
        for digest, occurrences in grouped.items():
            row = occurrences[0]
            v = row["values"]
            source = db.execute("SELECT id FROM sources WHERE original_url=?", (v["source_url"],)).fetchone()
            source_id = source[0] if source else new_id("source")
            if not source:
                db.execute("INSERT INTO sources(id,original_url,recorded_at) VALUES (?,?,?)",
                           (source_id, v["source_url"], now))
            evidence_id = f"evidence_{uuid5(NAMESPACE_URL, batch_id + ':' + digest)}"
            claim_id = f"claim_{uuid5(NAMESPACE_URL, evidence_id)}"
            parent_claim_id = correction_links[digest]
            parent_evidence_id = None
            if parent_claim_id:
                prior = db.execute(
                    "SELECT c.evidence_id FROM role_claims c JOIN evidence_links e ON e.id=c.evidence_id "
                    "WHERE c.id=? AND e.batch_id=? AND c.county_fips=?",
                    (parent_claim_id, parent_batch_id, county),
                ).fetchone()
                if not prior:
                    raise ValueError("Correction must reference a claim in the specified parent batch")
                parent_evidence_id = prior[0]
            db.execute(
                "INSERT INTO evidence_links(id,source_id,source_version_key,observed_title,observed_url,"
                "source_date,source_date_precision,source_date_basis,reported_checked_date,locator,"
                "batch_id,raw_record_json,raw_record_sha256,occurrences_json,supersedes_id,run_id,recorded_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (evidence_id, source_id, None, v["source_title"], v["source_url"],
                 v["source_date"] or None, row["source_date_precision"], "reported" if v["source_date"] else None,
                 v["checked_date"] or None, f"record:{row['record_number']}", batch_id,
                 canonical_json({"headers": spec.headers, "cells": row["cells"]}), digest,
                 canonical_json([{k: o[k] for k in ("record_number", "line_start", "line_end", "raw_text")}
                                 for o in occurrences]), parent_evidence_id, run_id, now),
            )
            db.execute(
                "INSERT INTO role_claims(id,county_fips,evidence_id,published_name,published_title,"
                "responsibility,source_listing_status,legacy_display_group,grouping_basis,department_label,"
                "division_label,program_location,private_note,supersedes_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (claim_id, county, evidence_id, v["full_name"], v["title"] or None, v["responsibility"] or None,
                 ("Listed" if v["listing_status"] == "Listed in official source" else v["listing_status"]), v["display_group"], v["grouping_basis"], v["department"], v["division"],
                 v["program_location"], v["private_note"], parent_claim_id),
            )
        db.execute("INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
                   (new_id("event"), run_id, "delivery_mapped", "scrape_batches", batch_id, now, now,
                    run_provenance, canonical_json({"records": len(rows), "claims": len(grouped),
                                                   "duplicates": len(rows) - len(grouped)})))
    if return_result:
        return _delivery_result(batch_id, created=True, version=version,
                                file_sha256=parsed["file_sha256"], county=county,
                                record_count=len(rows), claim_count=len(grouped),
                                duplicate_count=len(rows) - len(grouped),
                                lineage_kind=lineage_kind, parent_batch_id=parent_batch_id,
                                family_id=family_id, selected=selected)
    return batch_id


def set_parent(db, *, unit_id, parent_id, relation, evidence_id, run_id):
    """Record one current evidenced parent edge and retain the previous edge in audit.

    This encodes an already researched decision; it does not infer authority from
    labels, verify a citation's truth, or determine a county's real structure.
    """
    if db.in_transaction:
        raise ValueError("Finish current transaction before setting a parent")
    with db:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(
            "SELECT parent_id,parent_relation,parent_evidence_id FROM org_units WHERE id=?", (unit_id,),
        ).fetchone()
        if previous is None:
            raise ValueError("Unknown organization unit")
        db.execute("UPDATE org_units SET parent_id=?,parent_relation=?,parent_evidence_id=? WHERE id=?",
                   (parent_id, relation, evidence_id, unit_id))
        now = timestamp()
        db.execute("INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
                   (new_id("event"), run_id, "parent_changed", "org_units", unit_id, now, now, "observed",
                    canonical_json({"before": dict(previous), "after": {
                        "parent_id": parent_id, "parent_relation": relation, "parent_evidence_id": evidence_id,
                    }})))

"""Disposable synthetic SQLite fixture/bridge used by the R7 D1 integration test."""

import hashlib, json, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research.db import connect, migrate
from research.sync import (
    build_changeset,
    prepare_research_submission,
    reconcile_submission,
    approve_site_update,
    reconcile_reversal,
)
from research.mapping import canonical_json
from research.store import timestamp
from research.submission import submit_prepared

SITE = "r7-synthetic-site"
NOW = datetime.now(timezone.utc).isoformat(timespec="seconds")


def setup(path):
    db = connect(path)
    migrate(db)
    db.execute("INSERT INTO counties VALUES ('08001','Adams')")
    db.execute(
        "INSERT INTO research_runs VALUES ('run','mapping','synthetic','fixture',?,?,?,'synthetic fixture')",
        (NOW, NOW, NOW),
    )
    db.execute(
        "INSERT INTO scrape_batches(id,county_fips,family_id,lineage_kind,selected,version_label,original_file_name,file_sha256,mapping_version,mapping_json,provenance_type,run_id,recorded_at) VALUES ('batch','08001','batch','original',1,'fixture','fixture.csv',?,'fixture/v1','{}','synthetic','run',?)",
        (hashlib.sha256(b"fixture").hexdigest(), NOW),
    )
    sources = [
        ("src1", "https://example.invalid/adams/official", "official_page"),
        ("src2", "https://example.invalid/adams/document", "public_document"),
        ("src3", "https://example.invalid/adams/unclear", "unknown"),
    ]
    for i, (sid, url, kind) in enumerate(sources):
        db.execute(
            'INSERT INTO sources("Source ID","Original source URL","Document type","Previous source category","Publisher type","Recorded on") '
            "VALUES(?,?,?,'official','official',?)",
            (sid, url, kind, NOW),
        )
    ev = {}

    def evidence(key, source):
        eid = "ev_" + key
        url = dict((x[0], x[1]) for x in sources)[source]
        raw = json.dumps({"fixture": key})
        db.execute(
            "INSERT INTO evidence_links(\"Evidence record ID\",\"Source ID\",\"Source title as observed\",\"Source URL as observed\",\"Evidence location\",\"Import batch ID\",\"Original record\",\"Original record fingerprint\",\"Where the record appeared\",\"Research run ID\",\"Recorded on\") VALUES(?,?,?,?,?,'batch',?,?,?,?,?)",
            (
                eid,
                source,
                "Synthetic official " + key,
                url,
                "fixture location",
                raw,
                hashlib.sha256(key.encode()).hexdigest(),
                json.dumps([1]),
                "run",
                NOW,
            ),
        )
        ev[key] = eid
        return eid

    for key, sid in [
        ("office", "src1"),
        ("dept", "src1"),
        ("division", "src1"),
        ("partner", "src2"),
        ("role-a1", "src1"),
        ("role-a2", "src2"),
        ("role-b", "src1"),
        ("role-open", "src1"),
        ("role-ambiguous", "src3"),
    ]:
        evidence(key, sid)
    units = [
        ("office", "elected_office", None),
        ("department", "department", None),
        ("division", "division", "department"),
        ("partner", "partner", None),
    ]
    for uid, kind, parent in units:
        db.execute(
            "INSERT INTO org_units(\"Office or unit ID\",\"County code\",\"Office or unit label as published\",\"Organization type\",\"Parent office or unit\",\"Relationship to parent\",\"Evidence for parent relationship\") VALUES(?,'08001',?,?,?, ?,?)",
            (
                uid,
                kind.title()
                + (
                    " Office"
                    if kind == "elected_office"
                    else (
                        " Department"
                        if kind == "department"
                        else " Division" if kind == "division" else " Partnership"
                    )
                ),
                kind,
                parent,
                "administrative" if parent else None,
                ev["division"] if parent else None,
            ),
        )
        ev_key = {"department": "dept"}.get(uid, uid)
        db.execute(
            "INSERT INTO org_names(\"Office name record ID\",\"Office or unit ID\",\"Name\",\"Name type\",\"Evidence for this name\") VALUES(?,?,?,'published',?)",
            ("name-" + uid, uid, uid, ev[ev_key]),
        )
    targets = [
        ("target-a1", "division", "Synthetic Inspector"),
        ("target-a2", "department", "Synthetic Treasurer"),
        ("target-b", "office", "Synthetic Clerk"),
        ("target-p", "partner", "Synthetic Liaison"),
        ("target-open", "division", "Synthetic Unresolved"),
    ]
    for tid, unit, title in targets:
        db.execute(
            "INSERT INTO role_targets(\"Position ID\",\"Office or unit ID\",\"County code\",\"Documented position title\",\"Evidence for position\") VALUES(?,?,'08001',?,?)",
            (
                tid,
                unit,
                title,
                ev[
                    (
                        "division"
                        if unit == "division"
                        else (
                            "dept"
                            if unit == "department"
                            else "office" if unit == "office" else "partner"
                        )
                    )
                ],
            ),
        )
    people = [
        ("person-a", "Synthetic Jordan Example", "evidence_supported", ev["role-a1"]),
        ("person-b", "Synthetic Jordan Example", "evidence_supported", ev["role-b"]),
        ("person-open", "Synthetic Unresolved Example", "provisional", None),
    ]
    for pid, name, state, evidence_id in people:
        db.execute(
            "INSERT INTO research_people(\"Profile ID\",\"County code\",\"Full name\",\"Identity review status\",\"Evidence for identity\") VALUES(?,'08001',?,?,?)",
            (pid, name, state, evidence_id),
        )
    claims = [
        ("claim-a1", "person-a", "division", "target-a1", "role-a1", None),
        ("claim-a2", "person-a", "department", "target-a2", "role-a2", None),
        ("claim-b", "person-b", "office", "target-b", "role-b", None),
        ("claim-open", "person-open", "division", "target-open", "role-open", None),
        (
            "claim-partner",
            "person-a",
            "partner",
            "target-p",
            "role-p",
            "Synthetic shared partnership",
        ),
        (
            "claim-ambiguous",
            "person-b",
            "division",
            "target-a1",
            "role-ambiguous",
            None,
        ),
    ]
    evidence("role-p", "src2")
    for cid, pid, unit, target, key, aff in claims:
        db.execute(
            "INSERT INTO role_claims(\"Role claim ID\",\"County code\",\"Evidence record ID\",\"Linked profile\",\"Linked office or unit\",\"Linked position\",\"Name as published\",\"Position as published\",\"Listing status\",\"Affiliation\",\"Private review notes\") VALUES(?,'08001',?,?,?,?,?,?,'Listed',?,'PRIVATE FIXTURE NOTE MUST NOT LEAVE SQLITE')",
            (
                cid,
                ev[key],
                pid,
                unit,
                target,
                (
                    dict(people)[pid]
                    if False
                    else next(p[1] for p in people if p[0] == pid)
                ),
                next(t[2] for t in targets if t[0] == target),
                aff,
            ),
        )
    db.commit()
    generated = build_changeset(db, SITE)
    prepared = prepare_research_submission(
        db, SITE, "r7-fixture-initial-key", generated, now=NOW
    )
    print(
        json.dumps(
            {
                "request": generated["request"],
                "submission_id": prepared["submission_id"],
                "eligible": generated["eligible_count"],
                "excluded": generated["excluded"],
            }
        )
    )
    db.close()


def ack(path, receipt_text, submission_id):
    db = connect(path)
    receipt = json.loads(receipt_text)

    def transport(site, path, headers, body):
        assert site == SITE and path.endswith("/commit") and headers["idempotency-key"]
        assert json.loads(body) == json.loads(
            db.execute(
                "SELECT request_json FROM sync_submissions WHERE id=?", (submission_id,)
            ).fetchone()[0]
        )
        return 201, json.dumps(receipt).encode()

    uncertain = submit_prepared(
        db, submission_id, lambda *args: (_ for _ in ()).throw(TimeoutError()), now=NOW
    )
    assert uncertain["state"] == "uncertain"
    assert db.execute("SELECT count(*) FROM site_entity_links").fetchone()[0] == 0
    first = submit_prepared(db, submission_id, transport, now=NOW)
    assert first["state"] == "acknowledged"
    result = reconcile_submission(db, submission_id, now=NOW)
    repeat = reconcile_submission(db, submission_id, now=NOW)
    assert repeat["replayed"] and result["mapped"] == len(receipt["items"])
    generated = build_changeset(db, SITE)
    assert generated["eligible_count"] == 0
    print(
        json.dumps(
            {
                "result": result,
                "repeat": repeat,
                "mapping_count": db.execute(
                    "SELECT count(*) FROM site_entity_links WHERE site_key=?", (SITE,)
                ).fetchone()[0],
                "unresolved": sum(
                    x["reason"] == "identity_unresolved" for x in generated["excluded"]
                ),
            }
        )
    )
    db.close()


def prepare_update(path):
    db = connect(path)
    evidence = db.execute(
        "SELECT \"Evidence for identity\" AS identity_evidence_id FROM research_people WHERE \"Profile ID\"='person-a'"
    ).fetchone()[0]
    approval = approve_site_update(
        db,
        SITE,
        "research_person",
        "person-a",
        {"display_name": "Synthetic Jordan Example Revised"},
        1,
        evidence,
        now=NOW,
    )
    generated = build_changeset(db, SITE)
    assert (
        generated["eligible_count"] == 1
        and generated["request"]["changes"][0]["op"] == "update_record"
    )
    prepared = prepare_research_submission(
        db, SITE, "r7-fixture-update-key", generated, now=NOW
    )
    print(
        json.dumps(
            {
                "request": generated["request"],
                "submission_id": prepared["submission_id"],
                "approval_id": approval,
            }
        )
    )
    db.close()


def ack_update(path, receipt_text, submission_id):
    db = connect(path)
    receipt = json.loads(receipt_text)
    result = submit_prepared(
        db, submission_id, lambda *args: (200, json.dumps(receipt).encode()), now=NOW
    )
    assert result["state"] == "acknowledged"
    reconciled = reconcile_submission(db, submission_id, now=NOW)
    version = db.execute(
        "SELECT website_version FROM site_entity_links WHERE site_key=? AND local_entity_type='research_person' AND local_entity_id='person-a'",
        (SITE,),
    ).fetchone()[0]
    approval_state = db.execute(
        "SELECT state FROM site_sync_update_approvals WHERE id=(SELECT approval_id FROM sync_submission_items WHERE submission_id=?)",
        (submission_id,),
    ).fetchone()[0]
    assert version == 2 and approval_state == "consumed"
    try:
        approve_site_update(
            db,
            SITE,
            "research_person",
            "person-a",
            {"display_name": "stale"},
            1,
            db.execute(
                "SELECT \"Evidence for identity\" AS identity_evidence_id FROM research_people WHERE \"Profile ID\"='person-a'"
            ).fetchone()[0],
            now=NOW,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("stale mapped Website version accepted")
    print(
        json.dumps(
            {"result": reconciled, "version": version, "approval_state": approval_state}
        )
    )
    db.close()


def reversal(path, batch_id, receipt_text):
    db = connect(path)
    result = reconcile_reversal(db, SITE, batch_id, json.loads(receipt_text), now=NOW)
    state = db.execute(
        "SELECT link_state FROM site_entity_links WHERE site_key=? AND local_entity_type='research_person' AND local_entity_id='person-a'",
        (SITE,),
    ).fetchone()[0]
    assert state == "needs_refresh"
    print(json.dumps({"result": result, "link_state": state}))
    db.close()


if __name__ == "__main__":
    {
        "setup": setup,
        "ack": ack,
        "prepare-update": prepare_update,
        "ack-update": ack_update,
        "reversal": reversal,
    }[sys.argv[1]](*sys.argv[2:])

"""County-scoped, evidence-led identity planning and application."""

import hashlib
import json
import re
from collections import defaultdict
from urllib.parse import urlsplit

from research import operator as research_operator
from research.db import validate_migration_history
from research.mapping import canonical_json
from research.store import timestamp

PLAN_FORMAT = "colorado-watchdog/identity-foundation-plan/v1"
ACTOR_DEFAULT = "evidence-based-identity-foundation"

_NONPERSON_TOKENS = {
    "agency", "board", "clerk", "committee", "commission", "council", "county",
    "department", "division", "district", "office", "position", "service", "services",
    "staff", "team", "vacant", "vacancy", "unknown", "none", "tbd", "n/a",
}
_NICKNAME_SPLIT = re.compile(r"\s*(?:;|\||/|,|\band\b|&)\s*", re.IGNORECASE)
_ALPHA = re.compile(r"[^\W\d_]", re.UNICODE)
_ROLE_CUES = ("also serves as", "also holds", "also works as", "also listed as", "in addition to",
              "same person as", "is the same person", "serves in both", "holds both roles")


def _stable_id(prefix, *parts):
    key = canonical_json(list(parts)).encode("utf-8")
    return f"{prefix}_{hashlib.sha256(key).hexdigest()[:32]}"


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _official_host(url):
    try:
        host = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    return host == "gov" or host.endswith(".gov")


def _raw_fields(raw_record_json):
    if not raw_record_json:
        return {}
    try:
        record = json.loads(raw_record_json)
    except (TypeError, json.JSONDecodeError):
        return {}
    headers, cells = record.get("headers"), record.get("cells")
    if not isinstance(headers, list) or not isinstance(cells, list) or len(headers) != len(cells):
        return {}
    return {str(header): value for header, value in zip(headers, cells, strict=True)}


def _evidence_text(row):
    fields = _raw_fields(row["raw_record_json"])
    return "\n".join([row["quotation"] or "", row["observed_title"] or "",
                      *(str(value) for value in fields.values() if value is not None)])


def _direct_name_role(row):
    fields = _raw_fields(row["raw_record_json"])
    values = [str(value) for value in fields.values() if isinstance(value, str)]
    quotation = row["quotation"] or ""
    name_supported = row["published_name"] in values or row["published_name"] in quotation
    role_values = [value for value in (row["published_title"], row["responsibility"]) if value]
    role_supported = any(value in values or value in quotation for value in role_values)
    return bool(name_supported and role_supported)


def _is_person_name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        return False
    words = [word.strip(".,'’\"()[]{}-") for word in value.split()]
    words = [word for word in words if word]
    if len(words) < 2 or any(word.casefold() in _NONPERSON_TOKENS for word in words):
        return False
    return sum(bool(_ALPHA.search(word)) for word in words) >= 2


def _is_name_form(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 120:
        return False
    words = [word.strip(".,'’\"()[]{}-") for word in value.split()]
    return bool(words) and all(word and word.casefold() not in _NONPERSON_TOKENS and _ALPHA.search(word)
                               for word in words)


def _active_batch(row):
    kind = row["lineage_kind"]
    if kind in (None, "original", "complementary"):
        return True
    if kind == "corrected":
        return bool(row["selected"])
    # Alternatives remain retained evidence, but they are not a new person or
    # independent support merely because the same row appears in another CSV.
    return False


def _role_values(row):
    return [value for value in (row["published_title"], row["responsibility"])
            if isinstance(value, str) and value]


def _cue_between(text, name, role):
    folded, known, title = text.casefold(), name.casefold(), role.casefold()
    if not known or not title:
        return False
    name_positions, role_positions = [], []
    start = 0
    while (index := folded.find(known, start)) >= 0:
        name_positions.append((index, index + len(known)))
        start = index + 1
    start = 0
    while (index := folded.find(title, start)) >= 0:
        role_positions.append((index, index + len(title)))
        start = index + 1
    for left in name_positions:
        for right in role_positions:
            if left[1] <= right[0]:
                between = folded[left[1]:right[0]]
            elif right[1] <= left[0]:
                between = folded[right[1]:left[0]]
            else:
                continue
            if len(between) <= 300 and any(cue in between for cue in _ROLE_CUES):
                return True
    return False


def _connection_evidence_rows(db, county_fips):
    """Load only direct evidence in this county's batches or established source context."""
    return [dict(row) for row in db.execute(
        "SELECT e.id,e.source_id,e.batch_id,e.raw_record_json,e.quotation,e.observed_title,"
        "s.official_status,b.county_fips AS batch_county FROM evidence_links e "
        "JOIN sources s ON s.id=e.source_id LEFT JOIN scrape_batches b ON b.id=e.batch_id "
        "WHERE b.county_fips=? OR EXISTS (SELECT 1 FROM name_variants n "
        "JOIN research_people p ON p.id=n.person_id WHERE n.evidence_id=e.id AND p.county_fips=?) "
        "OR EXISTS (SELECT 1 FROM source_unit_links l JOIN org_units u ON u.id=l.unit_id "
        "WHERE l.evidence_id=e.id AND u.county_fips=?) "
        "OR (e.batch_id IS NULL AND e.source_id IN (SELECT e2.source_id FROM role_claims c2 "
        "JOIN evidence_links e2 ON e2.id=c2.evidence_id WHERE c2.county_fips=?) "
        "AND NOT EXISTS (SELECT 1 FROM role_claims cx JOIN evidence_links ex ON ex.id=cx.evidence_id "
        "WHERE ex.source_id=e.source_id AND cx.county_fips<>?)) ORDER BY e.id",
        (county_fips, county_fips, county_fips, county_fips, county_fips))]


def _identity_connection_edges(db, county_fips, rows, *, planned_sources, allow_planned_sources):
    candidates = [row for row in rows if _active_batch(row) and _is_person_name(row["published_name"])
                 and (row["official_status"] == "official" or
                      (allow_planned_sources and row["source_id"] in planned_sources))
                 and _direct_name_role(row)]
    by_name = defaultdict(list)
    for row in candidates:
        by_name[row["published_name"]].append(row)
    names_by_first_word = defaultdict(list)
    for name in by_name:
        first_word = name.split(maxsplit=1)[0].casefold()
        names_by_first_word[first_word].append(name)
    first_words = sorted(names_by_first_word, key=lambda value: (-len(value), value))
    first_words_pattern = (re.compile(r"(?<!\w)(?:" + "|".join(re.escape(value) for value in first_words)
                                      + r")(?!\w)") if first_words else None)
    edges = {}
    for evidence in _connection_evidence_rows(db, county_fips):
        if evidence["official_status"] != "official" and not (
                allow_planned_sources and evidence["source_id"] in planned_sources):
            continue
        if evidence["batch_county"] not in (None, county_fips):
            continue
        raw_text = "\n".join((evidence["raw_record_json"] or "", evidence["quotation"] or "",
                               evidence["observed_title"] or ""))
        if not any(cue in raw_text.casefold() for cue in _ROLE_CUES):
            continue
        text = _evidence_text(evidence)
        folded = text.casefold()
        mentioned_first_words = ({match.group(0) for match in first_words_pattern.finditer(folded)}
                                 if first_words_pattern else set())
        for first_word in mentioned_first_words:
            for name in names_by_first_word[first_word]:
                if name.casefold() not in folded:
                    continue
                supported = []
                supported_roles = {}
                for row in by_name[name]:
                    roles = [role for role in _role_values(row) if role.casefold() in folded]
                    if roles:
                        supported.append(row)
                        for role in roles:
                            supported_roles.setdefault(role, []).append(row)
                if len(supported) < 2:
                    continue
                # Identical repeated titles do not identify which source entry the
                # official connection describes.
                if any(len({row["id"] for row in role_rows}) > 1
                       for role_rows in supported_roles.values()):
                    continue
                unique_roles = list(supported_roles)
                for index, first_role in enumerate(unique_roles):
                    for second_role in unique_roles[index + 1:]:
                        if not (_cue_between(text, name, first_role) or _cue_between(text, name, second_role)):
                            continue
                        first = supported_roles[first_role][0]
                        second = supported_roles[second_role][0]
                        if first["id"] == second["id"]:
                            continue
                        edges[tuple(sorted((first["id"], second["id"])))] = evidence["id"]
    return edges


def _source_proposals(db):
    sources = list(db.execute("SELECT id,original_url,official_status FROM sources ORDER BY id"))
    eligible_sources = {source["id"] for source in sources
                        if source["official_status"] == "unknown" and _official_host(source["original_url"])}
    if not eligible_sources:
        return []
    claims = db.execute(
        "SELECT c.id,c.county_fips,c.evidence_id,c.published_name,c.published_title,c.responsibility,"
        "e.source_id,e.raw_record_json,e.quotation,e.observed_title FROM role_claims c "
        "JOIN evidence_links e ON e.id=c.evidence_id ORDER BY c.county_fips,c.id"
    )
    proof = {}
    for row in claims:
        if row["source_id"] in eligible_sources and row["source_id"] not in proof and _direct_name_role(row):
            proof[row["source_id"]] = row["evidence_id"]
    proposals = []
    for source in sources:
        if source["id"] not in eligible_sources:
            continue
        evidence_id = proof.get(source["id"])
        if evidence_id is None:
            continue
        proposals.append({
            "source_id": source["id"], "evidence_id": evidence_id,
            "from_status": "unknown", "to_status": "official",
            "host": urlsplit(source["original_url"]).hostname.lower(),
            "basis": "The retained observation directly contains its published name and role, and the exact cited URL is within the restricted .gov namespace; no source visit is asserted.",
        })
    return proposals


def _load_county_claims(db, county_fips):
    rows = db.execute(
        "SELECT c.id,c.county_fips,c.evidence_id,c.person_id,c.published_name,c.published_title,"
        "c.responsibility,c.source_listing_status,c.supersedes_id,c.unit_id,c.target_id,"
        "e.source_id,e.raw_record_json,e.quotation,e.observed_title,e.batch_id,e.source_version_key,"
        "s.original_url,s.official_status,b.family_id,b.lineage_kind,b.selected,b.parent_batch_id,"
        "b.county_fips AS batch_county FROM role_claims c "
        "JOIN evidence_links e ON e.id=c.evidence_id JOIN sources s ON s.id=e.source_id "
        "LEFT JOIN scrape_batches b ON b.id=e.batch_id WHERE c.county_fips=? ORDER BY c.id",
        (county_fips,),
    )
    return [dict(row) for row in rows]


def _components(rows, identity_edges=()):
    parent = {row["id"]: row["id"] for row in rows}
    by_id = {row["id"]: row for row in rows}

    def find(item):
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    for row in rows:
        if row["lineage_kind"] != "corrected" or not row["selected"] or not row["supersedes_id"]:
            continue
        old = by_id.get(row["supersedes_id"])
        if old is None or old["county_fips"] != row["county_fips"] or old["family_id"] != row["family_id"]:
            continue
        left, right = find(row["id"]), find(old["id"])
        if left != right:
            parent[max(left, right)] = min(left, right)

    for left_id, right_id in identity_edges:
        if left_id not in parent or right_id not in parent:
            continue
        left, right = find(left_id), find(right_id)
        if left != right:
            parent[max(left, right)] = min(left, right)

    groups = defaultdict(list)
    for row in rows:
        if _active_batch(row):
            groups[find(row["id"])].append(row)
    return groups


def _is_in_correction_lineage(left, right, component):
    by_id = {row["id"]: row for row in component}

    def ancestor(descendant_id, ancestor_id):
        current = by_id.get(descendant_id)
        seen = set()
        while current and current["supersedes_id"]:
            if current["id"] in seen or current["lineage_kind"] != "corrected" or not current["selected"]:
                return False
            seen.add(current["id"])
            parent = by_id.get(current["supersedes_id"])
            if (parent is None or parent["county_fips"] != current["county_fips"] or
                    parent["family_id"] != current["family_id"]):
                return False
            if parent["id"] == ancestor_id:
                return True
            current = parent
        return False

    return ancestor(left["id"], right["id"]) or ancestor(right["id"], left["id"])


def _state_snapshot(db, county_fips, source_targets):
    claims = []
    for row in _load_county_claims(db, county_fips):
        item = dict(row)
        if item["source_id"] in source_targets:
            item["official_status"] = source_targets[item["source_id"]]
        claims.append(item)
    people = [dict(row) for row in db.execute(
        "SELECT id,county_fips,display_name,identity_state,identity_evidence_id "
        "FROM research_people WHERE county_fips=? ORDER BY id", (county_fips,))]
    variants = [dict(row) for row in db.execute(
        "SELECT n.id,n.person_id,n.published_name,n.kind,n.evidence_id FROM name_variants n "
        "JOIN research_people p ON p.id=n.person_id WHERE p.county_fips=? ORDER BY n.id", (county_fips,))]
    matches = [dict(row) for row in db.execute(
        "SELECT id,county_fips,person_a,person_b,status,supporting_evidence_id,conflicting_evidence_id,"
        "rationale,decision_basis,resolution_evidence_id FROM possible_matches "
        "WHERE county_fips=? ORDER BY id", (county_fips,))]
    identity_evidence = _connection_evidence_rows(db, county_fips)
    for evidence in identity_evidence:
        if evidence["source_id"] in source_targets:
            evidence["official_status"] = source_targets[evidence["source_id"]]
    return {"claims": claims, "people": people, "variants": variants, "matches": matches,
            "identity_link_evidence": identity_evidence}


def _read_existing(db, county_fips):
    people = [dict(row) for row in db.execute(
        "SELECT id,county_fips,display_name,identity_state,identity_evidence_id FROM research_people "
        "WHERE county_fips=? ORDER BY id", (county_fips,))]
    variants = [dict(row) for row in db.execute(
        "SELECT n.id,n.person_id,n.published_name,n.kind,n.evidence_id FROM name_variants n "
        "JOIN research_people p ON p.id=n.person_id WHERE p.county_fips=? ORDER BY n.id", (county_fips,))]
    by_evidence = defaultdict(set)
    for person in people:
        if person["identity_evidence_id"]:
            by_evidence[person["identity_evidence_id"]].add(person["id"])
    for variant in variants:
        by_evidence[variant["evidence_id"]].add(variant["person_id"])
    claim_people = defaultdict(set)
    for row in db.execute("SELECT id,person_id FROM role_claims WHERE county_fips=? AND person_id IS NOT NULL",
                          (county_fips,)):
        claim_people[row["id"]].add(row["person_id"])
    return people, variants, by_evidence, claim_people


def _nickname_forms(row):
    fields = _raw_fields(row["raw_record_json"])
    nickname_text = fields.get("Nicknames")
    if not isinstance(nickname_text, str) or not nickname_text.strip():
        return []
    # A single literal form needs no parsing. A list is split only on explicit
    # delimiters; source cells themselves remain untouched in evidence storage.
    parts = [part.strip() for part in _NICKNAME_SPLIT.split(nickname_text) if part.strip()]
    return parts if parts and all(_is_name_form(part) for part in parts) else []


def _county_decisions(db, county_fips, *, planned_sources, allow_planned_sources, source_targets):
    rows = _load_county_claims(db, county_fips)
    connection_edges = _identity_connection_edges(db, county_fips, rows,
                                                  planned_sources=planned_sources,
                                                  allow_planned_sources=allow_planned_sources)
    groups = _components(rows, connection_edges)
    people, existing_variants, people_by_evidence, claim_people = _read_existing(db, county_fips)
    existing_names = defaultdict(set)
    for person in people:
        existing_names[person["display_name"]].add(person["id"])
    for variant in existing_variants:
        existing_names[variant["published_name"]].add(variant["person_id"])

    name_components = defaultdict(set)
    component_names = {}
    for component_id, component_rows in groups.items():
        names = {row["published_name"] for row in component_rows if _is_person_name(row["published_name"])}
        component_names[component_id] = names
        for name in names:
            name_components[name].add(component_id)
    ambiguous_components = {component for name, components in name_components.items() if len(components) > 1
                            for component in components}

    new_people, associations, variants, unresolved, rejected = [], [], [], [], []
    consumed = set()
    component_person = {}
    component_existing_candidates = {}
    for component_id in sorted(groups):
        component = groups[component_id]
        plausible = [row for row in component if _is_person_name(row["published_name"])]
        if not plausible:
            continue
        if component_id in ambiguous_components:
            continue
        candidate_rows = []
        for row in component:
            source_official = row["official_status"] == "official" or (
                allow_planned_sources and row["source_id"] in planned_sources)
            if (source_official and _active_batch(row) and _is_person_name(row["published_name"])
                    and _direct_name_role(row)):
                candidate_rows.append(row)
        if not candidate_rows:
            continue

        component_evidence = {row["evidence_id"] for row in component}
        linked_people = set().union(*(people_by_evidence.get(evidence_id, set()) for evidence_id in component_evidence))
        linked_people.update(person_id for row in component for person_id in claim_people.get(row["id"], set()))
        if len(linked_people) > 1:
            continue
        linked_person = next(iter(linked_people), None)
        if linked_person is None:
            conflicts = set().union(*(existing_names.get(name, set()) for name in component_names[component_id]))
            if conflicts:
                component_existing_candidates[component_id] = conflicts
                continue
        component_person[component_id] = linked_person

        candidate_rows.sort(key=lambda row: (0 if row["lineage_kind"] == "corrected" and row["selected"] else 1,
                                             row["id"]))
        anchor = candidate_rows[0]
        person_id = linked_person or _stable_id("person", county_fips, component_id)
        if linked_person is None:
            new_people.append({"person_id": person_id, "county_fips": county_fips,
                               "display_name": anchor["published_name"],
                               "identity_evidence_id": anchor["evidence_id"],
                               "anchor_claim_id": anchor["id"]})
        for row in component:
            if row["person_id"] is not None:
                if row["person_id"] != person_id:
                    continue
                consumed.add(row["id"])
                continue
            source_official = row["official_status"] == "official" or (
                allow_planned_sources and row["source_id"] in planned_sources)
            if (not source_official or not _active_batch(row) or not _is_person_name(row["published_name"])
                    or not _direct_name_role(row)):
                continue
            if row["id"] == anchor["id"]:
                method = "bootstrap"
                link_evidence_id = row["evidence_id"]
            elif row["supersedes_id"] and row["lineage_kind"] == "corrected" and row["selected"]:
                method = "correction_lineage"
                link_evidence_id = row["evidence_id"]
            elif _is_in_correction_lineage(row, anchor, component):
                # Every additional member is connected by a selected,
                # same-family corrected-batch supersession edge.
                method = "correction_lineage"
                link_evidence_id = row["evidence_id"]
            elif tuple(sorted((row["id"], anchor["id"]))) in connection_edges:
                method = "official_connection"
                link_evidence_id = connection_edges[tuple(sorted((row["id"], anchor["id"]))) ]
            else:
                continue
            associations.append({"claim_id": row["id"], "person_id": person_id,
                                 "evidence_id": link_evidence_id, "anchor_claim_id": anchor["id"],
                                 "method": method, "county_fips": county_fips})
            consumed.add(row["id"])
            variant_id = _stable_id("variant", person_id, row["published_name"], "published", row["evidence_id"])
            existing_variant = db.execute(
                "SELECT id FROM name_variants WHERE person_id=? AND published_name=? AND kind='published' AND evidence_id=?",
                (person_id, row["published_name"], row["evidence_id"]),
            ).fetchone()
            if existing_variant is None:
                variants.append({"variant_id": variant_id, "person_id": person_id,
                                 "published_name": row["published_name"], "kind": "published",
                                 "evidence_id": row["evidence_id"], "claim_id": row["id"],
                                 "basis": "Exact published name copied from the associated claim evidence"})
            if row["id"] == anchor["id"]:
                for nickname in _nickname_forms(row):
                    if nickname == row["published_name"]:
                        continue
                    current = db.execute(
                        "SELECT id FROM name_variants WHERE person_id=? AND published_name=? AND kind='nickname' AND evidence_id=?",
                        (person_id, nickname, row["evidence_id"]),
                    ).fetchone()
                    if current is None:
                        variants.append({"variant_id": _stable_id("variant", person_id, nickname, "nickname",
                                                                      row["evidence_id"]),
                                         "person_id": person_id, "published_name": nickname,
                                         "kind": "nickname", "evidence_id": row["evidence_id"],
                                         "claim_id": row["id"],
                                         "basis": "The exact original record places this literal form in its Nicknames field alongside the published name"})

    for component_id, component in groups.items():
        plausible = [row for row in component if _is_person_name(row["published_name"])]
        if not plausible:
            continue
        component_conflict = component_id in ambiguous_components
        existing_candidates = component_existing_candidates.get(
            component_id, set().union(*(existing_names.get(name, set()) for name in component_names[component_id])))
        component_evidence = {item["evidence_id"] for item in component}
        direct_people = set().union(*(people_by_evidence.get(evidence_id, set()) for evidence_id in component_evidence))
        direct_people.update(person_id for item in component for person_id in claim_people.get(item["id"], set()))
        unlinked_existing = existing_candidates - direct_people
        for row in component:
            if row["person_id"] is not None or row["id"] in consumed:
                continue
            if not _is_person_name(row["published_name"]):
                rejected.append({"claim_id": row["id"], "county_fips": county_fips,
                                 "evidence_id": row["evidence_id"], "reason": "published_text_not_a_plausible_person_name"})
                continue
            if row["lineage_kind"] == "alternative":
                reason = "alternative_batch_is_not_independent_identity_evidence"
            elif row["lineage_kind"] == "corrected" and not row["selected"]:
                reason = "corrected_batch_version_is_not_selected"
            elif component_conflict:
                reason = "same_name_has_multiple_unlinked_source_observations"
            elif unlinked_existing:
                reason = "existing_same_name_profile_requires_direct_identity_link"
            elif not (row["official_status"] == "official" or
                      (allow_planned_sources and row["source_id"] in planned_sources)):
                reason = "source_authority_not_established"
            elif not _direct_name_role(row):
                reason = "evidence_does_not_directly_link_exact_name_and_role"
            elif row["person_id"] is not None and row["person_id"] != component_person.get(component_id):
                reason = "identity_component_conflict_or_existing_association"
            else:
                reason = "identity_link_not_established"
            unresolved.append({"claim_id": row["id"], "county_fips": county_fips,
                               "published_name": row["published_name"], "evidence_id": row["evidence_id"],
                               "candidate_person_ids": sorted(existing_candidates), "reason": reason,
                               "next_evidence": ["an explicit official record connection, a shared unique contact identifier, or documented evidence that distinguishes the source entries"]})

    # Claims with non-person text or no position evidence are rejected with a
    # precise reason and remain unchanged in the role-claim table.
    for row in rows:
        if row["person_id"] is not None or row["id"] in consumed:
            continue
        if row["id"] in {item["claim_id"] for item in unresolved + rejected}:
            continue
        if not _is_person_name(row["published_name"]):
            rejected.append({"claim_id": row["id"], "county_fips": county_fips,
                             "evidence_id": row["evidence_id"], "reason": "published_text_not_a_plausible_person_name"})
        elif not _direct_name_role(row):
            rejected.append({"claim_id": row["id"], "county_fips": county_fips,
                             "evidence_id": row["evidence_id"], "reason": "evidence_does_not_directly_link_exact_name_and_role"})
        elif row["lineage_kind"] == "alternative":
            unresolved.append({"claim_id": row["id"], "county_fips": county_fips,
                               "published_name": row["published_name"], "evidence_id": row["evidence_id"],
                               "candidate_person_ids": [], "reason": "alternative_batch_is_not_independent_identity_evidence",
                               "next_evidence": ["a selected official observation or an explicit direct identity connection"]})
        elif row["lineage_kind"] == "corrected" and not row["selected"]:
            unresolved.append({"claim_id": row["id"], "county_fips": county_fips,
                               "published_name": row["published_name"], "evidence_id": row["evidence_id"],
                               "candidate_person_ids": [], "reason": "corrected_batch_version_is_not_selected",
                               "next_evidence": ["the selected version or an explicit correction lineage link"]})
        elif row["official_status"] != "official" and not (
                allow_planned_sources and row["source_id"] in planned_sources):
            unresolved.append({"claim_id": row["id"], "county_fips": county_fips,
                               "published_name": row["published_name"], "evidence_id": row["evidence_id"],
                               "candidate_person_ids": [], "reason": "source_authority_not_established",
                               "next_evidence": ["verified official source provenance for the exact cited source"]})
        else:
            unresolved.append({"claim_id": row["id"], "county_fips": county_fips,
                               "published_name": row["published_name"], "evidence_id": row["evidence_id"],
                               "candidate_person_ids": [], "reason": "identity_link_not_established",
                               "next_evidence": ["an explicit official record connection, a shared unique contact identifier, or documented evidence that distinguishes the source entries"]})

    new_people.sort(key=lambda item: item["person_id"])
    associations.sort(key=lambda item: item["claim_id"])
    variants.sort(key=lambda item: (item["person_id"], item["published_name"], item["evidence_id"], item["kind"]))
    unresolved.sort(key=lambda item: (item["claim_id"], item["reason"]))
    rejected.sort(key=lambda item: (item["claim_id"], item["reason"]))
    state = _state_snapshot(db, county_fips, source_targets)
    return {"county_fips": county_fips, "input_state_sha256": _digest(state),
            "new_people": new_people, "associations": associations, "name_variants": variants,
            "possible_matches": [], "unresolved": unresolved, "rejected": rejected,
            "input_claims": len(rows)}


def build_identity_plan(db):
    """Build a read-only county-bounded plan from already retained observations."""
    validate_migration_history(db)
    source_classifications = _source_proposals(db)
    planned_sources = {item["source_id"] for item in source_classifications}
    source_targets = {source_id: "official" for source_id in planned_sources}
    counties = [row[0] for row in db.execute("SELECT fips FROM counties WHERE EXISTS "
                                               "(SELECT 1 FROM role_claims c WHERE c.county_fips=counties.fips) ORDER BY fips")]
    county_plans = [_county_decisions(db, fips, planned_sources=planned_sources,
                                      allow_planned_sources=True, source_targets=source_targets)
                    for fips in counties]
    totals = defaultdict(int)
    for county in county_plans:
        totals["role_claims_evaluated"] += county["input_claims"]
        for key in ("new_people", "associations", "name_variants", "possible_matches", "unresolved", "rejected"):
            totals[key] += len(county[key])
    counts = {row[0]: row[1] for row in db.execute(
        "SELECT county_fips,count(*) FROM role_claims GROUP BY county_fips ORDER BY county_fips")}
    totals["role_claims_assigned_before"] = db.execute(
        "SELECT count(*) FROM role_claims WHERE person_id IS NOT NULL").fetchone()[0]
    totals["role_claims_unassigned_before"] = totals["role_claims_evaluated"] - totals["role_claims_assigned_before"]
    payload = {"format": PLAN_FORMAT,
               "input": {"county_registry_count": db.execute("SELECT count(*) FROM counties").fetchone()[0],
                         "counties_with_claims": len(counties), "claims_by_county": counts,
                         "source_count": db.execute("SELECT count(*) FROM sources").fetchone()[0],
                         "batch_count": db.execute("SELECT count(*) FROM scrape_batches").fetchone()[0],
                         "existing_people": db.execute("SELECT count(*) FROM research_people").fetchone()[0],
                         "existing_open_possible_matches": db.execute("SELECT count(*) FROM possible_matches WHERE status='open'").fetchone()[0]},
               "source_classifications": source_classifications,
               "counties": county_plans,
               "summary": {"counties_processed": len(counties),
                           "role_claims_evaluated": totals["role_claims_evaluated"],
                           "role_claims_assigned_before": totals["role_claims_assigned_before"],
                           "role_claims_unassigned_before": totals["role_claims_unassigned_before"],
                           "new_research_people": totals["new_people"],
                           "claims_associated": totals["associations"],
                           "evidence_supported_name_variants": totals["name_variants"],
                           "possible_match_candidates": totals["possible_matches"],
                           "unresolved_claims": totals["unresolved"],
                           "rejected_or_ineligible_claims": totals["rejected"],
                           "source_classifications_to_official": len(source_classifications),
                           "claims_assigned_after": totals["role_claims_assigned_before"] + totals["associations"],
                           "unit_associations_preserved": db.execute("SELECT count(*) FROM role_claims WHERE unit_id IS NOT NULL").fetchone()[0],
                           "position_associations_preserved": db.execute("SELECT count(*) FROM role_claims WHERE target_id IS NOT NULL").fetchone()[0]},
               "rules": {"county_scope": True, "name_or_department_alone_establishes_identity": False,
                         "automatic_association_basis": ["the exact bootstrap evidence", "an explicit selected corrected-batch supersession chain", "a direct official connection between exact documented roles"],
                         "alternative_batches_create_people": False,
                         "nickname_variants": "only literal forms in the same official record's Nicknames field"}}
    return {**payload, "plan_sha256": _digest(payload)}


def plan_sha256(plan):
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise ValueError("Unsupported identity plan format")
    actual = _digest({key: value for key, value in plan.items() if key != "plan_sha256"})
    if plan.get("plan_sha256") != actual:
        raise ValueError("Identity plan integrity check failed")
    return actual


def write_identity_plan(plan, destination, *, repository_root):
    from pathlib import Path

    destination = Path(destination)
    root = Path(repository_root).resolve()
    if not destination.is_absolute() or ".." in destination.parts:
        raise ValueError("Private identity plan path must be an explicit absolute path without traversal")
    current = Path(destination.anchor)
    for part in destination.parts[1:]:
        current /= part
        try:
            details = current.lstat()
        except FileNotFoundError:
            continue
        if current.is_symlink() or bool(getattr(details, "st_file_attributes", 0) & 0x400):
            raise ValueError("Private identity plan path cannot contain symbolic links or reparse points")
    resolved = destination.resolve()
    if resolved == root or root in resolved.parents:
        raise ValueError("Private identity plans must stay outside the source checkout")
    if not resolved.parent.is_dir() or resolved.exists():
        raise FileExistsError("Private identity plan parent must exist and destination must be new")
    content = json.dumps(plan, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_identity_plan(path, *, repository_root):
    from pathlib import Path

    path = Path(path)
    root = Path(repository_root).resolve()
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Private identity plan must be an explicit absolute path without traversal")
    resolved = path.resolve(strict=True)
    if resolved == root or root in resolved.parents or not resolved.is_file():
        raise ValueError("Identity plan must be a regular private file outside the source checkout")
    plan = json.loads(resolved.read_text(encoding="utf-8"))
    plan_sha256(plan)
    return plan


def _run_id(digest, suffix):
    return _stable_id("run", PLAN_FORMAT, digest, suffix)


def _event(run_id, kind, entity_type, entity_id, detail, actor):
    event_id = _stable_id("event", run_id, kind, entity_type, entity_id)
    return (event_id, kind, entity_type, entity_id, canonical_json({**detail, "operator": actor}))


def _expected_source_events(proposals, run_id, actor):
    return [_event(run_id, "source_classified", "sources", item["source_id"], {
        "before": {"official_status": item["from_status"]},
        "after": {"official_status": item["to_status"]},
        "supporting_evidence_id": item["evidence_id"], "basis": item["basis"],
        "verified_host": item["host"], "source_visit_recorded": False,
    }, actor) for item in proposals]


def _county_events(county, run_id, actor):
    events = []
    for person in county["new_people"]:
        events.append(_event(run_id, "research_person_created", "research_people", person["person_id"], {
            "before": None, "after": {"person_id": person["person_id"], "county_fips": person["county_fips"],
                                       "display_name": person["display_name"],
                                       "identity_state": "evidence_supported",
                                       "identity_evidence_id": person["identity_evidence_id"]},
            "claim_id": person["anchor_claim_id"], "supporting_evidence_id": person["identity_evidence_id"],
            "basis": "official source observation directly links the exact published name to a documented role",
        }, actor))
    for variant in county["name_variants"]:
        events.append(_event(run_id, "name_variant_registered", "name_variants", variant["variant_id"], {
            "before": None, "after": {"variant_id": variant["variant_id"], "person_id": variant["person_id"],
                                       "published_name": variant["published_name"], "kind": variant["kind"],
                                       "evidence_id": variant["evidence_id"]},
            "supporting_evidence_id": variant["evidence_id"], "claim_id": variant["claim_id"],
            "basis": variant["basis"],
        }, actor))
    for association in county["associations"]:
        events.append(_event(run_id, "claim_person_associated", "role_claims", association["claim_id"], {
            "before": {"person_id": None}, "after": {"person_id": association["person_id"]},
            "supporting_evidence_id": association["evidence_id"], "anchor_claim_id": association["anchor_claim_id"],
            "decision_basis": association["method"],
        }, actor))
    for candidate in county["possible_matches"]:
        events.append(_event(run_id, "possible_match_candidate_recorded", "possible_matches", candidate["id"],
                             candidate, actor))
    for case in county["unresolved"]:
        events.append(_event(run_id, "identity_unresolved_recorded", "role_claims", case["claim_id"], case, actor))
    for case in county["rejected"]:
        events.append(_event(run_id, "identity_observation_rejected", "role_claims", case["claim_id"], case, actor))
    return events


def _verify_run_and_events(db, run_id, note, expected_events):
    run = db.execute("SELECT id,provenance,actor,note FROM research_runs WHERE id=?", (run_id,)).fetchone()
    if run is None or run["provenance"] != "reconstructed" or run["note"] != note:
        raise ValueError("Identity application run is missing or conflicts with this plan")
    for event_id, kind, entity_type, entity_id, detail_json in expected_events:
        row = db.execute("SELECT run_id,kind,entity_type,entity_id,detail_json,provenance FROM research_events WHERE id=?",
                         (event_id,)).fetchone()
        if (row is None or row["run_id"] != run_id or row["kind"] != kind or
                row["entity_type"] != entity_type or row["entity_id"] != entity_id or
                row["detail_json"] != detail_json or row["provenance"] != "reconstructed"):
            raise ValueError("Identity application audit history is incomplete or changed")
    count = db.execute("SELECT count(*) FROM research_events WHERE run_id=?", (run_id,)).fetchone()[0]
    if count != len(expected_events):
        raise ValueError("Identity application run has an unexpected audit event count")
    return run["actor"]


def _verify_county_rows(db, county):
    for person in county["new_people"]:
        row = db.execute("SELECT county_fips,display_name,identity_state,identity_evidence_id FROM research_people WHERE id=?",
                         (person["person_id"],)).fetchone()
        expected = (person["county_fips"], person["display_name"], "evidence_supported", person["identity_evidence_id"])
        if row is None or tuple(row) != expected:
            raise ValueError("Planned research person is missing or changed")
    for association in county["associations"]:
        row = db.execute("SELECT county_fips,person_id FROM role_claims WHERE id=?", (association["claim_id"],)).fetchone()
        if row is None or tuple(row) != (association["county_fips"], association["person_id"]):
            raise ValueError("Planned role-claim association is missing or changed")
    for variant in county["name_variants"]:
        row = db.execute("SELECT person_id,published_name,kind,evidence_id FROM name_variants WHERE id=?",
                         (variant["variant_id"],)).fetchone()
        if row is None or tuple(row) != (variant["person_id"], variant["published_name"],
                                         variant["kind"], variant["evidence_id"]):
            raise ValueError("Planned evidence-supported name variant is missing or changed")


def apply_identity_plan(db, plan, *, expected_sha256, actor=ACTOR_DEFAULT):
    """Apply source classifications once, then commit each county atomically and resumably."""
    digest = plan_sha256(plan)
    if digest != expected_sha256:
        raise ValueError("Expected identity plan SHA-256 does not match the inspected preview")
    if not isinstance(actor, str) or not actor.strip():
        raise ValueError("An attributable operator is required")
    if db.in_transaction:
        raise ValueError("Finish the current transaction before applying the identity plan")
    validate_migration_history(db)
    source_run_id = _run_id(digest, "sources")
    source_note = f"identity-foundation/v1:{digest}:sources"
    source_expected_count = len(plan["source_classifications"])
    source_run = db.execute("SELECT id FROM research_runs WHERE id=?", (source_run_id,)).fetchone()
    source_targets = {item["source_id"]: item["to_status"] for item in plan["source_classifications"]}
    planned_sources = set(source_targets)
    if source_run is None and _source_proposals(db) != plan["source_classifications"]:
        raise ValueError("Source evidence or classification state changed after the identity preview")
    # Validate every not-yet-applied county before the first source or identity
    # write. This keeps a stale statewide plan from partially classifying sources.
    for county in plan["counties"]:
        county_run_id = _run_id(digest, county["county_fips"])
        county_run = db.execute("SELECT actor FROM research_runs WHERE id=?", (county_run_id,)).fetchone()
        if county_run:
            _verify_county_rows(db, county)
            _verify_run_and_events(db, county_run_id,
                                   f"identity-foundation/v1:{digest}:{county['county_fips']}",
                                   _county_events(county, county_run_id, county_run["actor"]))
            continue
        fresh = _county_decisions(db, county["county_fips"], planned_sources=planned_sources,
                                  allow_planned_sources=(source_run is None), source_targets=source_targets)
        if (fresh["input_state_sha256"] != county["input_state_sha256"] or
                any(fresh[key] != county[key] for key in (
                    "new_people", "associations", "name_variants", "possible_matches", "unresolved", "rejected"))):
            raise ValueError(f"County {county['county_fips']} changed after the identity preview; no decisions were overwritten")
    if source_run:
        saved_actor = db.execute("SELECT actor FROM research_runs WHERE id=?", (source_run_id,)).fetchone()[0]
        source_events = _expected_source_events(plan["source_classifications"], source_run_id, saved_actor)
        _verify_run_and_events(db, source_run_id, source_note, source_events)
        for proposal in plan["source_classifications"]:
            status = db.execute("SELECT official_status FROM sources WHERE id=?", (proposal["source_id"],)).fetchone()
            if status is None or status[0] != proposal["to_status"]:
                raise ValueError("A previously classified source changed after identity application")
    elif source_expected_count:
        db.execute("BEGIN IMMEDIATE")
        try:
            fresh_proposals = _source_proposals(db)
            if fresh_proposals != plan["source_classifications"]:
                raise ValueError("Source evidence or classification state changed after the identity preview")
            for proposal in plan["source_classifications"]:
                current = db.execute("SELECT official_status FROM sources WHERE id=?", (proposal["source_id"],)).fetchone()
                if current is None or current[0] != proposal["from_status"]:
                    raise ValueError("Source classification changed after the identity preview")
            now = timestamp()
            db.execute("INSERT INTO research_runs VALUES (?,?,?,?,?,?,?,?)",
                       (source_run_id, "screening", "reconstructed", actor, now, now, now, source_note))
            for proposal in plan["source_classifications"]:
                updated = db.execute("UPDATE sources SET official_status='official' WHERE id=? AND official_status='unknown'",
                                     (proposal["source_id"],))
                if updated.rowcount != 1:
                    raise ValueError("Source classification changed during application")
            for event in _expected_source_events(plan["source_classifications"], source_run_id, actor):
                db.execute("INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
                           (event[0], source_run_id, event[1], event[2], event[3], now, now,
                            "reconstructed", event[4]))
            db.commit()
        except Exception:
            db.rollback()
            raise
    else:
        # An empty classification stage is represented by no run.
        pass

    applied, resumed = [], []
    for planned_county in plan["counties"]:
        county = planned_county["county_fips"]
        run_id = _run_id(digest, county)
        note = f"identity-foundation/v1:{digest}:{county}"
        existing_run = db.execute("SELECT id,actor FROM research_runs WHERE id=?", (run_id,)).fetchone()
        if existing_run:
            _verify_county_rows(db, planned_county)
            events = _county_events(planned_county, run_id, existing_run["actor"])
            _verify_run_and_events(db, run_id, note, events)
            resumed.append(county)
            continue
        db.execute("BEGIN IMMEDIATE")
        try:
            fresh = _county_decisions(db, county, planned_sources=set(source_targets),
                                      allow_planned_sources=False, source_targets=source_targets)
            if (fresh["input_state_sha256"] != planned_county["input_state_sha256"] or
                    any(fresh[key] != planned_county[key] for key in (
                        "new_people", "associations", "name_variants", "possible_matches", "unresolved", "rejected"))):
                raise ValueError(f"County {county} changed after the identity preview; no decisions were overwritten")
            now = timestamp()
            db.execute("INSERT INTO research_runs VALUES (?,?,?,?,?,?,?,?)",
                       (run_id, "screening", "reconstructed", actor, now, now, now, note))
            for person in planned_county["new_people"]:
                anchor = db.execute("SELECT published_name,evidence_id FROM role_claims WHERE id=?",
                                    (person["anchor_claim_id"],)).fetchone()
                if anchor is None:
                    raise ValueError("The source-backed person anchor disappeared")
                research_operator._claim_evidence(
                    db, county_fips=person["county_fips"], claim_id=person["anchor_claim_id"],
                    published_name=anchor["published_name"], evidence_id=person["identity_evidence_id"])
                db.execute("INSERT INTO research_people(id,county_fips,display_name,identity_state,identity_evidence_id) "
                           "VALUES (?,?,?,'evidence_supported',?)",
                           (person["person_id"], person["county_fips"], person["display_name"], person["identity_evidence_id"]))
            for variant in planned_county["name_variants"]:
                if variant["kind"] == "nickname":
                    research_operator.validate_nickname_field_variant(
                        db, person_id=variant["person_id"], published_name=variant["published_name"],
                        evidence_id=variant["evidence_id"])
                db.execute("INSERT INTO name_variants(id,person_id,published_name,kind,evidence_id) VALUES (?,?,?,?,?)",
                           (variant["variant_id"], variant["person_id"], variant["published_name"],
                            variant["kind"], variant["evidence_id"]))
            association_order = {"bootstrap": 0, "correction_lineage": 1, "official_connection": 2}
            for association in sorted(
                planned_county["associations"],
                key=lambda item: (association_order.get(item["method"], 3), item["claim_id"]),
            ):
                if association["method"] == "correction_lineage":
                    research_operator.validate_correction_lineage_association(
                        db, claim_id=association["claim_id"], person_id=association["person_id"],
                        anchor_claim_id=association["anchor_claim_id"])
                elif association["method"] == "official_connection":
                    research_operator.validate_claim_connection(
                        db, claim_id=association["claim_id"], person_id=association["person_id"],
                        evidence_id=association["evidence_id"])
                else:
                    claim = db.execute("SELECT published_name FROM role_claims WHERE id=?",
                                       (association["claim_id"],)).fetchone()
                    research_operator._claim_evidence(
                        db, county_fips=association["county_fips"], claim_id=association["claim_id"],
                        published_name=claim["published_name"], evidence_id=association["evidence_id"])
                changed = db.execute("UPDATE role_claims SET person_id=? WHERE id=? AND county_fips=? AND person_id IS NULL",
                                     (association["person_id"], association["claim_id"], county))
                if changed.rowcount != 1:
                    raise ValueError("A role claim was assigned during identity application")
            for event in _county_events(planned_county, run_id, actor):
                db.execute("INSERT INTO research_events VALUES (?,?,?,?,?,?,?,?,?)",
                           (event[0], run_id, event[1], event[2], event[3], now, now,
                            "reconstructed", event[4]))
            db.commit()
            applied.append(county)
        except Exception:
            db.rollback()
            raise
    return {"status": "applied" if applied else "already_applied", "plan_sha256": digest,
            "source_classifications_applied": source_expected_count,
            "counties_applied": applied, "counties_resumed": resumed,
            **plan["summary"]}


def verify_identity_application(db, plan):
    digest = plan_sha256(plan)
    validate_migration_history(db)
    if plan["source_classifications"]:
        run_id = _run_id(digest, "sources")
        note = f"identity-foundation/v1:{digest}:sources"
        run = db.execute("SELECT actor FROM research_runs WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise ValueError("Identity source classification stage is incomplete")
        events = _expected_source_events(plan["source_classifications"], run_id, run[0])
        _verify_run_and_events(db, run_id, note, events)
        for proposal in plan["source_classifications"]:
            status = db.execute("SELECT official_status FROM sources WHERE id=?", (proposal["source_id"],)).fetchone()
            if status is None or status[0] != proposal["to_status"]:
                raise ValueError("Identity source classification differs from the plan")
    for county in plan["counties"]:
        run_id = _run_id(digest, county["county_fips"])
        run = db.execute("SELECT actor FROM research_runs WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise ValueError(f"Identity application is incomplete for county {county['county_fips']}")
        _verify_county_rows(db, county)
        _verify_run_and_events(db, run_id, f"identity-foundation/v1:{digest}:{county['county_fips']}",
                               _county_events(county, run_id, run[0]))
    return {"status": "verified", "plan_sha256": digest,
            "counties_processed": len(plan["counties"]),
            "new_research_people": plan["summary"]["new_research_people"],
            "claims_associated": plan["summary"]["claims_associated"],
            "name_variants": plan["summary"]["evidence_supported_name_variants"],
            "unresolved_claims": plan["summary"]["unresolved_claims"],
            "possible_match_candidates": plan["summary"]["possible_match_candidates"],
            "role_claims_assigned_after": db.execute("SELECT count(*) FROM role_claims WHERE person_id IS NOT NULL").fetchone()[0],
            "role_claims_still_unassigned": db.execute("SELECT count(*) FROM role_claims WHERE person_id IS NULL").fetchone()[0],
            "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_violations": len(db.execute("PRAGMA foreign_key_check").fetchall())}

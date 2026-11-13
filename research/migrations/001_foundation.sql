CREATE TABLE counties (
    fips TEXT PRIMARY KEY CHECK(length(fips) = 5 AND fips GLOB '08[0-9][0-9][0-9]'),
    name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) > 0)
) STRICT;

CREATE TABLE research_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('mapping', 'screening', 'source_visit', 'reconstruction')),
    provenance TEXT NOT NULL CHECK(provenance IN ('observed', 'reconstructed', 'synthetic')),
    actor TEXT,
    started_at TEXT,
    ended_at TEXT,
    recorded_at TEXT NOT NULL,
    note TEXT
) STRICT;

CREATE TABLE scrape_batches (
    id TEXT PRIMARY KEY,
    county_fips TEXT NOT NULL REFERENCES counties(fips),
    family_id TEXT NOT NULL,
    parent_batch_id TEXT,
    lineage_kind TEXT NOT NULL CHECK(lineage_kind IN ('original', 'complementary', 'corrected', 'alternative')),
    selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0, 1)),
    version_label TEXT NOT NULL,
    original_file_name TEXT NOT NULL,
    file_sha256 TEXT NOT NULL CHECK(length(file_sha256) = 64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'),
    mapping_version TEXT NOT NULL,
    mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
    provenance_type TEXT NOT NULL CHECK(provenance_type IN ('legacy_delivery', 'scrape', 'synthetic')),
    run_id TEXT NOT NULL REFERENCES research_runs(id),
    recorded_at TEXT NOT NULL,
    UNIQUE(id, county_fips),
    UNIQUE(county_fips, file_sha256, mapping_version),
    FOREIGN KEY(parent_batch_id, county_fips) REFERENCES scrape_batches(id, county_fips),
    CHECK((lineage_kind IN ('original', 'complementary') AND parent_batch_id IS NULL AND family_id = id)
       OR (lineage_kind IN ('corrected', 'alternative') AND parent_batch_id IS NOT NULL AND parent_batch_id <> id))
) STRICT;
CREATE UNIQUE INDEX one_selected_batch_per_family ON scrape_batches(family_id) WHERE selected = 1;
CREATE TRIGGER batch_lineage_insert BEFORE INSERT ON scrape_batches
WHEN NEW.parent_batch_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'batch family must match parent') WHERE NOT EXISTS (
        SELECT 1 FROM scrape_batches WHERE id = NEW.parent_batch_id AND family_id = NEW.family_id
    );
END;
CREATE TRIGGER batch_lineage_update BEFORE UPDATE OF parent_batch_id, family_id, lineage_kind ON scrape_batches
BEGIN
    SELECT RAISE(ABORT, 'batch lineage is stable; add a new version')
    WHERE NEW.parent_batch_id IS NOT OLD.parent_batch_id OR NEW.family_id <> OLD.family_id
       OR NEW.lineage_kind <> OLD.lineage_kind;
END;

CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    original_url TEXT NOT NULL UNIQUE CHECK(original_url LIKE 'https://%' OR original_url LIKE 'http://%'),
    page_type TEXT,
    official_status TEXT NOT NULL DEFAULT 'unknown' CHECK(official_status IN ('unknown', 'official', 'partner', 'other')),
    first_discovered_at TEXT,
    last_checked_at TEXT,
    last_successful_fetch_at TEXT,
    next_due_at TEXT,
    availability TEXT CHECK(availability IN ('available', 'blocked', 'missing', 'failed')),
    usefulness TEXT CHECK(usefulness IN ('personnel', 'structure', 'coverage_only', 'unproductive')),
    content_sha256 TEXT CHECK(content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')),
    etag TEXT,
    last_modified TEXT,
    recorded_at TEXT NOT NULL
) STRICT;

-- Evidence is a source-version observation, not the mutable source registry.
-- It can be a raw legacy row, a position/relationship citation, or later research.
CREATE TABLE evidence_links (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_version_key TEXT,
    observed_title TEXT,
    observed_url TEXT NOT NULL,
    source_date TEXT,
    source_date_precision TEXT CHECK(source_date_precision IN ('year', 'month', 'day')),
    source_date_basis TEXT CHECK(source_date_basis IN ('published', 'reported', 'modification_metadata', 'unknown')),
    reported_checked_date TEXT,
    locator TEXT NOT NULL,
    quotation TEXT,
    batch_id TEXT REFERENCES scrape_batches(id),
    raw_record_json TEXT CHECK(raw_record_json IS NULL OR json_valid(raw_record_json)),
    raw_record_sha256 TEXT,
    occurrences_json TEXT CHECK(occurrences_json IS NULL OR json_valid(occurrences_json)),
    supersedes_id TEXT REFERENCES evidence_links(id),
    run_id TEXT NOT NULL REFERENCES research_runs(id),
    recorded_at TEXT NOT NULL,
    UNIQUE(batch_id, raw_record_sha256),
    CHECK((source_date IS NULL AND source_date_precision IS NULL)
       OR (source_date IS NOT NULL AND source_date_precision IS NOT NULL)),
    CHECK((batch_id IS NULL AND raw_record_json IS NULL AND raw_record_sha256 IS NULL AND occurrences_json IS NULL)
       OR (batch_id IS NOT NULL AND raw_record_json IS NOT NULL AND raw_record_sha256 IS NOT NULL AND occurrences_json IS NOT NULL)),
    CHECK(supersedes_id IS NULL OR supersedes_id <> id)
) STRICT;
CREATE INDEX evidence_source_version ON evidence_links(source_id, source_version_key);

CREATE TABLE org_units (
    id TEXT PRIMARY KEY,
    county_fips TEXT NOT NULL REFERENCES counties(fips),
    source_label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('unknown', 'elected_office', 'appointed_office', 'department', 'division', 'subunit', 'partner', 'navigation')),
    parent_id TEXT,
    parent_relation TEXT CHECK(parent_relation IN ('administrative', 'statutory', 'navigation')),
    parent_evidence_id TEXT REFERENCES evidence_links(id),
    effective_from TEXT,
    effective_to TEXT,
    UNIQUE(id, county_fips),
    FOREIGN KEY(parent_id, county_fips) REFERENCES org_units(id, county_fips),
    CHECK((parent_id IS NULL AND parent_relation IS NULL AND parent_evidence_id IS NULL)
       OR (parent_id IS NOT NULL AND parent_relation IS NOT NULL AND parent_evidence_id IS NOT NULL)),
    CHECK(parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE TRIGGER org_parent_insert BEFORE INSERT ON org_units WHEN NEW.parent_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT, 'navigation is not reporting authority') WHERE NEW.parent_relation <> 'navigation'
        AND EXISTS (SELECT 1 FROM org_units WHERE id = NEW.parent_id AND kind = 'navigation');
    SELECT RAISE(ABORT, 'organization cycle') WHERE EXISTS (
        WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_id UNION SELECT u.parent_id FROM org_units u JOIN ancestors a ON u.id = a.id
            WHERE u.parent_id IS NOT NULL
        ) SELECT 1 FROM ancestors WHERE id = NEW.id
    );
END;
CREATE TRIGGER org_parent_update BEFORE UPDATE OF parent_id, parent_relation, kind ON org_units BEGIN
    SELECT RAISE(ABORT, 'navigation is not reporting authority') WHERE
        (NEW.parent_relation <> 'navigation' AND EXISTS (SELECT 1 FROM org_units WHERE id = NEW.parent_id AND kind = 'navigation'))
        OR (NEW.kind = 'navigation' AND EXISTS (SELECT 1 FROM org_units WHERE parent_id = NEW.id AND parent_relation <> 'navigation'));
    SELECT RAISE(ABORT, 'organization cycle') WHERE EXISTS (
        WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_id UNION SELECT u.parent_id FROM org_units u JOIN ancestors a ON u.id = a.id
            WHERE u.parent_id IS NOT NULL
        ) SELECT 1 FROM ancestors WHERE id = NEW.id
    );
END;

CREATE TABLE org_names (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL REFERENCES org_units(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('published', 'alternative', 'former')),
    evidence_id TEXT NOT NULL REFERENCES evidence_links(id),
    effective_from TEXT,
    effective_to TEXT,
    UNIQUE(unit_id, name, kind, evidence_id)
) STRICT;

CREATE TABLE role_targets (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    county_fips TEXT NOT NULL,
    documented_title TEXT NOT NULL CHECK(length(trim(documented_title)) > 0),
    evidence_id TEXT NOT NULL REFERENCES evidence_links(id),
    occupancy TEXT NOT NULL DEFAULT 'unknown' CHECK(occupancy IN ('unknown', 'occupied', 'explicitly_vacant')),
    occupancy_evidence_id TEXT REFERENCES evidence_links(id),
    UNIQUE(id, unit_id, county_fips),
    FOREIGN KEY(unit_id, county_fips) REFERENCES org_units(id, county_fips),
    CHECK(occupancy = 'unknown' OR occupancy_evidence_id IS NOT NULL)
) STRICT;

CREATE TABLE unit_coverage (
    unit_id TEXT NOT NULL REFERENCES org_units(id),
    axis TEXT NOT NULL CHECK(axis IN ('structure', 'leadership', 'named_staff', 'positions')),
    status TEXT NOT NULL CHECK(status IN ('not_started', 'partial', 'reviewed', 'stale', 'blocked')),
    evidence_id TEXT REFERENCES evidence_links(id),
    run_id TEXT REFERENCES research_runs(id),
    assessed_at TEXT,
    limitations TEXT,
    next_task TEXT,
    PRIMARY KEY(unit_id, axis),
    CHECK(status = 'not_started' OR (evidence_id IS NOT NULL AND run_id IS NOT NULL))
) STRICT;
CREATE TRIGGER initial_coverage AFTER INSERT ON org_units BEGIN
    INSERT INTO unit_coverage(unit_id, axis, status) VALUES
        (NEW.id, 'structure', 'not_started'), (NEW.id, 'leadership', 'not_started'),
        (NEW.id, 'named_staff', 'not_started'), (NEW.id, 'positions', 'not_started');
END;

CREATE TABLE source_unit_links (
    source_id TEXT NOT NULL REFERENCES sources(id),
    unit_id TEXT NOT NULL REFERENCES org_units(id),
    relation TEXT NOT NULL CHECK(relation IN ('personnel', 'structure', 'navigation', 'coverage_lead')),
    evidence_id TEXT NOT NULL REFERENCES evidence_links(id),
    PRIMARY KEY(source_id, unit_id, relation)
) STRICT;

CREATE TABLE research_people (
    id TEXT PRIMARY KEY,
    county_fips TEXT NOT NULL REFERENCES counties(fips),
    display_name TEXT NOT NULL,
    identity_state TEXT NOT NULL DEFAULT 'provisional' CHECK(identity_state IN ('provisional', 'evidence_supported')),
    identity_evidence_id TEXT REFERENCES evidence_links(id),
    UNIQUE(id, county_fips),
    CHECK(identity_state = 'provisional' OR identity_evidence_id IS NOT NULL)
) STRICT;

CREATE TABLE name_variants (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES research_people(id),
    published_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('published', 'nickname', 'former', 'alternative')),
    evidence_id TEXT NOT NULL REFERENCES evidence_links(id),
    UNIQUE(person_id, published_name, kind, evidence_id)
) STRICT;

CREATE TABLE role_claims (
    id TEXT PRIMARY KEY,
    county_fips TEXT NOT NULL REFERENCES counties(fips),
    evidence_id TEXT NOT NULL UNIQUE REFERENCES evidence_links(id),
    person_id TEXT,
    unit_id TEXT,
    target_id TEXT,
    published_name TEXT NOT NULL,
    published_title TEXT,
    responsibility TEXT,
    source_listing_status TEXT NOT NULL CHECK(source_listing_status IN ('Listed', 'Explicitly former', 'Unclear')),
    legacy_display_group TEXT,
    grouping_basis TEXT,
    department_label TEXT,
    division_label TEXT,
    program_location TEXT,
    program_context_type TEXT NOT NULL DEFAULT 'unknown' CHECK(program_context_type IN ('unknown', 'program', 'location')),
    affiliation TEXT,
    employment_start TEXT,
    employment_end TEXT,
    private_note TEXT,
    supersedes_id TEXT,
    UNIQUE(id, county_fips),
    FOREIGN KEY(person_id, county_fips) REFERENCES research_people(id, county_fips),
    FOREIGN KEY(unit_id, county_fips) REFERENCES org_units(id, county_fips),
    FOREIGN KEY(target_id, unit_id, county_fips) REFERENCES role_targets(id, unit_id, county_fips),
    FOREIGN KEY(supersedes_id, county_fips) REFERENCES role_claims(id, county_fips),
    CHECK(target_id IS NULL OR unit_id IS NOT NULL),
    CHECK(supersedes_id IS NULL OR supersedes_id <> id)
) STRICT;
CREATE INDEX claims_county_person ON role_claims(county_fips, person_id);
CREATE VIEW selected_role_claims AS
    SELECT c.* FROM role_claims c JOIN evidence_links e ON e.id = c.evidence_id
    JOIN scrape_batches b ON b.id = e.batch_id WHERE b.selected = 1;

CREATE TABLE possible_matches (
    id TEXT PRIMARY KEY,
    county_fips TEXT NOT NULL,
    person_a TEXT NOT NULL,
    person_b TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'same_supported', 'different_supported')),
    supporting_evidence_id TEXT REFERENCES evidence_links(id),
    conflicting_evidence_id TEXT REFERENCES evidence_links(id),
    rationale TEXT NOT NULL,
    decision_basis TEXT CHECK(decision_basis IN ('same_official_entry', 'official_connection', 'unique_county_contact', 'distinct_evidence')),
    resolution_evidence_id TEXT REFERENCES evidence_links(id),
    UNIQUE(person_a, person_b),
    FOREIGN KEY(person_a, county_fips) REFERENCES research_people(id, county_fips),
    FOREIGN KEY(person_b, county_fips) REFERENCES research_people(id, county_fips),
    CHECK(person_a < person_b),
    CHECK((status = 'open' AND decision_basis IS NULL AND resolution_evidence_id IS NULL)
       OR (status = 'same_supported' AND decision_basis IS NOT NULL AND decision_basis IN ('same_official_entry', 'official_connection', 'unique_county_contact') AND resolution_evidence_id IS NOT NULL)
       OR (status = 'different_supported' AND decision_basis IS NOT NULL AND decision_basis = 'distinct_evidence' AND resolution_evidence_id IS NOT NULL))
) STRICT;

CREATE TRIGGER claim_county_insert BEFORE INSERT ON role_claims BEGIN
    SELECT RAISE(ABORT, 'claim and delivery county differ') WHERE EXISTS (
        SELECT 1 FROM evidence_links e JOIN scrape_batches b ON b.id=e.batch_id
        WHERE e.id=NEW.evidence_id AND b.county_fips<>NEW.county_fips
    );
END;
CREATE TRIGGER claim_county_update BEFORE UPDATE OF county_fips, evidence_id ON role_claims BEGIN
    SELECT RAISE(ABORT, 'claim and delivery county differ') WHERE EXISTS (
        SELECT 1 FROM evidence_links e JOIN scrape_batches b ON b.id=e.batch_id
        WHERE e.id=NEW.evidence_id AND b.county_fips<>NEW.county_fips
    );
END;

CREATE TABLE source_visits (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    run_id TEXT NOT NULL REFERENCES research_runs(id),
    provenance TEXT NOT NULL CHECK(provenance IN ('observed', 'reconstructed', 'synthetic')),
    evidence_id TEXT REFERENCES evidence_links(id),
    reported_checked_date TEXT,
    attempted_at TEXT,
    actor TEXT,
    attempt INTEGER CHECK(attempt > 0),
    outcome TEXT CHECK(outcome IN ('success', 'not_modified', 'blocked', 'failed', 'not_found')),
    http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
    duration_ms INTEGER CHECK(duration_ms >= 0),
    content_sha256 TEXT,
    etag TEXT,
    last_modified TEXT,
    result_count INTEGER CHECK(result_count >= 0),
    note TEXT,
    CHECK(provenance <> 'reconstructed' OR evidence_id IS NOT NULL)
) STRICT;
CREATE INDEX visits_source_time ON source_visits(source_id, attempted_at);

CREATE TRIGGER source_unit_evidence_insert BEFORE INSERT ON source_unit_links BEGIN
    SELECT RAISE(ABORT, 'source link evidence belongs to another source') WHERE EXISTS (
        SELECT 1 FROM evidence_links WHERE id=NEW.evidence_id AND source_id<>NEW.source_id
    );
END;
CREATE TRIGGER source_unit_evidence_update BEFORE UPDATE OF source_id, evidence_id ON source_unit_links BEGIN
    SELECT RAISE(ABORT, 'source link evidence belongs to another source') WHERE EXISTS (
        SELECT 1 FROM evidence_links WHERE id=NEW.evidence_id AND source_id<>NEW.source_id
    );
END;
CREATE TRIGGER visit_evidence_insert BEFORE INSERT ON source_visits BEGIN
    SELECT RAISE(ABORT, 'visit evidence belongs to another source') WHERE EXISTS (
        SELECT 1 FROM evidence_links WHERE id=NEW.evidence_id AND source_id<>NEW.source_id
    );
END;
CREATE TRIGGER visit_evidence_update BEFORE UPDATE OF source_id, evidence_id ON source_visits BEGIN
    SELECT RAISE(ABORT, 'visit evidence belongs to another source') WHERE EXISTS (
        SELECT 1 FROM evidence_links WHERE id=NEW.evidence_id AND source_id<>NEW.source_id
    );
END;

-- Forward-compatible records only. R0 has no transport, execution, or Site IDs.
CREATE TABLE site_links (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES research_people(id),
    site_key TEXT NOT NULL,
    site_profile_id TEXT NOT NULL,
    remote_version INTEGER NOT NULL CHECK(remote_version > 0),
    observed_at TEXT NOT NULL,
    UNIQUE(site_key, person_id),
    UNIQUE(site_key, site_profile_id)
) STRICT;
CREATE TABLE sync_batches (
    id TEXT PRIMARY KEY,
    site_key TEXT NOT NULL,
    client_batch_id TEXT NOT NULL UNIQUE,
    contract_version TEXT NOT NULL,
    read_cursor TEXT,
    state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft', 'validated', 'applied', 'failed', 'reverted')),
    created_at TEXT NOT NULL,
    receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
    CHECK(state NOT IN ('applied', 'reverted') OR receipt_json IS NOT NULL)
) STRICT;
CREATE TABLE sync_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES sync_batches(id),
    claim_id TEXT NOT NULL REFERENCES role_claims(id),
    operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'archive', 'restore')),
    site_link_id TEXT REFERENCES site_links(id),
    expected_version INTEGER CHECK(expected_version > 0),
    resulting_version INTEGER CHECK(resulting_version > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    UNIQUE(batch_id, claim_id),
    CHECK((operation = 'create' AND site_link_id IS NULL AND expected_version IS NULL)
       OR (operation <> 'create' AND site_link_id IS NOT NULL AND expected_version IS NOT NULL))
) STRICT;
CREATE TABLE research_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES research_runs(id),
    kind TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    occurred_at TEXT,
    recorded_at TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance IN ('observed', 'reconstructed', 'synthetic')),
    detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
) STRICT;

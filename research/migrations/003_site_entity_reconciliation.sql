-- Profiles-only receipt reconciliation. Website rows and IDs remain authoritative.
CREATE TABLE site_entity_links (
    id TEXT PRIMARY KEY,
    site_key TEXT NOT NULL,
    local_entity_type TEXT NOT NULL CHECK(local_entity_type IN
        ('org_unit','org_affiliation','research_person','role_target','source','role_claim')),
    local_entity_id TEXT NOT NULL,
    website_entity TEXT NOT NULL CHECK(website_entity IN
        ('organizations','organization_county_affiliations','people','positions','role_sources','person_roles')),
    website_id TEXT NOT NULL,
    website_version INTEGER NOT NULL CHECK(website_version > 0),
    last_outcome TEXT NOT NULL CHECK(last_outcome IN ('created','reused','updated')),
    last_batch_id TEXT NOT NULL,
    link_state TEXT NOT NULL DEFAULT 'active' CHECK(link_state IN ('active','reverted','needs_refresh','conflict')),
    updated_at TEXT NOT NULL,
    UNIQUE(site_key, local_entity_type, local_entity_id),
    UNIQUE(site_key, website_entity, website_id)
) STRICT;

-- Preserve any pre-existing person-only Website ID mappings from R0.
INSERT INTO site_entity_links
    (id,site_key,local_entity_type,local_entity_id,website_entity,website_id,
     website_version,last_outcome,last_batch_id,link_state,updated_at)
SELECT 'legacy-' || id,site_key,'research_person',person_id,'people',site_profile_id,
       remote_version,'reused','legacy-site-link','active',observed_at
FROM site_links;

CREATE TABLE site_entity_lineage (
    link_id TEXT NOT NULL REFERENCES site_entity_links(id),
    evidence_id TEXT NOT NULL REFERENCES evidence_links(id),
    claim_id TEXT REFERENCES role_claims(id),
    PRIMARY KEY(link_id, evidence_id, claim_id)
) STRICT;

CREATE TABLE sync_submission_items (
    submission_id TEXT NOT NULL REFERENCES sync_submissions(id),
    item_index INTEGER NOT NULL CHECK(item_index >= 0),
    client_ref TEXT NOT NULL,
    website_entity TEXT NOT NULL CHECK(website_entity IN
        ('organizations','organization_county_affiliations','people','positions','role_sources','person_roles')),
    local_entity_type TEXT,
    local_entity_id TEXT,
    evidence_id TEXT REFERENCES evidence_links(id),
    claim_id TEXT REFERENCES role_claims(id),
    approval_id TEXT REFERENCES site_sync_update_approvals(id),
    request_item_json TEXT NOT NULL CHECK(json_valid(request_item_json)),
    PRIMARY KEY(submission_id, item_index),
    UNIQUE(submission_id, client_ref),
    CHECK((local_entity_type IS NULL AND local_entity_id IS NULL) OR
          (local_entity_type IS NOT NULL AND local_entity_id IS NOT NULL))
) STRICT;

CREATE TABLE sync_submission_receipts (
    submission_id TEXT PRIMARY KEY REFERENCES sync_submissions(id),
    state TEXT NOT NULL CHECK(state IN ('committed','rejected')),
    website_batch_id TEXT,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    recorded_at TEXT NOT NULL,
    CHECK((state = 'committed' AND website_batch_id IS NOT NULL) OR
          (state = 'rejected' AND website_batch_id IS NULL))
) STRICT;

CREATE TABLE sync_reversal_receipts (
    id TEXT PRIMARY KEY,
    site_key TEXT NOT NULL,
    website_batch_id TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK(state IN ('reverted','already_reverted','reversal_blocked')),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    recorded_at TEXT NOT NULL,
    UNIQUE(site_key,website_batch_id,receipt_sha256)
) STRICT;

CREATE TABLE sync_item_receipts (
    submission_id TEXT NOT NULL REFERENCES sync_submissions(id),
    item_index INTEGER NOT NULL,
    client_ref TEXT NOT NULL,
    website_entity TEXT NOT NULL,
    local_entity_type TEXT,
    local_entity_id TEXT,
    website_id TEXT,
    website_version INTEGER,
    outcome TEXT CHECK(outcome IN ('created','reused','updated')),
    status TEXT NOT NULL CHECK(status IN ('committed','rejected')),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    PRIMARY KEY(submission_id, item_index),
    FOREIGN KEY(submission_id,item_index) REFERENCES sync_submission_items(submission_id,item_index),
    CHECK((status='committed' AND website_id IS NOT NULL AND website_version > 0 AND outcome IS NOT NULL)
       OR (status='rejected' AND website_id IS NULL AND website_version IS NULL AND outcome IS NULL))
) STRICT;

CREATE TABLE site_sync_update_approvals (
    id TEXT PRIMARY KEY,
    site_key TEXT NOT NULL,
    local_entity_type TEXT NOT NULL CHECK(local_entity_type IN
        ('org_unit','research_person','role_target','source','role_claim')),
    local_entity_id TEXT NOT NULL,
    fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
    expected_version INTEGER NOT NULL CHECK(expected_version > 0),
    evidence_id TEXT NOT NULL REFERENCES evidence_links(id),
    state TEXT NOT NULL CHECK(state IN ('approved','consumed','rejected')),
    approved_at TEXT NOT NULL,
    consumed_submission_id TEXT REFERENCES sync_submissions(id),
    UNIQUE(site_key,local_entity_type,local_entity_id,state),
    CHECK((state='consumed' AND consumed_submission_id IS NOT NULL) OR state<>'consumed')
) STRICT;

CREATE UNIQUE INDEX site_entity_lineage_exact ON site_entity_lineage
    (link_id,evidence_id,ifnull(claim_id,''));

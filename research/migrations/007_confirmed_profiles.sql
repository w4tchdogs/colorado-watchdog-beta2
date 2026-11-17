-- Adds the confirmed Profiles tables and the conclusion and overview views.
-- Existing research and Website sync rows are not read or changed. The new
-- confirmed tables start empty and are filled only by reviewed promotion.

-- One confirmed county relationship per profile. The two foreign keys are
-- deferred together, so a profile and its county row must be inserted in one
-- transaction and neither can be removed alone.
CREATE TABLE "profile_county" (
    "Profile ID" TEXT PRIMARY KEY REFERENCES "profile"("Profile ID") DEFERRABLE INITIALLY DEFERRED,
    "County code" TEXT NOT NULL REFERENCES "county"("County code"),
    "Recorded on" TEXT NOT NULL,
    UNIQUE("Profile ID", "County code")
) STRICT;

CREATE TABLE "profile" (
    "Profile ID" TEXT PRIMARY KEY REFERENCES "profile_county"("Profile ID") DEFERRABLE INITIALLY DEFERRED,
    "Full name" TEXT NOT NULL CHECK(length(trim("Full name")) > 0),
    "Promotion reviewed by" TEXT NOT NULL CHECK(length(trim("Promotion reviewed by")) > 0),
    "Promotion reviewed on" TEXT NOT NULL CHECK(length(trim("Promotion reviewed on")) > 0),
    "Reviewer notes" TEXT,
    "Created on" TEXT NOT NULL
) STRICT;

CREATE TABLE "profile_county_unit" (
    "County unit ID" TEXT PRIMARY KEY,
    "County code" TEXT NOT NULL REFERENCES "county"("County code"),
    "Unit name" TEXT NOT NULL CHECK(length(trim("Unit name")) > 0),
    "Organization type" TEXT NOT NULL CHECK("Organization type" IN ('unknown', 'elected_office', 'appointed_office', 'department', 'division', 'subunit', 'partner', 'navigation')),
    "Research unit ID" TEXT,
    "Parent county unit" TEXT,
    "Evidence record ID" TEXT NOT NULL REFERENCES "research_evidence"("Evidence record ID"),
    "Reviewed by" TEXT NOT NULL CHECK(length(trim("Reviewed by")) > 0),
    "Reviewed on" TEXT NOT NULL CHECK(length(trim("Reviewed on")) > 0),
    UNIQUE("County unit ID", "County code"),
    UNIQUE("County unit ID", "Research unit ID", "County code"),
    FOREIGN KEY("Research unit ID", "County code") REFERENCES "county_research_unit_structure"("Office or unit ID", "County code"),
    FOREIGN KEY("Parent county unit", "County code") REFERENCES "profile_county_unit"("County unit ID", "County code"),
    CHECK("Parent county unit" IS NULL OR "Parent county unit" <> "County unit ID")
) STRICT;

CREATE TABLE "profile_evidence" (
    "Profile evidence ID" TEXT PRIMARY KEY,
    "Profile ID" TEXT NOT NULL,
    "County code" TEXT NOT NULL,
    "Research profile ID" TEXT NOT NULL,
    "Evidence record ID" TEXT NOT NULL REFERENCES "research_evidence"("Evidence record ID"),
    "Reviewer notes" TEXT,
    "Recorded on" TEXT NOT NULL,
    UNIQUE("Profile ID", "Evidence record ID"),
    UNIQUE("Profile evidence ID", "Profile ID", "County code"),
    FOREIGN KEY("Profile ID", "County code") REFERENCES "profile_county"("Profile ID", "County code"),
    FOREIGN KEY("Research profile ID", "County code") REFERENCES "profile_research"("Profile ID", "County code")
) STRICT;

CREATE TABLE "profile_evidence_citation" (
    "Citation ID" TEXT PRIMARY KEY,
    "Profile evidence ID" TEXT NOT NULL REFERENCES "profile_evidence"("Profile evidence ID"),
    "Source ID" TEXT NOT NULL REFERENCES "research_sources"("Source ID"),
    "Public URL" TEXT NOT NULL CHECK("Public URL" LIKE 'https://%' OR "Public URL" LIKE 'http://%'),
    "Public title" TEXT NOT NULL CHECK(length(trim("Public title")) > 0),
    "Publisher type" TEXT NOT NULL CHECK("Publisher type" IN ('official', 'unofficial', 'unresolved')),
    "Page type" TEXT NOT NULL CHECK(length(trim("Page type")) > 0),
    "Verified on" TEXT NOT NULL CHECK(length(trim("Verified on")) > 0),
    UNIQUE("Profile evidence ID", "Public URL"),
    UNIQUE("Citation ID", "Profile evidence ID")
) STRICT;

CREATE TABLE "profile_position" (
    "Profile position ID" TEXT PRIMARY KEY,
    "County code" TEXT NOT NULL,
    "County unit ID" TEXT NOT NULL,
    "Position title" TEXT NOT NULL CHECK(length(trim("Position title")) > 0),
    "Research unit ID" TEXT,
    "Research position ID" TEXT,
    "Evidence record ID" TEXT NOT NULL REFERENCES "research_evidence"("Evidence record ID"),
    UNIQUE("Profile position ID", "County unit ID", "County code"),
    FOREIGN KEY("County unit ID", "County code") REFERENCES "profile_county_unit"("County unit ID", "County code"),
    FOREIGN KEY("County unit ID", "Research unit ID", "County code") REFERENCES "profile_county_unit"("County unit ID", "Research unit ID", "County code"),
    FOREIGN KEY("Research position ID", "Research unit ID", "County code") REFERENCES "county_research_positions"("Position ID", "Office or unit ID", "County code"),
    CHECK("Research position ID" IS NULL OR "Research unit ID" IS NOT NULL)
) STRICT;

CREATE TABLE "profile_role" (
    "Role ID" TEXT PRIMARY KEY,
    "Profile ID" TEXT NOT NULL,
    "County code" TEXT NOT NULL,
    "County unit ID" TEXT,
    "Profile position ID" TEXT,
    "Office or department" TEXT,
    "Position title" TEXT,
    "Job description or duties" TEXT,
    "Employment start date" TEXT,
    "Employment end date" TEXT,
    "Affiliation" TEXT,
    "Affiliation evidence record ID" TEXT REFERENCES "research_evidence"("Evidence record ID"),
    UNIQUE("Role ID", "Profile ID", "County code"),
    FOREIGN KEY("Profile ID", "County code") REFERENCES "profile_county"("Profile ID", "County code"),
    FOREIGN KEY("County unit ID", "County code") REFERENCES "profile_county_unit"("County unit ID", "County code"),
    FOREIGN KEY("Profile position ID", "County unit ID", "County code") REFERENCES "profile_position"("Profile position ID", "County unit ID", "County code"),
    CHECK("Profile position ID" IS NULL OR "County unit ID" IS NOT NULL),
    CHECK("County unit ID" IS NOT NULL
       OR length(trim(coalesce("Office or department", ''))) > 0
       OR length(trim(coalesce("Position title", ''))) > 0
       OR length(trim(coalesce("Job description or duties", ''))) > 0),
    CHECK("Employment end date" IS NULL OR "Employment start date" IS NULL OR "Employment end date" >= "Employment start date"),
    CHECK("Affiliation" IS NULL OR "Affiliation evidence record ID" IS NOT NULL)
) STRICT;

CREATE TABLE "profile_evidence_role" (
    "Role ID" TEXT NOT NULL,
    "Role claim ID" TEXT NOT NULL,
    "Profile evidence ID" TEXT NOT NULL,
    "Profile ID" TEXT NOT NULL,
    "County code" TEXT NOT NULL,
    "Citation ID" TEXT,
    PRIMARY KEY("Role ID", "Role claim ID"),
    FOREIGN KEY("Role ID", "Profile ID", "County code") REFERENCES "profile_role"("Role ID", "Profile ID", "County code"),
    FOREIGN KEY("Role claim ID", "County code") REFERENCES "profile_research_role"("Role claim ID", "County code"),
    FOREIGN KEY("Profile evidence ID", "Profile ID", "County code") REFERENCES "profile_evidence"("Profile evidence ID", "Profile ID", "County code"),
    FOREIGN KEY("Citation ID", "Profile evidence ID") REFERENCES "profile_evidence_citation"("Citation ID", "Profile evidence ID")
) STRICT;

CREATE TABLE "profile_revisions" (
    "Revision ID" TEXT PRIMARY KEY,
    "Profile ID" TEXT NOT NULL REFERENCES "profile_county"("Profile ID"),
    "Revision number" INTEGER NOT NULL CHECK("Revision number" > 0),
    "Revision status" TEXT NOT NULL DEFAULT 'proposed' CHECK("Revision status" IN ('proposed', 'approved', 'rejected', 'superseded')),
    "Public revision" TEXT NOT NULL CHECK(json_valid("Public revision")),
    "Revision fingerprint" TEXT NOT NULL CHECK(length("Revision fingerprint") = 64 AND "Revision fingerprint" NOT GLOB '*[^0-9a-f]*'),
    "Earlier revision" TEXT REFERENCES "profile_revisions"("Revision ID"),
    "Proposed by" TEXT NOT NULL CHECK(length(trim("Proposed by")) > 0),
    "Proposed on" TEXT NOT NULL,
    "Reviewed by" TEXT,
    "Reviewed on" TEXT,
    "Review reason" TEXT,
    "Website request ID" TEXT REFERENCES "website_requests"(id),
    UNIQUE("Profile ID", "Revision number"),
    UNIQUE("Profile ID", "Revision fingerprint"),
    CHECK("Earlier revision" IS NULL OR "Earlier revision" <> "Revision ID"),
    CHECK("Revision status" = 'proposed' OR ("Reviewed by" IS NOT NULL AND "Reviewed on" IS NOT NULL) OR "Revision status" = 'superseded'),
    CHECK("Website request ID" IS NULL OR "Revision status" IN ('approved', 'superseded'))
) STRICT;

CREATE INDEX profile_county_by_county ON "profile_county"("County code");
CREATE INDEX profile_county_unit_research ON "profile_county_unit"("Research unit ID", "County code");
CREATE INDEX profile_evidence_research_identity ON "profile_evidence"("Research profile ID", "County code");
CREATE INDEX profile_role_profile ON "profile_role"("Profile ID", "County code");
CREATE INDEX profile_evidence_role_claim ON "profile_evidence_role"("Role claim ID", "County code");
CREATE INDEX profile_revisions_request ON "profile_revisions"("Website request ID") WHERE "Website request ID" IS NOT NULL;

-- Promotion needs an evidence-supported research identity.
CREATE TRIGGER profile_evidence_requires_supported_identity BEFORE INSERT ON "profile_evidence"
WHEN NOT EXISTS (SELECT 1 FROM "profile_research"
                 WHERE "Profile ID" = NEW."Research profile ID" AND "County code" = NEW."County code"
                   AND "Identity review status" = 'evidence_supported')
BEGIN SELECT RAISE(ABORT, 'Research identity must be evidence_supported'); END;

CREATE TRIGGER profile_evidence_requires_supported_identity_update
BEFORE UPDATE OF "Research profile ID", "County code" ON "profile_evidence"
WHEN NOT EXISTS (SELECT 1 FROM "profile_research"
                 WHERE "Profile ID" = NEW."Research profile ID" AND "County code" = NEW."County code"
                   AND "Identity review status" = 'evidence_supported')
BEGIN SELECT RAISE(ABORT, 'Research identity must be evidence_supported'); END;

CREATE TRIGGER profile_evidence_preserves_observation_identity
BEFORE UPDATE OF "Research profile ID" ON "profile_evidence"
WHEN NEW."Research profile ID" IS NOT OLD."Research profile ID" AND EXISTS (
    SELECT 1 FROM "profile_evidence_role" link
    JOIN "profile_research_role" observation ON observation."Role claim ID" = link."Role claim ID"
    WHERE link."Profile evidence ID" = OLD."Profile evidence ID"
      AND observation."Linked profile" IS NOT NEW."Research profile ID")
BEGIN SELECT RAISE(ABORT, 'Observation must be linked to the research identity of the evidence'); END;

CREATE TRIGGER profile_evidence_preserves_citation_source
BEFORE UPDATE OF "Evidence record ID" ON "profile_evidence"
WHEN NEW."Evidence record ID" IS NOT OLD."Evidence record ID" AND EXISTS (
    SELECT 1 FROM "profile_evidence_citation" citation
    WHERE citation."Profile evidence ID" = OLD."Profile evidence ID" AND NOT EXISTS (
        SELECT 1 FROM "research_evidence" evidence
        WHERE evidence."Evidence record ID" = NEW."Evidence record ID" AND evidence."Source ID" = citation."Source ID"))
BEGIN SELECT RAISE(ABORT, 'Citation source must match its evidence source'); END;

-- A role's observation must belong to the research identity behind the evidence.
CREATE TRIGGER profile_evidence_role_matches_identity BEFORE INSERT ON "profile_evidence_role"
WHEN NOT EXISTS (
    SELECT 1 FROM "profile_evidence" e JOIN "profile_research_role" c ON c."Role claim ID" = NEW."Role claim ID"
    WHERE e."Profile evidence ID" = NEW."Profile evidence ID" AND c."Linked profile" = e."Research profile ID")
BEGIN SELECT RAISE(ABORT, 'Observation must be linked to the research identity of the evidence'); END;

CREATE TRIGGER profile_evidence_role_matches_identity_update
BEFORE UPDATE OF "Profile evidence ID", "Role claim ID" ON "profile_evidence_role"
WHEN NOT EXISTS (
    SELECT 1 FROM "profile_evidence" e JOIN "profile_research_role" c ON c."Role claim ID" = NEW."Role claim ID"
    WHERE e."Profile evidence ID" = NEW."Profile evidence ID" AND c."Linked profile" = e."Research profile ID")
BEGIN SELECT RAISE(ABORT, 'Observation must be linked to the research identity of the evidence'); END;

-- A citation's private source must be the source of its supporting evidence.
CREATE TRIGGER profile_citation_source_insert BEFORE INSERT ON "profile_evidence_citation"
WHEN NOT EXISTS (SELECT 1 FROM "profile_evidence" pe JOIN "research_evidence" e ON e."Evidence record ID" = pe."Evidence record ID"
                 WHERE pe."Profile evidence ID" = NEW."Profile evidence ID" AND e."Source ID" = NEW."Source ID")
BEGIN SELECT RAISE(ABORT, 'Citation source must match its evidence source'); END;

CREATE TRIGGER profile_citation_source_update BEFORE UPDATE OF "Profile evidence ID", "Source ID" ON "profile_evidence_citation"
WHEN NOT EXISTS (SELECT 1 FROM "profile_evidence" pe JOIN "research_evidence" e ON e."Evidence record ID" = pe."Evidence record ID"
                 WHERE pe."Profile evidence ID" = NEW."Profile evidence ID" AND e."Source ID" = NEW."Source ID")
BEGIN SELECT RAISE(ABORT, 'Citation source must match its evidence source'); END;

-- A researched unit's parent comes from County Research.
CREATE TRIGGER profile_county_unit_parent_insert BEFORE INSERT ON "profile_county_unit"
WHEN NEW."Research unit ID" IS NOT NULL AND NEW."Parent county unit" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "profile_county_unit" p WHERE p."County unit ID" = NEW."Parent county unit" AND p."Research unit ID" IS NOT NULL)
 AND NOT EXISTS (
    SELECT 1 FROM "county_research_unit_structure" s JOIN "profile_county_unit" p ON p."County unit ID" = NEW."Parent county unit"
    WHERE s."Office or unit ID" = NEW."Research unit ID" AND s."Parent office or unit" = p."Research unit ID")
BEGIN SELECT RAISE(ABORT, 'Parent must match the researched unit parent'); END;

CREATE TRIGGER profile_county_unit_parent_update BEFORE UPDATE OF "Research unit ID", "Parent county unit" ON "profile_county_unit"
WHEN NEW."Research unit ID" IS NOT NULL AND NEW."Parent county unit" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "profile_county_unit" p WHERE p."County unit ID" = NEW."Parent county unit" AND p."Research unit ID" IS NOT NULL)
 AND NOT EXISTS (
    SELECT 1 FROM "county_research_unit_structure" s JOIN "profile_county_unit" p ON p."County unit ID" = NEW."Parent county unit"
    WHERE s."Office or unit ID" = NEW."Research unit ID" AND s."Parent office or unit" = p."Research unit ID")
BEGIN SELECT RAISE(ABORT, 'Parent must match the researched unit parent'); END;

CREATE TRIGGER profile_county_unit_preserves_researched_children
BEFORE UPDATE OF "Research unit ID" ON "profile_county_unit"
WHEN NEW."Research unit ID" IS NOT NULL AND NEW."Research unit ID" IS NOT OLD."Research unit ID" AND EXISTS (
    SELECT 1 FROM "profile_county_unit" child
    JOIN "county_research_unit_structure" source ON source."Office or unit ID" = child."Research unit ID"
    WHERE child."Parent county unit" = OLD."County unit ID"
      AND source."Parent office or unit" IS NOT NEW."Research unit ID")
BEGIN SELECT RAISE(ABORT, 'Parent must match the researched unit parent'); END;

-- The approved public revision stays immutable after supersession.
CREATE TRIGGER profile_revision_approved_immutable BEFORE UPDATE ON "profile_revisions"
WHEN OLD."Revision status" IN ('approved', 'superseded') AND (
    NEW."Revision ID" IS NOT OLD."Revision ID" OR NEW."Profile ID" IS NOT OLD."Profile ID"
    OR NEW."Revision number" IS NOT OLD."Revision number"
    OR NEW."Public revision" IS NOT OLD."Public revision" OR NEW."Revision fingerprint" IS NOT OLD."Revision fingerprint"
    OR NEW."Earlier revision" IS NOT OLD."Earlier revision" OR NEW."Proposed by" IS NOT OLD."Proposed by"
    OR NEW."Proposed on" IS NOT OLD."Proposed on" OR NEW."Reviewed by" IS NOT OLD."Reviewed by"
    OR NEW."Reviewed on" IS NOT OLD."Reviewed on" OR NEW."Review reason" IS NOT OLD."Review reason"
    OR (NEW."Revision status" IS NOT OLD."Revision status" AND NEW."Revision status" <> 'superseded')
    OR (NEW."Website request ID" IS NOT OLD."Website request ID"
        AND (OLD."Website request ID" IS NOT NULL OR NEW."Revision status" <> 'approved')))
BEGIN SELECT RAISE(ABORT, 'Approved revision is immutable'); END;

CREATE TRIGGER profile_revision_approved_no_delete BEFORE DELETE ON "profile_revisions"
WHEN OLD."Revision status" IN ('approved', 'superseded')
BEGIN SELECT RAISE(ABORT, 'Approved revision cannot be deleted'); END;

-- SQLite REPLACE can delete a conflicting row without running its delete trigger.
CREATE TRIGGER profile_revision_approved_no_replace BEFORE INSERT ON "profile_revisions"
WHEN EXISTS (SELECT 1 FROM "profile_revisions" r
             WHERE r."Revision status" IN ('approved', 'superseded')
               AND (r."Revision ID" = NEW."Revision ID" OR (r."Profile ID" = NEW."Profile ID"
                    AND (r."Revision number" = NEW."Revision number" OR r."Revision fingerprint" = NEW."Revision fingerprint"))))
BEGIN SELECT RAISE(ABORT, 'Approved revision is immutable'); END;

CREATE TRIGGER profile_revision_approved_no_replace_update
BEFORE UPDATE OF "Revision ID", "Profile ID", "Revision number", "Revision fingerprint" ON "profile_revisions"
WHEN EXISTS (SELECT 1 FROM "profile_revisions" r
             WHERE r."Revision ID" <> OLD."Revision ID" AND r."Revision status" IN ('approved', 'superseded')
               AND (r."Revision ID" = NEW."Revision ID" OR (r."Profile ID" = NEW."Profile ID"
                    AND (r."Revision number" = NEW."Revision number" OR r."Revision fingerprint" = NEW."Revision fingerprint"))))
BEGIN SELECT RAISE(ABORT, 'Approved revision is immutable'); END;

-- Observations in a selected intake batch, or without a batch, count as current findings.
CREATE VIEW profile_research_conclusions AS
SELECT rp."Profile ID" AS "Research profile ID",
       rp."County code",
       c."County name",
       rp."Full name",
       rp."Evidence for identity",
       e."Source URL as observed" AS "Identity source URL",
       s."Publisher type" AS "Identity source publisher",
       (SELECT count(*) FROM "profile_research_role" r
          JOIN "research_evidence" re ON re."Evidence record ID" = r."Evidence record ID"
          LEFT JOIN "research_scrapes" b ON b.id = re."Import batch ID"
         WHERE r."Linked profile" = rp."Profile ID" AND r."County code" = rp."County code"
           AND (re."Import batch ID" IS NULL OR b.selected = 1)) AS "Current role observations",
       (SELECT count(*) FROM "profile_research_role" r
          JOIN "research_evidence" re ON re."Evidence record ID" = r."Evidence record ID"
          LEFT JOIN "research_scrapes" b ON b.id = re."Import batch ID"
         WHERE r."Linked profile" = rp."Profile ID" AND r."County code" = rp."County code"
           AND r."Listing status" = 'Listed'
           AND (re."Import batch ID" IS NULL OR b.selected = 1)) AS "Listed role observations",
       (SELECT count(*) FROM "profile_research_role" r
         WHERE r."Linked profile" = rp."Profile ID" AND r."County code" = rp."County code"
           AND r."Linked office or unit" IS NOT NULL) AS "Observations with a researched unit",
       (SELECT min(pe."Profile ID") FROM "profile_evidence" pe
         WHERE pe."Research profile ID" = rp."Profile ID" AND pe."County code" = rp."County code") AS "Confirmed profile ID",
       CASE WHEN EXISTS (SELECT 1 FROM "profile_evidence" pe
                          WHERE pe."Research profile ID" = rp."Profile ID" AND pe."County code" = rp."County code")
            THEN 'Promoted' ELSE 'Ready for promotion review' END AS "Promotion state"
FROM "profile_research" rp
JOIN "county" c ON c."County code" = rp."County code"
JOIN "research_evidence" e ON e."Evidence record ID" = rp."Evidence for identity"
JOIN "research_sources" s ON s."Source ID" = e."Source ID"
WHERE rp."Identity review status" = 'evidence_supported';

CREATE VIEW county_research_conclusions AS
SELECT u."Office or unit ID",
       u."County code",
       c."County name",
       u."Office or unit label as published",
       u."Organization type",
       u."Parent office or unit",
       pu."Office or unit label as published" AS "Parent label as published",
       u."Relationship to parent",
       u."Evidence for parent relationship",
       pe."Source URL as observed" AS "Parent relationship source URL",
       u."Applies from",
       u."Applies until",
       (SELECT count(*) FROM "county_research_positions" p WHERE p."Office or unit ID" = u."Office or unit ID") AS "Documented positions",
       (SELECT count(*) FROM "county_research_positions" p
         WHERE p."Office or unit ID" = u."Office or unit ID" AND p."Position occupancy status" = 'occupied') AS "Occupied positions",
       (SELECT count(*) FROM "profile_research_role" r
          JOIN "research_evidence" re ON re."Evidence record ID" = r."Evidence record ID"
          LEFT JOIN "research_scrapes" b ON b.id = re."Import batch ID"
         WHERE r."Linked office or unit" = u."Office or unit ID"
           AND (re."Import batch ID" IS NULL OR b.selected = 1)) AS "Current role observations",
       (SELECT count(*) FROM "county_research_coverage" cv
         WHERE cv.unit_id = u."Office or unit ID" AND cv.status = 'reviewed') AS "Coverage areas reviewed",
       (SELECT count(*) FROM "profile_county_unit" cu
         WHERE cu."Research unit ID" = u."Office or unit ID") AS "Confirmed county units"
FROM "county_research_unit_structure" u
JOIN "county" c ON c."County code" = u."County code"
LEFT JOIN "county_research_unit_structure" pu ON pu."Office or unit ID" = u."Parent office or unit"
LEFT JOIN "research_evidence" pe ON pe."Evidence record ID" = u."Evidence for parent relationship";

-- Sync state. Synced needs an acknowledged request whose committed receipt
-- matches the Website batch, with no rejected item and no reversal, tied to
-- the latest approved revision that is also the latest revision.
CREATE VIEW profiles_overview AS
SELECT p."Profile ID",
       p."Full name",
       pc."County code",
       c."County name",
       (SELECT group_concat(label, '; ') FROM (
            SELECT CASE
                     WHEN length(trim(coalesce(r."Position title", ''))) > 0
                          AND length(trim(coalesce(r."Office or department", ''))) > 0
                       THEN r."Position title" || ' (' || r."Office or department" || ')'
                     WHEN length(trim(coalesce(r."Position title", ''))) > 0 THEN r."Position title"
                     WHEN length(trim(coalesce(r."Office or department", ''))) > 0 THEN r."Office or department"
                     WHEN length(trim(coalesce(r."Job description or duties", ''))) > 0 THEN r."Job description or duties"
                     ELSE coalesce(u."Unit name", 'Role')
                   END AS label
            FROM "profile_role" r
            LEFT JOIN "profile_county_unit" u ON u."County unit ID" = r."County unit ID"
            WHERE r."Profile ID" = p."Profile ID" ORDER BY r."Role ID")) AS "Roles",
       (SELECT count(*) FROM "profile_role" r WHERE r."Profile ID" = p."Profile ID") AS "Role count",
       lr."Revision number" AS "Latest revision",
       lr."Revision status" AS "Latest revision status",
       la."Revision number" AS "Approved revision",
       la."Website request ID",
       CASE
         WHEN lr."Revision status" = 'proposed' THEN 'Changes to review'
         WHEN la."Revision ID" IS NULL OR lr."Revision ID" IS NOT la."Revision ID" THEN 'Confirmed'
         WHEN la."Website request ID" IS NULL THEN 'Ready to sync'
         WHEN wr.state = 'pending' THEN 'Pending submission'
         WHEN wr.state = 'acknowledged'
              AND EXISTS (SELECT 1 FROM "website_request_receipts" rc
                          WHERE rc.submission_id = wr.id AND rc.state = 'committed'
                            AND rc.website_batch_id = wr.remote_batch_id)
              AND EXISTS (SELECT 1 FROM "website_request_changes" planned WHERE planned.submission_id = wr.id)
              AND NOT EXISTS (
                  SELECT 1 FROM "website_request_changes" planned
                  WHERE planned.submission_id = wr.id AND NOT EXISTS (
                      SELECT 1 FROM "website_change_receipts" ic
                      WHERE ic.submission_id = planned.submission_id AND ic.item_index = planned.item_index
                        AND ic.client_ref = planned.client_ref AND ic.website_entity = planned.website_entity
                        AND ic.status = 'committed'))
              AND NOT EXISTS (SELECT 1 FROM "website_reversal_receipts" rv
                              WHERE rv.site_key = wr.site_key AND rv.website_batch_id = wr.remote_batch_id
                                AND rv.state IN ('reverted', 'already_reverted'))
           THEN 'Synced'
         ELSE 'Ready to sync'
       END AS "Sync state"
FROM "profile" p
JOIN "profile_county" pc ON pc."Profile ID" = p."Profile ID"
JOIN "county" c ON c."County code" = pc."County code"
LEFT JOIN "profile_revisions" lr ON lr."Profile ID" = p."Profile ID"
     AND lr."Revision number" = (SELECT max(x."Revision number") FROM "profile_revisions" x WHERE x."Profile ID" = p."Profile ID")
LEFT JOIN "profile_revisions" la ON la."Profile ID" = p."Profile ID" AND la."Revision status" = 'approved'
     AND la."Revision number" = (SELECT max(x."Revision number") FROM "profile_revisions" x
                                 WHERE x."Profile ID" = p."Profile ID" AND x."Revision status" = 'approved')
LEFT JOIN "website_requests" wr ON wr.id = la."Website request ID";

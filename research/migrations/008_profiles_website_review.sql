-- Add verified name components and confirmed, evidence-linked alternate names.
-- Existing full names and all earlier rows remain untouched.
ALTER TABLE "profile" ADD COLUMN "First Name" TEXT;
ALTER TABLE "profile" ADD COLUMN "Middle Name" TEXT;
ALTER TABLE "profile" ADD COLUMN "Last Name" TEXT;
ALTER TABLE "profile" ADD COLUMN "Name components evidence ID" TEXT REFERENCES "profile_evidence"("Profile evidence ID");

CREATE TABLE "profile_alternate_name" (
    "Alternate name ID" TEXT PRIMARY KEY,
    "Profile ID" TEXT NOT NULL REFERENCES "profile"("Profile ID"),
    "Alternate name" TEXT NOT NULL CHECK(length(trim("Alternate name")) > 0),
    "Profile evidence ID" TEXT NOT NULL REFERENCES "profile_evidence"("Profile evidence ID"),
    "Display order" INTEGER NOT NULL CHECK("Display order" > 0),
    "Recorded on" TEXT NOT NULL,
    UNIQUE("Profile ID", "Alternate name"),
    UNIQUE("Profile ID", "Display order")
) STRICT;

CREATE INDEX profile_alternate_name_display
ON "profile_alternate_name"("Profile ID", "Display order", "Alternate name ID");

CREATE TRIGGER profile_name_components_insert BEFORE INSERT ON "profile"
WHEN (NEW."First Name" IS NOT NULL OR NEW."Middle Name" IS NOT NULL OR NEW."Last Name" IS NOT NULL)
 AND (NEW."Name components evidence ID" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "profile_evidence" e
       WHERE e."Profile evidence ID" = NEW."Name components evidence ID"
         AND e."Profile ID" = NEW."Profile ID"))
BEGIN SELECT RAISE(ABORT, 'Verified name components require this profile evidence'); END;

CREATE TRIGGER profile_name_components_update
BEFORE UPDATE OF "First Name", "Middle Name", "Last Name", "Name components evidence ID", "Profile ID" ON "profile"
WHEN (NEW."First Name" IS NOT NULL OR NEW."Middle Name" IS NOT NULL OR NEW."Last Name" IS NOT NULL)
 AND (NEW."Name components evidence ID" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "profile_evidence" e
       WHERE e."Profile evidence ID" = NEW."Name components evidence ID"
         AND e."Profile ID" = NEW."Profile ID"))
BEGIN SELECT RAISE(ABORT, 'Verified name components require this profile evidence'); END;

CREATE TRIGGER profile_alternate_name_insert BEFORE INSERT ON "profile_alternate_name"
WHEN NOT EXISTS (SELECT 1 FROM "profile_evidence" e
                  WHERE e."Profile evidence ID" = NEW."Profile evidence ID"
                    AND e."Profile ID" = NEW."Profile ID")
BEGIN SELECT RAISE(ABORT, 'Alternate name evidence must belong to this profile'); END;

CREATE TRIGGER profile_alternate_name_update
BEFORE UPDATE OF "Profile ID", "Profile evidence ID" ON "profile_alternate_name"
WHEN NOT EXISTS (SELECT 1 FROM "profile_evidence" e
                  WHERE e."Profile evidence ID" = NEW."Profile evidence ID"
                    AND e."Profile ID" = NEW."Profile ID")
BEGIN SELECT RAISE(ABORT, 'Alternate name evidence must belong to this profile'); END;

-- An existing evidence row cannot be reattached to another profile while it
-- supports a verified name. The ordinary FK also prevents deleting it.
CREATE TRIGGER profile_name_evidence_owner_update
BEFORE UPDATE OF "Profile ID" ON "profile_evidence"
WHEN EXISTS (SELECT 1 FROM "profile" p WHERE p."Name components evidence ID" = OLD."Profile evidence ID")
  OR EXISTS (SELECT 1 FROM "profile_alternate_name" a WHERE a."Profile evidence ID" = OLD."Profile evidence ID")
BEGIN SELECT RAISE(ABORT, 'Name evidence owner cannot change'); END;

-- The hierarchy follows confirmed parent links, checked against County
-- Research. Administrative and statutory edges are reporting relationships;
-- navigation edges are only display groupings. An unconfirmed parent is not
-- inferred from Research. Recursive traversal stops at the confirmed root.
CREATE VIEW profiles_website_review AS
WITH RECURSIVE unit_path("Role ID", "County unit ID", "Parent county unit", "Unit name", "Research unit ID", depth, path, grouped) AS (
    SELECT r."Role ID", u."County unit ID", u."Parent county unit", u."Unit name", u."Research unit ID",
           0, '', 0
      FROM "profile_role" r
      JOIN "profile_county_unit" u ON u."County unit ID" = r."County unit ID"
    UNION ALL
    SELECT up."Role ID", parent."County unit ID", parent."Parent county unit", parent."Unit name", parent."Research unit ID",
           up.depth + 1,
           CASE WHEN up.path = '' THEN up."Unit name" ELSE up."Unit name" || ' › ' || up.path END,
           CASE WHEN research."Relationship to parent" = 'navigation' THEN 1 ELSE up.grouped END
      FROM unit_path up
      JOIN "profile_county_unit" parent ON parent."County unit ID" = up."Parent county unit"
      LEFT JOIN "county_research_unit_structure" research ON research."Office or unit ID" = up."Research unit ID"
     WHERE up.depth < 32
       AND (up."Research unit ID" IS NULL OR parent."Research unit ID" IS NULL
            OR (research."Parent office or unit" = parent."Research unit ID"
                AND research."Relationship to parent" IN ('administrative', 'statutory', 'navigation')))
),
unit_display AS (
    SELECT up."Role ID", up."Unit name" AS county_unit,
           CASE WHEN up.path = '' THEN NULL
                WHEN up.grouped = 1 THEN 'Grouped under: ' || up.path
                ELSE up.path END AS county_sub_unit
      FROM unit_path up
     WHERE up."Parent county unit" IS NULL
        OR NOT EXISTS (SELECT 1 FROM unit_path parent
                        WHERE parent."Role ID" = up."Role ID" AND parent.depth = up.depth + 1)
),
alternate_display AS (
    SELECT a."Profile ID", a."Alternate name",
           row_number() OVER (PARTITION BY a."Profile ID" ORDER BY a."Display order", a."Alternate name ID") AS ordinal
      FROM "profile_alternate_name" a
),
grid AS (
    SELECT p."Profile ID" AS profile_id, r."Role ID" AS role_id, pc."County code" AS county_code,
           coalesce(p."First Name", '') AS first_name,
           coalesce(p."Middle Name", '') AS middle_name,
           coalesce(p."Last Name", '') AS last_name,
           coalesce((SELECT a."Alternate name" FROM alternate_display a
                      WHERE a."Profile ID" = p."Profile ID" AND a.ordinal = 1), '') AS alternate_1,
           coalesce((SELECT a."Alternate name" FROM alternate_display a
                      WHERE a."Profile ID" = p."Profile ID" AND a.ordinal = 2), '') AS alternate_2,
           c."County name" AS county,
           coalesce(ud.county_unit, r."Office or department", '') AS county_unit,
           coalesce(ud.county_sub_unit, '') AS county_sub_unit,
           coalesce(r."Position title", '') AS position,
           coalesce(r."Job description or duties", '') AS role
      FROM "profile_role" r
      JOIN "profile" p ON p."Profile ID" = r."Profile ID"
      JOIN "profile_county" pc ON pc."Profile ID" = p."Profile ID" AND pc."County code" = r."County code"
      JOIN "county" c ON c."County code" = pc."County code"
      LEFT JOIN unit_display ud ON ud."Role ID" = r."Role ID"
)
SELECT g.first_name AS "First Name", g.middle_name AS "Middle Name", g.last_name AS "Last Name",
       g.alternate_1 AS "Alternate Name 1", g.alternate_2 AS "Alternate Name 2",
       g.county AS "County", g.county_unit AS "County Unit", g.county_sub_unit AS "County Sub Unit",
       g.position AS "Position", g.role AS "Role",
       (SELECT substr(rev."Reviewed on", 1, 10)
          FROM "profile_revisions" rev, json_each(rev."Public revision", '$.website_review.roles') item
         WHERE rev."Profile ID" = g.profile_id AND rev."Revision status" IN ('approved', 'superseded')
           AND json_extract(item.value, '$.role_id') = g.role_id
           AND json_extract(item.value, '$.county_code') IS g.county_code
           AND json_extract(item.value, '$.county') IS g.county
           AND json_extract(item.value, '$.first_name') IS g.first_name
           AND json_extract(item.value, '$.middle_name') IS g.middle_name
           AND json_extract(item.value, '$.last_name') IS g.last_name
           AND json_extract(item.value, '$.alternate_name_1') IS g.alternate_1
           AND json_extract(item.value, '$.alternate_name_2') IS g.alternate_2
           AND json_extract(item.value, '$.county_unit') IS g.county_unit
           AND json_extract(item.value, '$.county_sub_unit') IS g.county_sub_unit
           AND json_extract(item.value, '$.position') IS g.position
           AND json_extract(item.value, '$.role') IS g.role
         ORDER BY rev."Revision number" DESC LIMIT 1) AS "Date Reviewed"
FROM grid g;

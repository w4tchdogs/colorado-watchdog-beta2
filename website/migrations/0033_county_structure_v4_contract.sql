-- County Structure v4 contract (COUNTY-DB-1 follow-up).
--
-- Two changes that the statewide v4 county.csv needs, made without rebuilding
-- county_unit. A rebuild would drop and recreate a table that aliases cascade
-- from and Profile role displays restrict on, so this migration only drops and
-- re-adds two private text columns and adds one new column.
--
-- 1. Private provenance (Evidence for relationship, Source references) may run
--    to 32,768 characters instead of 4,000. Existing text is copied aside,
--    the old columns with the 4,000 character CHECK are dropped, new columns
--    with the larger CHECK are added, and the text is copied back unchanged.
--    The text stays private: no public service reads these columns.
--
-- 2. A unit may be placed for browsing beneath another unit of the same county
--    with Relationship `display_group`, for example programs listed under CSU
--    Extension. This is browse placement only. It is stored in its own column,
--    `browse_parent_unit_id`, and never in `parent_unit_id`, so the reporting
--    hierarchy is unchanged: such a unit has no reporting parent.
--
-- Unit versions and timestamps are not changed by this migration.

CREATE TABLE county_structure_provenance_0033 (
  entity TEXT NOT NULL CHECK (entity IN ('unit', 'display')),
  id TEXT NOT NULL,
  evidence TEXT,
  source_references TEXT,
  PRIMARY KEY (entity, id)
) STRICT, WITHOUT ROWID;

INSERT INTO county_structure_provenance_0033 (entity, id, evidence, source_references)
  SELECT 'unit', id, evidence, source_references FROM county_unit
  WHERE evidence IS NOT NULL OR source_references IS NOT NULL;
INSERT INTO county_structure_provenance_0033 (entity, id, evidence, source_references)
  SELECT 'display', id, evidence, source_references FROM county_unit_display
  WHERE evidence IS NOT NULL OR source_references IS NOT NULL;

ALTER TABLE county_unit DROP COLUMN evidence;
ALTER TABLE county_unit DROP COLUMN source_references;
ALTER TABLE county_unit ADD COLUMN evidence TEXT
  CHECK (evidence IS NULL OR length(evidence) <= 32768);
ALTER TABLE county_unit ADD COLUMN source_references TEXT
  CHECK (source_references IS NULL OR length(source_references) <= 32768);

ALTER TABLE county_unit_display DROP COLUMN evidence;
ALTER TABLE county_unit_display DROP COLUMN source_references;
ALTER TABLE county_unit_display ADD COLUMN evidence TEXT
  CHECK (evidence IS NULL OR length(evidence) <= 32768);
ALTER TABLE county_unit_display ADD COLUMN source_references TEXT
  CHECK (source_references IS NULL OR length(source_references) <= 32768);

UPDATE county_unit SET
  evidence = (SELECT p.evidence FROM county_structure_provenance_0033 p
              WHERE p.entity = 'unit' AND p.id = county_unit.id),
  source_references = (SELECT p.source_references FROM county_structure_provenance_0033 p
                       WHERE p.entity = 'unit' AND p.id = county_unit.id)
WHERE id IN (SELECT id FROM county_structure_provenance_0033 WHERE entity = 'unit');

UPDATE county_unit_display SET
  evidence = (SELECT p.evidence FROM county_structure_provenance_0033 p
              WHERE p.entity = 'display' AND p.id = county_unit_display.id),
  source_references = (SELECT p.source_references FROM county_structure_provenance_0033 p
                       WHERE p.entity = 'display' AND p.id = county_unit_display.id)
WHERE id IN (SELECT id FROM county_structure_provenance_0033 WHERE entity = 'display');

DROP TABLE county_structure_provenance_0033;

-- Browse placement beneath another unit. Set only on a unit that has no
-- reporting parent and no display grouping, so the existing parent CHECK on
-- county_unit still holds with parent_relationship NULL.
ALTER TABLE county_unit ADD COLUMN browse_parent_unit_id TEXT
  REFERENCES county_unit(id) ON UPDATE RESTRICT ON DELETE RESTRICT
  CHECK (
    browse_parent_unit_id IS NULL OR (
      browse_parent_unit_id <> id AND parent_unit_id IS NULL
      AND display_group_id IS NULL AND parent_relationship IS NULL
    )
  );

CREATE INDEX county_unit_browse_parent ON county_unit (browse_parent_unit_id)
  WHERE browse_parent_unit_id IS NOT NULL;

CREATE TRIGGER county_unit_browse_parent_county_insert
BEFORE INSERT ON county_unit
WHEN NEW.browse_parent_unit_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM county_unit parent
  WHERE parent.id = NEW.browse_parent_unit_id AND parent.county_fips = NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'browse placement must remain within one county');
END;

CREATE TRIGGER county_unit_browse_parent_county_update
BEFORE UPDATE OF browse_parent_unit_id ON county_unit
WHEN NEW.browse_parent_unit_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM county_unit parent
  WHERE parent.id = NEW.browse_parent_unit_id AND parent.county_fips = NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'browse placement must remain within one county');
END;

CREATE TRIGGER county_unit_browse_parent_no_cycle
BEFORE UPDATE OF browse_parent_unit_id ON county_unit
WHEN NEW.browse_parent_unit_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.browse_parent_unit_id
    UNION ALL
    SELECT COALESCE(parent.parent_unit_id, parent.browse_parent_unit_id)
    FROM county_unit parent
    JOIN ancestors ON parent.id = ancestors.id
    WHERE COALESCE(parent.parent_unit_id, parent.browse_parent_unit_id) IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'county unit browse placement must not contain a cycle');
END;

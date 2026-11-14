-- A banner appears on the statewide homepage only when explicitly curated.
-- NULL means county-only. The order is independent of county display order.
ALTER TABLE banner_assets ADD COLUMN homepage_order INTEGER
  CHECK (homepage_order IS NULL OR homepage_order >= 0);

CREATE UNIQUE INDEX banner_assets_homepage_order
  ON banner_assets(homepage_order) WHERE homepage_order IS NOT NULL;

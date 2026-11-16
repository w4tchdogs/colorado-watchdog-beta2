-- Keep the publisher's authority classification distinct from page type.
-- Existing Website rows remain NULL until their publisher is verified.
ALTER TABLE role_sources ADD COLUMN publisher_classification TEXT
  CHECK (publisher_classification IN ('official', 'unofficial'));

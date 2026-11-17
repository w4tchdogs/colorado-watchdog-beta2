-- Retain account rows and every dependent identity, grant, audit and sync batch.
-- The existing account status is intentionally unchanged. A separate archive
-- marker lets owner listing and search omit historical records by default.
ALTER TABLE accounts ADD COLUMN archived_at TEXT;
CREATE INDEX accounts_archived_at ON accounts(archived_at);

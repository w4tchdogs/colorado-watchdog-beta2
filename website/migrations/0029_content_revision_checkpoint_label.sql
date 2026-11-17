-- Marks a revision that preserves the exact working draft from just before an
-- accepted AI edit. Existing revisions have no label. The table stays
-- append-only and the label is written only when the revision is inserted.
ALTER TABLE content_revisions ADD COLUMN checkpoint_label TEXT
  CHECK (
    checkpoint_label IS NULL
    OR (length(trim(checkpoint_label)) > 0 AND length(checkpoint_label) <= 80)
  );

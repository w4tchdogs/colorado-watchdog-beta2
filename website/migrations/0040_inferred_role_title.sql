-- A display label for Roles imports, separate from recorded role details.
ALTER TABLE person_roles ADD COLUMN inferred_title TEXT CHECK (
  inferred_title IS NULL OR length(trim(inferred_title)) BETWEEN 1 AND 500
);

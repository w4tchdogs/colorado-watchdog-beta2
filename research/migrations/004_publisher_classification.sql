ALTER TABLE sources ADD COLUMN publisher_classification TEXT NOT NULL DEFAULT 'unresolved'
    CHECK(publisher_classification IN ('official', 'unofficial', 'unresolved'));

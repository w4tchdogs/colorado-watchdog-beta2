CREATE TRIGGER counties_fips_prefix_insert
BEFORE INSERT ON counties
WHEN NEW.fips NOT GLOB '08[0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'county FIPS must be a Colorado code');
END;

CREATE TRIGGER counties_fips_prefix_update
BEFORE UPDATE OF fips ON counties
WHEN NEW.fips NOT GLOB '08[0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'county FIPS must be a Colorado code');
END;

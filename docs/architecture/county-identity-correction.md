# Colorado county identity correction

The public registry's stable key is the five-character county FIPS/GEOID. Its
names are display values looked up through that key. The historical seed in
`0001_counties.sql` paired `08065` with La Plata and `08067` with Lake. The
authoritative U.S. Census Bureau TIGERweb Current/ACS26 table, dated January 1,
2026, pairs `08065` with Lake and `08067` with La Plata:

<https://tigerweb.geo.census.gov/tigerwebmain/Files/acs26/tigerweb_acs26_county_co.html>

`tests/fixtures/colorado-counties-acs26.json` retains all 64 official name/FIPS
pairs and their source provenance. It is a test fixture; the runtime has no
Census dependency.

Migration `0015_correct_lake_la_plata_county_names.sql` preserves the historical
seed and all earlier checksums. It checks the complete 64-row registry, accepts
only the known reversed pair or the already-correct pair, exchanges names via a
temporary unique name, then checks every final pair. The repository migration
runner applies each migration and its history row inside one transaction. A
failed precondition or postcondition rolls back the migration and history row.

The three county-name updates advance the existing Website dependency
generation trigger three times. This is expected and makes cached/versioned
dependency checks observe the registry correction.

The correction changes no FIPS keys, deletes no county rows and updates no
dependent tables. The schema inventory found these affected relationships:

| Relationship | County storage |
| --- | --- |
| Organizations | `organizations.county_fips` |
| Organization/county affiliations | `organization_county_affiliations.county_fips` |
| Positions and people/roles | Inherited through organization and position links |
| Editorial county associations | `content_item_counties.county_fips` |
| Editorial revision snapshots | `content_revisions.county_fips_json` |
| County banners, versions and staging | `banner_assets.county_fips`, then linked by banner ID |
| Reports and their evidence/status/audit history | `reports.county_fips`, then linked by report ID |
| Sync batches, items, reversals and audit history | FIPS may be retained in request, inverse and result JSON |

These fields preserve the stable FIPS association; they do not record whether a
person selected a county by its name under the incorrect display mapping.
Therefore the source migration never swaps dependent values. If evidence shows a
particular record was assigned by the mistaken name mapping, reconcile it
separately with source provenance; leave uncertain records at their existing
key and report the unresolved association.

The current Website sync contract accepts county FIPS and verifies that the key
exists. It does not derive FIPS from county names. The separate Profiles
reference mapping is also FIPS-keyed and already pairs Lake with `08065` and La
Plata with `08067`; this Website correction does not change that database.

The correction does not alter banner source files, image metadata, publication
state, audit history or content visibility. FIPS-based routes remain canonical:
Lake is `/counties/08065`, and La Plata is `/counties/08067`.

The deployment-time data review remains separate from this source migration.
Hosted read access confirmed the live registry has 64 rows and currently pairs
`08065` with La Plata and `08067` with Lake. The available hosted reader exposes
complete rows, including private report and personnel data, but has no
aggregate-only query mode. No dependent hosted rows were read. The production
preflight contract is: use authorized, strictly read-only aggregate queries to
count references by FIPS across the county-keyed tables and examine provenance
without exporting private payloads; do not apply migration 0015 or deploy code
that assumes the corrected display names until every affected record is either
supported for its intended county by evidence or explicitly left unchanged with
its unresolved status understood. Any ambiguous cases block hosted application
until a separate evidence-backed reconciliation plan exists. The registry
migration itself leaves all FIPS references unchanged. No hosted data or Site
version was changed in this assignment.

The pending VIS8-RESTORE-1 map joins geometry by FIPS. Its existing geometry
uses Lake `08065` and La Plata `08067`; after migration its name/slug integrity
check can pass without geometry edits. Keep its mismatch fail-closed behavior.

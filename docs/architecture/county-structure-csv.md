# County Structure CSV contract and operator guide

This is the contract for `county.csv`, the single file that imports and exports the County Structure. It covers the 17 columns, the rules the importer enforces, the three import modes, and the steps an operator follows. The design behind it is in [County Structure](county-structure.md). A worked example is in [`tests/fixtures/county-structure-example.csv.txt`](../../tests/fixtures/county-structure-example.csv.txt). It uses synthetic data only. The repository ignores every `.csv` file so that no real data is committed by accident, which is why the example carries a `.txt` ending. Save a copy as `county.csv` to try it.

## The file

The file is UTF-8 comma-separated text with a header row. A leading byte order mark is accepted. Rows may end in CRLF or LF, and exports always use CRLF. Fields that contain a comma, a quote or a line break are quoted with double quotes, and a quote inside a field is doubled. Blank rows are skipped. A file may be up to 1 MiB and 20,000 rows. The header must match the 17 column names below exactly and in this order. A file with a different header is rejected before anything else is read.

| # | Column | Rule |
| --- | --- | --- |
| 1 | County code | Required. The five digit FIPS code, for example `08001`. It must be one of the 64 Colorado codes. |
| 2 | County name | Required. It must match the registered name for the code. |
| 3 | Office or unit ID | The durable key for the row. Blank only on a county-only row. 1 to 128 characters, starting with a letter or digit and using only letters, digits and `_ . : -`. Unique across the whole file, and two IDs that differ only by letter case count as duplicates. An ID never moves to another county. |
| 4 | Office or unit name | Required when the ID is present. |
| 5 | Parent office or unit ID | Blank for a top-level unit. Otherwise the ID of another row in the same county. |
| 6 | County Unit | Readable first level. See “Readable columns” below. |
| 7 | County Sub Unit | Readable second level. |
| 8 | County Sub Sub Unit | Readable third level. |
| 9 | Organization type | One of `office`, `department`, `board`, `commission`, `division`, `section`, `authority`, `district`, `program`, `other`, or `display_group`. Required on every row that has an ID. |
| 10 | Alternate names | A JSON array. Each entry is either a string or an object with `name` and optional `kind`. Blank means none. |
| 11 | Relationship to parent | `part_of`, `reports_to` or `display_group`. Must be blank on a top-level row. Under a unit, blank means `part_of`, and `display_group` means browse placement under that unit with no reporting relationship. Under a display group, it must be `display_group` or blank. |
| 12 | Evidence for relationship | Private free text. Optional. Up to 32,768 characters. |
| 13 | Source references | Private free text, such as URLs. Optional. Up to 32,768 characters. |
| 14 | Applies from | Optional date, `YYYY-MM-DD`. |
| 15 | Applies until | Optional date, `YYYY-MM-DD`. It must not be earlier than Applies from. |
| 16 | Display order | Optional whole number. Siblings sort by it, then by name. |
| 17 | Status | `active`, `former`, `historical`, `review_required` or `hidden`. Blank means `active`. |

## Stable IDs

The Office or unit ID is the identity of a row. Renaming a unit means keeping its ID and changing its name. Moving a unit means keeping its ID and changing its parent. The importer never matches by name, and there is no separate mapping file. A row whose ID is new is an addition. An ID that already belongs to another county is an error. In a merge or a county replacement, an ID that exists in the database is an update of that same unit.

## Units and display groups

A row is a structural unit unless its Organization type is `display_group`. A display group is a navigation heading such as “Elected Official”. It is not a parent in the organization chart. A unit may belong to one display group through Relationship `display_group`, and only a top-level unit may do so. A unit has at most one parent, either another unit or one display group.

**Browse placement under a unit.** A row whose parent is a regular unit and whose Relationship is `display_group` is listed under that unit for browsing, for example programs listed under CSU Extension. This is placement only. The unit has no reporting parent, it is stored apart from the reporting hierarchy, and the public page lists it under the placing unit while that unit is shown, otherwise under its own heading. The placing unit must be in the same county and the placement may not form a cycle. The readable columns follow the placement, so County Unit names the placing unit’s top level. A move between a reporting parent and a browse placement on the same parent counts as a move. Added by migration 0033.

The Sheriff’s Office is a normal top-level unit. It is not placed under Elected Official. Elected status is a view, and it comes only from a reviewed classification on a Profile role. The classification is made in the dashboard, so the same Sheriff role shows under the Sheriff’s Office and in the elected listing with no second Profile and no second role. Nothing in `county.csv` marks a person as elected.

## Readable columns

Columns 6 to 8 let a person scan the file. They are checked against the parent chain, never used as keys. Leave all three blank, or fill them so they equal the names of the first three levels above and including the row. A row at the first level carries its own name in County Unit. Rows deeper than three levels keep the first three names.

## County-only rows

A row with only a county code and name, and a blank ID, declares that the county exists and has no structure. A full export writes one for every empty county so that a replace-all file can still cover all 64 counties.

## Private provenance

Evidence for relationship and Source references are private. They are exported, they round-trip through an import, and they are shown in the owner dashboard. No public page, public API or public search returns them. Public pages read only names, types, aliases, order, status and linked people.

## Import modes

All three modes validate the whole file first and then compute one change set.

- **Merge.** Rows are added or updated by ID. Units that are not in the file stay as they are. A merged row may use a parent that already exists in the same county.
- **Replace one county.** The file must contain only the county you choose. Use a county-only row to replace a county with an empty structure. After the commit the county matches the file. Units missing from the file are retired or removed.
- **Replace all counties.** The file must cover all 64 counties, using county-only rows for empty ones. After the commit the database matches the file.

A removal is blocked while any Profile role points at the unit. The preview lists each blocked unit with its Profile count. Set the unit’s Status to `former`, `historical` or `hidden` in the file instead, or move the Profile roles first.

## Steps

1. Open Dashboard, County Structure.
2. Choose the county. For a replace-all file you can leave any county selected.
3. Choose the file and the mode, then press Validate and preview. Nothing changes.
4. Read the preview. It lists the counts to add, update, move, retire and remove, how many Profile links are affected, any file problems by row and column, and every blocked change.
5. If the preview has problems or blocked changes, fix the file and preview again. The Commit button stays off until the preview is clean.
6. Press Commit import. The commit applies the exact previewed change set in one transaction.
7. Press Export to download the current structure as `county.csv`.

The commit refuses to run if anyone changed the structure after the preview. Prepare the file again in that case. Repeating the same commit with the same key does nothing the second time. Each commit is recorded with a receipt and a history entry for every changed unit.

## Reversing an import

Recent imports are listed at the bottom of the page. Reverse restores the state from before that import. It works only while no later change exists and no Profile role depends on units the import added. When it cannot run, the page says why. A reversal is itself recorded and cannot be reversed again.

## Converting the final audit tables

The audited county unit tables are converted offline to this file and never loaded directly. For each audited unit assign a stable lowercase ID, fill the parent ID, the type and the status, copy the three readable levels, and move supporting notes to the evidence and source columns. Preview the result with Replace one county first. Use Replace all counties only for a complete reviewed file. No real audit data is part of this change.

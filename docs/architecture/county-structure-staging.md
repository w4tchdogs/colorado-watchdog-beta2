# County Structure staging acceptance checklist

Use this after the County Structure change is merged and the owner has approved applying migration 0031 to Cloudflare staging. It is written for the authenticated staging operator. Nothing on this list has been run. Record each result in the PR or in a sanitized receipt, and keep “tested locally” separate from “verified on the hosted Site”. Use synthetic data only. Do not load real audit data, real Profiles or private research.

Design and rules: [County Structure](county-structure.md). File format: [county.csv contract](county-structure-csv.md). General staging steps: [staging runbook](../deployment/cloudflare-staging.md).

## Before the migration

1. Record the active Worker version and the source commit it was built from.
2. Confirm the `DB` binding points at the intended staging database.
3. Run the existing staging D1 verifier and record the ledger count and the 64 county and FIPS pairs. Before this change the ledger should show the previous migration count.
4. Take a checkpoint of the staging database and files, and record its ID. This is the rollback point.
5. Record the row counts of `organizations`, `people`, `person_roles` and `positions`, so they can be compared afterwards.

## Apply

6. Apply migration 0031 using the documented staging procedure. It only adds tables. It changes no existing table or row.
7. Run the staging D1 verifier again. It expects 31 ledger rows, the same 31 names in order, and all 64 county and FIPS pairs.
8. Confirm the eight new tables exist and `county_structure_state` holds one row with version 0.
9. Compare the row counts from step 5. They must be unchanged.
10. Deploy the Worker built from the merged commit using the documented staging procedure.

## Access

11. Signed out, request `/api/admin/county-structure/counties`. Expect 401.
12. Signed in as a non-owner account, expect 403.
13. Signed in as the owner, open Dashboard and confirm County Structure appears in the sidebar and opens.
14. From a different origin, send a write to `/api/admin/county-structure/edits`. Expect 403 `origin_rejected`.

## Empty state

15. Open a county page on the public site. The County structure section must show the empty message and no error.
16. Confirm the public page source contains no evidence or source text.

## Import and export

17. Save `tests/fixtures/county-structure-example.csv.txt` as `county.csv` and prepare it with the Merge mode. Read the preview. Expect 7 units, 1 display group and the Alamosa county-only row, with nothing blocked.
18. Commit. Expect a success message and the counts to change.
19. Reload the page and confirm the tree shows the Sheriff’s Office at the top level and the Assessor and Clerk & Recorder under the Elected Official display group.
20. Export. Confirm the file has the 17 columns and the private evidence text is present in the export.
21. Prepare the exported file with Replace one county for Adams. Expect a preview with no changes.
22. Repeat the commit request from step 18 with the same Idempotency-Key, for example from the browser developer tools. Expect `replayed: true` and no new history entry.
23. Edit a unit name in the dashboard and save. Expect the new name and a history entry.
24. Open two browser tabs. Change a unit in the first, then change a unit in the second without reloading. The second must show the stale-version message and change nothing.

## Public view

25. Reload the Adams county page. The County structure section must list the units and the display group, and must not show evidence, source references, hidden units or former units.
26. Set one unit to hidden and confirm it disappears from the public page after reload.

## Profile links and the Sheriff rule

27. Using a synthetic Profile role, link it to the Sheriff’s Office as `home`, then as `elected_official`. The public page must show the one person under the Sheriff’s Office and in the elected listing. Confirm only one person record and one role record exist.
28. Prepare a Replace one county file that omits the Sheriff’s Office. Expect the preview to mark it blocked with the Profile count and the Commit button to stay off.

## Reversal

29. Prepare and commit a small second merge. Press Reverse on it. Expect the earlier state back.
30. Try to reverse the first import while a later import exists. Expect the not-reversible message and no change.

## Accessibility and layout

31. Complete steps 17 to 24 using the keyboard only. Every control must be reachable, show a visible focus ring and have a name.
32. With a screen reader, confirm the status line announces the preview result and each commit result.
33. Check widths of 1280, 768 and 375 pixels. The two columns must stack on narrow screens with no clipping or horizontal scroll.

## Close out

34. Remove the synthetic units by using Replace one county with a county-only row for Adams and Alamosa, or restore the checkpoint from step 4.
35. Run the staging D1 verifier a last time and record the result.
36. Write a sanitized receipt with the Worker version, the source commit, the verifier output and which of the steps above passed. Update the matching row in CURRENT.md.

## Rollback

If any step in “Apply” fails, stop. Restore the checkpoint from step 4. The migration only adds tables, so earlier Worker versions keep working with the tables present, and the previous Worker version listed in CURRENT.md is the rollback target for the code.

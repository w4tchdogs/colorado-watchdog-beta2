# VIS-11 and VIS-12 person and organization findings

Revision: November 15, 2026. Ledger rows: `VIS6-PERSON-001` and `VIS6-ORG-001`. Beta-2 source: `main` at `aa99683` (PR #126). Beta-2 was run locally with synthetic fixtures (`npm run site:dev` and `site:dev:empty`). Beta-1 was read only through its archived source. Nothing was checked on hosted Alpha-1.

## Beta-1 evidence

| Route | Established | Evidence |
| --- | --- | --- |
| `/counties/[slug]` | Yes | Archived `app/counties/[slug]/page.tsx` links to the directory and to `directoryView=structure` |
| `/people/[id]` | Yes | Archived `app/people/[id]/profile-view.tsx` has overview and research tabs and a return link to the directory with its filters |
| Standalone organization route | No | No `organizations` route exists in the archived `app` folder. Organizations appear only as an `officeId` directory filter and the structure view |

Coverage gap: the archive does not show how Beta-1 presented organization details, parents or subunits. Any claim about them would be a guess, so the row records the gap.

## Beta-2 behavior verified

- **Person flow.** County to officials to person works. Role history shows titles, dates, cited sources with checked dates, organization links and county associations (direct or affiliated). Two records with the same name stay separate. A person with no roles shows "No documented roles". A missing person returns 404 with one heading. The directory return link and breadcrumb keep the original filters.
- **Organization flow.** County page to organization to person works. Organization pages show the parent with its relationship label, counties (direct and affiliated, labelled as affiliations), positions, people in roles and a source list. Empty organization and empty database fixtures render their empty states, and a missing organization returns 404.
- **Layout and keyboard.** No horizontal overflow at 390 pixels on the organization page. Links and pager controls are plain anchors reachable by Tab.

## Defect fixed (VIS12-ORG-001, P2)

An organization page linked up to its parent but had no way down to its subunits. Dividing a department from its division required going back to the county structure view. The profile now lists direct subunits (up to 50, ordered by name) with type badges and the stored relationship ("reports to" or "grouped under"), or says none is recorded. A longer list says it is cut and points to the county structure view. The contract gains `subunits` and `subunitsTruncated`, and the SQLite and D1 services both fill them. Tests: service test in `tests/organization-profile.test.mjs` and the page test in `tests/site-pages.test.mjs`.

## Observation, no change

A person opened from a county page has no county return link beyond the county links on each role and the generic Officials breadcrumb. Return links exist only for directory filters. This is a P3 observation and was left alone.

## Not checked

Safari, Firefox, a real phone, hosted Alpha-1, and JavaScript-disabled behavior by turning script off (the pages are server-rendered links).

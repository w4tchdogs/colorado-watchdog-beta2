# VIS-9 County detail pages: findings

Revision: November 14, 2026. Ledger row: `VIS6-COUNTY-002`. Beta-2 source: `main` at `17dbf10` (PR #111). Reference: the public Beta-1 Adams County page, observed only. Beta-2 was run locally with synthetic fixtures (`npm run site:dev:banners` and `site:dev:empty`). Nothing was checked on hosted Alpha-1.

## Comparison with Beta-1 (Adams County)

| Area | Beta-1 | Beta-2 local | Result |
| --- | --- | --- | --- |
| County heading and sub-navigation | County name, County home, Officials and employees, Community Voices, county switcher, All counties | County name, County home, Officials and employees, County structure, county switcher with a Go button, All counties | Equivalent. Beta-2 adds a County structure link. The Go button keeps switching working without JavaScript |
| Banner placement | Banner hero with title, two actions and carousel controls | Server-rendered 3:1 banner frame, hero title, two actions and carousel controls | Equivalent, unchanged |
| Overview | Four headline counts (departments and offices, officials and employees, reports, grievances) | Organization and role counts with a notice that counts describe the database | Gap. Beta-1 counts and the report and grievance counts are new data features. Forwarded to 💠archon (STATS-1) |
| Paths to officials and structure | Two explore cards | Hero actions and the sub-navigation links | Equivalent paths. No separate explore cards |
| County Community Voices | A county panel that says no articles are published and links to all county stories | None on the county page | Gap. Needs editorial queries. Forwarded to 💠archon |
| Mobile navigation | About 145 px tall. Switcher and All counties share a row | 233 px tall before the fix | Defect, fixed (below) |

## Beta-2 behavior verified

- **County identity.** `/counties/08001` shows Adams with exact FIPS in every link. The switcher uses the 64-county list and marks the current county selected. `/counties?county=08005` redirects (303) to `/counties/08005`. An unknown code returns 400.
- **Directory views.** On `/officials?county=08001` the switcher posts to `/officials` and keeps the exact county code. On the structure view it also keeps `directoryView=structure`. The active link carries `aria-current`.
- **Populated county.** Adams shows 7 organizations (4 county, 3 affiliated), 38 role records, citations and affiliated flags. The role pager links to the next page. A stale role cursor shows "No more role records". An invalid organization cursor returns 400.
- **Empty county.** Alamosa and the empty database show the empty state with a link to other counties, and no organization or role sections. The sub-navigation is still present.
- **Keyboard.** Real Tab presses reach the carousel buttons, hero actions, breadcrumbs and record links, each with a visible solid outline.
- **No JavaScript.** The sub-navigation, switcher form with Go button, pager links and county redirect are plain links and forms.
- **Overflow.** No horizontal overflow at 1440, 768 or 390 pixels wide.

## Defect fixed

**Bulky county navigation on narrow screens.** At 390 px the navigation took 233 px and wrapped into four rows. The fix is CSS only, in `website/site/site.css`, inside the existing 44 rem media query. The three links get tighter padding, and the switcher shares a row with All counties. The navigation is now 161 px tall. The Go button, form action, exact FIPS and selected view are unchanged. Regression test: `county navigation stays compact on narrow screens` in `tests/site-pages.test.mjs`.

At 768 px the navigation is two rows and does not fit one row at any gap size, so it was left alone.

## Deferred

- County headline counts, including report and grievance counts (STATS-1).
- A county Community Voices panel (needs editorial queries and content).
- Hosted Alpha-1 behavior. Nothing was checked there.

## Evidence

Screenshots are not committed, because the repository allowlist excludes images. They are saved in the task worktree under `docs/coordination/visual-audit/vis-9/` and copied to the local workspace at `documentsisual-auditis-9\`: Beta-1 reference (`beta1-adams-*`), Beta-2 populated at 1440 and 768, populated at 390 before and after the fix, the empty county Alamosa at 768 and 390, and the empty-database Adams page at 1440. The Beta-1 reference at pane width was captured before the browser was resized. Not checked: Safari or Firefox, a real phone, a populated 1440 capture of the fix (unchanged above 44 rem), and hosted Alpha-1. Browser coverage was the built-in Chrome-based browser pane at 1440 x 900, 768 x 1024 and 390 x 844, with real keyboard Tab presses. JavaScript-disabled behavior was verified from the rendered HTML (plain links and forms), not by turning script off in a browser.

# VIS-15 Information pages audit

**Audit:** VIS-15, Help, Legal & Policy, About, How Reporting Works, CORA guide and Reading Records
**Revision:** 2026-11-15 v1
**Beta-2 source examined:** `main` aa99683
**Ledger rows updated:** VIS6-INFO-001 to VIS6-INFO-006 in [coverage-ledger.csv](../coverage-ledger.csv)
**Evidence reference:** VIS15-FINDINGS (this file)

## Method

Beta-1 destinations were read from the archived Beta-1 source (`archive\beta-1\colorado-watchdog`, `app\help`, `app\legal`, `app\legal\how-reporting-works`, `app\resources\cora`, `app\about` and `lib\site-navigation.mjs`). Beta-2 was run locally from this branch with `scripts/site-dev.mjs` (fictional in-memory data) and checked in the built-in browser at 1280 and 390 pixel widths. Every internal link on `/`, `/about`, `/reading-records`, `/submit-report`, `/track-report`, `/stories` and `/officials` was fetched, and every in-page anchor was resolved. Nothing was submitted and no hosted Site was opened. Prior VIS-6 evidence in the ledger is retained and the new findings are appended to it.

## Destination map

| Topic | Confirmed Beta-1 destination | Beta-2 equivalent | Status |
|---|---|---|---|
| Help | `/help`, in the Beta-1 main menu as "Get help". Links to How Reporting Works, CORA, report and Guest Voices submission, officials search, My Contributions | None. `/help` returns 404 and no header or footer link exists | Gap, owner decision |
| Legal & Policy | `/legal`, in the Beta-1 main menu. Prototype policy notes, allegation and privacy notices, takedown and tracking links | None. `/legal` returns 404 and no link exists | Gap, needs new policy copy |
| About | `/about`, in the Beta-1 main menu | `/about`, in the header and footer, 200 | Present, no defect |
| How Reporting Works | `/legal/how-reporting-works`, linked from Help and Legal | None. 404. `/reading-records` explains records, not report review | Gap, depends on report intake policy |
| CORA guide | `/resources/cora`, linked from Help and Legal. External agency links and an email template | None. 404 | Gap, owner decision |
| Reading Records | No Beta-1 route. Closest content is split across the Beta-1 help and legal pages | `/reading-records`, in the footer, home page, About and its own breadcrumbs, 200 | Beta-2 original, no defect |

## Link and layout checks

- No broken internal link or missing anchor on the seven pages checked, at either width.
- At 390 pixels the Menu button opens the main navigation with six 45 pixel high links and the page has no horizontal overflow. At 1280 pixels the navigation is inline and the About item is marked current on both About and Reading Records.
- Breadcrumbs on Reading Records resolve to `/` and `/about`.
- No public page links to `/submit-report` or `/track-report`. Those routes load, and their links are not exposed on purpose while real submission is gated. The report form is outside VIS-15.

## Defects fixed

None. No confirmed navigation defect has a clear intent and destination. Every broken path is a Beta-1 destination with no Beta-2 page, and creating one needs content the owner has not approved.

## Remaining gaps for the owner

1. Whether Beta-2 gets a Help hub. It would need a stable list of destinations and today only About and Reading Records exist.
2. Legal & Policy copy, including allegation, privacy, retention and takedown terms. Beta-1 states these are unapproved prototype notes, so they must not be carried over.
3. A How Reporting Works explainer, which depends on the report intake and review policy.
4. A CORA guide. Beta-1's template names Larimer County, so a Beta-2 version needs its own copy.
5. A public takedown or correction pathway, which Beta-1 also offered and Beta-2 does not.

## Limits

Checked on a local preview only. Hosted Alpha-1 was not sampled, so none of this is verified on the hosted Site. The Beta-1 pages were read from archived source and not re-opened live. The browser pane width limited true tablet checks and 768 pixels was not tested.

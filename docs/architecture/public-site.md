# Public website alpha (M4)

This document describes the implemented M4 public website alpha. It runs in a
local preview only. No Site is deployed, no hosted D1 or R2 is used, and
compatibility with ChatGPT Sites or any other host is untested.

## Approach

- The public site is server-rendered HTML produced by `src/site/`. It reads
  only through the shared `ApplicationServices` layer, the same service
  functions behind the public JSON API, so there is no parallel business logic
  and no direct database access from page code.
- Pages work without JavaScript. `website/site/site.js` adds two
  enhancements: the mobile menu toggle and live filtering on the county
  directory. `website/site/site.css` holds the design tokens and components.
- `createPublicSite(options)` returns a Fetch handler. `createWebsite` composes
  it with the existing application: `/api/*`, `/_internal/*` and `/internal/*`
  go to the unchanged application, everything else to the site.
  `src/application.ts` and `src/worker.ts` are not modified, so the Worker
  entrypoint does not serve the site yet. Wiring it in is deployment work.
- Static files are provided by an injected `SiteAssets` object. The local
  preview reads them from `website/site/`. A hosted deployment would supply its
  own implementation.
- The only service addition is `listCounties()`, a read of the seeded county
  registry. No schema, migration, sync or public API behavior changed.

## Routes

| Route | Page |
| --- | --- |
| `/` | Homepage with the 64-county index, discovery forms, a county selection, Stories and Posts area |
| `/counties?q=` | County directory with name or FIPS filter and letter navigation |
| `/counties/{countyFips}` | County overview, county organizations, affiliated organizations, documented roles |
| `/people?query=&cursor=` | People search (`searchPeople`) |
| `/people/{personId}` | Person profile (`getPersonProfile`) |
| `/organizations?query=&cursor=` | Organization search (`searchOrganizations`) |
| `/organizations/{organizationId}` | Organization profile, positions and roles |
| `/stories`, `/posts`, `/stories/{slug}`, `/posts/{slug}` | Editorial listing and article templates |
| `/about`, `/reading-records` | Supporting pages |
| `/assets/site.css`, `/assets/site.js`, `/assets/favicon.svg` | Static files |

Lists use the services' keyset cursors with bounded page sizes (25, or 50 for
county organizations). Paging is forward-only with a link back to the first
page, matching the cursor contracts. Unknown routes return an HTML 404,
malformed parameters a 400, a missing database a 503.

## Evidence rules in the presentation

- Role dates are shown as stored. A missing end date reads "Not recorded" and
  is never shown as current. The source-check date is labelled "Source
  checked" and kept apart from role dates.
- County pages list county organizations and affiliated organizations
  separately, and state that affiliates are not county departments.
- People are linked by stable ID. Search results that share a name show their
  record IDs and a note that they are separate records.
- Counts are described as database records, not staffing or completeness.
- An empty database produces explanatory empty states on every view.

## Editorial templates

No publication contract exists. The site never reads the editorial tables,
whose rows are drafts or archived. Story and Post pages render from an injected
`EditorialSource` (`src/site/editorial-source.ts`), a presentation model only.
The default source is empty, so `/stories` and `/posts` show empty states. The
local preview injects fictional fixtures, each marked "Fictional
demonstration".

## Local preview

```text
npm ci
npm run site:dev          fictional demonstration data
npm run site:dev:empty    counties only, no records
```

Open `http://127.0.0.1:8790/`. Set `SITE_PORT` to change the port. The preview
uses a fresh in-memory Website database on every start, ignores
`DATABASE_PATH`, refuses to start in a production environment, and never reads
the Profiles research database. Fixture code lives in `src/site-dev/` and is
not imported by `src/site/`, the application or the Worker. With fictional
data, every page shows a "Local preview" notice.

## Security

All interpolated values are HTML-escaped by the `html` template tag. Stored
source URLs become links only when they are absolute `http(s)` URLs without
credentials. Responses carry a Content Security Policy with no inline script or
style, plus `nosniff` and frame denial. The site accepts only `GET` and `HEAD`,
allowlists query parameters per page, and bounds path, query and cursor length.

## County imagery

County pages include a banner slot. `PublicSiteOptions.countyBanner` can return
an image for a county; by default it returns none and a neutral pattern is
shown. No Beta-1 or private artwork is used.

## Not implemented

- Hosted deployment and Worker wiring of the site.
- Publication of Stories and Posts, and any public editorial endpoint.
- Browsing all people or organizations without a search term (the search
  contract requires two characters).
- Backward keyset paging, county banners, accounts, submissions, files.

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
| `/counties/{countyFips}` | Banner hero, county navigation and switcher, overview, county organizations, affiliated organizations, documented roles |
| `/people?query=&cursor=` | People search (`searchPeople`) |
| `/people/{personId}` | Person profile (`getPersonProfile`) |
| `/organizations?query=&cursor=` | Organization search (`searchOrganizations`) |
| `/organizations/{organizationId}` | Organization profile, positions and roles |
| `/stories`, `/posts`, `/stories/{slug}`, `/posts/{slug}` | Editorial listing and article templates |
| `/about`, `/reading-records` | Supporting pages |
| `/counties?county={countyFips}` | County switcher; redirects to the county page |
| `/assets/{name}` | Stylesheet, script and brand images |

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
npm run site:dev:banners  fictional data plus synthetic banner test patterns
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

## Visual identity

The site carries the established Colorado Watchdog identity, taken from the
live Beta-1 site as the visual reference: red masthead (`#cb0000`), black
information strip, off-white page (`#f5f5f3`), heavy sans display headlines,
red uppercase eyebrow labels, square red buttons and bordered white cards.
Tokens and components live in `website/site/site.css`. No Beta-1 source code,
data or banner image was copied.

- **Fonts:** no font files are bundled. Headlines use the system stack
  `"Arial Black", "Archivo Black", "Helvetica Neue", Arial`; body text uses
  `Inter, "Segoe UI", Arial`. Beta-1 serves its own web fonts, so letterforms
  are close but not identical.
- **Logo and mascot:** `website/site/brand-*.png` and `favicon-*.png` are
  reduced copies of the owner's masters. Provenance is recorded in
  `website/site/BRAND-ASSETS.md`. The logo appears in the header, footer and
  banner placeholder. One mascot appears on the homepage, one on About and one
  on error pages.
- **Not carried over:** report submission, sign-in, statewide record totals and
  the county map, because Beta-2 does not implement them.

## Banner hero and presentation contract

`src/site/banner.ts` renders the homepage and county heroes and defines the
only interface between the site and banner artwork. It is storage-independent:
it knows nothing about R2, D1, manifests, uploads or source folders. Inventory,
validation, storage, publication and the Banner Manager belong to the banner
milestones (Issue #62).

**Frame.** The banner frame is always exactly 3:1 (`aspect-ratio: 3 / 1`) at
every width. On wide screens the heading overlays the frame; below 64rem the
heading sits under it, so the panorama is never covered or squeezed. A reserved
caption sits at the bottom right of the frame.

**Source images.** Approved sources may be 21:9, 3:1 or anything between. They
are never stretched or re-cropped on disk:

- `cover` (default) fills the frame and clips the overflow. `focalX` and
  `focalY` (0 to 1, default 0.5) choose which part stays visible.
- `contain` shows the whole image on a dark background.

Focal values are applied through stylesheet classes in 5% steps because the
Content Security Policy forbids inline styles.

**Placeholder.** With no published banner the frame shows a static branded
placeholder: a black-to-red field with the logo as a watermark. It is always
rendered underneath a banner image, so a missing, withdrawn or failed image
falls back to it with no broken picture and no layout shift.

**Contract.** A `BannerSource` supplies `BannerPresentation` records:

| Field | Meaning |
| --- | --- |
| `bannerId` | Stable logical identity. Not tied to filename, checksum or URL |
| `assetVersion` | The approved asset version currently shown |
| `countyFips` | Five-digit FIPS, or `null` for statewide artwork |
| `src` | Resolved, versioned image address (root-relative path or https URL) |
| `alt`, `caption` | Descriptive alternative text and landmark caption |
| `originalFilename` | Provenance only |
| `width`, `height` | Intrinsic pixel size, when known |
| `displayMode` | `cover` or `contain` |
| `focalX`, `focalY` | Normalized focal point |
| `order`, `primary` | Per-county ordering and primary selection |
| `status` | `published` or `unpublished` |

`forCounty(fips)` may return any number of banners; `forHome()` returns the
curated statewide set. The site shows published records only, primary first,
then by `order`, then by `bannerId`. This milestone displays the first one
statically and exposes the count as `data-banner-count`. There are no
slideshow controls and no animation.

**Lifecycle operations are data changes.** Add a record, change `order` or
`primary`, set `status` to `unpublished`, or point `assetVersion` and `src` at
a new or earlier version: the page changes with no template or stylesheet
edit. Requirements on the future pipeline:

- `src` must change whenever the asset version changes, so a replacement is
  never masked by a cached copy.
- If images are served from another origin, pass it in
  `PublicSiteOptions.bannerOrigins` so it is added to the CSP `img-src`.
- Supply `width` and `height` where known.
- Any future rotation must offer real pause and next controls, keep image and
  caption in step, and respect `prefers-reduced-motion`.

**Synthetic fixtures.** `npm run site:dev:banners` shows generated SVG test
patterns (21:9, 13:5 and 3:1; cover, contain, a top focal point, a missing
image, and three records on one county) on Adams, Boulder, Denver, Larimer and
Weld counties. They are geometric patterns, not artwork. No approved banner
file and no Beta-1 banner is used anywhere in this repository.

## Not implemented

- Hosted deployment and Worker wiring of the site.
- Publication of Stories and Posts, and any public editorial endpoint.
- Browsing all people or organizations without a search term (the search
  contract requires two characters).
- Banner inventory, storage, upload, publication, rotation and the Banner
  Manager (Issue #62). Only the presentation contract exists here.
- Backward keyset paging, accounts, submissions, files.

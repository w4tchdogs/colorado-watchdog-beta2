# Public website alpha (M4)

This document describes the M4 public website and its Sites-compatible Worker
package. Local verification uses disposable Wrangler D1. No Site is created,
published, or deployed by this milestone; hosted runtime and D1 behavior remain
unverified.

## Approach

- The public site is server-rendered HTML produced by `src/site/`. It reads
  only through the shared `ApplicationServices` layer, the same service
  functions behind the public JSON API, so there is no parallel business logic
  and no direct database access from page code.
- Pages work without JavaScript. `website/site/site.js` adds two
  enhancements: the mobile menu toggle and live filtering on the county
  directory. `website/site/site.css` holds the design tokens and components.
- `createPublicSite(options)` returns a Fetch handler. `createWebsite` composes
  it with the JSON application: `/api/*`, `/_internal/*` and `/internal/*`
  route to the application; public page routes go to the site.
- `src/worker.ts` default-exports the Sites Worker fetch handler. It creates the
  public read services from the trusted `DB` runtime binding. Without `DB`,
  liveness and bundled static assets remain available while readiness and
  database-backed pages fail closed. Account routes use the asynchronous D1
  account services. Human Sites identity fails closed until trusted host
  provenance is established. Production synchronization capabilities remain
  disabled.
- `src/services/d1-public-reads.ts` implements the existing public read
  projections over asynchronous D1 prepared statements. Page rendering awaits
  the service contract, which continues to accept the synchronous SQL.js
  implementation used by local previews and tests. Account services also use
  D1-native asynchronous reads and guarded batch mutations; SQL.js is not
  included in the Worker. Query inputs and row counts
  remain bounded; search and role pagination keep their existing stable keys.
- The build bundles only the reviewed CSS, JavaScript, logo and favicon assets
  into the Worker with fixed MIME types. It does not serve arbitrary paths from
  disk or require an object store for current static assets. Banner placeholders
  remain available without R2.
- `.openai/hosting.json` declares the logical `DB` D1 binding and no R2 binding.
  The build emits the server Worker at `dist/server/index.js` and copies the
  existing Website migrations into `dist/.openai/drizzle/`. It does not include
  the SQL.js production database path or the private Profiles research store.

## Local verification and first private Site deployment

`npm run test:sites:d1` applies existing Website migrations 0001–0012 to an
isolated local Wrangler D1 store, inserts synthetic Website rows, starts the
production-code Worker, exercises its public routes and static assets, then
checks behavior without the D1 binding. It creates no remote resource. The
result establishes local Wrangler behavior only, not hosted Sites behavior.

When an owner later chooses to create the first private Site:

1. Create a **new** Sites project named exactly `colorado_watchdog_alpha1` and
   link only `w4tchdogs/colorado-watchdog-beta2`. The existing Beta-1 project at
   `https://colorado-watchdog.futureguild2.chatgpt.site/` must remain unchanged.
   Never reuse its project ID, hosting configuration, D1 database, R2 bucket,
   or deployment target. Keep the new Site private.
2. Before every save or deployment, verify the displayed target is the newly
   created Beta-2 project and that its returned project ID is distinct from
   Beta-1. Stop if the project identity is ambiguous. Persist the actual new
   project ID as `.openai/hosting.json.project_id`; the build injects this exact
   value into `createSitesIdentityAdapter`, never the display name or a
   placeholder. The checked-in manifest intentionally has no ID before Site
   creation.
3. Select only the new Site's own database option so Sites provisions its new
   `DB` binding. Do not select or attach any Beta-1 resource. Leave R2
   unconfigured; the current Worker uses packaged static branding and renders
   banner placeholders.
4. Before the first deployment, inspect the source commit and packaged
   migrations through `0013_private_report_intake.sql`. Sites' documented workflow
   applies included migrations before uploading the Worker. Use only the Sites
   workflow for the hosted deployment; do not run Wrangler against a remote
   database.
5. Confirm the Site is still private, then exercise homepage, county, people,
   organization, static-asset and anonymous API behavior in the hosted preview.
   Hosted execution, identity provenance, and migration behavior are not
   certified by local checks. Before enabling human account access, establish
   an authenticated Site request context whose provenance the host guarantees;
   the public identity guide documents forwarded email and optional full name,
   not a Worker-verifiable subject/proof. Until that check succeeds, the human
   Sites adapter remains fail-closed. Synthetic local authentication is not
   evidence of hosted authentication.

Sites server-backed artifacts require a default-exported Fetch handler in
`dist/server/index.js`; `.openai/hosting.json` declares storage bindings, and
unused bindings stay `null`. See [Sites documentation](https://learn.chatgpt.com/docs/sites),
[data and connections](https://learn.chatgpt.com/docs/sites/data-and-connections),
[hosting, versions and deployments](https://learn.chatgpt.com/docs/sites/managing-a-site),
and [D1 readiness](d1-readiness.md).

## Routes

| Route                                                    | Page                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/`                                                      | Homepage with the 64-county index, discovery forms, a county selection, Stories and Posts area                          |
| `/counties?q=`                                           | County directory with name or FIPS filter and letter navigation                                                         |
| `/counties/{countyFips}`                                 | Banner hero, county navigation and switcher, overview, county organizations, affiliated organizations, documented roles |
| `/people?query=&cursor=`                                 | People search (`searchPeople`)                                                                                          |
| `/people/{personId}`                                     | Person profile (`getPersonProfile`)                                                                                     |
| `/organizations?query=&cursor=`                          | Organization search (`searchOrganizations`)                                                                             |
| `/organizations/{organizationId}`                        | Organization profile, positions and roles                                                                               |
| `/stories`, `/posts`, `/stories/{slug}`, `/posts/{slug}` | Editorial listing and article templates                                                                                 |
| `/about`, `/reading-records`                             | Supporting pages                                                                                                        |
| `/counties?county={countyFips}`                          | County switcher; redirects to the county page                                                                           |
| `/assets/{name}`                                         | Stylesheet, script and brand images                                                                                     |

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

| Field              | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `bannerId`         | Stable logical identity. Not tied to filename, checksum or URL      |
| `assetVersion`     | The approved asset version currently shown                          |
| `countyFips`       | Five-digit FIPS, or `null` for statewide artwork                    |
| `src`              | Resolved, versioned image address (root-relative path or https URL) |
| `alt`, `caption`   | Descriptive alternative text and landmark caption                   |
| `originalFilename` | Provenance only                                                     |
| `width`, `height`  | Intrinsic pixel size, when known                                    |
| `displayMode`      | `cover` or `contain`                                                |
| `focalX`, `focalY` | Normalized focal point                                              |
| `order`, `primary` | Per-county ordering and primary selection                           |
| `status`           | `published` or `unpublished`                                        |

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

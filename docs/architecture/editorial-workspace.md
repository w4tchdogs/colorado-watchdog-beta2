# Editorial workspace (M3-C, discovery added in M3-D, relationship discovery in M3-E)

A local, visual workspace for creating, editing, previewing, organizing and restoring fictional Posts and Stories. It drives the real M3-B content service through the real internal editorial transport. It is a development sandbox. It publishes nothing, adds no public page and grants no production access.

## Launch on Windows

Requirements: Node.js 22 and a modern browser (Edge, Chrome or Firefox).

1. Open PowerShell in the repository folder.
2. Run `npm install` once.
3. Run `npm run editor:dev`. It builds the project and starts the sandbox.
4. Open `http://127.0.0.1:8788/` in the browser. Use that exact address. `localhost` also works only when the port matches.
5. Stop with `Ctrl+C`. Every sandbox change is discarded on exit and the next launch starts from the same fictional seed.

To use another port, set `EDITOR_PORT` first: in PowerShell `$env:EDITOR_PORT = "8790"; npm run editor:dev`.

## Using the workspace

- **Dashboard:** lists Posts and Stories with type, title, summary, version, last modified (local time, relative age and exact ISO time on hover) and status. Archived rows are shaded. Pages hold 10 items and use the API cursor. Use `New Post` or `New Story` to start one, or `Open` to edit one.
- **Sorting (M3-D):** `Sort by` offers `Recently modified` (default, newest first) and `ID order`. The order applies to the whole filtered result set on the server, never to the loaded page only. A summary line under the controls states the active order, type, status and search, and the count shown.
- **Search (M3-D):** type words in `Search` and press Enter or `Search`. Matching is case-insensitive for ASCII letters, looks only at title and summary, and combines with the type and status filters. Up to five words (100 characters in total) are allowed and every word must appear in the title or summary. `%`, `_`, quotes and markup match literally. Changing the search, a filter or the order returns to page one. `Clear search and filters` resets everything and returns focus to the search box. An empty result explains that nothing matched and how to recover. Loading, error (with `Try again`) and authorization states are unchanged in behavior.
- **Editor:** title, summary and Markdown body with a live preview. The status line shows `Unsaved changes`, `Saving...` or `All changes saved`, plus the current version. Archived articles show a banner and are read-only until restored to a draft.
- **Relationships (M3-E):** three search pickers find counties, people and organizations by displayed name, so no ID has to be memorized or typed. Each result shows its identity before it is chosen, and selections are always stable IDs, never names. See [Relationship discovery](#relationship-discovery-m3-e).
- **Revision history:** each saved version with change type, time, editing account and a `Current` marker. `View` opens a read-only historical revision with preview, an optional comparison with the current draft and a confirmed `Restore this revision`, which creates a new version.
- **Acting as:** the top-right selector switches the synthetic sandbox account. Avery Author and Eli Editor may edit. Riley Reader has no editorial permission and Rene Retired is a disabled account, so both show how denials look. Switching accounts is a sandbox convenience only.

## Safe Markdown preview

The preview is built with a small dependency-free parser and DOM node creation. It never assigns `innerHTML` and has no HTML pass-through. Supported: headings, paragraphs, bold, italic, ordered and unordered lists, blockquotes, links, inline and fenced code, rules and line breaks. Raw HTML, including scripts and iframes, appears as literal text. Images and embeds are replaced by an `[image omitted]` note. A link survives only for an absolute `http`, `https` or `mailto` address without whitespace, control characters or embedded credentials. Everything else shows the link text plus a short note. Input size and nesting are bounded.

## Conflicts and unsaved work

Every mutation sends the expected version. On a stale version the UI never overwrites the newer save and never clears what was typed. A conflict panel names the newer version and editor, shows a line comparison, and offers to keep the local edits on top of the latest version (the next save becomes a new version) or to discard them after an explicit confirmation. A failed or offline save keeps every field and allows a retry. Leaving the page with unsaved changes asks first. Archive, restore and revision restore require a clean state.

## Sandbox isolation

- Binds to `127.0.0.1` only. Only exact `127.0.0.1:PORT` and `localhost:PORT` Host values are served, which blocks DNS rebinding.
- Always opens a fresh in-memory Website database seeded with fictional counties, people, organizations, accounts and about 14 Posts and Stories created through the real service. It never reads `DATABASE_PATH` or any other environment setting, never touches D1, R2 or the Profiles database, and the launcher refuses `APP_ENV` or `NODE_ENV` set to `production`.
- The M3-E lookup (`POST /sandbox/lookup`) is read-only, bounded and sandbox-only. It needs the same token, same-origin checks and an authorized sandbox account as the editorial API.
- A random per-launch token is embedded in the served page and required on every API call. Calls must be same-origin: `Origin` must match when present, `Sec-Fetch-Site` must be `same-origin` when present, and POSTs need one of them.
- A strict Content Security Policy (`default-src 'none'`, scripts, styles and connections from self only, no images, no framing), `nosniff` and `no-store`.
- Authorization is the unchanged M3-B design: the host supplies a trusted principal, a development-only allow policy names the two editing accounts, and the service keeps its own default-deny policy. Responses are never treated as permission by the UI.
- The editorial API is not registered in `src/application.ts` or `src/worker.ts`. The sandbox code lives in `src/editor-dev` and `scripts/editor-dev.mjs`.

## Tests

`tests/editor-markdown.test.mjs` covers the parser, link safety, injection and the diff. `tests/editor-sandbox.test.mjs` covers seeding, isolation, token, origin, host and CSP checks and authorization. `tests/content-listing.test.mjs` covers ordering across pages, equal-timestamp tie-breaks, search and filter combinations, invalid cursors and inputs, changes between requests, authorization and the transport. `tests/editor-discovery.test.mjs` covers the dashboard sort, search, clear, empty, error and authorization behavior. `tests/editor-relationships.test.mjs` covers the sandbox lookup and the pickers (see below). `tests/editor-ui.test.mjs` runs the compiled UI in jsdom against the real sandbox for dashboard, creation, editing, unsaved state, failed saves, conflicts, archive and restore, relationships, revisions and accessibility basics.

## Listing contract (M3-D)

`listDrafts` accepts `sort` (`id` default, or `modified`), `search`, `status`, `contentType`, `limit` (1 to 100) and one cursor. There is no schema change.

- **`id` ordering:** unchanged. The cursor is `afterId` and `nextCursor` is the last ID.
- **`modified` ordering:** `updated_at` descending, then ID descending as a deterministic tie-break. The cursor is the opaque `cursor` field and `nextCursor` has the form `m1~<updatedAt>~<id>`. Paging is keyset-based, so each page is a bounded query (`limit + 1` rows) and nothing is loaded into the browser to simulate paging.
- **Rejected with `invalid_request`:** an unknown or null `sort`, a malformed cursor (wrong prefix, timestamp, ID or length), `afterId` with `modified`, `cursor` with `id`, a non-string or control-character search, a search over 100 characters or more than five words, and unknown request keys. Rejection happens before any data is read, and a failed listing changes nothing.
- **Search:** each word becomes a bound `LIKE` pattern with `\`, `%` and `_` escaped, so input is never interpreted as SQL or a wildcard. The UI never assigns search text as HTML.
- **Authorization:** unchanged. Listing needs `content.read` in the service and the transport authorization callback. Sorting and searching grant nothing.

### Changes between requests

Keyset paging is stable while content changes. An item already shown is never repeated in `modified` order because saving it moves it newer than the cursor. An item edited after you passed its position moves to the front of the list and appears on a fresh first page, not on a later page. An item archived or restored between requests follows the active status filter on the next request.

## Relationship discovery (M3-E)

The Relationships panel has three labeled groups, each with a search picker above the list of selected records.

- **Counties:** search by county name or five-digit FIPS. Results show the name and `FIPS 08001`. The existing explicit county-FIPS model is unchanged.
- **People:** search by name or Website person ID. Results show the name, the stable ID and any recorded role titles as context. Records with identical names are separate results and are chosen one by one. Nothing merges or infers that similarly named people are the same person.
- **Organizations:** search by name, county name or ID. Results show the type, county, any parent record and any county affiliations. Selected organizations are grouped as County organizations, Regional offices, Partner organizations and Other affiliated organizations. Parent records, affiliations and partner records are shown as context only and the panel states that they do not establish administrative authority.

**Selecting and removing.** Choosing a result adds its ID to the draft. Choosing it again reports `already selected` and adds nothing. At most 50 of each kind can be linked, with a message at the limit. Each selected record has a labeled `Remove` button. Removing only changes the draft relationships: the title, summary and text you typed stay as they are, the status line shows `Unsaved changes` and focus returns to the picker. Saving still sends the expected version, so conflicts, failed saves and authorization denials behave as before and keep every selection.

**Keyboard and screen readers.** Each picker is an ARIA combobox with an inline listbox. `Arrow Down` and `Arrow Up` move through results, `Home` and `End` jump, `Enter` adds the highlighted result (and never an unhighlighted one) and `Escape` closes the list, then clears the text. Every control has an explicit label and hint, the active result has a visible outline, and selected results say `Selected` in text as well as by color. Status lines (`Searching...`, `N shown`, `No people match`, errors) and the add and remove messages are polite live regions. Failed searches show a `Try again` button and leave selections untouched.

**Missing, invalid and unavailable records.** Selected IDs are checked by exact ID through the same lookup. A record that no longer exists is flagged `Not found in the sandbox directory` and must be removed before saving. If the server rejects a save as `invalid_relationship`, the selections are checked again and the unavailable ones are marked. If the check itself fails, a notice offers `Retry record check`, and the selections can still be saved or removed.

### Sandbox lookup

`POST /sandbox/lookup` is part of the local sandbox only (`src/editor-dev/lookup.ts`). It reads the sandbox's own fictional Website database and writes nothing. It is not registered in `src/application.ts` or `src/worker.ts`, does not touch the public discovery endpoints, the Profiles database or the M1-F assignment, adds no permission, and needs no migration.

- **Request:** `kind` (`person` or `organization`) plus either `query` (up to 100 characters and five words) or `ids` (up to 50 exact IDs, never both), and an optional `limit` of 1 to 25 (default 10). Unknown keys, wrong types, control characters and oversized bodies (4 KiB) are rejected with `invalid_request` before any data is read.
- **Search:** each word is a bound `LIKE` pattern with `\`, `%` and `_` escaped, matched against the name or ID (and the county name for organizations). Results are ordered by name, then ID, and `hasMore` reports truncation.
- **ID check:** returns the records found and `missingIds` for the rest.
- **Authorization:** the same trusted-principal and sandbox policy as the editorial API. No principal returns 401 and a non-editing account returns 403. The content service and its default-deny policy remain authoritative for every save.

The fictional seed now includes two people with the same name and different role records, a county government with a department that has a parent record, two same-named offices in different counties, a regional office, a partner and an affiliated organization.

## Limitations

- `modified` ordering and search scan `content_items` without a dedicated index, because M3-D adds no migration. This is fine for editorial volumes. If the table grows large, add an `updated_at, id` index in a later migration.
- Search is substring matching with no ranking, stemming or fuzzy matching, and SQLite `LIKE` folds case for ASCII only. There is no full-text index or external search service.
- Pages are not snapshots: the total count is not shown and a page can differ after concurrent edits.
- People and organization search is substring matching over the sandbox directory with no ranking or fuzzy matching, and it returns at most 25 records per request. It is not a production directory or a public discovery feature.
- Person context is limited to recorded role titles because the Website people table holds only a display name. Organization context comes from the type, county, parent and affiliation records.
- Comparison diffs are skipped for bodies above 1,500 lines.
- Local sandbox only. Production editorial sign-in, permissions, publication, public rendering, media and approvals do not exist.

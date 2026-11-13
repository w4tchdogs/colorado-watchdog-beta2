# Editorial workspace (M3-C, discovery added in M3-D)

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
- **Relationships:** tick counties, then add people and organizations by explicit ID or from the fictional sandbox directory. Each selection has its own remove button. Nothing is ever linked from names in the text.
- **Revision history:** each saved version with change type, time, editing account and a `Current` marker. `View` opens a read-only historical revision with preview, an optional comparison with the current draft and a confirmed `Restore this revision`, which creates a new version.
- **Acting as:** the top-right selector switches the synthetic sandbox account. Avery Author and Eli Editor may edit. Riley Reader has no editorial permission and Rene Retired is a disabled account, so both show how denials look. Switching accounts is a sandbox convenience only.

## Safe Markdown preview

The preview is built with a small dependency-free parser and DOM node creation. It never assigns `innerHTML` and has no HTML pass-through. Supported: headings, paragraphs, bold, italic, ordered and unordered lists, blockquotes, links, inline and fenced code, rules and line breaks. Raw HTML, including scripts and iframes, appears as literal text. Images and embeds are replaced by an `[image omitted]` note. A link survives only for an absolute `http`, `https` or `mailto` address without whitespace, control characters or embedded credentials. Everything else shows the link text plus a short note. Input size and nesting are bounded.

## Conflicts and unsaved work

Every mutation sends the expected version. On a stale version the UI never overwrites the newer save and never clears what was typed. A conflict panel names the newer version and editor, shows a line comparison, and offers to keep the local edits on top of the latest version (the next save becomes a new version) or to discard them after an explicit confirmation. A failed or offline save keeps every field and allows a retry. Leaving the page with unsaved changes asks first. Archive, restore and revision restore require a clean state.

## Sandbox isolation

- Binds to `127.0.0.1` only. Only exact `127.0.0.1:PORT` and `localhost:PORT` Host values are served, which blocks DNS rebinding.
- Always opens a fresh in-memory Website database seeded with fictional counties, people, organizations, accounts and about 14 Posts and Stories created through the real service. It never reads `DATABASE_PATH` or any other environment setting, never touches D1, R2 or the Profiles database, and the launcher refuses `APP_ENV` or `NODE_ENV` set to `production`.
- A random per-launch token is embedded in the served page and required on every API call. Calls must be same-origin: `Origin` must match when present, `Sec-Fetch-Site` must be `same-origin` when present, and POSTs need one of them.
- A strict Content Security Policy (`default-src 'none'`, scripts, styles and connections from self only, no images, no framing), `nosniff` and `no-store`.
- Authorization is the unchanged M3-B design: the host supplies a trusted principal, a development-only allow policy names the two editing accounts, and the service keeps its own default-deny policy. Responses are never treated as permission by the UI.
- The editorial API is not registered in `src/application.ts` or `src/worker.ts`. The sandbox code lives in `src/editor-dev` and `scripts/editor-dev.mjs`.

## Tests

`tests/editor-markdown.test.mjs` covers the parser, link safety, injection and the diff. `tests/editor-sandbox.test.mjs` covers seeding, isolation, token, origin, host and CSP checks and authorization. `tests/content-listing.test.mjs` covers ordering across pages, equal-timestamp tie-breaks, search and filter combinations, invalid cursors and inputs, changes between requests, authorization and the transport. `tests/editor-discovery.test.mjs` covers the dashboard sort, search, clear, empty, error and authorization behavior. `tests/editor-ui.test.mjs` runs the compiled UI in jsdom against the real sandbox for dashboard, creation, editing, unsaved state, failed saves, conflicts, archive and restore, relationships, revisions and accessibility basics.

## Listing contract (M3-D)

`listDrafts` accepts `sort` (`id` default, or `modified`), `search`, `status`, `contentType`, `limit` (1 to 100) and one cursor. There is no schema change.

- **`id` ordering:** unchanged. The cursor is `afterId` and `nextCursor` is the last ID.
- **`modified` ordering:** `updated_at` descending, then ID descending as a deterministic tie-break. The cursor is the opaque `cursor` field and `nextCursor` has the form `m1~<updatedAt>~<id>`. Paging is keyset-based, so each page is a bounded query (`limit + 1` rows) and nothing is loaded into the browser to simulate paging.
- **Rejected with `invalid_request`:** an unknown or null `sort`, a malformed cursor (wrong prefix, timestamp, ID or length), `afterId` with `modified`, `cursor` with `id`, a non-string or control-character search, a search over 100 characters or more than five words, and unknown request keys. Rejection happens before any data is read, and a failed listing changes nothing.
- **Search:** each word becomes a bound `LIKE` pattern with `\`, `%` and `_` escaped, so input is never interpreted as SQL or a wildcard. The UI never assigns search text as HTML.
- **Authorization:** unchanged. Listing needs `content.read` in the service and the transport authorization callback. Sorting and searching grant nothing.

### Changes between requests

Keyset paging is stable while content changes. An item already shown is never repeated in `modified` order because saving it moves it newer than the cursor. An item edited after you passed its position moves to the front of the list and appears on a fresh first page, not on a later page. An item archived or restored between requests follows the active status filter on the next request.

## Limitations

- `modified` ordering and search scan `content_items` without a dedicated index, because M3-D adds no migration. This is fine for editorial volumes. If the table grows large, add an `updated_at, id` index in a later migration.
- Search is substring matching with no ranking, stemming or fuzzy matching, and SQLite `LIKE` folds case for ASCII only. There is no full-text index or external search service.
- Pages are not snapshots: the total count is not shown and a page can differ after concurrent edits.
- People and organizations are chosen by ID. The sandbox offers a fictional directory only as a convenience. There is no search service for them.
- Comparison diffs are skipped for bodies above 1,500 lines.
- Local sandbox only. Production editorial sign-in, permissions, publication, public rendering, media and approvals do not exist.

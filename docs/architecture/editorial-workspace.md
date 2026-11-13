# Editorial workspace (M3-C)

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

- **Dashboard:** lists Posts and Stories with type, title, summary, version, last modified and status. Filter by type and status. Pages hold 10 items and use the API cursor. Use `New Post` or `New Story` to start one, or `Open` to edit one.
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

`tests/editor-markdown.test.mjs` covers the parser, link safety, injection and the diff. `tests/editor-sandbox.test.mjs` covers seeding, isolation, token, origin, host and CSP checks and authorization. `tests/editor-ui.test.mjs` runs the compiled UI in jsdom against the real sandbox for dashboard, creation, editing, unsaved state, failed saves, conflicts, archive and restore, relationships, revisions and accessibility basics.

## Limitations

- The dashboard follows the accepted list API order (by identifier), not by last modification. Changing the API was out of scope.
- People and organizations are chosen by ID. The sandbox offers a fictional directory only as a convenience. There is no search service, and the sandbox does not invent one.
- Comparison diffs are skipped for bodies above 1,500 lines.
- Local sandbox only. Production editorial sign-in, permissions, publication, public rendering, media and approvals do not exist.

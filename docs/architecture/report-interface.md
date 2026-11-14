# Public report interface integration contract (SUB-2A)

The submission and tracking UI is an independently mountable presentation
module in `src/site/report-interface.ts`. It does not add routes, call a
database, or provide a live reporting service.

## Host integration

The host loads `website/site/report-interface.css` and mounts
`mountReportInterface(root, options)` with:

- `counties`: the current `listCounties()` result; do not copy the county
  registry into a second source.
- `adapter.submit(ReportSubmission)`: an authenticated host adapter that calls
  the SUB-1B service through a future host/Worker integration boundary and
  returns only `{ reference, recoveryKey? }`. SUB-2A does not add that route.
  The service must not return an internal report ID. The recovery key is
  present only for its initial issuance.
- `adapter.track(reference, recoveryKey)`: an adapter that returns only
  `ReportTrackingProjection`, matching the reporter-safe view returned by
  `trackReport`.
- `account` (optional): authenticated account context supplied by the host.
  Bind authorization and the trusted actor server-side; never trust a
  caller-supplied account ID as authentication.
- `demoNotice` only for local fixtures. Never label a live service as a demo.

The UI constructs `ReportSubmission` with an idempotency key and the existing
reporter, confidentiality, contact, subject and evidence fields. It validates
presentation input, but SUB-1B remains responsible for authoritative reference
and payload validation. File uploads are intentionally unsupported. A host may
mount the same module for separate submit and track routes and set
`trackingHref` to its track route; the default in-page link is `#report-track`.

The tracking result type is limited to status, submission date, and
`from`/`to`/`at` status-history entries. Do not expand it with private report
content, staff notes, reporter identity, evidence or audit data. All tracking
credential failures should map to the same generic UI message.

Recovery keys are held only in the initial receipt view's DOM and transient
component memory, never placed in a URL, browser storage, analytics or logs.
Leaving the receipt view clears the displayed key; retries that do not return a
key do not redisclose it.

## Local fictional-data demo

Run `npm run reports:demo` and open `http://127.0.0.1:8791/`. It serves the
existing county registry and fictional reporter context, but report creation
and tracking run only in browser memory. The adapter stores only a generated
reference, recovery-key digest and reporter-safe status projection; it stores
no entered report body, sends no report data to the server and loses all
fixture state on reload. Do not enter real information. This command is a local
presentation demo, not a reporting endpoint or substitute for SUB-1B.

This independently mountable component is integrated into the Website by
SUB-2C, which provides the submit and track routes, reviewed assets, county
registry and typed adapter described below.

## SUB-2C Website integration

The Sites Worker serves `/submit-report` and `/track-report` using the same
mountable interface and its compiled browser adapter. The pages load only the
reviewed `report-interface.css` and generated `report-interface.js` assets;
the Worker build allowlists those files alongside the existing site assets.
County options come from the existing D1-backed `listCounties()` service.

The adapter calls `POST /api/v1/reports` and
`POST /api/v1/reports/track` with same-origin credentials. Public pages clearly
state that intake is unavailable when anonymous submissions are disabled. The
disposable Wrangler D1 test configuration explicitly enables a loopback-only
fictional abuse-control adapter; no corresponding configuration is present in
normal Worker environments. Hosted anonymous intake still needs a shared,
production-compatible abuse-control provider.

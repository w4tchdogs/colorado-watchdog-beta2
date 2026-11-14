# Private report API

`createReportApiModule({ services, store, guestSubmissions })` in
`src/report-api.ts` returns a Fetch-compatible `{ fetch(request) }` handler. The
Sites Worker mounts it at `/api/v1/reports`. `services` is ACCT-1's server-side
`resolvePrincipal` and `hasCapability` implementation. For each request, the
Worker constructs a request-bound D1 store whose `authorizeStaff` callback
resolves the principal again from the server-accepted request and rechecks
`report.review`; never implement it from caller-supplied account IDs, roles or
identity headers.

## Endpoints

- `POST /api/v1/reports` — strict JSON submission; returns `reference`,
  one-time `recoveryKey`, and `replayed`. Replays do not redisclose the key.
- `POST /api/v1/reports/track` — JSON `{reference,recoveryKey}`; returns only
  status, submitted time, and status-only public history.
- `GET /api/v1/reports?limit=25&after=<id>&status=<status>` — staff queue,
  capped at 100, metadata only; `next` is the exclusive ID cursor.
- `GET /api/v1/reports/{id}` — staff-only complete private report.
- `GET /api/v1/reports/{id}/history` — staff-only review history including
  private notes and actors.
- `PATCH /api/v1/reports/{id}/status` — JSON
  `{expectedVersion,status,note?}`; status transitions use compare-and-set.

The review capability is assigned to editor, administrator, and owner. It is
not assigned to contributor. Account identity is resolved by ACCT-1; caller
roles, account IDs, and identity headers are never accepted as authority. Staff
capability is revalidated for each private request and the D1 adapter receives
the server-constructed actor.

All responses use `Cache-Control: no-store, private`. Mutating requests require
same-origin `Origin` and `application/json`, and body size is capped at 32 KiB.
Guest submissions are disabled unless explicitly enabled with a configured
abuse-control provider. The only included provider is explicitly enabled in
the disposable local Wrangler D1 test config, and allows loopback requests
only. The provider required for hosted activation must be production-compatible
and shared across instances; process-local throttling is not production
protection. A missing provider fails closed. No report API errors/logs include
submitted content or credentials.

SUB-2A can consume these stable paths without sharing UI changes. Production
anonymous intake must remain disabled until a working abuse-control provider
and its operational configuration are ready.

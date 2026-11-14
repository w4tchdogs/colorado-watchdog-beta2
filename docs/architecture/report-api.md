# Private report API

`createReportApiModule({ services, store, guestSubmissions })` in `src/report-api.ts`
returns a Fetch-compatible `{ fetch(request) }` handler. Mount that handler at
the `/api/v1/reports` prefix in the future SITES-2 composition; no Site template,
Worker, hosting manifest, or general router changes are needed. `services` must
be ACCT-1's server-side `resolvePrincipal` and `hasCapability` implementation.
The D1 store must be constructed with an `authorizeStaff` callback that
revalidates the current principal; never implement it from request claims.

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
abuse-control provider. The provider must be production-compatible and shared
across instances; process-local throttling is not production protection. A
missing provider fails closed. No report API errors/logs include submitted
content or credentials.

SUB-2A can consume these stable paths without sharing UI changes. Production
anonymous intake must remain disabled until a working abuse-control provider
and its operational configuration are ready.

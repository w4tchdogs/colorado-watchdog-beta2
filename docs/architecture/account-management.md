# Account management foundation (ACCT-1)

ACCT-1 uses the existing Website `accounts` and `identities` tables in D1. The
private Profiles research database remains separate. No account migration or
second account store is introduced.

## Local interface

For a localhost-only synthetic session, start the existing harness with
`ENABLE_SYNTHETIC_AUTH=1 npm run dev` (PowerShell: `$env:ENABLE_SYNTHETIC_AUTH="1";
npm run dev`). This seeds one synthetic human owner into the local D1-compatible
database and injects its test identity only in the loopback dev server. Leave
the flag unset for the default unauthenticated harness.

`GET /admin/accounts` serves a small native HTML/JavaScript management screen.
Its account API is `GET|POST /api/admin/accounts`, `GET|PATCH
/api/admin/accounts/:id`, `PUT /api/admin/accounts/:id/role`,
`POST /api/admin/accounts/:id/credentials`, and
`DELETE /api/admin/accounts/:id/identities?id=...&version=...`. The existing
`POST /api/accounts` compatibility endpoint remains available. The admin
module is exported independently by `createAccountAdminModule` and is also
mounted by the current application router.

Every management read and write checks the current principal and capabilities
on the server. Mutations require a same-origin `Origin` header, reject unknown
JSON fields, use expected row versions, and produce append-only audit entries.
Account listings are cursor-paged with a maximum of 100 rows. Account detail
returns identity metadata only; it never selects or serializes credential
hashes. Agent secrets appear once in the issuance response and are never
included in audit data. Disabling an account prevents all its identities from
authenticating. At least one active human owner with a live human identity must
remain. Agent accounts cannot hold the owner role. Only an owner can link a
human provider subject because linking transfers account access.

## Sites identity boundary

The Sites identity adapter accepts only a `VerifiedSitesContext` supplied by
trusted host code. The Beta-2 Worker currently supplies no such context and
therefore resolves no Sites human principal. It never reads
`oai-authenticated-user-id`, `oai-authenticated-user-email`, or
`oai-authenticated-user-full-name` from request headers. Public browsing remains
available, and all privileged human routes fail closed.

The public [Sites identity guide](https://learn.chatgpt.com/docs/sites/data-and-connections)
documents forwarded email and optional full name. It does not document a stable
opaque subject, authenticity guarantees for those headers, stripping or
replacement of caller-supplied claims, or direct Worker isolation. It does say
SIWC bypass callers have no signed-in visitor identity and do not receive the
identity headers. The guide and available Sites tools do not establish whether
unsigned clients can reach this Worker directly. Email and full name are never
identity keys. Until Sites exposes a documented authenticated context or
another verifiable boundary, header-shaped claims are treated as untrusted.

The D1 account service keeps its principal, account-status, identity-revocation,
expiry, and capability checks. An unlinked subject has no principal; no account,
identity link, or role is created at sign-in. Malformed Authorization headers
fail closed without human fallback. A SIWC bypass token only passes the Sites
access gate; it is not a human identity or ACCT-1 credential.

`npm run test:sites:d1` uses disposable local D1 to verify that complete forged
headers, malformed and duplicate claims, linked synthetic subjects, and
identity-less access do not authenticate a human. Agent-key authorization,
report privacy, and account capabilities continue to be tested independently.
These tests cannot establish hosted gateway isolation.

## First-owner bootstrap

`src/services/owner-bootstrap.ts` exposes an administrative D1 operation and is
not mounted as a Worker route. It checks the exact Beta-2 project and `DB`
binding inputs, verifies the full Website migration inventory (0001–0019 at the AUTH-3-WEB merge), including names and hashes, plus the append-only
bootstrap audit schema, and supports read-only dry run. The write uses a single
D1 atomic batch with guarded inserts for one active human owner, the exact
`chatgpt-sites:<project-id>` subject link, and a distinct
`trusted_bootstrap_operator` audit event. The event records the administrative
operator reference and target account, never the subject. Repeating the exact
completed operation is idempotent; a different owner, conflicting identity,
or partial state is rejected.

No live owner was created or linked. The available Sites connector cannot write
the live D1 database, and no trustworthy stable Sites subject is exposed to the
Worker. Do not run the bootstrap against production until a verified subject
and a trusted administrative D1 binding for the intended project are available.
The current Site and audience remain unchanged. Beta-1 is not modified.

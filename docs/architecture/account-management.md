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

`createSitesIdentityAdapter` accepts a host supplied verified-context
function. The adapter never reads identity headers from `Request`; absent
verified context it returns no human identity. This allows local tests and
future Sites wiring without treating spoofable request headers as proof.

**Hosted dependency:** the Sites runtime must supply a documented and
authenticated user identity to the application boundary, or a small hosting
adapter must validate the platform identity before constructing
`VerifiedSitesIdentity`. The narrow merge integration is to pass that verified
context function into `createServices({ humanIdentityAdapter:
createSitesIdentityAdapter(context) })` from the hosting composition root.
Do not use caller-controlled headers as the context source. The D1 account
service, API module and user interface remain independent of the SITES-2 Worker
entrypoint and M4-D directory interfaces.

The current local dev harness has no trusted Sites identity source. It can
exercise agent credentials and tests can inject synthetic human identity
adapters. No production account is created or invited by this milestone.

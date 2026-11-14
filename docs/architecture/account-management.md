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

`createSitesIdentityAdapter({ siteId, context })` accepts a host supplied
verified-context function. Bundled Sites runtime guidance confirms
`oai-authenticated-user-id` is stable for the same user on one Site and differs
across Sites. The Website account ID remains its own permanent identifier; the
Sites ID is only the identity subject, namespaced by the configured Site ID.
Email and full name are metadata and never grant a role or capability. A change
to email therefore does not change the linked account. The adapter never reads
identity headers from `Request`; absent verified context or required claims it
returns no human identity. This keeps caller-controlled request headers from
being treated as proof.

**Hosted dependency:** bundled Sites runtime guidance includes the stable ID,
email and optional name headers, while the public identity guide documents email
and optional full name ([ChatGPT Sites identity docs](https://learn.chatgpt.com/docs/sites/data-and-connections)).
That public guide does not describe the stable-ID header or explicitly state
the platform's anti-spoofing guarantee. The host must establish trusted
provenance before constructing `VerifiedSitesIdentity`; otherwise identity
resolution fails closed. The narrow SITES-2 integration is to provide this
trusted context to `createSitesIdentityAdapter({ siteId, context })` from its
hosting composition root. The D1 account service, API module and user interface
remain independent of the SITES-2 Worker entrypoint and M4-D directory
interfaces. Sites owns `/signin-with-chatgpt` and `/signout-with-chatgpt`; the
unauthenticated management page links into the native sign-in path.

The management page shows attributed account audit events at
`GET /api/admin/accounts/:id/audit`; credentials remain redacted.

## Sites Worker integration

The Sites Worker uses `createD1AccountServices`, an asynchronous implementation
of the existing account-service contract over the Website D1 binding. It keeps
the same account and identity tables, policy checks, version guards and
credential-free audit records. It does not bundle or use SQL.js as a production
database, and it does not enable synchronization capabilities or routes.
Agent-key principal resolution and account management use D1's asynchronous
prepared statements and guarded batch writes.

The Worker builds `createSitesIdentityAdapter({ siteId, context })` with the
actual `.openai/hosting.json.project_id`; it does not use a display name or a
placeholder. That project ID is intentionally absent until the new isolated
Beta-2 Site is created. The public Sites identity guide currently documents
forwarded email and optional full name but does not define a host-verifiable
identity subject or an anti-spoofing guarantee for Worker request headers. No
verified host context API is available in the Worker composition today, so its
`context` is absent and human identity remains fail-closed. The application
never promotes `oai-authenticated-*` headers from an arbitrary HTTP request.

`npm run test:sites:d1` verifies public routes together with synthetic agent
authentication, management reads/writes, one-time credential issuance and
revocation on disposable local D1. A local synthetic agent proves the adapter
and account routes work; it does not establish hosted ChatGPT authentication.
Before enabling human account access, the first private Beta-2 Site deployment
must establish a trusted host context and confirm its request/provenance
behavior. No production account is created or invited by this milestone.

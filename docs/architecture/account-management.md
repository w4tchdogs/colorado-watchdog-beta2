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

The Beta-2 Worker reads the Sites-forwarded
`oai-authenticated-user-id`, `oai-authenticated-user-email`, and optional
`oai-authenticated-user-full-name` fields in the isolated Worker composition
helper in `src/worker.ts`. Its subject convention is the opaque Sites
user ID, preserved exactly. The configured `.openai/hosting.json.project_id`
must equal `appgprj_6af7fb8f615c81918da0e4450ba336de`; the adapter namespaces the
subject as `chatgpt-sites:<project-id>`. A missing, malformed, or different
project ID disables Sites human identity resolution. The display name, URL,
Host, Origin, Referer, forwarding metadata, and client-supplied account or role
values do not select the provider or subject.

The Worker boundary requires a nonempty user ID and email, enforces field
length limits, rejects control characters and comma-combined claims, and
rejects malformed email and optional-name values. Invalid or incomplete input
returns no identity. The adapter does not derive a subject from email, name,
cookies, query parameters, or request bodies. Email and full name remain
metadata only. Identity resolution still requires an exact provider and subject
link in Website D1; the forwarded values never become an ACCT-1 principal by
themselves.

**Residual hosting assumption:** the Worker treats these claims as provisionally
platform-authenticated only behind the intended ChatGPT Sites gateway. Their
authenticity depends on the platform preventing client-controlled identity
header injection and unintended direct Worker access. Those guarantees have
not been independently established. Parsing and validation reject malformed
input, but cannot distinguish a genuine forwarded claim from an identical
attacker-supplied header. The public identity guide documents email and
optional full name but not the stable-ID header or complete header provenance
guarantees ([ChatGPT Sites identity docs](https://learn.chatgpt.com/docs/sites/data-and-connections)).
This is a development-stage dependency, not cryptographic authentication.

The D1 account service never parses identity headers and keeps its existing
principal, account-status, identity-revocation, expiry, and capability checks.
An unlinked subject has no principal; no account, identity link, or role is
created at sign-in. Malformed Authorization headers continue to fail closed
without falling back to a Sites identity. A Sites SIWC bypass token only passes
the Sites access gate; it is not a human identity or ACCT-1 credential. If no
usable user-ID claim accompanies a request, no human principal is resolved.

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

The Worker supplies `createSitesIdentityAdapter({ siteId, context })` with the
build-time project ID and the isolated Sites header context. It accepts claims
only for the configured Beta-2 project above. This composition does not change
`createD1AccountServices` or make a raw claim a principal: D1 must find the
exact linked identity and active account, then each protected request checks
current capabilities again. Disabled accounts, revoked or expired identities,
and changed roles therefore affect subsequent authorization. Existing agent
key behavior and account-management safeguards are unchanged.

`npm run test:sites:d1` exercises this bridge with synthetic linked owner,
administrator, editor, contributor, disabled, expired, revoked, unlinked, and
other-project identities on disposable local D1, alongside agent-key and
report-route coverage. Those local tests verify application behavior; they
cannot establish that hosted Sites prevents identity-header injection or that
SIWC bypass requests omit identity claims. The residual gateway assumption
requires separate private hosted verification after the code is merged and
deployed through a later Sites assignment.

This repository has no self-service first-owner bootstrap route. Because only
an existing owner can link a human identity, future hosted testing needs a
separately authorized, attributable operation to provision the first human
owner account and link its Sites subject in D1. AUTH-1 does not create a live
account or link the actual owner's identity. The current private Sites
deployment remains unchanged; a separate assignment must save and verify the
merged integration there. Beta-1 is a separate public Site and is not modified.

# AUTH-3 isolated sign-in pilot

This is a disposable Worker project for testing Auth0 OIDC on Sites. It is intentionally separate from Alpha-1 and uses its own D1. `AUTH0_ENABLED` must remain `false` until the first-login steps below call for enabling it. No GitHub profile field grants Website access.

Expected pilot origin: `https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site`

Runtime settings (set in Sites, never in source): `AUTH0_ENABLED`, `AUTH0_ISSUER`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_REDIRECT_URI`. The redirect URI is the exact origin above plus `/auth/callback`. One optional temporary setting, `AUTH3_PILOT_BOOTSTRAP_SUBJECT`, is described under "Linking the synthetic contributor". The fixed provider issuer must be the default Auth0 tenant issuer ending in `/`.

Session lifetime: 30 minutes idle, 8 hours absolute. Transaction lifetime: 5 minutes. No refresh tokens are requested or retained.

## Auth0 application requirements

The Worker authenticates to Auth0's token endpoint by sending `client_secret` in the JSON request body (`worker.mjs`, callback handler). The Auth0 application must therefore use the Post client-secret method (`client_secret_post`). Basic (`client_secret_basic`) and None will fail the token exchange. The Auth0 Dashboard location and label for this setting (under the application's credentials or advanced settings) have not been verified here, so confirm it in the dashboard. Also set the ID-token signing algorithm to RS256, turn off the default database connection for this application so only the GitHub connection can sign in, and limit the GitHub connection's upstream scopes to `read:user`.

## First login: obtaining the disposable account's Auth0 subject

The pilot D1 starts with one synthetic contributor account and one identity row (`auth3-synthetic-identity`) holding a placeholder issuer and an unlinked sentinel subject. Nothing grants access until that row holds the real Auth0 subject. While `AUTH0_ENABLED` is `false`, `/auth/login` returns 503 before any request to Auth0, and `/auth/callback` also returns 503. The pilot therefore cannot be used to discover the subject while it is disabled. Use one of these two methods. Never use an email address or GitHub username as the subject, and never put a subject or secret in source, logs, a PR or an issue comment.

### Method A: Auth0 dashboard tester (pilot stays disabled)

If the Auth0 Dashboard offers a test or "Try" option for the configured GitHub connection, use it with the disposable GitHub test account. Then open the user in Auth0 User Management and copy the exact User ID. The User ID is the value the Worker sees as the ID token `sub`. Availability and exact behavior of the tester for this connection are unverified. If it is not offered or does not create the user, use Method B.

### Method B: guarded first attempt with the sentinel still unlinked

1. Confirm the identity row still holds the sentinel subject. Set `AUTH0_ENABLED=true` on the isolated pilot only and deploy a new saved version.
2. Sign in once with the disposable GitHub test account. Expect the 403 page "This identity is not linked to the pilot test account." and no session. Confirm the `auth_sessions` table is empty. The Worker deliberately does not show the subject.
3. In Auth0 User Management, open the user that the attempt created and copy the exact User ID.
4. Link only the synthetic contributor with the runtime setting, as described below.
5. Sign in again. Expect a redirect to `/auth/test-view` and the signed-in page.

### Linking the synthetic contributor

The Sites Database tab and connector are read-only, so the row cannot be edited by hand. The pilot Worker links the row itself, once, using the optional runtime setting `AUTH3_PILOT_BOOTSTRAP_SUBJECT`.

How it works. Sign-in first looks up a linked identity as usual. Only if that misses, and only inside the OAuth callback after the transaction, state, nonce, issuer, audience, signature and expiry checks have all passed, the Worker compares the verified ID token `sub` to the setting. The setting must be nonempty and match exactly, and `AUTH0_ENABLED` must be `true`. On a match it runs one guarded `UPDATE` on `auth3-synthetic-identity`. The update applies only while that row still holds the account `auth3-synthetic-contributor`, the placeholder provider `auth0:https://tenant-placeholder.invalid/` and the subject `synthetic-unlinked-sentinel`, is not revoked, and its account is an active human contributor. It sets only `provider` (to `auth0:` plus the verified issuer, trailing slash included) and `subject` (to the verified `sub`). Because the guards are inside the statement, a concurrent callback cannot overwrite an established link. Before any session is issued the normal lookup runs again and must resolve to that synthetic contributor. If the update fails or the link cannot be confirmed, no session is issued. A missing or mismatched setting leaves the existing 403 page "This identity is not linked to the pilot test account." The setting value is never logged or returned. It adds no endpoint, migration, account or role change.

### Owner sequence for the hosted session

This is the plan for a later hosted session. None of it has been done. Only the local results listed in the PR are verified.

1. Confirm the Sites version was built from the PR head that contains this change. Auth0, GitHub OAuth settings and the runtime settings below stay as configured, with `AUTH0_ENABLED=false`.
2. Get the exact Auth0 `sub` for the disposable GitHub account (the connection tester or the Auth0 User ID). It is the User ID, never an email address or GitHub username.
3. In the isolated pilot's Sites settings only, add `AUTH3_PILOT_BOOTSTRAP_SUBJECT` with that exact value. Enter it privately. Never paste it into source, a PR, an issue or chat logs. Set `AUTH0_ENABLED=true` and deploy a new saved version.
4. Sign in once with the disposable GitHub account. Expect a redirect to `/auth/test-view` and the signed-in page.
5. Verify the corrected version and the single changed row with read-only Database access. `identities` should hold exactly one row, `auth3-synthetic-identity`, still on account `auth3-synthetic-contributor`, with `provider` equal to `auth0:` plus the issuer (trailing slash included), `subject` equal to the exact Auth0 `sub`, and `revoked_at` empty. `accounts` should be unchanged with one active contributor, and `auth_sessions` should hold one session. If the row is still the placeholder, the deployed version does not contain this change or the setting does not match exactly.
6. Remove `AUTH3_PILOT_BOOTSTRAP_SUBJECT` from the Sites settings and deploy. Sign out with the button and sign in again. A second successful sign-in with the setting removed shows the link is stored in the database and the setting is no longer needed.
7. Continue the hosted checklist below. After testing, set `AUTH0_ENABLED=false`, deploy, and confirm `/auth/login` and `/auth/callback` return 503 while the home page returns 200. Confirm `AUTH3_PILOT_BOOTSTRAP_SUBJECT` is gone and rotate or remove the pilot client secret.

Local verification only: the guarded SQL runs against real SQLite (`node:sqlite`) using the deployed Drizzle migration and synthetic data in `tests/bootstrap.test.mjs`. That is not D1 itself. Hosted D1 behavior is unverified until the session above.

## Callback diagnostics

Each `/auth/callback` attempt writes one JSON line per stage to the Worker's application log. A line holds only `event` (always `auth3_callback`), `stage`, `outcome` and, when Auth0 answered the token request, `upstream_status` (the numeric HTTP status). Nothing else is logged: no URLs, errors, stacks, request or response bodies, codes, state, nonce, PKCE values, tokens, cookies, secrets or account identifiers. Browser responses are unchanged.

### Matching one fresh attempt

1. Note the UTC time, then sign in once with the disposable GitHub account.
2. In the Sites Worker events for the pilot, find the `GET /auth/callback` request closest to that time. Read the `auth3_callback` lines logged with it, in order. Match by timestamp and request only, never by copying values from the callback URL.
3. The last line shows where the attempt stopped. A complete sign-in ends with `callback` / `completed`.

### Stage and outcome labels

| stage / outcome | Meaning |
| --- | --- |
| `input` / `state_or_cookie_missing` | State or the state cookie was missing or duplicated. Transaction not consumed. |
| `input` / `transaction_rejected` | No unconsumed, unexpired transaction matched the state and cookie. Not consumed by this request. |
| `input` / `provider_error_param_after_consume` | The callback carried an `error` parameter. The transaction was consumed. |
| `input` / `code_missing_or_duplicate_after_consume` | The `code` parameter was missing, empty or repeated. The transaction was consumed. |
| `token_request` / `started` | Input accepted. The token request to Auth0 is about to be sent. |
| `token_request` / `fetch_failed` | The request threw before any HTTP response (network failure, redirect refused). Auth0 may not have received it. |
| `token_request` / `upstream_rejected` | Auth0 answered with a non-success status, shown as `upstream_status`. A 401 or 403 usually means a client ID or secret or authentication-method mismatch, and a 400 usually means a bad code, verifier or redirect URI. |
| `token_request` / `response_unparseable` | Auth0 answered with a success status but the body was not JSON. |
| `token_request` / `response_received` | Auth0 returned a success status and parseable JSON. |
| `id_token` / `verification_failed` | The ID token was missing, malformed, or failed signature, issuer, audience, expiry, nonce or subject checks, or the JWKS fetch failed. |
| `id_token` / `verified` | The ID token passed every check. |
| `identity` / `lookup_or_bootstrap_failed` | The identity lookup or the one-time bootstrap update threw a database error. |
| `identity` / `not_linked` | No eligible linked identity was found. The browser sees the 403 page. |
| `identity` / `linked` | An eligible linked identity was found. |
| `session` / `creation_failed` | Inserting the session row failed. |
| `session` / `created` | The session row was inserted. |
| `callback` / `completed` | The callback finished with a redirect to `/auth/test-view`. |

Reading the sequence: no `token_request` / `started` line means input was rejected first. `started` with nothing after it, or followed by `fetch_failed`, means no usable answer came back from Auth0. A `started` line with no later line at all, as opposed to a failure label, means the Worker stopped without reaching the handler's catch (for example a timeout or cancelled request), and the token request has no timeout of its own.

These labels were exercised locally with synthetic data only. They have not been observed on the hosted Site until the attempt above is run.

## Sign out

The signed-in test page sends `Referrer-Policy: same-origin` so that the browser sends the page's own origin as `Origin` on the Sign out form POST. Every other response keeps `Referrer-Policy: no-referrer`, including the OAuth login redirect and callback. Without this narrow exception a browser form POST under `no-referrer` sends `Origin: null`, which the logout origin check correctly rejects. The logout endpoint still requires the exact pilot origin. Missing, `null`, foreign and lookalike origins are denied with 403 and leave the session active.

## Hosted verification checklist

1. Confirm the Sites version matches the PR head you intend to test.
2. Complete the Auth0 requirements above, then set the Sites runtime settings with `AUTH0_ENABLED=false`.
3. Obtain the subject with Method A or Method B and link the synthetic contributor through `AUTH3_PILOT_BOOTSTRAP_SUBJECT`. Confirm the single changed row, then remove the setting.
4. Sign in. Expect a redirect to `/auth/test-view` and the signed-in page. Check the cookie flags in browser dev tools: `__Host-` prefix, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.
5. With that active session, click Sign out in a real browser. Expect a 303 to `/`, a cleared session cookie, and a 401 from `/auth/test-view`. Confirm the session row has `revoked_at` set.
6. Hosted identity revocation: **blocked.** The test needs `revoked_at` set on the identity row, and no supported private D1 mutation method has been verified. The Sites Database tab and connector are read-only and the pilot adds no maintenance endpoint, so do not edit the row by hand. Local tests cover the behavior (a revoked identity denies its session) with synthetic data only. Hosted verification needs a supported way to run a private write against the pilot D1, for example an owner-only migration or administrative console that Sites has documented. Until then this step stays unverified.
7. Sign in with a second disposable GitHub account that is not linked. Expect 403 and no new session.
8. Before turning sign-in off, keep one signed-in browser session. Set `AUTH0_ENABLED=false`, deploy, and confirm login and callback return 503, the public home page returns 200, and `/auth/test-view` returns 401 with that existing session cookie. The test page is denied, so its Sign out button is not reachable. Use a same-origin `POST /auth/logout` from the browser, or sign out before disabling, then confirm the session row has `revoked_at`. Sign-out stays available while disabled.
9. Session rows and transaction rows cannot be cleared by hand because the Sites Database tab is read-only. Leave them. They expire on their own timestamps and revoked sessions are already unusable. Rotate or remove the pilot client secret.

## Disabling sign-in and stored sessions

Setting `AUTH0_ENABLED` to anything other than `true` only denies access while it is off. `/auth/test-view` returns 401 for every request, including one with an otherwise valid session cookie, and the denied request does not extend the session's idle expiry. Stored sessions are not invalidated or deleted. If the flag is set back to `true`, a session that has not been revoked, has not passed its 30 minute idle or 8 hour absolute limit and still has a linked, active identity works again. Idle time keeps running while disabled, so most sessions will have expired by then. To end a session for good, sign out (`POST /auth/logout` with the exact pilot origin), which works whether sign-in is enabled or disabled. Public browsing is unchanged.

## Known follow-ups

Unauthenticated `GET /auth/login` writes a transaction row each time and nothing purges expired transactions or sessions. The original unit tests use a fake DB. The bootstrap link tests run the guarded SQL against real SQLite instead. The migration exists in two copies (`migrations/0018_auth3_pilot.sql` and `.openai/drizzle/0001_auth3_pilot.sql`, and only the second is built and deployed). Non-POST requests to `/auth/logout` without an `Origin` return 403 instead of 405. The token-endpoint request has no timeout.

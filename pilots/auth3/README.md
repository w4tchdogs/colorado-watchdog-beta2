# AUTH-3 isolated sign-in pilot

This is a disposable Worker project for testing Auth0 OIDC on Sites. It is intentionally separate from Alpha-1 and uses its own D1. `AUTH0_ENABLED` must remain `false` until the first-login steps below call for enabling it. No GitHub profile field grants Website access.

Expected pilot origin: `https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site`

Runtime settings (set in Sites, never in source): `AUTH0_ENABLED`, `AUTH0_ISSUER`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_REDIRECT_URI`. The redirect URI is the exact origin above plus `/auth/callback`. The fixed provider issuer must be the default Auth0 tenant issuer ending in `/`.

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
4. Link only the synthetic contributor, as described below.
5. Sign in again. Expect a redirect to `/auth/test-view` and the signed-in page.

### Linking the synthetic contributor

Update only the existing `auth3-synthetic-identity` row. Set `provider` to `auth0:` followed by the exact issuer including its trailing slash (for example `auth0:https://<tenant-domain>/`) and set `subject` to the exact User ID. A provider value that differs by even a trailing slash produces a 403. Read the row back and confirm exactly one row changed. The supported method for editing a single row in the pilot D1 is unverified until it has been demonstrated. Do not assume the Sites D1 editor exists. A migration is not a good fallback because it would place the subject in source.

## Sign out

The signed-in test page sends `Referrer-Policy: same-origin` so that the browser sends the page's own origin as `Origin` on the Sign out form POST. Every other response keeps `Referrer-Policy: no-referrer`, including the OAuth login redirect and callback. Without this narrow exception a browser form POST under `no-referrer` sends `Origin: null`, which the logout origin check correctly rejects. The logout endpoint still requires the exact pilot origin. Missing, `null`, foreign and lookalike origins are denied with 403 and leave the session active.

## Hosted verification checklist

1. Confirm the Sites version matches the PR head you intend to test.
2. Complete the Auth0 requirements above, then set the Sites runtime settings with `AUTH0_ENABLED=false`.
3. Obtain the subject with Method A or Method B and link the synthetic contributor. Confirm the single changed row.
4. Sign in. Expect a redirect to `/auth/test-view` and the signed-in page. Check the cookie flags in browser dev tools: `__Host-` prefix, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.
5. With that active session, click Sign out in a real browser. Expect a 303 to `/`, a cleared session cookie, and a 401 from `/auth/test-view`. Confirm the session row has `revoked_at` set.
6. Sign in again for a fresh session. Set `revoked_at` on the identity row, reload `/auth/test-view` and expect 401. Clear `revoked_at` afterward if more testing follows.
7. Sign in with a second disposable GitHub account that is not linked. Expect 403 and no new session.
8. Set `AUTH0_ENABLED=false` again, deploy, and confirm login and callback return 503 and the public home page still returns 200.
9. Clear leftover rows in `auth_sessions` and `auth_transactions`, and rotate or remove the pilot client secret.

## Known follow-ups

Unauthenticated `GET /auth/login` writes a transaction row each time and nothing purges expired transactions or sessions. The unit tests use a fake DB, so the SQL is not exercised in CI. The migration exists in two copies (`migrations/0018_auth3_pilot.sql` and `.openai/drizzle/0001_auth3_pilot.sql`, and only the second is built and deployed). Non-POST requests to `/auth/logout` without an `Origin` return 403 instead of 405. The token-endpoint request has no timeout.

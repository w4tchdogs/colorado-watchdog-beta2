# Website human sign-in (AUTH-3-WEB)

Status: implemented and tested locally with synthetic identities. Cloudflare staging owner sign-in is hosted-verified. Sites sign-in remains disabled. See the [hosted staging sign-in evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/174#issuecomment-6932672296).

## What it does

The Website Worker signs in a human through Auth0 with a GitHub connection, using the authorization code flow with PKCE. It then keeps a server-side session in the Website D1 database. The session points at an existing human identity and account. Sign-in never creates an account, a link or a role. A person whose verified subject is not already linked to an active human account gets a `403` and nothing is written except the consumed sign-in transaction. First-owner creation belongs to AUTH-4 and invitations and linking belong to AUTH-5.

## Runtime settings

Sign-in is off unless `AUTH0_ENABLED` is exactly `true` and every other setting is valid. An invalid combination behaves as disabled. Configure these in the target host's runtime settings. Keep secrets out of source. Synthetic values are used in tests.

| Name | Meaning |
| --- | --- |
| `AUTH0_ENABLED` | Exactly `true` enables sign-in. Any other value or no value disables it |
| `AUTH0_ISSUER` | The tenant issuer, an HTTPS URL with a trailing slash and no port, path, query or credentials, for example `https://<tenant>.<region>.auth0.com/` |
| `AUTH0_CLIENT_ID` | The Auth0 application client ID. It is also the required ID token audience |
| `AUTH0_CLIENT_SECRET` | The application client secret. Keep it in the runtime secret store. At least 16 characters |
| `AUTH0_CANONICAL_ORIGIN` | The browser-visible Website origin, HTTPS and no path. Sessions exist only on this origin |
| `AUTH0_REDIRECT_URI` | Exactly `<AUTH0_CANONICAL_ORIGIN>/auth/callback` |

The token endpoint, the signing-key endpoint and the authorization endpoint are always derived from `AUTH0_ISSUER`. Nothing is taken from a request or from a token. Only the disposable local test Worker (`APP_ENV` equal to `test`) accepts a loopback HTTP canonical origin and an `AUTH0_TEST_UPSTREAM` fetch target. Both are ignored everywhere else.

The Auth0 application must use the Post client-secret method (`client_secret_post`) and RS256 ID tokens. Turn off the default database connection for it so that only the GitHub connection can sign in, and limit the upstream GitHub scope to `read:user`. These requirements come from the pilot and are not yet re-verified on the hosted Website.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /auth/login` | Starts sign-in. Accepts an optional `return_to` that must be a same-origin relative path. The default destination is `/`. Redirects to the issuer’s `/authorize` with `response_type=code`, `scope=openid`, S256 `code_challenge`, `state`, `nonce` and `prompt=login` |
| `GET /auth/callback` | Validates the response, consumes the transaction once, exchanges the code, verifies the ID token, checks the link, creates the session and redirects to the stored destination |
| `POST /auth/logout` | Revokes the session behind the presented cookie and clears it. Needs an exact `Origin` match. Works while sign-in is disabled |
| `GET /auth/account` | A small page that shows the signed-in account and a Sign out button. With a session cookie but no live session, for example while sign-in is disabled, it still offers Sign out |

Every `/auth/*` response is `no-store`. All except the account page send `Referrer-Policy: no-referrer`. The account page and the account administration access page send `same-origin`, so a browser form POST carries the exact page origin as `Origin` and the sign-out check can pass.

## Sign-in flow

1. Login creates a transaction in D1 holding the hashed state, the hashed browser handle, the nonce, the PKCE verifier and the return path. The transaction lasts five minutes and is bound to the browser through the `__Host-wd-login` cookie.
2. The callback requires exactly one `state`, exactly one of `code` or `error`, a matching `iss` when present, and no other parameter. Any duplicate, missing or conflicting parameter is refused before the transaction is touched. The callback also needs exactly one login cookie.
3. The transaction is consumed with one conditional `UPDATE ... RETURNING`, so of any number of concurrent callbacks at most one proceeds. A provider `error` consumes the transaction and ends the attempt.
4. The code is exchanged at the derived token endpoint with a five second timeout and a 64 KiB response bound. The request uses `redirect: "manual"` and any redirect is refused. Cloudflare Workers reject `redirect: "error"` before sending, which the pilot found.
5. The ID token is verified with `jose`. The Worker checks the RS256 signature against the issuer’s published key, the exact `iss` and `aud`, `azp` when present or when there are several audiences, `exp`, `iat` and `nbf` with a 30 second tolerance and a 15 minute maximum age, and the matching `nonce`. It refuses duplicate JSON members, ill-formed claims, an empty or oversized subject, and any `jku`, `x5u`, `jwk` or `x5c` header. Provider tokens are discarded after verification.
6. Signing keys come from one derived endpoint. They are cached for five minutes, refreshed by one coalesced request, and an unknown key ID triggers at most one refresh every 30 seconds. An expired cache is never served after a failed refresh, so an outage denies sign-in. A repeated key ID is treated as ambiguous and untrusted.
7. One guarded `INSERT ... SELECT` creates the session only when `auth0:<issuer>` and the exact subject match an unrevoked, unexpired, non-credential identity of an active human account. The eligibility test lives inside the statement, so a concurrent revoke or disable cannot be overtaken. If no row is created, the callback returns `403`.
8. The browser receives the `__Host-wd-session` cookie and the login cookie is cleared.

## Sessions

The cookie value is 32 random bytes. Only its SHA-256 hash is stored. The cookie is `__Host-wd-session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain`. The idle limit is 30 minutes and the absolute limit is eight hours. Idle expiry is extended only when at least five minutes of it has been used, and never past the absolute limit. No refresh token is requested or kept, so fresh upstream authentication is required when a session ends.

On every protected request the session adapter requires exactly one well-formed session cookie, the canonical origin, and a live session joined to its own identity and account. The identity must still hold the same provider and subject, must not be revoked or expired, and the account must be an active human account. The D1 account service then re-reads the account and identity to derive the principal and capabilities. A role change, a disabled account, a revoked or expired link or a changed subject therefore applies on the next request. A session issued under a previous issuer is ignored.

Duplicate, malformed or foreign-named cookies authenticate nothing. A request on a non-canonical origin authenticates nothing.

## Agent credentials and caller headers

Agent bearer credentials keep precedence. When an `Authorization` header is present the Worker uses only the agent branch. An invalid, duplicated or revoked credential denies the request and never falls back to a cookie. Headers such as `oai-authenticated-user-id` or `x-forwarded-user` still grant nothing. The Sites identity adapter is unchanged and still resolves no one without a verified host context.

## Cross-origin writes and caching

For every route, a request that carries the session cookie and no `Authorization` header and uses a method other than `GET`, `HEAD` or `OPTIONS` is refused with `403 origin_rejected` unless its `Origin` equals the request origin exactly. The existing per-route checks on the account API and the report API remain in place. The check applies only while sign-in is enabled.

A response to any request that carries a session cookie or an `Authorization` header gets `Cache-Control: no-store, private` when it does not already forbid storing. Anonymous public pages are served as before.

## Disabling sign-in

Setting `AUTH0_ENABLED` to anything but `true`, or breaking any other setting, denies every existing session on the next request. The denial happens before any session lookup or idle refresh, so a disabled Worker never extends a session. Public browsing, the disabled-by-default report intake, agent credentials and the MCP endpoint are unaffected.

Stored sessions are not deleted or revoked by disabling. If sign-in is enabled again with the same issuer, a session that was not revoked and has not passed its idle or absolute limit works again. Because idle time keeps running while disabled, most sessions will have lapsed. To end a session for good, sign out. `POST /auth/logout` and the sign-out page keep working while sign-in is disabled so the browser can revoke its session and clear the cookie.

## Stored data and cleanup

Migration `0019_human_sign_in.sql` adds `auth_login_transactions` and `auth_sessions`. They hold no provider token, no code and no cookie value. Neither table is part of the dependency-generation triggers, because sessions change on ordinary sign-ins and must not invalidate guarded administrative writes.

Unauthenticated login requests are bounded. Each login first deletes up to 100 expired or consumed transactions and up to 100 sessions whose absolute expiry passed more than seven days ago. It then inserts only while fewer than 500 unconsumed transactions are live. Past that, login answers `503` with `Retry-After: 60`. This keeps the transaction table at or near its cap and the session table to recent history, without a scheduled job.

## Logging

The Worker logs one JSON line per stage with `event`, `stage`, `outcome` and, when the provider answered, a numeric `upstream_status`. Outcomes are fixed lowercase labels. No URL, query string, code, state, nonce, token, cookie, secret, subject, account identifier or raw error is logged.

## Operator invalidation and recovery

Without adding an administrative write route, an operator has these controls. Set `AUTH0_ENABLED` to `false` to stop all human sessions at once. Change `AUTH0_ISSUER` to retire every session issued by the old tenant. Revoke one identity link or disable one account with the existing account administration API to end that person’s access immediately. For a suspected cookie theft or provider incident, use a trusted D1 console to run `UPDATE auth_sessions SET revoked_at = <now> WHERE revoked_at IS NULL`. A compromised provider signing key is handled at the provider, and the Worker refetches published keys within five minutes.

## Public header entry and dashboard

While sign-in is enabled the shared public header shows LOG IN / SIGN UP to signed-out visitors, with the note that sign-in works only for a Website account that is already linked. The link is `/auth/login?return_to=%2Fdashboard`. A visitor with a live human session sees a Dashboard link to `/dashboard` instead. While sign-in is disabled or invalid the header shows neither, and `/dashboard` answers `404`. The entry only chooses between two links. It grants nothing, and every dashboard request is authorized again on the server. The button follows the archived Beta-1 masthead button (transparent, white border, white uppercase text, dark fill on hover and focus). It is a native link, reachable by keyboard, and stays visible on narrow screens. The dashboard routes are described in [dashboard.md](dashboard.md#hosted-dashboard-alpha-1-entry).

## Enabling sign-in on Alpha-1

The active first-owner target is the [Cloudflare staging Worker](../deployment/cloudflare-staging.md). See [CURRENT](../coordination/CURRENT.md#d-deployment-state-separate-from-source) for the latest operator status. The earlier Sites access gap is recorded in the [Sites first-owner blocker](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/168#issuecomment-6925653748).

1. **Auth0.** Reuse the existing AUTH-3 application and GitHub connection. Settings use Post client authentication and RS256. Confirm the exact staging origin plus `/auth/callback` is in Allowed Callback URLs and retain the existing Sites callback. Obtain the owner's exact Auth0 User ID privately from the tenant's Users screen.
2. **Worker settings.** Use the staging origin without a trailing slash and the exact callback. Set `AUTH0_ISSUER`, the application client ID, and the masked application secret in Cloudflare. Keep `AUTH0_ENABLED=false` while deploying and bootstrapping. Verify dashboard-managed settings and staging bindings after deployment.
3. **Database.** Verify the actual staging D1 behind `DB`, the recovery evidence and the complete applied migration history against the pinned Worker source. Cloudflare staging's verified baseline carries migrations 0001–0023. Sites v14 carries 0001–0022 and its applied checksum ledger is unavailable through the inspected Sites interfaces.
4. **First owner.** Use `bootstrapFirstOwner` in `src/services/owner-bootstrap.ts` through a private operator path with the project ID, `DB`, provider key `auth0:` plus the exact issuer, exact verified subject, and attributable operator reference. Run `dryRun: true`, apply its guarded atomic batch, and verify the account, identity, and audit event. Keep subjects and secrets out of GitHub and logs.
5. **Hosted acceptance.** Set `AUTH0_ENABLED=true` on staging after verifying the records. Test the header sign-in entry, GitHub redirect and callback, owner dashboard access and refresh, sign-out, and denial of an anonymous or unlinked caller. Record the deployment and verification in GitHub. Keep public registration, Turnstile and guest intake disabled for this stage.

## Local verification

`tests/auth-oidc.test.mjs` covers configuration, return paths, the token and key checks, key rotation and outage, and the code exchange. `tests/auth-signin.test.mjs` drives the bundled Worker with a migrated local D1 and a synthetic provider. `npm run test:sites:d1` drives the same bundle under Wrangler with local D1 and a synthetic provider server.

## Not yet verified

A separate hosted unlinked-account result is unreported. The earlier Sites questions include whether its gateway forwards `/auth/*`, the callback query string and the `__Host-` cookies on the canonical origin, outbound HTTPS from the Worker to the tenant, applying migration 0019 to the hosted D1, a hosted sign-in and sign-out, hosted identity revocation, and an unlinked hosted account. The isolated pilot verified the provider and Worker runtime behavior but not this integration.

## Decisions still open

The Auth0 tenant and who operates and recovers it, the canonical Website origin, and the recovery operator who can run trusted D1 changes remain owner decisions. Fixed bounds proposed here for review are five minutes for a transaction, 30 minutes idle and eight hours absolute for a session.

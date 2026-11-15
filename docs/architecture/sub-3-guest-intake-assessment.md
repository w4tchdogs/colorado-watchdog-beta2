# SUB-3 guest intake provider assessment

Evidence reviewed November 14, 2026, against main `919492a` and the
[Alpha-1 report page](https://colorado-watchdog-alpha1.futureguild2.chatgpt.site/submit-report).

## Recommendation

Use Cloudflare Turnstile Free in Managed mode for implementation. It supports
standalone hostnames, has no published traffic or verification quota, and
usually checks visitors without a puzzle. Keep guest intake independent of
Website identity, with anonymous attribution and an optional alias. Hosted
intake remains disabled pending implementation and isolated Sites verification.
[Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) ·
[Widget modes](https://developers.cloudflare.com/turnstile/)

## Published $0 options

| Provider | Free allowance and exhaustion | Visitor experience and privacy |
| --- | --- | --- |
| **Turnstile Free** | Up to 20 widgets per account and 10 hostnames per widget, unlimited challenges and verification requests, seven-day analytics lookback and community support. A service outage, client load failure or upstream throttle still prevents verification. | Managed mode can ask for a checkbox. Cloudflare's overview states WCAG 2.2 AA and its plans page lists AAA. Use AA as the conservative vendor claim and test the actual form. Cloudflare processes IP, TLS fingerprint, user agent, sitekey and origin for bot detection and also uses signals to improve detection as controller. Cloudflare says it does not access or transmit form entries. The addendum gives no fixed signal-retention period. [Plans](https://developers.cloudflare.com/turnstile/plans/) · [Overview](https://developers.cloudflare.com/turnstile/) · [Privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/) |
| **hCaptcha Basic** | $0, advertised up to 10,000 requests/month on the plans page. The pricing page gives a separate Pro allowance. Basic exhaustion behavior is unspecified in the reviewed public documentation. Unavailable verification must close intake. | Basic can present visual puzzles. The accessibility accommodation can require provider email registration and a cookie, adding an identity step for those guests. Technical analytics may be held up to a year after cookie expiry, typically de-identified or aggregated, with an abuse exception. Personal data retention is criteria-based. [Plans](https://www.hcaptcha.com/plans) · [Pricing](https://www.hcaptcha.com/pricing) · [Accessibility](https://www.hcaptcha.com/accessibility) · [Privacy](https://www.hcaptcha.com/privacy) |
| **Google reCAPTCHA Essentials** | 10,000 assessments per calendar month across the organization with billing detached. CreateAssessment returns quota errors, typically 429, until reset. Legacy SiteVerify can return HTTP 200 with success and a static score on exhaustion. Use CreateAssessment for this design. | Score-based checks avoid puzzles but need a threshold and a retry path for false positives. Checkbox mode can present visual/audio alternatives. Google documents its security cookie and processor role for customer data. Reviewed sources give no fixed per-visitor assessment retention period. Minimize optional IP, user-agent and TLS fingerprint fields. [Billing](https://docs.cloud.google.com/recaptcha/docs/billing-information) · [Quota behavior](https://docs.cloud.google.com/recaptcha/quotas) · [Key types](https://docs.cloud.google.com/recaptcha/docs/choose-key-type) · [Privacy FAQ](https://docs.cloud.google.com/recaptcha/docs/faq) |

## Sites and server compatibility

The browser origin is `https://colorado-watchdog-alpha1.futureguild2.chatgpt.site`.
A read-only GET of `/submit-report` returned 200 with `script-src 'self'`,
`connect-src 'self'`, `default-src 'none'` and no `frame-src`. Each hosted
widget needs a route-scoped CSP change. Keep the report POST same-origin.
Sites documents server hosting and connections, its installed reference
exposes runtime secrets, and the Worker exposes HTTPS fetch. Exact hostname
registration, secret injection, effective CSP and HTTPS egress for this
integration remain to be demonstrated in isolation.
[Sites](https://learn.chatgpt.com/docs/sites/data-and-connections) ·
[Worker fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/) ·
[Existing runtime assessment](auth-3-identity-assessment.md)

- **Turnstile.** Register the exact standalone hostname. Add
  `https://challenges.cloudflare.com` to the report page's script and frame
  sources. Keep pre-clearance off. Expose only the public sitekey and inject
  the widget secret into the Worker. POST the token and secret to Siteverify,
  omit optional IP and custom data, and require affirmative success, exact
  hostname, expected action and a fresh challenge timestamp. Tokens last
  five minutes. Cloudflare documents eventually consistent redemption, so
  closely spaced uses can both validate. Enforce one use across Workers.
  [Hostname management](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/) ·
  [CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/) ·
  [Siteverify and network convergence](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) ·
  [Secret rotation](https://developers.cloudflare.com/turnstile/troubleshooting/rotate-secret-key/)
- **hCaptcha.** The widget needs hCaptcha script, frame, style and connect
  sources. Configuration describes allowlisting domains the operator owns.
  Acceptance of the assigned Sites hostname remains unverified. Use a
  dedicated public sitekey and Worker-only account secret. POST form-encoded
  token, secret and expected sitekey to Siteverify. Treat the returned
  hostname as informational per the guide. Tokens default to 120 seconds
  and the API distinguishes expired from already used.
  [Configuration](https://docs.hcaptcha.com/configuration) ·
  [Developer guide](https://docs.hcaptcha.com/)
- **reCAPTCHA.** Register the exact subdomain and permit the documented
  script, frame and connect sources on the submission page. Keep the
  restricted API credential in the Worker and call CreateAssessment for
  the public sitekey. Require a valid token, exact hostname, expected
  action and an acceptable risk score. Tokens expire after two minutes
  and are single-use.
  [Domain registration](https://docs.cloud.google.com/recaptcha/docs/create-key-website) ·
  [CSP FAQ](https://docs.cloud.google.com/recaptcha/docs/faq) ·
  [Server assessment](https://docs.cloud.google.com/recaptcha/docs/create-assessment-website)

## Contract and local verification

[`guestSubmissions.abuseControl`](../../src/report-api.ts) receives the
request after Origin and JSON media-type checks, before strict 32 KiB body
parsing and before writes. A denial returns 429 `rate_limited` with bounded
`Retry-After`. A missing or disabled provider returns 503
`submission_unavailable`. An ordinary thrown verification error returns
503 `service_unavailable`. Denial, expiration and replay share the same
response under this contract. Translate provider parsing failures to a
generic availability error so they do not reach the caller JSON syntax-error
handler. [Existing report API](report-api.md)

The [Worker](../../src/worker.ts) only installs an abuse provider under
`APP_ENV === "test"` and `REPORTS_TEST_ABUSE_CONTROL === "enabled"`. That
provider permits loopback only. The page and API share the availability
configuration. Tracking remains available with independent receipt credentials.

The [synthetic fixture](../../tests/report-api.test.mjs) accepted an anonymous
alias without a Website principal (201), denied invalid, expired and reused
challenge fixtures (429 with `Retry-After`), and returned 503 for a simulated
outage. Exactly one report reached storage. The reused token carried a distinct
report idempotency key to exercise the challenge boundary independently.
Existing tests cover same-key report retries, one-time recovery key disclosure
and missing-provider closure. The fixture models provider outcomes in memory.
Real token issuance and concurrent redemption remain integration checks.

`npm run build` and
`node --test tests/report-api.test.mjs tests/report-intake.test.mjs tests/report-interface.test.mjs`
passed locally (29 tests). The disposable `npm run test:sites:d1` also passed,
including the disabled Worker gate and off-loopback rejection by the test provider.

## Smallest implementation scope

1. Add one default-off Worker adapter. Require exact configured origin,
   public sitekey, Worker-only secret and Website D1. Carry a single bounded
   token in a dedicated same-origin request header. Preserve strict report
   JSON and stored receipt formats. Use bounded verification. Deny invalid,
   expired and used tokens. Fail closed on timeouts, malformed responses,
   upstream throttling or quota exhaustion, configuration errors and storage
   failure. Count outcomes without logging tokens, raw provider responses,
   IPs or report data.
2. After successful Siteverify, atomically insert a unique token digest in
   Website D1 before permitting submission. Retain it through the accepted
   validity window plus bounded clock tolerance and prune expired digests in
   bounded batches. Only the insert winner proceeds. Once a challenge is
   spent, the visitor can get a fresh one while keeping the same report
   idempotency key. D1 exhaustion also closes intake. Published Workers Free
   D1 limits include 5 million rows read and 100,000 written per day. Verify
   the hosted binding's capacity separately.
   [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) ·
   [D1 free-limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
3. Load the Managed widget only on the enabled submission page near submit
   time. Disclose browser-signal processing before loading it. Preserve the
   draft in memory through retries and announce verification status and errors
   accessibly. Keep the anonymous alias, optional contact, tracking and staff
   authorization behavior. Send only verification fields to Siteverify.
4. In a disposable public Sites project, verify secrets, hostname
   allowlisting, CSP and egress with isolated credentials. Exercise blocked
   scripts, keyboard and screen-reader use, fresh-token retries, concurrent
   duplicate redemption even when both upstream responses are affirmative,
   provider or D1 failure and the kill switch. Keep hosted intake disabled
   pending implementation and acceptance evidence.

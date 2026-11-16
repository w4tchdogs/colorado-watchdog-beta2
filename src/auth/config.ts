/**
 * Runtime configuration for Website human sign-in (AUTH-3-WEB).
 *
 * Sign-in is disabled unless `AUTH0_ENABLED` is exactly "true" and every other
 * setting passes validation. Nothing here reads request data, and the token and
 * signing-key endpoints are always derived from the validated issuer.
 */

export interface HumanSignInEnvironment {
  readonly APP_ENV?: string;
  /** Exactly "true" enables sign-in. Any other value, or absence, disables it. */
  readonly AUTH0_ENABLED?: string;
  /** Exact tenant issuer, HTTPS with a trailing slash, for example `https://tenant.example.auth0.com/`. */
  readonly AUTH0_ISSUER?: string;
  /** Auth0 application client ID. It is also the required ID token audience. */
  readonly AUTH0_CLIENT_ID?: string;
  /** Auth0 application client secret. Keep it in the runtime secret store. */
  readonly AUTH0_CLIENT_SECRET?: string;
  /** Canonical browser-visible Website origin, HTTPS and without a path. */
  readonly AUTH0_CANONICAL_ORIGIN?: string;
  /** Exact callback URL, `<canonical origin>/auth/callback`. */
  readonly AUTH0_REDIRECT_URI?: string;
  /** Test-only fetch target for token and key requests; ignored unless APP_ENV is "test". */
  readonly AUTH0_TEST_UPSTREAM?: string;
}

export interface HumanSignInConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly canonicalOrigin: string;
  readonly redirectUri: string;
  /** Identity provider namespace stored in `identities.provider`. */
  readonly provider: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
}

export type HumanSignInState =
  | { readonly status: "disabled" }
  | { readonly status: "invalid" }
  | { readonly status: "enabled"; readonly config: HumanSignInConfig };

export const CALLBACK_PATH = "/auth/callback";
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{8,128}$/;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return null;
  if (hasControlCharacters(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A bare HTTPS issuer: exact text, no port, credentials, path, query or fragment. */
function validIssuer(value: unknown): URL | null {
  const url = parseUrl(value);
  if (
    url?.protocol !== "https:" ||
    url.href !== value ||
    url.pathname !== "/" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === "localhost" ||
    IPV4_HOST.test(url.hostname) ||
    url.hostname.startsWith("[") ||
    !url.hostname.includes(".")
  )
    return null;
  return url;
}

/**
 * The canonical origin is HTTPS in every deployment. A loopback HTTP origin is
 * accepted only in the disposable local test Worker, mirroring the existing
 * test-only switches, so the bundled Worker can run without TLS.
 */
function validCanonicalOrigin(value: unknown, testMode: boolean): URL | null {
  const url = parseUrl(value);
  if (!url || url.origin !== value || url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (testMode && url.protocol === "http:" && isLoopbackHost(url.hostname))
    return url;
  return null;
}

function validTestUpstream(value: unknown): URL | null {
  const url = parseUrl(value);
  if (
    url?.protocol !== "http:" ||
    !isLoopbackHost(url.hostname) ||
    url.origin !== value
  )
    return null;
  return url;
}

/** Reads the sign-in settings. Never throws and never reads request data. */
export function readHumanSignIn(
  environment: HumanSignInEnvironment,
): HumanSignInState {
  if (environment.AUTH0_ENABLED !== "true") return { status: "disabled" };
  const testMode = environment.APP_ENV === "test";
  const issuerUrl = validIssuer(environment.AUTH0_ISSUER);
  const canonical = validCanonicalOrigin(
    environment.AUTH0_CANONICAL_ORIGIN,
    testMode,
  );
  const clientId = environment.AUTH0_CLIENT_ID;
  const clientSecret = environment.AUTH0_CLIENT_SECRET;
  if (
    !issuerUrl ||
    !canonical ||
    typeof clientId !== "string" ||
    !CLIENT_ID_PATTERN.test(clientId) ||
    typeof clientSecret !== "string" ||
    clientSecret.length < 16 ||
    clientSecret.length > 512 ||
    hasControlCharacters(clientSecret) ||
    environment.AUTH0_REDIRECT_URI !== `${canonical.origin}${CALLBACK_PATH}`
  )
    return { status: "invalid" };
  let upstream = issuerUrl.origin;
  if (testMode && environment.AUTH0_TEST_UPSTREAM !== undefined) {
    const override = validTestUpstream(environment.AUTH0_TEST_UPSTREAM);
    if (!override) return { status: "invalid" };
    upstream = override.origin;
  }
  const issuer = issuerUrl.href;
  return {
    status: "enabled",
    config: Object.freeze({
      issuer,
      clientId,
      clientSecret,
      canonicalOrigin: canonical.origin,
      redirectUri: `${canonical.origin}${CALLBACK_PATH}`,
      provider: `auth0:${issuer}`,
      authorizeUrl: new URL("authorize", issuer).href,
      tokenUrl: new URL("oauth/token", upstream).href,
      jwksUrl: new URL(".well-known/jwks.json", upstream).href,
    }),
  };
}

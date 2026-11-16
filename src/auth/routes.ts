import type { AsyncD1Database } from "../database/d1.js";
import type { HumanSignInConfig, HumanSignInState } from "./config.js";
import {
  authResponse,
  clearCookieHeader,
  cookieValues,
  exactSameOrigin,
  handleHash,
  hasSessionCookie,
  LOGIN_COOKIE,
  OPAQUE_HANDLE,
  pkceChallenge,
  plainResponse,
  randomHandle,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  setCookieHeader,
  singleHandleCookie,
  TRANSACTION_MS,
} from "./http.js";
import {
  exchangeAuthorizationCode,
  type FetchFunction,
  OidcError,
  type SigningKeyProvider,
  signingKeysFor,
  verifyIdToken,
} from "./oidc.js";
import {
  consumeLoginTransaction,
  createLoginTransaction,
  createSession,
  revokeSessions,
} from "./store.js";

export const AUTH_PATHS = {
  login: "/auth/login",
  callback: "/auth/callback",
  logout: "/auth/logout",
  account: "/auth/account",
} as const;

const DEFAULT_RETURN_PATH = "/";
const MAX_RETURN_PATH_LENGTH = 200;
const MAX_CODE_LENGTH = 2_048;
const MAX_SESSION_COOKIES_REVOKED = 5;
const CALLBACK_PARAMETERS = new Set([
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
  "iss",
]);
const LABEL = /^[a-z_]{1,48}$/;

export interface AuthRouteOptions {
  readonly database: AsyncD1Database | null;
  readonly signIn: HumanSignInState;
  /** Display facts for the signed-in page, from the live D1 principal. */
  readonly currentAccount?: (
    request: Request,
  ) => Promise<{ displayName: string; role: string } | null>;
  readonly now?: () => Date;
  readonly fetch?: FetchFunction;
  readonly keys?: SigningKeyProvider;
  readonly log?: (entry: Readonly<Record<string, unknown>>) => void;
}

export function isAuthPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

/**
 * Same-origin relative destination or null. Only a plain path and optional
 * query: no scheme, host, backslash, control character, fragment or `/auth`.
 */
export function validReturnPath(value: string): string | null {
  if (
    value.length < 1 ||
    value.length > MAX_RETURN_PATH_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 33 || code === 127;
    })
  )
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://return.invalid");
  } catch {
    return null;
  }
  if (
    parsed.origin !== "https://return.invalid" ||
    `${parsed.pathname}${parsed.search}` !== value ||
    parsed.pathname === "/auth" ||
    parsed.pathname.startsWith("/auth/")
  )
    return null;
  return value;
}

/** Fixed outcome labels and a numeric upstream status only. */
function logger(options: AuthRouteOptions) {
  const write = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return (stage: string, outcome: string, upstreamStatus?: number) => {
    try {
      if (!LABEL.test(stage) || !LABEL.test(outcome)) return;
      write({
        event: "human_sign_in",
        stage,
        outcome,
        ...(Number.isInteger(upstreamStatus) &&
        (upstreamStatus as number) >= 100 &&
        (upstreamStatus as number) <= 599
          ? { upstream_status: upstreamStatus }
          : {}),
      });
    } catch {
      // Logging must never change the response.
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // The only responses with a sign-out button relax the referrer policy to
  // same-origin. Browsers then send the exact page origin as `Origin` on the
  // sign-out POST, which the exact-origin check requires. Every other auth
  // response keeps no-referrer.
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
} as const;

function accountPage(
  status: number,
  message: string,
  options: { signOut: boolean; signIn: boolean },
): Response {
  const signOut = options.signOut
    ? '<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>'
    : "";
  const signIn = options.signIn
    ? '<p><a href="/auth/login">Sign in</a></p>'
    : "";
  return authResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account · Colorado Watchdog</title><main><h1>Account</h1><p>${escapeHtml(message)}</p>${signIn}${signOut}</main></html>`,
    status,
    PAGE_HEADERS,
  );
}

export async function handleAuthRequest(
  request: Request,
  options: AuthRouteOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const log = logger(options);
  switch (url.pathname) {
    case AUTH_PATHS.login:
      return request.method === "GET"
        ? login(request, url, options, log)
        : plainResponse(405, "Method not allowed.", { allow: "GET" });
    case AUTH_PATHS.callback:
      return request.method === "GET"
        ? callback(request, url, options, log)
        : plainResponse(405, "Method not allowed.", { allow: "GET" });
    case AUTH_PATHS.logout:
      return request.method === "POST"
        ? logout(request, options, log)
        : plainResponse(405, "Method not allowed.", { allow: "POST" });
    case AUTH_PATHS.account:
      return request.method === "GET"
        ? account(request, options)
        : plainResponse(405, "Method not allowed.", { allow: "GET" });
    default:
      return plainResponse(404, "Not found.");
  }
}

/** Enabled, valid and addressed to the canonical origin, else a response. */
function requireEnabled(
  request: Request,
  options: AuthRouteOptions,
  log: ReturnType<typeof logger>,
  extraHeaders: Record<string, string> = {},
):
  | { config: HumanSignInConfig; database: AsyncD1Database }
  | { response: Response } {
  const { signIn, database } = options;
  if (signIn.status === "invalid") log("configuration", "invalid");
  if (signIn.status !== "enabled" || !database)
    return {
      response: plainResponse(503, "Sign-in is not available.", extraHeaders),
    };
  if (new URL(request.url).origin !== signIn.config.canonicalOrigin)
    return { response: plainResponse(404, "Not found.", extraHeaders) };
  return { config: signIn.config, database };
}

async function login(
  request: Request,
  url: URL,
  options: AuthRouteOptions,
  log: ReturnType<typeof logger>,
): Promise<Response> {
  const enabled = requireEnabled(request, options, log);
  if ("response" in enabled) return enabled.response;
  const { config, database } = enabled;
  const requested = url.searchParams.getAll("return_to");
  if (requested.length > 1)
    return plainResponse(400, "Sign-in could not be started.");
  const returnPath =
    requested.length === 0
      ? DEFAULT_RETURN_PATH
      : validReturnPath(requested[0] ?? "");
  if (returnPath === null)
    return plainResponse(400, "Sign-in could not be started.");

  const state = randomHandle();
  const browser = randomHandle();
  const nonce = randomHandle();
  const verifier = randomHandle();
  try {
    const stored = await createLoginTransaction(
      database,
      {
        stateHash: await handleHash(state),
        browserHash: await handleHash(browser),
        nonce,
        codeVerifier: verifier,
        returnPath,
      },
      (options.now ?? (() => new Date()))(),
    );
    if (!stored) {
      log("login", "capacity_reached");
      return plainResponse(503, "Sign-in is busy. Try again shortly.", {
        "retry-after": "60",
      });
    }
  } catch {
    log("login", "storage_failed");
    return plainResponse(503, "Sign-in is not available.");
  }
  const authorize = new URL(config.authorizeUrl);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "login",
  }).toString();
  return authResponse(null, 302, {
    location: authorize.href,
    "set-cookie": setCookieHeader(LOGIN_COOKIE, browser, TRANSACTION_MS / 1000),
  });
}

function callbackFailure(status: number, message: string): Response {
  return plainResponse(status, message, {
    "set-cookie": clearCookieHeader(LOGIN_COOKIE),
  });
}

/** One value per allowed parameter, and nothing else. */
function callbackParameters(url: URL): Map<string, string> | null {
  const parameters = new Map<string, string>();
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    const [value] = values;
    if (
      !CALLBACK_PARAMETERS.has(key) ||
      values.length !== 1 ||
      value === undefined
    )
      return null;
    parameters.set(key, value);
  }
  return parameters;
}

async function callback(
  request: Request,
  url: URL,
  options: AuthRouteOptions,
  log: ReturnType<typeof logger>,
): Promise<Response> {
  const enabled = requireEnabled(request, options, log, {
    "set-cookie": clearCookieHeader(LOGIN_COOKIE),
  });
  if ("response" in enabled) return enabled.response;
  const { config, database } = enabled;
  const now = options.now ?? (() => new Date());

  const parameters = callbackParameters(url);
  const state = parameters?.get("state");
  const code = parameters?.get("code");
  const providerError = parameters?.has("error") ?? false;
  const browser = singleHandleCookie(request, LOGIN_COOKIE);
  if (
    !parameters ||
    state === undefined ||
    !OPAQUE_HANDLE.test(state) ||
    browser === null ||
    (code !== undefined) === providerError ||
    (code !== undefined && (code === "" || code.length > MAX_CODE_LENGTH)) ||
    (parameters.has("iss") && parameters.get("iss") !== config.issuer)
  ) {
    log("input", "rejected");
    return callbackFailure(400, "Sign-in could not be completed.");
  }

  let transaction: Awaited<ReturnType<typeof consumeLoginTransaction>>;
  try {
    transaction = await consumeLoginTransaction(
      database,
      await handleHash(state),
      await handleHash(browser),
      now(),
    );
  } catch {
    log("transaction", "storage_failed");
    return callbackFailure(503, "Sign-in is not available.");
  }
  if (!transaction) {
    log("transaction", "rejected");
    return callbackFailure(400, "Sign-in could not be completed.");
  }
  if (providerError || code === undefined) {
    log("input", "provider_error_after_consume");
    return callbackFailure(400, "Sign-in could not be completed.");
  }

  let subject: string;
  try {
    const idToken = await exchangeAuthorizationCode(
      config,
      code,
      transaction.codeVerifier,
      options.fetch ? { fetch: options.fetch } : {},
    );
    log("token_request", "response_received");
    ({ subject } = await verifyIdToken(
      idToken,
      config,
      transaction.nonce,
      options.keys ?? signingKeysFor(config),
      now().getTime(),
    ));
    log("id_token", "verified");
  } catch (error) {
    if (error instanceof OidcError)
      log(
        error.label.startsWith("token_") ? "token_request" : "id_token",
        error.label,
        error.upstreamStatus,
      );
    else log("id_token", "verification_failed");
    return callbackFailure(400, "Sign-in could not be completed.");
  }

  const handle = randomHandle();
  try {
    const created = await createSession(
      database,
      {
        id: crypto.randomUUID(),
        tokenHash: await handleHash(handle),
        provider: config.provider,
        subject,
      },
      now(),
    );
    if (!created) {
      // No account, link or session is created for an unlinked subject.
      log("identity", "not_linked");
      return callbackFailure(
        403,
        "This sign-in is not linked to a Colorado Watchdog account.",
      );
    }
  } catch {
    log("session", "creation_failed");
    return callbackFailure(503, "Sign-in is not available.");
  }
  log("session", "created");
  return authResponse(null, 302, {
    location: transaction.returnPath,
    "set-cookie": [
      setCookieHeader(SESSION_COOKIE, handle, SESSION_ABSOLUTE_MS / 1000),
      clearCookieHeader(LOGIN_COOKIE),
    ],
  });
}

/**
 * Local sign-out. It needs no sign-in configuration, so it keeps working
 * while sign-in is disabled and lets the browser revoke its session and clear
 * the cookie. Upstream single sign-on is not ended.
 */
async function logout(
  request: Request,
  options: AuthRouteOptions,
  log: ReturnType<typeof logger>,
): Promise<Response> {
  if (!exactSameOrigin(request)) return plainResponse(403, "Forbidden.");
  if (!options.database)
    return plainResponse(503, "Sign-out is not available.");
  try {
    const hashes = await Promise.all(
      cookieValues(request, SESSION_COOKIE)
        .filter((value) => OPAQUE_HANDLE.test(value))
        .slice(0, MAX_SESSION_COOKIES_REVOKED)
        .map(handleHash),
    );
    await revokeSessions(
      options.database,
      [...new Set(hashes)],
      (options.now ?? (() => new Date()))(),
    );
  } catch {
    log("logout", "storage_failed");
    return plainResponse(503, "Sign-out is not available.");
  }
  log("logout", "completed");
  return authResponse(null, 303, {
    location: "/",
    "set-cookie": clearCookieHeader(SESSION_COOKIE),
  });
}

async function account(
  request: Request,
  options: AuthRouteOptions,
): Promise<Response> {
  const enabled = options.signIn.status === "enabled";
  const sessionPresent = hasSessionCookie(request);
  let current: Awaited<
    ReturnType<NonNullable<AuthRouteOptions["currentAccount"]>>
  > = null;
  if (enabled && options.currentAccount) {
    try {
      current = await options.currentAccount(request);
    } catch {
      return plainResponse(503, "Account details are not available.");
    }
  }
  if (current)
    return accountPage(
      200,
      `Signed in as ${current.displayName} (${current.role}).`,
      { signOut: true, signIn: false },
    );
  return accountPage(
    401,
    enabled ? "You are not signed in." : "Sign-in is not available right now.",
    // A browser that still holds a session cookie can always end it, even
    // when sign-in is disabled.
    { signOut: sessionPresent, signIn: enabled },
  );
}

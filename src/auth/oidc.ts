import { importJWK, type JWK, jwtVerify } from "jose";
import type { HumanSignInConfig } from "./config.js";

/** Failure with a fixed label that is safe to log. It never carries input. */
export class OidcError extends Error {
  constructor(
    readonly label: string,
    readonly upstreamStatus?: number,
  ) {
    super(label);
    this.name = "OidcError";
  }
}

export type FetchFunction = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const MAX_TOKEN_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_KEYS = 20;
const MAX_JSON_DEPTH = 8;
const CLOCK_TOLERANCE_SECONDS = 30;
/** The ID token is verified right after the code exchange, so it must be fresh. */
const MAX_TOKEN_AGE = "15m";
export const UPSTREAM_TIMEOUT_MS = 5_000;
export const KEY_CACHE_TTL_MS = 5 * 60_000;
export const KEY_REFRESH_COOLDOWN_MS = 30_000;

/** Parses JSON text and rejects duplicate object members at any depth. */
export function parseJsonWithoutDuplicates(text: string): unknown {
  let position = 0;
  const skip = () => {
    while (/[ \t\n\r]/.test(text[position] ?? "")) position += 1;
  };
  const readString = (): string => {
    const start = position;
    position += 1;
    while (position < text.length) {
      const character = text[position];
      if (character === "\\") position += 2;
      else {
        position += 1;
        if (character === '"') return JSON.parse(text.slice(start, position));
      }
    }
    throw new OidcError("invalid_json");
  };
  const readValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new OidcError("invalid_json");
    skip();
    const character = text[position];
    if (character === '"') {
      readString();
    } else if (character === "{") {
      position += 1;
      skip();
      if (text[position] === "}") {
        position += 1;
        return;
      }
      const names = new Set<string>();
      for (;;) {
        skip();
        if (text[position] !== '"') throw new OidcError("invalid_json");
        const name = readString();
        if (names.has(name)) throw new OidcError("duplicate_json_member");
        names.add(name);
        skip();
        if (text[position] !== ":") throw new OidcError("invalid_json");
        position += 1;
        readValue(depth + 1);
        skip();
        const separator = text[position];
        position += 1;
        if (separator === "}") return;
        if (separator !== ",") throw new OidcError("invalid_json");
      }
    } else if (character === "[") {
      position += 1;
      skip();
      if (text[position] === "]") {
        position += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skip();
        const separator = text[position];
        position += 1;
        if (separator === "]") return;
        if (separator !== ",") throw new OidcError("invalid_json");
      }
    } else {
      const start = position;
      while (
        position < text.length &&
        !/[ \t\n\r,}\]]/.test(text[position] ?? "")
      )
        position += 1;
      if (position === start) throw new OidcError("invalid_json");
    }
  };
  readValue(0);
  skip();
  if (position !== text.length) throw new OidcError("invalid_json");
  try {
    return JSON.parse(text);
  } catch {
    throw new OidcError("invalid_json");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new OidcError("invalid_token");
  try {
    const binary = atob(
      segment
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(segment.length / 4) * 4, "="),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    return parseJsonWithoutDuplicates(text);
  } catch (error) {
    throw error instanceof OidcError ? error : new OidcError("invalid_token");
  }
}

function parseCompactJwt(token: unknown) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH)
    throw new OidcError("invalid_token");
  const parts = token.split(".");
  const [header, claims, signature] = parts;
  if (
    parts.length !== 3 ||
    header === undefined ||
    claims === undefined ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  )
    throw new OidcError("invalid_token");
  const decodedHeader = decodeSegment(header);
  const decodedClaims = decodeSegment(claims);
  if (!isRecord(decodedHeader) || !isRecord(decodedClaims))
    throw new OidcError("invalid_token");
  return { header: decodedHeader, claims: decodedClaims };
}

async function boundedFetch(
  fetchFunction: FetchFunction,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  failure: string,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      // Cloudflare Workers reject redirect "error" before sending, so redirects
      // are surfaced with "manual" and refused below.
      response = await fetchFunction(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new OidcError(failure);
    }
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new OidcError(`${failure}_redirect`, response.status);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new OidcError(`${failure}_rejected`, response.status);
    }
    try {
      return { response, text: await readBounded(response) };
    } catch (error) {
      if (error instanceof OidcError) throw error;
      throw new OidcError(failure);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES)
    throw new OidcError("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OidcError("response_too_large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

/** Exchanges the authorization code at the endpoint derived from the issuer. */
export async function exchangeAuthorizationCode(
  config: HumanSignInConfig,
  code: string,
  codeVerifier: string,
  options: { fetch?: FetchFunction; timeoutMs?: number } = {},
): Promise<string> {
  const { text } = await boundedFetch(
    options.fetch ?? ((input, init) => fetch(input, init)),
    config.tokenUrl,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      }),
    },
    options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    "token_request",
  );
  let body: unknown;
  try {
    body = parseJsonWithoutDuplicates(text);
  } catch {
    throw new OidcError("token_response_unparseable");
  }
  if (!isRecord(body) || typeof body.id_token !== "string" || !body.id_token)
    throw new OidcError("token_response_missing_id_token");
  return body.id_token;
}

export interface SigningKeyProvider {
  /** The one trusted RSA signing key for `kid`, or an OidcError. */
  keyFor(kid: string): Promise<JWK>;
}

interface KeyProviderOptions {
  readonly url: string;
  readonly fetch?: FetchFunction;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly cooldownMs?: number;
  readonly timeoutMs?: number;
}

function usableKeys(body: unknown): Map<string, JWK | null> {
  if (!isRecord(body) || !Array.isArray(body.keys))
    throw new OidcError("keys_invalid");
  if (body.keys.length === 0 || body.keys.length > MAX_KEYS)
    throw new OidcError("keys_invalid");
  const keys = new Map<string, JWK | null>();
  for (const entry of body.keys) {
    if (!isRecord(entry) || entry.kty !== "RSA") continue;
    if (typeof entry.kid !== "string" || entry.kid === "") continue;
    if (entry.use !== undefined && entry.use !== "sig") continue;
    if (entry.alg !== undefined && entry.alg !== "RS256") continue;
    if (typeof entry.n !== "string" || typeof entry.e !== "string") continue;
    // An ambiguous key ID is never trusted.
    keys.set(
      entry.kid,
      keys.has(entry.kid)
        ? null
        : { kty: "RSA", kid: entry.kid, n: entry.n, e: entry.e },
    );
  }
  if (keys.size === 0) throw new OidcError("keys_invalid");
  return keys;
}

/**
 * Bounded signing-key cache. Keys are fetched from the one derived endpoint,
 * cached for a short time, refreshed by a single coalesced request, and a miss
 * triggers at most one refresh per cooldown. When trusted keys cannot be
 * obtained, verification fails closed. Stale keys are never reused.
 */
export function createSigningKeyProvider(
  options: KeyProviderOptions,
): SigningKeyProvider {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? KEY_CACHE_TTL_MS;
  const cooldown = options.cooldownMs ?? KEY_REFRESH_COOLDOWN_MS;
  const fetchFunction = options.fetch ?? ((input, init) => fetch(input, init));
  let keys: Map<string, JWK | null> | null = null;
  let fetchedAt = 0;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      lastAttempt = now();
      try {
        const { text } = await boundedFetch(
          fetchFunction,
          options.url,
          { method: "GET", headers: { accept: "application/json" } },
          options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
          "keys_request",
        );
        let body: unknown;
        try {
          body = parseJsonWithoutDuplicates(text);
        } catch {
          throw new OidcError("keys_invalid");
        }
        keys = usableKeys(body);
        fetchedAt = now();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    async keyFor(kid) {
      const fresh = () => keys !== null && now() - fetchedAt < ttl;
      if (!fresh() || !keys?.has(kid)) {
        const mayRefresh = now() - lastAttempt >= cooldown;
        if (mayRefresh || inflight) await refresh();
        else if (!fresh()) throw new OidcError("keys_unavailable");
      }
      if (!fresh() || keys === null) throw new OidcError("keys_unavailable");
      const key = keys.get(kid);
      if (!key) throw new OidcError("key_unknown");
      return key;
    },
  };
}

const providers = new Map<string, SigningKeyProvider>();

/** One shared provider per key endpoint within this Worker isolate. */
export function signingKeysFor(config: HumanSignInConfig): SigningKeyProvider {
  let provider = providers.get(config.jwksUrl);
  if (!provider) {
    if (providers.size >= 4) providers.clear();
    provider = createSigningKeyProvider({ url: config.jwksUrl });
    providers.set(config.jwksUrl, provider);
  }
  return provider;
}

function validSubject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

/**
 * Verifies the ID token and returns the exact opaque subject. The key endpoint
 * is never taken from the token, and any structural doubt denies.
 */
export async function verifyIdToken(
  token: unknown,
  config: HumanSignInConfig,
  expectedNonce: string,
  keys: SigningKeyProvider,
  now: number = Date.now(),
): Promise<{ readonly subject: string }> {
  const { header, claims } = parseCompactJwt(token);
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid === "" ||
    "jku" in header ||
    "x5u" in header ||
    "jwk" in header ||
    "x5c" in header
  )
    throw new OidcError("invalid_token_header");
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (
    claims.iss !== config.issuer ||
    audiences.length > 9 ||
    !audiences.every((entry) => typeof entry === "string") ||
    !audiences.includes(config.clientId)
  )
    throw new OidcError("invalid_issuer_or_audience");
  if (
    claims.azp !== undefined
      ? claims.azp !== config.clientId
      : audiences.length > 1
  )
    throw new OidcError("invalid_authorized_party");
  if (claims.nonce !== expectedNonce) throw new OidcError("invalid_nonce");
  if (!validSubject(claims.sub)) throw new OidcError("invalid_subject");

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(
      token as string,
      async (protectedHeader) => {
        const key = await keys.keyFor(String(protectedHeader.kid));
        return importJWK(key, "RS256");
      },
      {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_TOKEN_AGE,
        requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
        currentDate: new Date(now),
      },
    );
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("verification_failed");
  }
  if (payload.nonce !== expectedNonce || !validSubject(payload.sub))
    throw new OidcError("invalid_nonce");
  return { subject: payload.sub };
}

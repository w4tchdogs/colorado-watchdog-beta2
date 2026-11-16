import type { AsyncD1Database } from "../database/d1.js";

/** Cloudflare Turnstile Siteverify endpoint. Only tests may substitute it. */
export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Header that carries the single-use challenge token on the report POST. */
export const CHALLENGE_TOKEN_HEADER = "x-turnstile-token";
/** Action the widget is rendered with and that Siteverify must echo. */
export const CHALLENGE_ACTION = "submit-report";

const MAX_TOKEN_LENGTH = 2048;
const MAX_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 4_000;
/** Cloudflare documents a five-minute token lifetime. */
const TOKEN_LIFETIME_SECONDS = 300;
/** Tolerated clock difference between Cloudflare and this Worker. */
const CLOCK_TOLERANCE_SECONDS = 60;
/** Claims outlive the accepted validity window so a spent token stays spent. */
const CLAIM_RETENTION_SECONDS =
  TOKEN_LIFETIME_SECONDS + 2 * CLOCK_TOLERANCE_SECONDS;
const PRUNE_BATCH = 25;

/** Fixed vocabulary, safe to count and log. Never carries request data. */
export type ChallengeOutcome =
  | "accepted"
  | "missing_token"
  | "rejected"
  | "expired"
  | "replayed"
  | "hostname_mismatch"
  | "action_mismatch"
  | "provider_unavailable"
  | "storage_unavailable"
  | "configuration_error";

export interface ReportChallengeOptions {
  readonly database: AsyncD1Database;
  /** Worker-only widget secret. */
  readonly secret: string;
  /** Exact hostname Siteverify must report. */
  readonly hostname: string;
  readonly fetch?: typeof fetch;
  readonly verifyUrl?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly record?: (outcome: ChallengeOutcome) => void;
}

export class ChallengeUnavailableError extends Error {}

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  challenge_ts?: unknown;
  "error-codes"?: unknown;
}

type Verified =
  | { kind: "ok"; challengeTime: number }
  | { kind: "denied"; outcome: ChallengeOutcome };

/**
 * Report abuse control backed by Turnstile Siteverify and an atomic claim in
 * Website D1. Denials resolve with `allowed: false`. Anything that prevents an
 * answer (timeout, malformed or throttled provider reply, bad configuration,
 * storage failure) throws, so the report API closes with 503.
 */
export function createTurnstileAbuseControl(options: ReportChallengeOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const record = (outcome: ChallengeOutcome) => {
    try {
      options.record?.(outcome);
    } catch {
      // Counting must never change the decision.
    }
  };
  const deny = (outcome: ChallengeOutcome) => {
    record(outcome);
    return { allowed: false as const, retryAfterSeconds: 1 };
  };
  const unavailable = (outcome: ChallengeOutcome): never => {
    record(outcome);
    throw new ChallengeUnavailableError();
  };

  async function prune(seconds: number): Promise<void> {
    try {
      await options.database.run(
        `DELETE FROM report_challenge_claims WHERE token_digest IN (
           SELECT token_digest FROM report_challenge_claims
           WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
        [seconds, PRUNE_BATCH],
      );
    } catch {
      // Pruning is best effort. The claim already succeeded.
    }
  }

  async function siteverify(token: string): Promise<Verified> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let body: SiteverifyResponse;
    try {
      // Only the secret and token are sent. No address, header or report data.
      const response = await doFetch(
        options.verifyUrl ?? TURNSTILE_VERIFY_URL,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: options.secret,
            response: token,
          }),
          signal: controller.signal,
          // Workers support "follow" and "manual". A redirect is not ok below.
          redirect: "manual",
        },
      );
      if (!response.ok) return unavailable("provider_unavailable");
      body = JSON.parse(await readBounded(response)) as SiteverifyResponse;
    } catch (error) {
      if (error instanceof ChallengeUnavailableError) throw error;
      return unavailable("provider_unavailable");
    } finally {
      clearTimeout(timer);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return unavailable("provider_unavailable");

    if (body.success !== true) {
      const codes = Array.isArray(body["error-codes"])
        ? body["error-codes"].filter(
            (code): code is string => typeof code === "string",
          )
        : [];
      if (
        codes.some((code) =>
          [
            "missing-input-secret",
            "invalid-input-secret",
            "internal-error",
          ].includes(code),
        )
      )
        return unavailable("configuration_error");
      if (codes.includes("timeout-or-duplicate"))
        return { kind: "denied", outcome: "replayed" };
      if (body.success === false)
        return { kind: "denied", outcome: "rejected" };
      return unavailable("provider_unavailable");
    }
    if (body.hostname !== options.hostname)
      return { kind: "denied", outcome: "hostname_mismatch" };
    if (body.action !== CHALLENGE_ACTION)
      return { kind: "denied", outcome: "action_mismatch" };
    const timestamp =
      typeof body.challenge_ts === "string"
        ? Date.parse(body.challenge_ts)
        : Number.NaN;
    if (!Number.isFinite(timestamp)) return unavailable("provider_unavailable");
    return { kind: "ok", challengeTime: Math.floor(timestamp / 1000) };
  }

  return {
    async check(
      request: Request,
    ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
      const token = request.headers.get(CHALLENGE_TOKEN_HEADER);
      if (
        token === null ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH ||
        !/^[\x21-\x7e]+$/.test(token)
      )
        return deny("missing_token");

      const result = await siteverify(token);
      if (result.kind === "denied") return deny(result.outcome);

      const seconds = Math.floor(now() / 1000);
      const age = seconds - result.challengeTime;
      if (age > TOKEN_LIFETIME_SECONDS || age < -CLOCK_TOLERANCE_SECONDS)
        return deny("expired");

      let claimed: boolean;
      try {
        const claim = await options.database.run(
          `INSERT INTO report_challenge_claims (token_digest, claimed_at, expires_at)
           VALUES (?, ?, ?) ON CONFLICT (token_digest) DO NOTHING`,
          [
            await sha256Hex(token),
            seconds,
            result.challengeTime + CLAIM_RETENTION_SECONDS,
          ],
        );
        claimed = claim.meta?.changes === 1;
      } catch {
        return unavailable("storage_unavailable");
      }
      if (!claimed) return deny("replayed");
      await prune(seconds);
      record("accepted");
      return { allowed: true };
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Provider response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

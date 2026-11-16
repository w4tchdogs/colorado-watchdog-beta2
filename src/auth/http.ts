import { hashCredential } from "../services/security.js";

export const SESSION_COOKIE = "__Host-wd-session";
export const LOGIN_COOKIE = "__Host-wd-login";

/** Opaque handles are 32 random bytes in unpadded base64url. */
export const OPAQUE_HANDLE = /^[A-Za-z0-9_-]{43}$/;

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;
export const TRANSACTION_MS = 5 * 60_000;

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function randomHandle(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Hex SHA-256 of an opaque handle. Only this hash is ever stored. */
export function handleHash(handle: string): Promise<string> {
  return hashCredential(handle);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

/**
 * All values presented under one cookie name. A caller that needs exactly one
 * credential must treat any other count as unauthenticated.
 */
export function cookieValues(request: Request, name: string): string[] {
  const header = request.headers.get("cookie");
  if (header === null) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0 && trimmed.slice(0, separator) === name) {
      values.push(trimmed.slice(separator + 1));
    }
  }
  return values;
}

/** The single well-formed opaque handle under `name`, else null. */
export function singleHandleCookie(
  request: Request,
  name: string,
): string | null {
  const values = cookieValues(request, name);
  const [value] = values;
  return values.length === 1 && value !== undefined && OPAQUE_HANDLE.test(value)
    ? value
    : null;
}

export function hasSessionCookie(request: Request): boolean {
  return cookieValues(request, SESSION_COOKIE).length > 0;
}

export function setCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookieHeader(name: string): string {
  return setCookieHeader(name, "", 0);
}

export function authResponse(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string | readonly string[]> = {},
): Response {
  const output = new Headers({
    "cache-control": "no-store, private",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") output.set(key, value);
    else for (const item of value) output.append(key, item);
  }
  return new Response(body, { status, headers: output });
}

export function plainResponse(
  status: number,
  message: string,
  headers: Record<string, string | readonly string[]> = {},
): Response {
  return authResponse(message, status, {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
}

/** Exact-origin check used for every cookie-authenticated browser write. */
export function exactSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

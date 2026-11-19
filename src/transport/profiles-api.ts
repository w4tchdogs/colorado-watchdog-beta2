import { exactSameOrigin } from "../auth/http.js";
import { PROFILES_API_PREFIX } from "../contracts/profiles.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import {
  ProfilesConflictError,
  ProfilesIdempotencyError,
  ProfilesInputError,
  type ProfilesService,
  ProfilesValidationError,
} from "../services/profiles-d1.js";
import {
  AuthorizationError,
  type TrustedPrincipal,
} from "../services/security.js";

/**
 * Owner Profiles sheet HTTP transport (PROFILES-1).
 *
 * Authenticates through the existing principal resolver, accepts a current
 * human session only and denies every route by default. The actor always comes
 * from the server. Writes need the exact page origin, a JSON body and an
 * idempotency key. Business rules, the live permission recheck, expected
 * versions and atomic writes stay in the service.
 *
 * Routes: GET rows, facets and select-all. POST preview and save.
 */
export const MAX_PROFILES_JSON_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function isProfilesPath(pathname: string): boolean {
  return (
    pathname === PROFILES_API_PREFIX ||
    pathname.startsWith(`${PROFILES_API_PREFIX}/`)
  );
}

export interface ProfilesTransportDependencies {
  readonly resolvePrincipal?: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  /** Must return true for `profile.manage`. Anything else denies. */
  readonly authorize?: (principal: TrustedPrincipal) => Promise<boolean>;
  /** Absent means the database binding is unavailable. */
  readonly service?: ProfilesService;
}

type Op = "rows" | "facets" | "selectAll" | "preview" | "save";

function match(
  pathname: string,
  method: string,
):
  | { kind: "route"; op: Op }
  | { kind: "method"; allow: string }
  | { kind: "none" } {
  const name = pathname.slice(PROFILES_API_PREFIX.length + 1);
  const routes: Record<string, [Op, string]> = {
    rows: ["rows", "GET"],
    facets: ["facets", "GET"],
    "select-all": ["selectAll", "GET"],
    preview: ["preview", "POST"],
    save: ["save", "POST"],
  };
  const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
  if (!route) return { kind: "none" };
  return method === route[1]
    ? { kind: "route", op: route[0] }
    : { kind: "method", allow: route[1] };
}

export function createProfilesApiTransport(
  dependencies: ProfilesTransportDependencies = {},
): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => handle(request, dependencies) };
}

async function handle(
  request: Request,
  dependencies: ProfilesTransportDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const matched = match(url.pathname, request.method);
  if (matched.kind === "none") return json(404, { error: "not_found" });
  if (matched.kind === "method")
    return json(405, { error: "method_not_allowed" }, { allow: matched.allow });
  const write = request.method === "POST";
  if (write) {
    if (url.search !== "") return json(400, { error: "unexpected_query" });
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared))
        return json(400, { error: "invalid_request" });
      if (Number(declared) > MAX_PROFILES_JSON_BYTES)
        return json(413, { error: "request_too_large" });
    }
    const type = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json")
      return json(415, { error: "unsupported_media_type" });
  }

  // Deny before reading or parsing any body.
  let principal: TrustedPrincipal | null;
  try {
    principal = (await dependencies.resolvePrincipal?.(request)) ?? null;
  } catch {
    return json(503, { error: "dependency_unavailable" });
  }
  if (!principal) return json(401, { error: "authentication_required" });
  // Profiles belong to a signed-in human. An agent credential never passes.
  if (principal.kind !== "human") return json(403, { error: "forbidden" });
  if (write && !exactSameOrigin(request))
    return json(403, { error: "origin_rejected" });
  try {
    if ((await dependencies.authorize?.(principal)) !== true)
      return json(403, { error: "forbidden" });
  } catch {
    return json(403, { error: "forbidden" });
  }
  const service = dependencies.service;
  if (!service) return json(503, { error: "profiles_unavailable" });

  try {
    switch (matched.op) {
      case "rows":
        return json(200, {
          ...(await service.listRows(principal, params(url))),
        });
      case "facets":
        return json(200, { ...(await service.facets(principal)) });
      case "selectAll":
        return json(200, {
          ...(await service.selectAll(principal, params(url))),
        });
      case "preview": {
        const body = await readBody(request);
        if (!body) return json(400, { error: "invalid_json" });
        return json(200, {
          ...(await service.preview(principal, body.changes)),
        });
      }
      case "save": {
        const key = request.headers.get("idempotency-key");
        if (!key) return json(400, { error: "idempotency_key_required" });
        const body = await readBody(request);
        if (!body) return json(400, { error: "invalid_json" });
        return json(200, {
          ...(await service.save(principal, key, body.changes)),
        });
      }
    }
  } catch (error) {
    return failure(error);
  }
}

function params(url: URL): Record<string, string> {
  const allowed = new Set([
    "query",
    "county",
    "office",
    "visibility",
    "sort",
    "direction",
    "page",
    "pageSize",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(out, key))
      throw new ProfilesInputError("Unexpected query");
    out[key] = value;
  }
  return out;
}

async function readBody(
  request: Request,
): Promise<{ changes: unknown } | null> {
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROFILES_JSON_BYTES)
      return null;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "changes")
    )
      return null;
    return { changes: (value as { changes?: unknown }).changes };
  } catch {
    return null;
  }
}

function failure(error: unknown): Response {
  if (error instanceof AuthorizationError)
    return json(403, { error: "forbidden" });
  if (error instanceof ProfilesInputError)
    return json(400, { error: "invalid_request", message: error.message });
  if (error instanceof ProfilesConflictError)
    return json(409, { error: "stale_version", issues: error.issues });
  if (error instanceof ProfilesValidationError)
    return json(422, { error: "validation_failed", issues: error.issues });
  if (error instanceof ProfilesIdempotencyError)
    return json(409, { error: "idempotency_conflict" });
  if (error instanceof StorageUnavailableError)
    return json(503, { error: "profiles_unavailable" });
  return json(503, { error: "dependency_unavailable" });
}

function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Record<string, string> = {},
): Response {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    status = 500;
    text = '{"error":"internal_error"}';
  }
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store, private",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

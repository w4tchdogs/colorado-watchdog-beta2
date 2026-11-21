import { exactSameOrigin } from "../auth/http.js";
import { PROFILES_API_PREFIX } from "../contracts/profiles.js";
import { PROFILES_IMPORT_MAX_BYTES } from "../contracts/profiles-import.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import { ProfileUnitLinkError } from "../services/profile-unit-links.js";
import {
  ProfilesConflictError,
  ProfilesIdempotencyError,
  ProfilesInputError,
  type ProfilesService,
  ProfilesValidationError,
} from "../services/profiles-d1.js";
import { ProfilesDeleteError } from "../services/profiles-delete-d1.js";
import {
  ImportIdempotencyError,
  ImportInputError,
  ImportReversalBlockedError,
  ImportStalePreviewError,
  ImportValidationError,
  type ProfilesImportService,
} from "../services/profiles-import-d1.js";
import { ProfilesWorkbookError } from "../services/profiles-import-xlsx.js";
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
 * Routes: GET rows, facets, select-all and names (one Profile's alternate
 * names). POST preview and save. Alternate-name writes travel through the
 * same preview and save, so a Profile's primary and alternate names are saved
 * in one atomic batch. The Profiles import (SYNC-1) adds POST import/preview,
 * import/commit and import/reverse under the same checks. Preview is
 * read-only and commit needs the digest of the preview the owner reviewed
 * plus an idempotency key.
 */
export const MAX_PROFILES_JSON_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DRAFT_WORKBOOK_RESPONSE_BYTES = 24 * 1024 * 1024;

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
  /** Absent means the Profiles import is unavailable. */
  readonly importService?: ProfilesImportService;
  /** Enabled only for the persistent, loopback Website draft database. */
  readonly privateDraftReview?: boolean;
}

type Op =
  | "rows"
  | "facets"
  | "selectAll"
  | "matchingVisibilityPreview"
  | "matchingVisibilitySave"
  | "unitLinksPreview"
  | "unitLinksCommit"
  | "names"
  | "preview"
  | "save"
  | "deletePreview"
  | "deleteCommit"
  | "importPreview"
  | "importCommit"
  | "importReverse";
const IMPORT_OPS: readonly Op[] = [
  "importPreview",
  "importCommit",
  "importReverse",
];

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
    "matching-visibility/preview": ["matchingVisibilityPreview", "POST"],
    "matching-visibility/save": ["matchingVisibilitySave", "POST"],
    "unit-links/preview": ["unitLinksPreview", "POST"],
    "unit-links/commit": ["unitLinksCommit", "POST"],
    names: ["names", "GET"],
    preview: ["preview", "POST"],
    save: ["save", "POST"],
    "delete/preview": ["deletePreview", "POST"],
    "delete/commit": ["deleteCommit", "POST"],
    "import/preview": ["importPreview", "POST"],
    "import/commit": ["importCommit", "POST"],
    "import/reverse": ["importReverse", "POST"],
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
  const isImport = IMPORT_OPS.includes(matched.op);
  const limit = isImport
    ? PROFILES_IMPORT_MAX_BYTES + 4096
    : MAX_PROFILES_JSON_BYTES;
  if (write) {
    if (url.search !== "") return json(400, { error: "unexpected_query" });
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared))
        return json(400, { error: "invalid_request" });
      if (Number(declared) > limit)
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
    if (isImport) {
      const importService = dependencies.importService;
      if (!importService) return json(503, { error: "profiles_unavailable" });
      const input = await readObject(request, limit);
      if (!input) return json(400, { error: "invalid_json" });
      const responseLimit =
        dependencies.privateDraftReview && Object.hasOwn(input, "workbook")
          ? MAX_DRAFT_WORKBOOK_RESPONSE_BYTES
          : MAX_RESPONSE_BYTES;
      if (matched.op === "importPreview")
        return json(
          200,
          { ...(await importService.preview(principal, input)) },
          {},
          responseLimit,
        );
      const key = request.headers.get("idempotency-key");
      if (!key) return json(400, { error: "idempotency_key_required" });
      if (matched.op === "importCommit")
        return json(
          200,
          { ...(await importService.commit(principal, key, input)) },
          {},
          responseLimit,
        );
      const batchId = (input as { batchId?: unknown }).batchId;
      if (typeof batchId !== "string")
        return json(400, { error: "invalid_request" });
      return json(200, {
        ...(await importService.reverse(principal, batchId, key)),
      });
    }
    if (matched.op === "unitLinksPreview" || matched.op === "unitLinksCommit") {
      const input = await readObject(request, limit);
      if (!input) return json(400, { error: "invalid_json" });
      if (matched.op === "unitLinksPreview")
        return json(200, {
          ...(await service.previewUnitLinks(principal, input)),
        });
      const key = request.headers.get("idempotency-key");
      if (!key) return json(400, { error: "idempotency_key_required" });
      return json(200, {
        ...(await service.commitUnitLinks(principal, key, input)),
      });
    }
    if (matched.op === "deletePreview" || matched.op === "deleteCommit") {
      const body = await readObject(request, limit);
      if (!body) return json(400, { error: "invalid_json" });
      if (matched.op === "deletePreview")
        return json(200, { ...(await service.previewDelete(principal, body)) });
      const key = request.headers.get("idempotency-key");
      if (!key) return json(400, { error: "idempotency_key_required" });
      return json(200, {
        ...(await service.commitDelete(principal, key, body)),
      });
    }
    if (
      matched.op === "matchingVisibilityPreview" ||
      matched.op === "matchingVisibilitySave"
    ) {
      const input = await readObject(request, limit);
      if (!input) return json(400, { error: "invalid_json" });
      if (matched.op === "matchingVisibilityPreview")
        return json(200, {
          ...(await service.previewMatchingVisibility(principal, input)),
        });
      const key = request.headers.get("idempotency-key");
      if (!key) return json(400, { error: "idempotency_key_required" });
      return json(200, {
        ...(await service.saveMatchingVisibility(principal, key, input)),
      });
    }
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
      case "names": {
        const profileId = url.searchParams.get("profileId");
        if (
          profileId === null ||
          [...url.searchParams.keys()].some((key) => key !== "profileId") ||
          url.searchParams.getAll("profileId").length !== 1
        )
          throw new ProfilesInputError("A profileId is required");
        const list = await service.alternateNames(principal, profileId);
        if (!list) return json(404, { error: "not_found" });
        return json(200, { ...list });
      }
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
      default:
        // Import operations returned above.
        return json(404, { error: "not_found" });
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

async function readObject(
  request: Request,
  limit: number,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > limit) return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
  if (error instanceof ProfileUnitLinkError)
    return json(error.code === "scope_too_large" ? 400 : 409, {
      error: error.code,
      message: error.message,
    });
  if (error instanceof ProfilesDeleteError)
    return json(
      error.code === "invalid_request"
        ? 400
        : error.code === "not_found"
          ? 404
          : 409,
      { error: error.code },
    );
  if (error instanceof AuthorizationError)
    return json(403, { error: "forbidden" });
  if (error instanceof ProfilesWorkbookError)
    return json(400, { error: "invalid_workbook", message: error.message });
  if (error instanceof ProfilesInputError || error instanceof ImportInputError)
    return json(400, { error: "invalid_request", message: error.message });
  if (error instanceof ImportValidationError)
    return json(422, { error: "validation_failed", issues: error.issues });
  if (error instanceof ImportStalePreviewError)
    return json(409, { error: "stale_preview" });
  if (error instanceof ImportIdempotencyError)
    return json(409, { error: "idempotency_conflict" });
  if (error instanceof ImportReversalBlockedError)
    return json(409, { error: error.code });
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
  maxResponseBytes = MAX_RESPONSE_BYTES,
): Response {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
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

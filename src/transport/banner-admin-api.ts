import { exactSameOrigin } from "../auth/http.js";
import type {
  BannerAdministration,
  BannerMetadataChange,
  NewBannerMetadata,
  PublicationMetadata,
} from "../contracts/banner-administration.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import { BannerStageError } from "../services/banner-admin-d1.js";
import {
  BannerConflictError,
  BannerValidationError,
} from "../services/banner-assets.js";
import {
  BANNER_IMAGE_LIMITS,
  BannerImageError,
} from "../services/banner-image-inspector.js";
import {
  AuthorizationError,
  type TrustedPrincipal,
} from "../services/security.js";

/**
 * Banner administration HTTP transport (BANNER-ADMIN-3).
 *
 * A thin adapter over the `BannerAdministration` contract. It authenticates
 * through the existing principal resolver, requires `banner.manage` for every
 * operation, derives the actor on the server, bounds and type-checks input and
 * maps service failures to stable codes. Business rules, live permission
 * rechecks and guarded writes stay in the service. Every route is default-deny:
 * an absent resolver, authorizer or service denies or reports unavailable.
 * Route shapes are documented in docs/architecture/banner-admin-api.md.
 */
export const BANNER_ADMIN_API_PREFIX = "/api/admin/banners";

export function isBannerAdminPath(pathname: string): boolean {
  return (
    pathname === BANNER_ADMIN_API_PREFIX ||
    pathname.startsWith(`${BANNER_ADMIN_API_PREFIX}/`)
  );
}

/** JSON bodies are small. The image body has its own byte limit. */
export const MAX_BANNER_ADMIN_JSON_BYTES = 64 * 1024;
export const MAX_BANNER_ADMIN_STAGE_HEADER_BYTES = 8 * 1024;
export const BANNER_STAGE_HEADER = "x-banner-stage";

const MAX_RESPONSE_JSON_BYTES = 2 * 1024 * 1024;
const BANNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIPS = /^08\d{3}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Path words that a banner ID may not take, so routes never become ambiguous. */
const RESERVED_BANNER_IDS = new Set(["counties", "versions", "stage"]);

type MaybePromise<T> = T | Promise<T>;

export interface BannerAdminTransportDependencies {
  /** Wire to the existing trusted principal resolver. Never trusts request fields. */
  readonly resolvePrincipal?: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  /** Must return true for `banner.manage`. Anything else denies. */
  readonly authorize?: (principal: TrustedPrincipal) => MaybePromise<boolean>;
  /** Absent means storage or the database binding is unavailable. */
  readonly administration?: BannerAdministration;
}

export function createBannerAdminApiTransport(
  dependencies: BannerAdminTransportDependencies = {},
): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => handle(request, dependencies) };
}

/** A controlled unavailable answer for a Worker without its Website bindings. */
export function bannerAdminUnavailable(): Response {
  return json(503, { error: "banner_admin_unavailable" });
}

type Route =
  | { readonly op: "listCounties" }
  | { readonly op: "getCounty"; readonly fips: string }
  | { readonly op: "listPublications"; readonly bannerId: string }
  | { readonly op: "reconcile"; readonly bannerId: string }
  | { readonly op: "versionImage"; readonly versionId: string }
  | { readonly op: "stage" }
  | {
      readonly op: "publish" | "withdraw" | "restore" | "metadata";
      readonly bannerId: string;
    }
  | { readonly op: "reorder"; readonly fips: string };

type Matched =
  | { readonly kind: "route"; readonly route: Route; readonly method: string }
  | { readonly kind: "method"; readonly allow: string }
  | { readonly kind: "none" };

function match(pathname: string, method: string): Matched {
  const parts = pathname.slice(BANNER_ADMIN_API_PREFIX.length).split("/");
  parts.shift(); // leading empty segment
  const hit = (route: Route, allowed: string): Matched =>
    method === allowed
      ? { kind: "route", route, method }
      : { kind: "method", allow: allowed };
  const [a, b, c] = parts;
  if (a === "counties" && parts.length === 1)
    return hit({ op: "listCounties" }, "GET");
  if (a === "counties" && b && FIPS.test(b)) {
    if (parts.length === 2) return hit({ op: "getCounty", fips: b }, "GET");
    if (parts.length === 3 && c === "reorder")
      return hit({ op: "reorder", fips: b }, "POST");
    return { kind: "none" };
  }
  if (a === "versions" && b && c === "image" && parts.length === 3) {
    return VERSION_ID.test(b)
      ? hit({ op: "versionImage", versionId: b }, "GET")
      : { kind: "none" };
  }
  if (a === "stage" && parts.length === 1) return hit({ op: "stage" }, "POST");
  if (
    a &&
    b &&
    parts.length === 2 &&
    !RESERVED_BANNER_IDS.has(a) &&
    BANNER_ID.test(a)
  ) {
    if (b === "publications")
      return hit({ op: "listPublications", bannerId: a }, "GET");
    if (b === "reconcile") return hit({ op: "reconcile", bannerId: a }, "GET");
    if (b === "publish" || b === "withdraw" || b === "restore")
      return hit({ op: b, bannerId: a }, "POST");
    if (b === "metadata") return hit({ op: "metadata", bannerId: a }, "POST");
  }
  return { kind: "none" };
}

async function handle(
  request: Request,
  dependencies: BannerAdminTransportDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const matched = match(url.pathname, request.method);
  if (matched.kind === "none") return json(404, { error: "not_found" });
  if (matched.kind === "method")
    return json(405, { error: "method_not_allowed" }, { allow: matched.allow });
  const { route } = matched;
  const write = request.method !== "GET";

  const queryError = checkQuery(route, url.searchParams);
  if (queryError) return json(400, { error: queryError });
  if (write) {
    const early = checkWriteHeaders(request, route);
    if (early) return early;
  }

  // Deny before reading or parsing any body.
  let principal: TrustedPrincipal | null;
  try {
    principal = (await dependencies.resolvePrincipal?.(request)) ?? null;
  } catch {
    return json(503, { error: "dependency_unavailable" });
  }
  if (!principal) return json(401, { error: "authentication_required" });
  // A browser write must come from this exact origin. Only an agent that
  // presents its own bearer credential, which a browser never attaches by
  // itself, is exempt.
  if (
    write &&
    !(
      principal.kind === "agent" &&
      request.headers.get("authorization") !== null
    ) &&
    !exactSameOrigin(request)
  )
    return json(403, { error: "origin_rejected" });
  try {
    if ((await dependencies.authorize?.(principal)) !== true)
      return json(403, { error: "forbidden" });
  } catch {
    return json(403, { error: "forbidden" });
  }
  const administration = dependencies.administration;
  if (!administration) return bannerAdminUnavailable();

  try {
    return await execute(request, route, principal, administration);
  } catch (error) {
    return failure(error);
  }
}

function checkQuery(route: Route, params: URLSearchParams): string | null {
  const keys = [...params.keys()];
  if (route.op !== "listCounties")
    return keys.length ? "unexpected_query" : null;
  const allowed = ["query", "limit", "afterFips"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    keys.length !== new Set(keys).size
  )
    return "unexpected_query";
  return null;
}

function checkWriteHeaders(request: Request, route: Route): Response | null {
  const declared = request.headers.get("content-length");
  const limit =
    route.op === "stage"
      ? BANNER_IMAGE_LIMITS.maxBytes
      : MAX_BANNER_ADMIN_JSON_BYTES;
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return json(400, { error: "invalid_request" });
    if (Number(declared) > limit)
      return json(413, { error: "request_too_large" });
  }
  const type = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (route.op === "stage") {
    if (type !== "image/png" && type !== "image/jpeg")
      return json(415, { error: "unsupported_media_type" });
    const encoding = request.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity")
      return json(415, { error: "unsupported_media_type" });
  } else if (type !== "application/json") {
    return json(415, { error: "unsupported_media_type" });
  }
  return null;
}

// ----------------------------------------------------------------- execution

async function execute(
  request: Request,
  route: Route,
  principal: TrustedPrincipal,
  service: BannerAdministration,
): Promise<Response> {
  switch (route.op) {
    case "listCounties": {
      const params = new URL(request.url).searchParams;
      const input: { query?: string; limit?: number; afterFips?: string } = {};
      const query = params.get("query");
      if (query !== null) {
        if (query.length > 50) return invalid();
        input.query = query;
      }
      const limit = params.get("limit");
      if (limit !== null) {
        if (!/^\d{1,3}$/.test(limit)) return invalid();
        input.limit = Number(limit);
      }
      const after = params.get("afterFips");
      if (after !== null) {
        if (!FIPS.test(after)) return invalid();
        input.afterFips = after;
      }
      return json(200, { ...(await service.listCounties(principal, input)) });
    }
    case "getCounty": {
      const detail = await service.getCounty(principal, route.fips);
      return detail
        ? json(200, { ...detail })
        : json(404, { error: "not_found" });
    }
    case "listPublications":
      return json(200, {
        publications: await service.listPublications(principal, route.bannerId),
      });
    case "reconcile":
      return json(200, {
        items: await service.reconcileBanner(principal, route.bannerId),
      });
    case "versionImage": {
      const image = await service.readVersionImage(principal, route.versionId);
      if (!image) return json(404, { error: "not_found" });
      return new Response(image.body, {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": image.mediaType,
          "content-length": String(image.body.byteLength),
          "content-disposition": "inline",
          "content-security-policy": "default-src 'none'; sandbox",
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
      });
    }
    case "stage":
      return stage(request, principal, service);
    default:
      return mutate(request, route, principal, service);
  }
}

async function stage(
  request: Request,
  principal: TrustedPrincipal,
  service: BannerAdministration,
): Promise<Response> {
  const header = request.headers.get(BANNER_STAGE_HEADER);
  if (header === null || header.length > MAX_BANNER_ADMIN_STAGE_HEADER_BYTES)
    return invalid();
  const meta = parseStageHeader(header);
  if (!meta) return invalid();
  const body = await readBounded(request, BANNER_IMAGE_LIMITS.maxBytes);
  if (!body.ok) return json(body.status, { error: body.error });
  const result = await service.stage(principal, {
    bannerId: meta.bannerId,
    countyFips: meta.countyFips,
    sourceFilename: meta.sourceFilename,
    bytes: body.bytes,
    idempotencyKey: meta.idempotencyKey,
    target: meta.target,
    ...(meta.expectedSha256 ? { expectedSha256: meta.expectedSha256 } : {}),
  });
  return json(result.replayed ? 200 : 201, { ...result });
}

async function mutate(
  request: Request,
  route: Exclude<
    Route,
    | { readonly op: "listCounties" | "getCounty" | "listPublications" }
    | { readonly op: "reconcile" | "versionImage" | "stage" }
  >,
  principal: TrustedPrincipal,
  service: BannerAdministration,
): Promise<Response> {
  const body = await readBounded(request, MAX_BANNER_ADMIN_JSON_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const value = parseJson(body.bytes);
  if (!isRecord(value)) return invalid();

  switch (route.op) {
    case "publish": {
      if (
        !closed(value, [
          "versionId",
          "expectedRowVersion",
          "idempotencyKey",
          "metadata",
        ]) ||
        !isVersionId(value.versionId) ||
        !isRowVersion(value.expectedRowVersion) ||
        !isKey(value.idempotencyKey) ||
        (value.metadata !== undefined && !isPublicationMetadata(value.metadata))
      )
        return invalid();
      return json(200, {
        ...(await service.publish(principal, {
          bannerId: route.bannerId,
          versionId: value.versionId,
          expectedRowVersion: value.expectedRowVersion,
          idempotencyKey: value.idempotencyKey,
          ...(value.metadata ? { metadata: value.metadata } : {}),
        })),
      });
    }
    case "restore": {
      if (
        !closed(value, [
          "versionId",
          "expectedRowVersion",
          "idempotencyKey",
          "publicationId",
          "metadata",
        ]) ||
        !isVersionId(value.versionId) ||
        !isRowVersion(value.expectedRowVersion) ||
        !isKey(value.idempotencyKey) ||
        (value.publicationId !== undefined &&
          !isVersionId(value.publicationId)) ||
        (value.metadata !== undefined &&
          !isPublicationMetadata(value.metadata)) ||
        (value.publicationId !== undefined && value.metadata !== undefined)
      )
        return invalid();
      return json(200, {
        ...(await service.restore(principal, {
          bannerId: route.bannerId,
          versionId: value.versionId,
          expectedRowVersion: value.expectedRowVersion,
          idempotencyKey: value.idempotencyKey,
          ...(value.publicationId
            ? { publicationId: value.publicationId }
            : {}),
          ...(value.metadata ? { metadata: value.metadata } : {}),
        })),
      });
    }
    case "withdraw": {
      if (
        !closed(value, ["expectedRowVersion", "idempotencyKey"]) ||
        !isRowVersion(value.expectedRowVersion) ||
        !isKey(value.idempotencyKey)
      )
        return invalid();
      return json(200, {
        ...(await service.withdraw(principal, {
          bannerId: route.bannerId,
          expectedRowVersion: value.expectedRowVersion,
          idempotencyKey: value.idempotencyKey,
        })),
      });
    }
    case "metadata": {
      if (
        !closed(value, ["expectedRowVersion", "idempotencyKey", "change"]) ||
        !isRowVersion(value.expectedRowVersion) ||
        !isKey(value.idempotencyKey) ||
        !isMetadataChange(value.change)
      )
        return invalid();
      return json(200, {
        ...(await service.updateMetadata(principal, {
          bannerId: route.bannerId,
          expectedRowVersion: value.expectedRowVersion,
          idempotencyKey: value.idempotencyKey,
          change: value.change,
        })),
      });
    }
    case "reorder": {
      if (
        !closed(value, [
          "idempotencyKey",
          "orderedBannerIds",
          "expectedRowVersions",
        ]) ||
        !isKey(value.idempotencyKey) ||
        !Array.isArray(value.orderedBannerIds) ||
        value.orderedBannerIds.length < 1 ||
        value.orderedBannerIds.length > 100 ||
        !value.orderedBannerIds.every(isBannerId) ||
        !isRecord(value.expectedRowVersions)
      )
        return invalid();
      const ids = value.orderedBannerIds as string[];
      const versions = value.expectedRowVersions;
      if (
        Object.keys(versions).length !== ids.length ||
        !ids.every((id) => isRowVersion(versions[id]))
      )
        return invalid();
      return json(200, {
        ...(await service.reorderCounty(principal, {
          countyFips: route.fips,
          idempotencyKey: value.idempotencyKey,
          orderedBannerIds: ids,
          expectedRowVersions: versions as Record<string, number>,
        })),
      });
    }
  }
}

// ------------------------------------------------------------------- parsing

interface StageMeta {
  readonly bannerId: string;
  readonly countyFips: string;
  readonly sourceFilename: string;
  readonly idempotencyKey: string;
  readonly expectedSha256?: string;
  readonly target:
    | { readonly kind: "new"; readonly metadata: NewBannerMetadata }
    | { readonly kind: "existing"; readonly expectedRowVersion: number };
}

function parseStageHeader(header: string): StageMeta | null {
  if (!/^[A-Za-z0-9_-]+$/.test(header)) return null;
  let value: unknown;
  try {
    const padded = header.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !closed(value, [
      "bannerId",
      "countyFips",
      "sourceFilename",
      "idempotencyKey",
      "expectedSha256",
      "target",
    ]) ||
    !isBannerId(value.bannerId) ||
    !isFips(value.countyFips) ||
    !isText(value.sourceFilename, 512) ||
    !isKey(value.idempotencyKey) ||
    (value.expectedSha256 !== undefined &&
      !(
        typeof value.expectedSha256 === "string" &&
        DIGEST.test(value.expectedSha256)
      )) ||
    !isRecord(value.target)
  )
    return null;
  const target = value.target;
  if (
    target.kind === "existing" &&
    closed(target, ["kind", "expectedRowVersion"]) &&
    isRowVersion(target.expectedRowVersion)
  )
    return {
      bannerId: value.bannerId,
      countyFips: value.countyFips,
      sourceFilename: value.sourceFilename,
      idempotencyKey: value.idempotencyKey,
      ...(value.expectedSha256 ? { expectedSha256: value.expectedSha256 } : {}),
      target: {
        kind: "existing",
        expectedRowVersion: target.expectedRowVersion,
      },
    };
  if (
    target.kind === "new" &&
    closed(target, ["kind", "metadata"]) &&
    isNewBannerMetadata(target.metadata)
  )
    return {
      bannerId: value.bannerId,
      countyFips: value.countyFips,
      sourceFilename: value.sourceFilename,
      idempotencyKey: value.idempotencyKey,
      ...(value.expectedSha256 ? { expectedSha256: value.expectedSha256 } : {}),
      target: { kind: "new", metadata: target.metadata },
    };
  return null;
}

function isBannerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BANNER_ID.test(value) &&
    !RESERVED_BANNER_IDS.has(value)
  );
}
function isVersionId(value: unknown): value is string {
  return typeof value === "string" && VERSION_ID.test(value);
}
function isFips(value: unknown): value is string {
  return typeof value === "string" && FIPS.test(value);
}
function isKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 200 &&
    !value.includes("\0")
  );
}
function isRowVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length <= max && !value.includes("\0")
  );
}
function isFocal(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}
function isMode(value: unknown): value is "cover" | "contain" {
  return value === "cover" || value === "contain";
}
function isOrder(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPublicationMetadata(value: unknown): value is PublicationMetadata {
  return (
    isRecord(value) &&
    closed(value, ["caption", "altText", "displayMode", "focalX", "focalY"]) &&
    isText(value.caption, 500) &&
    isText(value.altText, 1_000) &&
    isMode(value.displayMode) &&
    isFocal(value.focalX) &&
    isFocal(value.focalY)
  );
}

function isNewBannerMetadata(value: unknown): value is NewBannerMetadata {
  return (
    isRecord(value) &&
    closed(value, [
      "caption",
      "altText",
      "displayOrder",
      "isPrimary",
      "homepageOrder",
      "displayMode",
      "focalX",
      "focalY",
    ]) &&
    isText(value.caption, 500) &&
    isText(value.altText, 1_000) &&
    isOrder(value.displayOrder) &&
    typeof value.isPrimary === "boolean" &&
    (value.homepageOrder === undefined ||
      value.homepageOrder === null ||
      isOrder(value.homepageOrder)) &&
    isMode(value.displayMode) &&
    isFocal(value.focalX) &&
    isFocal(value.focalY)
  );
}

function isMetadataChange(value: unknown): value is BannerMetadataChange {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !closed(value, [
      "caption",
      "altText",
      "displayOrder",
      "homepageOrder",
      "isPrimary",
      "displayMode",
      "focalX",
      "focalY",
    ])
  )
    return false;
  return (
    (value.caption === undefined || isText(value.caption, 500)) &&
    (value.altText === undefined || isText(value.altText, 1_000)) &&
    (value.displayOrder === undefined || isOrder(value.displayOrder)) &&
    (value.homepageOrder === undefined ||
      value.homepageOrder === null ||
      isOrder(value.homepageOrder)) &&
    (value.isPrimary === undefined || typeof value.isPrimary === "boolean") &&
    (value.displayMode === undefined || isMode(value.displayMode)) &&
    (value.focalX === undefined || isFocal(value.focalX)) &&
    (value.focalY === undefined || isFocal(value.focalY))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

type BoundedBody =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly status: 400 | 413;
      readonly error: "invalid_request" | "request_too_large";
    };

/**
 * Reads at most `limit` bytes of the actual stream. `Content-Length` is never
 * trusted: an absent or understated header cannot let a larger body through.
 */
async function readBounded(
  request: Request,
  limit: number,
): Promise<BoundedBody> {
  if (!request.body)
    return { ok: false, status: 400, error: "invalid_request" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        try {
          await reader.cancel();
        } catch {
          // The oversized request is already rejected.
        }
        return { ok: false, status: 413, error: "request_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "invalid_request" };
  }
  if (size === 0) return { ok: false, status: 400, error: "invalid_request" };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// ------------------------------------------------------------------- failures

function invalid(): Response {
  return json(400, { error: "invalid_request" });
}

function failure(error: unknown): Response {
  if (error instanceof AuthorizationError)
    return json(403, { error: "forbidden" });
  if (error instanceof StorageUnavailableError)
    return json(503, { error: "dependency_unavailable" });
  if (error instanceof BannerImageError) {
    if (error.code === "too_large")
      return json(413, { error: "image_too_large" });
    if (error.code === "unsupported_type")
      return json(415, { error: "unsupported_image_type" });
    return json(422, { error: "invalid_image", reason: error.code });
  }
  if (error instanceof BannerValidationError)
    return json(422, { error: "validation_failed", detail: error.message });
  if (error instanceof BannerConflictError)
    return json(409, { error: error.code, detail: error.message });
  if (error instanceof BannerStageError)
    return json(503, { error: error.code, retryable: true });
  return json(500, { error: "internal_error" });
}

function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Record<string, string> = {},
): Response {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_JSON_BYTES) {
    status = 500;
    text = '{"error":"internal_error"}';
  }
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

import {
  CONTENT_SORTS,
  CONTENT_STATUSES,
  CONTENT_TYPES,
  type ContentDraftChanges,
  type ContentItem,
  type ContentListRequest,
  type ContentPage,
  type ContentRelationships,
  type ContentRelationshipsInput,
  type ContentRevision,
  type ContentRevisionListRequest,
  type ContentRevisionPage,
  type ContentSort,
  type ContentStatus,
  type ContentType,
  MAX_CONTENT_BODY_BYTES,
  MAX_CONTENT_CURSOR_LENGTH,
  MAX_CONTENT_PAGE_SIZE,
  MAX_CONTENT_RELATIONSHIPS_PER_KIND,
  MAX_CONTENT_SEARCH_LENGTH,
  MAX_CONTENT_SUMMARY_LENGTH,
  MAX_CONTENT_TITLE_LENGTH,
  type NewContentDraft,
} from "../contracts/content.js";
import { StaleVersionError } from "../database/versioned-writes.js";
import {
  ContentInputError,
  ContentNotFoundError,
  ContentRelationshipError,
  type ContentService,
  ContentStateError,
} from "../services/content.js";
import {
  AuthorizationError,
  type TrustedPrincipal,
} from "../services/security.js";

/**
 * Internal editorial transport for a future editorial workspace.
 *
 * Unregistered: nothing in `createApplication`, the Worker, or MCP creates it.
 * Authentication, per-operation authorization and every operation handler are
 * opt-in, and each absent piece denies. Business rules stay in the content
 * service. This adapter only parses structure, bounds input and sanitizes
 * output. Article bodies are Markdown source text and are never rendered,
 * interpreted or echoed into errors.
 */
export const CONTENT_API_PATHS = {
  createDraft: "/internal/content/drafts/create",
  getDraft: "/internal/content/drafts/get",
  listDrafts: "/internal/content/drafts/list",
  updateDraft: "/internal/content/drafts/update",
  setRelationships: "/internal/content/drafts/relationships",
  archiveDraft: "/internal/content/drafts/archive",
  restoreDraft: "/internal/content/drafts/restore",
  listRevisions: "/internal/content/revisions/list",
  getRevision: "/internal/content/revisions/get",
  restoreRevision: "/internal/content/revisions/restore",
} as const;

export type ContentTransportOperation = keyof typeof CONTENT_API_PATHS;

/** Largest accepted request body, enough for a maximum body with JSON escaping. */
export const MAX_CONTENT_REQUEST_BYTES = 600_000;
const MAX_CONTENT_RESPONSE_BYTES = 1_048_576;

type MaybePromise<T> = T | Promise<T>;

export interface ContentTransportOperations {
  readonly createDraft?: (
    principal: TrustedPrincipal,
    input: NewContentDraft,
  ) => MaybePromise<ContentItem>;
  readonly getDraft?: (
    principal: TrustedPrincipal,
    id: string,
  ) => MaybePromise<ContentItem | null>;
  readonly listDrafts?: (
    principal: TrustedPrincipal,
    request: ContentListRequest,
  ) => MaybePromise<ContentPage>;
  readonly updateDraft?: (
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    changes: ContentDraftChanges,
  ) => MaybePromise<ContentItem>;
  readonly setRelationships?: (
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    relationships: ContentRelationshipsInput,
  ) => MaybePromise<ContentItem>;
  readonly archiveDraft?: (
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
  ) => MaybePromise<ContentItem>;
  readonly restoreDraft?: (
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
  ) => MaybePromise<ContentItem>;
  readonly listRevisions?: (
    principal: TrustedPrincipal,
    id: string,
    request: ContentRevisionListRequest,
  ) => MaybePromise<ContentRevisionPage>;
  readonly getRevision?: (
    principal: TrustedPrincipal,
    id: string,
    version: number,
  ) => MaybePromise<ContentRevision | null>;
  readonly restoreRevision?: (
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    revisionVersion: number,
  ) => MaybePromise<ContentItem>;
}

export interface ContentTransportDependencies {
  /** Wire this to the existing M0-C principal resolver; never trust request fields. */
  readonly resolvePrincipal?: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  /** Each operation requires an explicit positive authorization decision. */
  readonly authorize?: (
    principal: TrustedPrincipal,
    operation: ContentTransportOperation,
  ) => MaybePromise<boolean>;
  readonly operations?: ContentTransportOperations;
}

/** Binds every operation to a content service. The service enforces its own policy. */
export function createContentTransportOperations(
  service: ContentService,
): ContentTransportOperations {
  return {
    createDraft: (principal, input) => service.createDraft(principal, input),
    getDraft: (principal, id) => service.getDraft(principal, id),
    listDrafts: (principal, request) => service.listDrafts(principal, request),
    updateDraft: (principal, id, version, changes) =>
      service.updateDraft(principal, id, version, changes),
    setRelationships: (principal, id, version, relationships) =>
      service.setRelationships(principal, id, version, relationships),
    archiveDraft: (principal, id, version) =>
      service.archiveDraft(principal, id, version),
    restoreDraft: (principal, id, version) =>
      service.restoreDraft(principal, id, version),
    listRevisions: (principal, id, request) =>
      service.listRevisions(principal, id, request),
    getRevision: (principal, id, version) =>
      service.getRevision(principal, id, version),
    restoreRevision: (principal, id, version, revision) =>
      service.restoreRevision(principal, id, version, revision),
  };
}

export function createContentApiTransport(
  dependencies: ContentTransportDependencies = {},
): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => handleRequest(request, dependencies) };
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION_BY_PATH = new Map<string, ContentTransportOperation>(
  (
    Object.entries(CONTENT_API_PATHS) as [ContentTransportOperation, string][]
  ).map(([operation, path]) => [path, operation]),
);

async function handleRequest(
  request: Request,
  dependencies: ContentTransportDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const operation = OPERATION_BY_PATH.get(url.pathname);
  if (!operation) return json(404, { error: "not_found" });
  if (request.method !== "POST")
    return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  if (url.search) return json(400, { error: "unexpected_query" });
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return json(415, { error: "unsupported_media_type" });
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return json(400, { error: "invalid_request" });
    if (Number(declared) > MAX_CONTENT_REQUEST_BYTES)
      return json(413, { error: "request_too_large" });
  }

  // Deny before reading or parsing the body.
  let principal: TrustedPrincipal | null;
  try {
    principal = (await dependencies.resolvePrincipal?.(request)) ?? null;
  } catch {
    return json(503, { error: "dependency_unavailable" });
  }
  if (!principal) return json(401, { error: "authentication_required" });
  try {
    if ((await dependencies.authorize?.(principal, operation)) !== true)
      return json(403, { error: "forbidden" });
  } catch {
    return json(403, { error: "forbidden" });
  }
  const handler = dependencies.operations?.[operation];
  if (typeof handler !== "function")
    return json(503, { error: "operation_unavailable" });

  const body = await readJson(request);
  if (!body.ok) return json(body.status, { error: body.error });
  const input = parseInput(operation, body.value);
  if (!input) return json(400, { error: "invalid_request" });

  try {
    return await execute(operation, principal, input, dependencies.operations);
  } catch (error) {
    return failure(error);
  }
}

async function execute(
  operation: ContentTransportOperation,
  principal: TrustedPrincipal,
  input: Record<string, unknown>,
  operations: ContentTransportOperations | undefined,
): Promise<Response> {
  const ops = operations as ContentTransportOperations;
  switch (operation) {
    case "createDraft":
      return item(
        await ops.createDraft?.(principal, input as unknown as NewContentDraft),
        201,
      );
    case "getDraft":
      return item(await ops.getDraft?.(principal, input.id as string));
    case "listDrafts": {
      const page = await ops.listDrafts?.(
        principal,
        input as ContentListRequest,
      );
      return page ? sanitized(sanitizePage(page)) : internal();
    }
    case "updateDraft":
      return item(
        await ops.updateDraft?.(
          principal,
          input.id as string,
          input.expectedVersion as number,
          input.changes as ContentDraftChanges,
        ),
      );
    case "setRelationships":
      return item(
        await ops.setRelationships?.(
          principal,
          input.id as string,
          input.expectedVersion as number,
          input.relationships as ContentRelationshipsInput,
        ),
      );
    case "archiveDraft":
      return item(
        await ops.archiveDraft?.(
          principal,
          input.id as string,
          input.expectedVersion as number,
        ),
      );
    case "restoreDraft":
      return item(
        await ops.restoreDraft?.(
          principal,
          input.id as string,
          input.expectedVersion as number,
        ),
      );
    case "listRevisions": {
      const { id, ...rest } = input;
      const page = await ops.listRevisions?.(
        principal,
        id as string,
        rest as ContentRevisionListRequest,
      );
      return page ? sanitized(sanitizeRevisionPage(page)) : internal();
    }
    case "getRevision": {
      const revision = await ops.getRevision?.(
        principal,
        input.id as string,
        input.version as number,
      );
      if (revision === null) return json(404, { error: "not_found" });
      return revision ? sanitized(sanitizeRevision(revision)) : internal();
    }
    case "restoreRevision":
      return item(
        await ops.restoreRevision?.(
          principal,
          input.id as string,
          input.expectedVersion as number,
          input.revisionVersion as number,
        ),
      );
  }
}

function failure(error: unknown): Response {
  if (error instanceof AuthorizationError)
    return json(403, { error: "forbidden" });
  if (error instanceof ContentNotFoundError)
    return json(404, { error: "not_found" });
  if (error instanceof StaleVersionError)
    return json(409, { error: "version_conflict" });
  if (error instanceof ContentStateError)
    return json(409, { error: "invalid_state" });
  if (error instanceof ContentRelationshipError)
    return json(422, { error: "invalid_relationship" });
  if (error instanceof ContentInputError)
    return json(400, { error: "invalid_request" });
  return internal();
}

// ---------------------------------------------------------------- parsing

function parseInput(
  operation: ContentTransportOperation,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  switch (operation) {
    case "createDraft": {
      if (
        !closed(value, [
          "contentType",
          "title",
          "summary",
          "body",
          "relationships",
        ])
      )
        return null;
      if (!CONTENT_TYPES.includes(value.contentType as ContentType))
        return null;
      if (!isString(value.title, MAX_CONTENT_TITLE_LENGTH * 6)) return null;
      if (!optionalText(value, "summary", false)) return null;
      if (!optionalText(value, "body", false)) return null;
      if (
        value.relationships !== undefined &&
        !isRelationshipsInput(value.relationships)
      )
        return null;
      return value;
    }
    case "getDraft":
      return closed(value, ["id"]) && isId(value.id) ? value : null;
    case "listDrafts": {
      if (
        !closed(value, [
          "status",
          "contentType",
          "limit",
          "afterId",
          "sort",
          "search",
          "cursor",
        ])
      )
        return null;
      if (
        value.sort !== undefined &&
        !CONTENT_SORTS.includes(value.sort as ContentSort)
      )
        return null;
      if (
        value.search !== undefined &&
        value.search !== null &&
        !isString(value.search, MAX_CONTENT_SEARCH_LENGTH * 6)
      )
        return null;
      if (
        value.cursor !== undefined &&
        value.cursor !== null &&
        !isString(value.cursor, MAX_CONTENT_CURSOR_LENGTH)
      )
        return null;
      if (
        value.status !== undefined &&
        !CONTENT_STATUSES.includes(value.status as ContentStatus)
      )
        return null;
      if (
        value.contentType !== undefined &&
        !CONTENT_TYPES.includes(value.contentType as ContentType)
      )
        return null;
      if (value.limit !== undefined && !isLimit(value.limit)) return null;
      if (
        value.afterId !== undefined &&
        value.afterId !== null &&
        !isId(value.afterId)
      )
        return null;
      return value;
    }
    case "updateDraft": {
      if (!closed(value, ["id", "expectedVersion", "changes"])) return null;
      if (!isId(value.id) || !isVersion(value.expectedVersion)) return null;
      const changes = value.changes;
      if (
        !isRecord(changes) ||
        !closed(changes, ["title", "summary", "body", "relationships"]) ||
        Object.keys(changes).length === 0
      )
        return null;
      if (
        changes.title !== undefined &&
        !isString(changes.title, MAX_CONTENT_TITLE_LENGTH * 6)
      )
        return null;
      if (!optionalText(changes, "summary", true)) return null;
      if (
        changes.body !== undefined &&
        !isString(changes.body, MAX_CONTENT_BODY_BYTES)
      )
        return null;
      if (
        changes.relationships !== undefined &&
        !isRelationshipsInput(changes.relationships)
      )
        return null;
      return value;
    }
    case "setRelationships":
      return closed(value, ["id", "expectedVersion", "relationships"]) &&
        isId(value.id) &&
        isVersion(value.expectedVersion) &&
        isRelationshipsInput(value.relationships)
        ? value
        : null;
    case "archiveDraft":
    case "restoreDraft":
      return closed(value, ["id", "expectedVersion"]) &&
        isId(value.id) &&
        isVersion(value.expectedVersion)
        ? value
        : null;
    case "listRevisions":
      return closed(value, ["id", "limit", "beforeVersion"]) &&
        isId(value.id) &&
        (value.limit === undefined || isLimit(value.limit)) &&
        (value.beforeVersion === undefined ||
          value.beforeVersion === null ||
          isVersion(value.beforeVersion))
        ? value
        : null;
    case "getRevision":
      return closed(value, ["id", "version"]) &&
        isId(value.id) &&
        isVersion(value.version)
        ? value
        : null;
    case "restoreRevision":
      return closed(value, ["id", "expectedVersion", "revisionVersion"]) &&
        isId(value.id) &&
        isVersion(value.expectedVersion) &&
        isVersion(value.revisionVersion)
        ? value
        : null;
  }
}

function isRelationshipsInput(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !closed(value, ["countyFips", "personIds", "organizationIds"])
  )
    return false;
  return Object.values(value).every(
    (targets) =>
      Array.isArray(targets) &&
      targets.length <= MAX_CONTENT_RELATIONSHIPS_PER_KIND &&
      targets.every(isId),
  );
}

function optionalText(
  value: Record<string, unknown>,
  key: string,
  nullable: boolean,
): boolean {
  const entry = value[key];
  if (entry === undefined) return true;
  if (entry === null) return nullable;
  return isString(
    entry,
    key === "summary" ? MAX_CONTENT_SUMMARY_LENGTH * 6 : MAX_CONTENT_BODY_BYTES,
  );
}

/** Cheap structural bound. The service applies the exact character and byte limits. */
function isString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isLimit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_CONTENT_PAGE_SIZE
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

async function readJson(request: Request): Promise<
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: 400 | 413;
      readonly error: "invalid_request" | "request_too_large";
    }
> {
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
      if (size > MAX_CONTENT_REQUEST_BYTES) {
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
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
    };
  } catch {
    return { ok: false, status: 400, error: "invalid_request" };
  }
}

// ------------------------------------------------------------- sanitizing

function item(value: ContentItem | null | undefined, status = 200): Response {
  if (value === null) return json(404, { error: "not_found" });
  if (!value) return internal();
  return sanitized(sanitizeItem(value), status);
}

function sanitizeRelationships(value: ContentRelationships) {
  return {
    countyFips: [...value.countyFips],
    personIds: [...value.personIds],
    organizationIds: [...value.organizationIds],
  };
}

function sanitizeSummaryFields(value: ContentItem | ContentRevision) {
  return {
    title: value.title,
    summary: value.summary,
    bodyFormat: value.bodyFormat,
    status: value.status,
  };
}

function sanitizeItem(value: ContentItem): Record<string, unknown> {
  return {
    id: value.id,
    contentType: value.contentType,
    ...sanitizeSummaryFields(value),
    body: value.body,
    version: value.version,
    createdByAccountId: value.createdByAccountId,
    lastEditedByAccountId: value.lastEditedByAccountId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
    relationships: sanitizeRelationships(value.relationships),
  };
}

function sanitizePage(page: ContentPage): Record<string, unknown> {
  return {
    items: page.items.map((entry) => ({
      id: entry.id,
      contentType: entry.contentType,
      title: entry.title,
      summary: entry.summary,
      bodyFormat: entry.bodyFormat,
      status: entry.status,
      version: entry.version,
      createdByAccountId: entry.createdByAccountId,
      lastEditedByAccountId: entry.lastEditedByAccountId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      archivedAt: entry.archivedAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

function sanitizeRevisionFields(value: ContentRevision) {
  return {
    contentId: value.contentId,
    version: value.version,
    changeKind: value.changeKind,
    ...sanitizeSummaryFields(value),
    editedByAccountId: value.editedByAccountId,
    recordedAt: value.recordedAt,
    restoredFromVersion: value.restoredFromVersion,
  };
}

function sanitizeRevision(value: ContentRevision): Record<string, unknown> {
  return {
    ...sanitizeRevisionFields(value),
    body: value.body,
    relationships: sanitizeRelationships(value.relationships),
  };
}

function sanitizeRevisionPage(
  page: ContentRevisionPage,
): Record<string, unknown> {
  return {
    items: page.items.map((entry) =>
      sanitizeRevisionFields(entry as ContentRevision),
    ),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

function sanitized(body: Record<string, unknown>, status = 200): Response {
  return json(status, body);
}

function internal(): Response {
  return json(500, { error: "internal_error" });
}

function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Record<string, string> = {},
): Response {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > MAX_CONTENT_RESPONSE_BYTES) {
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

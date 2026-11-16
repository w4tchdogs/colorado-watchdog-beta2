import type { SyncPlan } from "../contracts/sync.js";
import {
  MAX_SYNC_DIAGNOSTICS,
  MAX_SYNC_DUPLICATE_FLAGS,
  MAX_SYNC_ITEM_BYTES,
  MAX_SYNC_ITEMS_BY_SIZE,
  MAX_SYNC_REQUEST_BYTES,
  SYNC_CONTRACT_VERSION,
  type SyncChangeSetRequest,
  type SyncEntity,
} from "../contracts/sync.js";
import type { TrustedPrincipal } from "../services/security.js";
import type { SyncCommitResult } from "../services/sync-commit.js";
import type {
  SyncBatchLookup,
  SyncBatchReversalResult,
} from "../services/sync-history.js";

export const SYNC_API_PATHS = {
  dryRun: "/internal/sync/changesets/dry-run",
  commit: "/internal/sync/changesets/commit",
  lookup: "/internal/sync/batches/lookup",
  reverse: "/internal/sync/batches/reverse",
} as const;

export type SyncTransportOperation =
  | "dry_run"
  | "commit"
  | "lookup"
  | "reverse";
type MaybePromise<T> = T | Promise<T>;

export interface SyncTransportOperations {
  readonly dryRun?: (
    principal: TrustedPrincipal,
    request: SyncChangeSetRequest,
  ) => MaybePromise<SyncPlan>;
  readonly commit?: (
    principal: TrustedPrincipal,
    idempotencyKey: string,
    request: SyncChangeSetRequest,
  ) => MaybePromise<SyncCommitResult>;
  readonly lookup?: (
    principal: TrustedPrincipal,
    request: { readonly batchId?: string; readonly idempotencyKey?: string },
  ) => MaybePromise<SyncBatchLookup | null>;
  readonly reverse?: (
    principal: TrustedPrincipal,
    batchId: string,
    idempotencyKey: string,
  ) => MaybePromise<SyncBatchReversalResult>;
}

export interface SyncTransportDependencies {
  /** Wire this to the existing M0-C principal resolver; never trust request fields. */
  readonly resolvePrincipal?: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  /** Each operation requires an explicit positive authorization decision. */
  readonly authorize?: (
    principal: TrustedPrincipal,
    operation: SyncTransportOperation,
  ) => MaybePromise<boolean>;
  /** Bind to the existing planner, commit, lookup and reversal service functions. */
  readonly operations?: SyncTransportOperations;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITIES = new Set<SyncEntity>([
  "organizations",
  "organization_county_affiliations",
  "people",
  "positions",
  "role_sources",
  "person_roles",
]);
const CHANGE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  "create_organization:organizations": new Set(
    "name organization_type county_fips parent_organization_id parent_organization_ref parent_relationship".split(
      " ",
    ),
  ),
  "add_county_affiliation:organization_county_affiliations": new Set(
    "county_fips relationship_type organization_id organization_ref".split(" "),
  ),
  "create_person:people": new Set(["display_name"]),
  "create_position:positions": new Set(
    "title organization_id organization_ref".split(" "),
  ),
  "register_source:role_sources": new Set([
    "url",
    "title",
    "publisher_classification",
    "source_type",
  ]),
  "create_person_role:person_roles": new Set(
    "start_date end_date source_checked_at person_id person_ref position_id position_ref source_id source_ref county_fips published_office published_title job_description".split(
      " ",
    ),
  ),
  "update_record:organizations": new Set(
    "name organization_type county_fips parent_organization_id parent_relationship".split(
      " ",
    ),
  ),
  "update_record:people": new Set(["display_name"]),
  "update_record:positions": new Set(["title"]),
  "update_record:role_sources": new Set(["title"]),
  "update_record:person_roles": new Set(
    "start_date end_date source_checked_at source_id".split(" "),
  ),
};
const SAFE_REJECTION = "The changeset was rejected.";
const SAFE_REVERSAL =
  "The batch could not be safely reversed; no changes were applied.";

/** Internal and unregistered: authorization and operation handlers are opt-in. */
export function createSyncApiTransport(
  dependencies: SyncTransportDependencies = {},
): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => handleRequest(request, dependencies) };
}

async function handleRequest(
  request: Request,
  dependencies: SyncTransportDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname);
  if (!route) return json(404, { error: "not_found" });
  if (request.method !== "POST")
    return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  if (url.search) return json(400, { error: "unexpected_query" });
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return json(415, { error: "unsupported_media_type" });

  const needsKey = route === "commit" || route === "reverse";
  const key = needsKey ? request.headers.get("idempotency-key") : null;
  if (needsKey ? !isId(key) : request.headers.has("idempotency-key"))
    return json(400, { error: "invalid_idempotency_key" });

  const body = await readJson(request);
  if (!body.ok) return json(body.status, { error: body.error });
  const input = parseRequest(route, body.value);
  if (!input.ok) return json(400, { error: input.error });

  let principal: TrustedPrincipal | null;
  try {
    principal = (await dependencies.resolvePrincipal?.(request)) ?? null;
  } catch {
    return json(503, { error: "dependency_unavailable" });
  }
  if (!principal) return json(401, { error: "authentication_required" });

  try {
    if ((await dependencies.authorize?.(principal, route)) !== true)
      return json(403, { error: "forbidden" });
  } catch {
    return json(403, { error: "forbidden" });
  }
  if (!hasHandler(dependencies.operations, route))
    return json(503, { error: "operation_unavailable" });

  try {
    if (route === "dry_run" && "request" in input.value) {
      const result = await dependencies.operations?.dryRun?.(
        principal,
        input.value.request,
      );
      const safe = sanitizePlan(result);
      return safe ? json(200, safe) : json(500, { error: "internal_error" });
    }
    if (route === "commit" && "request" in input.value) {
      const result = await dependencies.operations?.commit?.(
        principal,
        key as string,
        input.value.request,
      );
      const safe = sanitizeCommit(result);
      if (!safe) return json(500, { error: "internal_error" });
      const status =
        result?.status === "committed"
          ? 200
          : result?.errors.some((error) =>
                ["commit_conflict", "idempotency_mismatch"].includes(
                  error.code,
                ),
              )
            ? 409
            : 422;
      return json(status, safe);
    }
    if (route === "lookup" && "lookup" in input.value) {
      const result = await dependencies.operations?.lookup?.(
        principal,
        input.value.lookup,
      );
      if (result === null) return json(404, { error: "batch_not_found" });
      const safe = sanitizeLookup(result);
      return safe ? json(200, safe) : json(500, { error: "internal_error" });
    }
    if (route === "reverse" && "batchId" in input.value) {
      const result = await dependencies.operations?.reverse?.(
        principal,
        input.value.batchId,
        key as string,
      );
      const safe = sanitizeReversal(result);
      return safe ? json(200, safe) : json(500, { error: "internal_error" });
    }
    return json(500, { error: "internal_error" });
  } catch {
    return json(500, { error: "internal_error" });
  }
}

function routeFor(path: string): SyncTransportOperation | null {
  if (path === SYNC_API_PATHS.dryRun) return "dry_run";
  if (path === SYNC_API_PATHS.commit) return "commit";
  if (path === SYNC_API_PATHS.lookup) return "lookup";
  if (path === SYNC_API_PATHS.reverse) return "reverse";
  return null;
}

function hasHandler(
  operations: SyncTransportOperations | undefined,
  route: SyncTransportOperation,
): boolean {
  if (route === "dry_run") return typeof operations?.dryRun === "function";
  if (route === "commit") return typeof operations?.commit === "function";
  if (route === "lookup") return typeof operations?.lookup === "function";
  return typeof operations?.reverse === "function";
}

async function readJson(request: Request): Promise<
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: 400 | 413;
      readonly error: "invalid_request" | "request_too_large";
    }
> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length))
      return { ok: false, status: 400, error: "invalid_request" };
    if (Number(length) > MAX_SYNC_REQUEST_BYTES)
      return { ok: false, status: 413, error: "request_too_large" };
  }
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
      if (size > MAX_SYNC_REQUEST_BYTES) {
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

type Parsed =
  | { readonly request: SyncChangeSetRequest }
  | {
      readonly lookup: {
        readonly batchId?: string;
        readonly idempotencyKey?: string;
      };
    }
  | { readonly batchId: string };
type ParseResult =
  | { readonly ok: true; readonly value: Parsed }
  | { readonly ok: false; readonly error: string };

function parseRequest(
  route: SyncTransportOperation,
  value: unknown,
): ParseResult {
  if (!isRecord(value)) return invalidRequest();
  if (value.contractVersion !== SYNC_CONTRACT_VERSION)
    return invalidRequest("unsupported_contract_version");

  if (route === "dry_run" || route === "commit") {
    const intent = route === "dry_run" ? "dry_run" : "commit";
    if (
      !closed(value, [
        "contractVersion",
        "requestId",
        "intent",
        "changes",
        "duplicateFlags",
      ]) ||
      value.intent !== intent ||
      typeof value.requestId !== "string" ||
      !UUID.test(value.requestId) ||
      !Array.isArray(value.changes) ||
      value.changes.length < 1 ||
      !value.changes.every(isValidChange)
    )
      return invalidRequest();
    for (const change of value.changes) {
      if (byteLength(change) > MAX_SYNC_ITEM_BYTES)
        return invalidRequest("item_too_large");
    }
    if (
      value.duplicateFlags !== undefined &&
      (!Array.isArray(value.duplicateFlags) ||
        value.duplicateFlags.length > MAX_SYNC_DUPLICATE_FLAGS ||
        value.duplicateFlags.some(
          (flag) =>
            !isRecord(flag) ||
            !closed(flag, [
              "targetRef",
              "possibleDuplicateOf",
              "category",
              "reason",
              "nonblocking",
              "evidenceSourceRefs",
            ]),
        ))
    )
      return invalidRequest("invalid_request");
    return {
      ok: true,
      value: { request: value as unknown as SyncChangeSetRequest },
    };
  }

  if (route === "lookup") {
    if (!closed(value, ["contractVersion", "batchId", "idempotencyKey"]))
      return invalidRequest();
    const hasBatchId = Object.hasOwn(value, "batchId");
    const hasKey = Object.hasOwn(value, "idempotencyKey");
    if (hasBatchId === hasKey) return invalidRequest();
    if (hasBatchId && !isId(value.batchId)) return invalidRequest();
    if (hasKey && !isId(value.idempotencyKey))
      return invalidRequest("invalid_idempotency_key");
    return {
      ok: true,
      value: {
        lookup: hasBatchId
          ? { batchId: value.batchId as string }
          : { idempotencyKey: value.idempotencyKey as string },
      },
    };
  }
  if (!closed(value, ["contractVersion", "batchId"]) || !isId(value.batchId))
    return invalidRequest();
  return { ok: true, value: { batchId: value.batchId } };
}

function isValidChange(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.op !== "string" ||
    typeof value.entity !== "string" ||
    !ENTITIES.has(value.entity as SyncEntity) ||
    !isRecord(value.fields)
  )
    return false;
  const fields = CHANGE_FIELDS[`${value.op}:${value.entity}`];
  if (!fields || Object.keys(value.fields).some((key) => !fields.has(key)))
    return false;
  if (value.op === "update_record")
    return (
      closed(value, [
        "op",
        "entity",
        "targetId",
        "expectedVersion",
        "fields",
      ]) &&
      isId(value.targetId) &&
      Number.isSafeInteger(value.expectedVersion) &&
      (value.expectedVersion as number) >= 1
    );
  return (
    closed(value, ["op", "entity", "clientRef", "fields"]) &&
    isId(value.clientRef)
  );
}

function sanitizePlan(
  value: SyncPlan | undefined,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    value.contractVersion !== SYNC_CONTRACT_VERSION ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_SYNC_ITEMS_BY_SIZE ||
    !Array.isArray(value.errors) ||
    value.errors.length > MAX_SYNC_DIAGNOSTICS ||
    !Array.isArray(value.duplicateFlags) ||
    value.duplicateFlags.length > MAX_SYNC_DUPLICATE_FLAGS
  )
    return null;
  return {
    contractVersion: value.contractVersion,
    requestId: value.requestId,
    eligible: value.eligible,
    items: value.items.map((item) => ({
      itemIndex: item.itemIndex,
      entity: item.entity,
      action: item.action,
      ...(item.clientRef === undefined ? {} : { clientRef: item.clientRef }),
      ...(item.websiteId === undefined ? {} : { websiteId: item.websiteId }),
      ...(item.targetId === undefined ? {} : { targetId: item.targetId }),
      ...(item.expectedVersion === undefined
        ? {}
        : { expectedVersion: item.expectedVersion }),
      dependencies: item.dependencies,
    })),
    errors: value.errors.map(sanitizeError),
    duplicateFlags: value.duplicateFlags.map((flag) => ({
      targetRef: flag.targetRef,
      possibleDuplicateOf: flag.possibleDuplicateOf,
      ...(flag.evidenceSourceRefs === undefined
        ? {}
        : { evidenceSourceRefs: flag.evidenceSourceRefs }),
    })),
  };
}

function sanitizeCommit(
  value: SyncCommitResult | undefined,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.errors)
  )
    return null;
  if (value.status === "committed") {
    if (value.items.length > MAX_SYNC_ITEMS_BY_SIZE || value.errors.length)
      return null;
    return {
      status: value.status,
      batchId: value.batchId,
      requestId: value.requestId,
      committedAt: value.committedAt,
      replayed: value.replayed,
      items: value.items.map((item) => ({
        itemIndex: item.itemIndex,
        ...(item.clientRef === undefined ? {} : { clientRef: item.clientRef }),
        entity: item.entity,
        websiteId: item.websiteId,
        version: item.version,
        outcome: item.outcome,
      })),
      errors: [],
    };
  }
  if (
    value.status !== "rejected" ||
    value.items.length ||
    !value.errors.length ||
    value.errors.length > MAX_SYNC_DIAGNOSTICS
  )
    return null;
  return {
    status: value.status,
    requestId: value.requestId,
    replayed: false,
    items: [],
    errors: value.errors.map(sanitizeError),
  };
}

function sanitizeLookup(
  value: SyncBatchLookup | null | undefined,
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_SYNC_ITEMS_BY_SIZE
  )
    return null;
  return {
    status: value.status,
    batchId: value.batchId,
    committedAt: value.committedAt,
    reversedAt: value.reversedAt,
    items: value.items.map((item) => ({
      itemIndex: item.itemIndex,
      clientRef: item.clientRef,
      entity: item.entity,
      websiteId: item.websiteId,
      outcome: item.outcome,
      version: item.version,
    })),
  };
}

function sanitizeReversal(
  value: SyncBatchReversalResult | undefined,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.status === "reverted")
    return {
      status: value.status,
      batchId: value.batchId,
      reversalId: value.reversalId,
      reversedAt: value.reversedAt,
      replayed: value.replayed,
    };
  if (value.status === "already_reverted")
    return {
      status: value.status,
      batchId: value.batchId,
      reversedAt: value.reversedAt,
      replayed: false,
    };
  if (value.status === "reversal_blocked")
    return {
      status: value.status,
      batchId: value.batchId,
      replayed: false,
      message: SAFE_REVERSAL,
    };
  return null;
}

function sanitizeError(error: {
  readonly code: string;
  readonly itemIndex?: number;
  readonly clientRef?: string;
  readonly currentVersion?: number;
}): Record<string, unknown> {
  return {
    code: error.code,
    ...(error.itemIndex === undefined ? {} : { itemIndex: error.itemIndex }),
    ...(error.clientRef === undefined ? {} : { clientRef: error.clientRef }),
    ...(error.currentVersion === undefined
      ? {}
      : { currentVersion: error.currentVersion }),
    message: SAFE_REJECTION,
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
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
function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_SYNC_ITEM_BYTES + 1;
  }
}
function invalidRequest(error = "invalid_request"): ParseResult {
  return { ok: false, error };
}
function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Record<string, string> = {},
): Response {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > MAX_SYNC_REQUEST_BYTES) {
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

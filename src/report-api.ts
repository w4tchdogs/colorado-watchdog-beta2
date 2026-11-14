import type {
  IntakeCommit,
  ReportIntakeStore,
  ReportStatus,
  ReportSubmission,
} from "./contracts/report-intake.js";
import { ReportIntakeError } from "./contracts/report-intake.js";
import type { ApplicationServices } from "./services/index.js";
import {
  getAllowedReportTransitions,
  getReportForStaff,
  submitReport,
  trackReport,
  transitionReport,
} from "./services/report-intake.js";
import type { TrustedPrincipal } from "./services/security.js";

const BASE = "/api/v1/reports";
const BODY_LIMIT = 32 * 1024;
const STATUSES: ReportStatus[] = [
  "submitted",
  "triage",
  "under-review",
  "needs-information",
  "accepted",
  "declined",
  "closed",
];

export interface ReportApiOptions {
  readonly services: Pick<
    ApplicationServices,
    "resolvePrincipal" | "hasCapability"
  > & {
    readonly listCounties: () =>
      | ReturnType<ApplicationServices["listCounties"]>
      | Promise<ReturnType<ApplicationServices["listCounties"]>>;
  };
  readonly store: ReportIntakeStore;
  /** Builds a request-bound store so its D1 authorization can re-resolve identity. */
  readonly storeForRequest?: (request: Request) => ReportIntakeStore;
  /** Production must provide a shared, durable abuse-control implementation. */
  readonly guestSubmissions?: {
    readonly enabled: boolean;
    readonly abuseControl?: {
      check(
        request: Request,
      ): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
    };
  };
}

/** Independently mountable Fetch API. Mount this handler at /api/v1/reports; no Site runtime is required. */
export function createReportApiModule(options: ReportApiOptions) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      const store = options.storeForRequest?.(request) ?? options.store;
      try {
        if (path === `${BASE}/track` && request.method === "POST")
          return await tracking(request, store);
        if (path === BASE && request.method === "POST")
          return await submission(request, options, store);
        if (path === BASE && request.method === "GET")
          return await listing(request, options, store);
        const match = new RegExp(
          `^${BASE}/([^/]+)(?:/(status|history))?$`,
        ).exec(path);
        if (!match) return json(404, { error: "not_found" });
        const action = match[2];
        if (
          (action === "status" && request.method !== "PATCH") ||
          (action !== "status" && request.method !== "GET")
        )
          return methodNotAllowed();
        const principal = await options.services.resolvePrincipal(request);
        if (!principal) return json(401, { error: "authentication_required" });
        if (!(await options.services.hasCapability(principal, "report.review")))
          return json(403, { error: "forbidden" });
        const actor = staffActor(principal);
        const reportId = decodeURIComponent(match[1] ?? "");
        if (action === "status" && request.method === "PATCH") {
          if (!sameOrigin(request))
            return json(403, { error: "origin_rejected" });
          const value = await readBody(request);
          if (
            !object(value) ||
            !keysAre(value, ["expectedVersion", "status", "note"]) ||
            !Number.isSafeInteger(value.expectedVersion) ||
            typeof value.status !== "string" ||
            !STATUSES.includes(value.status as ReportStatus) ||
            (value.note !== undefined && typeof value.note !== "string")
          )
            return json(400, { error: "invalid_request" });
          await transitionReport(
            store,
            reportId,
            value.expectedVersion as number,
            value.status as ReportStatus,
            actor,
            value.note as string | undefined,
          );
          return json(200, { ok: true });
        }
        const commit = await getReportForStaff(store, reportId, actor);
        if (!commit) return json(404, { error: "not_found" });
        if (action === "history") return json(200, { history: commit.history });
        const counties = await options.services.listCounties();
        return json(200, {
          report: commit.report,
          countyName:
            counties.find((county) => county.fips === commit.report.countyId)
              ?.name ?? commit.report.countyId,
          allowedNextStatuses: getAllowedReportTransitions(
            commit.report.status,
          ),
        });
      } catch (error) {
        return reportError(error);
      }
    },
  };
}

async function submission(
  request: Request,
  options: ReportApiOptions,
  store: ReportIntakeStore,
): Promise<Response> {
  if (!sameOrigin(request)) return json(403, { error: "origin_rejected" });
  if (!isJson(request)) return json(415, { error: "unsupported_media_type" });
  const config = options.guestSubmissions;
  if (!config?.enabled || !config.abuseControl)
    return json(503, { error: "submission_unavailable" });
  const abuse = await config.abuseControl.check(request);
  if (!abuse.allowed) {
    const retry = Math.max(1, Math.min(3600, abuse.retryAfterSeconds ?? 60));
    return json(
      429,
      { error: "rate_limited" },
      { "retry-after": String(retry) },
    );
  }
  const value = await readBody(request);
  if (!isSubmission(value)) return json(400, { error: "invalid_request" });
  const principal = await options.services.resolvePrincipal(request);
  const result = await submitReport(
    store,
    value,
    principal
      ? { kind: "reporter", accountId: principal.accountId }
      : { kind: "reporter" },
  );
  return json(result.replayed ? 200 : 201, {
    reference: result.receipt.reference,
    ...(result.receipt.recoveryKey
      ? { recoveryKey: result.receipt.recoveryKey }
      : {}),
    replayed: result.replayed,
  });
}

async function tracking(
  request: Request,
  store: ReportIntakeStore,
): Promise<Response> {
  if (!sameOrigin(request)) return json(403, { error: "origin_rejected" });
  if (!isJson(request)) return json(415, { error: "unsupported_media_type" });
  const value = await readBody(request);
  if (
    !object(value) ||
    !keysAre(value, ["reference", "recoveryKey"]) ||
    typeof value.reference !== "string" ||
    typeof value.recoveryKey !== "string"
  )
    return json(400, { error: "invalid_request" });
  return json(
    200,
    await trackReport(store, value.reference, value.recoveryKey),
  );
}

async function listing(
  request: Request,
  options: ReportApiOptions,
  store: ReportIntakeStore,
): Promise<Response> {
  const principal = await options.services.resolvePrincipal(request);
  if (!principal) return json(401, { error: "authentication_required" });
  if (!(await options.services.hasCapability(principal, "report.review")))
    return json(403, { error: "forbidden" });
  const url = new URL(request.url);
  const allowed = new Set(["limit", "after", "status"]);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    [...url.searchParams.keys()].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    )
  )
    return json(400, { error: "invalid_request" });
  const limitText = url.searchParams.get("limit") ?? "25";
  const limit = Number(limitText);
  const status = url.searchParams.get("status");
  const after = url.searchParams.get("after") ?? undefined;
  if (
    !/^\d+$/.test(limitText) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (status !== null && !STATUSES.includes(status as ReportStatus)) ||
    (after !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(after))
  )
    return json(400, { error: "invalid_request" });
  const result = await store.listPrivate(
    { limit, after, status: status as ReportStatus | undefined },
    staffActor(principal),
  );
  const counties = await options.services.listCounties();
  return json(200, {
    ...result,
    reports: result.reports.map((report) => ({
      ...report,
      countyName:
        counties.find((county) => county.fips === report.countyId)?.name ??
        report.countyId,
    })),
  });
}

function staffActor(principal: TrustedPrincipal) {
  if (
    principal.role !== "editor" &&
    principal.role !== "administrator" &&
    principal.role !== "owner"
  )
    throw new ReportIntakeError("FORBIDDEN");
  return {
    kind: "staff" as const,
    accountId: principal.accountId,
    role: principal.role,
  };
}

function isSubmission(value: unknown): value is ReportSubmission {
  if (
    !object(value) ||
    !keysAre(value, [
      "countyId",
      "subject",
      "description",
      "evidence",
      "reporter",
      "idempotencyKey",
    ]) ||
    !object(value.reporter) ||
    !keysAre(value.reporter, [
      "name",
      "email",
      "attribution",
      "confidential",
      "contactPreference",
    ]) ||
    (value.subject !== undefined &&
      (!object(value.subject) || !keysAre(value.subject, ["kind", "id"]))) ||
    !Array.isArray(value.evidence) ||
    value.evidence.some(
      (item) => !object(item) || !keysAre(item, ["title", "url", "note"]),
    )
  )
    return false;
  return true;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keysAre(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}
function isJson(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
    "application/json"
  );
}
async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))
    throw new BodyLimitError();
  if (!isJson(request)) throw new TypeError("unsupported_media_type");
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      throw new BodyLimitError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new SyntaxError();
  }
}
function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
function methodNotAllowed(): Response {
  return json(405, { error: "method_not_allowed" });
}
function reportError(error: unknown): Response {
  if (error instanceof BodyLimitError)
    return json(413, { error: "request_too_large" });
  if (error instanceof TypeError && error.message === "unsupported_media_type")
    return json(415, { error: "unsupported_media_type" });
  if (error instanceof SyntaxError)
    return json(400, { error: "invalid_request" });
  if (error instanceof ReportIntakeError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "CONFLICT"
            ? 409
            : error.code === "INVALID_TRANSITION"
              ? 409
              : 400;
    return json(status, { error: error.code.toLowerCase() });
  }
  return json(503, { error: "service_unavailable" });
}
class BodyLimitError extends Error {}

export type { IntakeCommit };

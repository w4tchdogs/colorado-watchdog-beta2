import type {
  DashboardSession,
  DashboardView,
} from "../contracts/dashboard.js";
import { DASHBOARD_API_PATHS } from "../contracts/dashboard.js";
import { DashboardViewNotFoundError } from "../services/dashboard.js";
import {
  AuthorizationError,
  type TrustedPrincipal,
} from "../services/security.js";

/**
 * Dashboard transport. The local sandbox mounts it over the synchronous
 * service. The hosted Worker mounts it over the asynchronous D1 service, only
 * while Website human sign-in is enabled. Authentication and the service are
 * opt-in and each absent piece denies. The principal always comes from the
 * host's resolver. No request field names an account, a role or a capability.
 */
export interface DashboardTransportService {
  session(
    principal: TrustedPrincipal,
  ): DashboardSession | Promise<DashboardSession>;
  view(
    principal: TrustedPrincipal,
    id: string,
  ): DashboardView | Promise<DashboardView>;
}

export interface DashboardTransportDependencies {
  readonly resolvePrincipal?: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  readonly service?: DashboardTransportService;
}

const MAX_REQUEST_BYTES = 512;
const VIEW_ID = /^[a-z](?:[a-z]|-(?=[a-z])){0,31}$/;

export function createDashboardApiTransport(
  dependencies: DashboardTransportDependencies = {},
): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => handle(request, dependencies) };
}

async function handle(
  request: Request,
  dependencies: DashboardTransportDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const isSession = url.pathname === DASHBOARD_API_PATHS.session;
  const isView = url.pathname === DASHBOARD_API_PATHS.view;
  if (!isSession && !isView) return json(404, { error: "not_found" });
  const method = isSession ? "GET" : "POST";
  if (request.method !== method)
    return json(405, { error: "method_not_allowed" }, { allow: method });
  if (url.search) return json(400, { error: "unexpected_query" });

  // Deny before reading the body.
  let principal: TrustedPrincipal | null;
  try {
    principal = (await dependencies.resolvePrincipal?.(request)) ?? null;
  } catch {
    return json(503, { error: "dependency_unavailable" });
  }
  if (!principal) return json(401, { error: "authentication_required" });
  const service = dependencies.service;
  if (!service) return json(503, { error: "operation_unavailable" });

  try {
    if (isSession) return json(200, { ...(await service.session(principal)) });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return json(415, { error: "unsupported_media_type" });
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES)
      return json(413, { error: "request_too_large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { view?: unknown }).view !== "string" ||
      !VIEW_ID.test((body as { view: string }).view)
    )
      return json(400, { error: "invalid_request" });
    return json(200, {
      ...(await service.view(principal, (body as { view: string }).view)),
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return json(403, { error: "forbidden" });
    if (error instanceof DashboardViewNotFoundError)
      return json(404, { error: "not_found" });
    return json(500, { error: "internal_error" });
  }
}

function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

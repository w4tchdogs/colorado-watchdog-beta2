import type {
  DashboardSession,
  DashboardView,
} from "../contracts/dashboard.js";
import {
  EditorApiError,
  type EditorErrorCode,
  type FetchLike,
  SANDBOX_ACCOUNT_HEADER,
  SANDBOX_TOKEN_HEADER,
} from "./api-client.js";

/**
 * Browser-side client for the dashboard API. It only builds requests. The
 * server decides who the caller is and what they may open, and a response is
 * never treated as permission.
 */
export const DASHBOARD_API_PATHS = {
  session: "/internal/dashboard/session",
  view: "/internal/dashboard/views/get",
} as const;

export interface DashboardClient {
  session(): Promise<DashboardSession>;
  view(id: string): Promise<DashboardView>;
}

export interface DashboardClientOptions {
  readonly fetch: FetchLike;
  /** Sandbox only: the per-launch token the local server embeds in the page. */
  readonly token: string;
  /** Sandbox only: which synthetic account the request speaks for. */
  readonly account: () => string;
}

const KNOWN_CODES = new Set<string>([
  "authentication_required",
  "forbidden",
  "not_found",
  "invalid_request",
  "operation_unavailable",
  "dependency_unavailable",
  "internal_error",
]);

export function createDashboardClient(
  options: DashboardClientOptions,
): DashboardClient {
  async function send<T>(
    path: string,
    method: "GET" | "POST",
    payload?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await options.fetch(path, {
        method,
        headers: {
          [SANDBOX_TOKEN_HEADER]: options.token,
          [SANDBOX_ACCOUNT_HEADER]: options.account(),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw new EditorApiError(0, "network_error");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const code =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : "internal_error";
      throw new EditorApiError(
        response.status,
        (KNOWN_CODES.has(code) ? code : "internal_error") as EditorErrorCode,
      );
    }
    if (typeof body !== "object" || body === null) {
      throw new EditorApiError(response.status, "internal_error");
    }
    return body as T;
  }

  return {
    session: () => send<DashboardSession>(DASHBOARD_API_PATHS.session, "GET"),
    view: (id) =>
      send<DashboardView>(DASHBOARD_API_PATHS.view, "POST", { view: id }),
  };
}

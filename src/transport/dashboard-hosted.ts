import { DASHBOARD_API_PATHS } from "../contracts/dashboard.js";
import type { TrustedPrincipal } from "../services/security.js";
import type { DashboardTransportService } from "./dashboard-api.js";
import { createDashboardApiTransport } from "./dashboard-api.js";

/**
 * Hosted dashboard routes (Alpha-1).
 *
 * `GET /dashboard` serves the dashboard shell and the two JSON routes serve its
 * data. The Worker mounts all three only while Website human sign-in is
 * enabled. The shell page itself holds no account data, but it is still served
 * only to a current human session so that a signed-out visitor, a disabled or
 * revoked account and an agent credential never receive the application.
 * Every data request is authorized again by the service on its own.
 */
export const DASHBOARD_PAGE_PATH = "/dashboard";
export const DASHBOARD_LOGIN_PATH = "/auth/login?return_to=%2Fdashboard";

export function isDashboardPath(pathname: string): boolean {
  return (
    pathname === DASHBOARD_PAGE_PATH ||
    pathname === DASHBOARD_API_PATHS.session ||
    pathname === DASHBOARD_API_PATHS.view
  );
}

export interface HostedDashboardDependencies {
  readonly resolvePrincipal: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  readonly service: DashboardTransportService;
}

const PAGE_HEADERS = {
  "cache-control": "no-store, private",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // Same-origin, so the sign-out form post carries the exact page origin.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
} as const;

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Colorado Watchdog dashboard</title>
<link rel="icon" href="/assets/favicon-light.png" type="image/png">
<link rel="stylesheet" href="/assets/dashboard-app.css">
</head>
<body>
<div id="app"><noscript>The dashboard needs JavaScript.</noscript></div>
<script type="module" src="/assets/dashboard-app.js"></script>
</body>
</html>
`;

export function dashboardUnavailable(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(status: number, message: string, extra = {}): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store, private",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export async function handleDashboardRequest(
  request: Request,
  dependencies: HostedDashboardDependencies,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== DASHBOARD_PAGE_PATH) {
    return createDashboardApiTransport({
      resolvePrincipal: dependencies.resolvePrincipal,
      service: dependencies.service,
    }).fetch(request);
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return text(405, "Method not allowed.", { allow: "GET, HEAD" });
  if (new URL(request.url).search !== "") return dashboardUnavailable();

  let principal: TrustedPrincipal | null;
  try {
    principal = await dependencies.resolvePrincipal(request);
  } catch {
    return text(503, "The dashboard is unavailable.");
  }
  if (!principal) {
    // An agent credential never falls back to a browser sign-in.
    if (request.headers.get("authorization") !== null)
      return text(401, "Authentication required.");
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: DASHBOARD_LOGIN_PATH,
      },
    });
  }
  try {
    // Throws for an agent, a disabled account or a revoked or expired link.
    await dependencies.service.session(principal);
  } catch {
    return text(403, "This account cannot open the dashboard.");
  }
  return new Response(request.method === "HEAD" ? null : SHELL, {
    status: 200,
    headers: PAGE_HEADERS,
  });
}

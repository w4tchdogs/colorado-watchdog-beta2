import {
  type DirectoryPageRequest,
  MAX_DIRECTORY_PAGE_SIZE,
} from "./contracts/directory.js";
import { StorageUnavailableError } from "./contracts/storage.js";
import { InvalidInputError } from "./services/accounts.js";
import type { ApplicationServices } from "./services/index.js";
import { AuthorizationError } from "./services/security.js";

const HEALTH_PATH = "/_internal/health";
const LIVE_PATH = "/_internal/live";
const READY_PATH = "/_internal/ready";
const PRINCIPAL_PATH = "/_internal/principal";
const ACCOUNTS_PATH = "/api/accounts";
const COUNTY_DIRECTORY_PATH =
  /^\/api\/counties\/([^/]+)\/(organizations|roles)$/;

export function createApplication(services: ApplicationServices) {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await dispatch(request, services);
      } catch {
        return jsonResponse(500, { error: "internal_error" });
      }
    },
  };
}

async function dispatch(
  request: Request,
  services: ApplicationServices,
): Promise<Response> {
  const url = new URL(request.url);
  let pathname: string;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    if (error instanceof URIError) {
      return jsonResponse(400, { error: "malformed_path" });
    }
    throw error;
  }

  const directoryMatch = pathname.match(COUNTY_DIRECTORY_PATH);
  const directoryCountyFips = directoryMatch?.[1];
  const directoryResource = directoryMatch?.[2];
  if (
    ![
      HEALTH_PATH,
      LIVE_PATH,
      READY_PATH,
      PRINCIPAL_PATH,
      ACCOUNTS_PATH,
    ].includes(pathname) &&
    !directoryMatch
  ) {
    return jsonResponse(404, { error: "not_found" });
  }

  const expectedMethod = pathname === ACCOUNTS_PATH ? "POST" : "GET";
  if (request.method !== expectedMethod) {
    return jsonResponse(
      405,
      { error: "method_not_allowed" },
      { allow: expectedMethod },
    );
  }

  if (!directoryMatch && url.search !== "") {
    return jsonResponse(400, { error: "unexpected_query" });
  }

  const directoryRequest = directoryMatch
    ? parseDirectoryPageRequest(url.searchParams, directoryCountyFips)
    : null;
  if (directoryMatch && !directoryRequest) {
    const supportedParameters = new Set(["limit", "afterId"]);
    const hasUnsupportedParameter = [...url.searchParams.keys()].some(
      (key) => !supportedParameters.has(key),
    );
    return jsonResponse(400, {
      error: hasUnsupportedParameter ? "unexpected_query" : "invalid_request",
    });
  }

  if (pathname === LIVE_PATH) {
    return jsonResponse(200, services.liveness());
  }

  try {
    if (pathname === READY_PATH) {
      return jsonResponse(200, await services.readiness());
    }
    if (pathname === HEALTH_PATH) {
      return jsonResponse(200, await services.health());
    }
    if (pathname === PRINCIPAL_PATH) {
      const principal = await services.resolvePrincipal(request);
      if (!principal) {
        return jsonResponse(401, { error: "authentication_required" });
      }
      return jsonResponse(200, {
        accountId: principal.accountId,
        kind: principal.kind,
        role: principal.role,
      });
    }
    if (directoryResource && directoryRequest) {
      const page =
        directoryResource === "organizations"
          ? services.listCountyOrganizations(directoryRequest)
          : services.listCountyRoleEntries(directoryRequest);
      return jsonResponse(200, { ...page });
    }

    return await createAccount(request, services);
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      return jsonResponse(503, { error: "dependency_unavailable" });
    }
    if (error instanceof AuthorizationError) {
      return jsonResponse(403, { error: "forbidden" });
    }
    if (error instanceof InvalidInputError) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    return jsonResponse(500, { error: "internal_error" });
  }
}

function parseDirectoryPageRequest(
  searchParams: URLSearchParams,
  countyFips: string | undefined,
): DirectoryPageRequest | null {
  if (typeof countyFips !== "string" || !/^08\d{3}$/.test(countyFips)) {
    return null;
  }

  const allowedParameters = new Set(["limit", "afterId"]);
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => !allowedParameters.has(key)) ||
    keys.some((key) => searchParams.getAll(key).length !== 1)
  ) {
    return null;
  }

  const limitValue = searchParams.get("limit");
  let limit: number | undefined;
  if (limitValue !== null) {
    if (!/^\d+$/.test(limitValue)) {
      return null;
    }
    limit = Number(limitValue);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE
    ) {
      return null;
    }
  }

  const afterId = searchParams.get("afterId");
  if (
    afterId !== null &&
    (afterId.length < 1 ||
      afterId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(afterId))
  ) {
    return null;
  }

  return {
    countyFips,
    ...(limit === undefined ? {} : { limit }),
    ...(afterId === null ? {} : { afterId }),
  };
}

async function createAccount(
  request: Request,
  services: ApplicationServices,
): Promise<Response> {
  const principal = await services.resolvePrincipal(request);
  if (!principal) {
    return jsonResponse(401, { error: "authentication_required" });
  }
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return jsonResponse(415, { error: "unsupported_media_type" });
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_request" });
  }
  if (!isNewAccount(value)) {
    return jsonResponse(400, { error: "invalid_request" });
  }
  return jsonResponse(201, { ...services.createAccount(principal, value) });
}

function isNewAccount(value: unknown): value is {
  kind: "human" | "agent";
  role: "contributor" | "editor" | "administrator" | "owner";
  displayName: string;
  email?: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const account = value as Record<string, unknown>;
  const allowedFields = new Set(["kind", "role", "displayName", "email"]);
  return (
    Object.keys(account).every((field) => allowedFields.has(field)) &&
    (account.kind === "human" || account.kind === "agent") &&
    (account.role === "contributor" ||
      account.role === "editor" ||
      account.role === "administrator" ||
      account.role === "owner") &&
    typeof account.displayName === "string" &&
    (account.email === undefined ||
      account.email === null ||
      typeof account.email === "string")
  );
}

function jsonResponse(
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

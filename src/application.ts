import { createAccountAdminModule } from "./account-admin.js";
import {
  type DirectoryPage,
  type DirectoryPageRequest,
  MAX_DIRECTORY_PAGE_SIZE,
} from "./contracts/directory.js";
import type { DirectorySearchRequest } from "./contracts/directory-search.js";
import type {
  OrganizationProfilePageRequest,
  OrganizationRolePageRequest,
} from "./contracts/organization-profile.js";
import type { PersonProfilePageRequest } from "./contracts/person-profile.js";
import { StorageUnavailableError } from "./contracts/storage.js";
import { InvalidInputError } from "./services/accounts.js";
import { CountyOverviewInputError } from "./services/county-overview.js";
import { DirectorySearchInputError } from "./services/directory-search.js";
import type { ApplicationServices } from "./services/index.js";
import { OrganizationProfileInputError } from "./services/organization-profile.js";
import { PersonProfileInputError } from "./services/person-profile.js";
import { AuthorizationError } from "./services/security.js";

const HEALTH_PATH = "/_internal/health";
const LIVE_PATH = "/_internal/live";
const READY_PATH = "/_internal/ready";
const PRINCIPAL_PATH = "/_internal/principal";
const ACCOUNTS_PATH = "/api/accounts";
const SELF_ACCOUNT_PATH = "/api/me";
const PEOPLE_COLLECTION_PATH = "/api/people";
const ORGANIZATIONS_COLLECTION_PATH = "/api/organizations";
const COUNTY_OVERVIEW_PATH = /^\/api\/counties\/([^/]+)$/;
const COUNTY_DIRECTORY_PATH =
  /^\/api\/counties\/([^/]+)\/(organizations|roles)$/;
const PEOPLE_PROFILE_PATH = /^\/api\/people\/(.*)$/;
const ORGANIZATION_PROFILE_PATH = /^\/api\/organizations(?:\/([^/]*))?$/;
const ORGANIZATION_ROLES_PATH = /^\/api\/organizations\/([^/]+)\/roles$/;

export function createApplication(
  services: ApplicationServices,
  options: { readonly humanSignIn?: boolean } = {},
) {
  const accountAdmin = createAccountAdminModule(services, options);
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        if (
          new URL(request.url).pathname.startsWith("/admin/accounts") ||
          new URL(request.url).pathname.startsWith("/api/admin/accounts")
        )
          return await accountAdmin.fetch(request);
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

  const countyOverviewMatch = pathname.match(COUNTY_OVERVIEW_PATH);
  const directoryMatch = pathname.match(COUNTY_DIRECTORY_PATH);
  const peopleCollection = pathname === PEOPLE_COLLECTION_PATH;
  const organizationsCollection = pathname === ORGANIZATIONS_COLLECTION_PATH;
  const personProfileMatch = peopleCollection
    ? null
    : pathname.match(PEOPLE_PROFILE_PATH);
  const organizationProfileMatch = organizationsCollection
    ? null
    : pathname.match(ORGANIZATION_PROFILE_PATH);
  const organizationRolesMatch = pathname.match(ORGANIZATION_ROLES_PATH);
  const directoryCountyFips = directoryMatch?.[1];
  const directoryResource = directoryMatch?.[2];
  if (
    ![
      HEALTH_PATH,
      LIVE_PATH,
      READY_PATH,
      PRINCIPAL_PATH,
      ACCOUNTS_PATH,
      SELF_ACCOUNT_PATH,
    ].includes(pathname) &&
    !peopleCollection &&
    !organizationsCollection &&
    !countyOverviewMatch &&
    !directoryMatch &&
    !personProfileMatch &&
    !organizationProfileMatch &&
    !organizationRolesMatch
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

  if (countyOverviewMatch && url.search !== "") {
    return jsonResponse(400, { error: "unexpected_query" });
  }
  const countyOverviewRequest = countyOverviewMatch
    ? parseCountyOverviewRequest(countyOverviewMatch[1])
    : null;
  if (countyOverviewMatch && !countyOverviewRequest) {
    return jsonResponse(400, { error: "invalid_request" });
  }

  if (
    !directoryMatch &&
    !personProfileMatch &&
    !organizationProfileMatch &&
    !organizationRolesMatch &&
    !peopleCollection &&
    !organizationsCollection &&
    !countyOverviewMatch &&
    url.search !== ""
  ) {
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
  const peopleSearchRequest = peopleCollection
    ? parseDirectorySearchRequest(url.searchParams)
    : null;
  if (peopleCollection && !peopleSearchRequest) {
    return invalidDirectorySearchRequest(url.searchParams);
  }
  const organizationsSearchRequest = organizationsCollection
    ? parseDirectorySearchRequest(url.searchParams)
    : null;
  if (organizationsCollection && !organizationsSearchRequest) {
    return invalidDirectorySearchRequest(url.searchParams);
  }
  const personProfileRequest = personProfileMatch
    ? parsePersonProfileRequest(personProfileMatch[1], url.searchParams)
    : null;
  if (personProfileMatch && !personProfileRequest) {
    const supportedParameters = new Set(["limit", "afterRoleId"]);
    const hasUnsupportedParameter = [...url.searchParams.keys()].some(
      (key) => !supportedParameters.has(key),
    );
    return jsonResponse(400, {
      error: hasUnsupportedParameter ? "unexpected_query" : "invalid_request",
    });
  }
  const organizationProfileRequest = organizationProfileMatch
    ? parseOrganizationProfileRequest(
        organizationProfileMatch[1],
        url.searchParams,
      )
    : null;
  if (organizationProfileMatch && !organizationProfileRequest) {
    const supportedParameters = new Set(["limit", "afterPositionId"]);
    const hasUnsupportedParameter = [...url.searchParams.keys()].some(
      (key) => !supportedParameters.has(key),
    );
    return jsonResponse(400, {
      error: hasUnsupportedParameter ? "unexpected_query" : "invalid_request",
    });
  }
  const organizationRoleRequest = organizationRolesMatch
    ? parseOrganizationRoleRequest(organizationRolesMatch[1], url.searchParams)
    : null;
  if (organizationRolesMatch && !organizationRoleRequest) {
    const supportedParameters = new Set(["limit", "afterRoleId"]);
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
    if (countyOverviewRequest) {
      const overview = await services.getCountyOverview(countyOverviewRequest);
      return overview
        ? jsonResponse(200, { ...overview })
        : jsonResponse(404, { error: "not_found" });
    }
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
    if (pathname === SELF_ACCOUNT_PATH) {
      const principal = await services.resolvePrincipal(request);
      if (!principal)
        return jsonResponse(401, { error: "authentication_required" });
      return jsonResponse(200, {
        ...(await services.getOwnAccount(principal)),
      });
    }
    if (directoryResource && directoryRequest) {
      const page =
        directoryResource === "organizations"
          ? await services.listCountyOrganizations(directoryRequest)
          : publicRolePage(
              await services.listCountyRoleEntries(directoryRequest),
            );
      return jsonResponse(200, { ...page });
    }
    if (peopleSearchRequest) {
      return jsonResponse(200, {
        ...(await services.searchPeople(peopleSearchRequest)),
      });
    }
    if (organizationsSearchRequest) {
      return jsonResponse(200, {
        ...(await services.searchOrganizations(organizationsSearchRequest)),
      });
    }
    if (personProfileRequest) {
      const profile = await services.getPersonProfile(personProfileRequest);
      return profile
        ? jsonResponse(200, {
            person: profile.person,
            ...publicRolePage(profile),
          })
        : jsonResponse(404, { error: "not_found" });
    }
    if (organizationProfileRequest) {
      const profile = await services.getOrganizationProfile(
        organizationProfileRequest,
      );
      return profile
        ? jsonResponse(200, { ...profile })
        : jsonResponse(404, { error: "not_found" });
    }
    if (organizationRoleRequest) {
      const roles = await services.listOrganizationRoleEntries(
        organizationRoleRequest,
      );
      return roles
        ? jsonResponse(200, publicRolePage(roles))
        : jsonResponse(404, { error: "not_found" });
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
    if (error instanceof PersonProfileInputError) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    if (error instanceof OrganizationProfileInputError) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    if (error instanceof CountyOverviewInputError) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    if (error instanceof DirectorySearchInputError) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    return jsonResponse(500, { error: "internal_error" });
  }
}

function parseCountyOverviewRequest(
  countyFips: string | undefined,
): { countyFips: string } | null {
  return typeof countyFips === "string" && /^08\d{3}$/.test(countyFips)
    ? { countyFips }
    : null;
}

function parseDirectorySearchRequest(
  searchParams: URLSearchParams,
): DirectorySearchRequest | null {
  const allowedParameters = new Set(["query", "limit", "cursor"]);
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => !allowedParameters.has(key)) ||
    keys.some((key) => searchParams.getAll(key).length !== 1)
  ) {
    return null;
  }

  const queryValue = searchParams.get("query");
  if (queryValue === null) return null;
  const query = queryValue.trim();
  if (query.length < 2 || query.length > 100) return null;

  const limitValue = searchParams.get("limit");
  let limit: number | undefined;
  if (limitValue !== null) {
    if (!/^\d+$/.test(limitValue)) return null;
    limit = Number(limitValue);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE
    ) {
      return null;
    }
  }

  const cursor = searchParams.get("cursor");
  return {
    query,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === null ? {} : { cursor }),
  };
}

function invalidDirectorySearchRequest(
  searchParams: URLSearchParams,
): Response {
  const supportedParameters = new Set(["query", "limit", "cursor"]);
  const hasUnsupportedParameter = [...searchParams.keys()].some(
    (key) => !supportedParameters.has(key),
  );
  return jsonResponse(400, {
    error: hasUnsupportedParameter ? "unexpected_query" : "invalid_request",
  });
}

function parseOrganizationProfileRequest(
  organizationId: string | undefined,
  searchParams: URLSearchParams,
): OrganizationProfilePageRequest | null {
  if (
    typeof organizationId !== "string" ||
    organizationId.length < 1 ||
    organizationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(organizationId)
  ) {
    return null;
  }

  const allowedParameters = new Set(["limit", "afterPositionId"]);
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
    if (!/^\d+$/.test(limitValue)) return null;
    limit = Number(limitValue);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE
    ) {
      return null;
    }
  }

  const afterPositionId = searchParams.get("afterPositionId");
  if (
    afterPositionId !== null &&
    (afterPositionId.length < 1 ||
      afterPositionId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(afterPositionId))
  ) {
    return null;
  }

  return {
    organizationId,
    ...(limit === undefined ? {} : { limit }),
    ...(afterPositionId === null ? {} : { afterPositionId }),
  };
}

function parseOrganizationRoleRequest(
  organizationId: string | undefined,
  searchParams: URLSearchParams,
): OrganizationRolePageRequest | null {
  if (
    typeof organizationId !== "string" ||
    organizationId.length < 1 ||
    organizationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(organizationId)
  ) {
    return null;
  }

  const allowedParameters = new Set(["limit", "afterRoleId"]);
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
    if (!/^\d+$/.test(limitValue)) return null;
    limit = Number(limitValue);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE
    ) {
      return null;
    }
  }

  const afterRoleId = searchParams.get("afterRoleId");
  if (
    afterRoleId !== null &&
    (afterRoleId.length < 1 ||
      afterRoleId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(afterRoleId))
  ) {
    return null;
  }

  return {
    organizationId,
    ...(limit === undefined ? {} : { limit }),
    ...(afterRoleId === null ? {} : { afterRoleId }),
  };
}

function parsePersonProfileRequest(
  personId: string | undefined,
  searchParams: URLSearchParams,
): PersonProfilePageRequest | null {
  if (
    typeof personId !== "string" ||
    personId.length < 1 ||
    personId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(personId)
  ) {
    return null;
  }

  const allowedParameters = new Set(["limit", "afterRoleId"]);
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
    if (!/^\d+$/.test(limitValue)) return null;
    limit = Number(limitValue);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_PAGE_SIZE
    ) {
      return null;
    }
  }

  const afterRoleId = searchParams.get("afterRoleId");
  if (
    afterRoleId !== null &&
    (afterRoleId.length < 1 ||
      afterRoleId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(afterRoleId))
  ) {
    return null;
  }

  return {
    personId,
    ...(limit === undefined ? {} : { limit }),
    ...(afterRoleId === null ? {} : { afterRoleId }),
  };
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
  return jsonResponse(201, {
    ...(await services.createAccount(principal, value)),
  });
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

function publicRolePage<T extends { readonly source: unknown }>({
  items,
  hasMore,
  nextCursor,
}: DirectoryPage<T>) {
  return {
    items: items.map(({ source: _source, ...entry }) => entry),
    hasMore,
    nextCursor,
  };
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

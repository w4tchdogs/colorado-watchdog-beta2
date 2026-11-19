import { exactSameOrigin } from "../auth/http.js";
import {
  COUNTY_STRUCTURE_API_PREFIX,
  IMPORT_MODES,
  type ImportMode,
} from "../contracts/county-structure.js";
import {
  CountyStructureConflictError,
  CountyStructureNotFoundError,
  CountyStructureValidationError,
  type D1CountyStructureAdministration,
  type StructureEdit,
} from "../services/county-structure-d1.js";
import {
  AuthorizationError,
  type TrustedPrincipal,
} from "../services/security.js";

/**
 * County Structure HTTP transport (COUNTY-DB-1).
 *
 * Owner-only and default-deny. It authenticates through the existing principal
 * resolver, accepts a current human session holding `county_structure.manage`
 * and nothing else, derives the actor on the server, and requires the exact
 * page origin for every write. Rules, expected versions, idempotency and atomic
 * writes stay in the service. Route shapes are in
 * docs/architecture/county-structure.md.
 */
export const MAX_COUNTY_STRUCTURE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const FIPS = /^08\d{3}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isCountyStructurePath(pathname: string): boolean {
  return (
    pathname === COUNTY_STRUCTURE_API_PREFIX ||
    pathname.startsWith(`${COUNTY_STRUCTURE_API_PREFIX}/`)
  );
}

export interface CountyStructureTransportDependencies {
  readonly resolvePrincipal?: (
    request: Request,
  ) => Promise<TrustedPrincipal | null>;
  /** Must return true for `county_structure.manage`. Anything else denies. */
  readonly authorize?: (principal: TrustedPrincipal) => Promise<boolean>;
  /** Absent means the database binding is unavailable. */
  readonly administration?: D1CountyStructureAdministration;
}

type Route =
  | { op: "counties" }
  | { op: "county"; fips: string }
  | { op: "export" }
  | { op: "imports" }
  | { op: "prepare" }
  | { op: "import"; id: string }
  | { op: "commit" | "reverse"; id: string }
  | { op: "edit" }
  | { op: "history"; id: string }
  | { op: "unitRoles"; id: string }
  | { op: "roleDisplay" };

type Matched =
  | { kind: "route"; route: Route }
  | { kind: "method"; allow: string }
  | { kind: "none" };

function match(pathname: string, method: string): Matched {
  const parts = pathname
    .slice(COUNTY_STRUCTURE_API_PREFIX.length)
    .split("/")
    .slice(1);
  const hit = (route: Route, allowed: string): Matched =>
    method === allowed
      ? { kind: "route", route }
      : { kind: "method", allow: allowed };
  const [a, b, c] = parts;
  if (a === "counties" && parts.length === 1)
    return hit({ op: "counties" }, "GET");
  if (a === "counties" && parts.length === 2 && b && FIPS.test(b))
    return hit({ op: "county", fips: b }, "GET");
  if (a === "export" && parts.length === 1) return hit({ op: "export" }, "GET");
  if (a === "imports" && parts.length === 1)
    return method === "POST"
      ? { kind: "route", route: { op: "prepare" } }
      : hit({ op: "imports" }, "GET");
  if (a === "imports" && b && ID.test(b)) {
    if (parts.length === 2) return hit({ op: "import", id: b }, "GET");
    if (parts.length === 3 && (c === "commit" || c === "reverse"))
      return hit({ op: c, id: b }, "POST");
  }
  if (a === "edits" && parts.length === 1) return hit({ op: "edit" }, "POST");
  if (a === "history" && parts.length === 2 && b && ID.test(b))
    return hit({ op: "history", id: b }, "GET");
  if (a === "units" && parts.length === 3 && b && ID.test(b) && c === "roles")
    return hit({ op: "unitRoles", id: b }, "GET");
  if (a === "role-displays" && parts.length === 1)
    return hit({ op: "roleDisplay" }, "POST");
  return { kind: "none" };
}

export function createCountyStructureApiTransport(
  dependencies: CountyStructureTransportDependencies = {},
): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request) => handle(request, dependencies) };
}

async function handle(
  request: Request,
  dependencies: CountyStructureTransportDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const matched = match(url.pathname, request.method);
  if (matched.kind === "none") return json(404, { error: "not_found" });
  if (matched.kind === "method")
    return json(405, { error: "method_not_allowed" }, { allow: matched.allow });
  const { route } = matched;
  const write = request.method === "POST";

  const queryError = checkQuery(route, url.searchParams);
  if (queryError) return json(400, { error: queryError });
  if (write) {
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared))
        return json(400, { error: "invalid_request" });
      if (Number(declared) > MAX_COUNTY_STRUCTURE_JSON_BYTES)
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
  // County Structure belongs to a signed-in human owner. An agent never passes.
  if (principal.kind !== "human") return json(403, { error: "forbidden" });
  if (write && !exactSameOrigin(request))
    return json(403, { error: "origin_rejected" });
  try {
    if ((await dependencies.authorize?.(principal)) !== true)
      return json(403, { error: "forbidden" });
  } catch {
    return json(403, { error: "forbidden" });
  }
  const service = dependencies.administration;
  if (!service) return json(503, { error: "county_structure_unavailable" });

  try {
    return await execute(request, url, route, principal, service);
  } catch (error) {
    return failure(error);
  }
}

function checkQuery(route: Route, params: URLSearchParams): string | null {
  const keys = [...params.keys()];
  if (keys.length === 0) return null;
  const allowed: Record<string, string[]> = {
    export: ["county"],
    imports: ["limit"],
    import: ["afterSeq", "limit"],
    history: ["limit"],
  };
  const list = allowed[route.op];
  if (
    !list ||
    keys.some((key) => !list.includes(key)) ||
    keys.length !== new Set(keys).size
  )
    return "unexpected_query";
  return null;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (
      new TextEncoder().encode(text).byteLength >
      MAX_COUNTY_STRUCTURE_JSON_BYTES
    )
      return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const invalid = (message = "invalid_request") =>
  json(400, { error: "invalid_request", message });
const num = (value: string | null, fallback: number) =>
  value !== null && /^\d{1,6}$/.test(value) ? Number(value) : fallback;

async function execute(
  request: Request,
  url: URL,
  route: Route,
  principal: TrustedPrincipal,
  service: D1CountyStructureAdministration,
): Promise<Response> {
  switch (route.op) {
    case "counties":
      return json(200, { ...(await service.listCounties(principal)) });
    case "county":
      return json(200, { ...(await service.getCounty(principal, route.fips)) });
    case "export": {
      const county = url.searchParams.get("county") ?? undefined;
      if (county !== undefined && !FIPS.test(county)) return invalid();
      const file = await service.exportCsv(principal, county);
      return new Response(file.csv, {
        status: 200,
        headers: {
          "cache-control": "no-store, private",
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${county ? `county-${county}.csv` : "county.csv"}"`,
          "x-content-type-options": "nosniff",
          "x-county-structure-version": String(file.version),
        },
      });
    }
    case "imports":
      return json(200, {
        imports: await service.listImports(
          principal,
          num(url.searchParams.get("limit"), 50),
        ),
      });
    case "import":
      return json(200, {
        ...(await service.getImport(
          principal,
          route.id,
          url.searchParams.has("afterSeq")
            ? num(url.searchParams.get("afterSeq"), -1)
            : -1,
          num(url.searchParams.get("limit"), 500),
        )),
      });
    case "history":
      return json(200, {
        history: await service.history(
          principal,
          route.id,
          num(url.searchParams.get("limit"), 50),
        ),
      });
    case "unitRoles":
      return json(200, {
        roles: await service.listLinkedRoles(principal, route.id),
      });
    case "prepare": {
      const input = await body(request);
      if (!input) return json(400, { error: "invalid_json" });
      const { fileName, csv, mode, countyFips } = input;
      if (
        typeof csv !== "string" ||
        typeof fileName !== "string" ||
        typeof mode !== "string" ||
        !(IMPORT_MODES as readonly string[]).includes(mode) ||
        (countyFips !== undefined &&
          countyFips !== null &&
          (typeof countyFips !== "string" || !FIPS.test(countyFips)))
      )
        return invalid();
      return json(200, {
        ...(await service.prepareImport(principal, {
          fileName,
          csv,
          mode: mode as ImportMode,
          countyFips: (countyFips as string | null | undefined) ?? null,
        })),
      });
    }
    case "commit": {
      const key = request.headers.get("idempotency-key");
      if (!key) return json(400, { error: "idempotency_key_required" });
      const input = await body(request);
      if (!input) return json(400, { error: "invalid_json" });
      if (
        typeof input.changesetSha256 !== "string" ||
        !Number.isInteger(input.expectedVersion)
      )
        return invalid();
      return json(200, {
        ...(await service.commitImport(principal, {
          importId: route.id,
          changesetSha256: input.changesetSha256,
          expectedVersion: input.expectedVersion as number,
          idempotencyKey: key,
        })),
      });
    }
    case "reverse": {
      const key = request.headers.get("idempotency-key");
      if (!key) return json(400, { error: "idempotency_key_required" });
      return json(200, {
        ...(await service.reverseImport(principal, {
          importId: route.id,
          idempotencyKey: key,
        })),
      });
    }
    case "edit": {
      const input = await body(request);
      if (
        !input ||
        typeof input.edit !== "object" ||
        input.edit === null ||
        !Number.isInteger(input.expectedVersion)
      )
        return json(400, { error: "invalid_json" });
      return json(200, {
        ...(await service.edit(principal, {
          expectedVersion: input.expectedVersion as number,
          edit: input.edit as StructureEdit,
        })),
      });
    }
    case "roleDisplay": {
      const input = await body(request);
      if (!input) return json(400, { error: "invalid_json" });
      if (input.action === "remove") {
        if (typeof input.id !== "string") return invalid();
        await service.removeRoleDisplay(principal, input.id);
        return json(200, { removed: true });
      }
      if (
        input.action !== "add" ||
        typeof input.personRoleId !== "string" ||
        typeof input.listing !== "string" ||
        (input.unitId !== undefined &&
          input.unitId !== null &&
          typeof input.unitId !== "string")
      )
        return invalid();
      return json(200, {
        ...(await service.addRoleDisplay(principal, {
          personRoleId: input.personRoleId,
          listing: input.listing as
            | "home"
            | "elected_official"
            | "department_leader",
          unitId: (input.unitId as string | null | undefined) ?? null,
        })),
      });
    }
  }
}

function failure(error: unknown): Response {
  if (error instanceof AuthorizationError)
    return json(403, { error: "forbidden" });
  if (error instanceof CountyStructureNotFoundError)
    return json(404, { error: "not_found" });
  if (error instanceof CountyStructureValidationError)
    return json(422, {
      error: "validation_failed",
      message: error.message,
      issues: error.issues,
    });
  if (error instanceof CountyStructureConflictError)
    return json(409, { error: error.code, message: error.message });
  return json(503, { error: "dependency_unavailable" });
}

function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Record<string, string> = {},
): Response {
  let text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
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

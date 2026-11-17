import { z } from "zod";
import type { InspectedCountyFips } from "../services/d1-inspection.js";
import type { TrustedPrincipal } from "../services/security.js";

export interface WebsiteInspectionTools {
  status(principal: TrustedPrincipal): Promise<unknown>;
  migrationHistory(principal: TrustedPrincipal): Promise<unknown>;
  countyReferenceCounts(
    principal: TrustedPrincipal,
    counties: readonly InspectedCountyFips[],
  ): Promise<unknown>;
  countyProvenanceSummary(
    principal: TrustedPrincipal,
    counties: readonly InspectedCountyFips[],
  ): Promise<unknown>;
}

export interface WebsiteMcpServices {
  resolvePrincipal(request: Request): Promise<TrustedPrincipal | null>;
  hasCapability(
    principal: TrustedPrincipal | null,
    capability: string,
  ): boolean | Promise<boolean>;
}

type JsonRpcId = string | number;
type ToolCallName =
  | "website_inspection_status"
  | "website_county_reference_counts"
  | "website_migration_history"
  | "website_county_provenance_summary";

const SUPPORTED_VERSION = "2026-07-28";
const COUNTIES = ["08065", "08067"] as const;
const countyInput = z
  .object({ countyFips: z.array(z.enum(COUNTIES)).min(1).max(2).optional() })
  .strict();
const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_RESULT_BYTES = 24 * 1024;
const COUNTY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    countyFips: {
      type: "array",
      items: { type: "string", enum: [...COUNTIES] },
      minItems: 1,
      maxItems: 2,
    },
  },
  additionalProperties: false,
} as const;
const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const TOOL_DEFINITIONS = [
  {
    name: "website_inspection_status",
    description:
      "Return safe metadata about the connected Website inspection environment and county registry.",
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  {
    name: "website_county_reference_counts",
    description:
      "Return bounded aggregate counts for Lake and La Plata county references. County selection is limited to FIPS 08065 and 08067.",
    inputSchema: COUNTY_INPUT_SCHEMA,
  },
  {
    name: "website_migration_history",
    description:
      "Return bounded schema migration version, filename and checksum metadata, compared with the canonical source migration set.",
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  {
    name: "website_county_provenance_summary",
    description:
      "Classify the available county association provenance for Lake and La Plata without returning records or inferring intent from FIPS alone.",
    inputSchema: COUNTY_INPUT_SCHEMA,
  },
] as const;

export async function handleWebsiteMcpRequest(
  request: Request,
  services: WebsiteMcpServices,
  inspection: WebsiteInspectionTools,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") {
    return jsonResponse(404, { error: "not_found" });
  }
  if (request.method !== "POST") {
    return jsonResponse(
      405,
      { error: "method_not_allowed" },
      { allow: "POST" },
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse(413, { error: "request_too_large" });
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "request_too_large" });
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse(400, rpcError(null, -32700, "parse_error"));
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || !isRpcId(body.id)) {
    return jsonResponse(400, rpcError(null, -32600, "invalid_request"));
  }
  const id = body.id;
  if (body.method === "server/discover") {
    return jsonResponse(
      200,
      rpcResult(id, {
        supportedVersions: [SUPPORTED_VERSION],
        capabilities: { tools: {} },
      }),
    );
  }
  if (body.method === "tools/list") {
    return jsonResponse(200, rpcResult(id, { tools: TOOL_DEFINITIONS }));
  }
  if (body.method !== "tools/call") {
    return jsonResponse(200, rpcError(id, -32601, "method_not_found"));
  }
  const params = body.params;
  if (!isRecord(params) || typeof params.name !== "string") {
    return jsonResponse(200, rpcError(id, -32602, "invalid_params"));
  }
  // Protocol 2026-07-28 clients send a request `_meta` envelope (protocol
  // version, client info, client capabilities) on every request. It carries
  // no actor identity and is never used for authorization, so it is accepted
  // as an object and otherwise ignored. Any other extra key is still refused.
  if (
    Object.keys(params).some(
      (key) => key !== "name" && key !== "arguments" && key !== "_meta",
    ) ||
    (params._meta !== undefined && !isRecord(params._meta))
  ) {
    return jsonResponse(200, rpcError(id, -32602, "invalid_params"));
  }
  if (!TOOL_DEFINITIONS.some((tool) => tool.name === params.name)) {
    return jsonResponse(200, rpcResult(id, toolError("unknown_tool")));
  }
  const name = params.name as ToolCallName;
  let args: { countyFips?: InspectedCountyFips[] } = {};
  if (
    name === "website_county_reference_counts" ||
    name === "website_county_provenance_summary"
  ) {
    const parsed = countyInput.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      return jsonResponse(200, rpcResult(id, toolError("invalid_arguments")));
    }
    args = parsed.data;
  } else if (
    params.arguments !== undefined &&
    (!isRecord(params.arguments) || Object.keys(params.arguments).length > 0)
  ) {
    return jsonResponse(200, rpcResult(id, toolError("invalid_arguments")));
  }
  try {
    const principal = await services.resolvePrincipal(request);
    if (
      !principal ||
      (principal.kind === "agent" && principal.role === "owner")
    ) {
      return jsonResponse(
        200,
        rpcResult(id, toolError("authentication_required")),
      );
    }
    if (!(await services.hasCapability(principal, "d1.inspect"))) {
      return jsonResponse(200, rpcResult(id, toolError("not_authorized")));
    }
    const selected = args.countyFips ?? COUNTIES;
    let result: unknown;
    switch (name) {
      case "website_inspection_status":
        result = await inspection.status(principal);
        break;
      case "website_county_reference_counts":
        result = await inspection.countyReferenceCounts(principal, selected);
        break;
      case "website_migration_history":
        result = await inspection.migrationHistory(principal);
        break;
      case "website_county_provenance_summary":
        result = await inspection.countyProvenanceSummary(principal, selected);
        break;
    }
    return jsonResponse(200, rpcResult(id, boundedToolResult(result)));
  } catch (error) {
    const code =
      error instanceof Error && error.name === "InspectionDeniedError"
        ? "not_authorized"
        : "inspection_unavailable";
    console.warn("mcp tool failed", { tool: name, code });
    return jsonResponse(200, rpcResult(id, toolError(code)));
  }
}

function boundedToolResult(value: unknown) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) {
    return toolError("result_too_large");
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: { result: value },
  };
}

function toolError(code: string) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code }) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is JsonRpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
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

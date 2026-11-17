import { z } from "zod";
import type {
  BannerAdminBanner,
  BannerAdministration,
  BannerChangeResult,
  BannerPublicationRecord,
} from "../contracts/banner-administration.js";
import {
  BannerConflictError,
  BannerValidationError,
} from "../services/banner-assets.js";
import type { InspectedCountyFips } from "../services/d1-inspection.js";
import {
  AuthorizationError,
  type TrustedPrincipal,
} from "../services/security.js";

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
type InspectionToolName =
  | "website_inspection_status"
  | "website_county_reference_counts"
  | "website_migration_history"
  | "website_county_provenance_summary";
type BannerToolName =
  | "website_banner_county"
  | "website_banner_publications"
  | "website_banner_publish"
  | "website_banner_withdraw"
  | "website_banner_restore";
type ToolCallName = InspectionToolName | BannerToolName;

/**
 * Capability every banner tool needs. No role holds `banner.publish`, so only
 * an agent with an active, owner-issued grant passes. The banner service
 * rechecks the live account, identity and grant on every call, and the write
 * batch fails on any grant change made after that check. `d1.inspect` alone
 * never reaches these tools.
 */
export const BANNER_MCP_CAPABILITY = "banner.publish";
const BANNER_TOOLS: ReadonlySet<string> = new Set<BannerToolName>([
  "website_banner_county",
  "website_banner_publications",
  "website_banner_publish",
  "website_banner_withdraw",
  "website_banner_restore",
]);

const SUPPORTED_VERSION = "2026-07-28";
const COUNTIES = ["08065", "08067"] as const;
const countyInput = z
  .object({ countyFips: z.array(z.enum(COUNTIES)).min(1).max(2).optional() })
  .strict();
const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_RESULT_BYTES = 24 * 1024;
/** A county can hold 25 banners with 20 listed versions each. */
const MAX_BANNER_RESULT_BYTES = 128 * 1024;

// The same identifier rules as the protected banner API. No path, URL,
// storage key, actor or SQL fits these patterns or the closed schemas below.
const BANNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COUNTY_FIPS = /^08\d{3}$/;
const RESERVED_BANNER_IDS = new Set(["counties", "versions", "stage"]);
const bannerIdInput = z
  .string()
  .regex(BANNER_ID)
  .refine((value) => !RESERVED_BANNER_IDS.has(value));
const recordIdInput = z.string().regex(RECORD_ID);
const rowVersionInput = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const idempotencyKeyInput = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
const publicationMetadataInput = z
  .object({
    caption: z.string().max(500),
    altText: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    displayMode: z.enum(["cover", "contain"]),
    focalX: z.number().min(0).max(1),
    focalY: z.number().min(0).max(1),
  })
  .strict();
const bannerCountyInput = z
  .object({
    countyFips: z.string().regex(COUNTY_FIPS),
    bannerId: bannerIdInput.optional(),
  })
  .strict();
const bannerPublicationsInput = z.object({ bannerId: bannerIdInput }).strict();
const bannerPublishInput = z
  .object({
    bannerId: bannerIdInput,
    versionId: recordIdInput,
    expectedRowVersion: rowVersionInput,
    idempotencyKey: idempotencyKeyInput,
    metadata: publicationMetadataInput.optional(),
  })
  .strict();
const bannerWithdrawInput = z
  .object({
    bannerId: bannerIdInput,
    expectedRowVersion: rowVersionInput,
    idempotencyKey: idempotencyKeyInput,
  })
  .strict();
const bannerRestoreInput = z
  .object({
    bannerId: bannerIdInput,
    versionId: recordIdInput,
    expectedRowVersion: rowVersionInput,
    idempotencyKey: idempotencyKeyInput,
    publicationId: recordIdInput.optional(),
  })
  .strict();
const BANNER_INPUTS = {
  website_banner_county: bannerCountyInput,
  website_banner_publications: bannerPublicationsInput,
  website_banner_publish: bannerPublishInput,
  website_banner_withdraw: bannerWithdrawInput,
  website_banner_restore: bannerRestoreInput,
} as const;

const BANNER_ID_SCHEMA = {
  type: "string",
  pattern: BANNER_ID.source,
  description: "An existing banner ID from website_banner_county",
} as const;
const RECORD_ID_SCHEMA = { type: "string", pattern: RECORD_ID.source } as const;
const ROW_VERSION_SCHEMA = {
  type: "integer",
  minimum: 1,
  description: "The banner rowVersion from the last read or change result",
} as const;
const IDEMPOTENCY_KEY_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description:
    "Generate once per intended change and reuse it unchanged on a retry",
} as const;
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
  {
    name: "website_banner_county",
    description:
      "Read one Colorado county's banners with row versions, status, selected version, publication text and newest versions. Optionally narrow to one banner. Needs the banner.publish agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        countyFips: { type: "string", pattern: COUNTY_FIPS.source },
        bannerId: BANNER_ID_SCHEMA,
      },
      required: ["countyFips"],
      additionalProperties: false,
    },
  },
  {
    name: "website_banner_publications",
    description:
      "Read a banner's recorded publication history, newest first, at most 50. Needs the banner.publish agent grant.",
    inputSchema: {
      type: "object",
      properties: { bannerId: BANNER_ID_SCHEMA },
      required: ["bannerId"],
      additionalProperties: false,
    },
  },
  {
    name: "website_banner_publish",
    description:
      "Publish a verified version that was staged through the protected banner API. The stored image is rechecked first. Omit metadata to keep the banner's current caption, alt text and display settings. Needs the banner.publish agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        bannerId: BANNER_ID_SCHEMA,
        versionId: RECORD_ID_SCHEMA,
        expectedRowVersion: ROW_VERSION_SCHEMA,
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
        metadata: {
          type: "object",
          properties: {
            caption: { type: "string", maxLength: 500 },
            altText: { type: "string", minLength: 1, maxLength: 1000 },
            displayMode: { type: "string", enum: ["cover", "contain"] },
            focalX: { type: "number", minimum: 0, maximum: 1 },
            focalY: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["caption", "altText", "displayMode", "focalX", "focalY"],
          additionalProperties: false,
        },
      },
      required: [
        "bannerId",
        "versionId",
        "expectedRowVersion",
        "idempotencyKey",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "website_banner_withdraw",
    description:
      "Take an active banner out of public view. Its versions and history are kept. Needs the banner.publish agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        bannerId: BANNER_ID_SCHEMA,
        expectedRowVersion: ROW_VERSION_SCHEMA,
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ["bannerId", "expectedRowVersion", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "website_banner_restore",
    description:
      "Select a retained verified version again with the text of a recorded publication, reactivating a withdrawn banner. Without publicationId the version's latest recorded publication is used. Needs the banner.publish agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        bannerId: BANNER_ID_SCHEMA,
        versionId: RECORD_ID_SCHEMA,
        expectedRowVersion: ROW_VERSION_SCHEMA,
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
        publicationId: RECORD_ID_SCHEMA,
      },
      required: [
        "bannerId",
        "versionId",
        "expectedRowVersion",
        "idempotencyKey",
      ],
      additionalProperties: false,
    },
  },
] as const;

export async function handleWebsiteMcpRequest(
  request: Request,
  services: WebsiteMcpServices,
  inspection: WebsiteInspectionTools,
  banners?: BannerAdministration,
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
  if (BANNER_TOOLS.has(name)) {
    return handleBannerTool(
      request,
      id,
      name as BannerToolName,
      params.arguments,
      services,
      banners,
    );
  }
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

async function handleBannerTool(
  request: Request,
  id: JsonRpcId,
  name: BannerToolName,
  rawArguments: unknown,
  services: WebsiteMcpServices,
  banners: BannerAdministration | undefined,
): Promise<Response> {
  const parsed = BANNER_INPUTS[name].safeParse(rawArguments ?? {});
  if (!parsed.success) {
    return jsonResponse(200, rpcResult(id, toolError("invalid_arguments")));
  }
  const reply = (result: unknown) => jsonResponse(200, rpcResult(id, result));
  try {
    const principal = await services.resolvePrincipal(request);
    if (
      !principal ||
      (principal.kind === "agent" && principal.role === "owner")
    ) {
      return reply(toolError("authentication_required"));
    }
    if (!(await services.hasCapability(principal, BANNER_MCP_CAPABILITY))) {
      return reply(toolError("not_authorized"));
    }
    if (!banners) return reply(toolError("banner_admin_unavailable"));
    let result: unknown;
    switch (name) {
      case "website_banner_county": {
        const input = parsed.data as z.infer<typeof bannerCountyInput>;
        const detail = await banners.getCounty(principal, input.countyFips);
        if (!detail) return reply(toolError("not_found"));
        const shown = input.bannerId
          ? detail.banners.filter((banner) => banner.id === input.bannerId)
          : detail.banners;
        if (input.bannerId && shown.length === 0) {
          return reply(toolError("not_found"));
        }
        result = {
          county: detail.county,
          banners: shown.map(bannerSummary),
          bannersTruncated: detail.bannersTruncated,
        };
        break;
      }
      case "website_banner_publications": {
        const input = parsed.data as z.infer<typeof bannerPublicationsInput>;
        const records = await banners.listPublications(
          principal,
          input.bannerId,
        );
        result = { publications: records.map(publicationSummary) };
        break;
      }
      case "website_banner_publish": {
        const input = parsed.data as z.infer<typeof bannerPublishInput>;
        result = changeSummary(
          await banners.publish(principal, {
            bannerId: input.bannerId,
            versionId: input.versionId,
            expectedRowVersion: input.expectedRowVersion,
            idempotencyKey: input.idempotencyKey,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          }),
        );
        break;
      }
      case "website_banner_withdraw": {
        const input = parsed.data as z.infer<typeof bannerWithdrawInput>;
        result = changeSummary(
          await banners.withdraw(principal, {
            bannerId: input.bannerId,
            expectedRowVersion: input.expectedRowVersion,
            idempotencyKey: input.idempotencyKey,
          }),
        );
        break;
      }
      case "website_banner_restore": {
        const input = parsed.data as z.infer<typeof bannerRestoreInput>;
        result = changeSummary(
          await banners.restore(principal, {
            bannerId: input.bannerId,
            versionId: input.versionId,
            expectedRowVersion: input.expectedRowVersion,
            idempotencyKey: input.idempotencyKey,
            ...(input.publicationId
              ? { publicationId: input.publicationId }
              : {}),
          }),
        );
        break;
      }
    }
    return reply(boundedToolResult(result, MAX_BANNER_RESULT_BYTES));
  } catch (error) {
    const failure = bannerFailure(error);
    console.warn("mcp tool failed", { tool: name, code: failure.error });
    return reply(toolError(failure));
  }
}

/** Operator metadata only. No object key, source filename or staging actor. */
function bannerSummary(banner: BannerAdminBanner) {
  return {
    id: banner.id,
    status: banner.status,
    rowVersion: banner.rowVersion,
    selectedVersionId: banner.selectedVersionId,
    publicEligible: banner.publicEligible,
    caption: banner.caption,
    altText: banner.altText,
    displayMode: banner.displayMode,
    focalX: banner.focalX,
    focalY: banner.focalY,
    displayOrder: banner.displayOrder,
    isPrimary: banner.isPrimary,
    homepageOrder: banner.homepageOrder,
    updatedAt: banner.updatedAt,
    versionCount: banner.versionCount,
    versionsTruncated: banner.versionsTruncated,
    versions: banner.versions.map((version) => ({
      id: version.id,
      state: version.state,
      isSelected: version.isSelected,
      mediaType: version.mediaType,
      width: version.width,
      height: version.height,
      byteSize: version.byteSize,
      sha256: version.sha256,
      createdAt: version.createdAt,
      verifiedAt: version.verifiedAt,
    })),
  };
}

function publicationSummary(record: BannerPublicationRecord) {
  return {
    id: record.id,
    versionId: record.versionId,
    sequence: record.sequence,
    origin: record.origin,
    restoredFromPublicationId: record.restoredFromPublicationId,
    caption: record.caption,
    altText: record.altText,
    displayMode: record.displayMode,
    focalX: record.focalX,
    focalY: record.focalY,
    bannerRowVersion: record.bannerRowVersion,
    publishedAt: record.publishedAt,
  };
}

function changeSummary(change: BannerChangeResult) {
  return {
    bannerId: change.bannerId,
    status: change.status,
    selectedVersionId: change.selectedVersionId,
    rowVersion: change.rowVersion,
    publicationId: change.publicationId,
    replayed: change.replayed,
  };
}

/** The protected banner API's codes. Unexpected errors expose nothing. */
function bannerFailure(error: unknown): { error: string; detail?: string } {
  if (error instanceof AuthorizationError) return { error: "not_authorized" };
  if (error instanceof BannerValidationError)
    return { error: "validation_failed", detail: error.message };
  if (error instanceof BannerConflictError)
    return { error: error.code, detail: error.message };
  return { error: "banner_admin_unavailable" };
}

function boundedToolResult(value: unknown, limit = MAX_RESULT_BYTES) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > limit) {
    return toolError("result_too_large");
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: { result: value },
  };
}

function toolError(failure: string | { error: string; detail?: string }) {
  const body = typeof failure === "string" ? { error: failure } : failure;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
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

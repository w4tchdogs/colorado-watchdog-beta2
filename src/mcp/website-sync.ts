import { z } from "zod";
import { SYNC_CONTRACT_VERSION } from "../contracts/sync.js";
import type { TrustedPrincipal } from "../services/security.js";
import {
  createSyncApiTransport,
  SYNC_API_PATHS,
  type SyncTransportDependencies,
  type SyncTransportOperation,
} from "../transport/sync-api.js";

/**
 * MCP-3 Profiles sync tools. They are a thin typed layer over the hosted sync
 * transport (PR #179, set-based planning and commit from PR #193), so request
 * validation, per-operation grants, batch ownership, dependency and version
 * checks, atomic writes, same-key replay and durable receipts are the existing
 * ones. This file adds argument typing, a bounded request body gate and paged
 * results. It never reads or writes the database itself.
 */

export type SyncToolName =
  | "website_sync_dry_run"
  | "website_sync_commit"
  | "website_sync_lookup"
  | "website_sync_reverse";

/** The owner-issued agent grant each tool needs. No role holds any of them. */
export const SYNC_TOOL_CAPABILITY: Readonly<
  Record<SyncToolName, "sync.read" | "sync.apply" | "sync.revert">
> = {
  website_sync_dry_run: "sync.read",
  website_sync_lookup: "sync.read",
  website_sync_commit: "sync.apply",
  website_sync_reverse: "sync.revert",
};

export function isSyncToolName(name: string): name is SyncToolName {
  return Object.hasOwn(SYNC_TOOL_CAPABILITY, name);
}

/** Only these two tools carry a changeset, so only they may exceed the small default body cap. */
export const SYNC_LARGE_BODY_TOOLS: ReadonlySet<string> = new Set<SyncToolName>(
  ["website_sync_dry_run", "website_sync_commit"],
);

/** A whole JSON-RPC body that carries a changeset. The 816-operation fixture is about 250 KB. */
export const MAX_SYNC_MCP_REQUEST_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SYNC_PAGE = 100;
export const MAX_SYNC_PAGE = 250;
/** 250 items plus 200 diagnostics fit well inside this. Larger results are refused, not truncated silently. */
export const MAX_SYNC_MCP_RESULT_BYTES = 192 * 1024;

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const id = z.string().regex(ID);
const offset = z.number().int().min(0).max(1_000_000);
const limit = z.number().int().min(1).max(MAX_SYNC_PAGE);
const changeset = z.object({}).passthrough();

const INPUTS = {
  website_sync_dry_run: z
    .object({
      changeset,
      itemOffset: offset.optional(),
      itemLimit: limit.optional(),
    })
    .strict(),
  website_sync_commit: z
    .object({
      idempotencyKey: id,
      changeset,
      itemOffset: offset.optional(),
      itemLimit: limit.optional(),
    })
    .strict(),
  website_sync_lookup: z
    .object({
      batchId: id.optional(),
      idempotencyKey: id.optional(),
      itemOffset: offset.optional(),
      itemLimit: limit.optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.batchId === undefined) !== (value.idempotencyKey === undefined),
    ),
  website_sync_reverse: z.object({ batchId: id, idempotencyKey: id }).strict(),
} as const;

const ID_SCHEMA = {
  type: "string",
  pattern: ID.source,
} as const;
const PAGE_PROPERTIES = {
  itemOffset: {
    type: "integer",
    minimum: 0,
    description: "First item to return. Defaults to 0",
  },
  itemLimit: {
    type: "integer",
    minimum: 1,
    maximum: MAX_SYNC_PAGE,
    description: `Items per page. Defaults to ${DEFAULT_SYNC_PAGE}`,
  },
} as const;
const CHANGESET_SCHEMA = {
  type: "object",
  description: `The m2-sync/v1 changeset exactly as prepared by the Profiles operator (contractVersion ${SYNC_CONTRACT_VERSION}, requestId, intent, changes, duplicateFlags). A whole request may be up to ${MAX_SYNC_MCP_REQUEST_BYTES / 1024} KiB`,
  additionalProperties: true,
} as const;

export const SYNC_TOOL_DEFINITIONS = [
  {
    name: "website_sync_dry_run",
    description:
      "Plan a Profiles changeset against the current Website state without writing anything. Reports eligibility, per-item actions, dependency and version errors and duplicate flags. A changeset prepared with intent commit is accepted and planned as a dry run. Items are paged. Needs the sync.read agent grant.",
    inputSchema: {
      type: "object",
      properties: { changeset: CHANGESET_SCHEMA, ...PAGE_PROPERTIES },
      required: ["changeset"],
      additionalProperties: false,
    },
  },
  {
    name: "website_sync_commit",
    description:
      "Commit a prepared Profiles changeset as one atomic batch owned by the calling agent. The changeset needs intent commit. Reusing an idempotency key with the same changeset replays the stored receipt, and a different changeset under that key is rejected. Returns the receipt's first page of items. Read the rest with website_sync_lookup. Needs the sync.apply agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: {
          ...ID_SCHEMA,
          description:
            "Generate once per changeset and reuse it unchanged on a retry",
        },
        changeset: CHANGESET_SCHEMA,
        ...PAGE_PROPERTIES,
      },
      required: ["idempotencyKey", "changeset"],
      additionalProperties: false,
    },
  },
  {
    name: "website_sync_lookup",
    description:
      "Read back one committed batch owned by the calling agent, by batch ID or by idempotency key, with its items in pages. Another account's batch is reported as not found. Needs the sync.read agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        batchId: ID_SCHEMA,
        idempotencyKey: ID_SCHEMA,
        ...PAGE_PROPERTIES,
      },
      description: "Provide exactly one of batchId and idempotencyKey",
      additionalProperties: false,
    },
  },
  {
    name: "website_sync_reverse",
    description:
      "Reverse one committed batch owned by the calling agent. The reversal is atomic and refused, with nothing changed, if a later change depends on the batch. Reusing the idempotency key replays the stored result. Needs the sync.revert agent grant.",
    inputSchema: {
      type: "object",
      properties: {
        batchId: ID_SCHEMA,
        idempotencyKey: {
          ...ID_SCHEMA,
          description:
            "Generate once per intended reversal and reuse it unchanged on a retry",
        },
      },
      required: ["batchId", "idempotencyKey"],
      additionalProperties: false,
    },
  },
] as const;

export interface SyncBridgeResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

/** Calls the sync transport for an already authenticated principal. */
export interface SyncMcpBridge {
  call(
    principal: TrustedPrincipal,
    operation: SyncTransportOperation,
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<SyncBridgeResponse>;
}

/**
 * Runs the real sync transport in process. The principal comes from the MCP
 * handler's own credential check, and the transport still authorizes the
 * operation's grant against the live account and grant rows, so a grant
 * revoked mid-request is honored.
 */
export function createSyncMcpBridge(
  dependencies: Omit<SyncTransportDependencies, "resolvePrincipal">,
): SyncMcpBridge {
  return {
    async call(principal, operation, payload, idempotencyKey) {
      const transport = createSyncApiTransport({
        ...dependencies,
        resolvePrincipal: async () => principal,
      });
      const response = await transport.fetch(
        new Request(`https://mcp.internal${PATHS[operation]}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          body: JSON.stringify(payload),
        }),
      );
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = await response.json();
        if (isRecord(parsed)) body = parsed;
      } catch {
        // An unreadable body is reported through the status alone.
      }
      return { status: response.status, body };
    },
  };
}

const PATHS: Record<SyncTransportOperation, string> = {
  dry_run: SYNC_API_PATHS.dryRun,
  commit: SYNC_API_PATHS.commit,
  lookup: SYNC_API_PATHS.lookup,
  reverse: SYNC_API_PATHS.reverse,
};

interface ToolResult {
  readonly isError?: true;
  readonly content: readonly { type: "text"; text: string }[];
  readonly structuredContent?: { result: unknown };
}

/** Runs one sync tool for a principal the caller has already authorized for it. */
export async function runSyncTool(
  name: SyncToolName,
  rawArguments: unknown,
  principal: TrustedPrincipal,
  bridge: SyncMcpBridge | undefined,
): Promise<ToolResult> {
  const parsed = INPUTS[name].safeParse(rawArguments ?? {});
  if (!parsed.success) return failure("invalid_arguments");
  if (!bridge) return failure("sync_unavailable");
  const input = parsed.data as Record<string, unknown>;
  const page = {
    offset: (input.itemOffset as number | undefined) ?? 0,
    limit: (input.itemLimit as number | undefined) ?? DEFAULT_SYNC_PAGE,
  };
  switch (name) {
    case "website_sync_dry_run": {
      const request = {
        ...(input.changeset as Record<string, unknown>),
        // A prepared commit request may be planned unchanged. Planning writes nothing.
        intent: "dry_run",
      };
      const reply = await bridge.call(principal, "dry_run", request);
      if (reply.status !== 200 || !reply.body) return transportFailure(reply);
      const items = asArray(reply.body.items);
      return bounded({
        contractVersion: reply.body.contractVersion,
        requestId: reply.body.requestId,
        eligible: reply.body.eligible,
        itemCount: items.length,
        counts: countBy(items, ["entity", "action"]),
        ...pageOf(items, page),
        errors: reply.body.errors,
        duplicateFlags: reply.body.duplicateFlags,
      });
    }
    case "website_sync_commit": {
      const reply = await bridge.call(
        principal,
        "commit",
        input.changeset,
        input.idempotencyKey as string,
      );
      if (!reply.body) return transportFailure(reply);
      if (reply.body.status === "rejected")
        return failure({
          error: "commit_rejected",
          status: "rejected",
          requestId: reply.body.requestId,
          errors: reply.body.errors,
        });
      if (reply.status !== 200) return transportFailure(reply);
      const items = asArray(reply.body.items);
      return bounded({
        status: reply.body.status,
        batchId: reply.body.batchId,
        requestId: reply.body.requestId,
        committedAt: reply.body.committedAt,
        replayed: reply.body.replayed,
        itemCount: items.length,
        counts: countBy(items, ["entity", "outcome"]),
        ...pageOf(items, page),
      });
    }
    case "website_sync_lookup": {
      const reply = await bridge.call(principal, "lookup", {
        contractVersion: SYNC_CONTRACT_VERSION,
        ...(input.batchId === undefined
          ? { idempotencyKey: input.idempotencyKey }
          : { batchId: input.batchId }),
      });
      if (reply.status === 404) return failure("batch_not_found");
      if (reply.status !== 200 || !reply.body) return transportFailure(reply);
      const items = asArray(reply.body.items);
      return bounded({
        status: reply.body.status,
        batchId: reply.body.batchId,
        committedAt: reply.body.committedAt,
        reversedAt: reply.body.reversedAt,
        itemCount: items.length,
        counts: countBy(items, ["entity", "outcome"]),
        ...pageOf(items, page),
      });
    }
    case "website_sync_reverse": {
      const reply = await bridge.call(
        principal,
        "reverse",
        {
          contractVersion: SYNC_CONTRACT_VERSION,
          batchId: input.batchId,
        },
        input.idempotencyKey as string,
      );
      if (reply.status !== 200 || !reply.body) return transportFailure(reply);
      return bounded(reply.body);
    }
  }
}

function pageOf(
  items: readonly unknown[],
  page: { offset: number; limit: number },
) {
  const end = Math.min(items.length, page.offset + page.limit);
  return {
    itemOffset: page.offset,
    items: items.slice(page.offset, end),
    nextItemOffset: end < items.length ? end : null,
  };
}

function countBy(
  items: readonly unknown[],
  keys: readonly [string, string],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!isRecord(item)) continue;
    const label = `${String(item[keys[0]])}:${String(item[keys[1]])}`;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The transport's safe codes only. Nothing from the request or the database. */
function transportFailure(reply: SyncBridgeResponse): ToolResult {
  const code = typeof reply.body?.error === "string" ? reply.body.error : null;
  switch (reply.status) {
    case 401:
      return failure("authentication_required");
    case 403:
      return failure("not_authorized");
    case 413:
      return failure("request_too_large");
    case 404:
      return failure(code ?? "not_found");
    case 400:
      return failure(code ?? "invalid_request");
    case 503:
      return failure("sync_unavailable");
    default:
      return failure("sync_failed");
  }
}

function failure(value: string | Record<string, unknown>): ToolResult {
  const body = typeof value === "string" ? { error: value } : value;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

function bounded(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_SYNC_MCP_RESULT_BYTES)
    return failure("result_too_large");
  return {
    content: [{ type: "text", text }],
    structuredContent: { result: value },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

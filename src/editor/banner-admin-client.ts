import type {
  BannerAdminBanner,
  BannerAdminVersion,
  BannerChangeResult,
  BannerPublicationRecord,
  BannerReconciliationItem,
  BannerStageResult,
  CountyBannerDetail,
  CountyBannerPage,
  NewBannerMetadata,
  PublicationMetadata,
  ReorderCountyResult,
} from "../contracts/banner-administration.js";

/**
 * Browser-side client for the merged `/api/admin/banners/*` contract. It only
 * builds requests and surfaces results. Authorization, version checks and
 * idempotency stay on the server, and a response is never treated as
 * permission.
 */
export const BANNER_ADMIN_API_PREFIX = "/api/admin/banners";

export type BannerAdminErrorCode =
  | "authentication_required"
  | "forbidden"
  | "origin_rejected"
  | "not_found"
  | "method_not_allowed"
  | "invalid_request"
  | "unexpected_query"
  | "stale_version"
  | "idempotency_conflict"
  | "snapshot_required"
  | "version_not_publishable"
  | "object_verification_failed"
  | "duplicate_image"
  | "order_conflict"
  | "banner_exists"
  | "banner_not_found"
  | "publication_mismatch"
  | "invalid_state"
  | "needs_reconciliation"
  | "conflict"
  | "request_too_large"
  | "image_too_large"
  | "unsupported_media_type"
  | "unsupported_image_type"
  | "validation_failed"
  | "invalid_image"
  | "storage_failed"
  | "finalize_failed"
  | "dependency_unavailable"
  | "banner_admin_unavailable"
  | "network_error"
  | "internal_error";

export class BannerAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: BannerAdminErrorCode,
    readonly detail?: string,
    readonly reason?: string,
    readonly retryable?: boolean,
  ) {
    super(code);
    this.name = "BannerAdminError";
  }
}

export type BannerAdminFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array | string;
  },
) => Promise<Response>;

export interface BannerAdminClientOptions {
  readonly fetch: BannerAdminFetch;
  /**
   * Extra request headers. Only the local sandbox sets this, to carry its
   * per-launch token and synthetic account. The hosted dashboard omits it and
   * relies on the Website session cookie that the fetch wrapper attaches.
   */
  readonly headers?: () => Record<string, string>;
}

export interface BannerVersionImageResponse {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface StageNewInput {
  readonly bannerId: string;
  readonly countyFips: string;
  readonly sourceFilename: string;
  readonly idempotencyKey: string;
  readonly metadata: NewBannerMetadata;
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg";
}

export interface StageExistingInput {
  readonly bannerId: string;
  readonly countyFips: string;
  readonly sourceFilename: string;
  readonly idempotencyKey: string;
  readonly expectedRowVersion: number;
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg";
}

export interface PublishInput {
  readonly bannerId: string;
  readonly versionId: string;
  readonly expectedRowVersion: number;
  readonly idempotencyKey: string;
  readonly metadata?: PublicationMetadata;
}

export interface RestoreInput {
  readonly bannerId: string;
  readonly versionId: string;
  readonly expectedRowVersion: number;
  readonly idempotencyKey: string;
  readonly publicationId?: string;
  readonly metadata?: PublicationMetadata;
}

export interface MetadataChangeInput {
  readonly bannerId: string;
  readonly expectedRowVersion: number;
  readonly idempotencyKey: string;
  readonly change: Record<string, string | number | boolean | null>;
}

export interface ReorderInput {
  readonly countyFips: string;
  readonly idempotencyKey: string;
  readonly orderedBannerIds: readonly string[];
  readonly expectedRowVersions: Readonly<Record<string, number>>;
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += BASE64URL_ALPHABET[(value >>> bits) & 63];
    }
  }
  if (bits > 0) out += BASE64URL_ALPHABET[(value << (6 - bits)) & 63];
  return out;
}

export function createBannerAdminClient(options: BannerAdminClientOptions) {
  const headers = (): Record<string, string> => options.headers?.() ?? {};

  async function send<T>(
    path: string,
    method: "GET" | "POST",
    init: { json?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await options.fetch(`${BANNER_ADMIN_API_PREFIX}${path}`, {
        method,
        headers: {
          ...headers(),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(init.json ?? {}) } : {}),
      });
    } catch {
      throw new BannerAdminError(0, "network_error");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const record =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      throw new BannerAdminError(
        response.status,
        (typeof record.error === "string"
          ? record.error
          : "internal_error") as BannerAdminErrorCode,
        typeof record.detail === "string" ? record.detail : undefined,
        typeof record.reason === "string" ? record.reason : undefined,
        record.retryable === true,
      );
    }
    return body as T;
  }

  async function stage(
    input:
      | (StageNewInput & {
          target: { kind: "new"; metadata: NewBannerMetadata };
        })
      | (StageExistingInput & {
          target: { kind: "existing"; expectedRowVersion: number };
        }),
  ): Promise<BannerStageResult> {
    const meta = {
      bannerId: input.bannerId,
      countyFips: input.countyFips,
      sourceFilename: input.sourceFilename,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
    };
    const header = base64url(new TextEncoder().encode(JSON.stringify(meta)));
    let response: Response;
    try {
      response = await options.fetch(`${BANNER_ADMIN_API_PREFIX}/stage`, {
        method: "POST",
        headers: {
          ...headers(),
          "content-type": input.mediaType,
          "x-banner-stage": header,
        },
        body: input.bytes,
      });
    } catch {
      throw new BannerAdminError(0, "network_error");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const record =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      throw new BannerAdminError(
        response.status,
        (typeof record.error === "string"
          ? record.error
          : "internal_error") as BannerAdminErrorCode,
        typeof record.detail === "string" ? record.detail : undefined,
        typeof record.reason === "string" ? record.reason : undefined,
        record.retryable === true,
      );
    }
    return body as BannerStageResult;
  }

  return {
    listCounties(
      params: { query?: string; limit?: number; afterFips?: string } = {},
    ): Promise<CountyBannerPage> {
      const search = new URLSearchParams();
      if (params.query) search.set("query", params.query);
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      if (params.afterFips) search.set("afterFips", params.afterFips);
      const query = search.toString();
      return send(`/counties${query ? `?${query}` : ""}`, "GET");
    },
    getCounty(fips: string): Promise<CountyBannerDetail> {
      return send(`/counties/${fips}`, "GET");
    },
    async listPublications(
      bannerId: string,
    ): Promise<readonly BannerPublicationRecord[]> {
      const body = await send<{
        publications?: readonly BannerPublicationRecord[];
      }>(`/${bannerId}/publications`, "GET");
      return body.publications ?? [];
    },
    async reconcile(
      bannerId: string,
    ): Promise<readonly BannerReconciliationItem[]> {
      const body = await send<{ items?: readonly BannerReconciliationItem[] }>(
        `/${bannerId}/reconcile`,
        "GET",
      );
      return body.items ?? [];
    },
    async versionImage(versionId: string): Promise<BannerVersionImageResponse> {
      let response: Response;
      try {
        response = await options.fetch(
          `${BANNER_ADMIN_API_PREFIX}/versions/${versionId}/image`,
          { method: "GET", headers: headers() },
        );
      } catch {
        throw new BannerAdminError(0, "network_error");
      }
      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const record =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)
            : {};
        throw new BannerAdminError(
          response.status,
          (typeof record.error === "string"
            ? record.error
            : "internal_error") as BannerAdminErrorCode,
        );
      }
      return {
        mediaType: response.headers.get("content-type") ?? "image/png",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
    stageNew(input: StageNewInput): Promise<BannerStageResult> {
      return stage({
        ...input,
        target: { kind: "new", metadata: input.metadata },
      });
    },
    stageReplacement(input: StageExistingInput): Promise<BannerStageResult> {
      return stage({
        ...input,
        target: {
          kind: "existing",
          expectedRowVersion: input.expectedRowVersion,
        },
      });
    },
    publish(input: PublishInput): Promise<BannerChangeResult> {
      return send(`/${input.bannerId}/publish`, "POST", {
        json: {
          versionId: input.versionId,
          expectedRowVersion: input.expectedRowVersion,
          idempotencyKey: input.idempotencyKey,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
    },
    withdraw(
      bannerId: string,
      expectedRowVersion: number,
      idempotencyKey: string,
    ): Promise<BannerChangeResult> {
      return send(`/${bannerId}/withdraw`, "POST", {
        json: { expectedRowVersion, idempotencyKey },
      });
    },
    restore(input: RestoreInput): Promise<BannerChangeResult> {
      return send(`/${input.bannerId}/restore`, "POST", {
        json: {
          versionId: input.versionId,
          expectedRowVersion: input.expectedRowVersion,
          idempotencyKey: input.idempotencyKey,
          ...(input.publicationId
            ? { publicationId: input.publicationId }
            : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
    },
    updateMetadata(input: MetadataChangeInput): Promise<BannerChangeResult> {
      return send(`/${input.bannerId}/metadata`, "POST", {
        json: {
          expectedRowVersion: input.expectedRowVersion,
          idempotencyKey: input.idempotencyKey,
          change: input.change,
        },
      });
    },
    reorderCounty(input: ReorderInput): Promise<ReorderCountyResult> {
      return send(`/counties/${input.countyFips}/reorder`, "POST", {
        json: {
          idempotencyKey: input.idempotencyKey,
          orderedBannerIds: input.orderedBannerIds,
          expectedRowVersions: input.expectedRowVersions,
        },
      });
    },
  };
}

export type BannerAdminClient = ReturnType<typeof createBannerAdminClient>;
export type { BannerAdminBanner, BannerAdminVersion };

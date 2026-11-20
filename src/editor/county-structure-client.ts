import {
  type ChangeCounts,
  COUNTY_STRUCTURE_API_PREFIX,
  type CountyStructureCounts,
  type CountySummary,
  type CsvIssue,
  type ImportMode,
  type ImportSummary,
  type PreparedImport,
  type UnitNode,
} from "../contracts/county-structure.js";
import type {
  RoleAttachmentPreview,
  RoleAttachmentReceipt,
} from "../services/county-role-attachment-d1.js";

/**
 * Browser client for the protected `/api/admin/county-structure/*` routes. It
 * only builds requests and surfaces results. Authorization, expected versions,
 * idempotency and every structure rule stay on the server, and a response is
 * never treated as permission. The browser sends the Website session cookie
 * and nothing else.
 */
export type CountyStructureFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class CountyStructureApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string = code,
    readonly issues: readonly CsvIssue[] = [],
  ) {
    super(message);
    this.name = "CountyStructureApiError";
  }
}

export interface CountyDetailResponse {
  readonly county: { readonly fips: string; readonly name: string };
  readonly version: number;
  readonly counts: CountyStructureCounts;
  readonly roots: readonly UnitNode[];
}

export interface LinkedRoleResponse {
  readonly id: string;
  readonly personRoleId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly listing: "home" | "elected_official" | "department_leader";
  readonly unitId: string | null;
  readonly title: string | null;
}

export interface HistoryEntry {
  readonly seq: number;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly createdAt?: string;
}

export interface EditPayload {
  readonly op: string;
  readonly [key: string]: unknown;
}

export interface CountyStructureClient {
  counties(): Promise<{
    readonly version: number;
    readonly counties: readonly CountySummary[];
  }>;
  county(fips: string): Promise<CountyDetailResponse>;
  exportCsv(
    fips?: string,
  ): Promise<{ readonly csv: string; readonly version: number }>;
  prepare(request: {
    readonly fileName: string;
    readonly csv: string;
    readonly mode: ImportMode;
    readonly countyFips: string | null;
  }): Promise<PreparedImport>;
  commit(
    importId: string,
    request: {
      readonly changesetSha256: string;
      readonly expectedVersion: number;
    },
    idempotencyKey: string,
  ): Promise<{
    readonly import: ImportSummary;
    readonly replayed: boolean;
    readonly noop: boolean;
  }>;
  reverse(
    importId: string,
    idempotencyKey: string,
  ): Promise<{ readonly import: ImportSummary; readonly replayed: boolean }>;
  imports(): Promise<{ readonly imports: readonly ImportSummary[] }>;
  history(
    entityId: string,
  ): Promise<{ readonly history: readonly HistoryEntry[] }>;
  edit(
    expectedVersion: number,
    edit: EditPayload,
  ): Promise<{
    readonly structureVersion: number;
    readonly entityId: string | null;
    readonly counts: ChangeCounts;
  }>;
  linkedRoles(
    unitId: string,
  ): Promise<{ readonly roles: readonly LinkedRoleResponse[] }>;
  previewRoleAttachments(request: {
    readonly csv: string;
    readonly countyFips: string;
  }): Promise<RoleAttachmentPreview>;
  commitRoleAttachments(
    request: {
      readonly csv: string;
      readonly countyFips: string;
      readonly digest: string;
    },
    idempotencyKey: string,
  ): Promise<RoleAttachmentReceipt>;
}

export function createCountyStructureClient(options: {
  readonly fetch: CountyStructureFetch;
}): CountyStructureClient {
  async function send(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await options.fetch(
        `${COUNTY_STRUCTURE_API_PREFIX}${path}`,
        init,
      );
    } catch {
      throw new CountyStructureApiError(0, "network_error");
    }
    if (!response.ok) {
      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      throw new CountyStructureApiError(
        response.status,
        typeof body.error === "string" ? body.error : "internal_error",
        typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : "internal_error",
        Array.isArray(body.issues) ? (body.issues as CsvIssue[]) : [],
      );
    }
    return response;
  }
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CountyStructureApiError(response.status, "invalid_response");
    }
  }
  const post = <T>(path: string, body: unknown, key?: string) =>
    call<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    counties: () => call("/counties"),
    county: (fips) => call(`/counties/${encodeURIComponent(fips)}`),
    async exportCsv(fips) {
      const response = await send(
        `/export${fips ? `?county=${encodeURIComponent(fips)}` : ""}`,
      );
      return {
        csv: await response.text(),
        version: Number(
          response.headers.get("x-county-structure-version") ?? 0,
        ),
      };
    },
    prepare: (request) => post("/imports", request),
    commit: (importId, request, key) =>
      post(`/imports/${encodeURIComponent(importId)}/commit`, request, key),
    reverse: (importId, key) =>
      post(`/imports/${encodeURIComponent(importId)}/reverse`, {}, key),
    imports: () => call("/imports"),
    history: (entityId) => call(`/history/${encodeURIComponent(entityId)}`),
    edit: (expectedVersion, edit) => post("/edits", { expectedVersion, edit }),
    linkedRoles: (unitId) => call(`/units/${encodeURIComponent(unitId)}/roles`),
    previewRoleAttachments: (request) =>
      post("/role-attachments/preview", request),
    commitRoleAttachments: (request, key) =>
      post("/role-attachments/commit", request, key),
  };
}

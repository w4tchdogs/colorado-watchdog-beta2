import {
  type AlternateNameList,
  type MatchingProfileVisibilityPreview,
  type MatchingProfileVisibilityReceipt,
  PROFILES_API_PREFIX,
  type ProfileChange,
  type ProfileChangeIssue,
  type ProfileFacets,
  type ProfilePage,
  type ProfilePreview,
  type ProfileQuery,
  type ProfileSaveResult,
  type ProfileSelectionEntry,
  type ProfileUnitLinkPreview,
  type ProfileUnitLinkReceipt,
  type ProfileUnitSuggestion,
  type ProfileUnitSuggestions,
} from "../contracts/profiles.js";
import type {
  ProfileDeletePreview,
  ProfileDeleteReason,
  ProfileDeleteReceipt,
} from "../contracts/profiles-delete.js";
import {
  PROFILES_IMPORT_PREFIX,
  type ProfilesImportPreview,
  type ProfilesImportReceipt,
  type ProfilesImportReversal,
  type ProfilesImportSource,
} from "../contracts/profiles-import.js";

/**
 * Browser client for the protected `/api/admin/profiles/*` routes. It only
 * builds requests and surfaces results. Authorization, expected versions and
 * idempotency stay on the server, and a response is never treated as
 * permission. The browser sends the Website session cookie and nothing else.
 */
export type ProfilesFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class ProfilesApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues: readonly ProfileChangeIssue[] = [],
    /** Import failures carry their own issue list (file, line, code, message). */
    readonly detail: readonly unknown[] = [],
    message = code,
  ) {
    super(message);
    this.name = "ProfilesApiError";
  }
}

export interface ProfilesClient {
  rows(query: ProfileQuery): Promise<ProfilePage>;
  exportCsv(query: ProfileQuery, columns: readonly string[]): Promise<Blob>;
  facets(): Promise<ProfileFacets>;
  suggestUnits(roleId: string): Promise<ProfileUnitSuggestions>;
  linkSuggestedUnit(
    roleId: string,
    unit: ProfileUnitSuggestion,
    key: string,
  ): Promise<ProfileUnitLinkReceipt>;
  previewUnitLinks(query: ProfileQuery): Promise<ProfileUnitLinkPreview>;
  commitUnitLinks(
    query: ProfileQuery,
    digest: string,
    key: string,
  ): Promise<ProfileUnitLinkReceipt>;
  selectAll(query: ProfileQuery): Promise<{
    readonly entries: readonly ProfileSelectionEntry[];
    readonly truncated: boolean;
  }>;
  previewMatchingVisibility(
    query: ProfileQuery,
    visible: boolean,
  ): Promise<MatchingProfileVisibilityPreview>;
  saveMatchingVisibility(
    query: ProfileQuery,
    visible: boolean,
    digest: string,
    idempotencyKey: string,
  ): Promise<MatchingProfileVisibilityReceipt>;
  /** One Profile's alternate names with private evidence. Owner only. */
  alternateNames(profileId: string): Promise<AlternateNameList>;
  deletePreview(profileId: string): Promise<ProfileDeletePreview>;
  deleteProfile(
    input: {
      readonly profileId: string;
      readonly digest: string;
      readonly reason: ProfileDeleteReason;
      readonly confirmation: string;
    },
    idempotencyKey: string,
  ): Promise<ProfileDeleteReceipt>;
  preview(changes: readonly ProfileChange[]): Promise<ProfilePreview>;
  save(
    changes: readonly ProfileChange[],
    idempotencyKey: string,
  ): Promise<ProfileSaveResult>;
  /** Read-only. Sends file contents and receives exact adds, updates and conflicts. */
  importPreview(
    source: ProfilesImportSource,
    readdProfileId?: string,
  ): Promise<ProfilesImportPreview>;
  importCommit(
    source: ProfilesImportSource,
    digest: string,
    idempotencyKey: string,
    readdProfileId?: string,
  ): Promise<ProfilesImportReceipt>;
  importReverse(
    batchId: string,
    idempotencyKey: string,
  ): Promise<ProfilesImportReversal>;
}

function queryString(query: ProfileQuery, paged: boolean): string {
  const params = new URLSearchParams();
  if (query.query) params.set("query", query.query);
  if (query.countyFips) params.set("county", query.countyFips);
  if (query.office) params.set("office", query.office);
  if (query.visibility !== "all") params.set("visibility", query.visibility);
  if (query.unitLink && query.unitLink !== "all")
    params.set("unitLink", query.unitLink);
  params.set("sort", query.sort);
  params.set("direction", query.direction);
  if (paged) {
    params.set("page", String(query.page));
    params.set("pageSize", String(query.pageSize));
  }
  return params.toString();
}

export function createProfilesClient(options: {
  readonly fetch: ProfilesFetch;
}): ProfilesClient {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await options.fetch(`${PROFILES_API_PREFIX}${path}`, init);
    } catch {
      throw new ProfilesApiError(0, "network_error");
    }
  }

  async function readJson<T>(response: Response): Promise<T> {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new ProfilesApiError(
        response.status,
        typeof body.error === "string" ? body.error : "internal_error",
        Array.isArray(body.issues) ? (body.issues as ProfileChangeIssue[]) : [],
        Array.isArray(body.issues) ? body.issues : [],
        body.error === "invalid_workbook" && typeof body.message === "string"
          ? body.message
          : undefined,
      );
    }
    return body as T;
  }
  const call = async <T>(path: string, init?: RequestInit) =>
    readJson<T>(await request(path, init));
  const post = (
    path: string,
    changes: readonly ProfileChange[],
    key?: string,
  ) =>
    call<never>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify({ changes }),
    });
  const importPost = <T>(name: string, body: unknown, key?: string) =>
    call<T>(
      `${PROFILES_IMPORT_PREFIX.slice(PROFILES_API_PREFIX.length)}/${name}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: JSON.stringify(body),
      },
    );
  const matchingVisibilityPost = <T>(
    operation: "preview" | "save",
    query: ProfileQuery,
    visible: boolean,
    review?: { digest: string; key: string },
  ) =>
    call<T>(`/matching-visibility/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(review ? { "idempotency-key": review.key } : {}),
      },
      body: JSON.stringify({
        filters: {
          query: query.query,
          county: query.countyFips,
          office: query.office,
          visibility: query.visibility,
          unitLink: query.unitLink,
        },
        visible,
        ...(review ? { digest: review.digest } : {}),
      }),
    });
  const unitLinkPost = <T>(
    operation: "preview" | "commit",
    query: ProfileQuery,
    review?: { digest: string; key: string },
  ) =>
    call<T>(`/unit-links/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(review ? { "idempotency-key": review.key } : {}),
      },
      body: JSON.stringify({
        filters: {
          query: query.query,
          county: query.countyFips,
          office: query.office,
          visibility: query.visibility,
          unitLink: query.unitLink,
        },
        ...(review ? { digest: review.digest } : {}),
      }),
    });
  return {
    suggestUnits: (roleId) =>
      call("/unit-links/suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId }),
      }),
    linkSuggestedUnit: (roleId, unit, key) =>
      call("/unit-links/choose", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          roleId,
          unitId: unit.unitId,
          digest: unit.digest,
        }),
      }),
    previewUnitLinks: (query) =>
      unitLinkPost<ProfileUnitLinkPreview>("preview", query),
    commitUnitLinks: (query, digest, key) =>
      unitLinkPost<ProfileUnitLinkReceipt>("commit", query, { digest, key }),
    previewMatchingVisibility: (query, visible) =>
      matchingVisibilityPost<MatchingProfileVisibilityPreview>(
        "preview",
        query,
        visible,
      ),
    saveMatchingVisibility: (query, visible, digest, key) =>
      matchingVisibilityPost<MatchingProfileVisibilityReceipt>(
        "save",
        query,
        visible,
        { digest, key },
      ),
    deletePreview: (profileId) =>
      call("/delete/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId }),
      }),
    deleteProfile: (input, key) =>
      call("/delete/commit", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(input),
      }),
    importPreview: (source, readdProfileId) =>
      importPost<ProfilesImportPreview>("preview", {
        ...("workbook" in source ? source : { files: source }),
        readdProfileId,
      }),
    importCommit: (source, digest, key, readdProfileId) =>
      importPost<ProfilesImportReceipt>(
        "commit",
        {
          ...("workbook" in source ? source : { files: source }),
          digest,
          readdProfileId,
        },
        key,
      ),
    importReverse: (batchId, key) =>
      importPost<ProfilesImportReversal>("reverse", { batchId }, key),
    rows: (query) => call<ProfilePage>(`/rows?${queryString(query, true)}`),
    async exportCsv(query, columns) {
      const params = new URLSearchParams(queryString(query, false));
      params.set("columns", columns.join(","));
      const response = await request(`/export?${params}`);
      if (!response.ok) await readJson(response);
      if (response.headers.get("content-type")?.split(";")[0] !== "text/csv")
        throw new ProfilesApiError(500, "internal_error");
      return response.blob();
    },
    async facets() {
      const first = await call<ProfileFacets>("/facets");
      const offices = [...first.offices];
      let cursor = first.nextOfficeCursor;
      while (cursor) {
        const params = new URLSearchParams({ afterOffice: cursor });
        const page = await call<ProfileFacets>(`/facets?${params}`);
        offices.push(...page.offices);
        cursor = page.nextOfficeCursor;
      }
      return { ...first, offices, nextOfficeCursor: null };
    },
    selectAll: (query) => call(`/select-all?${queryString(query, false)}`),
    alternateNames: (profileId) =>
      call<AlternateNameList>(
        `/names?${new URLSearchParams({ profileId }).toString()}`,
      ),
    preview: (changes) => post("/preview", changes) as Promise<ProfilePreview>,
    save: (changes, key) =>
      post("/save", changes, key) as Promise<ProfileSaveResult>,
  };
}

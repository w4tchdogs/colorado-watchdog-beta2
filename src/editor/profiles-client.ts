import {
  PROFILES_API_PREFIX,
  type ProfileChange,
  type ProfileChangeIssue,
  type ProfileFacets,
  type ProfilePage,
  type ProfilePreview,
  type ProfileQuery,
  type ProfileSaveResult,
  type ProfileSelectionEntry,
} from "../contracts/profiles.js";

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
  ) {
    super(code);
    this.name = "ProfilesApiError";
  }
}

export interface ProfilesClient {
  rows(query: ProfileQuery): Promise<ProfilePage>;
  facets(): Promise<ProfileFacets>;
  selectAll(query: ProfileQuery): Promise<{
    readonly entries: readonly ProfileSelectionEntry[];
    readonly truncated: boolean;
  }>;
  preview(changes: readonly ProfileChange[]): Promise<ProfilePreview>;
  save(
    changes: readonly ProfileChange[],
    idempotencyKey: string,
  ): Promise<ProfileSaveResult>;
}

function queryString(query: ProfileQuery, paged: boolean): string {
  const params = new URLSearchParams();
  if (query.query) params.set("query", query.query);
  if (query.countyFips) params.set("county", query.countyFips);
  if (query.office) params.set("office", query.office);
  if (query.visibility !== "all") params.set("visibility", query.visibility);
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
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await options.fetch(`${PROFILES_API_PREFIX}${path}`, init);
    } catch {
      throw new ProfilesApiError(0, "network_error");
    }
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
      );
    }
    return body as T;
  }
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
  return {
    rows: (query) => call<ProfilePage>(`/rows?${queryString(query, true)}`),
    facets: () => call<ProfileFacets>("/facets"),
    selectAll: (query) => call(`/select-all?${queryString(query, false)}`),
    preview: (changes) => post("/preview", changes) as Promise<ProfilePreview>,
    save: (changes, key) =>
      post("/save", changes, key) as Promise<ProfileSaveResult>,
  };
}

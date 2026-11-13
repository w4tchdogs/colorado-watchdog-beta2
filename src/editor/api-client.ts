import type {
  DirectoryLookupRequest,
  DirectoryLookupResult,
  OrganizationLookupItem,
  PersonLookupItem,
} from "../contracts/editor-lookup.js";
import type {
  ContentDraftChanges,
  ContentItem,
  ContentListRequest,
  ContentPage,
  ContentRelationshipsInput,
  ContentRevision,
  ContentRevisionListRequest,
  ContentRevisionPage,
  NewContentDraft,
} from "../contracts/content.js";

/**
 * Browser-side client for the internal editorial API. It only builds requests
 * and surfaces results. Every business rule, version check and authorization
 * decision stays on the server. Responses are never treated as permission.
 */
export const EDITOR_API_PATHS = {
  createDraft: "/internal/content/drafts/create",
  getDraft: "/internal/content/drafts/get",
  listDrafts: "/internal/content/drafts/list",
  updateDraft: "/internal/content/drafts/update",
  setRelationships: "/internal/content/drafts/relationships",
  archiveDraft: "/internal/content/drafts/archive",
  restoreDraft: "/internal/content/drafts/restore",
  listRevisions: "/internal/content/revisions/list",
  getRevision: "/internal/content/revisions/get",
  restoreRevision: "/internal/content/revisions/restore",
} as const;
export const SANDBOX_INFO_PATH = "/sandbox/info";
export const SANDBOX_LOOKUP_PATH = "/sandbox/lookup";
export const SANDBOX_TOKEN_HEADER = "x-editor-token";
export const SANDBOX_ACCOUNT_HEADER = "x-test-human-subject";

export type EditorErrorCode =
  | "authentication_required"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "invalid_state"
  | "invalid_relationship"
  | "invalid_request"
  | "request_too_large"
  | "operation_unavailable"
  | "dependency_unavailable"
  | "network_error"
  | "internal_error";

export class EditorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: EditorErrorCode,
  ) {
    super(code);
    this.name = "EditorApiError";
  }
}

export interface SandboxInfo {
  readonly sandbox: true;
  readonly accounts: readonly {
    readonly key: string;
    readonly label: string;
  }[];
  readonly counties: readonly {
    readonly fips: string;
    readonly name: string;
  }[];
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<Response>;

export interface EditorApiClientOptions {
  readonly fetch: FetchLike;
  /** Sandbox only: the per-launch token the local server embeds in the page. */
  readonly token: string;
  /** Sandbox only: which synthetic account the request speaks for. */
  readonly account: () => string;
}

export interface EditorApiClient {
  sandboxInfo(): Promise<SandboxInfo>;
  /** Sandbox only: bounded search or exact-ID check of people. */
  lookupPeople(
    request: Omit<DirectoryLookupRequest, "kind">,
  ): Promise<DirectoryLookupResult<PersonLookupItem>>;
  /** Sandbox only: bounded search or exact-ID check of organizations. */
  lookupOrganizations(
    request: Omit<DirectoryLookupRequest, "kind">,
  ): Promise<DirectoryLookupResult<OrganizationLookupItem>>;
  createDraft(input: NewContentDraft): Promise<ContentItem>;
  getDraft(id: string): Promise<ContentItem>;
  listDrafts(request: ContentListRequest): Promise<ContentPage>;
  updateDraft(
    id: string,
    expectedVersion: number,
    changes: ContentDraftChanges,
  ): Promise<ContentItem>;
  setRelationships(
    id: string,
    expectedVersion: number,
    relationships: ContentRelationshipsInput,
  ): Promise<ContentItem>;
  archiveDraft(id: string, expectedVersion: number): Promise<ContentItem>;
  restoreDraft(id: string, expectedVersion: number): Promise<ContentItem>;
  listRevisions(
    id: string,
    request: ContentRevisionListRequest,
  ): Promise<ContentRevisionPage>;
  getRevision(id: string, version: number): Promise<ContentRevision>;
  restoreRevision(
    id: string,
    expectedVersion: number,
    revisionVersion: number,
  ): Promise<ContentItem>;
}

const KNOWN_CODES = new Set<string>([
  "authentication_required",
  "forbidden",
  "not_found",
  "version_conflict",
  "invalid_state",
  "invalid_relationship",
  "invalid_request",
  "request_too_large",
  "operation_unavailable",
  "dependency_unavailable",
  "internal_error",
]);

export function createEditorApiClient(
  options: EditorApiClientOptions,
): EditorApiClient {
  async function send<T>(
    path: string,
    method: "GET" | "POST",
    payload?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await options.fetch(path, {
        method,
        headers: {
          [SANDBOX_TOKEN_HEADER]: options.token,
          [SANDBOX_ACCOUNT_HEADER]: options.account(),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
      });
    } catch {
      throw new EditorApiError(0, "network_error");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const code =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : "internal_error";
      throw new EditorApiError(
        response.status,
        (KNOWN_CODES.has(code) ? code : "internal_error") as EditorErrorCode,
      );
    }
    if (typeof body !== "object" || body === null) {
      throw new EditorApiError(response.status, "internal_error");
    }
    return body as T;
  }

  const post = <T>(path: string, payload: unknown) =>
    send<T>(path, "POST", payload);

  return {
    sandboxInfo: () => send<SandboxInfo>(SANDBOX_INFO_PATH, "GET"),
    lookupPeople: (request) =>
      post(SANDBOX_LOOKUP_PATH, { kind: "person", ...request }),
    lookupOrganizations: (request) =>
      post(SANDBOX_LOOKUP_PATH, { kind: "organization", ...request }),
    createDraft: (input) => post(EDITOR_API_PATHS.createDraft, input),
    getDraft: (id) => post(EDITOR_API_PATHS.getDraft, { id }),
    listDrafts: (request) => post(EDITOR_API_PATHS.listDrafts, request),
    updateDraft: (id, expectedVersion, changes) =>
      post(EDITOR_API_PATHS.updateDraft, { id, expectedVersion, changes }),
    setRelationships: (id, expectedVersion, relationships) =>
      post(EDITOR_API_PATHS.setRelationships, {
        id,
        expectedVersion,
        relationships,
      }),
    archiveDraft: (id, expectedVersion) =>
      post(EDITOR_API_PATHS.archiveDraft, { id, expectedVersion }),
    restoreDraft: (id, expectedVersion) =>
      post(EDITOR_API_PATHS.restoreDraft, { id, expectedVersion }),
    listRevisions: (id, request) =>
      post(EDITOR_API_PATHS.listRevisions, { id, ...request }),
    getRevision: (id, version) =>
      post(EDITOR_API_PATHS.getRevision, { id, version }),
    restoreRevision: (id, expectedVersion, revisionVersion) =>
      post(EDITOR_API_PATHS.restoreRevision, {
        id,
        expectedVersion,
        revisionVersion,
      }),
  };
}

const MESSAGES: Readonly<Record<EditorErrorCode, string>> = {
  authentication_required: "Sign in as a sandbox account to continue.",
  forbidden: "This sandbox account is not allowed to do that.",
  not_found: "That article or revision could not be found.",
  version_conflict:
    "Someone else changed this article after you opened it. Your text is still here.",
  invalid_state:
    "That action is not available for the article's current state (archived articles must be restored first).",
  invalid_relationship:
    "A selected county, person or organization is no longer available. Unavailable records are marked in the Relationships panel. Remove them and save again.",
  invalid_request:
    "The server rejected the input. Check the title, text and selected relationships.",
  request_too_large: "The article is too large to send.",
  operation_unavailable: "This editorial operation is not available right now.",
  dependency_unavailable:
    "A required service is not available. Try again shortly.",
  network_error: "Could not reach the local editor server.",
  internal_error: "Something went wrong on the server. Nothing was changed.",
};

export function describeError(error: unknown): string {
  if (error instanceof EditorApiError) {
    return MESSAGES[error.code];
  }
  return MESSAGES.internal_error;
}

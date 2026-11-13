import type { TrustedPrincipal } from "../services/security.js";

/**
 * Native Posts and Stories content contract (internal, not yet exposed).
 *
 * Bodies are Markdown source text. They are never trusted HTML: any future
 * renderer must escape or strip raw HTML and sanitize link targets.
 * Relationships are explicit Website IDs for navigation and context only.
 * They never assert employment, identity, or any personnel fact.
 */

export const CONTENT_TYPES = ["post", "story"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_STATUSES = ["draft", "archived"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_BODY_FORMAT = "markdown" as const;

export const MAX_CONTENT_TITLE_LENGTH = 200;
export const MAX_CONTENT_SUMMARY_LENGTH = 500;
export const MAX_CONTENT_BODY_BYTES = 200_000;
export const MAX_CONTENT_RELATIONSHIPS_PER_KIND = 50;

export const DEFAULT_CONTENT_PAGE_SIZE = 25;
export const MAX_CONTENT_PAGE_SIZE = 100;

export type ContentAction =
  | "content.create"
  | "content.read"
  | "content.update"
  | "content.archive"
  | "content.restore"
  | "content.revision.read"
  | "content.revision.restore";

export interface ContentRelationships {
  /** Five-digit Colorado county FIPS codes. */
  readonly countyFips: readonly string[];
  readonly personIds: readonly string[];
  readonly organizationIds: readonly string[];
}

/** Omitted kinds are left unchanged. An empty array clears that kind. */
export type ContentRelationshipsInput = Partial<ContentRelationships>;

export interface NewContentDraft {
  readonly contentType: ContentType;
  readonly title: string;
  readonly summary?: string | null;
  readonly body?: string;
  readonly relationships?: ContentRelationshipsInput;
}

export interface ContentDraftChanges {
  readonly title?: string;
  readonly summary?: string | null;
  readonly body?: string;
  readonly relationships?: ContentRelationshipsInput;
}

export interface ContentItem {
  readonly id: string;
  readonly contentType: ContentType;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly bodyFormat: typeof CONTENT_BODY_FORMAT;
  readonly status: ContentStatus;
  readonly version: number;
  readonly createdByAccountId: string;
  readonly lastEditedByAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly relationships: ContentRelationships;
}

/** Listing omits the body and relationships. */
export type ContentSummary = Omit<ContentItem, "body" | "relationships">;

export interface ContentListRequest {
  readonly status?: ContentStatus;
  readonly contentType?: ContentType;
  readonly limit?: number;
  readonly afterId?: string | null;
}

export interface ContentPage {
  readonly items: readonly ContentSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Injected authorization policy. The content service denies every action
 * unless the host supplies one. No account role grants content access here.
 */
export type ContentAuthorizationPolicy = (
  principal: TrustedPrincipal,
  action: ContentAction,
) => boolean;

export const CONTENT_REVISION_KINDS = [
  "baseline",
  "create",
  "update",
  "relationships",
  "archive",
  "restore_draft",
  "restore_revision",
] as const;
export type ContentRevisionKind = (typeof CONTENT_REVISION_KINDS)[number];

/**
 * An immutable snapshot of the editable state recorded by one successful
 * mutation. `baseline` marks content that predates revision history and holds
 * its state when history began. Earlier states were never captured.
 */
export interface ContentRevision {
  readonly contentId: string;
  readonly version: number;
  readonly changeKind: ContentRevisionKind;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly bodyFormat: typeof CONTENT_BODY_FORMAT;
  readonly status: ContentStatus;
  readonly relationships: ContentRelationships;
  readonly editedByAccountId: string;
  readonly recordedAt: string;
  /** Set only for `restore_revision`: the earlier version that was restored. */
  readonly restoredFromVersion: number | null;
}

/** Revision listings omit the body and relationships. */
export type ContentRevisionSummary = Omit<
  ContentRevision,
  "body" | "relationships"
>;

export interface ContentRevisionListRequest {
  readonly limit?: number;
  /** Return revisions older than this version (newest first). */
  readonly beforeVersion?: number | null;
}

export interface ContentRevisionPage {
  readonly items: readonly ContentRevisionSummary[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

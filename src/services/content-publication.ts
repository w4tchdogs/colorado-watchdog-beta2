import {
  ARTICLE_SLUG,
  CONTENT_ID,
  EDITORIAL_PATHWAYS,
  type EditorialLabel,
  type PublicationMetadata,
  type PublicationReceipt,
  type PublicationRequest,
  type PublishRequest,
} from "../contracts/publication.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import type { AsyncD1Database } from "../database/d1.js";
import { StaleVersionError } from "../database/versioned-writes.js";
import { safeExternalUrl } from "../site/html.js";
import { assertCredentialFree } from "./audit.js";
import {
  ContentInputError,
  ContentNotFoundError,
  ContentStateError,
} from "./content.js";
import {
  AuthorizationError,
  newId,
  type TrustedPrincipal,
} from "./security.js";

export class ContentSlugConflictError extends Error {}

function record(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function validText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

function validLabel(value: unknown): value is EditorialLabel {
  return (
    record(value, ["slug", "label"]) &&
    typeof value.slug === "string" &&
    value.slug.length <= 60 &&
    ARTICLE_SLUG.test(value.slug) &&
    validText(value.label, 100)
  );
}

function validSource(value: unknown): boolean {
  if (
    !record(value, ["title", "url"]) ||
    !validText(value.title, 200) ||
    typeof value.url !== "string" ||
    !/^https?:\/\//i.test(value.url) ||
    /[\s\\]/.test(value.url)
  ) {
    return false;
  }
  return safeExternalUrl(value.url) !== null;
}

export function validPublicationMetadata(
  value: unknown,
): value is PublicationMetadata {
  if (
    !record(value, ["byline", "sources", "pathway", "series", "topics"]) ||
    !validText(value.byline, 200)
  )
    return false;
  if (
    value.pathway !== undefined &&
    !EDITORIAL_PATHWAYS.some((pathway) => pathway === value.pathway)
  )
    return false;
  if (value.series !== undefined && !validLabel(value.series)) return false;
  if (
    value.topics !== undefined &&
    (!Array.isArray(value.topics) ||
      value.topics.length > 12 ||
      !value.topics.every(validLabel) ||
      new Set(value.topics.map((topic: EditorialLabel) => topic.slug)).size !==
        value.topics.length)
  )
    return false;
  return (
    value.sources === undefined ||
    (Array.isArray(value.sources) &&
      value.sources.length <= 20 &&
      value.sources.every(validSource))
  );
}

export function validPublicationRequest(
  value: unknown,
  publish: boolean,
): boolean {
  const keys = ["id", "expectedVersion", "expectedPublicationVersion"];
  if (
    !record(value, publish ? [...keys, "slug", "metadata"] : keys) ||
    typeof value.id !== "string" ||
    !CONTENT_ID.test(value.id) ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 1 ||
    typeof value.expectedPublicationVersion !== "number" ||
    !Number.isSafeInteger(value.expectedPublicationVersion) ||
    value.expectedPublicationVersion < (publish ? 0 : 1) ||
    value.expectedPublicationVersion === Number.MAX_SAFE_INTEGER
  )
    return false;
  return (
    !publish ||
    (typeof value.slug === "string" &&
      ARTICLE_SLUG.test(value.slug) &&
      validPublicationMetadata(value.metadata))
  );
}

interface WorkingState {
  content_type: string;
  draft_version: number;
  draft_status: string;
  eligible_revision: number;
  slug: string | null;
  publication_version: number | null;
  revision_version: number | null;
  withdrawn_at: string | null;
}

export function createContentPublicationService(
  database: AsyncD1Database,
  authorize: (principal: TrustedPrincipal) => Promise<boolean>,
) {
  async function change(
    principal: TrustedPrincipal,
    request: PublicationRequest,
    publication: PublishRequest | null,
  ): Promise<PublicationReceipt> {
    async function requireCapability() {
      if (!(await authorize(principal))) throw new AuthorizationError();
    }

    async function checkState() {
      await requireCapability();
      const state = await database.first<WorkingState>(
        `SELECT i.content_type, i.version AS draft_version, i.status AS draft_status,
                EXISTS (SELECT 1 FROM content_revisions r WHERE r.content_id=i.id AND r.version=i.version
                  AND r.status='draft' AND length(trim(r.body, char(9,10,13,32))) > 0) AS eligible_revision,
                p.slug, p.version AS publication_version, p.revision_version, p.withdrawn_at
         FROM content_items i LEFT JOIN content_publications p ON p.content_id=i.id WHERE i.id=?`,
        [request.id],
      );
      if (!state) throw new ContentNotFoundError();
      if (
        state.draft_version !== request.expectedVersion ||
        (state.publication_version ?? 0) !== request.expectedPublicationVersion
      )
        throw new StaleVersionError();
      const live = state.slug !== null && state.withdrawn_at === null;
      if (
        publication
          ? live ||
            state.draft_status !== "draft" ||
            state.eligible_revision !== 1
          : !live
      )
        throw new ContentStateError("Invalid publication transition");
      if (publication) {
        if (state.slug !== null && state.slug !== publication.slug)
          throw new ContentSlugConflictError();
        const collision = await database.first(
          "SELECT 1 FROM content_publications WHERE content_type=? AND slug=? AND content_id<>?",
          [state.content_type, publication.slug, request.id],
        );
        if (collision) throw new ContentSlugConflictError();
      }
      return state;
    }

    await requireCapability();
    if (!validPublicationRequest(request, publication !== null))
      throw new ContentInputError();
    const state = await checkState();
    const generation = await database.readDependencyGeneration();
    const slug = publication?.slug ?? state.slug;
    const revisionVersion = publication
      ? state.draft_version
      : state.revision_version;
    if (slug === null || revisionVersion === null)
      throw new ContentStateError("Missing publication state");
    const publicationVersion = request.expectedPublicationVersion + 1;
    const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    const action = publication ? "content.publish" : "content.withdraw";
    const details = { publicationVersion, revisionVersion };
    const summary = publication
      ? "Published a content revision"
      : "Withdrew a published revision";
    assertCredentialFree({
      action,
      targetType: "content_item",
      targetId: request.id,
      summary,
      details,
    });
    const mutation = publication
      ? database.prepare(
          `INSERT INTO content_publications
             (content_id,content_type,slug,revision_version,version,published_at,published_by_account_id,metadata_json)
           SELECT i.id,i.content_type,?,i.version,?,${now},?,?
           FROM content_items i JOIN content_revisions r ON r.content_id=i.id AND r.version=i.version
           WHERE i.id=? AND i.version=? AND i.status='draft'
             AND (COALESCE((SELECT version FROM content_publications WHERE content_id=i.id),0)=?)
           ON CONFLICT(content_id) DO UPDATE SET
             revision_version=excluded.revision_version,version=excluded.version,published_at=excluded.published_at,
             published_by_account_id=excluded.published_by_account_id,metadata_json=excluded.metadata_json,withdrawn_at=NULL
           WHERE content_publications.withdrawn_at IS NOT NULL AND content_publications.slug=excluded.slug`,
          [
            slug,
            publicationVersion,
            principal.accountId,
            JSON.stringify(publication.metadata),
            request.id,
            request.expectedVersion,
            request.expectedPublicationVersion,
          ],
        )
      : database.prepare(
          `UPDATE content_publications SET withdrawn_at=${now},version=?
           WHERE content_id=? AND version=? AND withdrawn_at IS NULL
             AND EXISTS (SELECT 1 FROM content_items WHERE id=? AND version=?)`,
          [
            publicationVersion,
            request.id,
            request.expectedPublicationVersion,
            request.id,
            request.expectedVersion,
          ],
        );
    const auditId = newId();
    try {
      await database.guardedBatch(generation, principal, [
        mutation,
        database.prepare(
          "INSERT INTO website_write_assertions (id,valid) VALUES (?,changes())",
          [auditId],
        ),
        database.prepare(
          `INSERT INTO audit_events (id,actor_account_id,action,target_type,target_id,summary,details_json)
           VALUES (?,?,?,'content_item',?,?,?)`,
          [
            auditId,
            principal.accountId,
            action,
            request.id,
            summary,
            JSON.stringify(details),
          ],
        ),
      ]);
    } catch {
      // Classify a competing write or revoked identity without exposing SQL.
      await checkState();
      throw new StorageUnavailableError();
    }
    return {
      contentId: request.id,
      slug,
      publicationVersion,
      revisionVersion,
      status: publication ? "published" : "withdrawn",
    };
  }

  return {
    publish: (principal: TrustedPrincipal, request: PublishRequest) =>
      change(principal, request, request),
    withdraw: (principal: TrustedPrincipal, request: PublicationRequest) =>
      change(principal, request, null),
  };
}

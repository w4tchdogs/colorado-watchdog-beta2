import {
  CONTENT_BODY_FORMAT,
  CONTENT_REVISION_KINDS,
  CONTENT_SORTS,
  CONTENT_STATUSES,
  CONTENT_TYPES,
  type ContentAction,
  type ContentAuthorizationPolicy,
  type ContentDraftChanges,
  type ContentItem,
  type ContentListRequest,
  type ContentPage,
  type ContentRelationships,
  type ContentRelationshipsInput,
  type ContentRevision,
  type ContentRevisionKind,
  type ContentRevisionListRequest,
  type ContentRevisionPage,
  type ContentRevisionSummary,
  type ContentStatus,
  type ContentSummary,
  type ContentType,
  DEFAULT_CONTENT_PAGE_SIZE,
  MAX_CONTENT_BODY_BYTES,
  MAX_CONTENT_CURSOR_LENGTH,
  MAX_CONTENT_PAGE_SIZE,
  MAX_CONTENT_RELATIONSHIPS_PER_KIND,
  MAX_CONTENT_SEARCH_LENGTH,
  MAX_CONTENT_SEARCH_TERMS,
  MAX_CONTENT_SUMMARY_LENGTH,
  MAX_CONTENT_TITLE_LENGTH,
  type NewContentDraft,
} from "../contracts/content.js";
import type { WebsiteDatabase } from "../database/sqlite.js";
import { StaleVersionError } from "../database/versioned-writes.js";
import { runAuditedMutation } from "./audit.js";
import {
  AuthorizationError,
  isCurrentPrincipal,
  newId,
  type TrustedPrincipal,
} from "./security.js";

export class ContentInputError extends Error {
  constructor(message = "Invalid content input") {
    super(message);
    this.name = "ContentInputError";
  }
}

export class ContentNotFoundError extends Error {
  constructor() {
    super("Content item not found");
    this.name = "ContentNotFoundError";
  }
}

export class ContentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentStateError";
  }
}

export class ContentRelationshipError extends Error {
  constructor(kind: "county" | "person" | "organization") {
    super(`Referenced ${kind} does not exist`);
    this.name = "ContentRelationshipError";
  }
}

/** Default-deny. No role or account receives content access from this module. */
export const denyAllContentPolicy: ContentAuthorizationPolicy = () => false;

export interface ContentService {
  createDraft(principal: TrustedPrincipal, input: NewContentDraft): ContentItem;
  getDraft(principal: TrustedPrincipal, id: string): ContentItem | null;
  updateDraft(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    changes: ContentDraftChanges,
  ): ContentItem;
  setRelationships(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    relationships: ContentRelationshipsInput,
  ): ContentItem;
  listDrafts(
    principal: TrustedPrincipal,
    request?: ContentListRequest,
  ): ContentPage;
  archiveDraft(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
  ): ContentItem;
  restoreDraft(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
  ): ContentItem;
  /** Newest first. Requires `content.revision.read`. */
  listRevisions(
    principal: TrustedPrincipal,
    id: string,
    request?: ContentRevisionListRequest,
  ): ContentRevisionPage;
  /** Requires `content.revision.read`. */
  getRevision(
    principal: TrustedPrincipal,
    id: string,
    version: number,
  ): ContentRevision | null;
  /**
   * Copies an earlier revision's title, summary, body and relationships into a
   * new current version. Requires `content.revision.restore`.
   */
  restoreRevision(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    revisionVersion: number,
  ): ContentItem;
}

export interface ContentServiceOptions {
  /** Absent means deny every action. */
  readonly authorize?: ContentAuthorizationPolicy;
}

type RelationshipKind = keyof ContentRelationships;
const RELATIONSHIP_KINDS: readonly RelationshipKind[] = [
  "countyFips",
  "personIds",
  "organizationIds",
];

const RELATIONSHIP_TABLES = {
  countyFips: { table: "content_item_counties", column: "county_fips" },
  personIds: { table: "content_item_people", column: "person_id" },
  organizationIds: {
    table: "content_item_organizations",
    column: "organization_id",
  },
} as const;

const TARGET_TABLES = {
  countyFips: { table: "counties", column: "fips", kind: "county" },
  personIds: { table: "people", column: "id", kind: "person" },
  organizationIds: {
    table: "organizations",
    column: "id",
    kind: "organization",
  },
} as const;

const COUNTY_FIPS = /^\d{5}$/;
const MAX_ID_LENGTH = 128;

export function createContentService(
  database: WebsiteDatabase,
  options: ContentServiceOptions = {},
): ContentService {
  const policy = options.authorize ?? denyAllContentPolicy;

  /** Fails closed on inactive principals, denied actions, and policy errors. */
  const authorize = (
    principal: TrustedPrincipal,
    action: ContentAction,
  ): void => {
    let allowed = false;
    try {
      allowed =
        isCurrentPrincipal(database, principal) &&
        policy(principal, action) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new AuthorizationError();
    }
  };

  const mutate = (
    principal: TrustedPrincipal,
    action: ContentAction,
    audit: {
      readonly auditAction: string;
      readonly targetId: string;
      readonly summary: string;
      readonly details: Readonly<Record<string, string | number | boolean>>;
      readonly revisionKind: ContentRevisionKind;
      readonly restoredFromVersion?: number;
    },
    mutation: () => void,
  ): ContentItem => {
    authorize(principal, action);
    return runAuditedMutation(
      database,
      { principal },
      {
        action: audit.auditAction,
        targetType: "content_item",
        targetId: audit.targetId,
        summary: audit.summary,
        details: audit.details,
      },
      () => {
        // Recheck inside the transaction so a concurrent revocation is honored.
        authorize(principal, action);
        mutation();
        return recordRevision(
          database,
          audit.targetId,
          audit.revisionKind,
          audit.restoredFromVersion ?? null,
        );
      },
    );
  };

  return {
    createDraft(principal, input) {
      authorize(principal, "content.create");
      const draft = validateNewDraft(input);
      const id = newId();
      return mutate(
        principal,
        "content.create",
        {
          revisionKind: "create",
          auditAction: "content.create",
          targetId: id,
          summary: "Created a content draft",
          details: {
            contentType: draft.contentType,
            version: 1,
            hasRelationships: hasAnyRelationship(draft.relationships),
          },
        },
        () => {
          database
            .prepare(
              `INSERT INTO content_items
                 (id, content_type, title, summary, body,
                  created_by_account_id, last_edited_by_account_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              draft.contentType,
              draft.title,
              draft.summary,
              draft.body,
              principal.accountId,
              principal.accountId,
            );
          replaceRelationships(database, id, draft.relationships);
        },
      );
    },

    getDraft(principal, id) {
      authorize(principal, "content.read");
      return findItem(database, validateId(id));
    },

    updateDraft(principal, id, expectedVersion, changes) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const update = validateChanges(changes);
      return mutate(
        principal,
        "content.update",
        {
          revisionKind: "update",
          auditAction: "content.update",
          targetId: target,
          summary: "Updated a content draft",
          details: {
            fields: update.fields.join(","),
            version: version + 1,
          },
        },
        () => {
          const assignments = [...update.columns.map(([column]) => column)];
          applyVersionedChange(
            database,
            target,
            version,
            "draft",
            "draft",
            principal,
            assignments,
            update.columns.map(([, value]) => value),
          );
          replaceRelationships(database, target, update.relationships);
        },
      );
    },

    setRelationships(principal, id, expectedVersion, relationships) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const normalized = normalizeRelationships(relationships);
      if (!hasAnyKind(normalized)) {
        throw new ContentInputError();
      }
      return mutate(
        principal,
        "content.update",
        {
          revisionKind: "relationships",
          auditAction: "content.relationships.set",
          targetId: target,
          summary: "Replaced content relationships",
          details: {
            kinds: Object.keys(normalized).sort().join(","),
            version: version + 1,
          },
        },
        () => {
          applyVersionedChange(
            database,
            target,
            version,
            "draft",
            "draft",
            principal,
            [],
            [],
          );
          replaceRelationships(database, target, normalized);
        },
      );
    },

    listDrafts(principal, request = {}) {
      authorize(principal, "content.read");
      return listItems(database, request);
    },

    archiveDraft(principal, id, expectedVersion) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      return mutate(
        principal,
        "content.archive",
        {
          revisionKind: "archive",
          auditAction: "content.archive",
          targetId: target,
          summary: "Archived a content draft",
          details: { version: version + 1 },
        },
        () => {
          applyVersionedChange(
            database,
            target,
            version,
            "draft",
            "archived",
            principal,
            [],
            [],
          );
        },
      );
    },

    restoreDraft(principal, id, expectedVersion) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      return mutate(
        principal,
        "content.restore",
        {
          revisionKind: "restore_draft",
          auditAction: "content.restore",
          targetId: target,
          summary: "Restored an archived content draft",
          details: { version: version + 1 },
        },
        () => {
          applyVersionedChange(
            database,
            target,
            version,
            "archived",
            "draft",
            principal,
            [],
            [],
          );
        },
      );
    },

    listRevisions(principal, id, request = {}) {
      authorize(principal, "content.revision.read");
      return listRevisionPage(database, validateId(id), request);
    },

    getRevision(principal, id, version) {
      authorize(principal, "content.revision.read");
      return findRevision(
        database,
        validateId(id),
        validateExpectedVersion(version),
      );
    },

    restoreRevision(principal, id, expectedVersion, revisionVersion) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const source = validateExpectedVersion(revisionVersion);
      if (source >= version) {
        throw new ContentInputError();
      }
      let restored: ContentRevision | null = null;
      return mutate(
        principal,
        "content.revision.restore",
        {
          revisionKind: "restore_revision",
          restoredFromVersion: source,
          auditAction: "content.revision.restore",
          targetId: target,
          summary: "Restored an earlier content revision",
          details: { fromVersion: source, version: version + 1 },
        },
        () => {
          const current = database
            .prepare("SELECT status, version FROM content_items WHERE id = ?")
            .get(target);
          if (!current) {
            throw new ContentNotFoundError();
          }
          if (current.status !== "draft") {
            throw new ContentStateError(
              "Archived content must be restored before it can change",
            );
          }
          if (current.version !== version) {
            throw new StaleVersionError();
          }
          restored = findRevision(database, target, source);
          if (!restored) {
            throw new ContentNotFoundError();
          }
          applyVersionedChange(
            database,
            target,
            version,
            "draft",
            "draft",
            principal,
            ["title", "summary", "body"],
            [restored.title, restored.summary, restored.body],
          );
          replaceRelationships(database, target, restored.relationships);
        },
      );
    },
  };
}

/**
 * Checks existence, required status and expected version, then writes one
 * version increment. Must run inside the caller's transaction.
 */
function applyVersionedChange(
  database: WebsiteDatabase,
  id: string,
  expectedVersion: number,
  requiredStatus: ContentStatus,
  nextStatus: ContentStatus,
  principal: TrustedPrincipal,
  columns: readonly string[],
  values: readonly (string | null)[],
): void {
  const current = database
    .prepare("SELECT status FROM content_items WHERE id = ?")
    .get(id);
  if (!current) {
    throw new ContentNotFoundError();
  }
  if (current.status !== requiredStatus) {
    throw new ContentStateError(
      requiredStatus === "draft"
        ? "Archived content must be restored before it can change"
        : "Only archived content can be restored",
    );
  }

  const assignments = columns
    .map((column) => `"${column}" = ?`)
    .concat([
      '"status" = ?',
      '"archived_at" = ?',
      '"last_edited_by_account_id" = ?',
      '"version" = "version" + 1',
      "\"updated_at\" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ])
    .join(", ");
  const archivedAt =
    nextStatus === "archived"
      ? (database
          .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now")
          .get()?.now as string)
      : null;
  const row = database
    .prepare(
      `UPDATE content_items SET ${assignments}
       WHERE id = ? AND version = ? AND status = ? RETURNING version`,
    )
    .get(
      ...values,
      nextStatus,
      archivedAt,
      principal.accountId,
      id,
      expectedVersion,
      requiredStatus,
    );
  if (!row) {
    throw new StaleVersionError();
  }
}

function replaceRelationships(
  database: WebsiteDatabase,
  contentId: string,
  relationships: ContentRelationshipsInput,
): void {
  for (const kind of RELATIONSHIP_KINDS) {
    const targets = relationships[kind];
    if (targets === undefined) {
      continue;
    }
    const link = RELATIONSHIP_TABLES[kind];
    const target = TARGET_TABLES[kind];
    for (const targetId of targets) {
      const exists = database
        .prepare(
          `SELECT 1 AS found FROM ${target.table} WHERE ${target.column} = ?`,
        )
        .get(targetId);
      if (!exists) {
        throw new ContentRelationshipError(target.kind);
      }
    }
    database
      .prepare(`DELETE FROM ${link.table} WHERE content_id = ?`)
      .run(contentId);
    for (const targetId of targets) {
      database
        .prepare(
          `INSERT INTO ${link.table} (content_id, ${link.column}) VALUES (?, ?)`,
        )
        .run(contentId, targetId);
    }
  }
}

function recordRevision(
  database: WebsiteDatabase,
  id: string,
  kind: ContentRevisionKind,
  restoredFromVersion: number | null,
): ContentItem {
  const item = readItem(database, id);
  database
    .prepare(
      `INSERT INTO content_revisions
         (content_id, version, change_kind, title, summary, body, status,
          county_fips_json, person_ids_json, organization_ids_json,
          edited_by_account_id, restored_from_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      item.version,
      kind,
      item.title,
      item.summary,
      item.body,
      item.status,
      JSON.stringify(item.relationships.countyFips),
      JSON.stringify(item.relationships.personIds),
      JSON.stringify(item.relationships.organizationIds),
      item.lastEditedByAccountId,
      restoredFromVersion,
    );
  return item;
}

const REVISION_SUMMARY_COLUMNS = `content_id, version, change_kind, title,
  summary, status, edited_by_account_id, restored_from_version, recorded_at`;

function findRevision(
  database: WebsiteDatabase,
  id: string,
  version: number,
): ContentRevision | null {
  const row = database
    .prepare(
      `SELECT ${REVISION_SUMMARY_COLUMNS}, body, county_fips_json,
              person_ids_json, organization_ids_json
       FROM content_revisions WHERE content_id = ? AND version = ?`,
    )
    .get(id, version);
  if (!row) {
    return null;
  }
  return {
    ...revisionSummaryFromRow(row),
    body: asString(row.body),
    relationships: {
      countyFips: parseIdArray(row.county_fips_json),
      personIds: parseIdArray(row.person_ids_json),
      organizationIds: parseIdArray(row.organization_ids_json),
    },
  };
}

function listRevisionPage(
  database: WebsiteDatabase,
  id: string,
  request: ContentRevisionListRequest,
): ContentRevisionPage {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new ContentInputError();
  }
  rejectUnknownKeys(request as Record<string, unknown>, [
    "limit",
    "beforeVersion",
  ]);
  const limit = request.limit ?? DEFAULT_CONTENT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENT_PAGE_SIZE) {
    throw new ContentInputError();
  }
  const before = request.beforeVersion ?? null;
  if (before !== null) {
    validateExpectedVersion(before);
  }
  if (
    !database
      .prepare("SELECT 1 AS found FROM content_items WHERE id = ?")
      .get(id)
  ) {
    throw new ContentNotFoundError();
  }
  const rows = database
    .prepare(
      `SELECT ${REVISION_SUMMARY_COLUMNS}
       FROM content_revisions
       WHERE content_id = ? AND (? IS NULL OR version < ?)
       ORDER BY version DESC LIMIT ?`,
    )
    .all(id, before, before, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(revisionSummaryFromRow);
  return {
    items,
    hasMore,
    nextCursor: hasMore ? (items.at(-1)?.version ?? null) : null,
  };
}

function revisionSummaryFromRow(
  row: Record<string, unknown>,
): ContentRevisionSummary {
  if (
    !CONTENT_REVISION_KINDS.includes(row.change_kind as ContentRevisionKind) ||
    !CONTENT_STATUSES.includes(row.status as ContentStatus)
  ) {
    throw new Error("Invalid content revision record");
  }
  return {
    contentId: asString(row.content_id),
    version: asNumber(row.version),
    changeKind: row.change_kind as ContentRevisionKind,
    title: asString(row.title),
    summary: row.summary === null ? null : asString(row.summary),
    bodyFormat: CONTENT_BODY_FORMAT,
    status: row.status as ContentStatus,
    editedByAccountId: asString(row.edited_by_account_id),
    recordedAt: asString(row.recorded_at),
    restoredFromVersion:
      row.restored_from_version === null
        ? null
        : asNumber(row.restored_from_version),
  };
}

function parseIdArray(value: unknown): string[] {
  const parsed: unknown = JSON.parse(asString(value));
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Invalid content revision record");
  }
  return parsed as string[];
}

function readItem(database: WebsiteDatabase, id: string): ContentItem {
  const item = findItem(database, id);
  if (!item) {
    throw new ContentNotFoundError();
  }
  return item;
}

function findItem(database: WebsiteDatabase, id: string): ContentItem | null {
  const row = database
    .prepare(
      `SELECT id, content_type, title, summary, body, body_format, status,
              version, created_by_account_id, last_edited_by_account_id,
              created_at, updated_at, archived_at
       FROM content_items WHERE id = ?`,
    )
    .get(id);
  if (!row) {
    return null;
  }
  const relationships = (kind: RelationshipKind): string[] => {
    const link = RELATIONSHIP_TABLES[kind];
    return database
      .prepare(
        `SELECT ${link.column} AS target FROM ${link.table}
         WHERE content_id = ? ORDER BY ${link.column} COLLATE BINARY`,
      )
      .all(id)
      .map((entry) => asString(entry.target));
  };
  return {
    ...summaryFromRow(row),
    body: asString(row.body),
    relationships: {
      countyFips: relationships("countyFips"),
      personIds: relationships("personIds"),
      organizationIds: relationships("organizationIds"),
    },
  };
}

const SORTABLE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODIFIED_CURSOR_PREFIX = "m1~";
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control input
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** Returns one escaped LIKE pattern per search term. */
function parseSearch(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new ContentInputError();
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_CONTENT_SEARCH_LENGTH) {
    throw new ContentInputError();
  }
  if (trimmed.length === 0) return [];
  const terms = trimmed.split(/\s+/u);
  if (terms.length > MAX_CONTENT_SEARCH_TERMS) {
    throw new ContentInputError();
  }
  return terms.map((term) => `%${term.replace(/[\\%_]/gu, "\\$&")}%`);
}

function parseModifiedCursor(value: string): {
  readonly updatedAt: string;
  readonly id: string;
} {
  if (value.length > MAX_CONTENT_CURSOR_LENGTH) throw new ContentInputError();
  if (!value.startsWith(MODIFIED_CURSOR_PREFIX)) throw new ContentInputError();
  const parts = value.slice(MODIFIED_CURSOR_PREFIX.length).split("~");
  const [updatedAt, id] = parts;
  if (
    parts.length !== 2 ||
    updatedAt === undefined ||
    id === undefined ||
    !CURSOR_TIMESTAMP.test(updatedAt) ||
    Number.isNaN(Date.parse(updatedAt)) ||
    !SORTABLE_ID.test(id)
  ) {
    throw new ContentInputError();
  }
  return { updatedAt, id };
}

function listItems(
  database: WebsiteDatabase,
  request: ContentListRequest,
): ContentPage {
  if (!request || typeof request !== "object") {
    throw new ContentInputError();
  }
  const limit = request.limit ?? DEFAULT_CONTENT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENT_PAGE_SIZE) {
    throw new ContentInputError();
  }
  const status = request.status ?? null;
  if (status !== null && !CONTENT_STATUSES.includes(status)) {
    throw new ContentInputError();
  }
  const contentType = request.contentType ?? null;
  if (contentType !== null && !CONTENT_TYPES.includes(contentType)) {
    throw new ContentInputError();
  }
  const sort = request.sort === undefined ? "id" : request.sort;
  if (!CONTENT_SORTS.includes(sort)) {
    throw new ContentInputError();
  }
  const afterId = request.afterId ?? null;
  const cursor = request.cursor ?? null;
  if (afterId !== null) {
    validateId(afterId);
    // An ID cursor belongs to ID ordering only.
    if (sort !== "id" || !SORTABLE_ID.test(afterId)) {
      throw new ContentInputError();
    }
  }
  if (cursor !== null) {
    if (sort !== "modified" || typeof cursor !== "string") {
      throw new ContentInputError();
    }
  }
  const patterns = parseSearch(request.search);

  const conditions = [
    "(? IS NULL OR status = ?)",
    "(? IS NULL OR content_type = ?)",
  ];
  const params: (string | number | null)[] = [
    status,
    status,
    contentType,
    contentType,
  ];
  for (const pattern of patterns) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  let order: string;
  if (sort === "modified") {
    if (cursor !== null) {
      const position = parseModifiedCursor(cursor);
      conditions.push(
        "(updated_at < ? OR (updated_at = ? AND id COLLATE BINARY < ?))",
      );
      params.push(position.updatedAt, position.updatedAt, position.id);
    }
    order = "updated_at DESC, id COLLATE BINARY DESC";
  } else {
    if (afterId !== null) {
      conditions.push("id > ?");
      params.push(afterId);
    }
    order = "id COLLATE BINARY";
  }

  const rows = database
    .prepare(
      `SELECT id, content_type, title, summary, body_format, status, version,
              created_by_account_id, last_edited_by_account_id,
              created_at, updated_at, archived_at
       FROM content_items
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY ${order} LIMIT ?`,
    )
    .all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(summaryFromRow);
  const last = items.at(-1);
  let nextCursor: string | null = null;
  if (hasMore && last) {
    nextCursor =
      sort === "modified"
        ? `${MODIFIED_CURSOR_PREFIX}${last.updatedAt}~${last.id}`
        : last.id;
  }
  return { items, hasMore, nextCursor };
}

function summaryFromRow(row: Record<string, unknown>): ContentSummary {
  if (
    !CONTENT_TYPES.includes(row.content_type as ContentType) ||
    !CONTENT_STATUSES.includes(row.status as ContentStatus) ||
    row.body_format !== CONTENT_BODY_FORMAT
  ) {
    throw new Error("Invalid content record");
  }
  return {
    id: asString(row.id),
    contentType: row.content_type as ContentType,
    title: asString(row.title),
    summary: row.summary === null ? null : asString(row.summary),
    bodyFormat: CONTENT_BODY_FORMAT,
    status: row.status as ContentStatus,
    version: asNumber(row.version),
    createdByAccountId: asString(row.created_by_account_id),
    lastEditedByAccountId: asString(row.last_edited_by_account_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    archivedAt: row.archived_at === null ? null : asString(row.archived_at),
  };
}

interface ValidatedDraft {
  readonly contentType: ContentType;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly relationships: ContentRelationshipsInput;
}

function validateNewDraft(input: NewContentDraft): ValidatedDraft {
  if (!isRecord(input)) {
    throw new ContentInputError();
  }
  rejectUnknownKeys(input, [
    "contentType",
    "title",
    "summary",
    "body",
    "relationships",
  ]);
  if (!CONTENT_TYPES.includes(input.contentType)) {
    throw new ContentInputError();
  }
  return {
    contentType: input.contentType,
    title: validateTitle(input.title),
    summary: validateSummary(input.summary ?? null),
    body: validateBody(input.body ?? ""),
    relationships: normalizeRelationships(input.relationships ?? {}),
  };
}

function validateChanges(changes: ContentDraftChanges): {
  readonly fields: string[];
  readonly columns: [string, string | null][];
  readonly relationships: ContentRelationshipsInput;
} {
  if (!isRecord(changes)) {
    throw new ContentInputError();
  }
  rejectUnknownKeys(changes, ["title", "summary", "body", "relationships"]);
  const fields: string[] = [];
  const columns: [string, string | null][] = [];
  if (changes.title !== undefined) {
    fields.push("title");
    columns.push(["title", validateTitle(changes.title)]);
  }
  if (changes.summary !== undefined) {
    fields.push("summary");
    columns.push(["summary", validateSummary(changes.summary)]);
  }
  if (changes.body !== undefined) {
    fields.push("body");
    columns.push(["body", validateBody(changes.body)]);
  }
  const relationships = normalizeRelationships(changes.relationships ?? {});
  if (changes.relationships !== undefined) {
    if (!hasAnyKind(relationships)) {
      throw new ContentInputError();
    }
    fields.push("relationships");
  }
  if (fields.length === 0) {
    throw new ContentInputError();
  }
  return { fields, columns, relationships };
}

function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new ContentInputError();
  }
  const title = value.trim();
  if (
    title.length === 0 ||
    [...title].length > MAX_CONTENT_TITLE_LENGTH ||
    hasControlCharacter(title)
  ) {
    throw new ContentInputError();
  }
  return title;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function validateSummary(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ContentInputError();
  }
  const summary = value.trim();
  if (
    summary.length === 0 ||
    [...summary].length > MAX_CONTENT_SUMMARY_LENGTH ||
    summary.includes("\u0000")
  ) {
    throw new ContentInputError();
  }
  return summary;
}

function validateBody(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    new TextEncoder().encode(value).length > MAX_CONTENT_BODY_BYTES
  ) {
    throw new ContentInputError();
  }
  return value;
}

function normalizeRelationships(value: unknown): ContentRelationshipsInput {
  if (!isRecord(value)) {
    throw new ContentInputError();
  }
  rejectUnknownKeys(value, RELATIONSHIP_KINDS);
  const normalized: {
    countyFips?: string[];
    personIds?: string[];
    organizationIds?: string[];
  } = {};
  for (const kind of RELATIONSHIP_KINDS) {
    const targets = value[kind];
    if (targets === undefined) {
      continue;
    }
    if (!Array.isArray(targets)) {
      throw new ContentInputError();
    }
    const unique = [...new Set(targets.map((target) => validateId(target)))];
    if (
      unique.length > MAX_CONTENT_RELATIONSHIPS_PER_KIND ||
      (kind === "countyFips" && unique.some((fips) => !COUNTY_FIPS.test(fips)))
    ) {
      throw new ContentInputError();
    }
    normalized[kind] = unique.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }
  return normalized;
}

function hasAnyKind(relationships: ContentRelationshipsInput): boolean {
  return RELATIONSHIP_KINDS.some((kind) => relationships[kind] !== undefined);
}

function hasAnyRelationship(relationships: ContentRelationshipsInput): boolean {
  return RELATIONSHIP_KINDS.some(
    (kind) => (relationships[kind]?.length ?? 0) > 0,
  );
}

function validateId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value !== value.trim()
  ) {
    throw new ContentInputError();
  }
  return value;
}

function validateExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ContentInputError();
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ContentInputError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid content record");
  }
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Invalid content record");
  }
  return value;
}

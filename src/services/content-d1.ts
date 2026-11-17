import type {
  ContentCheckpoint,
  ContentDraftChanges,
  ContentItem,
  ContentListRequest,
  ContentPage,
  ContentRelationshipsInput,
  ContentRevision,
  ContentRevisionKind,
  ContentRevisionListRequest,
  ContentRevisionPage,
  ContentStatus,
  NewContentDraft,
} from "../contracts/content.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { StaleVersionError } from "../database/versioned-writes.js";
import { assertCredentialFree } from "./audit.js";
import {
  asString,
  ContentInputError,
  ContentNotFoundError,
  ContentRelationshipError,
  ContentStateError,
  contentPageFromRows,
  hasAnyKind,
  hasAnyRelationship,
  normalizeRelationships,
  parseIdArray,
  planContentList,
  planRevisionList,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_TABLES,
  REVISION_LIST_SQL,
  REVISION_SUMMARY_COLUMNS,
  type RelationshipKind,
  revisionPageFromRows,
  revisionSummaryFromRow,
  summaryFromRow,
  TARGET_TABLES,
  validateChanges,
  validateCheckpoints,
  validateExpectedVersion,
  validateId,
  validateNewDraft,
} from "./content.js";
import {
  AuthorizationError,
  newId,
  type TrustedPrincipal,
} from "./security.js";

/** The draft service contract of `createContentService`, over asynchronous D1. */
export interface AsyncContentService {
  createDraft(
    principal: TrustedPrincipal,
    input: NewContentDraft,
  ): Promise<ContentItem>;
  getDraft(
    principal: TrustedPrincipal,
    id: string,
  ): Promise<ContentItem | null>;
  updateDraft(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    changes: ContentDraftChanges,
  ): Promise<ContentItem>;
  setRelationships(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    relationships: ContentRelationshipsInput,
  ): Promise<ContentItem>;
  listDrafts(
    principal: TrustedPrincipal,
    request?: ContentListRequest,
  ): Promise<ContentPage>;
  archiveDraft(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
  ): Promise<ContentItem>;
  restoreDraft(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
  ): Promise<ContentItem>;
  saveWithCheckpoints(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    checkpoints: readonly ContentCheckpoint[],
    changes: ContentDraftChanges,
  ): Promise<ContentItem>;
  listRevisions(
    principal: TrustedPrincipal,
    id: string,
    request?: ContentRevisionListRequest,
  ): Promise<ContentRevisionPage>;
  getRevision(
    principal: TrustedPrincipal,
    id: string,
    version: number,
  ): Promise<ContentRevision | null>;
  restoreRevision(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    revisionVersion: number,
  ): Promise<ContentItem>;
}
type Row = Record<string, unknown>;
const MAX_RELATIONSHIP_ROWS = 100;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

interface Change {
  readonly id: string;
  readonly kind: ContentRevisionKind;
  readonly auditAction: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly restoredFromVersion?: number;
  /** Re-reads the state this change depends on. Throws a typed error if invalid. */
  readonly check: () => Promise<void>;
  /** Statements that apply the change, in order, before the revision and audit. */
  readonly apply: () => D1BatchStatement[];
}

/**
 * Draft editing over the asynchronous Website D1. Behavior, validation, errors
 * and stored records match `createContentService`. D1 has no interactive
 * transaction, so each change is one atomic `guardedBatch`: the versioned write,
 * a write assertion that aborts the batch when no row matched, the relationship
 * rows, the revision snapshot and the audit event. A competing write, a stale
 * version or a revoked identity therefore changes nothing.
 *
 * `authorize` is the live capability check for the draft routes. It runs before
 * any read or write and again when a batch fails, and the batch itself asserts
 * the current principal.
 */
export function createD1ContentService(
  database: AsyncD1Database,
  authorize: (principal: TrustedPrincipal) => Promise<boolean>,
): AsyncContentService {
  async function require(principal: TrustedPrincipal): Promise<void> {
    let allowed = false;
    try {
      allowed = (await authorize(principal)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new AuthorizationError();
  }

  async function relationshipsOf(
    id: string,
    kind: RelationshipKind,
  ): Promise<string[]> {
    const link = RELATIONSHIP_TABLES[kind];
    const rows = await database.all<Row>(
      `SELECT ${link.column} AS target FROM ${link.table}
       WHERE content_id = ? ORDER BY ${link.column} COLLATE BINARY`,
      MAX_RELATIONSHIP_ROWS,
      [id],
    );
    return rows.map((entry) => asString(entry.target));
  }

  async function findItem(id: string): Promise<ContentItem | null> {
    const row = await database.first<Row>(
      `SELECT id, content_type, title, summary, body, body_format, status,
              version, created_by_account_id, last_edited_by_account_id,
              created_at, updated_at, archived_at
       FROM content_items WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    return {
      ...summaryFromRow(row),
      body: asString(row.body),
      relationships: {
        countyFips: await relationshipsOf(id, "countyFips"),
        personIds: await relationshipsOf(id, "personIds"),
        organizationIds: await relationshipsOf(id, "organizationIds"),
      },
    };
  }

  async function readItem(id: string): Promise<ContentItem> {
    const item = await findItem(id);
    if (!item) throw new ContentNotFoundError();
    return item;
  }

  async function findRevision(
    id: string,
    version: number,
  ): Promise<ContentRevision | null> {
    const row = await database.first<Row>(
      `SELECT ${REVISION_SUMMARY_COLUMNS}, body, county_fips_json,
              person_ids_json, organization_ids_json
       FROM content_revisions WHERE content_id = ? AND version = ?`,
      [id, version],
    );
    if (!row) return null;
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

  /** Same order as the synchronous service: missing, status, then version. */
  async function checkVersioned(
    id: string,
    expectedVersion: number,
    requiredStatus: ContentStatus,
  ): Promise<void> {
    const current = await database.first<Row>(
      "SELECT status, version FROM content_items WHERE id = ?",
      [id],
    );
    if (!current) throw new ContentNotFoundError();
    if (current.status !== requiredStatus)
      throw new ContentStateError(
        requiredStatus === "draft"
          ? "Archived content must be restored before it can change"
          : "Only archived content can be restored",
      );
    if (current.version !== expectedVersion) throw new StaleVersionError();
  }

  async function checkTargets(
    relationships: ContentRelationshipsInput,
  ): Promise<void> {
    for (const kind of RELATIONSHIP_KINDS) {
      const target = TARGET_TABLES[kind];
      for (const targetId of relationships[kind] ?? []) {
        const exists = await database.first(
          `SELECT 1 AS found FROM ${target.table} WHERE ${target.column} = ?`,
          [targetId],
        );
        if (!exists) throw new ContentRelationshipError(target.kind);
      }
    }
  }

  function relationshipStatements(
    id: string,
    relationships: ContentRelationshipsInput,
  ): D1BatchStatement[] {
    const statements: D1BatchStatement[] = [];
    for (const kind of RELATIONSHIP_KINDS) {
      const targets = relationships[kind];
      if (targets === undefined) continue;
      const link = RELATIONSHIP_TABLES[kind];
      statements.push(
        database.prepare(`DELETE FROM ${link.table} WHERE content_id = ?`, [
          id,
        ]),
      );
      for (const targetId of targets)
        statements.push(
          database.prepare(
            `INSERT INTO ${link.table} (content_id, ${link.column}) VALUES (?, ?)`,
            [id, targetId],
          ),
        );
    }
    return statements;
  }

  /** One version increment guarded by id, version and status. */
  function versionedUpdate(
    id: string,
    expectedVersion: number,
    requiredStatus: ContentStatus,
    nextStatus: ContentStatus,
    principal: TrustedPrincipal,
    columns: readonly [string, string | null][],
  ): D1BatchStatement[] {
    const assignments = [
      ...columns.map(([column]) => `"${column}" = ?`),
      '"status" = ?',
      `"archived_at" = ${nextStatus === "archived" ? NOW : "NULL"}`,
      '"last_edited_by_account_id" = ?',
      '"version" = "version" + 1',
      `"updated_at" = ${NOW}`,
    ].join(", ");
    return [
      database.prepare(
        `UPDATE content_items SET ${assignments}
         WHERE id = ? AND version = ? AND status = ?`,
        [
          ...columns.map(([, value]) => value),
          nextStatus,
          principal.accountId,
          id,
          expectedVersion,
          requiredStatus,
        ],
      ),
      // Aborts the whole batch when the guarded update matched no row.
      database.prepare(
        "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes())",
        [newId()],
      ),
    ];
  }

  function revisionStatement(
    id: string,
    kind: ContentRevisionKind,
    restoredFromVersion: number | null,
    checkpointLabel: string | null = null,
  ): D1BatchStatement {
    const ids = (table: string, column: string) =>
      `COALESCE((SELECT json_group_array(${column}) FROM (
         SELECT ${column} FROM ${table}
         WHERE content_id = i.id ORDER BY ${column} COLLATE BINARY)), '[]')`;
    return database.prepare(
      `INSERT INTO content_revisions
         (content_id, version, change_kind, title, summary, body, status,
          county_fips_json, person_ids_json, organization_ids_json,
          edited_by_account_id, restored_from_version, checkpoint_label)
       SELECT i.id, i.version, ?, i.title, i.summary, i.body, i.status,
         ${ids("content_item_counties", "county_fips")},
         ${ids("content_item_people", "person_id")},
         ${ids("content_item_organizations", "organization_id")},
         i.last_edited_by_account_id, ?, ?
       FROM content_items i WHERE i.id = ?`,
      [kind, restoredFromVersion, checkpointLabel, id],
    );
  }

  async function commit(
    principal: TrustedPrincipal,
    change: Change,
  ): Promise<ContentItem> {
    const audit = {
      action: change.auditAction,
      targetType: "content_item",
      targetId: change.id,
      summary: change.summary,
      details: change.details,
    };
    assertCredentialFree(audit);
    await require(principal);
    await change.check();
    const generation = await database.readDependencyGeneration();
    try {
      await database.guardedBatch(generation, principal, [
        ...change.apply(),
        revisionStatement(
          change.id,
          change.kind,
          change.restoredFromVersion ?? null,
        ),
        database.prepare(
          `INSERT INTO audit_events
             (id, actor_account_id, action, target_type, target_id, summary, details_json)
           VALUES (?, ?, ?, 'content_item', ?, ?, ?)`,
          [
            newId(),
            principal.accountId,
            change.auditAction,
            change.id,
            change.summary,
            JSON.stringify(change.details),
          ],
        ),
      ]);
    } catch {
      // Classify a competing write or revoked identity without exposing SQL.
      await require(principal);
      await change.check();
      throw new StorageUnavailableError();
    }
    return readItem(change.id);
  }

  return {
    async createDraft(principal, input) {
      await require(principal);
      const draft = validateNewDraft(input);
      const id = newId();
      await checkTargets(draft.relationships);
      return commit(principal, {
        id,
        kind: "create",
        auditAction: "content.create",
        summary: "Created a content draft",
        details: {
          contentType: draft.contentType,
          version: 1,
          hasRelationships: hasAnyRelationship(draft.relationships),
        },
        check: () => checkTargets(draft.relationships),
        apply: () => [
          database.prepare(
            `INSERT INTO content_items
               (id, content_type, title, summary, body,
                created_by_account_id, last_edited_by_account_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              draft.contentType,
              draft.title,
              draft.summary,
              draft.body,
              principal.accountId,
              principal.accountId,
            ],
          ),
          ...relationshipStatements(id, draft.relationships),
        ],
      });
    },

    async getDraft(principal, id) {
      await require(principal);
      return findItem(validateId(id));
    },

    async updateDraft(principal, id, expectedVersion, changes) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const update = validateChanges(changes);
      await require(principal);
      return commit(principal, {
        id: target,
        kind: "update",
        auditAction: "content.update",
        summary: "Updated a content draft",
        details: { fields: update.fields.join(","), version: version + 1 },
        check: async () => {
          await checkVersioned(target, version, "draft");
          await checkTargets(update.relationships);
        },
        apply: () => [
          ...versionedUpdate(
            target,
            version,
            "draft",
            "draft",
            principal,
            update.columns,
          ),
          ...relationshipStatements(target, update.relationships),
        ],
      });
    },

    async saveWithCheckpoints(
      principal,
      id,
      expectedVersion,
      checkpoints,
      changes,
    ) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const steps = validateCheckpoints(checkpoints);
      const final = validateChanges(changes);
      await require(principal);
      return commit(principal, {
        id: target,
        kind: "update",
        auditAction: "content.update",
        summary: "Saved a content draft with AI checkpoints",
        details: {
          fields: final.fields.join(","),
          checkpoints: steps.length,
          version: version + steps.length + 1,
        },
        check: async () => {
          await checkVersioned(target, version, "draft");
          for (const step of steps) await checkTargets(step.relationships);
          await checkTargets(final.relationships);
        },
        apply: () => {
          const statements: D1BatchStatement[] = [];
          let current = version;
          for (const step of steps) {
            statements.push(
              ...versionedUpdate(
                target,
                current,
                "draft",
                "draft",
                principal,
                step.columns,
              ),
              ...relationshipStatements(target, step.relationships),
              revisionStatement(target, "update", null, step.label),
            );
            current += 1;
          }
          statements.push(
            ...versionedUpdate(
              target,
              current,
              "draft",
              "draft",
              principal,
              final.columns,
            ),
            ...relationshipStatements(target, final.relationships),
          );
          return statements;
        },
      });
    },

    async setRelationships(principal, id, expectedVersion, relationships) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const normalized = normalizeRelationships(relationships);
      if (!hasAnyKind(normalized)) throw new ContentInputError();
      await require(principal);
      return commit(principal, {
        id: target,
        kind: "relationships",
        auditAction: "content.relationships.set",
        summary: "Replaced content relationships",
        details: {
          kinds: Object.keys(normalized).sort().join(","),
          version: version + 1,
        },
        check: async () => {
          await checkVersioned(target, version, "draft");
          await checkTargets(normalized);
        },
        apply: () => [
          ...versionedUpdate(target, version, "draft", "draft", principal, []),
          ...relationshipStatements(target, normalized),
        ],
      });
    },

    async listDrafts(principal, request = {}) {
      await require(principal);
      const plan = planContentList(request);
      const rows = await database.all<Row>(
        plan.sql,
        plan.limit + 1,
        plan.params,
      );
      return contentPageFromRows(plan, rows);
    },

    async archiveDraft(principal, id, expectedVersion) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      await require(principal);
      return commit(principal, {
        id: target,
        kind: "archive",
        auditAction: "content.archive",
        summary: "Archived a content draft",
        details: { version: version + 1 },
        check: async () => {
          if (
            await database.first(
              "SELECT 1 FROM content_publications WHERE content_id = ? AND withdrawn_at IS NULL",
              [target],
            )
          )
            throw new ContentStateError(
              "Withdraw published content before archiving",
            );
          await checkVersioned(target, version, "draft");
        },
        apply: () =>
          versionedUpdate(target, version, "draft", "archived", principal, []),
      });
    },

    async restoreDraft(principal, id, expectedVersion) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      await require(principal);
      return commit(principal, {
        id: target,
        kind: "restore_draft",
        auditAction: "content.restore",
        summary: "Restored an archived content draft",
        details: { version: version + 1 },
        check: () => checkVersioned(target, version, "archived"),
        apply: () =>
          versionedUpdate(target, version, "archived", "draft", principal, []),
      });
    },

    async listRevisions(principal, id, request = {}) {
      await require(principal);
      const target = validateId(id);
      const { limit, before } = planRevisionList(request);
      if (
        !(await database.first(
          "SELECT 1 AS found FROM content_items WHERE id = ?",
          [target],
        ))
      )
        throw new ContentNotFoundError();
      const rows = await database.all<Row>(REVISION_LIST_SQL, limit + 1, [
        target,
        before,
        before,
        limit + 1,
      ]);
      return revisionPageFromRows(rows, limit);
    },

    async getRevision(principal, id, version) {
      await require(principal);
      return findRevision(validateId(id), validateExpectedVersion(version));
    },

    async restoreRevision(principal, id, expectedVersion, revisionVersion) {
      const target = validateId(id);
      const version = validateExpectedVersion(expectedVersion);
      const source = validateExpectedVersion(revisionVersion);
      if (source >= version) throw new ContentInputError();
      await require(principal);
      let restored: ContentRevision | null = null;
      return commit(principal, {
        id: target,
        kind: "restore_revision",
        restoredFromVersion: source,
        auditAction: "content.revision.restore",
        summary: "Restored an earlier content revision",
        details: { fromVersion: source, version: version + 1 },
        check: async () => {
          await checkVersioned(target, version, "draft");
          restored = await findRevision(target, source);
          if (!restored) throw new ContentNotFoundError();
          await checkTargets(restored.relationships);
        },
        apply: () => {
          if (!restored) throw new ContentNotFoundError();
          return [
            ...versionedUpdate(target, version, "draft", "draft", principal, [
              ["title", restored.title],
              ["summary", restored.summary],
              ["body", restored.body],
            ]),
            ...relationshipStatements(target, restored.relationships),
          ];
        },
      });
    },
  };
}

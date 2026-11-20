import {
  type ChangeAction,
  type ChangeCounts,
  type ChangeItem,
  type CountyStructureCounts,
  type CountySummary,
  type CsvIssue,
  DISPLAY_GROUP_TYPE,
  IMPORT_MODES,
  type ImportMode,
  type ImportSummary,
  MAX_CSV_BYTES,
  MAX_TEXT,
  ORGANIZATION_TYPES,
  type OrganizationType,
  type ParentRelationship,
  type PreparedImport,
  type StructureRecord,
  UNIT_STATUSES,
  type UnitNode,
  type UnitStatus,
} from "../contracts/county-structure.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { assertCredentialFree } from "./audit.js";
import { parseAliases, parseCountyCsv } from "./county-structure-csv.js";
import {
  canonicalRecord,
  dependencyDepth,
  exportCountyCsv,
  orderTree,
  validateStructure,
} from "./county-structure-model.js";
import {
  countItems,
  diffStructures,
  planImport,
  sha256Hex,
} from "./county-structure-plan.js";
import {
  AuthorizationError,
  newId,
  roleHasCapability,
  type TrustedPrincipal,
} from "./security.js";

/**
 * County Structure administration (COUNTY-DB-1) on the Website D1 binding.
 *
 * Every write is one atomic guarded batch that begins by asserting the
 * structure version the caller saw, so a stale or concurrent changeset fails as
 * a whole. Imports are two stages (prepare, then explicit commit). Dashboard
 * edits and reversals reuse the same apply path and write the same append-only
 * history. Only the owner holds `county_structure.manage`.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const PAGE = 1000;
const CHUNK_CHARS = 60_000;
const MAX_ATTEMPTS = 3;
const FIPS = /^08\d{3}$/;
const IMPORT_ID = /^[A-Za-z0-9-]{8,64}$/;
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export class CountyStructureValidationError extends Error {
  constructor(
    readonly issues: readonly CsvIssue[],
    message = "The county structure is not valid",
  ) {
    super(message);
    this.name = "CountyStructureValidationError";
  }
}

export class CountyStructureConflictError extends Error {
  constructor(
    readonly code:
      | "stale_version"
      | "already_committed"
      | "idempotency_reuse"
      | "blocked"
      | "not_reversible"
      | "not_prepared",
    message: string,
  ) {
    super(message);
    this.name = "CountyStructureConflictError";
  }
}

export class CountyStructureNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "CountyStructureNotFoundError";
  }
}

interface CreateFields {
  readonly countyFips: string;
  readonly name: string;
  readonly organizationType?: OrganizationType;
  readonly parentId?: string | null;
  readonly relationship?: "part_of" | "reports_to";
  readonly status?: UnitStatus;
  readonly displayOrder?: number | null;
  readonly aliases?: readonly { name: string; kind?: string }[];
  readonly appliesFrom?: string | null;
  readonly appliesUntil?: string | null;
  readonly evidence?: string | null;
  readonly sources?: string | null;
}

export type StructureEdit =
  | (CreateFields & { readonly op: "create_unit" })
  | (CreateFields & { readonly op: "create_group" })
  | {
      readonly op: "update";
      readonly id: string;
      readonly name?: string;
      readonly organizationType?: OrganizationType;
      readonly status?: UnitStatus;
      readonly displayOrder?: number | null;
      readonly aliases?: readonly { name: string; kind?: string }[];
      readonly appliesFrom?: string | null;
      readonly appliesUntil?: string | null;
      readonly evidence?: string | null;
      readonly sources?: string | null;
    }
  | {
      readonly op: "move";
      readonly id: string;
      /** A unit, a display grouping, or null for a top-level unit. */
      readonly parentId: string | null;
      /** `display_group` under a unit is browse placement, not reporting. */
      readonly relationship?: "part_of" | "reports_to" | "display_group";
    }
  | {
      readonly op: "reorder";
      readonly countyFips: string;
      readonly parentId: string | null;
      readonly orderedIds: readonly string[];
    }
  | { readonly op: "delete"; readonly id: string };

export interface EditRequest {
  readonly expectedVersion: number;
  readonly edit: StructureEdit;
}

export interface EditResult {
  readonly structureVersion: number;
  readonly entityId: string | null;
  readonly counts: ChangeCounts;
}

export interface CountyDetail {
  readonly county: { readonly fips: string; readonly name: string };
  readonly version: number;
  readonly counts: CountyStructureCounts;
  readonly roots: readonly UnitNode[];
}

export interface LinkedRole {
  readonly id: string;
  readonly personRoleId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly listing: "home" | "elected_official" | "department_leader";
  readonly unitId: string | null;
  readonly title: string | null;
}

interface ApplyContext {
  readonly principal: TrustedPrincipal;
  readonly baseVersion: number;
  readonly source: "import" | "dashboard" | "reversal";
  readonly importId: string | null;
  readonly commitKey: string | null;
  readonly expectedUnits: number;
  readonly extra: readonly D1BatchStatement[];
  readonly auditAction: string;
  readonly auditSummary: string;
  readonly auditDetails: Record<string, string>;
}

export class D1CountyStructureAdministration {
  constructor(
    private readonly database: AsyncD1Database,
    private readonly newIdentifier: () => string = newId,
  ) {}

  // ------------------------------------------------------------- authority

  private async authorize(principal: TrustedPrincipal): Promise<void> {
    if (!roleHasCapability(principal.role, "county_structure.manage"))
      throw new AuthorizationError();
    const live = await this.database.first(
      `SELECT 1 AS ok FROM identities i JOIN accounts a ON a.id = i.account_id
       WHERE a.id = ? AND i.id = ? AND i.provider = ? AND a.kind = ? AND a.role = ?
         AND a.status = 'active' AND i.revoked_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at > ${NOW})`,
      [
        principal.accountId,
        principal.identityId,
        principal.provider,
        principal.kind,
        principal.role,
      ],
    );
    if (!live) throw new AuthorizationError();
  }

  private assertion(condition: string, values: (string | number)[]) {
    return this.database.prepare(
      `INSERT INTO website_write_assertions (id, valid)
       SELECT ?, CASE WHEN ${condition} THEN 1 ELSE 0 END`,
      [this.newIdentifier(), ...values],
    );
  }

  private changed() {
    return this.database.prepare(
      "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes())",
      [this.newIdentifier()],
    );
  }

  /** Atomic guarded batch. A stale structure version fails as a conflict. */
  private async guarded(
    principal: TrustedPrincipal,
    expectedVersion: number,
    build: () => D1BatchStatement[],
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await this.authorize(principal);
      const generation = await this.database.readDependencyGeneration();
      try {
        await this.database.guardedBatch(generation, principal, build());
        return;
      } catch (error) {
        last = error;
        if ((await this.version()) !== expectedVersion)
          throw new CountyStructureConflictError(
            "stale_version",
            "The county structure changed since this was prepared. Prepare it again.",
          );
      }
    }
    throw last;
  }

  // -------------------------------------------------------------------- reads

  async version(): Promise<number> {
    const row = await this.database.first<{ version: number }>(
      "SELECT version FROM county_structure_state WHERE id = 1",
    );
    if (!row) throw new Error("County structure state is unavailable");
    return row.version;
  }

  private async registry(): Promise<Map<string, string>> {
    const rows = await this.database.all<{ fips: string; name: string }>(
      "SELECT fips, name FROM counties ORDER BY fips",
      PAGE,
    );
    return new Map(rows.map((row) => [row.fips, row.name]));
  }

  private async readRecords(countyFips?: string): Promise<StructureRecord[]> {
    const out: StructureRecord[] = [];
    const scope = countyFips ? " AND county_fips = ?" : "";
    const values = (after: string) =>
      countyFips ? [after, countyFips] : [after];
    for (let after = ""; ; ) {
      const rows = await this.database.all<Record<string, unknown>>(
        `SELECT id, county_fips, name, status, applies_from, applies_until,
                display_order, evidence, source_references
         FROM county_unit_display WHERE id > ?${scope} ORDER BY id`,
        PAGE,
        values(after),
      );
      for (const row of rows) out.push(groupRecord(row));
      if (rows.length < PAGE) break;
      after = String(rows[rows.length - 1]?.id);
    }
    for (let after = ""; ; ) {
      const rows = await this.database.all<Record<string, unknown>>(
        `SELECT u.id, u.county_fips, u.parent_unit_id, u.display_group_id,
                u.browse_parent_unit_id, u.parent_relationship, u.name, u.organization_type, u.status,
                u.applies_from, u.applies_until, u.display_order, u.evidence,
                u.source_references,
                (SELECT json_group_array(json_object('name', alias, 'kind', alias_kind))
                   FROM (SELECT alias, alias_kind FROM county_unit_alias a
                         WHERE a.unit_id = u.id ORDER BY position)) AS aliases
         FROM county_unit u WHERE u.id > ?${scope.replace("county_fips", "u.county_fips")} ORDER BY u.id`,
        PAGE,
        values(after),
      );
      for (const row of rows) out.push(unitRecord(row));
      if (rows.length < PAGE) break;
      after = String(rows[rows.length - 1]?.id);
    }
    return out;
  }

  private async profileReferences(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let after = ""; ; ) {
      const rows = await this.database.all<{ unit_id: string; n: number }>(
        `SELECT unit_id, COUNT(DISTINCT person_role_id) AS n
         FROM county_role_display WHERE unit_id IS NOT NULL AND unit_id > ?
         GROUP BY unit_id ORDER BY unit_id`,
        PAGE,
        [after],
      );
      for (const row of rows) out.set(row.unit_id, row.n);
      if (rows.length < PAGE) break;
      after = String(rows[rows.length - 1]?.unit_id);
    }
    return out;
  }

  async listCounties(
    principal: TrustedPrincipal,
  ): Promise<{ version: number; counties: CountySummary[] }> {
    await this.authorize(principal);
    const rows = await this.database.all<Record<string, number | string>>(
      `SELECT c.fips, c.name,
         (SELECT COUNT(*) FROM county_unit u WHERE u.county_fips = c.fips) AS units,
         (SELECT COUNT(*) FROM county_unit u WHERE u.county_fips = c.fips AND (u.parent_unit_id IS NOT NULL OR u.display_group_id IS NOT NULL OR u.browse_parent_unit_id IS NOT NULL)) AS subunits,
         (SELECT COUNT(*) FROM county_unit_display g WHERE g.county_fips = c.fips) AS groups,
         (SELECT COUNT(DISTINCT r.person_role_id) FROM county_role_display r WHERE r.county_fips = c.fips) AS profiles,
         (SELECT COUNT(*) FROM county_unit u WHERE u.county_fips = c.fips AND u.status = 'review_required')
         + (SELECT COUNT(*) FROM county_unit_display g WHERE g.county_fips = c.fips AND g.status = 'review_required') AS unresolved
       FROM counties c ORDER BY c.fips`,
      PAGE,
    );
    return {
      version: await this.version(),
      counties: rows.map((row) => ({
        fips: String(row.fips),
        name: String(row.name),
        counts: {
          units: Number(row.units),
          subunits: Number(row.subunits),
          displayGroups: Number(row.groups),
          profiles: Number(row.profiles),
          unresolved: Number(row.unresolved),
        },
      })),
    };
  }

  async getCounty(
    principal: TrustedPrincipal,
    fips: string,
  ): Promise<CountyDetail> {
    await this.authorize(principal);
    if (!FIPS.test(fips)) throw new CountyStructureNotFoundError();
    const registry = await this.registry();
    const name = registry.get(fips);
    if (name === undefined) throw new CountyStructureNotFoundError();
    const [records, references, version] = await Promise.all([
      this.readRecords(fips),
      this.profileReferences(),
      this.version(),
    ]);
    const children = new Map<string | null, StructureRecord[]>();
    for (const { record } of orderTree(records)) {
      const key = record.parentId ?? record.displayGroupId;
      const list = children.get(key) ?? [];
      list.push(record);
      children.set(key, list);
    }
    const build = (parent: string | null): UnitNode[] =>
      (children.get(parent) ?? []).map((record) => ({
        record,
        profileReferences: references.get(record.id) ?? 0,
        children: build(record.id),
      }));
    const units = records.filter((record) => record.kind === "unit");
    return {
      county: { fips, name },
      version,
      counts: {
        units: units.length,
        subunits: units.filter(
          (record) =>
            record.parentId !== null || record.displayGroupId !== null,
        ).length,
        displayGroups: records.length - units.length,
        profiles: units.reduce(
          (sum, record) => sum + (references.get(record.id) ?? 0),
          0,
        ),
        unresolved: records.filter(
          (record) => record.status === "review_required",
        ).length,
      },
      roots: build(null),
    };
  }

  async exportCsv(
    principal: TrustedPrincipal,
    fips?: string,
  ): Promise<{ fileName: string; csv: string; version: number }> {
    await this.authorize(principal);
    if (fips !== undefined && !FIPS.test(fips))
      throw new CountyStructureNotFoundError();
    const registry = await this.registry();
    if (fips !== undefined && !registry.has(fips))
      throw new CountyStructureNotFoundError();
    const version = await this.version();
    const records = await this.readRecords(fips);
    return {
      fileName: "county.csv",
      csv: exportCountyCsv(registry, records, fips),
      version,
    };
  }

  // ------------------------------------------------------------------ prepare

  async prepareImport(
    principal: TrustedPrincipal,
    request: {
      readonly fileName: string;
      readonly csv: string;
      readonly mode: ImportMode;
      readonly countyFips?: string | null;
    },
  ): Promise<PreparedImport> {
    await this.authorize(principal);
    if (!(IMPORT_MODES as readonly string[]).includes(request.mode))
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "mode",
          message: "Choose merge, replace_county or replace_state.",
        },
      ]);
    if (request.csv.length > MAX_CSV_BYTES)
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "csv_too_large",
          message: "county.csv must be 1 MiB or smaller.",
        },
      ]);
    const registry = await this.registry();
    const parsed = parseCountyCsv(request.csv, registry);
    if (!parsed.file) throw new CountyStructureValidationError(parsed.issues);

    const [version, current, references] = await Promise.all([
      this.version(),
      this.readRecords(),
      this.profileReferences(),
    ]);
    const plan = await planImport({
      mode: request.mode,
      countyFips: request.countyFips ?? null,
      file: parsed.file,
      registry,
      current,
      profileReferences: references,
    });
    if (!plan.changeset) throw new CountyStructureValidationError(plan.issues);
    const { changeset } = plan;

    const id = this.newIdentifier();
    const fileSha = await sha256Hex(request.csv);
    const blocked = changeset.counts.blocked > 0;
    const fileName = request.fileName.trim().slice(0, 255) || "county.csv";
    const statements: D1BatchStatement[] = [
      this.database.prepare(
        `INSERT INTO county_structure_import
           (id, mode, county_fips, file_name, file_sha256, changeset_sha256, csv_text,
            base_version, status, counts_json, summary_json, prepared_by_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          request.mode,
          request.mode === "replace_county"
            ? (request.countyFips ?? null)
            : null,
          fileName,
          fileSha,
          changeset.checksum,
          request.csv,
          version,
          blocked ? "blocked" : "prepared",
          JSON.stringify(changeset.counts),
          JSON.stringify({ counties: [...parsed.file.counties.keys()].sort() }),
          principal.accountId,
        ],
      ),
      ...this.itemStatements(id, changeset.items),
    ];
    try {
      await this.database.guardedBatch(
        await this.database.readDependencyGeneration(),
        principal,
        statements,
      );
    } catch (error) {
      await this.authorize(principal);
      throw error;
    }
    const summary = await this.getImportSummary(id);
    return {
      import: summary,
      items: changeset.items,
      issues: [],
      committable: !blocked,
    };
  }

  private itemStatements(
    importId: string,
    items: readonly ChangeItem[],
  ): D1BatchStatement[] {
    return chunk(
      items.map((item) => ({
        seq: item.seq,
        entityType: item.entityType,
        entityId: item.entityId,
        countyFips: item.countyFips,
        action: item.action,
        blocked: item.blocked ? 1 : 0,
        reason: item.reason,
        profileReferences: item.profileReferences,
        before: item.before ? canonicalRecord(item.before) : null,
        after: item.after ? canonicalRecord(item.after) : null,
      })),
    ).map((part) =>
      this.database.prepare(
        `INSERT INTO county_structure_import_item
           (import_id, seq, entity_type, entity_id, county_fips, action, blocked, reason,
            profile_references, before_json, after_json)
         SELECT ?, json_extract(value, '$.seq'), json_extract(value, '$.entityType'),
                json_extract(value, '$.entityId'), json_extract(value, '$.countyFips'),
                json_extract(value, '$.action'), json_extract(value, '$.blocked'),
                json_extract(value, '$.reason'), json_extract(value, '$.profileReferences'),
                json_extract(value, '$.before'), json_extract(value, '$.after')
         FROM json_each(?)`,
        [importId, JSON.stringify(part)],
      ),
    );
  }

  // ------------------------------------------------------------------ history

  private async getImportSummary(id: string): Promise<ImportSummary> {
    const row = await this.database.first<Record<string, unknown>>(
      `SELECT id, mode, county_fips, file_name, file_sha256, changeset_sha256, base_version,
              after_version, status, counts_json, reverses_import_id, reversed_by_import_id,
              created_at, committed_at
       FROM county_structure_import WHERE id = ?`,
      [id],
    );
    if (!row) throw new CountyStructureNotFoundError();
    return importSummary(row);
  }

  async listImports(
    principal: TrustedPrincipal,
    limit = 50,
  ): Promise<ImportSummary[]> {
    await this.authorize(principal);
    const rows = await this.database.all<Record<string, unknown>>(
      `SELECT id, mode, county_fips, file_name, file_sha256, changeset_sha256, base_version,
              after_version, status, counts_json, reverses_import_id, reversed_by_import_id,
              created_at, committed_at
       FROM county_structure_import ORDER BY created_at DESC, id DESC`,
      Math.min(Math.max(limit, 1), 100),
    );
    return rows.map(importSummary);
  }

  async getImport(
    principal: TrustedPrincipal,
    id: string,
    afterSeq = -1,
    limit = 500,
  ): Promise<{
    import: ImportSummary;
    items: ChangeItem[];
    next: number | null;
  }> {
    await this.authorize(principal);
    if (!IMPORT_ID.test(id)) throw new CountyStructureNotFoundError();
    const summary = await this.getImportSummary(id);
    const size = Math.min(Math.max(limit, 1), PAGE);
    const rows = await this.database.all<Record<string, unknown>>(
      `SELECT seq, entity_type, entity_id, county_fips, action, blocked, reason,
              profile_references, before_json, after_json
       FROM county_structure_import_item WHERE import_id = ? AND seq > ? ORDER BY seq`,
      size,
      [id, afterSeq],
    );
    const items = rows.map(itemFromRow);
    return {
      import: summary,
      items,
      next:
        rows.length === size ? (items[items.length - 1]?.seq ?? null) : null,
    };
  }

  private async allItems(importId: string): Promise<ChangeItem[]> {
    const out: ChangeItem[] = [];
    for (let after = -1; ; ) {
      const rows = await this.database.all<Record<string, unknown>>(
        `SELECT seq, entity_type, entity_id, county_fips, action, blocked, reason,
                profile_references, before_json, after_json
         FROM county_structure_import_item WHERE import_id = ? AND seq > ? ORDER BY seq`,
        PAGE,
        [importId, after],
      );
      for (const row of rows) out.push(itemFromRow(row));
      if (rows.length < PAGE) break;
      after = out[out.length - 1]?.seq ?? after;
    }
    return out;
  }

  async history(
    principal: TrustedPrincipal,
    entityId: string,
    limit = 50,
  ): Promise<Record<string, unknown>[]> {
    await this.authorize(principal);
    const rows = await this.database.all<Record<string, unknown>>(
      `SELECT id, import_id, source, structure_version, county_fips, entity_type, entity_id,
              action, before_json, after_json, actor_account_id, created_at
       FROM county_structure_history WHERE entity_id = ? ORDER BY id DESC`,
      Math.min(Math.max(limit, 1), 200),
      [entityId],
    );
    return rows.map((row) => ({ ...row }));
  }

  // ------------------------------------------------------------------- commit

  async commitImport(
    principal: TrustedPrincipal,
    request: {
      readonly importId: string;
      readonly changesetSha256: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
    },
  ): Promise<{ import: ImportSummary; replayed: boolean; noop: boolean }> {
    await this.authorize(principal);
    if (!IMPORT_ID.test(request.importId) || !KEY.test(request.idempotencyKey))
      throw new CountyStructureNotFoundError();
    const row = await this.database.first<Record<string, unknown>>(
      `SELECT status, changeset_sha256, base_version, commit_idempotency_key
       FROM county_structure_import WHERE id = ?`,
      [request.importId],
    );
    if (!row) throw new CountyStructureNotFoundError();
    if (row.status === "committed") {
      if (row.commit_idempotency_key === request.idempotencyKey)
        return {
          import: await this.getImportSummary(request.importId),
          replayed: true,
          noop: false,
        };
      throw new CountyStructureConflictError(
        "already_committed",
        "This import was already committed.",
      );
    }
    if (row.status !== "prepared")
      throw new CountyStructureConflictError(
        row.status === "blocked" ? "blocked" : "not_prepared",
        row.status === "blocked"
          ? "This import is blocked. Resolve the reconciliation report and prepare it again."
          : "This import cannot be committed.",
      );
    if (
      row.changeset_sha256 !== request.changesetSha256 ||
      row.base_version !== request.expectedVersion
    )
      throw new CountyStructureConflictError(
        "stale_version",
        "The confirmed changeset does not match the prepared import.",
      );
    if ((await this.version()) !== row.base_version)
      throw new CountyStructureConflictError(
        "stale_version",
        "The county structure changed since this import was prepared. Prepare it again.",
      );
    const taken = await this.database.first(
      "SELECT 1 AS used FROM county_structure_import WHERE commit_idempotency_key = ?",
      [request.idempotencyKey],
    );
    if (taken)
      throw new CountyStructureConflictError(
        "idempotency_reuse",
        "That idempotency key belongs to another import.",
      );

    const items = await this.allItems(request.importId);
    if (items.some((item) => item.blocked))
      throw new CountyStructureConflictError(
        "blocked",
        "This import is blocked.",
      );

    if (items.length === 0) {
      await this.guarded(principal, row.base_version as number, () => [
        this.assertion(
          "(SELECT version FROM county_structure_state WHERE id = 1) = ?",
          [row.base_version as number],
        ),
        this.database.prepare(
          `UPDATE county_structure_import
              SET status = 'committed', after_version = base_version, commit_idempotency_key = ?,
                  committed_by_account_id = ?, committed_at = ${NOW}
            WHERE id = ? AND status = 'prepared'`,
          [request.idempotencyKey, principal.accountId, request.importId],
        ),
        this.changed(),
      ]);
      return {
        import: await this.getImportSummary(request.importId),
        replayed: false,
        noop: true,
      };
    }

    const counts = countItems(items, 0);
    const importId = request.importId;
    const expectedUnits = await this.expectedUnitCount(items);
    await this.guarded(principal, row.base_version as number, () =>
      this.applyStatements(items, {
        principal,
        baseVersion: row.base_version as number,
        source: "import",
        importId,
        commitKey: request.idempotencyKey,
        expectedUnits,
        extra: [],
        auditAction: "county_structure.import.commit",
        auditSummary: `Committed county structure import (${counts.add} added, ${counts.update + counts.move + counts.retire} changed, ${counts.remove} removed)`,
        auditDetails: { importId, changeset: request.changesetSha256 },
      }),
    );
    return {
      import: await this.getImportSummary(request.importId),
      replayed: false,
      noop: false,
    };
  }

  // ------------------------------------------------------------------ reversal

  async reverseImport(
    principal: TrustedPrincipal,
    request: { readonly importId: string; readonly idempotencyKey: string },
  ): Promise<{ import: ImportSummary; replayed: boolean }> {
    await this.authorize(principal);
    if (!IMPORT_ID.test(request.importId) || !KEY.test(request.idempotencyKey))
      throw new CountyStructureNotFoundError();
    const original = await this.database.first<Record<string, unknown>>(
      `SELECT id, mode, status, base_version, after_version, reversed_by_import_id
       FROM county_structure_import WHERE id = ?`,
      [request.importId],
    );
    if (!original) throw new CountyStructureNotFoundError();
    if (original.status === "reversed") {
      const reversal = await this.database.first<{
        id: string;
        commit_idempotency_key: string | null;
      }>(
        "SELECT id, commit_idempotency_key FROM county_structure_import WHERE id = ?",
        [original.reversed_by_import_id as string],
      );
      if (reversal?.commit_idempotency_key === request.idempotencyKey)
        return {
          import: await this.getImportSummary(reversal.id),
          replayed: true,
        };
      throw new CountyStructureConflictError(
        "already_committed",
        "This import was already reversed.",
      );
    }
    if (original.status !== "committed" || original.mode === "reversal")
      throw new CountyStructureConflictError(
        "not_reversible",
        "Only a committed import can be reversed.",
      );
    if (original.after_version === original.base_version)
      throw new CountyStructureConflictError(
        "not_reversible",
        "This import made no changes, so there is nothing to reverse.",
      );
    const current = await this.version();
    if (current !== original.after_version)
      throw new CountyStructureConflictError(
        "not_reversible",
        "The county structure has changed since this import. Reverse the later changes first, or correct the structure with a new county.csv.",
      );

    const originalItems = await this.allItems(request.importId);
    const references = await this.profileReferences();
    const inverse: ChangeItem[] = originalItems.map((item, seq) => {
      const before = item.after;
      const after = item.before;
      let action: ChangeAction;
      let blocked = false;
      let reason: string | null = null;
      const refs = references.get(item.entityId) ?? 0;
      if (!before) action = "add";
      else if (!after) {
        action = "remove";
        if (refs > 0) {
          blocked = true;
          reason = `${refs} Profile role${refs === 1 ? " is" : "s are"} now linked to this unit, so the import cannot be reversed without orphaning them.`;
        }
      } else
        action =
          before.parentId !== after.parentId ||
          before.displayGroupId !== after.displayGroupId ||
          before.relationship !== after.relationship
            ? "move"
            : "update";
      return {
        seq,
        entityType: item.entityType,
        entityId: item.entityId,
        countyFips: item.countyFips,
        action,
        blocked,
        reason,
        profileReferences: refs,
        before,
        after,
      };
    });
    const blockers = inverse.filter((item) => item.blocked);
    if (blockers.length > 0)
      throw new CountyStructureConflictError(
        "not_reversible",
        `Reversal is blocked: ${blockers.length} unit${blockers.length === 1 ? "" : "s"} now ${blockers.length === 1 ? "has" : "have"} linked Profile roles (first: ${blockers[0]?.entityId}).`,
      );
    const counts = countItems(inverse, 0);
    const reversalId = this.newIdentifier();
    const expectedUnits = await this.expectedUnitCount(inverse);
    const csv = "";
    const emptySha = await sha256Hex(csv);
    const changeset = await diffChecksum(inverse);
    const reversalRows: D1BatchStatement[] = [
      this.database.prepare(
        `INSERT INTO county_structure_import
           (id, mode, file_name, file_sha256, changeset_sha256, csv_text, base_version, status,
            counts_json, summary_json, reverses_import_id, prepared_by_account_id)
         VALUES (?, 'reversal', ?, ?, ?, '', ?, 'prepared', ?, '{}', ?, ?)`,
        [
          reversalId,
          `reversal of ${request.importId}`.slice(0, 255),
          emptySha,
          changeset,
          current,
          JSON.stringify(counts),
          request.importId,
          principal.accountId,
        ],
      ),
      ...this.itemStatements(reversalId, inverse),
    ];
    await this.guarded(principal, current, () =>
      this.applyStatements(
        inverse,
        {
          principal,
          baseVersion: current,
          source: "reversal",
          importId: reversalId,
          commitKey: request.idempotencyKey,
          expectedUnits,
          extra: [
            this.database.prepare(
              `UPDATE county_structure_import SET status = 'reversed', reversed_by_import_id = ?
                WHERE id = ? AND status = 'committed' AND after_version = ?`,
              [reversalId, request.importId, current],
            ),
            this.changed(),
          ],
          auditAction: "county_structure.import.reverse",
          auditSummary: "Reversed a county structure import",
          auditDetails: { importId: request.importId, reversalId },
        },
        reversalRows,
      ),
    );
    return { import: await this.getImportSummary(reversalId), replayed: false };
  }

  // -------------------------------------------------------------------- edits

  async edit(
    principal: TrustedPrincipal,
    request: EditRequest,
  ): Promise<EditResult> {
    await this.authorize(principal);
    const { edit } = request;
    if (
      !Number.isInteger(request.expectedVersion) ||
      request.expectedVersion < 0
    )
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "version",
          message: "expectedVersion is required.",
        },
      ]);
    if ((await this.version()) !== request.expectedVersion)
      throw new CountyStructureConflictError(
        "stale_version",
        "The county structure changed. Reload it and try again.",
      );

    const registry = await this.registry();
    let countyFips: string;
    let subjectId: string | null = null;
    if (
      edit.op === "create_unit" ||
      edit.op === "create_group" ||
      edit.op === "reorder"
    ) {
      countyFips = edit.countyFips;
    } else {
      const subject = await this.database.first<{ county_fips: string }>(
        `SELECT county_fips FROM county_unit WHERE id = ?
         UNION ALL SELECT county_fips FROM county_unit_display WHERE id = ?`,
        [edit.id, edit.id],
      );
      if (!subject) throw new CountyStructureNotFoundError();
      countyFips = subject.county_fips;
      subjectId = edit.id;
    }
    if (!registry.has(countyFips)) throw new CountyStructureNotFoundError();

    const records = await this.readRecords(countyFips);
    const references = await this.profileReferences();
    const { target, entityId } = applyEdit(records, edit, countyFips, () =>
      this.newIdentifier(),
    );
    const problems = validateStructure(target);
    if (problems.length > 0) throw new CountyStructureValidationError(problems);

    const changeset = await diffStructures({
      mode: "merge",
      countyFips,
      scope: new Set([countyFips]),
      current: records,
      target,
      removeAbsent: true,
      profileReferences: references,
    });
    const blocked = changeset.items.find((item) => item.blocked);
    if (blocked)
      throw new CountyStructureConflictError(
        "blocked",
        blocked.reason ?? "This change is blocked.",
      );
    if (changeset.items.length === 0)
      return {
        structureVersion: request.expectedVersion,
        entityId: entityId ?? subjectId,
        counts: changeset.counts,
      };

    const expectedUnits = await this.expectedUnitCount(changeset.items);
    await this.guarded(principal, request.expectedVersion, () =>
      this.applyStatements(changeset.items, {
        principal,
        baseVersion: request.expectedVersion,
        source: "dashboard",
        importId: null,
        commitKey: null,
        expectedUnits,
        extra: [],
        auditAction: `county_structure.edit.${edit.op}`,
        auditSummary: `County structure edit (${edit.op})`,
        auditDetails: { countyFips, entityId: entityId ?? subjectId ?? "" },
      }),
    );
    return {
      structureVersion: request.expectedVersion + 1,
      entityId: entityId ?? subjectId,
      counts: changeset.counts,
    };
  }

  // ------------------------------------------------------------ role displays

  async listLinkedRoles(
    principal: TrustedPrincipal,
    unitId: string,
  ): Promise<LinkedRole[]> {
    await this.authorize(principal);
    const rows = await this.database.all<Record<string, unknown>>(
      `SELECT d.id, d.person_role_id, r.person_id, p.display_name, d.listing, d.unit_id,
              COALESCE(r.published_title, pos.title) AS title
       FROM county_role_display d
       JOIN person_roles r ON r.id = d.person_role_id
       JOIN people p ON p.id = r.person_id
       LEFT JOIN positions pos ON pos.id = r.position_id
       WHERE d.unit_id = ? ORDER BY p.display_name, d.id`,
      200,
      [unitId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      personRoleId: String(row.person_role_id),
      personId: String(row.person_id),
      displayName: String(row.display_name),
      listing: row.listing as LinkedRole["listing"],
      unitId: row.unit_id === null ? null : String(row.unit_id),
      title: row.title === null ? null : String(row.title),
    }));
  }

  /**
   * Adds one reviewed view of an existing role. The Profile and role are never
   * copied. Calling again with the same triple returns the existing row.
   */
  async addRoleDisplay(
    principal: TrustedPrincipal,
    request: {
      readonly personRoleId: string;
      readonly listing: "home" | "elected_official" | "department_leader";
      readonly unitId?: string | null;
    },
  ): Promise<{ id: string; created: boolean }> {
    await this.authorize(principal);
    if (
      !["home", "elected_official", "department_leader"].includes(
        request.listing,
      )
    )
      throw new CountyStructureValidationError([
        { row: 0, column: null, code: "listing", message: "Unknown listing." },
      ]);
    const unitId = request.unitId ?? null;
    if (request.listing === "home" && !unitId)
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "unit_required",
          message: "A home listing needs a unit.",
        },
      ]);
    const role = await this.database.first<{ county_fips: string | null }>(
      "SELECT county_fips FROM person_roles WHERE id = ?",
      [request.personRoleId],
    );
    if (!role)
      throw new CountyStructureNotFoundError("The role does not exist.");
    let countyFips = role.county_fips;
    if (unitId) {
      const unit = await this.database.first<{ county_fips: string }>(
        "SELECT county_fips FROM county_unit WHERE id = ?",
        [unitId],
      );
      if (!unit)
        throw new CountyStructureNotFoundError("The unit does not exist.");
      if (countyFips && countyFips !== unit.county_fips)
        throw new CountyStructureValidationError([
          {
            row: 0,
            column: null,
            code: "cross_county",
            message: "The role and unit are in different counties.",
          },
        ]);
      countyFips = unit.county_fips;
    }
    if (!countyFips)
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "county_required",
          message: "The role has no county. Give a unit.",
        },
      ]);
    const existing = await this.database.first<{ id: string }>(
      `SELECT id FROM county_role_display
       WHERE person_role_id = ? AND listing = ? AND COALESCE(unit_id, '') = ?`,
      [request.personRoleId, request.listing, unitId ?? ""],
    );
    if (existing) return { id: existing.id, created: false };
    const id = this.newIdentifier();
    await this.guarded(principal, await this.version(), () => [
      this.database.prepare(
        `INSERT INTO county_role_display
           (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          request.personRoleId,
          countyFips as string,
          unitId,
          request.listing,
          principal.accountId,
        ],
      ),
      this.audit(
        principal,
        "county_structure.role_display.add",
        id,
        "Added a reviewed role display",
        { listing: request.listing },
      ),
    ]);
    return { id, created: true };
  }

  async removeRoleDisplay(
    principal: TrustedPrincipal,
    id: string,
  ): Promise<void> {
    await this.authorize(principal);
    await this.guarded(principal, await this.version(), () => [
      this.database.prepare("DELETE FROM county_role_display WHERE id = ?", [
        id,
      ]),
      this.changed(),
      this.audit(
        principal,
        "county_structure.role_display.remove",
        id,
        "Removed a reviewed role display",
        {},
      ),
    ]);
  }

  // -------------------------------------------------------------- apply (core)

  private async expectedUnitCount(
    items: readonly ChangeItem[],
  ): Promise<number> {
    const touched = [...new Set(items.map((item) => item.countyFips))];
    const row = await this.database.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM county_unit WHERE county_fips IN (SELECT value FROM json_each(?))",
      [JSON.stringify(touched)],
    );
    const units = items.filter((item) => item.entityType === "unit");
    return (
      (row?.n ?? 0) +
      units.filter((item) => item.action === "add").length -
      units.filter((item) => item.action === "remove").length
    );
  }

  private audit(
    principal: TrustedPrincipal,
    action: string,
    targetId: string,
    summary: string,
    details: Record<string, string>,
  ): D1BatchStatement {
    assertCredentialFree({
      action,
      targetType: "county_structure",
      targetId,
      summary,
      details,
    });
    return this.database.prepare(
      `INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json)
       VALUES (?, ?, ?, 'county_structure', ?, ?, ?)`,
      [
        this.newIdentifier(),
        principal.accountId,
        action,
        targetId,
        summary,
        JSON.stringify(details),
      ],
    );
  }

  /** One atomic statement list for a changeset. Order matters for the triggers. */
  private applyStatements(
    items: readonly ChangeItem[],
    context: ApplyContext,
    leading: readonly D1BatchStatement[] = [],
  ): D1BatchStatement[] {
    const statements: D1BatchStatement[] = [
      this.assertion(
        "(SELECT version FROM county_structure_state WHERE id = 1) = ?",
        [context.baseVersion],
      ),
      ...leading,
      this.database.prepare(
        `UPDATE county_structure_state SET version = version + 1, updated_at = ${NOW}
          WHERE id = 1 AND version = ?`,
        [context.baseVersion],
      ),
      this.changed(),
    ];
    const run = (sql: string, parts: unknown[]) => {
      for (const part of chunk(parts))
        statements.push(this.database.prepare(sql, [JSON.stringify(part)]));
    };

    const unitItems = items.filter((item) => item.entityType === "unit");
    const groupItems = items.filter(
      (item) => item.entityType === "display_group",
    );
    const unitsOf = (action: ChangeAction) =>
      unitItems.filter((item) => item.action === action);
    const moved = unitItems.filter((item) => item.action === "move");
    const changedAfter = unitItems.filter((item) => item.after !== null);

    // Depth among the records being written, so a parent always comes first.
    const depths = (records: StructureRecord[]) => dependencyDepth(records);
    const byLevel = <T extends StructureRecord>(
      records: T[],
      descending: boolean,
    ) => {
      const depth = depths(records);
      const levels = new Map<number, T[]>();
      for (const record of records) {
        const level = depth.get(record.id) ?? 0;
        const list = levels.get(level) ?? [];
        list.push(record);
        levels.set(level, list);
      }
      return [...levels.entries()]
        .sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]))
        .map(([, list]) => list);
    };

    // (a) detach units that are changing parent.
    run(
      "UPDATE county_unit SET parent_unit_id = NULL, display_group_id = NULL, browse_parent_unit_id = NULL, parent_relationship = NULL WHERE id IN (SELECT value FROM json_each(?))",
      moved.map((item) => item.entityId),
    );
    // (b) remove units, deepest first.
    const removedUnits = unitsOf("remove").map(
      (item) => item.before as StructureRecord,
    );
    for (const level of byLevel(removedUnits, true))
      run(
        "DELETE FROM county_unit WHERE id IN (SELECT value FROM json_each(?))",
        level.map((record) => record.id),
      );
    // (c) display groupings.
    const groupFields = (extra: string) =>
      `SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.countyFips') AS county_fips, json_extract(value, '$.name') AS name,
              json_extract(value, '$.status') AS status, json_extract(value, '$.appliesFrom') AS applies_from,
              json_extract(value, '$.appliesUntil') AS applies_until, json_extract(value, '$.displayOrder') AS display_order,
              json_extract(value, '$.evidence') AS evidence, json_extract(value, '$.sources') AS sources FROM json_each(?)${extra}`;
    run(
      `INSERT INTO county_unit_display (id, county_fips, name, status, applies_from, applies_until, display_order, evidence, source_references)
       SELECT id, county_fips, name, status, applies_from, applies_until, display_order, evidence, sources FROM (${groupFields("")})`,
      groupItems
        .filter((item) => item.action === "add")
        .map((item) => canonicalRecord(item.after as StructureRecord)),
    );
    run(
      `UPDATE county_unit_display SET name = j.name, status = j.status, applies_from = j.applies_from,
              applies_until = j.applies_until, display_order = j.display_order, evidence = j.evidence,
              source_references = j.sources, version = county_unit_display.version + 1, updated_at = ${NOW}
       FROM (${groupFields("")}) AS j WHERE county_unit_display.id = j.id`,
      groupItems
        .filter((item) => item.action !== "add" && item.action !== "remove")
        .map((item) => canonicalRecord(item.after as StructureRecord)),
    );
    // (d) add units, parents first.
    // `displayGroupId` is browse placement. It is stored in display_group_id
    // when it names a grouping and in browse_parent_unit_id when it names a
    // unit, where the stored relationship stays NULL (no reporting parent).
    // Groupings are written in step (c), before any unit, and unit and
    // grouping IDs never overlap.
    const browseIsGroup = `EXISTS (SELECT 1 FROM county_unit_display g WHERE g.id = json_extract(value, '$.displayGroupId'))`;
    const unitFields = `SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.countyFips') AS county_fips,
            json_extract(value, '$.parentId') AS parent_unit_id,
            CASE WHEN ${browseIsGroup} THEN json_extract(value, '$.displayGroupId') END AS display_group_id,
            CASE WHEN json_extract(value, '$.displayGroupId') IS NOT NULL AND NOT ${browseIsGroup}
                 THEN json_extract(value, '$.displayGroupId') END AS browse_parent_unit_id,
            CASE WHEN json_extract(value, '$.displayGroupId') IS NOT NULL AND NOT ${browseIsGroup}
                 THEN NULL ELSE json_extract(value, '$.relationship') END AS parent_relationship,
            json_extract(value, '$.name') AS name,
            json_extract(value, '$.organizationType') AS organization_type, json_extract(value, '$.status') AS status,
            json_extract(value, '$.appliesFrom') AS applies_from, json_extract(value, '$.appliesUntil') AS applies_until,
            json_extract(value, '$.displayOrder') AS display_order, json_extract(value, '$.evidence') AS evidence,
            json_extract(value, '$.sources') AS sources FROM json_each(?)`;
    const addedUnits = unitsOf("add").map(
      (item) => item.after as StructureRecord,
    );
    for (const level of byLevel(addedUnits, false))
      run(
        `INSERT INTO county_unit (id, county_fips, parent_unit_id, display_group_id, browse_parent_unit_id,
                parent_relationship, name, organization_type, status, applies_from, applies_until, display_order,
                evidence, source_references)
         SELECT id, county_fips, parent_unit_id, display_group_id, browse_parent_unit_id, parent_relationship, name,
                organization_type,
                status, applies_from, applies_until, display_order, evidence, sources FROM (${unitFields})`,
        level.map(canonicalRecord),
      );
    // (e) update fields, then re-attach moved units, parents first.
    run(
      `UPDATE county_unit SET name = j.name, organization_type = j.organization_type, status = j.status,
              applies_from = j.applies_from, applies_until = j.applies_until, display_order = j.display_order,
              evidence = j.evidence, source_references = j.sources, version = county_unit.version + 1, updated_at = ${NOW}
       FROM (${unitFields}) AS j WHERE county_unit.id = j.id`,
      unitItems
        .filter((item) => item.action !== "add" && item.action !== "remove")
        .map((item) => canonicalRecord(item.after as StructureRecord)),
    );
    const movedAfter = moved.map((item) => item.after as StructureRecord);
    for (const level of byLevel(movedAfter, false))
      run(
        `UPDATE county_unit SET parent_unit_id = j.parent_unit_id, display_group_id = j.display_group_id,
                browse_parent_unit_id = j.browse_parent_unit_id, parent_relationship = j.parent_relationship
         FROM (${unitFields}) AS j WHERE county_unit.id = j.id`,
        level.map(canonicalRecord),
      );
    // (f) remove groupings no unit still uses.
    run(
      "DELETE FROM county_unit_display WHERE id IN (SELECT value FROM json_each(?))",
      groupItems
        .filter((item) => item.action === "remove")
        .map((item) => item.entityId),
    );
    // (g) aliases for every written unit.
    run(
      "DELETE FROM county_unit_alias WHERE unit_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))",
      changedAfter.map((item) => ({ id: item.entityId })),
    );
    run(
      `INSERT INTO county_unit_alias (unit_id, position, alias, alias_kind)
       SELECT json_extract(u.value, '$.id'), CAST(a.key AS INTEGER), json_extract(a.value, '$.name'), json_extract(a.value, '$.kind')
       FROM json_each(?) AS u, json_each(json_extract(u.value, '$.aliases')) AS a`,
      changedAfter
        .filter((item) => (item.after?.aliases.length ?? 0) > 0)
        .map((item) => ({
          id: item.entityId,
          aliases: item.after?.aliases ?? [],
        })),
    );
    // (h) append-only history.
    for (const part of chunk(
      items.map((item) => ({
        countyFips: item.countyFips,
        entityType: item.entityType,
        entityId: item.entityId,
        action: item.action,
        before: item.before ? canonicalRecord(item.before) : null,
        after: item.after ? canonicalRecord(item.after) : null,
      })),
    ))
      statements.push(
        this.database.prepare(
          `INSERT INTO county_structure_history
             (import_id, source, structure_version, county_fips, entity_type, entity_id, action,
              before_json, after_json, actor_account_id)
           SELECT ?, ?, ?, json_extract(value, '$.countyFips'), json_extract(value, '$.entityType'),
                  json_extract(value, '$.entityId'), json_extract(value, '$.action'),
                  json_extract(value, '$.before'), json_extract(value, '$.after'), ?
           FROM json_each(?) ORDER BY CAST(key AS INTEGER)`,
          [
            context.importId,
            context.source,
            context.baseVersion + 1,
            context.principal.accountId,
            JSON.stringify(part),
          ],
        ),
      );
    // (i) the structure must hold exactly what the changeset implies.
    const touched = [...new Set(items.map((item) => item.countyFips))];
    statements.push(
      this.assertion(
        "(SELECT COUNT(*) FROM county_unit WHERE county_fips IN (SELECT value FROM json_each(?))) = ?",
        [JSON.stringify(touched), context.expectedUnits],
      ),
    );
    if (context.importId)
      statements.push(
        this.database.prepare(
          `UPDATE county_structure_import
              SET status = 'committed', after_version = ?, commit_idempotency_key = ?,
                  committed_by_account_id = ?, committed_at = ${NOW}
            WHERE id = ? AND status = 'prepared'`,
          [
            context.baseVersion + 1,
            context.commitKey,
            context.principal.accountId,
            context.importId,
          ],
        ),
        this.changed(),
      );
    statements.push(...context.extra);
    statements.push(
      this.audit(
        context.principal,
        context.auditAction,
        context.importId ?? touched.join(","),
        context.auditSummary,
        context.auditDetails,
      ),
    );
    return statements;
  }
}

// ------------------------------------------------------------------- helpers

function chunk<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const entry of list) {
    const length = JSON.stringify(entry).length + 1;
    if (current.length > 0 && size + length > CHUNK_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function diffChecksum(items: readonly ChangeItem[]): Promise<string> {
  return sha256Hex(
    JSON.stringify(
      items.map((item) => [
        item.action,
        item.entityId,
        item.before,
        item.after,
      ]),
    ),
  );
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function groupRecord(row: Record<string, unknown>): StructureRecord {
  return {
    kind: "display_group",
    id: String(row.id),
    countyFips: String(row.county_fips),
    parentId: null,
    displayGroupId: null,
    relationship: null,
    name: String(row.name),
    organizationType: DISPLAY_GROUP_TYPE,
    status: row.status as UnitStatus,
    appliesFrom: text(row.applies_from),
    appliesUntil: text(row.applies_until),
    displayOrder: row.display_order === null ? null : Number(row.display_order),
    aliases: [],
    evidence: text(row.evidence),
    sources: text(row.source_references),
  };
}

function unitRecord(row: Record<string, unknown>): StructureRecord {
  const aliases = JSON.parse(String(row.aliases ?? "[]")) as {
    name: string;
    kind: "alternate" | "historical" | "abbreviation";
  }[];
  return {
    kind: "unit",
    id: String(row.id),
    countyFips: String(row.county_fips),
    parentId: text(row.parent_unit_id),
    // Browse placement under a grouping or, since migration 0033, a unit.
    displayGroupId:
      text(row.display_group_id) ?? text(row.browse_parent_unit_id),
    relationship:
      row.browse_parent_unit_id !== null &&
      row.browse_parent_unit_id !== undefined
        ? "display_group"
        : (text(row.parent_relationship) as ParentRelationship | null),
    name: String(row.name),
    organizationType: row.organization_type as OrganizationType,
    status: row.status as UnitStatus,
    appliesFrom: text(row.applies_from),
    appliesUntil: text(row.applies_until),
    displayOrder: row.display_order === null ? null : Number(row.display_order),
    aliases: aliases.map((alias) => ({ name: alias.name, kind: alias.kind })),
    evidence: text(row.evidence),
    sources: text(row.source_references),
  };
}

function itemFromRow(row: Record<string, unknown>): ChangeItem {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type as "unit" | "display_group",
    entityId: String(row.entity_id),
    countyFips: String(row.county_fips),
    action: row.action as ChangeAction,
    blocked: Number(row.blocked) === 1,
    reason: text(row.reason),
    profileReferences: Number(row.profile_references),
    before: row.before_json
      ? (JSON.parse(String(row.before_json)) as StructureRecord)
      : null,
    after: row.after_json
      ? (JSON.parse(String(row.after_json)) as StructureRecord)
      : null,
  };
}

function importSummary(row: Record<string, unknown>): ImportSummary {
  return {
    id: String(row.id),
    mode: row.mode as ImportSummary["mode"],
    countyFips: text(row.county_fips),
    fileName: String(row.file_name),
    fileSha256: String(row.file_sha256),
    changesetSha256: String(row.changeset_sha256),
    baseVersion: Number(row.base_version),
    afterVersion: row.after_version === null ? null : Number(row.after_version),
    status: row.status as ImportSummary["status"],
    counts: JSON.parse(String(row.counts_json)) as ChangeCounts,
    reversesImportId: text(row.reverses_import_id),
    reversedByImportId: text(row.reversed_by_import_id),
    createdAt: String(row.created_at),
    committedAt: text(row.committed_at),
  };
}

const edits = (message: string, code = "edit"): never => {
  throw new CountyStructureValidationError([
    { row: 0, column: null, code, message },
  ]);
};

function applyEdit(
  records: readonly StructureRecord[],
  edit: StructureEdit,
  countyFips: string,
  newIdentifier: () => string,
): { target: StructureRecord[]; entityId: string | null } {
  const byId = new Map(records.map((record) => [record.id, record]));
  const aliasesFrom = (
    value: readonly { name: string; kind?: string }[] | undefined,
  ) => {
    if (value === undefined) return undefined;
    const parsed = parseAliases(
      JSON.stringify(
        value.map((alias) =>
          alias.kind && alias.kind !== "alternate" ? alias : alias.name,
        ),
      ),
    );
    if ("error" in parsed) return edits(parsed.error, "aliases");
    return parsed.aliases;
  };
  const checkText = (record: StructureRecord) => {
    if (record.name.trim() === "" || record.name.length > 300)
      edits("Name must be 1 to 300 characters.", "name");
    if (
      !(
        record.kind === "display_group" ||
        (ORGANIZATION_TYPES as readonly string[]).includes(
          record.organizationType,
        )
      )
    )
      edits("Unknown organization type.", "organization_type");
    if (!(UNIT_STATUSES as readonly string[]).includes(record.status))
      edits("Unknown status.", "status");
    for (const date of [record.appliesFrom, record.appliesUntil])
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date))
        edits("Dates use YYYY-MM-DD.", "date");
    if (
      record.appliesFrom &&
      record.appliesUntil &&
      record.appliesUntil < record.appliesFrom
    )
      edits("Applies until cannot be earlier than Applies from.", "date_range");
    if (
      record.displayOrder !== null &&
      (!Number.isInteger(record.displayOrder) || record.displayOrder < 0)
    )
      edits(
        "Display order must be a whole number of zero or more.",
        "display_order",
      );
    if (
      (record.evidence?.length ?? 0) > MAX_TEXT ||
      (record.sources?.length ?? 0) > MAX_TEXT
    )
      edits(
        `Provenance text is limited to ${MAX_TEXT} characters.`,
        "text_length",
      );
  };

  if (edit.op === "create_unit" || edit.op === "create_group") {
    const id = `${countyFips}-${newIdentifier().replaceAll("-", "").slice(0, 12)}`;
    const group = edit.op === "create_group";
    let parentId: string | null = null;
    let displayGroupId: string | null = null;
    let relationship: ParentRelationship | null = null;
    if (!group && edit.parentId) {
      const parent = byId.get(edit.parentId);
      if (!parent)
        return edits(
          "The parent does not exist in this county.",
          "parent_missing",
        );
      if (parent.kind === "display_group") {
        displayGroupId = parent.id;
        relationship = "display_group";
      } else {
        parentId = parent.id;
        relationship = edit.relationship ?? "part_of";
      }
    }
    const record: StructureRecord = {
      kind: group ? "display_group" : "unit",
      id,
      countyFips,
      parentId,
      displayGroupId,
      relationship,
      name: edit.name.trim().normalize("NFC"),
      organizationType: group
        ? DISPLAY_GROUP_TYPE
        : (edit.organizationType ?? "office"),
      status: edit.status ?? "active",
      appliesFrom: edit.appliesFrom ?? null,
      appliesUntil: edit.appliesUntil ?? null,
      displayOrder: edit.displayOrder ?? null,
      aliases: group ? [] : (aliasesFrom(edit.aliases) ?? []),
      evidence: edit.evidence?.trim() ? edit.evidence : null,
      sources: edit.sources?.trim() ? edit.sources : null,
    };
    checkText(record);
    return { target: [...records, record], entityId: id };
  }

  if (edit.op === "update") {
    const current = byId.get(edit.id);
    if (!current) return edits("The unit does not exist.", "not_found");
    const next: StructureRecord = {
      ...current,
      name:
        edit.name !== undefined
          ? edit.name.trim().normalize("NFC")
          : current.name,
      organizationType:
        edit.organizationType !== undefined && current.kind === "unit"
          ? edit.organizationType
          : current.organizationType,
      status: edit.status ?? current.status,
      appliesFrom:
        edit.appliesFrom !== undefined ? edit.appliesFrom : current.appliesFrom,
      appliesUntil:
        edit.appliesUntil !== undefined
          ? edit.appliesUntil
          : current.appliesUntil,
      displayOrder:
        edit.displayOrder !== undefined
          ? edit.displayOrder
          : current.displayOrder,
      aliases:
        current.kind === "unit"
          ? (aliasesFrom(edit.aliases) ?? current.aliases)
          : [],
      evidence:
        edit.evidence !== undefined
          ? edit.evidence?.trim()
            ? edit.evidence
            : null
          : current.evidence,
      sources:
        edit.sources !== undefined
          ? edit.sources?.trim()
            ? edit.sources
            : null
          : current.sources,
    };
    checkText(next);
    return {
      target: records.map((record) => (record.id === edit.id ? next : record)),
      entityId: edit.id,
    };
  }

  if (edit.op === "move") {
    const current = byId.get(edit.id);
    if (!current || current.kind !== "unit")
      return edits("Only a unit can be moved.", "not_found");
    let parentId: string | null = null;
    let displayGroupId: string | null = null;
    let relationship: ParentRelationship | null = null;
    if (edit.parentId !== null) {
      const parent = byId.get(edit.parentId);
      if (!parent)
        return edits(
          "The new parent does not exist in this county.",
          "parent_missing",
        );
      if (
        parent.kind === "display_group" ||
        edit.relationship === "display_group"
      ) {
        displayGroupId = parent.id;
        relationship = "display_group";
      } else {
        parentId = parent.id;
        relationship = edit.relationship ?? "part_of";
      }
    }
    return {
      target: records.map((record) =>
        record.id === edit.id
          ? { ...record, parentId, displayGroupId, relationship }
          : record,
      ),
      entityId: edit.id,
    };
  }

  if (edit.op === "reorder") {
    const siblings = records.filter(
      (record) => (record.parentId ?? record.displayGroupId) === edit.parentId,
    );
    const wanted = new Set(edit.orderedIds);
    if (
      wanted.size !== edit.orderedIds.length ||
      siblings.length !== wanted.size ||
      siblings.some((record) => !wanted.has(record.id))
    )
      return edits("The order must list each sibling exactly once.", "reorder");
    const position = new Map(edit.orderedIds.map((id, index) => [id, index]));
    return {
      target: records.map((record) =>
        position.has(record.id)
          ? { ...record, displayOrder: position.get(record.id) as number }
          : record,
      ),
      entityId: null,
    };
  }

  // delete
  const current = byId.get(edit.id);
  if (!current) return edits("The unit does not exist.", "not_found");
  const children = records.filter(
    (record) =>
      record.parentId === edit.id || record.displayGroupId === edit.id,
  );
  if (children.length > 0)
    return edits(
      `Move or delete the ${children.length} unit${children.length === 1 ? "" : "s"} under it first.`,
      "has_children",
    );
  return {
    target: records.filter((record) => record.id !== edit.id),
    entityId: edit.id,
  };
}

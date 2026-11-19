import { IMPORT_REF } from "../contracts/profiles-import.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { assertCredentialFree } from "./audit.js";
import {
  type AttachmentCounts,
  type AttachmentItem,
  type AttachmentLookups,
  attachmentDigestInput,
  parseAttachmentCsv,
  planAttachments,
} from "./county-role-attachment.js";
import { authorizeCountyStructure } from "./county-structure-auth.js";
import {
  CountyStructureConflictError,
  CountyStructureNotFoundError,
  CountyStructureValidationError,
} from "./county-structure-d1.js";
import type { TrustedPrincipal } from "./security.js";
import { IMPORTER_BATCH_KEY_PREFIX } from "./sync-commit-d1.js";

/**
 * Role-to-unit attachment on the Website D1 binding.
 *
 * The owner previews one county's rows from the reviewed role file, then
 * commits the exact preview. Each attachment is one reviewed `home` row in
 * `county_role_display`, the same row the dashboard's single-role control
 * writes. The Profile and role are never copied, and no other table changes.
 * The matching rules are in county-role-attachment.ts.
 *
 * The commit is one atomic batch of set-based statements. Every insert and
 * remap carries the state the preview saw and is followed by an exact row
 * count assertion, so a change after the preview fails the whole batch. The
 * idempotency key is recorded in an append-only audit row, which is also the
 * receipt that a retry returns.
 */

const PAGE = 1000;
const CHUNK = 400;
const MAX_FILE_CHARS = 2 * 1024 * 1024;
const FIPS = /^08\d{3}$/;
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const COMMIT_ACTION = "county_structure.role_attachment.commit";

export interface RoleAttachmentPreview {
  readonly countyFips: string;
  readonly fileSha256: string;
  /** Bind the commit to this exact preview. */
  readonly digest: string;
  readonly counts: AttachmentCounts;
  readonly ignoredColumns: readonly string[];
  readonly items: readonly AttachmentItem[];
  /** True when nothing is blocked and at least one link would change. */
  readonly committable: boolean;
}

export interface RoleAttachmentCommitRequest {
  readonly csv: string;
  readonly countyFips: string;
  readonly digest: string;
  readonly idempotencyKey: string;
}

export interface RoleAttachmentReceipt {
  readonly countyFips: string;
  readonly digest: string;
  readonly attached: number;
  readonly remapped: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly replayed: boolean;
}

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size)
    out.push(list.slice(index, index + size));
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class D1CountyRoleAttachments {
  constructor(
    private readonly database: AsyncD1Database,
    private readonly newIdentifier: () => string = () => crypto.randomUUID(),
  ) {}

  /** Read-only. Writes nothing. */
  async preview(
    principal: TrustedPrincipal,
    request: { readonly csv: string; readonly countyFips: string },
  ): Promise<RoleAttachmentPreview> {
    await authorizeCountyStructure(this.database, principal);
    return this.plan(request);
  }

  async commit(
    principal: TrustedPrincipal,
    request: RoleAttachmentCommitRequest,
  ): Promise<RoleAttachmentReceipt> {
    await authorizeCountyStructure(this.database, principal);
    if (!KEY.test(request.idempotencyKey))
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "idempotency_key",
          message:
            "The idempotency key must be 8 to 128 letters, digits or . _ : -.",
        },
      ]);
    const stored = await this.receipt(request.idempotencyKey);
    if (stored) {
      if (stored.digest !== request.digest)
        throw new CountyStructureConflictError(
          "idempotency_reuse",
          "This idempotency key was already used for a different preview.",
        );
      return { ...stored, replayed: true };
    }
    const preview = await this.plan(request);
    if (preview.digest !== request.digest)
      throw new CountyStructureConflictError(
        "stale_preview",
        "The roles, units or links changed since this preview. Preview again.",
      );
    if (!preview.committable)
      throw new CountyStructureConflictError(
        "blocked",
        preview.counts.blocked > 0
          ? `${preview.counts.blocked} row${preview.counts.blocked === 1 ? " is" : "s are"} blocked. Resolve them and preview again.`
          : "Nothing to attach or remap.",
      );

    const attach = preview.items
      .filter((item) => item.action === "attach")
      .map((item) => ({
        id: this.newIdentifier(),
        roleId: item.websiteRoleId as string,
        unitId: item.unitId as string,
        countyFips: item.countyFips,
      }));
    const remap = preview.items
      .filter((item) => item.action === "remap")
      .map((item) => ({
        id: item.currentDisplayId as string,
        version: item.currentDisplayVersion as number,
        from: item.currentUnitId as string,
        unitId: item.unitId as string,
      }));
    const statements: D1BatchStatement[] = [
      this.assertion(
        `NOT EXISTS (SELECT 1 FROM audit_events WHERE action = '${COMMIT_ACTION}' AND target_id = ?)`,
        [request.idempotencyKey],
      ),
    ];
    for (const part of chunks(attach))
      statements.push(
        this.database.prepare(
          `INSERT INTO county_role_display
             (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
           SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.roleId'),
                  json_extract(j.value, '$.countyFips'), json_extract(j.value, '$.unitId'), 'home', ?
           FROM json_each(?) AS j
           WHERE NOT EXISTS (
             SELECT 1 FROM county_role_display d
             WHERE d.person_role_id = json_extract(j.value, '$.roleId') AND d.listing = 'home')`,
          [principal.accountId, JSON.stringify(part)],
        ),
        this.assertion("changes() = ?", [part.length]),
      );
    for (const part of chunks(remap))
      statements.push(
        this.database.prepare(
          `UPDATE county_role_display
              SET unit_id = json_extract(j.value, '$.unitId'), version = county_role_display.version + 1,
                  reviewed_by_account_id = ?, reviewed_at = ${NOW}, updated_at = ${NOW}
             FROM json_each(?) AS j
            WHERE county_role_display.id = json_extract(j.value, '$.id')
              AND county_role_display.version = json_extract(j.value, '$.version')
              AND county_role_display.unit_id = json_extract(j.value, '$.from')
              AND county_role_display.listing = 'home'`,
          [principal.accountId, JSON.stringify(part)],
        ),
        this.assertion("changes() = ?", [part.length]),
      );
    const receipt: RoleAttachmentReceipt = {
      countyFips: request.countyFips,
      digest: preview.digest,
      attached: attach.length,
      remapped: remap.length,
      unchanged: preview.counts.unchanged,
      skipped: preview.counts.skipped,
      replayed: false,
    };
    statements.push(this.audit(principal, request.idempotencyKey, receipt));

    const generation = await this.database.readDependencyGeneration();
    try {
      await this.database.guardedBatch(generation, principal, statements);
    } catch (error) {
      const raced = await this.receipt(request.idempotencyKey);
      if (raced && raced.digest === request.digest)
        return { ...raced, replayed: true };
      if ((await this.plan(request)).digest !== request.digest)
        throw new CountyStructureConflictError(
          "stale_preview",
          "The roles, units or links changed during the commit. Preview again.",
        );
      throw error;
    }
    return receipt;
  }

  private assertion(condition: string, values: (string | number)[]) {
    return this.database.prepare(
      `INSERT INTO website_write_assertions (id, valid)
       SELECT ?, CASE WHEN ${condition} THEN 1 ELSE 0 END`,
      [this.newIdentifier(), ...values],
    );
  }

  private audit(
    principal: TrustedPrincipal,
    key: string,
    receipt: RoleAttachmentReceipt,
  ): D1BatchStatement {
    const summary = `Attached ${receipt.attached} and remapped ${receipt.remapped} Profile roles in county ${receipt.countyFips}`;
    const details = {
      countyFips: receipt.countyFips,
      digest: receipt.digest,
      attached: String(receipt.attached),
      remapped: String(receipt.remapped),
      unchanged: String(receipt.unchanged),
      skipped: String(receipt.skipped),
    };
    assertCredentialFree({
      action: COMMIT_ACTION,
      targetType: "county_structure",
      targetId: key,
      summary,
      details,
    });
    return this.database.prepare(
      `INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json)
       VALUES (?, ?, ?, 'county_structure', ?, ?, ?)`,
      [
        this.newIdentifier(),
        principal.accountId,
        COMMIT_ACTION,
        key,
        summary,
        JSON.stringify(details),
      ],
    );
  }

  private async receipt(key: string): Promise<RoleAttachmentReceipt | null> {
    const row = await this.database.first<{ details_json: string }>(
      `SELECT details_json FROM audit_events WHERE action = '${COMMIT_ACTION}' AND target_id = ?`,
      [key],
    );
    if (!row) return null;
    const details = JSON.parse(row.details_json) as Record<string, string>;
    return {
      countyFips: String(details.countyFips),
      digest: String(details.digest),
      attached: Number(details.attached),
      remapped: Number(details.remapped),
      unchanged: Number(details.unchanged),
      skipped: Number(details.skipped),
      replayed: false,
    };
  }

  private async plan(request: {
    readonly csv: string;
    readonly countyFips: string;
  }): Promise<RoleAttachmentPreview> {
    if (typeof request.csv !== "string" || request.csv.length > MAX_FILE_CHARS)
      throw new CountyStructureValidationError([
        {
          row: 0,
          column: null,
          code: "csv_too_large",
          message:
            "The role file must be 2 MiB or smaller. Upload one county's rows.",
        },
      ]);
    const county = FIPS.test(request.countyFips)
      ? await this.database.first("SELECT fips FROM counties WHERE fips = ?", [
          request.countyFips,
        ])
      : null;
    if (!county) throw new CountyStructureNotFoundError("Unknown county.");
    const parsed = parseAttachmentCsv(request.csv);
    if (parsed.issues.length > 0)
      throw new CountyStructureValidationError(
        parsed.issues.map((issue) => ({
          row: issue.line ?? 0,
          column: null,
          code: issue.code,
          message: issue.key ? `${issue.key}: ${issue.message}` : issue.message,
        })),
      );
    const rows = parsed.rows.filter(
      (row) => row.countyFips === request.countyFips,
    );
    const lookups = await this.lookups(
      [...new Set(rows.map((row) => row.roleKey))],
      [...new Set(rows.flatMap((row) => (row.unitId ? [row.unitId] : [])))],
    );
    const { items, counts } = planAttachments(
      parsed.rows,
      request.countyFips,
      lookups,
    );
    const fileSha256 = await sha256Hex(request.csv);
    const digest = await sha256Hex(
      attachmentDigestInput(request.countyFips, fileSha256, items),
    );
    return {
      countyFips: request.countyFips,
      fileSha256,
      digest,
      counts,
      ignoredColumns: parsed.ignoredColumns,
      items,
      committable: counts.blocked === 0 && counts.attach + counts.remap > 0,
    };
  }

  private async lookups(
    roleKeys: readonly string[],
    unitIds: readonly string[],
  ): Promise<AttachmentLookups> {
    const roles = new Map<string, string>();
    for (const part of chunks(roleKeys.map((key) => IMPORT_REF.role + key))) {
      // The mapping rule of the dashboard Profiles import: items committed by
      // an importer batch that has not been reversed, earliest first.
      const rows = await this.database.all<{ ref: string; id: string }>(
        `SELECT i.client_ref AS ref, i.target_id AS id
         FROM sync_batch_items i
         JOIN sync_batches b ON b.id = i.batch_id
         LEFT JOIN sync_batch_reversals r ON r.batch_id = i.batch_id
         WHERE r.batch_id IS NULL AND i.outcome IN ('created', 'reused')
           AND substr(b.idempotency_key, 1, ${IMPORTER_BATCH_KEY_PREFIX.length}) = '${IMPORTER_BATCH_KEY_PREFIX}'
           AND i.client_ref IN (SELECT value FROM json_each(?))
         ORDER BY b.committed_at, i.batch_id, i.item_index`,
        PAGE,
        [JSON.stringify(part)],
      );
      for (const row of rows) {
        const key = row.ref.slice(IMPORT_REF.role.length);
        if (!roles.has(key)) roles.set(key, row.id);
      }
    }
    const roleCounties = new Map<string, string | null>();
    const homes = new Map<
      string,
      { id: string; unitId: string; version: number }[]
    >();
    for (const part of chunks([...new Set(roles.values())])) {
      const json = JSON.stringify(part);
      for (const row of await this.database.all<{
        id: string;
        county_fips: string | null;
      }>(
        "SELECT id, county_fips FROM person_roles WHERE id IN (SELECT value FROM json_each(?))",
        PAGE,
        [json],
      ))
        roleCounties.set(row.id, row.county_fips);
      for (const row of await this.database.all<{
        id: string;
        person_role_id: string;
        unit_id: string;
        version: number;
      }>(
        `SELECT id, person_role_id, unit_id, version FROM county_role_display
         WHERE listing = 'home' AND person_role_id IN (SELECT value FROM json_each(?))
         ORDER BY id`,
        PAGE,
        [json],
      )) {
        const list = homes.get(row.person_role_id) ?? [];
        list.push({ id: row.id, unitId: row.unit_id, version: row.version });
        homes.set(row.person_role_id, list);
      }
    }
    const units = new Map<string, string>();
    for (const part of chunks(unitIds))
      for (const row of await this.database.all<{
        id: string;
        county_fips: string;
      }>(
        "SELECT id, county_fips FROM county_unit WHERE id IN (SELECT value FROM json_each(?))",
        PAGE,
        [JSON.stringify(part)],
      ))
        units.set(row.id, row.county_fips);
    return { roles, roleCounties, units, homes };
  }
}

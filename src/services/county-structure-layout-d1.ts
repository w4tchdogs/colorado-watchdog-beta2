import {
  COUNTY_STRUCTURE_ELECTED_GROUP_KEY,
  COUNTY_STRUCTURE_LAYOUT_CATEGORIES,
  type CountyStructureLayout,
  type CountyStructureLayoutGroup,
  type CountyStructurePinColumn,
  type CountyStructurePinnedGroup,
  displayGroupLayoutKey,
} from "../contracts/county-structure.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { assertCredentialFree } from "./audit.js";
import { authorizeCountyStructure } from "./county-structure-auth.js";
import {
  CountyStructureConflictError,
  CountyStructureNotFoundError,
  CountyStructureValidationError,
} from "./county-structure-d1.js";
import { sha256Hex } from "./county-structure-plan.js";
import { newId, type TrustedPrincipal } from "./security.js";

const FIPS = /^08\d{3}$/;
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

interface LayoutRow {
  readonly group_id: string;
  readonly pinned_column: CountyStructurePinColumn;
  readonly position: number;
}

interface LayoutHistoryRow {
  readonly id: string;
  readonly layout_version: number;
  readonly request_sha256: string;
  readonly after_json: string;
}

export interface SaveCountyStructureLayoutRequest {
  readonly countyFips: string;
  readonly expectedVersion: number;
  readonly pinnedGroups: readonly CountyStructurePinnedGroup[];
  readonly idempotencyKey: string;
}

export interface SaveCountyStructureLayoutResult {
  readonly version: number;
  readonly pinnedGroups: readonly CountyStructurePinnedGroup[];
  readonly replayed: boolean;
  readonly noop: boolean;
}

export class D1CountyStructureLayoutAdministration {
  constructor(
    private readonly database: AsyncD1Database,
    private readonly newIdentifier: () => string = newId,
  ) {}

  async get(
    principal: TrustedPrincipal,
    countyFips: string,
  ): Promise<CountyStructureLayout> {
    await authorizeCountyStructure(this.database, principal);
    await this.assertCounty(countyFips);
    const [state, groups, pinnedGroups] = await Promise.all([
      this.database.first<{ version: number }>(
        "SELECT version FROM county_structure_layout_state WHERE county_fips = ?",
        [countyFips],
      ),
      this.availableGroups(countyFips),
      this.readPinnedGroups(countyFips),
    ]);
    if (!state) throw new Error("County Structure layout state is unavailable");
    return {
      countyFips,
      version: Number(state.version),
      availableGroups: groups,
      pinnedGroups,
    };
  }

  async save(
    principal: TrustedPrincipal,
    request: SaveCountyStructureLayoutRequest,
  ): Promise<SaveCountyStructureLayoutResult> {
    await authorizeCountyStructure(this.database, principal);
    await this.assertCounty(request.countyFips);
    if (
      !Number.isSafeInteger(request.expectedVersion) ||
      request.expectedVersion < 0 ||
      !KEY.test(request.idempotencyKey)
    )
      throw this.invalid(
        "A valid layout version and request key are required.",
      );

    const pinnedGroups = this.validatePins(request.pinnedGroups);
    const availableGroups = await this.availableGroups(request.countyFips);
    const available = new Set(availableGroups.map((group) => group.id));
    if (pinnedGroups.some((group) => !available.has(group.groupId)))
      throw this.invalid("A pinned group is not available in this county.");

    const requestSha = await sha256Hex(
      JSON.stringify({ countyFips: request.countyFips, pinnedGroups }),
    );
    const prior = await this.database.first<LayoutHistoryRow>(
      `SELECT id, layout_version, request_sha256, after_json
       FROM county_structure_layout_history
       WHERE county_fips = ? AND idempotency_key = ?`,
      [request.countyFips, request.idempotencyKey],
    );
    if (prior) {
      if (prior.request_sha256 !== requestSha)
        throw new CountyStructureConflictError(
          "idempotency_reuse",
          "That request key was already used for another layout.",
        );
      return {
        version: Number(prior.layout_version),
        pinnedGroups: JSON.parse(
          prior.after_json,
        ) as CountyStructurePinnedGroup[],
        replayed: true,
        noop: false,
      };
    }

    const before = await this.readPinnedGroups(request.countyFips);
    const state = await this.database.first<{ version: number }>(
      "SELECT version FROM county_structure_layout_state WHERE county_fips = ?",
      [request.countyFips],
    );
    if (!state) throw new Error("County Structure layout state is unavailable");
    const currentVersion = Number(state.version);
    if (currentVersion !== request.expectedVersion)
      throw new CountyStructureConflictError(
        "stale_version",
        "The pinned layout changed. Reload it and try again.",
      );

    const noop = JSON.stringify(before) === JSON.stringify(pinnedGroups);
    const version = currentVersion + (noop ? 0 : 1);
    const historyId = this.newIdentifier();
    const statements: D1BatchStatement[] = [
      this.database.prepare(
        `INSERT INTO website_write_assertions (id, valid)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM county_structure_layout_state
           WHERE county_fips = ? AND version = ?
         ) THEN 1 ELSE 0 END`,
        [this.newIdentifier(), request.countyFips, currentVersion],
      ),
    ];
    if (!noop) {
      statements.push(
        this.database.prepare(
          "DELETE FROM county_structure_pinned_group WHERE county_fips = ?",
          [request.countyFips],
        ),
      );
      for (const group of pinnedGroups) {
        statements.push(
          this.database.prepare(
            `INSERT INTO county_structure_pinned_group
               (county_fips, group_id, pinned_column, position)
             VALUES (?, ?, ?, ?)`,
            [request.countyFips, group.groupId, group.column, group.position],
          ),
        );
      }
      statements.push(
        this.database.prepare(
          `UPDATE county_structure_layout_state
           SET version = version + 1, updated_at = ${NOW}
           WHERE county_fips = ? AND version = ?`,
          [request.countyFips, currentVersion],
        ),
        this.database.prepare(
          "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes())",
          [this.newIdentifier()],
        ),
      );
    }
    statements.push(
      this.database.prepare(
        `INSERT INTO county_structure_layout_history
           (id, county_fips, layout_version, actor_account_id, idempotency_key,
            request_sha256, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyId,
          request.countyFips,
          version,
          principal.accountId,
          request.idempotencyKey,
          requestSha,
          JSON.stringify(before),
          JSON.stringify(pinnedGroups),
        ],
      ),
      this.database.prepare(
        "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes())",
        [this.newIdentifier()],
      ),
      this.audit(principal, request.countyFips, historyId, version, noop),
      this.database.prepare("DELETE FROM website_write_assertions"),
    );

    const generation = await this.database.readDependencyGeneration();
    try {
      await this.database.guardedBatch(generation, principal, statements);
    } catch (error) {
      const latest = await this.database.first<{ version: number }>(
        "SELECT version FROM county_structure_layout_state WHERE county_fips = ?",
        [request.countyFips],
      );
      if (Number(latest?.version) !== currentVersion)
        throw new CountyStructureConflictError(
          "stale_version",
          "The pinned layout changed. Reload it and try again.",
        );
      throw error;
    }
    return { version, pinnedGroups, replayed: false, noop };
  }

  private async assertCounty(countyFips: string): Promise<void> {
    if (!FIPS.test(countyFips)) throw new CountyStructureNotFoundError();
    const county = await this.database.first<{ fips: string }>(
      "SELECT fips FROM counties WHERE fips = ?",
      [countyFips],
    );
    if (!county) throw new CountyStructureNotFoundError();
  }

  private async availableGroups(
    countyFips: string,
  ): Promise<CountyStructureLayoutGroup[]> {
    const groups = await this.database.all<{ id: string; name: string }>(
      `SELECT id, name FROM county_unit_display
       WHERE county_fips = ? AND status = 'active' ORDER BY display_order, name, id`,
      100,
      [countyFips],
    );
    return [
      { id: COUNTY_STRUCTURE_ELECTED_GROUP_KEY, name: "Elected Officials" },
      ...COUNTY_STRUCTURE_LAYOUT_CATEGORIES,
      ...groups.map(({ id, name }) => ({
        id: displayGroupLayoutKey(id),
        name,
      })),
    ];
  }

  private async readPinnedGroups(
    countyFips: string,
  ): Promise<CountyStructurePinnedGroup[]> {
    const rows = await this.database.all<LayoutRow>(
      `SELECT group_id, pinned_column, position
       FROM county_structure_pinned_group
       WHERE county_fips = ?
       ORDER BY pinned_column, position, group_id`,
      100,
      [countyFips],
    );
    return rows.map((row) => ({
      groupId: row.group_id,
      column: row.pinned_column,
      position: Number(row.position),
    }));
  }

  private validatePins(
    input: readonly CountyStructurePinnedGroup[],
  ): CountyStructurePinnedGroup[] {
    if (!Array.isArray(input) || input.length > 100)
      throw this.invalid("Choose no more than 100 pinned groups.");
    const pins: CountyStructurePinnedGroup[] = [];
    const seenGroups = new Set<string>();
    const positions: Record<CountyStructurePinColumn, Set<number>> = {
      left: new Set(),
      right: new Set(),
    };
    for (const candidate of input as readonly unknown[]) {
      const item =
        candidate && typeof candidate === "object"
          ? (candidate as Partial<CountyStructurePinnedGroup>)
          : null;
      if (
        !item ||
        typeof item.groupId !== "string" ||
        item.groupId.length > 256 ||
        (item.column !== "left" && item.column !== "right") ||
        typeof item.position !== "number" ||
        !Number.isSafeInteger(item.position) ||
        item.position < 1 ||
        item.position > 100 ||
        seenGroups.has(item.groupId) ||
        positions[item.column].has(item.position)
      )
        throw this.invalid("Pinned groups need unique columns and positions.");
      seenGroups.add(item.groupId);
      positions[item.column].add(item.position);
      pins.push({
        groupId: item.groupId,
        column: item.column,
        position: item.position,
      });
    }
    for (const column of ["left", "right"] as const) {
      const ordered = [...positions[column]].sort((a, b) => a - b);
      if (ordered.some((position, index) => position !== index + 1))
        throw this.invalid(
          "Positions in each column must start at 1 with no gaps.",
        );
    }
    return pins.sort(
      (a, b) =>
        a.column.localeCompare(b.column) ||
        a.position - b.position ||
        a.groupId.localeCompare(b.groupId),
    );
  }

  private invalid(message: string): CountyStructureValidationError {
    return new CountyStructureValidationError(
      [{ row: 0, column: null, code: "layout", message }],
      "The pinned layout is not valid",
    );
  }

  private audit(
    principal: TrustedPrincipal,
    countyFips: string,
    targetId: string,
    version: number,
    noop: boolean,
  ): D1BatchStatement {
    const action = noop
      ? "county_structure.layout.noop"
      : "county_structure.layout.save";
    const details = { countyFips, version: String(version) };
    assertCredentialFree({
      action,
      targetType: "county_structure",
      targetId,
      summary: noop
        ? "Confirmed county layout preferences"
        : "Updated county layout preferences",
      details,
    });
    return this.database.prepare(
      `INSERT INTO audit_events
         (id, actor_account_id, action, target_type, target_id, summary, details_json)
       VALUES (?, ?, ?, 'county_structure', ?, ?, ?)`,
      [
        this.newIdentifier(),
        principal.accountId,
        action,
        targetId,
        noop
          ? "Confirmed county layout preferences"
          : "Updated county layout preferences",
        JSON.stringify(details),
      ],
    );
  }
}

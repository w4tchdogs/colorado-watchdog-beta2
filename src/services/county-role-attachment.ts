import { readCsvTable } from "./county-structure-csv.js";
import { normalizeHeader } from "./profiles-import-csv.js";

/**
 * Pure planning for attaching imported Profile roles to County Structure units
 * (role-to-unit attachment). No database access.
 *
 * The owner uploads the reviewed role file, which carries the intended
 * `County unit ID` for each role. Each row is matched by stable IDs only: the
 * private `role_id` resolves to a Website role through the mapping the
 * dashboard Profiles import recorded (`dash:role:<role_id>`), and the unit is
 * the County Structure stable unit ID. The row's county FIPS must equal the
 * role's county and the unit's county. Names and titles are never matched.
 *
 * An attachment is one reviewed `home` row in `county_role_display`. A row
 * with a blank unit ID changes nothing, and an existing link is never removed
 * by this workflow. A role whose Profile has not been imported yet is skipped,
 * not blocked, so the file can be re-run after the next Profiles import.
 */

export const ATTACHMENT_COLUMNS = [
  "role_id",
  "county_fips",
  "county_unit_id",
] as const;

const FIPS = /^08\d{3}$/;
const ROLE_KEY = /^[A-Za-z0-9._:-]{1,100}$/;
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAX_ATTACHMENT_ROWS = 20_000;

export interface AttachmentIssue {
  readonly line: number | null;
  readonly code: string;
  readonly message: string;
  readonly key?: string;
}

export interface AttachmentRow {
  readonly line: number;
  readonly roleKey: string;
  readonly countyFips: string;
  readonly unitId: string | null;
}

export interface ParsedAttachmentFile {
  readonly rows: readonly AttachmentRow[];
  readonly ignoredColumns: readonly string[];
  readonly issues: readonly AttachmentIssue[];
}

/** Reads the role file. Only the three matching columns are used. */
export function parseAttachmentCsv(text: string): ParsedAttachmentFile {
  const issues: AttachmentIssue[] = [];
  const table = readCsvTable(text);
  if ("error" in table)
    return {
      rows: [],
      ignoredColumns: [],
      issues: [
        {
          line: table.error.row,
          code: "malformed_csv",
          message: table.error.message,
        },
      ],
    };
  const [header, ...body] = table.rows;
  if (!header || header.every((cell) => cell.trim() === ""))
    return {
      rows: [],
      ignoredColumns: [],
      issues: [
        {
          line: null,
          code: "empty_file",
          message: "The file has no header row.",
        },
      ],
    };
  const names = header.map(normalizeHeader);
  const position = new Map<string, number>();
  names.forEach((name, index) => {
    if (!position.has(name)) position.set(name, index);
  });
  for (const column of ATTACHMENT_COLUMNS)
    if (!position.has(column))
      issues.push({
        line: 1,
        code: "missing_column",
        message: `The file needs a ${column} column.`,
      });
  if (issues.length > 0) return { rows: [], ignoredColumns: [], issues };
  if (body.length > MAX_ATTACHMENT_ROWS)
    return {
      rows: [],
      ignoredColumns: [],
      issues: [
        {
          line: null,
          code: "too_many_rows",
          message: `The file has more than ${MAX_ATTACHMENT_ROWS} rows.`,
        },
      ],
    };
  const ignoredColumns = [
    ...new Set(
      names.filter(
        (name) =>
          name !== "" &&
          !(ATTACHMENT_COLUMNS as readonly string[]).includes(name),
      ),
    ),
  ];
  const cell = (cells: readonly string[], column: string) =>
    (cells[position.get(column) as number] ?? "").trim();
  const rows: AttachmentRow[] = [];
  body.forEach((cells, index) => {
    const line = index + 2;
    if (cells.every((value) => value.trim() === "")) return;
    const roleKey = cell(cells, "role_id");
    const countyFips = cell(cells, "county_fips");
    const unit = cell(cells, "county_unit_id");
    if (!ROLE_KEY.test(roleKey)) {
      issues.push({
        line,
        code: "role_id",
        message: "role_id is missing or malformed.",
      });
      return;
    }
    if (!FIPS.test(countyFips)) {
      issues.push({
        line,
        code: "county_fips",
        message: "county_fips must be a Colorado county code such as 08013.",
        key: roleKey,
      });
      return;
    }
    if (unit !== "" && !UNIT_ID.test(unit)) {
      issues.push({
        line,
        code: "county_unit_id",
        message: "county_unit_id is malformed.",
        key: roleKey,
      });
      return;
    }
    rows.push({ line, roleKey, countyFips, unitId: unit === "" ? null : unit });
  });
  return { rows, ignoredColumns, issues };
}

export type AttachmentAction =
  | "attach"
  | "remap"
  | "unchanged"
  | "unattached"
  | "skipped"
  | "blocked";

export interface AttachmentItem {
  readonly line: number;
  readonly roleKey: string;
  readonly countyFips: string;
  readonly unitId: string | null;
  readonly websiteRoleId: string | null;
  /** The unit of the role's current home listing, when it has one. */
  readonly currentUnitId: string | null;
  readonly currentDisplayId: string | null;
  readonly currentDisplayVersion: number | null;
  readonly action: AttachmentAction;
  readonly reason: string | null;
}

export interface AttachmentCounts {
  readonly rows: number;
  readonly otherCounties: number;
  readonly attach: number;
  readonly remap: number;
  readonly unchanged: number;
  readonly unattached: number;
  readonly skipped: number;
  readonly blocked: number;
}

/** What the database says about the keys in one county's rows. */
export interface AttachmentLookups {
  /** Private role key to Website role ID, from the Profiles import mapping. */
  readonly roles: ReadonlyMap<string, string>;
  /** Website role ID to its county (null when the role has none). */
  readonly roleCounties: ReadonlyMap<string, string | null>;
  /** County Structure unit ID to its county. */
  readonly units: ReadonlyMap<string, string>;
  /** Website role ID to its current home listings. */
  readonly homes: ReadonlyMap<
    string,
    readonly { id: string; unitId: string; version: number }[]
  >;
}

export function planAttachments(
  rows: readonly AttachmentRow[],
  countyFips: string,
  lookups: AttachmentLookups,
): { items: AttachmentItem[]; counts: AttachmentCounts } {
  const inCounty = rows.filter((row) => row.countyFips === countyFips);
  const wanted = new Map<string, Set<string>>();
  for (const row of inCounty)
    if (row.unitId !== null) {
      const set = wanted.get(row.roleKey) ?? new Set<string>();
      set.add(row.unitId);
      wanted.set(row.roleKey, set);
    }
  const seen = new Set<string>();
  const items: AttachmentItem[] = [];
  for (const row of inCounty) {
    const websiteRoleId = lookups.roles.get(row.roleKey) ?? null;
    const homes = websiteRoleId ? (lookups.homes.get(websiteRoleId) ?? []) : [];
    const home = homes.length === 1 ? homes[0] : undefined;
    const base = {
      line: row.line,
      roleKey: row.roleKey,
      countyFips: row.countyFips,
      unitId: row.unitId,
      websiteRoleId,
      currentUnitId: home?.unitId ?? null,
      currentDisplayId: home?.id ?? null,
      currentDisplayVersion: home?.version ?? null,
    };
    const result = (action: AttachmentAction, reason: string | null = null) =>
      items.push({ ...base, action, reason });

    if (row.unitId === null) {
      result("unattached", "No county unit ID. Existing links are kept.");
      continue;
    }
    if ((wanted.get(row.roleKey)?.size ?? 0) > 1) {
      result("blocked", "The file gives this role more than one county unit.");
      continue;
    }
    const duplicateKey = `${row.roleKey}\u0000${row.unitId}`;
    if (seen.has(duplicateKey)) {
      result("unchanged", "Repeated row.");
      continue;
    }
    seen.add(duplicateKey);
    if (!websiteRoleId) {
      result(
        "skipped",
        "This role has not been imported to the Website yet. Import its Profile first.",
      );
      continue;
    }
    const roleCounty = lookups.roleCounties.get(websiteRoleId);
    if (roleCounty === undefined) {
      result("blocked", "The imported role no longer exists on the Website.");
      continue;
    }
    if (roleCounty !== row.countyFips) {
      result(
        "blocked",
        `The role is recorded in county ${roleCounty ?? "(none)"}, not ${row.countyFips}.`,
      );
      continue;
    }
    const unitCounty = lookups.units.get(row.unitId);
    if (unitCounty === undefined) {
      result("blocked", `County unit ${row.unitId} does not exist.`);
      continue;
    }
    if (unitCounty !== row.countyFips) {
      result(
        "blocked",
        `County unit ${row.unitId} belongs to county ${unitCounty}, not ${row.countyFips}.`,
      );
      continue;
    }
    if (homes.length > 1) {
      result(
        "blocked",
        "The role already has more than one home listing. Resolve it in the dashboard first.",
      );
      continue;
    }
    if (!home) result("attach");
    else if (home.unitId === row.unitId) result("unchanged");
    else result("remap", `Moves the role from ${home.unitId}.`);
  }
  const count = (action: AttachmentAction) =>
    items.filter((item) => item.action === action).length;
  return {
    items,
    counts: {
      rows: rows.length,
      otherCounties: rows.length - inCounty.length,
      attach: count("attach"),
      remap: count("remap"),
      unchanged: count("unchanged"),
      unattached: count("unattached"),
      skipped: count("skipped"),
      blocked: count("blocked"),
    },
  };
}

/** Digest of everything a commit would act on, bound to the current state. */
export function attachmentDigestInput(
  countyFips: string,
  fileSha256: string,
  items: readonly AttachmentItem[],
): string {
  return JSON.stringify([
    "county-role-attachment/v1",
    countyFips,
    fileSha256,
    items.map((item) => [
      item.line,
      item.roleKey,
      item.unitId,
      item.websiteRoleId,
      item.currentDisplayId,
      item.currentDisplayVersion,
      item.currentUnitId,
      item.action,
    ]),
  ]);
}

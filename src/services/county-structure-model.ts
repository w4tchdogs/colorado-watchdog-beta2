import {
  COUNTY_CSV_COLUMNS,
  type CountyCsvColumn,
  type CsvIssue,
  DISPLAY_GROUP_TYPE,
  type ParsedCountyFile,
  type StructureRecord,
} from "../contracts/county-structure.js";
import { serializeAliases, writeCsvTable } from "./county-structure-csv.js";

/**
 * Pure structure rules (COUNTY-DB-1): parent resolution, validation, canonical
 * form, tree order and CSV export. The same rules validate an import, a merge
 * and every dashboard edit, so one definition of a valid county exists.
 */

export const MAX_DEPTH = 12;

export interface ExternalRecord {
  readonly countyFips: string;
  readonly kind: "unit" | "display_group";
}

/**
 * Turns parsed rows into records, resolving every Parent ID against the file
 * and, for a merge, against units already stored for the same counties.
 */
export function resolveRecords(
  file: ParsedCountyFile,
  external: ReadonlyMap<string, ExternalRecord> = new Map(),
): { records: StructureRecord[]; issues: CsvIssue[] } {
  const issues: CsvIssue[] = [];
  const inFile = new Map(file.rows.map((row) => [row.id, row]));
  const records: StructureRecord[] = [];
  for (const row of file.rows) {
    const issue = (column: CountyCsvColumn, code: string, message: string) =>
      issues.push({ row: row.rowNumber, column, code, message });
    if (row.parentRef === null) {
      records.push(row.record);
      continue;
    }
    const inside = inFile.get(row.parentRef);
    const outside = external.get(row.parentRef);
    const parentKind = inside
      ? inside.isGroup
        ? "display_group"
        : "unit"
      : outside?.kind;
    const parentCounty = inside ? inside.countyFips : outside?.countyFips;
    if (!parentKind || parentCounty === undefined) {
      issue(
        "Parent office or unit ID",
        "parent_missing",
        `Parent ${row.parentRef} is not in this file or the stored structure.`,
      );
      continue;
    }
    if (parentCounty !== row.countyFips) {
      issue(
        "Parent office or unit ID",
        "parent_cross_county",
        `Parent ${row.parentRef} belongs to county ${parentCounty}, not ${row.countyFips}.`,
      );
      continue;
    }
    if (parentKind === "display_group") {
      if (
        row.relationshipRaw !== null &&
        row.relationshipRaw !== "display_group"
      ) {
        issue(
          "Relationship to parent",
          "relationship_mismatch",
          "A row under a display grouping must use display_group or leave the relationship blank.",
        );
        continue;
      }
      records.push({
        ...row.record,
        displayGroupId: row.parentRef,
        relationship: "display_group",
      });
    } else {
      if (row.relationshipRaw === "display_group") {
        issue(
          "Relationship to parent",
          "relationship_mismatch",
          "display_group is only for a row under a display grouping.",
        );
        continue;
      }
      records.push({
        ...row.record,
        parentId: row.parentRef,
        relationship:
          row.relationshipRaw === "reports_to" ? "reports_to" : "part_of",
      });
    }
  }
  return { records, issues };
}

export interface ValidateOptions {
  /** Row numbers and readable columns of file rows, to report and compare. */
  readonly file?: ParsedCountyFile;
}

/** Names from the top grouping or unit down to the record, root first. */
export function ancestorChain(
  record: StructureRecord,
  byId: ReadonlyMap<string, StructureRecord>,
): StructureRecord[] | null {
  const chain: StructureRecord[] = [record];
  const seen = new Set([record.id]);
  let current = record;
  while (current.parentId !== null || current.displayGroupId !== null) {
    const next = byId.get(
      (current.parentId ?? current.displayGroupId) as string,
    );
    if (!next || seen.has(next.id)) return null;
    seen.add(next.id);
    chain.unshift(next);
    current = next;
    if (chain.length > MAX_DEPTH + 1) return null;
  }
  return chain;
}

/** Whole-structure rules. `records` is the complete target for its counties. */
export function validateStructure(
  records: readonly StructureRecord[],
  options: ValidateOptions = {},
): CsvIssue[] {
  const issues: CsvIssue[] = [];
  const rowOf = new Map(options.file?.rows.map((row) => [row.id, row]) ?? []);
  const report = (
    id: string,
    column: CountyCsvColumn | null,
    code: string,
    message: string,
  ) =>
    issues.push({
      row: rowOf.get(id)?.rowNumber ?? 0,
      column,
      code,
      message: rowOf.has(id) ? message : `${id}: ${message}`,
    });

  const byId = new Map<string, StructureRecord>();
  for (const record of records) {
    if (byId.has(record.id)) {
      report(
        record.id,
        "Office or unit ID",
        "duplicate_unit_id",
        `Unit ID ${record.id} is used more than once.`,
      );
      continue;
    }
    byId.set(record.id, record);
  }

  for (const record of byId.values()) {
    const parentId = record.parentId ?? record.displayGroupId;
    if (parentId !== null) {
      const parent = byId.get(parentId);
      if (!parent) {
        report(
          record.id,
          "Parent office or unit ID",
          "parent_missing",
          `Parent ${parentId} does not exist.`,
        );
        continue;
      }
      if (parent.countyFips !== record.countyFips) {
        report(
          record.id,
          "Parent office or unit ID",
          "parent_cross_county",
          `Parent ${parentId} belongs to another county.`,
        );
        continue;
      }
      if (record.parentId !== null && parent.kind !== "unit")
        report(
          record.id,
          "Parent office or unit ID",
          "parent_kind",
          "A structural parent must be a unit.",
        );
      if (record.displayGroupId !== null && parent.kind !== "display_group")
        report(
          record.id,
          "Parent office or unit ID",
          "parent_kind",
          "A display grouping parent must be a grouping.",
        );
    }
    if (record.kind === "display_group" && parentId !== null)
      report(
        record.id,
        "Parent office or unit ID",
        "group_parent",
        "A display grouping cannot have a parent.",
      );
  }
  if (issues.length > 0) return issues;

  for (const record of byId.values()) {
    const chain = ancestorChain(record, byId);
    if (!chain) {
      report(
        record.id,
        "Parent office or unit ID",
        "parent_cycle",
        "The parent chain forms a cycle or is deeper than 12 levels.",
      );
      continue;
    }
    const row = rowOf.get(record.id);
    if (!row) continue;
    const [a, b, c] = row.readable;
    if (a === "" && b === "" && c === "") continue;
    const expected = [0, 1, 2].map((level) => chain[level]?.name ?? "");
    const given = [a, b, c];
    const labels = [
      "County Unit",
      "County Sub Unit",
      "County Sub Sub Unit",
    ] as const;
    for (let level = 0; level < 3; level += 1) {
      if (given[level] !== expected[level]) {
        report(
          record.id,
          labels[level] as CountyCsvColumn,
          "readable_mismatch",
          `${labels[level]} is "${given[level]}" but the parent IDs give "${expected[level]}". Parent IDs decide the hierarchy.`,
        );
        break;
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------- canonical form

/** Fixed key order so equal records always serialize to the same text. */
export function canonicalRecord(record: StructureRecord): StructureRecord {
  return {
    kind: record.kind,
    id: record.id,
    countyFips: record.countyFips,
    parentId: record.parentId,
    displayGroupId: record.displayGroupId,
    relationship: record.relationship,
    name: record.name,
    organizationType: record.organizationType,
    status: record.status,
    appliesFrom: record.appliesFrom,
    appliesUntil: record.appliesUntil,
    displayOrder: record.displayOrder,
    aliases: record.aliases.map((alias) => ({
      name: alias.name,
      kind: alias.kind,
    })),
    evidence: record.evidence,
    sources: record.sources,
  };
}

export function recordJson(record: StructureRecord): string {
  return JSON.stringify(canonicalRecord(record));
}

export function sameRecord(left: StructureRecord, right: StructureRecord) {
  return recordJson(left) === recordJson(right);
}

/** Depth among `ids`: records whose parent is also in the set come later. */
export function dependencyDepth(
  records: readonly StructureRecord[],
): Map<string, number> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const depth = new Map<string, number>();
  const visit = (record: StructureRecord, guard: number): number => {
    const known = depth.get(record.id);
    if (known !== undefined) return known;
    if (guard > MAX_DEPTH + 2) return 0;
    const parent = byId.get(
      (record.parentId ?? record.displayGroupId) as string,
    );
    const value = parent ? visit(parent, guard + 1) + 1 : 0;
    depth.set(record.id, value);
    return value;
  };
  for (const record of records) visit(record, 0);
  return depth;
}

// ----------------------------------------------------------------- tree order

const collator = (left: string, right: string) => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

function siblingOrder(left: StructureRecord, right: StructureRecord): number {
  const a = left.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const b = right.displayOrder ?? Number.MAX_SAFE_INTEGER;
  if (a !== b) return a < b ? -1 : 1;
  const byName = collator(left.name, right.name);
  return byName !== 0 ? byName : collator(left.id, right.id);
}

/** Depth-first order per county: groups and top-level units, then children. */
export function orderTree(
  records: readonly StructureRecord[],
): { record: StructureRecord; depth: number }[] {
  const children = new Map<string | null, StructureRecord[]>();
  for (const record of records) {
    const key = record.parentId ?? record.displayGroupId;
    const list = children.get(key) ?? [];
    list.push(record);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort(siblingOrder);
  const out: { record: StructureRecord; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const record of children.get(parent) ?? []) {
      out.push({ record, depth });
      walk(record.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// ---------------------------------------------------------------------- export

/**
 * The complete `county.csv`. Counties without any record get one county-only
 * row. Rows are ordered by county code, then in tree order, so exporting the
 * same structure twice gives identical bytes.
 */
export function exportCountyCsv(
  registry: ReadonlyMap<string, string>,
  records: readonly StructureRecord[],
  onlyCounty?: string,
): string {
  const byCounty = new Map<string, StructureRecord[]>();
  for (const record of records) {
    const list = byCounty.get(record.countyFips) ?? [];
    list.push(record);
    byCounty.set(record.countyFips, list);
  }
  const rows: string[][] = [];
  for (const fips of [...registry.keys()].sort()) {
    if (onlyCounty !== undefined && fips !== onlyCounty) continue;
    const name = registry.get(fips) as string;
    const own = byCounty.get(fips) ?? [];
    if (own.length === 0) {
      rows.push([
        fips,
        name,
        ...Array<string>(COUNTY_CSV_COLUMNS.length - 2).fill(""),
      ]);
      continue;
    }
    const byId = new Map(own.map((record) => [record.id, record]));
    for (const { record } of orderTree(own)) {
      const chain = ancestorChain(record, byId) ?? [record];
      rows.push([
        fips,
        name,
        record.id,
        record.name,
        record.parentId ?? record.displayGroupId ?? "",
        chain[0]?.name ?? "",
        chain[1]?.name ?? "",
        chain[2]?.name ?? "",
        record.organizationType === DISPLAY_GROUP_TYPE
          ? DISPLAY_GROUP_TYPE
          : record.organizationType,
        serializeAliases(record.aliases),
        record.relationship ?? "",
        record.evidence ?? "",
        record.sources ?? "",
        record.appliesFrom ?? "",
        record.appliesUntil ?? "",
        record.displayOrder === null ? "" : String(record.displayOrder),
        record.status,
      ]);
    }
  }
  return writeCsvTable(rows);
}

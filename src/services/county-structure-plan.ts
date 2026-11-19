import type {
  ChangeAction,
  ChangeCounts,
  ChangeItem,
  Changeset,
  CsvIssue,
  ImportMode,
  ParsedCountyFile,
  StructureRecord,
} from "../contracts/county-structure.js";
import {
  canonicalRecord,
  dependencyDepth,
  type ExternalRecord,
  recordJson,
  resolveRecords,
  sameRecord,
  validateStructure,
} from "./county-structure-model.js";

/**
 * Deterministic changeset planning (COUNTY-DB-1). Pure: it receives the stored
 * structure and Profile reference counts, and returns exact item-level changes.
 * Every import mode and every dashboard edit reduces to "make this county
 * structure the target", then this diff.
 */

export interface PlanInput {
  readonly mode: ImportMode;
  readonly countyFips: string | null;
  readonly file: ParsedCountyFile;
  readonly registry: ReadonlyMap<string, string>;
  /** Every stored record, in any county. */
  readonly current: readonly StructureRecord[];
  /** Distinct Profile roles referencing each stored unit. */
  readonly profileReferences: ReadonlyMap<string, number>;
}

export interface PlanResult {
  readonly changeset: Changeset | null;
  readonly issues: readonly CsvIssue[];
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const fileIssue = (code: string, message: string): CsvIssue => ({
  row: 0,
  column: null,
  code,
  message,
});

export async function planImport(input: PlanInput): Promise<PlanResult> {
  const { mode, file, registry } = input;
  const fileCounties = [...file.counties.keys()].sort();
  const issues: CsvIssue[] = [];

  let scope: Set<string>;
  if (mode === "replace_county") {
    const fips = input.countyFips;
    if (!fips || !registry.has(fips))
      return {
        changeset: null,
        issues: [
          fileIssue("county_required", "Choose one valid county to replace."),
        ],
      };
    scope = new Set([fips]);
    const others = fileCounties.filter((code) => code !== fips);
    if (others.length > 0)
      issues.push(
        fileIssue(
          "county_scope",
          `The file also names other counties (${others.slice(0, 5).join(", ")}). A one-county replacement file must contain only ${fips}.`,
        ),
      );
    if (!file.counties.has(fips))
      issues.push(
        fileIssue(
          "county_missing",
          `The file has no rows for ${fips}. Use a county-only row to replace a county with an empty structure.`,
        ),
      );
  } else if (mode === "replace_state") {
    scope = new Set(registry.keys());
    const missing = [...registry.keys()].filter(
      (code) => !file.counties.has(code),
    );
    if (missing.length > 0)
      issues.push(
        fileIssue(
          "statewide_coverage",
          `A statewide replacement must include all 64 counties. Missing ${missing.length}: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}.`,
        ),
      );
  } else {
    scope = new Set(fileCounties);
    if (scope.size === 0)
      issues.push(fileIssue("county_missing", "The file names no counties."));
  }
  if (issues.length > 0) return { changeset: null, issues };

  const currentById = new Map(
    input.current.map((record) => [record.id, record]),
  );
  const external = new Map<string, ExternalRecord>();
  if (mode === "merge") {
    for (const record of input.current)
      if (scope.has(record.countyFips))
        external.set(record.id, {
          countyFips: record.countyFips,
          kind: record.kind,
        });
  }
  // Identifier ownership: an ID never changes county or kind.
  for (const row of file.rows) {
    const existing = currentById.get(row.id);
    if (existing && existing.countyFips !== row.countyFips)
      issues.push({
        row: row.rowNumber,
        column: "Office or unit ID",
        code: "id_county_changed",
        message: `Unit ID ${row.id} already belongs to county ${existing.countyFips}. Stable IDs cannot move between counties.`,
      });
    else if (existing && existing.kind !== row.record.kind)
      issues.push({
        row: row.rowNumber,
        column: "Office or unit ID",
        code: "id_kind_changed",
        message: `Unit ID ${row.id} is stored as a ${existing.kind === "unit" ? "unit" : "display grouping"} and cannot change kind.`,
      });
  }
  const resolved = resolveRecords(file, external);
  issues.push(...resolved.issues);
  if (issues.length > 0) return { changeset: null, issues };

  const fileById = new Map(
    resolved.records.map((record) => [record.id, record]),
  );
  const target: StructureRecord[] = [];
  for (const record of input.current)
    if (
      scope.has(record.countyFips) &&
      (mode === "merge" ? !fileById.has(record.id) : false)
    )
      target.push(record);
  target.push(...resolved.records);
  const structural = validateStructure(target, { file });
  if (structural.length > 0) return { changeset: null, issues: structural };

  const changeset = await diffStructures({
    mode,
    countyFips: input.countyFips,
    scope,
    current: input.current,
    target,
    removeAbsent: mode !== "merge",
    profileReferences: input.profileReferences,
  });
  return { changeset, issues: [] };
}

export interface DiffInput {
  readonly mode: ImportMode;
  readonly countyFips: string | null;
  readonly scope: ReadonlySet<string>;
  readonly current: readonly StructureRecord[];
  readonly target: readonly StructureRecord[];
  readonly removeAbsent: boolean;
  readonly profileReferences: ReadonlyMap<string, number>;
}

function classify(
  before: StructureRecord,
  after: StructureRecord,
): ChangeAction {
  if (
    before.parentId !== after.parentId ||
    before.displayGroupId !== after.displayGroupId ||
    before.relationship !== after.relationship
  )
    return "move";
  const leaving = (status: string) =>
    status === "former" || status === "historical";
  if (!leaving(before.status) && leaving(after.status)) return "retire";
  return "update";
}

export async function diffStructures(input: DiffInput): Promise<Changeset> {
  const before = new Map<string, StructureRecord>();
  for (const record of input.current)
    if (input.scope.has(record.countyFips)) before.set(record.id, record);
  const after = new Map(input.target.map((record) => [record.id, record]));
  const depth = dependencyDepth([...before.values(), ...after.values()]);

  const draft: Omit<ChangeItem, "seq">[] = [];
  let unchanged = 0;
  for (const record of after.values()) {
    const old = before.get(record.id);
    if (!old) {
      draft.push({
        entityType: record.kind,
        entityId: record.id,
        countyFips: record.countyFips,
        action: "add",
        blocked: false,
        reason: null,
        profileReferences: 0,
        before: null,
        after: canonicalRecord(record),
      });
    } else if (sameRecord(old, record)) {
      unchanged += 1;
    } else {
      draft.push({
        entityType: record.kind,
        entityId: record.id,
        countyFips: record.countyFips,
        action: classify(old, record),
        blocked: false,
        reason: null,
        profileReferences: input.profileReferences.get(record.id) ?? 0,
        before: canonicalRecord(old),
        after: canonicalRecord(record),
      });
    }
  }
  if (input.removeAbsent) {
    for (const old of before.values()) {
      if (after.has(old.id)) continue;
      const references = input.profileReferences.get(old.id) ?? 0;
      draft.push({
        entityType: old.kind,
        entityId: old.id,
        countyFips: old.countyFips,
        action: "remove",
        blocked: references > 0,
        reason:
          references > 0
            ? `${references} Profile role${references === 1 ? " is" : "s are"} linked to this unit. Keep the unit in the file or reassign those roles first.`
            : null,
        profileReferences: references,
        before: canonicalRecord(old),
        after: null,
      });
    }
  }
  const kindRank = (kind: string) => (kind === "display_group" ? 0 : 1);
  draft.sort((left, right) => {
    if (left.countyFips !== right.countyFips)
      return left.countyFips < right.countyFips ? -1 : 1;
    if (kindRank(left.entityType) !== kindRank(right.entityType))
      return kindRank(left.entityType) - kindRank(right.entityType);
    const a = depth.get(left.entityId) ?? 0;
    const b = depth.get(right.entityId) ?? 0;
    if (a !== b) return a - b;
    return left.entityId < right.entityId
      ? -1
      : left.entityId > right.entityId
        ? 1
        : 0;
  });
  const items: ChangeItem[] = draft.map((item, seq) => ({ seq, ...item }));
  const counts = countItems(items, unchanged);
  const checksum = await sha256Hex(
    JSON.stringify({
      mode: input.mode,
      countyFips: input.countyFips,
      items: items.map((item) => ({
        action: item.action,
        id: item.entityId,
        before: item.before ? recordJson(item.before) : null,
        after: item.after ? recordJson(item.after) : null,
        blocked: item.blocked,
      })),
    }),
  );
  return {
    mode: input.mode,
    countyFips: input.countyFips,
    items,
    counts,
    checksum,
  };
}

export function countItems(
  items: readonly ChangeItem[],
  unchanged: number,
): ChangeCounts {
  const counts = { add: 0, update: 0, move: 0, retire: 0, remove: 0 };
  let blocked = 0;
  let affected = 0;
  for (const item of items) {
    counts[item.action] += 1;
    if (item.blocked) blocked += 1;
    if (item.action !== "add") affected += item.profileReferences;
  }
  return { ...counts, unchanged, blocked, affectedProfileReferences: affected };
}

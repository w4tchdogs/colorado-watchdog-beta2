/**
 * County Structure contract (COUNTY-DB-1).
 *
 * The 17 owner-facing `county.csv` columns, the allowed values, and the records
 * every layer shares. The CSV format is specified in
 * docs/architecture/county-structure-csv.md.
 */

export const COUNTY_CSV_COLUMNS = [
  "County code",
  "County name",
  "Office or unit ID",
  "Office or unit name",
  "Parent office or unit ID",
  "County Unit",
  "County Sub Unit",
  "County Sub Sub Unit",
  "Organization type",
  "Alternate names",
  "Relationship to parent",
  "Evidence for relationship",
  "Source references",
  "Applies from",
  "Applies until",
  "Display order",
  "Status",
] as const;

export type CountyCsvColumn = (typeof COUNTY_CSV_COLUMNS)[number];

/** One raw CSV row keyed by column, every value a string ("" when blank). */
export type CountyCsvRow = Readonly<Record<CountyCsvColumn, string>>;

export const ORGANIZATION_TYPES = [
  "office",
  "department",
  "board",
  "commission",
  "division",
  "section",
  "authority",
  "district",
  "program",
  "other",
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/** `display_group` marks a navigation grouping row, never a structural unit. */
export const DISPLAY_GROUP_TYPE = "display_group";

export const UNIT_STATUSES = [
  "active",
  "former",
  "historical",
  "review_required",
  "hidden",
] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const PARENT_RELATIONSHIPS = [
  "part_of",
  "reports_to",
  "display_group",
] as const;
export type ParentRelationship = (typeof PARENT_RELATIONSHIPS)[number];

export const ALIAS_KINDS = ["alternate", "historical", "abbreviation"] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export const IMPORT_MODES = [
  "merge",
  "replace_county",
  "replace_state",
] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const COUNTY_STRUCTURE_API_PREFIX = "/api/admin/county-structure";
export const COUNTY_STRUCTURE_CAPABILITY = "county_structure.manage";

export const COUNTY_STRUCTURE_ELECTED_GROUP_KEY = "listing:elected_officials";
export const COUNTY_STRUCTURE_LAYOUT_CATEGORIES = [
  { id: "category:departments", name: "Departments" },
  { id: "category:offices", name: "Offices" },
  { id: "category:boards", name: "Boards" },
  { id: "category:commissions", name: "Commissions" },
  { id: "category:other", name: "Other" },
] as const;
export const displayGroupLayoutKey = (id: string): string =>
  `display-group:${id}`;
export type CountyStructurePinColumn = "left" | "right";

export interface CountyStructureLayoutGroup {
  readonly id: string;
  readonly name: string;
}

export interface CountyStructurePinnedGroup {
  readonly groupId: string;
  readonly column: CountyStructurePinColumn;
  readonly position: number;
}

export interface CountyStructureLayout {
  readonly countyFips: string;
  readonly version: number;
  readonly availableGroups: readonly CountyStructureLayoutGroup[];
  readonly pinnedGroups: readonly CountyStructurePinnedGroup[];
}

export const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAX_CSV_BYTES = 1_048_576;
export const MAX_CSV_ROWS = 20_000;
/**
 * Limit for each private provenance field (Evidence for relationship, Source
 * references). Migration 0033 raised it from 4,000 so long source lists, such
 * as an 8,816 character statewide reference, import and export unchanged.
 */
export const MAX_TEXT = 32_768;

export interface AliasRecord {
  readonly name: string;
  readonly kind: AliasKind;
}

/**
 * One structural unit or one display grouping. A grouping has `kind:
 * "display_group"`, no parent, no relationship and no aliases.
 *
 * `parentId` is the reporting parent. `displayGroupId` is browse placement
 * only, with relationship `display_group`: it names either a display grouping
 * or, for a nested browse placement such as a program listed under CSU
 * Extension, another unit of the same county. A unit has at most one of the
 * two, so browse placement never implies a reporting relationship.
 */
export interface StructureRecord {
  readonly kind: "unit" | "display_group";
  readonly id: string;
  readonly countyFips: string;
  readonly parentId: string | null;
  readonly displayGroupId: string | null;
  readonly relationship: ParentRelationship | null;
  readonly name: string;
  readonly organizationType: OrganizationType | typeof DISPLAY_GROUP_TYPE;
  readonly status: UnitStatus;
  readonly appliesFrom: string | null;
  readonly appliesUntil: string | null;
  readonly displayOrder: number | null;
  readonly aliases: readonly AliasRecord[];
  readonly evidence: string | null;
  readonly sources: string | null;
}

/** A parsed row before parent references are resolved against units and groupings. */
export interface ParsedRow {
  readonly rowNumber: number;
  readonly countyFips: string;
  readonly id: string;
  readonly parentRef: string | null;
  readonly relationshipRaw: string | null;
  readonly isGroup: boolean;
  readonly record: StructureRecord;
  /** The three readable grouping columns exactly as written (trimmed). */
  readonly readable: readonly [string, string, string];
}

export interface ParsedCountyFile {
  /** Every county named by the file, including counties with no units. */
  readonly counties: ReadonlyMap<string, string>;
  readonly rows: readonly ParsedRow[];
}

export interface CsvIssue {
  /** 1-based file row (the header is row 1), or 0 for a file-level issue. */
  readonly row: number;
  readonly column: CountyCsvColumn | null;
  readonly code: string;
  readonly message: string;
}

export type ChangeAction = "add" | "update" | "move" | "retire" | "remove";

export interface ChangeItem {
  readonly seq: number;
  readonly entityType: "unit" | "display_group";
  readonly entityId: string;
  readonly countyFips: string;
  readonly action: ChangeAction;
  readonly blocked: boolean;
  readonly reason: string | null;
  /** Profile roles that reference the unit and would be affected. */
  readonly profileReferences: number;
  readonly before: StructureRecord | null;
  readonly after: StructureRecord | null;
}

export interface ChangeCounts {
  readonly add: number;
  readonly update: number;
  readonly move: number;
  readonly retire: number;
  readonly remove: number;
  readonly unchanged: number;
  readonly blocked: number;
  readonly affectedProfileReferences: number;
}

export interface Changeset {
  readonly mode: ImportMode;
  readonly countyFips: string | null;
  readonly items: readonly ChangeItem[];
  readonly counts: ChangeCounts;
  readonly checksum: string;
}

export interface ImportSummary {
  readonly id: string;
  readonly mode: ImportMode | "reversal";
  readonly countyFips: string | null;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly changesetSha256: string;
  readonly baseVersion: number;
  readonly afterVersion: number | null;
  readonly status: "prepared" | "committed" | "blocked" | "reversed";
  readonly counts: ChangeCounts;
  readonly reversesImportId: string | null;
  readonly reversedByImportId: string | null;
  readonly createdAt: string;
  readonly committedAt: string | null;
}

export interface PreparedImport {
  readonly import: ImportSummary;
  readonly items: readonly ChangeItem[];
  readonly issues: readonly CsvIssue[];
  /** False when the file has errors or any item is blocked. */
  readonly committable: boolean;
}

export interface UnitNode {
  readonly record: StructureRecord;
  readonly profileReferences: number;
  readonly children: readonly UnitNode[];
}

export interface CountyStructureCounts {
  readonly units: number;
  readonly subunits: number;
  readonly displayGroups: number;
  readonly profiles: number;
  readonly unresolved: number;
}

export interface CountySummary {
  readonly fips: string;
  readonly name: string;
  readonly counts: CountyStructureCounts;
}

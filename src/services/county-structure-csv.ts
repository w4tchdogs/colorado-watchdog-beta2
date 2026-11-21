import {
  ALIAS_KINDS,
  type AliasKind,
  type AliasRecord,
  COUNTY_CSV_COLUMNS,
  type CountyCsvColumn,
  type CountyCsvRow,
  type CsvIssue,
  DISPLAY_GROUP_TYPE,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  MAX_TEXT,
  ORGANIZATION_TYPES,
  type OrganizationType,
  PARENT_RELATIONSHIPS,
  type ParentRelationship,
  type ParsedCountyFile,
  type ParsedRow,
  type StructureRecord,
  UNIT_ID_PATTERN,
  UNIT_STATUSES,
  type UnitStatus,
} from "../contracts/county-structure.js";

/**
 * Pure `county.csv` reading and writing (COUNTY-DB-1). No database access.
 * The format is specified in docs/architecture/county-structure-csv.md.
 */

const COLUMN_COUNT = COUNTY_CSV_COLUMNS.length;
const FIPS = /^\d{5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ORDER = /^\d{1,9}$/;
const MAX_NAME = 300;

// ------------------------------------------------------------------- reading

type RawTable = { readonly rows: string[][] } | { readonly error: CsvIssue };

/** RFC 4180 reader: quoted fields, doubled quotes, embedded line breaks. */
export function readCsvTable(input: string): RawTable {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
    quoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (fieldStarted) {
        return {
          error: {
            row: rows.length + 1,
            column: null,
            code: "csv_quote_misplaced",
            message: "A quote appears in the middle of an unquoted field.",
          },
        };
      }
      inQuotes = true;
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      if (quoted) {
        return {
          error: {
            row: rows.length + 1,
            column: null,
            code: "csv_quote_misplaced",
            message: "Text follows a closing quote inside a field.",
          },
        };
      }
      field += char;
      fieldStarted = true;
    }
    if (rows.length > MAX_CSV_ROWS + 1) {
      return {
        error: {
          row: 0,
          column: null,
          code: "csv_too_many_rows",
          message: `The file has more than ${MAX_CSV_ROWS} rows.`,
        },
      };
    }
  }
  if (inQuotes) {
    return {
      error: {
        row: rows.length + 1,
        column: null,
        code: "csv_unterminated_quote",
        message: "A quoted field is never closed.",
      },
    };
  }
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return { rows };
}

export interface ParseResult {
  readonly file: ParsedCountyFile | null;
  readonly issues: readonly CsvIssue[];
}

function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === "");
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function privateText(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.trim() === "" ? null : normalized;
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
): T | null {
  const lowered = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(lowered)
    ? (lowered as T)
    : null;
}

export function parseAliases(
  value: string,
): { aliases: AliasRecord[] } | { error: string } {
  if (value.trim() === "") return { aliases: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: "Alternate names must be a JSON array." };
  }
  if (!Array.isArray(parsed))
    return { error: "Alternate names must be a JSON array." };
  const aliases: AliasRecord[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    let name: unknown;
    let kind: unknown = "alternate";
    if (typeof entry === "string") name = entry;
    else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const keys = Object.keys(entry);
      if (keys.some((key) => key !== "name" && key !== "kind"))
        return { error: 'An alias object may only have "name" and "kind".' };
      name = (entry as Record<string, unknown>).name;
      kind = (entry as Record<string, unknown>).kind ?? "alternate";
    } else {
      return { error: "Each alternate name must be a string or an object." };
    }
    if (typeof name !== "string")
      return { error: "Each alternate name needs a text name." };
    const trimmed = name.trim().normalize("NFC");
    if (trimmed === "" || trimmed.length > MAX_NAME)
      return { error: `Alternate names must be 1 to ${MAX_NAME} characters.` };
    if (
      typeof kind !== "string" ||
      !(ALIAS_KINDS as readonly string[]).includes(kind)
    )
      return {
        error: "An alias kind must be alternate, historical or abbreviation.",
      };
    if (seen.has(trimmed))
      return { error: `The alternate name "${trimmed}" is listed twice.` };
    seen.add(trimmed);
    aliases.push({ name: trimmed, kind: kind as AliasKind });
  }
  return { aliases };
}

export function serializeAliases(aliases: readonly AliasRecord[]): string {
  if (aliases.length === 0) return "";
  return JSON.stringify(
    aliases.map((alias) =>
      alias.kind === "alternate"
        ? alias.name
        : { name: alias.name, kind: alias.kind },
    ),
  );
}

/**
 * Parses text into rows with local validation only. Parent resolution, cycles,
 * readable-column agreement and registry coverage happen later, against the
 * resulting structure.
 */
export function parseCountyCsv(
  text: string,
  registry: ReadonlyMap<string, string>,
): ParseResult {
  const issues: CsvIssue[] = [];
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    return {
      file: null,
      issues: [
        {
          row: 0,
          column: null,
          code: "csv_too_large",
          message: "county.csv must be 1 MiB or smaller.",
        },
      ],
    };
  }
  const table = readCsvTable(text);
  if ("error" in table) return { file: null, issues: [table.error] };
  const [header, ...body] = table.rows;
  if (!header) {
    return {
      file: null,
      issues: [
        {
          row: 0,
          column: null,
          code: "csv_empty",
          message: "The file is empty.",
        },
      ],
    };
  }
  const names = header.map((cell) => cell.trim());
  if (
    names.length !== COLUMN_COUNT ||
    names.some((name, index) => name !== COUNTY_CSV_COLUMNS[index])
  ) {
    return {
      file: null,
      issues: [
        {
          row: 1,
          column: null,
          code: "header_mismatch",
          message: `The header must be exactly these ${COLUMN_COUNT} columns in order: ${COUNTY_CSV_COLUMNS.join(", ")}.`,
        },
      ],
    };
  }

  const counties = new Map<string, string>();
  const rows: ParsedRow[] = [];
  body.forEach((cells, index) => {
    const rowNumber = index + 2;
    if (isBlankRow(cells)) return;
    const issue = (
      column: CountyCsvColumn | null,
      code: string,
      message: string,
    ) => issues.push({ row: rowNumber, column, code, message });
    if (cells.length !== COLUMN_COUNT) {
      issue(
        null,
        "column_count",
        `The row has ${cells.length} values, not ${COLUMN_COUNT}.`,
      );
      return;
    }
    const raw = Object.fromEntries(
      COUNTY_CSV_COLUMNS.map((column, position) => [
        column,
        cells[position] as string,
      ]),
    ) as CountyCsvRow;

    const code = raw["County code"].trim();
    if (!FIPS.test(code)) {
      issue(
        "County code",
        "county_code_format",
        "County code must be five digits, including leading zeroes.",
      );
      return;
    }
    const registered = registry.get(code);
    if (registered === undefined) {
      issue(
        "County code",
        "county_unknown",
        `County code ${code} is not a Colorado county.`,
      );
      return;
    }
    const countyName = raw["County name"].trim().normalize("NFC");
    if (countyName !== registered) {
      issue(
        "County name",
        "county_name_mismatch",
        `County name must be "${registered}" for ${code}.`,
      );
      return;
    }
    counties.set(code, registered);

    const id = raw["Office or unit ID"].trim();
    if (id === "") {
      const extra = COUNTY_CSV_COLUMNS.slice(2).filter(
        (column) => raw[column].trim() !== "",
      );
      if (extra.length > 0)
        issue(
          extra[0] as CountyCsvColumn,
          "root_row_has_data",
          "A county-only row must leave every column after County name blank.",
        );
      return;
    }
    if (!UNIT_ID_PATTERN.test(id)) {
      issue(
        "Office or unit ID",
        "unit_id_format",
        "Unit IDs use letters, digits and . _ : - only, start with a letter or digit and run to 128 characters.",
      );
      return;
    }

    let valid = true;
    const fail = (column: CountyCsvColumn, code: string, message: string) => {
      valid = false;
      issue(column, code, message);
    };

    const name = raw["Office or unit name"].trim().normalize("NFC");
    if (name === "" || name.length > MAX_NAME)
      fail(
        "Office or unit name",
        "unit_name",
        `Unit name must be 1 to ${MAX_NAME} characters.`,
      );

    const typeText = raw["Organization type"].trim().toLowerCase();
    const isGroup = typeText === DISPLAY_GROUP_TYPE;
    let organizationType: StructureRecord["organizationType"] =
      DISPLAY_GROUP_TYPE;
    if (!isGroup) {
      const type = oneOf<OrganizationType>(typeText, ORGANIZATION_TYPES);
      if (!type)
        fail(
          "Organization type",
          "organization_type",
          `Organization type must be one of ${ORGANIZATION_TYPES.join(", ")} or ${DISPLAY_GROUP_TYPE}.`,
        );
      else organizationType = type;
    }

    const statusText = raw.Status.trim();
    let status: UnitStatus = "active";
    if (statusText !== "") {
      const parsed = oneOf<UnitStatus>(statusText, UNIT_STATUSES);
      if (!parsed)
        fail(
          "Status",
          "status",
          `Status must be one of ${UNIT_STATUSES.join(", ")}, or blank for active.`,
        );
      else status = parsed;
    }

    const dates: Array<string | null> = [];
    for (const column of ["Applies from", "Applies until"] as const) {
      const value = raw[column].trim();
      if (value === "") dates.push(null);
      else if (!validDate(value)) {
        fail(
          column,
          "date_format",
          `${column} must be a real date written YYYY-MM-DD, or blank.`,
        );
        dates.push(null);
      } else dates.push(value);
    }
    const [appliesFrom, appliesUntil] = dates as [string | null, string | null];
    if (appliesFrom && appliesUntil && appliesUntil < appliesFrom)
      fail(
        "Applies until",
        "date_range",
        "Applies until cannot be earlier than Applies from.",
      );

    const orderText = raw["Display order"].trim();
    let displayOrder: number | null = null;
    if (orderText !== "") {
      if (!ORDER.test(orderText))
        fail(
          "Display order",
          "display_order",
          "Display order must be a whole number of zero or more, or blank.",
        );
      else displayOrder = Number(orderText);
    }

    const aliasResult = parseAliases(raw["Alternate names"]);
    let aliases: AliasRecord[] = [];
    if ("error" in aliasResult)
      fail("Alternate names", "aliases", aliasResult.error);
    else aliases = aliasResult.aliases;
    if (isGroup && aliases.length > 0)
      fail(
        "Alternate names",
        "group_aliases",
        "A display grouping cannot have alternate names.",
      );

    const evidence = privateText(raw["Evidence for relationship"]);
    const sources = privateText(raw["Source references"]);
    if (evidence && evidence.length > MAX_TEXT)
      fail(
        "Evidence for relationship",
        "text_length",
        `Evidence is limited to ${MAX_TEXT} characters.`,
      );
    if (sources && sources.length > MAX_TEXT)
      fail(
        "Source references",
        "text_length",
        `Source references are limited to ${MAX_TEXT} characters.`,
      );

    const parentRef = raw["Parent office or unit ID"].trim() || null;
    if (parentRef !== null && !UNIT_ID_PATTERN.test(parentRef))
      fail(
        "Parent office or unit ID",
        "parent_id_format",
        "Parent IDs use the same format as unit IDs.",
      );
    if (parentRef === id)
      fail(
        "Parent office or unit ID",
        "parent_self",
        "A unit cannot be its own parent.",
      );

    const relationshipText = raw["Relationship to parent"].trim();
    let relationshipRaw: string | null = null;
    if (relationshipText !== "") {
      const relationship = oneOf<ParentRelationship>(
        relationshipText,
        PARENT_RELATIONSHIPS,
      );
      if (!relationship)
        fail(
          "Relationship to parent",
          "relationship",
          `Relationship must be one of ${PARENT_RELATIONSHIPS.join(", ")}, or blank.`,
        );
      else relationshipRaw = relationship;
    }
    if (parentRef === null && relationshipRaw !== null)
      fail(
        "Relationship to parent",
        "relationship_without_parent",
        "A top-level row has no parent, so Relationship to parent must be blank.",
      );
    if (isGroup && parentRef !== null)
      fail(
        "Parent office or unit ID",
        "group_parent",
        "A display grouping is top-level and cannot have a parent.",
      );

    if (!valid) return;
    const record: StructureRecord = {
      kind: isGroup ? "display_group" : "unit",
      id,
      countyFips: code,
      parentId: null,
      displayGroupId: null,
      relationship: null,
      name,
      organizationType,
      status,
      appliesFrom,
      appliesUntil,
      displayOrder,
      aliases,
      evidence,
      sources,
    };
    rows.push({
      rowNumber,
      countyFips: code,
      id,
      parentRef,
      relationshipRaw,
      isGroup,
      record,
      readable: [
        raw["County Unit"].trim().normalize("NFC"),
        raw["County Sub Unit"].trim().normalize("NFC"),
        raw["County Sub Sub Unit"].trim().normalize("NFC"),
      ],
    });
  });

  const seen = new Map<string, number>();
  for (const row of rows) {
    const first = seen.get(row.id);
    if (first !== undefined)
      issues.push({
        row: row.rowNumber,
        column: "Office or unit ID",
        code: "duplicate_unit_id",
        message: `Unit ID ${row.id} is already used on row ${first}.`,
      });
    else seen.set(row.id, row.rowNumber);
  }
  const folded = new Map<string, string>();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined && other !== row.id)
      issues.push({
        row: row.rowNumber,
        column: "Office or unit ID",
        code: "unit_id_case",
        message: `Unit ID ${row.id} differs from ${other} only by letter case.`,
      });
    else folded.set(key, row.id);
  }

  if (issues.length > 0) return { file: null, issues };
  return { file: { counties, rows }, issues };
}

// ------------------------------------------------------------------- writing

function quote(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() || value === ""
    ? value === ""
      ? ""
      : `"${value.replaceAll('"', '""')}"`
    : value;
}

/** Deterministic text: header first, CRLF line ends, a final line break. */
export function writeCsvTable(
  rows: readonly (readonly string[])[],
  header: readonly string[] = COUNTY_CSV_COLUMNS,
): string {
  const lines = [header.map(quote).join(",")];
  for (const row of rows) lines.push(row.map(quote).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

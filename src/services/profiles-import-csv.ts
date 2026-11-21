import {
  ALTERNATE_NAME_TYPES,
  type AlternateNameType,
  PROFILES_MAX_NAME_LENGTH,
} from "../contracts/profiles.js";
import {
  HEADER_ALIASES,
  IMPORT_ROLE_TEXT_LIMITS,
  type ImportIssue,
  NAME_FILE,
  NAME_FILE_COLUMNS,
  PROFILE_FILE,
  PROFILE_FILE_COLUMNS,
  PROFILE_NAME_COMPONENT_COLUMNS,
  PROFILES_IMPORT_MAX_ROWS,
  type ProfilesImportFileName,
  ROLE_FILE,
  ROLE_FILE_COLUMNS,
} from "../contracts/profiles-import.js";
import type { PersonNameComponentField } from "../contracts/sync.js";

/**
 * Pure CSV reading and row validation for the dashboard Profiles import. No
 * database access. Every rejected row becomes a readable issue with its file
 * and line, and nothing is guessed or repaired.
 */
export interface ParsedFile {
  readonly file: ProfilesImportFileName;
  readonly headers: readonly string[];
  readonly ignoredColumns: readonly string[];
  readonly rows: readonly {
    readonly line: number;
    readonly values: Readonly<Record<string, string>>;
  }[];
  readonly issues: readonly ImportIssue[];
}

const MAX_FIELD = 4_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** RFC 4180 reader. Returns records with their starting line number. */
export function readCsv(text: string): {
  readonly records: readonly {
    readonly line: number;
    readonly cells: string[];
  }[];
  readonly error: string | null;
} {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let sawContent = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      sawContent = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
      sawContent = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      if (sawContent || cell !== "" || cells.length > 0) {
        cells.push(cell);
        records.push({ line: startLine, cells });
      }
      cells = [];
      cell = "";
      sawContent = false;
      line++;
      startLine = line;
    } else {
      cell += ch;
      sawContent = true;
    }
    if (cell.length > MAX_FIELD)
      return {
        records,
        error: `A field on line ${startLine} is longer than ${MAX_FIELD} characters.`,
      };
  }
  if (quoted)
    return {
      records,
      error: `A quoted field starting on line ${startLine} is never closed.`,
    };
  if (sawContent || cell !== "" || cells.length > 0) {
    cells.push(cell);
    records.push({ line: startLine, cells });
  }
  return { records, error: null };
}

export function normalizeHeader(header: string): string {
  const base = header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return Object.hasOwn(HEADER_ALIASES, base)
    ? (HEADER_ALIASES[base] as string)
    : base;
}

export function parseImportFile(
  file: ProfilesImportFileName,
  text: string,
): ParsedFile {
  const issues: ImportIssue[] = [];
  const spec =
    file === PROFILE_FILE
      ? PROFILE_FILE_COLUMNS
      : file === NAME_FILE
        ? NAME_FILE_COLUMNS
        : ROLE_FILE_COLUMNS;
  const issue = (
    code: string,
    message: string,
    line: number | null = null,
    key?: string,
  ) => issues.push({ file, line, code, message, ...(key ? { key } : {}) });
  const { records, error } = readCsv(text);
  if (error) issue("malformed_csv", error);
  if (records.length === 0) {
    issue("empty_file", `${file} has no header row.`);
    return { file, headers: [], ignoredColumns: [], rows: [], issues };
  }
  const headers = (records[0] as { cells: string[] }).cells.map(
    normalizeHeader,
  );
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header))
      issue(
        "duplicate_column",
        `Column "${header}" appears more than once.`,
        1,
      );
    seen.add(header);
  }
  for (const required of spec.required)
    if (!seen.has(required))
      issue("missing_column", `${file} needs a "${required}" column.`, 1);
  const known = new Set<string>([...spec.required, ...spec.optional]);
  const ignoredColumns = headers.filter(
    (header) => header !== "" && !known.has(header),
  );
  if (records.length - 1 > PROFILES_IMPORT_MAX_ROWS)
    issue(
      "too_many_rows",
      `${file} has more than ${PROFILES_IMPORT_MAX_ROWS} rows.`,
    );
  const rows: { line: number; values: Record<string, string> }[] = [];
  for (const record of records.slice(1, PROFILES_IMPORT_MAX_ROWS + 1)) {
    if (record.cells.length !== headers.length) {
      issue(
        "column_count",
        `Row has ${record.cells.length} values but the header has ${headers.length}.`,
        record.line,
      );
      continue;
    }
    const values: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (known.has(header))
        values[header] = (record.cells[index] as string).trim();
    });
    rows.push({ line: record.line, values });
  }
  return { file, headers, ignoredColumns, rows, issues };
}

export function validId(value: string | undefined): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export interface ProfileRecord {
  readonly line: number;
  readonly profileId: string;
  readonly displayName: string;
  /** Only the components whose column is present. A blank cell is null. */
  readonly components: Readonly<
    Partial<Record<PersonNameComponentField, string | null>>
  >;
}
export type NameComponents = Readonly<
  Record<
    "first_name" | "middle_name" | "last_name" | "name_prefix" | "name_suffix",
    string | null
  >
>;
export interface NameRecord {
  readonly line: number;
  readonly nameId: string;
  readonly profileId: string;
  readonly nameType: AlternateNameType;
  readonly publishedName: string;
  readonly components: NameComponents;
  readonly appliesFrom: string | null;
  readonly appliesUntil: string | null;
  /** The file asked for the name to be Public. It is ignored. */
  readonly requestedPublic: boolean;
  /** The file marked the name Confirmed. It is ignored. */
  readonly requestedConfirmed: boolean;
}
export interface RoleRecord {
  readonly line: number;
  readonly roleId: string;
  readonly profileId: string;
  readonly countyFips: string;
  readonly publishedOffice?: string;
  readonly publishedTitle?: string;
  readonly inferredTitle?: string;
  readonly jobDescription?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

export function validateProfileRows(parsed: ParsedFile): {
  readonly records: readonly ProfileRecord[];
  readonly issues: readonly ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const records: ProfileRecord[] = [];
  const keys = new Set<string>();
  for (const { line, values } of parsed.rows) {
    const id = values.profile_id;
    const name = values.display_name;
    const bad = (code: string, message: string) =>
      issues.push({
        file: PROFILE_FILE,
        line,
        code,
        message,
        ...(id ? { key: id } : {}),
      });
    if (!validId(id)) {
      bad(
        "invalid_profile_id",
        "profile_id must be 1 to 100 letters, digits, dots, colons, underscores or hyphens.",
      );
      continue;
    }
    if (keys.has(id)) {
      bad("duplicate_key", `profile_id ${id} appears more than once.`);
      continue;
    }
    keys.add(id);
    if (!name || name.length > 500) {
      bad("invalid_display_name", "display_name must be 1 to 500 characters.");
      continue;
    }
    const components: Partial<Record<PersonNameComponentField, string | null>> =
      {};
    let componentsOk = true;
    for (const { column, max } of PROFILE_NAME_COMPONENT_COLUMNS) {
      if (!Object.hasOwn(values, column)) continue;
      const value = values[column] ?? "";
      if (value.length > max || CONTROL.test(value)) {
        bad(
          "invalid_name_component",
          `${column} must be at most ${max} characters with no control characters.`,
        );
        componentsOk = false;
        continue;
      }
      components[column] = value === "" ? null : value;
    }
    if (CONTROL.test(name)) {
      bad("invalid_display_name", "display_name has a control character.");
      continue;
    }
    if (!componentsOk) continue;
    records.push({ line, profileId: id, displayName: name, components });
  }
  return { records, issues };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
const NAME_TYPES: readonly string[] = ALTERNATE_NAME_TYPES;
const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0", ""]);
const nameKey = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Validates typed alternate names. A name is identified by its own stable
 * profile_name_id and belongs to the Profile named by profile_id. The checks
 * are file-local. Whether the Profile exists is decided against the Website.
 */
export function validateNameRows(parsed: ParsedFile): {
  readonly records: readonly NameRecord[];
  readonly issues: readonly ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const records: NameRecord[] = [];
  const ids = new Set<string>();
  const active = new Set<string>();
  for (const { line, values } of parsed.rows) {
    const id = values.profile_name_id;
    const bad = (code: string, message: string) =>
      issues.push({
        file: NAME_FILE,
        line,
        code,
        message,
        ...(id ? { key: id } : {}),
      });
    if (!validId(id)) {
      bad(
        "invalid_name_id",
        "profile_name_id must be 1 to 100 letters, digits, dots, colons, underscores or hyphens.",
      );
      continue;
    }
    if (ids.has(id)) {
      bad("duplicate_key", `profile_name_id ${id} appears more than once.`);
      continue;
    }
    ids.add(id);
    const profileId = values.profile_id;
    if (!validId(profileId)) {
      bad(
        "invalid_profile_id",
        "profile_id must be 1 to 100 letters, digits, dots, colons, underscores or hyphens.",
      );
      continue;
    }
    const type = values.name_type ?? "";
    if (!NAME_TYPES.includes(type)) {
      bad("invalid_name_type", `name_type "${type}" is not a supported type.`);
      continue;
    }
    const published = values.published_name ?? "";
    if (
      !published ||
      published.length > PROFILES_MAX_NAME_LENGTH ||
      CONTROL.test(published)
    ) {
      bad(
        "invalid_published_name",
        `published_name must be 1 to ${PROFILES_MAX_NAME_LENGTH} characters with no control characters.`,
      );
      continue;
    }
    let ok = true;
    const comps: Record<string, string | null> = {};
    for (const { column, max } of PROFILE_NAME_COMPONENT_COLUMNS) {
      if (column === "preferred_first_name") continue;
      const value = values[column] ?? "";
      if (value.length > max || CONTROL.test(value)) {
        bad(
          "invalid_name_component",
          `${column} must be at most ${max} characters with no control characters.`,
        );
        ok = false;
      }
      comps[column] = value === "" ? null : value;
    }
    const from = values.applies_from || null;
    const until = values.applies_until || null;
    if (from && !validDate(from)) {
      bad("invalid_date", "applies_from must be a YYYY-MM-DD calendar date.");
      ok = false;
    }
    if (until && !validDate(until)) {
      bad("invalid_date", "applies_until must be a YYYY-MM-DD calendar date.");
      ok = false;
    }
    if (from && until && validDate(from) && validDate(until) && until < from) {
      bad("date_order", "applies_until cannot be before applies_from.");
      ok = false;
    }
    const status = nameKey(values.verification_status ?? "").replace(/_/g, " ");
    if (!["", "confirmed", "requires review"].includes(status)) {
      bad(
        "invalid_status",
        "verification_status must be Confirmed or Requires review when given.",
      );
      ok = false;
    }
    const flag = nameKey(values.public_display ?? "");
    if (!YES.has(flag) && !NO.has(flag)) {
      bad("invalid_flag", "public_display must be Yes or No when given.");
      ok = false;
    }
    if (!ok) continue;
    const key = [
      profileId,
      type,
      nameKey(published),
      from ?? "",
      until ?? "",
    ].join("|");
    if (active.has(key)) {
      bad(
        "duplicate_name",
        "This Profile already has this name, type and dates in the file.",
      );
      continue;
    }
    active.add(key);
    records.push({
      line,
      nameId: id,
      profileId,
      nameType: type as AlternateNameType,
      publishedName: published,
      components: comps as NameComponents,
      appliesFrom: from,
      appliesUntil: until,
      requestedPublic: YES.has(flag),
      requestedConfirmed: status === "confirmed",
    });
  }
  return { records, issues };
}

export function validateRoleRows(
  parsed: ParsedFile,
  allowPartial = false,
): {
  readonly records: readonly RoleRecord[];
  readonly issues: readonly ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const records: RoleRecord[] = [];
  const keys = new Set<string>();
  for (const { line, values: v } of parsed.rows) {
    const id = v.role_id;
    const bad = (code: string, message: string) => {
      issues.push({
        file: ROLE_FILE,
        line,
        code,
        message,
        ...(id ? { key: id } : {}),
      });
      return false;
    };
    if (!validId(id)) {
      bad(
        "invalid_role_id",
        "role_id must be 1 to 100 letters, digits, dots, colons, underscores or hyphens.",
      );
      continue;
    }
    if (keys.has(id)) {
      bad("duplicate_key", `role_id ${id} appears more than once.`);
      continue;
    }
    keys.add(id);
    let ok = true;
    if (!validId(v.profile_id))
      ok = bad(
        "missing_profile",
        "A role needs the profile_id of its Profile.",
      );
    if (!/^08\d{3}$/.test(v.county_fips ?? ""))
      ok = bad(
        "invalid_county",
        "county_fips must be a five digit Colorado FIPS code such as 08001.",
      );
    if (
      !allowPartial &&
      !v.published_office &&
      !v.published_title &&
      !v.job_description
    )
      ok = bad(
        "role_detail_required",
        "A role needs published_office, published_title or job_description.",
      );
    for (const [field, max] of Object.entries(IMPORT_ROLE_TEXT_LIMITS))
      if ((v[field] ?? "").length > max)
        ok = bad("invalid_field", `${field} is longer than ${max} characters.`);
    for (const field of ["start_date", "end_date"] as const)
      if (v[field] && !validDate(v[field] as string))
        ok = bad("invalid_date", `${field} must be YYYY-MM-DD.`);
    if (
      v.start_date &&
      v.end_date &&
      validDate(v.start_date) &&
      validDate(v.end_date) &&
      v.end_date < v.start_date
    )
      ok = bad("date_order", "end_date is before start_date.");
    if (!ok) continue;
    records.push({
      line,
      roleId: id,
      profileId: v.profile_id as string,
      countyFips: v.county_fips as string,
      ...(v.published_office ? { publishedOffice: v.published_office } : {}),
      ...(v.published_title ? { publishedTitle: v.published_title } : {}),
      ...(v.inferred_title ? { inferredTitle: v.inferred_title } : {}),
      ...(v.job_description ? { jobDescription: v.job_description } : {}),
      ...(v.start_date ? { startDate: v.start_date } : {}),
      ...(v.end_date ? { endDate: v.end_date } : {}),
    });
  }
  return { records, issues };
}

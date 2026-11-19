import {
  HEADER_ALIASES,
  type ImportIssue,
  PROFILE_FILE,
  PROFILE_FILE_COLUMNS,
  PROFILES_IMPORT_MAX_ROWS,
  type ProfilesImportFileName,
  ROLE_FILE,
  ROLE_FILE_COLUMNS,
} from "../contracts/profiles-import.js";

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
  const spec = file === PROFILE_FILE ? PROFILE_FILE_COLUMNS : ROLE_FILE_COLUMNS;
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
}
export interface RoleRecord {
  readonly line: number;
  readonly roleId: string;
  readonly profileId: string;
  readonly countyFips: string;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  readonly publisherClassification: "official" | "unofficial";
  readonly sourceType: "official_page" | "public_document" | "other_public";
  readonly publishedOffice?: string;
  readonly publishedTitle?: string;
  readonly jobDescription?: string;
  readonly sourceCheckedAt?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

const CLASSIFICATIONS = ["official", "unofficial"];
const SOURCE_TYPES = ["official_page", "public_document", "other_public"];

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
    records.push({ line, profileId: id, displayName: name });
  }
  return { records, issues };
}

export function validateRoleRows(parsed: ParsedFile): {
  readonly records: readonly RoleRecord[];
  readonly issues: readonly ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const records: RoleRecord[] = [];
  const keys = new Set<string>();
  const sources = new Map<
    string,
    { url: string; title: string; classification: string; type: string }
  >();
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
    // A role without its source is a missing dependency. Nothing is guessed.
    if (!validId(v.source_id) || !v.source_url || !v.source_title)
      ok = bad(
        "missing_source",
        "A role needs source_id, source_url and source_title.",
      );
    else if (!/^https?:\/\/\S+$/i.test(v.source_url))
      ok = bad("invalid_url", "source_url must be an http or https URL.");
    if (!CLASSIFICATIONS.includes(v.publisher_classification ?? ""))
      ok = bad(
        "invalid_classification",
        "publisher_classification must be official or unofficial.",
      );
    if (!SOURCE_TYPES.includes(v.source_type ?? ""))
      ok = bad(
        "invalid_source_type",
        "source_type must be official_page, public_document or other_public.",
      );
    if (!v.published_office && !v.published_title && !v.job_description)
      ok = bad(
        "role_detail_required",
        "A role needs published_office, published_title or job_description.",
      );
    for (const [field, max] of [
      ["published_office", 500],
      ["published_title", 500],
      ["job_description", 2000],
    ] as const)
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
    if (
      v.source_checked_at &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(
        v.source_checked_at,
      )
    )
      ok = bad(
        "invalid_timestamp",
        "source_checked_at must be a UTC timestamp such as 2026-11-01T00:00:00Z.",
      );
    if (ok && validId(v.source_id)) {
      const prior = sources.get(v.source_id);
      const current = {
        url: v.source_url as string,
        title: v.source_title as string,
        classification: v.publisher_classification as string,
        type: v.source_type as string,
      };
      if (prior && JSON.stringify(prior) !== JSON.stringify(current))
        ok = bad(
          "source_conflict",
          `source_id ${v.source_id} has different details on another row.`,
        );
      else sources.set(v.source_id, current);
    }
    if (!ok) continue;
    records.push({
      line,
      roleId: id,
      profileId: v.profile_id as string,
      countyFips: v.county_fips as string,
      sourceId: v.source_id as string,
      sourceUrl: v.source_url as string,
      sourceTitle: v.source_title as string,
      publisherClassification:
        v.publisher_classification as RoleRecord["publisherClassification"],
      sourceType: v.source_type as RoleRecord["sourceType"],
      ...(v.published_office ? { publishedOffice: v.published_office } : {}),
      ...(v.published_title ? { publishedTitle: v.published_title } : {}),
      ...(v.job_description ? { jobDescription: v.job_description } : {}),
      ...(v.source_checked_at ? { sourceCheckedAt: v.source_checked_at } : {}),
      ...(v.start_date ? { startDate: v.start_date } : {}),
      ...(v.end_date ? { endDate: v.end_date } : {}),
    });
  }
  return { records, issues };
}

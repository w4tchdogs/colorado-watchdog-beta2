/**
 * Validation and mapping for the two Profile CSV files, treated as one logical
 * import: `profile.csv` (one row per Profile) and `profile_name.csv` (one row
 * per alternate name).
 *
 * This module is pure. It reads no database, writes nothing and merges nothing.
 * Every row is matched by its stable ID, never by a name. A row whose ID is not
 * known is an error, not a new person, and two people with the same name stay
 * two people. The result is a list of problems and, when there are none, the
 * mapped rows. A later step feeds those rows to the existing M2/R7/R8
 * preview, commit and revert path so the import reuses its protections.
 */

import {
  ALTERNATE_NAME_TYPES,
  type AlternateNameFields,
  type AlternateNameType,
  PROFILES_MAX_NAME_AFFIX_LENGTH,
  PROFILES_MAX_NAME_COMPONENT_LENGTH,
  PROFILES_MAX_SOURCE_REFERENCE_LENGTH,
  PROFILES_MAX_SOURCES_PER_NAME,
} from "../contracts/profiles.js";

export const PROFILE_CSV_COLUMNS = [
  "profile_id",
  "display_name",
  "first_name",
  "middle_name",
  "last_name",
  "name_prefix",
  "name_suffix",
  "preferred_first_name",
] as const;

export const PROFILE_NAME_CSV_COLUMNS = [
  "profile_name_id",
  "profile_id",
  "name_type",
  "first_name",
  "middle_name",
  "last_name",
  "name_prefix",
  "name_suffix",
  "published_name",
  "applies_from",
  "applies_until",
  "verification_status",
  "public_display",
  "sources",
] as const;

/** Separator between source references inside the `sources` cell. */
export const PROFILE_CSV_SOURCE_SEPARATOR = " | ";

export const PROFILE_CSV_MAX_ROWS = 20_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ProfileCsvFile = "profile.csv" | "profile_name.csv";

export interface ProfileCsvIssue {
  readonly file: ProfileCsvFile;
  /** 1-based spreadsheet row, where row 1 is the header. 0 means the file. */
  readonly row: number;
  readonly column: string | null;
  readonly code:
    | "missing_column"
    | "unknown_column"
    | "too_many_rows"
    | "missing_value"
    | "invalid_id"
    | "duplicate_id"
    | "unknown_profile"
    | "invalid_value"
    | "invalid_date"
    | "date_order"
    | "too_long"
    | "public_not_allowed"
    | "duplicate_name"
    | "too_many_sources";
  readonly message: string;
}

export interface MappedProfileRow {
  readonly profileId: string;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly namePrefix: string | null;
  readonly nameSuffix: string | null;
  readonly preferredFirstName: string | null;
}

export interface MappedNameRow {
  /** The ID the file gave this name. It maps to a stored ID on import. */
  readonly sourceProfileNameId: string;
  readonly profileId: string;
  readonly fields: AlternateNameFields;
}

export interface ProfileCsvResult {
  readonly ok: boolean;
  readonly issues: readonly ProfileCsvIssue[];
  readonly profiles: readonly MappedProfileRow[];
  readonly names: readonly MappedNameRow[];
}

export interface ProfileCsvInput {
  readonly profileCsv: string;
  readonly profileNameCsv: string;
  /**
   * IDs of Profiles that already exist on the Website. A name row may point at
   * one of these or at a Profile defined in `profile.csv`.
   */
  readonly knownProfileIds?: ReadonlySet<string>;
}

/** Parse RFC 4180 text into rows. Returns null when a quote is left open. */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "") || row.length > 1) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) return null;
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "") || row.length > 1) rows.push(row);
  }
  return rows;
}

const real = (date: string): boolean => {
  if (!DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date)
  );
};

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

const nameKey = (value: string): string =>
  value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

interface Table {
  readonly rows: readonly Record<string, string>[];
  readonly rowNumbers: readonly number[];
}

function readTable(
  file: ProfileCsvFile,
  text: string,
  columns: readonly string[],
  required: readonly string[],
  issues: ProfileCsvIssue[],
): Table {
  const parsed = parseCsv(text);
  const empty: Table = { rows: [], rowNumbers: [] };
  if (!parsed) {
    issues.push({
      file,
      row: 0,
      column: null,
      code: "invalid_value",
      message: "The file has a quoted value that never closes.",
    });
    return empty;
  }
  const header = parsed[0]?.map((name) => name.trim());
  if (!header) {
    issues.push({
      file,
      row: 0,
      column: null,
      code: "missing_column",
      message: "The file is empty. It needs a header row.",
    });
    return empty;
  }
  for (const name of required)
    if (!header.includes(name))
      issues.push({
        file,
        row: 1,
        column: name,
        code: "missing_column",
        message: `The header is missing the “${name}” column.`,
      });
  for (const name of header)
    if (!columns.includes(name))
      issues.push({
        file,
        row: 1,
        column: name,
        code: "unknown_column",
        message: `“${name}” is not a column this import reads.`,
      });
  const body = parsed.slice(1);
  if (body.length > PROFILE_CSV_MAX_ROWS) {
    issues.push({
      file,
      row: 0,
      column: null,
      code: "too_many_rows",
      message: `The file has more than ${PROFILE_CSV_MAX_ROWS} rows. Split it.`,
    });
    return empty;
  }
  return {
    rows: body.map((cells) =>
      Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])),
    ),
    rowNumbers: body.map((_, i) => i + 2),
  };
}

function component(
  file: ProfileCsvFile,
  row: number,
  column: string,
  value: string | null,
  limit: number,
  issues: ProfileCsvIssue[],
): string | null {
  if (value !== null && value.length > limit)
    issues.push({
      file,
      row,
      column,
      code: "too_long",
      message: `“${column}” is longer than ${limit} characters.`,
    });
  return value;
}

function yesNo(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "no" || v === "false" || v === "0") return false;
  if (v === "yes" || v === "true" || v === "1") return true;
  return null;
}

/** Validate both files together and map them to the Website model. */
export function validateProfileCsv(input: ProfileCsvInput): ProfileCsvResult {
  const issues: ProfileCsvIssue[] = [];
  const profileTable = readTable(
    "profile.csv",
    input.profileCsv,
    PROFILE_CSV_COLUMNS,
    ["profile_id", "display_name"],
    issues,
  );
  const nameTable = readTable(
    "profile_name.csv",
    input.profileNameCsv,
    PROFILE_NAME_CSV_COLUMNS,
    ["profile_name_id", "profile_id", "name_type", "published_name"],
    issues,
  );

  const profiles: MappedProfileRow[] = [];
  const profileIds = new Set<string>();
  profileTable.rows.forEach((raw, index) => {
    const row = profileTable.rowNumbers[index] as number;
    const id = (raw.profile_id ?? "").trim();
    if (!ID.test(id)) {
      issues.push({
        file: "profile.csv",
        row,
        column: "profile_id",
        code: id === "" ? "missing_value" : "invalid_id",
        message:
          id === ""
            ? "Every row needs a Profile ID. Rows are never matched by name."
            : "The Profile ID has characters that are not allowed.",
      });
      return;
    }
    if (profileIds.has(id)) {
      issues.push({
        file: "profile.csv",
        row,
        column: "profile_id",
        code: "duplicate_id",
        message: `Profile ID “${id}” appears more than once.`,
      });
      return;
    }
    profileIds.add(id);
    const displayName = clean(raw.display_name);
    if (displayName === null)
      issues.push({
        file: "profile.csv",
        row,
        column: "display_name",
        code: "missing_value",
        message: "Every Profile needs a Display Name.",
      });
    const get = (column: string, limit: number) =>
      component("profile.csv", row, column, clean(raw[column]), limit, issues);
    profiles.push({
      profileId: id,
      displayName: component(
        "profile.csv",
        row,
        "display_name",
        displayName,
        PROFILES_MAX_NAME_COMPONENT_LENGTH,
        issues,
      ) as string,
      firstName: get("first_name", PROFILES_MAX_NAME_COMPONENT_LENGTH),
      middleName: get("middle_name", PROFILES_MAX_NAME_COMPONENT_LENGTH),
      lastName: get("last_name", PROFILES_MAX_NAME_COMPONENT_LENGTH),
      namePrefix: get("name_prefix", PROFILES_MAX_NAME_AFFIX_LENGTH),
      nameSuffix: get("name_suffix", PROFILES_MAX_NAME_AFFIX_LENGTH),
      preferredFirstName: get(
        "preferred_first_name",
        PROFILES_MAX_NAME_COMPONENT_LENGTH,
      ),
    });
  });

  const names: MappedNameRow[] = [];
  const nameIds = new Set<string>();
  const activeKeys = new Set<string>();
  nameTable.rows.forEach((raw, index) => {
    const row = nameTable.rowNumbers[index] as number;
    const problem = (
      column: string | null,
      code: ProfileCsvIssue["code"],
      message: string,
    ) => issues.push({ file: "profile_name.csv", row, column, code, message });

    const nameId = (raw.profile_name_id ?? "").trim();
    if (!ID.test(nameId)) {
      problem(
        "profile_name_id",
        nameId === "" ? "missing_value" : "invalid_id",
        nameId === ""
          ? "Every name needs its own ID so a re-import is not duplicated."
          : "The name ID has characters that are not allowed.",
      );
      return;
    }
    if (nameIds.has(nameId)) {
      problem(
        "profile_name_id",
        "duplicate_id",
        `Name ID “${nameId}” appears more than once.`,
      );
      return;
    }
    nameIds.add(nameId);

    const profileId = (raw.profile_id ?? "").trim();
    if (!profileIds.has(profileId) && !input.knownProfileIds?.has(profileId))
      problem(
        "profile_id",
        "unknown_profile",
        "This Profile ID is in neither profile.csv nor the Website. No Profile is created or matched by name.",
      );

    const type = (raw.name_type ?? "").trim();
    if (!(ALTERNATE_NAME_TYPES as readonly string[]).includes(type))
      problem(
        "name_type",
        "invalid_value",
        `“${type}” is not a supported name type.`,
      );

    const published = component(
      "profile_name.csv",
      row,
      "published_name",
      clean(raw.published_name),
      500,
      issues,
    );
    if (published === null)
      problem(
        "published_name",
        "missing_value",
        "Every alternate name needs the Full Name as Published.",
      );

    const from = clean(raw.applies_from);
    const until = clean(raw.applies_until);
    for (const [column, value] of [
      ["applies_from", from],
      ["applies_until", until],
    ] as const)
      if (value !== null && !real(value))
        problem(column, "invalid_date", "Use a real date like 2024-03-31.");
    if (from && until && real(from) && real(until) && until < from)
      problem("applies_until", "date_order", "The end is before the start.");

    const status = (raw.verification_status ?? "").trim().toLowerCase();
    const verification =
      status === "" ||
      status === "requires_review" ||
      status === "requires review"
        ? "requires_review"
        : status === "confirmed"
          ? "confirmed"
          : null;
    if (verification === null)
      problem(
        "verification_status",
        "invalid_value",
        "Use Confirmed or Requires review.",
      );

    const publicFlag = yesNo(raw.public_display ?? "");
    if (publicFlag === null)
      problem("public_display", "invalid_value", "Use Yes or No.");
    if (publicFlag === true && verification !== "confirmed")
      problem(
        "public_display",
        "public_not_allowed",
        "A name can be public only when it is Confirmed. Nothing is published by default.",
      );

    const sources = (raw.sources ?? "")
      .split(PROFILE_CSV_SOURCE_SEPARATOR.trim())
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (sources.length > PROFILES_MAX_SOURCES_PER_NAME)
      problem(
        "sources",
        "too_many_sources",
        `A name has at most ${PROFILES_MAX_SOURCES_PER_NAME} sources.`,
      );
    for (const source of sources)
      if (source.length > PROFILES_MAX_SOURCE_REFERENCE_LENGTH)
        problem("sources", "too_long", "A source reference is too long.");

    if (published !== null && ID.test(profileId)) {
      const key = `${profileId}|${type}|${nameKey(published)}|${from ?? ""}|${until ?? ""}`;
      if (activeKeys.has(key))
        problem(
          "published_name",
          "duplicate_name",
          "This Profile already has this name, type and dates in the file.",
        );
      activeKeys.add(key);
    }

    const get = (column: string, limit: number) =>
      component(
        "profile_name.csv",
        row,
        column,
        clean(raw[column]),
        limit,
        issues,
      );
    if (published === null || verification === null || publicFlag === null)
      return;
    names.push({
      sourceProfileNameId: nameId,
      profileId,
      fields: {
        nameType: type as AlternateNameType,
        firstName: get("first_name", PROFILES_MAX_NAME_COMPONENT_LENGTH),
        middleName: get("middle_name", PROFILES_MAX_NAME_COMPONENT_LENGTH),
        lastName: get("last_name", PROFILES_MAX_NAME_COMPONENT_LENGTH),
        namePrefix: get("name_prefix", PROFILES_MAX_NAME_AFFIX_LENGTH),
        nameSuffix: get("name_suffix", PROFILES_MAX_NAME_AFFIX_LENGTH),
        publishedName: published,
        appliesFrom: from,
        appliesUntil: until,
        verificationStatus: verification,
        publicDisplay: publicFlag,
        sources,
      },
    });
  });

  return {
    ok: issues.length === 0,
    issues,
    profiles: issues.length === 0 ? profiles : [],
    names: issues.length === 0 ? names : [],
  };
}

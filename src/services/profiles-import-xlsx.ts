import type { CellValue } from "read-excel-file/universal";
import {
  PROFILES_IMPORT_MAX_ROWS,
  PROFILES_WORKBOOK_MAX_BYTES,
} from "../contracts/profiles-import.js";
import {
  ImportWorkbookError as ProfilesWorkbookError,
  readImportWorkbook,
} from "./import-workbook.js";
import { normalizeHeader } from "./profiles-import-csv.js";

export { ProfilesWorkbookError };

const SHEETS = ["Profiles", "Roles", "Alternate Names"] as const;

function csvCell(value: CellValue<string> | null, header?: string): string {
  if (value === null) return "";
  if (value instanceof Date) {
    const timestamp = value.toISOString();
    return header === "source_checked_at" ? timestamp : timestamp.slice(0, 10);
  }
  let cell = String(value);
  if (header === "county_fips" && /^8\d{3}$/.test(cell)) cell = `0${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function tabCsv(
  rows: readonly (readonly (CellValue<string> | null)[])[],
): string {
  const headers = rows[0]?.map((cell) => normalizeHeader(csvCell(cell))) ?? [];
  return rows
    .map((row, index) =>
      row
        .map((cell, column) =>
          csvCell(cell, index ? headers[column] : undefined),
        )
        .join(","),
    )
    .join("\r\n");
}

export async function readProfilesWorkbook(
  encoded: string,
  includeAlternateNames = true,
): Promise<{
  profile: string;
  profileRole?: string;
  profileName?: string;
}> {
  try {
    const workbook = await readImportWorkbook(encoded, {
      maxBytes: PROFILES_WORKBOOK_MAX_BYTES,
      maxRows: PROFILES_IMPORT_MAX_ROWS,
      sheetNames: SHEETS,
      sheetError:
        "Use one Profiles tab and only the optional Roles and Alternate Names tabs.",
    });
    const tabs = new Map(workbook.map(({ sheet, data }) => [sheet, data]));
    const profiles = tabs.get("Profiles");
    if (!profiles?.length)
      throw new ProfilesWorkbookError(
        "Include a Profiles tab with column headers.",
      );
    const roles = tabs.get("Roles");
    const names = includeAlternateNames ? tabs.get("Alternate Names") : null;
    return {
      profile: tabCsv(profiles),
      ...(roles && roles.length > 1 ? { profileRole: tabCsv(roles) } : {}),
      ...(names && names.length > 1 ? { profileName: tabCsv(names) } : {}),
    };
  } catch (error) {
    if (error instanceof ProfilesWorkbookError) throw error;
    throw new ProfilesWorkbookError("Choose a valid .xlsx workbook.");
  }
}

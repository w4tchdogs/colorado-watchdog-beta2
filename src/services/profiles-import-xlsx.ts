import { unzipSync, zipSync } from "fflate";
import readXlsxFile, { type CellValue } from "read-excel-file/universal";
import { SaxesParser } from "saxes";
import {
  PROFILES_IMPORT_MAX_ROWS,
  PROFILES_WORKBOOK_MAX_BYTES,
} from "../contracts/profiles-import.js";
import { normalizeHeader } from "./profiles-import-csv.js";

const SHEETS = ["Profiles", "Roles", "Alternate Names"] as const;
const MAX_ARCHIVE_PARTS = 256;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_COLUMNS = 64;
const MAX_ROW = PROFILES_IMPORT_MAX_ROWS + 1;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ProfilesWorkbookError extends Error {}

function checkXml(xml: Uint8Array): void {
  const parser = new SaxesParser<{ xmlns: false }>({ xmlns: false });
  let root: string | undefined;
  const tabs = new Set<string>();
  const checkRow = (row: number) => {
    if (!Number.isSafeInteger(row) || row < 1 || row > MAX_ROW)
      throw new ProfilesWorkbookError("A worksheet exceeds the row limit.");
  };
  parser.on("doctype", () => {
    throw new ProfilesWorkbookError("The workbook contains unsupported XML.");
  });
  parser.on("opentag", ({ name, attributes }) => {
    const tag = name.slice(name.lastIndexOf(":") + 1);
    root ??= tag;
    if (root === "workbook" && tag === "sheet") {
      const sheet = attributes.name;
      if (
        typeof sheet !== "string" ||
        !SHEETS.some((allowed) => allowed === sheet) ||
        tabs.has(sheet)
      )
        throw new ProfilesWorkbookError(
          "Use one Profiles tab and only the optional Roles and Alternate Names tabs.",
        );
      tabs.add(sheet);
    }
    if (root !== "worksheet") return;
    if (tag === "f")
      throw new ProfilesWorkbookError(
        "The workbook contains formulas. Replace them with values and preview again.",
      );
    if (tag === "row" && attributes.r !== undefined)
      checkRow(Number(attributes.r));
    if (tag === "c") {
      const address = /^([A-Z]{1,2})([1-9]\d*)$/.exec(attributes.r ?? "");
      if (!address)
        throw new ProfilesWorkbookError(
          "A worksheet has an invalid cell address.",
        );
      let column = 0;
      for (const letter of address[1] ?? "")
        column = column * 26 + letter.charCodeAt(0) - 64;
      if (column > MAX_COLUMNS)
        throw new ProfilesWorkbookError(
          "A worksheet exceeds the column limit.",
        );
      checkRow(Number(address[2]));
    }
  });
  parser.write(decoder.decode(xml)).close();
}

function checkedArchive(encoded: string): Uint8Array {
  const maxEncoded = 4 * Math.ceil(PROFILES_WORKBOOK_MAX_BYTES / 3);
  if (encoded.length > maxEncoded)
    throw new ProfilesWorkbookError("The Excel workbook is too large.");
  if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded))
    throw new ProfilesWorkbookError("Choose a valid .xlsx workbook.");
  const binary = atob(encoded);
  if (binary.length > PROFILES_WORKBOOK_MAX_BYTES)
    throw new ProfilesWorkbookError("The Excel workbook is too large.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);

  let expanded = 0;
  const paths = new Set<string>();
  const entries = unzipSync(bytes, {
    filter({ name, originalSize }) {
      expanded += originalSize;
      if (expanded > MAX_EXPANDED_BYTES || paths.size >= MAX_ARCHIVE_PARTS)
        throw new ProfilesWorkbookError("The expanded workbook is too large.");
      if (paths.has(name) || /(?:^|\/)\.\.?(?:\/|$)|[\\\0]/.test(name))
        throw new ProfilesWorkbookError(
          "The workbook has invalid internal paths.",
        );
      paths.add(name);
      if (/vbaProject\.bin$/i.test(name))
        throw new ProfilesWorkbookError(
          "Save the workbook as a macro-free .xlsx file.",
        );
      return /\.(?:xml|rels)$/i.test(name);
    },
  });
  for (const entry of Object.values(entries)) checkXml(entry);
  // The reader offloads larger deflated parts to a Worker. Keep the checked
  // parts uncompressed so the same reader runs in Cloudflare without one.
  return zipSync(entries, { level: 0 });
}

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

export async function readProfilesWorkbook(encoded: string): Promise<{
  profile: string;
  profileRole?: string;
  profileName?: string;
}> {
  try {
    const workbook = await readXlsxFile(checkedArchive(encoded), {
      trim: false,
      parseNumber: (value) => value,
    });
    const tabs = new Map(workbook.map(({ sheet, data }) => [sheet, data]));
    const profiles = tabs.get("Profiles");
    if (!profiles?.length)
      throw new ProfilesWorkbookError(
        "Include a Profiles tab with column headers.",
      );
    const roles = tabs.get("Roles");
    const names = tabs.get("Alternate Names");
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

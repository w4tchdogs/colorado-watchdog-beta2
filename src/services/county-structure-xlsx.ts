import type { CellValue } from "read-excel-file/universal";
import {
  COUNTY_CSV_COLUMNS,
  MAX_COUNTY_WORKBOOK_BYTES,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
} from "../contracts/county-structure.js";
import { writeCsvTable } from "./county-structure-csv.js";
import { ImportWorkbookError, readImportWorkbook } from "./import-workbook.js";

function cellText(value: CellValue<string> | null | undefined): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.valueOf()))
      throw new ImportWorkbookError("The worksheet contains an invalid date.");
    return value.toISOString().slice(0, 10);
  }
  return value == null ? "" : String(value);
}

/** Convert workbook values to the existing county import input and preserve its diagnostics. */
export async function readCountyWorkbook(encoded: string): Promise<string> {
  const sheets = await readImportWorkbook(encoded, {
    maxBytes: MAX_COUNTY_WORKBOOK_BYTES,
    maxRows: MAX_CSV_ROWS,
    sheetError: "Use one worksheet with the County Structure column headers.",
  });
  const [header, ...rows] = sheets[0]?.data ?? [];
  if (sheets.length !== 1 || !header)
    throw new ImportWorkbookError(
      "Include one worksheet with the County Structure column headers.",
    );

  const headers = header.map(cellText);
  const csv = writeCsvTable(
    rows.map((row) =>
      Array.from(
        { length: Math.max(header.length, row.length) },
        (_, column) => {
          const value = cellText(row[column]);
          return headers[column]?.trim() === COUNTY_CSV_COLUMNS[0] &&
            /^8\d{3}$/.test(value)
            ? `0${value}`
            : value;
        },
      ),
    ),
    headers,
  );
  if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES)
    throw new ImportWorkbookError(
      "The Excel worksheet's import data must be 1 MiB or smaller.",
    );
  return csv;
}

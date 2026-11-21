import { unzipSync, zipSync } from "fflate";
import readXlsxFile, { type Sheet } from "read-excel-file/universal";
import { SaxesParser } from "saxes";

const MAX_ARCHIVE_PARTS = 256;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_COLUMNS = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ImportWorkbookError extends Error {}

interface WorkbookLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly sheetNames?: readonly string[];
  readonly sheetError: string;
}

function checkXml(xml: Uint8Array, limits: WorkbookLimits): void {
  const parser = new SaxesParser<{ xmlns: false }>({ xmlns: false });
  let root: string | undefined;
  const tabs = new Set<string>();
  const checkRow = (row: number) => {
    if (!Number.isSafeInteger(row) || row < 1 || row > limits.maxRows + 1)
      throw new ImportWorkbookError("A worksheet exceeds the row limit.");
  };
  parser.on("doctype", () => {
    throw new ImportWorkbookError("The workbook contains unsupported XML.");
  });
  parser.on("opentag", ({ name, attributes }) => {
    const tag = name.slice(name.lastIndexOf(":") + 1);
    root ??= tag;
    if (root === "workbook" && tag === "sheet") {
      const sheet = attributes.name;
      if (
        typeof sheet !== "string" ||
        tabs.size >= (limits.sheetNames?.length ?? 1) ||
        (limits.sheetNames && !limits.sheetNames.includes(sheet)) ||
        tabs.has(sheet)
      )
        throw new ImportWorkbookError(limits.sheetError);
      tabs.add(sheet);
    }
    if (root !== "worksheet") return;
    if (tag === "f")
      throw new ImportWorkbookError(
        "The workbook contains formulas. Replace them with values and preview again.",
      );
    if (tag === "row" && attributes.r !== undefined)
      checkRow(Number(attributes.r));
    if (tag === "c") {
      const address = /^([A-Z]{1,2})([1-9]\d*)$/.exec(attributes.r ?? "");
      if (!address)
        throw new ImportWorkbookError(
          "A worksheet has an invalid cell address.",
        );
      let column = 0;
      for (const letter of address[1] ?? "")
        column = column * 26 + letter.charCodeAt(0) - 64;
      if (column > MAX_COLUMNS)
        throw new ImportWorkbookError("A worksheet exceeds the column limit.");
      checkRow(Number(address[2]));
    }
  });
  parser.write(decoder.decode(xml)).close();
}

function checkedArchive(encoded: string, limits: WorkbookLimits): Uint8Array {
  const maxEncoded = 4 * Math.ceil(limits.maxBytes / 3);
  if (encoded.length > maxEncoded)
    throw new ImportWorkbookError("The Excel workbook is too large.");
  if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded))
    throw new ImportWorkbookError("Choose a valid .xlsx workbook.");
  const binary = atob(encoded);
  if (binary.length > limits.maxBytes)
    throw new ImportWorkbookError("The Excel workbook is too large.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);

  let expanded = 0;
  const paths = new Set<string>();
  const entries = unzipSync(bytes, {
    filter({ name, originalSize }) {
      expanded += originalSize;
      if (expanded > MAX_EXPANDED_BYTES || paths.size >= MAX_ARCHIVE_PARTS)
        throw new ImportWorkbookError("The expanded workbook is too large.");
      if (paths.has(name) || /(?:^|\/)\.\.?(?:\/|$)|[\\\0]/.test(name))
        throw new ImportWorkbookError(
          "The workbook has invalid internal paths.",
        );
      paths.add(name);
      if (/vbaProject\.bin$/i.test(name))
        throw new ImportWorkbookError(
          "Save the workbook as a macro-free .xlsx file.",
        );
      return /\.(?:xml|rels)$/i.test(name);
    },
  });
  for (const entry of Object.values(entries)) checkXml(entry, limits);
  // The reader offloads larger deflated parts to a Worker. Keep the checked
  // parts uncompressed so the same reader runs in Cloudflare without one.
  return zipSync(entries, { level: 0 });
}

/** Read local values from a bounded, formula-free Excel archive. */
export async function readImportWorkbook(
  encoded: string,
  limits: WorkbookLimits,
): Promise<Sheet<string>[]> {
  try {
    return await readXlsxFile(checkedArchive(encoded, limits), {
      trim: false,
      parseNumber: (value) => value,
    });
  } catch (error) {
    if (error instanceof ImportWorkbookError) throw error;
    throw new ImportWorkbookError("Choose a valid .xlsx workbook.");
  }
}

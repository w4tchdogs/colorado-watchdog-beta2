import { strToU8, zipSync } from "fflate";

const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const packageRels =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRels =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

export function buildProfilesWorkbook(sheets, extraParts = {}) {
  const tabs = Object.entries(sheets);
  const parts = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      "</Types>",
    "_rels/.rels":
      '<Relationships xmlns="' +
      packageRels +
      '">' +
      '<Relationship Id="rId1" Type="' +
      officeRels +
      '/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
    "xl/workbook.xml":
      '<workbook xmlns="' +
      spreadsheet +
      '" xmlns:r="' +
      officeRels +
      '"><sheets>' +
      tabs
        .map(
          ([name], index) =>
            '<sheet name="' +
            xml(name) +
            '" sheetId="' +
            (index + 1) +
            '" r:id="rId' +
            (index + 1) +
            '"/>',
        )
        .join("") +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="' +
      packageRels +
      '">' +
      tabs
        .map(
          (_, index) =>
            '<Relationship Id="rId' +
            (index + 1) +
            '" Type="' +
            officeRels +
            '/worksheet" Target="worksheets/sheet' +
            (index + 1) +
            '.xml"/>',
        )
        .join("") +
      "</Relationships>",
  };
  for (const [index, [, rows]] of tabs.entries()) {
    parts[`xl/worksheets/sheet${index + 1}.xml`] =
      '<worksheet xmlns="' +
      spreadsheet +
      '"><sheetData>' +
      rows
        .map(
          (row, rowIndex) =>
            '<row r="' +
            (rowIndex + 1) +
            '">' +
            row
              .map((value, column) => {
                const address =
                  String.fromCharCode(65 + column) + (rowIndex + 1);
                if (value === null) return "";
                if (typeof value === "number")
                  return `<c r="${address}"><v>${value}</v></c>`;
                return (
                  '<c r="' +
                  address +
                  '" t="inlineStr"><is><t xml:space="preserve">' +
                  xml(value) +
                  "</t></is></c>"
                );
              })
              .join("") +
            "</row>",
        )
        .join("") +
      "</sheetData></worksheet>";
  }
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries({ ...parts, ...extraParts }).map(([name, text]) => [
          name,
          strToU8(text),
        ]),
      ),
    ),
  );
}

import {
  PROFILE_UNIT_LINK_LABELS,
  type ProfileFieldDefinition,
  type ProfileRow,
} from "../contracts/profiles.js";

type Cell = string | number | boolean | null;

export function profileCsvLine(values: readonly Cell[]): string {
  return (
    values
      .map((value) => {
        const text =
          typeof value === "boolean"
            ? value
              ? "Yes"
              : "No"
            : String(value ?? "");
        // Treat user text as text in spreadsheet apps, including formula prefixes
        // preceded by whitespace. The apostrophe is part of the exported CSV.
        const safe =
          typeof value === "string" &&
          /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text)
            ? `'${text}`
            : text;
        return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
      })
      .join(",") + "\r\n"
  );
}

export function profileCsvRow(
  row: ProfileRow,
  columns: readonly ProfileFieldDefinition[],
): string {
  return profileCsvLine(
    columns.map(({ id }) =>
      id === "unitLink"
        ? row.unitLink
          ? PROFILE_UNIT_LINK_LABELS[row.unitLink.state]
          : null
        : row[
            id as keyof Omit<ProfileRow, "unitLink" | "missingForPublication">
          ],
    ),
  );
}

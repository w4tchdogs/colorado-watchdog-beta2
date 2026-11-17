/**
 * Reads the banner naming convention `08XXX-COUNTYNAME-CAPTION.ext`, where
 * `08XXX` is the county FIPS code. Underscores in the caption stand for
 * spaces. The result only pre-fills the add-a-banner form, so every value
 * stays editable and nothing here grants or checks anything.
 */
export interface ParsedBannerFilename {
  /** A banner ID the API accepts, taken from the file name without its extension. */
  readonly bannerId: string;
  /** "County Caption", empty when the name does not follow the convention. */
  readonly caption: string;
  /** "County Caption, County County, Colorado", empty when there is no caption. */
  readonly altText: string;
  /** The FIPS code the file name starts with, when it has one. */
  readonly fips: string | null;
  /** True when the name followed the convention and a caption was found. */
  readonly matched: boolean;
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const titleCase = (value: string): string =>
  value
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export function parseBannerFilename(
  fileName: string,
  countyName: string,
): ParsedBannerFilename {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]+$/, "");
  const bannerId = base
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128);
  const found = /^(08\d{3})-(.+)$/.exec(base);
  if (!found?.[1] || !found[2])
    return { bannerId, caption: "", altText: "", fips: null, matched: false };
  const fips = found[1];
  const parts = found[2].split("-");
  // The county may itself contain hyphens or underscores (El Paso), so take
  // as many leading pieces as spell the selected county's name.
  let countyPieces = 1;
  if (countyName) {
    for (let count = 1; count < parts.length; count += 1) {
      if (slug(parts.slice(0, count).join("")) === slug(countyName)) {
        countyPieces = count;
        break;
      }
    }
  }
  const county =
    countyName || titleCase(parts.slice(0, countyPieces).join(" "));
  const captionText = titleCase(parts.slice(countyPieces).join(" "));
  if (!captionText)
    return { bannerId, caption: "", altText: "", fips, matched: false };
  const caption = `${county} ${captionText}`;
  return {
    bannerId,
    caption,
    altText: `${caption}, ${county} County, Colorado`,
    fips,
    matched: true,
  };
}

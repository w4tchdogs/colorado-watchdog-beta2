import geometry from "./colorado-county-map.json" with { type: "json" };
import { countyTitle } from "./format.js";
import { html, path, type SafeHtml } from "./html.js";

export interface CountyMapCounty {
  readonly fips: string;
  readonly slug: string;
  readonly path: string;
}

export interface CountyMapGeometry {
  readonly viewBox: string;
  readonly counties: readonly CountyMapCounty[];
}

export const COUNTY_MAP = geometry as CountyMapGeometry;
const FIPS = /^08\d{3}$/;
const VIEW_BOX =
  /^-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/;
const SVG_NUMBER = "-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const SVG_RING = new RegExp(
  `^M${SVG_NUMBER},${SVG_NUMBER}(?:L${SVG_NUMBER},${SVG_NUMBER}){2,}`,
);

function validViewBox(value: string): boolean {
  if (!VIEW_BOX.test(value)) return false;
  const parts = value.trim().split(/\s+/).map(Number);
  const width = Number(parts[2]);
  const height = Number(parts[3]);
  return (
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  );
}

function validSvgPath(value: string): boolean {
  let remaining = value;
  while (remaining !== "") {
    const ring = SVG_RING.exec(remaining)?.[0];
    if (!ring || !remaining.startsWith(`${ring}Z`)) return false;
    remaining = remaining.slice(ring.length + 1);
  }
  return value.length > 0;
}

/** Checks the bundled geometry's static SVG and county identity invariants. */
export function validateCountyMap(
  counties: readonly { fips: string; name: string }[],
  map: CountyMapGeometry = COUNTY_MAP,
): boolean {
  if (!validViewBox(map.viewBox) || map.counties.length !== 64) return false;

  const byFips = new Map(counties.map((county) => [county.fips, county]));
  const seen = new Set<string>();
  for (const region of map.counties) {
    if (
      !FIPS.test(region.fips) ||
      seen.has(region.fips) ||
      !byFips.has(region.fips) ||
      !/^[a-z]+(?:-[a-z]+)*$/.test(region.slug) ||
      !validSvgPath(region.path)
    ) {
      return false;
    }
    const county = byFips.get(region.fips);
    const slug = county?.name
      .toLowerCase()
      .replace(/\s+county$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!county || slug !== region.slug) return false;
    seen.add(region.fips);
  }
  return seen.size === counties.length && counties.length === 64;
}

/** Returns SVG links only for a complete, registry-matched geometry set. */
export function renderCountyMap(
  counties: readonly { fips: string; name: string }[],
  matches: ReadonlySet<string>,
  map: CountyMapGeometry = COUNTY_MAP,
): SafeHtml {
  if (!validateCountyMap(counties, map)) {
    return html`<p class="county-map-fallback" role="note">
      The county map is temporarily unavailable. Use the searchable directory below to open any county.
    </p>`;
  }

  const names = new Map(counties.map((county) => [county.fips, county.name]));
  return html`<figure class="county-map-figure">
    <a class="county-map-skip" href="#county-directory">Skip the map and browse all 64 counties</a>
    <div class="county-map-frame">
      <p class="county-map-status" data-map-status role="status" aria-live="polite">Choose a county</p>
      <svg class="county-map" viewBox="${map.viewBox}" role="group"
        aria-labelledby="county-map-title" aria-describedby="county-map-description">
        <title id="county-map-title">Interactive map of Colorado counties</title>
        <desc id="county-map-description">All 64 Colorado counties are selectable. Use the county search and directory below when a map region is small.</desc>
        ${map.counties.map((region) => {
          const name = countyTitle(names.get(region.fips) ?? "");
          const matched = matches.has(region.fips);
          return html`<a class="county-map-link${matched ? " is-match" : ""}"
            data-map-county="${region.fips}" data-fips="${region.fips}"
            href="${path("counties", region.fips)}"
            aria-label="${name}, FIPS ${region.fips}. Open county directory page.">
            <title>${name} · FIPS ${region.fips}</title>
            <path d="${region.path}" />
          </a>`;
        })}
      </svg>
      <figcaption class="county-map-caption">
        Boundaries: Colorado Department of Transportation. Simplified for navigation. Use the searchable directory for small counties and keyboard navigation.
      </figcaption>
    </div>
  </figure>`;
}

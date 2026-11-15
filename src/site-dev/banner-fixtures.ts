import type { BannerPresentation, BannerSource } from "../site/banner.js";

/**
 * Synthetic banner test patterns for the local preview and tests. They are
 * generated geometric SVGs, not artwork: no approved banner file, Beta-1
 * banner or scenic image is used or referenced. Circles and a square grid make
 * any stretching visible; edge labels show what `cover` clips.
 */
interface Pattern {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

const PATTERNS: readonly Pattern[] = [
  {
    name: "fixture-banner-21x9.v1.svg",
    width: 2100,
    height: 900,
    label: "21:9",
  },
  {
    name: "fixture-banner-21x9.v2.svg",
    width: 2100,
    height: 900,
    label: "21:9 v2",
  },
  {
    name: "fixture-banner-13x5.v1.svg",
    width: 2600,
    height: 1000,
    label: "13:5",
  },
  { name: "fixture-banner-3x1.v1.svg", width: 2400, height: 800, label: "3:1" },
];

function patternSvg({ width, height, label }: Pattern): string {
  const lines: string[] = [];
  for (let x = 100; x < width; x += 100) {
    lines.push(
      `<path d="M${x} 0V${height}" stroke="#ffffff" stroke-opacity="0.18"/>`,
    );
  }
  for (let y = 100; y < height; y += 100) {
    lines.push(
      `<path d="M0 ${y}H${width}" stroke="#ffffff" stroke-opacity="0.18"/>`,
    );
  }
  const cx = width / 2;
  const cy = height / 2;
  const edge = (x: number, y: number, text: string, anchor: string) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, sans-serif" font-size="44" font-weight="700" fill="#ffffff">${text}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<rect width="${width}" height="${height}" fill="#3b4a5a"/>
${lines.join("\n")}
<rect x="6" y="6" width="${width - 12}" height="${height - 12}" fill="none" stroke="#ffd34d" stroke-width="12"/>
<circle cx="${cx}" cy="${cy}" r="${height * 0.36}" fill="none" stroke="#ffffff" stroke-width="10"/>
<circle cx="${height * 0.25}" cy="${height * 0.25}" r="${height * 0.14}" fill="#ffd34d"/>
<circle cx="${width - height * 0.25}" cy="${height * 0.75}" r="${height * 0.14}" fill="#ffd34d"/>
<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-family="Arial, sans-serif" font-size="120" font-weight="700" fill="#ffffff">${label}</text>
<text x="${cx}" y="${cy + 80}" text-anchor="middle" font-family="Arial, sans-serif" font-size="52" fill="#ffffff">Synthetic test pattern, ${width} x ${height}. Not artwork.</text>
${edge(cx, 64, "TOP EDGE", "middle")}
${edge(cx, height - 30, "BOTTOM EDGE", "middle")}
${edge(40, cy, "LEFT", "start")}
${edge(width - 40, cy, "RIGHT", "end")}
</svg>
`;
}

const ASSETS = new Map(PATTERNS.map((p) => [p.name, patternSvg(p)]));

export function bannerFixtureAsset(name: string): string | null {
  return ASSETS.get(name) ?? null;
}

const asset = (name: string) => `/assets/${name}`;

export const BANNER_FIXTURES: readonly BannerPresentation[] = [
  // Adams: three records for one county. The primary wins over ordering and
  // the unpublished record is never shown.
  {
    bannerId: "fixture-adams-wide",
    assetVersion: "v2",
    countyFips: "08001",
    src: asset("fixture-banner-21x9.v2.svg"),
    originalFilename: "synthetic-21x9.svg",
    width: 2100,
    height: 900,
    alt: "Synthetic 21 by 9 test pattern.",
    caption: "Synthetic 21:9 pattern, cover",
    displayMode: "cover",
    order: 1,
    status: "published",
  },
  {
    bannerId: "fixture-adams-primary",
    assetVersion: "v1",
    countyFips: "08001",
    src: asset("fixture-banner-13x5.v1.svg"),
    width: 2600,
    height: 1000,
    alt: "Synthetic 13 by 5 test pattern.",
    caption: "Synthetic 13:5 pattern, cover, centered",
    displayMode: "cover",
    order: 2,
    primary: true,
    status: "published",
  },
  {
    bannerId: "fixture-adams-withdrawn",
    assetVersion: "v1",
    countyFips: "08001",
    src: asset("fixture-banner-3x1.v1.svg"),
    alt: "Withdrawn synthetic pattern.",
    order: 0,
    status: "unpublished",
  },
  {
    bannerId: "fixture-boulder-contain",
    assetVersion: "v1",
    countyFips: "08013",
    src: asset("fixture-banner-21x9.v1.svg"),
    width: 2100,
    height: 900,
    alt: "Synthetic 21 by 9 test pattern shown whole.",
    caption: "Synthetic 21:9 pattern, contain",
    displayMode: "contain",
    status: "published",
  },
  {
    bannerId: "fixture-denver-focal",
    assetVersion: "v1",
    countyFips: "08031",
    src: asset("fixture-banner-21x9.v1.svg"),
    width: 2100,
    height: 900,
    alt: "Synthetic 21 by 9 test pattern framed toward the top.",
    caption: "Synthetic 21:9 pattern, cover, focal point top",
    displayMode: "cover",
    focalX: 0.5,
    focalY: 0,
    status: "published",
  },
  {
    bannerId: "fixture-larimer-exact",
    assetVersion: "v1",
    countyFips: "08069",
    src: asset("fixture-banner-3x1.v1.svg"),
    width: 2400,
    height: 800,
    alt: "Synthetic 3 by 1 test pattern.",
    caption: "Synthetic 3:1 pattern",
    status: "published",
  },
  {
    // The address resolves to nothing, as a withdrawn or lost asset would.
    bannerId: "fixture-weld-missing",
    assetVersion: "v1",
    countyFips: "08123",
    src: asset("fixture-banner-missing.v1.svg"),
    alt: "Synthetic banner whose image is unavailable.",
    caption: "Unavailable image",
    status: "published",
  },
];

/** Two synthetic homepage banners, so the homepage carousel can be tested. */
export const HOME_BANNER_FIXTURES: readonly BannerPresentation[] = [
  {
    bannerId: "fixture-home-wide",
    assetVersion: "v1",
    countyFips: null,
    src: asset("fixture-banner-21x9.v1.svg"),
    width: 2100,
    height: 900,
    alt: "Synthetic homepage 21 by 9 test pattern.",
    caption: "Synthetic homepage 21:9 pattern, cover",
    displayMode: "cover",
    order: 1,
    status: "published",
  },
  {
    bannerId: "fixture-home-exact",
    assetVersion: "v1",
    countyFips: null,
    src: asset("fixture-banner-3x1.v1.svg"),
    width: 2400,
    height: 800,
    alt: "Synthetic homepage 3 by 1 test pattern.",
    caption: "Synthetic homepage 3:1 pattern",
    order: 2,
    status: "published",
  },
];

/** `home: false` leaves the homepage without banners to test the fallback. */
export function createFixtureBannerSource(
  options: { readonly home?: boolean } = {},
): BannerSource {
  const home = options.home ?? true;
  return {
    forCounty: (countyFips) =>
      BANNER_FIXTURES.filter((banner) => banner.countyFips === countyFips),
    forHome: () => (home ? HOME_BANNER_FIXTURES : []),
  };
}

export const fixtureBannerSource: BannerSource = createFixtureBannerSource();

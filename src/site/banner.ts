import { html, type SafeHtml } from "./html.js";

/**
 * Storage-independent presentation contract for county and statewide banner
 * artwork. A future Website banner service resolves the currently approved
 * asset version for each logical banner and supplies these records; the public
 * site only renders them. Nothing here knows about R2, D1, manifests, upload
 * or filenames on disk.
 */
export type BannerDisplayMode = "cover" | "contain";

export interface BannerPresentation {
  /** Stable logical identity. Survives image replacement and renaming. */
  readonly bannerId: string;
  /** Identifies the approved asset version currently behind `src`. */
  readonly assetVersion: string;
  /** Five-digit county FIPS, or null for statewide artwork. */
  readonly countyFips: string | null;
  /**
   * Resolved, versioned image reference: a root-relative path or an https
   * URL. It must change when the asset version changes so a replacement is
   * never hidden behind a cached copy of the old address.
   */
  readonly src: string;
  /** Descriptive alternative text for the artwork. */
  readonly alt: string;
  /** Human-readable location or landmark caption. */
  readonly caption?: string | null;
  /** Provenance only. Never used to build the image address. */
  readonly originalFilename?: string | null;
  /** Intrinsic pixel size of the source image, when known. */
  readonly width?: number | null;
  readonly height?: number | null;
  /** `cover` fills the 3:1 frame; `contain` shows the whole image. */
  readonly displayMode?: BannerDisplayMode;
  /** Normalized focal point, 0 (left/top) to 1 (right/bottom). Default 0.5. */
  readonly focalX?: number;
  readonly focalY?: number;
  /** Position within its county (or the statewide set). Lower shows first. */
  readonly order?: number;
  /** The county's primary banner is shown ahead of ordering. */
  readonly primary?: boolean;
  /** Only `published` banners are ever rendered. */
  readonly status: "published" | "unpublished";
}

export interface BannerSource {
  /** Banners assigned to one county. Any number, including none. */
  forCounty(
    countyFips: string,
  ): readonly BannerPresentation[] | Promise<readonly BannerPresentation[]>;
  /** Curated statewide selection for the homepage hero. */
  forHome():
    | readonly BannerPresentation[]
    | Promise<readonly BannerPresentation[]>;
}

export const emptyBannerSource: BannerSource = {
  forCounty: () => [],
  forHome: () => [],
};

/** Root-relative path or credential-free https URL; anything else is refused. */
export function safeBannerSrc(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  if (/[\s\\<>"'`]/.test(value)) return null;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const FOCAL_STEP = 5;
/** Focal coordinate as a percentage rounded to the stylesheet's 5% steps. */
export function focalPercent(value: number | undefined): number {
  const number =
    typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  const clamped = Math.min(1, Math.max(0, number));
  return Math.round((clamped * 100) / FOCAL_STEP) * FOCAL_STEP;
}

/**
 * Published, renderable banners in display order: primary first, then
 * ascending `order`, then `bannerId` for a stable result. Unpublished records,
 * records for another county and records without a usable address are dropped,
 * so withdrawing or reordering a banner is a data change only.
 */
export function selectBanners(
  banners: readonly BannerPresentation[],
  countyFips: string | null,
): readonly BannerPresentation[] {
  return banners
    .filter(
      (banner) =>
        banner.status === "published" &&
        (countyFips === null || banner.countyFips === countyFips) &&
        safeBannerSrc(banner.src) !== null &&
        typeof banner.bannerId === "string" &&
        banner.bannerId.length > 0,
    )
    .slice()
    .sort(
      (a, b) =>
        Number(b.primary === true) - Number(a.primary === true) ||
        (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER) ||
        (a.bannerId < b.bannerId ? -1 : a.bannerId > b.bannerId ? 1 : 0),
    );
}

function dimension(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * The fixed 3:1 banner frame. The branded placeholder is always present
 * underneath, so a missing, withdrawn or failed image never leaves a broken
 * picture or shifts the layout. This milestone shows one static banner; the
 * remaining count is exposed for a later, accessible rotation control.
 */
export function bannerFrame(
  banners: readonly BannerPresentation[],
  countyFips: string | null,
): SafeHtml {
  const selected = selectBanners(banners, countyFips);
  const banner = selected[0];
  if (!banner) {
    return html`<div class="banner-frame" data-banner-frame data-banner-count="0">
      <div class="banner-placeholder" aria-hidden="true"></div>
    </div>`;
  }
  const mode: BannerDisplayMode =
    banner.displayMode === "contain" ? "contain" : "cover";
  const width = dimension(banner.width);
  const height = dimension(banner.height);
  return html`<div class="banner-frame has-image mode-${mode}" data-banner-frame
      data-banner-id="${banner.bannerId}" data-banner-version="${banner.assetVersion}"
      data-banner-count="${selected.length}">
    <div class="banner-placeholder" aria-hidden="true"></div>
    <img class="banner-image fx-${focalPercent(banner.focalX)} fy-${focalPercent(banner.focalY)}" data-banner-image
      src="${safeBannerSrc(banner.src) ?? ""}" alt="${banner.alt}"
      ${width && height ? html`width="${width}" height="${height}"` : ""} decoding="async">
    ${banner.caption ? html`<p class="banner-caption">${banner.caption}</p>` : ""}
  </div>`;
}

export interface BannerHeroOptions {
  readonly variant: "home" | "county";
  readonly banners: readonly BannerPresentation[];
  readonly countyFips: string | null;
  readonly eyebrow: string;
  readonly title: string;
  readonly meta?: SafeHtml;
  readonly lede?: string;
  readonly actions?: SafeHtml;
}

/**
 * Page hero built on the banner frame. On wide screens the heading overlays
 * the artwork; on narrow screens it sits below, so the panorama is never
 * covered or cropped to fit text.
 */
export function bannerHero(options: BannerHeroOptions): SafeHtml {
  return html`<section class="hero hero-${options.variant}" aria-labelledby="hero-title">
    <div class="hero-banner">${bannerFrame(options.banners, options.countyFips)}</div>
    <div class="hero-content">
      <div class="wrap">
        <p class="eyebrow eyebrow-light">${options.eyebrow}</p>
        <h1 id="hero-title">${options.title}</h1>
        ${options.meta ? html`<div class="hero-meta">${options.meta}</div>` : ""}
        ${options.lede ? html`<p class="hero-lede">${options.lede}</p>` : ""}
        ${options.actions ? html`<p class="hero-actions">${options.actions}</p>` : ""}
      </div>
    </div>
  </section>`;
}

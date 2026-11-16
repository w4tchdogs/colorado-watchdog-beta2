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
  /** `cover` fills the banner frame; `contain` shows the whole image. */
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
        banner?.status === "published" &&
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

function presentBanner(banner: BannerPresentation) {
  return {
    bannerId: banner.bannerId,
    assetVersion: banner.assetVersion,
    countyFips: banner.countyFips,
    src: safeBannerSrc(banner.src) ?? "",
    alt: banner.alt,
    caption: typeof banner.caption === "string" ? banner.caption.trim() : "",
    width: dimension(banner.width),
    height: dimension(banner.height),
    mode: banner.displayMode === "contain" ? "contain" : "cover",
    focalX: focalPercent(banner.focalX),
    focalY: focalPercent(banner.focalY),
    primary: banner.primary === true,
    order: Number.isFinite(banner.order) ? banner.order : null,
  };
}

/**
 * Render the first usable banner and keep the other selected presentations
 * inert until the browser enhancement enables the controls.
 */
export function bannerFrame(
  banners: readonly BannerPresentation[],
  countyFips: string | null,
): SafeHtml {
  const selected = selectBanners(banners, countyFips)
    .filter(
      (banner) =>
        banner.bannerId.trim() &&
        typeof banner.assetVersion === "string" &&
        banner.assetVersion.trim() &&
        typeof banner.alt === "string" &&
        banner.alt.trim() &&
        (banner.countyFips === null ||
          (typeof banner.countyFips === "string" &&
            /^\d{5}$/.test(banner.countyFips))),
    )
    .map(presentBanner);
  const banner = selected[0];
  if (!banner) {
    return html`<div class="banner-frame" data-banner-frame data-banner-count="0">
      <div class="banner-placeholder" aria-hidden="true"></div>
    </div>`;
  }
  const { width, height } = banner;
  const multiple = selected.length > 1;
  return html`<div class="banner-frame has-image mode-${banner.mode}" data-banner-frame
      data-banner-id="${banner.bannerId}" data-banner-version="${banner.assetVersion}"
      data-banner-count="${selected.length}"
      ${multiple ? html`data-banner-slides="${JSON.stringify(selected)}" data-banner-interval="8000"` : ""}>
    <div class="banner-placeholder" aria-hidden="true"></div>
    <img class="banner-image fx-${banner.focalX} fy-${banner.focalY}" data-banner-image
      src="${banner.src}" alt="${banner.alt}"
      ${width && height ? html`width="${width}" height="${height}"` : ""} decoding="async">
    <p class="banner-caption" ${banner.caption ? "" : html`hidden`}>${banner.caption}</p>
  </div>
  ${
    multiple
      ? html`<div class="banner-controls" data-banner-controls role="group" aria-label="Banner carousel" hidden>
      <p class="banner-status" aria-live="polite" aria-atomic="true" data-banner-status>Banner 1 of ${selected.length}</p>
      <p class="visually-hidden" aria-live="polite" aria-atomic="true" data-banner-announce></p>
      <div class="banner-buttons">
        <button type="button" data-banner-previous aria-label="Previous banner">Previous</button>
        <button type="button" data-banner-next aria-label="Next banner">Next</button>
        <button type="button" data-banner-pause aria-label="Pause banner rotation" aria-disabled="true">Pause</button>
        <button type="button" data-banner-play aria-label="Play banner rotation">Play</button>
      </div>
    </div>`
      : ""
  }`;
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
 * Page hero built on the banner frame. The copy overlays the artwork, and the
 * frame can grow when the copy wraps on narrow screens.
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

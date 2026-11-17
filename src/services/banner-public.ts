import type {
  BannerMediaType,
  ResolvedBanner,
} from "../contracts/banner-assets.js";
import type { AsyncD1Database } from "../database/d1.js";
import type { BannerPresentation, BannerSource } from "../site/banner.js";
import {
  R2BannerObjectStorage,
  type R2BucketLike,
  sha256Hex,
} from "./banner-storage.js";

interface PublicBannerRow {
  id: unknown;
  county_fips: unknown;
  caption: unknown;
  alt_text: unknown;
  display_mode: unknown;
  focal_x: unknown;
  focal_y: unknown;
  display_order: unknown;
  is_primary: unknown;
  width: unknown;
  height: unknown;
  version_id: unknown;
  object_key: unknown;
  sha256: unknown;
  byte_size: unknown;
  media_type: unknown;
}

export interface VerifiedPublicBanner {
  readonly body: Uint8Array;
  readonly contentType: BannerMediaType;
}

const SELECT_BANNER = `SELECT a.id, a.county_fips, a.caption, a.alt_text,
 a.display_mode, a.focal_x, a.focal_y, a.display_order, a.is_primary,
 v.id AS version_id, v.object_key, v.sha256, v.byte_size, v.media_type,
 v.width, v.height
 FROM banner_assets a JOIN banner_asset_versions v
 ON v.id = a.selected_version_id AND v.banner_id = a.id
 WHERE a.status = 'active' AND v.state = 'verified'`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BANNER_BYTES = 25 * 1024 * 1024;
/** Banners shown in a homepage carousel. */
const HOMEPAGE_BANNER_COUNT = 5;
/** Random candidates read from R2 at most, so a failed object can be replaced. */
const HOMEPAGE_CANDIDATES = 10;

function integer(value: unknown, minimum = 1): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function validRow(row: PublicBannerRow): ResolvedBanner | null {
  const bannerId =
    typeof row.id === "string" && row.id.length <= 128 ? row.id : null;
  const countyFips =
    typeof row.county_fips === "string" && /^08\d{3}$/.test(row.county_fips)
      ? row.county_fips
      : null;
  const versionId =
    typeof row.version_id === "string" && UUID_PATTERN.test(row.version_id)
      ? row.version_id
      : null;
  const objectKey =
    typeof row.object_key === "string" &&
    row.object_key.startsWith("banner-assets/") &&
    row.object_key.length <= 256
      ? row.object_key
      : null;
  const sha256 =
    typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256)
      ? row.sha256
      : null;
  const width = integer(row.width);
  const height = integer(row.height);
  const displayOrder = integer(row.display_order, 0);
  const focalX =
    typeof row.focal_x === "number" &&
    Number.isFinite(row.focal_x) &&
    row.focal_x >= 0 &&
    row.focal_x <= 1
      ? row.focal_x
      : null;
  const focalY =
    typeof row.focal_y === "number" &&
    Number.isFinite(row.focal_y) &&
    row.focal_y >= 0 &&
    row.focal_y <= 1
      ? row.focal_y
      : null;
  const mediaType =
    row.media_type === "image/jpeg" || row.media_type === "image/png"
      ? row.media_type
      : null;
  const byteSize = integer(row.byte_size);
  if (
    !bannerId ||
    !countyFips ||
    !versionId ||
    !objectKey ||
    !sha256 ||
    !width ||
    !height ||
    displayOrder === null ||
    focalX === null ||
    focalY === null ||
    !mediaType ||
    !byteSize ||
    byteSize > MAX_BANNER_BYTES
  )
    return null;
  if (objectKey !== `banner-assets/${versionId}`) return null;
  if (row.is_primary !== 0 && row.is_primary !== 1) return null;
  if (
    typeof row.caption !== "string" ||
    row.caption.length > 500 ||
    typeof row.alt_text !== "string" ||
    row.alt_text.length > 1000 ||
    (row.display_mode !== "cover" && row.display_mode !== "contain")
  )
    return null;
  return {
    bannerId,
    countyFips,
    versionId,
    assetRef: objectKey,
    caption: row.caption,
    altText: row.alt_text,
    displayMode: row.display_mode,
    focalX,
    focalY,
    displayOrder,
    isPrimary: row.is_primary === 1,
    width,
    height,
  };
}

function toPresentation(banner: ResolvedBanner): BannerPresentation {
  return {
    bannerId: banner.bannerId,
    assetVersion: banner.versionId,
    countyFips: banner.countyFips,
    src: `/banner-assets/${banner.versionId}`,
    alt: banner.altText,
    caption: banner.caption,
    width: banner.width,
    height: banner.height,
    displayMode: banner.displayMode,
    focalX: banner.focalX,
    focalY: banner.focalY,
    order: banner.displayOrder,
    primary: banner.isPrimary,
    status: "published",
  };
}

/** Async D1/R2 public read adapter. It has no mutation or key-lookup API. */
export class D1BannerPublicService implements BannerSource {
  private readonly storage: R2BannerObjectStorage;

  constructor(
    private readonly database: AsyncD1Database,
    bucket: R2BucketLike,
  ) {
    this.storage = new R2BannerObjectStorage(bucket);
  }

  async resolveCounty(fips: string): Promise<readonly ResolvedBanner[]> {
    if (!/^08\d{3}$/.test(fips)) return [];
    const rows = await this.database.all<PublicBannerRow>(
      `${SELECT_BANNER} AND a.county_fips = ? ORDER BY a.is_primary DESC, a.display_order, a.id`,
      100,
      [fips],
    );
    return this.verifyRows(rows);
  }

  /**
   * Random homepage selection. Every active banner with a selected, verified
   * version is in the pool, whatever its homepage_order or county primary
   * flag. The pool is shuffled in SQL before the limit is applied, so any
   * banner can be drawn. Only a small candidate sample is read from R2, in
   * random order, and drawing stops at five verified banners.
   */
  async resolveHomepage(): Promise<readonly ResolvedBanner[]> {
    const rows = await this.database.all<PublicBannerRow>(
      `${SELECT_BANNER} ORDER BY RANDOM() LIMIT ${HOMEPAGE_CANDIDATES}`,
      HOMEPAGE_CANDIDATES,
    );
    return this.verifyRows(rows, HOMEPAGE_BANNER_COUNT);
  }

  async forCounty(fips: string): Promise<readonly BannerPresentation[]> {
    return (await this.resolveCounty(fips)).map(toPresentation);
  }

  async forHome(): Promise<readonly BannerPresentation[]> {
    return (await this.resolveHomepage()).map((banner, index) => ({
      ...toPresentation(banner),
      // The homepage sequence is the random draw order. County primary and
      // county order do not promote an image into it.
      order: index,
      primary: false,
    }));
  }

  async deliver(versionId: string): Promise<VerifiedPublicBanner | null> {
    if (!UUID_PATTERN.test(versionId)) return null;
    const row = await this.database.first<PublicBannerRow>(
      `${SELECT_BANNER} AND v.id = ? LIMIT 1`,
      [versionId],
    );
    if (!row || validRow(row)?.versionId !== versionId) return null;
    const mediaType = row.media_type as BannerMediaType;
    try {
      const head = await this.storage.head(String(row.object_key));
      if (!head || head.byteSize !== Number(row.byte_size)) return null;
      const object = await this.storage.get(String(row.object_key));
      if (
        !object ||
        object.byteSize !== Number(row.byte_size) ||
        object.body.byteLength !== Number(row.byte_size) ||
        object.metadata.sha256 !== row.sha256 ||
        object.metadata.versionId !== versionId
      )
        return null;
      if ((await sha256Hex(object.body)) !== row.sha256) return null;
      if (
        mediaType === "image/jpeg" &&
        !(
          object.body[0] === 0xff &&
          object.body[1] === 0xd8 &&
          object.body[2] === 0xff
        )
      )
        return null;
      if (
        mediaType === "image/png" &&
        ![137, 80, 78, 71, 13, 10, 26, 10].every(
          (byte, index) => object.body[index] === byte,
        )
      )
        return null;
      return { body: object.body, contentType: mediaType };
    } catch {
      return null;
    }
  }

  private async verifyRows(
    rows: readonly PublicBannerRow[],
    maximum = Number.POSITIVE_INFINITY,
  ): Promise<readonly ResolvedBanner[]> {
    const results: ResolvedBanner[] = [];
    for (const row of rows) {
      if (results.length >= maximum) break;
      const banner = validRow(row);
      if (!banner) continue;
      try {
        const head = await this.storage.head(banner.assetRef);
        if (!head || head.byteSize !== Number(row.byte_size)) continue;
        const object = await this.storage.get(banner.assetRef);
        if (
          !object ||
          object.byteSize !== Number(row.byte_size) ||
          object.body.byteLength !== Number(row.byte_size) ||
          object.metadata.sha256 !== row.sha256 ||
          object.metadata.versionId !== banner.versionId
        )
          continue;
        if ((await sha256Hex(object.body)) !== row.sha256) continue;
        if (
          (row.media_type === "image/jpeg" &&
            !(
              object.body[0] === 0xff &&
              object.body[1] === 0xd8 &&
              object.body[2] === 0xff
            )) ||
          (row.media_type === "image/png" &&
            ![137, 80, 78, 71, 13, 10, 26, 10].every(
              (byte, index) => object.body[index] === byte,
            ))
        )
          continue;
        results.push(banner);
      } catch {
        // Object storage is optional/unavailable: omit the image and render the branded placeholder.
      }
    }
    return results;
  }
}

import type { TrustedPrincipal } from "../services/security.js";
import type {
  BannerAssetStatus,
  BannerDisplayMode,
  BannerMediaType,
  BannerStageState,
  BannerVersionState,
} from "./banner-assets.js";

/**
 * Shared banner administration contract (BANNER-ADMIN-1). The dashboard, its
 * HTTP routes and the later MCP tools all call this one interface. No input
 * carries an actor: the trusted principal is passed separately and rechecked
 * against live account state on every call. No result carries an object key.
 */

export const BANNER_ADMIN_LIMITS = Object.freeze({
  countyPageDefault: 25,
  countyPageMax: 100,
  bannersPerCounty: 25,
  versionsPerBanner: 20,
});

export interface CountyBannerSummary {
  readonly fips: string;
  readonly name: string;
  readonly bannerCount: number;
  /** Banners that are active with a selected verified version. */
  readonly publicBannerCount: number;
  /** Versions still pending, staging or failed. They need reconciliation. */
  readonly attentionVersionCount: number;
}

export interface CountyBannerPage {
  readonly counties: readonly CountyBannerSummary[];
  /** Pass as `afterFips` to read the next page. Absent on the last page. */
  readonly nextAfterFips?: string;
}

export interface ListCountiesRequest {
  /** Case-insensitive county name fragment or FIPS prefix. */
  readonly query?: string;
  readonly limit?: number;
  readonly afterFips?: string;
}

export interface BannerAdminVersion {
  readonly id: string;
  readonly previousVersionId: string | null;
  readonly sourceFilename: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly mediaType: BannerMediaType;
  readonly state: BannerVersionState;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
  readonly stagedByAccountId: string | null;
  readonly operationState: BannerStageState | null;
  readonly isSelected: boolean;
}

export interface BannerAdminBanner {
  readonly id: string;
  readonly countyFips: string;
  readonly sourceFilename: string;
  readonly caption: string;
  readonly altText: string;
  readonly displayOrder: number;
  readonly homepageOrder: number | null;
  readonly isPrimary: boolean;
  readonly displayMode: BannerDisplayMode;
  readonly focalX: number;
  readonly focalY: number;
  readonly status: BannerAssetStatus;
  readonly selectedVersionId: string | null;
  readonly rowVersion: number;
  readonly updatedAt: string;
  /**
   * Active with a selected verified version. This is a state check only. The
   * public route also rereads and digest-checks the stored bytes.
   */
  readonly publicEligible: boolean;
  /** Newest first, at most `versionsPerBanner`. */
  readonly versions: readonly BannerAdminVersion[];
  readonly versionCount: number;
  readonly versionsTruncated: boolean;
}

export interface CountyBannerDetail {
  readonly county: { readonly fips: string; readonly name: string };
  readonly banners: readonly BannerAdminBanner[];
  readonly bannersTruncated: boolean;
}

export interface NewBannerMetadata {
  readonly caption: string;
  readonly altText: string;
  readonly displayOrder: number;
  readonly isPrimary: boolean;
  readonly homepageOrder?: number | null;
  readonly displayMode: BannerDisplayMode;
  readonly focalX: number;
  readonly focalY: number;
}

/**
 * Staging never edits an existing banner. A new banner starts as a private
 * draft with its first metadata. A new version of an existing banner carries
 * no metadata at all, so the live caption and alt text cannot change.
 */
export type BannerStageTarget =
  | { readonly kind: "new"; readonly metadata: NewBannerMetadata }
  | { readonly kind: "existing"; readonly expectedRowVersion: number };

export interface BannerStageRequest {
  readonly bannerId: string;
  readonly countyFips: string;
  /** Provenance only. Never a path and never used to build a storage key. */
  readonly sourceFilename: string;
  readonly bytes: Uint8Array;
  readonly idempotencyKey: string;
  readonly target: BannerStageTarget;
  /** Optional client digest. If present it must equal the digest computed here. */
  readonly expectedSha256?: string;
}

export interface BannerStageResult {
  readonly bannerId: string;
  readonly version: BannerAdminVersion;
  /** The banner row version, unchanged by an existing-banner stage. */
  readonly bannerRowVersion: number;
  /** True when this exact request had already completed. */
  readonly replayed: boolean;
  /** "full" only when the server decoded every pixel row. */
  readonly decode: "full" | "not_performed";
  /** True only for a version in state `verified`. */
  readonly verified: boolean;
  readonly note?: string;
}

export type BannerReconciliationClass =
  | "verified_unchanged"
  | "verified_object_missing"
  | "staging_object_missing"
  | "stored_object_integrity_failed"
  | "object_present_unverified_database_state";

export interface BannerReconciliationItem {
  readonly versionId: string;
  readonly state: BannerVersionState;
  readonly classification: BannerReconciliationClass;
}

export interface BannerAdministration {
  listCounties(
    principal: TrustedPrincipal,
    request?: ListCountiesRequest,
  ): Promise<CountyBannerPage>;
  getCounty(
    principal: TrustedPrincipal,
    countyFips: string,
  ): Promise<CountyBannerDetail | null>;
  /** Stores and checks an image. Never selects it and never edits public metadata. */
  stage(
    principal: TrustedPrincipal,
    request: BannerStageRequest,
  ): Promise<BannerStageResult>;
  /** Read-only. Classifies stored objects against recorded digests. Changes nothing. */
  reconcileBanner(
    principal: TrustedPrincipal,
    bannerId: string,
  ): Promise<readonly BannerReconciliationItem[]>;
}

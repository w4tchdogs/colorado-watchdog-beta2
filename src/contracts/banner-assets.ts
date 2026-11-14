export type BannerDisplayMode = "cover" | "contain";
export type BannerMediaType = "image/jpeg" | "image/png";
export type BannerAssetStatus = "draft" | "active" | "withdrawn";
export type BannerVersionState =
  | "pending"
  | "staging"
  | "staged"
  | "verified"
  | "failed"
  | "superseded";
export type BannerStageState =
  | BannerVersionState
  | "interrupted"
  | "ready_for_retry"
  | "activated";

export interface BannerMetadata {
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
  readonly version: number;
}

export interface BannerVersion {
  readonly id: string;
  readonly bannerId: string;
  readonly previousVersionId: string | null;
  readonly sourceFilename: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly byteSize: number;
  readonly mediaType: BannerMediaType;
  readonly objectKey: string;
  readonly state: BannerVersionState;
}

export interface BannerStageProposal {
  readonly bannerId: string;
  readonly countyFips: string;
  readonly sourceFilename: string;
  readonly caption: string;
  readonly altText: string;
  readonly displayOrder: number;
  readonly isPrimary: boolean;
  readonly homepageOrder?: number | null;
  readonly displayMode: BannerDisplayMode;
  readonly focalX: number;
  readonly focalY: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly idempotencyKey: string;
  readonly expectedRowVersion?: number;
  readonly expectedSha256?: string;
  readonly sourceVersionNumber?: number;
  readonly sourceHistory?: readonly Banners1SourceVersion[];
}

export interface Banners1SourceVersion {
  readonly version: number;
  readonly sha256: string;
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly format: "jpeg" | "png";
  readonly sizeBytes: number;
  readonly validation: "full_decode_passed";
  readonly status?: string;
}

export interface ResolvedBanner {
  readonly bannerId: string;
  readonly countyFips: string;
  readonly versionId: string;
  readonly assetRef: string;
  readonly caption: string;
  readonly altText: string;
  readonly displayMode: BannerDisplayMode;
  readonly focalX: number;
  readonly focalY: number;
  readonly displayOrder: number;
  readonly isPrimary: boolean;
  readonly width: number;
  readonly height: number;
}

export interface Banners1ManifestProposal {
  readonly schemaVersion: number;
  readonly banners: readonly Record<string, unknown>[];
}

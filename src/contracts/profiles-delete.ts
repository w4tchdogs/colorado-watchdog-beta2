export const PROFILE_DELETE_REASONS = {
  duplicate: "Duplicate Website copy",
  incorrect: "Incorrect Website record",
  removed_from_master: "Removed from the offline master",
  other: "Other correction",
} as const;

export type ProfileDeleteReason = keyof typeof PROFILE_DELETE_REASONS;

export interface ProfileDeleteCounts {
  readonly roles: number;
  readonly names: number;
  readonly countyLinks: number;
}

export interface ProfileDeletePreview {
  readonly profileId: string;
  readonly displayName: string;
  readonly counties: readonly string[];
  readonly visible: boolean;
  readonly counts: ProfileDeleteCounts;
  readonly blockers: {
    readonly reports: number;
    readonly editorialLinks: number;
    readonly duplicateReviews: number;
  };
  readonly digest: string;
}

export interface ProfileDeleteReceipt {
  readonly profileId: string;
  readonly deletedAt: string;
  readonly counts: ProfileDeleteCounts;
  readonly replayed: boolean;
}

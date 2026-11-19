import { PROFILES_API_PREFIX } from "./profiles.js";

/**
 * Dashboard Profiles CSV import contract (SYNC-1).
 *
 * The owner uploads reviewed CSV files in the Profiles tab, inspects the exact
 * adds, updates, conflicts and visibility, then commits. The browser sends file
 * text only. Parsing, matching, validation, version checks, Website-assigned
 * IDs, receipts and reversal all happen on the server through the shared sync
 * service. The private research store is never read.
 */
export const PROFILES_IMPORT_CONTRACT = "profiles-import/v1" as const;
export const PROFILES_IMPORT_PREFIX = `${PROFILES_API_PREFIX}/import`;
export const PROFILES_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const PROFILES_IMPORT_MAX_ROWS = 20_000;
export const PROFILES_IMPORT_MAX_REPORT_ROWS = 3_000;

/**
 * Stable external keys are persisted as namespaced client references on the
 * committed sync items. A later upload of the same key matches the Website
 * record the first commit created, never by name or label.
 */
export const IMPORT_REF_PREFIX = "dash:";
export const IMPORT_REF = {
  profile: "dash:profile:",
  role: "dash:role:",
  source: "dash:source:",
} as const;

export const PROFILE_FILE = "profile.csv" as const;
export const ROLE_FILE = "profile_role.csv" as const;
export type ProfilesImportFileName = typeof PROFILE_FILE | typeof ROLE_FILE;

/**
 * Accepted file contract. Headers are matched after lowercasing and replacing
 * spaces and hyphens with underscores. Unrecognized columns are listed in the
 * preview and never imported.
 */
export const PROFILE_FILE_COLUMNS = {
  required: ["profile_id", "display_name"],
  optional: [] as readonly string[],
} as const;
export const ROLE_FILE_COLUMNS = {
  required: [
    "role_id",
    "profile_id",
    "county_fips",
    "source_id",
    "source_url",
    "source_title",
    "publisher_classification",
    "source_type",
  ],
  /** At least one of published_office, published_title or job_description per row. */
  optional: [
    "published_office",
    "published_title",
    "job_description",
    "source_checked_at",
    "start_date",
    "end_date",
  ],
} as const;
/** Header aliases from the private v6 export. */
export const HEADER_ALIASES: Readonly<Record<string, string>> = {
  county_code: "county_fips",
};

export interface ProfilesImportFiles {
  readonly profile: string;
  readonly profileRole?: string;
}

export type ImportAction =
  | "add"
  | "update"
  | "unchanged"
  | "conflict"
  | "blocked";
export type ImportRecordKind = "profile" | "role" | "source";
export type ImportVisibility =
  | "hidden_on_create"
  | "stays_hidden"
  | "stays_visible"
  | "not_applicable";

export interface ImportIssue {
  readonly file: ProfilesImportFileName | "request";
  readonly line: number | null;
  readonly key?: string;
  readonly code: string;
  readonly message: string;
}

export interface ImportRowReport {
  readonly kind: ImportRecordKind;
  readonly key: string;
  readonly line: number;
  readonly label: string;
  readonly action: ImportAction;
  readonly websiteId?: string;
  readonly visibility: ImportVisibility;
  readonly fields?: readonly {
    readonly field: string;
    readonly current: string | null;
    readonly proposed: string | null;
  }[];
  readonly reason?: string;
}

export interface ProfilesImportCounts {
  readonly add: number;
  readonly update: number;
  readonly unchanged: number;
  readonly conflict: number;
  readonly blocked: number;
}

export interface ProfilesImportPreview {
  readonly contract: typeof PROFILES_IMPORT_CONTRACT;
  /** Binds the commit to exactly what the owner reviewed. */
  readonly digest: string;
  readonly canCommit: boolean;
  readonly profiles: ProfilesImportCounts;
  readonly roles: ProfilesImportCounts;
  readonly sources: ProfilesImportCounts;
  readonly newProfilesHidden: number;
  readonly rows: readonly ImportRowReport[];
  readonly rowsTruncated: boolean;
  readonly issues: readonly ImportIssue[];
  readonly ignoredColumns: readonly {
    readonly file: ProfilesImportFileName;
    readonly columns: readonly string[];
  }[];
  readonly notes: readonly string[];
  /** Existing Website Profiles and roles the file does not mention. They are never touched. */
  readonly untouchedProfiles: number;
  readonly untouchedRoles: number;
}

export interface ProfilesImportReceipt {
  readonly status: "committed" | "nothing_to_commit";
  readonly batchId?: string;
  readonly committedAt?: string;
  readonly replayed: boolean;
  readonly created: {
    readonly profiles: number;
    readonly roles: number;
    readonly sources: number;
    readonly reusedSources: number;
  };
  readonly updated: { readonly profiles: number; readonly roles: number };
  readonly newProfilesHidden: number;
  readonly createdProfiles: readonly {
    readonly key: string;
    readonly profileId: string;
    readonly hidden: true;
  }[];
}

export interface ProfilesImportReversal {
  readonly status: "reverted" | "already_reverted";
  readonly batchId: string;
  readonly reversedAt: string;
}

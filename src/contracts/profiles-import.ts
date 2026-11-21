import { PROFILES_API_PREFIX } from "./profiles.js";
import type { PersonNameComponentField } from "./sync.js";

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
// Base64-encoded workbooks fit inside the existing JSON request budget.
export const PROFILES_WORKBOOK_MAX_BYTES = (PROFILES_IMPORT_MAX_BYTES * 3) / 4;
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
  name: "dash:name:",
} as const;

export const PROFILE_FILE = "profile.csv" as const;
export const ROLE_FILE = "profile_role.csv" as const;
export const NAME_FILE = "profile_name.csv" as const;
export type ProfilesImportFileName =
  | typeof PROFILE_FILE
  | typeof ROLE_FILE
  | typeof NAME_FILE;

/**
 * Primary name components accepted in profile.csv, with their length limits.
 * An absent column leaves that component untouched. A present column with a
 * blank cell clears it, unless the Profile changed on the Website after its
 * last import.
 */
export const PROFILE_NAME_COMPONENT_COLUMNS: readonly {
  readonly column: PersonNameComponentField;
  readonly max: number;
}[] = [
  { column: "first_name", max: 200 },
  { column: "middle_name", max: 200 },
  { column: "last_name", max: 200 },
  { column: "name_prefix", max: 50 },
  { column: "name_suffix", max: 50 },
  { column: "preferred_first_name", max: 200 },
];

/**
 * Accepted file contract. Headers are matched after lowercasing and replacing
 * spaces and hyphens with underscores. Unrecognized columns are listed in the
 * preview and never imported.
 */
export const PROFILE_FILE_COLUMNS = {
  required: ["profile_id", "display_name"],
  optional: [
    "first_name",
    "middle_name",
    "last_name",
    "name_prefix",
    "name_suffix",
    "preferred_first_name",
  ] as readonly string[],
} as const;
/**
 * Typed alternate names. Each row has its own stable ID and names its
 * Profile by the stable profile_id. verification_status and public_display
 * are read only to warn: an imported alternate is always created private and
 * pending review, whatever the file says. No evidence or claim column is read.
 */
export const NAME_FILE_COLUMNS = {
  required: ["profile_name_id", "profile_id", "name_type", "published_name"],
  optional: [
    "first_name",
    "middle_name",
    "last_name",
    "name_prefix",
    "name_suffix",
    "applies_from",
    "applies_until",
    "verification_status",
    "public_display",
  ],
} as const;
export const IMPORT_ROLE_TEXT_LIMITS = {
  published_office: 500,
  published_title: 500,
  inferred_title: 500,
  job_description: 2000,
} as const;
export const ROLE_FILE_COLUMNS = {
  required: ["role_id", "profile_id", "county_fips"],
  /** At least one of published_office, published_title or job_description per row. */
  optional: [
    "published_office",
    "published_title",
    "inferred_title",
    "job_description",
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
  readonly profileName?: string;
}

export type ProfilesImportSource =
  | ProfilesImportFiles
  | { readonly workbook: string; readonly includeAlternateNames?: boolean };

export type ImportAction =
  | "add"
  | "update"
  | "unchanged"
  | "conflict"
  | "blocked";
export type ImportRecordKind = "profile" | "role" | "source" | "name";
export type ImportVisibility =
  | "hidden_on_create"
  | "stays_hidden"
  | "stays_visible"
  /** A new alternate name: private and pending explicit owner review. */
  | "private_pending_review"
  /** An existing alternate name that is not public. It stays private. */
  | "stays_private"
  /** An existing alternate name the owner made public. A change is held. */
  | "stays_public"
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
  readonly deletedOnWebsite?: true;
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
  readonly names: ProfilesImportCounts;
  readonly newProfilesHidden: number;
  /** New alternate names created private and pending review. */
  readonly newNamesPrivate: number;
  /** Rows whose file marks the name Public or Confirmed. Both are ignored. */
  readonly namesPublishRequested: number;
  /** Unchanged Profiles and roles appear in the totals. Deleted rows retain details. */
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
    readonly names: number;
  };
  readonly updated: {
    readonly profiles: number;
    readonly roles: number;
    readonly names: number;
  };
  readonly newNamesPrivate: number;
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

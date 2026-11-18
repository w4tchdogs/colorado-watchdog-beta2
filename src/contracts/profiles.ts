/**
 * Profiles sheet contract (PROFILES-1).
 *
 * One row per role, keyed by the stable Profile ID and Role ID. The field map
 * below is the single source for the dashboard grid, the server allowlist and
 * the published field map in docs/architecture/profiles-sheet.md. Status says
 * what the Website can do with a column today:
 *
 * - `editable`: written through the guarded Website write path with an
 *   expected row version, an audit event and a retry-safe receipt.
 * - `read-only`: shown from Website D1 and never written by this module.
 * - `unavailable`: the Website has no such column. The picker lists it with
 *   the reason so no column is silently missing.
 */
export const PROFILES_API_PREFIX = "/api/admin/profiles";
export const PROFILES_CAPABILITY = "profile.manage";

export const PROFILES_MAX_PAGE_SIZE = 100;
export const PROFILES_DEFAULT_PAGE_SIZE = 50;
export const PROFILES_MAX_PAGE = 10_000;
export const PROFILES_MAX_SELECT_ALL = 1_000;
export const PROFILES_MAX_CHANGES = 500;
export const PROFILES_MAX_QUERY_LENGTH = 100;
export const PROFILES_MAX_NAME_LENGTH = 500;

export type ProfileFieldStatus = "editable" | "read-only" | "unavailable";
export type ProfileFieldScope = "profile" | "role";

export interface ProfileFieldDefinition {
  readonly id: string;
  readonly label: string;
  readonly status: ProfileFieldStatus;
  readonly scope: ProfileFieldScope;
  /** Where the value comes from on the Website, or why it is not there. */
  readonly source: string;
  /** Which system owns the value and what a later sync can change. */
  readonly owner: string;
  /** Short reason shown in the picker for an unavailable column. */
  readonly reason?: string;
  readonly defaultVisible: boolean;
  readonly sortable: boolean;
  /** Present for editable columns: the guarded entity and column. */
  readonly write?: {
    readonly entity: "people" | "person_roles" | "person_visibility";
    readonly column: string;
  };
}

const PRIVATE_WORKFLOW =
  "Private Profiles database. Not stored on the Website and never synced to it.";

export const PROFILE_FIELDS: readonly ProfileFieldDefinition[] = [
  {
    id: "profileId",
    label: "Profile ID",
    status: "read-only",
    scope: "profile",
    source: "people.id",
    owner:
      "Website. Assigned once when the Profile is created and never changed by a sync.",
    defaultVisible: false,
    sortable: true,
  },
  {
    id: "fullName",
    label: "Full Name",
    status: "editable",
    scope: "profile",
    source: "people.display_name",
    owner:
      "Shared. The Website value is edited here. The private reviewed Profiles record is edited through its own workflow. A later reviewed sync replaces the Website value only through a preview and the expected-version check.",
    defaultVisible: true,
    sortable: true,
    write: { entity: "people", column: "display_name" },
  },
  {
    id: "visible",
    label: "Visible on Website",
    status: "editable",
    scope: "profile",
    source: "person_visibility.visible (no row means visible)",
    owner:
      "Website only. Changed by an explicit hide or restore action. No sync ever reads or replaces it.",
    defaultVisible: true,
    sortable: true,
    write: { entity: "person_visibility", column: "visible" },
  },
  {
    id: "promotionReviewedBy",
    label: "Promotion Reviewed By",
    status: "unavailable",
    scope: "profile",
    source: "Private Profiles database",
    owner: PRIVATE_WORKFLOW,
    reason:
      "System-generated review metadata. It stays in the private Profiles workflow.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "promotionReviewedOn",
    label: "Promotion Reviewed On",
    status: "unavailable",
    scope: "profile",
    source: "Private Profiles database",
    owner: PRIVATE_WORKFLOW,
    reason:
      "System-generated review metadata. It stays in the private Profiles workflow.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "reviewerNotes",
    label: "Reviewer Notes",
    status: "unavailable",
    scope: "profile",
    source: "Private Profiles database",
    owner: PRIVATE_WORKFLOW,
    reason: "Private reviewer notes stay in the private Profiles workflow.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "createdOn",
    label: "Created On",
    status: "read-only",
    scope: "profile",
    source: "people.created_at",
    owner:
      "Website. Set when the Website record was created, not the private research date.",
    defaultVisible: false,
    sortable: true,
  },
  {
    id: "firstName",
    label: "First Name",
    status: "unavailable",
    scope: "profile",
    source: "No Website column",
    owner:
      "Private Profiles database. The Website stores one display name, so no component is derived from it.",
    reason:
      "The Website keeps only the full display name. Verified name components are not on main.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "middleName",
    label: "Middle Name",
    status: "unavailable",
    scope: "profile",
    source: "No Website column",
    owner:
      "Private Profiles database. The Website stores one display name, so no component is derived from it.",
    reason:
      "The Website keeps only the full display name. Verified name components are not on main.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "lastName",
    label: "Last Name",
    status: "unavailable",
    scope: "profile",
    source: "No Website column",
    owner:
      "Private Profiles database. The Website stores one display name, so no component is derived from it.",
    reason:
      "The Website keeps only the full display name. Verified name components are not on main.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "alternateName1",
    label: "Alternate Name 1",
    status: "unavailable",
    scope: "profile",
    source: "No Website column",
    owner: PRIVATE_WORKFLOW,
    reason:
      "The Website has no alternate-name table, so Search covers the display name only.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "alternateName2",
    label: "Alternate Name 2",
    status: "unavailable",
    scope: "profile",
    source: "No Website column",
    owner: PRIVATE_WORKFLOW,
    reason:
      "The Website has no alternate-name table, so Search covers the display name only.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "county",
    label: "County",
    status: "read-only",
    scope: "role",
    source:
      "person_roles.county_fips, else the linked office's county, joined to counties.name",
    owner:
      "Shared. A role's county is set by a reviewed sync. This module does not write it.",
    defaultVisible: true,
    sortable: true,
  },
  {
    id: "countyUnit",
    label: "County Unit",
    status: "read-only",
    scope: "role",
    source: "Parent of the linked organization (organizations.parent_organization_id)",
    owner:
      "Shared organization entity. Changed only through a reviewed sync of the organization.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "countySubUnit",
    label: "County Sub Unit",
    status: "read-only",
    scope: "role",
    source: "The linked organization when it has a parent",
    owner:
      "Shared organization entity. Changed only through a reviewed sync of the organization.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "officeDepartment",
    label: "Office / Department",
    status: "read-only",
    scope: "role",
    source: "person_roles.published_office, else organizations.name",
    owner:
      "Role text is written by a reviewed sync. The Website allowlist has no office field, so it is read-only here.",
    defaultVisible: true,
    sortable: true,
  },
  {
    id: "position",
    label: "Position",
    status: "read-only",
    scope: "role",
    source: "person_roles.published_title, else positions.title",
    owner:
      "Role text is written by a reviewed sync. A shared position title is not edited from a single row.",
    defaultVisible: true,
    sortable: true,
  },
  {
    id: "roleDuties",
    label: "Role / Duties",
    status: "read-only",
    scope: "role",
    source: "person_roles.job_description",
    owner:
      "Role text is written by a reviewed sync. The Website allowlist has no duties field, so it is read-only here.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "employmentStart",
    label: "Employment Start",
    status: "editable",
    scope: "role",
    source: "person_roles.start_date",
    owner:
      "Shared. Edited here on the Website. A later reviewed sync can replace it only after the preview shows the difference and the role's expected version still matches.",
    defaultVisible: true,
    sortable: true,
    write: { entity: "person_roles", column: "start_date" },
  },
  {
    id: "employmentEnd",
    label: "Employment End",
    status: "editable",
    scope: "role",
    source: "person_roles.end_date",
    owner:
      "Shared. Edited here on the Website. A later reviewed sync can replace it only after the preview shows the difference and the role's expected version still matches.",
    defaultVisible: true,
    sortable: true,
    write: { entity: "person_roles", column: "end_date" },
  },
  {
    id: "affiliation",
    label: "Affiliation",
    status: "read-only",
    scope: "role",
    source:
      "Direct county government, or organization_county_affiliations for the county",
    owner:
      "Shared organization entity. Changed only through a reviewed sync.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "dateReviewed",
    label: "Date Reviewed",
    status: "editable",
    scope: "role",
    source: "person_roles.source_checked_at",
    owner:
      "Shared. The Website value is the source check date. A later reviewed sync can replace it through the preview and expected-version check.",
    defaultVisible: false,
    sortable: true,
    write: { entity: "person_roles", column: "source_checked_at" },
  },
  {
    id: "roleId",
    label: "Role ID",
    status: "read-only",
    scope: "role",
    source: "person_roles.id",
    owner:
      "Website. Assigned once when the role is created and kept through every sync.",
    defaultVisible: false,
    sortable: true,
  },
  {
    id: "profileVersion",
    label: "Profile Version",
    status: "read-only",
    scope: "profile",
    source: "people.version",
    owner:
      "Website. System counter checked on every save and by every sync update.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "roleVersion",
    label: "Role Version",
    status: "read-only",
    scope: "role",
    source: "person_roles.version",
    owner:
      "Website. System counter checked on every save and by every sync update.",
    defaultVisible: false,
    sortable: false,
  },
  {
    id: "roleSource",
    label: "Source Citation",
    status: "unavailable",
    scope: "role",
    source: "role_sources and the private evidence record",
    owner: PRIVATE_WORKFLOW,
    reason:
      "Claim-level evidence and citations stay in the private Profiles workflow and are never shown in this sheet.",
    defaultVisible: false,
    sortable: false,
  },
] as const;

export const PROFILE_SORT_FIELDS = PROFILE_FIELDS.filter(
  (field) => field.sortable,
).map((field) => field.id);

export type ProfileVisibilityFilter = "all" | "visible" | "hidden";
export type ProfileSortDirection = "asc" | "desc";

export interface ProfileQuery {
  readonly query: string;
  readonly countyFips: string | null;
  readonly office: string | null;
  readonly visibility: ProfileVisibilityFilter;
  readonly sort: string;
  readonly direction: ProfileSortDirection;
  readonly page: number;
  readonly pageSize: number;
}

export interface ProfileRow {
  readonly roleId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly roleVersion: number;
  /** 0 when the Profile has no visibility row (visible by default). */
  readonly visibilityVersion: number;
  readonly fullName: string;
  readonly visible: boolean;
  readonly createdOn: string;
  readonly countyFips: string | null;
  readonly county: string | null;
  readonly countyUnit: string | null;
  readonly countySubUnit: string | null;
  readonly officeDepartment: string | null;
  readonly position: string | null;
  readonly roleDuties: string | null;
  readonly employmentStart: string | null;
  readonly employmentEnd: string | null;
  readonly affiliation: string | null;
  readonly dateReviewed: string | null;
  readonly roleCreatedOn: string;
  readonly roleUpdatedOn: string;
  readonly profileUpdatedOn: string;
}

export interface ProfilePage {
  readonly rows: readonly ProfileRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly lastPage: number;
}

export interface ProfileFacets {
  readonly counties: readonly { readonly fips: string; readonly name: string }[];
  readonly offices: readonly string[];
}

/**
 * What a selected row carries so a bulk change needs no further lookup: the
 * stable IDs, the versions to expect and the values the change replaces.
 */
export interface ProfileSelectionEntry {
  readonly roleId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly roleVersion: number;
  readonly visibilityVersion: number;
  readonly visible: boolean;
  readonly fullName: string;
  readonly employmentStart: string | null;
  readonly employmentEnd: string | null;
  readonly dateReviewed: string | null;
}

export type ProfileChange =
  | {
      readonly kind: "field";
      readonly entity: "people" | "person_roles";
      readonly targetId: string;
      readonly field: string;
      readonly expectedVersion: number;
      readonly value: string | null;
    }
  | {
      readonly kind: "visibility";
      readonly personId: string;
      readonly expectedVersion: number;
      readonly visible: boolean;
    };

export type ProfileErrorCode =
  | "invalid_value"
  | "unsupported_field"
  | "duplicate_target"
  | "not_found"
  | "stale_version"
  | "not_eligible"
  | "no_change"
  | "date_order";

export interface ProfileChangeIssue {
  readonly index: number;
  readonly code: ProfileErrorCode;
  readonly message: string;
  /** Present for a stale change: the version and value now stored. */
  readonly currentVersion?: number;
  readonly currentValue?: string | boolean | null;
}

export interface ProfileImpact {
  /** True when the written entity is shared by more than one role row. */
  readonly shared: boolean;
  readonly profileId: string | null;
  readonly roleRows: number;
  readonly counties: readonly string[];
  readonly summary: string;
}

export interface ProfilePreviewItem {
  readonly index: number;
  readonly label: string;
  readonly field: string;
  readonly targetId: string;
  readonly before: string | boolean | null;
  readonly after: string | boolean | null;
  readonly impact: ProfileImpact;
}

export interface ProfilePreview {
  readonly ok: boolean;
  readonly items: readonly ProfilePreviewItem[];
  readonly issues: readonly ProfileChangeIssue[];
}

export interface ProfileSaveResult {
  readonly applied: number;
  readonly replayed: boolean;
  readonly items: readonly {
    readonly index: number;
    readonly entity: "people" | "person_roles" | "person_visibility";
    readonly targetId: string;
    readonly field: string;
    readonly newVersion: number;
  }[];
}

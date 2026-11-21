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
export const PROFILES_EXPORT_FILENAME = "profiles-view.csv";

export const PROFILES_MAX_PAGE_SIZE = 1_000;
export const PROFILES_DEFAULT_PAGE_SIZE = 50;
export const PROFILES_MAX_PAGE = 10_000;
export const PROFILES_MAX_SELECT_ALL = 1_000;
export const PROFILES_MAX_CHANGES = 500;
export const PROFILES_MAX_QUERY_LENGTH = 100;
export const PROFILES_MAX_NAME_LENGTH = 500;
export const PROFILES_MAX_NAME_COMPONENT_LENGTH = 200;
export const PROFILES_MAX_NAME_AFFIX_LENGTH = 50;

/**
 * Controlled alternate-name vocabulary. The meaning of each value is
 * documented in docs/architecture/profile-names.md. A value says how the name
 * is documented, never an unstated conclusion: a different surname in a source
 * is not by itself a `married_surname`, a `birth_surname` or a
 * `legal_name_change`. Use `other` or `historical_published` with
 * `requires_review` until the evidence supports a specific type.
 */
export const ALTERNATE_NAME_TYPES = [
  "nickname",
  "preferred",
  "middle_name_used",
  "birth_surname",
  "married_surname",
  "former_surname",
  "legal_name_change",
  "professional_name",
  "initials",
  "historical_published",
  "spelling_variant",
  "transliteration",
  "other",
] as const;
export type AlternateNameType = (typeof ALTERNATE_NAME_TYPES)[number];

/**
 * Label and meaning for each alternate-name type. The meanings are the
 * vocabulary the owner agreed to and are repeated in
 * docs/architecture/profile-names.md. Every meaning describes how a name is
 * documented. None of them lets the Website infer a life event.
 */
export const ALTERNATE_NAME_TYPE_INFO: Readonly<
  Record<
    AlternateNameType,
    { readonly label: string; readonly meaning: string }
  >
> = {
  nickname: {
    label: "Nickname",
    meaning:
      "An informal given name or short form the person is documented as using.",
  },
  preferred: {
    label: "Preferred name",
    meaning:
      "A name the person is documented as preferring, apart from the primary Preferred First Name.",
  },
  middle_name_used: {
    label: "Middle name used",
    meaning:
      "The person is documented as going by a middle name in place of the first name.",
  },
  birth_surname: {
    label: "Birth surname",
    meaning: "A source states this is the surname the person was born with.",
  },
  married_surname: {
    label: "Married surname",
    meaning:
      "A source states this surname was taken or used because of a marriage.",
  },
  former_surname: {
    label: "Former surname",
    meaning:
      "A source states this is a surname the person used before the current one, without saying why.",
  },
  legal_name_change: {
    label: "Legal name change",
    meaning: "A source documents a legal change of name.",
  },
  professional_name: {
    label: "Professional name",
    meaning: "A name used in a professional or official role.",
  },
  initials: {
    label: "Initials",
    meaning: "The name as initials, such as J. R. Doe.",
  },
  historical_published: {
    label: "Historical published name",
    meaning:
      "A name as it appeared in a dated publication when the reason for the difference is not documented.",
  },
  spelling_variant: {
    label: "Spelling variant",
    meaning: "The same name spelled differently across sources.",
  },
  transliteration: {
    label: "Transliteration",
    meaning: "The name rendered from another alphabet or accented form.",
  },
  other: {
    label: "Other",
    meaning:
      "Any documented name that fits no other type. Use with Requires review when unsure.",
  },
};

export const ALTERNATE_NAME_STATUSES = [
  "requires_review",
  "confirmed",
] as const;
export type AlternateNameStatus = (typeof ALTERNATE_NAME_STATUSES)[number];

/** Public label for an approved alternate name, by type. */
export type AlternateNamePublicLabel =
  | "Also known as"
  | "Formerly known as"
  | "Professional name"
  | "Published as";

export const ALTERNATE_NAME_PUBLIC_LABELS: Readonly<
  Record<AlternateNameType, AlternateNamePublicLabel>
> = {
  nickname: "Also known as",
  preferred: "Also known as",
  middle_name_used: "Also known as",
  birth_surname: "Formerly known as",
  married_surname: "Formerly known as",
  former_surname: "Formerly known as",
  legal_name_change: "Formerly known as",
  professional_name: "Professional name",
  initials: "Also known as",
  historical_published: "Published as",
  spelling_variant: "Published as",
  transliteration: "Published as",
  other: "Also known as",
};

export type ProfileNameReview =
  | "display_only"
  | "components_entered"
  | "alternate_names_pending";

/** Editable primary-name columns on `people`, by grid field ID. */
export const PROFILE_NAME_COMPONENT_COLUMNS = {
  firstName: "first_name",
  middleName: "middle_name",
  lastName: "last_name",
  preferredFirstName: "preferred_first_name",
  namePrefix: "name_prefix",
  nameSuffix: "name_suffix",
} as const;

export interface AlternateNameFields {
  readonly nameType: AlternateNameType;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly namePrefix: string | null;
  readonly nameSuffix: string | null;
  /** The exact documented name ("Full Name as Published"). */
  readonly publishedName: string;
  readonly appliesFrom: string | null;
  readonly appliesUntil: string | null;
  readonly verificationStatus: AlternateNameStatus;
  readonly publicDisplay: boolean;
}

/**
 * One alternate-name operation. `add` needs no expected version. `update`,
 * `remove` and `restore` carry the name's version. `remove` is a reversible
 * soft removal, and `restore` undoes it. The server checks that the Profile
 * still exists in the same atomic batch as every other change.
 */
export type AlternateNameChange =
  | {
      readonly kind: "alternate_name";
      readonly op: "add";
      readonly personId: string;
      readonly fields: AlternateNameFields;
    }
  | {
      readonly kind: "alternate_name";
      readonly op: "update";
      readonly personId: string;
      readonly nameId: string;
      readonly expectedVersion: number;
      readonly fields: AlternateNameFields;
    }
  | {
      readonly kind: "alternate_name";
      readonly op: "remove" | "restore";
      readonly personId: string;
      readonly nameId: string;
      readonly expectedVersion: number;
    };

/** An alternate name as the owner sees it. */
export interface AlternateNameRecord extends AlternateNameFields {
  readonly id: string;
  readonly personId: string;
  readonly version: number;
  readonly removed: boolean;
  readonly removedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AlternateNameList {
  readonly profileId: string;
  readonly displayName: string;
  readonly profileVersion: number;
  readonly names: readonly AlternateNameRecord[];
  /** True when the Profile has more names than one response carries. */
  readonly truncated: boolean;
}

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

const NAME_COMPONENT_OWNER =
  "Website only for now. Edited here and left blank when unknown. The Website never derives a component from the display name. The reviewed sync does not read or write it until the Profiles import extends the sync allowlist.";

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
    id: "displayName",
    label: "Display Name",
    status: "editable",
    scope: "profile",
    source: "people.display_name",
    owner:
      "Shared. The approved public-facing name. Edited here on the Website. A later reviewed sync replaces it only through a preview and the expected-version check. It is never rebuilt from the name components.",
    defaultVisible: true,
    sortable: true,
    write: { entity: "people", column: "display_name" },
  },
  {
    id: "visible",
    label: "Visible",
    status: "editable",
    scope: "profile",
    source: "person_visibility.visible (no row means visible)",
    owner:
      "Website only. Changed by an explicit hide or restore action. No sync ever reads or replaces it. Disabled while the Profile does not meet the publication rule.",
    defaultVisible: true,
    sortable: true,
    write: { entity: "person_visibility", column: "visible" },
  },
  {
    id: "publicationStatus",
    label: "Status",
    status: "read-only",
    scope: "profile",
    source:
      "Visible on Website and the publication rule (profile_publication_ready, migration 0037)",
    owner:
      "Website. Computed, never stored. Says Visible, Hidden, or Hidden with what is missing, such as Hidden · Missing role.",
    defaultVisible: true,
    sortable: false,
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
    id: "lastUploaded",
    label: "Last Uploaded",
    status: "read-only",
    scope: "profile",
    source:
      "Latest committed dashboard Profiles import (sync_batches.committed_at) that created or changed the Profile, a role or an alternate name",
    owner:
      "Website. Read from committed import receipts. Previews, failed commits, unchanged rows and same-key retries leave it alone. Blank when no upload is recorded.",
    defaultVisible: true,
    sortable: true,
  },
  {
    id: "firstName",
    label: "First Name",
    status: "editable",
    scope: "profile",
    source: "people.first_name",
    owner: NAME_COMPONENT_OWNER,
    defaultVisible: true,
    sortable: true,
    write: { entity: "people", column: "first_name" },
  },
  {
    id: "middleName",
    label: "Middle Name",
    status: "editable",
    scope: "profile",
    source: "people.middle_name",
    owner: NAME_COMPONENT_OWNER,
    defaultVisible: true,
    sortable: true,
    write: { entity: "people", column: "middle_name" },
  },
  {
    id: "lastName",
    label: "Last Name",
    status: "editable",
    scope: "profile",
    source: "people.last_name",
    owner: NAME_COMPONENT_OWNER,
    defaultVisible: true,
    sortable: true,
    write: { entity: "people", column: "last_name" },
  },
  {
    id: "preferredFirstName",
    label: "Preferred First Name",
    status: "editable",
    scope: "profile",
    source: "people.preferred_first_name",
    owner: NAME_COMPONENT_OWNER,
    defaultVisible: false,
    sortable: true,
    write: { entity: "people", column: "preferred_first_name" },
  },
  {
    id: "namePrefix",
    label: "Name Prefix",
    status: "editable",
    scope: "profile",
    source: "people.name_prefix",
    owner: NAME_COMPONENT_OWNER,
    defaultVisible: false,
    sortable: true,
    write: { entity: "people", column: "name_prefix" },
  },
  {
    id: "nameSuffix",
    label: "Name Suffix",
    status: "editable",
    scope: "profile",
    source: "people.name_suffix",
    owner: NAME_COMPONENT_OWNER,
    defaultVisible: false,
    sortable: true,
    write: { entity: "people", column: "name_suffix" },
  },
  {
    id: "alternateNameCount",
    label: "Alternate Names",
    status: "read-only",
    scope: "profile",
    source: "Count of active profile_names rows for the Profile",
    owner:
      "Website. Alternate names are added, edited and removed in the alternate-name editor, not in the grid.",
    defaultVisible: true,
    sortable: true,
  },
  {
    id: "nameReview",
    label: "Name Review",
    status: "read-only",
    scope: "profile",
    source:
      "Derived from the name components and the review status of the alternate names",
    owner:
      "Website. Display name only, components entered, or alternate names awaiting review. Computed, never stored.",
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
    source:
      "Parent of the linked organization (organizations.parent_organization_id)",
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
    id: "unitLink",
    label: "Unit Linked",
    status: "read-only",
    scope: "role",
    source:
      "Exact county and office match against County Structure, with the reviewed home placement",
    owner: "Website. Saved in County Structure as a role-to-unit link.",
    defaultVisible: true,
    sortable: false,
  },
  {
    id: "position",
    label: "Position",
    status: "read-only",
    scope: "role",
    source:
      "person_roles.published_title, then person_roles.inferred_title, then positions.title",
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
    owner: "Shared organization entity. Changed only through a reviewed sync.",
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

const PINNED_PROFILE_FIELDS = ["visible", "displayName"];
export const PROFILE_GRID_FIELDS = [
  ...PINNED_PROFILE_FIELDS.map((id) =>
    PROFILE_FIELDS.find((field) => field.id === id),
  ).filter((field) => field !== undefined),
  ...PROFILE_FIELDS.filter(
    (field) =>
      field.status !== "unavailable" &&
      !PINNED_PROFILE_FIELDS.includes(field.id),
  ),
];

export const PROFILE_SORT_FIELDS = PROFILE_FIELDS.filter(
  (field) => field.sortable,
).map((field) => field.id);

/** `incomplete` lists Profiles that do not meet the publication rule. */
export type ProfileVisibilityFilter =
  | "all"
  | "visible"
  | "hidden"
  | "incomplete";
export type ProfileSortDirection = "asc" | "desc";
export type ProfileUnitLinkFilter = "all" | "unlinked" | "linked";
export const PROFILE_NO_COUNTY = "none";

export interface ProfileQuery {
  readonly query: string;
  readonly countyFips: string | null;
  readonly office: string | null;
  readonly visibility: ProfileVisibilityFilter;
  readonly unitLink?: ProfileUnitLinkFilter;
  readonly sort: string;
  readonly direction: ProfileSortDirection;
  readonly page: number;
  readonly pageSize: number;
}

export interface ProfileRow {
  /** Stable grid key: the role ID, or `profile:<id>` for a roleless Profile. */
  readonly rowKey: string;
  /** Null on the one row of a Profile that has no role. */
  readonly roleId: string | null;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly roleVersion: number;
  /** 0 when the Profile has no visibility row (visible by default). */
  readonly visibilityVersion: number;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly preferredFirstName: string | null;
  readonly namePrefix: string | null;
  readonly nameSuffix: string | null;
  /** Active (not removed) alternate names, any status. */
  readonly alternateNameCount: number;
  readonly alternateNamesPendingReview: number;
  readonly nameReview: ProfileNameReview;
  readonly visible: boolean;
  /** True when the Profile meets the publication rule. */
  readonly publicationReady: boolean;
  /** What is missing, such as "role" or "county". Empty when ready. */
  readonly missingForPublication: readonly string[];
  /** `incomplete` when the Website hid the Profile automatically. */
  readonly hiddenReason: "incomplete" | null;
  readonly publicationStatus: string;
  readonly createdOn: string;
  /** Commit time of the latest import that changed it, or null. */
  readonly lastUploaded: string | null;
  readonly countyFips: string | null;
  readonly county: string | null;
  readonly countyUnit: string | null;
  readonly countySubUnit: string | null;
  readonly officeDepartment: string | null;
  readonly unitLink: ProfileUnitLink | null;
  readonly position: string | null;
  readonly roleDuties: string | null;
  readonly employmentStart: string | null;
  readonly employmentEnd: string | null;
  readonly affiliation: string | null;
  readonly dateReviewed: string | null;
  readonly roleCreatedOn: string | null;
  readonly roleUpdatedOn: string | null;
  readonly profileUpdatedOn: string;
}

export type ProfileUnitLinkState =
  | "linked"
  | "ready"
  | "unmatched"
  | "multiple"
  | "review";

export const PROFILE_UNIT_LINK_LABELS: Readonly<
  Record<ProfileUnitLinkState, string>
> = {
  linked: "✓ Linked",
  ready: "Exact match · ready to link",
  unmatched: "No exact match",
  multiple: "Multiple matches",
  review: "Review existing link",
};

export interface ProfileUnitLink {
  readonly state: ProfileUnitLinkState;
  readonly paths: readonly string[];
}

export type ProfileUnitLinkPreview = Readonly<
  Record<ProfileUnitLinkState, number>
> & {
  readonly digest: string;
};

export interface ProfileUnitLinkReceipt {
  readonly attached: number;
  readonly replayed: boolean;
}

export interface ProfileUnitSuggestion {
  readonly unitId: string;
  readonly path: string;
  readonly digest: string;
}

export interface ProfileUnitSuggestions {
  readonly office: string | null;
  readonly units: readonly ProfileUnitSuggestion[];
}

export interface ProfilePage {
  readonly rows: readonly ProfileRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly lastPage: number;
}

export interface ProfileFacets {
  readonly counties: readonly {
    readonly fips: string;
    readonly name: string;
  }[];
  readonly offices: readonly {
    readonly name: string;
    readonly countyFips: string | null;
  }[];
  readonly nextOfficeCursor: string | null;
}

/**
 * What a selected row carries so a bulk change needs no further lookup: the
 * stable IDs, the versions to expect and the values the change replaces.
 */
export interface ProfileSelectionEntry {
  readonly rowKey: string;
  readonly roleId: string | null;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly roleVersion: number;
  readonly visibilityVersion: number;
  readonly visible: boolean;
  readonly publicationReady: boolean;
  readonly displayName: string;
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
    }
  | AlternateNameChange;

export type ProfileErrorCode =
  | "invalid_value"
  | "unsupported_field"
  | "duplicate_target"
  | "not_found"
  | "stale_version"
  | "not_eligible"
  | "no_change"
  | "date_order"
  | "duplicate_name"
  | "public_not_allowed";

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
    readonly entity:
      | "people"
      | "person_roles"
      | "person_visibility"
      | "profile_names";
    readonly targetId: string;
    readonly field: string;
    readonly newVersion: number;
  }[];
}

export interface MatchingProfileVisibilityPreview {
  readonly matched: number;
  readonly willChange: number;
  readonly alreadySet: number;
  readonly incomplete: number;
  readonly digest: string;
}

export interface MatchingProfileVisibilityReceipt {
  readonly applied: number;
  readonly replayed: boolean;
}

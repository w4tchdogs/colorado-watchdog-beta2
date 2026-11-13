/**
 * Types and limits for the local editorial sandbox lookup. The lookup exists
 * only inside the disposable sandbox. It is not a public Website endpoint and
 * does not depend on any public discovery contract.
 */
export const DIRECTORY_LOOKUP_KINDS = ["person", "organization"] as const;
export type DirectoryLookupKind = (typeof DIRECTORY_LOOKUP_KINDS)[number];

export const DIRECTORY_LOOKUP_DEFAULT_LIMIT = 10;
export const DIRECTORY_LOOKUP_MAX_LIMIT = 25;
export const DIRECTORY_LOOKUP_MAX_IDS = 50;
export const DIRECTORY_LOOKUP_MAX_QUERY_LENGTH = 100;
export const DIRECTORY_LOOKUP_MAX_QUERY_WORDS = 5;

export const SANDBOX_ORGANIZATION_TYPES = [
  "county_government",
  "office",
  "department",
  "division",
  "regional",
  "partner",
  "other",
] as const;
export type SandboxOrganizationType =
  (typeof SANDBOX_ORGANIZATION_TYPES)[number];

export type SandboxParentRelationship = "reports_to" | "grouped_under";
export type SandboxAffiliationType =
  | "serves"
  | "partner_for"
  | "shared_service";

export interface DirectoryLookupRequest {
  readonly kind: DirectoryLookupKind;
  /** Search words (name or ID). Omitted or empty lists the first records. */
  readonly query?: string;
  /** Resolve exact IDs instead of searching (selected-record checks). */
  readonly ids?: readonly string[];
  readonly limit?: number;
}

export interface PersonLookupItem {
  readonly id: string;
  readonly name: string;
  /** Recorded role titles, shown only to tell records apart. */
  readonly roles: readonly {
    readonly title: string;
    readonly organizationName: string;
  }[];
}

export interface OrganizationLookupItem {
  readonly id: string;
  readonly name: string;
  readonly type: SandboxOrganizationType;
  readonly county: { readonly fips: string; readonly name: string } | null;
  readonly parent: {
    readonly id: string;
    readonly name: string;
    readonly relationship: SandboxParentRelationship;
  } | null;
  readonly affiliations: readonly {
    readonly fips: string;
    readonly name: string;
    readonly relationshipType: SandboxAffiliationType;
  }[];
}

export interface DirectoryLookupResult<T> {
  readonly kind: DirectoryLookupKind;
  readonly items: readonly T[];
  /** True when more records matched than were returned. */
  readonly hasMore: boolean;
  /** Only for ID resolution: requested IDs that do not exist. */
  readonly missingIds: readonly string[];
}

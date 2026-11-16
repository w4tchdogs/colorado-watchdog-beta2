import type { CountyAffiliationType, OrganizationType } from "./directory.js";

export const OFFICIALS_SORT_FIELDS = [
  "name",
  "title",
  "organization",
  "county",
  "checked",
] as const;
export type OfficialsSort = (typeof OFFICIALS_SORT_FIELDS)[number];
export type SortDirection = "asc" | "desc";

/** Browses documented people. No search term is required. */
export interface OfficialsDirectoryRequest {
  /** Limit to organizations of, or affiliated with, this county. */
  readonly countyFips?: string | null;
  /** Limit to this organization and its documented subunits. */
  readonly organizationId?: string | null;
  /** Limit to organizations of one stored type. */
  readonly organizationType?: OrganizationType | null;
  /** Matches person names, position titles and organization names. */
  readonly query?: string | null;
  readonly sort?: OfficialsSort;
  readonly direction?: SortDirection;
  /** One-based page number. */
  readonly page?: number;
  readonly limit?: number;
}

export interface OfficialsCountyAssociation {
  readonly fips: string;
  readonly name: string;
  readonly direct: boolean;
  readonly affiliations: readonly CountyAffiliationType[];
}

export interface OfficialsDirectoryRole {
  readonly id: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** When the cited source was checked. Not an employment date. */
  readonly sourceCheckedAt: string;
  readonly position: { readonly id: string; readonly title: string };
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly type: OrganizationType;
    readonly counties: readonly OfficialsCountyAssociation[];
  };
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: string;
    readonly publisherClassification?: "official" | "unofficial";
  };
}

export interface OfficialsDirectoryEntry {
  readonly person: { readonly id: string; readonly displayName: string };
  /**
   * The person's most recently source-checked role among those matching the
   * request, or null when the person has no documented role. It is a display
   * choice, not a statement of current employment.
   */
  readonly role: OfficialsDirectoryRole | null;
  /** Number of the person's role records matching the request. */
  readonly matchingRoleCount: number;
}

export interface OfficialsDirectoryPage {
  readonly items: readonly OfficialsDirectoryEntry[];
  /** People matching the request, counted from Website records only. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

export interface CountyStructureRequest {
  readonly countyFips: string;
}

export interface CountyStructureOrganization {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly parentOrganizationId: string | null;
  readonly parentRelationship: "reports_to" | "grouped_under" | null;
  readonly countyAssociation: {
    readonly direct: boolean;
    readonly affiliations: readonly CountyAffiliationType[];
  };
  /** Positions documented for this organization itself. */
  readonly positionCount: number;
  /**
   * Distinct people with a role record at this organization or a documented
   * subunit. A count of records, not a staffing total.
   */
  readonly peopleCount: number;
}

export interface CountyStructure {
  readonly county: { readonly fips: string; readonly name: string };
  readonly organizations: readonly CountyStructureOrganization[];
  /** True when the county has more organizations than the bounded read. */
  readonly truncated: boolean;
}

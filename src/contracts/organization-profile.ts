import type {
  CountyAffiliationType,
  DirectoryPage,
  OrganizationType,
} from "./directory.js";

export interface OrganizationProfilePageRequest {
  readonly organizationId: string;
  readonly limit?: number;
  readonly afterPositionId?: string | null;
}

export interface OrganizationRolePageRequest {
  readonly organizationId: string;
  readonly limit?: number;
  readonly afterRoleId?: string | null;
}

export interface OrganizationProfileCounty {
  readonly fips: string;
  readonly name: string;
  readonly direct: boolean;
  readonly affiliations: readonly {
    id: string;
    relationshipType: CountyAffiliationType;
    version: number;
  }[];
}

export interface OrganizationProfileParent {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly relationshipType: "reports_to" | "grouped_under";
}

export interface OrganizationProfileSubunit {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly relationshipType: "reports_to" | "grouped_under";
}

/** Direct subunits listed on a profile. Longer lists are cut here. */
export const MAX_PROFILE_SUBUNITS = 50;

export interface OrganizationProfilePosition {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

export interface OrganizationProfilePage
  extends DirectoryPage<OrganizationProfilePosition> {
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly type: OrganizationType;
    readonly version: number;
  };
  readonly parentOrganization: OrganizationProfileParent | null;
  /** Direct subunits only, ordered by name then id, at most MAX_PROFILE_SUBUNITS. */
  readonly subunits: readonly OrganizationProfileSubunit[];
  readonly subunitsTruncated: boolean;
  readonly counties: readonly OrganizationProfileCounty[];
}

export interface OrganizationRoleEntry {
  readonly role: {
    readonly id: string;
    readonly version: number;
    readonly startDate: string | null;
    readonly endDate: string | null;
    readonly sourceCheckedAt: string;
  };
  readonly person: {
    readonly id: string;
    readonly displayName: string;
    readonly version: number;
  };
  readonly position: {
    readonly id: string;
    readonly title: string;
    readonly version: number;
  };
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: "official_page" | "public_document" | "other_public";
    readonly publisherClassification?: "official" | "unofficial";
    readonly version: number;
  } | null;
}

export interface OrganizationRolePage
  extends DirectoryPage<OrganizationRoleEntry> {}

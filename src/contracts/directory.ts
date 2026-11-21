export const DEFAULT_DIRECTORY_PAGE_SIZE = 25;
export const MAX_DIRECTORY_PAGE_SIZE = 100;

export interface DirectoryPageRequest {
  readonly countyFips: string;
  readonly limit?: number;
  /** Opaque only in the sense that callers should pass it back unchanged. */
  readonly afterId?: string | null;
}

export interface DirectoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type OrganizationType =
  | "county_government"
  | "office"
  | "department"
  | "division"
  | "regional"
  | "partner"
  | "other";

export type CountyAffiliationType = "serves" | "partner_for" | "shared_service";

export interface CountyOrganization {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly version: number;
  readonly parentOrganizationId: string | null;
  readonly parentRelationship: "reports_to" | "grouped_under" | null;
  readonly countyAssociation: {
    readonly direct: boolean;
    readonly affiliations: readonly CountyAffiliationType[];
  };
}

export interface CountyRoleEntry {
  readonly person: {
    readonly id: string;
    readonly displayName: string;
    readonly version: number;
  };
  readonly role: {
    readonly id: string;
    readonly version: number;
    readonly startDate: string | null;
    readonly endDate: string | null;
    readonly sourceCheckedAt: string;
    /** Documented text, kept apart from the structured links below. */
    readonly publishedOffice: string | null;
    readonly publishedTitle: string | null;
    readonly inferredTitle?: string;
    readonly jobDescription: string | null;
  };
  /** Null when the role rests on documented text alone. */
  readonly position: {
    readonly id: string;
    readonly title: string;
    readonly version: number;
  } | null;
  /** Null when no organization is resolved for the role. */
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly type: OrganizationType;
    readonly version: number;
    readonly countyAssociation: CountyOrganization["countyAssociation"];
  } | null;
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: "official_page" | "public_document" | "other_public";
    readonly publisherClassification?: "official" | "unofficial";
    readonly version: number;
  } | null;
}

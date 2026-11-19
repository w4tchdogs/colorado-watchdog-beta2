import type {
  CountyAffiliationType,
  DirectoryPage,
  OrganizationType,
} from "./directory.js";

export interface PersonProfilePageRequest {
  readonly personId: string;
  readonly limit?: number;
  readonly afterRoleId?: string | null;
}

export interface PersonProfileCounty {
  readonly fips: string;
  readonly name: string;
  /** True only when the organization row directly names this county. */
  readonly direct: boolean;
  readonly affiliations: readonly {
    id: string;
    relationshipType: CountyAffiliationType;
    version: number;
  }[];
}

export interface PersonProfileRole {
  readonly role: {
    readonly id: string;
    readonly version: number;
    readonly startDate: string | null;
    readonly endDate: string | null;
    readonly sourceCheckedAt: string;
    /** The role's own explicit county, or null for an older role without one. */
    readonly county: { readonly fips: string; readonly name: string } | null;
    /** Documented text, kept apart from the structured links below. */
    readonly publishedOffice: string | null;
    readonly publishedTitle: string | null;
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
    readonly counties: readonly PersonProfileCounty[];
  } | null;
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: "official_page" | "public_document" | "other_public";
    readonly publisherClassification?: "official" | "unofficial";
    readonly version: number;
  };
}

/**
 * A public alternate name. Only a confirmed, explicitly approved name is ever
 * returned. The label is derived from the private name type, which is not
 * exposed, and the sources and dates stay private.
 */
export interface PersonProfileAlternateName {
  readonly name: string;
  readonly label:
    | "Also known as"
    | "Formerly known as"
    | "Professional name"
    | "Published as";
}

export interface PersonProfilePage extends DirectoryPage<PersonProfileRole> {
  readonly person: {
    readonly id: string;
    readonly displayName: string;
    readonly version: number;
    readonly alternateNames: readonly PersonProfileAlternateName[];
  };
}

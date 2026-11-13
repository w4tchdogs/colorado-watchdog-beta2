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
  };
  readonly position: {
    readonly id: string;
    readonly title: string;
    readonly version: number;
  };
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly type: OrganizationType;
    readonly version: number;
    readonly counties: readonly PersonProfileCounty[];
  };
  readonly source: {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: "official_page" | "public_document" | "other_public";
    readonly version: number;
  };
}

export interface PersonProfilePage extends DirectoryPage<PersonProfileRole> {
  readonly person: {
    readonly id: string;
    readonly displayName: string;
    readonly version: number;
  };
}

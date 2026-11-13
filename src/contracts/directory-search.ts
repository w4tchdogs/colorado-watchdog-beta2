import type { DirectoryPage, OrganizationType } from "./directory.js";

export interface DirectorySearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface PersonSearchResult {
  readonly id: string;
  readonly displayName: string;
  readonly version: number;
}

export interface OrganizationSearchResult {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly version: number;
}

export type PersonSearchPage = DirectoryPage<PersonSearchResult>;
export type OrganizationSearchPage = DirectoryPage<OrganizationSearchResult>;

export interface CountyOverviewRequest {
  readonly countyFips: string;
}

export interface CountyOverview {
  readonly county: {
    readonly fips: string;
    readonly name: string;
  };
  readonly organizationCounts: {
    readonly total: number;
    readonly direct: number;
    readonly affiliated: number;
  };
  readonly documentedRoleCount: number;
}

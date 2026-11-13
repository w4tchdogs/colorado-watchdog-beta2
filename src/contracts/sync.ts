import type { CountyAffiliationType, OrganizationType } from "./directory.js";

export const SYNC_CONTRACT_VERSION = "m2-sync/v1" as const;
export const MAX_SYNC_REQUEST_BYTES = 512 * 1024;
export const MAX_SYNC_CHANGES = 200;
export const MAX_SYNC_ITEM_BYTES = 32 * 1024;
export const MAX_SYNC_CITATIONS = 25;
export const MAX_SYNC_DUPLICATE_FLAGS = 20;

export type SyncEntity =
  | "organizations"
  | "organization_county_affiliations"
  | "people"
  | "positions"
  | "role_sources"
  | "person_roles";

export interface CreateOrganization {
  readonly op: "create_organization";
  readonly entity: "organizations";
  readonly clientRef: string;
  readonly fields: {
    readonly name: string;
    readonly organization_type: OrganizationType;
    readonly county_fips?: string | null;
    readonly parent_organization_id?: string | null;
    readonly parent_organization_ref?: string;
    readonly parent_relationship?: "reports_to" | "grouped_under" | null;
  };
}
export interface CreateAffiliation {
  readonly op: "add_county_affiliation";
  readonly entity: "organization_county_affiliations";
  readonly clientRef: string;
  readonly fields: {
    readonly organization_id?: string;
    readonly organization_ref?: string;
    readonly county_fips: string;
    readonly relationship_type: CountyAffiliationType;
  };
}
export interface CreatePerson {
  readonly op: "create_person";
  readonly entity: "people";
  readonly clientRef: string;
  readonly fields: { readonly display_name: string };
}
export interface CreatePosition {
  readonly op: "create_position";
  readonly entity: "positions";
  readonly clientRef: string;
  readonly fields: {
    readonly organization_id?: string;
    readonly organization_ref?: string;
    readonly title: string;
  };
}
export interface CreateRoleSource {
  readonly op: "register_source";
  readonly entity: "role_sources";
  readonly clientRef: string;
  readonly fields: {
    readonly url: string;
    readonly title: string;
    readonly source_type: "official_page" | "public_document" | "other_public";
  };
}
export interface CreatePersonRole {
  readonly op: "create_person_role";
  readonly entity: "person_roles";
  readonly clientRef: string;
  readonly fields: {
    readonly person_id?: string;
    readonly person_ref?: string;
    readonly position_id?: string;
    readonly position_ref?: string;
    readonly source_id?: string;
    readonly source_ref?: string;
    readonly start_date?: string | null;
    readonly end_date?: string | null;
    readonly source_checked_at: string;
  };
}
export interface UpdateRecord {
  readonly op: "update_record";
  readonly entity: SyncEntity;
  readonly targetId: string;
  readonly expectedVersion: number;
  readonly fields: Readonly<Record<string, unknown>>;
}
export type SyncChange =
  | CreateOrganization
  | CreateAffiliation
  | CreatePerson
  | CreatePosition
  | CreateRoleSource
  | CreatePersonRole
  | UpdateRecord;

export interface DuplicateFlagInput {
  readonly targetRef: string;
  readonly possibleDuplicateOf: string;
  readonly category: "possible_match";
  readonly reason: string;
  readonly nonblocking: true;
  readonly evidenceSourceRefs?: readonly string[];
}
export interface SyncChangeSetRequest {
  readonly contractVersion: typeof SYNC_CONTRACT_VERSION;
  readonly requestId: string;
  readonly intent: "dry_run" | "commit";
  readonly changes: readonly SyncChange[];
  readonly duplicateFlags?: readonly DuplicateFlagInput[];
}
export type SyncErrorCode =
  | "invalid_request"
  | "request_too_large"
  | "too_many_changes"
  | "item_too_large"
  | "unsupported_operation"
  | "unsupported_entity"
  | "unsupported_field"
  | "missing_field"
  | "invalid_field"
  | "invalid_enum"
  | "invalid_date"
  | "invalid_timestamp"
  | "future_timestamp"
  | "invalid_url"
  | "unknown_county"
  | "missing_target"
  | "stale_version"
  | "duplicate_target"
  | "duplicate_client_ref"
  | "invalid_reference"
  | "forward_reference"
  | "wrong_entity_reference"
  | "client_ref_in_id_field"
  | "relationship_conflict"
  | "hierarchy_cycle"
  | "hierarchy_too_deep"
  | "hierarchy_county_mismatch"
  | "county_change_splits_hierarchy"
  | "duplicate_affiliation"
  | "duplicate_source_url"
  | "source_metadata_conflict"
  | "source_check_required"
  | "date_order"
  | "too_many_citations"
  | "too_many_duplicate_flags"
  | "duplicate_flag_invalid"
  | "changed_rows_limit"
  | "commit_not_supported";

export interface SyncPlanError {
  readonly code: SyncErrorCode;
  readonly itemIndex?: number;
  readonly clientRef?: string;
  readonly currentVersion?: number;
  readonly message: string;
}
export type PlannedAction =
  | "would_create"
  | "would_update"
  | "would_reuse"
  | "invalid";
export interface PlannedSyncItem {
  readonly itemIndex: number;
  readonly entity: SyncEntity;
  readonly action: PlannedAction;
  readonly clientRef?: string;
  readonly websiteId?: string;
  readonly targetId?: string;
  readonly expectedVersion?: number;
  readonly dependencies: readonly string[];
}
export interface SyncPlan {
  readonly contractVersion: typeof SYNC_CONTRACT_VERSION;
  readonly requestId: string | null;
  readonly eligible: boolean;
  readonly items: readonly PlannedSyncItem[];
  readonly errors: readonly SyncPlanError[];
  readonly duplicateFlags: readonly {
    readonly targetRef: string;
    readonly possibleDuplicateOf: string;
    readonly evidenceSourceRefs?: readonly string[];
  }[];
}

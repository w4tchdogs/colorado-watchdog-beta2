import type { CountyAffiliationType, OrganizationType } from "./directory.js";

export const SYNC_CONTRACT_VERSION = "m2-sync/v1" as const;
export const MAX_SYNC_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_SYNC_ITEM_BYTES = 32 * 1024;
export const MAX_SYNC_DUPLICATE_FLAGS = 20;
/** Diagnostics and error lists stay short and readable. This is an output bound, not an input cap. */
export const MAX_SYNC_DIAGNOSTICS = 200;
/** Largest stored batch result. Matches the sync_batches check from Website migration 0023. */
export const MAX_SYNC_RESULT_BYTES = 1_900_000;
/**
 * There is no cap on the number of changes or citations in a request. The 8 MiB request
 * size and 32 KiB per-change limits bound them, because no change is smaller than 40 bytes.
 * Batches of 10,000 changes fit. This derived figure only guards reads of stored items.
 */
export const MAX_SYNC_ITEMS_BY_SIZE = Math.floor(MAX_SYNC_REQUEST_BYTES / 40);

export type SyncEntity =
  | "organizations"
  | "organization_county_affiliations"
  | "people"
  | "positions"
  | "role_sources"
  | "person_roles";

type ExistingIdOrReference<IdKey extends string, RefKey extends string> =
  | (Readonly<Record<IdKey, string>> & { readonly [Key in RefKey]?: never })
  | (Readonly<Record<RefKey, string>> & { readonly [Key in IdKey]?: never });
type OrganizationParent =
  | Readonly<{
      parent_organization_id?: null;
      parent_organization_ref?: never;
      parent_relationship?: null;
    }>
  | Readonly<{
      parent_organization_id: string;
      parent_organization_ref?: never;
      parent_relationship: "reports_to" | "grouped_under";
    }>
  | Readonly<{
      parent_organization_id?: never;
      parent_organization_ref: string;
      parent_relationship: "reports_to" | "grouped_under";
    }>;

export interface CreateOrganization {
  readonly op: "create_organization";
  readonly entity: "organizations";
  readonly clientRef: string;
  readonly fields: Readonly<{
    name: string;
    organization_type: OrganizationType;
    county_fips?: string | null;
  }> &
    OrganizationParent;
}
export interface CreateAffiliation {
  readonly op: "add_county_affiliation";
  readonly entity: "organization_county_affiliations";
  readonly clientRef: string;
  readonly fields: Readonly<{
    county_fips: string;
    relationship_type: CountyAffiliationType;
  }> &
    ExistingIdOrReference<"organization_id", "organization_ref">;
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
  readonly fields: Readonly<{ title: string }> &
    ExistingIdOrReference<"organization_id", "organization_ref">;
}
export interface CreateRoleSource {
  readonly op: "register_source";
  readonly entity: "role_sources";
  readonly clientRef: string;
  readonly fields: {
    readonly url: string;
    readonly title: string;
    readonly publisher_classification: "official" | "unofficial";
    readonly source_type: "official_page" | "public_document" | "other_public";
  };
}
export interface CreatePersonRole {
  readonly op: "create_person_role";
  readonly entity: "person_roles";
  readonly clientRef: string;
  /**
   * A role needs a person, an explicit county, a citation and at least one
   * documented detail: a structured position link, an office, a title or a
   * job description. Documented text stays separate from structured links.
   */
  readonly fields: Readonly<{
    start_date?: string | null;
    end_date?: string | null;
    source_checked_at?: string | null;
    county_fips: string;
    published_office?: string;
    published_title?: string;
    job_description?: string;
  }> &
    ExistingIdOrReference<"person_id", "person_ref"> &
    Partial<ExistingIdOrReference<"position_id", "position_ref">> &
    ExistingIdOrReference<"source_id", "source_ref">;
}
interface UpdateRecordBase {
  readonly op: "update_record";
  readonly targetId: string;
  readonly expectedVersion: number;
}
export type UpdateRecord =
  | (UpdateRecordBase & {
      readonly entity: "organizations";
      readonly fields: Readonly<{
        name?: string;
        organization_type?: OrganizationType;
        county_fips?: string | null;
        parent_organization_id?: string | null;
        parent_relationship?: "reports_to" | "grouped_under" | null;
      }>;
    })
  | (UpdateRecordBase & {
      readonly entity: "people";
      readonly fields: Readonly<{ display_name?: string }>;
    })
  | (UpdateRecordBase & {
      readonly entity: "positions" | "role_sources";
      readonly fields: Readonly<{ title?: string }>;
    })
  | (UpdateRecordBase & {
      readonly entity: "person_roles";
      readonly fields: Readonly<{
        start_date?: string | null;
        end_date?: string | null;
        source_checked_at?: string | null;
        source_id?: never;
      }>;
    })
  | (UpdateRecordBase & {
      readonly entity: "person_roles";
      readonly fields: Readonly<{
        start_date?: string | null;
        end_date?: string | null;
        source_checked_at?: string | null;
        source_id: string;
      }>;
    });
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
  | "no_changes"
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
  | "role_detail_required"
  | "date_order"
  | "too_many_duplicate_flags"
  | "duplicate_flag_invalid"
  | "commit_not_supported"
  | "invalid_idempotency_key"
  | "idempotency_mismatch"
  | "commit_conflict";

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

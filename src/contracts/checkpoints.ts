// Checkpoint contracts shared by the local producer, verifier and adapters.
// Types and plain constants only: nothing here may import Node modules.

import type { TrustedPrincipal } from "../services/security.js";

export const CHECKPOINT_FORMAT = "colorado-watchdog-checkpoint";
export const CHECKPOINT_FORMAT_VERSION = 1;

export interface CheckpointMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

export interface CheckpointColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: boolean;
  readonly pk: number;
}

export interface CheckpointMember {
  readonly member: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CheckpointTable extends CheckpointMember {
  readonly name: string;
  readonly columns: readonly CheckpointColumn[];
  readonly rows: number;
}

export interface CheckpointFileEntry {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CheckpointManifest {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly format_version: typeof CHECKPOINT_FORMAT_VERSION;
  readonly checkpoint_id: string;
  readonly created_at: string;
  readonly application: { readonly commit: string };
  readonly database: {
    readonly migration_version: number;
    readonly migrations: readonly CheckpointMigrationRecord[];
    readonly schema: CheckpointMember;
    readonly tables: readonly CheckpointTable[];
  };
  readonly files: readonly CheckpointFileEntry[];
  readonly totals: {
    readonly tables: number;
    readonly rows: number;
    readonly files: number;
    readonly file_bytes: number;
  };
}

/** Resource ceilings applied to capture, bundle reading and verification. */
export interface CheckpointLimits {
  readonly maxTables: number;
  readonly maxRows: number;
  readonly maxDatabaseBytes: number;
  readonly maxSchemaBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxManifestBytes: number;
  readonly maxMembers: number;
  readonly maxFailures: number;
}

/** R2-shaped file storage. `revision` is an opaque change token. */
export interface StoredFileInfo {
  readonly key: string;
  readonly size: number;
  readonly revision: string;
}

export interface StoredFile extends StoredFileInfo {
  readonly bytes: Uint8Array;
}

export interface FileStore {
  list(): Promise<StoredFileInfo[]>;
  read(key: string, maxBytes: number): Promise<StoredFile>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface BundleMember {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface BundleEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
}

export interface BundleReader {
  readonly id: string;
  entries(maxEntries: number): Promise<BundleEntry[]>;
  read(path: string, maxBytes: number): Promise<Uint8Array>;
}

/**
 * Checkpoint destination. `put` must publish all-or-nothing, must never
 * replace a published identifier, and requires `manifest.json` as the final
 * member. `prune` exists in the interface but no deletion is authorized.
 */
export interface CheckpointDestination {
  put(id: string, members: AsyncIterable<BundleMember>): Promise<void>;
  list(): Promise<string[]>;
  get(id: string): Promise<BundleReader>;
  prune(): Promise<never>;
}

export interface VerificationFailure {
  readonly code: string;
  readonly subject: string;
  readonly detail: string;
}

export interface VerificationReport {
  readonly format_version: typeof CHECKPOINT_FORMAT_VERSION;
  readonly checkpoint_id: string;
  readonly ok: boolean;
  readonly manifest_sha256: string | null;
  readonly started_at: string;
  readonly finished_at: string;
  readonly restored: {
    readonly tables: number;
    readonly rows: number;
    readonly files: number;
    readonly file_bytes: number;
  };
  readonly failures: readonly VerificationFailure[];
  readonly failures_truncated: boolean;
}

export interface CheckpointRecord {
  readonly id: string;
  readonly operationId: string | null;
  readonly applicationCommit: string;
  readonly migrationVersion: number;
  readonly manifestSha256: string;
  readonly verificationStatus: "pending" | "verified" | "failed";
  readonly verifiedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface ReconciliationResult {
  readonly interruptedOperations: readonly string[];
  readonly adopted: readonly string[];
  readonly untrustedOrphans: readonly { id: string; reason: string }[];
  readonly missingBundles: readonly string[];
}

/**
 * Checkpoint operations for the shared service layer. Every call requires an
 * M0-C trusted principal holding the matching checkpoint capability.
 */
export interface CheckpointService {
  /** Publishes a checkpoint. The result is always unverified ("pending"). */
  create(
    principal: TrustedPrincipal,
    request?: { checkpointId?: string },
  ): Promise<CheckpointRecord>;
  /** Restores the bundle into scratch storage and records the verdict. */
  verify(
    principal: TrustedPrincipal,
    checkpointId: string,
  ): Promise<{ record: CheckpointRecord; report: VerificationReport }>;
  list(principal: TrustedPrincipal): CheckpointRecord[];
  read(
    principal: TrustedPrincipal,
    checkpointId: string,
  ): { record: CheckpointRecord; verification: unknown };
  /** Recovers from interruptions. Never deletes and never trusts by default. */
  reconcile(principal: TrustedPrincipal): Promise<ReconciliationResult>;
  /** Always refuses. No retention or deletion policy is authorized. */
  prune(principal: TrustedPrincipal): Promise<never>;
}

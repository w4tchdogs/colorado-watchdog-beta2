import type {
  BundleReader,
  CheckpointDestination,
  CheckpointLimits,
  CheckpointMigrationRecord,
  CheckpointRecord,
  CheckpointService,
  FileStore,
  VerificationReport,
} from "../../contracts/checkpoints.js";
import type { WebsiteDatabase } from "../../database/sqlite.js";
import { updateVersionedRow } from "../../database/versioned-writes.js";
import { runAuditedMutation } from "../../services/audit.js";
import { createOperation } from "../../services/operations.js";
import {
  requireCapability,
  type TrustedPrincipal,
} from "../../services/security.js";
import {
  assertApplicationCommit,
  assertCheckpointId,
  CheckpointError,
  newCheckpointId,
} from "./core.js";
import {
  type PreparedCheckpoint,
  prepareCheckpoint,
  publishPreparedCheckpoint,
} from "./producer.js";
import {
  type VerificationOutcome,
  verifyCheckpointBundle,
} from "./verifier.js";

export interface CheckpointServiceDependencies {
  readonly database: WebsiteDatabase;
  readonly fileStore: FileStore;
  readonly destination: CheckpointDestination;
  readonly applicationCommit: string;
  readonly knownMigrations?: readonly CheckpointMigrationRecord[];
  readonly scratchRoot?: string;
  readonly limits?: Partial<CheckpointLimits>;
  readonly openScratchDatabase?: () => Promise<WebsiteDatabase>;
  readonly now?: () => Date;
}

const CREATE_KIND = "checkpoint.create";
const VERIFY_KIND = "checkpoint.verify";
const RECORD_COLUMNS =
  "id, operation_id, application_commit, migration_version, manifest_sha256, verification_status, verified_at, version, created_at";

type Progress = Record<string, string | number | null>;

/**
 * Checkpoint lifecycle over the accepted `operations` and `checkpoints`
 * tables.
 *
 *   operation running  -> capturing -> publishing (manifest digest recorded)
 *   bundle published   -> checkpoints row inserted as "pending"
 *   restore verified   -> "verified" (with verified_at) or "failed"
 *
 * Every entrypoint takes the M0-C `TrustedPrincipal` and checks its capability
 * against the database. State changes and their audit events share one
 * transaction through `runAuditedMutation`.
 *
 * A `checkpoints` row exists only for a published bundle. File publication
 * and the database row cannot be one atomic step, so the digest recorded on
 * the operation before publication lets `reconcile` identify a published but
 * unrecorded bundle without trusting the directory's mere existence.
 */
export function createCheckpointService(
  dependencies: CheckpointServiceDependencies,
): CheckpointService {
  const { database, fileStore, destination } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const active = new Set<string>();
  assertApplicationCommit(dependencies.applicationCommit);

  const timestamp = () => now().toISOString();

  const findRecord = (id: string): CheckpointRecord | undefined => {
    const row = database
      .prepare(`SELECT ${RECORD_COLUMNS} FROM checkpoints WHERE id = ?`)
      .get(id);
    return row ? toRecord(row) : undefined;
  };

  const requireRecord = (id: string): CheckpointRecord => {
    assertCheckpointId(id);
    const record = findRecord(id);
    if (!record) {
      throw new CheckpointError(
        "checkpoint_not_found",
        "No recorded checkpoint has this identifier",
        { subject: id },
      );
    }
    return record;
  };

  const startOperation = (
    kind: string,
    principal: TrustedPrincipal,
    progress: Progress,
  ): string => {
    // M0-C creates and audits the operation; it is then marked running.
    const id = createOperation(database, principal, kind);
    updateOperation(id, {
      status: "running",
      started_at: timestamp(),
      progress_json: JSON.stringify(progress),
    });
    active.add(id);
    return id;
  };

  const updateOperation = (
    id: string,
    changes: Record<string, string | null>,
  ): void => {
    const row = database
      .prepare("SELECT version FROM operations WHERE id = ?")
      .get(id);
    updateVersionedRow(
      database,
      "operations",
      id,
      Number(row?.version),
      changes,
    );
  };

  const finishOperation = (
    id: string,
    status: "succeeded" | "failed",
    progress: Progress,
    errorCode: string | null,
  ): void => {
    updateOperation(id, {
      status,
      progress_json: JSON.stringify(progress),
      error_code: errorCode,
      finished_at: timestamp(),
    });
  };

  /** Marks an operation failed without masking the original error. */
  const failOperation = (id: string, code: string, progress: Progress) => {
    try {
      finishOperation(id, "failed", progress, code);
    } catch {
      // The operation stays "running"; reconcile() marks it interrupted.
    } finally {
      active.delete(id);
    }
  };

  const insertCheckpoint = (
    prepared: Pick<PreparedCheckpoint, "manifest" | "manifestJson"> & {
      manifestSha256: string;
    },
    operationId: string,
    verification: VerificationReport | null,
  ): void => {
    database
      .prepare(
        "INSERT INTO checkpoints (id, operation_id, application_commit, migration_version, manifest_json, manifest_sha256, verification_status, verification_json, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        prepared.manifest.checkpoint_id,
        operationId,
        prepared.manifest.application.commit,
        prepared.manifest.database.migration_version,
        prepared.manifestJson,
        prepared.manifestSha256,
        verification ? "verified" : "pending",
        JSON.stringify(verification ?? {}),
        verification ? verification.finished_at : null,
      );
  };

  const runVerifier = async (
    id: string,
    expectedManifestSha256: string,
  ): Promise<VerificationOutcome> => {
    let reader: BundleReader;
    try {
      reader = await destination.get(id);
    } catch (error) {
      if (
        error instanceof CheckpointError &&
        error.code === "checkpoint_not_found"
      ) {
        // A bundle that is absent cannot be restored: that is a verdict.
        return {
          report: missingBundleReport(id, now()),
          manifest: null,
          manifestJson: null,
        };
      }
      throw error;
    }
    return verifyCheckpointBundle(reader, {
      expectedManifestSha256,
      knownMigrations: dependencies.knownMigrations,
      scratchRoot: dependencies.scratchRoot,
      limits: dependencies.limits,
      openScratchDatabase: dependencies.openScratchDatabase,
    });
  };

  return {
    async create(principal, request = {}) {
      requireCapability(database, principal, "checkpoint.create");
      const id = request.checkpointId ?? newCheckpointId(now());
      assertCheckpointId(id);
      if (findRecord(id) || (await destination.list()).includes(id)) {
        throw new CheckpointError(
          "duplicate_checkpoint",
          "A checkpoint with this identifier already exists",
          { subject: id },
        );
      }

      const progress: Progress = { checkpoint_id: id, phase: "capturing" };
      const operationId = startOperation(CREATE_KIND, principal, progress);
      let prepared: PreparedCheckpoint;
      try {
        prepared = await prepareCheckpoint(database, fileStore, {
          checkpointId: id,
          applicationCommit: dependencies.applicationCommit,
          createdAt: now(),
          limits: dependencies.limits,
        });
        // Recorded before publication: the anchor reconcile() relies on.
        progress.phase = "publishing";
        progress.manifest_sha256 = prepared.manifestSha256;
        updateOperation(operationId, {
          progress_json: JSON.stringify(progress),
        });
        await publishPreparedCheckpoint(prepared, fileStore, destination);
      } catch (error) {
        failOperation(operationId, errorCode(error, "production_failed"), {
          ...progress,
          phase: "failed_before_publication",
        });
        throw error;
      }

      try {
        runAuditedMutation(
          database,
          { principal, operationId },
          {
            action: "checkpoint.created",
            targetType: "checkpoint",
            targetId: id,
            summary: `Checkpoint ${id} published. Restore verification pending.`,
            details: {
              manifest_sha256: prepared.manifestSha256,
              verification_status: "pending",
              tables: prepared.manifest.totals.tables,
              rows: prepared.manifest.totals.rows,
              files: prepared.manifest.totals.files,
            },
          },
          () => {
            insertCheckpoint(prepared, operationId, null);
            finishOperation(
              operationId,
              "succeeded",
              { ...progress, phase: "published", verification: "pending" },
              null,
            );
          },
        );
      } catch {
        failOperation(operationId, "record_failed", {
          ...progress,
          phase: "published_unrecorded",
        });
        throw new CheckpointError(
          "record_failed",
          "The bundle was published but could not be recorded; run reconcile",
          { subject: id },
        );
      }
      active.delete(operationId);
      return requireRecord(id);
    },

    async verify(principal, checkpointId) {
      requireCapability(database, principal, "checkpoint.verify");
      const before = requireRecord(checkpointId);
      const progress: Progress = { checkpoint_id: checkpointId };
      const operationId = startOperation(VERIFY_KIND, principal, {
        ...progress,
        phase: "restoring",
      });

      let outcome: VerificationOutcome;
      try {
        outcome = await runVerifier(checkpointId, before.manifestSha256);
      } catch (error) {
        // No verdict was reached, so the checkpoint row is left untouched.
        failOperation(
          operationId,
          errorCode(error, "verification_interrupted"),
          { ...progress, phase: "interrupted" },
        );
        throw error;
      }

      const { report } = outcome;
      const status = report.ok ? "verified" : "failed";
      try {
        runAuditedMutation(
          database,
          { principal, operationId },
          {
            action: report.ok
              ? "checkpoint.verified"
              : "checkpoint.verification_failed",
            targetType: "checkpoint",
            targetId: checkpointId,
            summary: report.ok
              ? `Checkpoint ${checkpointId} restored and matched its manifest.`
              : `Checkpoint ${checkpointId} failed restore verification.`,
            details: {
              verification_status: status,
              failures: report.failures.length,
              first_failure: report.failures[0]?.code ?? null,
            },
          },
          () => {
            updateVersionedRow(
              database,
              "checkpoints",
              checkpointId,
              before.version,
              {
                verification_status: status,
                verification_json: JSON.stringify(report),
                verified_at: report.ok ? report.finished_at : null,
              },
            );
            finishOperation(
              operationId,
              report.ok ? "succeeded" : "failed",
              { ...progress, phase: "recorded", verification: status },
              report.ok ? null : "verification_failed",
            );
          },
        );
      } catch (error) {
        failOperation(operationId, errorCode(error, "record_failed"), {
          ...progress,
          phase: "verdict_unrecorded",
        });
        throw error;
      }
      active.delete(operationId);
      return { record: requireRecord(checkpointId), report };
    },

    list(principal) {
      requireCapability(database, principal, "checkpoint.read");
      return database
        .prepare(
          `SELECT ${RECORD_COLUMNS} FROM checkpoints ORDER BY created_at, id`,
        )
        .all()
        .map(toRecord);
    },

    read(principal, checkpointId) {
      requireCapability(database, principal, "checkpoint.read");
      const record = requireRecord(checkpointId);
      const row = database
        .prepare("SELECT verification_json FROM checkpoints WHERE id = ?")
        .get(checkpointId);
      return {
        record,
        verification: JSON.parse(String(row?.verification_json)),
      };
    },

    async reconcile(principal) {
      requireCapability(database, principal, "checkpoint.create");
      requireCapability(database, principal, "checkpoint.verify");

      const interrupted: string[] = [];
      const running = database
        .prepare(
          "SELECT id, progress_json FROM operations WHERE status IN ('pending', 'running') AND kind IN (?, ?) ORDER BY id",
        )
        .all(CREATE_KIND, VERIFY_KIND);
      for (const row of running) {
        const id = String(row.id);
        if (!active.has(id)) {
          finishOperation(
            id,
            "failed",
            parseProgress(row.progress_json),
            "interrupted",
          );
          interrupted.push(id);
        }
      }

      const published = await destination.list();
      const recorded = new Set(
        database
          .prepare("SELECT id FROM checkpoints")
          .all()
          .map((row) => String(row.id)),
      );
      const adopted: string[] = [];
      const untrusted: { id: string; reason: string }[] = [];
      for (const id of published) {
        if (recorded.has(id)) {
          continue;
        }
        const anchor = findAnchor(database, id);
        if (!anchor) {
          untrusted.push({ id, reason: "no_operation_record" });
          continue;
        }
        if (active.has(anchor.operationId)) {
          continue;
        }
        const { report, manifest, manifestJson } = await runVerifier(
          id,
          anchor.manifestSha256,
        );
        if (!report.ok || !manifest || manifestJson === null) {
          untrusted.push({
            id,
            reason: report.failures[0]?.code ?? "verification_failed",
          });
          continue;
        }
        runAuditedMutation(
          database,
          { principal, operationId: anchor.operationId },
          {
            action: "checkpoint.reconciled",
            targetType: "checkpoint",
            targetId: id,
            summary: `Unrecorded checkpoint ${id} matched its operation record, passed restore verification and was recorded.`,
            details: {
              manifest_sha256: anchor.manifestSha256,
              verification_status: "verified",
            },
          },
          () =>
            insertCheckpoint(
              { manifest, manifestJson, manifestSha256: anchor.manifestSha256 },
              anchor.operationId,
              report,
            ),
        );
        adopted.push(id);
      }

      const available = new Set(published);
      return {
        interruptedOperations: interrupted,
        adopted,
        untrustedOrphans: untrusted,
        missingBundles: [...recorded].filter((id) => !available.has(id)).sort(),
      };
    },

    async prune() {
      // Pruning is disabled unconditionally and takes no principal. M0-C also
      // denies checkpoint.prune to every role, so there is nothing to authorize.
      return destination.prune();
    },
  };
}

function missingBundleReport(id: string, at: Date): VerificationReport {
  const time = at.toISOString();
  return {
    format_version: 1,
    checkpoint_id: id,
    ok: false,
    manifest_sha256: null,
    started_at: time,
    finished_at: time,
    restored: { tables: 0, rows: 0, files: 0, file_bytes: 0 },
    failures: [
      {
        code: "bundle_missing",
        subject: id,
        detail: "The published bundle is not present at the destination",
      },
    ],
    failures_truncated: false,
  };
}

function toRecord(row: Record<string, unknown>): CheckpointRecord {
  return {
    id: String(row.id),
    operationId: row.operation_id === null ? null : String(row.operation_id),
    applicationCommit: String(row.application_commit),
    migrationVersion: Number(row.migration_version),
    manifestSha256: String(row.manifest_sha256),
    verificationStatus: row.verification_status as
      | "pending"
      | "verified"
      | "failed",
    verifiedAt: row.verified_at === null ? null : String(row.verified_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
}

function parseProgress(value: unknown): Progress {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Progress)
      : {};
  } catch {
    return {};
  }
}

/** Finds the create operation that recorded this bundle's manifest digest. */
function findAnchor(
  database: WebsiteDatabase,
  checkpointId: string,
): { operationId: string; manifestSha256: string } | undefined {
  const rows = database
    .prepare(
      "SELECT id, progress_json FROM operations WHERE kind = ? AND status IN ('running', 'failed') ORDER BY created_at DESC, id",
    )
    .all(CREATE_KIND);
  for (const row of rows) {
    const progress = parseProgress(row.progress_json);
    if (
      progress.checkpoint_id === checkpointId &&
      typeof progress.manifest_sha256 === "string"
    ) {
      return {
        operationId: String(row.id),
        manifestSha256: progress.manifest_sha256,
      };
    }
  }
  return undefined;
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof CheckpointError ? error.code : fallback;
}

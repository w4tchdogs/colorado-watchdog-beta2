import type {
  BannerMetadata,
  BannerStageProposal,
  Banners1SourceVersion,
  BannerVersion,
  ResolvedBanner,
} from "../contracts/banner-assets.js";
import type { WebsiteDatabase } from "../database/sqlite.js";
import { insertAuditEvent, runAuditedMutation } from "./audit.js";
import { type ImmutableObjectStorage, sha256Hex } from "./banner-storage.js";
import { hasCapability, type TrustedPrincipal } from "./security.js";

export class BannerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BannerConflictError";
  }
}

export class BannerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BannerValidationError";
  }
}

function authorized(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
): void {
  if (!hasCapability(database, principal, "banner.manage"))
    throw new Error("Banner mutation is not authorized");
}

function validText(value: string, name: string, limit: number): void {
  if (typeof value !== "string" || value.length > limit || value.includes("\0"))
    throw new BannerValidationError(`Invalid ${name}`);
}

function validateProposal(input: BannerStageProposal): void {
  validText(input.bannerId, "banner ID", 128);
  validText(input.sourceFilename, "source filename", 512);
  if (
    input.sourceFilename.startsWith("/") ||
    input.sourceFilename.startsWith("\\") ||
    /^[A-Za-z]:/.test(input.sourceFilename) ||
    input.sourceFilename.split(/[\\/]/).includes("..")
  )
    throw new BannerValidationError(
      "Source filename must be relative to the approved collection",
    );
  validText(input.caption, "caption", 500);
  validText(input.altText, "alt text", 1_000);
  if (!/^08\d{3}$/.test(input.countyFips))
    throw new BannerValidationError("County FIPS must be five Colorado digits");
  if (!input.bytes.length || input.bytes.length > 25 * 1024 * 1024)
    throw new BannerValidationError("Image must be between 1 byte and 25 MiB");
  if (
    !Number.isInteger(input.width) ||
    input.width < 1 ||
    !Number.isInteger(input.height) ||
    input.height < 1
  )
    throw new BannerValidationError(
      "Image dimensions must be positive integers",
    );
  if (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)
    throw new BannerValidationError(
      "Display order must be a nonnegative integer",
    );
  if (
    ![input.focalX, input.focalY].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
  )
    throw new BannerValidationError(
      "Focal coordinates must be between zero and one",
    );
  if (input.displayMode !== "cover" && input.displayMode !== "contain")
    throw new BannerValidationError("Unsupported display mode");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
    throw new BannerValidationError("Invalid idempotency key");
  if (!input.expectedSha256 || !/^[0-9a-f]{64}$/.test(input.expectedSha256))
    throw new BannerValidationError(
      "A full-decode BANNERS-1 source digest is required",
    );
  if (
    input.sourceVersionNumber !== undefined &&
    (!Number.isInteger(input.sourceVersionNumber) ||
      input.sourceVersionNumber < 1)
  )
    throw new BannerValidationError("Invalid source version number");
  if (
    input.sourceHistory &&
    input.sourceHistory.some(
      (item) =>
        !Number.isInteger(item.version) ||
        item.version < 1 ||
        !/^[0-9a-f]{64}$/.test(item.sha256) ||
        !item.filename.trim() ||
        item.filename.length > 512 ||
        item.filename.startsWith("/") ||
        item.filename.startsWith("\\") ||
        /^[A-Za-z]:/.test(item.filename) ||
        item.filename.split(/[\\/]/).includes("..") ||
        !Number.isInteger(item.width) ||
        item.width < 1 ||
        !Number.isInteger(item.height) ||
        item.height < 1 ||
        !Number.isInteger(item.sizeBytes) ||
        item.sizeBytes < 1 ||
        !["jpeg", "png"].includes(item.format) ||
        item.validation !== "full_decode_passed" ||
        (item.status !== undefined && item.status.length > 50),
    )
  )
    throw new BannerValidationError("Source image-version lineage is invalid");
  const jpeg =
    input.bytes[0] === 0xff &&
    input.bytes[1] === 0xd8 &&
    input.bytes[2] === 0xff;
  const png =
    input.bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, i) => input.bytes[i] === value,
    );
  if (!jpeg && !png)
    throw new BannerValidationError(
      "Only validated JPEG and PNG inputs are supported",
    );
}

function mapBanner(row: Record<string, unknown>): BannerMetadata {
  return {
    id: String(row.id),
    countyFips: String(row.county_fips),
    sourceFilename: String(row.source_filename),
    caption: String(row.caption),
    altText: String(row.alt_text),
    displayOrder: Number(row.display_order),
    isPrimary: Number(row.is_primary) === 1,
    displayMode: row.display_mode as BannerMetadata["displayMode"],
    focalX: Number(row.focal_x),
    focalY: Number(row.focal_y),
    status: row.status as BannerMetadata["status"],
    selectedVersionId:
      typeof row.selected_version_id === "string"
        ? row.selected_version_id
        : null,
    version: Number(row.version),
  };
}

function mergeSourceHistory(
  storedJson: unknown,
  incoming: readonly Banners1SourceVersion[],
): readonly Banners1SourceVersion[] {
  if (typeof storedJson !== "string")
    throw new BannerConflictError(
      "Stored BANNERS-1 source history is malformed",
    );
  let prior: unknown;
  try {
    prior = JSON.parse(storedJson);
  } catch {
    throw new BannerConflictError(
      "Stored BANNERS-1 source history is malformed",
    );
  }
  if (!Array.isArray(prior))
    throw new BannerConflictError(
      "Stored BANNERS-1 source history is malformed",
    );
  const byNumber = new Map<number, Banners1SourceVersion>();
  for (const raw of prior) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !Number.isInteger((raw as Banners1SourceVersion).version) ||
      typeof (raw as Banners1SourceVersion).sha256 !== "string"
    )
      throw new BannerConflictError(
        "Stored BANNERS-1 source history is malformed",
      );
    const item = raw as Banners1SourceVersion;
    byNumber.set(item.version, item);
  }
  for (const item of incoming) {
    const old = byNumber.get(item.version);
    if (old && old.sha256 !== item.sha256)
      throw new BannerConflictError(
        "BANNERS-1 source lineage conflicts with retained history",
      );
    byNumber.set(item.version, item);
  }
  return [...byNumber.values()].sort(
    (left, right) => left.version - right.version,
  );
}

/** Internal BANNERS-2 service. No route is registered by this milestone. */
export class BannerAssetService {
  constructor(
    private readonly database: WebsiteDatabase,
    private readonly storage: ImmutableObjectStorage,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async stage(
    input: BannerStageProposal,
    principal: TrustedPrincipal,
  ): Promise<{
    banner: BannerMetadata;
    version: BannerVersion;
    skipped: boolean;
  }> {
    authorized(this.database, principal);
    validateProposal(input);
    const digest = await sha256Hex(input.bytes);
    if (input.expectedSha256 !== digest)
      throw new BannerValidationError(
        "Source bytes do not match the BANNERS-1 manifest digest",
      );
    const requestFingerprint = await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify({ ...input, bytes: undefined, digest }),
      ),
    );
    const priorOperation = this.database
      .prepare(
        "SELECT * FROM banner_stage_operations WHERE idempotency_key = ?",
      )
      .get(input.idempotencyKey);
    let retryOperation = false;
    if (priorOperation) {
      if (priorOperation.request_sha256 !== requestFingerprint)
        throw new BannerConflictError(
          "Idempotency key was already used for a different request",
        );
      const saved = this.getVersion(String(priorOperation.version_id));
      const banner = this.getBanner(String(priorOperation.banner_id));
      if (!saved || !banner)
        throw new BannerConflictError(
          "Saved stage operation is incomplete and needs reconciliation",
        );
      if (saved.state === "verified")
        return { banner, version: saved, skipped: true };
      if (
        [
          "pending",
          "staging",
          "staged",
          "failed",
          "interrupted",
          "ready_for_retry",
        ].includes(String(priorOperation.state))
      )
        retryOperation = true;
      else
        throw new BannerConflictError(
          "Stage operation is not retryable and needs reconciliation",
        );
    }
    const existing = this.getBanner(input.bannerId);
    if (existing && input.expectedRowVersion === undefined && !retryOperation)
      throw new BannerConflictError(
        "Updating an existing banner requires its expected row version",
      );
    if (
      existing &&
      (existing.countyFips !== input.countyFips ||
        (input.expectedRowVersion !== undefined &&
          existing.version !== input.expectedRowVersion))
    )
      throw new BannerConflictError(
        "Banner county or expected row version conflicts with current metadata",
      );
    const duplicateAcrossBanners = this.database
      .prepare(
        "SELECT banner_id FROM banner_asset_versions WHERE sha256 = ? AND banner_id <> ? LIMIT 1",
      )
      .get(digest, input.bannerId);
    if (duplicateAcrossBanners)
      throw new BannerConflictError(
        "Image digest is already assigned to another logical banner; association requires review",
      );
    const same = retryOperation
      ? undefined
      : this.database
          .prepare(
            "SELECT * FROM banner_asset_versions WHERE banner_id = ? AND sha256 = ?",
          )
          .get(input.bannerId, digest);
    if (same) {
      const version = this.getVersion(String(same.id));
      if (version?.state === "verified") {
        this.database
          .prepare(`INSERT INTO banner_stage_operations
            (id, banner_id, version_id, idempotency_key, request_sha256, state, created_by_account_id)
            VALUES (?, ?, ?, ?, ?, 'verified', ?)`)
          .run(
            this.newId(),
            input.bannerId,
            version.id,
            input.idempotencyKey,
            requestFingerprint,
            principal.accountId,
          );
        return {
          banner: existing ?? this.getBanner(input.bannerId)!,
          version,
          skipped: true,
        };
      }
      throw new BannerConflictError(
        "Matching image version exists but is not verified; reconcile before retrying",
      );
    }
    const versionId = retryOperation
      ? String(priorOperation?.version_id)
      : this.newId();
    const operationId = retryOperation
      ? String(priorOperation?.id)
      : this.newId();
    const objectKey = retryOperation
      ? String(
          this.database
            .prepare(
              "SELECT object_key FROM banner_asset_versions WHERE id = ?",
            )
            .get(versionId)?.object_key,
        )
      : `banner-assets/${versionId}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(versionId))
      throw new BannerValidationError(
        "Generated image-version ID is not safe for an immutable key",
      );
    const mediaType = input.bytes[0] === 0xff ? "image/jpeg" : "image/png";
    const previous = existing?.selectedVersionId ?? null;
    const transaction = this.database.transaction(() => {
      const current = this.getBanner(input.bannerId);
      if (
        current &&
        input.expectedRowVersion !== undefined &&
        current.version !== input.expectedRowVersion
      )
        throw new BannerConflictError("Stale banner row version");
      if (!current) {
        this.database
          .prepare(`INSERT INTO banner_assets (id, county_fips, source_filename, caption, alt_text, source_history_json, display_order, is_primary, display_mode, focal_x, focal_y, status, created_by_account_id, updated_by_account_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
          .run(
            input.bannerId,
            input.countyFips,
            input.sourceFilename,
            input.caption,
            input.altText,
            JSON.stringify(input.sourceHistory ?? []),
            input.displayOrder,
            input.isPrimary ? 1 : 0,
            input.displayMode,
            input.focalX,
            input.focalY,
            principal.accountId,
            principal.accountId,
          );
      }
      if (current && input.sourceHistory) {
        const storedHistory = this.database
          .prepare("SELECT source_history_json FROM banner_assets WHERE id = ?")
          .get(input.bannerId)?.source_history_json;
        const mergedHistory = mergeSourceHistory(
          storedHistory,
          input.sourceHistory,
        );
        const result = this.database.prepare(
          "UPDATE banner_assets SET source_filename = ?, source_history_json = ?, version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ? AND version = ?",
        );
        result.run(
          input.sourceFilename,
          JSON.stringify(mergedHistory),
          principal.accountId,
          this.now(),
          input.bannerId,
          current.version,
        );
      }
      if (!retryOperation)
        this.database
          .prepare(`INSERT INTO banner_asset_versions (id, banner_id, previous_version_id, source_filename, sha256, source_version_number, width, height, aspect_ratio, byte_size, media_type, object_key, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(
            versionId,
            input.bannerId,
            previous,
            input.sourceFilename,
            digest,
            input.sourceVersionNumber ?? null,
            input.width,
            input.height,
            input.width / input.height,
            input.bytes.byteLength,
            mediaType,
            objectKey,
          );
      if (!retryOperation)
        this.database
          .prepare(`INSERT INTO banner_stage_operations (id, banner_id, version_id, idempotency_key, request_sha256, state, created_by_account_id)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
          .run(
            operationId,
            input.bannerId,
            versionId,
            input.idempotencyKey,
            requestFingerprint,
            principal.accountId,
          );
      if (!retryOperation)
        insertAuditEvent(
          this.database,
          { principal },
          {
            action: "banner.stage.started",
            targetType: "banner",
            targetId: input.bannerId,
            summary: "Banner image staging started",
            details: { versionId, sha256: digest },
          },
        );
    });
    if (retryOperation) {
      this.database
        .prepare(
          "UPDATE banner_stage_operations SET state = 'staging', error_code = NULL, updated_at = ? WHERE id = ?",
        )
        .run(this.now(), operationId);
      this.database
        .prepare(
          "UPDATE banner_asset_versions SET state = 'staging' WHERE id = ? AND state <> 'verified'",
        )
        .run(versionId);
    } else transaction();

    this.database
      .prepare(
        "UPDATE banner_stage_operations SET state = 'staging', updated_at = ? WHERE id = ?",
      )
      .run(this.now(), operationId);
    this.database
      .prepare(
        "UPDATE banner_asset_versions SET state = 'staging' WHERE id = ?",
      )
      .run(versionId);
    try {
      const result = await this.storage.putIfAbsent(objectKey, input.bytes, {
        sha256: digest,
        mediaType,
        versionId,
      });
      this.database
        .prepare(
          "UPDATE banner_asset_versions SET state = 'staged' WHERE id = ? AND state = 'staging'",
        )
        .run(versionId);
      this.database
        .prepare(
          "UPDATE banner_stage_operations SET state = 'staged', updated_at = ? WHERE id = ? AND state = 'staging'",
        )
        .run(this.now(), operationId);
      const stored = await this.storage.get(objectKey);
      if (
        !stored ||
        stored.byteSize !== input.bytes.byteLength ||
        stored.body.byteLength !== input.bytes.byteLength ||
        (await sha256Hex(stored.body)) !== digest ||
        stored.metadata.sha256 !== digest ||
        stored.metadata.versionId !== versionId
      )
        throw new BannerConflictError(
          "Stored object is missing or failed full-byte integrity verification",
        );
      const verifiedAt = this.now();
      const commit = this.database.transaction(() => {
        this.database
          .prepare(
            "UPDATE banner_asset_versions SET state = 'verified', verification_json = ?, verified_at = ? WHERE id = ? AND state IN ('staging', 'staged')",
          )
          .run(
            JSON.stringify({
              algorithm: "SHA-256",
              sha256: digest,
              byteSize: stored.byteSize,
              storageOutcome: result,
            }),
            verifiedAt,
            versionId,
          );
        this.database
          .prepare(
            "UPDATE banner_stage_operations SET state = 'verified', updated_at = ?, error_code = NULL WHERE id = ?",
          )
          .run(verifiedAt, operationId);
        insertAuditEvent(
          this.database,
          { principal },
          {
            action: "banner.stage.verified",
            targetType: "banner",
            targetId: input.bannerId,
            summary: "Banner image bytes verified",
            details: { versionId, sha256: digest, byteSize: stored.byteSize },
          },
        );
      });
      commit();
    } catch (error) {
      const failedAt = this.now();
      const recordFailure = this.database.transaction(() => {
        this.database
          .prepare(
            "UPDATE banner_stage_operations SET state = 'interrupted', error_code = 'storage_verification_failed', updated_at = ? WHERE id = ?",
          )
          .run(failedAt, operationId);
        this.database
          .prepare(
            "UPDATE banner_asset_versions SET state = 'failed' WHERE id = ?",
          )
          .run(versionId);
        insertAuditEvent(
          this.database,
          { principal },
          {
            action: "banner.stage.interrupted",
            targetType: "banner",
            targetId: input.bannerId,
            summary: "Banner staging requires retry or review",
            details: { versionId, failureCode: "storage_verification_failed" },
          },
        );
      });
      recordFailure();
      throw error;
    }
    return {
      banner: this.getBanner(input.bannerId)!,
      version: this.getVersion(versionId)!,
      skipped: false,
    };
  }

  activate(
    bannerId: string,
    versionId: string,
    expectedVersion: number,
    principal: TrustedPrincipal,
  ): BannerMetadata {
    authorized(this.database, principal);
    const banner = this.getBanner(bannerId);
    const version = this.getVersion(versionId);
    if (
      !banner ||
      !version ||
      version.bannerId !== bannerId ||
      version.state !== "verified"
    )
      throw new BannerConflictError(
        "Only a verified version belonging to this banner can be selected",
      );
    if (banner.version !== expectedVersion)
      throw new BannerConflictError("Stale banner row version");
    const at = this.now();
    return runAuditedMutation(
      this.database,
      { principal },
      {
        action: "banner.version.activated",
        targetType: "banner",
        targetId: bannerId,
        summary: "Verified banner version selected",
        details: { versionId },
      },
      () => {
        const result = this.database
          .prepare(
            "UPDATE banner_assets SET selected_version_id = ?, status = 'active', version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ? AND version = ?",
          )
          .run(versionId, principal.accountId, at, bannerId, expectedVersion);
        if (result === undefined) {
          /* local Statement.run returns void; row count checked below */
        }
        const selected = this.getBanner(bannerId)!;
        this.database
          .prepare(
            "UPDATE banner_stage_operations SET state = 'activated', updated_at = ? WHERE version_id = ?",
          )
          .run(at, versionId);
        return selected;
      },
    );
  }

  withdraw(
    bannerId: string,
    expectedVersion: number,
    principal: TrustedPrincipal,
  ): BannerMetadata {
    return this.changeStatus(bannerId, "withdrawn", expectedVersion, principal);
  }

  async restore(
    bannerId: string,
    versionId: string,
    expectedVersion: number,
    principal: TrustedPrincipal,
  ): Promise<BannerMetadata> {
    authorized(this.database, principal);
    const version = this.getVersion(versionId);
    if (
      !version ||
      version.bannerId !== bannerId ||
      version.state !== "verified"
    )
      throw new BannerConflictError(
        "Retained version is not verified for this banner",
      );
    const stored = await this.storage.get(version.objectKey);
    if (
      !stored ||
      stored.byteSize !== version.byteSize ||
      (await sha256Hex(stored.body)) !== version.sha256
    )
      throw new BannerConflictError(
        "Retained version object is missing or failed integrity verification",
      );
    return this.changeSelection(
      bannerId,
      versionId,
      expectedVersion,
      principal,
      "banner.version.restored",
      "Retained banner version restored",
    );
  }

  updateMetadata(
    bannerId: string,
    expectedVersion: number,
    change: Partial<
      Pick<
        BannerStageProposal,
        | "caption"
        | "altText"
        | "displayOrder"
        | "isPrimary"
        | "displayMode"
        | "focalX"
        | "focalY"
      >
    >,
    principal: TrustedPrincipal,
  ): BannerMetadata {
    authorized(this.database, principal);
    const current = this.getBanner(bannerId);
    if (!current || current.version !== expectedVersion)
      throw new BannerConflictError("Stale banner row version");
    if (change.caption !== undefined) validText(change.caption, "caption", 500);
    if (change.altText !== undefined)
      validText(change.altText, "alt text", 1_000);
    if (
      change.displayOrder !== undefined &&
      (!Number.isInteger(change.displayOrder) || change.displayOrder < 0)
    )
      throw new BannerValidationError("Invalid display order");
    if (
      change.displayMode !== undefined &&
      !["cover", "contain"].includes(change.displayMode)
    )
      throw new BannerValidationError("Invalid display mode");
    for (const focal of [change.focalX, change.focalY])
      if (
        focal !== undefined &&
        (!Number.isFinite(focal) || focal < 0 || focal > 1)
      )
        throw new BannerValidationError(
          "Focal coordinates must be between zero and one",
        );
    const fields: Record<string, string> = {
      caption: "caption",
      altText: "alt_text",
      displayOrder: "display_order",
      isPrimary: "is_primary",
      displayMode: "display_mode",
      focalX: "focal_x",
      focalY: "focal_y",
    };
    const set = Object.entries(change).filter(([key]) => key in fields);
    if (set.length === 0) return current;
    const assignments = set.map(([key]) => `${fields[key]} = ?`).join(", ");
    const values = set.map(([key, value]) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
    return runAuditedMutation(
      this.database,
      { principal },
      {
        action: "banner.metadata.updated",
        targetType: "banner",
        targetId: bannerId,
        summary: "Banner metadata updated",
      },
      () => {
        if (change.isPrimary === true) {
          const prior = this.database
            .prepare(
              "SELECT id FROM banner_assets WHERE county_fips = ? AND is_primary = 1 AND id <> ?",
            )
            .all(current.countyFips, bannerId);
          for (const row of prior)
            this.database
              .prepare(
                "UPDATE banner_assets SET is_primary = 0, version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ?",
              )
              .run(principal.accountId, this.now(), String(row.id));
        }
        this.database
          .prepare(
            `UPDATE banner_assets SET ${assignments}, version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ? AND version = ?`,
          )
          .run(
            ...values,
            principal.accountId,
            this.now(),
            bannerId,
            expectedVersion,
          );
        return this.getBanner(bannerId)!;
      },
    );
  }

  reorderCounty(
    countyFips: string,
    orderedBannerIds: readonly string[],
    expectedVersions: Readonly<Record<string, number>>,
    principal: TrustedPrincipal,
  ): void {
    authorized(this.database, principal);
    const current = this.database
      .prepare(
        "SELECT id, version, display_order FROM banner_assets WHERE county_fips = ? ORDER BY display_order, id",
      )
      .all(countyFips);
    const currentIds = current.map((row) => String(row.id));
    if (
      orderedBannerIds.length !== currentIds.length ||
      new Set(orderedBannerIds).size !== currentIds.length ||
      orderedBannerIds.some((id) => !currentIds.includes(id))
    )
      throw new BannerConflictError(
        "Reordering must include each county banner exactly once",
      );
    for (const row of current)
      if (expectedVersions[String(row.id)] !== Number(row.version))
        throw new BannerConflictError("Stale banner row version");
    runAuditedMutation(
      this.database,
      { principal },
      {
        action: "banner.order.updated",
        targetType: "county",
        targetId: countyFips,
        summary: "County banner order updated",
        details: { count: orderedBannerIds.length },
      },
      () => {
        const base =
          Math.max(-1, ...current.map((row) => Number(row.display_order))) +
          current.length +
          1;
        orderedBannerIds.forEach((id, index) => {
          this.database
            .prepare(
              "UPDATE banner_assets SET display_order = ?, version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ?",
            )
            .run(base + index, principal.accountId, this.now(), id);
        });
        orderedBannerIds.forEach((id, index) => {
          this.database
            .prepare(
              "UPDATE banner_assets SET display_order = ?, version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ?",
            )
            .run(index, principal.accountId, this.now(), id);
        });
      },
    );
  }

  async resolveCounty(countyFips: string): Promise<readonly ResolvedBanner[]> {
    const rows = this.database
      .prepare(
        `SELECT b.*, v.id AS version_id, v.width, v.height, v.object_key FROM banner_assets b JOIN banner_asset_versions v ON v.id = b.selected_version_id WHERE b.county_fips = ? AND b.status = 'active' AND v.state = 'verified' ORDER BY b.display_order, b.id`,
      )
      .all(countyFips);
    const resolved = [];
    for (const row of rows) {
      const version = this.getVersion(String(row.version_id));
      if (!version) continue;
      const stored = await this.storage.get(version.objectKey);
      if (
        !stored ||
        stored.byteSize !== version.byteSize ||
        (await sha256Hex(stored.body)) !== version.sha256
      )
        continue;
      resolved.push({
        bannerId: String(row.id),
        countyFips: String(row.county_fips),
        versionId: String(row.version_id),
        assetRef: String(row.object_key),
        caption: String(row.caption),
        altText: String(row.alt_text),
        displayMode: row.display_mode as ResolvedBanner["displayMode"],
        focalX: Number(row.focal_x),
        focalY: Number(row.focal_y),
        displayOrder: Number(row.display_order),
        isPrimary: Number(row.is_primary) === 1,
        width: Number(row.width),
        height: Number(row.height),
      });
    }
    return resolved;
  }

  async reconcile(): Promise<
    readonly { readonly versionId: string; readonly classification: string }[]
  > {
    const versions = this.database
      .prepare("SELECT * FROM banner_asset_versions ORDER BY created_at, id")
      .all();
    const reports = [];
    for (const row of versions) {
      const objectKey = String(row.object_key);
      const stored = await this.storage.get(objectKey);
      if (!stored)
        reports.push({
          versionId: String(row.id),
          classification:
            row.state === "verified"
              ? "verified_object_missing"
              : "staging_object_missing",
        });
      else if (
        stored.byteSize !== Number(row.byte_size) ||
        (await sha256Hex(stored.body)) !== row.sha256
      )
        reports.push({
          versionId: String(row.id),
          classification: "stored_object_integrity_failed",
        });
      else if (row.state !== "verified")
        reports.push({
          versionId: String(row.id),
          classification: "object_present_unverified_database_state",
        });
      else
        reports.push({
          versionId: String(row.id),
          classification: "verified_unchanged",
        });
    }
    for (const key of await this.storage.listKeys("banner-assets/")) {
      const known = this.database
        .prepare("SELECT id FROM banner_asset_versions WHERE object_key = ?")
        .get(key);
      if (!known)
        reports.push({
          versionId: "",
          classification: `orphaned_object:${key}`,
        });
    }
    return reports;
  }

  getBanner(id: string): BannerMetadata | undefined {
    const row = this.database
      .prepare("SELECT * FROM banner_assets WHERE id = ?")
      .get(id);
    return row ? mapBanner(row) : undefined;
  }

  getVersion(id: string): BannerVersion | undefined {
    const row = this.database
      .prepare("SELECT * FROM banner_asset_versions WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      bannerId: String(row.banner_id),
      previousVersionId:
        typeof row.previous_version_id === "string"
          ? row.previous_version_id
          : null,
      sourceFilename: String(row.source_filename),
      sha256: String(row.sha256),
      width: Number(row.width),
      height: Number(row.height),
      aspectRatio: Number(row.aspect_ratio),
      byteSize: Number(row.byte_size),
      mediaType: row.media_type as BannerVersion["mediaType"],
      objectKey: String(row.object_key),
      state: row.state as BannerVersion["state"],
    };
  }

  private changeStatus(
    id: string,
    status: "active" | "withdrawn",
    expected: number,
    principal: TrustedPrincipal,
  ): BannerMetadata {
    authorized(this.database, principal);
    const current = this.getBanner(id);
    if (!current || current.version !== expected)
      throw new BannerConflictError("Stale banner row version");
    if (status === "active" && !current.selectedVersionId)
      throw new BannerConflictError(
        "Cannot activate a banner without a selected verified version",
      );
    return runAuditedMutation(
      this.database,
      { principal },
      {
        action: status === "withdrawn" ? "banner.withdrawn" : "banner.restored",
        targetType: "banner",
        targetId: id,
        summary:
          status === "withdrawn" ? "Banner withdrawn" : "Banner restored",
      },
      () => {
        this.database
          .prepare(
            "UPDATE banner_assets SET status = ?, version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ? AND version = ?",
          )
          .run(status, principal.accountId, this.now(), id, expected);
        return this.getBanner(id)!;
      },
    );
  }

  private changeSelection(
    id: string,
    versionId: string,
    expected: number,
    principal: TrustedPrincipal,
    action: string,
    summary: string,
  ): BannerMetadata {
    const version = this.getVersion(versionId);
    if (!version || version.state !== "verified")
      throw new BannerConflictError("Selected version is not verified");
    const key = this.database
      .prepare("SELECT id FROM banner_asset_versions WHERE id = ?")
      .get(versionId);
    if (!key) throw new BannerConflictError("Selected version is missing");
    return runAuditedMutation(
      this.database,
      { principal },
      {
        action,
        targetType: "banner",
        targetId: id,
        summary,
        details: { versionId },
      },
      () => {
        this.database
          .prepare(
            "UPDATE banner_assets SET selected_version_id = ?, status = 'active', version = version + 1, updated_by_account_id = ?, updated_at = ? WHERE id = ? AND version = ?",
          )
          .run(versionId, principal.accountId, this.now(), id, expected);
        return this.getBanner(id)!;
      },
    );
  }
}

/** BANNERS-1 manifests are translated only when source identity and facts are explicit. */
export function translateBanners1Record(
  record: Record<string, unknown>,
): Omit<BannerStageProposal, "bytes" | "idempotencyKey"> {
  const source = record.source;
  if (!source || typeof source !== "object")
    throw new BannerValidationError("BANNERS-1 source record is missing");
  const facts = source as Record<string, unknown>;
  if (
    record.sourceMissing === true ||
    facts.validation !== "full_decode_passed"
  )
    throw new BannerValidationError(
      "Missing or unvalidated source cannot be staged",
    );
  if (
    typeof record.bannerId !== "string" ||
    typeof record.countyFips !== "string" ||
    !/^08\d{3}$/.test(record.countyFips)
  )
    throw new BannerValidationError(
      "Manifest identity or county association is invalid",
    );
  if (
    typeof facts.filename !== "string" ||
    typeof facts.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(facts.sha256) ||
    !["jpeg", "png"].includes(String(facts.format)) ||
    typeof facts.sizeBytes !== "number" ||
    facts.sizeBytes < 1
  )
    throw new BannerValidationError(
      "Manifest source filename or digest is invalid",
    );
  if (
    ![facts.width, facts.height].every(
      (value) => Number.isInteger(value) && Number(value) > 0,
    )
  )
    throw new BannerValidationError("Manifest image dimensions are invalid");
  if (
    typeof record.caption !== "string" ||
    typeof record.altText !== "string" ||
    !Number.isInteger(record.displayOrder)
  )
    throw new BannerValidationError("Manifest metadata is incomplete");
  const displayMode = record.displayMode;
  if (displayMode !== "cover" && displayMode !== "contain")
    throw new BannerValidationError("Manifest display mode is invalid");
  const sourceVersionNumber = record.currentVersion;
  if (!Number.isInteger(sourceVersionNumber) || Number(sourceVersionNumber) < 1)
    throw new BannerValidationError(
      "Manifest source version number is invalid",
    );
  const sourceHistory: Banners1SourceVersion[] = [];
  const historyNumbers = new Set<number>();
  if (record.versions !== undefined && !Array.isArray(record.versions))
    throw new BannerValidationError(
      "Manifest version history must be an array",
    );
  for (const item of (record.versions ?? []) as unknown[]) {
    if (!item || typeof item !== "object")
      throw new BannerValidationError(
        "Manifest version history entry is malformed",
      );
    const version = item as Record<string, unknown>;
    if (
      !Number.isInteger(version.version) ||
      typeof version.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(version.sha256) ||
      typeof version.filename !== "string" ||
      typeof version.width !== "number" ||
      typeof version.height !== "number" ||
      !["jpeg", "png"].includes(String(version.format)) ||
      typeof version.sizeBytes !== "number" ||
      version.validation !== "full_decode_passed"
    )
      throw new BannerValidationError(
        "Manifest version history entry is incomplete",
      );
    if (historyNumbers.has(Number(version.version)))
      throw new BannerValidationError(
        "Manifest version history contains duplicate version numbers",
      );
    historyNumbers.add(Number(version.version));
    sourceHistory.push({
      version: Number(version.version),
      sha256: version.sha256,
      filename: version.filename,
      width: version.width,
      height: version.height,
      format: version.format as Banners1SourceVersion["format"],
      sizeBytes: version.sizeBytes,
      validation: "full_decode_passed",
      ...(typeof version.status === "string" ? { status: version.status } : {}),
    });
  }
  if (!sourceHistory.some((item) => item.sha256 === facts.sha256))
    sourceHistory.push({
      version: Number(sourceVersionNumber),
      sha256: facts.sha256,
      filename: facts.filename,
      width: Number(facts.width),
      height: Number(facts.height),
      format: facts.format as Banners1SourceVersion["format"],
      sizeBytes: Number(facts.sizeBytes),
      validation: "full_decode_passed",
    });
  return {
    bannerId: record.bannerId,
    countyFips: record.countyFips,
    sourceFilename: facts.filename,
    caption: record.caption,
    altText: record.altText,
    displayOrder: Number(record.displayOrder),
    isPrimary: record.isPrimary === true,
    displayMode,
    focalX: Number(record.focalX),
    focalY: Number(record.focalY),
    width: Number(facts.width),
    height: Number(facts.height),
    expectedSha256: facts.sha256,
    sourceVersionNumber: Number(sourceVersionNumber),
    sourceHistory,
  };
}

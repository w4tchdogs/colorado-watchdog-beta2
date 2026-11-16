import type {
  BannerAdminBanner,
  BannerAdministration,
  BannerAdminVersion,
  BannerChangeResult,
  BannerMetadataChange,
  BannerPublicationRecord,
  BannerReconciliationClass,
  BannerReconciliationItem,
  BannerStageRequest,
  BannerStageResult,
  CountyBannerDetail,
  CountyBannerPage,
  ListCountiesRequest,
  PublicationMetadata,
  PublicationOrigin,
  PublishRequest,
  ReorderCountyRequest,
  ReorderCountyResult,
  RestoreRequest,
  UpdateMetadataRequest,
  WithdrawRequest,
} from "../contracts/banner-administration.js";
import {
  BANNER_ADMIN_LIMITS,
  BANNER_PUBLICATION_LIST_LIMIT,
} from "../contracts/banner-administration.js";
import type {
  BannerAssetStatus,
  BannerDisplayMode,
  BannerMediaType,
  BannerStageState,
  BannerVersionState,
} from "../contracts/banner-assets.js";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import { assertCredentialFree } from "./audit.js";
import {
  BannerConflictError,
  BannerValidationError,
  validText,
} from "./banner-assets.js";
import {
  type BannerImageInspection,
  inspectBannerImage,
} from "./banner-image-inspector.js";
import { type ImmutableObjectStorage, sha256Hex } from "./banner-storage.js";
import {
  AuthorizationError,
  newId,
  roleHasCapability,
  type TrustedPrincipal,
} from "./security.js";

/** Object storage or the final database write failed. The operation can be retried. */
export class BannerStageError extends Error {
  constructor(
    readonly code: "storage_failed" | "finalize_failed",
    message: string,
  ) {
    super(message);
    this.name = "BannerStageError";
  }
}

/** The version has no recorded publication, so the caller must supply the text. */
export class BannerSnapshotRequiredError extends BannerConflictError {
  constructor() {
    super(
      "This version has no recorded publication. Supply explicit caption, alt text, display mode and focal point to restore it",
    );
    this.name = "BannerSnapshotRequiredError";
  }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const RETRYABLE_VERSION = ["pending", "staging", "failed"];
const RETRYABLE_OPERATION = [
  "pending",
  "staging",
  "failed",
  "interrupted",
  "ready_for_retry",
];
const BANNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_ATTEMPTS = 3;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("Invalid banner record");
  return value;
}
function optStr(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid banner record");
  return value;
}
function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid banner record");
  return value;
}
function optNum(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : num(row, key);
}

function mapVersion(row: Row, selectedId: string | null): BannerAdminVersion {
  const id = str(row, "id");
  return {
    id,
    previousVersionId: optStr(row, "previous_version_id"),
    sourceFilename: str(row, "source_filename"),
    sha256: str(row, "sha256"),
    width: num(row, "width"),
    height: num(row, "height"),
    byteSize: num(row, "byte_size"),
    mediaType: str(row, "media_type") as BannerMediaType,
    state: str(row, "state") as BannerVersionState,
    createdAt: str(row, "created_at"),
    verifiedAt: optStr(row, "verified_at"),
    stagedByAccountId: optStr(row, "staged_by"),
    operationState: optStr(row, "op_state") as BannerStageState | null,
    isSelected: id === selectedId,
  };
}

function mapPublication(row: Row): BannerPublicationRecord {
  return {
    id: str(row, "id"),
    versionId: str(row, "version_id"),
    sequence: num(row, "sequence"),
    origin: str(row, "origin") as PublicationOrigin,
    restoredFromPublicationId: optStr(row, "restored_from_publication_id"),
    caption: str(row, "caption"),
    altText: str(row, "alt_text"),
    displayMode: str(row, "display_mode") as BannerDisplayMode,
    focalX: num(row, "focal_x"),
    focalY: num(row, "focal_y"),
    bannerRowVersion: num(row, "banner_row_version"),
    publishedByAccountId: str(row, "published_by_account_id"),
    publishedAt: str(row, "published_at"),
  };
}

function validateSnapshot(metadata: PublicationMetadata): void {
  validText(metadata.caption, "caption", 500);
  validText(metadata.altText, "alt text", 1_000);
  if (metadata.altText.trim() === "")
    throw new BannerValidationError("Alt text must not be blank");
  if (!["cover", "contain"].includes(metadata.displayMode))
    throw new BannerValidationError("Invalid display mode");
  for (const focal of [metadata.focalX, metadata.focalY])
    if (!Number.isFinite(focal) || focal < 0 || focal > 1)
      throw new BannerValidationError(
        "Focal coordinates must be between zero and one",
      );
}

const CHANGE_FIELDS = [
  "caption",
  "altText",
  "displayOrder",
  "homepageOrder",
  "isPrimary",
  "displayMode",
  "focalX",
  "focalY",
];

/** Copies only known fields. Unknown fields are refused, not ignored. */
function validateChange(input: BannerMetadataChange): BannerMetadataChange {
  if (!input || typeof input !== "object")
    throw new BannerValidationError("Invalid metadata change");
  const keys = Object.keys(input).filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  );
  if (keys.length === 0)
    throw new BannerValidationError("No metadata change supplied");
  const unknown = keys.find((key) => !CHANGE_FIELDS.includes(key));
  if (unknown) throw new BannerValidationError("Unknown metadata field");
  const change = input;
  if (change.caption !== undefined) validText(change.caption, "caption", 500);
  if (change.altText !== undefined)
    validText(change.altText, "alt text", 1_000);
  if (
    change.displayOrder !== undefined &&
    (!Number.isInteger(change.displayOrder) || change.displayOrder < 0)
  )
    throw new BannerValidationError("Invalid display order");
  if (
    change.homepageOrder !== undefined &&
    change.homepageOrder !== null &&
    (!Number.isInteger(change.homepageOrder) || change.homepageOrder < 0)
  )
    throw new BannerValidationError("Invalid homepage order");
  if (change.isPrimary !== undefined && typeof change.isPrimary !== "boolean")
    throw new BannerValidationError("Invalid primary flag");
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
  return change;
}

/** Stable JSON with sorted keys, so a request fingerprint ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function likePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class D1BannerAdministration implements BannerAdministration {
  constructor(
    private readonly database: AsyncD1Database,
    private readonly storage: ImmutableObjectStorage,
    private readonly newIdentifier: () => string = newId,
  ) {}

  // ---------------------------------------------------------------- authority

  /** Capability from the claimed role, then the live account and identity rows. */
  private async authorize(principal: TrustedPrincipal): Promise<void> {
    if (!roleHasCapability(principal.role, "banner.manage"))
      throw new AuthorizationError();
    const live = await this.database.first(
      `SELECT 1 AS ok FROM identities i JOIN accounts a ON a.id = i.account_id
       WHERE a.id = ? AND i.id = ? AND i.provider = ? AND a.kind = ? AND a.role = ?
         AND a.status = 'active' AND i.revoked_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at > ${NOW})`,
      [
        principal.accountId,
        principal.identityId,
        principal.provider,
        principal.kind,
        principal.role,
      ],
    );
    if (!live) throw new AuthorizationError();
  }

  /**
   * Runs one atomic guarded batch. Authority is rechecked before every attempt,
   * and the batch itself reasserts the principal and dependency generation, so a
   * revoked account cannot finish a write that was already in flight. A stale
   * generation from an unrelated write is retried with a fresh generation.
   */
  private async guarded(
    principal: TrustedPrincipal,
    build: () => D1BatchStatement[],
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await this.authorize(principal);
      const generation = await this.database.readDependencyGeneration();
      try {
        await this.database.guardedBatch(generation, principal, build());
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  private audit(
    principal: TrustedPrincipal,
    action: string,
    bannerId: string,
    summary: string,
    details: Record<string, string>,
    targetType: "banner" | "county" = "banner",
  ): D1BatchStatement {
    assertCredentialFree({
      action,
      targetType,
      targetId: bannerId,
      summary,
      details,
    });
    return this.database.prepare(
      `INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        this.newIdentifier(),
        principal.accountId,
        action,
        targetType,
        bannerId,
        summary,
        JSON.stringify(details),
      ],
    );
  }

  private assertion(condition: string, values: (string | number)[]) {
    return this.database.prepare(
      `INSERT INTO website_write_assertions (id, valid)
       SELECT ?, CASE WHEN ${condition} THEN 1 ELSE 0 END`,
      [this.newIdentifier(), ...values],
    );
  }

  private changed() {
    return this.database.prepare(
      "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes())",
      [this.newIdentifier()],
    );
  }

  // -------------------------------------------------------------------- reads

  async listCounties(
    principal: TrustedPrincipal,
    request: ListCountiesRequest = {},
  ): Promise<CountyBannerPage> {
    await this.authorize(principal);
    const limit = request.limit ?? BANNER_ADMIN_LIMITS.countyPageDefault;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > BANNER_ADMIN_LIMITS.countyPageMax
    )
      throw new BannerValidationError("Invalid county page size");
    const query = request.query?.trim() ?? "";
    if (query.length > 50 || [...query].some((c) => c.charCodeAt(0) < 32))
      throw new BannerValidationError("Invalid county search");
    if (request.afterFips !== undefined && !/^08\d{3}$/.test(request.afterFips))
      throw new BannerValidationError("Invalid county cursor");
    const rows = await this.database.all<Row>(
      `SELECT c.fips AS fips, c.name AS name,
         (SELECT COUNT(*) FROM banner_assets b WHERE b.county_fips = c.fips) AS banner_count,
         (SELECT COUNT(*) FROM banner_assets b JOIN banner_asset_versions v ON v.id = b.selected_version_id
            WHERE b.county_fips = c.fips AND b.status = 'active' AND v.state = 'verified') AS public_count,
         (SELECT COUNT(*) FROM banner_assets b JOIN banner_asset_versions v ON v.banner_id = b.id
            WHERE b.county_fips = c.fips AND v.state IN ('pending','staging','failed')) AS attention_count
       FROM counties c
       WHERE (? = '' OR c.fips > ?)
         AND (? = '' OR c.fips LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')
       ORDER BY c.fips`,
      limit + 1,
      [
        request.afterFips ?? "",
        request.afterFips ?? "",
        query,
        `${likePattern(query)}%`,
        `%${likePattern(query)}%`,
      ],
    );
    const page = rows.slice(0, limit).map((row) => ({
      fips: str(row, "fips"),
      name: str(row, "name"),
      bannerCount: num(row, "banner_count"),
      publicBannerCount: num(row, "public_count"),
      attentionVersionCount: num(row, "attention_count"),
    }));
    const last = page[page.length - 1];
    return {
      counties: page,
      ...(rows.length > limit && last ? { nextAfterFips: last.fips } : {}),
    };
  }

  async getCounty(
    principal: TrustedPrincipal,
    countyFips: string,
  ): Promise<CountyBannerDetail | null> {
    await this.authorize(principal);
    if (!/^08\d{3}$/.test(countyFips))
      throw new BannerValidationError(
        "County FIPS must be five Colorado digits",
      );
    const county = await this.database.first<Row>(
      "SELECT fips, name FROM counties WHERE fips = ?",
      [countyFips],
    );
    if (!county) return null;
    const bannerRows = await this.database.all<Row>(
      "SELECT * FROM banner_assets WHERE county_fips = ? ORDER BY display_order, id",
      BANNER_ADMIN_LIMITS.bannersPerCounty + 1,
      [countyFips],
    );
    const shown = bannerRows.slice(0, BANNER_ADMIN_LIMITS.bannersPerCounty);
    const versionRows = shown.length
      ? await this.database.all<Row>(
          `SELECT * FROM (
             SELECT v.*,
               ROW_NUMBER() OVER (PARTITION BY v.banner_id ORDER BY v.created_at DESC, v.id DESC) AS rn,
               COUNT(*) OVER (PARTITION BY v.banner_id) AS total,
               EXISTS (SELECT 1 FROM banner_assets b WHERE b.id = v.banner_id AND b.selected_version_id = v.id) AS is_selected,
               (SELECT o.created_by_account_id FROM banner_stage_operations o WHERE o.version_id = v.id ORDER BY o.created_at, o.id LIMIT 1) AS staged_by,
               (SELECT o.state FROM banner_stage_operations o WHERE o.version_id = v.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS op_state
             FROM banner_asset_versions v
             WHERE v.banner_id IN (${shown.map(() => "?").join(",")})
           ) WHERE rn <= ? OR is_selected = 1
           ORDER BY banner_id, rn`,
          BANNER_ADMIN_LIMITS.bannersPerCounty *
            (BANNER_ADMIN_LIMITS.versionsPerBanner + 1),
          [
            ...shown.map((row) => str(row, "id")),
            BANNER_ADMIN_LIMITS.versionsPerBanner,
          ],
        )
      : [];
    const banners: BannerAdminBanner[] = shown.map((row) => {
      const id = str(row, "id");
      const selected = optStr(row, "selected_version_id");
      const mine = versionRows.filter((v) => str(v, "banner_id") === id);
      const versions = mine.map((v) => mapVersion(v, selected));
      const total = mine[0] ? num(mine[0], "total") : 0;
      const status = str(row, "status") as BannerAssetStatus;
      return {
        id,
        countyFips: str(row, "county_fips"),
        sourceFilename: str(row, "source_filename"),
        caption: str(row, "caption"),
        altText: str(row, "alt_text"),
        displayOrder: num(row, "display_order"),
        homepageOrder: optNum(row, "homepage_order"),
        isPrimary: num(row, "is_primary") === 1,
        displayMode: str(row, "display_mode") as BannerDisplayMode,
        focalX: num(row, "focal_x"),
        focalY: num(row, "focal_y"),
        status,
        selectedVersionId: selected,
        rowVersion: num(row, "version"),
        updatedAt: str(row, "updated_at"),
        publicEligible:
          status === "active" &&
          versions.some((v) => v.isSelected && v.state === "verified"),
        versions,
        versionCount: total,
        versionsTruncated: total > versions.length,
      };
    });
    return {
      county: { fips: str(county, "fips"), name: str(county, "name") },
      banners,
      bannersTruncated: bannerRows.length > shown.length,
    };
  }

  async reconcileBanner(
    principal: TrustedPrincipal,
    bannerId: string,
  ): Promise<readonly BannerReconciliationItem[]> {
    await this.authorize(principal);
    if (!BANNER_ID.test(bannerId))
      throw new BannerValidationError("Invalid banner ID");
    const rows = await this.database.all<Row>(
      "SELECT id, state, sha256, byte_size, object_key FROM banner_asset_versions WHERE banner_id = ? ORDER BY created_at DESC, id DESC",
      BANNER_ADMIN_LIMITS.versionsPerBanner,
      [bannerId],
    );
    const items: BannerReconciliationItem[] = [];
    for (const row of rows) {
      const state = str(row, "state") as BannerVersionState;
      const stored = await this.storage.get(str(row, "object_key"));
      let classification: BannerReconciliationClass;
      if (!stored)
        classification =
          state === "verified"
            ? "verified_object_missing"
            : "staging_object_missing";
      else if (
        stored.byteSize !== num(row, "byte_size") ||
        (await sha256Hex(stored.body)) !== str(row, "sha256")
      )
        classification = "stored_object_integrity_failed";
      else if (state !== "verified")
        classification = "object_present_unverified_database_state";
      else classification = "verified_unchanged";
      items.push({ versionId: str(row, "id"), state, classification });
    }
    return items;
  }

  // ------------------------------------------------------------------ staging

  private validate(request: BannerStageRequest): void {
    if (!BANNER_ID.test(request.bannerId))
      throw new BannerValidationError("Invalid banner ID");
    if (!/^08\d{3}$/.test(request.countyFips))
      throw new BannerValidationError(
        "County FIPS must be five Colorado digits",
      );
    validText(request.sourceFilename, "source filename", 512);
    if (
      !request.sourceFilename.trim() ||
      request.sourceFilename.startsWith("/") ||
      request.sourceFilename.startsWith("\\") ||
      /^[A-Za-z]:/.test(request.sourceFilename) ||
      request.sourceFilename.split(/[\\/]/).includes("..")
    )
      throw new BannerValidationError(
        "Source filename must be relative to the approved collection",
      );
    if (
      typeof request.idempotencyKey !== "string" ||
      !request.idempotencyKey.trim() ||
      request.idempotencyKey.length > 200
    )
      throw new BannerValidationError("Invalid idempotency key");
    if (
      request.expectedSha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(request.expectedSha256)
    )
      throw new BannerValidationError("Invalid expected digest");
    const target = request.target;
    if (target.kind === "existing") {
      if (
        !Number.isInteger(target.expectedRowVersion) ||
        target.expectedRowVersion < 1
      )
        throw new BannerValidationError("Invalid expected row version");
      return;
    }
    if (target.kind !== "new")
      throw new BannerValidationError("Invalid stage target");
    const m = target.metadata;
    validText(m.caption, "caption", 500);
    validText(m.altText, "alt text", 1_000);
    if (!m.altText.trim())
      throw new BannerValidationError("Alt text is required for a new banner");
    if (!Number.isInteger(m.displayOrder) || m.displayOrder < 0)
      throw new BannerValidationError(
        "Display order must be a nonnegative integer",
      );
    if (
      m.homepageOrder !== undefined &&
      m.homepageOrder !== null &&
      (!Number.isInteger(m.homepageOrder) || m.homepageOrder < 0)
    )
      throw new BannerValidationError("Invalid homepage order");
    if (
      ![m.focalX, m.focalY].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    )
      throw new BannerValidationError(
        "Focal coordinates must be between zero and one",
      );
    if (m.displayMode !== "cover" && m.displayMode !== "contain")
      throw new BannerValidationError("Unsupported display mode");
    if (typeof m.isPrimary !== "boolean")
      throw new BannerValidationError("Invalid primary flag");
  }

  async stage(
    principal: TrustedPrincipal,
    request: BannerStageRequest,
  ): Promise<BannerStageResult> {
    await this.authorize(principal);
    this.validate(request);
    // Limits are checked before decoding. Dimensions and digest come from the bytes.
    const image = await inspectBannerImage(request.bytes);
    if (request.expectedSha256 && request.expectedSha256 !== image.sha256)
      throw new BannerValidationError(
        "Supplied digest does not match the image bytes",
      );
    const fingerprint = await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify({
          actor: principal.accountId,
          bannerId: request.bannerId,
          countyFips: request.countyFips,
          sourceFilename: request.sourceFilename,
          target: request.target,
          sha256: image.sha256,
        }),
      ),
    );
    const county = await this.database.first(
      "SELECT 1 AS ok FROM counties WHERE fips = ?",
      [request.countyFips],
    );
    if (!county) throw new BannerValidationError("Unknown county");

    let operation = await this.database.first<Row>(
      "SELECT * FROM banner_stage_operations WHERE idempotency_key = ?",
      [request.idempotencyKey],
    );
    if (!operation) {
      try {
        operation = await this.begin(principal, request, image, fingerprint);
      } catch (error) {
        // A concurrent request with the same key may have won the insert.
        operation = await this.database.first<Row>(
          "SELECT * FROM banner_stage_operations WHERE idempotency_key = ?",
          [request.idempotencyKey],
        );
        if (!operation) throw error;
      }
    }
    return this.continueOperation(
      principal,
      request,
      image,
      fingerprint,
      operation,
    );
  }

  /** Creates the pending rows atomically, or reuses a version with the same digest. */
  private async begin(
    principal: TrustedPrincipal,
    request: BannerStageRequest,
    image: BannerImageInspection,
    fingerprint: string,
  ): Promise<Row> {
    const banner = await this.database.first<Row>(
      "SELECT id, county_fips, version FROM banner_assets WHERE id = ?",
      [request.bannerId],
    );
    const target = request.target;
    if (target.kind === "new" && banner)
      throw new BannerConflictError(
        "Banner already exists. Stage a new version of it instead",
      );
    if (target.kind === "existing") {
      if (!banner) throw new BannerConflictError("Banner does not exist");
      if (str(banner, "county_fips") !== request.countyFips)
        throw new BannerConflictError("Banner belongs to a different county");
      if (num(banner, "version") !== target.expectedRowVersion)
        throw new BannerConflictError("Stale banner row version");
    }
    if (target.kind === "new") {
      const taken = await this.database.first(
        "SELECT 1 AS ok FROM banner_assets WHERE county_fips = ? AND display_order = ?",
        [request.countyFips, target.metadata.displayOrder],
      );
      if (taken)
        throw new BannerConflictError(
          "Another banner in this county already uses that display order",
        );
      if (target.metadata.isPrimary) {
        const primary = await this.database.first(
          "SELECT 1 AS ok FROM banner_assets WHERE county_fips = ? AND is_primary = 1",
          [request.countyFips],
        );
        if (primary)
          throw new BannerConflictError(
            "This county already has a primary banner",
          );
      }
    }
    const elsewhere = await this.database.first(
      "SELECT banner_id FROM banner_asset_versions WHERE sha256 = ? AND banner_id <> ? LIMIT 1",
      [image.sha256, request.bannerId],
    );
    if (elsewhere)
      throw new BannerConflictError(
        "Image digest is already assigned to another logical banner. Association needs review",
      );
    const same = await this.database.first<Row>(
      "SELECT * FROM banner_asset_versions WHERE banner_id = ? AND sha256 = ?",
      [request.bannerId, image.sha256],
    );
    const operationId = this.newIdentifier();
    const guardExisting = (): D1BatchStatement[] =>
      target.kind === "existing"
        ? [
            this.assertion(
              "EXISTS (SELECT 1 FROM banner_assets WHERE id = ? AND county_fips = ? AND version = ?)",
              [request.bannerId, request.countyFips, target.expectedRowVersion],
            ),
          ]
        : [];

    if (same) {
      const state = str(same, "state");
      if (state !== "verified" && state !== "staged")
        throw new BannerConflictError(
          "A matching image version exists but is not verified. Reconcile before retrying",
        );
      await this.guarded(principal, () => [
        ...guardExisting(),
        this.database.prepare(
          `INSERT INTO banner_stage_operations (id, banner_id, version_id, idempotency_key, request_sha256, state, created_by_account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            request.bannerId,
            str(same, "id"),
            request.idempotencyKey,
            fingerprint,
            state,
            principal.accountId,
          ],
        ),
        this.audit(
          principal,
          "banner.stage.reused",
          request.bannerId,
          "Existing banner image version reused",
          {
            versionId: str(same, "id"),
            sha256: image.sha256,
          },
        ),
      ]);
      return this.operationRow(operationId);
    }

    const versionId = this.newIdentifier();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(versionId))
      throw new BannerValidationError(
        "Generated image-version ID is not safe for an immutable key",
      );
    await this.guarded(principal, () => [
      ...guardExisting(),
      this.assertion(
        "NOT EXISTS (SELECT 1 FROM banner_asset_versions WHERE sha256 = ? AND banner_id <> ?)",
        [image.sha256, request.bannerId],
      ),
      ...(target.kind === "new"
        ? [
            this.database.prepare(
              `INSERT INTO banner_assets (id, county_fips, source_filename, caption, alt_text, source_history_json,
                 display_order, is_primary, display_mode, focal_x, focal_y, homepage_order, status,
                 created_by_account_id, updated_by_account_id)
               VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
              [
                request.bannerId,
                request.countyFips,
                request.sourceFilename,
                target.metadata.caption,
                target.metadata.altText,
                target.metadata.displayOrder,
                target.metadata.isPrimary ? 1 : 0,
                target.metadata.displayMode,
                target.metadata.focalX,
                target.metadata.focalY,
                target.metadata.homepageOrder ?? null,
                principal.accountId,
                principal.accountId,
              ],
            ),
          ]
        : []),
      this.database.prepare(
        `INSERT INTO banner_asset_versions (id, banner_id, previous_version_id, source_filename, sha256,
           width, height, aspect_ratio, byte_size, media_type, object_key, state)
         VALUES (?, ?, (SELECT selected_version_id FROM banner_assets WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          versionId,
          request.bannerId,
          request.bannerId,
          request.sourceFilename,
          image.sha256,
          image.width,
          image.height,
          image.width / image.height,
          image.byteSize,
          image.mediaType,
          `banner-assets/${versionId}`,
        ],
      ),
      this.database.prepare(
        `INSERT INTO banner_stage_operations (id, banner_id, version_id, idempotency_key, request_sha256, state, created_by_account_id)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [
          operationId,
          request.bannerId,
          versionId,
          request.idempotencyKey,
          fingerprint,
          principal.accountId,
        ],
      ),
      this.audit(
        principal,
        "banner.stage.started",
        request.bannerId,
        "Banner image staging started",
        {
          versionId,
          sha256: image.sha256,
        },
      ),
    ]);
    return this.operationRow(operationId);
  }

  private async operationRow(id: string): Promise<Row> {
    const operation = await this.database.first<Row>(
      "SELECT * FROM banner_stage_operations WHERE id = ?",
      [id],
    );
    if (!operation)
      throw new BannerStageError("finalize_failed", "Stage record is missing");
    return operation;
  }

  private async continueOperation(
    principal: TrustedPrincipal,
    request: BannerStageRequest,
    image: BannerImageInspection,
    fingerprint: string,
    operation: Row,
  ): Promise<BannerStageResult> {
    if (str(operation, "request_sha256") !== fingerprint)
      throw new BannerConflictError(
        "Idempotency key was already used for a different request",
      );
    const state = str(operation, "state");
    if (state === "verified" || state === "staged" || state === "activated")
      return this.result(
        str(operation, "banner_id"),
        str(operation, "version_id"),
        true,
        image,
      );
    if (!RETRYABLE_OPERATION.includes(state))
      throw new BannerConflictError(
        "Stage operation is not retryable and needs reconciliation",
      );
    return this.transfer(principal, request, image, operation);
  }

  /** Moves bytes to storage, rereads them, and finalizes only after both succeed. */
  private async transfer(
    principal: TrustedPrincipal,
    request: BannerStageRequest,
    image: BannerImageInspection,
    operation: Row,
  ): Promise<BannerStageResult> {
    const operationId = str(operation, "id");
    const versionId = str(operation, "version_id");
    const bannerId = str(operation, "banner_id");
    const version = await this.database.first<Row>(
      "SELECT * FROM banner_asset_versions WHERE id = ?",
      [versionId],
    );
    if (!version || !RETRYABLE_VERSION.includes(str(version, "state")))
      throw new BannerConflictError(
        "Saved stage operation needs reconciliation",
      );
    if (str(version, "sha256") !== image.sha256)
      throw new BannerConflictError(
        "Saved version does not match the supplied image",
      );
    const objectKey = str(version, "object_key");
    const versionState = str(version, "state");
    const operationState = str(operation, "state");

    if (versionState !== "staging" || operationState !== "staging") {
      await this.guarded(principal, () => [
        ...(versionState !== "staging"
          ? [
              this.database.prepare(
                "UPDATE banner_asset_versions SET state = 'staging' WHERE id = ? AND state IN ('pending','failed')",
                [versionId],
              ),
              this.changed(),
            ]
          : []),
        ...(operationState !== "staging"
          ? [
              this.database.prepare(
                `UPDATE banner_stage_operations SET state = 'staging', error_code = NULL, updated_at = ${NOW}
                 WHERE id = ? AND state IN ('pending','failed','interrupted','ready_for_retry')`,
                [operationId],
              ),
              this.changed(),
            ]
          : []),
      ]);
    }

    try {
      await this.storage.putIfAbsent(objectKey, request.bytes, {
        sha256: image.sha256,
        mediaType: image.mediaType,
        versionId,
        operationId,
      });
      const stored = await this.storage.get(objectKey);
      if (
        !stored ||
        stored.byteSize !== image.byteSize ||
        stored.body.byteLength !== image.byteSize ||
        stored.metadata.sha256 !== image.sha256 ||
        stored.metadata.mediaType !== image.mediaType ||
        stored.metadata.versionId !== versionId ||
        stored.metadata.operationId !== operationId ||
        (await sha256Hex(stored.body)) !== image.sha256
      )
        throw new Error("Stored object failed verification");
    } catch {
      await this.fail(
        principal,
        bannerId,
        versionId,
        operationId,
        "storage_verification_failed",
      );
      throw new BannerStageError(
        "storage_failed",
        "Image storage or verification failed. Retry with the same key",
      );
    }

    const verified = image.decode === "full";
    const verification = JSON.stringify({
      inspector: "banner-image-inspector/v1",
      decode: image.decode,
      storage: "reread_sha256_match",
      ...(image.decodeNote ? { note: image.decodeNote } : {}),
    });
    try {
      await this.guarded(principal, () => [
        this.database.prepare(
          verified
            ? `UPDATE banner_asset_versions SET state = 'verified', verification_json = ?, verified_at = ${NOW}
               WHERE id = ? AND state = 'staging'`
            : `UPDATE banner_asset_versions SET state = 'staged', verification_json = ?
               WHERE id = ? AND state = 'staging'`,
          [verification, versionId],
        ),
        this.changed(),
        this.database.prepare(
          `UPDATE banner_stage_operations SET state = ?, error_code = NULL, updated_at = ${NOW}
           WHERE id = ? AND state = 'staging'`,
          [verified ? "verified" : "staged", operationId],
        ),
        this.changed(),
        this.audit(
          principal,
          verified ? "banner.stage.verified" : "banner.stage.staged",
          bannerId,
          verified
            ? "Banner image version verified"
            : "Banner image stored, not verified",
          { versionId, sha256: image.sha256 },
        ),
      ]);
    } catch (error) {
      // Lost authority leaves the version in staging with its object present.
      // That state is reconciled read-only and never becomes verified here.
      if (error instanceof AuthorizationError) throw error;
      const current = await this.database.first<Row>(
        "SELECT state FROM banner_asset_versions WHERE id = ?",
        [versionId],
      );
      if (current && ["verified", "staged"].includes(str(current, "state")))
        return this.result(bannerId, versionId, true, image);
      await this.fail(
        principal,
        bannerId,
        versionId,
        operationId,
        "finalize_failed",
      );
      throw new BannerStageError(
        "finalize_failed",
        "Stage could not be finalized. Retry with the same key",
      );
    }
    return this.result(bannerId, versionId, false, image);
  }

  /** Best effort. If authority is gone the rows are left as they are. */
  private async fail(
    principal: TrustedPrincipal,
    bannerId: string,
    versionId: string,
    operationId: string,
    code: string,
  ): Promise<void> {
    try {
      await this.guarded(principal, () => [
        this.database.prepare(
          "UPDATE banner_asset_versions SET state = 'failed' WHERE id = ? AND state = 'staging'",
          [versionId],
        ),
        this.changed(),
        this.database.prepare(
          `UPDATE banner_stage_operations SET state = 'interrupted', error_code = ?, updated_at = ${NOW}
           WHERE id = ? AND state = 'staging'`,
          [code, operationId],
        ),
        this.changed(),
        this.audit(
          principal,
          "banner.stage.failed",
          bannerId,
          "Banner image staging failed",
          {
            versionId,
            code,
          },
        ),
      ]);
    } catch {
      /* The staging rows remain and reconcile as unverified. */
    }
  }

  private async result(
    bannerId: string,
    versionId: string,
    replayed: boolean,
    image: BannerImageInspection,
  ): Promise<BannerStageResult> {
    const row = await this.database.first<Row>(
      `SELECT v.*, v.id = b.selected_version_id AS is_selected, b.version AS banner_version,
         (SELECT o.created_by_account_id FROM banner_stage_operations o WHERE o.version_id = v.id ORDER BY o.created_at, o.id LIMIT 1) AS staged_by,
         (SELECT o.state FROM banner_stage_operations o WHERE o.version_id = v.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS op_state
       FROM banner_asset_versions v JOIN banner_assets b ON b.id = v.banner_id
       WHERE v.id = ? AND v.banner_id = ?`,
      [versionId, bannerId],
    );
    if (!row)
      throw new BannerStageError("finalize_failed", "Stage record is missing");
    const version = mapVersion(row, row.is_selected === 1 ? versionId : null);
    return {
      bannerId,
      version,
      bannerRowVersion: num(row, "banner_version"),
      replayed,
      decode: image.decode,
      verified: version.state === "verified",
      ...(image.decodeNote && version.state !== "verified"
        ? { note: image.decodeNote }
        : {}),
    };
  }

  // ------------------------------------------------------------ publication

  async listPublications(
    principal: TrustedPrincipal,
    bannerId: string,
  ): Promise<readonly BannerPublicationRecord[]> {
    await this.authorize(principal);
    this.validateBannerId(bannerId);
    const rows = await this.database.all<Row>(
      "SELECT * FROM banner_publications WHERE banner_id = ? ORDER BY sequence DESC",
      BANNER_PUBLICATION_LIST_LIMIT,
      [bannerId],
    );
    return rows.map(mapPublication);
  }

  async publish(
    principal: TrustedPrincipal,
    request: PublishRequest,
  ): Promise<BannerChangeResult> {
    await this.authorize(principal);
    this.validateKey(request.idempotencyKey);
    this.validateBannerId(request.bannerId);
    validText(request.versionId, "version ID", 128);
    this.validateRowVersion(request.expectedRowVersion);
    if (request.metadata) validateSnapshot(request.metadata);
    const fingerprint = await this.fingerprint("publish", principal, {
      bannerId: request.bannerId,
      versionId: request.versionId,
      expectedRowVersion: request.expectedRowVersion,
      metadata: request.metadata ?? null,
    });
    return this.select({
      principal,
      key: request.idempotencyKey,
      fingerprint,
      action: "publish",
      bannerId: request.bannerId,
      expectedRowVersion: request.expectedRowVersion,
      plan: async () => {
        const banner = await this.expectBanner(
          request.bannerId,
          request.expectedRowVersion,
        );
        const version = await this.verifiedVersion(
          request.bannerId,
          request.versionId,
        );
        const metadata: PublicationMetadata = request.metadata ?? {
          caption: str(banner, "caption"),
          altText: str(banner, "alt_text"),
          displayMode: str(banner, "display_mode") as BannerDisplayMode,
          focalX: num(banner, "focal_x"),
          focalY: num(banner, "focal_y"),
        };
        validateSnapshot(metadata);
        await this.verifyStoredObject(version);
        return {
          origin: "publish",
          restoredFrom: null,
          metadata,
          versionId: request.versionId,
          auditAction: "banner.published",
          summary: "Banner version published",
        };
      },
    });
  }

  async restore(
    principal: TrustedPrincipal,
    request: RestoreRequest,
  ): Promise<BannerChangeResult> {
    await this.authorize(principal);
    this.validateKey(request.idempotencyKey);
    this.validateBannerId(request.bannerId);
    validText(request.versionId, "version ID", 128);
    this.validateRowVersion(request.expectedRowVersion);
    if (request.publicationId !== undefined && request.metadata !== undefined)
      throw new BannerValidationError(
        "Give a recorded publication or explicit metadata, not both",
      );
    if (request.publicationId !== undefined)
      validText(request.publicationId, "publication ID", 128);
    if (request.metadata) validateSnapshot(request.metadata);
    const fingerprint = await this.fingerprint("restore", principal, {
      bannerId: request.bannerId,
      versionId: request.versionId,
      expectedRowVersion: request.expectedRowVersion,
      publicationId: request.publicationId ?? null,
      metadata: request.metadata ?? null,
    });
    return this.select({
      principal,
      key: request.idempotencyKey,
      fingerprint,
      action: "restore",
      bannerId: request.bannerId,
      expectedRowVersion: request.expectedRowVersion,
      plan: async () => {
        await this.expectBanner(request.bannerId, request.expectedRowVersion);
        const version = await this.verifiedVersion(
          request.bannerId,
          request.versionId,
        );
        let metadata: PublicationMetadata;
        let origin: PublicationOrigin;
        let restoredFrom: string | null = null;
        if (request.metadata) {
          metadata = request.metadata;
          origin = "restore_explicit";
        } else {
          const recorded = request.publicationId
            ? await this.database.first<Row>(
                "SELECT * FROM banner_publications WHERE id = ? AND banner_id = ? AND version_id = ?",
                [request.publicationId, request.bannerId, request.versionId],
              )
            : await this.database.first<Row>(
                "SELECT * FROM banner_publications WHERE banner_id = ? AND version_id = ? ORDER BY sequence DESC LIMIT 1",
                [request.bannerId, request.versionId],
              );
          if (!recorded) {
            if (request.publicationId)
              throw new BannerConflictError(
                "That publication does not belong to this version",
              );
            throw new BannerSnapshotRequiredError();
          }
          metadata = mapPublication(recorded);
          origin = "restore_recorded";
          restoredFrom = str(recorded, "id");
        }
        await this.verifyStoredObject(version);
        return {
          origin,
          restoredFrom,
          metadata,
          versionId: request.versionId,
          auditAction: "banner.restored",
          summary: "Retained banner version restored",
        };
      },
    });
  }

  async withdraw(
    principal: TrustedPrincipal,
    request: WithdrawRequest,
  ): Promise<BannerChangeResult> {
    await this.authorize(principal);
    this.validateKey(request.idempotencyKey);
    this.validateBannerId(request.bannerId);
    this.validateRowVersion(request.expectedRowVersion);
    const fingerprint = await this.fingerprint("withdraw", principal, {
      bannerId: request.bannerId,
      expectedRowVersion: request.expectedRowVersion,
    });
    const replay = await this.replayOf<BannerChangeResult>(
      request.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const banner = await this.expectBanner(
      request.bannerId,
      request.expectedRowVersion,
    );
    if (str(banner, "status") !== "active")
      throw new BannerConflictError("Only an active banner can be withdrawn");
    const selected = optStr(banner, "selected_version_id");
    const rowVersion = request.expectedRowVersion + 1;
    return this.commit<BannerChangeResult>({
      principal,
      key: request.idempotencyKey,
      fingerprint,
      action: "withdraw",
      targetType: "banner",
      targetId: request.bannerId,
      result: {
        bannerId: request.bannerId,
        status: "withdrawn",
        selectedVersionId: selected,
        rowVersion,
        publicationId: null,
      },
      expect: () =>
        this.expectBanner(request.bannerId, request.expectedRowVersion),
      statements: () => [
        this.database.prepare(
          `UPDATE banner_assets SET status = 'withdrawn', version = version + 1,
             updated_by_account_id = ?, updated_at = ${NOW}
           WHERE id = ? AND version = ? AND status = 'active'`,
          [principal.accountId, request.bannerId, request.expectedRowVersion],
        ),
        this.changed(),
      ],
      audit: this.audit(
        principal,
        "banner.withdrawn",
        request.bannerId,
        "Banner withdrawn",
        { versionId: selected ?? "none", rowVersion: String(rowVersion) },
      ),
    });
  }

  async updateMetadata(
    principal: TrustedPrincipal,
    request: UpdateMetadataRequest,
  ): Promise<BannerChangeResult> {
    await this.authorize(principal);
    this.validateKey(request.idempotencyKey);
    this.validateBannerId(request.bannerId);
    this.validateRowVersion(request.expectedRowVersion);
    const change = validateChange(request.change);
    const fingerprint = await this.fingerprint("update_metadata", principal, {
      bannerId: request.bannerId,
      expectedRowVersion: request.expectedRowVersion,
      change,
    });
    const replay = await this.replayOf<BannerChangeResult>(
      request.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const banner = await this.expectBanner(
      request.bannerId,
      request.expectedRowVersion,
    );
    const county = str(banner, "county_fips");
    const status = str(banner, "status") as BannerAssetStatus;
    const selected = optStr(banner, "selected_version_id");
    const next = {
      caption: change.caption ?? str(banner, "caption"),
      altText: change.altText ?? str(banner, "alt_text"),
      displayOrder: change.displayOrder ?? num(banner, "display_order"),
      homepageOrder:
        change.homepageOrder !== undefined
          ? change.homepageOrder
          : optNum(banner, "homepage_order"),
      isPrimary: change.isPrimary ?? num(banner, "is_primary") === 1,
      displayMode:
        change.displayMode ??
        (str(banner, "display_mode") as BannerDisplayMode),
      focalX: change.focalX ?? num(banner, "focal_x"),
      focalY: change.focalY ?? num(banner, "focal_y"),
    };
    const snapshotChanged =
      next.caption !== str(banner, "caption") ||
      next.altText !== str(banner, "alt_text") ||
      next.displayMode !== str(banner, "display_mode") ||
      next.focalX !== num(banner, "focal_x") ||
      next.focalY !== num(banner, "focal_y");
    const record = snapshotChanged && selected !== null;
    if ((status === "active" || record) && next.altText.trim() === "")
      throw new BannerValidationError(
        "A banner with a selected image needs non-blank alt text",
      );
    if (next.displayOrder !== num(banner, "display_order")) {
      const taken = await this.database.first(
        "SELECT 1 AS ok FROM banner_assets WHERE county_fips = ? AND display_order = ? AND id <> ?",
        [county, next.displayOrder, request.bannerId],
      );
      if (taken)
        throw new BannerConflictError(
          "Another banner in this county already uses that display order",
        );
    }
    if (
      next.homepageOrder !== null &&
      next.homepageOrder !== optNum(banner, "homepage_order")
    ) {
      const taken = await this.database.first(
        "SELECT 1 AS ok FROM banner_assets WHERE homepage_order = ? AND id <> ?",
        [next.homepageOrder, request.bannerId],
      );
      if (taken)
        throw new BannerConflictError(
          "Another banner already uses that homepage order",
        );
    }
    const publicationId = record ? this.newIdentifier() : null;
    const rowVersion = request.expectedRowVersion + 1;
    return this.commit<BannerChangeResult>({
      principal,
      key: request.idempotencyKey,
      fingerprint,
      action: "update_metadata",
      targetType: "banner",
      targetId: request.bannerId,
      result: {
        bannerId: request.bannerId,
        status,
        selectedVersionId: selected,
        rowVersion,
        publicationId,
      },
      expect: () =>
        this.expectBanner(request.bannerId, request.expectedRowVersion),
      statements: () => [
        ...(next.isPrimary
          ? [
              this.database.prepare(
                `UPDATE banner_assets SET is_primary = 0, version = version + 1,
                   updated_by_account_id = ?, updated_at = ${NOW}
                 WHERE county_fips = ? AND is_primary = 1 AND id <> ?`,
                [principal.accountId, county, request.bannerId],
              ),
            ]
          : []),
        this.database.prepare(
          `UPDATE banner_assets SET caption = ?, alt_text = ?, display_order = ?, homepage_order = ?,
             is_primary = ?, display_mode = ?, focal_x = ?, focal_y = ?, version = version + 1,
             updated_by_account_id = ?, updated_at = ${NOW}
           WHERE id = ? AND version = ?`,
          [
            next.caption,
            next.altText,
            next.displayOrder,
            next.homepageOrder,
            next.isPrimary ? 1 : 0,
            next.displayMode,
            next.focalX,
            next.focalY,
            principal.accountId,
            request.bannerId,
            request.expectedRowVersion,
          ],
        ),
        this.changed(),
        ...(publicationId && selected
          ? [
              this.publicationInsert({
                id: publicationId,
                bannerId: request.bannerId,
                versionId: selected,
                origin: "metadata_edit",
                restoredFrom: null,
                metadata: next,
                rowVersion,
                accountId: principal.accountId,
              }),
            ]
          : []),
      ],
      audit: this.audit(
        principal,
        "banner.metadata.updated",
        request.bannerId,
        "Banner metadata updated",
        {
          fields: Object.keys(change).sort().join(","),
          rowVersion: String(rowVersion),
          ...(publicationId ? { publicationId } : {}),
        },
      ),
    });
  }

  async reorderCounty(
    principal: TrustedPrincipal,
    request: ReorderCountyRequest,
  ): Promise<ReorderCountyResult> {
    await this.authorize(principal);
    this.validateKey(request.idempotencyKey);
    if (!/^08\d{3}$/.test(request.countyFips))
      throw new BannerValidationError(
        "County FIPS must be five Colorado digits",
      );
    const ids = request.orderedBannerIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > BANNER_ADMIN_LIMITS.countyPageMax
    )
      throw new BannerValidationError("Invalid banner order");
    for (const id of ids) {
      this.validateBannerId(id);
      this.validateRowVersion(request.expectedRowVersions[id]);
    }
    const fingerprint = await this.fingerprint("reorder", principal, {
      countyFips: request.countyFips,
      orderedBannerIds: ids,
      expectedRowVersions: ids.map((id) => request.expectedRowVersions[id]),
    });
    const replay = await this.replayOf<ReorderCountyResult>(
      request.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const current = await this.currentOrder(
      request.countyFips,
      ids,
      request.expectedRowVersions,
    );
    const moved = ids.filter((id, index) => current.get(id)?.order !== index);
    if (moved.length === 0)
      throw new BannerValidationError("The banner order is unchanged");
    const base =
      Math.max(-1, ...[...current.values()].map((row) => row.order)) +
      ids.length +
      1;
    const phase = (second: boolean): D1BatchStatement[] =>
      ids.flatMap((id, index) => {
        const before = current.get(id);
        if (!before || before.order === index) return [];
        return [
          this.database.prepare(
            `UPDATE banner_assets SET display_order = ?, version = version + 1,
               updated_by_account_id = ?, updated_at = ${NOW}
             WHERE id = ? AND county_fips = ? AND version = ?`,
            [
              second ? index : base + index,
              principal.accountId,
              id,
              request.countyFips,
              before.version + (second ? 1 : 0),
            ],
          ),
          this.changed(),
        ];
      });
    return this.commit<ReorderCountyResult>({
      principal,
      key: request.idempotencyKey,
      fingerprint,
      action: "reorder",
      targetType: "county",
      targetId: request.countyFips,
      result: {
        countyFips: request.countyFips,
        banners: ids.map((id, index) => {
          const before = current.get(id);
          return {
            bannerId: id,
            displayOrder: index,
            rowVersion:
              (before?.version ?? 0) + (before?.order === index ? 0 : 2),
          };
        }),
      },
      expect: async () => {
        await this.currentOrder(
          request.countyFips,
          ids,
          request.expectedRowVersions,
        );
      },
      statements: () => [
        this.assertion(
          "(SELECT COUNT(*) FROM banner_assets WHERE county_fips = ?) = ?",
          [request.countyFips, ids.length],
        ),
        ...phase(false),
        ...phase(true),
      ],
      audit: this.audit(
        principal,
        "banner.order.updated",
        request.countyFips,
        "County banner order updated",
        { count: String(ids.length), moved: String(moved.length) },
        "county",
      ),
    });
  }

  // -------------------------------------------------------- change plumbing

  private validateKey(key: string): void {
    validText(key, "idempotency key", 200);
    if (key.trim() === "")
      throw new BannerValidationError("Invalid idempotency key");
  }

  private validateBannerId(id: string): void {
    if (typeof id !== "string" || !BANNER_ID.test(id))
      throw new BannerValidationError("Invalid banner ID");
  }

  private validateRowVersion(value: unknown): void {
    if (!Number.isInteger(value) || (value as number) < 1)
      throw new BannerValidationError("Invalid expected row version");
  }

  private async fingerprint(
    action: string,
    principal: TrustedPrincipal,
    payload: unknown,
  ): Promise<string> {
    return sha256Hex(
      new TextEncoder().encode(
        canonical({ action, actor: principal.accountId, payload }),
      ),
    );
  }

  /** The stored result of an earlier identical request, or a conflict on key reuse. */
  private async replayOf<T extends { replayed: boolean }>(
    key: string,
    fingerprint: string,
  ): Promise<T | null> {
    const row = await this.database.first<Row>(
      "SELECT request_sha256, result_json FROM banner_admin_operations WHERE idempotency_key = ?",
      [key],
    );
    if (!row) return null;
    if (str(row, "request_sha256") !== fingerprint)
      throw new BannerConflictError(
        "Idempotency key was already used for a different request",
      );
    return {
      ...(JSON.parse(str(row, "result_json")) as object),
      replayed: true,
    } as T;
  }

  private async expectBanner(
    bannerId: string,
    expectedRowVersion: number,
  ): Promise<Row> {
    const banner = await this.database.first<Row>(
      "SELECT * FROM banner_assets WHERE id = ?",
      [bannerId],
    );
    if (!banner) throw new BannerConflictError("Banner does not exist");
    if (num(banner, "version") !== expectedRowVersion)
      throw new BannerConflictError("Stale banner row version");
    return banner;
  }

  private async verifiedVersion(
    bannerId: string,
    versionId: string,
  ): Promise<Row> {
    const version = await this.database.first<Row>(
      "SELECT * FROM banner_asset_versions WHERE id = ? AND banner_id = ?",
      [versionId, bannerId],
    );
    if (!version || str(version, "state") !== "verified")
      throw new BannerConflictError(
        "Only a verified version belonging to this banner can be selected",
      );
    return version;
  }

  /** Rereads the object and compares size and digest before anything selects it. */
  private async verifyStoredObject(version: Row): Promise<void> {
    const stored = await this.storage.get(str(version, "object_key"));
    if (
      !stored ||
      stored.byteSize !== num(version, "byte_size") ||
      stored.body.byteLength !== num(version, "byte_size") ||
      (await sha256Hex(stored.body)) !== str(version, "sha256") ||
      stored.metadata.sha256 !== str(version, "sha256") ||
      stored.metadata.versionId !== str(version, "id")
    )
      throw new BannerConflictError(
        "Stored image is missing or failed size and digest verification",
      );
  }

  private async currentOrder(
    countyFips: string,
    ids: readonly string[],
    expectedVersions: Readonly<Record<string, number>>,
  ): Promise<Map<string, { order: number; version: number }>> {
    const rows = await this.database.all<Row>(
      "SELECT id, display_order, version FROM banner_assets WHERE county_fips = ? ORDER BY display_order, id",
      BANNER_ADMIN_LIMITS.countyPageMax + 1,
      [countyFips],
    );
    const known = new Map(
      rows.map((row) => [
        str(row, "id"),
        { order: num(row, "display_order"), version: num(row, "version") },
      ]),
    );
    if (
      rows.length !== ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !known.has(id))
    )
      throw new BannerConflictError(
        "Reordering must include each county banner exactly once",
      );
    for (const id of ids)
      if (known.get(id)?.version !== expectedVersions[id])
        throw new BannerConflictError("Stale banner row version");
    return known;
  }

  private publicationInsert(input: {
    id: string;
    bannerId: string;
    versionId: string;
    origin: PublicationOrigin;
    restoredFrom: string | null;
    metadata: PublicationMetadata;
    rowVersion: number;
    accountId: string;
  }): D1BatchStatement {
    return this.database.prepare(
      `INSERT INTO banner_publications (id, banner_id, version_id, sequence, origin, restored_from_publication_id,
         caption, alt_text, display_mode, focal_x, focal_y, banner_row_version, published_by_account_id)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM banner_publications WHERE banner_id = ?),
         ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.bannerId,
        input.versionId,
        input.bannerId,
        input.origin,
        input.restoredFrom,
        input.metadata.caption,
        input.metadata.altText,
        input.metadata.displayMode,
        input.metadata.focalX,
        input.metadata.focalY,
        input.rowVersion,
        input.accountId,
      ],
    );
  }

  /** Publish and restore share one write: select, set metadata, record, audit. */
  private async select(spec: {
    principal: TrustedPrincipal;
    key: string;
    fingerprint: string;
    action: "publish" | "restore";
    bannerId: string;
    expectedRowVersion: number;
    plan: () => Promise<{
      origin: PublicationOrigin;
      restoredFrom: string | null;
      metadata: PublicationMetadata;
      versionId: string;
      auditAction: string;
      summary: string;
    }>;
  }): Promise<BannerChangeResult> {
    const replay = await this.replayOf<BannerChangeResult>(
      spec.key,
      spec.fingerprint,
    );
    if (replay) return replay;
    const plan = await spec.plan();
    const publicationId = this.newIdentifier();
    const rowVersion = spec.expectedRowVersion + 1;
    return this.commit<BannerChangeResult>({
      principal: spec.principal,
      key: spec.key,
      fingerprint: spec.fingerprint,
      action: spec.action,
      targetType: "banner",
      targetId: spec.bannerId,
      result: {
        bannerId: spec.bannerId,
        status: "active",
        selectedVersionId: plan.versionId,
        rowVersion,
        publicationId,
      },
      expect: async () => {
        await this.expectBanner(spec.bannerId, spec.expectedRowVersion);
        await this.verifiedVersion(spec.bannerId, plan.versionId);
      },
      statements: () => [
        this.assertion(
          "EXISTS (SELECT 1 FROM banner_asset_versions WHERE id = ? AND banner_id = ? AND state = 'verified')",
          [plan.versionId, spec.bannerId],
        ),
        this.database.prepare(
          `UPDATE banner_assets SET selected_version_id = ?, status = 'active', caption = ?, alt_text = ?,
             display_mode = ?, focal_x = ?, focal_y = ?, version = version + 1,
             updated_by_account_id = ?, updated_at = ${NOW}
           WHERE id = ? AND version = ?`,
          [
            plan.versionId,
            plan.metadata.caption,
            plan.metadata.altText,
            plan.metadata.displayMode,
            plan.metadata.focalX,
            plan.metadata.focalY,
            spec.principal.accountId,
            spec.bannerId,
            spec.expectedRowVersion,
          ],
        ),
        this.changed(),
        this.publicationInsert({
          id: publicationId,
          bannerId: spec.bannerId,
          versionId: plan.versionId,
          origin: plan.origin,
          restoredFrom: plan.restoredFrom,
          metadata: plan.metadata,
          rowVersion,
          accountId: spec.principal.accountId,
        }),
        this.database.prepare(
          `UPDATE banner_stage_operations SET state = 'activated', updated_at = ${NOW}
           WHERE version_id = ? AND state = 'verified'`,
          [plan.versionId],
        ),
      ],
      audit: this.audit(
        spec.principal,
        plan.auditAction,
        spec.bannerId,
        plan.summary,
        {
          versionId: plan.versionId,
          publicationId,
          origin: plan.origin,
          rowVersion: String(rowVersion),
          ...(plan.restoredFrom ? { restoredFrom: plan.restoredFrom } : {}),
        },
      ),
    });
  }

  /**
   * Runs the guarded batch with the idempotency ledger row and the audit event
   * in the same atomic write. If it fails, nothing was written. The failure is
   * then explained: lost authority, a concurrent identical request, a stale
   * read or a constraint.
   */
  private async commit<T extends { replayed: boolean }>(spec: {
    principal: TrustedPrincipal;
    key: string;
    fingerprint: string;
    action: "publish" | "withdraw" | "restore" | "update_metadata" | "reorder";
    targetType: "banner" | "county";
    targetId: string;
    result: Omit<T, "replayed">;
    expect: () => Promise<unknown>;
    statements: () => D1BatchStatement[];
    audit: D1BatchStatement;
  }): Promise<T> {
    try {
      await this.guarded(spec.principal, () => [
        ...spec.statements(),
        this.database.prepare(
          `INSERT INTO banner_admin_operations (id, idempotency_key, request_sha256, action, target_type, target_id, result_json, account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.newIdentifier(),
            spec.key,
            spec.fingerprint,
            spec.action,
            spec.targetType,
            spec.targetId,
            JSON.stringify(spec.result),
            spec.principal.accountId,
          ],
        ),
        spec.audit,
      ]);
    } catch (error) {
      await this.authorize(spec.principal);
      const replay = await this.replayOf<T>(spec.key, spec.fingerprint);
      if (replay) return replay;
      await spec.expect();
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message))
        throw new BannerConflictError(
          "Change conflicts with another banner's order or primary setting",
        );
      throw error;
    }
    return { ...spec.result, replayed: false } as T;
  }
}

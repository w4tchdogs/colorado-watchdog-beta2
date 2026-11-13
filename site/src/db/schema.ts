// Website D1 schema for milestone M0. Source of truth for generated migrations.
// Research tables do not belong here. They live in the separate local research system.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Shared column conventions.
// - version: starts at 1 and rises by exactly one on every update through the service layer.
// - created_at and updated_at: UTC ISO 8601 text supplied by the service layer.
// - JSON columns: text with a json_valid check.
const version = () => integer("version").notNull().default(1);
const createdAt = () => text("created_at").notNull();
const updatedAt = () => text("updated_at").notNull();

export const ACCOUNT_KINDS = ["human", "agent"] as const;
export const ACCOUNT_ROLES = ["contributor", "editor", "administrator", "owner"] as const;
export const ACCOUNT_STATUSES = ["active", "disabled"] as const;
export const IDENTITY_PROVIDERS = ["sites", "agent_key"] as const;
export const OPERATION_STATES = ["pending", "running", "succeeded", "failed"] as const;
export const VERIFY_RESULTS = ["passed", "failed"] as const;

export const counties = sqliteTable(
  "counties",
  {
    fips: text("fips").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
  },
  (t) => [
    uniqueIndex("counties_name_unique").on(t.name),
    uniqueIndex("counties_slug_unique").on(t.slug),
    check(
      "counties_fips_format",
      sql`length(${t.fips}) = 5 AND ${t.fips} GLOB '08[0-9][0-9][0-9]'`,
    ),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    status: text("status").notNull().default("active"),
    preferences: text("preferences").notNull().default("{}"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("accounts_kind_valid", sql`${t.kind} IN ('human', 'agent')`),
    check(
      "accounts_role_valid",
      sql`${t.role} IN ('contributor', 'editor', 'administrator', 'owner')`,
    ),
    check("accounts_status_valid", sql`${t.status} IN ('active', 'disabled')`),
    check(
      "accounts_preferences_json",
      sql`json_valid(${t.preferences}) AND json_type(${t.preferences}) = 'object'`,
    ),
    check("accounts_version_positive", sql`${t.version} >= 1`),
  ],
);

export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    provider: text("provider").notNull(),
    // Sign-in subject for provider "sites". Key hash for provider "agent_key". Never a raw key.
    subject: text("subject").notNull(),
    label: text("label"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("identities_provider_subject_unique").on(t.provider, t.subject),
    index("identities_account").on(t.accountId),
    check("identities_provider_valid", sql`${t.provider} IN ('sites', 'agent_key')`),
    check("identities_version_positive", sql`${t.version} >= 1`),
  ],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    state: text("state").notNull().default("pending"),
    requestedBy: text("requested_by").references(() => accounts.id),
    params: text("params").notNull().default("{}"),
    result: text("result"),
    progress: integer("progress").notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "operations_state_valid",
      sql`${t.state} IN ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check("operations_params_json", sql`json_valid(${t.params})`),
    check("operations_result_json", sql`${t.result} IS NULL OR json_valid(${t.result})`),
    check("operations_progress_range", sql`${t.progress} BETWEEN 0 AND 100`),
    check("operations_version_positive", sql`${t.version} >= 1`),
  ],
);

// Append-only by application rule. The service layer exposes no update or delete for this table.
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: text("at").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    operationId: text("operation_id").references(() => operations.id),
    summary: text("summary").notNull().default("{}"),
  },
  (t) => [
    index("audit_events_at").on(t.at),
    index("audit_events_target").on(t.targetType, t.targetId),
    check("audit_events_summary_json", sql`json_valid(${t.summary})`),
  ],
);

export const checkpoints = sqliteTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    manifest: text("manifest").notNull(),
    verifiedAt: text("verified_at"),
    verifyResult: text("verify_result"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "checkpoints_sha256_format",
      sql`length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("checkpoints_manifest_json", sql`json_valid(${t.manifest})`),
    check(
      "checkpoints_verify_result_valid",
      sql`${t.verifyResult} IS NULL OR ${t.verifyResult} IN ('passed', 'failed')`,
    ),
    check("checkpoints_version_positive", sql`${t.version} >= 1`),
  ],
);

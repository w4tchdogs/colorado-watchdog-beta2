import { randomUUID } from "node:crypto";
import type { AsyncD1Database, D1BatchStatement } from "../database/d1.js";
import {
  loadWebsiteMigrations,
  migrationChecksum,
} from "../database/migrations.js";

export const BETA2_PROJECT_ID = "appgprj_6af7fb8f615c81918da0e4450ba336de";
export const BETA2_SITES_PROVIDER = `chatgpt-sites:${BETA2_PROJECT_ID}`;
const EXPECTED_MIGRATION = "0014_owner_bootstrap_audit.sql";

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

export interface FirstOwnerBootstrapInput {
  readonly projectId: string;
  readonly bindingName: string;
  /** Exact opaque subject obtained from a separately verified trusted channel. */
  readonly subject: string;
  /**
   * Identity provider namespace for the link. Defaults to the Beta-2 Sites
   * provider. Website human sign-in uses `auth0:<issuer>` with the exact
   * `AUTH0_ISSUER`, so link an Auth0 subject by passing that value here.
   */
  readonly provider?: string;
  /** Durable operator identity from the trusted administrative environment. */
  readonly operatorReference: string;
  readonly dryRun?: boolean;
}

export type FirstOwnerBootstrapResult =
  | { readonly status: "ready" }
  | { readonly status: "already_complete" }
  | { readonly status: "created"; readonly accountId: string };

interface BootstrapState {
  readonly ownerCount: number;
  readonly exactLinkCount: number;
  readonly eventCount: number;
  readonly exactOwnerAccountId: string | null;
}

/**
 * Offline administrative operation. It is deliberately not mounted as a
 * Worker route. D1 batch supplies the all-or-nothing boundary; each write is
 * additionally guarded so competing operators cannot create another owner.
 */
export async function bootstrapFirstOwner(
  database: AsyncD1Database,
  input: FirstOwnerBootstrapInput,
): Promise<FirstOwnerBootstrapResult> {
  validateInput(input);
  const provider = input.provider ?? BETA2_SITES_PROVIDER;
  await verifySchema(database);
  const before = await readState(database, provider, input.subject);
  if (isCompleted(before)) return { status: "already_complete" };
  if (before.ownerCount || before.exactLinkCount || before.eventCount) {
    throw new Error("First-owner bootstrap state conflicts; no changes made");
  }
  if (input.dryRun) return { status: "ready" };

  const accountId = `acct_${randomUUID()}`;
  const identityId = `identity_${randomUUID()}`;
  const auditId = `boot_${randomUUID()}`;
  const statements: D1BatchStatement[] = [
    database.prepare(
      `INSERT INTO accounts (id, kind, role, status, display_name, email)
       SELECT ?, 'human', 'owner', 'active', 'Website Owner', NULL
       WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'owner')`,
      [accountId],
    ),
    database.prepare(
      `INSERT INTO identities (id, account_id, provider, subject)
       SELECT ?, a.id, ?, ? FROM accounts a
       WHERE a.id = ? AND a.kind = 'human' AND a.role = 'owner'
         AND a.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND subject = ?)
         AND (SELECT COUNT(*) FROM accounts WHERE role = 'owner') = 1`,
      [identityId, provider, input.subject, accountId, provider, input.subject],
    ),
    database.prepare(
      `INSERT INTO owner_bootstrap_audit
         (id, actor_kind, actor_reference, action, account_id, identity_id,
          provider, site_project_id, summary)
       SELECT ?, 'trusted_bootstrap_operator', ?, 'account.first_owner.bootstrap',
              a.id, i.id, ?, ?,
              'First human owner established by trusted administrative bootstrap'
       FROM accounts a JOIN identities i ON i.account_id = a.id
       WHERE a.id = ? AND a.kind = 'human' AND a.role = 'owner'
         AND a.status = 'active' AND i.id = ? AND i.provider = ? AND i.subject = ?
         AND NOT EXISTS (SELECT 1 FROM owner_bootstrap_audit)`,
      [
        auditId,
        input.operatorReference,
        provider,
        BETA2_PROJECT_ID,
        accountId,
        identityId,
        provider,
        input.subject,
      ],
    ),
  ];
  await database.batch(statements);

  const after = await readState(database, provider, input.subject);
  if (isCompleted(after)) {
    return after.exactOwnerAccountId === accountId
      ? { status: "created", accountId }
      : { status: "already_complete" };
  }
  throw new Error("First-owner bootstrap did not complete atomically");
}

function validateInput(input: FirstOwnerBootstrapInput): void {
  if (
    input.projectId !== BETA2_PROJECT_ID ||
    input.bindingName !== "DB" ||
    typeof input.subject !== "string" ||
    input.subject.length === 0 ||
    input.subject.length > 512 ||
    hasControlCharacters(input.subject) ||
    !input.subject.trim() ||
    typeof input.operatorReference !== "string" ||
    !input.operatorReference.trim() ||
    input.operatorReference.length > 128 ||
    hasControlCharacters(input.operatorReference) ||
    (input.provider !== undefined && !validProvider(input.provider))
  ) {
    throw new TypeError("Invalid first-owner bootstrap target or input");
  }
}

/** The Beta-2 Sites provider, or `auth0:` plus a bare HTTPS issuer. */
function validProvider(provider: unknown): boolean {
  if (provider === BETA2_SITES_PROVIDER) return true;
  if (typeof provider !== "string" || !provider.startsWith("auth0:"))
    return false;
  const issuer = provider.slice("auth0:".length);
  try {
    const url = new URL(issuer);
    return (
      url.protocol === "https:" &&
      url.href === issuer &&
      url.pathname === "/" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function verifySchema(database: AsyncD1Database): Promise<void> {
  const history = await database.all<{
    version: unknown;
    name: unknown;
    sha256: unknown;
  }>(
    "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
    32,
  );
  const expected = loadWebsiteMigrations();
  if (
    expected.length !== 26 ||
    history.length !== expected.length ||
    history.some((row, index) => {
      const migration = expected[index];
      return (
        !migration ||
        row.version !== migration.version ||
        row.name !== migration.name ||
        row.sha256 !== migrationChecksum(migration.sql)
      );
    }) ||
    expected[13]?.name !== EXPECTED_MIGRATION
  ) {
    throw new Error(
      "Website D1 migration state is not the expected Beta-2 schema",
    );
  }
  const tables = await database.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('accounts','identities','owner_bootstrap_audit') ORDER BY name",
    4,
  );
  if (tables.length !== 3) {
    throw new Error("Website D1 account schema is incomplete");
  }
  const audit = await database.first<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'owner_bootstrap_audit_no_delete'",
  );
  if (!audit) throw new Error("Website D1 bootstrap audit is not append-only");
}

async function readState(
  database: AsyncD1Database,
  provider: string,
  subject: string,
): Promise<BootstrapState> {
  const row = await database.first<Record<string, unknown>>(
    `SELECT
       (SELECT COUNT(*) FROM accounts WHERE role = 'owner') AS owner_count,
       (SELECT COUNT(*) FROM identities WHERE provider = ? AND subject = ?) AS link_count,
       (SELECT COUNT(*) FROM owner_bootstrap_audit) AS event_count,
       (SELECT a.id FROM accounts a JOIN identities i ON i.account_id = a.id
        JOIN owner_bootstrap_audit e ON e.account_id = a.id AND e.identity_id = i.id
        WHERE a.kind = 'human' AND a.role = 'owner' AND a.status = 'active'
          AND i.provider = ? AND i.subject = ?
          AND e.action = 'account.first_owner.bootstrap'
          AND e.site_project_id = ? AND e.provider = ?
        LIMIT 1) AS exact_owner_account_id`,
    [provider, subject, provider, subject, BETA2_PROJECT_ID, provider],
  );
  if (!row) throw new Error("Could not inspect Website D1 bootstrap state");
  return {
    ownerCount: numberValue(row.owner_count),
    exactLinkCount: numberValue(row.link_count),
    eventCount: numberValue(row.event_count),
    exactOwnerAccountId:
      typeof row.exact_owner_account_id === "string"
        ? row.exact_owner_account_id
        : null,
  };
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid Website D1 bootstrap count");
  }
  return value;
}

function isCompleted(state: BootstrapState): boolean {
  return (
    state.ownerCount === 1 &&
    state.exactLinkCount === 1 &&
    state.eventCount === 1 &&
    state.exactOwnerAccountId !== null
  );
}

import type { WebsiteDatabase } from "../database/sqlite.js";
import { updateVersionedRow } from "../database/versioned-writes.js";
import { runAuditedMutation } from "./audit.js";
import {
  type AccountKind,
  type AccountRole,
  createAgentCredential,
  isCurrentPrincipal,
  isGrantableAgentCapability,
  newId,
  requireCapability,
  type TrustedPrincipal,
} from "./security.js";

export interface NewAccount {
  readonly kind: AccountKind;
  readonly role: AccountRole;
  readonly displayName: string;
  readonly email?: string | null;
}

export interface AccountSummary {
  readonly id: string;
  readonly kind: AccountKind;
  readonly role: AccountRole;
  readonly status: "active" | "disabled";
  readonly archivedAt: string | null;
  readonly displayName: string;
  readonly version: number;
}

export interface AccountFilter {
  readonly query?: string;
  readonly kind?: AccountKind;
  readonly role?: AccountRole;
  readonly status?: "active" | "disabled";
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly afterId?: string;
}

export interface AccountDetails extends AccountSummary {
  readonly email: string | null;
  readonly preferences: Readonly<Record<string, unknown>>;
  readonly identities: ReadonlyArray<{
    readonly id: string;
    readonly provider: string;
    readonly subject: string;
    readonly expiresAt: string | null;
    readonly revokedAt: string | null;
    readonly version: number;
  }>;
}

const MAX_ACCOUNT_PAGE_SIZE = 100;

/** A signed-in account may inspect its own profile; administrators may inspect any. */
export function getOwnAccount(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
): AccountSummary {
  if (!isCurrentPrincipal(database, principal)) throw new InvalidInputError();
  return getAccountRow(database, principal.accountId);
}

export function getAccount(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  id: string,
): AccountSummary | null {
  requireCapability(database, principal, "account.read");
  const row = database
    .prepare(
      `SELECT id, kind, role, status, display_name, version, archived_at
       FROM accounts WHERE id = ?`,
    )
    .get(id);
  if (!row) {
    return null;
  }
  if (
    typeof row.id !== "string" ||
    (row.kind !== "human" && row.kind !== "agent") ||
    !isRole(row.role) ||
    (row.status !== "active" && row.status !== "disabled") ||
    typeof row.display_name !== "string" ||
    typeof row.version !== "number"
  ) {
    throw new Error("Invalid account record");
  }
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    status: row.status,
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    displayName: row.display_name,
    version: row.version,
  };
}

export function getAccountDetails(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  id: string,
): AccountDetails | null {
  requireCapability(database, principal, "account.read");
  const row = database
    .prepare(
      `SELECT id, kind, role, status, display_name, email, preferences, version, archived_at FROM accounts WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  const summary = parseAccountSummary(row);
  let preferences: unknown;
  try {
    preferences = JSON.parse(String(row.preferences));
  } catch {
    throw new Error("Invalid account preferences");
  }
  if (
    !preferences ||
    typeof preferences !== "object" ||
    Array.isArray(preferences)
  )
    throw new Error("Invalid account preferences");
  const identities = database
    .prepare(
      `SELECT id, provider, subject, expires_at, revoked_at, version FROM identities WHERE account_id = ? ORDER BY created_at, id`,
    )
    .all(id)
    .map((identity) => ({
      id: String(identity.id),
      provider: String(identity.provider),
      subject: String(identity.subject),
      expiresAt:
        identity.expires_at === null ? null : String(identity.expires_at),
      revokedAt:
        identity.revoked_at === null ? null : String(identity.revoked_at),
      version: Number(identity.version),
    }));
  return {
    ...summary,
    email: row.email === null ? null : String(row.email),
    preferences: preferences as Record<string, unknown>,
    identities,
  };
}

export function listAccounts(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  filter: AccountFilter = {},
) {
  requireCapability(database, principal, "account.read");
  const limit = filter.limit ?? 50;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_ACCOUNT_PAGE_SIZE ||
    (filter.query !== undefined &&
      (filter.query.trim().length < 1 || filter.query.length > 100)) ||
    (filter.kind !== undefined &&
      filter.kind !== "human" &&
      filter.kind !== "agent") ||
    (filter.role !== undefined && !isRole(filter.role)) ||
    (filter.status !== undefined &&
      filter.status !== "active" &&
      filter.status !== "disabled") ||
    (filter.afterId !== undefined &&
      (filter.afterId.length < 1 || filter.afterId.length > 128))
  )
    throw new InvalidInputError();
  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (!filter.includeArchived) conditions.push("archived_at IS NULL");
  if (filter.query) {
    conditions.push(
      "(display_name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')",
    );
    const q = `%${filter.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    args.push(q, q);
  }
  if (filter.kind) {
    conditions.push("kind = ?");
    args.push(filter.kind);
  }
  if (filter.role) {
    conditions.push("role = ?");
    args.push(filter.role);
  }
  if (filter.status) {
    conditions.push("status = ?");
    args.push(filter.status);
  }
  if (filter.afterId) {
    conditions.push("id > ?");
    args.push(filter.afterId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = database
    .prepare(
      `SELECT id, kind, role, status, display_name, version, archived_at FROM accounts ${where} ORDER BY id LIMIT ?`,
    )
    .all(...args, limit + 1);
  const hasMore = rows.length > limit;
  return {
    accounts: rows.slice(0, limit).map(parseAccountSummary),
    nextAfterId: hasMore ? String(rows[limit - 1]?.id) : null,
  };
}

function getAccountRow(database: WebsiteDatabase, id: string): AccountSummary {
  const row = database
    .prepare(
      "SELECT id, kind, role, status, display_name, version, archived_at FROM accounts WHERE id = ?",
    )
    .get(id);
  if (!row) throw new InvalidInputError();
  return parseAccountSummary(row);
}

function parseAccountSummary(row: Record<string, unknown>): AccountSummary {
  if (
    typeof row.id !== "string" ||
    (row.kind !== "human" && row.kind !== "agent") ||
    !isRole(row.role) ||
    (row.status !== "active" && row.status !== "disabled") ||
    typeof row.display_name !== "string" ||
    typeof row.version !== "number"
  )
    throw new Error("Invalid account record");
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    status: row.status,
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    displayName: row.display_name,
    version: row.version,
  };
}

export class InvalidInputError extends Error {
  constructor() {
    super("Invalid account or identity input");
    this.name = "InvalidInputError";
  }
}

export function createAccount(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  input: NewAccount,
  operationId?: string,
): AccountSummary {
  requireCapability(database, principal, "account.create");
  validateAccountInput(input);
  if (input.kind === "agent" && input.role === "owner")
    throw new InvalidInputError();
  if (input.role === "owner" || input.role === "administrator") {
    requireCapability(database, principal, "account.change_role");
  }
  if (
    input.kind === "human" &&
    input.role !== "owner" &&
    input.role !== "administrator"
  ) {
    requireCapability(database, principal, "account.change_role");
  }
  if (input.kind === "agent" && input.role === "editor") {
    requireCapability(database, principal, "account.change_role");
  }

  const id = newId();
  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "account.create",
      targetType: "account",
      targetId: id,
      summary: "Created an account",
      details: { kind: input.kind, role: input.role },
    },
    () => {
      database
        .prepare(
          `INSERT INTO accounts (id, kind, role, display_name, email)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          input.role,
          input.displayName.trim(),
          input.email ?? null,
        );
      return {
        id,
        kind: input.kind,
        role: input.role,
        status: "active",
        archivedAt: null,
        displayName: input.displayName.trim(),
        version: 1,
      };
    },
  );
}

export function updateAccount(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  id: string,
  expectedVersion: number,
  changes: {
    readonly displayName?: string;
    readonly email?: string | null;
    readonly status?: "active" | "disabled";
    readonly preferences?: Readonly<Record<string, unknown>>;
  },
  operationId?: string,
): number {
  requireCapability(database, principal, "account.update");
  const values: Record<string, string | number | null> = {};
  if (changes.displayName !== undefined) {
    if (!changes.displayName.trim()) {
      throw new InvalidInputError();
    }
    values.display_name = changes.displayName.trim();
  }
  if (changes.email !== undefined) {
    if (
      changes.email !== null &&
      (typeof changes.email !== "string" || !changes.email.trim())
    ) {
      throw new InvalidInputError();
    }
    values.email = changes.email?.trim() ?? null;
  }
  if (changes.status !== undefined) {
    if (changes.status !== "active" && changes.status !== "disabled") {
      throw new InvalidInputError();
    }
    values.status = changes.status;
  }
  if (changes.preferences !== undefined) {
    if (
      !changes.preferences ||
      typeof changes.preferences !== "object" ||
      Array.isArray(changes.preferences) ||
      JSON.stringify(changes.preferences).length > 4096
    )
      throw new InvalidInputError();
    values.preferences = JSON.stringify(changes.preferences);
  }
  if (Object.keys(values).length === 0) {
    throw new InvalidInputError();
  }

  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "account.update",
      targetType: "account",
      targetId: id,
      summary: "Updated an account",
      details: { fields: Object.keys(values).sort().join(",") },
    },
    () => {
      const current = database
        .prepare("SELECT role, status, kind FROM accounts WHERE id = ?")
        .get(id);
      if (!current) {
        throw new InvalidInputError();
      }
      if (
        current.role === "owner" &&
        current.status === "active" &&
        values.status === "disabled"
      ) {
        ensureAnotherActiveOwner(database, id);
      }
      return updateVersionedRow(
        database,
        "accounts",
        id,
        expectedVersion,
        values,
      );
    },
  );
}

/** Archive is owner-only because the account must retain a readable history. */
export function archiveAccount(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  id: string,
  expectedVersion: number,
  operationId?: string,
): number {
  requireCapability(database, principal, "account.change_role");
  const account = database
    .prepare("SELECT kind,status,archived_at FROM accounts WHERE id=?")
    .get(id);
  if (account?.kind !== "agent" || account.archived_at !== null)
    throw new InvalidInputError();
  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "account.archive",
      targetType: "account",
      targetId: id,
      summary: "Archived an unused agent account",
    },
    () => {
      database
        .prepare(
          "UPDATE identities SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id=? AND provider='agent-key' AND revoked_at IS NULL",
        )
        .run(id);
      database
        .prepare(
          "UPDATE agent_capability_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoked_by_account_id=? WHERE account_id=? AND revoked_at IS NULL",
        )
        .run(principal.accountId, id);
      return updateVersionedRow(database, "accounts", id, expectedVersion, {
        archived_at: new Date().toISOString(),
        status: "disabled",
      });
    },
  );
}

export function changeAccountRole(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  id: string,
  expectedVersion: number,
  role: AccountRole,
  operationId?: string,
): number {
  requireCapability(database, principal, "account.change_role");
  if (!isRole(role)) {
    throw new InvalidInputError();
  }
  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "account.role.change",
      targetType: "account",
      targetId: id,
      summary: "Changed an account role",
      details: { role },
    },
    () => {
      const current = database
        .prepare("SELECT role, status, kind FROM accounts WHERE id = ?")
        .get(id);
      if (!current) {
        throw new InvalidInputError();
      }
      if (role === "owner" && current.kind !== "human")
        throw new InvalidInputError();
      if (
        current.role === "owner" &&
        current.status === "active" &&
        role !== "owner"
      ) {
        ensureAnotherActiveOwner(database, id);
      }
      return updateVersionedRow(database, "accounts", id, expectedVersion, {
        role,
      });
    },
  );
}

export function createHumanIdentity(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  accountId: string,
  provider: string,
  subject: string,
  operationId?: string,
): string {
  requireCapability(database, principal, "identity.create");
  // Identity attachment grants control of the target account. Only an owner can
  // attach a provider subject, and existing provider subjects cannot be relinked.
  requireCapability(database, principal, "account.change_role");
  if (!provider.trim() || provider === "agent-key" || !subject.trim()) {
    throw new InvalidInputError();
  }
  const id = newId();
  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "identity.create",
      targetType: "identity",
      targetId: id,
      summary: "Linked a human sign-in identity",
      details: { provider },
    },
    () => {
      const account = database
        .prepare("SELECT kind FROM accounts WHERE id = ? AND status = 'active'")
        .get(accountId);
      if (account?.kind !== "human") {
        throw new InvalidInputError();
      }
      if (
        database
          .prepare(
            "SELECT 1 FROM identities WHERE provider = ? AND subject = ?",
          )
          .get(provider, subject)
      )
        throw new InvalidInputError();
      database
        .prepare(
          `INSERT INTO identities (id, account_id, provider, subject)
           VALUES (?, ?, ?, ?)`,
        )
        .run(id, accountId, provider, subject);
      return id;
    },
  );
}

export function setAgentCapability(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  accountId: string,
  capability: string,
  granted: boolean,
): void {
  requireCapability(database, principal, "account.change_role");
  if (!isGrantableAgentCapability(capability)) throw new InvalidInputError();
  runAuditedMutation(
    database,
    { principal },
    {
      action: granted
        ? "account.capability.grant"
        : "account.capability.revoke",
      targetType: "account",
      targetId: accountId,
      summary: granted
        ? "Granted an agent capability"
        : "Revoked an agent capability",
      details: { capability },
    },
    () => {
      if (granted) {
        database
          .prepare(
            "INSERT INTO agent_capability_grants (id,account_id,capability,granted_by_account_id,granted_at) SELECT ?,id,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM accounts WHERE id=? AND kind='agent' AND status='active'",
          )
          .run(newId(), capability, principal.accountId, accountId);
      } else {
        database
          .prepare(
            "UPDATE agent_capability_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoked_by_account_id=? WHERE account_id=? AND capability=? AND revoked_at IS NULL",
          )
          .run(principal.accountId, accountId, capability);
      }
      return true;
    },
  );
}

export function listAgentCapabilities(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  accountId: string,
): readonly string[] {
  requireCapability(database, principal, "account.read");
  return database
    .prepare(
      "SELECT capability FROM agent_capability_grants WHERE account_id=? AND revoked_at IS NULL ORDER BY capability",
    )
    .all(accountId)
    .map((row) => String(row.capability));
}

export async function issueAgentCredential(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  accountId: string,
  expiresAt?: string | null,
  operationId?: string,
  now = new Date(),
): Promise<{ readonly identityId: string; readonly secret: string }> {
  requireCapability(database, principal, "identity.create");
  const expiry = parseFutureExpiry(expiresAt, now);
  const account = database
    .prepare("SELECT kind FROM accounts WHERE id = ? AND status = 'active'")
    .get(accountId);
  if (account?.kind !== "agent") {
    throw new InvalidInputError();
  }

  const credential = await createAgentCredential();
  const identityId = newId();
  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "identity.agent_key.issue",
      targetType: "identity",
      targetId: identityId,
      summary: "Issued an agent credential",
      details: { accountId, expiresAt: expiry },
    },
    () => {
      requireCapability(database, principal, "identity.create");
      const currentAccount = database
        .prepare("SELECT kind FROM accounts WHERE id = ? AND status = 'active'")
        .get(accountId);
      if (currentAccount?.kind !== "agent") {
        throw new InvalidInputError();
      }
      database
        .prepare(
          `INSERT INTO identities
             (id, account_id, provider, subject, credential_hash, expires_at)
           VALUES (?, ?, 'agent-key', ?, ?, ?)`,
        )
        .run(identityId, accountId, identityId, credential.hash, expiry);
      return { identityId, secret: credential.secret };
    },
  );
}

export function revokeIdentity(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  identityId: string,
  expectedVersion: number,
  now = new Date(),
  operationId?: string,
): number {
  requireCapability(database, principal, "identity.revoke");
  return runAuditedMutation(
    database,
    { principal, operationId },
    {
      action: "identity.revoke",
      targetType: "identity",
      targetId: identityId,
      summary: "Revoked an identity",
    },
    () => {
      const current = database
        .prepare(
          `SELECT i.revoked_at, i.account_id, a.kind, a.role, a.status
           FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.id = ?`,
        )
        .get(identityId);
      if (!current || current.revoked_at !== null) {
        throw new InvalidInputError();
      }
      if (
        current.kind === "human" &&
        current.role === "owner" &&
        current.status === "active"
      ) {
        const otherIdentityCount = database
          .prepare(
            `SELECT COUNT(*) AS count FROM identities
             WHERE account_id = ? AND id <> ? AND provider <> 'agent-key'
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .get(String(current.account_id), identityId)?.count;
        if (otherIdentityCount === 0)
          ensureAnotherActiveOwner(database, String(current.account_id));
      }
      return updateVersionedRow(
        database,
        "identities",
        identityId,
        expectedVersion,
        { revoked_at: now.toISOString() },
      );
    },
  );
}

export function validateAccountInput(input: NewAccount): void {
  if (
    !input ||
    (input.kind !== "human" && input.kind !== "agent") ||
    !isRole(input.role) ||
    typeof input.displayName !== "string" ||
    !input.displayName.trim() ||
    (input.email !== undefined &&
      input.email !== null &&
      (typeof input.email !== "string" || !input.email.trim()))
  ) {
    throw new InvalidInputError();
  }
}

export function parseFutureExpiry(
  value: string | null | undefined,
  now: Date,
): string | null {
  if (value == null) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new InvalidInputError();
  }
  return new Date(timestamp).toISOString();
}

function ensureAnotherActiveOwner(
  database: WebsiteDatabase,
  excludingId: string,
): void {
  const count = database
    .prepare(
      `SELECT COUNT(*) AS count FROM accounts a
       WHERE a.id <> ? AND a.role = 'owner' AND a.kind = 'human' AND a.status = 'active'
         AND EXISTS (SELECT 1 FROM identities i WHERE i.account_id = a.id
           AND i.provider <> 'agent-key' AND i.revoked_at IS NULL
           AND (i.expires_at IS NULL OR i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    )
    .get(excludingId)?.count;
  if (typeof count !== "number" || count < 1) {
    throw new InvalidInputError();
  }
}

function isRole(value: unknown): value is AccountRole {
  return (
    value === "contributor" ||
    value === "editor" ||
    value === "administrator" ||
    value === "owner"
  );
}

import type { WebsiteDatabase } from "../database/sqlite.js";
import { updateVersionedRow } from "../database/versioned-writes.js";
import { runAuditedMutation } from "./audit.js";
import {
  type AccountKind,
  type AccountRole,
  createAgentCredential,
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
  readonly displayName: string;
  readonly version: number;
}

export function getAccount(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  id: string,
): AccountSummary | null {
  requireCapability(database, principal, "account.read");
  const row = database
    .prepare(
      `SELECT id, kind, role, status, display_name, version
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
  },
  operationId?: string,
): number {
  requireCapability(database, principal, "account.update");
  const values: Record<string, string | null> = {};
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
        .prepare("SELECT role, status FROM accounts WHERE id = ?")
        .get(id);
      if (!current) {
        throw new InvalidInputError();
      }
      if (
        current.role === "owner" &&
        current.status === "active" &&
        values.status === "disabled"
      ) {
        ensureAnotherActiveOwner(database);
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
        .prepare("SELECT role, status FROM accounts WHERE id = ?")
        .get(id);
      if (!current) {
        throw new InvalidInputError();
      }
      if (
        current.role === "owner" &&
        current.status === "active" &&
        role !== "owner"
      ) {
        ensureAnotherActiveOwner(database);
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
        .prepare("SELECT revoked_at FROM identities WHERE id = ?")
        .get(identityId);
      if (!current || current.revoked_at !== null) {
        throw new InvalidInputError();
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

function validateAccountInput(input: NewAccount): void {
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

function parseFutureExpiry(
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

function ensureAnotherActiveOwner(database: WebsiteDatabase): void {
  const count = database
    .prepare(
      "SELECT COUNT(*) AS count FROM accounts WHERE role = 'owner' AND status = 'active'",
    )
    .get()?.count;
  if (typeof count !== "number" || count <= 1) {
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

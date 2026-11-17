import type { AsyncD1Database } from "../database/d1.js";
import {
  type AccountDetails,
  type AccountFilter,
  type AccountSummary,
  InvalidInputError,
  type NewAccount,
  parseFutureExpiry,
  validateAccountInput,
} from "./accounts.js";
import { type AuditRecord, assertCredentialFree } from "./audit.js";
import {
  type AccountRole,
  AGENT_KEY_PATTERN,
  AuthorizationError,
  createAgentCredential,
  type HumanIdentityAdapter,
  hashCredential,
  isAccountKind,
  isAccountRole,
  isGrantableAgentCapability,
  makeTrustedPrincipal,
  newId,
  roleHasCapability,
  type TrustedPrincipal,
} from "./security.js";

type Row = Record<string, unknown>;
const MAX_ACCOUNT_PAGE_SIZE = 100;
const MAX_IDENTITY_ROWS = 1_000;

/** Asynchronous D1 implementation of the existing account service contract. */
export function createD1AccountServices(
  database: AsyncD1Database,
  humanIdentityAdapter?: HumanIdentityAdapter,
  now: () => Date = () => new Date(),
) {
  async function hasCapability(
    principal: TrustedPrincipal | null,
    capability: string,
  ): Promise<boolean> {
    if (!principal) return false;
    const granted =
      principal.kind === "agent" &&
      isGrantableAgentCapability(capability) &&
      !roleHasCapability(principal.role, capability);
    if (!granted && !roleHasCapability(principal.role, capability))
      return false;
    const row = await database.first<Row>(
      `SELECT a.kind, a.role, a.status, i.expires_at
       FROM accounts a JOIN identities i ON i.account_id = a.id
       WHERE a.id = ? AND i.id = ? AND i.provider = ?
         AND i.revoked_at IS NULL`,
      [principal.accountId, principal.identityId, principal.provider],
    );
    if (!rowIsCurrent(row, principal, now())) return false;
    if (!granted) return true;
    const grant = await database.first<Row>(
      `SELECT 1 AS granted FROM agent_capability_grants
       WHERE account_id = ? AND capability = ? AND revoked_at IS NULL`,
      [principal.accountId, capability],
    );
    return !!grant;
  }

  async function requireCapability(
    principal: TrustedPrincipal,
    capability: string,
  ): Promise<void> {
    if (!(await hasCapability(principal, capability)))
      throw new AuthorizationError();
  }

  async function resolvePrincipal(
    request: Request,
  ): Promise<TrustedPrincipal | null> {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      const match = /^Bearer (cwa_[A-Za-z0-9_-]{43})$/.exec(authorization);
      if (!match?.[1] || !AGENT_KEY_PATTERN.test(match[1])) return null;
      const credentialHash = await hashCredential(match[1]);
      const row = await database.first<Row>(
        `SELECT a.id, a.kind, a.role, i.id identity_id, i.expires_at
         FROM identities i JOIN accounts a ON a.id = i.account_id
         WHERE i.provider = 'agent-key' AND i.credential_hash = ?
           AND i.revoked_at IS NULL AND a.status = 'active'`,
        [credentialHash],
      );
      if (!row || !validPrincipalRow(row, now())) return null;
      return makeTrustedPrincipal(row, "agent-key");
    }

    // Only the injected hosting adapter may return a verified identity. The
    // D1 service never promotes arbitrary request headers to a human claim,
    // and a human claim can only resolve to a human account.
    const claim = await humanIdentityAdapter?.resolve(request);
    if (!claim?.provider.trim() || !claim.subject.trim()) return null;
    const row = await database.first<Row>(
      `SELECT a.id, a.kind, a.role, i.id identity_id, i.expires_at
       FROM identities i JOIN accounts a ON a.id = i.account_id
       WHERE i.provider = ? AND i.subject = ? AND i.credential_hash IS NULL
         AND i.revoked_at IS NULL AND a.status = 'active' AND a.kind = 'human'`,
      [claim.provider, claim.subject],
    );
    if (!row || !validPrincipalRow(row, now())) return null;
    return makeTrustedPrincipal(row, claim.provider);
  }

  async function getOwnAccount(
    principal: TrustedPrincipal,
  ): Promise<AccountSummary> {
    if (!(await isCurrentPrincipal(principal))) throw new InvalidInputError();
    const account = await accountSummary(principal.accountId);
    if (!account) throw new InvalidInputError();
    return account;
  }

  async function getAccount(
    principal: TrustedPrincipal,
    id: string,
  ): Promise<AccountSummary | null> {
    await requireCapability(principal, "account.read");
    return accountSummary(id);
  }

  async function getAccountDetails(
    principal: TrustedPrincipal,
    id: string,
  ): Promise<AccountDetails | null> {
    await requireCapability(principal, "account.read");
    const row = await database.first<Row>(
      `SELECT id,kind,role,status,display_name,email,preferences,version
       FROM accounts WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    const summary = parseAccountSummary(row);
    let preferences: unknown;
    try {
      preferences = JSON.parse(str(row.preferences));
    } catch {
      throw new Error("Invalid account preferences");
    }
    if (
      !preferences ||
      typeof preferences !== "object" ||
      Array.isArray(preferences)
    )
      throw new Error("Invalid account preferences");
    const identities = await database.all<Row>(
      `SELECT id,provider,subject,expires_at,revoked_at,version
       FROM identities WHERE account_id = ? ORDER BY created_at,id`,
      MAX_IDENTITY_ROWS,
      [id],
    );
    if (identities.length === MAX_IDENTITY_ROWS)
      throw new Error("Account identity list exceeds its safety bound");
    return {
      ...summary,
      email: row.email === null ? null : str(row.email),
      preferences: preferences as Record<string, unknown>,
      identities: identities.map((identity) => ({
        id: str(identity.id),
        provider: str(identity.provider),
        subject: str(identity.subject),
        expiresAt: nullable(identity.expires_at),
        revokedAt: nullable(identity.revoked_at),
        version: num(identity.version),
      })),
    };
  }

  async function listAccounts(
    principal: TrustedPrincipal,
    filter: AccountFilter = {},
  ) {
    await requireCapability(principal, "account.read");
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
      (filter.role !== undefined && !isAccountRole(filter.role)) ||
      (filter.status !== undefined &&
        filter.status !== "active" &&
        filter.status !== "disabled" &&
        filter.status !== "archived") ||
      (filter.afterId !== undefined &&
        (filter.afterId.length < 1 || filter.afterId.length > 128))
    )
      throw new InvalidInputError();
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (filter.status !== "archived") conditions.push("status <> 'archived'");
    if (filter.query) {
      conditions.push(
        "(display_name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')",
      );
      const query = `%${filter.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      values.push(query, query);
    }
    if (filter.kind) {
      conditions.push("kind = ?");
      values.push(filter.kind);
    }
    if (filter.role) {
      conditions.push("role = ?");
      values.push(filter.role);
    }
    if (filter.status) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter.afterId) {
      conditions.push("id > ?");
      values.push(filter.afterId);
    }
    const rows = await database.all<Row>(
      `SELECT id,kind,role,status,display_name,version FROM accounts
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY id LIMIT ?`,
      limit + 1,
      [...values, limit + 1],
    );
    return {
      accounts: rows.slice(0, limit).map(parseAccountSummary),
      nextAfterId: rows.length > limit ? str(rows[limit - 1]?.id) : null,
    };
  }

  async function createAccount(
    principal: TrustedPrincipal,
    input: NewAccount,
    operationId?: string,
  ): Promise<AccountSummary> {
    await requireCapability(principal, "account.create");
    validateAccountInput(input);
    if (input.kind === "agent" && input.role === "owner")
      throw new InvalidInputError();
    if (
      input.role === "owner" ||
      input.role === "administrator" ||
      (input.kind === "human" && input.role !== "contributor") ||
      (input.kind === "agent" && input.role === "editor")
    ) {
      await requireCapability(principal, "account.change_role");
    }
    const id = newId();
    const displayName = input.displayName.trim();
    await auditedBatch(
      principal,
      "account.create",
      "account",
      id,
      "Created an account",
      { kind: input.kind, role: input.role },
      [
        database.prepare(
          "UPDATE identities SET revoked_at=?,version=version+1,updated_at=? WHERE account_id=? AND provider='agent-key' AND revoked_at IS NULL",
          [now().toISOString(), now().toISOString(), id],
        ),
        database.prepare(
          "UPDATE agent_capability_grants SET revoked_at=?,revoked_by_account_id=? WHERE account_id=? AND revoked_at IS NULL",
          [now().toISOString(), principal.accountId, id],
        ),
        database.prepare(
          `INSERT INTO accounts (id,kind,role,display_name,email) VALUES (?,?,?,?,?)`,
          [
            id,
            input.kind,
            input.role,
            displayName,
            input.email?.trim() ?? null,
          ],
        ),
        assertOneChange(`account:${id}`),
      ],
      operationId,
      "account.create",
    );
    return {
      id,
      kind: input.kind,
      role: input.role,
      status: "active",
      displayName,
      version: 1,
    };
  }

  async function updateAccount(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    changes: {
      readonly displayName?: string;
      readonly email?: string | null;
      readonly status?: "active" | "disabled" | "archived";
      readonly preferences?: Readonly<Record<string, unknown>>;
    },
    operationId?: string,
  ): Promise<number> {
    await requireCapability(principal, "account.update");
    const values: Record<string, string | null> = {};
    if (changes.displayName !== undefined) {
      if (!changes.displayName.trim()) throw new InvalidInputError();
      values.display_name = changes.displayName.trim();
    }
    if (changes.email !== undefined) {
      if (changes.email !== null && !changes.email.trim())
        throw new InvalidInputError();
      values.email = changes.email?.trim() ?? null;
    }
    if (changes.status !== undefined) {
      if (
        changes.status !== "active" &&
        changes.status !== "disabled" &&
        changes.status !== "archived"
      )
        throw new InvalidInputError();
      values.status = changes.status;
    }
    if (changes.preferences !== undefined) {
      if (
        !changes.preferences ||
        typeof changes.preferences !== "object" ||
        Array.isArray(changes.preferences)
      )
        throw new InvalidInputError();
      const encoded = JSON.stringify(changes.preferences);
      if (encoded.length > 4096) throw new InvalidInputError();
      values.preferences = encoded;
    }
    const fields = Object.keys(values).sort();
    if (!fields.length || !validExpectedVersion(expectedVersion))
      throw new InvalidInputError();
    const assignments = fields.map((field) => `"${field}" = ?`).join(", ");
    const bound = fields.map((field) => values[field] ?? null);
    await auditedBatch(
      principal,
      "account.update",
      "account",
      id,
      "Updated an account",
      { fields: fields.join(",") },
      [
        database.prepare(
          `UPDATE accounts SET ${assignments},version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?
           AND NOT (role='owner' AND status='active' AND ?='disabled' AND NOT EXISTS
             (SELECT 1 FROM accounts other WHERE other.id<>accounts.id AND other.kind='human' AND other.role='owner' AND other.status='active'
               AND EXISTS (SELECT 1 FROM identities oi WHERE oi.account_id=other.id AND oi.provider<>'agent-key' AND oi.revoked_at IS NULL
                 AND (oi.expires_at IS NULL OR oi.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))`,
          [...bound, id, expectedVersion, values.status ?? ""],
        ),
        assertOneChange(`account:${id}`),
      ],
      operationId,
      "account.update",
    );
    return expectedVersion + 1;
  }

  async function changeAccountRole(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    role: AccountRole,
    operationId?: string,
  ): Promise<number> {
    await requireCapability(principal, "account.change_role");
    if (!isAccountRole(role) || !validExpectedVersion(expectedVersion))
      throw new InvalidInputError();
    const result = await database.all<Row>(
      `SELECT version FROM accounts WHERE id=? AND version=? AND (?<>'owner' OR kind='human')`,
      1,
      [id, expectedVersion, role],
    );
    if (!result.length) throw new InvalidInputError();
    const version = num(result[0]?.version) + 1;
    await auditedBatch(
      principal,
      "account.role.change",
      "account",
      id,
      "Changed an account role",
      { role },
      [
        database.prepare(
          `UPDATE accounts SET role=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND version=? AND (?<>'owner' OR kind='human')
         AND NOT (role='owner' AND status='active' AND ?<>'owner' AND NOT EXISTS
           (SELECT 1 FROM accounts other WHERE other.id<>accounts.id AND other.kind='human' AND other.role='owner' AND other.status='active'
             AND EXISTS (SELECT 1 FROM identities oi WHERE oi.account_id=other.id AND oi.provider<>'agent-key' AND oi.revoked_at IS NULL
               AND (oi.expires_at IS NULL OR oi.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))`,
          [role, id, expectedVersion, role, role],
        ),
        assertOneChange(`account:${id}`),
      ],
      operationId,
      "account.change_role",
    );
    return version;
  }

  async function createHumanIdentity(
    principal: TrustedPrincipal,
    accountId: string,
    provider: string,
    subject: string,
    operationId?: string,
  ): Promise<string> {
    await requireCapability(principal, "identity.create");
    await requireCapability(principal, "account.change_role");
    if (!provider.trim() || provider === "agent-key" || !subject.trim())
      throw new InvalidInputError();
    const id = newId();
    await auditedBatch(
      principal,
      "identity.create",
      "identity",
      id,
      "Linked a human sign-in identity",
      { provider },
      [
        database.prepare(
          `INSERT INTO identities (id,account_id,provider,subject)
         SELECT ?,id,?,? FROM accounts WHERE id=? AND kind='human' AND status='active'
           AND NOT EXISTS (SELECT 1 FROM identities WHERE provider=? AND subject=?)`,
          [id, provider, subject, accountId, provider, subject],
        ),
        assertOneChange(`identity:${id}`),
      ],
      operationId,
      "identity.create",
    );
    return id;
  }

  async function issueAgentCredential(
    principal: TrustedPrincipal,
    accountId: string,
    expiresAt?: string | null,
    operationId?: string,
  ): Promise<{ readonly identityId: string; readonly secret: string }> {
    await requireCapability(principal, "identity.create");
    const expiry = parseFutureExpiry(expiresAt, now());
    const credential = await createAgentCredential();
    const identityId = newId();
    await auditedBatch(
      principal,
      "identity.agent_key.issue",
      "identity",
      identityId,
      "Issued an agent credential",
      { accountId, expiresAt: expiry },
      [
        database.prepare(
          `INSERT INTO identities (id,account_id,provider,subject,credential_hash,expires_at)
           SELECT ?,id,'agent-key',?,?,? FROM accounts WHERE id=? AND kind='agent' AND status='active'`,
          [identityId, identityId, credential.hash, expiry, accountId],
        ),
        assertOneChange(`identity:${identityId}`),
      ],
      operationId,
      "identity.create",
    );
    return { identityId, secret: credential.secret };
  }

  async function setAgentCapability(
    principal: TrustedPrincipal,
    accountId: string,
    capability: string,
    granted: boolean,
    operationId?: string,
  ): Promise<void> {
    await requireCapability(principal, "account.change_role");
    if (!isGrantableAgentCapability(capability) || !accountId.trim())
      throw new InvalidInputError();
    const id = newId();
    const at = now().toISOString();
    await auditedBatch(
      principal,
      granted ? "account.capability.grant" : "account.capability.revoke",
      "account",
      accountId,
      granted ? "Granted an agent capability" : "Revoked an agent capability",
      { capability },
      [
        granted
          ? database.prepare(
              `INSERT INTO agent_capability_grants (id,account_id,capability,granted_by_account_id,granted_at)
               SELECT ?,id,?,?,? FROM accounts WHERE id=? AND kind='agent' AND status='active'
                 AND NOT EXISTS (SELECT 1 FROM agent_capability_grants g WHERE g.account_id=accounts.id AND g.capability=? AND g.revoked_at IS NULL)`,
              [id, capability, principal.accountId, at, accountId, capability],
            )
          : database.prepare(
              `UPDATE agent_capability_grants SET revoked_at=?,revoked_by_account_id=?
               WHERE account_id=? AND capability=? AND revoked_at IS NULL`,
              [at, principal.accountId, accountId, capability],
            ),
        assertOneChange(`capability:${accountId}:${capability}`),
      ],
      operationId,
      "account.change_role",
    );
  }

  async function listAgentCapabilities(
    principal: TrustedPrincipal,
    accountId: string,
  ): Promise<readonly string[]> {
    await requireCapability(principal, "account.read");
    const rows = await database.all<Row>(
      `SELECT capability FROM agent_capability_grants
       WHERE account_id=? AND revoked_at IS NULL ORDER BY capability`,
      10,
      [accountId],
    );
    return rows.map((row) => String(row.capability));
  }

  async function revokeIdentity(
    principal: TrustedPrincipal,
    identityId: string,
    expectedVersion: number,
    operationId?: string,
  ): Promise<number> {
    await requireCapability(principal, "identity.revoke");
    if (!validExpectedVersion(expectedVersion)) throw new InvalidInputError();
    const rows = await database.all<Row>(
      `SELECT i.account_id,i.version,a.kind,a.role,a.status FROM identities i JOIN accounts a ON a.id=i.account_id
       WHERE i.id=? AND i.version=? AND i.revoked_at IS NULL`,
      1,
      [identityId, expectedVersion],
    );
    if (!rows[0]) throw new InvalidInputError();
    const row = rows[0];
    const ownerSafe =
      row.kind !== "human" ||
      row.role !== "owner" ||
      row.status !== "active" ||
      (await hasAnotherActiveOwner(String(row.account_id), identityId));
    if (!ownerSafe) throw new InvalidInputError();
    const version = num(row.version) + 1;
    await auditedBatch(
      principal,
      "identity.revoke",
      "identity",
      identityId,
      "Revoked an identity",
      {},
      [
        database.prepare(
          `UPDATE identities SET revoked_at=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND version=? AND revoked_at IS NULL AND (?=0 OR EXISTS
           (SELECT 1 FROM accounts owner WHERE owner.id=identities.account_id AND owner.kind='human' AND owner.role='owner' AND owner.status='active'
             AND EXISTS (SELECT 1 FROM identities oi WHERE oi.account_id=owner.id AND oi.id<>identities.id AND oi.provider<>'agent-key' AND oi.revoked_at IS NULL
               AND (oi.expires_at IS NULL OR oi.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))`,
          [now().toISOString(), identityId, expectedVersion, ownerSafe ? 0 : 1],
        ),
        assertOneChange(`identity:${identityId}`),
      ],
      operationId,
      "identity.revoke",
    );
    return version;
  }

  async function archiveAccount(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    operationId?: string,
  ): Promise<number> {
    await requireCapability(principal, "account.change_role");
    if (!validExpectedVersion(expectedVersion)) throw new InvalidInputError();
    const rows = await database.all<Row>(
      "SELECT kind,status,version FROM accounts WHERE id=? AND version=?",
      1,
      [id, expectedVersion],
    );
    const row = rows[0];
    if (!row || row.kind !== "agent" || row.status === "archived")
      throw new InvalidInputError();
    const version = num(row.version) + 1;
    await auditedBatch(
      principal,
      "account.archive",
      "account",
      id,
      "Archived an unused agent account",
      {},
      [
        database.prepare(
          "UPDATE identities SET revoked_at=?,version=version+1,updated_at=? WHERE account_id=? AND provider='agent-key' AND revoked_at IS NULL",
          [now().toISOString(), now().toISOString(), id],
        ),
        database.prepare(
          "UPDATE agent_capability_grants SET revoked_at=?,revoked_by_account_id=? WHERE account_id=? AND revoked_at IS NULL",
          [now().toISOString(), principal.accountId, id],
        ),
        database.prepare(
          "UPDATE accounts SET status='archived',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? AND kind='agent' AND status<>'archived'",
          [id, expectedVersion],
        ),
        assertOneChange(`account:${id}`),
      ],
      operationId,
      "account.change_role",
    );
    return version;
  }

  async function createOperation(
    principal: TrustedPrincipal,
    kind: string,
    id = newId(),
  ): Promise<string> {
    await requireCapability(principal, "operation.create");
    if (!kind.trim() || !id.trim()) throw new Error("Invalid operation input");
    await auditedBatch(
      principal,
      "operation.create",
      "operation",
      id,
      "Created an operation",
      { kind },
      [
        database.prepare(
          "INSERT INTO operations (id,kind,created_by_account_id) VALUES (?,?,?)",
          [id, kind.trim(), principal.accountId],
        ),
        assertOneChange(`operation:${id}`),
      ],
      id,
      "operation.create",
    );
    return id;
  }

  async function listAuditEvents(
    principal: TrustedPrincipal,
    limit = 100,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    await requireCapability(principal, "audit.read");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Audit page size must be between 1 and 100");
    return database.all<Row>(
      `SELECT id,actor_account_id,operation_id,action,target_type,target_id,summary,details_json,created_at
       FROM audit_events ORDER BY created_at DESC,id DESC LIMIT ?`,
      limit,
      [limit],
    );
  }

  async function isCurrentPrincipal(
    principal: TrustedPrincipal,
  ): Promise<boolean> {
    const row = await database.first<Row>(
      `SELECT a.kind,a.role,a.status,i.expires_at FROM accounts a JOIN identities i ON i.account_id=a.id
       WHERE a.id=? AND i.id=? AND i.provider=? AND i.revoked_at IS NULL`,
      [principal.accountId, principal.identityId, principal.provider],
    );
    return rowIsCurrent(row, principal, now());
  }

  async function accountSummary(id: string): Promise<AccountSummary | null> {
    const row = await database.first<Row>(
      "SELECT id,kind,role,status,display_name,version FROM accounts WHERE id=?",
      [id],
    );
    return row ? parseAccountSummary(row) : null;
  }

  async function hasAnotherActiveOwner(
    accountId: string,
    identityId: string,
  ): Promise<boolean> {
    const row = await database.first<Row>(
      `SELECT 1 found FROM identities i JOIN accounts a ON a.id=i.account_id
       WHERE a.id=? AND i.id<>? AND a.kind='human' AND a.role='owner' AND a.status='active'
         AND i.provider<>'agent-key' AND i.revoked_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 1`,
      [accountId, identityId],
    );
    if (row) return true;
    const count = await database.first<Row>(
      `SELECT COUNT(*) count FROM accounts a WHERE a.id<>? AND a.kind='human' AND a.role='owner' AND a.status='active'
       AND EXISTS (SELECT 1 FROM identities i WHERE i.account_id=a.id AND i.provider<>'agent-key' AND i.revoked_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
      [accountId],
    );
    return num(count?.count) > 0;
  }

  async function auditedBatch(
    principal: TrustedPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    summary: string,
    details: AuditRecord["details"],
    statements: readonly import("../database/d1.js").D1BatchStatement[],
    operationId: string | undefined,
    capability: string,
  ): Promise<void> {
    await requireCapability(principal, capability);
    const generation = await database.readDependencyGeneration();
    const audit: AuditRecord = {
      action,
      targetType,
      targetId,
      summary,
      details,
    };
    assertCredentialFree(audit);
    const auditInsert = database.prepare(
      `INSERT INTO audit_events (id,actor_account_id,operation_id,action,target_type,target_id,summary,details_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        newId(),
        principal.accountId,
        operationId ?? null,
        action,
        targetType,
        targetId,
        summary,
        JSON.stringify(details ?? {}),
      ],
    );
    await database.guardedBatch(generation, principal, [
      ...statements,
      auditInsert,
    ]);
  }

  function assertOneChange(id: string) {
    return database.prepare(
      "INSERT INTO website_write_assertions (id,valid) VALUES (?,changes())",
      [id],
    );
  }

  return {
    resolvePrincipal,
    hasCapability,
    createAccount,
    getAccount,
    getOwnAccount,
    getAccountDetails,
    listAccounts,
    updateAccount,
    changeAccountRole,
    createHumanIdentity,
    issueAgentCredential,
    setAgentCapability,
    archiveAccount,
    listAgentCapabilities,
    revokeIdentity,
    createOperation,
    listAuditEvents,
  };
}

function validPrincipalRow(row: Row, currentTime: Date): boolean {
  if (
    !isAccountKind(row.kind) ||
    !isAccountRole(row.role) ||
    (typeof row.expires_at !== "string" && row.expires_at !== null)
  )
    return false;
  return (
    row.expires_at === null ||
    Date.parse(row.expires_at) > currentTime.getTime()
  );
}

function rowIsCurrent(
  row: Row | null,
  principal: TrustedPrincipal,
  currentTime: Date,
): boolean {
  return (
    !!row &&
    row.status === "active" &&
    row.kind === principal.kind &&
    row.role === principal.role &&
    validPrincipalRow(row, currentTime)
  );
}

function parseAccountSummary(row: Row): AccountSummary {
  if (
    !isAccountKind(row.kind) ||
    !isAccountRole(row.role) ||
    (row.status !== "active" &&
      row.status !== "disabled" &&
      row.status !== "archived") ||
    typeof row.display_name !== "string"
  )
    throw new Error("Invalid account record");
  return {
    id: str(row.id),
    kind: row.kind,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    version: num(row.version),
  };
}

function validExpectedVersion(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function str(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid Website string field");
  return value;
}

function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Invalid Website numeric field");
  return value;
}

function nullable(value: unknown): string | null {
  return value === null ? null : str(value);
}

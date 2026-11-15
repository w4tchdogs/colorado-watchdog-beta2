import type { WebsiteDatabase } from "../database/sqlite.js";

export type Capability =
  | "content.publish"
  | "d1.inspect"
  | "account.read"
  | "account.create"
  | "account.update"
  | "account.change_role"
  | "identity.create"
  | "identity.revoke"
  | "audit.read"
  | "operation.create"
  | "checkpoint.create"
  | "checkpoint.verify"
  | "checkpoint.read"
  | "checkpoint.prune"
  | "sync.read"
  | "sync.apply"
  | "sync.revert"
  | "banner.manage"
  | "report.review";

export type AccountKind = "human" | "agent";
export type AccountRole = "contributor" | "editor" | "administrator" | "owner";

const principalBrand: unique symbol = Symbol("trusted-principal");

export interface TrustedPrincipal {
  readonly [principalBrand]: true;
  readonly accountId: string;
  readonly identityId: string;
  readonly kind: AccountKind;
  readonly role: AccountRole;
  readonly provider: string;
}

export interface HumanIdentityClaim {
  readonly provider: string;
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface HumanIdentityAdapter {
  resolve(request: Request): Promise<HumanIdentityClaim | null>;
}

export class AuthorizationError extends Error {
  constructor() {
    super("The principal is not authorized for this capability");
    this.name = "AuthorizationError";
  }
}

const ROLE_CAPABILITIES: Readonly<
  Record<AccountRole, readonly Exclude<Capability, "checkpoint.prune">[]>
> = {
  contributor: [],
  editor: ["report.review", "content.publish"],
  administrator: [
    "d1.inspect",
    "account.read",
    "account.create",
    "account.update",
    "identity.create",
    "identity.revoke",
    "audit.read",
    "operation.create",
    "checkpoint.create",
    "checkpoint.verify",
    "checkpoint.read",
    "banner.manage",
    "content.publish",
    "report.review",
  ],
  owner: [
    "d1.inspect",
    "account.read",
    "account.create",
    "account.update",
    "account.change_role",
    "identity.create",
    "identity.revoke",
    "audit.read",
    "operation.create",
    "checkpoint.create",
    "checkpoint.verify",
    "checkpoint.read",
    "banner.manage",
    "content.publish",
    "report.review",
  ],
};

/** Shared role policy for synchronous SQL.js and asynchronous host adapters. */
export function roleHasCapability(
  role: AccountRole,
  capability: string,
): boolean {
  return (
    capability !== "checkpoint.prune" &&
    ROLE_CAPABILITIES[role].includes(
      capability as Exclude<Capability, "checkpoint.prune">,
    )
  );
}

const AGENT_KEY_PREFIX = "cwa_";
export const AGENT_KEY_PATTERN = /^cwa_[A-Za-z0-9_-]{43}$/;

export async function resolvePrincipal(
  database: WebsiteDatabase,
  request: Request,
  humanIdentityAdapter?: HumanIdentityAdapter,
  now = new Date(),
): Promise<TrustedPrincipal | null> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer (cwa_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) {
      return null;
    }

    const presentedCredential = match[1];
    if (!presentedCredential) {
      return null;
    }
    const credentialHash = await hashCredential(presentedCredential);
    const row = database
      .prepare(
        `SELECT accounts.id, accounts.kind, accounts.role,
                identities.id AS identity_id, identities.expires_at
         FROM identities
         JOIN accounts ON accounts.id = identities.account_id
         WHERE identities.provider = 'agent-key'
           AND identities.credential_hash = ?
           AND identities.revoked_at IS NULL
           AND accounts.status = 'active'`,
      )
      .get(credentialHash);
    if (!row || !isAccountKind(row.kind) || !isAccountRole(row.role)) {
      return null;
    }
    if (!hasUnexpiredIdentity(row.expires_at, now)) {
      return null;
    }

    return makeTrustedPrincipal(row, "agent-key");
  }

  const claim = await humanIdentityAdapter?.resolve(request);
  if (!claim?.provider.trim() || !claim.subject.trim()) {
    return null;
  }
  const row = database
    .prepare(
      `      SELECT accounts.id, accounts.kind, accounts.role,
                identities.id AS identity_id, identities.expires_at
       FROM identities
       JOIN accounts ON accounts.id = identities.account_id
       WHERE identities.provider = ?
         AND identities.subject = ?
         AND identities.credential_hash IS NULL
         AND identities.revoked_at IS NULL
         AND accounts.status = 'active'`,
    )
    .get(claim.provider, claim.subject);
  if (!row || !isAccountKind(row.kind) || !isAccountRole(row.role)) {
    return null;
  }
  if (!hasUnexpiredIdentity(row.expires_at, now)) {
    return null;
  }
  return makeTrustedPrincipal(row, claim.provider);
}

export function hasCapability(
  database: WebsiteDatabase,
  principal: TrustedPrincipal | null,
  capability: string,
): principal is TrustedPrincipal {
  if (
    principal?.[principalBrand] !== true ||
    capability === "checkpoint.prune"
  ) {
    return false;
  }
  const current = database
    .prepare(
      `SELECT accounts.kind, accounts.role, identities.expires_at
       FROM identities
       JOIN accounts ON accounts.id = identities.account_id
       WHERE accounts.id = ? AND identities.id = ?
         AND identities.provider = ? AND identities.revoked_at IS NULL
         AND accounts.status = 'active'`,
    )
    .get(principal.accountId, principal.identityId, principal.provider);
  return (
    !!current &&
    isAccountKind(current.kind) &&
    isAccountRole(current.role) &&
    hasUnexpiredIdentity(current.expires_at, new Date()) &&
    current.kind === principal.kind &&
    current.role === principal.role &&
    roleHasCapability(current.role, capability)
  );
}

/**
 * Rechecks that the principal still names an active account and an unrevoked,
 * unexpired identity with the same kind and role. Grants no capability.
 */
export function isCurrentPrincipal(
  database: WebsiteDatabase,
  principal: TrustedPrincipal | null,
): principal is TrustedPrincipal {
  if (principal?.[principalBrand] !== true) {
    return false;
  }
  const current = database
    .prepare(
      `SELECT accounts.kind, accounts.role, identities.expires_at
       FROM identities
       JOIN accounts ON accounts.id = identities.account_id
       WHERE accounts.id = ? AND identities.id = ?
         AND identities.provider = ? AND identities.revoked_at IS NULL
         AND accounts.status = 'active'`,
    )
    .get(principal.accountId, principal.identityId, principal.provider);
  return (
    !!current &&
    isAccountKind(current.kind) &&
    isAccountRole(current.role) &&
    hasUnexpiredIdentity(current.expires_at, new Date()) &&
    current.kind === principal.kind &&
    current.role === principal.role
  );
}

export function requireCapability(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  capability: Capability,
): void {
  if (!hasCapability(database, principal, capability)) {
    throw new AuthorizationError();
  }
}

export function createTestHumanIdentityAdapter(
  subjects: Readonly<Record<string, string>>,
): HumanIdentityAdapter {
  return {
    async resolve(request) {
      const presentedSubject = request.headers.get("x-test-human-subject");
      if (!presentedSubject || !Object.hasOwn(subjects, presentedSubject)) {
        return null;
      }
      const subject = subjects[presentedSubject];
      if (!subject) {
        return null;
      }
      return {
        provider: "test-human",
        subject,
      };
    },
  };
}

export async function createAgentCredential(): Promise<{
  readonly secret: string;
  readonly hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const secret = `${AGENT_KEY_PREFIX}${encoded}`;
  if (!AGENT_KEY_PATTERN.test(secret)) {
    throw new Error("Could not generate an agent credential");
  }
  return { secret, hash: await hashCredential(secret) };
}

function hasUnexpiredIdentity(expiresAt: unknown, now: Date): boolean {
  if (expiresAt === null) {
    return true;
  }
  if (typeof expiresAt !== "string") {
    return false;
  }
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

export async function hashCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function makeTrustedPrincipal(
  row: Record<string, unknown>,
  provider: string,
): TrustedPrincipal {
  if (
    typeof row.id !== "string" ||
    typeof row.identity_id !== "string" ||
    !isAccountKind(row.kind) ||
    !isAccountRole(row.role)
  ) {
    throw new Error("Invalid account record");
  }
  return Object.freeze({
    [principalBrand]: true as const,
    accountId: row.id,
    identityId: row.identity_id,
    kind: row.kind,
    role: row.role,
    provider,
  });
}

export function isAccountKind(value: unknown): value is AccountKind {
  return value === "human" || value === "agent";
}

export function isAccountRole(value: unknown): value is AccountRole {
  return (
    value === "contributor" ||
    value === "editor" ||
    value === "administrator" ||
    value === "owner"
  );
}

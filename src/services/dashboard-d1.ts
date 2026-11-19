import {
  DASHBOARD_GROUP_LABELS,
  DASHBOARD_MODULES,
  type DashboardAccountSummary,
  type DashboardModuleDefinition,
  type DashboardModuleId,
  type DashboardModuleLink,
  type DashboardSession,
  type DashboardSignInMethod,
  type DashboardView,
} from "../contracts/dashboard.js";
import type { AsyncD1Database } from "../database/d1.js";
import {
  DashboardViewNotFoundError,
  providerLabel,
  ROLE_LABELS,
} from "./dashboard.js";
import {
  AuthorizationError,
  isAccountRole,
  type TrustedPrincipal,
} from "./security.js";

/**
 * Hosted dashboard service over the asynchronous Website D1.
 *
 * It uses the same module registry and the same role matrix as the local
 * dashboard service. Every answer is derived from the live principal on each
 * call, nothing is cached or written, and no caller input selects an account.
 *
 * Only modules whose hosted dependencies are verified are offered. A registry
 * module that is active locally but not hosted is reported as planned, so its
 * navigation, view and data stay closed to every role until it is added to
 * `HOSTED_DASHBOARD_MODULES`.
 */
export const HOSTED_DASHBOARD_MODULES: ReadonlySet<DashboardModuleId> =
  new Set<DashboardModuleId>([
    "overview",
    "account",
    "posts",
    "banners",
    "profiles",
    "county-structure",
  ]);

export interface HostedDashboardAccounts {
  hasCapability(
    principal: TrustedPrincipal | null,
    capability: string,
  ): Promise<boolean>;
  /** Throws unless the principal is a current, active account. */
  getOwnAccount(principal: TrustedPrincipal): Promise<unknown>;
}

type Row = Record<string, unknown>;
const MAX_SIGN_IN_ROWS = 20;

export function createD1DashboardService(
  database: AsyncD1Database,
  accounts: HostedDashboardAccounts,
  hosted: ReadonlySet<DashboardModuleId> = HOSTED_DASHBOARD_MODULES,
) {
  async function isHuman(principal: TrustedPrincipal): Promise<boolean> {
    if (principal.kind !== "human") return false;
    try {
      await accounts.getOwnAccount(principal);
      return true;
    } catch {
      return false;
    }
  }

  async function allows(
    principal: TrustedPrincipal,
    module: DashboardModuleDefinition,
  ): Promise<boolean> {
    if (module.access.kind === "signed-in") return isHuman(principal);
    return (
      (await isHuman(principal)) &&
      (await accounts.hasCapability(principal, module.access.capability))
    );
  }

  const link = (module: DashboardModuleDefinition): DashboardModuleLink => ({
    id: module.id,
    label: module.label,
    group: module.group,
    groupLabel: DASHBOARD_GROUP_LABELS[module.group],
    description: module.description,
  });

  async function modulesFor(
    principal: TrustedPrincipal,
    state: "active" | "planned",
  ): Promise<DashboardModuleLink[]> {
    const result: DashboardModuleLink[] = [];
    for (const module of DASHBOARD_MODULES) {
      const effective =
        module.state === "active" && hosted.has(module.id)
          ? "active"
          : "planned";
      if (effective === state && (await allows(principal, module)))
        result.push(link(module));
    }
    return result;
  }

  async function account(
    principal: TrustedPrincipal,
  ): Promise<DashboardAccountSummary> {
    const row = await database.first<Row>(
      `SELECT display_name, email, role, created_at
       FROM accounts
       WHERE id = ? AND kind = 'human' AND status = 'active'`,
      [principal.accountId],
    );
    if (
      !row ||
      typeof row.display_name !== "string" ||
      typeof row.created_at !== "string" ||
      !isAccountRole(row.role)
    )
      throw new AuthorizationError();
    return {
      displayName: row.display_name,
      email: typeof row.email === "string" ? row.email : null,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role],
      status: "active",
      memberSince: row.created_at,
    };
  }

  async function signInMethods(
    principal: TrustedPrincipal,
  ): Promise<readonly DashboardSignInMethod[]> {
    const rows = await database.all<Row>(
      `SELECT id, provider, created_at, expires_at
       FROM identities
       WHERE account_id = ? AND credential_hash IS NULL
         AND revoked_at IS NULL
       ORDER BY created_at, id`,
      MAX_SIGN_IN_ROWS,
      [principal.accountId],
    );
    return rows.map((row) => ({
      label: providerLabel(String(row.provider)),
      linkedAt: String(row.created_at),
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
      current: row.id === principal.identityId,
    }));
  }

  async function requireHuman(principal: TrustedPrincipal): Promise<void> {
    if (!(await isHuman(principal))) throw new AuthorizationError();
  }

  return {
    async session(principal: TrustedPrincipal): Promise<DashboardSession> {
      await requireHuman(principal);
      return {
        account: await account(principal),
        modules: await modulesFor(principal, "active"),
        planned: await modulesFor(principal, "planned"),
      };
    },
    async view(
      principal: TrustedPrincipal,
      id: string,
    ): Promise<DashboardView> {
      await requireHuman(principal);
      const module = DASHBOARD_MODULES.find(
        (entry) =>
          entry.id === id && entry.state === "active" && hosted.has(entry.id),
      );
      // Unknown, not-yet-built and not-yet-hosted views share one answer.
      if (!module) throw new DashboardViewNotFoundError();
      if (!(await allows(principal, module))) throw new AuthorizationError();
      switch (module.id) {
        case "overview":
          return {
            view: "overview",
            account: await account(principal),
            modules: await modulesFor(principal, "active"),
            planned: await modulesFor(principal, "planned"),
            editorial: null,
          };
        case "account":
          return {
            view: "account",
            account: await account(principal),
            signInMethods: await signInMethods(principal),
            modules: await modulesFor(principal, "active"),
          };
        case "posts":
          // The module only names the view. Every draft read and write goes
          // through the protected `/internal/content/*` routes, which check
          // `content.publish` and the live account themselves.
          return { view: "posts" };
        case "banners":
          // The module only names the view. Every banner read and write goes
          // through the protected `/api/admin/banners/*` routes, which check
          // `banner.manage` and the live account themselves.
          return { view: "banners" };
        case "profiles":
          // The module only names the view. Every Profiles read and write goes
          // through the protected `/api/admin/profiles/*` routes, which check
          // `profile.manage` and the live human account themselves.
          return { view: "profiles" };
        case "county-structure":
          // The module only names the view. Every read and write goes through
          // the protected `/api/admin/county-structure/*` routes, which check
          // `county_structure.manage` and the live owner account themselves.
          return { view: "county-structure" };
        default:
          throw new DashboardViewNotFoundError();
      }
    },
  };
}

import type { ContentSummary } from "../contracts/content.js";
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
import type { WebsiteDatabase } from "../database/sqlite.js";
import {
  type AccountRole,
  AuthorizationError,
  hasCapability,
  isAccountRole,
  isCurrentPrincipal,
  type TrustedPrincipal,
} from "./security.js";

/**
 * Dashboard service (EDIT-2 local slice).
 *
 * Every answer is derived from the trusted principal and the existing role
 * matrix on each call. Nothing is cached, nothing is written and no caller
 * input selects an account: the self-view is always the principal's own row.
 * Only active human accounts have a dashboard. Agent credentials are refused.
 */
export class DashboardViewNotFoundError extends Error {
  constructor() {
    super("The dashboard view does not exist");
    this.name = "DashboardViewNotFoundError";
  }
}

export interface DashboardServiceOptions {
  /**
   * Recent Posts and Stories for the Overview. Wire this to the content
   * service, which applies its own policy. Absent means none are shown.
   */
  readonly recentContent?: (
    principal: TrustedPrincipal,
  ) => readonly ContentSummary[];
}

export interface DashboardService {
  session(principal: TrustedPrincipal): DashboardSession;
  view(principal: TrustedPrincipal, id: string): DashboardView;
  /** True when the principal may open the named working module right now. */
  mayOpen(principal: TrustedPrincipal | null, id: DashboardModuleId): boolean;
}

const ROLE_LABELS: Readonly<Record<AccountRole, string>> = {
  contributor: "Contributor",
  editor: "Editor",
  administrator: "Administrator",
  owner: "Owner",
};

const RECENT_LIMIT = 5;

export function createDashboardService(
  database: WebsiteDatabase,
  options: DashboardServiceOptions = {},
): DashboardService {
  const isHuman = (
    principal: TrustedPrincipal | null,
  ): principal is TrustedPrincipal =>
    principal?.kind === "human" && isCurrentPrincipal(database, principal);

  const allows = (
    principal: TrustedPrincipal,
    module: DashboardModuleDefinition,
  ): boolean =>
    module.access.kind === "signed-in"
      ? isHuman(principal)
      : isHuman(principal) &&
        hasCapability(database, principal, module.access.capability);

  const link = (module: DashboardModuleDefinition): DashboardModuleLink => ({
    id: module.id,
    label: module.label,
    group: module.group,
    groupLabel: DASHBOARD_GROUP_LABELS[module.group],
    description: module.description,
  });

  const modulesFor = (
    principal: TrustedPrincipal,
    state: "active" | "planned",
  ) =>
    DASHBOARD_MODULES.filter(
      (module) => module.state === state && allows(principal, module),
    ).map(link);

  function requireHuman(principal: TrustedPrincipal): void {
    if (!isHuman(principal)) throw new AuthorizationError();
  }

  function account(principal: TrustedPrincipal): DashboardAccountSummary {
    const row = database
      .prepare(
        `SELECT display_name, email, role, created_at
         FROM accounts
         WHERE id = ? AND kind = 'human' AND status = 'active'`,
      )
      .get(principal.accountId);
    if (
      !row ||
      typeof row.display_name !== "string" ||
      typeof row.created_at !== "string" ||
      !isAccountRole(row.role)
    ) {
      throw new AuthorizationError();
    }
    return {
      displayName: row.display_name,
      email: typeof row.email === "string" ? row.email : null,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role],
      status: "active",
      memberSince: row.created_at,
    };
  }

  function signInMethods(
    principal: TrustedPrincipal,
  ): readonly DashboardSignInMethod[] {
    return database
      .prepare(
        `SELECT id, provider, created_at, expires_at
         FROM identities
         WHERE account_id = ? AND credential_hash IS NULL
           AND revoked_at IS NULL
         ORDER BY created_at, id`,
      )
      .all(principal.accountId)
      .map((row) => ({
        label: providerLabel(String(row.provider)),
        linkedAt: String(row.created_at),
        expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
        current: row.id === principal.identityId,
      }));
  }

  function recent(principal: TrustedPrincipal): readonly ContentSummary[] {
    try {
      return (options.recentContent?.(principal) ?? []).slice(0, RECENT_LIMIT);
    } catch {
      // A denied or failed listing shows nothing rather than failing Overview.
      return [];
    }
  }

  return {
    session(principal) {
      requireHuman(principal);
      return {
        account: account(principal),
        modules: modulesFor(principal, "active"),
        planned: modulesFor(principal, "planned"),
      };
    },
    view(principal, id) {
      requireHuman(principal);
      const module = DASHBOARD_MODULES.find(
        (entry) => entry.id === id && entry.state === "active",
      );
      // Unknown and not-yet-built views are the same answer for everyone.
      if (!module) throw new DashboardViewNotFoundError();
      if (!allows(principal, module)) throw new AuthorizationError();
      switch (module.id) {
        case "overview": {
          const modules = modulesFor(principal, "active");
          return {
            view: "overview",
            account: account(principal),
            modules,
            planned: modulesFor(principal, "planned"),
            editorial: modules.some((entry) => entry.id === "posts")
              ? { recent: recent(principal) }
              : null,
          };
        }
        case "account":
          return {
            view: "account",
            account: account(principal),
            signInMethods: signInMethods(principal),
            modules: modulesFor(principal, "active"),
          };
        case "posts":
          return { view: "posts" };
        case "banners":
          return { view: "banners" };
        default:
          throw new DashboardViewNotFoundError();
      }
    },
    mayOpen(principal, id) {
      const module = DASHBOARD_MODULES.find(
        (entry) => entry.id === id && entry.state === "active",
      );
      return !!module && principal !== null && allows(principal, module);
    },
  };
}

/** A display label only. The provider string and subject are never returned. */
function providerLabel(provider: string): string {
  if (provider === "test-human") return "Sandbox test identity";
  if (provider.startsWith("auth0:")) return "Auth0 sign-in";
  if (provider.startsWith("chatgpt-sites:")) return "ChatGPT Sites sign-in";
  return "Linked sign-in";
}

import type { ContentSummary } from "./content.js";

/**
 * Dashboard contract (EDIT-2 local slice).
 *
 * One registry names every dashboard module, the access it needs and whether
 * it works yet. The server derives navigation and view access from it with the
 * existing role matrix. The browser only renders what the server returns and
 * never treats this file or a response as permission.
 */
export type DashboardModuleId =
  | "overview"
  | "account"
  | "posts"
  | "reports"
  | "banners"
  | "profiles"
  | "accounts"
  | "audit"
  | "status";

export type DashboardGroupId = "workspace" | "editorial" | "administration";

/**
 * `signed-in` means any active human account. A capability string must be one
 * of the existing capabilities in `src/services/security.ts`.
 */
export type DashboardAccess =
  | { readonly kind: "signed-in" }
  | { readonly kind: "capability"; readonly capability: string };

export interface DashboardModuleDefinition {
  readonly id: DashboardModuleId;
  readonly label: string;
  readonly group: DashboardGroupId;
  readonly description: string;
  readonly access: DashboardAccess;
  /** Only `active` modules are navigable. `planned` modules have no view. */
  readonly state: "active" | "planned";
}

export const DASHBOARD_GROUP_LABELS: Readonly<
  Record<DashboardGroupId, string>
> = {
  workspace: "Your workspace",
  editorial: "Editorial",
  administration: "Administration",
};

export const DASHBOARD_MODULES: readonly DashboardModuleDefinition[] = [
  {
    id: "overview",
    label: "Overview",
    group: "workspace",
    description: "Your starting page.",
    access: { kind: "signed-in" },
    state: "active",
  },
  {
    id: "account",
    label: "My Account",
    group: "workspace",
    description: "Your own account details and access.",
    access: { kind: "signed-in" },
    state: "active",
  },
  {
    id: "posts",
    label: "Posts & Stories",
    group: "editorial",
    description: "Draft, preview, revise and organize Posts and Stories.",
    access: { kind: "capability", capability: "content.publish" },
    state: "active",
  },
  {
    id: "reports",
    label: "Reports",
    group: "editorial",
    description: "Review submitted reports.",
    access: { kind: "capability", capability: "report.review" },
    state: "planned",
  },
  {
    id: "banners",
    label: "Banners",
    group: "administration",
    description: "Stage, preview, publish and restore banners.",
    access: { kind: "capability", capability: "banner.manage" },
    state: "active",
  },
  {
    id: "profiles",
    label: "Profiles",
    group: "administration",
    description: "Search, edit and hide or restore Profiles in a sheet.",
    access: { kind: "capability", capability: "profile.manage" },
    state: "active",
  },
  {
    id: "accounts",
    label: "Accounts",
    group: "administration",
    description: "Manage accounts, roles and sign-in links.",
    access: { kind: "capability", capability: "account.read" },
    state: "planned",
  },
  {
    id: "audit",
    label: "Audit",
    group: "administration",
    description: "Read the audit trail.",
    access: { kind: "capability", capability: "audit.read" },
    state: "planned",
  },
  {
    id: "status",
    label: "System Status",
    group: "administration",
    description: "Read-only checks of the Website database and storage.",
    access: { kind: "capability", capability: "d1.inspect" },
    state: "planned",
  },
];

export interface DashboardModuleLink {
  readonly id: DashboardModuleId;
  readonly label: string;
  readonly group: DashboardGroupId;
  readonly groupLabel: string;
  readonly description: string;
}

/** Safe self-view fields. Never a subject, credential, hash or preference. */
export interface DashboardAccountSummary {
  readonly displayName: string;
  readonly email: string | null;
  readonly role: "contributor" | "editor" | "administrator" | "owner";
  readonly roleLabel: string;
  readonly status: "active";
  readonly memberSince: string;
}

export interface DashboardSignInMethod {
  readonly label: string;
  readonly linkedAt: string;
  readonly expiresAt: string | null;
  /** True for the link that authenticated this request. */
  readonly current: boolean;
}

export interface DashboardSession {
  readonly account: DashboardAccountSummary;
  /** Working destinations this account may open, in display order. */
  readonly modules: readonly DashboardModuleLink[];
  /** Modules this account would be allowed to use that are not built yet. */
  readonly planned: readonly DashboardModuleLink[];
}

export interface DashboardOverviewView {
  readonly view: "overview";
  readonly account: DashboardAccountSummary;
  readonly modules: readonly DashboardModuleLink[];
  readonly planned: readonly DashboardModuleLink[];
  /** Present only when the account may use Posts & Stories. */
  readonly editorial: {
    readonly recent: readonly ContentSummary[];
  } | null;
}

export interface DashboardAccountView {
  readonly view: "account";
  readonly account: DashboardAccountSummary;
  readonly signInMethods: readonly DashboardSignInMethod[];
  readonly modules: readonly DashboardModuleLink[];
}

export interface DashboardPostsView {
  readonly view: "posts";
}

/**
 * The Banners module keeps its data in its own transport and service. The
 * dashboard view carries no banner data; the view factory reads the merged
 * `/api/admin/banners/*` contract itself.
 */
export interface DashboardBannersView {
  readonly view: "banners";
}

/**
 * The Profiles sheet keeps its data in its own protected transport and
 * service. The dashboard view carries no Profile data.
 */
export interface DashboardProfilesView {
  readonly view: "profiles";
}

export type DashboardView =
  | DashboardOverviewView
  | DashboardAccountView
  | DashboardPostsView
  | DashboardBannersView
  | DashboardProfilesView;

export const DASHBOARD_API_PATHS = {
  session: "/internal/dashboard/session",
  view: "/internal/dashboard/views/get",
} as const;

import { createApplication } from "./application.js";
import { readHumanSignIn } from "./auth/config.js";
import { exactSameOrigin, hasSessionCookie } from "./auth/http.js";
import { createSessionIdentityAdapter } from "./auth/identity.js";
import { handleAuthRequest, isAuthPath } from "./auth/routes.js";
import type { ReportIntakeStore } from "./contracts/report-intake.js";
import type { RuntimeEnvironment } from "./contracts/runtime.js";
import { StorageUnavailableError } from "./contracts/storage.js";
import { AsyncD1Database } from "./database/d1.js";
import { handleWebsiteMcpRequest } from "./mcp/website.js";
import { createSyncMcpBridge } from "./mcp/website-sync.js";
import { createReportApiModule, type ReportApiOptions } from "./report-api.js";
import {
  createAiProposalService,
  createAiProviderFromEnv,
} from "./services/ai-proposals.js";
import { D1BannerAdministration } from "./services/banner-admin-d1.js";
import { D1BannerPublicService } from "./services/banner-public.js";
import { R2BannerObjectStorage } from "./services/banner-storage.js";
import { createD1ContentService } from "./services/content-d1.js";
import { createContentPublicationService } from "./services/content-publication.js";
import { D1CountyRoleAttachments } from "./services/county-role-attachment-d1.js";
import { D1CountyStructureAdministration } from "./services/county-structure-d1.js";
import { D1CountyStructureLayoutAdministration } from "./services/county-structure-layout-d1.js";
import { D1CountyStructurePublicService } from "./services/county-structure-public.js";
import { createD1AccountServices } from "./services/d1-accounts.js";
import { createD1WebsiteInspectionService } from "./services/d1-inspection.js";
import { createD1PublicReadServices } from "./services/d1-public-reads.js";
import { createD1DashboardService } from "./services/dashboard-d1.js";
import type { ApplicationServices } from "./services/index.js";
import { createD1ProfilesService } from "./services/profiles-d1.js";
import { createD1ProfilesImportService } from "./services/profiles-import-d1.js";
import {
  type ChallengeOutcome,
  createTurnstileAbuseControl,
} from "./services/report-challenge.js";
import { D1ReportIntakeStore } from "./services/report-intake-d1.js";
import type { HumanIdentityAdapter } from "./services/security.js";
import { createSitesIdentityAdapter } from "./services/sites-identity.js";
import { createHostedSyncTransportDependencies } from "./services/sync-hosted.js";
import { createD1EditorialSource } from "./site/d1-editorial-source.js";
import { createPublicSite, createWebsite } from "./site/index.js";
import type { PublicSiteServices } from "./site/types.js";
import { bundledSiteAssets } from "./site/worker-assets.js";
import {
  bannerAdminUnavailable,
  createBannerAdminApiTransport,
  isBannerAdminPath,
} from "./transport/banner-admin-api.js";
import {
  CONTENT_API_PATHS,
  CONTENT_PUBLICATION_API_PATHS,
  type ContentTransportOperations,
  createContentApiTransport,
  createContentTransportOperations,
} from "./transport/content-api.js";
import {
  createCountyStructureApiTransport,
  isCountyStructurePath,
} from "./transport/county-structure-api.js";
import {
  dashboardUnavailable,
  handleDashboardRequest,
  isDashboardPath,
} from "./transport/dashboard-hosted.js";
import {
  createProfilesApiTransport,
  isProfilesPath,
} from "./transport/profiles-api.js";
import { createSyncApiTransport, isSyncApiPath } from "./transport/sync-api.js";

declare const __WATCHDOG_SITES_PROJECT_ID__: string | null;
declare const __WATCHDOG_WEBSITE_MIGRATIONS__: readonly {
  version: number;
  name: string;
  sha256: string;
}[];

/** The only Sites project allowed to supply human claims to this Worker. */
const BETA2_SITES_PROJECT_ID = "appgprj_6af7fb8f615c81918da0e4450ba336de";
const ALPHA1_PUBLIC_ORIGIN =
  "https://colorado-watchdog-alpha1.futureguild2.chatgpt.site";

// Sites currently documents identity headers but does not expose an
// authenticated identity context or a verifiable Worker gateway assertion.
// Never promote request headers into a VerifiedSitesContext here.

function unavailableServices() {
  const unavailable = () => {
    throw new StorageUnavailableError();
  };
  return {
    liveness: () => ({ status: "ok" as const }),
    readiness: async () => unavailable(),
    health: async () => unavailable(),
    resolvePrincipal: async () => null,
    listCounties: unavailable,
    getCountyOverview: unavailable,
    listCountyOrganizations: unavailable,
    listCountyRoleEntries: unavailable,
    browsePeople: unavailable,
    browseOrganizations: unavailable,
    searchPeople: unavailable,
    searchOrganizations: unavailable,
    getPersonProfile: unavailable,
    getOrganizationProfile: unavailable,
    listOrganizationRoleEntries: unavailable,
    listOfficials: unavailable,
    getCountyStructure: unavailable,
    hasCapability: unavailable,
    createAccount: unavailable,
    getAccount: unavailable,
    updateAccount: unavailable,
    changeAccountRole: unavailable,
    createHumanIdentity: unavailable,
    issueAgentCredential: unavailable,
    revokeIdentity: unavailable,
    createOperation: unavailable,
    listAuditEvents: unavailable,
    checkpoints: unavailable,
  };
}

function unavailableReportStore(): ReportIntakeStore {
  const unavailable = async (): Promise<never> => {
    throw new StorageUnavailableError();
  };
  return {
    validateReferences: unavailable,
    create: unavailable,
    getPrivate: unavailable,
    findByReceipt: unavailable,
    compareAndSet: unavailable,
    listPrivate: unavailable,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function turnstileAbuseControl(
  environment: RuntimeEnvironment,
  database: AsyncD1Database | undefined,
) {
  if (environment.REPORTS_TURNSTILE !== "enabled" || !database)
    return undefined;
  const sitekey = environment.REPORTS_TURNSTILE_SITEKEY;
  const secret = environment.REPORTS_TURNSTILE_SECRET;
  if (!sitekey || !/^[0-9A-Za-z_-]{1,100}$/.test(sitekey) || !secret)
    return undefined;
  let origin: URL;
  try {
    origin = new URL(environment.REPORTS_TURNSTILE_ORIGIN ?? "");
  } catch {
    return undefined;
  }
  const testing = environment.APP_ENV === "test";
  const exact =
    origin.pathname === "/" &&
    !origin.search &&
    !origin.hash &&
    !origin.username;
  if (
    !exact ||
    !(
      origin.protocol === "https:" ||
      (testing &&
        origin.protocol === "http:" &&
        isLoopbackHostname(origin.hostname))
    )
  )
    return undefined;
  let verifyUrl: string | undefined;
  if (testing && environment.REPORTS_TEST_TURNSTILE_VERIFY_URL) {
    try {
      const target = new URL(environment.REPORTS_TEST_TURNSTILE_VERIFY_URL);
      if (target.protocol !== "http:" || !isLoopbackHostname(target.hostname))
        return undefined;
      verifyUrl = target.toString();
    } catch {
      return undefined;
    }
  }
  const control = createTurnstileAbuseControl({
    database,
    secret,
    hostname: origin.hostname,
    ...(verifyUrl ? { verifyUrl } : {}),
    // Counts only a fixed outcome name. No token, address or report data.
    record: (outcome: ChallengeOutcome) =>
      console.info(JSON.stringify({ event: "report_challenge", outcome })),
  });
  return {
    sitekey,
    origin: origin.origin,
    // The challenge belongs to one exact origin. Any other host is closed.
    abuseControl: {
      check: async (request: Request) =>
        new URL(request.url).origin === origin.origin
          ? control.check(request)
          : { allowed: false },
    },
  };
}

function reportApi(
  environment: RuntimeEnvironment,
  services: ReportApiOptions["services"],
  database?: AsyncD1Database,
  accountSubmissions = false,
) {
  const turnstile = turnstileAbuseControl(environment, database);
  const testAbuseEnabled =
    environment.APP_ENV === "test" &&
    environment.REPORTS_TEST_ABUSE_CONTROL === "enabled";
  const abuseControl =
    turnstile?.abuseControl ??
    (testAbuseEnabled
      ? {
          async check(request: Request) {
            return isLoopbackHostname(new URL(request.url).hostname)
              ? { allowed: true }
              : { allowed: false };
          },
        }
      : undefined);
  const unavailable = unavailableReportStore();
  const makeStore = (request: Request): ReportIntakeStore =>
    database
      ? new D1ReportIntakeStore(database, async (actor) => {
          // Re-resolve from the server-accepted request and recheck its live
          // identity/capability. The D1 adapter never trusts actor claims alone.
          const current = await services.resolvePrincipal(request);
          return Boolean(
            current &&
              current.accountId === actor.accountId &&
              current.role === actor.role &&
              (await services.hasCapability(current, "report.review")),
          );
        })
      : unavailable;
  return {
    enabled: Boolean(abuseControl),
    accountEnabled: Boolean(database) && accountSubmissions,
    challenge: turnstile
      ? { sitekey: turnstile.sitekey, origin: turnstile.origin }
      : undefined,
    handler: createReportApiModule({
      services,
      store: unavailable,
      storeForRequest: makeStore,
      ...(database && accountSubmissions
        ? { accountSubmissions: { enabled: true } }
        : {}),
      ...(abuseControl
        ? {
            guestSubmissions: { enabled: true, abuseControl },
          }
        : {}),
    }),
  };
}

/**
 * Responses to a request that carries a credential are private. A response
 * that does not already forbid storage gets `no-store`, so no shared cache
 * can keep one person's view for another.
 */
function withPrivateCaching(request: Request, response: Response): Response {
  if (
    request.headers.get("authorization") === null &&
    !hasSessionCookie(request)
  )
    return response;
  if (/no-store/i.test(response.headers.get("cache-control") ?? ""))
    return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, private");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function originRejected(): Response {
  return new Response(JSON.stringify({ error: "origin_rejected" }), {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** AI proposals stay unavailable (503) until a provider is configured. */
function aiOperations(
  environment: RuntimeEnvironment,
): Pick<ContentTransportOperations, "proposeAi"> {
  const provider = createAiProviderFromEnv(environment);
  if (!provider) return {};
  const service = createAiProposalService({ provider });
  return {
    proposeAi: (_principal, request, signal) =>
      service.propose(request, signal),
  };
}

const routes = {
  async fetch(
    request: Request,
    environment: RuntimeEnvironment,
  ): Promise<Response> {
    const fallback = unavailableServices();
    const { origin, pathname } = new URL(request.url);
    const publicationRoute =
      pathname === CONTENT_PUBLICATION_API_PATHS.publish ||
      pathname === CONTENT_PUBLICATION_API_PATHS.withdraw;
    const draftRoute = (Object.values(CONTENT_API_PATHS) as string[]).includes(
      pathname,
    );
    const signIn = readHumanSignIn(environment);
    if (!environment.DB) {
      if (isAuthPath(pathname))
        return handleAuthRequest(request, { database: null, signIn });
      if (isBannerAdminPath(pathname)) return bannerAdminUnavailable();
      if (isProfilesPath(pathname))
        return new Response(JSON.stringify({ error: "profiles_unavailable" }), {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      if (isSyncApiPath(pathname))
        return new Response(
          JSON.stringify({ error: "operation_unavailable" }),
          {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          },
        );
      if (isDashboardPath(pathname)) return dashboardUnavailable();
      if (publicationRoute || draftRoute)
        return createContentApiTransport().fetch(request);
      if (new URL(request.url).pathname === "/mcp") {
        return new Response(
          JSON.stringify({ error: "inspection_unavailable" }),
          {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
      const app = createApplication(fallback as unknown as ApplicationServices);
      const reports = reportApi(
        environment,
        fallback as unknown as ReportApiOptions["services"],
      );
      const site = createPublicSite({
        services: fallback as unknown as PublicSiteServices,
        assets: bundledSiteAssets,
        reportReviewAccess: async () => 401,
      });
      return createWebsite({
        application: app,
        site,
        reports: reports.handler,
      }).fetch(request);
    }

    try {
      const database = new AsyncD1Database(environment.DB);
      // A cookie-authenticated write from another origin is refused on every
      // route. A request with an Authorization header is an agent request and
      // never uses the cookie, so this check does not apply to it.
      if (
        signIn.status === "enabled" &&
        !isAuthPath(pathname) &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        request.headers.get("authorization") === null &&
        hasSessionCookie(request) &&
        !exactSameOrigin(request)
      )
        return originRejected();
      const reads = createD1PublicReadServices(database);
      // Object storage is optional. A missing Sites binding leaves the existing
      // branded banner placeholders in place and never prevents page rendering.
      const bannerService = environment.BUCKET
        ? new D1BannerPublicService(database, environment.BUCKET)
        : undefined;
      const siteId =
        typeof __WATCHDOG_SITES_PROJECT_ID__ === "string"
          ? __WATCHDOG_SITES_PROJECT_ID__
          : null;
      const sitesIdentity =
        siteId === BETA2_SITES_PROJECT_ID
          ? createSitesIdentityAdapter({ siteId })
          : undefined;
      // Website-owned session sign-in resolves nothing unless sign-in is
      // enabled. The Sites adapter keeps resolving nothing without a verified
      // host context.
      const sessionIdentity = createSessionIdentityAdapter({
        database,
        signIn,
      });
      const humanIdentity: HumanIdentityAdapter = {
        async resolve(identityRequest) {
          return (
            (await sessionIdentity.resolve(identityRequest)) ??
            (await sitesIdentity?.resolve(identityRequest)) ??
            null
          );
        },
      };
      const accounts = createD1AccountServices(database, humanIdentity);
      if (isAuthPath(pathname)) {
        return handleAuthRequest(request, {
          database,
          signIn,
          currentAccount: async (authRequest) => {
            const principal = await accounts.resolvePrincipal(authRequest);
            if (!principal) return null;
            const account = await accounts.getOwnAccount(principal);
            return { displayName: account.displayName, role: account.role };
          },
        });
      }
      if (isDashboardPath(pathname)) {
        // The dashboard exists only while Website human sign-in is enabled.
        if (signIn.status !== "enabled") return dashboardUnavailable();
        return handleDashboardRequest(request, {
          resolvePrincipal: accounts.resolvePrincipal,
          service: createD1DashboardService(database, accounts),
        });
      }
      if (publicationRoute || draftRoute) {
        const authorize = (
          principal: NonNullable<
            Awaited<ReturnType<typeof accounts.resolvePrincipal>>
          >,
        ) => accounts.hasCapability(principal, "content.publish");
        // Draft editing belongs to the signed-in dashboard, so it is limited to
        // a current human account that also holds `content.publish`. An agent
        // credential keeps the publication routes only.
        const authorizeDrafts = async (
          principal: Parameters<typeof authorize>[0],
        ) => principal.kind === "human" && (await authorize(principal));
        return createContentApiTransport({
          resolvePrincipal: accounts.resolvePrincipal,
          authorize: (principal, operation) =>
            operation === "publish" || operation === "withdraw"
              ? authorize(principal)
              : authorizeDrafts(principal),
          operations: {
            ...createContentTransportOperations(
              createD1ContentService(database, authorizeDrafts),
            ),
            ...createContentPublicationService(database, authorize),
            ...aiOperations(environment),
          },
        }).fetch(request);
      }
      if (isSyncApiPath(pathname)) {
        // Agent-only, capability-gated and default-deny. Every operation needs
        // an explicit sync grant that no role holds, and nothing is public.
        return createSyncApiTransport({
          resolvePrincipal: accounts.resolvePrincipal,
          ...createHostedSyncTransportDependencies(
            database,
            accounts.hasCapability,
          ),
        }).fetch(request);
      }
      if (isProfilesPath(pathname)) {
        // The owner Profiles sheet exists only with human sign-in enabled. It
        // admits a current human session holding `profile.manage` and nothing
        // else, so an agent credential is denied on every route.
        if (signIn.status !== "enabled")
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          });
        const authorizeProfiles = (
          principal: NonNullable<
            Awaited<ReturnType<typeof accounts.resolvePrincipal>>
          >,
        ) => accounts.hasCapability(principal, "profile.manage");
        return createProfilesApiTransport({
          resolvePrincipal: accounts.resolvePrincipal,
          authorize: authorizeProfiles,
          service: createD1ProfilesService(database, {
            authorize: authorizeProfiles,
          }),
          importService: createD1ProfilesImportService(database, {
            authorize: authorizeProfiles,
          }),
        }).fetch(request);
      }
      if (isCountyStructurePath(pathname)) {
        // Owner-only County Structure management. It exists only with human
        // sign-in enabled and admits a current human session holding
        // `county_structure.manage`, so an agent credential is denied.
        if (signIn.status !== "enabled")
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          });
        return createCountyStructureApiTransport({
          resolvePrincipal: accounts.resolvePrincipal,
          authorize: (principal) =>
            accounts.hasCapability(principal, "county_structure.manage"),
          administration: new D1CountyStructureAdministration(database),
          layouts: new D1CountyStructureLayoutAdministration(database),
          roleAttachments: new D1CountyRoleAttachments(database),
        }).fetch(request);
      }
      if (isBannerAdminPath(pathname)) {
        // Administration needs both bindings. Without the bucket the transport
        // still authenticates and authorizes, then reports unavailable.
        return createBannerAdminApiTransport({
          resolvePrincipal: accounts.resolvePrincipal,
          authorize: (principal) =>
            accounts.hasCapability(principal, "banner.manage"),
          ...(environment.BUCKET
            ? {
                administration: new D1BannerAdministration(
                  database,
                  new R2BannerObjectStorage(environment.BUCKET),
                ),
              }
            : {}),
        }).fetch(request);
      }
      const services = {
        ...fallback,
        ...reads,
        ...accounts,
        async readiness() {
          await database.first("SELECT 1 AS ready");
          return { status: "ready" as const };
        },
        async health() {
          await database.first("SELECT 1 AS ready");
          return { status: "ok" as const };
        },
      };
      const inspection = createD1WebsiteInspectionService(
        database,
        __WATCHDOG_WEBSITE_MIGRATIONS__,
        {
          projectId: siteId,
          bindingName: "DB",
          authorize: (principal) =>
            accounts.hasCapability(principal, "d1.inspect"),
        },
      );
      const app = createApplication(
        services as unknown as ApplicationServices,
        {
          humanSignIn: signIn.status === "enabled",
        },
      );
      const reports = reportApi(
        environment,
        services,
        database,
        signIn.status === "enabled",
      );
      const currentHumanAccountId = async (request: Request) => {
        if (!hasSessionCookie(request)) return null;
        const principal = await accounts.resolvePrincipal(request);
        return principal?.kind === "human" ? principal.accountId : null;
      };
      const site = createPublicSite({
        services: reads,
        editorial: createD1EditorialSource(database),
        assets: bundledSiteAssets,
        allowChatGptEditor:
          siteId === BETA2_SITES_PROJECT_ID && origin === ALPHA1_PUBLIC_ORIGIN,
        countyStructure: new D1CountyStructurePublicService(database),
        ...(bannerService
          ? { banners: bannerService, bannerDelivery: bannerService }
          : {}),
        reportSubmissionsEnabled: reports.enabled || reports.accountEnabled,
        reportGuestEnabled: reports.enabled,
        ...(reports.challenge ? { reportChallenge: reports.challenge } : {}),
        // The header offers sign-in or the Dashboard only while Website human
        // sign-in is enabled, which is also the only time /dashboard exists.
        ...(signIn.status === "enabled"
          ? {
              accountEntry: async (entryRequest: Request) => {
                return (await currentHumanAccountId(entryRequest))
                  ? "signed-in"
                  : "signed-out";
              },
              reportAccountId: currentHumanAccountId,
            }
          : {}),
        reportReviewAccess: async (request) => {
          const principal = await services.resolvePrincipal(request);
          if (!principal) return 401;
          return (await services.hasCapability(principal, "report.review"))
            ? null
            : 403;
        },
      });
      const website = createWebsite({
        application: app,
        site,
        reports: reports.handler,
      });
      if (new URL(request.url).pathname === "/mcp") {
        // Banner tools reuse the same D1/R2 service as the protected banner
        // API. Without the bucket they authorize and then report unavailable.
        return handleWebsiteMcpRequest(
          request,
          services,
          inspection,
          environment.BUCKET
            ? new D1BannerAdministration(
                database,
                new R2BannerObjectStorage(environment.BUCKET),
              )
            : undefined,
          // Profiles sync tools reuse the hosted sync services and grants.
          createSyncMcpBridge(
            createHostedSyncTransportDependencies(
              database,
              accounts.hasCapability,
            ),
          ),
        );
      }
      return website.fetch(request);
    } catch {
      return new Response(JSON.stringify({ error: "dependency_unavailable" }), {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
  },
};

const worker = {
  async fetch(
    request: Request,
    environment: RuntimeEnvironment,
  ): Promise<Response> {
    return withPrivateCaching(
      request,
      await routes.fetch(request, environment),
    );
  },
};

export default worker;

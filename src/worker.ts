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
import { createReportApiModule, type ReportApiOptions } from "./report-api.js";
import { D1BannerAdministration } from "./services/banner-admin-d1.js";
import { D1BannerPublicService } from "./services/banner-public.js";
import { R2BannerObjectStorage } from "./services/banner-storage.js";
import { createContentPublicationService } from "./services/content-publication.js";
import { createD1AccountServices } from "./services/d1-accounts.js";
import { createD1WebsiteInspectionService } from "./services/d1-inspection.js";
import { createD1PublicReadServices } from "./services/d1-public-reads.js";
import type { ApplicationServices } from "./services/index.js";
import { D1ReportIntakeStore } from "./services/report-intake-d1.js";
import type { HumanIdentityAdapter } from "./services/security.js";
import { createSitesIdentityAdapter } from "./services/sites-identity.js";
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
  CONTENT_PUBLICATION_API_PATHS,
  createContentApiTransport,
} from "./transport/content-api.js";

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

function reportApi(
  environment: RuntimeEnvironment,
  services: ReportApiOptions["services"],
  database?: AsyncD1Database,
) {
  const testAbuseEnabled =
    environment.APP_ENV === "test" &&
    environment.REPORTS_TEST_ABUSE_CONTROL === "enabled";
  const abuseControl = testAbuseEnabled
    ? {
        async check(request: Request) {
          return isLoopbackHostname(new URL(request.url).hostname)
            ? { allowed: true }
            : { allowed: false };
        },
      }
    : undefined;
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
    handler: createReportApiModule({
      services,
      store: unavailable,
      storeForRequest: makeStore,
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
    const signIn = readHumanSignIn(environment);
    if (!environment.DB) {
      if (isAuthPath(pathname))
        return handleAuthRequest(request, { database: null, signIn });
      if (isBannerAdminPath(pathname)) return bannerAdminUnavailable();
      if (publicationRoute) return createContentApiTransport().fetch(request);
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
      if (publicationRoute) {
        const authorize = (
          principal: NonNullable<
            Awaited<ReturnType<typeof accounts.resolvePrincipal>>
          >,
        ) => accounts.hasCapability(principal, "content.publish");
        return createContentApiTransport({
          resolvePrincipal: accounts.resolvePrincipal,
          authorize,
          operations: createContentPublicationService(database, authorize),
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
      const reports = reportApi(environment, services, database);
      const site = createPublicSite({
        services: reads,
        editorial: createD1EditorialSource(database),
        assets: bundledSiteAssets,
        allowChatGptEditor:
          siteId === BETA2_SITES_PROJECT_ID && origin === ALPHA1_PUBLIC_ORIGIN,
        ...(bannerService
          ? { banners: bannerService, bannerDelivery: bannerService }
          : {}),
        reportSubmissionsEnabled: reports.enabled,
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
        return handleWebsiteMcpRequest(request, services, inspection);
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

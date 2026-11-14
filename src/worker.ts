import { createApplication } from "./application.js";
import type { ReportIntakeStore } from "./contracts/report-intake.js";
import type { RuntimeEnvironment } from "./contracts/runtime.js";
import { StorageUnavailableError } from "./contracts/storage.js";
import { AsyncD1Database } from "./database/d1.js";
import { createReportApiModule, type ReportApiOptions } from "./report-api.js";
import { D1BannerPublicService } from "./services/banner-public.js";
import { createD1AccountServices } from "./services/d1-accounts.js";
import { createD1PublicReadServices } from "./services/d1-public-reads.js";
import type { ApplicationServices } from "./services/index.js";
import { D1ReportIntakeStore } from "./services/report-intake-d1.js";
import { createSitesIdentityAdapter } from "./services/sites-identity.js";
import { createPublicSite, createWebsite } from "./site/index.js";
import type { PublicSiteServices } from "./site/types.js";
import { bundledSiteAssets } from "./site/worker-assets.js";

declare const __WATCHDOG_SITES_PROJECT_ID__: string | null;

/** The only Sites project allowed to supply human claims to this Worker. */
const BETA2_SITES_PROJECT_ID = "appgprj_6af7fb8f615c81918da0e4450ba336de";

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

const worker = {
  async fetch(
    request: Request,
    environment: RuntimeEnvironment,
  ): Promise<Response> {
    const fallback = unavailableServices();
    if (!environment.DB) {
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
      const accounts = createD1AccountServices(database, sitesIdentity);
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
      const app = createApplication(services as unknown as ApplicationServices);
      const reports = reportApi(environment, services, database);
      const site = createPublicSite({
        services: reads,
        assets: bundledSiteAssets,
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
      return createWebsite({
        application: app,
        site,
        reports: reports.handler,
      }).fetch(request);
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

export default worker;

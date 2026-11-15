import { createApplication } from "./application.js";
import type { ReportIntakeStore } from "./contracts/report-intake.js";
import type { RuntimeEnvironment } from "./contracts/runtime.js";
import { StorageUnavailableError } from "./contracts/storage.js";
import { AsyncD1Database } from "./database/d1.js";
import { handleWebsiteMcpRequest } from "./mcp/website.js";
import { createReportApiModule, type ReportApiOptions } from "./report-api.js";
import { D1BannerPublicService } from "./services/banner-public.js";
import { createContentPublicationService } from "./services/content-publication.js";
import { createD1AccountServices } from "./services/d1-accounts.js";
import { createD1WebsiteInspectionService } from "./services/d1-inspection.js";
import { createD1PublicReadServices } from "./services/d1-public-reads.js";
import type { ApplicationServices } from "./services/index.js";
import { D1ReportIntakeStore } from "./services/report-intake-d1.js";
import { createSitesIdentityAdapter } from "./services/sites-identity.js";
import { createD1EditorialSource } from "./site/d1-editorial-source.js";
import { createPublicSite, createWebsite } from "./site/index.js";
import type { PublicSiteServices } from "./site/types.js";
import { bundledSiteAssets } from "./site/worker-assets.js";
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

// Sites currently documents identity headers but does not expose an
// authenticated identity context or a verifiable Worker gateway assertion.
// Never promote request headers into a VerifiedSitesContext here.

// This diagnostic is separate from the public site and API routers.
// Use a random 256-bit Sites secret for one invocation, then revoke the secret.
const R2_DIAGNOSTIC_PATH = "/_ops/diagnostics/r2-binding";
const R2_DIAGNOSTIC_KEY = "__watchdog_diagnostics/r2-binding-check/2026-11-15-v1";
const R2_DIAGNOSTIC_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function hasR2DiagnosticCredential(
  request: Request,
  environment: RuntimeEnvironment,
): boolean {
  const token = environment.R2_DIAGNOSTIC_TOKEN;
  if (
    typeof token !== "string" ||
    !R2_DIAGNOSTIC_TOKEN_PATTERN.test(token)
  ) {
    return false;
  }
  const expected = `Bearer ${token}`;
  const supplied = request.headers.get("authorization") ?? "";
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}

async function runR2BindingDiagnostic(
  request: Request,
  environment: RuntimeEnvironment,
): Promise<Response> {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (
    request.method !== "POST" ||
    !hasR2DiagnosticCredential(request, environment)
  ) {
    // Do not reveal the route, whether a secret is configured, or binding state.
    return new Response(null, { status: 404, headers });
  }

  let outcome:
    | "binding_missing"
    | "head_null"
    | "head_object"
    | "head_failed";
  if (!environment.BUCKET) {
    outcome = "binding_missing";
  } else {
    try {
      outcome = (await environment.BUCKET.head(R2_DIAGNOSTIC_KEY))
        ? "head_object"
        : "head_null";
    } catch {
      outcome = "head_failed";
    }
  }

  // Keep production logs limited to the four result categories above.
  console.info(`r2_binding_diagnostic:${outcome}`);
  return new Response(null, { status: 204, headers });
}

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

const worker = {
  async fetch(
    request: Request,
    environment: RuntimeEnvironment,
  ): Promise<Response> {
    const fallback = unavailableServices();
    const pathname = new URL(request.url).pathname;
    const publicationRoute =
      pathname === CONTENT_PUBLICATION_API_PATHS.publish ||
      pathname === CONTENT_PUBLICATION_API_PATHS.withdraw;
    if (pathname === R2_DIAGNOSTIC_PATH) {
      return runR2BindingDiagnostic(request, environment);
    }
    if (!environment.DB) {
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
      const app = createApplication(services as unknown as ApplicationServices);
      const reports = reportApi(environment, services, database);
      const site = createPublicSite({
        services: reads,
        editorial: createD1EditorialSource(database),
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

export default worker;

import { createApplication } from "./application.js";
import type { RuntimeEnvironment } from "./contracts/runtime.js";
import { StorageUnavailableError } from "./contracts/storage.js";
import { AsyncD1Database } from "./database/d1.js";
import { createD1PublicReadServices } from "./services/d1-public-reads.js";
import type { ApplicationServices } from "./services/index.js";
import { createPublicSite, createWebsite } from "./site/index.js";
import type { PublicSiteServices } from "./site/types.js";
import { bundledSiteAssets } from "./site/worker-assets.js";

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

const worker = {
  async fetch(
    request: Request,
    environment: RuntimeEnvironment,
  ): Promise<Response> {
    const fallback = unavailableServices();
    if (!environment.DB) {
      const app = createApplication(fallback as unknown as ApplicationServices);
      const site = createPublicSite({
        services: fallback as unknown as PublicSiteServices,
        assets: bundledSiteAssets,
      });
      return createWebsite({ application: app, site }).fetch(request);
    }

    try {
      const database = new AsyncD1Database(environment.DB);
      const reads = createD1PublicReadServices(database);
      const services = {
        ...fallback,
        ...reads,
        async readiness() {
          await database.first("SELECT 1 AS ready");
          return { status: "ready" as const };
        },
        async health() {
          await database.first("SELECT 1 AS ready");
          return { status: "ok" as const };
        },
        async resolvePrincipal() {
          return null;
        },
      };
      const app = createApplication(services as unknown as ApplicationServices);
      const site = createPublicSite({
        services: reads,
        assets: bundledSiteAssets,
      });
      return createWebsite({ application: app, site }).fetch(request);
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

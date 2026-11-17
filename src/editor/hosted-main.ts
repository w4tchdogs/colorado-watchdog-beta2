import type { FetchLike } from "./api-client.js";
import {
  type BannerAdminFetch,
  createBannerAdminClient,
} from "./banner-admin-client.js";
import { createBannersView } from "./banner-views.js";
import { mountDashboard } from "./dashboard.js";
import { createDashboardClient } from "./dashboard-client.js";
import { accountView, overviewView } from "./dashboard-views.js";

/**
 * Hosted dashboard entry. It carries no sandbox switch, no synthetic account,
 * no fixture and no sandbox header. The server decides who the caller is from
 * the Website session cookie, and only modules the server marks active have a
 * view here. Banners uses the same cookie, so its client sends no token or
 * account header, and the protected routes keep checking `banner.manage`.
 * Posts & Stories is added once its hosted dependencies are verified.
 */
const root = document.getElementById("app");

if (root) {
  const sameOriginFetch: FetchLike = (input, init) =>
    fetch(input, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  const bannerFetch: BannerAdminFetch = (input, init) =>
    fetch(input, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  const bannerClient = createBannerAdminClient({ fetch: bannerFetch });
  mountDashboard(root, {
    doc: document,
    client: createDashboardClient({ fetch: sameOriginFetch }),
    publicSiteUrl: "/",
    views: {
      overview: overviewView,
      account: accountView,
      banners: createBannersView({ client: bannerClient }),
    },
    signOut: { action: "/auth/logout" },
  });
}

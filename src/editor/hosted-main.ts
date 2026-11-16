import type { FetchLike } from "./api-client.js";
import { mountDashboard } from "./dashboard.js";
import { createDashboardClient } from "./dashboard-client.js";
import { accountView, overviewView } from "./dashboard-views.js";

/**
 * Hosted dashboard entry. It carries no sandbox switch, no synthetic account,
 * no fixture and no sandbox header. The server decides who the caller is from
 * the Website session cookie, and only modules the server marks active have a
 * view here. Posts & Stories and Banners are added once their hosted
 * dependencies are verified.
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
  mountDashboard(root, {
    doc: document,
    client: createDashboardClient({ fetch: sameOriginFetch }),
    publicSiteUrl: "/",
    views: { overview: overviewView, account: accountView },
    signOut: { action: "/auth/logout" },
  });
}

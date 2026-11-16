import { createEditorApiClient, type FetchLike } from "./api-client.js";
import {
  type BannerAdminFetch,
  createBannerAdminClient,
} from "./banner-admin-client.js";
import { createBannersView } from "./banner-views.js";
import { mountDashboard } from "./dashboard.js";
import { createDashboardClient } from "./dashboard-client.js";
import {
  accountView,
  createPostsView,
  overviewView,
} from "./dashboard-views.js";

const root = document.getElementById("app");
const token =
  document
    .querySelector('meta[name="editor-token"]')
    ?.getAttribute("content") ?? "";

if (root) {
  // The acting account lives in memory only. Nothing is kept in browser
  // storage, so a reload returns to the default sandbox account.
  const session = { account: "author" };
  const sameOriginFetch: FetchLike = (input, init) =>
    fetch(input, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  const connection = {
    fetch: sameOriginFetch,
    token,
    account: () => session.account,
  };
  const editorClient = createEditorApiClient(connection);
  const dashboardClient = createDashboardClient(connection);
  const bannerFetch: BannerAdminFetch = (input, init) =>
    fetch(input, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  const bannerClient = createBannerAdminClient({
    fetch: bannerFetch,
    token,
    account: () => session.account,
  });

  void (async () => {
    // Sandbox-only details: the synthetic accounts and the local public site.
    let accounts: readonly { key: string; label: string }[] = [];
    let publicSiteUrl: string | null = null;
    try {
      const info = await editorClient.sandboxInfo();
      accounts = info.accounts;
      publicSiteUrl = info.publicSiteUrl ?? null;
    } catch {
      // The shell still loads and reports its own errors.
    }
    mountDashboard(root, {
      doc: document,
      client: dashboardClient,
      publicSiteUrl,
      views: {
        overview: overviewView,
        account: accountView,
        posts: createPostsView({ client: editorClient, session }),
        banners: createBannersView({ client: bannerClient }),
      },
      sandbox: {
        accounts,
        current: () => session.account,
        switchTo: (key) => {
          session.account = key;
        },
      },
    });
  })();
}

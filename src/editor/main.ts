import { createEditorApiClient } from "./api-client.js";
import { createBannerAdminClient } from "./banner-admin-client.js";
import { createBannersView } from "./banner-views.js";
import { createCountyStructureClient } from "./county-structure-client.js";
import { createCountyStructureView } from "./county-structure-view.js";
import { createDashboardClient } from "./dashboard-client.js";
import { mountSandboxDashboard, sandboxHeaders } from "./dashboard-sandbox.js";
import {
  accountView,
  createPostsView,
  overviewView,
} from "./dashboard-views.js";
import { createProfilesClient } from "./profiles-client.js";
import { createProfilesView } from "./profiles-view.js";

const root = document.getElementById("app");
const token =
  document
    .querySelector('meta[name="editor-token"]')
    ?.getAttribute("content") ?? "";

if (root) {
  // The acting account lives in memory only. Nothing is kept in browser
  // storage, so a reload returns to the default sandbox account.
  const session = { account: "author" };
  const sameOriginFetch = (input: string, init?: RequestInit) =>
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
  const headersForSandbox = sandboxHeaders(connection);
  const editorClient = createEditorApiClient(connection);
  const dashboardClient = createDashboardClient({
    fetch: sameOriginFetch,
    headers: headersForSandbox,
  });
  const bannerClient = createBannerAdminClient({
    fetch: sameOriginFetch,
    headers: headersForSandbox,
  });
  const sandboxFetch = (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headersForSandbox()))
      headers.set(key, value);
    return sameOriginFetch(input, { ...init, headers });
  };

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
    mountSandboxDashboard(root, {
      doc: document,
      client: dashboardClient,
      publicSiteUrl,
      views: {
        overview: overviewView,
        account: accountView,
        posts: createPostsView({ client: editorClient, session }),
        banners: createBannersView({ client: bannerClient }),
        profiles: createProfilesView({
          client: createProfilesClient({ fetch: sandboxFetch }),
        }),
        "county-structure": createCountyStructureView({
          client: createCountyStructureClient({ fetch: sandboxFetch }),
        }),
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

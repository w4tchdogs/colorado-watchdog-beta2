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
import { createProfilesClient, type ProfilesFetch } from "./profiles-client.js";
import { createProfilesView } from "./profiles-view.js";

/**
 * Hosted dashboard entry. It carries no sandbox switch, no synthetic account,
 * no fixture and no sandbox header. The server decides who the caller is from
 * the Website session cookie, and only modules the server marks active have a
 * view here. Banners uses the same cookie, so its client sends no token or
 * account header, and the protected routes keep checking `banner.manage`.
 * Posts & Stories uses the same cookie. Its client sends no sandbox header and
 * the draft routes keep checking `content.publish` on every request. It offers
 * draft editing only, with no publication controls.
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
  const profilesFetch: ProfilesFetch = (input, init) =>
    fetch(input, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  const bannerClient = createBannerAdminClient({ fetch: bannerFetch });
  // The editor reads no account from the page. The server decides who the
  // caller is, so the session below only labels unsaved edits.
  const editorClient = createEditorApiClient({ fetch: sameOriginFetch });
  mountDashboard(root, {
    doc: document,
    client: createDashboardClient({ fetch: sameOriginFetch }),
    publicSiteUrl: "/",
    views: {
      overview: overviewView,
      account: accountView,
      posts: createPostsView({
        client: editorClient,
        session: { account: "" },
      }),
      banners: createBannersView({ client: bannerClient }),
      profiles: createProfilesView({
        client: createProfilesClient({ fetch: profilesFetch }),
      }),
    },
    signOut: { action: "/auth/logout" },
  });
}

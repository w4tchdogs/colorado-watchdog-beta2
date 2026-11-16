import type { ContentSummary } from "../contracts/content.js";
import type {
  DashboardAccountSummary,
  DashboardModuleLink,
} from "../contracts/dashboard.js";
import type { EditorApiClient } from "./api-client.js";
import { type EditorSession, mountEditorApp } from "./app.js";
import type { DashboardViewFactory } from "./dashboard.js";
import { el } from "./dom.js";

/**
 * The three working dashboard views. Each renders only the server data it is
 * handed. Text goes through text nodes, never markup.
 */
type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes?: Parameters<typeof el>[2],
  ...children: Parameters<typeof el>[3][]
) => HTMLElementTagNameMap[K];

const helper =
  (doc: Document): H =>
  (tag, attributes = {}, ...children) =>
    el(doc, tag, attributes, ...children);

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};
const formatDateTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

function card(h: H, id: string, title: string, ...children: Node[]) {
  return h(
    "section",
    { class: "dash-card", id, "aria-labelledby": `${id}-h` },
    h("h2", { id: `${id}-h` }, title),
    ...children,
  );
}

function definitionList(h: H, rows: readonly (readonly [string, string])[]) {
  return h(
    "dl",
    { class: "dash-facts" },
    ...rows.map(([term, value]) =>
      h("div", {}, h("dt", {}, term), h("dd", {}, value)),
    ),
  );
}

const accountRows = (account: DashboardAccountSummary) =>
  [
    ["Name", account.displayName],
    ["Email", account.email ?? "Not recorded"],
    ["Role", account.roleLabel],
  ] as const;

function moduleList(
  h: H,
  modules: readonly DashboardModuleLink[],
  hrefFor: ((id: string) => string) | null,
) {
  return h(
    "ul",
    { class: "dash-module-list" },
    ...modules.map((module) =>
      h(
        "li",
        {},
        hrefFor
          ? h("a", { href: hrefFor(module.id) }, module.label)
          : h("strong", {}, module.label),
        h("span", { class: "dash-module-note" }, module.description),
      ),
    ),
  );
}

export const overviewView: DashboardViewFactory = (context) => {
  const { data, container, hrefFor } = context;
  if (data.view !== "overview") return { destroy() {} };
  const h = helper(context.doc);
  const others = data.modules.filter((module) => module.id !== "overview");
  // A module this role will get but that is not available yet still means the
  // role has staff tools. Only a role with none at all gets the plain note.
  const staffTools =
    others.some((module) => module.id !== "account") ||
    data.planned.length > 0;

  const children: Node[] = [
    h("h1", { id: "overview-heading" }, `Welcome, ${data.account.displayName}`),
    h(
      "p",
      { class: "dash-lede" },
      `You are signed in as ${data.account.roleLabel}.`,
    ),
    card(
      h,
      "overview-account",
      "Your account",
      definitionList(h, accountRows(data.account)),
      h(
        "p",
        {},
        h(
          "a",
          { href: hrefFor("account"), class: "dash-action" },
          "Open My Account",
        ),
      ),
    ),
    card(
      h,
      "overview-actions",
      "What you can do here",
      moduleList(h, others, hrefFor),
      staffTools
        ? h("p", { class: "help" }, "This list follows your role.")
        : h(
            "p",
            { class: "help", id: "overview-no-staff-tools" },
            "Your role has no staff tools. Drafts, reports and administration are not part of this account.",
          ),
    ),
  ];

  if (data.editorial) {
    children.push(
      card(
        h,
        "overview-editorial",
        "Posts & Stories",
        h(
          "p",
          { class: "actions" },
          h(
            "a",
            { href: hrefFor("posts", "/new/post"), class: "dash-action" },
            "New Post",
          ),
          h(
            "a",
            { href: hrefFor("posts", "/new/story"), class: "dash-action" },
            "New Story",
          ),
          h("a", { href: hrefFor("posts") }, "All Posts & Stories"),
        ),
        h("h3", {}, "Recently modified"),
        data.editorial.recent.length === 0
          ? h(
              "p",
              { class: "empty", id: "overview-recent-empty" },
              "No Posts or Stories yet. Use New Post or New Story to start one.",
            )
          : recentList(h, data.editorial.recent, hrefFor),
      ),
    );
  }

  if (data.planned.length > 0) {
    children.push(
      card(
        h,
        "overview-planned",
        "Planned for your role",
        h(
          "p",
          { class: "help" },
          "These parts of the dashboard are not available yet. They have no page and no data here.",
        ),
        moduleList(h, data.planned, null),
      ),
    );
  }

  container.append(...children);
  return { destroy() {} };
};

function recentList(
  h: H,
  items: readonly ContentSummary[],
  hrefFor: (id: string, subPath?: string) => string,
) {
  return h(
    "ul",
    { class: "dash-recent", id: "overview-recent" },
    ...items.map((item) =>
      h(
        "li",
        {},
        h("a", { href: hrefFor("posts", `/item/${item.id}`) }, item.title),
        h(
          "span",
          { class: "dash-module-note" },
          `${item.contentType === "post" ? "Post" : "Story"}, ${item.status === "draft" ? "draft" : "archived"}, version ${item.version}, changed ${formatDateTime(item.updatedAt)}`,
        ),
      ),
    ),
  );
}

export const accountView: DashboardViewFactory = (context) => {
  const { data, container } = context;
  if (data.view !== "account") return { destroy() {} };
  const h = helper(context.doc);
  container.append(
    h("h1", { id: "account-heading" }, "My Account"),
    h(
      "p",
      { class: "dash-lede" },
      "These are the details recorded for your own account.",
    ),
    card(
      h,
      "account-profile",
      "Profile",
      definitionList(h, [
        ...accountRows(data.account),
        ["Status", "Active"],
        ["Member since", formatDate(data.account.memberSince)],
      ]),
    ),
    card(
      h,
      "account-sign-in",
      "Sign-in",
      data.signInMethods.length === 0
        ? h("p", { class: "empty" }, "No sign-in method is linked.")
        : h(
            "ul",
            { class: "dash-module-list" },
            ...data.signInMethods.map((method) =>
              h(
                "li",
                {},
                h("strong", {}, method.label),
                h(
                  "span",
                  { class: "dash-module-note" },
                  `Linked ${formatDate(method.linkedAt)}${method.expiresAt ? `, expires ${formatDate(method.expiresAt)}` : ""}${method.current ? ". Used for this session." : ""}`,
                ),
              ),
            ),
          ),
    ),
    card(
      h,
      "account-access",
      "Your access",
      moduleList(h, data.modules, context.hrefFor),
    ),
    h(
      "p",
      { class: "help", id: "account-edit-note" },
      "An administrator manages names, email addresses, roles and sign-in links. Changing them from this page is not available.",
    ),
  );
  return { destroy() {} };
};

export interface PostsViewOptions {
  readonly client: EditorApiClient;
  readonly session: EditorSession;
  readonly pageSize?: number;
  readonly previewDelayMs?: number;
  readonly searchDelayMs?: number;
  readonly confirmLeave?: (message: string) => boolean;
}

/** Hosts the existing editorial workspace inside the dashboard shell. */
export function createPostsView(
  options: PostsViewOptions,
): DashboardViewFactory {
  return (context) => {
    if (context.data.view !== "posts") return { destroy() {} };
    const app = mountEditorApp(context.container, {
      doc: context.doc,
      client: options.client,
      session: options.session,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.previewDelayMs === undefined
        ? {}
        : { previewDelayMs: options.previewDelayMs }),
      ...(options.searchDelayMs === undefined
        ? {}
        : { searchDelayMs: options.searchDelayMs }),
      ...(options.confirmLeave ? { confirmLeave: options.confirmLeave } : {}),
      host: {
        routePrefix: "/posts",
        homeLabel: "Posts & Stories",
        announce: context.announce,
      },
    });
    return { canLeave: () => app.canLeave(), destroy: () => app.destroy() };
  };
}

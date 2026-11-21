import type {
  DashboardModuleLink,
  DashboardSession,
  DashboardView,
} from "../contracts/dashboard.js";
import { EditorApiError } from "./api-client.js";
import type { DashboardClient } from "./dashboard-client.js";
import { clear, el, replaceChildren } from "./dom.js";

/**
 * Dashboard shell: sidebar, page indication, account menu and one view slot.
 *
 * Integration point for later modules: add the module to
 * `src/contracts/dashboard.ts` as `active`, return its data from the dashboard
 * service, and register a `DashboardViewFactory` under the same id in the
 * `views` option. The shell asks the server before it mounts any view, so a
 * factory never runs for an account the server refused.
 */
export interface DashboardViewContext {
  readonly doc: Document;
  /** Empty element the view renders into. The shell clears it afterwards. */
  readonly container: HTMLElement;
  /** Server data for this view, already authorized for this account. */
  readonly data: DashboardView;
  readonly session: DashboardSession;
  /** Hash link to a module, for example `hrefFor("posts", "/new/post")`. */
  hrefFor(id: string, subPath?: string): string;
  announce(text: string): void;
}

export interface DashboardViewHandle {
  /** Return false to keep the user on this view (unsaved work). */
  canLeave?(): boolean;
  destroy(): void;
}

export type DashboardViewFactory = (
  context: DashboardViewContext,
) => DashboardViewHandle;

export interface DashboardOptions {
  readonly doc: Document;
  readonly client: DashboardClient;
  readonly views: Readonly<Record<string, DashboardViewFactory>>;
  /** Absolute or root-relative address of the public site, when known. */
  readonly publicSiteUrl?: string | null;
  /**
   * Optional strip above the header. The local sandbox uses it for its strip with its synthetic account
   * switch. The hosted entry never passes it, and the switch code lives in
   * `dashboard-sandbox.ts`, which the hosted bundle does not include.
   */
  readonly topStrip?: (hooks: DashboardStripHooks) => HTMLElement;
  /** Sandbox wording for the page title and the signed-out panel. */
  readonly titleSuffix?: string;
  readonly signedOutNote?: string;
  /** Hosted sign-in link, shown when the dashboard requires sign-in. */
  readonly signInHref?: string;
  /**
   * Hosted sign-out. Renders a same-origin form that posts to the Website
   * sign-out route, which revokes the session and clears its cookie. The
   * sandbox never passes this.
   */
  readonly signOut?: { readonly action: string };
}

/** What the shell lends to a strip it did not build itself. */
export interface DashboardStripHooks {
  /** False when the open view has unsaved work and the user stays. */
  canLeave(): boolean;
  announce(text: string): void;
  /** Reloads the session and the open view for the account now in use. */
  restart(): void;
}

export interface Dashboard {
  destroy(): void;
}

const VIEW_ID = /^[a-z](?:[a-z]|-(?=[a-z])){0,31}$/;
const DEFAULT_VIEW = "overview";

export function mountDashboard(
  root: HTMLElement,
  options: DashboardOptions,
): Dashboard {
  const doc = options.doc;
  const win = doc.defaultView;
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);

  let session: DashboardSession | null = null;
  let handle: DashboardViewHandle | null = null;
  let currentView = "";
  let lastHash = win?.location.hash ?? "";
  let suppressHash = false;
  let renderToken = 0;
  let destroyed = false;

  // ------------------------------------------------------------- chrome
  const live = h("div", {
    class: "visually-hidden",
    role: "status",
    "aria-live": "polite",
  });
  const announce = (text: string) => {
    live.textContent = "";
    live.textContent = text;
  };
  const main = h("main", { id: "main", tabindex: "-1" });
  const crumb = h("p", { class: "dash-crumb", id: "dash-page-title" });
  const navList = h("div", { class: "dash-nav-groups" });
  const sidebarFoot = h("div", { class: "dash-sidebar-foot" });
  const sidebar = h(
    "nav",
    { id: "dash-sidebar", class: "dash-sidebar", "aria-label": "Dashboard" },
    h("div", { class: "dash-sidebar-inner" }, navList, sidebarFoot),
  );
  const menuToggle = h(
    "button",
    {
      type: "button",
      id: "dash-menu-toggle",
      class: "dash-menu-toggle",
      "aria-expanded": "false",
      "aria-controls": "dash-sidebar",
    },
    "Menu",
  );
  const accountButton = h("button", {
    type: "button",
    id: "account-menu-button",
    class: "dash-account-button",
    "aria-expanded": "false",
    "aria-controls": "account-menu",
  });
  const accountMenu = h("div", {
    id: "account-menu",
    class: "dash-account-menu",
    hidden: true,
  });
  const accountSlot = h("div", { class: "dash-account" });

  const topStrip =
    options.topStrip?.({
      canLeave: () => !(handle?.canLeave && !handle.canLeave()),
      announce,
      restart: () => void start(),
    }) ?? null;

  const shell = h(
    "div",
    { class: "dash" },
    h("a", { class: "skip-link", href: "#main" }, "Skip to content"),
    topStrip,
    h(
      "header",
      { class: "dash-topbar" },
      menuToggle,
      h(
        "a",
        {
          class: "dash-brand",
          href: `#/${DEFAULT_VIEW}`,
          "aria-label": "Colorado Watchdog dashboard, Overview",
        },
        h("span", { class: "dash-brand-name" }, "Colorado Watchdog"),
        h("span", { class: "dash-brand-sub" }, "Dashboard"),
      ),
      crumb,
      accountSlot,
    ),
    h("div", { class: "dash-body" }, sidebar, main),
    live,
  );
  clear(root);
  root.appendChild(shell);

  // -------------------------------------------------------- menu states
  const setSidebarOpen = (open: boolean) => {
    shell.classList.toggle("is-nav-open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
  };
  menuToggle.addEventListener("click", () =>
    setSidebarOpen(menuToggle.getAttribute("aria-expanded") !== "true"),
  );

  const setAccountMenuOpen = (open: boolean) => {
    accountMenu.hidden = !open;
    accountButton.setAttribute("aria-expanded", String(open));
  };
  accountButton.addEventListener("click", () =>
    setAccountMenuOpen(accountMenu.hidden),
  );
  accountMenu.addEventListener("click", (event) => {
    if ((event.target as Element | null)?.closest("a")) {
      setAccountMenuOpen(false);
    }
  });
  const onDocumentClick = (event: Event) => {
    const target = event.target as Node | null;
    if (target && !accountSlot.contains(target)) setAccountMenuOpen(false);
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!accountMenu.hidden) {
      setAccountMenuOpen(false);
      accountButton.focus();
    } else if (shell.classList.contains("is-nav-open")) {
      setSidebarOpen(false);
      menuToggle.focus();
    }
  };
  doc.addEventListener("click", onDocumentClick);
  doc.addEventListener("keydown", onKeydown);

  // ------------------------------------------------------------ routing
  const hrefFor = (id: string, subPath = "") => `#/${id}${subPath}`;
  function viewFromHash(): string {
    const value = (win?.location.hash ?? "").replace(/^#\/?/, "");
    const first = value.split("/")[0] ?? "";
    if (first === "") return DEFAULT_VIEW;
    return VIEW_ID.test(first) ? first : "unknown";
  }

  const onHashChange = () => {
    if (!win) return;
    if (suppressHash) {
      suppressHash = false;
      return;
    }
    const next = viewFromHash();
    if (next === currentView && handle) {
      // A move inside the open view. The view handles it.
      lastHash = win.location.hash;
      return;
    }
    if (handle?.canLeave && !handle.canLeave()) {
      suppressHash = true;
      win.location.hash = lastHash;
      return;
    }
    lastHash = win.location.hash;
    void route();
  };
  win?.addEventListener("hashchange", onHashChange);

  // ---------------------------------------------------------- rendering
  const signInLink = () =>
    options.signInHref
      ? h("a", { class: "dash-signin", href: options.signInHref }, "Sign in")
      : null;

  function renderChrome(signInRequired: boolean): void {
    const groups = new Map<string, DashboardModuleLink[]>();
    for (const module of session?.modules ?? []) {
      const list = groups.get(module.groupLabel) ?? [];
      list.push(module);
      groups.set(module.groupLabel, list);
    }
    replaceChildren(
      doc,
      navList,
      ...[...groups].map(([label, modules]) =>
        h(
          "div",
          { class: "dash-nav-group" },
          h("p", { class: "dash-nav-heading" }, label),
          h(
            "ul",
            {},
            ...modules.map((module) =>
              h(
                "li",
                {},
                h(
                  "a",
                  {
                    href: hrefFor(module.id),
                    "data-view": module.id,
                    ...(module.id === currentView
                      ? { "aria-current": "page" }
                      : {}),
                  },
                  module.label,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const siteLink = (id: string) =>
      options.publicSiteUrl
        ? h(
            "a",
            { href: options.publicSiteUrl, id, rel: "noreferrer" },
            "View public site",
          )
        : null;
    replaceChildren(doc, sidebarFoot, siteLink("public-site-link"));

    if (!session) {
      replaceChildren(
        doc,
        accountSlot,
        (signInRequired ? signInLink() : null) ??
          h(
            "p",
            { class: "dash-signed-out", id: "signed-out" },
            "Not signed in",
          ),
      );
      return;
    }
    accountButton.textContent = session.account.displayName;
    replaceChildren(
      doc,
      accountMenu,
      h("p", { class: "dash-account-name" }, session.account.displayName),
      h("p", { class: "dash-account-role" }, session.account.roleLabel),
      h(
        "ul",
        {},
        h(
          "li",
          {},
          h(
            "a",
            { href: hrefFor("account"), id: "menu-account" },
            "My Account",
          ),
        ),
        options.publicSiteUrl ? h("li", {}, siteLink("menu-site")) : null,
      ),
      options.signOut
        ? h(
            "form",
            {
              method: "post",
              action: options.signOut.action,
              class: "dash-signout",
              id: "menu-signout-form",
            },
            h("button", { type: "submit", id: "menu-signout" }, "Sign out"),
          )
        : null,
    );
    setAccountMenuOpen(false);
    replaceChildren(doc, accountSlot, accountButton, accountMenu);
  }

  function setTitle(label: string): void {
    replaceChildren(
      doc,
      crumb,
      h("span", { class: "dash-crumb-root" }, "Dashboard"),
      label ? h("span", { class: "dash-crumb-page" }, label) : null,
    );
    doc.title = `${label ? `${label} - ` : ""}Colorado Watchdog dashboard${options.titleSuffix ?? ""}`;
  }

  function panel(
    id: string,
    heading: string,
    text: string,
    ...extra: Parameters<typeof el>[3][]
  ): void {
    replaceChildren(
      doc,
      main,
      h(
        "section",
        { class: "dash-state", id },
        h("h1", {}, heading),
        h("p", {}, text),
        ...extra,
      ),
    );
    setTitle(heading);
    announce(heading);
    focusMain();
  }
  const overviewLink = () =>
    h("p", {}, h("a", { href: hrefFor(DEFAULT_VIEW) }, "Go to Overview"));
  const retryButton = (action: () => void) => {
    const button = h(
      "button",
      { type: "button", id: "dash-retry" },
      "Try again",
    );
    button.addEventListener("click", action);
    return button;
  };

  /** Moves focus to the page without leaving the view scrolled part-way. */
  function focusMain(): void {
    main.focus({ preventScroll: true });
    doc.documentElement.scrollTop = 0;
  }

  function leaveView(): void {
    handle?.destroy();
    handle = null;
    clear(main);
  }

  /** Loads the session from the server, then opens the view in the hash. */
  async function start(): Promise<void> {
    if (destroyed) return;
    const token = ++renderToken;
    leaveView();
    currentView = viewFromHash();
    replaceChildren(
      doc,
      main,
      h("p", { class: "loading", role: "status" }, "Loading dashboard..."),
    );
    let failure: unknown = null;
    try {
      session = await options.client.session();
    } catch (error) {
      session = null;
      failure = error;
    }
    if (destroyed || token !== renderToken) return;
    const signInRequired =
      failure instanceof EditorApiError &&
      (failure.code === "authentication_required" ||
        failure.code === "forbidden");
    renderChrome(signInRequired);
    if (session) {
      await route();
      return;
    }
    setTitle("");
    if (signInRequired) {
      panel(
        "state-signed-out",
        "Sign in required",
        "The dashboard is available to signed-in accounts. No account is signed in, or this account is not active.",
        signInLink(),
        options.signedOutNote ? h("p", {}, options.signedOutNote) : null,
      );
      return;
    }
    panel(
      "state-error",
      "The dashboard could not be loaded",
      failure instanceof EditorApiError && failure.code === "network_error"
        ? "The server could not be reached."
        : "Something went wrong on the server. Nothing was changed.",
      retryButton(() => void start()),
    );
  }

  /** Asks the server for the view in the hash and mounts it when allowed. */
  async function route(): Promise<void> {
    if (destroyed) return;
    const token = ++renderToken;
    leaveView();
    setSidebarOpen(false);
    setAccountMenuOpen(false);
    currentView = viewFromHash();
    const module = session?.modules.find((entry) => entry.id === currentView);
    setTitle(module?.label ?? "");
    for (const anchor of Array.from(navList.querySelectorAll("a[data-view]"))) {
      if (anchor.getAttribute("data-view") === currentView)
        anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    }
    if (!session) {
      void start();
      return;
    }
    replaceChildren(
      doc,
      main,
      h("p", { class: "loading", role: "status" }, "Loading..."),
    );
    let data: DashboardView;
    try {
      data = await options.client.view(currentView);
    } catch (error) {
      if (destroyed || token !== renderToken) return;
      const code = error instanceof EditorApiError ? error.code : "";
      if (code === "authentication_required") {
        // The account was signed out or disabled since the session loaded.
        void start();
      } else if (code === "forbidden") {
        panel(
          "state-denied",
          "Not available for this account",
          "Your role does not include this part of the dashboard.",
          overviewLink(),
        );
      } else if (code === "not_found" || code === "invalid_request") {
        panel(
          "state-not-found",
          "Page not found",
          "There is no dashboard page at this address.",
          overviewLink(),
        );
      } else {
        panel(
          "state-error",
          "This page could not be loaded",
          code === "network_error"
            ? "The server could not be reached."
            : "Something went wrong on the server. Nothing was changed.",
          retryButton(() => void route()),
        );
      }
      return;
    }
    if (destroyed || token !== renderToken) return;
    const factory = Object.hasOwn(options.views, currentView)
      ? options.views[currentView]
      : undefined;
    if (!factory) {
      panel(
        "state-not-found",
        "Page not found",
        "There is no dashboard page at this address.",
        overviewLink(),
      );
      return;
    }
    const container = h("div", {
      class: "dash-view",
      "data-view": currentView,
    });
    replaceChildren(doc, main, container);
    focusMain();
    handle = factory({
      doc,
      container,
      data,
      session,
      hrefFor,
      announce,
    });
    if (module) announce(`${module.label} loaded`);
  }

  void start();

  return {
    destroy() {
      destroyed = true;
      handle?.destroy();
      handle = null;
      win?.removeEventListener("hashchange", onHashChange);
      doc.removeEventListener("click", onDocumentClick);
      doc.removeEventListener("keydown", onKeydown);
      clear(root);
    },
  };
}

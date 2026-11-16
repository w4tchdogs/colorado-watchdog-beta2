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

export interface DashboardSandboxSwitch {
  readonly accounts: readonly {
    readonly key: string;
    readonly label: string;
  }[];
  current(): string;
  switchTo(key: string): void;
}

export interface DashboardOptions {
  readonly doc: Document;
  readonly client: DashboardClient;
  readonly views: Readonly<Record<string, DashboardViewFactory>>;
  /** Absolute or root-relative address of the public site, when known. */
  readonly publicSiteUrl?: string | null;
  /**
   * Local sandbox only. A hosted shell never passes this, so the synthetic
   * account switch has no hosted counterpart.
   */
  readonly sandbox?: DashboardSandboxSwitch;
}

export interface Dashboard {
  destroy(): void;
}

const VIEW_ID = /^[a-z]{1,32}$/;
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

  const sandboxBar = options.sandbox ? buildSandboxBar(options.sandbox) : null;

  const shell = h(
    "div",
    { class: "dash" },
    h("a", { class: "skip-link", href: "#main" }, "Skip to content"),
    sandboxBar,
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

  function buildSandboxBar(sandbox: DashboardSandboxSwitch): HTMLElement {
    const select = h("select", { id: "sandbox-account" });
    for (const account of sandbox.accounts) {
      select.appendChild(h("option", { value: account.key }, account.label));
    }
    select.value = sandbox.current();
    select.addEventListener("change", () => {
      if (handle?.canLeave && !handle.canLeave()) {
        select.value = sandbox.current();
        return;
      }
      sandbox.switchTo(select.value);
      announce(`Now acting as ${select.selectedOptions[0]?.text ?? ""}`);
      void start();
    });
    return h(
      "div",
      { class: "dash-sandbox", id: "sandbox-bar" },
      h(
        "p",
        { class: "sandbox-flag", id: "sandbox-flag" },
        "LOCAL SANDBOX - fictional data only, nothing is published",
      ),
      h(
        "div",
        { class: "account-switch" },
        h("label", { for: "sandbox-account" }, "Acting as"),
        select,
      ),
    );
  }

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
  function renderChrome(): void {
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
        h("p", { class: "dash-signed-out", id: "signed-out" }, "Not signed in"),
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
    doc.title = `${label ? `${label} - ` : ""}Colorado Watchdog dashboard${options.sandbox ? " (local sandbox)" : ""}`;
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
    renderChrome();
    if (session) {
      await route();
      return;
    }
    setTitle("");
    if (
      failure instanceof EditorApiError &&
      (failure.code === "authentication_required" ||
        failure.code === "forbidden")
    ) {
      panel(
        "state-signed-out",
        "Sign in required",
        "The dashboard is available to signed-in accounts. No account is signed in, or this account is not active.",
        options.sandbox
          ? h(
              "p",
              {},
              "In this local sandbox, choose an account under Acting as.",
            )
          : null,
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

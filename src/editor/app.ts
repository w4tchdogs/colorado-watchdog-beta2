import type {
  ContentCheckpoint,
  ContentItem,
  ContentRevision,
  ContentRevisionKind,
  ContentRevisionSummary,
  ContentSort,
  ContentStatus,
  ContentSummary,
  ContentType,
} from "../contracts/content.js";
import {
  describeError,
  type EditorApiClient,
  EditorApiError,
  type SandboxInfo,
} from "./api-client.js";
import { diffLines, hasChanges } from "./diff.js";
import { clear, el, replaceChildren } from "./dom.js";
import { renderMarkdownInto } from "./preview.js";
import { createRelationshipsPanel, type Rel } from "./relationships.js";
import { buildRevisionCompare } from "./revision-compare.js";
import { type AiPanel, createAiPanel } from "./ai-panel.js";
import { createVisualCanvas } from "./visual-canvas.js";
import { toVisual } from "./visual-model.js";
import {
  createWriterChrome,
  renderOutline as renderOutlineInto,
} from "./writer-chrome.js";

export interface EditorSession {
  /** Sandbox account key sent with each request. */
  account: string;
}

export interface EditorAppOptions {
  readonly doc: Document;
  readonly client: EditorApiClient;
  readonly session: EditorSession;
  readonly pageSize?: number;
  readonly previewDelayMs?: number;
  /** Delay before a relationship search runs after typing. */
  readonly searchDelayMs?: number;
  /** Used only when leaving an article that has unsaved changes. */
  readonly confirmLeave?: (message: string) => boolean;
  /**
   * Set when a dashboard shell hosts the workspace. The shell then owns the
   * page chrome and the account switch, and this app renders only its views
   * under the given hash prefix.
   */
  readonly host?: EditorHost;
}

export interface EditorHost {
  /** Hash path of the list view without the leading "#", for example "/posts". */
  readonly routePrefix: string;
  /** Name of the list view used in "Back to ..." links. */
  readonly homeLabel: string;
  readonly announce?: (text: string) => void;
}

export interface EditorApp {
  /** False when the user declines to discard unsaved changes. */
  canLeave(): boolean;
  destroy(): void;
}

type Route =
  | { readonly name: "dashboard" }
  | { readonly name: "new"; readonly type: ContentType }
  | { readonly name: "item"; readonly id: string };

type RelLike = {
  readonly countyFips: readonly string[];
  readonly personIds: readonly string[];
  readonly organizationIds: readonly string[];
};
type NoticeKind = "info" | "success" | "error";

/** Mirrors MAX_CONTENT_SEARCH_LENGTH. Types only cross the browser boundary. */
const MAX_CONTENT_SEARCH_LENGTH = 100;
const MAX_BODY_CHARACTERS = 200_000;
const REVISION_PAGE_SIZE = 10;

const CHANGE_LABELS: Readonly<Record<ContentRevisionKind, string>> = {
  baseline: "Baseline snapshot",
  create: "Created",
  update: "Edited",
  relationships: "Relationships changed",
  archive: "Archived",
  restore_draft: "Restored to draft",
  restore_revision: "Restored from an earlier revision",
};

export function mountEditorApp(
  root: HTMLElement,
  options: EditorAppOptions,
): EditorApp {
  const doc = options.doc;
  const win = doc.defaultView;
  const client = options.client;
  const session = options.session;
  const host = options.host ?? null;
  const prefix = host?.routePrefix ?? "";
  const homeLabel = host?.homeLabel ?? "dashboard";
  const pageSize = options.pageSize ?? 10;
  const previewDelay = options.previewDelayMs ?? 120;
  const searchDelay = options.searchDelayMs ?? 150;
  const confirmLeave =
    options.confirmLeave ??
    ((message: string) => win?.confirm(message) ?? true);
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);

  let info: SandboxInfo | null = null;
  let route: Route = { name: "dashboard" };
  let leaveGuard: (() => boolean) | null = null;
  let cleanupView: (() => void) | null = null;
  let renderToken = 0;
  let destroyed = false;
  let uid = 0;
  const nextId = (prefix: string) => `${prefix}-${++uid}`;

  // ------------------------------------------------------------- shell
  const live = h("div", {
    class: "visually-hidden",
    role: "status",
    "aria-live": "polite",
  });
  const accountSelect = h("select", {
    id: "sandbox-account",
    "aria-label": "Acting as sandbox account",
  });
  const main = host
    ? h("div", { id: "editor-host", class: "editor-host", tabindex: "-1" })
    : h("main", { id: "main", tabindex: "-1" });
  const shell = h(
    "div",
    { class: "shell" },
    h("a", { class: "skip-link", href: "#main" }, "Skip to content"),
    h(
      "header",
      { class: "topbar" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-name" }, "Colorado Watchdog"),
        h("span", { class: "brand-sub" }, "Editorial workspace"),
      ),
      h(
        "p",
        { class: "sandbox-flag", id: "sandbox-flag" },
        "LOCAL SANDBOX - fictional data only, nothing is published",
      ),
      h(
        "nav",
        { "aria-label": "Workspace" },
        h("a", { href: "#/", id: "nav-dashboard" }, "Dashboard"),
      ),
      h(
        "div",
        { class: "account-switch" },
        h("label", { for: "sandbox-account" }, "Acting as"),
        accountSelect,
      ),
    ),
    main,
    live,
  );
  clear(root);
  if (host) root.append(main, live);
  else root.appendChild(shell);

  const announce = (text: string) => {
    if (host?.announce) {
      host.announce(text);
      return;
    }
    live.textContent = "";
    live.textContent = text;
  };

  function notice(
    container: HTMLElement,
    kind: NoticeKind,
    text: string,
  ): void {
    replaceChildren(
      doc,
      container,
      h(
        "p",
        {
          class: `notice notice-${kind}`,
          role: kind === "error" ? "alert" : "status",
        },
        text,
      ),
    );
    announce(text);
  }

  const formatTime = (iso: string | null | undefined) => {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  };
  const relativeTime = (iso: string) => {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 0) return "";
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
  };
  const timeElement = (iso: string) =>
    h("time", { datetime: iso, title: iso }, formatTime(iso));

  // ------------------------------------------------------------ routing
  const inHost = (hash: string) => {
    const value = hash.replace(/^#/, "");
    return value === prefix || value.startsWith(`${prefix}/`);
  };
  function parseHash(hash: string): Route {
    let value = hash.replace(/^#/, "");
    if (host) value = inHost(hash) ? value.slice(prefix.length) : "";
    const item = /^\/item\/([A-Za-z0-9._:-]{1,128})$/.exec(value);
    if (item) return { name: "item", id: item[1] as string };
    const created = /^\/new\/(post|story)$/.exec(value);
    if (created) return { name: "new", type: created[1] as ContentType };
    return { name: "dashboard" };
  }
  const routeHash = (target: Route) =>
    target.name === "item"
      ? `#${prefix}/item/${target.id}`
      : target.name === "new"
        ? `#${prefix}/new/${target.type}`
        : host
          ? `#${prefix}`
          : "#/";
  const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b);

  function go(target: Route, replace = false): void {
    if (leaveGuard && !leaveGuard()) {
      return;
    }
    show(target, replace);
  }

  function show(target: Route, replace = false): void {
    if (destroyed) return;
    const token = ++renderToken;
    cleanupView?.();
    cleanupView = null;
    leaveGuard = null;
    route = target;
    const hash = routeHash(target);
    if (win && win.location.hash !== hash) {
      if (replace) win.history.replaceState(null, "", hash);
      else {
        suppressHash = true;
        win.location.hash = hash;
      }
    }
    if (target.name === "dashboard") renderDashboard(token);
    else renderEditor(target, token);
    main.focus();
  }

  let suppressHash = false;
  const onHashChange = () => {
    if (suppressHash) {
      suppressHash = false;
      return;
    }
    if (!win) return;
    if (host) {
      // The shell handles every hash outside this workspace, and restoring
      // the hash after a declined leave must not rebuild the open view.
      if (!inHost(win.location.hash)) return;
      if (sameRoute(parseHash(win.location.hash), route)) return;
    }
    const target = parseHash(win.location.hash);
    if (leaveGuard && !leaveGuard()) {
      suppressHash = true;
      win.location.hash = routeHash(route);
      return;
    }
    show(target, true);
  };
  win?.addEventListener("hashchange", onHashChange);

  const onBeforeUnload = (event: Event) => {
    if (leaveGuard && !isGuardClean()) {
      event.preventDefault();
    }
  };
  let guardIsClean: (() => boolean) | null = null;
  const isGuardClean = () => guardIsClean?.() ?? true;
  win?.addEventListener("beforeunload", onBeforeUnload);

  for (const anchor of [shell.querySelector("#nav-dashboard")]) {
    anchor?.addEventListener("click", (event) => {
      event.preventDefault();
      go({ name: "dashboard" });
    });
  }
  accountSelect.addEventListener("change", () => {
    session.account = accountSelect.value;
    announce(`Now acting as ${accountSelect.selectedOptions[0]?.text ?? ""}`);
    if (route.name === "dashboard") renderDashboard(++renderToken);
    else onAccountChanged?.();
  });
  let onAccountChanged: (() => void) | null = null;

  // ---------------------------------------------------------- dashboard
  function renderDashboard(token: number): void {
    const filters = {
      type: "",
      status: "",
      sort: "modified" as ContentSort,
      search: "",
    };
    const cursors: (string | null)[] = [null];
    let pageIndex = 0;
    let requestId = 0;

    const typeSelect = h(
      "select",
      { id: "filter-type" },
      h("option", { value: "" }, "All types"),
      h("option", { value: "post" }, "Posts"),
      h("option", { value: "story" }, "Stories"),
    );
    const statusSelect = h(
      "select",
      { id: "filter-status" },
      h("option", { value: "" }, "All states"),
      h("option", { value: "draft" }, "Draft"),
      h("option", { value: "archived" }, "Archived"),
    );
    const sortSelect = h(
      "select",
      { id: "sort-order" },
      h("option", { value: "modified" }, "Recently modified"),
      h("option", { value: "id" }, "ID order"),
    );
    const searchInput = h("input", {
      id: "search-text",
      type: "search",
      maxlength: String(MAX_CONTENT_SEARCH_LENGTH),
      autocomplete: "off",
      placeholder: "Title or summary",
    });
    const searchButton = h(
      "button",
      { type: "submit", id: "search-submit" },
      "Search",
    );
    const clearButton = h(
      "button",
      { type: "button", id: "filters-clear" },
      "Clear search and filters",
    );
    const summary = h("p", {
      class: "list-summary",
      id: "list-summary",
      role: "status",
    });
    const results = h("div", { class: "results" });
    const pager = h("div", { class: "pager" });
    const newPost = h("button", { type: "button", id: "new-post" }, "New Post");
    const newStory = h(
      "button",
      { type: "button", id: "new-story" },
      "New Story",
    );
    newPost.addEventListener("click", () => go({ name: "new", type: "post" }));
    newStory.addEventListener("click", () =>
      go({ name: "new", type: "story" }),
    );
    const form = h(
      "form",
      {
        class: "filters",
        role: "search",
        "aria-label": "Search and filter drafts",
      },
      h("label", { for: "search-text" }, "Search"),
      searchInput,
      searchButton,
      h("label", { for: "filter-type" }, "Type"),
      typeSelect,
      h("label", { for: "filter-status" }, "Status"),
      statusSelect,
      h("label", { for: "sort-order" }, "Sort by"),
      sortSelect,
      clearButton,
    );

    replaceChildren(
      doc,
      main,
      h(
        "div",
        { class: "page-head" },
        h("h1", {}, "Drafts"),
        h("div", { class: "actions" }, newPost, newStory),
      ),
      form,
      summary,
      results,
      pager,
    );

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      resetAndLoad();
    });
    typeSelect.addEventListener("change", () => resetAndLoad());
    statusSelect.addEventListener("change", () => resetAndLoad());
    sortSelect.addEventListener("change", () => resetAndLoad());
    clearButton.addEventListener("click", () => {
      typeSelect.value = "";
      statusSelect.value = "";
      searchInput.value = "";
      resetAndLoad();
      searchInput.focus();
    });
    // Any change to the search, filters or order starts again from page one.
    function resetAndLoad() {
      filters.type = typeSelect.value;
      filters.status = statusSelect.value;
      filters.sort = sortSelect.value === "id" ? "id" : "modified";
      filters.search = searchInput.value.trim();
      cursors.length = 1;
      pageIndex = 0;
      void load();
    }

    const hasActiveFilters = () =>
      filters.type !== "" || filters.status !== "" || filters.search !== "";

    function describeView(): string {
      const parts = [
        `Sorted by ${filters.sort === "modified" ? "recently modified, newest first" : "ID order"}`,
      ];
      if (filters.type)
        parts.push(`type: ${filters.type === "post" ? "Posts" : "Stories"}`);
      if (filters.status)
        parts.push(
          `status: ${filters.status === "draft" ? "Draft" : "Archived"}`,
        );
      if (filters.search) parts.push(`search: "${filters.search}"`);
      return parts.join(", ");
    }

    async function load(): Promise<void> {
      const mine = ++requestId;
      summary.textContent = describeView();
      replaceChildren(
        doc,
        results,
        h("p", { class: "loading", role: "status" }, "Loading drafts..."),
      );
      clear(pager);
      try {
        if (!info) info = await client.sandboxInfo();
        const position = cursors[pageIndex];
        const page = await client.listDrafts({
          limit: pageSize,
          sort: filters.sort,
          ...(filters.type ? { contentType: filters.type as ContentType } : {}),
          ...(filters.status
            ? { status: filters.status as ContentStatus }
            : {}),
          ...(filters.search ? { search: filters.search } : {}),
          ...(position
            ? filters.sort === "modified"
              ? { cursor: position }
              : { afterId: position }
            : {}),
        });
        if (mine !== requestId || token !== renderToken) return;
        renderRows(page.items);
        renderPager(page.hasMore, page.nextCursor, page.items.length);
        const shown = `${page.items.length} ${page.items.length === 1 ? "item" : "items"} shown`;
        summary.textContent = `${describeView()}. ${shown}.`;
        announce(shown);
      } catch (error) {
        if (mine !== requestId || token !== renderToken) return;
        const retry = h("button", { type: "button" }, "Try again");
        retry.addEventListener("click", () => void load());
        replaceChildren(
          doc,
          results,
          h(
            "p",
            { class: "notice notice-error", role: "alert" },
            describeError(error),
          ),
          retry,
        );
      }
    }

    function renderRows(items: readonly ContentSummary[]): void {
      if (items.length === 0) {
        replaceChildren(
          doc,
          results,
          h(
            "p",
            { class: "empty" },
            hasActiveFilters()
              ? "No Posts or Stories match this search and these filters. Try different words or clear the search and filters."
              : "No Posts or Stories yet. Use New Post or New Story to start one.",
          ),
        );
        return;
      }
      const body = h("tbody");
      for (const item of items) {
        const open = h(
          "a",
          {
            href: routeHash({ name: "item", id: item.id }),
            class: "open-link",
          },
          `Open ${item.title}`,
        );
        open.addEventListener("click", (event) => {
          event.preventDefault();
          go({ name: "item", id: item.id });
        });
        body.appendChild(
          h(
            "tr",
            {
              "data-id": item.id,
              class: item.status === "archived" ? "row-archived" : "",
            },
            h("td", {}, typeBadge(item.contentType)),
            h(
              "td",
              { class: "title-cell" },
              h("strong", {}, item.title),
              item.summary
                ? h("span", { class: "summary" }, item.summary)
                : null,
            ),
            h("td", { class: "num" }, `v${item.version}`),
            h(
              "td",
              { class: "modified-cell" },
              timeElement(item.updatedAt),
              h("span", { class: "relative" }, relativeTime(item.updatedAt)),
            ),
            h("td", {}, statusBadge(item.status)),
            h("td", {}, open),
          ),
        );
      }
      const modifiedHead = h(
        "th",
        {
          scope: "col",
          ...(filters.sort === "modified" ? { "aria-sort": "descending" } : {}),
        },
        "Last modified",
      );
      replaceChildren(
        doc,
        results,
        h(
          "table",
          { class: "drafts" },
          h("caption", { class: "visually-hidden" }, "Posts and Stories"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ...["Type", "Title and summary", "Version"].map((label) =>
                h("th", { scope: "col" }, label),
              ),
              modifiedHead,
              ...["Status", "Open"].map((label) =>
                h("th", { scope: "col" }, label),
              ),
            ),
          ),
          body,
        ),
      );
    }

    function renderPager(
      hasMore: boolean,
      nextCursor: string | null,
      count: number,
    ): void {
      const previous = h(
        "button",
        { type: "button", id: "page-previous", disabled: pageIndex === 0 },
        "Previous page",
      );
      const next = h(
        "button",
        { type: "button", id: "page-next", disabled: !hasMore },
        "Next page",
      );
      previous.addEventListener("click", () => {
        pageIndex -= 1;
        void load();
      });
      next.addEventListener("click", () => {
        if (!nextCursor) return;
        cursors.length = pageIndex + 1;
        cursors.push(nextCursor);
        pageIndex += 1;
        void load();
      });
      replaceChildren(
        doc,
        pager,
        previous,
        h(
          "span",
          { class: "page-label", id: "page-label" },
          `Page ${pageIndex + 1} (${count} shown)`,
        ),
        next,
      );
    }

    void (async () => {
      await populateAccounts();
      if (token === renderToken) await load();
    })();
  }

  async function populateAccounts(): Promise<void> {
    if (accountSelect.options.length > 0) return;
    try {
      info = info ?? (await client.sandboxInfo());
    } catch {
      return;
    }
    for (const account of info.accounts) {
      accountSelect.appendChild(
        h(
          "option",
          { value: account.key, selected: account.key === session.account },
          account.label,
        ),
      );
    }
    accountSelect.value = session.account;
  }

  const typeBadge = (type: ContentType) =>
    h(
      "span",
      { class: `badge badge-${type}` },
      type === "post" ? "Post" : "Story",
    );
  const statusBadge = (status: ContentStatus) =>
    h(
      "span",
      { class: `badge badge-${status}` },
      status === "draft" ? "Draft" : "Archived",
    );

  // ------------------------------------------------------------- editor
  function renderEditor(target: Route, token: number): void {
    const isNew = target.name === "new";
    const draftType: ContentType = target.name === "new" ? target.type : "post";
    const itemId = target.name === "item" ? target.id : null;
    replaceChildren(
      doc,
      main,
      h("p", { class: "loading", role: "status" }, "Loading article..."),
    );
    void (async () => {
      await populateAccounts();
      if (token !== renderToken) return;
      if (isNew) {
        buildEditor(null, draftType, token);
        return;
      }
      try {
        info = info ?? (await client.sandboxInfo());
        const item = await client.getDraft(itemId as string);
        if (token !== renderToken) return;
        buildEditor(item, item.contentType, token);
      } catch (error) {
        if (token !== renderToken) return;
        const retry = h("button", { type: "button" }, "Try again");
        retry.addEventListener("click", () => show(target, true));
        const back = h(
          "a",
          { href: routeHash({ name: "dashboard" }) },
          `Back to ${homeLabel}`,
        );
        back.addEventListener("click", (event) => {
          event.preventDefault();
          go({ name: "dashboard" });
        });
        replaceChildren(
          doc,
          main,
          h("h1", {}, "Article unavailable"),
          h(
            "p",
            { class: "notice notice-error", role: "alert" },
            describeError(error),
          ),
          retry,
          " ",
          back,
        );
      }
    })();
  }

  const emptyRel = (): Rel => ({
    countyFips: [],
    personIds: [],
    organizationIds: [],
  });
  const copyRel = (rel: RelLike): Rel => ({
    countyFips: [...rel.countyFips],
    personIds: [...rel.personIds],
    organizationIds: [...rel.organizationIds],
  });
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length &&
    [...a].sort().every((value, index) => value === [...b].sort()[index]);
  const sameRel = (a: RelLike, b: RelLike) =>
    sameList(a.countyFips, b.countyFips) &&
    sameList(a.personIds, b.personIds) &&
    sameList(a.organizationIds, b.organizationIds);

  function buildEditor(
    initial: ContentItem | null,
    contentType: ContentType,
    token: number,
  ): void {
    let item: ContentItem | null = initial;
    const draft = {
      title: initial?.title ?? "",
      summary: initial?.summary ?? "",
      body: initial?.body ?? "",
      rel: initial ? copyRel(initial.relationships) : emptyRel(),
    };
    let saving = false;
    let working = false;
    let lastSaved: Date | null = null;
    let conflict: ContentItem | null = null;
    let historical: ContentRevision | null = null;
    let confirming: "restore" | "discard" | null = null;
    let revisions: ContentRevisionSummary[] = [];
    let revisionsMore: number | null = null;
    let revisionsState: "idle" | "loading" | "error" = "idle";
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let saveFailed = false;
    let mode: "visual" | "source" = "visual";
    let previewing = false;
    let aiPanel: AiPanel | null = null;
    /** Working drafts captured just before accepted AI edits, saved with the next save. */
    const pending: ContentCheckpoint[] = [];
    // Wide screens start with the settings open and keep the canvas central.
    let settingsOpen = win?.matchMedia
      ? win.matchMedia("(min-width: 80rem)").matches
      : true;

    const isDirty = (): boolean => {
      if (!item) {
        return (
          draft.title !== "" ||
          draft.summary !== "" ||
          draft.body !== "" ||
          !sameRel(draft.rel, emptyRel())
        );
      }
      return (
        draft.title !== item.title ||
        draft.summary !== (item.summary ?? "") ||
        draft.body !== item.body ||
        !sameRel(draft.rel, item.relationships)
      );
    };
    const isArchived = () => item?.status === "archived";
    const readOnly = () => isArchived() || historical !== null;
    guardIsClean = () => !isDirty();
    leaveGuard = () =>
      !isDirty() ||
      confirmLeave("You have unsaved changes. Leave and discard them?");
    cleanupView = () => {
      doc.removeEventListener("keydown", onSaveShortcut);
      aiPanel?.destroy();
      canvas.destroy();
      if (previewTimer) clearTimeout(previewTimer);
      onAccountChanged = null;
      guardIsClean = null;
    };

    // --- static structure
    const idPrefix = nextId("ed");
    const titleInput = h("input", {
      id: `${idPrefix}-title`,
      type: "text",
      maxlength: 400,
      autocomplete: "off",
      "aria-describedby": `${idPrefix}-title-help`,
    });
    const summaryInput = h("textarea", {
      id: `${idPrefix}-summary`,
      rows: 3,
      maxlength: 1000,
    });
    const bodyInput = h("textarea", {
      id: `${idPrefix}-body`,
      rows: 18,
      maxlength: MAX_BODY_CHARACTERS,
      spellcheck: "true",
      class: "source-input",
      "aria-describedby": `${idPrefix}-body-help`,
    });
    titleInput.value = draft.title;
    summaryInput.value = draft.summary;
    bodyInput.value = draft.body;
    titleInput.classList.add("writer-title");
    titleInput.setAttribute("placeholder", "Article title");

    const saveButton = h(
      "button",
      { type: "button", id: "save", class: "primary" },
      "Save Draft",
    );
    const lifecycleButton = h(
      "button",
      { type: "button", id: "lifecycle" },
      "Archive",
    );
    const stateLine = h("span", {
      id: "save-state",
      class: "save-state",
      role: "status",
    });
    const versionLine = h("span", {
      id: "version-line",
      class: "version-line",
    });
    const typeBadgeSlot = h("span", {});
    const statusBadgeSlot = h("span", {});
    const messages = h("div", { id: "messages", class: "messages" });
    const banners = h("div", { id: "banners", class: "banners" });
    const conflictSlot = h("div", { id: "conflict-slot" });
    const preview = h("article", {
      class: "preview",
      id: "preview",
      "aria-label": "Article preview",
    });
    const previewTitle = h("h2", { class: "preview-title" });
    const previewSummary = h("p", { class: "preview-summary" });
    const previewBody = h("div", { class: "preview-body" });
    preview.append(previewTitle, previewSummary, previewBody);
    const charCount = h("span", {
      class: "char-count",
      id: `${idPrefix}-body-help`,
    });

    // visual canvas, source view and toolbar toggles
    const modeNote = h("p", {
      class: "notice notice-info mode-note",
      id: "mode-note",
      hidden: true,
    });
    const roundTripNote = h(
      "p",
      {
        class: "notice notice-error mode-note",
        id: "round-trip-note",
        hidden: true,
      },
      "Some of what you typed cannot be written as Markdown that reads exactly the same. Check the Source view before saving.",
    );
    const canvas = createVisualCanvas({
      doc,
      blocks: [],
      readOnly: false,
      idPrefix,
      onChange: (markdown) => {
        draft.body = markdown;
        bodyInput.value = markdown;
        saveFailed = false;
        schedulePreview();
        updateStatus();
      },
      onRoundTripWarning: (warn) => {
        roundTripNote.hidden = !warn;
      },
      onNotice: (_kind, text) => announce(text),
      onSelection: (info) => aiPanel?.selection(info),
      checkpointDelayMs: previewDelay <= 0 ? 0 : 500,
    });
    aiPanel = createAiPanel({
      doc,
      client,
      canvas,
      idPrefix,
      host: {
        state: () => ({
          articleId: item?.id ?? null,
          version: item?.version ?? null,
          title: draft.title,
          summary: draft.summary,
          body: draft.body,
          visual: mode === "visual" && !previewing,
          locked: readOnly() || saving || working || conflict !== null,
        }),
        accept: (label, apply) => {
          if (!item && (draft.title || draft.summary || draft.body.trim())) {
            notice(
              messages,
              "error",
              "Save the draft once before applying AI edits, so the version before the edit can be kept.",
            );
            return false;
          }
          // The exact working draft, including unsaved manual changes.
          const before: ContentCheckpoint | null = item && {
            label: `Before AI edit: ${label}`,
            title: draft.title.trim() || item.title,
            summary: draft.summary.trim() || null,
            body: draft.body,
            relationships: copyRel(draft.rel),
          };
          if (!apply()) return false;
          if (before) pending.push(before);
          return true;
        },
        setTitle: (title) => {
          titleInput.value = title;
          draft.title = title;
          saveFailed = false;
          updatePreview();
          updateStatus();
        },
        announce,
      },
    });
    const {
      visualButton,
      sourceButton,
      previewButton,
      historyButton,
      settingsButton,
      widthDesktop,
      widthNarrow,
      previewTools,
      outlineList,
      outlineSlot,
    } = createWriterChrome(doc, idPrefix);
    let narrowPreview = false;
    const sourcePane = h(
      "div",
      { class: "source-pane" },
      h(
        "label",
        { for: `${idPrefix}-body`, class: "visually-hidden" },
        "Body (Markdown)",
      ),
      bodyInput,
      h(
        "p",
        { class: "help" },
        "Markdown source. HTML is shown as text and never run.",
        " ",
        charCount,
      ),
    );
    const canvasPane = h(
      "section",
      { class: "pane canvas-pane", "aria-label": "Writing canvas" },
      h(
        "label",
        { for: `${idPrefix}-title`, class: "visually-hidden" },
        "Title",
      ),
      titleInput,
      h(
        "p",
        { class: "visually-hidden", id: `${idPrefix}-title-help` },
        "Required, up to 200 characters.",
      ),
      modeNote,
      roundTripNote,
      previewTools,
      canvas.element,
      aiPanel.selectionBar,
      sourcePane,
      preview,
    );
    const grid = canvasPane;
    const settingsPanel = h("aside", {
      class: "settings-panel",
      id: `${idPrefix}-settings`,
      "aria-label": "Article settings",
    });
    const historicalSlot = h("div", { id: "historical-slot" });

    // relationships panel
    const relationships = createRelationshipsPanel({
      doc,
      client,
      idPrefix,
      searchDelayMs: searchDelay,
      counties: info?.counties ?? [],
      getRel: () => draft.rel,
      isLocked: () => readOnly() || saving || working,
      onChange: () => updateStatus(),
      nextId,
    });
    const relationshipsSlot = relationships.element;
    // revisions panel
    const revisionsSlot = h("section", {
      class: "panel",
      id: "revisions-panel",
      "aria-labelledby": `${idPrefix}-rev-h`,
    });

    const backLink = h(
      "a",
      { href: routeHash({ name: "dashboard" }) },
      `Back to ${homeLabel}`,
    );
    backLink.addEventListener("click", (event) => {
      event.preventDefault();
      go({ name: "dashboard" });
    });

    settingsPanel.append(
      h("h2", { id: `${idPrefix}-settings-h` }, "Settings"),
      h(
        "section",
        { class: "panel", "aria-labelledby": `${idPrefix}-sum-h` },
        h("h3", { id: `${idPrefix}-sum-h` }, "Summary"),
        h("label", { for: `${idPrefix}-summary` }, "Summary (optional)"),
        summaryInput,
        h(
          "p",
          { class: "help" },
          "Shown in lists and at the top of the article.",
        ),
      ),
      aiPanel.element,
      outlineSlot,
      canvas.blockPanel,
      relationshipsSlot,
      revisionsSlot,
    );

    replaceChildren(
      doc,
      main,
      h(
        "div",
        { class: "editor writer" },
        h("p", { class: "crumbs" }, backLink),
        h(
          "div",
          { class: "writer-bar" },
          h(
            "div",
            { class: "writer-bar-top" },
            h(
              "h1",
              { id: "editor-heading", class: "writer-heading" },
              initial === null
                ? `New ${contentType === "post" ? "Post" : "Story"}`
                : "Edit article",
            ),
            typeBadgeSlot,
            statusBadgeSlot,
            versionLine,
            stateLine,
            h(
              "div",
              { class: "actions writer-actions" },
              h(
                "span",
                {
                  class: "seg-group",
                  role: "group",
                  "aria-label": "Editing view",
                },
                visualButton,
                sourceButton,
              ),
              previewButton,
              historyButton,
              settingsButton,
              lifecycleButton,
              saveButton,
            ),
          ),
          canvas.tools,
          canvas.linkForm,
        ),
        banners,
        conflictSlot,
        messages,
        historicalSlot,
        h("div", { class: "writer-body" }, grid, settingsPanel),
      ),
    );

    // --- status rendering
    function updateStatus(): void {
      const dirty = isDirty();
      aiPanel?.refresh();
      replaceChildren(
        doc,
        typeBadgeSlot,
        typeBadge(item?.contentType ?? contentType),
      );
      replaceChildren(
        doc,
        statusBadgeSlot,
        statusBadge(item?.status ?? "draft"),
      );
      versionLine.textContent = item
        ? `Version ${item.version}`
        : "Not saved yet";
      stateLine.className = `save-state ${saving ? "is-saving" : conflict || (saveFailed && dirty) ? "is-error" : dirty ? "is-unsaved" : "is-saved"}`;
      stateLine.textContent = saving
        ? "Saving..."
        : conflict
          ? "Conflict: a newer version exists. Unsaved changes are kept."
          : saveFailed && dirty
            ? "Save failed. Unsaved changes are kept."
            : dirty
              ? "Unsaved changes"
              : item
                ? `All changes saved${lastSaved ? ` at ${lastSaved.toLocaleTimeString()}` : ""}`
                : "Nothing to save yet";
      const lock = readOnly() || saving || working;
      titleInput.readOnly = readOnly();
      summaryInput.readOnly = readOnly();
      bodyInput.readOnly = readOnly();
      canvas.setReadOnly(readOnly() || previewing);
      visualButton.setAttribute("aria-pressed", String(mode === "visual"));
      sourceButton.setAttribute("aria-pressed", String(mode === "source"));
      previewButton.setAttribute("aria-pressed", String(previewing));
      previewButton.textContent = previewing ? "Back to editing" : "Preview";
      settingsButton.setAttribute("aria-expanded", String(settingsOpen));
      settingsPanel.hidden = !settingsOpen;
      titleInput.hidden = previewing;
      canvas.element.hidden = previewing || mode !== "visual";
      canvas.tools.hidden = previewing || mode !== "visual";
      if (previewing || mode !== "visual") canvas.linkForm.hidden = true;
      sourcePane.hidden = previewing || mode !== "source";
      preview.hidden = !previewing;
      previewTools.hidden = !previewing;
      preview.classList.toggle("preview-narrow", narrowPreview);
      widthDesktop.setAttribute("aria-pressed", String(!narrowPreview));
      widthNarrow.setAttribute("aria-pressed", String(narrowPreview));
      canvas.blockPanel.hidden = mode !== "visual";
      renderOutline();
      modeNote.hidden = modeNote.textContent === "" || previewing;
      roundTripNote.hidden = roundTripNote.hidden || mode !== "visual";
      saveButton.disabled = lock || conflict !== null || !dirty;
      lifecycleButton.hidden = item === null;
      lifecycleButton.textContent = isArchived()
        ? "Restore to draft"
        : "Archive";
      lifecycleButton.disabled =
        lock || conflict !== null || dirty || historical !== null;
      lifecycleButton.title = dirty
        ? "Save your changes before archiving or restoring"
        : "";
      charCount.textContent = `${draft.body.length.toLocaleString()} / ${MAX_BODY_CHARACTERS.toLocaleString()} characters`;
      replaceChildren(doc, banners);
      if (isArchived()) {
        banners.appendChild(
          h(
            "p",
            {
              class: "banner banner-archived",
              id: "archived-banner",
              role: "status",
            },
            "This article is archived and read-only. Restore it to a draft to edit it.",
          ),
        );
      }
      relationships.render();
      renderRevisionsPanel();
    }

    function renderOutline(): void {
      renderOutlineInto(
        doc,
        outlineList,
        mode === "visual"
          ? {
              canvas,
              onJump: () => {
                previewing = false;
                updateStatus();
              },
            }
          : null,
        draft.body,
      );
    }

    function schedulePreview(): void {
      if (previewTimer) clearTimeout(previewTimer);
      if (previewDelay <= 0) {
        updatePreview();
        return;
      }
      previewTimer = setTimeout(updatePreview, previewDelay);
    }
    function updatePreview(): void {
      previewTitle.textContent = draft.title.trim() || "Untitled";
      previewSummary.textContent = draft.summary;
      previewSummary.hidden = draft.summary.trim() === "";
      renderMarkdownInto(doc, previewBody, draft.body);
    }

    titleInput.addEventListener("input", () => {
      draft.title = titleInput.value;
      saveFailed = false;
      updatePreview();
      updateStatus();
    });
    summaryInput.addEventListener("input", () => {
      draft.summary = summaryInput.value;
      updatePreview();
      updateStatus();
    });
    bodyInput.addEventListener("input", () => {
      draft.body = bodyInput.value;
      saveFailed = false;
      if (mode === "visual") refreshCanvas();
      schedulePreview();
      updateStatus();
    });

    // --- visual / source / preview / settings
    function explain(reason: string): void {
      modeNote.textContent = `This draft uses ${reason}, which the visual editor cannot represent safely. It stays in Source view and its text is unchanged.`;
      announce(modeNote.textContent);
    }
    function setMode(next: "visual" | "source"): boolean {
      if (next === "visual") {
        const result = toVisual(draft.body);
        if (!result.ok) {
          explain(result.reason);
          mode = "source";
          updateStatus();
          return false;
        }
        modeNote.textContent = "";
        canvas.setBlocks(result.blocks);
      }
      mode = next;
      updateStatus();
      return true;
    }
    /** Reloads the canvas after the body changed from outside the canvas. */
    function refreshCanvas(): void {
      if (mode !== "visual") return;
      const result = toVisual(draft.body);
      if (result.ok) canvas.setBlocks(result.blocks);
      else {
        mode = "source";
        explain(result.reason);
      }
    }
    visualButton.addEventListener("click", () => {
      previewing = false;
      if (mode === "visual") {
        updateStatus();
        return;
      }
      if (setMode("visual")) canvas.focus();
    });
    sourceButton.addEventListener("click", () => {
      previewing = false;
      modeNote.textContent = "";
      setMode("source");
      bodyInput.focus();
    });
    previewButton.addEventListener("click", () => {
      previewing = !previewing;
      updatePreview();
      updateStatus();
      if (previewing) preview.setAttribute("tabindex", "-1");
      (previewing
        ? preview
        : mode === "visual"
          ? titleInput
          : bodyInput
      ).focus();
    });
    historyButton.addEventListener("click", () => {
      settingsOpen = true;
      updateStatus();
      revisionsSlot.setAttribute("tabindex", "-1");
      revisionsSlot.scrollIntoView?.({ block: "start" });
      revisionsSlot.focus();
    });
    widthDesktop.addEventListener("click", () => {
      narrowPreview = false;
      updateStatus();
    });
    widthNarrow.addEventListener("click", () => {
      narrowPreview = true;
      updateStatus();
    });
    settingsButton.addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      updateStatus();
    });
    const onSaveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    doc.addEventListener("keydown", onSaveShortcut);
    {
      const first = toVisual(draft.body);
      if (first.ok) canvas.setBlocks(first.blocks);
      else {
        mode = "source";
        explain(first.reason);
      }
    }

    // --- mutation plumbing
    function syncFrom(result: ContentItem, sent: typeof draft): void {
      item = result;
      if (draft.title === sent.title) draft.title = result.title;
      if (draft.summary === sent.summary) draft.summary = result.summary ?? "";
      const bodyChanged = draft.body === sent.body && result.body !== sent.body;
      if (draft.body === sent.body) draft.body = result.body;
      if (sameRel(draft.rel, sent.rel))
        draft.rel = copyRel(result.relationships);
      titleInput.value = draft.title;
      summaryInput.value = draft.summary;
      bodyInput.value = draft.body;
      lastSaved = new Date();
      if (bodyChanged) refreshCanvas();
      updatePreview();
    }
    function replaceDraftWith(result: ContentItem): void {
      item = result;
      pending.length = 0;
      draft.title = result.title;
      draft.summary = result.summary ?? "";
      draft.body = result.body;
      draft.rel = copyRel(result.relationships);
      titleInput.value = draft.title;
      summaryInput.value = draft.summary;
      bodyInput.value = draft.body;
      lastSaved = new Date();
      refreshCanvas();
      updatePreview();
    }
    const snapshot = () => ({
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      rel: copyRel(draft.rel),
    });

    async function handleConflict(): Promise<void> {
      if (!item) return;
      try {
        conflict = await client.getDraft(item.id);
        renderConflict();
        notice(
          messages,
          "error",
          describeError(new EditorApiError(409, "version_conflict")),
        );
      } catch (error) {
        notice(messages, "error", describeError(error));
      }
    }

    async function save(): Promise<void> {
      if (saving || working || readOnly() || conflict) return;
      if (draft.title.trim() === "") {
        notice(messages, "error", "Enter a title before saving.");
        titleInput.focus();
        return;
      }
      const sent = snapshot();
      saving = true;
      saveFailed = false;
      updateStatus();
      try {
        if (!item) {
          const created = await client.createDraft({
            contentType,
            title: sent.title,
            ...(sent.summary.trim() ? { summary: sent.summary } : {}),
            body: sent.body,
            ...(sameRel(sent.rel, emptyRel())
              ? {}
              : { relationships: sent.rel }),
          });
          syncFrom(created, sent);
          notice(messages, "success", "Draft created as version 1.");
          if (win) {
            // replaceState fires no hashchange, so nothing is suppressed.
            route = { name: "item", id: created.id };
            win.history.replaceState(null, "", routeHash(route));
          }
          const heading = main.querySelector("#editor-heading");
          if (heading) heading.textContent = "Edit article";
        } else {
          const changes: Record<string, unknown> = {};
          if (sent.title !== item.title) changes.title = sent.title;
          if (sent.summary !== (item.summary ?? ""))
            changes.summary = sent.summary.trim() === "" ? null : sent.summary;
          if (sent.body !== item.body) changes.body = sent.body;
          if (!sameRel(sent.rel, item.relationships))
            changes.relationships = sent.rel;
          if (Object.keys(changes).length === 0 && pending.length === 0) {
            notice(messages, "info", "There are no changes to save.");
            return;
          }
          const kept = pending.length;
          const updated =
            kept > 0
              ? await client.saveWithCheckpoints(
                  item.id,
                  item.version,
                  pending,
                  {
                    title: sent.title,
                    summary: sent.summary.trim() === "" ? null : sent.summary,
                    body: sent.body,
                    relationships: sent.rel,
                  },
                )
              : await client.updateDraft(item.id, item.version, changes);
          pending.length = 0;
          syncFrom(updated, sent);
          notice(
            messages,
            "success",
            `Saved as version ${updated.version}.${kept > 0 ? ` ${kept} AI checkpoint${kept === 1 ? " is" : "s are"} in Revision history.` : ""}`,
          );
        }
        await loadRevisions(true);
      } catch (error) {
        if (
          error instanceof EditorApiError &&
          error.code === "version_conflict"
        ) {
          await handleConflict();
        } else {
          saveFailed = true;
          if (
            error instanceof EditorApiError &&
            error.code === "invalid_relationship"
          ) {
            relationships.recheckSelected();
          }
          notice(
            messages,
            "error",
            `${describeError(error)} Your changes are still here and were not saved.`,
          );
        }
      } finally {
        saving = false;
        updateStatus();
      }
    }
    saveButton.addEventListener("click", () => void save());

    async function runLifecycle(): Promise<void> {
      if (!item || isDirty() || working || saving) return;
      working = true;
      updateStatus();
      const archiving = !isArchived();
      try {
        const result = archiving
          ? await client.archiveDraft(item.id, item.version)
          : await client.restoreDraft(item.id, item.version);
        replaceDraftWith(result);
        notice(
          messages,
          "success",
          archiving
            ? `Archived as version ${result.version}. Restore it to keep editing.`
            : `Restored to draft as version ${result.version}.`,
        );
        await loadRevisions(true);
      } catch (error) {
        if (
          error instanceof EditorApiError &&
          error.code === "version_conflict"
        ) {
          notice(
            messages,
            "error",
            "The article changed elsewhere. Reloaded the latest version; try again.",
          );
          try {
            replaceDraftWith(await client.getDraft(item.id));
          } catch {
            // The notice above already explains the situation.
          }
        } else {
          notice(messages, "error", describeError(error));
        }
      } finally {
        working = false;
        updateStatus();
      }
    }
    lifecycleButton.addEventListener("click", () => void runLifecycle());

    onAccountChanged = () => {
      notice(
        messages,
        "info",
        "Account changed. Your next save or action is attributed to the newly selected sandbox account.",
      );
    };

    // --- conflict panel
    function renderConflict(): void {
      replaceChildren(doc, conflictSlot);
      if (!conflict || !item) {
        updateStatus();
        return;
      }
      const latest = conflict;
      const diff = diffLines(latest.body, draft.body);
      const changedFields = [
        draft.title !== latest.title ? "title" : null,
        draft.summary !== (latest.summary ?? "") ? "summary" : null,
        !sameRel(draft.rel, latest.relationships) ? "relationships" : null,
      ].filter((entry): entry is string => entry !== null);
      const keep = h(
        "button",
        { type: "button", id: "conflict-keep", class: "primary" },
        "Keep my edits on top of the latest version",
      );
      const discard = h(
        "button",
        { type: "button", id: "conflict-discard" },
        "Discard my edits and load the latest version",
      );
      keep.addEventListener("click", () => {
        if (!conflict) return;
        item = conflict;
        conflict = null;
        replaceChildren(doc, conflictSlot);
        notice(
          messages,
          "info",
          `Now based on version ${item.version}. Review the differences, then save when you are ready.`,
        );
        updateStatus();
      });
      discard.addEventListener("click", () => {
        confirming = "discard";
        renderConflict();
      });
      const panel = h(
        "section",
        {
          class: "conflict",
          id: "conflict-panel",
          role: "alert",
          "aria-labelledby": `${idPrefix}-conflict-h`,
        },
        h("h2", { id: `${idPrefix}-conflict-h` }, "Version conflict"),
        h(
          "p",
          {},
          `Version ${latest.version} was saved by ${latest.lastEditedByAccountId} at ${formatTime(latest.updatedAt)} while you were editing version ${item.version}. Nothing you typed has been lost or overwritten.`,
        ),
        h(
          "p",
          {},
          changedFields.length > 0 || (diff && hasChanges(diff))
            ? `Your text differs from the latest version in: ${[...(diff && hasChanges(diff) ? ["body"] : []), ...changedFields].join(", ")}.`
            : "Your text matches the latest version.",
        ),
        diff && hasChanges(diff)
          ? h(
              "div",
              { class: "diff-wrap" },
              h("h3", {}, "Body: latest version compared with your text"),
              renderDiff(diff),
            )
          : null,
        confirming === "discard"
          ? h(
              "div",
              {
                class: "confirm",
                role: "alertdialog",
                "aria-labelledby": `${idPrefix}-confirm-discard`,
              },
              h(
                "p",
                { id: `${idPrefix}-confirm-discard` },
                "Discard everything you typed since your last save and load the latest version?",
              ),
              confirmButton("Yes, discard my edits", () => {
                if (!conflict) return;
                const latestVersion = conflict;
                conflict = null;
                confirming = null;
                replaceChildren(doc, conflictSlot);
                replaceDraftWith(latestVersion);
                notice(
                  messages,
                  "info",
                  `Loaded version ${latestVersion.version}.`,
                );
                updateStatus();
              }),
              cancelButton(() => {
                confirming = null;
                renderConflict();
              }),
            )
          : h("div", { class: "actions" }, keep, discard),
      );
      conflictSlot.appendChild(panel);
      updateStatus();
    }

    function confirmButton(
      label: string,
      onClick: () => void,
    ): HTMLButtonElement {
      const button = h(
        "button",
        { type: "button", class: "danger", "data-confirm": "yes" },
        label,
      );
      button.addEventListener("click", onClick);
      return button;
    }
    function cancelButton(onClick: () => void): HTMLButtonElement {
      const button = h(
        "button",
        { type: "button", "data-confirm": "no" },
        "Cancel",
      );
      button.addEventListener("click", onClick);
      return button;
    }

    function renderDiff(
      diff: ReturnType<typeof diffLines> & object,
    ): HTMLElement {
      const list = h("pre", {
        class: "diff",
        "aria-label": "Line differences",
      });
      for (const line of diff) {
        const marker =
          line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  ";
        list.appendChild(
          h(
            "span",
            { class: `diff-line diff-${line.kind}`, "data-kind": line.kind },
            `${marker}${line.text}\n`,
          ),
        );
      }
      return list;
    }

    // --- revisions
    async function loadRevisions(reset: boolean): Promise<void> {
      if (!item) return;
      const id = item.id;
      revisionsState = "loading";
      renderRevisionsPanel();
      try {
        const page = await client.listRevisions(id, {
          limit: REVISION_PAGE_SIZE,
          ...(!reset && revisionsMore !== null
            ? { beforeVersion: revisionsMore }
            : {}),
        });
        revisions = reset ? [...page.items] : [...revisions, ...page.items];
        revisionsMore = page.hasMore ? page.nextCursor : null;
        revisionsState = "idle";
      } catch {
        revisionsState = "error";
      }
      renderRevisionsPanel();
    }

    function renderRevisionsPanel(): void {
      const children: (Node | string | null)[] = [
        h("h2", { id: `${idPrefix}-rev-h` }, "Revision history"),
      ];
      if (!item) {
        children.push(
          h(
            "p",
            { class: "empty" },
            "History starts when you save the first version.",
          ),
        );
      } else if (revisionsState === "loading" && revisions.length === 0) {
        children.push(
          h("p", { class: "loading", role: "status" }, "Loading revisions..."),
        );
      } else if (revisionsState === "error") {
        const retry = h(
          "button",
          { type: "button", id: "revisions-retry" },
          "Try again",
        );
        retry.addEventListener("click", () => void loadRevisions(true));
        children.push(
          h(
            "p",
            { class: "notice notice-error", role: "alert" },
            "Revision history could not be loaded.",
          ),
          retry,
        );
      } else if (revisions.length === 0) {
        children.push(h("p", { class: "empty" }, "No revisions recorded."));
      } else {
        const list = h("ol", { class: "revisions", id: "revision-list" });
        for (const revision of revisions) {
          const isCurrent = item.version === revision.version;
          const view = h(
            "button",
            {
              type: "button",
              class: "view-revision",
              "data-version": revision.version,
              "aria-label": `View revision ${revision.version}`,
            },
            "View",
          );
          view.addEventListener(
            "click",
            () => void openRevision(revision.version),
          );
          list.appendChild(
            h(
              "li",
              {
                class: isCurrent ? "revision is-current" : "revision",
                "data-version": revision.version,
              },
              h("span", { class: "rev-version" }, `v${revision.version}`),
              h(
                "span",
                { class: "rev-kind" },
                revision.changeKind === "restore_revision" &&
                  revision.restoredFromVersion
                  ? `Restored from v${revision.restoredFromVersion}`
                  : (revision.checkpointLabel ??
                      CHANGE_LABELS[revision.changeKind]),
              ),
              isCurrent
                ? h("span", { class: "badge badge-current" }, "Current")
                : null,
              h(
                "span",
                { class: "rev-meta" },
                timeElement(revision.recordedAt),
                " by ",
                h("span", { class: "rev-editor" }, revision.editedByAccountId),
              ),
              view,
            ),
          );
        }
        children.push(list);
        if (revisionsMore !== null) {
          const more = h(
            "button",
            { type: "button", id: "revisions-more" },
            "Load older revisions",
          );
          more.addEventListener("click", () => void loadRevisions(false));
          children.push(more);
        }
      }
      replaceChildren(doc, revisionsSlot, ...children);
    }

    async function openRevision(version: number): Promise<void> {
      if (!item) return;
      try {
        historical = await client.getRevision(item.id, version);
        await relationships.ensureResolved(
          historical.relationships.personIds,
          historical.relationships.organizationIds,
        );
        confirming = null;
        renderHistorical();
        grid.hidden = true;
        announce(`Viewing revision ${version}`);
      } catch (error) {
        notice(messages, "error", describeError(error));
      }
    }

    function closeHistorical(): void {
      historical = null;
      confirming = null;
      replaceChildren(doc, historicalSlot);
      grid.hidden = false;
      updateStatus();
    }

    function renderHistorical(): void {
      replaceChildren(doc, historicalSlot);
      if (!historical || !item) {
        updateStatus();
        return;
      }
      const revision = historical;
      const current = item;
      const back = h(
        "button",
        { type: "button", id: "historical-back" },
        "Back to current draft",
      );
      back.addEventListener("click", closeHistorical);
      const blockedReason = isArchived()
        ? "Restore the article to a draft before restoring a revision."
        : isDirty()
          ? "Save or discard your unsaved changes before restoring a revision."
          : revision.version >= current.version
            ? "This is already the current version."
            : null;
      const restore = h(
        "button",
        {
          type: "button",
          id: "historical-restore",
          class: "primary",
          disabled: blockedReason !== null,
        },
        "Restore this revision",
      );
      restore.addEventListener("click", () => {
        confirming = "restore";
        renderHistorical();
      });
      const compare = h("input", {
        type: "checkbox",
        id: `${idPrefix}-compare`,
      });
      const compareSlot = h("div", { id: "compare-slot" });
      compare.addEventListener("change", () => {
        replaceChildren(
          doc,
          compareSlot,
          compare.checked ? buildCompare(revision) : null,
        );
      });
      const body = h("div", { class: "preview-body", id: "historical-body" });
      renderMarkdownInto(doc, body, revision.body);
      const relList = (
        label: string,
        values: readonly string[],
        names: ReadonlyMap<string, string>,
      ) =>
        h(
          "p",
          { class: "rel-line" },
          h("strong", {}, `${label}: `),
          values.length === 0
            ? "none"
            : values.map((value) => names.get(value) ?? value).join(", "),
        );
      historicalSlot.appendChild(
        h(
          "section",
          {
            class: "historical",
            id: "historical-panel",
            "aria-labelledby": `${idPrefix}-hist-h`,
          },
          h(
            "p",
            {
              class: "banner banner-historical",
              id: "historical-banner",
              role: "status",
            },
            `Viewing historical revision v${revision.version} (${revision.checkpointLabel ?? CHANGE_LABELS[revision.changeKind]}) - read only. You are not editing the current draft.`,
          ),
          h("h2", { id: `${idPrefix}-hist-h` }, revision.title),
          revision.summary
            ? h("p", { class: "preview-summary" }, revision.summary)
            : null,
          h(
            "p",
            { class: "rev-meta" },
            "Recorded ",
            timeElement(revision.recordedAt),
            " by ",
            revision.editedByAccountId,
            ` - state at the time: ${revision.status}`,
          ),
          relList(
            "Counties",
            revision.relationships.countyFips,
            relationships.countyNames,
          ),
          relList(
            "People",
            revision.relationships.personIds,
            relationships.personNames,
          ),
          relList(
            "Organizations",
            revision.relationships.organizationIds,
            relationships.organizationNames,
          ),
          h("div", { class: "preview", id: "historical-preview" }, body),
          h(
            "div",
            { class: "row" },
            compare,
            h(
              "label",
              { for: `${idPrefix}-compare` },
              "Compare with current draft",
            ),
          ),
          compareSlot,
          blockedReason
            ? h("p", { class: "help", id: "restore-blocked" }, blockedReason)
            : null,
          confirming === "restore"
            ? h(
                "div",
                {
                  class: "confirm",
                  id: "restore-confirm",
                  role: "alertdialog",
                  "aria-labelledby": `${idPrefix}-confirm-restore`,
                },
                h(
                  "p",
                  { id: `${idPrefix}-confirm-restore` },
                  `Restore revision v${revision.version}? This creates version ${current.version + 1} with that revision's title, summary, text and relationships. The history stays intact.`,
                ),
                confirmButton(
                  "Confirm restore",
                  () => void performRestore(revision),
                ),
                cancelButton(() => {
                  confirming = null;
                  renderHistorical();
                }),
              )
            : h("div", { class: "actions" }, restore, back),
        ),
      );
      updateStatus();
    }

    const buildCompare = (revision: ContentRevision): HTMLElement =>
      buildRevisionCompare(doc, revision, draft, relationships, renderDiff);

    async function performRestore(revision: ContentRevision): Promise<void> {
      if (!item || working || isDirty()) return;
      working = true;
      updateStatus();
      try {
        const result = await client.restoreRevision(
          item.id,
          item.version,
          revision.version,
        );
        replaceDraftWith(result);
        historical = null;
        confirming = null;
        replaceChildren(doc, historicalSlot);
        grid.hidden = false;
        notice(
          messages,
          "success",
          `Restored revision ${revision.version} as version ${result.version}.`,
        );
        await loadRevisions(true);
      } catch (error) {
        confirming = null;
        if (
          error instanceof EditorApiError &&
          error.code === "version_conflict"
        ) {
          notice(
            messages,
            "error",
            "The article changed elsewhere. Reloaded the latest version; review it and try again.",
          );
          try {
            replaceDraftWith(await client.getDraft(item.id));
            await loadRevisions(true);
          } catch {
            // The notice above already explains the situation.
          }
          closeHistorical();
        } else {
          notice(messages, "error", describeError(error));
          renderHistorical();
        }
      } finally {
        working = false;
        updateStatus();
      }
    }

    // --- start
    updatePreview();
    updateStatus();
    if (item) void loadRevisions(true);
    titleInput.focus();
    if (token !== renderToken) return;
  }

  // ------------------------------------------------------------- start
  void (async () => {
    await populateAccounts();
    if (destroyed) return;
    const initial = win
      ? parseHash(win.location.hash)
      : { name: "dashboard" as const };
    show(initial, true);
  })();

  return {
    canLeave: () => !leaveGuard || leaveGuard(),
    destroy() {
      destroyed = true;
      cleanupView?.();
      win?.removeEventListener("hashchange", onHashChange);
      win?.removeEventListener("beforeunload", onBeforeUnload);
      clear(root);
    },
  };
}

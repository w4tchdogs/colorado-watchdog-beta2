import type {
  BannerAdminBanner,
  BannerAdminVersion,
  BannerPublicationRecord,
  BannerReconciliationItem,
  CountyBannerSummary,
  PublicationMetadata,
} from "../contracts/banner-administration.js";
import {
  type BannerAdminClient,
  BannerAdminError,
} from "./banner-admin-client.js";
import { parseBannerFilename } from "./banner-filename.js";
import type { DashboardViewFactory } from "./dashboard.js";
import { el, replaceChildren } from "./dom.js";

/**
 * The Banners dashboard view. It renders only what the merged
 * `/api/admin/banners/*` contract returns, keeps every business rule on the
 * server, and never shows a storage key or an internal error.
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

const COUNTY_PAGE_LIMIT = 100;
const RETRYABLE_CODES = new Set([
  "storage_failed",
  "finalize_failed",
  "dependency_unavailable",
  "network_error",
]);

export interface BannersViewOptions {
  readonly client: BannerAdminClient;
  readonly newIdempotencyKey?: () => string;
  readonly createPreviewUrl?: (bytes: Uint8Array, mediaType: string) => string;
  readonly revokePreviewUrl?: (url: string) => void;
}

interface PublishFormValues {
  caption: string;
  altText: string;
  displayMode: "cover" | "contain";
  focalX: string;
  focalY: string;
}

interface StagedPreview {
  readonly versionId: string;
  url: string | null;
  error: string | null;
}

interface BannerState {
  pending: PublishFormValues | null;
  staged: StagedPreview | null;
  conflict: string | null;
  retry: null | (() => Promise<void>);
  publications: readonly BannerPublicationRecord[] | null;
  publicationsError: string | null;
  reconcile: readonly BannerReconciliationItem[] | null;
  confirming: null | {
    readonly kind: "publish" | "withdraw" | "restore";
    readonly versionId?: string;
    readonly publicationId?: string;
  };
  editingDetails: boolean;
}

interface ViewOptions {
  readonly client: BannerAdminClient;
  readonly newKey: () => string;
  readonly createPreviewUrl: (bytes: Uint8Array, mediaType: string) => string;
  readonly revokePreviewUrl: (url: string) => void;
}

interface State {
  query: string;
  counties: readonly CountyBannerSummary[];
  nextAfterFips: string | null;
  countiesError: string | null;
  loadingCounties: boolean;
  detail: {
    county: { readonly fips: string; readonly name: string };
    banners: readonly BannerAdminBanner[];
    bannersTruncated: boolean;
  } | null;
  detailError: string | null;
  loadingDetail: boolean;
  banners: Map<string, BannerState>;
  notice: string | null;
  order: readonly string[] | null;
  orderDirty: boolean;
  newBannerId: string;
  /** Element id to focus after the next render (keyboard continuity). */
  focusId: string | null;
  newStage: null | {
    countyFips: string;
    run: () => Promise<void>;
  };
}

const formValues = (banner: BannerAdminBanner): PublishFormValues => ({
  caption: banner.caption,
  altText: banner.altText,
  displayMode: banner.displayMode,
  focalX: String(banner.focalX),
  focalY: String(banner.focalY),
});

export function createBannersView(
  options: BannersViewOptions,
): DashboardViewFactory {
  const view: ViewOptions = {
    client: options.client,
    newKey:
      options.newIdempotencyKey ??
      (() =>
        globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
        `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    createPreviewUrl:
      options.createPreviewUrl ??
      ((bytes, mediaType) =>
        URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: mediaType }),
        )),
    revokePreviewUrl:
      options.revokePreviewUrl ?? ((url) => URL.revokeObjectURL(url)),
  };

  return (context) => {
    const { doc, container, announce } = context;
    const h = helper(doc);
    const state: State = {
      query: "",
      counties: [],
      nextAfterFips: null,
      countiesError: null,
      loadingCounties: false,
      detail: null,
      detailError: null,
      loadingDetail: false,
      banners: new Map(),
      notice: null,
      order: null,
      orderDirty: false,
      newBannerId: "",
      focusId: null,
      newStage: null,
    };
    const previews = new Set<string>();
    let destroyed = false;

    const stateFor = (bannerId: string): BannerState => {
      let entry = state.banners.get(bannerId);
      if (!entry) {
        entry = {
          pending: null,
          staged: null,
          conflict: null,
          retry: null,
          publications: null,
          publicationsError: null,
          reconcile: null,
          confirming: null,
          editingDetails: false,
        };
        state.banners.set(bannerId, entry);
      }
      return entry;
    };

    const makePreview = (bytes: Uint8Array, mediaType: string): string => {
      const url = view.createPreviewUrl(bytes, mediaType);
      previews.add(url);
      return url;
    };

    const dropPreviews = () => {
      for (const url of previews) view.revokePreviewUrl(url);
      previews.clear();
      thumbs.clear();
    };

    // One private preview per image version, fetched through the protected
    // route and shown as a blob URL. `null` records a failed load.
    const thumbs = new Map<string, string | null>();
    const thumbLoading = new Set<string>();
    const thumbUpdates = new Map<string, () => void>();
    const previewVersionId = (banner: BannerAdminBanner): string | null =>
      banner.selectedVersionId ??
      banner.versions.find((version) => version.state === "verified")?.id ??
      null;
    const ensureThumbs = (banners: readonly BannerAdminBanner[]) => {
      for (const banner of banners) {
        const id = previewVersionId(banner);
        if (!id || thumbs.has(id) || thumbLoading.has(id)) continue;
        thumbLoading.add(id);
        void view.client
          .versionImage(id)
          .then((image) => {
            if (!destroyed)
              thumbs.set(id, makePreview(image.bytes, image.mediaType));
          })
          .catch(() => {
            if (!destroyed) thumbs.set(id, null);
          })
          .finally(() => {
            thumbLoading.delete(id);
            thumbUpdates.get(id)?.();
          });
      }
    };

    const describe = (error: unknown): string => {
      if (!(error instanceof BannerAdminError))
        return "Something went wrong. Nothing was changed.";
      switch (error.code) {
        case "network_error":
          return "The server could not be reached.";
        case "authentication_required":
          return "Your session ended. Choose an account again or reload the page.";
        case "forbidden":
          return "Your account no longer has banner access.";
        case "origin_rejected":
          return "The request did not come from this dashboard.";
        case "not_found":
          return "That county, banner or version does not exist. Refresh and try again.";
        case "stale_version":
          return "Another change was saved first. Review the current state, then retry.";
        case "idempotency_conflict":
          return "This request was already sent with different details. Start a new request.";
        case "snapshot_required":
          return "This version has no recorded publication. Add caption, alt text and display settings to restore it.";
        case "version_not_publishable":
          return "This version cannot be published. It may not be a verified version of this banner.";
        case "object_verification_failed":
          return "The stored image is missing or damaged. Use Check stored images.";
        case "duplicate_image":
          return "This image is already attached to another banner.";
        case "order_conflict":
          return "That order conflicts with another banner in this county.";
        case "request_too_large":
        case "image_too_large":
          return "The image is too large. The limit is 25 MiB.";
        case "unsupported_media_type":
        case "unsupported_image_type":
          return "Only PNG and JPEG images are accepted.";
        case "invalid_image":
          return error.reason === "dimensions_exceeded"
            ? "The image has too many pixels."
            : "The image could not be read as a PNG or JPEG file.";
        case "validation_failed":
          return error.detail || "A required detail is missing or invalid.";
        case "storage_failed":
        case "finalize_failed":
          return "Storage is unavailable right now. Nothing was published. Try again.";
        case "dependency_unavailable":
          return "The banner service is unavailable right now. Try again.";
        case "banner_admin_unavailable":
          return "Banner administration is unavailable in this environment.";
        default:
          return "Something went wrong on the server. Nothing was changed.";
      }
    };

    const isRetryable = (error: unknown): boolean =>
      error instanceof BannerAdminError &&
      (RETRYABLE_CODES.has(error.code) || error.retryable === true);

    // ------------------------------------------------------------- render

    const render = () => {
      if (destroyed) return;
      thumbUpdates.clear();
      // Re-rendering replaces every control, so keyboard focus would fall to
      // the page. Remember the focused control and put focus back afterwards,
      // unless a step asked for focus to move somewhere specific.
      const focused = doc.activeElement as HTMLElement | null;
      const previousFocus =
        focused && container.contains(focused)
          ? {
              id: focused.id,
              className: focused.className,
              text: focused.textContent ?? "",
              version: focused.getAttribute("data-version"),
            }
          : null;
      const children: Node[] = [
        h("h1", { id: "banners-heading" }, "Banners"),
        h(
          "p",
          { class: "dash-lede" },
          "Manage the banners displayed on county pages.",
        ),
      ];
      if (state.notice)
        children.push(
          h("p", { class: "dash-notice", role: "status" }, state.notice),
        );

      children.push(countySearchCard());
      if (state.loadingDetail)
        children.push(
          h("p", { class: "loading", role: "status" }, "Loading county..."),
        );
      if (state.detailError)
        children.push(
          h("p", { class: "dash-error", role: "alert" }, state.detailError),
        );
      if (state.detail) {
        children.push(countyCard(state.detail));
        for (const banner of orderedBanners())
          children.push(bannerCard(banner));
      }
      replaceChildren(doc, container, ...children);
      let target: HTMLElement | null = state.focusId
        ? doc.getElementById(state.focusId)
        : null;
      state.focusId = null;
      if (!target && previousFocus) {
        target = previousFocus.id
          ? doc.getElementById(previousFocus.id)
          : (Array.from(container.querySelectorAll<HTMLElement>("button")).find(
              (candidate) =>
                !candidate.id &&
                candidate.className === previousFocus.className &&
                (candidate.textContent ?? "") === previousFocus.text &&
                candidate.getAttribute("data-version") ===
                  previousFocus.version,
            ) ?? null);
      }
      if (target && container.contains(target)) target.focus();
    };

    const retryButton = (action: () => void, id: string) => {
      const button = h("button", { type: "button", id }, "Try again");
      button.addEventListener("click", action);
      return button;
    };

    const countyMatches = (county: CountyBannerSummary, query: string) => {
      const needle = query.trim().toLowerCase();
      return (
        needle !== "" &&
        (county.name.toLowerCase().includes(needle) ||
          county.fips.includes(needle))
      );
    };

    const countySearchCard = () => {
      const input = h("input", {
        type: "search",
        id: "banner-county-query",
        value: state.query,
        maxlength: "40",
        autocomplete: "off",
        "aria-describedby": "banner-county-query-help",
      });
      const note = h(
        "p",
        {
          class: "help",
          id: "banner-county-query-help",
          role: "status",
        },
        "Type a county name or five-digit FIPS code to highlight matches. The number after each FIPS code is the county's banner count.",
      );
      const grid = h("ol", {
        class: "county-index-grid banner-county-grid",
        id: "banner-counties",
      });
      const cells = new Map<string, HTMLElement>();
      for (const county of state.counties) {
        const open = h(
          "button",
          {
            type: "button",
            class: "banner-county-open",
            "data-fips": county.fips,
            title: `${county.name} County, FIPS ${county.fips}, ${county.bannerCount} banner${county.bannerCount === 1 ? "" : "s"}, ${county.publicBannerCount} public`,
          },
          h(
            "span",
            { class: "cell-name" },
            county.name,
            h(
              "span",
              { class: "visually-hidden" },
              ` County, FIPS ${county.fips}, ${county.bannerCount} banner${county.bannerCount === 1 ? "" : "s"}, ${county.publicBannerCount} public`,
            ),
          ),
          h(
            "span",
            { class: "cell-code", "aria-hidden": "true" },
            `${county.fips} \u00b7 ${county.bannerCount}`,
          ),
        );
        open.addEventListener("click", () => void openCounty(county));
        const cell = h(
          "li",
          { "data-county": "", "data-fips": county.fips },
          open,
        );
        if (state.detail?.county.fips === county.fips)
          cell.classList.add("is-active");
        cells.set(county.fips, cell);
        grid.append(cell);
      }
      // Highlight in place so typing never rebuilds the input or loses focus.
      const highlight = () => {
        let count = 0;
        for (const county of state.counties) {
          const hit = countyMatches(county, state.query);
          if (hit) count += 1;
          cells.get(county.fips)?.classList.toggle("is-match", hit);
        }
        note.textContent =
          state.query.trim() === ""
            ? "Type a county name or five-digit FIPS code to highlight matches. The number after each FIPS code is the county's banner count."
            : count === 0
              ? "No county matches that search."
              : `${count} ${count === 1 ? "county matches" : "counties match"}. Press Enter with one match to open it.`;
        return count;
      };
      input.addEventListener("input", () => {
        state.query = input.value;
        highlight();
      });
      const form = h(
        "form",
        { id: "banner-county-search", class: "banner-search" },
        h(
          "label",
          { for: "banner-county-query" },
          "Find a county by name or FIPS",
        ),
        input,
        h("button", { type: "submit", id: "banner-county-submit" }, "Search"),
        note,
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        state.query = input.value;
        highlight();
        const hits = state.counties.filter((county) =>
          countyMatches(county, state.query),
        );
        if (hits.length === 1 && hits[0]) void openCounty(hits[0]);
      });
      const rows: Node[] = [form];
      if (state.loadingCounties)
        rows.push(
          h("p", { class: "loading", role: "status" }, "Loading counties..."),
        );
      if (state.countiesError)
        rows.push(
          h(
            "p",
            { class: "dash-error", role: "alert" },
            state.countiesError,
            retryButton(() => void loadCounties(), "banner-county-retry"),
          ),
        );
      if (state.counties.length > 0) {
        rows.push(grid);
        highlight();
      }
      return h(
        "section",
        {
          class: "dash-card",
          id: "banners-counties",
          "aria-labelledby": "banners-counties-h",
        },
        h("h2", { id: "banners-counties-h" }, "Search and browse all counties"),
        ...rows,
      );
    };

    const orderedBanners = (): readonly BannerAdminBanner[] => {
      const banners = state.detail?.banners ?? [];
      if (!state.order) return banners;
      const byId = new Map(banners.map((banner) => [banner.id, banner]));
      const ordered = state.order
        .map((id) => byId.get(id))
        .filter((banner): banner is BannerAdminBanner => banner !== undefined);
      for (const banner of banners)
        if (!state.order.includes(banner.id)) ordered.push(banner);
      return ordered;
    };

    const countyCard = (detail: NonNullable<State["detail"]>) => {
      const rows: Node[] = [
        h(
          "p",
          { class: "dash-lede" },
          `${detail.county.name} (${detail.county.fips}) `,
          h(
            "a",
            {
              class: "banner-county-link",
              href: `/counties/${detail.county.fips}`,
              target: "_blank",
              rel: "noopener noreferrer",
              title: `Open the ${detail.county.name} County page in a new tab`,
            },
            h("span", { "aria-hidden": "true" }, "\u2197"),
            h(
              "span",
              { class: "visually-hidden" },
              `Open the ${detail.county.name} County page in a new tab`,
            ),
          ),
        ),
      ];
      if (detail.bannersTruncated)
        rows.push(
          h(
            "p",
            { class: "help" },
            `Only the first ${detail.banners.length} banners of this county are shown.`,
          ),
        );
      if (detail.banners.length > 1) rows.push(reorderControls());
      if (detail.banners.length === 0)
        rows.push(
          h(
            "p",
            { class: "empty", id: "banner-county-empty" },
            "This county has no banner yet. Add one below.",
          ),
        );
      rows.push(newBannerCard(detail.county.fips));
      return h(
        "section",
        {
          class: "dash-card",
          id: "banner-county",
          "aria-labelledby": "banner-county-h",
        },
        h("h2", { id: "banner-county-h" }, "County banners"),
        ...rows,
      );
    };

    const reorderControls = () => {
      const rows: Node[] = [];
      if (state.orderDirty)
        rows.push(
          h(
            "p",
            { class: "help", id: "banner-order-help" },
            "The display order has unsaved changes.",
          ),
        );
      const actions = h(
        "p",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            id: "banner-order-save",
            ...(state.orderDirty ? {} : { disabled: true }),
          },
          "Save order",
        ),
        h(
          "button",
          {
            type: "button",
            id: "banner-order-reset",
            ...(state.orderDirty ? {} : { disabled: true }),
          },
          "Cancel",
        ),
      );
      actions
        .querySelector("#banner-order-save")
        ?.addEventListener("click", () => void saveOrder());
      actions
        .querySelector("#banner-order-reset")
        ?.addEventListener("click", () => {
          state.order = state.detail
            ? state.detail.banners.map((banner) => banner.id)
            : null;
          state.orderDirty = false;
          render();
        });
      rows.push(actions);
      return h("div", { class: "banner-order" }, ...rows);
    };

    const moveButtons = (bannerId: string) => {
      const wrap = h("span", { class: "banner-move" });
      const make = (label: string, delta: number, id: string) => {
        const button = h(
          "button",
          { type: "button", id, "data-banner": bannerId },
          label,
        );
        button.addEventListener("click", () => {
          if (!state.order) return;
          const from = state.order.indexOf(bannerId);
          const target = from + delta;
          if (target < 0 || target >= state.order.length) return;
          const next = [...state.order];
          next.splice(from, 1);
          next.splice(target, 0, bannerId);
          state.order = next;
          state.orderDirty = true;
          render();
        });
        return button;
      };
      wrap.append(
        make("Move up", -1, `banner-move-up-${bannerId}`),
        make("Move down", 1, `banner-move-down-${bannerId}`),
      );
      return wrap;
    };

    const bannerCard = (banner: BannerAdminBanner) => {
      const bannerState = stateFor(banner.id);
      const children: Node[] = [
        h(
          "h3",
          { id: `banner-${banner.id}-h`, tabindex: "-1" },
          banner.caption ? banner.caption : "(no caption)",
        ),
        h(
          "p",
          { class: "dash-module-note" },
          `Banner ${banner.id}, version ${banner.rowVersion}`,
        ),
        ...bannerThumb(banner),
        bannerFacts(banner),
        ...versionList(banner, bannerState),
        ...stagedArea(banner, bannerState),
        ...confirmArea(banner, bannerState),
        ...conflictArea(banner, bannerState),
        ...actionRows(banner, bannerState),
        ...publicationRows(banner, bannerState),
        ...reconcileRows(banner, bannerState),
      ];
      return h(
        "section",
        {
          class: "dash-card banner-card",
          id: `banner-${banner.id}`,
          "aria-labelledby": `banner-${banner.id}-h`,
        },
        ...children,
      );
    };

    const bannerThumb = (banner: BannerAdminBanner): Node[] => {
      const id = previewVersionId(banner);
      if (!id) return [];
      const slot = h("div");
      const update = () => {
        const url = thumbs.get(id);
        const content = url
          ? h("img", {
              class: "banner-thumb",
              src: url,
              alt: `Private preview of the ${banner.selectedVersionId ? "current" : "latest"} image for banner ${banner.id}`,
            })
          : h(
              "p",
              { class: "help banner-thumb-note" },
              thumbs.has(id)
                ? "The preview could not be loaded."
                : "Loading preview...",
            );
        replaceChildren(doc, slot, content);
      };
      // A background preview must leave the active form and file input intact.
      thumbUpdates.set(id, update);
      update();
      return [slot];
    };

    const statusLabel = (banner: BannerAdminBanner): string =>
      banner.status === "active"
        ? banner.publicEligible
          ? "Public"
          : "Active, no public image"
        : banner.status === "withdrawn"
          ? "Withdrawn"
          : "Draft";

    const bannerFacts = (banner: BannerAdminBanner) =>
      h(
        "dl",
        { class: "dash-facts" },
        h("div", {}, h("dt", {}, "Status"), h("dd", {}, statusLabel(banner))),
        h(
          "div",
          {},
          h("dt", {}, "Alt text"),
          h("dd", {}, banner.altText || "None"),
        ),
        h(
          "div",
          {},
          h("dt", {}, "Display"),
          h(
            "dd",
            {},
            `${banner.displayMode}, focal ${banner.focalX}/${banner.focalY}`,
          ),
        ),
        h(
          "div",
          {},
          h("dt", {}, "Order"),
          h(
            "dd",
            {},
            `Display ${banner.displayOrder}${banner.homepageOrder === null ? "" : `, homepage ${banner.homepageOrder}`}${banner.isPrimary ? ", primary" : ""}`,
          ),
        ),
      );

    const versionStateLabel = (version: BannerAdminVersion): string => {
      if (version.isSelected) return "Selected";
      if (version.state === "verified") return "Staged, not public";
      if (version.state === "staging") return "Staging";
      if (version.state === "pending") return "Pending";
      return "Failed, needs attention";
    };

    const versionList = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const rows: Node[] = [h("h4", {}, `Versions (${banner.versionCount})`)];
      if (banner.versionsTruncated)
        rows.push(
          h(
            "p",
            { class: "help" },
            `Only the newest ${banner.versions.length} versions are shown.`,
          ),
        );
      rows.push(
        h(
          "ul",
          { class: "banner-versions" },
          ...banner.versions.map((version) =>
            h(
              "li",
              {
                "data-version": version.id,
                class: version.isSelected
                  ? "banner-version-selected"
                  : undefined,
              },
              h(
                "strong",
                {},
                `${versionStateLabel(version)} - ${version.mediaType === "image/png" ? "PNG" : "JPEG"}, ${version.width}x${version.height}`,
              ),
              h(
                "span",
                { class: "dash-module-note" },
                `Version ${version.id}, added ${new Date(version.createdAt).toLocaleString()}, source file ${version.sourceFilename}`,
              ),
              version.state === "verified" && !version.isSelected
                ? h(
                    "p",
                    { class: "actions" },
                    previewButton(banner.id, version.id),
                  )
                : null,
            ),
          ),
        ),
      );
      if (bannerState.retry)
        rows.push(
          h(
            "p",
            { class: "dash-error", role: "alert" },
            "The last change could not be completed.",
            retryButton(
              () => void bannerState.retry?.(),
              `banner-retry-${banner.id}`,
            ),
          ),
        );
      return rows;
    };

    const previewButton = (bannerId: string, versionId: string) => {
      const button = h(
        "button",
        { type: "button", class: "banner-preview", "data-version": versionId },
        "Preview privately",
      );
      button.addEventListener("click", () => {
        void showPreview(bannerId, versionId);
      });
      return button;
    };

    const stagedArea = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      if (!bannerState.staged) return [];
      const staged = bannerState.staged;
      if (!staged.versionId) {
        return staged.error
          ? [
              h(
                "p",
                {
                  class: "dash-error",
                  role: "alert",
                  id: `banner-staged-error-${banner.id}`,
                },
                staged.error,
              ),
            ]
          : [];
      }
      const rows: Node[] = [
        h("h4", {}, "Staged version, private preview"),
        h(
          "p",
          { class: "help" },
          "Only administrators and the owner can open this preview. Publishing makes it public.",
        ),
      ];
      if (staged.error)
        rows.push(
          h(
            "p",
            {
              class: "dash-error",
              role: "alert",
              id: `banner-staged-error-${banner.id}`,
            },
            staged.error,
            retryButton(
              () => void showPreview(banner.id, staged.versionId),
              `banner-staged-retry-${banner.id}`,
            ),
          ),
        );
      if (staged.url)
        rows.push(
          h("img", {
            src: staged.url,
            alt: `Private preview of the staged image for banner ${banner.id}`,
            class: "banner-preview-image",
            id: `banner-staged-image-${banner.id}`,
          }),
        );
      rows.push(...publishForm(banner, bannerState));
      return rows;
    };

    const publishForm = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const values = bannerState.pending ?? formValues(banner);
      const caption = h("input", {
        type: "text",
        id: `banner-caption-${banner.id}`,
        value: values.caption,
        maxlength: "500",
      });
      const alt = h("input", {
        type: "text",
        id: `banner-alt-${banner.id}`,
        value: values.altText,
        maxlength: "1000",
        required: true,
      });
      const mode = h("select", { id: `banner-mode-${banner.id}` });
      for (const option of ["cover", "contain"]) {
        const node = h("option", { value: option }, option);
        if (option === values.displayMode) node.selected = true;
        mode.append(node);
      }
      const focalX = h("input", {
        type: "number",
        id: `banner-focal-x-${banner.id}`,
        value: values.focalX,
        min: "0",
        max: "1",
        step: "0.05",
      });
      const focalY = h("input", {
        type: "number",
        id: `banner-focal-y-${banner.id}`,
        value: values.focalY,
        min: "0",
        max: "1",
        step: "0.05",
      });
      const keep = () => {
        bannerState.pending = {
          caption: caption.value,
          altText: alt.value,
          displayMode: mode.value === "contain" ? "contain" : "cover",
          focalX: focalX.value,
          focalY: focalY.value,
        };
      };
      for (const input of [caption, alt, focalX, focalY])
        input.addEventListener("input", keep);
      mode.addEventListener("change", keep);
      const publish = h(
        "button",
        { type: "button", id: `banner-publish-${banner.id}` },
        "Publish this version",
      );
      publish.addEventListener("click", () => {
        keep();
        stateFor(banner.id).confirming = { kind: "publish" };
        state.focusId = `banner-confirm-no-${banner.id}`;
        render();
      });
      return [
        h(
          "div",
          { class: "banner-publish-form" },
          h("label", { for: caption.id }, "Caption"),
          caption,
          h("label", { for: alt.id }, "Alt text (required)"),
          alt,
          h("label", { for: mode.id }, "Display mode"),
          mode,
          h("label", { for: focalX.id }, "Focal point X (0 to 1)"),
          focalX,
          h("label", { for: focalY.id }, "Focal point Y (0 to 1)"),
          focalY,
          h("p", { class: "actions" }, publish),
        ),
      ];
    };

    const confirmArea = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const confirm = bannerState.confirming;
      if (!confirm) return [];
      const county = state.detail?.county.name ?? "";
      const text =
        confirm.kind === "publish"
          ? `Publish the staged image for ${county} banner ${banner.id} to the county page?`
          : confirm.kind === "withdraw"
            ? `Withdraw ${county} banner ${banner.id} from the county page? Its history is kept.`
            : `Restore the recorded publication ${confirm.publicationId} for ${county} banner ${banner.id}, with its image, caption, alt text and display settings?`;
      const panel = h(
        "div",
        {
          class: "banner-confirm",
          role: "group",
          "aria-label": "Confirm change",
          id: `banner-confirm-${banner.id}`,
        },
        h("p", {}, text),
        h(
          "p",
          { class: "actions" },
          h(
            "button",
            {
              type: "button",
              "data-confirm": "yes",
              id: `banner-confirm-yes-${banner.id}`,
            },
            confirm.kind === "publish"
              ? "Publish"
              : confirm.kind === "withdraw"
                ? "Withdraw"
                : "Restore",
          ),
          h(
            "button",
            {
              type: "button",
              "data-confirm": "no",
              id: `banner-confirm-no-${banner.id}`,
            },
            "Cancel",
          ),
        ),
      );
      panel
        .querySelector('[data-confirm="yes"]')
        ?.addEventListener("click", () => {
          bannerState.confirming = null;
          // The confirmation disappears, so park focus on this banner's heading.
          state.focusId = `banner-${banner.id}-h`;
          if (confirm.kind === "publish") void doPublish(banner);
          else if (confirm.kind === "withdraw") void doWithdraw(banner);
          else if (confirm.kind === "restore" && confirm.versionId)
            void doRestore(banner, confirm.versionId, confirm.publicationId);
        });
      panel
        .querySelector('[data-confirm="no"]')
        ?.addEventListener("click", () => {
          bannerState.confirming = null;
          state.focusId = `banner-${confirm.kind === "withdraw" ? "withdraw" : "publish"}-${banner.id}`;
          render();
        });
      return [panel];
    };

    const conflictArea = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      if (!bannerState.conflict) return [];
      const panel = h(
        "div",
        {
          class: "banner-conflict",
          id: `banner-conflict-${banner.id}`,
          role: "alert",
        },
        h("p", {}, bannerState.conflict),
        h(
          "p",
          { class: "actions" },
          h(
            "button",
            { type: "button", id: `banner-conflict-refresh-${banner.id}` },
            "Refresh current state",
          ),
        ),
        h(
          "p",
          { class: "help" },
          "Your edits are kept below. Review the current state, then retry with the refreshed version.",
        ),
      );
      panel
        .querySelector("button")
        ?.addEventListener("click", () => void refreshAfterConflict(banner.id));
      return [panel];
    };

    const actionRows = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const stageInput = h("input", {
        type: "file",
        id: `banner-file-${banner.id}`,
        accept: "image/png,image/jpeg",
        class: "banner-file",
      });
      stageInput.addEventListener("change", () => {
        const file = stageInput.files?.[0];
        if (file) void stageFile(banner, file, stageInput);
      });
      const rows: Node[] = [
        h("h4", {}, "Replace the image"),
        h(
          "label",
          { for: stageInput.id, class: "banner-file-label" },
          "Choose a PNG or JPEG to stage (25 MiB limit)",
        ),
        stageInput,
      ];
      const detailsButton = h(
        "button",
        { type: "button", id: `banner-details-${banner.id}` },
        "Edit details",
      );
      detailsButton.addEventListener("click", () => {
        bannerState.editingDetails = !bannerState.editingDetails;
        if (bannerState.editingDetails && !bannerState.pending)
          bannerState.pending = formValues(banner);
        render();
      });
      const withdrawButton = h(
        "button",
        { type: "button", id: `banner-withdraw-${banner.id}` },
        "Withdraw",
      );
      withdrawButton.addEventListener("click", () => {
        bannerState.confirming = { kind: "withdraw" };
        state.focusId = `banner-confirm-no-${banner.id}`;
        render();
      });
      const checkButton = h(
        "button",
        { type: "button", id: `banner-reconcile-${banner.id}` },
        "Check stored images",
      );
      checkButton.addEventListener("click", () => void doReconcile(banner.id));
      const move =
        (state.order?.length ?? 0) > 1 ? moveButtons(banner.id) : null;
      rows.push(
        h(
          "p",
          { class: "actions banner-actions" },
          detailsButton,
          banner.status === "active" ? withdrawButton : null,
          checkButton,
          move,
        ),
      );
      if (bannerState.editingDetails)
        rows.push(...detailsForm(banner, bannerState));
      return rows;
    };

    const detailsForm = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const values = bannerState.pending ?? formValues(banner);
      const caption = h("input", {
        type: "text",
        id: `banner-detail-caption-${banner.id}`,
        value: values.caption,
        maxlength: "500",
      });
      const alt = h("input", {
        type: "text",
        id: `banner-detail-alt-${banner.id}`,
        value: values.altText,
        maxlength: "1000",
        required: true,
      });
      const mode = h("select", { id: `banner-detail-mode-${banner.id}` });
      for (const option of ["cover", "contain"]) {
        const node = h("option", { value: option }, option);
        if (option === values.displayMode) node.selected = true;
        mode.append(node);
      }
      const focalX = h("input", {
        type: "number",
        id: `banner-detail-focal-x-${banner.id}`,
        value: values.focalX,
        min: "0",
        max: "1",
        step: "0.05",
      });
      const focalY = h("input", {
        type: "number",
        id: `banner-detail-focal-y-${banner.id}`,
        value: values.focalY,
        min: "0",
        max: "1",
        step: "0.05",
      });
      const keep = () => {
        bannerState.pending = {
          caption: caption.value,
          altText: alt.value,
          displayMode: mode.value === "contain" ? "contain" : "cover",
          focalX: focalX.value,
          focalY: focalY.value,
        };
      };
      for (const input of [caption, alt, focalX, focalY])
        input.addEventListener("input", keep);
      mode.addEventListener("change", keep);
      const save = h(
        "button",
        { type: "button", id: `banner-detail-save-${banner.id}` },
        "Save details",
      );
      save.addEventListener("click", () => {
        keep();
        void doMetadata(banner);
      });
      const cancel = h(
        "button",
        { type: "button", id: `banner-detail-cancel-${banner.id}` },
        "Cancel",
      );
      cancel.addEventListener("click", () => {
        bannerState.editingDetails = false;
        bannerState.pending = null;
        render();
      });
      return [
        h(
          "div",
          { class: "banner-details-form" },
          h("label", { for: caption.id }, "Caption"),
          caption,
          h("label", { for: alt.id }, "Alt text (required)"),
          alt,
          h("label", { for: mode.id }, "Display mode"),
          mode,
          h("label", { for: focalX.id }, "Focal point X (0 to 1)"),
          focalX,
          h("label", { for: focalY.id }, "Focal point Y (0 to 1)"),
          focalY,
          h("p", { class: "actions" }, save, cancel),
        ),
      ];
    };

    const publicationRows = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const rows: Node[] = [h("h4", {}, "Publication history")];
      if (bannerState.publicationsError)
        rows.push(
          h(
            "p",
            { class: "dash-error", role: "alert" },
            bannerState.publicationsError,
            retryButton(
              () => void loadPublications(banner.id),
              `banner-history-retry-${banner.id}`,
            ),
          ),
        );
      else if (bannerState.publications === null)
        rows.push(
          h("p", { class: "help" }, "History has not been loaded yet."),
        );
      else if (bannerState.publications.length === 0)
        rows.push(
          h(
            "p",
            { class: "empty", id: `banner-history-empty-${banner.id}` },
            "This banner has never been published.",
          ),
        );
      else
        rows.push(
          h(
            "ol",
            { class: "banner-publications", id: `banner-history-${banner.id}` },
            ...bannerState.publications.map((record) => {
              const item = h(
                "li",
                { "data-publication": record.id },
                h(
                  "strong",
                  {},
                  `#${record.sequence} ${originLabel(record.origin)}, version ${record.versionId}`,
                ),
                h(
                  "span",
                  { class: "dash-module-note" },
                  `${record.caption ? `Caption: ${record.caption}. ` : ""}Alt: ${record.altText}. ${record.displayMode}, focal ${record.focalX}/${record.focalY}. Published ${new Date(record.publishedAt).toLocaleString()}.`,
                ),
                h(
                  "p",
                  { class: "actions" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "banner-restore",
                      "data-publication": record.id,
                    },
                    "Restore this publication",
                  ),
                ),
              );
              item
                .querySelector("button.banner-restore")
                ?.addEventListener("click", () => {
                  bannerState.confirming = {
                    kind: "restore",
                    versionId: record.versionId,
                    publicationId: record.id,
                  };
                  state.focusId = `banner-confirm-no-${banner.id}`;
                  render();
                });
              return item;
            }),
          ),
        );
      return rows;
    };

    const reconcileRows = (
      banner: BannerAdminBanner,
      bannerState: BannerState,
    ) => {
      const items = bannerState.reconcile;
      if (!items) return [];
      return [
        h(
          "div",
          {
            class: "banner-reconcile",
            id: `banner-reconcile-report-${banner.id}`,
          },
          h("h4", {}, "Stored image check"),
          items.length === 0
            ? h("p", { class: "empty" }, "No versions to check.")
            : h(
                "ul",
                {},
                ...items.map((item) =>
                  h(
                    "li",
                    {},
                    `Version ${item.versionId}: ${classificationLabel(item.classification)}`,
                  ),
                ),
              ),
        ),
      ];
    };

    const newBannerCard = (countyFips: string) => {
      const bannerIdInput = h("input", {
        type: "text",
        id: "banner-new-id",
        value: state.newBannerId,
        maxlength: "128",
      });
      bannerIdInput.addEventListener("input", () => {
        state.newBannerId = bannerIdInput.value;
      });
      const file = h("input", {
        type: "file",
        id: "banner-new-file",
        accept: "image/png,image/jpeg",
        class: "banner-file",
      });
      const caption = h("input", {
        type: "text",
        id: "banner-new-caption",
        maxlength: "500",
      });
      const alt = h("input", {
        type: "text",
        id: "banner-new-alt",
        maxlength: "1000",
        required: true,
      });
      const order = h("input", {
        type: "number",
        id: "banner-new-order",
        value: "0",
        min: "0",
        step: "1",
      });
      const primary = h("input", {
        type: "checkbox",
        id: "banner-new-primary",
      });
      const fileNote = h("p", {
        class: "help",
        id: "banner-new-file-note",
        role: "status",
      });
      // Names follow 08XXX-COUNTYNAME-CAPTION. Fill only fields that are
      // empty or still hold the previous fill, so typed edits are kept.
      const filled = { id: "", caption: "", alt: "" };
      const fillFrom = (
        input: HTMLInputElement,
        key: keyof typeof filled,
        value: string,
      ) => {
        if (
          value &&
          (input.value.trim() === "" || input.value === filled[key])
        ) {
          input.value = value;
          filled[key] = value;
        }
      };
      file.addEventListener("change", () => {
        const chosen = file.files?.[0];
        if (!chosen) return;
        const parsed = parseBannerFilename(
          chosen.name,
          state.detail?.county.name ?? "",
        );
        fillFrom(bannerIdInput, "id", parsed.bannerId);
        state.newBannerId = bannerIdInput.value;
        fillFrom(caption, "caption", parsed.caption);
        fillFrom(alt, "alt", parsed.altText);
        fileNote.textContent =
          parsed.fips && parsed.fips !== countyFips
            ? `The file name starts with ${parsed.fips}, but this county is ${countyFips}. Check the county before staging.`
            : parsed.matched
              ? "Banner ID, caption and alt text were filled from the file name. Edit them if needed."
              : "The file name does not follow 08XXX-COUNTY-CAPTION, so only the banner ID was filled.";
      });
      const stage = h(
        "button",
        { type: "button", id: "banner-new-stage" },
        "Stage new banner",
      );
      stage.addEventListener("click", () => {
        const chosen = file.files?.[0];
        if (!chosen) {
          announceError("Choose an image file first.");
          return;
        }
        void stageNewBanner(countyFips, {
          bannerId: bannerIdInput.value.trim(),
          file: chosen,
          caption: caption.value,
          altText: alt.value,
          displayOrder: Number(order.value || "0"),
          isPrimary: primary.checked,
        });
      });
      return h(
        "div",
        { class: "banner-new", id: "banner-new" },
        h("h4", {}, "Add a banner"),
        h(
          "label",
          { for: "banner-new-id" },
          "Banner ID (letters, numbers, dots, dashes)",
        ),
        bannerIdInput,
        h("label", { for: "banner-new-file" }, "Image (PNG or JPEG)"),
        file,
        fileNote,
        h("label", { for: "banner-new-caption" }, "Caption"),
        caption,
        h("label", { for: "banner-new-alt" }, "Alt text (required)"),
        alt,
        h("label", { for: "banner-new-order" }, "Display order"),
        order,
        h(
          "div",
          {},
          h(
            "label",
            { for: "banner-new-primary" },
            "Primary banner for the county",
          ),
          primary,
        ),
        ...(state.newStage?.countyFips === countyFips
          ? [
              h(
                "p",
                {
                  class: "dash-error",
                  role: "alert",
                  id: `banner-new-retry-note-${countyFips}`,
                },
                "The staging request did not complete. Retry sends the same image and details again with the same idempotency key; submitting changed inputs uses a new key.",
                retryButton(
                  () => void state.newStage?.run(),
                  "banner-new-retry",
                ),
              ),
            ]
          : []),
        h("p", { class: "actions" }, stage),
      );
    };

    // ------------------------------------------------------------ actions

    const loadCounties = async () => {
      state.loadingCounties = true;
      state.countiesError = null;
      render();
      try {
        const all: CountyBannerSummary[] = [];
        let after: string | undefined;
        // Colorado has 64 counties, so this is one request. The loop only
        // guards against a smaller server page.
        for (let page = 0; page < 5; page += 1) {
          const result = await view.client.listCounties({
            limit: COUNTY_PAGE_LIMIT,
            ...(after ? { afterFips: after } : {}),
          });
          all.push(...result.counties);
          after = result.nextAfterFips ?? undefined;
          if (!after) break;
        }
        state.counties = all;
        state.nextAfterFips = null;
      } catch (error) {
        state.countiesError = describe(error);
      } finally {
        state.loadingCounties = false;
        render();
      }
    };

    const openCounty = async (county: CountyBannerSummary) => {
      state.loadingDetail = true;
      state.detailError = null;
      render();
      await loadCounty(county.fips);
    };

    const loadCounty = async (fips: string) => {
      try {
        const detail = await view.client.getCounty(fips);
        state.detail = detail;
        state.order = detail.banners.map((banner) => banner.id);
        state.orderDirty = false;
        ensureThumbs(detail.banners);
        for (const banner of detail.banners) {
          const bannerState = stateFor(banner.id);
          if (
            bannerState.publications === null &&
            !bannerState.publicationsError
          )
            void loadPublications(banner.id);
        }
      } catch (error) {
        state.detailError = describe(error);
      } finally {
        state.loadingDetail = false;
        render();
      }
    };

    const refreshAfterConflict = async (bannerId: string) => {
      if (!state.detail) return;
      const fips = state.detail.county.fips;
      await loadCounty(fips);
      stateFor(bannerId).conflict =
        "Current state is shown. Your edits are kept below. Retry when you have reviewed them.";
      render();
    };

    const loadPublications = async (bannerId: string) => {
      const bannerState = stateFor(bannerId);
      try {
        bannerState.publications = await view.client.listPublications(bannerId);
        bannerState.publicationsError = null;
      } catch (error) {
        bannerState.publicationsError = describe(error);
      }
      render();
    };

    const showPreview = async (bannerId: string, versionId: string) => {
      const bannerState = stateFor(bannerId);
      bannerState.staged = { versionId, url: null, error: null };
      render();
      try {
        const image = await view.client.versionImage(versionId);
        if (bannerState.staged?.versionId === versionId) {
          bannerState.staged.url = makePreview(image.bytes, image.mediaType);
          bannerState.staged.error = null;
        }
      } catch (error) {
        if (bannerState.staged?.versionId === versionId)
          bannerState.staged.error = describe(error);
      }
      render();
    };

    const stageFile = async (
      banner: BannerAdminBanner,
      file: File,
      input: HTMLInputElement,
    ) => {
      const mediaType =
        file.type === "image/png"
          ? "image/png"
          : file.type === "image/jpeg"
            ? "image/jpeg"
            : null;
      const bannerState = stateFor(banner.id);
      if (!mediaType) {
        bannerState.staged = {
          versionId: "",
          url: null,
          error: "Only PNG and JPEG images are accepted.",
        };
        render();
        input.value = "";
        return;
      }
      const key = view.newKey();
      const attempt = async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return view.client.stageReplacement({
          bannerId: banner.id,
          countyFips: state.detail?.county.fips ?? "",
          sourceFilename: file.name,
          idempotencyKey: key,
          expectedRowVersion: currentRowVersion(banner.id) ?? banner.rowVersion,
          bytes,
          mediaType,
        });
      };
      await runStaged(banner, bannerState, attempt);
      input.value = "";
    };

    const stageNewBanner = async (
      countyFips: string,
      input: {
        bannerId: string;
        file: File;
        caption: string;
        altText: string;
        displayOrder: number;
        isPrimary: boolean;
      },
    ) => {
      const mediaType =
        input.file.type === "image/png"
          ? "image/png"
          : input.file.type === "image/jpeg"
            ? "image/jpeg"
            : null;
      if (!mediaType) {
        announceError("Only PNG and JPEG images are accepted.");
        return;
      }
      if (!input.bannerId) {
        announceError("Enter a banner ID first.");
        return;
      }
      if (!input.altText.trim()) {
        announceError("Alt text is required before staging a new banner.");
        return;
      }
      const key = view.newKey();
      const attempt = async () => {
        const bytes = new Uint8Array(await input.file.arrayBuffer());
        return view.client.stageNew({
          bannerId: input.bannerId,
          countyFips,
          sourceFilename: input.file.name,
          idempotencyKey: key,
          metadata: {
            caption: input.caption,
            altText: input.altText,
            displayOrder: input.displayOrder,
            isPrimary: input.isPrimary,
            homepageOrder: null,
            displayMode: "cover",
            focalX: 0.5,
            focalY: 0.5,
          },
          bytes,
          mediaType,
        });
      };
      await runNewStage(countyFips, attempt);
    };

    const runNewStage = async (
      countyFips: string,
      attempt: () => Promise<{
        bannerId: string;
        version: { readonly id: string };
      }>,
    ) => {
      try {
        const result = await attempt();
        state.newStage = null;
        state.notice = `Staged version ${result.version.id} for banner ${result.bannerId}. Preview it below, then publish.`;
        announce(`Staged version for banner ${result.bannerId}`);
        state.newBannerId = "";
        await loadCounty(countyFips);
        await showPreview(result.bannerId, result.version.id);
      } catch (error) {
        retainNewStage(error, countyFips, attempt);
        announceError(describe(error));
      }
      render();
    };

    const retainNewStage = (
      error: unknown,
      countyFips: string,
      attempt: () => Promise<{
        bannerId: string;
        version: { readonly id: string };
      }>,
    ) => {
      if (!isRetryable(error)) {
        state.newStage = null;
        return;
      }
      state.newStage = {
        countyFips,
        run: async () => {
          state.newStage = null;
          render();
          await runNewStage(countyFips, attempt);
        },
      };
    };

    const runStaged = async (
      banner: BannerAdminBanner,
      bannerState: BannerState,
      attempt: () => Promise<{ version: { readonly id: string } }>,
    ) => {
      try {
        const result = await attempt();
        bannerState.conflict = null;
        bannerState.retry = null;
        state.notice = `Staged version ${result.version.id} for banner ${banner.id}. Preview it below, then publish.`;
        announce(`Staged version for banner ${banner.id}`);
        if (state.detail) await loadCounty(state.detail.county.fips);
        await showPreview(banner.id, result.version.id);
      } catch (error) {
        if (
          error instanceof BannerAdminError &&
          error.code === "stale_version"
        ) {
          bannerState.conflict = describe(error);
          bannerState.retry = null;
          announceError(describe(error));
        } else if (
          error instanceof BannerAdminError &&
          error.code === "idempotency_conflict"
        ) {
          bannerState.retry = null;
          announceError(
            "This request was already sent with different details. Choose the image again.",
          );
        } else {
          bannerState.retry = async () => {
            bannerState.retry = null;
            await runStaged(banner, bannerState, attempt);
          };
          announceError(describe(error));
        }
        render();
      }
    };

    const metadataOf = (
      bannerState: BannerState,
    ): PublicationMetadata | null => {
      const values = bannerState.pending;
      if (!values) return null;
      const focalX = Number(values.focalX);
      const focalY = Number(values.focalY);
      if (!values.altText.trim()) {
        announceError("Alt text is required before publishing.");
        return null;
      }
      if (
        Number.isNaN(focalX) ||
        Number.isNaN(focalY) ||
        focalX < 0 ||
        focalX > 1 ||
        focalY < 0 ||
        focalY > 1
      ) {
        announceError("Focal points must be between 0 and 1.");
        return null;
      }
      return {
        caption: values.caption,
        altText: values.altText,
        displayMode: values.displayMode,
        focalX,
        focalY,
      };
    };

    const doPublish = async (banner: BannerAdminBanner) => {
      const bannerState = stateFor(banner.id);
      const versionId = bannerState.staged?.versionId;
      if (!versionId) return;
      const metadata = metadataOf(bannerState);
      if (metadata === null) return;
      const key = view.newKey();
      const attempt = () =>
        view.client.publish({
          bannerId: banner.id,
          versionId,
          expectedRowVersion: currentRowVersion(banner.id) ?? banner.rowVersion,
          idempotencyKey: key,
          metadata,
        });
      await runWrite(banner, bannerState, attempt, key, "Published");
    };

    const doWithdraw = async (banner: BannerAdminBanner) => {
      const bannerState = stateFor(banner.id);
      const key = view.newKey();
      const attempt = () =>
        view.client.withdraw(
          banner.id,
          currentRowVersion(banner.id) ?? banner.rowVersion,
          key,
        );
      await runWrite(
        banner,
        bannerState,
        attempt,
        key,
        "Withdrawn from public view",
      );
    };

    const doRestore = async (
      banner: BannerAdminBanner,
      versionId: string,
      publicationId?: string,
    ) => {
      const bannerState = stateFor(banner.id);
      const key = view.newKey();
      const attempt = () =>
        view.client.restore({
          bannerId: banner.id,
          versionId,
          expectedRowVersion: currentRowVersion(banner.id) ?? banner.rowVersion,
          idempotencyKey: key,
          ...(publicationId ? { publicationId } : {}),
        });
      await runWrite(banner, bannerState, attempt, key, "Restored");
    };

    const doMetadata = async (banner: BannerAdminBanner) => {
      const bannerState = stateFor(banner.id);
      const metadata = metadataOf(bannerState);
      if (metadata === null) return;
      const key = view.newKey();
      const attempt = () =>
        view.client.updateMetadata({
          bannerId: banner.id,
          expectedRowVersion: currentRowVersion(banner.id) ?? banner.rowVersion,
          idempotencyKey: key,
          change: {
            caption: metadata.caption,
            altText: metadata.altText,
            displayMode: metadata.displayMode,
            focalX: metadata.focalX,
            focalY: metadata.focalY,
          },
        });
      bannerState.editingDetails = false;
      await runWrite(banner, bannerState, attempt, key, "Details saved");
    };

    const doReconcile = async (bannerId: string) => {
      const bannerState = stateFor(bannerId);
      try {
        bannerState.reconcile = await view.client.reconcile(bannerId);
      } catch (error) {
        announceError(describe(error));
        return;
      }
      render();
    };

    const saveOrder = async () => {
      const detail = state.detail;
      if (!detail || !state.order) return;
      const key = view.newKey();
      const expectedRowVersions: Record<string, number> = {};
      for (const banner of detail.banners)
        expectedRowVersions[banner.id] = banner.rowVersion;
      try {
        await view.client.reorderCounty({
          countyFips: detail.county.fips,
          idempotencyKey: key,
          orderedBannerIds: state.order,
          expectedRowVersions,
        });
        state.notice = "Display order saved.";
        await loadCounty(detail.county.fips);
      } catch (error) {
        announceError(describe(error));
      }
    };

    const currentRowVersion = (bannerId: string): number | null =>
      state.detail?.banners.find((banner) => banner.id === bannerId)
        ?.rowVersion ?? null;

    const runWrite = async (
      banner: BannerAdminBanner,
      bannerState: BannerState,
      attempt: () => Promise<unknown>,
      key: string,
      done: string,
    ) => {
      try {
        await attempt();
        bannerState.conflict = null;
        bannerState.retry = null;
        bannerState.staged = null;
        bannerState.pending = null;
        bannerState.editingDetails = false;
        bannerState.publications = null;
        bannerState.publicationsError = null;
        state.notice = `${done}.`;
        announce(done);
        if (state.detail) await loadCounty(state.detail.county.fips);
        else render();
      } catch (error) {
        if (
          error instanceof BannerAdminError &&
          error.code === "stale_version"
        ) {
          bannerState.conflict = describe(error);
          bannerState.retry = null;
          announceError(describe(error));
        } else if (
          error instanceof BannerAdminError &&
          error.code === "idempotency_conflict"
        ) {
          bannerState.retry = null;
          announceError(
            "This request was already sent with different details. Start the change again.",
          );
        } else if (isRetryable(error)) {
          bannerState.retry = async () => {
            bannerState.retry = null;
            await runWrite(banner, bannerState, attempt, key, done);
          };
          announceError(describe(error));
        } else {
          bannerState.retry = null;
          announceError(describe(error));
        }
        render();
      }
    };

    const announceError = (text: string) => {
      state.notice = null;
      announce(text);
    };

    render();
    void loadCounties();

    return {
      destroy() {
        destroyed = true;
        thumbUpdates.clear();
        dropPreviews();
      },
    };
  };
}

const originLabel = (origin: BannerPublicationRecord["origin"]): string => {
  switch (origin) {
    case "publish":
      return "Published";
    case "restore_recorded":
      return "Restored from a recorded publication";
    case "restore_explicit":
      return "Restored with explicit details";
    case "metadata_edit":
      return "Details edited";
  }
};

const classificationLabel = (
  classification: BannerReconciliationItem["classification"],
): string => {
  switch (classification) {
    case "verified_unchanged":
      return "verified, unchanged";
    case "verified_object_missing":
      return "verified, but the stored image is missing";
    case "staging_object_missing":
      return "staging image is missing";
    case "stored_object_integrity_failed":
      return "stored image failed its integrity check";
    case "object_present_unverified_database_state":
      return "stored image is present but the version is not verified";
  }
};

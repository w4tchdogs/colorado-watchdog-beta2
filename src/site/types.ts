import type { ApplicationServices } from "../services/index.js";
import type { BannerSource } from "./banner.js";
import type { EditorialSource } from "./editorial-source.js";
import type { SafeHtml } from "./html.js";

/** The read-only slice of the shared service layer the public site uses. */
export type PublicSiteServices = Pick<
  ApplicationServices,
  | "listCounties"
  | "listOfficials"
  | "getCountyStructure"
  | "getCountyOverview"
  | "listCountyOrganizations"
  | "listCountyRoleEntries"
  | "searchPeople"
  | "searchOrganizations"
  | "getPersonProfile"
  | "getOrganizationProfile"
  | "listOrganizationRoleEntries"
>;

/** Sync SQL.js and asynchronous host services share the same render contract. */
export type PublicSiteServiceResults = {
  [Key in keyof PublicSiteServices]: (
    ...args: Parameters<PublicSiteServices[Key]>
  ) =>
    | ReturnType<PublicSiteServices[Key]>
    | Promise<ReturnType<PublicSiteServices[Key]>>;
};

export interface SiteAsset {
  readonly body: string | Uint8Array;
  readonly contentType: string;
}

/** Host-provided static files (stylesheet and enhancement script). */
export interface SiteAssets {
  get(name: string): Promise<SiteAsset | null>;
}

export interface PublicSiteOptions {
  readonly services: PublicSiteServiceResults;
  readonly assets: SiteAssets;
  /** Published editorial content. Defaults to a source with no articles. */
  readonly editorial?: EditorialSource;
  /**
   * True only in the local preview. Shows a persistent notice that all
   * records and articles are fictional demonstration data.
   */
  readonly preview?: boolean;
  readonly now?: () => Date;
  /** Published banner artwork. Defaults to none, which shows placeholders. */
  readonly banners?: BannerSource;
  /** Extra origins allowed to serve banner images (added to the CSP). */
  readonly bannerOrigins?: readonly string[];
  /** Whether a configured local fictional-report test adapter is available. */
  readonly reportSubmissionsEnabled?: boolean;
  /** Server-side ACCT-1 check for the private staff review page. */
  readonly reportReviewAccess?: (request: Request) => Promise<401 | 403 | null>;
}

export interface SiteContext {
  readonly services: PublicSiteServiceResults;
  readonly editorial: EditorialSource;
  readonly preview: boolean;
  readonly now: Date;
  readonly banners: BannerSource;
  readonly reportSubmissionsEnabled: boolean;
}

export interface Breadcrumb {
  readonly label: string;
  readonly href?: string;
}

export interface Page {
  readonly status?: number;
  readonly title: string;
  readonly description?: string;
  /** Navigation key of the active section. */
  readonly section?: string;
  readonly breadcrumbs?: readonly Breadcrumb[];
  /** Full-bleed markup rendered above the padded main column. */
  readonly lead?: SafeHtml;
  /** Section-level navigation bar rendered directly under the site header. */
  readonly subnav?: SafeHtml;
  /** When set, the response is a redirect to this internal path. */
  readonly redirect?: string;
  readonly body: SafeHtml;
  /** Reviewed same-origin stylesheets and scripts for this page. */
  readonly head?: SafeHtml;
}

export class BadRequest extends Error {
  constructor(readonly restartHref: string) {
    super("bad_request");
    this.name = "BadRequest";
  }
}

export class NotFound extends Error {
  constructor(readonly what = "page") {
    super("not_found");
    this.name = "NotFound";
  }
}

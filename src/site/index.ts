import { emptyCountyStructure } from "../services/county-structure-public.js";
import { emptyBannerSource } from "./banner.js";
import {
  type EditorialFilters,
  FILTER_PARAMETERS,
  parseEditorialFilters,
} from "./community-voices.js";
import { emptyEditorialSource } from "./editorial-source.js";
import { isCountyFips } from "./format.js";
import { html, path } from "./html.js";
import { renderDocument } from "./layout.js";
import { countiesPage } from "./pages/counties.js";
import { countyPage } from "./pages/county.js";
import { directoryPage } from "./pages/directory.js";
import { articlePage, editorialListPage } from "./pages/editorial.js";
import {
  badRequestPage,
  methodNotAllowedPage,
  notFoundPage,
  serverErrorPage,
  unavailablePage,
} from "./pages/errors.js";
import { homePage } from "./pages/home.js";
import { aboutPage, readingRecordsPage } from "./pages/info.js";
import { officialsPage } from "./pages/officials.js";
import { organizationPage } from "./pages/organization.js";
import { personPage } from "./pages/person.js";
import { reportPage } from "./pages/report.js";
import { staffReportsPage } from "./pages/staff-reports.js";
import {
  isReportDirectoryPath,
  reportDirectoryResponse,
} from "./report-directory.js";
import {
  type AccountEntry,
  BadRequest,
  NotFound,
  type Page,
  type PublicSiteOptions,
  type SiteContext,
} from "./types.js";

export type { BannerPresentation, BannerSource } from "./banner.js";
export type { EditorialSource } from "./editorial-source.js";
export type { PublicSiteOptions, SiteAssets } from "./types.js";

const MAX_PATH_LENGTH = 300;
const MAX_QUERY_LENGTH = 1024;
const ASSET_PATH = /^\/assets\/([a-z0-9][a-z0-9.-]{0,80}\.(?:css|js|svg|png))$/;
const PUBLIC_BROWSING_PATH =
  /^\/(?:$|(?:counties|people|organizations|officials|posts|stories|about|reading-records)(?:\/|$))/;

function isStaffReportsPath(pathname: string): boolean {
  try {
    return (
      decodeURIComponent(pathname).replace(/\/+$/, "") === "/admin/reports"
    );
  } catch {
    return false;
  }
}

const CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";

function securityHeaders(
  bannerOrigins: readonly string[],
  allowChatGptEditor = false,
  challenge = false,
) {
  // Only well-formed https origins may be added for banner images.
  const origins = bannerOrigins.filter((origin) =>
    /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(origin),
  );
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    ...(!allowChatGptEditor ? { "x-frame-options": "DENY" } : {}),
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": `default-src 'none'; script-src 'self'${challenge ? ` ${CHALLENGE_ORIGIN}` : ""}; ${challenge ? `frame-src ${CHALLENGE_ORIGIN}; ` : ""}style-src 'self'; img-src ${["'self'", ...origins].join(" ")}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${allowChatGptEditor ? "https://chatgpt.com" : "'none'"}`,
  } as const;
}

/** Rejects repeated parameters and anything outside the page's allowlist. */
function checkedParameters(
  url: URL,
  allowed: readonly string[],
  restartHref: string,
): URLSearchParams {
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new BadRequest(restartHref);
    }
  }
  return url.searchParams;
}

/**
 * Validates the Community Voices filters of /stories and /posts. Malformed
 * values and unknown Colorado county codes are rejected with a restart link.
 */
async function editorialFilters(
  context: SiteContext,
  url: URL,
  listing: "/stories" | "/posts",
): Promise<EditorialFilters> {
  const parameters = checkedParameters(url, FILTER_PARAMETERS, listing);
  const filters = parseEditorialFilters(parameters);
  if (filters === null) throw new BadRequest(listing);
  if (
    filters.county !== undefined &&
    !(await context.services.listCounties()).some(
      (county) => county.fips === filters.county,
    )
  ) {
    throw new BadRequest(listing);
  }
  return filters;
}

async function route(
  context: SiteContext,
  url: URL,
  pathname: string,
  entry: AccountEntry | null,
  reportAccountId?: () => Promise<string | null>,
): Promise<Page> {
  const segments = pathname.split("/").filter(Boolean);
  const [first, second, ...rest] = segments;
  if (rest.length > 0 || pathname.includes("//")) throw new NotFound();
  const none = () => checkedParameters(url, [], pathname);

  if (first === undefined) {
    none();
    return homePage(context);
  }
  if (second === undefined) {
    switch (first) {
      case "counties": {
        const parameters = checkedParameters(url, ["q", "county"], "/counties");
        // The county switcher submits a FIPS code; send it to that county.
        const county = parameters.get("county");
        if (county !== null) {
          if (
            !isCountyFips(county) ||
            !(await context.services.listCounties()).some(
              (c) => c.fips === county,
            )
          ) {
            throw new BadRequest("/counties");
          }
          return {
            title: "Redirect",
            body: html``,
            redirect: path("counties", county),
          };
        }
        return countiesPage(context, parameters.get("q") ?? "");
      }
      case "people":
      case "organizations":
        return directoryPage(
          context,
          first,
          checkedParameters(url, ["query", "cursor"], `/${first}`),
        );
      case "officials":
        return officialsPage(
          context,
          checkedParameters(
            url,
            ["view", "directoryView", "county", "office", "q", "sort", "page"],
            "/officials",
          ),
        );
      case "stories":
        return editorialListPage(
          context,
          "story",
          await editorialFilters(context, url, "/stories"),
        );
      case "posts":
        return editorialListPage(
          context,
          "post",
          await editorialFilters(context, url, "/posts"),
        );
      case "about":
        none();
        return aboutPage();
      case "reading-records":
        none();
        return readingRecordsPage();
      case "submit-report": {
        const params = checkedParameters(
          url,
          ["guest", "account"],
          "/submit-report",
        );
        const mode = params.has("guest")
          ? "guest"
          : params.has("account")
            ? "account"
            : "choose";
        if (params.size > 1 || (mode !== "choose" && params.get(mode) !== "1"))
          throw new BadRequest("/submit-report");
        const accountId =
          mode === "account" &&
          context.reportSubmissionsEnabled &&
          entry === "signed-in"
            ? await reportAccountId?.()
            : null;
        return reportPage(context, mode, entry, accountId);
      }
      case "track-report":
        none();
        return reportPage(context, "track", entry);
      default:
        throw new NotFound();
    }
  }
  switch (first) {
    case "admin":
      if (second !== "reports") throw new NotFound();
      none();
      return staffReportsPage();
    case "counties":
      return countyPage(
        context,
        second,
        checkedParameters(url, ["orgAfter", "roleAfter"], pathname),
      );
    case "people":
      return personPage(
        context,
        second,
        checkedParameters(url, ["afterRoleId", "from"], pathname),
      );
    case "organizations":
      return organizationPage(
        context,
        second,
        checkedParameters(url, ["positionAfter", "roleAfter"], pathname),
      );
    case "stories":
      none();
      return articlePage(context, "story", second);
    case "posts":
      none();
      return articlePage(context, "post", second);
    default:
      throw new NotFound();
  }
}

function errorToPage(error: unknown): Page {
  if (error instanceof NotFound) return notFoundPage(error.what);
  if (error instanceof BadRequest) return badRequestPage(error.restartHref);
  if (error instanceof Error) {
    if (error.name === "StorageUnavailableError") return unavailablePage();
    if (error.name.endsWith("InputError")) return badRequestPage("/");
  }
  return serverErrorPage();
}

/**
 * Server-rendered public site. It reads only through the shared service layer
 * and returns complete HTML documents, so pages work without JavaScript.
 */
export function createPublicSite(options: PublicSiteOptions) {
  const editorial = options.editorial ?? emptyEditorialSource;
  const preview = options.preview === true;
  const clock = options.now ?? (() => new Date());
  const banners = options.banners ?? emptyBannerSource;
  const countyStructure = options.countyStructure ?? emptyCountyStructure;
  const SECURITY_HEADERS = securityHeaders(options.bannerOrigins ?? []);
  const editorHeaders = options.allowChatGptEditor
    ? securityHeaders(options.bannerOrigins ?? [], true)
    : SECURITY_HEADERS;
  // Only the submission page may load or frame the challenge widget.
  const challengeHeaders =
    options.reportSubmissionsEnabled === true && options.reportChallenge
      ? securityHeaders(options.bannerOrigins ?? [], false, true)
      : null;

  const respond = (
    page: Page,
    head: boolean,
    extra = {},
    headers = SECURITY_HEADERS,
    entry: AccountEntry | null = null,
  ): Response =>
    page.redirect
      ? new Response(null, {
          status: 303,
          headers: {
            ...headers,
            location: page.redirect,
            "cache-control": "no-store",
          },
        })
      : new Response(head ? null : renderDocument(page, preview, entry), {
          status: page.status ?? 200,
          headers: {
            ...headers,
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
            ...extra,
          },
        });

  return {
    async fetch(request: Request): Promise<Response> {
      const head = request.method === "HEAD";
      let entry: AccountEntry | null = null;
      try {
        const url = new URL(request.url);
        if (isStaffReportsPath(url.pathname)) {
          const denied = options.reportReviewAccess
            ? await options.reportReviewAccess(request)
            : 401;
          if (denied !== null) {
            return new Response(
              denied === 401 ? "Authentication required." : "Forbidden.",
              {
                status: denied,
                headers: {
                  ...SECURITY_HEADERS,
                  "cache-control": "no-store, private",
                  "content-type": "text/plain; charset=utf-8",
                },
              },
            );
          }
        }
        if (request.method !== "GET" && !head) {
          return respond(methodNotAllowedPage(), false, { allow: "GET, HEAD" });
        }
        if (
          url.pathname.length > MAX_PATH_LENGTH ||
          url.search.length > MAX_QUERY_LENGTH
        ) {
          return respond(notFoundPage("page"), head);
        }
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return respond(notFoundPage("page"), head);
        }

        if (isReportDirectoryPath(pathname)) {
          if (options.reportSubmissionsEnabled !== true || head)
            return respond(notFoundPage("page"), head);
          const lookup = await reportDirectoryResponse(
            url,
            options.services,
            clock(),
          );
          for (const [name, value] of Object.entries(SECURITY_HEADERS))
            if (!lookup.headers.has(name)) lookup.headers.set(name, value);
          return lookup;
        }

        const asset = ASSET_PATH.exec(pathname);
        if (asset?.[1]) {
          const file = await options.assets.get(asset[1]);
          if (!file) return respond(notFoundPage("page"), head);
          return new Response(head ? null : (file.body as BodyInit), {
            status: 200,
            headers: {
              ...SECURITY_HEADERS,
              "cache-control": "no-cache",
              "content-type": file.contentType,
            },
          });
        }

        const bannerAsset =
          /^\/banner-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
            pathname,
          );
        if (bannerAsset) {
          const versionId = bannerAsset[1];
          if (url.search || !options.bannerDelivery || !versionId) {
            return new Response(null, {
              status: 404,
              headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
            });
          }
          const image = await options.bannerDelivery.deliver(versionId);
          if (!image)
            return new Response(null, {
              status: 404,
              headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
            });
          return new Response(head ? null : image.body, {
            status: 200,
            headers: {
              ...SECURITY_HEADERS,
              "cache-control": "no-store",
              "content-type": image.contentType,
              "content-length": String(image.body.byteLength),
            },
          });
        }

        if (options.accountEntry) {
          try {
            entry = await options.accountEntry(request);
          } catch {
            // The entry only picks a link. A failed check shows sign-in.
            entry = "signed-out";
          }
        }
        const context: SiteContext = {
          services: options.services,
          editorial,
          preview,
          now: clock(),
          banners,
          countyStructure,
          reportSubmissionsEnabled: options.reportSubmissionsEnabled === true,
          reportGuestEnabled:
            options.reportSubmissionsEnabled === true &&
            options.reportGuestEnabled !== false,
          ...(options.reportSubmissionsEnabled === true &&
          options.reportChallenge
            ? { reportChallenge: options.reportChallenge }
            : {}),
        };
        return respond(
          await route(
            context,
            url,
            pathname,
            entry,
            () => options.reportAccountId?.(request) ?? Promise.resolve(null),
          ),
          head,
          isStaffReportsPath(url.pathname) ||
            (pathname.replace(/\/+$/, "") === "/submit-report" &&
              entry === "signed-in")
            ? { "cache-control": "no-store, private" }
            : {},
          PUBLIC_BROWSING_PATH.test(pathname)
            ? editorHeaders
            : challengeHeaders &&
                pathname.replace(/\/+$/, "") === "/submit-report"
              ? challengeHeaders
              : SECURITY_HEADERS,
          entry,
        );
      } catch (error) {
        try {
          return respond(errorToPage(error), head, {}, SECURITY_HEADERS, entry);
        } catch {
          return new Response("Internal error", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      }
    },
  };
}

interface FetchHandler {
  fetch(request: Request): Promise<Response>;
}

/**
 * Composes the JSON application and the public site behind one Fetch handler.
 * `/api/*` and `/_internal/*` keep their existing behavior unchanged.
 */
export function createWebsite(handlers: {
  readonly application: FetchHandler;
  readonly site: FetchHandler;
  readonly reports?: FetchHandler;
}): FetchHandler {
  return {
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (
        handlers.reports &&
        (pathname === "/api/v1/reports" ||
          pathname.startsWith("/api/v1/reports/"))
      ) {
        return handlers.reports.fetch(request);
      }
      return pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname.startsWith("/admin/accounts") ||
        pathname.startsWith("/_internal/") ||
        pathname.startsWith("/internal/")
        ? handlers.application.fetch(request)
        : handlers.site.fetch(request);
    },
  };
}

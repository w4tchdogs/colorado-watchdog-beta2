import {
  emptyState,
  organizationLink,
  organizationTypeBadge,
  pageHeader,
  pager,
  personLink,
  recordId,
  searchForm,
} from "../components.js";
import { html, type SafeHtml, withQuery } from "../html.js";
import { BadRequest, type Page, type SiteContext } from "../types.js";

const PAGE_SIZE = 25;
const MIN_QUERY = 2;
const MAX_QUERY = 100;
const MAX_CURSOR = 512;

interface DirectoryCopy {
  readonly collection: "people" | "organizations";
  readonly title: string;
  readonly intro: string;
  readonly label: string;
  readonly button: string;
}

const COPY: Readonly<Record<"people" | "organizations", DirectoryCopy>> = {
  people: {
    collection: "people",
    title: "People",
    intro:
      "Browse or search people documented in the Website database. The directory does not establish current employment and is not a complete government roster. People with the same name are separate records and are never merged by name.",
    label: "Person name",
    button: "Search people",
  },
  organizations: {
    collection: "organizations",
    title: "Organizations",
    intro:
      "Browse or search documented county governments, offices, departments, divisions, regional organizations and partners. The type shown is the stored record type. It does not by itself make an organization a county department.",
    label: "Organization name",
    button: "Search organizations",
  },
};

async function results(
  context: SiteContext,
  copy: DirectoryCopy,
  query: string,
  cursor: string | null,
) {
  const request = { limit: PAGE_SIZE, cursor: query ? cursor || null : cursor };
  if (copy.collection === "people") {
    const page = query
      ? await context.services.searchPeople({ ...request, query })
      : await context.services.browsePeople(request);
    const repeated = new Set<string>();
    const seen = new Set<string>();
    for (const item of page.items) {
      const key = item.displayName.toLowerCase();
      if (seen.has(key)) repeated.add(key);
      seen.add(key);
    }
    return {
      page,
      rows: page.items.map(
        (item): SafeHtml => html`<li class="record-row">
          <div class="record-main"><span class="record-title">${personLink(item.id, item.displayName)}</span>${recordId(item.id)}</div>
          ${repeated.has(item.displayName.toLowerCase()) ? html`<p class="same-name">Shares a name with another record on this page. They are documented as separate people.</p>` : ""}
        </li>`,
      ),
    };
  }
  const page = query
    ? await context.services.searchOrganizations({ ...request, query })
    : await context.services.browseOrganizations(request);
  return {
    page,
    rows: page.items.map(
      (item): SafeHtml => html`<li class="record-row">
        <div class="record-main"><span class="record-title">${organizationLink(item.id, item.name)}</span>${organizationTypeBadge(item.type)}${recordId(item.id)}</div>
      </li>`,
    ),
  };
}

export async function directoryPage(
  context: SiteContext,
  collection: "people" | "organizations",
  parameters: URLSearchParams,
): Promise<Page> {
  const copy = COPY[collection];
  const base = `/${collection}`;
  const query = (parameters.get("query") ?? "").trim();
  const cursor = parameters.get("cursor");
  const browse = query === "";
  const heading = browse ? `Browse ${collection}` : "Search results";
  const firstHref = withQuery(base, { query: query || null });
  if (
    query.length > MAX_QUERY ||
    (cursor !== null && cursor.length > MAX_CURSOR)
  ) {
    throw new BadRequest(base);
  }

  const form = searchForm({
    action: base,
    id: `${collection}-search`,
    label: copy.label,
    name: "query",
    value: query,
    button: copy.button,
    hint: "Enter at least two characters.",
    minLength: MIN_QUERY,
    maxLength: MAX_QUERY,
  });

  let outcome: SafeHtml;
  if (!browse && query.length < MIN_QUERY) {
    outcome = emptyState(
      "That search is too short",
      "Enter at least two characters so the search can return a bounded set of results.",
    );
  } else {
    let found: Awaited<ReturnType<typeof results>>;
    try {
      found = await results(context, copy, query, cursor);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "DirectorySearchInputError"
      ) {
        throw new BadRequest(firstHref);
      }
      throw error;
    }
    const { page, rows } = found;
    outcome =
      rows.length === 0
        ? emptyState(
            cursor
              ? "No more results"
              : browse
                ? `No ${collection} documented here yet`
                : `No ${collection} match "${query}"`,
            browse
              ? "Listings reflect records documented in the Website database and cover only part of the government roster."
              : "Only names stored in the database are searched, and the database is not a complete roster. A missing name means it has not been documented here.",
            browse && cursor
              ? html`<a class="button button-quiet" href="${firstHref}">Back to first page</a>`
              : html`<a class="button button-quiet" href="/counties">Browse counties</a>`,
          )
        : html`<p class="result-count" role="status">${browse ? `Showing ${rows.length} records from the Website database` : `${cursor ? "More results" : "Results"} for "${query}"`}${page.hasMore ? ", continued on the next page" : ""}.</p>
            <ul class="record-list">${rows}</ul>
            ${pager({
              label: browse ? "Directory pages" : "Result pages",
              firstHref: cursor ? firstHref : null,
              nextHref: page.hasMore
                ? withQuery(base, {
                    query: query || null,
                    cursor: page.nextCursor,
                  })
                : null,
            })}`;
  }

  return {
    title: copy.title,
    description: copy.intro,
    section: collection === "people" ? "officials" : collection,
    breadcrumbs: [{ label: "Home", href: "/" }, { label: copy.title }],
    body: html`${pageHeader(copy.title, copy.intro, undefined, "Statewide directory")}${form}<section class="section results" aria-labelledby="directory-results"><h2 id="directory-results">${heading}</h2>${outcome}</section>`,
  };
}

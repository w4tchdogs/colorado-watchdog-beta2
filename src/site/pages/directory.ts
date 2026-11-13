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
  readonly prompt: string;
}

const COPY: Readonly<Record<"people" | "organizations", DirectoryCopy>> = {
  people: {
    collection: "people",
    title: "People",
    intro:
      "Search the people documented in public roles. Results match stored names only. People with the same name are separate records and are never merged by name.",
    label: "Person name",
    button: "Search people",
    prompt:
      "Enter at least two characters of a name. You can also start from a county to see the people documented there.",
  },
  organizations: {
    collection: "organizations",
    title: "Organizations",
    intro:
      "Search county governments, offices, departments, divisions, regional organizations and partners. The type shown is the stored record type. It does not by itself make an organization a county department.",
    label: "Organization name",
    button: "Search organizations",
    prompt:
      "Enter at least two characters of a name. You can also start from a county to see the organizations documented there.",
  },
};

function results(
  context: SiteContext,
  copy: DirectoryCopy,
  query: string,
  cursor: string | null,
) {
  const request = { query, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) };
  if (copy.collection === "people") {
    const page = context.services.searchPeople(request);
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
  const page = context.services.searchOrganizations(request);
  return {
    page,
    rows: page.items.map(
      (item): SafeHtml => html`<li class="record-row">
        <div class="record-main"><span class="record-title">${organizationLink(item.id, item.name)}</span>${organizationTypeBadge(item.type)}${recordId(item.id)}</div>
      </li>`,
    ),
  };
}

export function directoryPage(
  context: SiteContext,
  collection: "people" | "organizations",
  parameters: URLSearchParams,
): Page {
  const copy = COPY[collection];
  const base = `/${collection}`;
  const query = (parameters.get("query") ?? "").trim();
  const cursor = parameters.get("cursor");
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
  if (query === "") {
    outcome = emptyState(
      `Search ${copy.title.toLowerCase()} by name`,
      copy.prompt,
      html`<a class="button button-quiet" href="/counties">Browse counties</a>`,
    );
  } else if (query.length < MIN_QUERY) {
    outcome = emptyState(
      "That search is too short",
      "Enter at least two characters so the search can return a bounded set of results.",
    );
  } else {
    let found: ReturnType<typeof results>;
    try {
      found = results(context, copy, query, cursor);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "DirectorySearchInputError"
      ) {
        throw new BadRequest(withQuery(base, { query }));
      }
      throw error;
    }
    const { page, rows } = found;
    outcome =
      rows.length === 0
        ? emptyState(
            cursor ? "No more results" : `No ${collection} match "${query}"`,
            "Only names stored in the database are searched, and the database is not a complete roster. A missing name means it has not been documented here.",
            html`<a class="button button-quiet" href="/counties">Browse counties</a>`,
          )
        : html`<p class="result-count" role="status">${cursor ? "More results" : "Results"} for "${query}"${page.hasMore ? ", continued on the next page" : ""}.</p>
            <ul class="record-list">${rows}</ul>
            ${pager({
              label: "Result pages",
              firstHref: cursor ? withQuery(base, { query }) : null,
              nextHref: page.hasMore
                ? withQuery(base, { query, cursor: page.nextCursor })
                : null,
            })}`;
  }

  return {
    title: copy.title,
    description: copy.intro,
    section: collection,
    breadcrumbs: [{ label: "Home", href: "/" }, { label: copy.title }],
    body: html`${pageHeader(copy.title, copy.intro)}${form}<section class="section results" aria-label="Search results">${outcome}</section>`,
  };
}

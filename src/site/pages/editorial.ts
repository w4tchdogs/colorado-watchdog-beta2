import {
  articleTags,
  COMMUNITY_VOICES_HEAD,
  contentTypeNav,
  type EditorialFilters,
  filterArticles,
  filterForm,
  filterOptions,
  hasFilters,
  pathwayCards,
  resultSummary,
} from "../community-voices.js";
import {
  citation,
  countyLink,
  emptyState,
  eyebrow,
  organizationLink,
  pageHeader,
  personLink,
} from "../components.js";
import type {
  ArticleBlock,
  EditorialArticle,
  EditorialType,
} from "../editorial-source.js";
import { formatStoredDate } from "../format.js";
import { html, path, type SafeHtml } from "../html.js";
import { NotFound, type Page, type SiteContext } from "../types.js";

const KINDS = {
  story: {
    plural: "Stories",
    singular: "Story",
    base: "stories",
    heading: "Stories worth hearing.",
    intro:
      "Longer reported pieces about Colorado county government, each linked to the counties, people and organizations it covers and to its sources.",
    empty:
      "No stories have been published. When they are, each one will list its sources and link to the related county, person and organization records.",
  },
  post: {
    plural: "Posts",
    singular: "Post",
    base: "posts",
    heading: "Posts from the record.",
    intro:
      "Shorter updates and notes from the project, with the same source references as longer stories.",
    empty:
      "No posts have been published. Short updates will appear here once publishing is available.",
  },
} as const;

function fictionalFlag(article: EditorialArticle): SafeHtml {
  return article.fictional
    ? html`<span class="fictional-flag">Fictional demonstration</span>`
    : html``;
}

function articleMeta(article: EditorialArticle): SafeHtml {
  return html`<p class="article-meta">
    <span class="article-kind">${KINDS[article.type].singular}</span>
    <time datetime="${article.date}">${formatStoredDate(article.date)}</time>
    <span>${article.byline}</span>
  </p>`;
}

export function articleCard(
  article: EditorialArticle,
  level: 2 | 3 = 3,
  /** Adds explicit pathway, series, topic and county tags (listing pages). */
  withTags = false,
): SafeHtml {
  const link = html`<a href="${path(KINDS[article.type].base, article.slug)}">${article.title}</a>`;
  return html`<article class="article-card article-card-${article.type}">
    ${fictionalFlag(article)}
    ${level === 2 ? html`<h2 class="article-card-title">${link}</h2>` : html`<h3 class="article-card-title">${link}</h3>`}
    <p class="article-summary">${article.summary}</p>
    ${articleMeta(article)}
    ${withTags ? articleTags(article) : ""}
  </article>`;
}

function block(item: ArticleBlock): SafeHtml {
  switch (item.kind) {
    case "heading":
      return html`<h2>${item.text}</h2>`;
    case "quote":
      return html`<blockquote><p>${item.text}</p></blockquote>`;
    case "list":
      return html`<ul>${item.items.map((entry) => html`<li>${entry}</li>`)}</ul>`;
    default:
      return html`<p>${item.text}</p>`;
  }
}

export function editorialListPage(
  context: SiteContext,
  type: EditorialType,
  filters: EditorialFilters = {},
): Page {
  const kind = KINDS[type];
  const base = `/${kind.base}`;
  // Filters apply to the complete public collection, never a displayed subset.
  const all = context.editorial.list(type);
  const matches = filterArticles(all, filters);
  const filtered = hasFilters(filters);
  const summary = resultSummary(
    { plural: kind.plural, singular: kind.singular, base },
    matches.length,
    all.length,
    filtered,
    filters.q,
  );
  const noun = kind.plural.toLowerCase();
  return {
    title: kind.plural,
    description: kind.intro,
    section: kind.base,
    breadcrumbs: [{ label: "Home", href: "/" }, { label: kind.plural }],
    head: COMMUNITY_VOICES_HEAD,
    body: html`${pageHeader(kind.heading, kind.intro, undefined, `Community Voices \u00b7 ${kind.plural}`)}
      ${pathwayCards(base, kind.plural, filters.pathway, filters)}
      <section class="cv-browse" aria-label="Browse ${noun}">
        ${contentTypeNav(type, filters)}
        ${filterForm({ plural: kind.plural, singular: kind.singular, base }, filterOptions(all), filters)}
      </section>
      <section class="cv-results" id="cv-results" aria-labelledby="cv-results-heading">
        <h2 class="visually-hidden" id="cv-results-heading">${kind.plural} results</h2>
        ${summary ? html`<p class="cv-count" role="status">${summary}</p>` : ""}
        ${
          all.length === 0
            ? emptyState(
                `No ${noun} yet`,
                kind.empty,
                html`<a class="button button-quiet" href="/counties">Browse county records</a>`,
                3,
              )
            : matches.length === 0
              ? emptyState(
                  filters.q
                    ? `No ${noun} match your search`
                    : `No ${noun} match these filters`,
                  filters.q
                    ? `No published ${noun} match “${filters.q}” with the selected filters.`
                    : `No ${kind.singular.toLowerCase()} has been given this combination of pathway, county, series and topic. Articles without that classification are never matched to it.`,
                  filters.q
                    ? html`<a class="button button-quiet" href="${base}">Clear search and filters</a>`
                    : html`<a class="button button-quiet" href="${base}">Clear filters</a>`,
                  3,
                )
              : html`<div class="article-list article-list-${type}">${matches.map((article) => articleCard(article, 3, true))}</div>`
        }
      </section>`,
  };
}

export function articlePage(
  context: SiteContext,
  type: EditorialType,
  slug: string,
): Page {
  const kind = KINDS[type];
  const article = /^[a-z0-9-]{1,120}$/.test(slug)
    ? context.editorial.get(type, slug)
    : null;
  if (!article) throw new NotFound(kind.singular.toLowerCase());
  const { counties, people, organizations } = article.related;
  const hasRelated = counties.length + people.length + organizations.length > 0;

  return {
    title: article.title,
    description: article.summary,
    section: kind.base,
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: kind.plural, href: `/${kind.base}` },
      { label: article.title },
    ],
    body: html`<article class="article">
      <header class="article-header">
        ${eyebrow(`Community Voices \u00b7 ${kind.singular}`)}
        ${fictionalFlag(article)}
        <h1>${article.title}</h1>
        <p class="article-standfirst">${article.summary}</p>
        ${articleMeta(article)}
      </header>
      <div class="article-layout">
        <div class="article-body">${article.body.map(block)}</div>
        <aside class="article-aside" aria-label="Related records and sources">
          ${
            hasRelated
              ? html`<section>
                  <h2>Related records</h2>
                  ${counties.length ? html`<h3>Counties</h3><ul>${counties.map((c) => html`<li>${countyLink(c.fips, c.name)}</li>`)}</ul>` : ""}
                  ${people.length ? html`<h3>People</h3><ul>${people.map((p) => html`<li>${personLink(p.id, p.displayName)}</li>`)}</ul>` : ""}
                  ${organizations.length ? html`<h3>Organizations</h3><ul>${organizations.map((o) => html`<li>${organizationLink(o.id, o.name)}</li>`)}</ul>` : ""}
                </section>`
              : ""
          }
          <section>
            <h2>Sources</h2>
            ${
              article.sources.length === 0
                ? html`<p class="quiet">No sources are listed for this piece.</p>`
                : html`<ul class="source-list">${article.sources.map((source) => html`<li>${citation(source)}</li>`)}</ul>`
            }
          </section>
        </aside>
      </div>
    </article>`,
  };
}

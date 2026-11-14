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
): SafeHtml {
  const link = html`<a href="${path(KINDS[article.type].base, article.slug)}">${article.title}</a>`;
  return html`<article class="article-card article-card-${article.type}">
    ${fictionalFlag(article)}
    ${level === 2 ? html`<h2 class="article-card-title">${link}</h2>` : html`<h3 class="article-card-title">${link}</h3>`}
    <p class="article-summary">${article.summary}</p>
    ${articleMeta(article)}
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
): Page {
  const kind = KINDS[type];
  const articles = context.editorial.list(type);
  return {
    title: kind.plural,
    description: kind.intro,
    section: kind.base,
    breadcrumbs: [{ label: "Home", href: "/" }, { label: kind.plural }],
    body: html`${pageHeader(kind.heading, kind.intro, undefined, `Community Voices \u00b7 ${kind.plural}`)}
      <section class="section" aria-label="${kind.plural}">
        ${
          articles.length === 0
            ? emptyState(
                `No ${kind.plural.toLowerCase()} yet`,
                kind.empty,
                html`<a class="button button-quiet" href="/counties">Browse county records</a>`,
              )
            : html`<div class="article-list article-list-${type}">${articles.map((article) => articleCard(article, 2))}</div>`
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

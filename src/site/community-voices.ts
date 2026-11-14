/**
 * Reusable Community Voices presentation: pathway cards, content-type
 * navigation, validated filters and the filter form.
 *
 * Everything here works on the public `EditorialSource` presentation contract
 * only. Pathway, series and topic come exclusively from explicit article
 * metadata. Nothing is inferred from titles, bylines, counties or prose, and
 * no counts are produced except from the articles actually supplied.
 */
import type {
  EditorialArticle,
  EditorialLabel,
  EditorialPathway,
} from "./editorial-source.js";
import { countyTitle, isCountyFips } from "./format.js";
import { html, type SafeHtml, trusted, withQuery } from "./html.js";

/** Stylesheet for these components, loaded through `Page.head`. */
export const COMMUNITY_VOICES_HEAD: SafeHtml = html`<link rel="stylesheet" href="/assets/community-voices.css">`;

export interface PathwayDefinition {
  readonly slug: EditorialPathway;
  readonly number: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
}

/**
 * Labels and wording follow Beta-1's /voices page where Beta-1's text applies
 * to Beta-2. Beta-1 wording that promises features Beta-2 does not have (guest
 * submissions, a publishing cadence) and Beta-1's series title (specific
 * Beta-1 content) are deliberately not carried over.
 */
export const PATHWAYS: readonly PathwayDefinition[] = [
  {
    slug: "local-series",
    number: "01",
    eyebrow: "Local series",
    title: "Local series",
    description:
      "Ongoing reporting that follows one community or issue across installments.",
    action: "Browse local series",
  },
  {
    slug: "guest-voices",
    number: "02",
    eyebrow: "Your perspective",
    title: "Guest Voices",
    description: "Full stories from people navigating county government.",
    action: "Browse guest voices",
  },
  {
    slug: "statewide-issues",
    number: "03",
    eyebrow: "Across Colorado",
    title: "Statewide County Issues",
    description:
      "Room for investigations, county coverage and multi-county roundups.",
    action: "Browse statewide issues",
  },
];

export const FILTER_PARAMETERS = [
  "county",
  "pathway",
  "series",
  "topic",
] as const;

export interface EditorialFilters {
  readonly county?: string;
  readonly pathway?: EditorialPathway;
  readonly series?: string;
  readonly topic?: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 60;

function isSlug(value: string): boolean {
  return value.length <= MAX_SLUG && SLUG.test(value);
}

function isPathway(value: string): value is EditorialPathway {
  return PATHWAYS.some((pathway) => pathway.slug === value);
}

/**
 * Parses already-allowlisted, non-duplicated query parameters. Returns null
 * when any supplied value is malformed. An empty value means "not selected",
 * which is what a no-JavaScript form submits for "All".
 */
export function parseEditorialFilters(
  parameters: URLSearchParams,
): EditorialFilters | null {
  const filters: {
    county?: string;
    pathway?: EditorialPathway;
    series?: string;
    topic?: string;
  } = {};
  const county = parameters.get("county");
  if (county) {
    if (!isCountyFips(county)) return null;
    filters.county = county;
  }
  const pathway = parameters.get("pathway");
  if (pathway) {
    if (!isPathway(pathway)) return null;
    filters.pathway = pathway;
  }
  const series = parameters.get("series");
  if (series) {
    if (!isSlug(series)) return null;
    filters.series = series;
  }
  const topic = parameters.get("topic");
  if (topic) {
    if (!isSlug(topic)) return null;
    filters.topic = topic;
  }
  return filters;
}

export function hasFilters(filters: EditorialFilters): boolean {
  return FILTER_PARAMETERS.some((name) => filters[name] !== undefined);
}

function filterQuery(filters: EditorialFilters): Record<string, string> {
  const query: Record<string, string> = {};
  for (const name of FILTER_PARAMETERS) {
    const value = filters[name];
    if (value !== undefined) query[name] = value;
  }
  return query;
}

function validLabel(entry: EditorialLabel | undefined): EditorialLabel | null {
  return entry && isSlug(entry.slug) && entry.label.trim() !== ""
    ? entry
    : null;
}

export function seriesOf(article: EditorialArticle): EditorialLabel | null {
  return validLabel(article.series);
}

export function topicsOf(article: EditorialArticle): EditorialLabel[] {
  return (article.topics ?? []).flatMap((topic) => validLabel(topic) ?? []);
}

/** Newest first, then slug, so order is identical on every request. */
export function sortArticles(
  articles: readonly EditorialArticle[],
): EditorialArticle[] {
  return [...articles].sort((a, b) =>
    a.date === b.date
      ? a.slug < b.slug
        ? -1
        : a.slug > b.slug
          ? 1
          : 0
      : a.date < b.date
        ? 1
        : -1,
  );
}

/** Filters the complete collection, then orders it. */
export function filterArticles(
  articles: readonly EditorialArticle[],
  filters: EditorialFilters,
): EditorialArticle[] {
  return sortArticles(
    articles.filter(
      (article) =>
        (filters.county === undefined ||
          article.related.counties.some((c) => c.fips === filters.county)) &&
        (filters.pathway === undefined ||
          article.pathway === filters.pathway) &&
        (filters.series === undefined ||
          seriesOf(article)?.slug === filters.series) &&
        (filters.topic === undefined ||
          topicsOf(article).some((topic) => topic.slug === filters.topic)),
    ),
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterOptions {
  readonly counties: readonly FilterOption[];
  readonly series: readonly FilterOption[];
  readonly topics: readonly FilterOption[];
}

function byLabel(a: FilterOption, b: FilterOption): number {
  return a.label.localeCompare(b.label, "en") || a.value.localeCompare(b.value);
}

/** Options come only from metadata present in the complete collection. */
export function filterOptions(
  articles: readonly EditorialArticle[],
): FilterOptions {
  const counties = new Map<string, FilterOption>();
  const series = new Map<string, FilterOption>();
  const topics = new Map<string, FilterOption>();
  for (const article of articles) {
    for (const county of article.related.counties) {
      if (!counties.has(county.fips)) {
        counties.set(county.fips, {
          value: county.fips,
          label: countyTitle(county.name),
        });
      }
    }
    const entry = seriesOf(article);
    if (entry && !series.has(entry.slug)) {
      series.set(entry.slug, { value: entry.slug, label: entry.label });
    }
    for (const topic of topicsOf(article)) {
      if (!topics.has(topic.slug)) {
        topics.set(topic.slug, { value: topic.slug, label: topic.label });
      }
    }
  }
  return {
    counties: [...counties.values()].sort(byLabel),
    series: [...series.values()].sort(byLabel),
    topics: [...topics.values()].sort(byLabel),
  };
}

export interface ListingKind {
  readonly plural: string;
  readonly singular: string;
  readonly base: string;
}

const ARROW = trusted('<span aria-hidden="true">→</span>');
const WRAPPED_ARROW = trusted('<span aria-hidden="true">&nbsp;→</span>');

/**
 * Three pathway cards. Each links to the listing with the pathway filter
 * applied. Cards show no counts: whether a pathway has articles is reported
 * truthfully by the filtered list the card leads to.
 */
export function pathwayCards(
  listingBase: string,
  listingPlural: string,
  active?: EditorialPathway,
): SafeHtml {
  return html`<section class="cv-pathways" aria-labelledby="cv-pathways-heading">
    <h2 class="visually-hidden" id="cv-pathways-heading">Community Voices pathways</h2>
    <ul class="cv-pathway-grid">
      ${PATHWAYS.map(
        (
          pathway,
        ) => html`<li class="cv-pathway${active === pathway.slug ? " cv-pathway-active" : ""}">
          <p class="cv-pathway-eyebrow">${pathway.number} · ${pathway.eyebrow}</p>
          <h3 class="cv-pathway-title">${pathway.title}</h3>
          <p class="cv-pathway-description">${pathway.description}</p>
          <a class="cv-pathway-link" href="${withQuery(listingBase, { pathway: pathway.slug }, "cv-results")}"
            ${active === pathway.slug ? html`aria-current="true"` : ""}>${pathway.action}<span class="visually-hidden"> in ${listingPlural}</span> ${pathway.slug === "statewide-issues" ? WRAPPED_ARROW : ARROW}</a>
        </li>`,
      )}
    </ul>
    <p class="cv-pathway-note">A pathway lists only articles that editors have explicitly assigned to it.</p>
  </section>`;
}

/** Stories and Posts navigation that keeps the current filters. */
export function contentTypeNav(
  current: "story" | "post",
  filters: EditorialFilters,
): SafeHtml {
  const query = filterQuery(filters);
  const entries = [
    { type: "story", label: "Stories", href: "/stories" },
    { type: "post", label: "Posts", href: "/posts" },
  ] as const;
  return html`<nav class="cv-types" aria-label="Content type">
    <ul>
      ${entries.map(
        (entry) =>
          html`<li><a href="${withQuery(entry.href, query)}"${
            entry.type === current ? html` aria-current="page"` : ""
          }>${entry.label}</a></li>`,
      )}
    </ul>
  </nav>`;
}

function selectField(
  name: string,
  label: string,
  allLabel: string,
  unavailableLabel: string,
  options: readonly FilterOption[],
  selected: string | undefined,
): SafeHtml {
  const id = `cv-filter-${name}`;
  // A well-formed value with no matching article stays visible and selected,
  // so the form always reflects the URL.
  const shown =
    selected !== undefined && !options.some((o) => o.value === selected)
      ? [...options, { value: selected, label: selected }]
      : options;
  if (shown.length === 0) {
    return html`<div class="cv-field">
      <label for="${id}">${label}</label>
      <select id="${id}" disabled aria-describedby="${id}-note">
        <option>${allLabel}</option>
      </select>
      <p class="cv-field-note" id="${id}-note">${unavailableLabel}</p>
    </div>`;
  }
  return html`<div class="cv-field">
    <label for="${id}">${label}</label>
    <select id="${id}" name="${name}">
      <option value=""${selected === undefined ? html` selected` : ""}>${allLabel}</option>
      ${shown.map(
        (option) =>
          html`<option value="${option.value}"${option.value === selected ? html` selected` : ""}>${option.label}</option>`,
      )}
    </select>
  </div>`;
}

/**
 * A plain GET form, so filtering works without JavaScript and every result is
 * a shareable URL that survives reload and Back/Forward.
 */
export function filterForm(
  kind: ListingKind,
  options: FilterOptions,
  filters: EditorialFilters,
): SafeHtml {
  const noun = kind.plural.toLowerCase();
  return html`<form class="cv-filters" action="${kind.base}" method="get" aria-labelledby="cv-filters-heading">
    <h2 class="visually-hidden" id="cv-filters-heading">Filter ${noun}</h2>
    <div class="cv-field-grid">
      ${selectField(
        "pathway",
        "Pathway",
        "All pathways",
        "",
        PATHWAYS.map((p) => ({ value: p.slug, label: p.title })),
        filters.pathway,
      )}
      ${selectField(
        "county",
        "County",
        "All counties",
        `No counties are listed on any ${kind.singular.toLowerCase()} yet.`,
        options.counties,
        filters.county,
      )}
      ${selectField(
        "series",
        "Series",
        "All series",
        `No ${kind.singular.toLowerCase()} belongs to a series yet.`,
        options.series,
        filters.series,
      )}
      ${selectField(
        "topic",
        "Topic",
        "All topics",
        `No topics are assigned to ${noun} yet.`,
        options.topics,
        filters.topic,
      )}
    </div>
    <div class="cv-filter-actions">
      <button class="button" type="submit">Filter ${noun}</button>
      <a class="button button-quiet" href="${kind.base}">Clear filters</a>
    </div>
  </form>`;
}

/** Accurate count line. Returns null when there is nothing to count. */
export function resultSummary(
  kind: ListingKind,
  shown: number,
  total: number,
  filtered: boolean,
): string | null {
  if (total === 0) return null;
  const noun = (count: number) =>
    `${count} ${count === 1 ? kind.singular : kind.plural}`.toLowerCase();
  if (!filtered) return `Showing all ${noun(total)}.`;
  return `${shown} of ${noun(total)} ${shown === 1 ? "matches" : "match"} the selected filters.`;
}

/** Explicit metadata only, rendered beneath an article card. */
export function articleTags(article: EditorialArticle): SafeHtml {
  const pathway = PATHWAYS.find((entry) => entry.slug === article.pathway);
  const series = seriesOf(article);
  const topics = topicsOf(article);
  const counties = article.related.counties;
  if (!pathway && !series && topics.length === 0 && counties.length === 0) {
    return html``;
  }
  return html`<ul class="cv-tags" aria-label="Article classification">
    ${pathway ? html`<li class="cv-tag cv-tag-pathway"><span class="visually-hidden">Pathway: </span>${pathway.title}</li>` : ""}
    ${series ? html`<li class="cv-tag"><span class="visually-hidden">Series: </span>${series.label}</li>` : ""}
    ${topics.map((topic) => html`<li class="cv-tag"><span class="visually-hidden">Topic: </span>${topic.label}</li>`)}
    ${counties.map((county) => html`<li class="cv-tag cv-tag-county"><span class="visually-hidden">County: </span>${countyTitle(county.name)}</li>`)}
  </ul>`;
}

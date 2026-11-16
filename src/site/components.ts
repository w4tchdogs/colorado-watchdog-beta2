import {
  countyTitle,
  formatStoredDate,
  organizationTypeClass,
  organizationTypeLabel,
  sourceTypeLabel,
} from "./format.js";
import {
  externalHost,
  html,
  path,
  type SafeHtml,
  safeExternalUrl,
  trusted,
} from "./html.js";

export function eyebrow(text: string): SafeHtml {
  return html`<p class="eyebrow">${text}</p>`;
}

export function pageHeader(
  title: string,
  intro?: SafeHtml | string,
  meta?: SafeHtml,
  eyebrowText?: string,
): SafeHtml {
  return html`<header class="page-header">
    ${eyebrowText ? eyebrow(eyebrowText) : ""}
    <h1>${title}</h1>
    ${meta ? html`<div class="page-meta">${meta}</div>` : ""}
    ${intro ? html`<p class="lede">${intro}</p>` : ""}
  </header>`;
}

export function emptyState(
  title: string,
  detail: SafeHtml | string,
  actions?: SafeHtml,
  /** Heading level, chosen to follow the surrounding section heading. */
  level: 2 | 3 = 2,
): SafeHtml {
  return html`<div class="empty-state">
    ${level === 2 ? html`<h2>${title}</h2>` : html`<h3>${title}</h3>`}
    <p>${detail}</p>
    ${actions ? html`<p class="empty-actions">${actions}</p>` : ""}
  </div>`;
}

export function notice(content: SafeHtml | string): SafeHtml {
  return html`<p class="notice">${content}</p>`;
}

export interface SearchFormOptions {
  readonly action: string;
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly value?: string;
  readonly hint?: string;
  /** Extra attributes for the hint paragraph, for example a live region. */
  readonly hintAttributes?: SafeHtml;
  /** Visually hides the label while keeping it as the accessible name. */
  readonly labelHidden?: boolean;
  readonly placeholder?: string;
  /** Omit for a search that runs as the visitor types. Enter still submits. */
  readonly button?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Extra attributes for progressive enhancement hooks. */
  readonly inputAttributes?: SafeHtml;
}

export function searchForm(options: SearchFormOptions): SafeHtml {
  const hintId = `${options.id}-hint`;
  return html`<form class="search-form" action="${options.action}" method="get" role="search">
    <label for="${options.id}"${options.labelHidden ? trusted(' class="visually-hidden"') : ""}>${options.label}</label>
    <div class="search-row">
      <input id="${options.id}" name="${options.name}" type="search" value="${options.value ?? ""}"
        autocomplete="off" spellcheck="false"
        ${options.placeholder ? html`placeholder="${options.placeholder}"` : ""}
        ${options.minLength ? html`minlength="${options.minLength}" required` : ""}
        maxlength="${options.maxLength ?? 100}"
        ${options.hint ? html`aria-describedby="${hintId}"` : ""}
        ${options.inputAttributes ?? ""}>
      ${options.button ? html`<button class="button" type="submit">${options.button}</button>` : ""}
    </div>
    ${options.hint ? html`<p class="hint" id="${hintId}" ${options.hintAttributes ?? ""}>${options.hint}</p>` : ""}
  </form>`;
}

export interface PagerOptions {
  readonly label: string;
  /** Present when the visitor is past the first page. */
  readonly firstHref: string | null;
  /** Present when another page exists. */
  readonly nextHref: string | null;
}

export function pager(options: PagerOptions): SafeHtml {
  if (!options.firstHref && !options.nextHref) return html``;
  return html`<nav class="pager" aria-label="${options.label}">
    ${options.firstHref ? html`<a class="button button-quiet" href="${options.firstHref}">Back to first page</a>` : ""}
    ${options.nextHref ? html`<a class="button button-quiet" rel="next" href="${options.nextHref}">Next page</a>` : ""}
  </nav>`;
}

export function organizationTypeBadge(type: string): SafeHtml {
  return html`<span class="type-badge type-${organizationTypeClass(type)}">${organizationTypeLabel(type)}</span>`;
}

export function countyLink(fips: string, name: string): SafeHtml {
  return html`<a href="${path("counties", fips)}">${countyTitle(name)}</a>`;
}

export function personLink(id: string, displayName: string): SafeHtml {
  return html`<a href="${path("people", id)}">${displayName}</a>`;
}

export function organizationLink(id: string, name: string): SafeHtml {
  return html`<a href="${path("organizations", id)}">${name}</a>`;
}

export function recordId(id: string): SafeHtml {
  return html`<span class="record-id">Record <code>${id}</code></span>`;
}

export interface RoleDates {
  readonly startDate: string | null;
  readonly endDate: string | null;
}

/**
 * Stored role dates exactly as documented. A missing end date is labelled as
 * not recorded and is never rendered as "present" or "current".
 */
export function roleDates(role: RoleDates): SafeHtml {
  return html`<dl class="role-dates">
    <div><dt>Role start</dt><dd>${role.startDate ? formatStoredDate(role.startDate) : trusted('<span class="unrecorded">Not recorded</span>')}</dd></div>
    <div><dt>Role end</dt><dd>${role.endDate ? formatStoredDate(role.endDate) : trusted('<span class="unrecorded">Not recorded</span>')}</dd></div>
  </dl>`;
}

export interface Citation {
  readonly title: string;
  readonly url: string;
  readonly type?: string;
  /** When the source was last checked. Not an employment date. */
  readonly checkedAt?: string;
}

export function citation(source: Citation): SafeHtml {
  const href = safeExternalUrl(source.url);
  const host = externalHost(source.url);
  return html`<div class="citation">
    <span class="citation-label">Source</span>
    ${
      href
        ? html`<cite><a href="${href}" rel="external noopener noreferrer">${source.title}</a></cite>`
        : html`<cite>${source.title}</cite> <span class="citation-withheld">(link withheld: the stored address is not a web link)</span>`
    }
    <span class="citation-meta">
      ${source.type ? html`<span>${sourceTypeLabel(source.type)}</span>` : ""}
      ${host ? html`<span>${host}</span>` : ""}
      ${source.checkedAt ? html`<span>Source checked ${formatStoredDate(source.checkedAt)}</span>` : ""}
    </span>
  </div>`;
}

export const END_DATE_NOTE =
  "A role with no recorded end date is not confirmed as current. It means only that no end date is stored.";

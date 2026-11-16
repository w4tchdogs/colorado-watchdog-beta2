import {
  countyIndexGrid,
  emptyState,
  pageHeader,
  searchForm,
} from "../components.js";
import { renderCountyMap } from "../county-map.js";
import { countyTitle } from "../format.js";
import { html, path, type SafeHtml, trusted } from "../html.js";
import type { Page, SiteContext } from "../types.js";

/** Aggregate counts for one county. `null` or missing means not available. */
export interface CountyCounts {
  readonly profiles?: number | null;
  readonly reports?: number | null;
  readonly grievances?: number | null;
}

/** A registry entry, optionally carrying aggregate counts for the table. */
export interface CountyDirectoryEntry {
  readonly fips: string;
  readonly name: string;
  readonly counts?: CountyCounts;
}

export type CountySortKey = "county" | "profiles" | "reports" | "grievances";
export type CountySortDirection = "asc" | "desc";

export interface CountySort {
  readonly key: CountySortKey;
  readonly direction: CountySortDirection;
}

const SORT_COLUMNS: readonly { key: CountySortKey; label: string }[] = [
  { key: "county", label: "County" },
  { key: "profiles", label: "Listed Profiles" },
  { key: "reports", label: "Reports" },
  { key: "grievances", label: "Grievances" },
];

export const DEFAULT_COUNTY_SORT: CountySort = {
  key: "county",
  direction: "asc",
};

export function matchesCounty(
  county: { fips: string; name: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    county.name.toLowerCase().includes(needle) ||
    countyTitle(county.name).toLowerCase().includes(needle) ||
    county.fips.includes(needle)
  );
}

const sortName = (name: string) =>
  countyTitle(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const nameThenFips = (
  left: { fips: string; name: string },
  right: { fips: string; name: string },
) =>
  sortName(left.name).localeCompare(sortName(right.name), "en") ||
  left.fips.localeCompare(right.fips);

function countValue(
  county: CountyDirectoryEntry,
  key: Exclude<CountySortKey, "county">,
): number | null {
  const value = county.counts?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Sorts counties for the results table. County sorts alphabetically. Count
 * columns sort numerically with unavailable counts after known values in
 * either direction. Ties fall back to county name, then FIPS, ascending.
 */
export function sortCounties<T extends CountyDirectoryEntry>(
  counties: readonly T[],
  sort: CountySort,
): T[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...counties].sort((left, right) => {
    if (sort.key === "county") return sign * nameThenFips(left, right);
    const a = countValue(left, sort.key);
    const b = countValue(right, sort.key);
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    if (a !== null && b !== null && a !== b) return sign * (a - b);
    return nameThenFips(left, right);
  });
}

/** The map status line for a search. */
export function matchingStatus(count: number): string {
  return `${count} matching ${count === 1 ? "county" : "counties"}`;
}

/** The text beside the search field for a search. */
export function matchNote(count: number): string {
  return `${count} ${count === 1 ? "county matches" : "counties match"}`;
}

export const IDLE_STATUS = "Choose a county";
export const IDLE_NOTE =
  "Type a county name or FIPS code to see matching counties.";

function countCell(value: number | null, label: string): SafeHtml {
  return value === null
    ? html`<td data-label="${label}"><span aria-hidden="true">–</span><span class="visually-hidden">Unavailable</span></td>`
    : html`<td data-label="${label}">${value}</td>`;
}

export async function countiesPage(
  context: SiteContext,
  query: string,
): Promise<Page> {
  const all: readonly CountyDirectoryEntry[] =
    await context.services.listCounties();
  const trimmed = query.trim().slice(0, 40);
  const active = trimmed !== "";
  const shown = new Set(
    active
      ? all
          .filter((county) => matchesCounty(county, trimmed))
          .map((c) => c.fips)
      : [],
  );
  const matchCount = shown.size;
  const hiddenUnless = (visible: boolean) => (visible ? "" : trusted("hidden"));
  const rows = sortCounties(all, DEFAULT_COUNTY_SORT);
  const showResults = matchCount > 0;
  const body = html`<div class="counties-page">
  ${pageHeader(
    "Explore Colorado’s counties",
    "Choose a county on the map or search the directory below. County totals reflect incident locations and can overlap; they do not add up to the statewide total.",
    undefined,
    `${all.length} counties · one statewide record`,
  )}
  ${renderCountyMap(all, shown, undefined, active ? matchingStatus(matchCount) : IDLE_STATUS)}
  ${searchForm({
    action: "/counties",
    id: "county-search",
    label: "Search counties",
    labelHidden: true,
    placeholder: "Search counties",
    name: "q",
    value: trimmed,
    hint: active ? matchNote(matchCount) : IDLE_NOTE,
    hintAttributes: html`data-county-note data-idle-note="${IDLE_NOTE}" role="status" aria-live="polite" aria-atomic="true"`,
    maxLength: 40,
    inputAttributes: trusted("data-county-filter"),
  })}
  <p class="county-browse"><a class="county-browse-all" href="#county-directory">Browse all ${all.length} counties</a></p>
  <div data-county-empty ${active && matchCount === 0 ? "" : trusted("hidden")}>
    ${emptyState(
      "No county matches that search",
      "Check the spelling, or try the five-digit FIPS code. Colorado county FIPS codes start with 08.",
      html`<a class="button button-quiet" href="/counties">Clear the search</a>`,
    )}
  </div>
  <section id="county-results" class="county-results" data-county-results aria-label="Matching counties" ${hiddenUnless(showResults)}>
    <div class="county-mobile-sort" data-sort-select-wrap hidden>
      <label for="county-sort">Sort counties</label>
      <select id="county-sort" data-sort-select>
        ${SORT_COLUMNS.flatMap(({ key, label }) =>
          (["asc", "desc"] as const).map(
            (direction) =>
              html`<option value="${key}:${direction}" ${key === "county" && direction === "asc" ? trusted("selected") : ""}>${label} · ${direction === "asc" ? "ascending" : "descending"}</option>`,
          ),
        )}
      </select>
    </div>
    <table class="county-table" data-county-table>
      <thead>
        <tr>
          ${SORT_COLUMNS.map(
            ({ key, label }) =>
              html`<th scope="col" data-sort-key="${key}">${label}</th>`,
          )}
          <th scope="col"><span class="visually-hidden">Open county</span></th>
        </tr>
      </thead>
      <tbody data-county-rows>
        ${rows.map((county) => {
          const title = countyTitle(county.name);
          const counts = [
            ["profiles", "Listed Profiles"],
            ["reports", "Reports"],
            ["grievances", "Grievances"],
          ] as const;
          return html`<tr data-result-row data-fips="${county.fips}" data-name="${county.name.toLowerCase()} county" data-sort-name="${sortName(county.name)}"
            ${counts.map(([key]) => trusted(`data-${key}="${countValue(county, key) ?? ""}" `))}
            ${hiddenUnless(shown.has(county.fips))}>
            <td data-label="County"><a class="county-name-link" href="${path("counties", county.fips)}">${title}</a><span class="county-fips">FIPS ${county.fips}</span></td>
            ${counts.map(([key, label]) => countCell(countValue(county, key), label))}
            <td class="county-row-end"><span class="county-row-arrow" aria-hidden="true"></span></td>
          </tr>`;
        })}
      </tbody>
    </table>
  </section>
  <section id="county-directory" aria-labelledby="county-directory-title">
    <h2 id="county-directory-title">Search and browse all counties</h2>
    ${countyIndexGrid(all, shown)}
  </section>
</div>`;

  return {
    title: "Colorado counties",
    description:
      "Directory of all 64 Colorado counties with FIPS codes and links to documented organizations and roles.",
    section: "counties",
    breadcrumbs: [{ label: "Home", href: "/" }, { label: "Counties" }],
    body,
  };
}

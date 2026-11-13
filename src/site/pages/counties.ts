import { emptyState, pageHeader, searchForm } from "../components.js";
import { countyTitle } from "../format.js";
import { html, path, trusted } from "../html.js";
import type { Page, SiteContext } from "../types.js";

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

export function countiesPage(context: SiteContext, query: string): Page {
  const all = context.services.listCounties();
  const trimmed = query.trim().slice(0, 40);
  const shown = new Set(
    all.filter((county) => matchesCounty(county, trimmed)).map((c) => c.fips),
  );
  const counties = { length: shown.size };
  const hiddenUnless = (visible: boolean) => (visible ? "" : trusted("hidden"));
  const groups = new Map<string, typeof all>();
  for (const county of all) {
    const letter = county.name.charAt(0).toUpperCase();
    groups.set(letter, [...(groups.get(letter) ?? []), county]);
  }
  const letters = [...groups.keys()];
  const groupShown = (letter: string) =>
    (groups.get(letter) ?? []).some((county) => shown.has(county.fips));

  const body = html`
  ${pageHeader(
    "Colorado counties",
    `All ${all.length} counties from the public county registry, each with its five-digit FIPS code.`,
  )}
  ${searchForm({
    action: "/counties",
    id: "county-search",
    label: "Filter counties",
    name: "q",
    value: trimmed,
    button: "Filter",
    hint: "Type a county name or FIPS code, for example Larimer or 08069.",
    maxLength: 40,
    inputAttributes: trusted("data-county-filter"),
  })}
  <p class="result-count" data-county-count role="status" aria-live="polite">${
    trimmed === ""
      ? `Showing all ${all.length} counties.`
      : `Showing ${counties.length} of ${all.length} counties for "${trimmed}".`
  }</p>
  <div data-county-empty ${counties.length === 0 ? "" : trusted("hidden")}>
    ${emptyState(
      "No county matches that search",
      "Check the spelling, or try the five-digit FIPS code. Colorado county FIPS codes start with 08.",
      html`<a class="button button-quiet" href="/counties">Show all counties</a>`,
    )}
  </div>
  ${
    letters.length > 1
      ? html`<nav class="letter-nav" aria-label="Jump to letter" data-letter-nav><ul>
          ${letters.map((letter) => html`<li ${hiddenUnless(groupShown(letter))}><a href="#letter-${letter}" data-letter-link="${letter}">${letter}</a></li>`)}
        </ul></nav>`
      : ""
  }
  <div class="county-groups">
    ${letters.map(
      (
        letter,
      ) => html`<section class="county-group" data-county-group data-letter="${letter}" aria-labelledby="letter-${letter}" ${hiddenUnless(groupShown(letter))}>
        <h2 id="letter-${letter}" tabindex="-1">${letter}</h2>
        <ul class="county-list">
          ${(groups.get(letter) ?? []).map(
            (
              county,
            ) => html`<li data-county data-name="${county.name.toLowerCase()} county" data-fips="${county.fips}" ${hiddenUnless(shown.has(county.fips))}>
              <a href="${path("counties", county.fips)}">
                <span class="county-name">${countyTitle(county.name)}</span>
                <span class="fips">FIPS ${county.fips}</span>
              </a>
            </li>`,
          )}
        </ul>
      </section>`,
    )}
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

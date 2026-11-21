import { countyTitle } from "./format.js";
import { html, type SafeHtml, trusted, withQuery } from "./html.js";

export type CountyNavItem = "home" | "officials" | "structure" | "voices";

export interface CountyNavOptions {
  readonly counties: readonly { fips: string; name: string }[];
  readonly county: { fips: string; name: string };
  readonly current: CountyNavItem;
  /**
   * Where the county switcher sends the visitor: the county home page, or the
   * same directory view for the chosen county.
   */
  readonly switchTo: "home" | "people" | "structure";
}

export function officialsHref(
  countyFips: string | null,
  view: "people" | "structure" = "people",
): string {
  return withQuery("/officials", {
    directoryView: view === "structure" ? "structure" : null,
    county: countyFips,
  });
}

/**
 * County-level navigation shared by the county page and the county-filtered
 * directory, so statewide and county browsing read as one directory.
 */
export function countyNav(options: CountyNavOptions): SafeHtml {
  const { county, current } = options;
  const title = countyTitle(county.name);
  const link = (item: CountyNavItem, href: string, label: string) =>
    html`<li><a href="${href}"${item === current ? trusted(' aria-current="page"') : ""}>${label}</a></li>`;
  const directory = options.switchTo !== "home";
  return html`<nav class="county-nav" aria-label="${title}">
    <div class="wrap county-nav-inner">
      <a class="county-nav-name" href="/counties/${county.fips}">${title}</a>
      <ul>
        ${link("home", `/counties/${county.fips}`, "County home")}
        ${link("officials", officialsHref(county.fips), "Officials & employees")}
        ${link("voices", withQuery("/stories", { county: county.fips }), "Community Voices")}
      </ul>
      <form class="county-switch" action="${directory ? "/officials" : "/counties"}" method="get">
        ${options.switchTo === "structure" ? trusted('<input type="hidden" name="directoryView" value="structure">') : ""}
        <label class="visually-hidden" for="county-switch">Switch county</label>
        <select id="county-switch" name="county">
          ${options.counties.map(
            (entry) =>
              html`<option value="${entry.fips}"${entry.fips === county.fips ? trusted(" selected") : ""}>${countyTitle(entry.name)}</option>`,
          )}
        </select>
        <button class="button button-quiet button-small" type="submit">Go</button>
      </form>
      <a class="county-nav-all" href="/counties">All counties</a>
    </div>
  </nav>`;
}

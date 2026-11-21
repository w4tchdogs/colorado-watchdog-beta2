import { bannerHero } from "../banner.js";
import { countyNav, officialsHref } from "../county-nav.js";
import { countyTitle, isCountyFips, isStableId } from "../format.js";
import { html, path } from "../html.js";
import { BadRequest, NotFound, type Page, type SiteContext } from "../types.js";
import { countyStructureSection } from "./county-structure-section.js";
import { available } from "./home.js";

export async function countyPage(
  context: SiteContext,
  countyFips: string,
  parameters: URLSearchParams,
): Promise<Page> {
  if (!isCountyFips(countyFips)) throw new NotFound("county");
  const counties = await context.services.listCounties();
  const county = counties.find(({ fips }) => fips === countyFips);
  if (!county) throw new NotFound("county");

  const base = path("counties", countyFips);
  // Keep bookmarks to the former lists working as county home links.
  if ([...parameters.values()].some((value) => !isStableId(value)))
    throw new BadRequest(base);

  const title = countyTitle(county.name);
  const lead = bannerHero({
    variant: "county",
    banners: await context.banners.forCounty(countyFips),
    countyFips,
    eyebrow: `Colorado Watchdog \u00b7 ${title}`,
    title,
    lede: "County government. Community experiences. One lasting record.",
    actions: html`<a class="button" href="${officialsHref(countyFips)}">Find an official &#8599;</a> <a class="button button-light" href="/submit-report">Submit a report &#8599;</a>`,
  });

  const subnav = countyNav({
    counties,
    county,
    current: "home",
    switchTo: "home",
  });

  const [structure, units, people] = await Promise.all([
    available(() => context.countyStructure.getCountyStructure(countyFips)),
    available(() => context.countyStructure.countPublicUnits(countyFips)),
    available(() => context.services.countPublicPeople(countyFips)),
  ]);

  const body = html`
  <section class="section" aria-labelledby="overview-heading">
    <h2 id="overview-heading">Overview</h2>
    <dl class="stat-row county-stat-row">
      <div><dt>Departments and offices</dt><dd>${units?.toLocaleString("en-US") ?? "—"}</dd>${units === null ? html`<span class="stat-status">Unavailable</span>` : ""}</div>
      <div><dt>County officials and employees</dt><dd>${people?.toLocaleString("en-US") ?? "—"}</dd>${people === null ? html`<span class="stat-status">Unavailable</span>` : ""}</div>
      ${["Reports", "Grievances"].map((label) => html`<div><dt>${label}</dt><dd aria-label="Pending">—</dd><span class="stat-status">Pending</span></div>`)}
    </dl>
    <p class="stat-note">Each public unit and eligible Profile is counted once in this county. County directory eligibility does not require a unit attachment. Counts may overlap with other counties. Report and grievance totals are pending.</p>
  </section>

  <section class="section county-entry-section" aria-labelledby="county-explore-heading">
    <p class="eyebrow">Explore ${title}</p>
    <h2 id="county-explore-heading">Find the office. Find the official.</h2>
    ${people === 0 ? html`<p>No officials or employees are currently listed for this county.</p>` : ""}
    <div class="county-entry-grid">
      <a class="county-entry-card" href="${officialsHref(countyFips)}">
        <h3>Officials &amp; employees</h3>
        <p>Search the county directory and open permanent statewide profiles.</p>
        <span>Explore directory &#8599;</span>
      </a>
      <a class="county-entry-card" href="${base}#structure">
        <h3>County structure</h3>
        <p>${units === null ? "County structure is temporarily unavailable." : units === 0 ? "No office structure has been recorded for this county." : "Explore the departments, offices and other public units recorded for this county."}</p>
        <span>Explore county offices &#8599;</span>
      </a>
    </div>
  </section>

  ${structure ? countyStructureSection(title, structure) : html`<p class="notice">County structure is temporarily unavailable.</p>`}`;

  return {
    title,
    description: `County structure and officials directory for ${title}, Colorado (FIPS ${countyFips}).`,
    section: "counties",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: "Counties", href: "/counties" },
      { label: title },
    ],
    subnav,
    lead,
    body,
  };
}

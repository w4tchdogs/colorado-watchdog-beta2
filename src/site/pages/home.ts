import { searchForm } from "../components.js";
import { countyTitle, plural } from "../format.js";
import { html, path, type SafeHtml } from "../html.js";
import type { Page, SiteContext } from "../types.js";
import { articleCard } from "./editorial.js";

const FEATURED_COUNT = 6;

/** A deterministic daily rotation through the registry; it ranks nothing. */
function featuredCounties<T>(counties: readonly T[], now: Date): readonly T[] {
  if (counties.length === 0) return [];
  const day = Math.floor(now.getTime() / 86_400_000);
  const step = Math.max(1, Math.floor(counties.length / FEATURED_COUNT));
  const picked: T[] = [];
  for (
    let index = 0;
    index < Math.min(FEATURED_COUNT, counties.length);
    index += 1
  ) {
    const county = counties[(day + index * step) % counties.length];
    if (county !== undefined) picked.push(county);
  }
  return picked;
}

function countyIndex(
  counties: readonly { fips: string; name: string }[],
): SafeHtml {
  return html`<nav class="county-index" aria-label="County index">
    <ol class="county-index-grid">
      ${counties.map(
        (county) =>
          html`<li><a href="${path("counties", county.fips)}" title="${countyTitle(county.name)}, FIPS ${county.fips}">
            <span class="cell-code" aria-hidden="true">${county.fips.slice(2)}</span>
            <span class="cell-name">${county.name}<span class="visually-hidden"> County, FIPS ${county.fips}</span></span>
          </a></li>`,
      )}
    </ol>
    <p class="county-index-caption">All ${counties.length} counties in alphabetical order with their FIPS codes. This index is not a map.</p>
  </nav>`;
}

export function homePage(context: SiteContext): Page {
  const counties = context.services.listCounties();
  const featured = featuredCounties(counties, context.now).map((county) => ({
    county,
    overview: context.services.getCountyOverview({ countyFips: county.fips }),
  }));
  const stories = context.editorial.list("story").slice(0, 2);
  const posts = context.editorial.list("post").slice(0, 3);

  const lead = html`<section class="hero">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <h1>Who holds public office in Colorado's 64 counties, and where that is written down.</h1>
        <p>Colorado Watchdog documents county organizations, positions and the people recorded in them. Every role links to the public source it came from and the date that source was checked.</p>
        ${searchForm({
          action: "/counties",
          id: "hero-county",
          label: "Find a county",
          name: "q",
          button: "Find county",
          hint: "Search by county name or five-digit FIPS code.",
          maxLength: 40,
        })}
        <p class="hero-links"><a href="/counties">Browse all counties</a> <a href="/reading-records">How to read these records</a></p>
      </div>
      ${countyIndex(counties)}
    </div>
  </section>`;

  const body = html`
  <section class="section" aria-labelledby="discover-heading">
    <h2 id="discover-heading">Look up a person or an organization</h2>
    <p class="section-intro">Search matches stored names only. People who share a name stay separate records, because a matching name is not proof of the same person.</p>
    <div class="split">
      ${searchForm({
        action: "/people",
        id: "home-people",
        label: "Person name",
        name: "query",
        button: "Search people",
        hint: "Enter at least two characters.",
        minLength: 2,
      })}
      ${searchForm({
        action: "/organizations",
        id: "home-organizations",
        label: "Organization name",
        name: "query",
        button: "Search organizations",
        hint: "Enter at least two characters.",
        minLength: 2,
      })}
    </div>
  </section>

  <section class="section" aria-labelledby="featured-heading">
    <div class="section-heading">
      <h2 id="featured-heading">Start with a county</h2>
      <a href="/counties">All 64 counties</a>
    </div>
    <p class="section-intro">A changing selection from the county registry. Counts describe records in this site's database. They do not measure staffing or completeness.</p>
    <ul class="county-cards">
      ${featured.map(({ county, overview }) => {
        const total = overview?.organizationCounts.total ?? 0;
        const roles = overview?.documentedRoleCount ?? 0;
        return html`<li class="county-card">
          <a class="county-card-link" href="${path("counties", county.fips)}">${countyTitle(county.name)}</a>
          <span class="fips">FIPS ${county.fips}</span>
          <span class="county-card-counts">${
            total === 0 && roles === 0
              ? "No records in the database yet"
              : `${plural(total, "organization", "organizations")}, ${plural(roles, "documented role", "documented roles")}`
          }</span>
        </li>`;
      })}
    </ul>
  </section>

  <section class="section" aria-labelledby="reporting-heading">
    <div class="section-heading">
      <h2 id="reporting-heading">Stories and Posts</h2>
      <span><a href="/stories">Stories</a> <a href="/posts">Posts</a></span>
    </div>
    ${
      stories.length + posts.length === 0
        ? html`<div class="empty-state">
            <h3>Nothing has been published yet</h3>
            <p>Stories are longer reported pieces. Posts are shorter updates. Both will appear here, linked to the counties, people and organizations they cover.</p>
          </div>`
        : html`<div class="editorial-grid">
            <div class="editorial-stories">${stories.map((article) => articleCard(article))}</div>
            <div class="editorial-posts">${posts.map((article) => articleCard(article))}</div>
          </div>`
    }
  </section>

  <section class="section principles" aria-labelledby="evidence-heading">
    <h2 id="evidence-heading">How records are documented</h2>
    <div class="principle-grid">
      <div>
        <h3>Every role has a public source</h3>
        <p>A role is listed only when a public source ties a person's name to a position. The citation and the date it was checked appear beside the role.</p>
      </div>
      <div>
        <h3>Dates mean what they say</h3>
        <p>The date a source was checked is not a start date. A role without an end date is not confirmed as current.</p>
      </div>
      <div>
        <h3>Missing does not mean vacant</h3>
        <p>The database is not a complete roster. A position or person that is not listed has not been documented here, and nothing more.</p>
      </div>
    </div>
    <p><a href="/reading-records">Read the full guide to citations and documented roles</a></p>
  </section>`;

  return {
    title: "Colorado Watchdog",
    description:
      "Public, source-cited records of Colorado county organizations, positions and the people documented in them.",
    lead,
    body,
  };
}

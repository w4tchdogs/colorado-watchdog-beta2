import { bannerHero } from "../banner.js";
import { eyebrow, searchForm } from "../components.js";
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
            <span class="cell-name">${county.name}<span class="visually-hidden"> County, FIPS ${county.fips}</span></span>
            <span class="cell-code" aria-hidden="true">${county.fips}</span>
          </a></li>`,
      )}
    </ol>
    <p class="county-index-caption">All ${counties.length} counties in alphabetical order with their FIPS codes. This index is not a map.</p>
  </nav>`;
}

export async function homePage(context: SiteContext): Promise<Page> {
  const counties = await context.services.listCounties();
  const featured = await Promise.all(
    featuredCounties(counties, context.now).map(async (county) => ({
      county,
      overview: await context.services.getCountyOverview({
        countyFips: county.fips,
      }),
    })),
  );
  const stories = context.editorial.list("story").slice(0, 2);
  const posts = context.editorial.list("post").slice(0, 3);

  const lead = bannerHero({
    variant: "home",
    banners: context.banners.forHome(),
    countyFips: null,
    eyebrow: "Colorado · Independent & community-run",
    title: "Community Voices. Government Accountability.",
    lede: "A statewide record of county government, the people who serve, and the experiences of the communities they serve.",
    actions: html`<a class="button" href="/counties">Explore the counties</a> <a class="button button-light" href="/reading-records">How to read the records</a>`,
  });

  const body = html`
  <section class="section section-first" aria-labelledby="discover-heading">
    ${eyebrow("Find the county. Find the record.")}
    <h2 id="discover-heading">Accountability starts locally.</h2>
    <div class="feature-grid">
      <div class="card feature-card">
        <h3>Explore the counties</h3>
        <p>Start with a county government. Browse its organizations, affiliated bodies and documented roles.</p>
        ${searchForm({
          action: "/counties",
          id: "home-county",
          label: "County name or FIPS code",
          name: "q",
          button: "Find county",
          maxLength: 40,
        })}
      </div>
      <div class="card feature-card">
        <h3>Find a person</h3>
        <p>Search people documented in public roles. Records that share a name stay separate.</p>
        ${searchForm({
          action: "/people",
          id: "home-people",
          label: "Person name",
          name: "query",
          button: "Search people",
          hint: "Enter at least two characters.",
          minLength: 2,
        })}
      </div>
      <div class="card feature-card">
        <h3>Find an organization</h3>
        <p>Search county governments, offices, departments, regional bodies and partners.</p>
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
    </div>
  </section>

  <section class="section" aria-labelledby="index-heading">
    ${eyebrow("64 counties · one statewide record")}
    <div class="section-heading">
      <h2 id="index-heading">Explore Colorado's counties</h2>
      <a class="text-link" href="/counties">Open the county directory</a>
    </div>
    ${countyIndex(counties)}
    <h3 class="subhead">Start with a county</h3>
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
    ${eyebrow("Community Voices")}
    <div class="section-heading">
      <h2 id="reporting-heading">Stories worth hearing.</h2>
      <span><a class="text-link" href="/stories">All Stories</a> <a class="text-link" href="/posts">All Posts</a></span>
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
    <div class="principles-intro">
      <div>
        ${eyebrow("Public records, cited sources")}
        <h2 id="evidence-heading">A record, with context.</h2>
        <p class="section-intro">The directory holds what public sources stated when they were checked. Coverage is growing. It is not a complete roster and not a government service.</p>
      </div>
      <img class="mascot" src="/assets/brand-mascot-standing.png" alt="" width="210" height="214">
    </div>
    <div class="principle-grid">
      <div class="card">
        <h3>Every role has a public source</h3>
        <p>A role is listed only when a public source ties a person's name to a position. The citation and the date it was checked appear beside the role.</p>
      </div>
      <div class="card">
        <h3>Dates mean what they say</h3>
        <p>The date a source was checked is not a start date. A role without an end date is not confirmed as current.</p>
      </div>
      <div class="card">
        <h3>Missing does not mean vacant</h3>
        <p>A position or person that is not listed has not been documented here, and nothing more.</p>
      </div>
    </div>
    <p><a class="button button-quiet" href="/reading-records">Read the guide to citations and documented roles</a></p>
  </section>`;

  return {
    title: "Colorado Watchdog",
    description:
      "Community Voices. Government Accountability. Public, source-cited records of Colorado county organizations, positions and the people documented in them.",
    lead,
    body,
  };
}

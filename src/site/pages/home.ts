import { bannerHero } from "../banner.js";
import { COMMUNITY_VOICES_HEAD, pathwayCards } from "../community-voices.js";
import { eyebrow } from "../components.js";
import { html } from "../html.js";
import type { Page, SiteContext } from "../types.js";
import { articleCard } from "./editorial.js";

const discoveryCards = [
  {
    href: "/counties",
    title: "Explore the counties",
    description:
      "Start with a county government. Browse its organizations, affiliated bodies and documented roles.",
    icon: html`<path d="M18 8c0 3.5-6 9-6 9s-6-5.5-6-9a6 6 0 0 1 12 0Z"/><circle cx="12" cy="8" r="2"/><path d="M8 14H5l-3 8h20l-3-8h-3"/>`,
  },
  {
    href: "/officials",
    title: "Find an official",
    description:
      "Search documented officials and employees by name, title or department.",
    icon: html`<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M16 3a4 4 0 0 1 0 8m6 10v-2a4 4 0 0 0-3-4"/>`,
  },
  {
    href: "/organizations",
    title: "Find an organization",
    description:
      "Search county governments, offices, departments, regional bodies and partners.",
    icon: html`<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4m-7 4v-4h14v4"/>`,
  },
  {
    href: "/stories",
    title: "Community Voices",
    description:
      "Read stories about Colorado counties and the experiences of people who live there.",
    icon: html`<path d="M12 5v16M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3z"/>`,
  },
] as const;

export async function homePage(context: SiteContext): Promise<Page> {
  const previews = async (type: "story" | "post", limit: number) =>
    context.editorial.previews
      ? context.editorial.previews(type, limit)
      : (await context.editorial.list(type)).slice(0, limit);
  const [stories, posts] = await Promise.all([
    previews("story", 2),
    previews("post", 3),
  ]);

  const lead = bannerHero({
    variant: "home",
    banners: await context.banners.forHome(),
    countyFips: null,
    eyebrow: "Colorado · Independent & community-run",
    title: "Community Voices. Government Accountability.",
    lede: "A statewide record of county government, the people who serve, and the experiences of the communities they serve.",
    actions: html`<a class="button" href="/counties">Explore the counties</a> <a class="button button-light" href="/reading-records">How to read the records</a>`,
  });

  const body = html`
  <section class="section section-first home-discovery" aria-labelledby="discover-heading">
    ${eyebrow("Find the county. Find the record.")}
    <h2 id="discover-heading">Accountability starts locally.</h2>
    <div class="discovery-grid">
      ${discoveryCards.map(
        ({
          href,
          title,
          description,
          icon,
        }) => html`<a class="discovery-card" href="${href}">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
          <h3>${title}</h3>
          <p>${description}</p>
          <span class="discovery-card-action" aria-hidden="true">Explore <span>↗</span></span>
        </a>`,
      )}
    </div>
  </section>

  <section class="section" aria-labelledby="reporting-heading">
    ${eyebrow("Community Voices")}
    <div class="section-heading">
      <h2 id="reporting-heading">Stories worth hearing.</h2>
      <span><a class="text-link" href="/stories">All Stories</a> <a class="text-link" href="/posts">All Posts</a></span>
    </div>
    ${pathwayCards("/stories", "Stories")}
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
    isHomePage: true,
    head: COMMUNITY_VOICES_HEAD,
    description:
      "Community Voices. Government Accountability. Public, source-cited records of Colorado county organizations, positions and the people documented in them.",
    lead,
    body,
  };
}

import type {
  CountyOrganization,
  CountyRoleEntry,
} from "../../contracts/directory.js";
import { bannerHero } from "../banner.js";
import {
  END_DATE_NOTE,
  emptyState,
  organizationLink,
  organizationTypeBadge,
  pager,
  personLink,
  roleDates,
} from "../components.js";
import { countyNav, officialsHref } from "../county-nav.js";
import {
  affiliationVerb,
  countyTitle,
  isCountyFips,
  isStableId,
  parentRelationshipLabel,
} from "../format.js";
import { html, path, type SafeHtml, withQuery } from "../html.js";
import { BadRequest, NotFound, type Page, type SiteContext } from "../types.js";
import { countyStructureSection } from "./county-structure-section.js";
import { available } from "./home.js";

const ORGANIZATION_PAGE_SIZE = 50;
const ROLE_PAGE_SIZE = 25;

function organizationRow(
  organization: CountyOrganization,
  county: string,
  names: ReadonlyMap<string, string>,
): SafeHtml {
  const parentName = organization.parentOrganizationId
    ? names.get(organization.parentOrganizationId)
    : undefined;
  return html`<li class="record-row">
    <div class="record-main">
      <span class="record-title">${organizationLink(organization.id, organization.name)}</span>
      ${organizationTypeBadge(organization.type)}
    </div>
    <ul class="record-facts">
      ${
        organization.parentOrganizationId
          ? html`<li>${parentRelationshipLabel(organization.parentRelationship)} ${organizationLink(
              organization.parentOrganizationId,
              parentName ?? "its parent organization",
            )}</li>`
          : ""
      }
      ${organization.countyAssociation.affiliations.map(
        (type) => html`<li>${affiliationVerb(type)} ${county}</li>`,
      )}
    </ul>
  </li>`;
}

function roleRow(entry: CountyRoleEntry): SafeHtml {
  const { position, organization, role } = entry;
  const title = position?.title ?? role.publishedTitle;
  return html`<li class="role-entry">
    <div class="role-head">
      <h3>${personLink(entry.person.id, entry.person.displayName)}</h3>
      ${
        title || organization
          ? html`<p class="role-position">${title ?? ""}${title && organization ? ", " : ""}${organization ? organizationLink(organization.id, organization.name) : ""}
        ${organization ? organizationTypeBadge(organization.type) : ""}
        ${
          organization && !organization.countyAssociation.direct
            ? html`<span class="affiliated-flag">Affiliated organization, not a county department</span>`
            : ""
        }
      </p>`
          : ""
      }
    </div>
    ${role.publishedOffice ? html`<p class="role-office"><span class="quiet">Office as published:</span> ${role.publishedOffice}</p>` : ""}
    ${role.jobDescription ? html`<p class="role-duties"><span class="quiet">Duties as published:</span> ${role.jobDescription}</p>` : ""}
    ${roleDates(role)}
  </li>`;
}

export async function countyPage(
  context: SiteContext,
  countyFips: string,
  parameters: URLSearchParams,
): Promise<Page> {
  if (!isCountyFips(countyFips)) throw new NotFound("county");
  const overview = await context.services.getCountyOverview({ countyFips });
  if (!overview) throw new NotFound("county");

  const base = path("counties", countyFips);
  const orgAfter = parameters.get("orgAfter");
  const roleAfter = parameters.get("roleAfter");
  if (
    (orgAfter !== null && !isStableId(orgAfter)) ||
    (roleAfter !== null && !isStableId(roleAfter))
  ) {
    throw new BadRequest(base);
  }

  const organizations = await context.services.listCountyOrganizations({
    countyFips,
    limit: ORGANIZATION_PAGE_SIZE,
    afterId: orgAfter,
  });
  const roles = await context.services.listCountyRoleEntries({
    countyFips,
    limit: ROLE_PAGE_SIZE,
    afterId: roleAfter,
  });

  const title = countyTitle(overview.county.name);
  const names = new Map(organizations.items.map((o) => [o.id, o.name]));
  const direct = organizations.items.filter((o) => o.countyAssociation.direct);
  const affiliated = organizations.items.filter(
    (o) => !o.countyAssociation.direct,
  );
  const counts = overview.organizationCounts;
  const empty = counts.total === 0 && overview.documentedRoleCount === 0;

  const organizationPager = pager({
    label: "Organization pages",
    firstHref: orgAfter
      ? withQuery(base, { roleAfter }, "organizations")
      : null,
    nextHref: organizations.hasMore
      ? withQuery(
          base,
          { orgAfter: organizations.nextCursor, roleAfter },
          "organizations",
        )
      : null,
  });
  const rolePager = pager({
    label: "Role pages",
    firstHref: roleAfter ? withQuery(base, { orgAfter }, "roles") : null,
    nextHref: roles.hasMore
      ? withQuery(base, { orgAfter, roleAfter: roles.nextCursor }, "roles")
      : null,
  });

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
    counties: await context.services.listCounties(),
    county: overview.county,
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

  ${structure ? countyStructureSection(title, structure) : html`<p class="notice">County structure is temporarily unavailable.</p>`}

  ${
    empty
      ? ""
      : html`
  <section class="section" id="organizations" aria-labelledby="organizations-heading">
    <h2 id="organizations-heading">Organizations</h2>
    <h3 class="subhead">County organizations</h3>
    <p class="section-intro">Organizations recorded as part of ${title} itself.</p>
    ${
      direct.length === 0
        ? html`<p class="quiet">${orgAfter || organizations.hasMore ? "None on this page." : "None documented."}</p>`
        : html`<ul class="record-list">${direct.map((o) => organizationRow(o, title, names))}</ul>`
    }
    <h3 class="subhead">Affiliated regional and partner organizations</h3>
    <p class="section-intro">Organizations with a documented relationship to ${title}. They are not county departments, and an affiliation does not imply that they report to the county.</p>
    ${
      affiliated.length === 0
        ? html`<p class="quiet">${orgAfter || organizations.hasMore ? "None on this page." : "None documented."}</p>`
        : html`<ul class="record-list affiliated">${affiliated.map((o) => organizationRow(o, title, names))}</ul>`
    }
    ${organizationPager}
  </section>

  <section class="section" id="roles" aria-labelledby="roles-heading">
    <h2 id="roles-heading">Documented roles and people</h2>
    <p class="section-intro">Each entry is one role record backed by a public source. ${END_DATE_NOTE}</p>
    ${
      roles.items.length === 0
        ? emptyState(
            roleAfter ? "No more role records" : "No documented roles yet",
            "Organizations are recorded for this county, but no person has been documented in a role. This does not indicate a vacancy.",
            undefined,
            3,
          )
        : html`<ol class="role-list">${roles.items.map(roleRow)}</ol>`
    }
    ${rolePager}
  </section>`
  }`;

  return {
    title,
    description: `Documented organizations and roles for ${title}, Colorado (FIPS ${overview.county.fips}).`,
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

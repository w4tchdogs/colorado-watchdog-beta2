import type {
  CountyOrganization,
  CountyRoleEntry,
} from "../../contracts/directory.js";
import { bannerHero } from "../banner.js";
import {
  citation,
  END_DATE_NOTE,
  emptyState,
  notice,
  organizationLink,
  organizationTypeBadge,
  pager,
  personLink,
  roleDates,
} from "../components.js";
import {
  affiliationVerb,
  countyTitle,
  isCountyFips,
  isStableId,
  parentRelationshipLabel,
} from "../format.js";
import { html, path, type SafeHtml, trusted, withQuery } from "../html.js";
import { BadRequest, NotFound, type Page, type SiteContext } from "../types.js";

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
  return html`<li class="role-entry">
    <div class="role-head">
      <h3>${personLink(entry.person.id, entry.person.displayName)}</h3>
      <p class="role-position">${entry.position.title}, ${organizationLink(entry.organization.id, entry.organization.name)}
        ${organizationTypeBadge(entry.organization.type)}
        ${
          entry.organization.countyAssociation.direct
            ? ""
            : html`<span class="affiliated-flag">Affiliated organization, not a county department</span>`
        }
      </p>
    </div>
    ${roleDates(entry.role)}
    ${citation({ ...entry.source, checkedAt: entry.role.sourceCheckedAt })}
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
    banners: context.banners.forCounty(countyFips),
    countyFips,
    eyebrow: `Colorado Watchdog \u00b7 ${title}`,
    title,
    meta: html`<span class="fips">FIPS ${overview.county.fips}</span> <span>Colorado</span>`,
    lede: "County organizations, affiliated bodies and documented public roles, with sources.",
  });

  const subnav = html`<nav class="county-nav" aria-label="${title}">
    <div class="wrap county-nav-inner">
      <span class="county-nav-name">${title}</span>
      <ul>
        <li><a href="#main" aria-current="true">County home</a></li>
        ${empty ? "" : html`<li><a href="#organizations">Organizations</a></li><li><a href="#roles">Roles and people</a></li>`}
      </ul>
      <form class="county-switch" action="/counties" method="get">
        <label class="visually-hidden" for="county-switch">Switch county</label>
        <select id="county-switch" name="county">
          ${(await context.services.listCounties()).map(
            (county) =>
              html`<option value="${county.fips}"${county.fips === countyFips ? trusted(" selected") : ""}>${countyTitle(county.name)}</option>`,
          )}
        </select>
        <button class="button button-quiet button-small" type="submit">Go</button>
      </form>
      <a class="county-nav-all" href="/counties">All counties</a>
    </div>
  </nav>`;

  const body = html`
  <section class="section" aria-labelledby="overview-heading">
    <h2 id="overview-heading">Overview</h2>
    ${
      empty
        ? emptyState(
            `No records for ${title} yet`,
            "No organizations or roles have been documented for this county in the database. That reflects the state of this project's research, not the county's government.",
            html`<a class="button button-quiet" href="/counties">Browse other counties</a>`,
            3,
          )
        : html`<dl class="stat-row">
            <div><dt>Organizations in the database</dt><dd>${counts.total}</dd></div>
            <div><dt>County organizations</dt><dd>${counts.direct}</dd></div>
            <div><dt>Affiliated organizations</dt><dd>${counts.affiliated}</dd></div>
            <div><dt>Documented role records</dt><dd>${overview.documentedRoleCount}</dd></div>
          </dl>
          ${notice("These counts describe records in this database. They do not measure staffing, completeness, vacancies or current employment. An organization recorded both as a county organization and as an affiliate is counted in both groups and once in the total.")}`
    }
  </section>

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

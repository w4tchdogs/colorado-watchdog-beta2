import type { PersonProfileRole } from "../../contracts/person-profile.js";
import {
  citation,
  countyLink,
  END_DATE_NOTE,
  emptyState,
  notice,
  organizationLink,
  organizationTypeBadge,
  pager,
  recordId,
  roleDates,
} from "../components.js";
import { affiliationVerb, isStableId } from "../format.js";
import { html, path, type SafeHtml, withQuery } from "../html.js";
import { BadRequest, NotFound, type Page, type SiteContext } from "../types.js";

const PAGE_SIZE = 25;

export function countyAssociations(
  counties: PersonProfileRole["organization"]["counties"],
): SafeHtml {
  if (counties.length === 0) {
    return html`<p class="quiet">No county association is recorded for this organization.</p>`;
  }
  return html`<ul class="association-list">
    ${counties.map(
      (county) => html`
        ${county.direct ? html`<li><span class="association direct">County organization of</span> ${countyLink(county.fips, county.name)}</li>` : ""}
        ${county.affiliations.map(
          (affiliation) =>
            html`<li><span class="association affiliated">${affiliationVerb(affiliation.relationshipType)}</span> ${countyLink(county.fips, county.name)} <span class="quiet">(affiliation, not a county department)</span></li>`,
        )}`,
    )}
  </ul>`;
}

function roleCard(entry: PersonProfileRole): SafeHtml {
  return html`<li class="role-entry">
    <div class="role-head">
      <h3>${entry.position.title}</h3>
      <p class="role-position">${organizationLink(entry.organization.id, entry.organization.name)} ${organizationTypeBadge(entry.organization.type)}</p>
    </div>
    ${countyAssociations(entry.organization.counties)}
    ${roleDates(entry.role)}
    ${citation({ ...entry.source, checkedAt: entry.role.sourceCheckedAt })}
  </li>`;
}

export function personPage(
  context: SiteContext,
  personId: string,
  parameters: URLSearchParams,
): Page {
  if (!isStableId(personId)) throw new NotFound("person");
  const base = path("people", personId);
  const afterRoleId = parameters.get("afterRoleId");
  if (afterRoleId !== null && !isStableId(afterRoleId)) {
    throw new BadRequest(base);
  }
  const profile = context.services.getPersonProfile({
    personId,
    limit: PAGE_SIZE,
    afterRoleId,
  });
  if (!profile) throw new NotFound("person");

  const name = profile.person.displayName;
  const body = html`
  <header class="page-header profile-header">
    <p class="eyebrow">Person</p>
    <h1>${name}</h1>
    <div class="page-meta">${recordId(profile.person.id)}</div>
    <p class="lede">This profile lists the roles documented for this record. Another record with the same name is a different documented person unless evidence shows otherwise.</p>
  </header>
  <section class="section" aria-labelledby="roles-heading">
    <h2 id="roles-heading">Documented role history</h2>
    ${notice(`${END_DATE_NOTE} The source-checked date is when the cited source was last reviewed. It is not when the role began.`)}
    ${
      profile.items.length === 0
        ? emptyState(
            afterRoleId ? "No more role records" : "No documented roles",
            "No source-backed role is stored for this person record.",
            undefined,
            3,
          )
        : html`<ol class="role-list">${profile.items.map(roleCard)}</ol>`
    }
    ${pager({
      label: "Role pages",
      firstHref: afterRoleId ? base : null,
      nextHref: profile.hasMore
        ? withQuery(base, { afterRoleId: profile.nextCursor })
        : null,
    })}
  </section>`;

  return {
    title: name,
    description: `Documented public roles and source citations for ${name}.`,
    section: "people",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: "People", href: "/people" },
      { label: name },
    ],
    body,
  };
}

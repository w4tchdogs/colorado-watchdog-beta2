import type {
  PersonProfileAlternateName,
  PersonProfileRole,
} from "../../contracts/person-profile.js";
import {
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
import { directoryReturnHref } from "./officials.js";

const PAGE_SIZE = 25;

export function countyAssociations(
  counties: NonNullable<PersonProfileRole["organization"]>["counties"],
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
  const { position, organization, role } = entry;
  const heading =
    position?.title ?? role.publishedTitle ?? role.publishedOffice ?? "Role";
  return html`<li class="role-entry">
    <div class="role-head">
      <h3>${heading}</h3>
      ${organization ? html`<p class="role-position">${organizationLink(organization.id, organization.name)} ${organizationTypeBadge(organization.type)}</p>` : ""}
    </div>
    ${role.publishedOffice && (position || role.publishedTitle) ? html`<p class="role-office"><span class="quiet">Office as published:</span> ${role.publishedOffice}</p>` : ""}
    ${role.publishedTitle && position && role.publishedTitle !== position.title ? html`<p class="role-title"><span class="quiet">Title as published:</span> ${role.publishedTitle}</p>` : ""}
    ${role.jobDescription ? html`<p class="role-duties"><span class="quiet">Duties as published:</span> ${role.jobDescription}</p>` : ""}
    ${role.county ? html`<p class="role-county"><span class="quiet">County:</span> ${countyLink(role.county.fips, role.county.name)}</p>` : ""}
    ${organization ? countyAssociations(organization.counties) : ""}
    ${roleDates(entry.role)}
  </li>`;
}

/**
 * Approved alternate names, grouped by label. Each is shown as a published
 * name, never as an established conclusion about who the person is.
 */
function alternateNames(
  entries: readonly PersonProfileAlternateName[],
): SafeHtml | "" {
  if (entries.length === 0) return "";
  const labels = [...new Set(entries.map((entry) => entry.label))];
  return html`<dl class="alternate-names">${labels.map(
    (label) =>
      html`<div><dt>${label}</dt><dd>${entries
        .filter((entry) => entry.label === label)
        .map((entry) => entry.name)
        .join("; ")}</dd></div>`,
  )}</dl>`;
}

export async function personPage(
  context: SiteContext,
  personId: string,
  parameters: URLSearchParams,
): Promise<Page> {
  if (!isStableId(personId)) throw new NotFound("person");
  const base = path("people", personId);
  const afterRoleId = parameters.get("afterRoleId");
  if (afterRoleId !== null && !isStableId(afterRoleId)) {
    throw new BadRequest(base);
  }
  const profile = await context.services.getPersonProfile({
    personId,
    limit: PAGE_SIZE,
    afterRoleId,
  });
  if (!profile) throw new NotFound("person");

  const name = profile.person.displayName;
  // A profile opened from the directory carries its filters, so the visitor
  // can return to the same results.
  const from = parameters.get("from");
  const back = directoryReturnHref(from);
  const keep = back ? from : null;
  const body = html`
  <header class="page-header profile-header">
    <p class="eyebrow">Person</p>
    <h1>${name}</h1>
    ${alternateNames(profile.person.alternateNames)}
    <div class="page-meta">${recordId(profile.person.id)}</div>
    ${back ? html`<p class="back-link"><a href="${back}">Back to directory results</a></p>` : ""}
    <p class="lede">This profile lists the roles documented for this record. Another record with the same name is a different documented person unless evidence shows otherwise.</p>
  </header>
  <section class="section" aria-labelledby="roles-heading">
    <h2 id="roles-heading">Documented role history</h2>
    ${notice(`${END_DATE_NOTE} The source-checked date is when the supporting source was last reviewed. It is not when the role began.`)}
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
      firstHref: afterRoleId ? withQuery(base, { from: keep }) : null,
      nextHref: profile.hasMore
        ? withQuery(base, { afterRoleId: profile.nextCursor, from: keep })
        : null,
    })}
  </section>`;

  return {
    title: name,
    description: `Documented public roles for ${name}.`,
    section: "officials",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: "Officials & employees", href: back ?? "/officials" },
      { label: name },
    ],
    body,
  };
}

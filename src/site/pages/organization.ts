import type { OrganizationRoleEntry } from "../../contracts/organization-profile.js";
import {
  citation,
  END_DATE_NOTE,
  emptyState,
  organizationLink,
  organizationTypeBadge,
  pager,
  personLink,
  recordId,
  roleDates,
} from "../components.js";
import {
  isStableId,
  organizationTypeClass,
  organizationTypeLabel,
  parentRelationshipLabel,
} from "../format.js";
import { html, path, type SafeHtml, withQuery } from "../html.js";
import { BadRequest, NotFound, type Page, type SiteContext } from "../types.js";
import { countyAssociations } from "./person.js";

const PAGE_SIZE = 25;

function roleRow(entry: OrganizationRoleEntry): SafeHtml {
  return html`<li class="role-entry">
    <div class="role-head">
      <h3>${personLink(entry.person.id, entry.person.displayName)}</h3>
      <p class="role-position">${entry.position.title}</p>
    </div>
    ${roleDates(entry.role)}
    ${citation({ ...entry.source, checkedAt: entry.role.sourceCheckedAt })}
  </li>`;
}

export function organizationPage(
  context: SiteContext,
  organizationId: string,
  parameters: URLSearchParams,
): Page {
  if (!isStableId(organizationId)) throw new NotFound("organization");
  const base = path("organizations", organizationId);
  const positionAfter = parameters.get("positionAfter");
  const roleAfter = parameters.get("roleAfter");
  if (
    (positionAfter !== null && !isStableId(positionAfter)) ||
    (roleAfter !== null && !isStableId(roleAfter))
  ) {
    throw new BadRequest(base);
  }

  const profile = context.services.getOrganizationProfile({
    organizationId,
    limit: PAGE_SIZE,
    afterPositionId: positionAfter,
  });
  const roles = profile
    ? context.services.listOrganizationRoleEntries({
        organizationId,
        limit: PAGE_SIZE,
        afterRoleId: roleAfter,
      })
    : null;
  if (!profile || !roles) throw new NotFound("organization");

  const { organization, parentOrganization: parent } = profile;
  const sources = new Map<string, OrganizationRoleEntry>();
  for (const entry of roles.items) {
    if (!sources.has(entry.source.id)) sources.set(entry.source.id, entry);
  }

  const body = html`
  <header class="page-header profile-header type-edge edge-${organizationTypeClass(organization.type)}">
    <p class="eyebrow">${organizationTypeLabel(organization.type)}</p>
    <h1>${organization.name}</h1>
    <div class="page-meta">${organizationTypeBadge(organization.type)} ${recordId(organization.id)}</div>
  </header>

  <section class="section" aria-labelledby="context-heading">
    <h2 id="context-heading">Where it sits</h2>
    <div class="split">
      <div>
        <h3 class="subhead">Parent organization</h3>
        ${
          parent
            ? html`<p>${parentRelationshipLabel(parent.relationshipType)} ${organizationLink(parent.id, parent.name)} ${organizationTypeBadge(parent.type)}</p>
                ${parent.relationshipType === "grouped_under" ? html`<p class="quiet">Grouped under is a listing arrangement. It does not establish a reporting line.</p>` : ""}`
            : html`<p class="quiet">No parent organization is recorded.</p>`
        }
      </div>
      <div>
        <h3 class="subhead">Counties</h3>
        ${countyAssociations(profile.counties)}
      </div>
    </div>
  </section>

  <section class="section" id="positions" aria-labelledby="positions-heading">
    <h2 id="positions-heading">Documented positions</h2>
    <p class="section-intro">Position titles recorded for this organization. A listed position is not a statement that it is filled or vacant.</p>
    ${
      profile.items.length === 0
        ? emptyState(
            positionAfter ? "No more positions" : "No documented positions",
            "No position has been documented for this organization. This does not describe how the organization is staffed.",
            undefined,
            3,
          )
        : html`<ul class="position-list">${profile.items.map((position) => html`<li>${position.title}</li>`)}</ul>`
    }
    ${pager({
      label: "Position pages",
      firstHref: positionAfter
        ? withQuery(base, { roleAfter }, "positions")
        : null,
      nextHref: profile.hasMore
        ? withQuery(
            base,
            { positionAfter: profile.nextCursor, roleAfter },
            "positions",
          )
        : null,
    })}
  </section>

  <section class="section" id="roles" aria-labelledby="roles-heading">
    <h2 id="roles-heading">People documented in roles</h2>
    <p class="section-intro">${END_DATE_NOTE}</p>
    ${
      roles.items.length === 0
        ? emptyState(
            roleAfter ? "No more role records" : "No documented roles",
            "No person has been documented in a role at this organization. This does not indicate a vacancy.",
            undefined,
            3,
          )
        : html`<ol class="role-list">${roles.items.map(roleRow)}</ol>`
    }
    ${pager({
      label: "Role pages",
      firstHref: roleAfter ? withQuery(base, { positionAfter }, "roles") : null,
      nextHref: roles.hasMore
        ? withQuery(
            base,
            { positionAfter, roleAfter: roles.nextCursor },
            "roles",
          )
        : null,
    })}
  </section>

  ${
    sources.size === 0
      ? ""
      : html`<section class="section" aria-labelledby="sources-heading">
          <h2 id="sources-heading">Public sources on this page</h2>
          <ul class="source-list">${[...sources.values()].map((entry) => html`<li>${citation(entry.source)}</li>`)}</ul>
        </section>`
  }`;

  return {
    title: organization.name,
    description: `Documented positions, roles and public sources for ${organization.name}.`,
    section: "organizations",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: "Organizations", href: "/organizations" },
      { label: organization.name },
    ],
    body,
  };
}

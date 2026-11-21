import { UNIT_ID_PATTERN } from "../../contracts/county-structure.js";
import type { OrganizationType } from "../../contracts/directory.js";
import {
  type CountyStructure,
  type CountyStructureOrganization,
  OFFICIALS_SORT_FIELDS,
  type OfficialsDirectoryEntry,
  type OfficialsDirectoryPage,
  type OfficialsSort,
} from "../../contracts/officials-directory.js";
import type { PublicCountyUnit } from "../../services/county-structure-public.js";
import {
  emptyState,
  notice,
  organizationLink,
  organizationTypeBadge,
  pageHeader,
} from "../components.js";
import { COUNTY_UNIT_OFFICE_PREFIX, countyNav } from "../county-nav.js";
import {
  affiliationVerb,
  countyTitle,
  formatStoredDate,
  isCountyFips,
  isStableId,
  ORGANIZATION_TYPE_LABELS,
  parentRelationshipLabel,
  plural,
} from "../format.js";
import { html, path, type SafeHtml, trusted, withQuery } from "../html.js";
import { BadRequest, type Page, type SiteContext } from "../types.js";

const PAGE_SIZE = 25;
const MAX_QUERY = 100;
const MAX_PAGE = 10_000;

type OfficeFilter =
  | { readonly kind: "organization" | "unit"; readonly id: string }
  | { readonly kind: "type"; readonly type: OrganizationType };

export interface DirectoryState {
  readonly view: "people" | "structure";
  readonly county: string | null;
  readonly office: OfficeFilter | null;
  readonly query: string;
  readonly sort: OfficialsSort;
  readonly descending: boolean;
  readonly page: number;
}

const TYPE_GROUPS: readonly { type: OrganizationType; plural: string }[] = [
  { type: "county_government", plural: "County government" },
  { type: "office", plural: "Offices" },
  { type: "department", plural: "Departments" },
  { type: "division", plural: "Divisions" },
  { type: "regional", plural: "Regional organizations" },
  { type: "partner", plural: "Partner organizations" },
  { type: "other", plural: "Other organizations" },
];

const SORT_LABELS: Readonly<Record<OfficialsSort, string>> = {
  name: "Official / employee",
  county: "County",
  organization: "County office",
  title: "Position title",
  checked: "Source checked",
};

function officeValue(office: OfficeFilter | null): string | null {
  if (!office) return null;
  if (office.kind === "type") return `type:${office.type}`;
  return office.kind === "unit"
    ? `${COUNTY_UNIT_OFFICE_PREFIX}${office.id}`
    : office.id;
}

/** Directory address for a state. Defaults are omitted to keep links short. */
export function directoryHref(
  state: DirectoryState,
  changes: Partial<DirectoryState> = {},
): string {
  return `/officials${directoryQuery({ ...state, ...changes })}`;
}

function directoryQuery(state: DirectoryState): string {
  return withQuery("", {
    directoryView: state.view === "structure" ? "structure" : null,
    county: state.county,
    office: state.view === "people" ? officeValue(state.office) : null,
    q: state.view === "people" ? state.query : null,
    sort:
      state.view === "people" && (state.sort !== "name" || state.descending)
        ? `${state.sort}${state.descending ? "-desc" : ""}`
        : null,
    page: state.view === "people" && state.page > 1 ? String(state.page) : null,
  });
}

/**
 * Reads directory state from URL parameters. Every value is validated here;
 * anything malformed raises BadRequest so a broken link restarts cleanly.
 */
export function parseDirectoryState(
  parameters: URLSearchParams,
  restart = "/officials",
): DirectoryState {
  const bad = () => new BadRequest(restart);
  const view = parameters.get("directoryView") ?? "people";
  if (view !== "people" && view !== "structure") throw bad();

  const county = parameters.get("county") || null;
  if (county !== null && !isCountyFips(county)) throw bad();

  let office: OfficeFilter | null = null;
  const officeText = parameters.get("office") || null;
  if (officeText !== null) {
    if (officeText.startsWith("type:")) {
      const type = officeText.slice(5) as OrganizationType;
      if (!(type in ORGANIZATION_TYPE_LABELS)) throw bad();
      office = { kind: "type", type };
    } else if (officeText.startsWith(COUNTY_UNIT_OFFICE_PREFIX)) {
      const id = officeText.slice(COUNTY_UNIT_OFFICE_PREFIX.length);
      if (county === null || !UNIT_ID_PATTERN.test(id)) throw bad();
      office = { kind: "unit", id };
    } else if (isStableId(officeText)) {
      office = { kind: "organization", id: officeText };
    } else {
      throw bad();
    }
  }

  const query = (parameters.get("q") ?? "").trim();
  if (query.length > MAX_QUERY) throw bad();

  const sortText = parameters.get("sort") ?? "name";
  const descending = sortText.endsWith("-desc");
  const sort = (descending ? sortText.slice(0, -5) : sortText) as OfficialsSort;
  if (!OFFICIALS_SORT_FIELDS.includes(sort)) throw bad();

  const pageText = parameters.get("page") ?? "1";
  if (!/^[1-9]\d{0,4}$/.test(pageText)) throw bad();
  const page = Number(pageText);
  if (page > MAX_PAGE) throw bad();

  return { view, county, office, query, sort, descending, page };
}

/**
 * Rebuilds a "back to directory results" address from the `from` value a
 * profile link carries. The value is re-validated field by field, so it can
 * only ever produce an /officials address.
 */
export function directoryReturnHref(from: string | null): string | null {
  if (from === null || from.length === 0 || from.length > 512) return null;
  try {
    const state = parseDirectoryState(new URLSearchParams(from));
    return directoryHref(state);
  } catch {
    return null;
  }
}

function initials(name: string): string {
  const words = name
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word));
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function tabs(
  state: DirectoryState,
  profileCount: number | null,
  structureCount: number | null,
): SafeHtml {
  const tab = (
    view: "people" | "structure",
    label: string,
    total: number | null,
  ) =>
    html`<li><a class="directory-tab" href="${directoryHref(state, { view, page: 1 })}"${state.view === view ? trusted(' aria-current="page"') : ""}>${label}${
      total === null
        ? ""
        : html` <span class="count-chip">${total}<span class="visually-hidden"> ${view === "people" ? "profiles" : "organizations"}</span></span>`
    }</a></li>`;
  return html`<nav class="directory-tabs" aria-label="Directory views"><ul>
    ${tab("people", "Named profiles", profileCount)}
    ${tab("structure", "County structure", structureCount)}
  </ul></nav>`;
}

function countySelect(
  counties: readonly { fips: string; name: string }[],
  selected: string | null,
  id: string,
): SafeHtml {
  return html`<div class="field">
    <label for="${id}">County</label>
    <select id="${id}" name="county">
      <option value="">All counties</option>
      ${counties.map(
        (county) =>
          html`<option value="${county.fips}"${county.fips === selected ? trusted(" selected") : ""}>${countyTitle(county.name)}</option>`,
      )}
    </select>
  </div>`;
}

function officeSelect(
  state: DirectoryState,
  structure: CountyStructure | null,
  units: readonly PublicCountyUnit[],
  officeName: string | null,
): SafeHtml {
  const selected = officeValue(state.office);
  const option = (value: string, label: string) =>
    html`<option value="${value}"${value === selected ? trusted(" selected") : ""}>${label}</option>`;
  let groups: SafeHtml | SafeHtml[];
  if (structure) {
    const direct = structure.organizations.filter(
      (o) => o.countyAssociation.direct,
    );
    const affiliated = structure.organizations.filter(
      (o) => !o.countyAssociation.direct,
    );
    groups = [
      ...TYPE_GROUPS.map(({ type, plural: label }) => {
        const members = direct.filter((o) => o.type === type);
        return members.length === 0
          ? html``
          : html`<optgroup label="${label}">
              ${option(`type:${type}`, `${label}: all`)}
              ${members.map((o) => option(o.id, o.name))}
            </optgroup>`;
      }),
      affiliated.length === 0
        ? html``
        : html`<optgroup label="Affiliated organizations (not county departments)">
            ${affiliated.map((o) => option(o.id, o.name))}
          </optgroup>`,
    ];
  } else {
    groups = html`<optgroup label="Organization type">
      ${TYPE_GROUPS.map(({ type, plural: label }) => option(`type:${type}`, `${label}: all`))}
    </optgroup>
    ${state.office?.kind === "organization" && officeName ? html`<optgroup label="Selected office">${option(state.office.id, officeName)}</optgroup>` : ""}`;
  }
  return html`<div class="field">
    <label for="directory-office">Office or department</label>
    <select id="directory-office" name="office" aria-describedby="directory-office-hint">
      <option value="">All county offices &amp; departments</option>
      ${
        units.length > 0
          ? html`<optgroup label="County Structure units">
        ${units.map((unit) => option(`${COUNTY_UNIT_OFFICE_PREFIX}${unit.id}`, unit.name))}
      </optgroup>`
          : ""
      }
      ${groups}
    </select>
    <p class="hint" id="directory-office-hint">${
      units.length > 0
        ? "County Structure units show reviewed placements in that unit. Other offices include their documented subunits."
        : structure
          ? "Choosing an office includes its documented subunits."
          : "Individual offices become available after you select a county."
    }</p>
  </div>`;
}

function sortSelect(state: DirectoryState): SafeHtml {
  const current = `${state.sort}${state.descending ? "-desc" : ""}`;
  const fields: OfficialsSort[] = [
    "name",
    "county",
    "organization",
    "title",
    "checked",
  ];
  return html`<div class="field">
    <label for="directory-sort">Sort profiles</label>
    <select id="directory-sort" name="sort">
      ${fields.flatMap((field) =>
        ["", "-desc"].map((suffix) => {
          const value = `${field}${suffix}`;
          return html`<option value="${value}"${value === current ? trusted(" selected") : ""}>${SORT_LABELS[field]}, ${suffix ? "descending" : "ascending"}</option>`;
        }),
      )}
    </select>
  </div>`;
}

function countyCell(
  entry: OfficialsDirectoryEntry,
  filterCounty: string | null,
): SafeHtml {
  const role = entry.role;
  const counties = role?.organization
    ? role.organization.counties
    : role?.county
      ? [
          {
            fips: role.county.fips,
            name: role.county.name,
            direct: true,
            affiliations: [],
          },
        ]
      : [];
  if (counties.length === 0) {
    return html`<span class="quiet">No county recorded</span>`;
  }
  const shown = filterCounty
    ? counties.filter((county) => county.fips === filterCounty)
    : counties.some((county) => county.direct)
      ? counties.filter((county) => county.direct)
      : counties;
  return html`<ul class="cell-list">${shown.map((county) => {
    const link = html`<a href="${path("counties", county.fips)}">${countyTitle(county.name)}</a>`;
    return county.direct
      ? html`<li>${link}</li>`
      : html`<li><span class="affiliation-note">${affiliationVerb(county.affiliations[0] ?? "")}</span> ${link}</li>`;
  })}</ul>`;
}

function sourceCheckedCell(entry: OfficialsDirectoryEntry): SafeHtml {
  const role = entry.role;
  if (!role) return html`<span class="quiet">No source-backed role</span>`;
  return html`<span class="checked-date">${formatStoredDate(role.sourceCheckedAt)}</span>`;
}

function profileRow(
  entry: OfficialsDirectoryEntry,
  state: DirectoryState,
  from: string,
): SafeHtml {
  const role = entry.role;
  const profile = withQuery(path("people", entry.person.id), { from });
  const others = entry.matchingRoleCount - 1;
  return html`<tr>
    <td class="cell-person" data-label="Official / employee">
      <span class="avatar" aria-hidden="true">${initials(entry.person.displayName)}</span>
      <div class="person-summary">
        <a class="person-name" href="${profile}">${entry.person.displayName}</a>
        <span class="person-title">${role ? (role.position?.title ?? role.publishedTitle ?? role.publishedOffice ?? "Duties as published below") : "No documented role"}</span>
        ${role?.jobDescription ? html`<span class="row-note">Duties as published: ${role.jobDescription}</span>` : ""}
        ${role ? html`<span class="status-chip">Documented role</span>` : ""}
        ${role?.endDate ? html`<span class="row-note">Role end recorded: ${formatStoredDate(role.endDate)}</span>` : ""}
        ${others > 0 ? html`<span class="row-note">${plural(others, "other matching role", "other matching roles")} on the profile</span>` : ""}
      </div>
    </td>
    <td data-label="County"><div class="cell-value">${countyCell(entry, state.county)}</div></td>
    <td data-label="County office"><div class="cell-value">${
      role?.organization
        ? html`${organizationLink(role.organization.id, role.organization.name)} ${organizationTypeBadge(role.organization.type)}`
        : role?.publishedOffice
          ? html`${role.publishedOffice} <span class="quiet">(as published)</span>`
          : html`<span class="quiet">None recorded</span>`
    }</div></td>
    <td data-label="Source checked"><div class="cell-value">${sourceCheckedCell(entry)}</div></td>
    <td class="cell-open"><a class="open-profile" href="${profile}">Open profile<span class="visually-hidden">: ${entry.person.displayName}</span></a></td>
  </tr>`;
}

function sortableHeading(
  state: DirectoryState,
  field: OfficialsSort,
): SafeHtml {
  const active = state.sort === field;
  const descending = active && !state.descending;
  const href = directoryHref(state, { sort: field, descending, page: 1 });
  return html`<th scope="col"${active ? trusted(` aria-sort="${state.descending ? "descending" : "ascending"}"`) : ""}>
    <a class="sort-link" href="${href}">${SORT_LABELS[field]}<span class="sort-mark" aria-hidden="true">${active ? (state.descending ? "▼" : "▲") : "↕"}</span><span class="visually-hidden">, sort ${descending ? "descending" : "ascending"}</span></a>
  </th>`;
}

function pagination(
  state: DirectoryState,
  page: number,
  pageCount: number,
): SafeHtml {
  if (pageCount <= 1) return html``;
  return html`<nav class="pager directory-pager" aria-label="Result pages">
    ${page > 1 ? html`<a class="button button-quiet" rel="prev" href="${directoryHref(state, { page: page - 1 })}">Previous page</a>` : ""}
    <span class="pager-status">Page ${page} of ${pageCount}</span>
    ${page < pageCount ? html`<a class="button button-quiet" rel="next" href="${directoryHref(state, { page: page + 1 })}">Next page</a>` : ""}
  </nav>`;
}

async function peopleView(
  context: SiteContext,
  state: DirectoryState,
  structure: CountyStructure | null,
  counties: readonly { fips: string; name: string }[],
): Promise<{ body: SafeHtml; total: number | null }> {
  const countyName = structure ? countyTitle(structure.county.name) : null;
  const units =
    state.county === null
      ? []
      : [...(await context.countyStructure.listPublicUnits(state.county))].sort(
          (a, b) =>
            a.name.localeCompare(b.name, "en") ||
            a.id.localeCompare(b.id, "en"),
        );
  let office = state.office;
  let officeName: string | null = null;
  if (office?.kind === "unit") {
    const unitId = office.id;
    const match = units.find((unit) => unit.id === unitId);
    if (!match)
      throw new BadRequest(directoryHref(state, { office: null, page: 1 }));
    officeName = match.name;
  } else if (office?.kind === "organization" && structure) {
    const officeId = office.id;
    const match = structure.organizations.find((o) => o.id === officeId);
    // Legacy organization links clear the office when the county changes.
    if (match) officeName = match.name;
    else office = null;
  } else if (office?.kind === "organization") {
    // With no county the select offers only types, so name the filter here
    // to keep it visible. An unknown ID is refused by the service below.
    const profile = await context.services.getOrganizationProfile({
      organizationId: office.id,
      limit: 1,
    });
    officeName = profile?.organization.name ?? null;
  } else if (office?.kind === "type") {
    const officeType = office.type;
    officeName = `${TYPE_GROUPS.find((group) => group.type === officeType)?.plural ?? "Organizations"}: all`;
  }
  const effective: DirectoryState = { ...state, office };

  const form = html`<form class="directory-filters" action="/officials" method="get" role="search" aria-label="Filter the directory">
    <div class="field field-search">
      <label for="directory-q">Search</label>
      <input id="directory-q" name="q" type="search" value="${state.query}" maxlength="${MAX_QUERY}"
        placeholder="Name, title, or department" autocomplete="off" spellcheck="false">
    </div>
    ${countySelect(counties, state.county, "directory-county")}
    ${officeSelect(effective, structure, units, officeName)}
    ${sortSelect(state)}
    <div class="filter-actions">
      <button class="button" type="submit">Apply filters</button>
      <a class="text-link" href="/officials">Clear all</a>
    </div>
  </form>`;

  if (state.query.length === 1) {
    return {
      total: null,
      body: html`${form}${emptyState(
        "That search is too short",
        "Enter at least two characters, or clear the search to browse every documented profile.",
        html`<a class="button button-quiet" href="${directoryHref(effective, { query: "", page: 1 })}">Browse without a search</a>`,
      )}`,
    };
  }

  let result: OfficialsDirectoryPage;
  try {
    result = await context.services.listOfficials({
      countyFips: state.county,
      countyUnitId: office?.kind === "unit" ? office.id : null,
      organizationId: office?.kind === "organization" ? office.id : null,
      organizationType: office?.kind === "type" ? office.type : null,
      query: state.query || null,
      sort: state.sort,
      direction: state.descending ? "desc" : "asc",
      page: state.page,
      limit: PAGE_SIZE,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "OfficialsDirectoryInputError"
    ) {
      throw new BadRequest(directoryHref(state, { office: null, page: 1 }));
    }
    throw error;
  }

  const filtered =
    state.county !== null || office !== null || state.query !== "";
  const scope = [
    countyName ? `County: ${countyName}.` : "All counties.",
    officeName ? `Office: ${officeName}.` : "",
    state.query ? `Search: "${state.query}".` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const from = directoryQuery(effective).replace(/^\?/, "");

  let results: SafeHtml;
  if (result.total === 0) {
    results = filtered
      ? emptyState(
          "No documented profiles match these filters",
          countyName && !office && !state.query
            ? `No one has been documented for ${countyName} in this database yet. That reflects this project's research, not the county's staffing.`
            : "Only records stored in this database are searched, and it is not a complete roster. A missing name has not been documented here.",
          html`<a class="button button-quiet" href="/officials">Clear all filters</a>`,
        )
      : emptyState(
          "No officials or employees have been documented yet",
          "The directory fills as research is completed. Nothing here describes how any county is staffed.",
          html`<a class="button button-quiet" href="/counties">Browse counties</a>`,
        );
  } else if (result.items.length === 0) {
    results = emptyState(
      "That page is past the end of these results",
      `These filters now match ${plural(result.total, "profile", "profiles")} on ${plural(result.pageCount, "page", "pages")}.`,
      html`<a class="button button-quiet" href="${directoryHref(effective, { page: 1 })}">Go to the first page</a>`,
    );
  } else {
    const first = (result.page - 1) * result.pageSize + 1;
    results = html`<div class="directory-results-head">
        <h2 id="results-heading">Documented officials &amp; employees <span class="count-chip">${result.total}</span></h2>
        <p class="section-intro">Each row is one person record with the most recently source-checked role that matches these filters. The date describes when the source was checked. It does not confirm current employment.</p>
      </div>
      <table class="directory-table" aria-labelledby="results-heading">
        <thead><tr>
          ${sortableHeading(effective, "name")}
          ${sortableHeading(effective, "county")}
          ${sortableHeading(effective, "organization")}
          ${sortableHeading(effective, "checked")}
          <th scope="col"><span class="visually-hidden">Open profile</span></th>
        </tr></thead>
        <tbody>${result.items.map((entry) => profileRow(entry, effective, from))}</tbody>
      </table>
      <p class="result-range">Showing ${first} to ${first + result.items.length - 1} of ${result.total}.</p>
      ${pagination(effective, result.page, result.pageCount)}`;
  }

  return {
    total: result.total,
    body: html`${form}
      <p class="directory-status" role="status"><span>Showing documented officials and employees. ${scope}</span> <span class="directory-match">${plural(result.total, "profile matches", "profiles match")}</span></p>
      <section class="directory-results" aria-label="Directory results">${results}</section>
      <p class="directory-footnote">A source-checked date describes the source confirming a listed role, not a start or departure date. A role in another county or a newer record does not establish succession. People who share a name are separate records.</p>`,
  };
}

function structureEntry(
  organization: CountyStructureOrganization,
  county: string,
  children: ReadonlyMap<string, readonly CountyStructureOrganization[]>,
  names: ReadonlyMap<string, string>,
  seen: Set<string>,
  nested: boolean,
): SafeHtml {
  seen.add(organization.id);
  const parentName = organization.parentOrganizationId
    ? names.get(organization.parentOrganizationId)
    : undefined;
  const subunits = (children.get(organization.id) ?? []).filter(
    (child) => !seen.has(child.id),
  );
  const people = withQuery("/officials", { county, office: organization.id });
  return html`<li class="structure-entry${nested ? " is-subunit" : ""}">
    <div class="structure-row">
      <a class="structure-name" href="${people}">${organization.name}</a>
      <span class="structure-count">${plural(organization.peopleCount, "profile", "profiles")}</span>
    </div>
    <p class="structure-meta">
      ${
        organization.parentOrganizationId && organization.parentRelationship
          ? html`<span>${parentRelationshipLabel(organization.parentRelationship)} ${parentName ?? "its documented parent"}</span>`
          : ""
      }
      ${organization.countyAssociation.affiliations.map(
        (type) => html`<span>${affiliationVerb(type)} this county</span>`,
      )}
      <a href="${path("organizations", organization.id)}">Positions and record<span class="visually-hidden">: ${organization.name}</span></a>
    </p>
    ${
      subunits.length === 0
        ? ""
        : html`<ul class="structure-subunits">${subunits.map((child) => structureEntry(child, county, children, names, seen, true))}</ul>`
    }
  </li>`;
}

function structureView(structure: CountyStructure | null): SafeHtml {
  if (!structure) {
    return emptyState(
      "Select a county to browse its recorded structure",
      "County structure lists the organizations documented for one county and the parent relationships recorded between them.",
      html`<a class="button button-quiet" href="/counties">Browse counties</a>`,
    );
  }
  const title = countyTitle(structure.county.name);
  const fips = structure.county.fips;
  if (structure.organizations.length === 0) {
    return emptyState(
      `No organizations recorded for ${title} yet`,
      "No county organization or affiliated body has been documented for this county. That reflects this project's research, not the county's government.",
      html`<a class="button button-quiet" href="/officials?directoryView=structure">Choose another county</a>`,
    );
  }

  const direct = structure.organizations.filter(
    (o) => o.countyAssociation.direct,
  );
  const affiliated = structure.organizations.filter(
    (o) => !o.countyAssociation.direct,
  );
  const names = new Map(structure.organizations.map((o) => [o.id, o.name]));
  const directIds = new Set(direct.map((o) => o.id));
  const governments = new Set(
    direct.filter((o) => o.type === "county_government").map((o) => o.id),
  );
  const children = new Map<string, CountyStructureOrganization[]>();
  for (const organization of direct) {
    const parent = organization.parentOrganizationId;
    // Units recorded directly under the county government record are listed
    // by their own type instead of being nested under one long card.
    if (parent && directIds.has(parent) && !governments.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), organization]);
    }
  }
  const topLevel = direct.filter(
    (o) =>
      governments.has(o.id) ||
      !o.parentOrganizationId ||
      !directIds.has(o.parentOrganizationId) ||
      governments.has(o.parentOrganizationId),
  );

  const seen = new Set<string>();
  const cards = TYPE_GROUPS.map(({ type, plural: label }) => {
    const members = topLevel.filter((o) => o.type === type);
    if (members.length === 0) return html``;
    const all = withQuery("/officials", {
      county: fips,
      office: `type:${type}`,
    });
    return html`<section class="card structure-card" aria-labelledby="structure-${type}">
      <div class="structure-card-head">
        <h3 id="structure-${type}">${label}</h3>
        ${type === "county_government" ? "" : html`<a class="text-link" href="${all}">All profiles<span class="visually-hidden"> in ${label.toLowerCase()}</span></a>`}
      </div>
      <ul class="structure-list">${members.map((o) => structureEntry(o, fips, children, names, seen, false))}</ul>
    </section>`;
  });

  return html`
    ${notice(html`<strong>County structure is not one chain of command.</strong> Group headings are the stored organization types and do not create supervisory authority. A parent is shown only where a parent relationship is documented. Profile counts are records in this database, include documented subunits, and are not staffing totals.`)}
    ${structure.truncated ? notice("This county has more recorded organizations than this page lists. Use the office filter in Named profiles to reach the rest.") : ""}
    <h2 class="structure-county">${title}</h2>
    ${
      direct.length === 0
        ? html`<p class="quiet">No organization is recorded as part of ${title} itself.</p>`
        : html`<div class="structure-grid">${cards}</div>`
    }
    ${
      affiliated.length === 0
        ? ""
        : html`<section class="section" aria-labelledby="structure-affiliated">
            <h2 id="structure-affiliated">Affiliated regional and partner organizations</h2>
            <p class="section-intro">Organizations with a documented relationship to ${title}. They are not county departments, and an affiliation does not imply that they report to the county.</p>
            <div class="card structure-card structure-affiliated">
              <ul class="structure-list">${affiliated.map((o) => structureEntry(o, fips, new Map(), names, new Set(), false))}</ul>
            </div>
          </section>`
    }`;
}

export async function officialsPage(
  context: SiteContext,
  parameters: URLSearchParams,
): Promise<Page> {
  const state = parseDirectoryState(parameters);
  const counties = await context.services.listCounties();
  if (state.county !== null && !counties.some((c) => c.fips === state.county)) {
    throw new BadRequest("/officials");
  }
  const structure =
    state.county === null
      ? null
      : await context.services.getCountyStructure({ countyFips: state.county });
  const structureCount = structure ? structure.organizations.length : null;

  let content: SafeHtml;
  let profileCount: number | null = null;
  if (state.view === "structure") {
    content = html`<form class="directory-filters directory-filters-structure" action="/officials" method="get" aria-label="Choose a county">
        <input type="hidden" name="directoryView" value="structure">
        ${countySelect(counties, state.county, "directory-county")}
        <div class="filter-actions"><button class="button" type="submit">Show county</button></div>
      </form>
      <p class="directory-status" role="status">Recorded county organizations and their documented subunits. ${structure ? `County: ${countyTitle(structure.county.name)}.` : "No county selected."}</p>
      ${structureView(structure)}`;
    // The profile tab count reflects the same county with no other filter.
    profileCount = (
      await context.services.listOfficials({
        countyFips: state.county,
        limit: 1,
      })
    ).total;
  } else {
    const view = await peopleView(context, state, structure, counties);
    content = view.body;
    profileCount = view.total;
  }

  const title = structure
    ? `Officials & employees, ${countyTitle(structure.county.name)}`
    : "Search officials & employees";
  return {
    title,
    description:
      "Browse documented county officials and employees by county, office and name.",
    section: "officials",
    breadcrumbs: [
      { label: "Home", href: "/" },
      ...(structure
        ? [
            { label: "Counties", href: "/counties" },
            {
              label: countyTitle(structure.county.name),
              href: path("counties", structure.county.fips),
            },
          ]
        : []),
      { label: "Officials & employees" },
    ],
    ...(structure
      ? {
          subnav: countyNav({
            counties,
            county: structure.county,
            current: state.view === "structure" ? "structure" : "officials",
            switchTo: state.view,
          }),
        }
      : {}),
    body: html`${pageHeader(
      "Search officials & employees",
      "One profile per documented person. Browse statewide or select a county to begin. A directory entry is not a finding of misconduct.",
      undefined,
      "County governments · Documented roles",
    )}
    ${tabs(state, profileCount, structureCount)}
    ${content}`,
  };
}

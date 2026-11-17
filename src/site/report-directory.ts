import type { OrganizationType } from "../contracts/directory.js";
import type { PublicSiteServiceResults } from "./types.js";

/**
 * Read-only directory lookups for the report form's employee picker. They
 * reuse the public officials directory and person profile services, so the
 * form sees exactly the records the public Officials page shows.
 */

export type PickerRoleGroup = "latest" | "prior" | "unrecorded";

export interface PickerRole {
  readonly id: string;
  readonly title: string | null;
  readonly office: string | null;
  readonly county: { readonly fips: string; readonly name: string } | null;
  /** Documented employment dates, when the source gave them. */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** When the cited source was checked. Not an employment date. */
  readonly sourceCheckedAt: string;
  readonly sourceTitle: string;
  readonly group: PickerRoleGroup;
}

export interface PickerPerson {
  readonly personId: string;
  readonly displayName: string;
  readonly matchingRoleCount: number;
  readonly role: PickerRole | null;
}

const TYPES: readonly OrganizationType[] = [
  "county_government",
  "office",
  "department",
  "division",
  "regional",
  "partner",
  "other",
];
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const FIPS = /^08\d{3}$/;
const PAGE_SIZE = 10;

/** A role with an end date in the past is prior. A role with neither date has no employment context. */
export function classifyRole(
  role: { startDate: string | null; endDate: string | null },
  now: Date,
): PickerRoleGroup {
  const today = now.toISOString().slice(0, 10);
  if (role.endDate !== null && role.endDate <= today) return "prior";
  if (role.startDate !== null || role.endDate !== null) return "latest";
  return "unrecorded";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function isReportDirectoryPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/submit-report/directory";
}

export async function reportDirectoryResponse(
  url: URL,
  services: PublicSiteServiceResults,
  now: Date,
): Promise<Response> {
  const allowed = new Set([
    "county",
    "office",
    "q",
    "page",
    "offices",
    "person",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      return json(400, { error: "invalid_request" });
  }
  const get = (name: string) => url.searchParams.get(name) || null;
  try {
    const officesFor = get("offices");
    if (officesFor !== null) {
      if (!FIPS.test(officesFor))
        return json(400, { error: "invalid_request" });
      const structure = await services.getCountyStructure({
        countyFips: officesFor,
      });
      return json(200, {
        offices: structure.organizations.map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type,
          parentOrganizationId: o.parentOrganizationId,
        })),
        truncated: structure.truncated,
      });
    }

    const personId = get("person");
    if (personId !== null) {
      if (!ID.test(personId)) return json(400, { error: "invalid_request" });
      const roles: PickerRole[] = [];
      let after: string | null = null;
      let person: { id: string; displayName: string } | null = null;
      for (let guard = 0; guard < 5; guard += 1) {
        const page = await services.getPersonProfile({
          personId,
          limit: 100,
          afterRoleId: after,
        });
        if (!page) return json(404, { error: "not_found" });
        person = page.person;
        for (const item of page.items) {
          roles.push({
            id: item.role.id,
            title: item.role.publishedTitle ?? item.position?.title ?? null,
            office:
              item.role.publishedOffice ?? item.organization?.name ?? null,
            county: item.role.county,
            startDate: item.role.startDate,
            endDate: item.role.endDate,
            sourceCheckedAt: item.role.sourceCheckedAt,
            sourceTitle: item.source.title,
            group: classifyRole(item.role, now),
          });
        }
        if (!page.hasMore) break;
        after = page.nextCursor;
      }
      if (!person) return json(404, { error: "not_found" });
      // Latest source check first, so the most recent observation leads.
      roles.sort((a, b) => b.sourceCheckedAt.localeCompare(a.sourceCheckedAt));
      return json(200, {
        person: { personId: person.id, displayName: person.displayName },
        roles,
      });
    }

    const county = get("county");
    if (county !== null && !FIPS.test(county))
      return json(400, { error: "invalid_request" });
    const officeText = get("office");
    let organizationId: string | null = null;
    let organizationType: OrganizationType | null = null;
    if (officeText !== null) {
      if (officeText.startsWith("type:")) {
        const type = officeText.slice(5) as OrganizationType;
        if (!TYPES.includes(type))
          return json(400, { error: "invalid_request" });
        organizationType = type;
      } else if (ID.test(officeText)) {
        organizationId = officeText;
      } else {
        return json(400, { error: "invalid_request" });
      }
    }
    const query = (get("q") ?? "").trim();
    if (query.length === 1 || query.length > 100)
      return json(400, { error: "invalid_request" });
    const pageText = get("page") ?? "1";
    if (!/^[1-9]\d{0,3}$/.test(pageText))
      return json(400, { error: "invalid_request" });
    const result = await services.listOfficials({
      countyFips: county,
      organizationId,
      organizationType,
      query: query || null,
      sort: "name",
      direction: "asc",
      page: Number(pageText),
      limit: PAGE_SIZE,
    });
    const items: PickerPerson[] = result.items.map((entry) => ({
      personId: entry.person.id,
      displayName: entry.person.displayName,
      matchingRoleCount: entry.matchingRoleCount,
      role: entry.role
        ? {
            id: entry.role.id,
            title:
              entry.role.publishedTitle ?? entry.role.position?.title ?? null,
            office:
              entry.role.publishedOffice ??
              entry.role.organization?.name ??
              null,
            county: entry.role.county,
            startDate: entry.role.startDate,
            endDate: entry.role.endDate,
            sourceCheckedAt: entry.role.sourceCheckedAt,
            sourceTitle: entry.role.source.title,
            group: classifyRole(entry.role, now),
          }
        : null,
    }));
    return json(200, {
      items,
      total: result.total,
      page: result.page,
      pageCount: result.pageCount,
    });
  } catch (error) {
    if (error instanceof Error && error.name.endsWith("InputError"))
      return json(400, { error: "invalid_request" });
    return json(503, { error: "service_unavailable" });
  }
}

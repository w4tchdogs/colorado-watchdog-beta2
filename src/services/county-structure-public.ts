import type { AsyncD1Database } from "../database/d1.js";
import { personIsPublicSql } from "./person-visibility.js";

/**
 * Public County Structure reads (COUNTY-DB-1).
 *
 * Selects only public columns. It never reads evidence, source references,
 * import receipts or history. A unit shows only while it and every ancestor are
 * `active`. A browse heading such as "Elected Official" or "Departments" lists
 * top-level units without being their reporting parent. Every shown unit
 * appears exactly once: under a verified parent when it has one, otherwise
 * under its heading. A heading is the county's own saved grouping when the unit
 * has one, then the county's matching grouping, then a generic category from
 * the unit type, and **Other** when none applies. The Elected Officials listing
 * is built from reviewed `county_role_display` rows and never from a title.
 */

export interface PublicPerson {
  readonly personId: string;
  readonly displayName: string;
  readonly title: string | null;
}

export interface PublicUnit {
  readonly id: string;
  readonly name: string;
  readonly organizationType: string;
  readonly aliases: readonly string[];
  readonly people: readonly PublicPerson[];
  readonly children: readonly PublicUnit[];
}

export interface PublicGroup {
  readonly id: string;
  readonly name: string;
  readonly units: readonly PublicUnit[];
}

export interface PublicElectedOfficial extends PublicPerson {
  readonly unitId: string | null;
  readonly unitName: string | null;
}

export interface PublicCountyStructure {
  readonly countyFips: string;
  /** Browse headings. Each shown unit appears once, under one heading. */
  readonly groups: readonly PublicGroup[];
  readonly electedOfficials: readonly PublicElectedOfficial[];
  /** True when no County Structure has been imported for this county. */
  readonly empty: boolean;
}

export interface CountyStructureReader {
  getCountyStructure(countyFips: string): Promise<PublicCountyStructure>;
}

/** The reader used when no County Structure database is attached. */
export const emptyCountyStructure: CountyStructureReader = {
  async getCountyStructure(countyFips: string): Promise<PublicCountyStructure> {
    return {
      countyFips,
      groups: [],
      electedOfficials: [],
      empty: true,
    };
  },
};

const LIMIT = 1000;

interface UnitRow {
  id: string;
  parent_unit_id: string | null;
  display_group_id: string | null;
  name: string;
  organization_type: string;
  display_order: number | null;
  aliases: string | null;
}

const byOrder = (
  left: { display_order: number | null; name: string; id: string },
  right: { display_order: number | null; name: string; id: string },
) => {
  const a = left.display_order ?? Number.MAX_SAFE_INTEGER;
  const b = right.display_order ?? Number.MAX_SAFE_INTEGER;
  if (a !== b) return a - b;
  const n = left.name
    .toLowerCase()
    .localeCompare(right.name.toLowerCase(), "en");
  return n !== 0 ? n : left.id.localeCompare(right.id, "en");
};

/**
 * The comparison key for public labels. Two strings with the same key differ
 * only in whitespace, including spaces around a hyphen or a slash. The literal
 * strings stay in the database and the private evidence.
 */
export const labelKey = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/gu, "");

/** One public label per unit: drop aliases that match the name or each other. */
function publicAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set([labelKey(name)]);
  const kept: string[] = [];
  for (const alias of aliases) {
    const key = labelKey(alias);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    kept.push(alias);
  }
  return kept;
}

/** Generic browse headings, in display order, keyed by unit type. */
const CATEGORIES = [
  { id: "category:departments", name: "Departments", types: ["department"] },
  { id: "category:offices", name: "Offices", types: ["office"] },
  { id: "category:boards", name: "Boards", types: ["board"] },
  { id: "category:commissions", name: "Commissions", types: ["commission"] },
] as const;
const OTHER = { id: "category:other", name: "Other" } as const;

/** Singular/plural and case differences do not make a different heading. */
const headingKey = (value: string): string =>
  labelKey(value).toLowerCase().replace(/s$/u, "");

export class D1CountyStructurePublicService implements CountyStructureReader {
  constructor(private readonly database: AsyncD1Database) {}

  async getCountyStructure(countyFips: string): Promise<PublicCountyStructure> {
    if (!/^08\d{3}$/.test(countyFips))
      return {
        countyFips,
        groups: [],
        electedOfficials: [],
        empty: true,
      };

    const groups = await this.database.all<{
      id: string;
      name: string;
      display_order: number | null;
    }>(
      `SELECT id, name, display_order FROM county_unit_display
       WHERE county_fips = ? AND status = 'active'`,
      LIMIT,
      [countyFips],
    );
    const units = await this.database.all<UnitRow>(
      `SELECT u.id, u.parent_unit_id, u.display_group_id, u.name, u.organization_type,
              u.display_order,
              (SELECT json_group_array(alias)
                 FROM (SELECT alias FROM county_unit_alias a
                       WHERE a.unit_id = u.id ORDER BY position)) AS aliases
       FROM county_unit u WHERE u.county_fips = ? AND u.status = 'active'`,
      LIMIT,
      [countyFips],
    );
    const roles = await this.database.all<{
      listing: string;
      unit_id: string | null;
      person_id: string;
      display_name: string;
      title: string | null;
    }>(
      `SELECT d.listing, d.unit_id, p.id AS person_id, p.display_name,
              COALESCE(r.published_title, pos.title) AS title
       FROM county_role_display d
       JOIN person_roles r ON r.id = d.person_role_id
       JOIN people p ON p.id = r.person_id
       LEFT JOIN positions pos ON pos.id = r.position_id
       WHERE d.county_fips = ? AND ${personIsPublicSql("p.id")}
       ORDER BY p.display_name, p.id, d.id`,
      LIMIT,
      [countyFips],
    );

    const visibleGroups = new Set(groups.map((group) => group.id));
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    // A unit shows only while every ancestor is active and its grouping is active.
    const shown = (unit: UnitRow): boolean => {
      const seen = new Set<string>();
      let current: UnitRow | undefined = unit;
      while (current) {
        if (seen.has(current.id)) return false;
        seen.add(current.id);
        if (
          current.display_group_id &&
          !visibleGroups.has(current.display_group_id)
        )
          return false;
        if (!current.parent_unit_id) return true;
        current = byId.get(current.parent_unit_id);
      }
      return false;
    };
    const visible = units.filter(shown);
    const visibleIds = new Set(visible.map((unit) => unit.id));

    const homePeople = new Map<string, PublicPerson[]>();
    const electedOfficials: PublicElectedOfficial[] = [];
    const seenElected = new Set<string>();
    for (const role of roles) {
      const person: PublicPerson = {
        personId: role.person_id,
        displayName: role.display_name,
        title: role.title,
      };
      if (
        role.listing === "home" &&
        role.unit_id &&
        visibleIds.has(role.unit_id)
      ) {
        const list = homePeople.get(role.unit_id) ?? [];
        list.push(person);
        homePeople.set(role.unit_id, list);
      }
      if (role.listing === "elected_official") {
        const key = `${role.person_id}:${role.unit_id ?? ""}`;
        if (seenElected.has(key)) continue;
        seenElected.add(key);
        const unit = role.unit_id ? byId.get(role.unit_id) : undefined;
        electedOfficials.push({
          ...person,
          unitId: unit && visibleIds.has(unit.id) ? unit.id : null,
          unitName: unit && visibleIds.has(unit.id) ? unit.name : null,
        });
      }
    }

    // A unit with a shown parent nests under it. Every other shown unit is a
    // root and takes exactly one browse heading.
    const countyHeadings = new Map(
      groups.map((group) => [headingKey(group.name), group.id]),
    );
    const headingFor = (unit: UnitRow): string => {
      if (unit.display_group_id) return unit.display_group_id;
      const category = CATEGORIES.find((entry) =>
        (entry.types as readonly string[]).includes(unit.organization_type),
      );
      if (!category) return OTHER.id;
      return countyHeadings.get(headingKey(category.name)) ?? category.id;
    };
    // Separate maps: a heading id and a unit id may look alike.
    const childrenOf = new Map<string, UnitRow[]>();
    const rootsOf = new Map<string, UnitRow[]>();
    for (const unit of visible) {
      const target = unit.parent_unit_id ? childrenOf : rootsOf;
      const key = unit.parent_unit_id ?? headingFor(unit);
      const list = target.get(key) ?? [];
      list.push(unit);
      target.set(key, list);
    }
    const node = (unit: UnitRow): PublicUnit => ({
      id: unit.id,
      name: unit.name,
      organizationType: unit.organization_type,
      aliases: publicAliases(
        unit.name,
        unit.aliases ? (JSON.parse(unit.aliases) as string[]) : [],
      ),
      people: homePeople.get(unit.id) ?? [],
      children: (childrenOf.get(unit.id) ?? []).sort(byOrder).map(node),
    });

    const unitsUnder = (id: string): PublicUnit[] =>
      (rootsOf.get(id) ?? []).sort(byOrder).map(node);
    const publicGroups: PublicGroup[] = [...groups]
      .sort(byOrder)
      .map((group) => ({
        id: group.id,
        name: group.name,
        units: unitsUnder(group.id),
      }));
    for (const heading of [...CATEGORIES, OTHER]) {
      const units = unitsUnder(heading.id);
      if (units.length > 0)
        publicGroups.push({ id: heading.id, name: heading.name, units });
    }
    return {
      countyFips,
      groups: publicGroups,
      electedOfficials,
      empty: groups.length === 0 && units.length === 0,
    };
  }
}

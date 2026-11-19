import type { SyncEntity } from "../contracts/sync.js";
import type { AsyncD1Database } from "../database/d1.js";

/** D1 allows 100 bound parameters per query; one more is the row limit. */
const ID_CHUNK = 90;
/** An organization has at most 64 counties times 3 relationship types. */
const AFFILIATION_ORG_CHUNK = 5;
const MAX_ID_LENGTH = 128;
const TABLES = new Set<SyncEntity>([
  "organizations",
  "organization_county_affiliations",
  "people",
  "positions",
  "role_sources",
  "person_roles",
  "profile_names",
]);
const ID_FIELDS: Readonly<Record<string, SyncEntity>> = {
  organization_id: "organizations",
  parent_organization_id: "organizations",
  person_id: "people",
  position_id: "positions",
  source_id: "role_sources",
};

export type SourceRow = {
  id: string;
  title: unknown;
  source_type: unknown;
  publisher_classification: unknown;
  version: unknown;
};

/**
 * Set-based Website reads for one sync plan. `prefetch` loads every record,
 * county, source URL and affiliation the request names in bounded `IN` queries
 * (one per entity and chunk), instead of one query per item. Any value it did not
 * prefetch is read individually and cached, so a lookup is never answered from a
 * guess.
 *
 * Reusing one instance for a later plan or for commit preparation is correct only
 * while the caller's dependency-generation guard covers every table read here:
 * any write to them advances the generation, and the guarded commit then fails.
 */
export class SyncPlanReads {
  private readonly rows = new Map<string, Record<string, unknown> | null>();
  private readonly counties = new Map<string, boolean>();
  private readonly sources = new Map<string, SourceRow | null>();
  private readonly affiliations = new Set<string>();
  private readonly affiliationOrgs = new Set<string>();
  /** D1 queries this instance has sent. */
  queries = 0;

  constructor(readonly db: AsyncD1Database) {}

  async prefetch(input: unknown): Promise<void> {
    if (!isRecord(input) || !Array.isArray(input.changes)) return;
    const ids = new Map<SyncEntity, Set<string>>();
    const counties = new Set<string>();
    const urls = new Set<string>();
    const affiliationOrgs = new Set<string>();
    const want = (entity: SyncEntity, id: unknown) => {
      if (!validId(id)) return;
      let set = ids.get(entity);
      if (!set) {
        set = new Set();
        ids.set(entity, set);
      }
      set.add(id);
    };
    for (const change of input.changes) {
      if (!isRecord(change)) continue;
      const fields = isRecord(change.fields) ? change.fields : {};
      if (
        change.op === "update_record" &&
        typeof change.entity === "string" &&
        TABLES.has(change.entity as SyncEntity)
      )
        want(change.entity as SyncEntity, change.targetId);
      for (const [field, entity] of Object.entries(ID_FIELDS))
        if (Object.hasOwn(fields, field)) want(entity, fields[field]);
      if (
        typeof fields.county_fips === "string" &&
        fields.county_fips.length <= 5
      )
        counties.add(fields.county_fips);
      if (
        change.op === "register_source" &&
        typeof fields.url === "string" &&
        fields.url.length <= 2048
      )
        urls.add(fields.url);
      if (
        change.op === "add_county_affiliation" &&
        validId(fields.organization_id)
      )
        affiliationOrgs.add(fields.organization_id);
    }
    if (Array.isArray(input.duplicateFlags))
      for (const flag of input.duplicateFlags) {
        if (!isRecord(flag)) continue;
        want("people", flag.targetRef);
        want("people", flag.possibleDuplicateOf);
        if (Array.isArray(flag.evidenceSourceRefs))
          for (const ref of flag.evidenceSourceRefs) want("role_sources", ref);
      }

    for (const [entity, set] of ids)
      for (const chunk of chunks([...set], ID_CHUNK)) {
        const found = await this.read<Record<string, unknown>>(
          `SELECT * FROM "${entity}" WHERE id IN (${marks(chunk.length)})`,
          chunk.length,
          chunk,
        );
        for (const id of chunk) this.rows.set(key(entity, id), null);
        for (const row of found)
          this.rows.set(key(entity, String(row.id)), row);
      }
    for (const chunk of chunks([...counties], ID_CHUNK)) {
      const found = await this.read<{ fips: string }>(
        `SELECT fips FROM counties WHERE fips IN (${marks(chunk.length)})`,
        chunk.length,
        chunk,
      );
      for (const fips of chunk) this.counties.set(fips, false);
      for (const row of found) this.counties.set(row.fips, true);
    }
    for (const chunk of chunks([...urls], ID_CHUNK)) {
      const found = await this.read<SourceRow & { url: string }>(
        `SELECT id, url, title, source_type, publisher_classification, version FROM role_sources WHERE url IN (${marks(chunk.length)})`,
        chunk.length,
        chunk,
      );
      for (const url of chunk) this.sources.set(url, null);
      for (const row of found) this.sources.set(row.url, sourceRow(row));
    }
    for (const chunk of chunks([...affiliationOrgs], AFFILIATION_ORG_CHUNK)) {
      const found = await this.read<{
        organization_id: string;
        county_fips: string;
        relationship_type: string;
      }>(
        `SELECT organization_id, county_fips, relationship_type FROM organization_county_affiliations WHERE organization_id IN (${marks(chunk.length)})`,
        1_000,
        chunk,
      );
      if (found.length >= 1_000) continue; // unexpectedly many: read individually
      for (const id of chunk) this.affiliationOrgs.add(id);
      for (const row of found)
        this.affiliations.add(
          JSON.stringify([
            row.organization_id,
            row.county_fips,
            row.relationship_type,
          ]),
        );
    }
  }

  /** The current row, or null when no record has this ID. */
  async row(
    entity: SyncEntity,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const cacheKey = key(entity, id);
    if (this.rows.has(cacheKey)) return this.rows.get(cacheKey) ?? null;
    this.queries++;
    const row = await this.db.first<Record<string, unknown>>(
      `SELECT * FROM "${entity}" WHERE id = ?`,
      [id],
    );
    this.rows.set(cacheKey, row ?? null);
    return row ?? null;
  }

  async exists(entity: SyncEntity, id: string): Promise<boolean> {
    return (await this.row(entity, id)) !== null;
  }

  async countyExists(value: unknown): Promise<boolean> {
    if (typeof value !== "string") return false;
    const known = this.counties.get(value);
    if (known !== undefined) return known;
    this.queries++;
    const found = !!(await this.db.first(
      "SELECT 1 AS found FROM counties WHERE fips = ?",
      [value],
    ));
    this.counties.set(value, found);
    return found;
  }

  async sourceByUrl(url: string): Promise<SourceRow | null> {
    if (this.sources.has(url)) return this.sources.get(url) ?? null;
    this.queries++;
    const row = await this.db.first<SourceRow>(
      "SELECT id, title, source_type, publisher_classification, version FROM role_sources WHERE url = ?",
      [url],
    );
    const value = row ? sourceRow(row) : null;
    this.sources.set(url, value);
    return value;
  }

  async affiliationExists(
    organizationId: string,
    countyFips: string,
    relationshipType: string,
  ): Promise<boolean> {
    const entry = JSON.stringify([
      organizationId,
      countyFips,
      relationshipType,
    ]);
    if (this.affiliationOrgs.has(organizationId))
      return this.affiliations.has(entry);
    this.queries++;
    const found = !!(await this.db.first(
      "SELECT 1 AS found FROM organization_county_affiliations WHERE organization_id = ? AND county_fips = ? AND relationship_type = ?",
      [organizationId, countyFips, relationshipType],
    ));
    if (found) this.affiliations.add(entry);
    return found;
  }

  private async read<Row>(
    sql: string,
    limit: number,
    values: readonly string[],
  ): Promise<readonly Row[]> {
    this.queries++;
    return this.db.all<Row>(sql, limit, values);
  }
}

function sourceRow(row: SourceRow): SourceRow {
  return {
    id: row.id,
    title: row.title,
    source_type: row.source_type,
    publisher_classification: row.publisher_classification,
    version: row.version,
  };
}

function key(entity: SyncEntity, id: string): string {
  return `${entity}\u0000${id}`;
}

function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    out.push(values.slice(i, i + size));
  return out;
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

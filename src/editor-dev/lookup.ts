import {
  DIRECTORY_LOOKUP_DEFAULT_LIMIT,
  DIRECTORY_LOOKUP_KINDS,
  DIRECTORY_LOOKUP_MAX_IDS,
  DIRECTORY_LOOKUP_MAX_LIMIT,
  DIRECTORY_LOOKUP_MAX_QUERY_LENGTH,
  DIRECTORY_LOOKUP_MAX_QUERY_WORDS,
  type DirectoryLookupKind,
  type DirectoryLookupResult,
  type OrganizationLookupItem,
  type PersonLookupItem,
  SANDBOX_ORGANIZATION_TYPES,
  type SandboxAffiliationType,
  type SandboxOrganizationType,
  type SandboxParentRelationship,
} from "../contracts/editor-lookup.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

/**
 * Bounded, read-only lookup over the sandbox's own fictional Website database.
 * Every query is parameterized, results are capped, and nothing here writes.
 */
export class LookupRequestError extends Error {
  constructor() {
    super("invalid_request");
    this.name = "LookupRequestError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const hasControlCharacter = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
const REQUEST_KEYS = new Set(["kind", "query", "ids", "limit"]);

export interface ParsedLookup {
  readonly kind: DirectoryLookupKind;
  readonly words: readonly string[];
  readonly ids: readonly string[] | null;
  readonly limit: number;
}

export function parseLookupRequest(value: unknown): ParsedLookup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LookupRequestError();
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key)) throw new LookupRequestError();
  }
  const kind = input.kind;
  if (
    typeof kind !== "string" ||
    !(DIRECTORY_LOOKUP_KINDS as readonly string[]).includes(kind)
  ) {
    throw new LookupRequestError();
  }
  let limit = DIRECTORY_LOOKUP_DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > DIRECTORY_LOOKUP_MAX_LIMIT
    ) {
      throw new LookupRequestError();
    }
    limit = input.limit;
  }
  if (input.ids !== undefined) {
    if (input.query !== undefined || !Array.isArray(input.ids)) {
      throw new LookupRequestError();
    }
    if (input.ids.length > DIRECTORY_LOOKUP_MAX_IDS) {
      throw new LookupRequestError();
    }
    const ids: string[] = [];
    for (const id of input.ids) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        throw new LookupRequestError();
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return { kind: kind as DirectoryLookupKind, words: [], ids, limit };
  }
  let words: string[] = [];
  if (input.query !== undefined) {
    if (
      typeof input.query !== "string" ||
      input.query.length > DIRECTORY_LOOKUP_MAX_QUERY_LENGTH ||
      hasControlCharacter(input.query)
    ) {
      throw new LookupRequestError();
    }
    words = input.query.split(/\s+/).filter((word) => word !== "");
    if (words.length > DIRECTORY_LOOKUP_MAX_QUERY_WORDS) {
      throw new LookupRequestError();
    }
  }
  return { kind: kind as DirectoryLookupKind, words, ids: null, limit };
}

const escapeLike = (word: string) => word.replace(/[\\%_]/g, (c) => `\\${c}`);

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export function runLookup(
  database: WebsiteDatabase,
  request: ParsedLookup,
): DirectoryLookupResult<PersonLookupItem | OrganizationLookupItem> {
  return request.kind === "person"
    ? lookupPeople(database, request)
    : lookupOrganizations(database, request);
}

function lookupPeople(
  database: WebsiteDatabase,
  request: ParsedLookup,
): DirectoryLookupResult<PersonLookupItem> {
  const rows = selectRows(database, request, {
    table: "people p",
    columns: "p.id AS id, p.display_name AS name",
    nameColumn: "p.display_name",
    idColumn: "p.id",
    extraMatch: () => null,
  });
  const items = rows.items.map((row) => ({
    id: str(row.id),
    name: str(row.name),
    roles: database
      .prepare(
        `SELECT pos.title AS title, o.name AS organization_name
         FROM person_roles pr
         JOIN positions pos ON pos.id = pr.position_id
         JOIN organizations o ON o.id = pos.organization_id
         WHERE pr.person_id = ?
         ORDER BY pos.title COLLATE NOCASE, pr.id
         LIMIT 3`,
      )
      .all(str(row.id))
      .map((role) => ({
        title: str(role.title),
        organizationName: str(role.organization_name),
      })),
  }));
  return finish("person", request, items, rows.hasMore);
}

function lookupOrganizations(
  database: WebsiteDatabase,
  request: ParsedLookup,
): DirectoryLookupResult<OrganizationLookupItem> {
  const rows = selectRows(database, request, {
    table: "organizations p",
    columns:
      "p.id AS id, p.name AS name, p.organization_type AS type, p.county_fips AS county_fips, p.parent_organization_id AS parent_id, p.parent_relationship AS parent_relationship",
    nameColumn: "p.name",
    idColumn: "p.id",
    // A county name also finds the organizations in that county.
    extraMatch: () =>
      "EXISTS (SELECT 1 FROM counties c WHERE c.fips = p.county_fips AND c.name LIKE ? ESCAPE '\\')",
  });
  const items = rows.items.map((row): OrganizationLookupItem => {
    const type = str(row.type);
    const countyFips = row.county_fips === null ? null : str(row.county_fips);
    const county =
      countyFips === null
        ? null
        : (() => {
            const found = database
              .prepare("SELECT name FROM counties WHERE fips = ?")
              .get(countyFips);
            return found ? { fips: countyFips, name: str(found.name) } : null;
          })();
    const parentRow =
      row.parent_id === null
        ? undefined
        : database
            .prepare("SELECT id, name FROM organizations WHERE id = ?")
            .get(str(row.parent_id));
    return {
      id: str(row.id),
      name: str(row.name),
      type: (SANDBOX_ORGANIZATION_TYPES as readonly string[]).includes(type)
        ? (type as SandboxOrganizationType)
        : "other",
      county,
      parent: parentRow
        ? {
            id: str(parentRow.id),
            name: str(parentRow.name),
            relationship: str(
              row.parent_relationship,
            ) as SandboxParentRelationship,
          }
        : null,
      affiliations: database
        .prepare(
          `SELECT a.county_fips AS fips, c.name AS name, a.relationship_type AS relationship_type
           FROM organization_county_affiliations a
           JOIN counties c ON c.fips = a.county_fips
           WHERE a.organization_id = ?
           ORDER BY c.name COLLATE NOCASE, a.relationship_type
           LIMIT 10`,
        )
        .all(str(row.id))
        .map((affiliation) => ({
          fips: str(affiliation.fips),
          name: str(affiliation.name),
          relationshipType: str(
            affiliation.relationship_type,
          ) as SandboxAffiliationType,
        })),
    };
  });
  return finish("organization", request, items, rows.hasMore);
}

interface SelectSpec {
  readonly table: string;
  readonly columns: string;
  readonly nameColumn: string;
  readonly idColumn: string;
  readonly extraMatch: () => string | null;
}

function selectRows(
  database: WebsiteDatabase,
  request: ParsedLookup,
  spec: SelectSpec,
): { items: Record<string, unknown>[]; hasMore: boolean } {
  if (request.ids !== null) {
    if (request.ids.length === 0) return { items: [], hasMore: false };
    const marks = request.ids.map(() => "?").join(",");
    const items = database
      .prepare(
        `SELECT ${spec.columns} FROM ${spec.table}
         WHERE ${spec.idColumn} IN (${marks})
         ORDER BY ${spec.nameColumn} COLLATE NOCASE, ${spec.idColumn}`,
      )
      .all(...request.ids);
    return { items, hasMore: false };
  }
  const conditions: string[] = [];
  const parameters: string[] = [];
  for (const word of request.words) {
    const pattern = `%${escapeLike(word)}%`;
    const extra = spec.extraMatch();
    conditions.push(
      `(${spec.nameColumn} LIKE ? ESCAPE '\\' OR ${spec.idColumn} LIKE ? ESCAPE '\\'${extra ? ` OR ${extra}` : ""})`,
    );
    parameters.push(pattern, pattern);
    if (extra) parameters.push(pattern);
  }
  const rows = database
    .prepare(
      `SELECT ${spec.columns} FROM ${spec.table}
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY ${spec.nameColumn} COLLATE NOCASE, ${spec.idColumn}
       LIMIT ${request.limit + 1}`,
    )
    .all(...parameters);
  return {
    items: rows.slice(0, request.limit),
    hasMore: rows.length > request.limit,
  };
}

function finish<T extends { readonly id: string }>(
  kind: DirectoryLookupKind,
  request: ParsedLookup,
  items: T[],
  hasMore: boolean,
): DirectoryLookupResult<T> {
  const found = new Set(items.map((item) => item.id));
  return {
    kind,
    items,
    hasMore,
    missingIds:
      request.ids === null ? [] : request.ids.filter((id) => !found.has(id)),
  };
}

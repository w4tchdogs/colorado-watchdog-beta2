import {
  DEFAULT_DIRECTORY_PAGE_SIZE,
  type DirectoryPage,
  MAX_DIRECTORY_PAGE_SIZE,
  type OrganizationType,
} from "../contracts/directory.js";
import type {
  DirectoryBrowseRequest,
  DirectorySearchRequest,
  OrganizationSearchPage,
  OrganizationSearchResult,
  PersonSearchPage,
  PersonSearchResult,
} from "../contracts/directory-search.js";
import type { WebsiteDatabase } from "../database/sqlite.js";

import type { DirectoryQueryRunner } from "./officials-directory.js";

type SearchKind = "people" | "organizations";
type SearchConfig = {
  readonly table: "people" | "organizations";
  readonly nameColumn: "display_name" | "name";
};
type SearchCursor = {
  readonly version: 1;
  readonly kind: SearchKind;
  readonly query: string;
  readonly id: string;
};
type SearchInput = {
  readonly query: string;
  readonly limit: number;
  readonly cursorId: string | null;
};

const SEARCH_CONFIG: Record<SearchKind, SearchConfig> = {
  people: { table: "people", nameColumn: "display_name" },
  organizations: { table: "organizations", nameColumn: "name" },
};
const MAX_SEARCH_QUERY_LENGTH = 100;
const MAX_CURSOR_LENGTH = 2048;

export class DirectorySearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectorySearchInputError";
  }
}

export function searchPeople(
  database: WebsiteDatabase,
  request: DirectorySearchRequest,
): PersonSearchPage {
  return searchRecords(database, request, "people", personResult);
}

function personResult(row: Record<string, unknown>): PersonSearchResult {
  return {
    id: asString(row.id),
    displayName: asString(row.name),
    version: asNumber(row.version),
  };
}

export function searchOrganizations(
  database: WebsiteDatabase,
  request: DirectorySearchRequest,
): OrganizationSearchPage {
  return searchRecords(database, request, "organizations", organizationResult);
}

function organizationResult(
  row: Record<string, unknown>,
): OrganizationSearchResult {
  return {
    id: asString(row.id),
    name: asString(row.name),
    type: row.organization_type as OrganizationType,
    version: asNumber(row.version),
  };
}

export function browsePeople(
  runner: DirectoryQueryRunner,
  request: DirectoryBrowseRequest,
): Promise<PersonSearchPage> {
  return browseRecords(runner, request, "people", personResult);
}

export function browseOrganizations(
  runner: DirectoryQueryRunner,
  request: DirectoryBrowseRequest,
): Promise<OrganizationSearchPage> {
  return browseRecords(runner, request, "organizations", organizationResult);
}

async function browseRecords<T>(
  runner: DirectoryQueryRunner,
  request: DirectoryBrowseRequest,
  kind: SearchKind,
  project: (row: Record<string, unknown>) => T,
): Promise<DirectoryPage<T>> {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => key !== "limit" && key !== "cursor")
  ) {
    throw new DirectorySearchInputError("browse request is malformed");
  }
  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new DirectorySearchInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }

  const { table, nameColumn } = SEARCH_CONFIG[kind];
  const sort = `${nameColumn} COLLATE NOCASE, id COLLATE BINARY`;
  let after: readonly string[] = [];
  if (request.cursor != null) {
    const cursor =
      typeof request.cursor === "string" && request.cursor.length <= 256
        ? /^browse1\.(people|organizations)\.([A-Za-z0-9._:-]{1,128})\.([a-f0-9]{64})$/.exec(
            request.cursor,
          )
        : null;
    const id = cursor?.[2];
    if (!id || cursor?.[1] !== kind) {
      throw new DirectorySearchInputError(
        "cursor is malformed or incompatible",
      );
    }
    const anchor = await runner.first(
      `SELECT ${nameColumn} AS name FROM ${table} WHERE id = ?`,
      [id],
    );
    if (
      !anchor ||
      request.cursor !== (await browseCursor(kind, id, asString(anchor.name)))
    ) {
      throw new DirectorySearchInputError("cursor is invalid or stale");
    }
    after = [asString(anchor.name), id];
  }

  const rows = await runner.all(
    `SELECT id, ${nameColumn} AS name, version
            ${kind === "organizations" ? ", organization_type" : ""}
     FROM ${table}
     ${after.length ? `WHERE (${sort}) > (?, ?)` : ""}
     ORDER BY ${sort}
     LIMIT ?`,
    limit + 1,
    [...after, limit + 1],
  );
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(project),
    hasMore,
    nextCursor:
      hasMore && last
        ? await browseCursor(kind, asString(last.id), asString(last.name))
        : null,
  };
}

async function browseCursor(kind: SearchKind, id: string, name: string) {
  // Detect changes to the anchor's public sort key without embedding the name.
  const bytes = new TextEncoder().encode(JSON.stringify([kind, id, name]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `browse1.${kind}.${id}.${fingerprint}`;
}

function searchRecords<T>(
  database: WebsiteDatabase,
  request: DirectorySearchRequest,
  kind: SearchKind,
  project: (row: Record<string, unknown>) => T,
): DirectoryPage<T> {
  const input = validateRequest(request, kind);
  const config = SEARCH_CONFIG[kind];
  const pattern = `%${escapeLike(input.query)}%`;
  let afterName: string | null = null;

  if (input.cursorId !== null) {
    const cursorRow = database
      .prepare(
        `SELECT ${config.nameColumn} AS name
         FROM ${config.table}
         WHERE id = ? AND ${config.nameColumn} LIKE ? ESCAPE '\\'`,
      )
      .get(input.cursorId, pattern);
    if (!cursorRow) {
      throw new DirectorySearchInputError("cursor is invalid or stale");
    }
    afterName = asString(cursorRow.name);
  }

  const rows = database
    .prepare(
      `SELECT id, ${config.nameColumn} AS name, version
              ${kind === "organizations" ? ", organization_type" : ""}
       FROM ${config.table}
       WHERE ${config.nameColumn} LIKE ? ESCAPE '\\'
         AND (? IS NULL OR
              ${config.nameColumn} COLLATE NOCASE > ? COLLATE NOCASE OR
              (${config.nameColumn} COLLATE NOCASE = ? COLLATE NOCASE
               AND id COLLATE BINARY > ? COLLATE BINARY))
       ORDER BY ${config.nameColumn} COLLATE NOCASE, id COLLATE BINARY
       LIMIT ?`,
    )
    .all(
      pattern,
      afterName,
      afterName,
      afterName,
      input.cursorId,
      input.limit + 1,
    );
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const last = selected.at(-1);
  return {
    items: selected.map(project),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            version: 1,
            kind,
            query: input.query,
            id: asString(last.id),
          })
        : null,
  };
}

function validateRequest(
  request: DirectorySearchRequest,
  kind: SearchKind,
): SearchInput {
  const allowedFields = new Set(["query", "limit", "cursor"]);
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => !allowedFields.has(key)) ||
    typeof request.query !== "string"
  ) {
    throw new DirectorySearchInputError("search request is malformed");
  }

  const query = request.query.trim();
  if (query.length < 2 || query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new DirectorySearchInputError(
      `query must contain 2 to ${MAX_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  const limit = request.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIRECTORY_PAGE_SIZE
  ) {
    throw new DirectorySearchInputError(
      `limit must be an integer from 1 to ${MAX_DIRECTORY_PAGE_SIZE}`,
    );
  }

  const cursor = request.cursor ?? null;
  if (cursor === null) return { query, limit, cursorId: null };
  if (typeof cursor !== "string") {
    throw new DirectorySearchInputError("cursor is malformed");
  }
  const cursorId = decodeCursor(cursor, kind, query);
  if (cursorId === null) {
    throw new DirectorySearchInputError("cursor is malformed or incompatible");
  }
  return { query, limit, cursorId };
}

function decodeCursor(
  cursor: string,
  kind: SearchKind,
  query: string,
): string | null {
  if (
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    return null;
  }

  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const value = decoded as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 ||
      value.version !== 1 ||
      value.kind !== kind ||
      value.query !== query ||
      typeof value.id !== "string" ||
      value.id.length < 1 ||
      value.id.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value.id)
    ) {
      return null;
    }
    return value.id;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: SearchCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid directory search record");
  }
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Invalid directory search record");
  }
  return value;
}

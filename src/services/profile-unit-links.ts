import type {
  ProfileUnitLink,
  ProfileUnitLinkPreview,
  ProfileUnitLinkReceipt,
  ProfileUnitLinkState,
  ProfileUnitSuggestions,
} from "../contracts/profiles.js";
import type { AsyncD1Database } from "../database/d1.js";
import { authorizeCountyStructure } from "./county-structure-auth.js";
import { sha256Hex } from "./county-structure-plan.js";
import type { TrustedPrincipal } from "./security.js";

type Scope = {
  readonly sql: string;
  readonly values: readonly (string | number)[];
};

const SUGGESTION_ACTION = "county_structure.role_attachment.suggested";

function unitPaths(seeds: string): string {
  return `paths(id, unit_id, path) AS (
    ${seeds}
    UNION ALL
    SELECT parent.id, p.unit_id, parent.name || ' › ' || p.path
    FROM paths p JOIN county_unit child ON child.id = p.id
    JOIN county_unit parent ON parent.id = child.parent_unit_id
  )`;
}

/** Compare names after folding the typographic right apostrophe to ASCII. */
const unitNameKey = (expression: string) =>
  `replace(${expression}, char(8217), char(39))`;

// A display group is a heading, so only county_unit is eligible to match.
function classified(scope: Scope): string {
  return `WITH RECURSIVE scope AS MATERIALIZED (${scope.sql}),
    names AS (
      SELECT county_fips, ${unitNameKey("name")} AS name_key,
             COUNT(*) AS total, MIN(id) AS unit_id
      FROM county_unit GROUP BY county_fips, name_key COLLATE BINARY
    ),
    homes AS (
      SELECT d.person_role_id, COUNT(*) AS total, MIN(d.unit_id) AS unit_id,
        MAX(EXISTS (
          SELECT 1 FROM audit_events e WHERE e.id = d.id AND e.action = '${SUGGESTION_ACTION}'
            AND d.version = 1 AND json_extract(e.details_json, '$.unitId') = d.unit_id
            AND ${unitNameKey("json_extract(e.details_json, '$.office')")} = ${unitNameKey("s.office")} COLLATE BINARY
        )) AS suggested
      FROM scope s JOIN county_role_display d ON d.person_role_id = s.role_id
      WHERE d.listing = 'home' GROUP BY d.person_role_id
    ),
    classified AS (
      SELECT s.*, n.unit_id, ${unitNameKey("s.office")} AS office_key,
        CASE WHEN h.total = 1 AND
               (h.suggested = 1 OR (n.total = 1 AND h.unit_id = n.unit_id)) THEN 'linked'
             WHEN h.total IS NOT NULL THEN 'review'
             WHEN n.total > 1 THEN 'multiple'
             WHEN n.total = 1 THEN 'ready'
             ELSE 'unmatched' END AS state
      FROM scope s LEFT JOIN names n ON n.county_fips = s.county_fips
        AND n.name_key = ${unitNameKey("s.office")} COLLATE BINARY
      LEFT JOIN homes h ON h.person_role_id = s.role_id
    )`;
}

export async function readProfileUnitLinks(
  database: AsyncD1Database,
  roles: readonly {
    readonly roleId: string;
    readonly countyFips: string | null;
    readonly office: string | null;
  }[],
): Promise<ReadonlyMap<string, ProfileUnitLink>> {
  if (roles.length === 0) return new Map();
  const scope = {
    sql: `SELECT json_extract(value, '$.roleId') AS role_id,
                 json_extract(value, '$.countyFips') AS county_fips,
                 json_extract(value, '$.office') AS office FROM json_each(?)`,
    values: [JSON.stringify(roles)],
  };
  const rows = await database.all<{
    role_id: string;
    state: ProfileUnitLinkState;
    paths: string;
  }>(
    `${classified(scope)},
      ${unitPaths(`
        SELECT u.id, u.id, u.name
        FROM county_unit u
        WHERE EXISTS (SELECT 1 FROM classified c WHERE c.state = 'multiple'
          AND c.county_fips = u.county_fips AND c.office_key = ${unitNameKey("u.name")} COLLATE BINARY)
      `)}
      SELECT c.role_id, c.state, (SELECT json_group_array(
          COALESCE(g.name || ' › ', '') || p.path || ' (' || p.unit_id || ')'
          ORDER BY p.path, p.unit_id)
        FROM paths p JOIN county_unit root ON root.id = p.id
        LEFT JOIN county_unit_display g ON g.id = root.display_group_id
        JOIN county_unit leaf ON leaf.id = p.unit_id
        WHERE root.parent_unit_id IS NULL AND leaf.county_fips = c.county_fips
          AND ${unitNameKey("leaf.name")} = c.office_key COLLATE BINARY AND c.state = 'multiple') AS paths
      FROM classified c`,
    roles.length,
    scope.values,
  );
  return new Map(
    rows.map((row) => [
      row.role_id,
      { state: row.state, paths: JSON.parse(row.paths) as string[] },
    ]),
  );
}

const ACTION = "county_structure.role_attachment.exact";
const PLAN_CHUNK = 800;
const MAX_PLAN_ROWS = 1000;

export class ProfileUnitLinkError extends Error {
  constructor(
    readonly code: "stale_preview" | "idempotency_conflict" | "scope_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ProfileUnitLinkError";
  }
}

type PlanRow = {
  part: number;
  state: ProfileUnitLinkState;
  total: number;
  pairs: string;
};

export function createProfileUnitLinks(database: AsyncD1Database) {
  async function replaySaved(
    principal: TrustedPrincipal,
    key: string,
    fingerprint: string,
  ) {
    const stored = await database.first<{
      request_fingerprint: string;
      response_json: string;
    }>(
      `SELECT request_fingerprint, response_json FROM profile_write_receipts
       WHERE actor_account_id = ? AND idempotency_key = ?`,
      [principal.accountId, key],
    );
    if (!stored) return null;
    if (stored.request_fingerprint !== fingerprint)
      throw new ProfileUnitLinkError(
        "idempotency_conflict",
        "This key belongs to another review.",
      );
    return {
      ...(JSON.parse(stored.response_json) as ProfileUnitLinkReceipt),
      replayed: true,
    };
  }

  const saveReceipt = (
    principal: TrustedPrincipal,
    key: string,
    fingerprint: string,
    receipt: ProfileUnitLinkReceipt,
  ) =>
    database.prepare(
      `INSERT INTO profile_write_receipts
       (actor_account_id, idempotency_key, request_fingerprint, response_json)
       VALUES (?, ?, ?, ?)`,
      [principal.accountId, key, fingerprint, JSON.stringify(receipt)],
    );

  const assertion = (total: number) =>
    database.prepare(
      "INSERT INTO website_write_assertions (id, valid) VALUES (?, changes() = ?)",
      [crypto.randomUUID(), total],
    );

  async function suggestions(roleId: string) {
    const role = await database.first<{
      county_fips: string | null;
      office: string | null;
      version: number;
    }>(
      `SELECT COALESCE(r.county_fips, o.county_fips) AS county_fips,
              COALESCE(r.published_office, o.name) AS office, r.version
       FROM person_roles r
       LEFT JOIN positions pos ON pos.id = r.position_id
       LEFT JOIN organizations o ON o.id = pos.organization_id
       WHERE r.id = ? AND NOT EXISTS (
         SELECT 1 FROM county_role_display d WHERE d.person_role_id = r.id AND d.listing = 'home')`,
      [roleId],
    );
    if (!role)
      throw new ProfileUnitLinkError(
        "stale_preview",
        "This role is no longer available for linking. Refresh Profiles.",
      );
    const prefix = role.office?.trim().toLowerCase() ?? "";
    if (!role.county_fips || prefix.length < 2) return { role, units: [] };
    const candidates = await database.all<{
      id: string;
      path: string;
      version: number;
    }>(
      `WITH RECURSIVE prefixes(value) AS (
         VALUES(${unitNameKey("?")}) UNION ALL SELECT substr(value, 1, length(value) - 1)
         FROM prefixes WHERE length(value) > 3
       ), candidates AS (
         SELECT u.id, u.name, u.version, MAX(length(p.value)) AS score
         FROM county_unit u JOIN prefixes p ON substr(lower(${unitNameKey("u.name")}), 1, length(p.value)) = p.value
         WHERE u.county_fips = ? AND u.status = 'active'
         GROUP BY u.id
         ORDER BY score DESC, length(u.name), u.name COLLATE NOCASE, u.id
         LIMIT 5
       ), ${unitPaths("SELECT id, id, name FROM candidates")}
       SELECT c.id, c.version, COALESCE(g.name || ' › ', '') || p.path AS path
       FROM candidates c JOIN paths p ON p.unit_id = c.id
       JOIN county_unit root ON root.id = p.id
       LEFT JOIN county_unit_display g ON g.id = root.display_group_id
       WHERE root.parent_unit_id IS NULL
       ORDER BY c.score DESC, length(c.name), c.name COLLATE NOCASE, c.id`,
      5,
      [prefix, role.county_fips],
    );
    return {
      role,
      units: await Promise.all(
        candidates.map(async (unit) => ({
          unitId: unit.id,
          path: unit.path,
          version: unit.version,
          digest: await sha256Hex(JSON.stringify([roleId, role, unit])),
        })),
      ),
    };
  }

  async function plan(scope: Scope) {
    // Group reviewed IDs into bounded D1 cells, retaining deterministic order
    // across the whole filtered set. The API returns only summary counts.
    const rows = await database.all<PlanRow>(
      `${classified(scope)},
        ordered AS (
          SELECT role_id, county_fips, unit_id,
            (ROW_NUMBER() OVER (ORDER BY role_id COLLATE BINARY) - 1) / ${PLAN_CHUNK} + 1 AS part
          FROM classified WHERE state = 'ready'
        )
        SELECT 0 AS part, state, COUNT(*) AS total, '' AS pairs
        FROM classified GROUP BY state
        UNION ALL
        SELECT part, 'ready', COUNT(*),
          json_group_array(json_array(role_id, county_fips, unit_id) ORDER BY role_id COLLATE BINARY)
        FROM ordered GROUP BY part
        ORDER BY part, state`,
      MAX_PLAN_ROWS,
      scope.values,
    );
    const counts = {
      linked: 0,
      ready: 0,
      unmatched: 0,
      multiple: 0,
      review: 0,
    };
    const parts: PlanRow[] = [];
    for (const row of rows) {
      if (row.part === 0) counts[row.state] = row.total;
      else parts.push(row);
    }
    if (parts.reduce((total, part) => total + part.total, 0) !== counts.ready)
      throw new ProfileUnitLinkError(
        "scope_too_large",
        "Too many matches for one batch. Filter by county and preview again.",
      );
    const digest = await sha256Hex(
      JSON.stringify([
        scope.sql,
        scope.values,
        counts,
        parts.map((part) => part.pairs),
      ]),
    );
    return { preview: { ...counts, digest }, parts };
  }

  const stale = () =>
    new ProfileUnitLinkError(
      "stale_preview",
      "Roles, units, or placements changed. Preview the exact matches again.",
    );

  return {
    async suggest(
      principal: TrustedPrincipal,
      roleId: string,
    ): Promise<ProfileUnitSuggestions> {
      await authorizeCountyStructure(database, principal);
      const { role, units } = await suggestions(roleId);
      return {
        office: role.office,
        units: units.map(({ unitId, path, digest }) => ({
          unitId,
          path,
          digest,
        })),
      };
    },
    async choose(
      principal: TrustedPrincipal,
      roleId: string,
      unitId: string,
      digest: string,
      key: string,
    ): Promise<ProfileUnitLinkReceipt> {
      await authorizeCountyStructure(database, principal);
      const fingerprint = await sha256Hex(
        JSON.stringify([SUGGESTION_ACTION, roleId, unitId, digest]),
      );
      const prior = await replaySaved(principal, key, fingerprint);
      if (prior) return prior;
      const generation = await database.readDependencyGeneration();
      const checkChoice = async () => {
        const { role, units } = await suggestions(roleId);
        const unit = units.find(
          (candidate) =>
            candidate.unitId === unitId && candidate.digest === digest,
        );
        if (!unit)
          throw new ProfileUnitLinkError(
            "stale_preview",
            "The suggestions changed. Review the role again.",
          );
        return { role, unit };
      };
      const { role, unit } = await checkChoice();
      // Sharing the attachment ID supports an indexed lookup of the owner's
      // reviewed spelling difference when displaying the link status.
      const attachmentId = crypto.randomUUID();
      const receipt = { attached: 1, replayed: false };
      try {
        await database.guardedBatch(generation, principal, [
          database.prepare(
            `INSERT INTO county_role_display
               (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
             SELECT ?, r.id, u.county_fips, u.id, 'home', ?
             FROM person_roles r
             LEFT JOIN positions pos ON pos.id = r.position_id
             LEFT JOIN organizations o ON o.id = pos.organization_id
             JOIN county_unit u ON u.county_fips = COALESCE(r.county_fips, o.county_fips)
             WHERE r.id = ? AND r.version = ? AND u.id = ? AND u.version = ?
               AND u.status = 'active' AND COALESCE(r.published_office, o.name) = ? COLLATE BINARY
               AND NOT EXISTS (
                 SELECT 1 FROM county_role_display d WHERE d.person_role_id = r.id AND d.listing = 'home')`,
            [
              attachmentId,
              principal.accountId,
              roleId,
              role.version,
              unitId,
              unit.version,
              role.office,
            ],
          ),
          assertion(1),
          database.prepare(
            `INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json)
             VALUES (?, ?, ?, 'county_structure', ?, ?, ?)`,
            [
              attachmentId,
              principal.accountId,
              SUGGESTION_ACTION,
              roleId,
              "Attached a Profile role to an owner-reviewed suggested unit",
              JSON.stringify({ office: role.office, unitId }),
            ],
          ),
          saveReceipt(principal, key, fingerprint, receipt),
        ]);
      } catch (error) {
        await authorizeCountyStructure(database, principal);
        const raced = await replaySaved(principal, key, fingerprint);
        if (raced) return raced;
        await checkChoice();
        throw error;
      }
      return receipt;
    },
    async preview(
      principal: TrustedPrincipal,
      scope: Scope,
    ): Promise<ProfileUnitLinkPreview> {
      await authorizeCountyStructure(database, principal);
      return (await plan(scope)).preview;
    },
    async commit(
      principal: TrustedPrincipal,
      scope: Scope,
      digest: string,
      key: string,
    ): Promise<ProfileUnitLinkReceipt> {
      await authorizeCountyStructure(database, principal);
      const fingerprint = await sha256Hex(
        JSON.stringify([ACTION, scope.sql, scope.values, digest]),
      );
      const replay = () => replaySaved(principal, key, fingerprint);
      const prior = await replay();
      if (prior) return prior;
      const generation = await database.readDependencyGeneration();
      const { preview, parts } = await plan(scope);
      if (preview.digest !== digest) throw stale();
      const receipt = { attached: preview.ready, replayed: false };
      if (!preview.ready) return receipt;
      const statements = parts.flatMap((part) => [
        database.prepare(
          `INSERT INTO county_role_display
             (id, person_role_id, county_fips, unit_id, listing, reviewed_by_account_id)
           SELECT lower(hex(randomblob(16))), r.id, u.county_fips, u.id, 'home', ?
           FROM json_each(?) j JOIN person_roles r ON r.id = json_extract(j.value, '$[0]')
           JOIN county_unit u ON u.id = json_extract(j.value, '$[2]')
              AND u.county_fips = json_extract(j.value, '$[1]')
           LEFT JOIN positions pos ON pos.id = r.position_id
           LEFT JOIN organizations o ON o.id = pos.organization_id
           WHERE u.county_fips = COALESCE(r.county_fips, o.county_fips)
             AND ${unitNameKey("u.name")} = ${unitNameKey("COALESCE(r.published_office, o.name)")} COLLATE BINARY
             AND NOT EXISTS (
               SELECT 1 FROM county_unit other
               WHERE other.county_fips = u.county_fips
                 AND ${unitNameKey("other.name")} = ${unitNameKey("u.name")} COLLATE BINARY
                 AND other.id <> u.id)
             AND NOT EXISTS (
               SELECT 1 FROM county_role_display d WHERE d.person_role_id = r.id AND d.listing = 'home')`,
          [principal.accountId, part.pairs],
        ),
        assertion(part.total),
      ]);
      statements.push(
        database.prepare(
          `INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json)
           VALUES (?, ?, ?, 'county_structure', ?, ?, ?)`,
          [
            crypto.randomUUID(),
            principal.accountId,
            ACTION,
            key,
            "Attached Profile roles to exact County Structure matches",
            JSON.stringify({ attached: String(receipt.attached), digest }),
          ],
        ),
        saveReceipt(principal, key, fingerprint, receipt),
      );
      try {
        await database.guardedBatch(generation, principal, statements);
      } catch (error) {
        await authorizeCountyStructure(database, principal);
        const raced = await replay();
        if (raced) return raced;
        if ((await plan(scope)).preview.digest !== digest) throw stale();
        throw error;
      }
      return receipt;
    },
  };
}

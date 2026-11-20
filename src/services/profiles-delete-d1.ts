import {
  PROFILE_DELETE_REASONS,
  type ProfileDeletePreview,
  type ProfileDeleteReceipt,
} from "../contracts/profiles-delete.js";
import type { AsyncD1Database } from "../database/d1.js";
import { personIsPublicSql } from "./person-visibility.js";
import { AuthorizationError, type TrustedPrincipal } from "./security.js";

export class ProfilesDeleteError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "stale_preview"
      | "delete_blocked"
      | "idempotency_conflict",
  ) {
    super(code);
  }
}

// Capture the review in one query. Preserve row IDs and versions in the token
// even when two different dependency sets have the same visible counts.
const SNAPSHOT_SQL = `
  WITH target AS (SELECT * FROM people WHERE id = ?),
       roles AS (SELECT r.* FROM person_roles r JOIN target p ON p.id = r.person_id),
       counties_for_roles AS (
         SELECT c.name FROM roles r
         LEFT JOIN positions pos ON pos.id = r.position_id
         LEFT JOIN organizations o ON o.id = pos.organization_id
         JOIN counties c ON c.fips = COALESCE(r.county_fips, o.county_fips)
         UNION
         SELECT c.name FROM roles r
         JOIN positions pos ON pos.id = r.position_id
         JOIN organization_county_affiliations a ON a.organization_id = pos.organization_id
         JOIN counties c ON c.fips = a.county_fips
       ),
       names AS (SELECT n.* FROM profile_names n JOIN target p ON p.id = n.person_id),
       links AS (SELECT d.* FROM county_role_display d JOIN roles r ON r.id = d.person_role_id)
  SELECT json_object(
    'id', p.id, 'name', p.display_name, 'version', p.version,
    'visible', ${personIsPublicSql("p.id")},
    'visibilityVersion', (SELECT version FROM person_visibility WHERE person_id = p.id),
    'counties', json((SELECT json_group_array(name) FROM (SELECT name FROM counties_for_roles ORDER BY name))),
    'roles', json((SELECT json_group_array(json_array(id, version)) FROM (SELECT id, version FROM roles ORDER BY id))),
    'names', json((SELECT json_group_array(json_array(id, version)) FROM (SELECT id, version FROM names ORDER BY id))),
    'links', json((SELECT json_group_array(json_array(id, version)) FROM (SELECT id, version FROM links ORDER BY id))),
    'reports', (SELECT COUNT(*) FROM reports WHERE subject_kind = 'person' AND subject_id = p.id),
    'editorialLinks', (SELECT COUNT(*) FROM content_item_people WHERE person_id = p.id),
    'duplicateReviews', (SELECT COUNT(*) FROM person_duplicate_flags
      WHERE person_id = p.id OR possible_duplicate_person_id = p.id)
  ) AS snapshot FROM target p`;

interface Snapshot {
  readonly id: string;
  readonly name: string;
  readonly visible: 0 | 1;
  readonly counties: string[];
  readonly roles: unknown[];
  readonly names: unknown[];
  readonly links: unknown[];
  readonly reports: number;
  readonly editorialLinks: number;
  readonly duplicateReviews: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createProfilesDelete(
  db: AsyncD1Database,
  requireOwner: (principal: TrustedPrincipal) => Promise<void>,
  now: () => Date,
) {
  async function authorize(principal: TrustedPrincipal): Promise<void> {
    if (principal.kind !== "human" || principal.role !== "owner")
      throw new AuthorizationError();
    await requireOwner(principal);
  }

  async function snapshot(id: string) {
    const row = await db.first<{ snapshot: string }>(SNAPSHOT_SQL, [id]);
    if (!row) throw new ProfilesDeleteError("not_found");
    const data = JSON.parse(row.snapshot) as Snapshot;
    const preview: ProfileDeletePreview = {
      profileId: data.id,
      displayName: data.name,
      counties: data.counties,
      visible: data.visible === 1,
      counts: {
        roles: data.roles.length,
        names: data.names.length,
        countyLinks: data.links.length,
      },
      blockers: {
        reports: data.reports,
        editorialLinks: data.editorialLinks,
        duplicateReviews: data.duplicateReviews,
      },
      digest: await hash(row.snapshot),
    };
    return { raw: row.snapshot, preview };
  }

  return {
    async previewDelete(
      principal: TrustedPrincipal,
      body: Record<string, unknown>,
    ): Promise<ProfileDeletePreview> {
      await authorize(principal);
      const { profileId } = body;
      if (typeof profileId !== "string" || !ID.test(profileId))
        throw new ProfilesDeleteError("invalid_request");
      return (await snapshot(profileId)).preview;
    },
    async commitDelete(
      principal: TrustedPrincipal,
      key: string,
      body: Record<string, unknown>,
    ): Promise<ProfileDeleteReceipt> {
      await authorize(principal);
      const { profileId, digest, confirmation, reason } = body;
      if (
        typeof profileId !== "string" ||
        !ID.test(profileId) ||
        typeof digest !== "string" ||
        !DIGEST.test(digest) ||
        confirmation !== "DELETE" ||
        !KEY.test(key) ||
        typeof reason !== "string" ||
        !Object.hasOwn(PROFILE_DELETE_REASONS, reason)
      )
        throw new ProfilesDeleteError("invalid_request");
      const fingerprint = await hash(
        JSON.stringify(["profile.delete", profileId, digest, reason]),
      );
      const replay = async () => {
        const prior = await db.first<{
          request_fingerprint: string;
          response_json: string;
        }>(
          "SELECT request_fingerprint, response_json FROM profile_write_receipts WHERE actor_account_id = ? AND idempotency_key = ?",
          [principal.accountId, key],
        );
        if (!prior) return null;
        if (prior.request_fingerprint !== fingerprint)
          throw new ProfilesDeleteError("idempotency_conflict");
        return {
          ...(JSON.parse(prior.response_json) as ProfileDeleteReceipt),
          replayed: true,
        };
      };
      const prior = await replay();
      if (prior) return prior;
      const generation = await db.readDependencyGeneration();
      const reviewed = await snapshot(profileId).catch(
        async (error: unknown) => {
          // The winning request can commit between the first receipt read and the snapshot.
          const winner = await replay();
          if (winner) return winner;
          throw error;
        },
      );
      if ("replayed" in reviewed) return reviewed;
      const { preview, raw } = reviewed;
      if (preview.digest !== digest)
        throw new ProfilesDeleteError("stale_preview");
      if (Object.values(preview.blockers).some((count) => count > 0))
        throw new ProfilesDeleteError("delete_blocked");
      const receipt = {
        profileId,
        deletedAt: now().toISOString(),
        counts: preview.counts,
        replayed: false,
      };
      try {
        await db.guardedBatch(generation, principal, [
          db.prepare(
            `INSERT INTO website_write_assertions (id, valid)
            SELECT ?, CASE WHEN (SELECT snapshot FROM (${SNAPSHOT_SQL})) = ? THEN 1 ELSE 0 END`,
            [crypto.randomUUID(), profileId, raw],
          ),
          db.prepare(
            `INSERT INTO profile_deleted_targets (entity, target_id, profile_id, deletion_generation)
            SELECT 'people', id, id, ?1 FROM people WHERE id = ?2
            UNION ALL SELECT 'person_roles', id, person_id, ?1 FROM person_roles WHERE person_id = ?2
            UNION ALL SELECT 'profile_names', id, person_id, ?1 FROM profile_names WHERE person_id = ?2`,
            [generation, profileId],
          ),
          db.prepare(
            "DELETE FROM county_role_display WHERE person_role_id IN (SELECT id FROM person_roles WHERE person_id = ?)",
            [profileId],
          ),
          db.prepare("DELETE FROM person_roles WHERE person_id = ?", [
            profileId,
          ]),
          db.prepare("DELETE FROM profile_names WHERE person_id = ?", [
            profileId,
          ]),
          db.prepare("DELETE FROM profile_legacy_names WHERE person_id = ?", [
            profileId,
          ]),
          // The publication trigger can add a visibility row when the last role is removed.
          db.prepare("DELETE FROM person_visibility WHERE person_id = ?", [
            profileId,
          ]),
          db.prepare("DELETE FROM people WHERE id = ?", [profileId]),
          db.prepare(
            `INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, summary, details_json, created_at)
            VALUES (?, ?, 'profile.delete', 'person', ?, 'Deleted a Website Profile', ?, ?)`,
            [
              crypto.randomUUID(),
              principal.accountId,
              profileId,
              JSON.stringify({ reason, counts: preview.counts }),
              receipt.deletedAt,
            ],
          ),
          db.prepare(
            `INSERT INTO profile_write_receipts (actor_account_id, idempotency_key, request_fingerprint, response_json)
            VALUES (?, ?, ?, ?)`,
            [principal.accountId, key, fingerprint, JSON.stringify(receipt)],
          ),
        ]);
      } catch (error) {
        const winner = await replay();
        if (winner) return winner;
        await authorize(principal);
        if ((await db.readDependencyGeneration()) !== generation)
          throw new ProfilesDeleteError("stale_preview");
        const current = await snapshot(profileId);
        if (current.preview.digest !== digest)
          throw new ProfilesDeleteError("stale_preview");
        throw error;
      }
      return receipt;
    },
  };
}

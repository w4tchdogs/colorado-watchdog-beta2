import type { PersonProfileAlternateName } from "../contracts/person-profile.js";
import {
  ALTERNATE_NAME_PUBLIC_LABELS,
  type AlternateNameType,
} from "../contracts/profiles.js";

/**
 * Public visibility for Profiles (PROFILES-1).
 *
 * A Profile with no `person_visibility` row keeps its current public
 * visibility. A row with `visible = 0` hides the Profile. Every public read
 * that returns a person, a person's role or a count that includes people adds
 * this predicate, so a hidden Profile is absent from directories, search,
 * organization listings, county counts and pickers, and its own page and API
 * answer as not found. Staff-only reads (sync planning, audit, the owner
 * Profiles sheet) deliberately do not use it.
 *
 * The Profile must also meet the publication rule in the
 * `profile_publication_ready` view (migration 0034): a nonblank display name
 * and at least one role with a county, a source and an office, position or
 * duties. Triggers already hide a Profile that stops meeting it, and this
 * check keeps an incomplete Profile private on every public read regardless.
 *
 * `idExpression` is a trusted SQL expression naming a people ID column. It is
 * never built from request input.
 */
export function personIsPublicSql(idExpression: string): string {
  return `(NOT EXISTS (SELECT 1 FROM person_visibility hidden_pv WHERE hidden_pv.person_id = ${idExpression} AND hidden_pv.visible = 0) AND EXISTS (SELECT 1 FROM profile_publication_ready ready_pv WHERE ready_pv.person_id = ${idExpression}))`;
}

/**
 * A public alternate name is confirmed, explicitly approved for display and
 * not removed (PROFILES-NAMES-1). Only a name that passes this predicate may
 * reach a public page, API, search index or export. `alias` is the trusted
 * table alias of `profile_names`. The predicate never replaces the Profile
 * visibility check, which every public read applies as well, so a hidden
 * Profile exposes no alternate name.
 */
export function publicAlternateNameSql(alias = "pn"): string {
  return `${alias}.public_display = 1 AND ${alias}.verification_status = 'confirmed' AND ${alias}.removed_at IS NULL`;
}

/**
 * Public people-name match: the approved display name, or a public alternate
 * name. Needs two `LIKE` parameters, both the same escaped pattern. Private,
 * unreviewed and removed names never match.
 */
export function publicPersonNameMatchSql(
  nameExpression: string,
  idExpression: string,
): string {
  return `(${nameExpression} LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM profile_names pn WHERE pn.person_id = ${idExpression} AND ${publicAlternateNameSql("pn")} AND pn.published_name LIKE ? ESCAPE '\\'))`;
}

/** Maximum public alternate names one Profile page shows. */
export const PUBLIC_ALTERNATE_NAME_LIMIT = 20;

/** Public projection of one approved name. Nothing else leaves the database. */
export function toPublicAlternateName(
  type: unknown,
  name: unknown,
): PersonProfileAlternateName {
  return {
    name: String(name),
    label:
      ALTERNATE_NAME_PUBLIC_LABELS[type as AlternateNameType] ??
      "Also known as",
  };
}

export const PUBLIC_ALTERNATE_NAMES_SQL = `SELECT pn.name_type, pn.published_name
  FROM profile_names pn
  WHERE pn.person_id = ? AND ${publicAlternateNameSql("pn")}
  ORDER BY pn.published_name COLLATE NOCASE, pn.id COLLATE BINARY
  LIMIT ${PUBLIC_ALTERNATE_NAME_LIMIT}`;

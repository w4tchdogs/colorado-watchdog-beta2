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
 * `idExpression` is a trusted SQL expression naming a people ID column. It is
 * never built from request input.
 */
export function personIsPublicSql(idExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM person_visibility hidden_pv WHERE hidden_pv.person_id = ${idExpression} AND hidden_pv.visible = 0)`;
}

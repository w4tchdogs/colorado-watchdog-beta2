import type { AsyncD1Database } from "../database/d1.js";
import {
  AuthorizationError,
  roleHasCapability,
  type TrustedPrincipal,
} from "./security.js";

/**
 * The County Structure authority check, shared by the structure service and
 * the role-to-unit attachment service. The role must carry
 * `county_structure.manage`, and the account and identity must still be live.
 */
export async function authorizeCountyStructure(
  database: AsyncD1Database,
  principal: TrustedPrincipal,
): Promise<void> {
  if (!roleHasCapability(principal.role, "county_structure.manage"))
    throw new AuthorizationError();
  const live = await database.first(
    `SELECT 1 AS ok FROM identities i JOIN accounts a ON a.id = i.account_id
     WHERE a.id = ? AND i.id = ? AND i.provider = ? AND a.kind = ? AND a.role = ?
       AND a.status = 'active' AND i.revoked_at IS NULL
       AND (i.expires_at IS NULL OR i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [
      principal.accountId,
      principal.identityId,
      principal.provider,
      principal.kind,
      principal.role,
    ],
  );
  if (!live) throw new AuthorizationError();
}

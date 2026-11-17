import type { AsyncD1Database } from "../database/d1.js";
import type {
  SyncTransportOperation,
  SyncTransportOperations,
} from "../transport/sync-api.js";
import type { TrustedPrincipal } from "./security.js";
import { syncCapabilityFor } from "./sync-authorization.js";
import { commitSyncChangesetD1 } from "./sync-commit-d1.js";
import { lookupSyncBatchD1 } from "./sync-lookup-d1.js";
import { planSyncChangesetD1 } from "./sync-planner-d1.js";
import { reverseSyncBatchD1 } from "./sync-revert-d1.js";

type HasCapability = (
  principal: TrustedPrincipal | null,
  capability: string,
) => Promise<boolean>;

/**
 * Binds the D1 planner, commit, lookup and reversal engines to the sync
 * transport. Default-deny: each operation needs its own explicit capability,
 * which no role holds and an agent receives only by an active grant.
 */
export function createHostedSyncTransportDependencies(
  database: AsyncD1Database,
  hasCapability: HasCapability,
): {
  readonly authorize: (
    principal: TrustedPrincipal,
    operation: SyncTransportOperation,
  ) => Promise<boolean>;
  readonly operations: SyncTransportOperations;
} {
  const authorize = (
    principal: TrustedPrincipal,
    operation: SyncTransportOperation,
  ) => hasCapability(principal, syncCapabilityFor(operation));
  const guard = (principal: TrustedPrincipal, capability: string) =>
    hasCapability(principal, capability);
  return {
    authorize,
    operations: {
      dryRun: (_principal, request) => planSyncChangesetD1(database, request),
      commit: (principal, key, request) =>
        commitSyncChangesetD1(database, principal, key, request, {
          authorize: guard,
        }),
      lookup: (principal, lookup) =>
        lookupSyncBatchD1(database, principal, lookup),
      reverse: (principal, batchId, key) =>
        reverseSyncBatchD1(database, principal, batchId, key, {
          authorize: guard,
        }),
    },
  };
}

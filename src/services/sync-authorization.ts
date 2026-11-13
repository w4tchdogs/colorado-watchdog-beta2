import type { WebsiteDatabase } from "../database/sqlite.js";
import type { SyncTransportOperation } from "../transport/sync-api.js";
import { hasCapability, type TrustedPrincipal } from "./security.js";

const OPERATION_CAPABILITY = {
  dry_run: "sync.read",
  lookup: "sync.read",
  commit: "sync.apply",
  reverse: "sync.revert",
} as const;

export function syncCapabilityFor(
  operation: SyncTransportOperation,
): (typeof OPERATION_CAPABILITY)[SyncTransportOperation] {
  return OPERATION_CAPABILITY[operation];
}

/** Uses the current account and identity rows. No role receives sync grants by default. */
export function createSyncAuthorization(
  database: WebsiteDatabase,
): (principal: TrustedPrincipal, operation: SyncTransportOperation) => boolean {
  return (principal, operation) =>
    hasCapability(database, principal, syncCapabilityFor(operation));
}

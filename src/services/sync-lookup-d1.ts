import type { SyncEntity } from "../contracts/sync.js";
import type { AsyncD1Database } from "../database/d1.js";
import type { TrustedPrincipal } from "./security.js";
import type { SyncBatchLookup } from "./sync-history.js";

const PAGE_ROWS = 1_000;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OUTCOMES = new Set(["created", "updated", "reused"]);
const ENTITIES = new Set<string>([
  "organizations",
  "organization_county_affiliations",
  "people",
  "positions",
  "role_sources",
  "person_roles",
]);

/**
 * Read-only D1 readback of one committed batch owned by the principal. The
 * caller authorizes sync.read first. Returns null when the batch does not
 * exist for this principal, so another account's batch is indistinguishable
 * from a missing one.
 */
export async function lookupSyncBatchD1(
  database: AsyncD1Database,
  principal: TrustedPrincipal,
  lookup: { readonly batchId?: string; readonly idempotencyKey?: string },
): Promise<SyncBatchLookup | null> {
  const byId = typeof lookup.batchId === "string" && lookup.batchId.length > 0;
  const byKey =
    typeof lookup.idempotencyKey === "string" &&
    lookup.idempotencyKey.length > 0;
  const value = byId ? lookup.batchId : lookup.idempotencyKey;
  if (byId === byKey || typeof value !== "string" || !ID.test(value))
    throw new Error("Provide one valid batch ID or idempotency key");
  const batch = await database.first<{ id: string; committed_at: string }>(
    `SELECT id, committed_at FROM sync_batches
     WHERE ${byId ? "id" : "idempotency_key"} = ? AND actor_account_id = ?
       AND status = 'committed'`,
    [value, principal.accountId],
  );
  if (!batch) return null;
  const items: SyncBatchLookup["items"][number][] = [];
  for (let after = -1; ; ) {
    const page = await database.all<Record<string, unknown>>(
      `SELECT item_index, client_ref, entity, target_id, outcome, committed_version
       FROM sync_batch_items WHERE batch_id = ? AND item_index > ?
       ORDER BY item_index`,
      PAGE_ROWS,
      [batch.id, after],
    );
    for (const row of page) {
      if (
        typeof row.item_index !== "number" ||
        typeof row.client_ref !== "string" ||
        typeof row.entity !== "string" ||
        !ENTITIES.has(row.entity) ||
        typeof row.target_id !== "string" ||
        typeof row.outcome !== "string" ||
        !OUTCOMES.has(row.outcome) ||
        typeof row.committed_version !== "number"
      )
        return null;
      items.push({
        itemIndex: row.item_index,
        clientRef: row.client_ref,
        entity: row.entity as SyncEntity,
        websiteId: row.target_id,
        outcome: row.outcome as "created" | "updated" | "reused",
        version: row.committed_version,
      });
    }
    const last = page.at(-1);
    if (page.length < PAGE_ROWS || !last) break;
    after = Number(last.item_index);
  }
  const reversal = await database.first<{ reversed_at: string }>(
    "SELECT reversed_at FROM sync_batch_reversals WHERE batch_id = ? AND actor_account_id = ?",
    [batch.id, principal.accountId],
  );
  return {
    status: reversal ? "reverted" : "committed",
    batchId: batch.id,
    committedAt: batch.committed_at,
    reversedAt: reversal?.reversed_at ?? null,
    items,
  };
}

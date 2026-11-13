import type { WebsiteDatabase } from "../database/sqlite.js";
import { requireCapability, type TrustedPrincipal } from "./security.js";

export interface AuditRecord {
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MutationAttribution {
  readonly principal: TrustedPrincipal;
  readonly operationId?: string;
}

export function runAuditedMutation<T>(
  database: WebsiteDatabase,
  attribution: MutationAttribution,
  audit: AuditRecord,
  mutation: () => T,
): T {
  assertCredentialFree(audit);
  const transact = database.transaction(() => {
    const result = mutation();
    database
      .prepare(
        `INSERT INTO audit_events
           (id, actor_account_id, operation_id, action, target_type, target_id, summary, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        attribution.principal.accountId,
        attribution.operationId ?? null,
        audit.action,
        audit.targetType,
        audit.targetId ?? null,
        audit.summary,
        JSON.stringify(audit.details ?? {}),
      );
    return result;
  });
  return transact();
}

/** Inserts validated audit evidence into a transaction owned by the caller. */
export function insertAuditEvent(
  database: WebsiteDatabase,
  attribution: MutationAttribution,
  audit: AuditRecord,
): void {
  assertCredentialFree(audit);
  database
    .prepare(
      `INSERT INTO audit_events
         (id, actor_account_id, operation_id, action, target_type, target_id, summary, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      attribution.principal.accountId,
      attribution.operationId ?? null,
      audit.action,
      audit.targetType,
      audit.targetId ?? null,
      audit.summary,
      JSON.stringify(audit.details ?? {}),
    );
}

function assertCredentialFree(audit: AuditRecord): void {
  const values = [
    audit.action,
    audit.targetType,
    audit.targetId,
    audit.summary,
    ...Object.values(audit.details ?? {}).filter(
      (value): value is string => typeof value === "string",
    ),
  ];
  if (values.some((value) => value && /cwa_[A-Za-z0-9_-]{43}/.test(value))) {
    throw new Error("Audit data cannot contain credentials");
  }
}

export function listAuditEvents(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  limit = 100,
): ReadonlyArray<Record<string, unknown>> {
  requireCapability(database, principal, "audit.read");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Audit page size must be between 1 and 100");
  }
  return database
    .prepare(
      `SELECT id, actor_account_id, operation_id, action, target_type, target_id,
              summary, details_json, created_at
       FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit);
}

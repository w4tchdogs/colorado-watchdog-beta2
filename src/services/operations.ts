import type { WebsiteDatabase } from "../database/sqlite.js";
import { runAuditedMutation } from "./audit.js";
import { newId, requireCapability, type TrustedPrincipal } from "./security.js";

export function createOperation(
  database: WebsiteDatabase,
  principal: TrustedPrincipal,
  kind: string,
  id = newId(),
): string {
  requireCapability(database, principal, "operation.create");
  if (!kind.trim() || !id.trim()) {
    throw new Error("Invalid operation input");
  }
  return runAuditedMutation(
    database,
    { principal, operationId: id },
    {
      action: "operation.create",
      targetType: "operation",
      targetId: id,
      summary: "Created an operation",
      details: { kind },
    },
    () => {
      database
        .prepare(
          "INSERT INTO operations (id, kind, created_by_account_id) VALUES (?, ?, ?)",
        )
        .run(id, kind.trim(), principal.accountId);
      return id;
    },
  );
}

// Counts the D1 calls one commit makes for each scale fixture, against a local
// in-memory Website database. Synthetic data only. Run after `npm run build`.
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangesetD1 } from "../dist/services/sync-commit-d1.js";
import { planSyncChangesetD1 } from "../dist/services/sync-planner-d1.js";
import {
  countingD1Binding,
  mixedChangeset,
  referenceBaseChangeset,
  referenceRolesChangeset,
} from "../tests/sync-scale-fixtures.mjs";

const now = () => new Date("2026-11-13T12:00:00.000Z");
const authorize = async (_principal, capability) => capability === "sync.apply";

const database = await openWebsiteDatabase();
migrateWebsiteDatabase(database);
database.exec(`
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('count-owner', 'human', 'owner', 'Synthetic Owner');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('count-identity', 'count-owner', 'test-human', 'owner');
`);
const principal = await resolvePrincipal(
  database,
  new Request("https://watchdog.invalid", {
    headers: { "x-test-human-subject": "owner" },
  }),
  createTestHumanIdentityAdapter({ owner: "owner" }),
);

async function measure(label, operation) {
  const { binding, counter, total } = countingD1Binding(database);
  const d1 = new AsyncD1Database(binding);
  const started = performance.now();
  const result = await operation(d1);
  const ms = Math.round(performance.now() - started);
  const row = {
    label,
    d1Calls: total(),
    ...counter,
    localMs: ms,
    status: result.status ?? (result.eligible ? "eligible" : "ineligible"),
  };
  console.log(JSON.stringify(row));
  return result;
}

await measure("mixed-816 dry run", (d1) =>
  planSyncChangesetD1(d1, mixedChangeset("dry_run"), now),
);
await measure("mixed-816 commit", (d1) =>
  commitSyncChangesetD1(d1, principal, "count-mixed", mixedChangeset(), {
    authorize,
    now,
  }),
);
const base = await measure("reference base commit", (d1) =>
  commitSyncChangesetD1(d1, principal, "count-base", referenceBaseChangeset(), {
    authorize,
    now,
  }),
);
const ids = new Map(base.items.map((item) => [item.clientRef, item.websiteId]));
await measure("references-251 dry run", (d1) =>
  planSyncChangesetD1(d1, referenceRolesChangeset(ids, "dry_run"), now),
);
await measure("references-251 commit", (d1) =>
  commitSyncChangesetD1(
    d1,
    principal,
    "count-refs",
    referenceRolesChangeset(ids),
    { authorize, now },
  ),
);
database.close();

import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createContentService } from "../dist/services/content.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";

export const ALLOWED_ACCOUNTS = new Set([
  "acct-author",
  "acct-editor",
  "acct-retired",
]);
export const allowSynthetic = (principal) =>
  ALLOWED_ACCOUNTS.has(principal.accountId);

export const SUBJECTS = {
  author: "subject-author",
  editor: "subject-editor",
  outsider: "subject-outsider",
  retired: "subject-retired",
};

/** Synthetic accounts, organizations, and people only. */
export function seedContentFixture(database) {
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name, email)
    VALUES ('acct-author','human','contributor','Synthetic Author','author@example.invalid'),
           ('acct-editor','human','contributor','Synthetic Editor','editor@example.invalid'),
           ('acct-outsider','human','contributor','Synthetic Outsider',NULL),
           ('acct-retired','human','contributor','Synthetic Retired',NULL);
    INSERT INTO identities (id, account_id, provider, subject)
    VALUES ('id-author','acct-author','test-human','${SUBJECTS.author}'),
           ('id-editor','acct-editor','test-human','${SUBJECTS.editor}'),
           ('id-outsider','acct-outsider','test-human','${SUBJECTS.outsider}'),
           ('id-retired','acct-retired','test-human','${SUBJECTS.retired}');
    INSERT INTO organizations (id, name, organization_type, county_fips)
    VALUES ('org-1','Fictional Records Office','office','08001'),
           ('org-2','Fictional Regional Board','regional',NULL);
    INSERT INTO people (id, display_name)
    VALUES ('person-1','Fictional Person One'),
           ('person-2','Fictional Person Two'),
           ('person-3','Fictional Person Three');
  `);
}

export function principalFactory(database) {
  const adapter = createTestHumanIdentityAdapter({
    author: SUBJECTS.author,
    editor: SUBJECTS.editor,
    outsider: SUBJECTS.outsider,
    retired: SUBJECTS.retired,
  });
  return (who) =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": who },
      }),
      adapter,
    );
}

export async function withContentFixture(callback, path = ":memory:") {
  const database = await openWebsiteDatabase(path);
  migrateWebsiteDatabase(database);
  if (!database.prepare("SELECT 1 AS found FROM accounts LIMIT 1").get()) {
    seedContentFixture(database);
  }
  const principal = principalFactory(database);
  const service = createContentService(database, { authorize: allowSynthetic });
  try {
    await callback({ database, principal, service });
  } finally {
    database.close();
  }
}

export const auditCount = (database) =>
  database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
export const revisionCount = (database, id) =>
  id === undefined
    ? database.prepare("SELECT COUNT(*) AS count FROM content_revisions").get()
        .count
    : database
        .prepare(
          "SELECT COUNT(*) AS count FROM content_revisions WHERE content_id = ?",
        )
        .get(id).count;

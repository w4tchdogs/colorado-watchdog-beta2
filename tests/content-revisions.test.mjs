import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { StaleVersionError } from "../dist/database/versioned-writes.js";
import {
  ContentInputError,
  ContentNotFoundError,
  ContentRelationshipError,
  ContentStateError,
  createContentService,
} from "../dist/services/content.js";
import { AuthorizationError } from "../dist/services/security.js";
import {
  allowSynthetic,
  auditCount,
  principalFactory,
  revisionCount,
  seedContentFixture,
  withContentFixture,
} from "./content-fixtures.mjs";

const EXACT_BODY =
  "# Heading  \r\n\r\n  Indented line with trailing spaces   \n<script>alert('synthetic')</script>\n[link](javascript:void(0))\n\tTab é中😀\n\n";

test("creation records the initial recoverable revision", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "story",
      title: "Initial revision",
      summary: "Initial summary",
      body: EXACT_BODY,
      relationships: {
        countyFips: ["08013", "08001"],
        personIds: ["person-1"],
        organizationIds: ["org-2"],
      },
    });
    assert.equal(revisionCount(database, draft.id), 1);
    const revision = service.getRevision(author, draft.id, 1);
    assert.deepEqual(revision, {
      contentId: draft.id,
      version: 1,
      changeKind: "create",
      title: "Initial revision",
      summary: "Initial summary",
      body: EXACT_BODY,
      bodyFormat: "markdown",
      status: "draft",
      relationships: {
        countyFips: ["08001", "08013"],
        personIds: ["person-1"],
        organizationIds: ["org-2"],
      },
      editedByAccountId: "acct-author",
      recordedAt: revision.recordedAt,
      restoredFromVersion: null,
      checkpointLabel: null,
    });
    assert.match(revision.recordedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  });
});

test("every successful mutation adds exactly one revision with exact prior bodies", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const editor = await principal("editor");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Version one",
      body: EXACT_BODY,
    });
    service.updateDraft(editor, draft.id, 1, { body: "Second body\n" });
    service.updateDraft(author, draft.id, 2, {
      title: "Version three",
      summary: "Third summary",
    });
    service.updateDraft(editor, draft.id, 3, {
      body: "Fourth body",
      summary: null,
    });
    const current = service.getDraft(author, draft.id);
    assert.equal(current.version, 4);
    assert.equal(revisionCount(database, draft.id), 4);

    const bodies = [1, 2, 3, 4].map(
      (version) => service.getRevision(author, draft.id, version).body,
    );
    assert.deepEqual(bodies, [
      EXACT_BODY,
      "Second body\n",
      "Second body\n",
      "Fourth body",
    ]);
    assert.equal(service.getRevision(author, draft.id, 1).title, "Version one");
    assert.equal(
      service.getRevision(author, draft.id, 3).title,
      "Version three",
    );
    assert.equal(
      service.getRevision(author, draft.id, 3).summary,
      "Third summary",
    );
    assert.equal(service.getRevision(author, draft.id, 4).summary, null);
    assert.deepEqual(
      [1, 2, 3, 4].map(
        (v) => service.getRevision(author, draft.id, v).editedByAccountId,
      ),
      ["acct-author", "acct-editor", "acct-author", "acct-editor"],
    );
    assert.deepEqual(
      [1, 2, 3, 4].map(
        (v) => service.getRevision(author, draft.id, v).changeKind,
      ),
      ["create", "update", "update", "update"],
    );
    // The current record mirrors the newest revision.
    const newest = service.getRevision(author, draft.id, 4);
    assert.equal(newest.body, current.body);
    assert.equal(newest.title, current.title);
  });
});

test("relationship history is preserved across edits", async () => {
  await withContentFixture(async ({ principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Links over time",
      relationships: { countyFips: ["08001"] },
    });
    service.setRelationships(author, draft.id, 1, {
      personIds: ["person-1", "person-2"],
    });
    service.updateDraft(author, draft.id, 2, {
      relationships: {
        countyFips: ["08013", "08069"],
        personIds: ["person-3"],
      },
    });
    service.setRelationships(author, draft.id, 3, {
      organizationIds: ["org-1"],
      countyFips: [],
    });

    const rel = (version) =>
      service.getRevision(author, draft.id, version).relationships;
    assert.deepEqual(rel(1), {
      countyFips: ["08001"],
      personIds: [],
      organizationIds: [],
    });
    assert.deepEqual(rel(2), {
      countyFips: ["08001"],
      personIds: ["person-1", "person-2"],
      organizationIds: [],
    });
    assert.deepEqual(rel(3), {
      countyFips: ["08013", "08069"],
      personIds: ["person-3"],
      organizationIds: [],
    });
    assert.deepEqual(rel(4), {
      countyFips: [],
      personIds: ["person-3"],
      organizationIds: ["org-1"],
    });
    assert.deepEqual(
      [1, 2, 3, 4].map(
        (v) => service.getRevision(author, draft.id, v).changeKind,
      ),
      ["create", "relationships", "update", "relationships"],
    );
  });
});

test("archive and restore each record a revision with their state", async () => {
  await withContentFixture(async ({ principal, service }) => {
    const author = await principal("author");
    const editor = await principal("editor");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Lifecycle",
    });
    service.archiveDraft(editor, draft.id, 1);
    service.restoreDraft(author, draft.id, 2);
    const page = service.listRevisions(author, draft.id);
    assert.deepEqual(
      page.items.map((r) => [
        r.version,
        r.changeKind,
        r.status,
        r.editedByAccountId,
      ]),
      [
        [3, "restore_draft", "draft", "acct-author"],
        [2, "archive", "archived", "acct-editor"],
        [1, "create", "draft", "acct-author"],
      ],
    );
  });
});

test("restoring an earlier revision creates a new version and keeps history intact", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const editor = await principal("editor");
    const draft = service.createDraft(author, {
      contentType: "story",
      title: "Original title",
      summary: "Original summary",
      body: EXACT_BODY,
      relationships: {
        countyFips: ["08001"],
        personIds: ["person-1"],
        organizationIds: ["org-1"],
      },
    });
    service.updateDraft(author, draft.id, 1, {
      title: "Changed title",
      summary: null,
      body: "Changed body",
      relationships: {
        countyFips: ["08013"],
        personIds: [],
        organizationIds: ["org-2"],
      },
    });
    service.setRelationships(author, draft.id, 2, { personIds: ["person-2"] });
    const before = [1, 2, 3].map((v) =>
      service.getRevision(author, draft.id, v),
    );
    const auditBefore = auditCount(database);

    const restored = service.restoreRevision(editor, draft.id, 3, 1);
    assert.equal(restored.version, 4);
    assert.equal(restored.status, "draft");
    assert.equal(restored.title, "Original title");
    assert.equal(restored.summary, "Original summary");
    assert.equal(restored.body, EXACT_BODY);
    assert.deepEqual(restored.relationships, {
      countyFips: ["08001"],
      personIds: ["person-1"],
      organizationIds: ["org-1"],
    });
    assert.equal(restored.contentType, "story");
    assert.equal(restored.id, draft.id);
    assert.equal(restored.createdByAccountId, "acct-author");
    assert.equal(restored.createdAt, draft.createdAt);
    assert.equal(restored.lastEditedByAccountId, "acct-editor");

    const revision = service.getRevision(author, draft.id, 4);
    assert.equal(revision.changeKind, "restore_revision");
    assert.equal(revision.restoredFromVersion, 1);
    assert.equal(revision.editedByAccountId, "acct-editor");
    assert.equal(revision.body, EXACT_BODY);
    // Historical revisions are untouched.
    assert.deepEqual(
      [1, 2, 3].map((v) => service.getRevision(author, draft.id, v)),
      before,
    );
    assert.equal(revisionCount(database, draft.id), 4);

    const event = database
      .prepare(
        "SELECT actor_account_id, action, details_json FROM audit_events ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    assert.equal(event.action, "content.revision.restore");
    assert.equal(event.actor_account_id, "acct-editor");
    assert.deepEqual(JSON.parse(event.details_json), {
      fromVersion: 1,
      version: 4,
    });
    assert.equal(auditCount(database), auditBefore + 1);

    // A snapshot recorded while archived can still be copied back into a draft.
    service.archiveDraft(author, draft.id, 4);
    service.restoreDraft(author, draft.id, 5);
    const archivedSnapshot = service.restoreRevision(author, draft.id, 6, 5);
    assert.equal(archivedSnapshot.status, "draft");
    assert.equal(archivedSnapshot.version, 7);
  });
});

test("revision restoration respects lifecycle, versions, and input rules", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Rules",
      body: "one",
    });
    service.updateDraft(author, draft.id, 1, { body: "two" });
    service.archiveDraft(author, draft.id, 2);

    assert.throws(
      () => service.restoreRevision(author, draft.id, 3, 1),
      ContentStateError,
    );
    service.restoreDraft(author, draft.id, 3);

    const snapshot = () => service.getDraft(author, draft.id);
    const before = snapshot();
    const revisionsBefore = revisionCount(database);
    const auditBefore = auditCount(database);
    assert.throws(
      () => service.restoreRevision(author, draft.id, 3, 1),
      StaleVersionError,
    );
    assert.throws(
      () => service.restoreRevision(author, draft.id, 4, 4),
      ContentInputError,
    );
    assert.throws(
      () => service.restoreRevision(author, draft.id, 4, 9),
      ContentInputError,
    );
    for (const bad of [0, -1, 1.5, "1", undefined, null]) {
      assert.throws(
        () => service.restoreRevision(author, draft.id, 4, bad),
        ContentInputError,
      );
      assert.throws(
        () => service.restoreRevision(author, draft.id, bad, 1),
        ContentInputError,
      );
    }
    assert.throws(
      () => service.restoreRevision(author, "missing", 4, 1),
      ContentNotFoundError,
    );
    assert.deepEqual(snapshot(), before);
    assert.equal(revisionCount(database), revisionsBefore);
    assert.equal(auditCount(database), auditBefore);
  });
});

test("stale mutations create no revision or partial change", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Stale",
    });
    service.updateDraft(author, draft.id, 1, { body: "current" });
    const before = service.getDraft(author, draft.id);
    const revisions = revisionCount(database);
    const audits = auditCount(database);

    assert.throws(
      () =>
        service.updateDraft(author, draft.id, 1, {
          title: "Stale",
          relationships: { personIds: ["person-1"] },
        }),
      StaleVersionError,
    );
    assert.throws(
      () => service.setRelationships(author, draft.id, 1, { countyFips: [] }),
      StaleVersionError,
    );
    assert.throws(
      () => service.archiveDraft(author, draft.id, 1),
      StaleVersionError,
    );
    assert.throws(
      () => service.restoreDraft(author, draft.id, 1),
      ContentStateError,
    );
    assert.deepEqual(service.getDraft(author, draft.id), before);
    assert.equal(revisionCount(database), revisions);
    assert.equal(auditCount(database), audits);
  });
});

test("a failing revision insert rolls back content, relationships, and audit", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Atomic",
      relationships: { countyFips: ["08001"] },
    });
    const before = service.getDraft(author, draft.id);
    const revisions = revisionCount(database);
    const audits = auditCount(database);
    database.exec(`
      CREATE TRIGGER synthetic_revision_failure
      BEFORE INSERT ON content_revisions
      WHEN NEW.version > 1
      BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END;
    `);

    assert.throws(() =>
      service.updateDraft(author, draft.id, 1, {
        title: "Lost",
        relationships: { personIds: ["person-1"] },
      }),
    );
    assert.throws(() =>
      service.setRelationships(author, draft.id, 1, { countyFips: ["08013"] }),
    );
    assert.throws(() => service.archiveDraft(author, draft.id, 1));
    assert.deepEqual(service.getDraft(author, draft.id), before);
    assert.equal(revisionCount(database), revisions);
    assert.equal(auditCount(database), audits);

    database.exec("DROP TRIGGER synthetic_revision_failure");
    database.exec(`
      CREATE TRIGGER synthetic_create_failure
      BEFORE INSERT ON content_revisions
      WHEN NEW.change_kind = 'create'
      BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END;
    `);
    const items = database
      .prepare("SELECT COUNT(*) AS count FROM content_items")
      .get().count;
    assert.throws(() =>
      service.createDraft(author, {
        contentType: "post",
        title: "Never stored",
      }),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM content_items").get()
        .count,
      items,
    );
    assert.equal(auditCount(database), audits);
  });
});

test("restoring a revision with a missing relationship target rolls back atomically", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Target removed",
      relationships: { personIds: ["person-3"], countyFips: ["08001"] },
    });
    service.updateDraft(author, draft.id, 1, {
      title: "Later title",
      relationships: { personIds: [] },
    });
    // person-3 is no longer linked, so only history refers to it.
    database.exec("DELETE FROM people WHERE id = 'person-3'");
    const before = service.getDraft(author, draft.id);
    const revisions = revisionCount(database);
    const audits = auditCount(database);

    assert.throws(
      () => service.restoreRevision(author, draft.id, 2, 1),
      ContentRelationshipError,
    );
    assert.deepEqual(service.getDraft(author, draft.id), before);
    assert.equal(revisionCount(database), revisions);
    assert.equal(auditCount(database), audits);
    assert.equal(
      service.getRevision(author, draft.id, 1).relationships.personIds[0],
      "person-3",
    );
  });
});

test("historical revisions are immutable and cannot be silently removed", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Immutable",
      body: "keep",
    });
    service.updateDraft(author, draft.id, 1, { body: "later" });
    const before = database
      .prepare("SELECT * FROM content_revisions ORDER BY version")
      .all();

    for (const statement of [
      "UPDATE content_revisions SET body = 'tampered'",
      "UPDATE content_revisions SET title = 'tampered' WHERE version = 1",
      "DELETE FROM content_revisions",
      "DELETE FROM content_revisions WHERE version = 1",
      `DELETE FROM content_items WHERE id = '${draft.id}'`,
      `INSERT INTO content_revisions (content_id, version, change_kind, title, body, status, county_fips_json, person_ids_json, organization_ids_json, edited_by_account_id) VALUES ('${draft.id}', 1, 'update', 't', 'b', 'draft', '[]', '[]', '[]', 'acct-author')`,
      `INSERT INTO content_revisions (content_id, version, change_kind, title, body, status, county_fips_json, person_ids_json, organization_ids_json, edited_by_account_id) VALUES ('${draft.id}', 7, 'update', 't', 'b', 'draft', '[]', '[]', '[]', 'acct-author')`,
      `INSERT INTO content_revisions (content_id, version, change_kind, title, body, status, county_fips_json, person_ids_json, organization_ids_json, edited_by_account_id) VALUES ('${draft.id}', 2, 'rewrite', 't', 'b', 'draft', '[]', '[]', '[]', 'acct-author')`,
      `INSERT INTO content_revisions (content_id, version, change_kind, title, body, status, county_fips_json, person_ids_json, organization_ids_json, edited_by_account_id, restored_from_version) VALUES ('${draft.id}', 2, 'update', 't', 'b', 'draft', '[]', '[]', '[]', 'acct-author', 1)`,
      `INSERT INTO content_revisions (content_id, version, change_kind, title, body, status, county_fips_json, person_ids_json, organization_ids_json, edited_by_account_id) VALUES ('${draft.id}', 2, 'update', 't', 'b', 'draft', '{}', '[]', '[]', 'acct-author')`,
      `INSERT INTO content_revisions (content_id, version, change_kind, title, body, status, county_fips_json, person_ids_json, organization_ids_json, edited_by_account_id) VALUES ('no-such-item', 1, 'create', 't', 'b', 'draft', '[]', '[]', '[]', 'acct-author')`,
      "DELETE FROM accounts WHERE id = 'acct-author'",
    ]) {
      assert.throws(() => database.exec(statement), undefined, statement);
    }
    assert.deepEqual(
      database
        .prepare("SELECT * FROM content_revisions ORDER BY version")
        .all(),
      before,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("revision listing and retrieval are bounded", async () => {
  await withContentFixture(async ({ principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Many edits",
      body: "v1",
    });
    for (let version = 1; version < 7; version += 1) {
      service.updateDraft(author, draft.id, version, {
        body: `v${version + 1}`,
      });
    }
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = service.listRevisions(author, draft.id, {
        limit: 3,
        beforeVersion: cursor,
      });
      assert.ok(page.items.length <= 3);
      for (const item of page.items) {
        assert.equal("body" in item, false);
        assert.equal("relationships" in item, false);
        seen.push(item.version);
      }
      assert.equal(page.hasMore, page.nextCursor !== null);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1]);
    assert.equal(pages, 3);
    assert.equal(service.listRevisions(author, draft.id).items.length, 7);
    assert.equal(
      service.listRevisions(author, draft.id, { limit: 100 }).items.length,
      7,
    );
    assert.deepEqual(
      service.listRevisions(author, draft.id, { beforeVersion: 1 }).items,
      [],
    );

    for (const limit of [0, -1, 1.5, 101, "3"]) {
      assert.throws(
        () => service.listRevisions(author, draft.id, { limit }),
        ContentInputError,
      );
    }
    for (const beforeVersion of [0, 1.5, "3"]) {
      assert.throws(
        () => service.listRevisions(author, draft.id, { beforeVersion }),
        ContentInputError,
      );
    }
    assert.throws(
      () => service.listRevisions(author, draft.id, { offset: 2 }),
      ContentInputError,
    );
    assert.throws(
      () => service.listRevisions(author, "missing"),
      ContentNotFoundError,
    );
    assert.throws(() => service.listRevisions(author, ""), ContentInputError);
    assert.equal(service.getRevision(author, draft.id, 99), null);
    assert.equal(service.getRevision(author, "missing", 1), null);
    assert.throws(
      () => service.getRevision(author, draft.id, 0),
      ContentInputError,
    );
  });
});

test("revision read and restore are authorized independently of content access", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const outsider = await principal("outsider");
    const retired = await principal("retired");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Guarded",
    });
    service.updateDraft(author, draft.id, 1, { body: "two" });
    const revisions = revisionCount(database);
    const audits = auditCount(database);
    const before = service.getDraft(author, draft.id);
    const calls = (svc, who) => [
      () => svc.listRevisions(who, draft.id),
      () => svc.getRevision(who, draft.id, 1),
      () => svc.restoreRevision(who, draft.id, 2, 1),
    ];
    for (const call of [
      ...calls(createContentService(database), author),
      ...calls(service, outsider),
    ]) {
      assert.throws(call, AuthorizationError);
    }

    const only = (...actions) =>
      createContentService(database, {
        authorize: (_p, action) => actions.includes(action),
      });
    const readOnly = only("content.revision.read");
    assert.equal(readOnly.listRevisions(author, draft.id).items.length, 2);
    assert.equal(readOnly.getRevision(author, draft.id, 1).body, "");
    assert.throws(
      () => readOnly.restoreRevision(author, draft.id, 2, 1),
      AuthorizationError,
    );
    assert.throws(
      () => readOnly.getDraft(author, draft.id),
      AuthorizationError,
    );

    const restoreOnly = only("content.revision.restore");
    assert.throws(
      () => restoreOnly.listRevisions(author, draft.id),
      AuthorizationError,
    );
    assert.throws(
      () => restoreOnly.getRevision(author, draft.id, 1),
      AuthorizationError,
    );
    assert.throws(
      () => restoreOnly.updateDraft(author, draft.id, 2, { body: "x" }),
      AuthorizationError,
    );

    const contentOnly = only(
      "content.read",
      "content.update",
      "content.create",
    );
    assert.throws(
      () => contentOnly.listRevisions(author, draft.id),
      AuthorizationError,
    );
    assert.throws(
      () => contentOnly.restoreRevision(author, draft.id, 2, 1),
      AuthorizationError,
    );

    database.exec(
      "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'acct-retired'",
    );
    for (const call of calls(service, retired)) {
      assert.throws(call, AuthorizationError);
    }
    database.exec(
      "UPDATE accounts SET status = 'active', version = version + 1 WHERE id = 'acct-retired'",
    );
    database.exec(
      "UPDATE identities SET revoked_at = '2026-11-13T00:00:00Z', version = version + 1 WHERE id = 'id-retired'",
    );
    for (const call of calls(service, retired)) {
      assert.throws(call, AuthorizationError);
    }
    assert.equal(revisionCount(database), revisions);
    assert.equal(auditCount(database), audits);
    assert.deepEqual(service.getDraft(author, draft.id), before);
  });
});

test("audit events never contain article text", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "PRIVATE-TITLE-MARKER",
      body: "PRIVATE-BODY-MARKER",
    });
    service.updateDraft(author, draft.id, 1, { body: "PRIVATE-BODY-MARKER-2" });
    service.restoreRevision(author, draft.id, 2, 1);
    const text = database
      .prepare(
        "SELECT group_concat(summary || details_json) AS text FROM audit_events",
      )
      .get().text;
    assert.doesNotMatch(text, /PRIVATE/);
    assert.equal(auditCount(database), 3);
  });
});

test("revisions persist across database close and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-revisions-"));
  const path = join(directory, "website.sqlite");
  let id;
  try {
    await withContentFixture(async ({ principal, service }) => {
      const author = await principal("author");
      const draft = service.createDraft(author, {
        contentType: "post",
        title: "Persistent",
        body: EXACT_BODY,
        relationships: { countyFips: ["08001"] },
      });
      id = draft.id;
      service.updateDraft(author, id, 1, { body: "second" });
    }, path);
    await withContentFixture(async ({ database, principal, service }) => {
      const editor = await principal("editor");
      assert.equal(revisionCount(database, id), 2);
      assert.equal(service.getRevision(editor, id, 1).body, EXACT_BODY);
      const restored = service.restoreRevision(editor, id, 2, 1);
      assert.equal(restored.version, 3);
      assert.equal(restored.body, EXACT_BODY);
    }, path);
    await withContentFixture(async ({ service, principal }) => {
      const author = await principal("author");
      assert.deepEqual(
        service.listRevisions(author, id).items.map((r) => r.changeKind),
        ["restore_revision", "update", "create"],
      );
    }, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration 0010 snapshots an already-populated version-9 database", async () => {
  const database = await openWebsiteDatabase();
  const migrations = loadWebsiteMigrations();
  assert.equal(migrations.length, 33);
  migrateWebsiteDatabase(database, migrations.slice(0, 9));
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
      .count,
    9,
  );
  assert.equal(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'content_revisions'",
      )
      .get(),
    undefined,
  );
  seedContentFixture(database);
  database.exec(`
    INSERT INTO content_items
      (id, content_type, title, summary, body, status, archived_at,
       created_by_account_id, last_edited_by_account_id, version)
    VALUES
      ('legacy-post','post','Legacy post','Legacy summary','Legacy body',
       'draft',NULL,'acct-author','acct-editor',5),
      ('legacy-story','story','Legacy story',NULL,'',
       'archived','2026-11-12T10:00:00.000Z','acct-author','acct-author',2),
      ('legacy-bare','post','No links',NULL,'Bare body',
       'draft',NULL,'acct-editor','acct-editor',1);
    INSERT INTO content_item_counties (content_id, county_fips)
    VALUES ('legacy-post','08013'),('legacy-post','08001');
    INSERT INTO content_item_people (content_id, person_id)
    VALUES ('legacy-post','person-2'),('legacy-post','person-1');
    INSERT INTO content_item_organizations (content_id, organization_id)
    VALUES ('legacy-story','org-2');
  `);
  const itemsBefore = database
    .prepare("SELECT * FROM content_items ORDER BY id")
    .all();

  migrateWebsiteDatabase(database, migrations);
  assert.deepEqual(
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version),
    [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
    ],
  );
  // The accepted current records are unchanged.
  assert.deepEqual(
    database.prepare("SELECT * FROM content_items ORDER BY id").all(),
    itemsBefore,
  );

  const baseline = database
    .prepare(
      `SELECT content_id, version, change_kind, title, summary, body, status,
              county_fips_json, person_ids_json, organization_ids_json,
              edited_by_account_id, restored_from_version, recorded_at
       FROM content_revisions ORDER BY content_id`,
    )
    .all();
  assert.equal(
    baseline.length,
    3,
    "one baseline per item, no fabricated history",
  );
  const byId = Object.fromEntries(baseline.map((row) => [row.content_id, row]));
  assert.equal(byId["legacy-post"].version, 5);
  assert.equal(byId["legacy-post"].change_kind, "baseline");
  assert.equal(byId["legacy-post"].body, "Legacy body");
  assert.equal(byId["legacy-post"].edited_by_account_id, "acct-editor");
  assert.equal(byId["legacy-post"].county_fips_json, '["08001","08013"]');
  assert.equal(byId["legacy-post"].person_ids_json, '["person-1","person-2"]');
  assert.equal(byId["legacy-post"].organization_ids_json, "[]");
  assert.equal(byId["legacy-story"].version, 2);
  assert.equal(byId["legacy-story"].status, "archived");
  assert.equal(byId["legacy-story"].summary, null);
  assert.equal(byId["legacy-story"].organization_ids_json, '["org-2"]');
  assert.equal(byId["legacy-bare"].county_fips_json, "[]");
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM content_revisions WHERE version < 5 AND content_id = 'legacy-post'",
      )
      .get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  // Reapplying is a no-op and the service continues the history.
  migrateWebsiteDatabase(database, migrations);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM content_revisions").get()
      .count,
    3,
  );
  const principal = principalFactory(database);
  const service = createContentService(database, { authorize: allowSynthetic });
  const editor = await principal("editor");
  const next = service.updateDraft(editor, "legacy-post", 5, {
    body: "Edited after migration",
  });
  assert.equal(next.version, 6);
  assert.deepEqual(
    service
      .listRevisions(editor, "legacy-post")
      .items.map((r) => [r.version, r.changeKind]),
    [
      [6, "update"],
      [5, "baseline"],
    ],
  );
  assert.equal(
    service.getRevision(editor, "legacy-post", 5).body,
    "Legacy body",
  );
  assert.equal(service.getRevision(editor, "legacy-post", 2), null);
  // An earlier version that was never captured cannot be restored.
  assert.throws(
    () => service.restoreRevision(editor, "legacy-post", 6, 2),
    ContentNotFoundError,
  );
  const back = service.restoreRevision(editor, "legacy-post", 6, 5);
  assert.equal(back.body, "Legacy body");
  assert.deepEqual(back.relationships.countyFips, ["08001", "08013"]);
  assert.equal(back.version, 7);
  database.close();
});

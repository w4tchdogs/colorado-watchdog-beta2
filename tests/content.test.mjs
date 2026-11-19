import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { StaleVersionError } from "../dist/database/versioned-writes.js";
import {
  ContentInputError,
  ContentNotFoundError,
  ContentRelationshipError,
  ContentStateError,
  createContentService,
} from "../dist/services/content.js";
import { createServices } from "../dist/services/index.js";
import {
  AuthorizationError,
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";

const SUBJECTS = {
  author: "subject-author",
  editor: "subject-editor",
  outsider: "subject-outsider",
  retired: "subject-retired",
};
const ALLOWED_ACCOUNTS = new Set([
  "acct-author",
  "acct-editor",
  "acct-retired",
]);
const allowSynthetic = (principal) => ALLOWED_ACCOUNTS.has(principal.accountId);

function seed(database) {
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name)
    VALUES ('acct-author','human','contributor','Synthetic Author'),
           ('acct-editor','human','contributor','Synthetic Editor'),
           ('acct-outsider','human','contributor','Synthetic Outsider'),
           ('acct-retired','human','contributor','Synthetic Retired');
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
           ('person-2','Fictional Person Two');
  `);
}

async function fixture(callback, path = ":memory:") {
  const database = await openWebsiteDatabase(path);
  migrateWebsiteDatabase(database);
  if (!database.prepare("SELECT 1 AS found FROM accounts LIMIT 1").get()) {
    seed(database);
  }
  const adapter = createTestHumanIdentityAdapter({
    author: SUBJECTS.author,
    editor: SUBJECTS.editor,
    outsider: SUBJECTS.outsider,
    retired: SUBJECTS.retired,
  });
  const principal = (who) =>
    resolvePrincipal(
      database,
      new Request("https://watchdog.invalid", {
        headers: { "x-test-human-subject": who },
      }),
      adapter,
    );
  const service = createContentService(database, { authorize: allowSynthetic });
  try {
    await callback({ database, principal, service });
  } finally {
    database.close();
  }
}

const auditCount = (database) =>
  database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
const contentCount = (database) =>
  database.prepare("SELECT COUNT(*) AS count FROM content_items").get().count;

test("creates Post and Story drafts with author, editor, and defaults", async () => {
  await fixture(async ({ principal, service }) => {
    const author = await principal("author");
    const post = service.createDraft(author, {
      contentType: "post",
      title: "  Fictional budget notes ",
      summary: "A synthetic summary.",
      body: "# Heading\n\nSynthetic *Markdown* body.",
    });
    const story = service.createDraft(author, {
      contentType: "story",
      title: "Fictional story",
    });

    assert.equal(post.contentType, "post");
    assert.equal(post.title, "Fictional budget notes");
    assert.equal(post.status, "draft");
    assert.equal(post.version, 1);
    assert.equal(post.bodyFormat, "markdown");
    assert.equal(post.createdByAccountId, "acct-author");
    assert.equal(post.lastEditedByAccountId, "acct-author");
    assert.equal(post.archivedAt, null);
    assert.deepEqual(post.relationships, {
      countyFips: [],
      personIds: [],
      organizationIds: [],
    });
    assert.match(post.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(story.contentType, "story");
    assert.equal(story.summary, null);
    assert.equal(story.body, "");
    assert.notEqual(post.id, story.id);
    assert.deepEqual(service.getDraft(author, post.id), post);
    assert.equal(service.getDraft(author, "missing-id"), null);
  });
});

test("version-checked updates track the last editor and keep the original author", async () => {
  await fixture(async ({ principal, service }) => {
    const author = await principal("author");
    const editor = await principal("editor");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Original title",
      body: "Original body",
    });

    const edited = service.updateDraft(editor, draft.id, 1, {
      title: "Edited title",
      summary: "Edited summary",
    });
    assert.equal(edited.version, 2);
    assert.equal(edited.title, "Edited title");
    assert.equal(edited.summary, "Edited summary");
    assert.equal(edited.body, "Original body");
    assert.equal(edited.createdByAccountId, "acct-author");
    assert.equal(edited.lastEditedByAccountId, "acct-editor");
    assert.equal(edited.createdAt, draft.createdAt);

    const cleared = service.updateDraft(author, draft.id, 2, {
      summary: null,
      body: "Edited body",
    });
    assert.equal(cleared.version, 3);
    assert.equal(cleared.summary, null);
    assert.equal(cleared.lastEditedByAccountId, "acct-author");
  });
});

test("stale versions fail without partial changes or audit evidence", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Stable title",
      relationships: { countyFips: ["08001"] },
    });
    service.updateDraft(author, draft.id, 1, { body: "Second version" });
    const before = service.getDraft(author, draft.id);
    const auditBefore = auditCount(database);

    assert.throws(
      () =>
        service.updateDraft(author, draft.id, 1, {
          title: "Stale title",
          relationships: { countyFips: ["08013"], personIds: ["person-1"] },
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
    assert.deepEqual(service.getDraft(author, draft.id), before);
    assert.equal(auditCount(database), auditBefore);
  });
});

test("stores multiple county relationships by explicit FIPS code", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "story",
      title: "Multi-county story",
      relationships: { countyFips: ["08013", "08001", "08001", "08069"] },
    });
    assert.deepEqual(draft.relationships.countyFips, [
      "08001",
      "08013",
      "08069",
    ]);

    const replaced = service.setRelationships(author, draft.id, 1, {
      countyFips: ["08005", "08069"],
    });
    assert.equal(replaced.version, 2);
    assert.deepEqual(replaced.relationships.countyFips, ["08005", "08069"]);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM content_item_counties")
        .get().count,
      2,
    );
  });
});

test("links explicit people and organizations without creating personnel facts", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Context links",
      relationships: {
        personIds: ["person-2", "person-1"],
        organizationIds: ["org-1", "org-2"],
        countyFips: ["08001"],
      },
    });
    assert.deepEqual(draft.relationships, {
      countyFips: ["08001"],
      personIds: ["person-1", "person-2"],
      organizationIds: ["org-1", "org-2"],
    });

    const partial = service.setRelationships(author, draft.id, 1, {
      personIds: ["person-1"],
    });
    assert.deepEqual(partial.relationships.personIds, ["person-1"]);
    assert.deepEqual(partial.relationships.organizationIds, ["org-1", "org-2"]);
    assert.deepEqual(partial.relationships.countyFips, ["08001"]);

    const cleared = service.updateDraft(author, draft.id, 2, {
      relationships: { personIds: [], organizationIds: [] },
    });
    assert.deepEqual(cleared.relationships, {
      countyFips: ["08001"],
      personIds: [],
      organizationIds: [],
    });
    for (const table of [
      "person_roles",
      "positions",
      "role_sources",
      "person_duplicate_flags",
    ]) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
        0,
      );
    }
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM people").get().count,
      2,
    );
  });
});

test("rejects nonexistent and malformed relationship targets", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Target checks",
    });
    const before = contentCount(database);

    assert.throws(
      () =>
        service.createDraft(author, {
          contentType: "post",
          title: "Bad county",
          relationships: { countyFips: ["08999"] },
        }),
      ContentRelationshipError,
    );
    assert.throws(
      () =>
        service.createDraft(author, {
          contentType: "post",
          title: "Bad person",
          relationships: { personIds: ["Fictional Person One"] },
        }),
      ContentRelationshipError,
    );
    assert.throws(
      () =>
        service.setRelationships(author, draft.id, 1, {
          organizationIds: ["nope"],
        }),
      ContentRelationshipError,
    );
    for (const relationships of [
      { countyFips: ["Adams"] },
      { countyFips: ["8001"] },
      { countyFips: "08001" },
      { personIds: [""] },
      { personIds: [42] },
      { organizationIds: Array.from({ length: 51 }, (_, i) => `org-${i}`) },
      { unknownKind: ["x"] },
      {},
    ]) {
      assert.throws(
        () => service.setRelationships(author, draft.id, 1, relationships),
        ContentInputError,
      );
    }
    assert.equal(contentCount(database), before);
    assert.equal(service.getDraft(author, draft.id).version, 1);
  });
});

test("a failing relationship rolls back the whole content change", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Rollback subject",
      body: "Original",
      relationships: { countyFips: ["08001"], personIds: ["person-1"] },
    });
    const before = service.getDraft(author, draft.id);
    const auditBefore = auditCount(database);

    assert.throws(
      () =>
        service.updateDraft(author, draft.id, 1, {
          title: "Should not persist",
          body: "Should not persist",
          relationships: {
            countyFips: ["08013"],
            personIds: ["person-2", "missing-person"],
          },
        }),
      ContentRelationshipError,
    );
    assert.deepEqual(service.getDraft(author, draft.id), before);
    assert.equal(auditCount(database), auditBefore);

    const itemsBefore = contentCount(database);
    assert.throws(
      () =>
        service.createDraft(author, {
          contentType: "story",
          title: "Should not exist",
          relationships: {
            countyFips: ["08001"],
            organizationIds: ["missing-org"],
          },
        }),
      ContentRelationshipError,
    );
    assert.equal(contentCount(database), itemsBefore);
    assert.equal(auditCount(database), auditBefore);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM content_item_counties")
        .get().count,
      1,
    );
  });
});

test("archives and restores drafts and blocks edits while archived", async () => {
  await fixture(async ({ principal, service }) => {
    const author = await principal("author");
    const editor = await principal("editor");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Archive subject",
      relationships: { personIds: ["person-1"] },
    });

    const archived = service.archiveDraft(editor, draft.id, 1);
    assert.equal(archived.status, "archived");
    assert.equal(archived.version, 2);
    assert.match(archived.archivedAt, /Z$/);
    assert.equal(archived.lastEditedByAccountId, "acct-editor");
    assert.deepEqual(archived.relationships.personIds, ["person-1"]);

    assert.throws(
      () => service.updateDraft(author, draft.id, 2, { title: "Blocked" }),
      ContentStateError,
    );
    assert.throws(
      () => service.setRelationships(author, draft.id, 2, { personIds: [] }),
      ContentStateError,
    );
    assert.throws(
      () => service.archiveDraft(author, draft.id, 2),
      ContentStateError,
    );

    const restored = service.restoreDraft(author, draft.id, 2);
    assert.equal(restored.status, "draft");
    assert.equal(restored.version, 3);
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.title, "Archive subject");
    assert.equal(restored.createdByAccountId, "acct-author");
    assert.throws(
      () => service.restoreDraft(author, draft.id, 3),
      ContentStateError,
    );
    assert.throws(
      () => service.restoreDraft(author, draft.id, 2),
      ContentStateError,
    );
    assert.throws(
      () => service.archiveDraft(author, "missing", 1),
      ContentNotFoundError,
    );
    assert.equal(
      service.updateDraft(author, draft.id, 3, { title: "Again" }).version,
      4,
    );
  });
});

test("lists drafts with bounded stable pagination and filters", async () => {
  await fixture(async ({ principal, service }) => {
    const author = await principal("author");
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(
        service.createDraft(author, {
          contentType: index % 2 === 0 ? "post" : "story",
          title: `Fictional draft ${index}`,
          body: "Body text that listings must not return",
        }),
      );
    }
    service.archiveDraft(author, created[0].id, 1);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = service.listDrafts(author, { limit: 2, afterId: cursor });
      assert.ok(page.items.length <= 2);
      for (const item of page.items) {
        assert.equal("body" in item, false);
        assert.equal("relationships" in item, false);
        seen.push(item.id);
      }
      assert.equal(page.hasMore, page.nextCursor !== null);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [...created.map((item) => item.id)].sort());

    assert.equal(
      service.listDrafts(author, { status: "archived" }).items.length,
      1,
    );
    assert.equal(
      service.listDrafts(author, { status: "draft" }).items.length,
      4,
    );
    assert.equal(
      service.listDrafts(author, { contentType: "story" }).items.length,
      2,
    );
    assert.equal(service.listDrafts(author).items.length, 5);

    for (const limit of [0, -1, 1.5, 101, "5"]) {
      assert.throws(
        () => service.listDrafts(author, { limit }),
        ContentInputError,
      );
    }
    assert.throws(
      () => service.listDrafts(author, { status: "published" }),
      ContentInputError,
    );
    assert.throws(
      () => service.listDrafts(author, { contentType: "page" }),
      ContentInputError,
    );
    assert.equal(service.listDrafts(author, { limit: 100 }).items.length, 5);
  });
});

test("denies by default, for unlisted principals, and for inactive principals", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const outsider = await principal("outsider");
    const retired = await principal("retired");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Guarded",
    });
    const auditBefore = auditCount(database);
    const itemsBefore = contentCount(database);

    const denyByDefault = createContentService(database);
    const operations = (svc, who) => [
      () => svc.createDraft(who, { contentType: "post", title: "Denied" }),
      () => svc.getDraft(who, draft.id),
      () => svc.listDrafts(who),
      () => svc.updateDraft(who, draft.id, 1, { title: "Denied" }),
      () => svc.setRelationships(who, draft.id, 1, { countyFips: ["08001"] }),
      () => svc.archiveDraft(who, draft.id, 1),
      () => svc.restoreDraft(who, draft.id, 1),
    ];
    for (const operation of [
      ...operations(denyByDefault, author),
      ...operations(service, outsider),
    ]) {
      assert.throws(operation, AuthorizationError);
    }

    const actionPolicy = createContentService(database, {
      authorize: (_principal, action) => action === "content.read",
    });
    assert.equal(actionPolicy.listDrafts(author).items.length, 1);
    assert.throws(
      () =>
        actionPolicy.createDraft(author, {
          contentType: "post",
          title: "Denied",
        }),
      AuthorizationError,
    );
    for (const authorize of [
      () => 1,
      () => "true",
      () => undefined,
      () => {
        throw new Error("policy failure");
      },
    ]) {
      const broken = createContentService(database, { authorize });
      assert.throws(() => broken.listDrafts(author), AuthorizationError);
    }

    const forged = {
      accountId: author.accountId,
      identityId: author.identityId,
      kind: author.kind,
      role: author.role,
      provider: author.provider,
    };
    assert.throws(() => service.listDrafts(forged), AuthorizationError);
    assert.throws(() => service.listDrafts(null), AuthorizationError);

    database.exec(
      "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'acct-retired'",
    );
    for (const operation of operations(service, retired)) {
      assert.throws(operation, AuthorizationError);
    }
    database.exec(
      "UPDATE accounts SET status = 'active', version = version + 1 WHERE id = 'acct-retired'",
    );
    database.exec(
      "UPDATE identities SET revoked_at = '2026-11-13T00:00:00Z', version = version + 1 WHERE id = 'id-retired'",
    );
    for (const operation of operations(service, retired)) {
      assert.throws(operation, AuthorizationError);
    }

    assert.equal(auditCount(database), auditBefore);
    assert.equal(contentCount(database), itemsBefore);
    assert.equal(service.getDraft(author, draft.id).version, 1);
  });
});

test("rechecks account activity inside the mutation transaction", async () => {
  await fixture(async ({ database, principal }) => {
    const author = await principal("author");
    let calls = 0;
    const racing = createContentService(database, {
      authorize: () => {
        calls += 1;
        if (calls === 2) {
          database.exec(
            "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'acct-author'",
          );
        }
        return true;
      },
    });
    assert.throws(
      () =>
        racing.createDraft(author, { contentType: "post", title: "Racing" }),
      AuthorizationError,
    );
    assert.equal(contentCount(database), 0);
    assert.equal(auditCount(database), 0);
  });
});

test("audits every mutation append-only without content or credentials", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const editor = await principal("editor");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Sensitive-looking title",
      body: "Private body text",
    });
    service.updateDraft(editor, draft.id, 1, { body: "Changed private text" });
    service.setRelationships(editor, draft.id, 2, { countyFips: ["08001"] });
    service.archiveDraft(author, draft.id, 3);
    service.restoreDraft(editor, draft.id, 4);
    service.getDraft(author, draft.id);
    service.listDrafts(author);

    const events = database
      .prepare(
        `SELECT actor_account_id, action, target_type, target_id, summary, details_json
         FROM audit_events ORDER BY created_at, rowid`,
      )
      .all();
    assert.deepEqual(
      events.map((event) => [event.action, event.actor_account_id]),
      [
        ["content.create", "acct-author"],
        ["content.update", "acct-editor"],
        ["content.relationships.set", "acct-editor"],
        ["content.archive", "acct-author"],
        ["content.restore", "acct-editor"],
      ],
    );
    for (const event of events) {
      assert.equal(event.target_type, "content_item");
      assert.equal(event.target_id, draft.id);
      assert.doesNotMatch(
        event.summary + event.details_json,
        /Private|Sensitive|cwa_/,
      );
    }
    assert.deepEqual(JSON.parse(events[1].details_json), {
      fields: "body",
      version: 2,
    });

    assert.throws(() => database.exec("UPDATE audit_events SET summary = 'x'"));
    assert.throws(() => database.exec("DELETE FROM audit_events"));
    assert.equal(auditCount(database), 5);
  });
});

test("validates titles, summaries, bodies, and unknown fields", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Valid",
    });
    const before = contentCount(database);
    const create = (input) => () => service.createDraft(author, input);

    for (const input of [
      { contentType: "page", title: "Bad type" },
      { contentType: "post", title: "" },
      { contentType: "post", title: "   " },
      { contentType: "post", title: "x".repeat(201) },
      { contentType: "post", title: "Line\nbreak" },
      { contentType: "post", title: 42 },
      { contentType: "post", title: "Ok", summary: "" },
      { contentType: "post", title: "Ok", summary: "x".repeat(501) },
      { contentType: "post", title: "Ok", body: "a".repeat(200_001) },
      { contentType: "post", title: "Ok", body: "nul\u0000byte" },
      { contentType: "post", title: "Ok", status: "archived" },
      { contentType: "post", title: "Ok", createdByAccountId: "acct-editor" },
      null,
    ]) {
      assert.throws(create(input), ContentInputError);
    }
    assert.equal(contentCount(database), before);

    for (const changes of [
      {},
      { status: "archived" },
      { version: 9 },
      { title: " " },
      null,
    ]) {
      assert.throws(
        () => service.updateDraft(author, draft.id, 1, changes),
        ContentInputError,
      );
    }
    for (const version of [0, -1, 1.5, "1", undefined]) {
      assert.throws(
        () => service.updateDraft(author, draft.id, version, { title: "Ok" }),
        ContentInputError,
      );
    }

    const exact = service.createDraft(author, {
      contentType: "post",
      title: "x".repeat(200),
      summary: "y".repeat(500),
      body: "b".repeat(200_000),
    });
    assert.equal(exact.body.length, 200_000);
    const raw = service.createDraft(author, {
      contentType: "post",
      title: "Raw HTML stays inert source text",
      body: '<script>alert("synthetic")</script>',
    });
    assert.equal(raw.body, '<script>alert("synthetic")</script>');
    assert.equal(raw.bodyFormat, "markdown");
  });
});

test("SQL constraints protect lifecycle, bounds, origin, and versions", async () => {
  await fixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const draft = service.createDraft(author, {
      contentType: "post",
      title: "Constraints",
    });
    const insert = (columns, values) => () =>
      database
        .prepare(
          `INSERT INTO content_items (id, created_by_account_id, last_edited_by_account_id, ${columns})
           VALUES ('direct-id','acct-author','acct-author', ${values})`,
        )
        .run();

    assert.throws(insert("content_type, title", "'page','t'"));
    assert.throws(insert("content_type, title", "'post',''"));
    assert.throws(
      insert("content_type, title, status", "'post','t','published'"),
    );
    assert.throws(
      insert("content_type, title, status", "'post','t','archived'"),
    );
    assert.throws(
      insert(
        "content_type, title, archived_at",
        "'post','t','2026-11-13T00:00:00Z'",
      ),
    );
    assert.throws(
      insert("content_type, title, body_format", "'post','t','html'"),
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO content_items (id, content_type, title, created_by_account_id, last_edited_by_account_id)
           VALUES ('orphan','post','t','missing-account','missing-account')`,
        )
        .run(),
    );
    for (const statement of [
      `UPDATE content_items SET version = version + 2 WHERE id = '${draft.id}'`,
      `UPDATE content_items SET content_type = 'story', version = version + 1 WHERE id = '${draft.id}'`,
      `UPDATE content_items SET created_by_account_id = 'acct-editor', version = version + 1 WHERE id = '${draft.id}'`,
      `UPDATE content_items SET created_at = '2000-01-01T00:00:00.000Z', version = version + 1 WHERE id = '${draft.id}'`,
      `DELETE FROM accounts WHERE id = 'acct-author'`,
    ]) {
      assert.throws(() => database.exec(statement));
    }
    service.setRelationships(author, draft.id, 1, {
      countyFips: ["08001"],
      personIds: ["person-1"],
      organizationIds: ["org-1"],
    });
    for (const statement of [
      "DELETE FROM people WHERE id = 'person-1'",
      "DELETE FROM organizations WHERE id = 'org-1'",
      "DELETE FROM counties WHERE fips = '08001'",
      `DELETE FROM content_items WHERE id = '${draft.id}'`,
    ]) {
      assert.throws(() => database.exec(statement));
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("content, relationships, and audit persist across database close and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-content-"));
  const path = join(directory, "website.sqlite");
  let draftId;
  try {
    await fixture(async ({ principal, service }) => {
      const author = await principal("author");
      const draft = service.createDraft(author, {
        contentType: "story",
        title: "Persistent story",
        body: "Persistent body",
        relationships: {
          countyFips: ["08001", "08013"],
          personIds: ["person-1"],
          organizationIds: ["org-2"],
        },
      });
      draftId = draft.id;
      service.updateDraft(author, draft.id, 1, {
        summary: "Persistent summary",
      });
      service.archiveDraft(author, draft.id, 2);
    }, path);

    await fixture(async ({ database, principal, service }) => {
      const editor = await principal("editor");
      const item = service.getDraft(editor, draftId);
      assert.equal(item.title, "Persistent story");
      assert.equal(item.summary, "Persistent summary");
      assert.equal(item.status, "archived");
      assert.equal(item.version, 3);
      assert.equal(item.createdByAccountId, "acct-author");
      assert.deepEqual(item.relationships, {
        countyFips: ["08001", "08013"],
        personIds: ["person-1"],
        organizationIds: ["org-2"],
      });
      assert.equal(auditCount(database), 3);
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get().count,
        30,
      );
      const restored = service.restoreDraft(editor, draftId, 3);
      assert.equal(restored.version, 4);
      assert.equal(restored.lastEditedByAccountId, "acct-editor");
    }, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the content service stays internal and unregistered", async () => {
  const services = createServices();
  assert.deepEqual(
    Object.keys(services).filter((name) =>
      /content|draft|post|stor/i.test(name),
    ),
    [],
  );
});

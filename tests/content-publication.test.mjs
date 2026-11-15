import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { createContentPublicationService } from "../dist/services/content-publication.js";
import { createD1EditorialSource } from "../dist/site/d1-editorial-source.js";
import { withContentFixture } from "./content-fixtures.mjs";

function localBinding(database) {
  return {
    prepare(sql) {
      let values;
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async first() {
          return database.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: database.prepare(sql).all(...values),
          };
        },
        runInBatch() {
          database.prepare(sql).run(...values);
        },
      };
    },
    async batch(statements) {
      return database.transaction(() => {
        for (const statement of statements) statement.runInBatch();
        return [];
      })();
    },
  };
}

test("publication preserves the immutable revision and rolls back if audit storage fails", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const editor = await principal("editor");
    const draft = service.createDraft(editor, {
      contentType: "story",
      title: "Fictional field notes",
      body: "Original fictional body",
      relationships: { countyFips: ["08001"], personIds: ["person-1"] },
    });
    const store = new AsyncD1Database(localBinding(database));
    const publish = createContentPublicationService(store, async () => true);
    const publicSource = createD1EditorialSource(store);
    const initial = {
      id: draft.id,
      expectedVersion: 1,
      expectedPublicationVersion: 0,
      slug: "field-notes",
      metadata: { byline: "Fictional Writer" },
    };

    database.exec(`
      CREATE TRIGGER synthetic_publication_audit_failure BEFORE INSERT ON audit_events
      WHEN NEW.action = 'content.publish' BEGIN SELECT RAISE(ABORT, 'fixture'); END;
    `);
    await assert.rejects(publish.publish(editor, initial), {
      name: "StorageUnavailableError",
    });
    assert.equal(await publicSource.get("story", initial.slug), null);
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM content_publications")
        .get().count,
      0,
    );
    database.exec("DROP TRIGGER synthetic_publication_audit_failure");

    assert.equal((await publish.publish(editor, initial)).revisionVersion, 1);
    const edited = service.updateDraft(editor, draft.id, 1, {
      title: "Fictional revised field notes",
      body: "Working-copy canary",
      relationships: { countyFips: ["08013"], personIds: [] },
    });
    assert.equal(edited.version, 2);
    assert.equal(
      service.getRevision(editor, draft.id, 1).body,
      "Original fictional body",
    );
    assert.equal(
      service.getRevision(editor, draft.id, 2).body,
      "Working-copy canary",
    );
    const visible = await publicSource.get("story", initial.slug);
    assert.equal(visible.markdown, "Original fictional body");
    assert.deepEqual(
      visible.related.counties.map(({ fips }) => fips),
      ["08001"],
    );
    assert.deepEqual(
      visible.related.people.map(({ id }) => id),
      ["person-1"],
    );
    assert.throws(() => service.archiveDraft(editor, draft.id, 2), {
      name: "ContentStateError",
    });

    await publish.withdraw(editor, {
      id: draft.id,
      expectedVersion: 2,
      expectedPublicationVersion: 1,
    });
    assert.equal(await publicSource.get("story", initial.slug), null);
    const archived = service.archiveDraft(editor, draft.id, 2);
    await assert.rejects(
      publish.publish(editor, {
        ...initial,
        expectedVersion: archived.version,
        expectedPublicationVersion: 2,
      }),
      { name: "ContentStateError" },
    );

    const restored = service.restoreDraft(editor, draft.id, archived.version);
    const result = await publish.publish(editor, {
      ...initial,
      expectedVersion: restored.version,
      expectedPublicationVersion: 2,
    });
    assert.equal(result.revisionVersion, 4);
    assert.equal(
      (await publicSource.get("story", initial.slug)).markdown,
      "Working-copy canary",
    );
    const audit = database
      .prepare(`
      SELECT action,actor_account_id,details_json FROM audit_events
      WHERE action IN ('content.publish','content.withdraw')
      ORDER BY json_extract(details_json,'$.publicationVersion')
    `)
      .all();
    assert.deepEqual(
      audit.map((row) => ({
        action: row.action,
        actor: row.actor_account_id,
        ...JSON.parse(row.details_json),
      })),
      [
        {
          action: "content.publish",
          actor: editor.accountId,
          publicationVersion: 1,
          revisionVersion: 1,
        },
        {
          action: "content.withdraw",
          actor: editor.accountId,
          publicationVersion: 2,
          revisionVersion: 1,
        },
        {
          action: "content.publish",
          actor: editor.accountId,
          publicationVersion: 3,
          revisionVersion: 4,
        },
      ],
    );
  });
});

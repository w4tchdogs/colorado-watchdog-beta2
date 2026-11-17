import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { StaleVersionError } from "../dist/database/versioned-writes.js";
import { createLocalD1Binding } from "../dist/editor-dev/d1-binding.js";
import {
  ContentInputError,
  ContentRelationshipError,
} from "../dist/services/content.js";
import { createD1ContentService } from "../dist/services/content-d1.js";
import { AuthorizationError } from "../dist/services/security.js";
import {
  allowSynthetic,
  auditCount,
  revisionCount,
  withContentFixture,
} from "./content-fixtures.mjs";

const rel = (county = [], people = [], orgs = []) => ({
  countyFips: county,
  personIds: people,
  organizationIds: orgs,
});
const checkpoint = (
  label,
  title,
  body,
  summary = null,
  relationships = rel(),
) => ({
  label,
  title,
  summary,
  body,
  relationships,
});

/** Runs the same scenarios against the sync service and the D1 service. */
const IMPLEMENTATIONS = {
  sync: ({ service }) => service,
  d1: ({ database }) =>
    createD1ContentService(
      new AsyncD1Database(createLocalD1Binding(database)),
      async (principal) => allowSynthetic(principal),
    ),
};

for (const [name, build] of Object.entries(IMPLEMENTATIONS)) {
  test(`${name}: checkpoints and the final draft save as consecutive revisions`, async () => {
    await withContentFixture(async (context) => {
      const { database, principal } = context;
      const service = build(context);
      const author = await principal("author");
      const draft = await service.createDraft(author, {
        contentType: "post",
        title: "Original",
        body: "Saved body",
      });
      const audits = auditCount(database);
      const saved = await service.saveWithCheckpoints(
        author,
        draft.id,
        1,
        [
          checkpoint(
            "Before AI edit: Rewrite",
            "Manual title",
            "Saved body plus an unsaved manual edit",
            "Manual summary",
            rel(["08001"], ["person-1"]),
          ),
          checkpoint(
            "Before AI edit: Shorten",
            "Manual title",
            "After the first AI edit",
            "Manual summary",
            rel(["08001"], ["person-1"]),
          ),
        ],
        { title: "Final", body: "After the second AI edit" },
      );
      assert.equal(saved.version, 4);
      assert.equal(saved.title, "Final");
      assert.equal(saved.body, "After the second AI edit");
      assert.equal(revisionCount(database, draft.id), 4);
      assert.equal(auditCount(database), audits + 1);
      const first = await service.getRevision(author, draft.id, 2);
      assert.equal(first.checkpointLabel, "Before AI edit: Rewrite");
      assert.equal(first.body, "Saved body plus an unsaved manual edit");
      assert.equal(first.summary, "Manual summary");
      assert.deepEqual(first.relationships.countyFips, ["08001"]);
      const second = await service.getRevision(author, draft.id, 3);
      assert.equal(second.checkpointLabel, "Before AI edit: Shorten");
      assert.equal(second.body, "After the first AI edit");
      const last = await service.getRevision(author, draft.id, 4);
      assert.equal(last.checkpointLabel, null);
      assert.equal(last.body, "After the second AI edit");
      // History lists labels, and restore creates a new revision.
      const page = await service.listRevisions(author, draft.id, {});
      assert.deepEqual(
        page.items.map((item) => item.checkpointLabel),
        [null, "Before AI edit: Shorten", "Before AI edit: Rewrite", null],
      );
      const restored = await service.restoreRevision(author, draft.id, 4, 2);
      assert.equal(restored.version, 5);
      assert.equal(restored.body, "Saved body plus an unsaved manual edit");
      assert.equal(restored.title, "Manual title");
      assert.deepEqual(restored.relationships.personIds, ["person-1"]);
      assert.equal(revisionCount(database, draft.id), 5);
    });
  });

  test(`${name}: a stale version, invalid input or missing target leaves stored content unchanged`, async () => {
    await withContentFixture(async (context) => {
      const { database, principal } = context;
      const service = build(context);
      const author = await principal("author");
      const draft = await service.createDraft(author, {
        contentType: "story",
        title: "Stable",
        body: "Stable body",
      });
      const before = {
        revisions: revisionCount(database),
        audits: auditCount(database),
        item: await service.getDraft(author, draft.id),
      };
      const good = [checkpoint("Before AI edit: Rewrite", "T", "B")];
      const unchanged = async () => {
        assert.equal(revisionCount(database), before.revisions);
        assert.equal(auditCount(database), before.audits);
        assert.deepEqual(await service.getDraft(author, draft.id), before.item);
      };
      await assert.rejects(
        async () =>
          service.saveWithCheckpoints(author, draft.id, 7, good, { body: "x" }),
        StaleVersionError,
      );
      await unchanged();
      for (const bad of [
        [],
        new Array(11).fill(checkpoint("Before AI edit: Rewrite", "T", "B")),
        [checkpoint("<script>", "T", "B")],
        [checkpoint("Before AI edit: Rewrite", "  ", "B")],
        [{ ...good[0], extra: true }],
        [checkpoint("Before AI edit: Rewrite", "T", "B\u0000")],
      ]) {
        await assert.rejects(
          async () =>
            service.saveWithCheckpoints(author, draft.id, 1, bad, {
              body: "x",
            }),
          ContentInputError,
        );
        await unchanged();
      }
      await assert.rejects(
        async () => service.saveWithCheckpoints(author, draft.id, 1, good, {}),
        ContentInputError,
      );
      await unchanged();
      // The second checkpoint fails after the first was staged: all or nothing.
      await assert.rejects(
        async () =>
          service.saveWithCheckpoints(
            author,
            draft.id,
            1,
            [
              checkpoint("Before AI edit: Rewrite", "T", "B"),
              checkpoint("Before AI edit: Shorten", "T", "B2", null, {
                ...rel(),
                personIds: ["person-does-not-exist"],
              }),
            ],
            { body: "x" },
          ),
        ContentRelationshipError,
      );
      await unchanged();
    });
  });

  test(`${name}: checkpoint saves need the update permission`, async () => {
    await withContentFixture(async (context) => {
      const { database, principal } = context;
      const service = build(context);
      const author = await principal("author");
      const draft = await service.createDraft(author, {
        contentType: "post",
        title: "Guarded",
        body: "Body",
      });
      const outsider = await principal("outsider");
      const before = revisionCount(database);
      await assert.rejects(
        async () =>
          service.saveWithCheckpoints(
            outsider,
            draft.id,
            1,
            [checkpoint("Before AI edit: Rewrite", "T", "B")],
            { body: "x" },
          ),
        AuthorizationError,
      );
      assert.equal(revisionCount(database), before);
    });
  });
}

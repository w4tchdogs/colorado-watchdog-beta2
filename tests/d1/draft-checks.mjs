import assert from "node:assert/strict";

/**
 * Draft editing for Posts & Stories on the bundled Worker over the disposable
 * local D1. Everything is synthetic. `signIn` and `send` come from the human
 * sign-in checks so the caller is a real Website session, not a header.
 */
export async function runDraftChecks({ base, send, signIn, editorJar }) {
  const post = (path, body, jar, headers = {}) =>
    send(path, {
      method: "POST",
      jar,
      headers: {
        origin: base,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const call = async (path, body, jar) => {
    const response = await post(path, body, jar);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const drafts = "/internal/content/drafts";
  const revisions = "/internal/content/revisions";

  // Signed-out and contributor callers get nothing, on every draft route.
  const contributor = await signIn("github|wrangler-contributor");
  for (const path of [
    `${drafts}/list`,
    `${drafts}/get`,
    `${drafts}/create`,
    `${revisions}/list`,
  ]) {
    assert.equal((await call(path, {}, undefined)).status, 401, path);
    assert.equal((await call(path, {}, contributor.jar)).status, 403, path);
  }

  const created = await call(
    `${drafts}/create`,
    {
      contentType: "post",
      title: "Synthetic D1 Draft",
      body: "A fictional body for the disposable D1.",
    },
    editorJar,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal(created.body.version, 1);

  const updated = await call(
    `${drafts}/update`,
    {
      id,
      expectedVersion: 1,
      changes: { title: "Synthetic D1 Draft, edited" },
    },
    editorJar,
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.body.version, 2);

  // A stale write is refused and the D1 batch leaves no partial record.
  const stale = await call(
    `${drafts}/update`,
    { id, expectedVersion: 1, changes: { body: "Typed against version 1." } },
    editorJar,
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: "version_conflict" });
  const afterStale = await call(`${drafts}/get`, { id }, editorJar);
  assert.equal(afterStale.body.version, 2);
  assert.equal(afterStale.body.body, "A fictional body for the disposable D1.");
  assert.equal(
    (await call(`${revisions}/list`, { id }, editorJar)).body.items.length,
    2,
  );

  // Relationships, archive, restore and revision restore.
  const related = await call(
    `${drafts}/relationships`,
    { id, expectedVersion: 2, relationships: { countyFips: ["08001"] } },
    editorJar,
  );
  assert.equal(related.status, 200);
  assert.deepEqual(related.body.relationships.countyFips, ["08001"]);
  const missingTarget = await call(
    `${drafts}/relationships`,
    {
      id,
      expectedVersion: 3,
      relationships: { personIds: ["no-such-person"] },
    },
    editorJar,
  );
  assert.equal(missingTarget.status, 422);
  const archived = await call(
    `${drafts}/archive`,
    { id, expectedVersion: 3 },
    editorJar,
  );
  assert.equal(archived.body.status, "archived");
  const restored = await call(
    `${drafts}/restore`,
    { id, expectedVersion: 4 },
    editorJar,
  );
  assert.equal(restored.body.status, "draft");
  assert.equal(restored.body.version, 5);
  const rolledBack = await call(
    `${revisions}/restore`,
    { id, expectedVersion: 5, revisionVersion: 1 },
    editorJar,
  );
  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.body.title, "Synthetic D1 Draft");
  assert.deepEqual(rolledBack.body.relationships.countyFips, []);
  const history = await call(`${revisions}/list`, { id }, editorJar);
  assert.deepEqual(
    history.body.items.map((item) => item.changeKind),
    [
      "restore_revision",
      "restore_draft",
      "archive",
      "relationships",
      "update",
      "create",
    ],
  );
  const list = await call(
    `${drafts}/list`,
    { search: "synthetic d1" },
    editorJar,
  );
  assert.deepEqual(
    list.body.items.map((item) => item.id),
    [id],
  );
  // A contributor still cannot read the draft it never owned.
  assert.equal(
    (await call(`${drafts}/get`, { id }, contributor.jar)).status,
    403,
  );
}

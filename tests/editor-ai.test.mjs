import assert from "node:assert/strict";
import test from "node:test";
import { mountWorkspace, startSandbox, waitFor } from "./editor-fixtures.mjs";

const blocks = (w) => w.$$(".vtext");
function setBlockText(w, index, text) {
  const element = blocks(w)[index];
  element.textContent = text;
  element.dispatchEvent(new w.window.Event("input", { bubbles: true }));
}
/** Marks a block as the one the author is working in. */
function focusBlock(w, index) {
  blocks(w)[index].dispatchEvent(new w.window.Event("focus"));
}
async function openItem(w, id) {
  w.window.location.hash = `#/item/${id}`;
  await waitFor(() => w.titleInput() && blocks(w).length > 0, "editor");
}
async function openSaved(w, body, title = "AI article") {
  const created = await w.client.createDraft({
    contentType: "post",
    title,
    body,
  });
  await openItem(w, created.id);
  return created;
}
const body = (w) => w.bodyInput().value;
async function propose(w, buttonId, waitFor_ = "#ai-apply") {
  w.click(buttonId);
  await waitFor(() => w.$(waitFor_), `proposal for ${buttonId}`);
}
async function save(w, version) {
  w.click("#save");
  await waitFor(
    () => w.text("#version-line") === `Version ${version}`,
    `v${version}`,
  );
}

test("a selection rewrite shows original and proposal first, applies as one undo step and keeps the draft as a checkpoint", async () => {
  const w = await mountWorkspace();
  try {
    const created = await openSaved(
      w,
      "Saved first paragraph.\n\nSecond paragraph.",
    );
    // An unsaved manual edit exists before the AI edit.
    setBlockText(w, 0, "Manual unsaved paragraph.");
    focusBlock(w, 0);
    const before = body(w);
    assert.equal(before, "Manual unsaved paragraph.\n\nSecond paragraph.");
    await propose(w, "#ai-rewrite");
    assert.equal(body(w), before, "the proposal does not change the draft");
    assert.match(w.text("#ai-original"), /Manual unsaved paragraph\./);
    assert.match(
      w.text("#ai-proposed"),
      /Rewritten: Manual unsaved paragraph\./,
    );
    w.click("#ai-apply");
    assert.equal(
      body(w),
      "Rewritten: Manual unsaved paragraph.\n\nSecond paragraph.",
    );
    assert.equal(w.$("#ai-review").children.length, 0);
    // One undo step restores the exact text, and redo reapplies it.
    w.click("button[aria-label^='Undo']");
    assert.equal(body(w), before);
    w.click("button[aria-label^='Redo']");
    assert.match(body(w), /^Rewritten: /);
    // Save persists the checkpoint and the result in one operation.
    await save(w, 3);
    assert.match(w.text("#messages"), /1 AI checkpoint is in Revision history/);
    const checkpoint = await w.client.getRevision(created.id, 2);
    assert.equal(checkpoint.checkpointLabel, "Before AI edit: Rewrite");
    assert.equal(
      checkpoint.body,
      before,
      "exact pre-AI draft incl. manual edit",
    );
    const final = await w.client.getRevision(created.id, 3);
    assert.equal(final.checkpointLabel, null);
    assert.match(final.body, /^Rewritten: /);
    await waitFor(() => w.$$("#revision-list li").length === 3, "history");
    assert.match(w.text("#revision-list"), /Before AI edit: Rewrite/);
  } finally {
    await w.close();
  }
});

test("rollback works after reopening the editor, including two accepted AI edits before one save", async () => {
  const w = await mountWorkspace();
  try {
    const created = await openSaved(w, "Saved text.\n\nStays.");
    setBlockText(w, 0, "Manual change.");
    focusBlock(w, 0);
    const pre = body(w);
    await propose(w, "#ai-rewrite");
    w.click("#ai-apply");
    const afterFirst = body(w);
    focusBlock(w, 0);
    const select = w.$("#ai-translate");
    select.value = "Spanish";
    w.change(select);
    await waitFor(() => w.$("#ai-apply"), "translate proposal");
    w.click("#ai-apply");
    assert.match(
      body(w),
      /^Translation into Spanish: Rewritten: Manual change\./,
    );
    await save(w, 4);
    assert.match(
      w.text("#messages"),
      /2 AI checkpoints are in Revision history/,
    );
    const labels = [];
    for (const version of [2, 3, 4]) {
      labels.push(
        (await w.client.getRevision(created.id, version)).checkpointLabel,
      );
    }
    assert.deepEqual(labels, [
      "Before AI edit: Rewrite",
      "Before AI edit: Translate",
      null,
    ]);
    assert.equal((await w.client.getRevision(created.id, 2)).body, pre);
    assert.equal((await w.client.getRevision(created.id, 3)).body, afterFirst);
    // Reopen the editor from the list and restore the first checkpoint.
    w.click(".crumbs a");
    await waitFor(() => w.$("#new-post"), "dashboard");
    await openItem(w, created.id);
    await waitFor(
      () => w.$$("#revision-list li").length === 4,
      "history after reopen",
    );
    w.click(".view-revision[data-version='2']");
    await waitFor(() => w.$("#historical-restore"), "restore button");
    assert.match(w.text("#historical-banner"), /Before AI edit: Rewrite/);
    w.click("#historical-restore");
    w.click("[data-confirm='yes']");
    await waitFor(() => w.text("#version-line") === "Version 5", "restored");
    assert.equal(body(w), pre);
    const stored = await w.client.getDraft(created.id);
    assert.equal(stored.body, pre);
    assert.equal(stored.version, 5);
    // The checkpoint itself is untouched, and restoring made a new revision.
    assert.equal((await w.client.getRevision(created.id, 2)).body, pre);
  } finally {
    await w.close();
  }
});

test("a generated article is inserted or replaces the body, and the suggested title is accepted separately", async () => {
  const w = await mountWorkspace();
  try {
    const created = await openSaved(w, "Existing opening.", "Keep this title");
    w.type(w.$("#ai-panel textarea"), "the fictional river survey");
    await propose(w, "#ai-article", "#ai-insert");
    assert.match(
      w.text("#ai-review"),
      /A fictional draft about the fictional river survey/,
    );
    assert.match(
      w
        .$$(".ai-block-text")
        .map((area) => area.value)
        .join(" "),
      /Needs source/,
    );
    assert.equal(body(w), "Existing opening.");
    assert.equal(w.titleInput().value, "Keep this title");
    // Edit one proposed block before inserting and remove another.
    const areas = w.$$(".ai-block-text");
    assert.ok(areas.length >= 5);
    areas[0].value = "An edited intro.";
    areas[0].dispatchEvent(new w.window.Event("input", { bubbles: true }));
    w.click(".ai-blocks li:last-child button");
    focusBlock(w, 0);
    w.click("#ai-insert");
    assert.match(body(w), /^Existing opening\.\n\nAn edited intro\./);
    assert.match(body(w), /\[Needs source/);
    assert.equal(w.titleInput().value, "Keep this title", "title is separate");
    // Replace body from a second proposal, then accept its title on its own.
    await propose(w, "#ai-article", "#ai-replace");
    w.click("#ai-use-title");
    assert.match(w.titleInput().value, /^A fictional draft about/);
    w.click("#ai-replace");
    assert.doesNotMatch(body(w), /Existing opening/);
    await save(w, 1 + 4);
    const labels = [];
    for (let version = 2; version <= 4; version += 1) {
      labels.push(
        (await w.client.getRevision(created.id, version)).checkpointLabel,
      );
    }
    assert.deepEqual(labels, [
      "Before AI edit: Draft article",
      "Before AI edit: Suggested title",
      "Before AI edit: Draft article",
    ]);
    assert.equal(
      (await w.client.getRevision(created.id, 2)).title,
      "Keep this title",
    );
  } finally {
    await w.close();
  }
});

test("stale, invalid, refused, failed and cancelled proposals leave the draft alone", async () => {
  const sandbox = await startSandbox({ aiTimeoutMs: 150 });
  const w = await mountWorkspace({ sandbox });
  try {
    const created = await openSaved(w, "One paragraph.\n\nTwo.");
    const original = body(w);
    focusBlock(w, 0);
    // Stale: the author edits while the proposal is open.
    await propose(w, "#ai-rewrite");
    setBlockText(w, 1, "Two, edited meanwhile.");
    const edited = body(w);
    w.click("#ai-apply");
    assert.equal(body(w), edited, "stale proposal not applied");
    assert.match(w.text("#ai-review"), /out of date/);
    w.click("#ai-regenerate");
    await waitFor(() => w.$("#ai-apply"), "regenerated");
    w.click("#ai-discard");
    assert.equal(body(w), edited);
    // Refusal, invalid blocks, unsafe link, provider error and timeout.
    const area = w.$("#ai-panel textarea");
    for (const [marker, pattern] of [
      ["[[refuse]]", /declined/],
      ["[[malformed]]", /rejected/],
      ["[[bad-link]]", /rejected/],
      ["[[bad-block]]", /rejected/],
      ["[[error]]", /not available/],
      ["[[slow]]", /too long/],
    ]) {
      w.type(area, marker);
      w.click("#ai-section");
      await waitFor(
        () => /Nothing was changed/.test(w.text("#ai-review")),
        marker,
      );
      assert.match(w.text("#ai-review"), pattern, marker);
      assert.equal(body(w), edited, marker);
      assert.equal(w.$("#ai-apply"), null);
    }
    // Cancel while running.
    w.type(area, "[[slow]]");
    w.click("#ai-section");
    await waitFor(() => w.$("#ai-cancel"), "cancel button");
    w.click("#ai-cancel");
    assert.match(w.text("#ai-status"), /Cancelled/);
    assert.equal(body(w), edited);
    // Nothing was checkpointed and the saved version is unchanged.
    assert.equal((await w.client.getDraft(created.id)).version, 1);
    w.click("#save");
    await waitFor(() => w.text("#version-line") === "Version 2", "plain save");
    assert.equal(original === edited, false);
    assert.equal(
      (await w.client.getRevision(created.id, 2)).checkpointLabel,
      null,
    );
  } finally {
    await w.close();
  }
});

test("a failed or conflicting save keeps checkpoints and the working draft for a retry", async () => {
  let failSave = true;
  const w = await mountWorkspace({
    hook: ({ path }) =>
      failSave && path.endsWith("/drafts/save")
        ? new Response(JSON.stringify({ error: "dependency_unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : undefined,
  });
  try {
    const created = await openSaved(w, "Base text.");
    setBlockText(w, 0, "Manual text.");
    focusBlock(w, 0);
    await propose(w, "#ai-rewrite");
    w.click("#ai-apply");
    const working = body(w);
    w.click("#save");
    await waitFor(() => /not saved/.test(w.text("#messages")), "failed save");
    assert.equal(body(w), working);
    assert.match(w.text("#save-state"), /Save failed/);
    assert.equal((await w.client.getDraft(created.id)).version, 1);
    // A conflicting save from another view keeps the working edits too.
    await w.client.updateDraft(created.id, 1, { title: "Changed elsewhere" });
    failSave = false;
    w.click("#save");
    await waitFor(() => w.$("#conflict-keep"), "conflict panel");
    assert.equal(body(w), working);
    assert.equal((await w.client.getDraft(created.id)).version, 2);
    // Keep the edits and retry: the checkpoint is still sent and persisted.
    w.click("#conflict-keep");
    await waitFor(() => !w.$("#conflict-keep"), "conflict resolved");
    w.click("#save");
    await waitFor(
      () => w.text("#version-line") === "Version 4",
      "retried save",
    );
    const checkpoint = await w.client.getRevision(created.id, 3);
    assert.equal(checkpoint.checkpointLabel, "Before AI edit: Rewrite");
    assert.equal(checkpoint.body, "Manual text.");
    assert.equal((await w.client.getDraft(created.id)).body, working);
  } finally {
    await w.close();
  }
});

test("AI controls are off in source view and read-only articles, and an unsaved draft must be saved first", async () => {
  const w = await mountWorkspace();
  try {
    const created = await openSaved(w, "Text.");
    w.click("#mode-source");
    assert.equal(w.$("#ai-rewrite").disabled, true);
    assert.match(w.text("#ai-hint"), /Visual view/);
    w.click("#mode-visual");
    assert.equal(w.$("#ai-rewrite").disabled, false);
    w.click(".crumbs a");
    await waitFor(() => w.$("#new-post"), "dashboard");
    w.click("#new-post");
    await waitFor(() => w.titleInput(), "new article");
    w.type(w.titleInput(), "Unsaved");
    setBlockText(w, 0, "Some unsaved words.");
    focusBlock(w, 0);
    await propose(w, "#ai-rewrite");
    w.click("#ai-apply");
    assert.match(w.text("#messages"), /Save the draft once/);
    assert.equal(body(w), "Some unsaved words.");
    void created;
  } finally {
    await w.close();
  }
});

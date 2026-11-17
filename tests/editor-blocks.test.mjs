import assert from "node:assert/strict";
import test from "node:test";
import { serializeBlocks, toVisual } from "../dist/editor/visual-model.js";
import { mountWorkspace, waitFor } from "./editor-fixtures.mjs";

const blocksOf = (source) => {
  const result = toVisual(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.blocks;
};
const canvasBlocks = (w) => w.$$(".vtext");
function setBlockText(w, index, text) {
  const element = canvasBlocks(w)[index];
  element.textContent = text;
  element.dispatchEvent(new w.window.Event("input", { bubbles: true }));
}
async function newVisual(w, selector = "#new-post") {
  await waitFor(() => w.$(selector), "dashboard ready");
  w.click(selector);
  await waitFor(() => w.titleInput(), "new editor");
}
const addBlock = (w, label) => {
  w.click("button[aria-label='Add block']");
  w.click(w.$$(".vmenu-item").find((item) => item.textContent === label));
};

test("model: dividers and image placeholders round trip with alt text and captions", () => {
  const source =
    'Intro\n\n---\n\n![Alt \\[one\\]](image-placeholder "A \\"quoted\\" caption")\n\n![Plain](https://example.invalid/i.png)';
  const blocks = blocksOf(source);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["p", "hr", "image", "image"],
  );
  assert.equal(blocks[2].alt, "Alt [one]");
  assert.equal(blocks[2].caption, 'A "quoted" caption');
  assert.equal(blocks[3].src, "https://example.invalid/i.png");
  assert.equal(serializeBlocks(blocks), source);
});

test("visual: divider, image placeholder, duplicate, outline, preview width and history", async () => {
  const w = await mountWorkspace();
  try {
    await newVisual(w);
    w.type(w.titleInput(), "Blocks");
    setBlockText(w, 0, "Opening");
    addBlock(w, "Heading 2");
    setBlockText(w, 1, "Section one");
    addBlock(w, "Divider");
    addBlock(w, "Image placeholder");
    assert.equal(w.$$(".vdivider").length, 1);
    assert.equal(w.$$(".vimage").length, 1);
    w.type(w.$(".vimage input[id*=alt]"), "A river at dawn");
    w.type(w.$(".vimage input[id*=cap]"), "Fictional river");
    assert.equal(
      w.bodyInput().value,
      'Opening\n\n## Section one\n\n---\n\n![A river at dawn](image-placeholder "Fictional river")',
    );
    w.click("button[aria-label^='Duplicate block']");
    assert.equal(w.$$(".vimage").length, 2);
    const entries = w.$$(".outline button");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].textContent, "Section one");
    w.click(entries[0]);
    assert.equal(w.window.document.activeElement.textContent, "Section one");
    w.click("#save");
    await waitFor(() => w.text("#version-line") === "Version 1", "saved");
    const id = w.window.location.hash.replace("#/item/", "");
    assert.match((await w.client.getDraft(id)).body, /Fictional river/);
    w.click(".crumbs a");
    await waitFor(() => w.$("#new-post"), "dashboard");
    w.window.location.hash = `#/item/${id}`;
    await waitFor(() => w.$$(".vimage").length === 2, "reopened");
    assert.equal(w.$$(".vimage input[id*=alt]")[0].value, "A river at dawn");
    w.click("#toggle-preview");
    assert.equal(w.$("#preview figure.image-placeholder") !== null, true);
    assert.equal(w.$("#preview img"), null);
    assert.equal(w.text("#preview figcaption"), "Fictional river");
    w.click("#preview-narrow");
    assert.equal(w.$("#preview").classList.contains("preview-narrow"), true);
    w.click("#preview-desktop");
    assert.equal(w.$("#preview").classList.contains("preview-narrow"), false);
    w.click("#toggle-preview");
    w.click("#toggle-settings");
    assert.equal(w.$(".settings-panel").hidden, true);
    w.click("#open-history");
    assert.equal(w.$(".settings-panel").hidden, false);
    assert.equal(w.window.document.activeElement.id, "revisions-panel");
  } finally {
    await w.close();
  }
});

const LEGACY = {
  "nested lists": ["- a\n  - nested\n  - nested two\n- b", "source", /nested/],
  "fenced code": [
    "Intro\n\n```js\nconst a = 1;\n```\n\nEnd",
    "source",
    /code block/,
  ],
  "inline code and links": [
    "Use `npm test` and read [the docs](https://example.invalid/docs).",
    "visual",
  ],
  "html comment": ["Before\n\n<!-- editorial note -->\n\nAfter", "visual"],
  "legacy media shortcodes": [
    '[[gallery id=3]]\n\n{{< figure src="a.png" >}}\n\n![alt](https://example.invalid/i.png "Cap")',
    "visual",
  ],
  "inline image": [
    "Text ![alt](https://example.invalid/i.png) more",
    "source",
    /image/,
  ],
  table: ["| a | b |\n| - | - |\n| 1 | 2 |", "visual"],
  "hard break": ["Line one  \nLine two", "source", /line break/],
  "star bullets": ["* a\n* b\n\n__bold__ text", "visual"],
};

test("legacy constructs keep their saved body byte for byte through metadata saves", async () => {
  for (const [name, [body, expectMode, reason]] of Object.entries(LEGACY)) {
    const w = await mountWorkspace();
    try {
      const created = await w.client.createDraft({
        contentType: "post",
        title: `Legacy ${name}`,
        body,
      });
      w.window.location.hash = `#/item/${created.id}`;
      await waitFor(() => w.titleInput(), `editor ${name}`);
      const mode =
        w.$("#mode-source").getAttribute("aria-pressed") === "true"
          ? "source"
          : "visual";
      assert.equal(mode, expectMode, name);
      if (reason) assert.match(w.text("#mode-note"), reason, name);
      w.click("#mode-source");
      w.click("#mode-visual");
      w.click("#mode-source");
      assert.equal(w.bodyInput().value, body, `${name} after toggles`);
      w.type(w.summaryInput(), `Metadata only for ${name}`);
      w.click("#save");
      await waitFor(() => w.text("#version-line") === "Version 2", name);
      assert.equal((await w.client.getDraft(created.id)).body, body, name);
    } finally {
      await w.close();
    }
  }
});

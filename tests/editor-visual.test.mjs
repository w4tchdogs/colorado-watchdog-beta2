import assert from "node:assert/strict";
import test from "node:test";
import {
  roundTrips,
  serializeBlocks,
  toVisual,
} from "../dist/editor/visual-model.js";
import { mountWorkspace, waitFor } from "./editor-fixtures.mjs";

const blocksOf = (source) => {
  const result = toVisual(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.blocks;
};

test("model: supported Markdown opens visually and keeps its meaning", () => {
  const source =
    "## Heading\n\nA **bold** and *italic* [link](https://example.invalid/a_b) line.\n\n> A quote\n\n- one\n- two\n\n1. first\n2. second\n\n### Smaller";
  const blocks = blocksOf(source);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["h2", "p", "quote", "ul", "ul", "ol", "ol", "h3"],
  );
  assert.equal(serializeBlocks(blocks), source);
});

test("model: inline code round trips, including backticks inside", () => {
  for (const source of [
    "Use `npm test` here",
    "Odd ``a ` b`` code",
    "Edge `` `tick` `` pad",
  ]) {
    const blocks = blocksOf(source);
    assert.equal(roundTrips(blocks), true, source);
    assert.equal(blocksOf(serializeBlocks(blocks))[0].text.length > 1, true);
  }
});

test("model: cosmetic variants are accepted without changing meaning", () => {
  const blocks = blocksOf("* a\n* b\n\n__strong__ text\nsecond line");
  assert.equal(blocks.length, 3);
  assert.equal(roundTrips(blocks), true);
});

test("model: syntax it cannot represent stays source-only", () => {
  for (const source of [
    "```\ncode\n```",
    "text\n\n---\n\nmore",
    "- a\n  - nested",
    "> one\n>\n> two",
    "Line one  \nLine two",
    "![alt](https://example.invalid/i.png)",
    "[bad](javascript:alert(1))",
    "##### Deep heading",
    "3. starts at three\n4. next",
  ]) {
    const result = toVisual(source);
    assert.equal(result.ok, false, source);
    assert.ok(result.reason.length > 0);
  }
});

test("model: typed characters that look like Markdown are escaped", () => {
  const texts = [
    "# not a heading",
    "- not a list",
    "1. not a list",
    "> not a quote",
    "2 * 3 * 4 = 24",
    "snake_case and _lead_ and under_",
    "[brackets] and `ticks` and back\\slash",
    "***",
    "<script>alert(1)</script>",
    "a <b>tag</b> & ampersand",
  ];
  for (const text of texts) {
    const blocks = [{ kind: "p", text: [{ t: "text", v: text }] }];
    const markdown = serializeBlocks(blocks);
    assert.equal(roundTrips(blocks), true, text);
    const back = blocksOf(markdown);
    assert.equal(back.length, 1, text);
    assert.equal(back[0].kind, "p", text);
    assert.equal(back[0].text.map((node) => node.v ?? "").join(""), text, text);
  }
});

test("model: whitespace beside emphasis moves outside the marks", () => {
  const blocks = [
    {
      kind: "p",
      text: [
        { t: "text", v: "a" },
        { t: "strong", c: [{ t: "text", v: " bold " }] },
        { t: "text", v: "b" },
        { t: "em", c: [{ t: "text", v: "x" }] },
        { t: "em", c: [{ t: "text", v: "y" }] },
      ],
    },
  ];
  assert.equal(roundTrips(blocks), true);
  assert.equal(serializeBlocks(blocks), "a **bold** b*xy*");
});

// ----------------------------------------------------------- the editor

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
const inMenu = (w, label) =>
  w.$$(".vmenu-item").find((item) => item.textContent === label);
const addBlock = (w, label) => {
  w.click("button[aria-label='Add block']");
  w.click(inMenu(w, label));
};

test("visual: write, format blocks, save and reopen as Markdown", async () => {
  const w = await mountWorkspace();
  try {
    await newVisual(w);
    assert.equal(canvasBlocks(w).length, 1);
    assert.equal(w.$("#mode-visual").getAttribute("aria-pressed"), "true");
    w.type(w.titleInput(), "Visual writing check");
    setBlockText(w, 0, "A fictional opening paragraph.");
    w.click("button[aria-label='Add block']");
    assert.equal(w.$(".vmenu").hidden, false);
    w.click(inMenu(w, "Heading 2"));
    assert.equal(canvasBlocks(w).length, 2);
    setBlockText(w, 1, "A heading");
    addBlock(w, "Bulleted list");
    setBlockText(w, 2, "first");
    addBlock(w, "Bulleted list");
    setBlockText(w, 3, "second");
    const expected =
      "A fictional opening paragraph.\n\n## A heading\n\n- first\n- second";
    assert.equal(w.bodyInput().value, expected);
    assert.match(w.text("#save-state"), /Unsaved changes/);
    w.click("#save");
    await waitFor(() => w.text("#version-line") === "Version 1", "saved");
    assert.match(w.text("#save-state"), /All changes saved/);
    const id = w.window.location.hash.replace("#/item/", "");
    assert.equal((await w.client.getDraft(id)).body, expected);
    w.click(".crumbs a");
    await waitFor(() => w.$("#new-post"), "dashboard");
    w.window.location.hash = `#/item/${id}`;
    await waitFor(() => canvasBlocks(w).length === 4, "reopened visually");
    assert.match(w.text("#preview"), /A heading/);
  } finally {
    await w.close();
  }
});

test("visual: blocks move, change type, are removed, and undo and redo", async () => {
  const w = await mountWorkspace();
  try {
    await newVisual(w);
    setBlockText(w, 0, "One");
    addBlock(w, "Quote");
    setBlockText(w, 1, "Two");
    assert.equal(w.bodyInput().value, "One\n\n> Two");
    w.click("button[aria-label^='Move block up']");
    assert.equal(w.bodyInput().value, "> Two\n\nOne");
    w.click("button[aria-label^='Undo']");
    assert.equal(w.bodyInput().value, "One\n\n> Two");
    w.click("button[aria-label^='Redo']");
    assert.equal(w.bodyInput().value, "> Two\n\nOne");
    const select = w.$("select[aria-label='Block type']");
    select.value = "p";
    w.change(select);
    assert.equal(w.bodyInput().value, "Two\n\nOne");
    w.click("button[aria-label='Remove block']");
    assert.equal(w.bodyInput().value, "One");
    w.click("button[aria-label^='Undo']");
    assert.equal(w.bodyInput().value, "Two\n\nOne");
  } finally {
    await w.close();
  }
});

test("visual: pasted markup is reduced to plain text", async () => {
  const w = await mountWorkspace();
  try {
    await newVisual(w);
    const element = canvasBlocks(w)[0];
    element.focus();
    const event = new w.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    event.clipboardData = {
      getData: () => "<img src=x onerror=alert(1)>\n\nsecond para",
    };
    element.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(w.$(".vcanvas img"), null);
    assert.equal(canvasBlocks(w).length, 2);
    assert.equal(
      w.bodyInput().value,
      "<img src=x onerror=alert(1)>\n\nsecond para",
    );
  } finally {
    await w.close();
  }
});

test("existing drafts keep their exact text through opening, mode switches and unrelated saves", async () => {
  const w = await mountWorkspace();
  try {
    const cosmetic =
      "* star bullet\n* another\n\n__old strong__ text\nwrapped line";
    const created = await w.client.createDraft({
      contentType: "post",
      title: "Legacy cosmetic",
      body: cosmetic,
    });
    w.window.location.hash = `#/item/${created.id}`;
    await waitFor(() => canvasBlocks(w).length === 3, "visual");
    assert.equal(w.bodyInput().value, cosmetic);
    w.click("#mode-source");
    w.click("#mode-visual");
    w.click("#mode-source");
    assert.equal(w.bodyInput().value, cosmetic);
    w.type(w.summaryInput(), "Only the summary changed");
    w.click("#save");
    await waitFor(() => w.text("#version-line") === "Version 2", "saved");
    assert.equal((await w.client.getDraft(created.id)).body, cosmetic);
  } finally {
    await w.close();
  }
});

test("drafts with unsupported syntax stay editable in source view", async () => {
  const w = await mountWorkspace();
  try {
    const source = "Intro\n\n```\ncode   block\n```\n\n---\n\nEnd";
    const created = await w.client.createDraft({
      contentType: "story",
      title: "Has a code block",
      body: source,
    });
    w.window.location.hash = `#/item/${created.id}`;
    await waitFor(() => w.titleInput(), "editor");
    assert.equal(w.$("#mode-source").getAttribute("aria-pressed"), "true");
    assert.equal(w.$(".vcanvas").hidden, true);
    assert.equal(w.$(".source-pane").hidden, false);
    assert.match(w.text("#mode-note"), /code block/);
    assert.equal(w.bodyInput().value, source);
    w.click("#mode-visual");
    assert.equal(w.$("#mode-source").getAttribute("aria-pressed"), "true");
    assert.equal(w.bodyInput().value, source);
    w.type(w.bodyInput(), `${source}\n\nMore`);
    w.click("#save");
    await waitFor(() => w.text("#version-line") === "Version 2", "saved");
    assert.equal(
      (await w.client.getDraft(created.id)).body,
      `${source}\n\nMore`,
    );
  } finally {
    await w.close();
  }
});

test("preview shows the safe article render and returns to editing", async () => {
  const w = await mountWorkspace();
  try {
    await newVisual(w, "#new-story");
    w.type(w.titleInput(), "Preview me");
    setBlockText(w, 0, "Hello <b>there</b>");
    w.click("#toggle-preview");
    assert.equal(w.$("#preview").hidden, false);
    assert.equal(w.$(".vcanvas").hidden, true);
    assert.equal(w.$("#preview b"), null);
    assert.match(w.text("#preview"), /Preview me/);
    assert.match(w.text("#preview"), /Hello <b>there<\/b>/);
    w.click("#toggle-preview");
    assert.equal(w.$("#preview").hidden, true);
    assert.equal(w.$(".vcanvas").hidden, false);
  } finally {
    await w.close();
  }
});

test("settings panel collapses and keeps its content", async () => {
  const w = await mountWorkspace();
  try {
    await newVisual(w);
    const panel = w.$(".settings-panel");
    assert.equal(panel.hidden, false);
    assert.equal(w.$("#toggle-settings").getAttribute("aria-expanded"), "true");
    w.click("#toggle-settings");
    assert.equal(panel.hidden, true);
    assert.equal(
      w.$("#toggle-settings").getAttribute("aria-expanded"),
      "false",
    );
    assert.ok(panel.querySelector("textarea[id$=-summary]"));
    assert.ok(panel.querySelector("#revisions-panel"));
  } finally {
    await w.close();
  }
});

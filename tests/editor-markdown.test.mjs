import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EDITOR_API_PATHS } from "../dist/editor/api-client.js";
import { diffLines, hasChanges } from "../dist/editor/diff.js";
import { parseMarkdown, safeLinkTarget } from "../dist/editor/markdown.js";
import { renderMarkdownInto } from "../dist/editor/preview.js";
import { CONTENT_API_PATHS } from "../dist/transport/content-api.js";

function render(source) {
  const { window } = new JSDOM("<!doctype html><body><div id=r></div>");
  const container = window.document.getElementById("r");
  renderMarkdownInto(window.document, container, source);
  return container;
}

test("preview renders headings, paragraphs, emphasis, lists, quotes, links and code", () => {
  const out = render(
    [
      "# Title",
      "",
      "Para with **bold**, *italic* and `code`.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "",
      "[site](https://example.invalid/a)",
      "",
      "```",
      "block <b>",
      "```",
    ].join("\n"),
  );
  assert.equal(out.querySelector("h1")?.textContent, "Title");
  assert.equal(out.querySelector("strong")?.textContent, "bold");
  assert.equal(out.querySelector("em")?.textContent, "italic");
  assert.equal(out.querySelectorAll("ul li").length, 2);
  assert.equal(out.querySelectorAll("ol li").length, 2);
  assert.equal(out.querySelector("blockquote")?.textContent?.trim(), "quoted");
  assert.equal(
    out.querySelector("pre")?.textContent?.includes("block <b>"),
    true,
  );
  const link = out.querySelector("a");
  assert.equal(link?.getAttribute("href"), "https://example.invalid/a");
  assert.match(link?.getAttribute("rel") ?? "", /noopener/);
});

test("raw HTML and scripts are shown as text and never become elements", () => {
  const out = render(
    '<script>window.pwned=1</script><img src=x onerror="window.pwned=1"><b>x</b>\n\n<iframe src="https://example.invalid"></iframe>',
  );
  for (const tag of ["script", "img", "iframe", "b"]) {
    assert.equal(out.querySelector(tag), null, tag);
  }
  assert.match(out.textContent ?? "", /<script>window\.pwned=1<\/script>/);
  assert.equal(out.innerHTML.includes("<script"), false);
});

test("images and media are omitted rather than loaded", () => {
  const out = render("![alt text](https://example.invalid/x.png)");
  assert.equal(out.querySelector("img"), null);
  assert.match(out.textContent ?? "", /image omitted/);
});

test("unsafe link targets are rejected and render as plain text", () => {
  const unsafe = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>1</script>",
    "vbscript:x",
    "file:///etc/passwd",
    "//example.invalid/x",
    "/relative",
    "https://user:pw@example.invalid/",
    "java\tscript:alert(1)",
  ];
  for (const target of unsafe) {
    assert.equal(safeLinkTarget(target), null, target);
    const out = render(`[click](${target})`);
    assert.equal(out.querySelector("a"), null, target);
  }
  assert.equal(
    safeLinkTarget("https://example.invalid/ok")?.startsWith("https://"),
    true,
  );
  assert.equal(
    safeLinkTarget("mailto:a@example.invalid")?.startsWith("mailto:"),
    true,
  );
});

test("pathological input stays bounded", () => {
  const started = Date.now();
  parseMarkdown("*".repeat(50_000));
  parseMarkdown("[".repeat(20_000));
  parseMarkdown(">".repeat(5_000));
  parseMarkdown("- ".repeat(5_000));
  assert.ok(Date.now() - started < 5_000);
});

test("line diff reports additions and removals and is bounded", () => {
  const diff = diffLines("a\nb\nc", "a\nx\nc");
  assert.equal(hasChanges(diff), true);
  assert.deepEqual(
    diff.map((line) => line.kind),
    ["same", "removed", "added", "same"],
  );
  assert.equal(hasChanges(diffLines("same", "same")), false);
  assert.equal(diffLines("x\n".repeat(2_000), "y\n".repeat(2_000)), null);
});

test("browser client paths match the server transport paths", () => {
  assert.deepEqual(EDITOR_API_PATHS, CONTENT_API_PATHS);
});

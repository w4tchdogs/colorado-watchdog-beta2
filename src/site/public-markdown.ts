import { type Block, type Inline, parseMarkdown } from "../editor/markdown.js";
import { html, type SafeHtml } from "./html.js";

function inline(node: Inline): SafeHtml {
  switch (node.t) {
    case "text":
      return html`${node.v}`;
    case "code":
      return html`<code>${node.v}</code>`;
    case "strong":
      return html`<strong>${node.c.map(inline)}</strong>`;
    case "em":
      return html`<em>${node.c.map(inline)}</em>`;
    case "link":
      return html`<a href="${node.href}">${node.c.map(inline)}</a>`;
    case "br":
      return html`<br>`;
  }
}

function block(node: Block): SafeHtml {
  switch (node.t) {
    case "paragraph":
      return html`<p>${node.c.map(inline)}</p>`;
    case "heading": {
      const text = node.c.map(inline);
      if (node.level <= 2) return html`<h2>${text}</h2>`;
      if (node.level === 3) return html`<h3>${text}</h3>`;
      if (node.level === 4) return html`<h4>${text}</h4>`;
      if (node.level === 5) return html`<h5>${text}</h5>`;
      return html`<h6>${text}</h6>`;
    }
    case "code":
      return html`<pre><code>${node.v}</code></pre>`;
    case "quote":
      return html`<blockquote>${node.c.map(block)}</blockquote>`;
    case "list": {
      const items = node.items.map((item) => html`<li>${item.map(block)}</li>`);
      return node.ordered
        ? html`<ol start="${node.start}">${items}</ol>`
        : html`<ul>${items}</ul>`;
    }
    case "hr":
      return html`<hr>`;
  }
}

export function renderPublicMarkdown(source: string): readonly SafeHtml[] {
  return parseMarkdown(source).map(block);
}

function inlineText(node: Inline): string {
  if ("v" in node) return node.v;
  return "c" in node ? node.c.map(inlineText).join("") : " ";
}

function blockText(node: Block): string {
  switch (node.t) {
    case "paragraph":
    case "heading":
      return node.c.map(inlineText).join("");
    case "quote":
      return node.c.map(blockText).join(" ");
    case "list":
      return node.items.flatMap((item) => item.map(blockText)).join(" ");
    case "code":
      return node.v;
    case "hr":
      return "";
  }
}

export function publicMarkdownText(source: string): string {
  return parseMarkdown(source).map(blockText).join(" ");
}

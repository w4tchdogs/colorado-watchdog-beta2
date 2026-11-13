import { append, clear, el } from "./dom.js";
import { type Block, type Inline, parseMarkdown } from "./markdown.js";

/**
 * Renders untrusted Markdown into the container using createElement and text
 * nodes only. There is no innerHTML, no markup parsing and no script, so raw
 * HTML in an article shows up as literal text.
 */
export function renderMarkdownInto(
  doc: Document,
  container: HTMLElement,
  source: string,
): void {
  clear(container);
  for (const block of parseMarkdown(source)) {
    container.appendChild(renderBlock(doc, block));
  }
}

function renderBlock(doc: Document, block: Block): HTMLElement {
  switch (block.t) {
    case "heading": {
      const tag = `h${Math.min(6, Math.max(1, block.level))}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      const heading = el(doc, tag);
      append(doc, heading, renderInline(doc, block.c));
      return heading;
    }
    case "paragraph": {
      const paragraph = el(doc, "p");
      append(doc, paragraph, renderInline(doc, block.c));
      return paragraph;
    }
    case "code": {
      return el(doc, "pre", {}, el(doc, "code", {}, block.v));
    }
    case "quote": {
      const quote = el(doc, "blockquote");
      for (const child of block.c) {
        quote.appendChild(renderBlock(doc, child));
      }
      return quote;
    }
    case "list": {
      const list = el(doc, block.ordered ? "ol" : "ul", {
        start: block.ordered && block.start !== 1 ? block.start : null,
      });
      for (const item of block.items) {
        const entry = el(doc, "li");
        for (const child of item) {
          entry.appendChild(renderBlock(doc, child));
        }
        list.appendChild(entry);
      }
      return list;
    }
    case "hr":
      return el(doc, "hr");
  }
}

function renderInline(doc: Document, nodes: readonly Inline[]): Node[] {
  return nodes.map((node): Node => {
    switch (node.t) {
      case "text":
        return doc.createTextNode(node.v);
      case "br":
        return el(doc, "br");
      case "code":
        return el(doc, "code", {}, node.v);
      case "strong": {
        const strong = el(doc, "strong");
        append(doc, strong, renderInline(doc, node.c));
        return strong;
      }
      case "em": {
        const emphasis = el(doc, "em");
        append(doc, emphasis, renderInline(doc, node.c));
        return emphasis;
      }
      case "link": {
        const anchor = el(doc, "a", {
          href: node.href,
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        });
        append(doc, anchor, renderInline(doc, node.c));
        return anchor;
      }
      default:
        return doc.createTextNode("");
    }
  });
}

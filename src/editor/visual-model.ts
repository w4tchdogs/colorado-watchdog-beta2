/**
 * Block model behind the visual writing canvas (EDIT-3). Markdown stays the
 * stored body format. This module converts between Markdown and a flat list
 * of blocks and never touches the DOM.
 *
 * A body opens visually only when it converts without loss: the blocks are
 * serialized, parsed again with the same parser and must match. Anything else
 * (code blocks, rules, nested lists, multi-paragraph quotes, inline code,
 * hard breaks, images or links the safe renderer would strip) is reported as
 * unsupported and the draft stays in source view with its text untouched.
 */
import {
  type Block,
  type Inline,
  parseMarkdown,
  safeLinkTarget,
} from "./markdown.js";

export type VKind = "p" | "h1" | "h2" | "h3" | "h4" | "quote" | "ul" | "ol";
export type VInline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "strong"; readonly c: readonly VInline[] }
  | { readonly t: "em"; readonly c: readonly VInline[] }
  | {
      readonly t: "link";
      readonly href: string;
      readonly c: readonly VInline[];
    };

export interface VBlock {
  kind: VKind;
  text: VInline[];
}

export type VisualResult =
  | { readonly ok: true; readonly blocks: VBlock[] }
  | { readonly ok: false; readonly reason: string };

export const KIND_LABELS: Readonly<Record<VKind, string>> = {
  p: "Paragraph",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  quote: "Quote",
  ul: "Bulleted list item",
  ol: "Numbered list item",
};

class Unsupported extends Error {}

function fail(reason: string): never {
  throw new Unsupported(reason);
}

// ---------------------------------------------------------------- inline

function fromInline(nodes: readonly Inline[]): VInline[] {
  return nodes.map((node): VInline => {
    switch (node.t) {
      case "text":
        if (
          node.v.includes("(link removed:") ||
          node.v.includes("[image omitted")
        ) {
          fail("a link or image the safe renderer would remove");
        }
        return { t: "text", v: node.v };
      case "strong":
        return { t: "strong", c: fromInline(node.c) };
      case "em":
        return { t: "em", c: fromInline(node.c) };
      case "link":
        return { t: "link", href: node.href, c: fromInline(node.c) };
      case "code":
        return { t: "code", v: node.v };
      case "br":
        return fail("a hard line break");
      default:
        return fail("unknown inline content");
    }
  });
}

const WS_START = /^\s+/;
const WS_END = /\s+$/;

/** Canonical form: merged, no empties, no edge whitespace inside marks. */
export function normalizeInline(nodes: readonly VInline[]): VInline[] {
  const out: VInline[] = [];
  const push = (node: VInline) => {
    const last = out[out.length - 1];
    if (node.t === "text") {
      if (node.v === "") return;
      if (last?.t === "text") {
        out[out.length - 1] = { t: "text", v: last.v + node.v };
      } else out.push(node);
      return;
    }
    if (node.t === "code") {
      if (node.v !== "") out.push(node);
      return;
    }
    if (node.c.length === 0) return;
    if (
      last &&
      last.t === node.t &&
      (node.t !== "link" || (last as typeof node).href === node.href)
    ) {
      out[out.length - 1] = {
        ...last,
        c: normalizeInline([...(last as typeof node).c, ...node.c]),
      } as VInline;
      return;
    }
    out.push(node);
  };
  for (const node of nodes) {
    if (node.t === "text") {
      push({
        t: "text",
        v: node.v.replace(/ /g, " ").replace(/\n/g, " "),
      });
      continue;
    }
    if (node.t === "code") {
      push(node);
      continue;
    }
    const children = normalizeInline(node.c);
    if (node.t === "link") {
      push({ t: "link", href: node.href, c: children });
      continue;
    }
    // Emphasis cannot start or end with whitespace in Markdown, so move it out.
    let lead = "";
    let trail = "";
    const first = children[0];
    if (first?.t === "text") {
      const match = WS_START.exec(first.v);
      if (match) {
        lead = match[0];
        children[0] = { t: "text", v: first.v.slice(lead.length) };
      }
    }
    const last = children[children.length - 1];
    if (last?.t === "text") {
      const match = WS_END.exec(last.v);
      if (match) {
        trail = match[0];
        children[children.length - 1] = {
          t: "text",
          v: last.v.slice(0, last.v.length - trail.length),
        };
      }
    }
    push({ t: "text", v: lead });
    push({ t: node.t, c: normalizeInline(children) } as VInline);
    push({ t: "text", v: trail });
  }
  return out;
}

/** Trims whitespace at the outer edges of a block and normalizes. */
export function normalizeBlockText(nodes: readonly VInline[]): VInline[] {
  const out = normalizeInline(nodes);
  const first = out[0];
  if (first?.t === "text") {
    out[0] = { t: "text", v: first.v.replace(WS_START, "") };
  }
  const last = out[out.length - 1];
  if (last?.t === "text") {
    out[out.length - 1] = { t: "text", v: last.v.replace(WS_END, "") };
  }
  return normalizeInline(out);
}

export const isEmptyText = (nodes: readonly VInline[]): boolean =>
  normalizeBlockText(nodes).length === 0;

function escapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (ch === "\\" || ch === "`" || ch === "*" || ch === "[" || ch === "]") {
      out += `\\${ch}`;
    } else if (ch === "_") {
      const before = value[i - 1] ?? "";
      const after = value[i + 1] ?? "";
      out +=
        /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after) ? ch : "\\_";
    } else out += ch;
  }
  return out;
}

function balancedParens(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function inlineToMarkdown(nodes: readonly VInline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case "text":
          return escapeText(node.v);
        case "code": {
          const longest = Math.max(
            0,
            ...(node.v.match(/`+/g) ?? []).map((run) => run.length),
          );
          const ticks = "`".repeat(longest + 1);
          const pad = /^`|`$/.test(node.v) || /^ .* $/.test(node.v) ? " " : "";
          return `${ticks}${pad}${node.v}${pad}${ticks}`;
        }
        case "strong":
          return `**${inlineToMarkdown(node.c)}**`;
        case "em":
          return `*${inlineToMarkdown(node.c)}*`;
        case "link": {
          const href = balancedParens(node.href)
            ? node.href
            : node.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
          return `[${inlineToMarkdown(node.c)}](${href})`;
        }
        default:
          return "";
      }
    })
    .join("");
}

/** Escapes a leading character that would otherwise start another block. */
function guardLineStart(text: string): string {
  if (/^[#>+\-~]/.test(text)) return `\\${text}`;
  if (/^\d{1,9}[.)]/.test(text)) {
    return text.replace(/^(\d{1,9})([.)])/, "$1\\$2");
  }
  return text;
}

// ----------------------------------------------------------------- blocks

export function serializeBlocks(blocks: readonly VBlock[]): string {
  const parts: string[] = [];
  let run: { kind: "ul" | "ol"; lines: string[] } | null = null;
  const flush = () => {
    if (run) parts.push(run.lines.join("\n"));
    run = null;
  };
  for (const block of blocks) {
    const text = normalizeBlockText(block.text);
    if (text.length === 0) continue;
    const md = inlineToMarkdown(text);
    if (block.kind === "ul" || block.kind === "ol") {
      if (run && run.kind !== block.kind) flush();
      if (!run) run = { kind: block.kind, lines: [] };
      run.lines.push(
        block.kind === "ul"
          ? `- ${guardLineStart(md)}`
          : `${run.lines.length + 1}. ${guardLineStart(md)}`,
      );
      continue;
    }
    flush();
    if (block.kind === "quote") parts.push(`> ${guardLineStart(md)}`);
    else if (block.kind === "p") parts.push(guardLineStart(md));
    else parts.push(`${"#".repeat(Number(block.kind[1]))} ${md}`);
  }
  flush();
  return parts.join("\n\n");
}

function onlyParagraph(blocks: readonly Block[], what: string): VInline[] {
  const only = blocks[0];
  if (blocks.length !== 1 || only?.t !== "paragraph") {
    return fail(what);
  }
  return fromInline(only.c);
}

function fromTree(tree: readonly Block[]): VBlock[] {
  const out: VBlock[] = [];
  for (const block of tree) {
    switch (block.t) {
      case "paragraph":
        out.push({ kind: "p", text: fromInline(block.c) });
        break;
      case "heading":
        if (block.level > 4) fail("a heading below level 4");
        out.push({
          kind: `h${block.level}` as VKind,
          text: fromInline(block.c),
        });
        break;
      case "quote":
        out.push({
          kind: "quote",
          text: onlyParagraph(block.c, "a quote with several blocks"),
        });
        break;
      case "list": {
        if (block.ordered && block.start !== 1) {
          fail("a numbered list that does not start at 1");
        }
        for (const item of block.items) {
          out.push({
            kind: block.ordered ? "ol" : "ul",
            text: onlyParagraph(item, "a nested or multi-paragraph list item"),
          });
        }
        break;
      }
      case "code":
        fail("a code block");
        break;
      case "hr":
        fail("a horizontal rule");
        break;
    }
  }
  return out;
}

const canonical = (blocks: readonly VBlock[]): string =>
  JSON.stringify(
    blocks
      .map((block) => ({ k: block.kind, t: normalizeBlockText(block.text) }))
      .filter((block) => block.t.length > 0),
  );

function* walk(nodes: readonly VInline[]): Generator<VInline> {
  for (const node of nodes) {
    yield node;
    if (node.t !== "text" && node.t !== "code") yield* walk(node.c);
  }
}

/** Converts Markdown to blocks, or explains why the visual editor cannot. */
export function toVisual(source: string): VisualResult {
  try {
    const blocks = fromTree(parseMarkdown(source));
    for (const block of blocks) {
      for (const node of walk(block.text)) {
        if (node.t === "link" && safeLinkTarget(node.href) === null) {
          fail("a link target that is not allowed");
        }
      }
    }
    if (!roundTrips(blocks)) {
      fail("formatting that does not survive a visual round trip");
    }
    return { ok: true, blocks };
  } catch (error) {
    if (error instanceof Unsupported) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

/**
 * True when the serialized Markdown parses back to the same blocks. The
 * canvas checks this after each edit so it can warn instead of silently
 * writing something that reads differently.
 */
export function roundTrips(blocks: readonly VBlock[]): boolean {
  try {
    return (
      canonical(blocks) ===
      canonical(fromTree(parseMarkdown(serializeBlocks(blocks))))
    );
  } catch {
    return false;
  }
}

export const cloneBlocks = (blocks: readonly VBlock[]): VBlock[] =>
  blocks.map((block) => ({
    kind: block.kind,
    text: normalizeBlockText(block.text),
  }));

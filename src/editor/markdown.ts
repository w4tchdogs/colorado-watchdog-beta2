/**
 * Small, dependency-free Markdown parser that produces a plain-object tree.
 * It never produces markup. Raw HTML is kept as literal text, images are not
 * supported (media is out of scope) and links survive only when the target is
 * an allowlisted absolute URL. A separate renderer turns the tree into DOM
 * nodes with text nodes only, so no input can create a script or handler.
 */
export type Inline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "strong"; readonly c: readonly Inline[] }
  | { readonly t: "em"; readonly c: readonly Inline[] }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "link"; readonly href: string; readonly c: readonly Inline[] }
  | { readonly t: "br" };

export type Block =
  | {
      readonly t: "heading";
      readonly level: number;
      readonly c: readonly Inline[];
    }
  | { readonly t: "paragraph"; readonly c: readonly Inline[] }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "quote"; readonly c: readonly Block[] }
  | {
      readonly t: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly Block[])[];
    }
  | { readonly t: "hr" }
  | {
      /** A paragraph that is only one image. Never loaded, shown as a placeholder. */
      readonly t: "figure";
      readonly alt: string;
      readonly src: string;
      readonly caption: string;
    };

export const MAX_BLOCK_DEPTH = 6;
export const MAX_INLINE_DEPTH = 8;
/** Longer paragraphs are shown as plain text to bound parsing work. */
export const MAX_FORMATTED_PARAGRAPH = 20_000;
const EMPHASIS_WINDOW = 5_000;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const WHITESPACE = /\s/;

function hasWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (WHITESPACE.test(character)) return true;
  }
  return false;
}

/** Returns a normalized URL for allowlisted targets, otherwise null. */
export function safeLinkTarget(raw: string): string | null {
  const target = raw.trim();
  if (
    target.length === 0 ||
    target.length > 2_048 ||
    hasWhitespaceOrControl(target)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.protocol !== "mailto:" && (url.username || url.password)) {
    return null;
  }
  if (url.protocol !== "mailto:" && url.hostname === "") {
    return null;
  }
  return url.href;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isRule(line: string): boolean {
  const text = line.trim();
  return (
    text.length >= 3 &&
    (/^-{3,}$/.test(text) || /^\*{3,}$/.test(text) || /^_{3,}$/.test(text))
  );
}

function isQuoteLine(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    isQuoteLine(line) ||
    LIST_MARKER.test(line) ||
    isRule(line)
  );
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    if (depth >= MAX_BLOCK_DEPTH) {
      blocks.push({ t: "paragraph", c: [{ t: "text", v: line.trim() }] });
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = (fence[1] as string)[0] as string;
      const size = (fence[1] as string).length;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] as string;
        const closing = current.trim();
        if (
          closing.length >= size &&
          [...closing].every((character) => character === marker)
        ) {
          index += 1;
          break;
        }
        body.push(current);
        index += 1;
      }
      blocks.push({ t: "code", v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      let text = (heading[2] as string).trimEnd();
      while (text.endsWith("#")) {
        text = text.slice(0, -1);
      }
      blocks.push({
        t: "heading",
        level: (heading[1] as string).length,
        c: parseInline(text.trim(), 0),
      });
      index += 1;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ t: "hr" });
      index += 1;
      continue;
    }
    if (isQuoteLine(line)) {
      const inner: string[] = [];
      while (index < lines.length && isQuoteLine(lines[index] as string)) {
        inner.push((lines[index] as string).replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      blocks.push({ t: "quote", c: parseBlocks(inner, depth + 1) });
      continue;
    }
    const marker = LIST_MARKER.exec(line);
    if (marker) {
      const ordered = /\d/.test(marker[2] as string);
      const start = ordered ? Number.parseInt(marker[2] as string, 10) : 1;
      const items: Block[][] = [];
      while (index < lines.length) {
        const current = LIST_MARKER.exec(lines[index] as string);
        if (!current || /\d/.test(current[2] as string) !== ordered) {
          break;
        }
        const itemLines: string[] = [current[3] as string];
        index += 1;
        while (index < lines.length) {
          const next = lines[index] as string;
          if (isBlank(next)) {
            const after = lines[index + 1];
            if (
              after !== undefined &&
              (/^ {2,}\S/.test(after) ||
                (LIST_MARKER.test(after) &&
                  /\d/.test((LIST_MARKER.exec(after)?.[2] ?? "") as string) ===
                    ordered))
            ) {
              itemLines.push("");
              index += 1;
              continue;
            }
            break;
          }
          if (/^ {2,}\S/.test(next)) {
            itemLines.push(next.replace(/^ {1,4}/, ""));
            index += 1;
            continue;
          }
          if (startsBlock(next)) {
            break;
          }
          itemLines.push(next);
          index += 1;
        }
        items.push(parseBlocks(itemLines, depth + 1));
        while (index < lines.length && isBlank(lines[index] as string)) {
          const after = lines[index + 1];
          if (after !== undefined && LIST_MARKER.test(after)) {
            index += 1;
          } else {
            break;
          }
        }
      }
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      !isBlank(lines[index] as string) &&
      (paragraph.length === 0 || !startsBlock(lines[index] as string))
    ) {
      paragraph.push(lines[index] as string);
      index += 1;
    }
    const text = paragraph.map((entry) => entry.trimStart()).join("\n");
    const figure = readFigure(text);
    if (figure) {
      blocks.push(figure);
      continue;
    }
    blocks.push({
      t: "paragraph",
      c:
        text.length > MAX_FORMATTED_PARAGRAPH
          ? [{ t: "text", v: text }]
          : parseInline(text, 0),
    });
  }
  return blocks;
}

const ESCAPABLE = "\\`*_{}[]()#+-.!<>~|&\"'";

export function parseInline(source: string, depth: number): Inline[] {
  if (depth > MAX_INLINE_DEPTH) {
    return source.length > 0 ? [{ t: "text", v: source }] : [];
  }
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      out.push({ t: "text", v: buffer });
      buffer = "";
    }
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "\n") {
        flush();
        out.push({ t: "br" });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.includes(next)) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      if (buffer.endsWith("  ")) {
        buffer = buffer.trimEnd();
        flush();
        out.push({ t: "br" });
      } else {
        buffer = buffer.trimEnd();
        buffer += " ";
      }
      i += 1;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (source[i + run] === "`") {
        run += 1;
      }
      const ticks = "`".repeat(run);
      const close = findExactRun(source, ticks, i + run);
      if (close !== -1) {
        flush();
        let code = source.slice(i + run, close).replace(/\n/g, " ");
        if (
          code.length > 2 &&
          code.startsWith(" ") &&
          code.endsWith(" ") &&
          code.trim().length > 0
        ) {
          code = code.slice(1, -1);
        }
        out.push({ t: "code", v: code });
        i = close + run;
        continue;
      }
      buffer += ticks;
      i += run;
      continue;
    }
    if (ch === "!" && source[i + 1] === "[") {
      const link = readLink(source, i + 1);
      if (link) {
        buffer += `[image omitted: ${link.text}]`;
        i = link.end;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      const link = readLink(source, i);
      if (link) {
        flush();
        const children = parseInline(link.text, depth + 1);
        const href = safeLinkTarget(link.target);
        if (href !== null) {
          out.push({ t: "link", href, c: stripLinks(children) });
        } else {
          out.push(...children, {
            t: "text",
            v: " (link removed: unsafe or unsupported target)",
          });
        }
        i = link.end;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "_") {
      const double = source[i + 1] === ch;
      const width = double ? 2 : 1;
      const delimiter = ch.repeat(width);
      const before = i > 0 ? (source[i - 1] as string) : "";
      const after = source[i + width] ?? "";
      const intraword = ch === "_" && /[A-Za-z0-9]/.test(before);
      if (!intraword && after !== "" && !/\s/.test(after)) {
        const close = findEmphasisClose(source, delimiter, i + width, ch);
        if (close !== -1) {
          const inner = source.slice(i + width, close);
          flush();
          out.push({
            t: double ? "strong" : "em",
            c: parseInline(inner, depth + 1),
          });
          i = close + width;
          continue;
        }
      }
      buffer += double ? delimiter : ch;
      i += width;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

function findExactRun(source: string, ticks: string, from: number): number {
  let position = source.indexOf(ticks, from);
  while (position !== -1) {
    const beforeOk = source[position - 1] !== "`";
    const afterOk = source[position + ticks.length] !== "`";
    if (beforeOk && afterOk) {
      return position;
    }
    position = source.indexOf(ticks, position + 1);
  }
  return -1;
}

function findEmphasisClose(
  source: string,
  delimiter: string,
  from: number,
  ch: string,
): number {
  const limit = Math.min(source.length, from + EMPHASIS_WINDOW);
  let position = from;
  while (position < limit) {
    const found = source.indexOf(delimiter, position);
    if (found === -1 || found >= limit) {
      return -1;
    }
    const previous = source[found - 1] as string;
    const next = source[found + delimiter.length] ?? "";
    const adjacentSame =
      delimiter.length === 1 ? next === ch || previous === ch : next === ch;
    const closesWord =
      ch === "_" && /[A-Za-z0-9]/.test(next) && delimiter.length === 1;
    if (found > from && !/\s/.test(previous) && !adjacentSame && !closesWord) {
      return found;
    }
    position = found + 1;
  }
  return -1;
}

interface LinkParse {
  readonly text: string;
  readonly target: string;
  readonly title: string;
  readonly end: number;
}

/** A paragraph made only of one image becomes a figure placeholder. */
function readFigure(text: string): Block | null {
  const trimmed = text.trimEnd();
  if (!trimmed.startsWith("![") || trimmed.includes("\n")) return null;
  const link = readLink(trimmed, 1);
  if (!link || link.end !== trimmed.length || link.target === "") return null;
  return {
    t: "figure",
    alt: link.text.replace(/\\([\\[\]])/g, "$1"),
    src: link.target,
    caption: link.title,
  };
}

function readLink(source: string, open: number): LinkParse | null {
  let depth = 0;
  let close = -1;
  const limit = Math.min(source.length, open + 1_000);
  for (let position = open; position < limit; position += 1) {
    const ch = source[position];
    if (ch === "\\") {
      position += 1;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = position;
        break;
      }
    }
  }
  if (close === -1 || source[close + 1] !== "(") {
    return null;
  }
  let parens = 0;
  let end = -1;
  const targetLimit = Math.min(source.length, close + 2_100);
  for (let position = close + 1; position < targetLimit; position += 1) {
    const ch = source[position];
    if (ch === "\\") {
      position += 1;
    } else if (ch === "(") {
      parens += 1;
    } else if (ch === ")") {
      parens -= 1;
      if (parens === 0) {
        end = position;
        break;
      }
    } else if (ch === "\n") {
      return null;
    }
  }
  if (end === -1) {
    return null;
  }
  const inside = source.slice(close + 2, end).trim();
  const target = inside.split(/[ \t]/, 1)[0] ?? "";
  const rest = inside.slice(target.length).trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(rest);
  return {
    title: quoted ? (quoted[1] as string).replace(/\\(["\\])/g, "$1") : "",
    text: source.slice(open + 1, close),
    target:
      target.startsWith("<") && target.endsWith(">")
        ? target.slice(1, -1)
        : target,
    end: end + 1,
  };
}

function stripLinks(nodes: readonly Inline[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.t === "link") {
      return stripLinks(node.c);
    }
    if (node.t === "strong" || node.t === "em") {
      return [{ t: node.t, c: stripLinks(node.c) }];
    }
    return [node];
  });
}

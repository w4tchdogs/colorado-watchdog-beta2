/**
 * Minimal escaped-by-default HTML templating for the public site. Every
 * interpolated string is escaped; only values produced by this module's `html`
 * tag (or `trusted` for reviewed static markup) are inserted as markup.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type HtmlValue =
  | SafeHtml
  | string
  | number
  | null
  | undefined
  | false
  | readonly HtmlValue[];

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (character) => ESCAPES[character] ?? "");
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return escapeHtml(value);
  return value.map(render).join("");
}

export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  let output = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    output += render(values[index]) + (strings[index + 1] ?? "");
  }
  return new SafeHtml(output);
}

/** Only for constant markup written in this repository, never for data. */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/**
 * Returns a normalized absolute http(s) URL, or null. Stored source URLs are
 * data, so anything else (javascript:, data:, relative paths, credentials) is
 * never rendered as a link.
 */
export function safeExternalUrl(value: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

export function externalHost(value: string): string | null {
  const href = safeExternalUrl(value);
  return href ? new URL(href).host : null;
}

/** Builds an internal path from literal segments and encoded identifiers. */
export function path(...segments: readonly string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function withQuery(
  pathname: string,
  parameters: Readonly<Record<string, string | null | undefined>>,
  fragment?: string,
): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined && value !== "") {
      search.set(name, value);
    }
  }
  const query = search.toString();
  return `${pathname}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`;
}

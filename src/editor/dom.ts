/**
 * Tiny DOM helper for the editorial workspace. Text always goes through text
 * nodes and attributes through setAttribute, so no helper ever parses markup.
 * Event-handler attributes are refused outright.
 */
export type Child = Node | string | null | undefined | false;
export type Attributes = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]*$/;

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (!ATTRIBUTE_NAME.test(name) || name.startsWith("on")) {
      throw new Error("Unsupported attribute");
    }
    element.setAttribute(name, value === true ? "" : String(value));
  }
  append(doc, element, children);
  return element;
}

export function append(
  doc: Document,
  parent: Node,
  children: readonly Child[],
): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    parent.appendChild(
      typeof child === "string" ? doc.createTextNode(child) : child,
    );
  }
}

export function clear(node: Node): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function replaceChildren(
  doc: Document,
  parent: Node,
  ...children: Child[]
): void {
  clear(parent);
  append(doc, parent, children);
}

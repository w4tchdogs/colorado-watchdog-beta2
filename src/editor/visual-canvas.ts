/**
 * Visual writing canvas (EDIT-3). A column of editable blocks plus a toolbar
 * for formatting, inserting, moving and undoing. The model is the flat block
 * list from visual-model.ts and the canvas reports Markdown after each edit.
 * The DOM is built with createElement and text nodes only, and edited DOM is
 * read back through an allowlist (text, strong, em, safe links), so pasted or
 * dragged markup never reaches the stored body.
 */
import { clear, el } from "./dom.js";
import { safeLinkTarget } from "./markdown.js";
import {
  cloneBlocks,
  isEmptyText,
  KIND_LABELS,
  normalizeBlockText,
  roundTrips,
  serializeBlocks,
  type VBlock,
  type VInline,
  type VKind,
} from "./visual-model.js";

export interface CanvasOptions {
  readonly doc: Document;
  readonly blocks: readonly VBlock[];
  readonly readOnly: boolean;
  readonly idPrefix: string;
  /** Called after every edit with the Markdown for the whole body. */
  readonly onChange: (markdown: string) => void;
  /** Called when an edit cannot be written as Markdown that reads the same. */
  readonly onRoundTripWarning: (warn: boolean) => void;
  readonly onNotice: (kind: "info" | "error", text: string) => void;
  readonly checkpointDelayMs?: number;
}

export interface Canvas {
  /** The editable column. */
  readonly element: HTMLElement;
  /** Toolbar controls for the top bar. */
  readonly tools: HTMLElement;
  /** The inline link form, shown under the top bar when open. */
  readonly linkForm: HTMLElement;
  setBlocks(blocks: readonly VBlock[]): void;
  setReadOnly(value: boolean): void;
  focus(): void;
  undo(): void;
  redo(): void;
  destroy(): void;
}

const INSERTABLE: readonly VKind[] = ["p", "h2", "h3", "ul", "ol", "quote"];
const HISTORY_LIMIT = 200;

// ------------------------------------------------------- DOM <-> inline

export function domToInline(parent: Node): VInline[] {
  const out: VInline[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      out.push({ t: "text", v: node.textContent ?? "" });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") continue;
    if (tag === "code") {
      out.push({ t: "code", v: element.textContent ?? "" });
      continue;
    }
    const children = domToInline(element);
    if (tag === "strong" || tag === "b") out.push({ t: "strong", c: children });
    else if (tag === "em" || tag === "i") out.push({ t: "em", c: children });
    else if (tag === "a") {
      const href = safeLinkTarget(element.getAttribute("href") ?? "");
      if (href) out.push({ t: "link", href, c: children });
      else out.push(...children);
    } else out.push(...children);
  }
  return out;
}

function inlineToDom(doc: Document, nodes: readonly VInline[], parent: Node) {
  for (const node of nodes) {
    if (node.t === "text") {
      parent.appendChild(doc.createTextNode(node.v));
      continue;
    }
    if (node.t === "code") {
      parent.appendChild(el(doc, "code", {}, node.v));
      continue;
    }
    const element =
      node.t === "strong"
        ? el(doc, "strong")
        : node.t === "em"
          ? el(doc, "em")
          : el(doc, "a", { href: node.href });
    inlineToDom(doc, node.c, element);
    parent.appendChild(element);
  }
}

// ----------------------------------------------------------------- caret

function caretOffset(doc: Document, element: HTMLElement): number | null {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return null;
  const before = doc.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function setCaret(doc: Document, element: HTMLElement, offset: number) {
  const selection = doc.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(element, 4);
  let remaining = offset;
  let placed = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      range.setStart(node, remaining);
      placed = true;
      break;
    }
    remaining -= length;
  }
  if (!placed) {
    range.selectNodeContents(element);
    range.collapse(false);
  } else range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// ------------------------------------------------------------- component

export function createVisualCanvas(options: CanvasOptions): Canvas {
  const { doc } = options;
  const win = doc.defaultView;
  const checkpointDelay = options.checkpointDelayMs ?? 500;
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);

  let blocks: VBlock[] = cloneBlocks(options.blocks);
  if (blocks.length === 0) blocks = [{ kind: "p", text: [] }];
  let readOnly = options.readOnly;
  let current = 0;
  let past: string[] = [];
  let future: string[] = [];
  let committed = JSON.stringify(cloneBlocks(blocks));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedRange: Range | null = null;
  let destroyed = false;

  const column = h("div", {
    class: "vblocks",
    role: "group",
    "aria-label": "Article body",
  });
  const editables: HTMLElement[] = [];

  // ------------------------------------------------------------- toolbar
  const button = (label: string, text: string, extra: string = "") =>
    h(
      "button",
      {
        type: "button",
        class: `vtool ${extra}`.trim(),
        "aria-label": label,
        title: label,
      },
      text,
    );
  const undoButton = button("Undo (Ctrl+Z)", "Undo", "vtool-text");
  const redoButton = button("Redo (Ctrl+Shift+Z)", "Redo", "vtool-text");
  const addButton = h(
    "button",
    {
      type: "button",
      class: "vtool vtool-text",
      "aria-haspopup": "true",
      "aria-expanded": "false",
      "aria-label": "Add block",
      title: "Add a block after the current one",
    },
    "+ Block",
  );
  const upButton = button("Move block up (Alt+Up)", "Up", "vtool-text");
  const downButton = button("Move block down (Alt+Down)", "Down", "vtool-text");
  const removeButton = button("Remove block", "Remove", "vtool-text");
  const boldButton = button("Bold (Ctrl+B)", "B", "vtool-bold");
  const italicButton = button("Italic (Ctrl+I)", "I", "vtool-italic");
  const linkButton = button("Link (Ctrl+K)", "Link", "vtool-text");
  const kindSelect = h("select", {
    class: "vtool vtool-select",
    "aria-label": "Block type",
  });
  for (const kind of Object.keys(KIND_LABELS) as VKind[]) {
    kindSelect.appendChild(h("option", { value: kind }, KIND_LABELS[kind]));
  }
  const menu = h("div", {
    class: "vmenu",
    role: "menu",
    "aria-label": "Add block",
    hidden: true,
  });
  const menuItems = INSERTABLE.map((kind) =>
    h(
      "button",
      { type: "button", role: "menuitem", class: "vmenu-item" },
      KIND_LABELS[kind].replace(" list item", " list"),
    ),
  );
  for (const item of menuItems) menu.appendChild(item);
  const tools = h(
    "div",
    {
      class: "vtools",
      role: "toolbar",
      "aria-label": "Writing tools",
      "aria-controls": "",
    },
    undoButton,
    redoButton,
    h("span", { class: "vtool-gap", "aria-hidden": "true" }),
    h("span", { class: "vmenu-wrap" }, addButton, menu),
    kindSelect,
    upButton,
    downButton,
    removeButton,
    h("span", { class: "vtool-gap", "aria-hidden": "true" }),
    boldButton,
    italicButton,
    linkButton,
  );
  tools.removeAttribute("aria-controls");

  const linkInput = h("input", {
    type: "text",
    id: `${options.idPrefix}-link`,
    autocomplete: "off",
    placeholder: "https://example.org/page",
    inputmode: "url",
  });
  const linkApply = h("button", { type: "submit", class: "primary" }, "Apply");
  const linkRemove = h("button", { type: "button" }, "Remove link");
  const linkCancel = h("button", { type: "button" }, "Cancel");
  const linkError = h("span", { class: "vlink-error", role: "alert" });
  const linkForm = h(
    "form",
    { class: "vlink", hidden: true, "aria-label": "Link address" },
    h("label", { for: `${options.idPrefix}-link` }, "Link address"),
    linkInput,
    linkApply,
    linkRemove,
    linkCancel,
    linkError,
  );

  // ----------------------------------------------------------- bookkeeping
  const snapshot = () => JSON.stringify(cloneBlocks(blocks));

  function emit(): void {
    options.onChange(serializeBlocks(blocks));
  }

  /** Records the last settled state so undo steps back by whole edits. */
  function checkpoint(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const now = snapshot();
    if (now !== committed) {
      past.push(committed);
      if (past.length > HISTORY_LIMIT) past.shift();
      committed = now;
      future = [];
    }
    options.onRoundTripWarning(!roundTrips(blocks));
    updateTools();
  }

  function scheduleCheckpoint(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(checkpoint, checkpointDelay);
  }

  function restore(state: string): void {
    blocks = JSON.parse(state) as VBlock[];
    if (blocks.length === 0) blocks = [{ kind: "p", text: [] }];
    committed = state;
    current = Math.min(current, blocks.length - 1);
    renderAll(current, null);
    emit();
    options.onRoundTripWarning(!roundTrips(blocks));
  }

  function undo(): void {
    if (readOnly) return;
    checkpoint();
    const previous = past.pop();
    if (previous === undefined) return;
    future.push(committed);
    restore(previous);
    options.onNotice("info", "Undid the last change.");
  }

  function redo(): void {
    if (readOnly) return;
    checkpoint();
    const next = future.pop();
    if (next === undefined) return;
    past.push(committed);
    restore(next);
    options.onNotice("info", "Redid the change.");
  }

  function updateTools(): void {
    const lock = readOnly;
    for (const control of [
      addButton,
      kindSelect,
      boldButton,
      italicButton,
      linkButton,
    ]) {
      (control as HTMLButtonElement).disabled = lock;
    }
    undoButton.disabled =
      lock || (past.length === 0 && snapshot() === committed);
    redoButton.disabled = lock || future.length === 0;
    upButton.disabled = lock || current <= 0;
    downButton.disabled = lock || current >= blocks.length - 1;
    removeButton.disabled = lock;
    kindSelect.value = blocks[current]?.kind ?? "p";
  }

  // ------------------------------------------------------------- rendering
  function renderAll(focusIndex: number | null, offset: number | null): void {
    clear(column);
    editables.length = 0;
    let listNumber = 0;
    blocks.forEach((block, index) => {
      const previous = blocks[index - 1];
      listNumber =
        block.kind === "ol" && previous?.kind === "ol" ? listNumber + 1 : 1;
      const label = `${KIND_LABELS[block.kind]} ${index + 1} of ${blocks.length}`;
      const editable = h("div", {
        class: "vtext",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        "aria-readonly": readOnly ? "true" : null,
        contenteditable: readOnly ? "false" : "true",
        spellcheck: "true",
        "data-placeholder":
          block.kind === "p" ? "Write, or press + Block to add more." : label,
      });
      inlineToDom(doc, normalizeBlockText(block.text), editable);
      wire(editable, index);
      editables.push(editable);
      column.appendChild(
        h(
          "div",
          {
            class: `vblock vblock-${block.kind}`,
            "data-kind": block.kind,
          },
          block.kind === "ul"
            ? h("span", { class: "vmarker", "aria-hidden": "true" }, "•")
            : block.kind === "ol"
              ? h(
                  "span",
                  { class: "vmarker", "aria-hidden": "true" },
                  `${listNumber}.`,
                )
              : null,
          editable,
        ),
      );
    });
    if (focusIndex !== null) {
      const target =
        editables[Math.max(0, Math.min(focusIndex, editables.length - 1))];
      if (target) {
        target.focus();
        if (offset !== null) setCaret(doc, target, offset);
        current = editables.indexOf(target);
      }
    }
    updateTools();
  }

  function syncBlock(index: number): void {
    const element = editables[index];
    const block = blocks[index];
    if (!element || !block) return;
    block.text = domToInline(element);
    if (!(element.textContent ?? "").length && element.firstChild) {
      clear(element);
    }
  }

  // ------------------------------------------------------------ operations
  function insertBlock(kind: VKind, after: number | null): void {
    if (readOnly) return;
    checkpoint();
    const at = after === null ? blocks.length - 1 : after;
    const here = blocks[at];
    if (here && here.kind === "p" && isEmptyText(here.text) && kind !== "p") {
      here.kind = kind;
      renderAll(at, 0);
    } else if (
      here &&
      here.kind === "p" &&
      isEmptyText(here.text) &&
      kind === "p"
    ) {
      renderAll(at, 0);
    } else {
      blocks.splice(at + 1, 0, { kind, text: [] });
      renderAll(at + 1, 0);
    }
    emit();
    checkpoint();
    options.onNotice("info", `${KIND_LABELS[kind]} block added.`);
  }

  function changeKind(kind: VKind): void {
    const block = blocks[current];
    if (readOnly || !block || block.kind === kind) return;
    const element = editables[current];
    const offset = element ? caretOffset(doc, element) : null;
    syncBlock(current);
    checkpoint();
    block.kind = kind;
    renderAll(current, offset ?? 0);
    emit();
    checkpoint();
  }

  function moveBlock(direction: -1 | 1): void {
    const target = current + direction;
    const here = blocks[current];
    const there = blocks[target];
    if (readOnly || !here || !there) return;
    const element = editables[current];
    const offset = element ? caretOffset(doc, element) : null;
    syncBlock(current);
    checkpoint();
    blocks[current] = there;
    blocks[target] = here;
    renderAll(target, offset ?? 0);
    emit();
    checkpoint();
    options.onNotice(
      "info",
      `Moved ${KIND_LABELS[here.kind].toLowerCase()} to position ${target + 1} of ${blocks.length}.`,
    );
  }

  function removeBlock(): void {
    if (readOnly) return;
    syncBlock(current);
    checkpoint();
    if (blocks.length === 1) {
      blocks = [{ kind: "p", text: [] }];
      renderAll(0, 0);
    } else {
      blocks.splice(current, 1);
      renderAll(Math.max(0, current - 1), null);
    }
    emit();
    checkpoint();
    options.onNotice("info", "Block removed.");
  }

  function splitAtCaret(index: number): void {
    const element = editables[index];
    const block = blocks[index];
    const selection = doc.getSelection();
    if (!element || !block || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) range.deleteContents();
    const tail = doc.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(element, element.childNodes.length);
    const fragment = tail.extractContents();
    const holder = h("div");
    holder.appendChild(fragment);
    const tailText = domToInline(holder);
    syncBlock(index);
    checkpoint();
    const headEmpty = isEmptyText(block.text);
    const tailEmpty = isEmptyText(tailText);
    if (headEmpty && tailEmpty && block.kind !== "p") {
      block.kind = "p";
      renderAll(index, 0);
    } else {
      const next: VKind =
        block.kind === "ul" || block.kind === "ol" ? block.kind : "p";
      blocks.splice(index + 1, 0, { kind: next, text: tailText });
      renderAll(index + 1, 0);
    }
    emit();
    checkpoint();
  }

  function backspaceAtStart(index: number): void {
    const block = blocks[index];
    const element = editables[index];
    if (!block || !element) return;
    syncBlock(index);
    checkpoint();
    if (block.kind !== "p") {
      block.kind = "p";
      renderAll(index, 0);
    } else if (index > 0) {
      const before = blocks[index - 1] as VBlock;
      const length = editables[index - 1]?.textContent?.length ?? 0;
      before.text = [...before.text, ...block.text];
      blocks.splice(index, 1);
      renderAll(index - 1, length);
    } else return;
    emit();
    checkpoint();
  }

  function insertPlain(index: number, text: string): void {
    const element = editables[index];
    const block = blocks[index];
    if (!element || !block) return;
    const paragraphs = text
      .replace(/\r\n?/g, "\n")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);
    if (paragraphs.length === 0) return;
    checkpoint();
    const selection = doc.getSelection();
    const first = paragraphs[0] as string;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = doc.createTextNode(first);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    syncBlock(index);
    if (paragraphs.length > 1) {
      const extra: VBlock[] = paragraphs
        .slice(1)
        .map((line) => ({
          kind: "p" as VKind,
          text: [{ t: "text", v: line }],
        }));
      blocks.splice(index + 1, 0, ...extra);
      renderAll(index + extra.length, null);
    }
    emit();
    checkpoint();
  }

  function format(command: "bold" | "italic"): void {
    if (readOnly) return;
    const element = editables[current];
    if (!element) return;
    element.focus();
    const exec = (doc as Document & { execCommand?: Document["execCommand"] })
      .execCommand;
    if (typeof exec !== "function") {
      options.onNotice("error", "Formatting is not available in this browser.");
      return;
    }
    doc.execCommand("styleWithCSS", false, "false");
    doc.execCommand(command, false);
    syncBlock(current);
    emit();
    checkpoint();
  }

  // ----------------------------------------------------------------- links
  function openLink(): void {
    if (readOnly) return;
    const selection = doc.getSelection();
    const element = editables[current];
    if (!selection || selection.rangeCount === 0 || !element) {
      options.onNotice(
        "error",
        "Click in the text and select the words to link.",
      );
      return;
    }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      options.onNotice(
        "error",
        "Click in the text and select the words to link.",
      );
      return;
    }
    const anchor = (node: Node | null): HTMLAnchorElement | null => {
      for (let n: Node | null = node; n && n !== element; n = n.parentNode) {
        if (n.nodeType === 1 && (n as Element).tagName === "A") {
          return n as HTMLAnchorElement;
        }
      }
      return null;
    };
    const existing = anchor(range.startContainer);
    if (range.collapsed && !existing) {
      options.onNotice("error", "Select the words you want to link first.");
      return;
    }
    savedRange = range.cloneRange();
    linkInput.value = existing?.getAttribute("href") ?? "https://";
    linkRemove.hidden = !existing;
    linkError.textContent = "";
    linkForm.hidden = false;
    linkInput.focus();
    linkInput.select();
  }

  function closeLink(refocus: boolean): void {
    linkForm.hidden = true;
    const range = savedRange;
    savedRange = null;
    const element = editables[current];
    if (refocus && element) {
      element.focus();
      const selection = doc.getSelection();
      if (selection && range) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  linkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const href = safeLinkTarget(linkInput.value);
    if (!href) {
      linkError.textContent =
        "Enter a full web address starting with https:// or http://, or a mailto: address.";
      linkInput.focus();
      return;
    }
    closeLink(true);
    doc.execCommand("styleWithCSS", false, "false");
    doc.execCommand("createLink", false, href);
    syncBlock(current);
    emit();
    checkpoint();
    options.onNotice("info", "Link added.");
  });
  linkRemove.addEventListener("click", () => {
    closeLink(true);
    doc.execCommand("unlink", false);
    syncBlock(current);
    emit();
    checkpoint();
    options.onNotice("info", "Link removed.");
  });
  linkCancel.addEventListener("click", () => closeLink(true));
  linkForm.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") {
      event.preventDefault();
      closeLink(true);
    }
  });

  // ---------------------------------------------------------- block events
  function wire(element: HTMLElement, index: number): void {
    element.addEventListener("focus", () => {
      current = index;
      updateTools();
    });
    element.addEventListener("input", () => {
      syncBlock(index);
      emit();
      scheduleCheckpoint();
    });
    element.addEventListener("beforeinput", (raw) => {
      const event = raw as InputEvent;
      switch (event.inputType) {
        case "insertParagraph":
          event.preventDefault();
          splitAtCaret(index);
          break;
        case "insertLineBreak":
          event.preventDefault();
          break;
        case "historyUndo":
          event.preventDefault();
          undo();
          break;
        case "historyRedo":
          event.preventDefault();
          redo();
          break;
        default:
          break;
      }
    });
    element.addEventListener("paste", (raw) => {
      const event = raw as ClipboardEvent;
      event.preventDefault();
      if (readOnly) return;
      insertPlain(index, event.clipboardData?.getData("text/plain") ?? "");
    });
    element.addEventListener("drop", (event) => event.preventDefault());
    element.addEventListener("keydown", (raw) => {
      const event = raw as KeyboardEvent;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;
      if (mod && !event.altKey && key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !event.altKey && key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && !event.altKey && key.toLowerCase() === "k") {
        event.preventDefault();
        openLink();
        return;
      }
      if (event.altKey && !mod && (key === "ArrowUp" || key === "ArrowDown")) {
        event.preventDefault();
        moveBlock(key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (readOnly) return;
      const selection = doc.getSelection();
      const collapsed = !!selection && selection.isCollapsed;
      const offset = caretOffset(doc, element);
      const length = element.textContent?.length ?? 0;
      if (key === "Enter" && !mod && !event.shiftKey && !event.isComposing) {
        // Some mobile keyboards skip beforeinput, so Enter is handled here too.
        event.preventDefault();
        splitAtCaret(index);
        return;
      }
      if (key === "Backspace" && collapsed && offset === 0 && !mod) {
        event.preventDefault();
        backspaceAtStart(index);
        return;
      }
      if (!collapsed || event.shiftKey || mod || event.altKey) return;
      if (
        (key === "ArrowUp" || key === "ArrowLeft") &&
        offset === 0 &&
        index > 0
      ) {
        event.preventDefault();
        const prev = editables[index - 1];
        if (prev) {
          prev.focus();
          setCaret(doc, prev, prev.textContent?.length ?? 0);
        }
      } else if (
        (key === "ArrowDown" || key === "ArrowRight") &&
        offset === length &&
        index < editables.length - 1
      ) {
        event.preventDefault();
        const next = editables[index + 1];
        if (next) {
          next.focus();
          setCaret(doc, next, 0);
        }
      }
    });
  }

  // --------------------------------------------------------------- toolbar
  // Keep the text selection while a toolbar button is pressed.
  tools.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    if (target.tagName !== "SELECT" && target.tagName !== "OPTION") {
      event.preventDefault();
    }
  });
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);
  upButton.addEventListener("click", () => moveBlock(-1));
  downButton.addEventListener("click", () => moveBlock(1));
  removeButton.addEventListener("click", removeBlock);
  boldButton.addEventListener("click", () => format("bold"));
  italicButton.addEventListener("click", () => format("italic"));
  linkButton.addEventListener("click", openLink);
  kindSelect.addEventListener("change", () =>
    changeKind(kindSelect.value as VKind),
  );

  function closeMenu(refocus: boolean): void {
    menu.hidden = true;
    addButton.setAttribute("aria-expanded", "false");
    if (refocus) addButton.focus();
  }
  function openMenu(): void {
    if (readOnly) return;
    menu.hidden = false;
    addButton.setAttribute("aria-expanded", "true");
    menuItems[0]?.focus();
  }
  addButton.addEventListener("click", () => {
    if (menu.hidden) openMenu();
    else closeMenu(true);
  });
  menuItems.forEach((item, position) => {
    item.addEventListener("click", () => {
      closeMenu(false);
      insertBlock(INSERTABLE[position] as VKind, current);
    });
    item.addEventListener("keydown", (raw) => {
      const event = raw as KeyboardEvent;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        menuItems[
          (position + step + menuItems.length) % menuItems.length
        ]?.focus();
      }
    });
  });
  const onOutside = (event: Event) => {
    if (!menu.hidden && !menu.parentElement?.contains(event.target as Node)) {
      closeMenu(false);
    }
  };
  doc.addEventListener("click", onOutside);

  const endButton = h(
    "button",
    { type: "button", class: "vadd-end" },
    "+ Add a block at the end",
  );
  endButton.addEventListener("click", () => {
    if (readOnly) return;
    const last = blocks[blocks.length - 1];
    if (last && isEmptyText(last.text)) {
      editables[blocks.length - 1]?.focus();
      return;
    }
    insertBlock("p", blocks.length - 1);
  });
  const element = h("div", { class: "vcanvas" }, column, endButton);

  const onSelectionChange = () => {
    if (destroyed) return;
    const query = (
      doc as Document & { queryCommandState?: (c: string) => boolean }
    ).queryCommandState;
    if (typeof query !== "function") return;
    const active = editables[current];
    const selection = doc.getSelection();
    const inside =
      !!active &&
      !!selection?.anchorNode &&
      active.contains(selection.anchorNode);
    try {
      boldButton.setAttribute(
        "aria-pressed",
        String(inside && doc.queryCommandState("bold")),
      );
      italicButton.setAttribute(
        "aria-pressed",
        String(inside && doc.queryCommandState("italic")),
      );
    } catch {
      // Not every engine answers this query.
    }
  };
  doc.addEventListener("selectionchange", onSelectionChange);
  void win;

  renderAll(null, null);

  return {
    element,
    tools,
    linkForm,
    setBlocks(next) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      blocks = cloneBlocks(next);
      if (blocks.length === 0) blocks = [{ kind: "p", text: [] }];
      past = [];
      future = [];
      committed = snapshot();
      current = 0;
      renderAll(null, null);
    },
    setReadOnly(value) {
      if (value === readOnly) return;
      readOnly = value;
      for (const editable of editables) {
        editable.setAttribute("contenteditable", value ? "false" : "true");
        if (value) editable.setAttribute("aria-readonly", "true");
        else editable.removeAttribute("aria-readonly");
      }
      endButton.disabled = value;
      updateTools();
    },
    focus() {
      editables[0]?.focus();
    },
    undo,
    redo,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      doc.removeEventListener("click", onOutside);
      doc.removeEventListener("selectionchange", onSelectionChange);
    },
  };
}

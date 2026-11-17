/**
 * Static controls of the writing workspace (EDIT-3 and EDIT-4): the view
 * switches, preview width switch and the sidebar outline. App wiring stays in
 * app.ts. Nothing here touches draft state.
 */
import { el } from "./dom.js";
import { parseMarkdown } from "./markdown.js";
import type { Canvas } from "./visual-canvas.js";

export interface WriterChrome {
  readonly visualButton: HTMLButtonElement;
  readonly sourceButton: HTMLButtonElement;
  readonly previewButton: HTMLButtonElement;
  readonly historyButton: HTMLButtonElement;
  readonly settingsButton: HTMLButtonElement;
  readonly widthDesktop: HTMLButtonElement;
  readonly widthNarrow: HTMLButtonElement;
  readonly previewTools: HTMLElement;
  readonly outlineList: HTMLElement;
  readonly outlineSlot: HTMLElement;
}

export function createWriterChrome(
  doc: Document,
  idPrefix: string,
): WriterChrome {
  const button = (id: string, text: string, className?: string) =>
    el(
      doc,
      "button",
      { type: "button", id, ...(className ? { class: className } : {}) },
      text,
    );
  const widthDesktop = button("preview-desktop", "Desktop", "seg");
  const widthNarrow = button("preview-narrow", "Narrow", "seg");
  const outlineList = el(doc, "ol", { class: "outline" });
  return {
    visualButton: button("mode-visual", "Visual", "seg"),
    sourceButton: button("mode-source", "Source", "seg"),
    previewButton: button("toggle-preview", "Preview"),
    historyButton: button("open-history", "Revision history"),
    settingsButton: el(
      doc,
      "button",
      {
        type: "button",
        id: "toggle-settings",
        "aria-controls": `${idPrefix}-settings`,
      },
      "Settings",
    ),
    widthDesktop,
    widthNarrow,
    previewTools: el(
      doc,
      "div",
      { class: "preview-tools", hidden: true },
      el(doc, "span", { id: `${idPrefix}-pw` }, "Preview width"),
      el(
        doc,
        "span",
        {
          class: "seg-group",
          role: "group",
          "aria-labelledby": `${idPrefix}-pw`,
        },
        widthDesktop,
        widthNarrow,
      ),
    ),
    outlineList,
    outlineSlot: el(
      doc,
      "section",
      { class: "panel", "aria-labelledby": `${idPrefix}-outline-h` },
      el(doc, "h3", { id: `${idPrefix}-outline-h` }, "Outline"),
      el(doc, "nav", { "aria-label": "Outline" }, outlineList),
    ),
  };
}

/** Fills the outline from the canvas, or from the Markdown in source view. */
export function renderOutline(
  doc: Document,
  list: HTMLElement,
  visual: { readonly canvas: Canvas; readonly onJump: () => void } | null,
  body: string,
): void {
  while (list.firstChild) list.removeChild(list.firstChild);
  const note = (text: string) =>
    list.appendChild(el(doc, "li", { class: "help" }, text));
  if (visual) {
    const entries = visual.canvas.getOutline();
    for (const entry of entries) {
      const open = el(
        doc,
        "button",
        { type: "button", class: `outline-item outline-l${entry.level}` },
        entry.text.trim() || "(empty heading)",
      );
      open.addEventListener("click", () => {
        visual.onJump();
        visual.canvas.focusBlock(entry.index);
      });
      list.appendChild(el(doc, "li", {}, open));
    }
    if (entries.length === 0) note("Add a heading to build an outline.");
    return;
  }
  let count = 0;
  for (const block of parseMarkdown(body)) {
    if (block.t !== "heading") continue;
    count += 1;
    const text = block.c.map((node) => ("v" in node ? node.v : "")).join("");
    list.appendChild(
      el(
        doc,
        "li",
        { class: `outline-item outline-l${block.level}` },
        text || "(heading)",
      ),
    );
  }
  if (count === 0) note("No headings in this draft.");
}

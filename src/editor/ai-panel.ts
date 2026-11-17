/**
 * AI assistant for the writing canvas (EDIT-4 PR 2): a sidebar section and a
 * selection toolbar. A request returns a proposal that is only displayed. The
 * working draft changes when the author applies it, and only if the proposal
 * is still bound to the same article, saved version and working text.
 */

import { proposalBlocksToVisual } from "./ai-blocks.js";
import {
  AI_OPERATION_LABELS,
  AI_PROPOSAL_SCHEMA_VERSION,
  type AiBlockKind,
  type AiOperation,
  type AiProposal,
  type AiProposalRequest,
  type AiProposalResult,
} from "./ai-contract.js";
import { describeError, type EditorApiClient } from "./api-client.js";
import { clear, el } from "./dom.js";
import { renderMarkdownInto } from "./preview.js";
import type { Canvas } from "./visual-canvas.js";

export interface AiHostState {
  readonly articleId: string | null;
  readonly version: number | null;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  /** True when the visual canvas is showing. Proposals need it. */
  readonly visual: boolean;
  /** True while the draft is read-only, saving or in conflict. */
  readonly locked: boolean;
}

export interface AiHost {
  state(): AiHostState;
  /**
   * Captures the exact working draft as a checkpoint, then runs `apply`. The
   * checkpoint is kept only when `apply` returns true. Returns false when the
   * edit was not applied.
   */
  accept(label: string, apply: () => boolean): boolean;
  setTitle(title: string): void;
  announce(text: string): void;
}

export interface AiPanel {
  readonly element: HTMLElement;
  readonly selectionBar: HTMLElement;
  /** Re-reads the host state to enable or disable the controls. */
  refresh(): void;
  selection(
    info: { readonly index: number; readonly rect: DOMRect } | null,
  ): void;
  destroy(): void;
}

interface Binding {
  readonly articleId: string | null;
  readonly version: number | null;
  readonly body: string;
}

type Target =
  | {
      readonly kind: "block";
      readonly index: number;
      readonly markdown: string;
    }
  | { readonly kind: "insert"; readonly index: number };

interface Run {
  readonly controller: AbortController;
  readonly request: AiProposalRequest;
  readonly binding: Binding;
  readonly target: Target;
}

const TONES = ["Formal", "Friendly", "Plain language"];
const LANGUAGES = ["Spanish", "French", "German"];
const BLOCK_LABELS: Readonly<Record<AiBlockKind, string>> = {
  paragraph: "Paragraph",
  heading2: "Heading 2",
  heading3: "Heading 3",
  quote: "Quote",
  bullet: "Bulleted item",
  number: "Numbered item",
  divider: "Divider",
};

export function createAiPanel(options: {
  readonly doc: Document;
  readonly client: EditorApiClient;
  readonly canvas: Canvas;
  readonly host: AiHost;
  readonly idPrefix: string;
}): AiPanel {
  const { doc, client, canvas, host } = options;
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);
  let run: Run | null = null;
  let destroyed = false;

  // ------------------------------------------------------------- controls
  const button = (id: string, text: string, className = "") =>
    h(
      "button",
      { type: "button", id, ...(className ? { class: className } : {}) },
      text,
    );
  const rewrite = button("ai-rewrite", "Rewrite");
  const shorten = button("ai-shorten", "Shorten");
  const choice = (id: string, label: string, values: readonly string[]) => {
    const select = h(
      "select",
      { id, "aria-label": label },
      h("option", { value: "" }, `${label}...`),
      ...values.map((value) => h("option", { value }, value)),
    );
    return select;
  };
  const tone = choice("ai-tone", "Change tone", TONES);
  const translate = choice("ai-translate", "Translate to", LANGUAGES);
  const instruction = h("textarea", {
    id: `${options.idPrefix}-ai-instruction`,
    rows: 3,
    maxlength: 1000,
    placeholder:
      "For example: a short news item about a fictional county meeting",
  });
  const outline = button("ai-outline", "Create outline");
  const section = button("ai-section", "Draft section");
  const article = button("ai-article", "Draft article");
  const hint = h("p", { class: "help", id: "ai-hint" });
  const status = h("div", {
    id: "ai-status",
    class: "ai-status",
    role: "status",
    "aria-live": "polite",
  });
  const review = h("div", { id: "ai-review", class: "ai-review" });
  const triggers: HTMLButtonElement[] = [
    rewrite,
    shorten,
    outline,
    section,
    article,
  ];
  const element = h(
    "section",
    {
      class: "panel",
      id: "ai-panel",
      "aria-labelledby": `${options.idPrefix}-ai-h`,
    },
    h("h3", { id: `${options.idPrefix}-ai-h` }, "AI assistant"),
    h(
      "p",
      { class: "help" },
      "Proposals are shown first. Nothing changes in your draft until you apply one.",
    ),
    h("h4", {}, "Selected block"),
    h("div", { class: "actions" }, rewrite, shorten),
    h("div", { class: "ai-choices" }, tone, translate),
    h("h4", {}, "Draft with AI"),
    h("label", { for: instruction.id }, "Describe the article or section"),
    instruction,
    h("div", { class: "actions" }, outline, section, article),
    hint,
    status,
    review,
  );

  // The selection toolbar offers the same four edits next to the text.
  const selRewrite = button("ai-sel-rewrite", "Rewrite");
  const selShorten = button("ai-sel-shorten", "Shorten");
  const selTone = button("ai-sel-tone", "Change tone");
  const selTranslate = button("ai-sel-translate", "Translate");
  const submenu = h("span", { class: "ai-submenu", hidden: true });
  const selectionBar = h(
    "div",
    {
      class: "ai-selbar",
      role: "toolbar",
      "aria-label": "AI edit for the selected text",
      hidden: true,
    },
    selRewrite,
    selShorten,
    selTone,
    selTranslate,
    submenu,
  );

  // -------------------------------------------------------------- helpers
  const bind = (): Binding => {
    const state = host.state();
    return {
      articleId: state.articleId,
      version: state.version,
      body: state.body,
    };
  };
  const staleReason = (binding: Binding): string | null => {
    const state = host.state();
    if (state.articleId !== binding.articleId)
      return "You switched to a different article.";
    if (state.version !== binding.version) return "The saved version changed.";
    if (state.body !== binding.body) return "Your draft text changed.";
    return null;
  };
  const say = (text: string) => {
    status.textContent = text;
    host.announce(text);
  };
  const failure = (text: string) => {
    clear(review);
    review.appendChild(
      h(
        "p",
        { class: "notice notice-error", role: "alert" },
        `${text} Nothing was changed.`,
      ),
    );
    say(`${text} Nothing was changed.`);
  };

  function refresh(): void {
    const state = host.state();
    const off = !state.visual || state.locked || run !== null;
    for (const control of [
      ...triggers,
      tone,
      translate,
      selRewrite,
      selShorten,
      selTone,
      selTranslate,
    ]) {
      (control as HTMLButtonElement).disabled = off;
    }
    instruction.readOnly = state.locked;
    hint.textContent = state.visual
      ? ""
      : "Switch to the Visual view to use AI proposals.";
  }

  // --------------------------------------------------------------- running
  function start(
    operation: AiOperation,
    options2: { text?: string; instruction?: string },
    target: Target,
  ): void {
    const state = host.state();
    if (run || state.locked || !state.visual) return;
    const request: AiProposalRequest = {
      schema: AI_PROPOSAL_SCHEMA_VERSION,
      operation,
      ...(options2.text === undefined ? {} : { text: options2.text }),
      ...(options2.instruction === undefined
        ? {}
        : { instruction: options2.instruction }),
      context: {
        title: state.title.slice(0, 400),
        summary:
          state.summary.trim() === "" ? null : state.summary.slice(0, 500),
      },
    };
    const current: Run = {
      controller: new AbortController(),
      request,
      binding: bind(),
      target,
    };
    run = current;
    clear(review);
    const cancel = button("ai-cancel", "Cancel");
    cancel.addEventListener("click", () => {
      if (run !== current) return;
      current.controller.abort();
      run = null;
      clear(review);
      say("Cancelled. Nothing was changed.");
      refresh();
    });
    review.appendChild(
      h("p", {}, `${AI_OPERATION_LABELS[operation]}: working...`, " ", cancel),
    );
    say(`${AI_OPERATION_LABELS[operation]}: working. Your draft is unchanged.`);
    refresh();
    client.proposeAi(request, current.controller.signal).then(
      (result) => {
        if (run !== current || destroyed) return;
        run = null;
        refresh();
        show(current, result);
      },
      (error: unknown) => {
        if (run !== current || destroyed) return;
        run = null;
        refresh();
        const code = (error as { code?: string }).code;
        failure(
          code === "operation_unavailable"
            ? "AI proposals are not set up on this server."
            : code === "forbidden"
              ? "Your account is not allowed to use AI proposals."
              : describeError(error),
        );
      },
    );
  }

  function show(source: Run, result: AiProposalResult): void {
    if (result.status === "refused") {
      failure(`The provider declined: ${result.message}`);
      return;
    }
    if (result.status === "invalid") {
      failure(`The proposal was rejected: ${result.message}.`);
      return;
    }
    if (result.status === "timeout") {
      failure("The provider took too long.");
      return;
    }
    if (result.status === "unavailable") {
      failure("The provider is not available.");
      return;
    }
    clear(review);
    say(
      `${AI_OPERATION_LABELS[source.request.operation]}: proposal ready. Review it before applying.`,
    );
    if (source.target.kind === "block")
      reviewSelection(source, result.proposal, source.target);
    else reviewDraft(source, result.proposal, source.target.index);
  }

  const regenerate = (source: Run) => {
    const target =
      source.target.kind === "block"
        ? {
            kind: "block" as const,
            index: source.target.index,
            markdown:
              canvas.getCurrentBlock()?.markdown ?? source.target.markdown,
          }
        : source.target;
    start(
      source.request.operation,
      {
        ...(source.request.text === undefined
          ? {}
          : {
              text:
                target.kind === "block" ? target.markdown : source.request.text,
            }),
        ...(source.request.instruction === undefined
          ? {}
          : { instruction: source.request.instruction }),
      },
      target,
    );
  };

  function staleNotice(source: Run, reason: string): void {
    clear(review);
    const again = button("ai-regenerate", "Regenerate");
    again.addEventListener("click", () => regenerate(source));
    review.appendChild(
      h(
        "p",
        { class: "notice notice-error", role: "alert" },
        `${reason} The proposal is out of date and was not applied. Your text is unchanged.`,
        " ",
        again,
      ),
    );
    say(`${reason} The proposal was not applied.`);
  }

  function reviewSelection(
    source: Run,
    proposal: AiProposal,
    target: Extract<Target, { kind: "block" }>,
  ): void {
    const next = proposal.blocks[0]?.text ?? "";
    const original = h("div", { class: "ai-text", id: "ai-original" });
    const proposed = h("div", { class: "ai-text", id: "ai-proposed" });
    renderMarkdownInto(doc, original, target.markdown);
    renderMarkdownInto(doc, proposed, next);
    const apply = button("ai-apply", "Apply", "primary");
    const discard = button("ai-discard", "Discard");
    apply.addEventListener("click", () => {
      const reason = staleReason(source.binding);
      if (reason) {
        staleNotice(source, reason);
        return;
      }
      const done = host.accept(AI_OPERATION_LABELS[proposal.operation], () =>
        canvas.replaceBlockText(target.index, target.markdown, next),
      );
      if (!done) {
        staleNotice(source, "The selected block changed.");
        return;
      }
      clear(review);
      say(
        `${AI_OPERATION_LABELS[proposal.operation]} applied. Undo restores the previous text.`,
      );
    });
    discard.addEventListener("click", () => {
      clear(review);
      say("Proposal discarded. Nothing was changed.");
    });
    review.append(
      h("h4", {}, `Proposed: ${AI_OPERATION_LABELS[proposal.operation]}`),
      h(
        "div",
        { class: "ai-compare" },
        h("div", {}, h("h5", {}, "Original"), original),
        h("div", {}, h("h5", {}, "Proposed"), proposed),
      ),
      h("div", { class: "actions" }, apply, discard),
    );
  }

  function reviewDraft(
    source: Run,
    proposal: AiProposal,
    insertAfter: number,
  ): void {
    const rows = proposal.blocks.map((block) => ({ ...block }));
    const list = h("ol", { class: "ai-blocks" });
    const problem = h("p", {
      class: "notice notice-error",
      role: "alert",
      hidden: true,
    });
    const draw = () => {
      clear(list);
      rows.forEach((row, index) => {
        const label = `${BLOCK_LABELS[row.kind]} ${index + 1} of ${rows.length}`;
        const remove = h(
          "button",
          { type: "button", "aria-label": `Remove ${label}` },
          "Remove",
        );
        remove.addEventListener("click", () => {
          rows.splice(index, 1);
          draw();
        });
        let field: HTMLElement;
        if (row.kind === "divider") {
          field = h("span", { class: "help" }, "Divider");
        } else {
          const area = h("textarea", {
            class: "ai-block-text",
            rows: 2,
            "aria-label": label,
          });
          area.value = row.text;
          area.addEventListener("input", () => {
            row.text = area.value;
          });
          field = area;
        }
        list.appendChild(
          h(
            "li",
            {},
            h("span", { class: "ai-kind" }, BLOCK_LABELS[row.kind]),
            field,
            remove,
          ),
        );
      });
      if (rows.length === 0)
        list.appendChild(h("li", { class: "help" }, "No blocks left."));
    };
    draw();
    const converted = () => {
      const result = proposalBlocksToVisual(rows);
      if (!result.ok || result.blocks.length === 0) {
        problem.hidden = false;
        problem.textContent = result.ok
          ? "There are no blocks to add."
          : `${result.reason}. Edit the text and try again.`;
        return null;
      }
      problem.hidden = true;
      return result.blocks;
    };
    const guarded = (
      label: string,
      apply: (blocks: NonNullable<ReturnType<typeof converted>>) => void,
    ) => {
      const reason = staleReason(source.binding);
      if (reason) {
        staleNotice(source, reason);
        return;
      }
      const blocks = converted();
      if (!blocks) return;
      const done = host.accept(label, () => {
        apply(blocks);
        return true;
      });
      if (!done) return;
      clear(review);
      say(`${label} applied. Undo restores the previous draft.`);
    };
    const insert = button("ai-insert", "Insert at cursor", "primary");
    const replace = button("ai-replace", "Replace body");
    const discard = button("ai-discard", "Discard");
    const label = AI_OPERATION_LABELS[proposal.operation];
    insert.addEventListener("click", () =>
      guarded(label, (blocks) => canvas.insertBlocksAfter(insertAfter, blocks)),
    );
    replace.addEventListener("click", () =>
      guarded(label, (blocks) => canvas.replaceAll(blocks)),
    );
    discard.addEventListener("click", () => {
      clear(review);
      say("Proposal discarded. Nothing was changed.");
    });
    review.append(h("h4", {}, `Proposed: ${label}`));
    if (proposal.title) {
      const useTitle = button("ai-use-title", "Use this title");
      useTitle.addEventListener("click", () => {
        const reason = staleReason(source.binding);
        if (reason) {
          staleNotice(source, reason);
          return;
        }
        const title = proposal.title ?? "";
        const applied = host.accept("Suggested title", () => {
          host.setTitle(title);
          return true;
        });
        if (applied) say("Suggested title applied.");
      });
      review.append(
        h(
          "p",
          { class: "ai-title" },
          h("strong", {}, "Suggested title: "),
          proposal.title,
          " ",
          useTitle,
        ),
      );
    }
    review.append(
      h(
        "p",
        { class: "help" },
        "Edit or remove blocks before adding them. Placeholders in square brackets mark facts, quotes or sources to supply. Your current draft is kept as a revision when you save.",
      ),
      list,
      problem,
      h("div", { class: "actions" }, insert, replace, discard),
    );
  }

  // ------------------------------------------------------------ wire events
  function startSelection(
    operation: AiOperation,
    instructionText?: string,
  ): void {
    const block = canvas.getCurrentBlock();
    if (!block || block.markdown.trim() === "") {
      say("Click in a paragraph, heading, quote or list item first.");
      return;
    }
    start(
      operation,
      {
        text: block.markdown,
        ...(instructionText === undefined
          ? {}
          : { instruction: instructionText }),
      },
      { kind: "block", index: block.index, markdown: block.markdown },
    );
    hideSelectionBar();
  }
  const startDraft = (operation: AiOperation) => {
    const text = instruction.value.trim();
    if (text === "") {
      say("Describe what you want first.");
      instruction.focus();
      return;
    }
    const current = canvas.getCurrentBlock();
    start(
      operation,
      { instruction: text },
      {
        kind: "insert",
        index: current ? current.index : canvas.blockCount() - 1,
      },
    );
  };
  rewrite.addEventListener("click", () => startSelection("rewrite"));
  shorten.addEventListener("click", () => startSelection("shorten"));
  tone.addEventListener("change", () => {
    if (tone.value) startSelection("change_tone", tone.value);
    tone.value = "";
  });
  translate.addEventListener("change", () => {
    if (translate.value) startSelection("translate", translate.value);
    translate.value = "";
  });
  outline.addEventListener("click", () => startDraft("create_outline"));
  section.addEventListener("click", () => startDraft("draft_section"));
  article.addEventListener("click", () => startDraft("draft_article"));

  // Selection toolbar. Buttons keep the text selection while pressed.
  const menu = (values: readonly string[], operation: AiOperation) => {
    clear(submenu);
    submenu.hidden = false;
    for (const value of values) {
      const item = h("button", { type: "button" }, value);
      item.addEventListener("click", () => startSelection(operation, value));
      submenu.appendChild(item);
    }
  };
  function hideSelectionBar(): void {
    selectionBar.hidden = true;
    submenu.hidden = true;
  }
  selectionBar.addEventListener("mousedown", (event) => event.preventDefault());
  selRewrite.addEventListener("click", () => startSelection("rewrite"));
  selShorten.addEventListener("click", () => startSelection("shorten"));
  selTone.addEventListener("click", () => menu(TONES, "change_tone"));
  selTranslate.addEventListener("click", () => menu(LANGUAGES, "translate"));
  selectionBar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideSelectionBar();
  });

  refresh();
  return {
    element,
    selectionBar,
    refresh,
    selection(info) {
      const state = host.state();
      if (!info || !state.visual || state.locked || run) {
        if (!selectionBar.contains(doc.activeElement)) hideSelectionBar();
        return;
      }
      const parent = selectionBar.offsetParent as HTMLElement | null;
      const box = parent?.getBoundingClientRect();
      selectionBar.hidden = false;
      submenu.hidden = true;
      if (box) {
        const top = Math.max(0, info.rect.top - box.top - 44);
        const left = Math.max(
          0,
          Math.min(info.rect.left - box.left, box.width - 280),
        );
        selectionBar.style.top = `${Math.round(top)}px`;
        selectionBar.style.left = `${Math.round(left)}px`;
      }
    },
    destroy() {
      destroyed = true;
      run?.controller.abort();
      run = null;
    },
  };
}

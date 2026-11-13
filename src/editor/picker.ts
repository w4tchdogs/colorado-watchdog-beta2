import { el, replaceChildren } from "./dom.js";

/**
 * Accessible search picker (ARIA combobox with an inline listbox). It never
 * parses markup: every string is a text node. The caller owns what "selected"
 * means and what happens on choose, so the same widget serves counties,
 * people and organizations and never matches by name.
 */
export interface PickerOption {
  readonly id: string;
  readonly name: string;
  /** Shown beside the name, for example "ID sbx-person-1" or "FIPS 08001". */
  readonly idText: string;
  /** Short context lines that help tell similar records apart. */
  readonly details: readonly string[];
}

export interface PickerSearchResult {
  readonly options: readonly PickerOption[];
  readonly hasMore: boolean;
}

export interface PickerConfig {
  readonly doc: Document;
  readonly idPrefix: string;
  readonly noun: string;
  readonly nounPlural: string;
  readonly label: string;
  readonly hint: string;
  readonly delayMs: number;
  search(query: string): Promise<PickerSearchResult>;
  isSelected(id: string): boolean;
  choose(option: PickerOption): void;
}

export interface Picker {
  readonly element: HTMLElement;
  setDisabled(disabled: boolean): void;
  /** Re-reads the selected state of the visible options. */
  refresh(): void;
  focus(): void;
}

type Status = "idle" | "loading" | "error" | "empty" | "results";

export function createPicker(config: PickerConfig): Picker {
  const { doc, idPrefix } = config;
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);

  let options: readonly PickerOption[] = [];
  let hasMore = false;
  let active = -1;
  let open = false;
  let disabled = false;
  let status: Status = "idle";
  let query = "";
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const input = h("input", {
    id: `${idPrefix}-input`,
    type: "text",
    role: "combobox",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 100,
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": `${idPrefix}-listbox`,
    "aria-describedby": `${idPrefix}-hint ${idPrefix}-status`,
  });
  const listbox = h("ul", {
    id: `${idPrefix}-listbox`,
    class: "picker-list",
    role: "listbox",
    "aria-multiselectable": "true",
    "aria-label": `${config.noun} search results`,
    hidden: true,
  });
  const statusLine = h("p", {
    id: `${idPrefix}-status`,
    class: "help picker-status",
    role: "status",
    "aria-live": "polite",
  });
  const retry = h(
    "button",
    { type: "button", class: "picker-retry", hidden: true },
    "Try again",
  );
  const element = h(
    "div",
    { class: "picker", id: `${idPrefix}-picker` },
    h("label", { for: `${idPrefix}-input` }, config.label),
    h("p", { class: "help", id: `${idPrefix}-hint` }, config.hint),
    input,
    h("div", { class: "row" }, statusLine, retry),
    listbox,
  );

  const optionId = (index: number) => `${idPrefix}-opt-${index}`;

  function setOpen(next: boolean): void {
    open = next && !disabled;
    input.setAttribute("aria-expanded", open ? "true" : "false");
    listbox.hidden = !open || options.length === 0;
    if (!open) input.removeAttribute("aria-activedescendant");
  }

  function setActive(index: number): void {
    active = index;
    for (const [i, node] of Array.from(listbox.children).entries()) {
      node.classList.toggle("is-active", i === index);
    }
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", optionId(index));
      listbox.children[index]?.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function renderStatus(): void {
    retry.hidden = status !== "error";
    listbox.setAttribute("aria-busy", status === "loading" ? "true" : "false");
    const noun = config.nounPlural;
    switch (status) {
      case "loading":
        statusLine.textContent = `Searching ${noun}...`;
        break;
      case "error":
        statusLine.textContent = `Could not load ${noun}. Your selections are unchanged.`;
        break;
      case "empty":
        statusLine.textContent =
          query === ""
            ? `There are no ${noun} to choose from.`
            : `No ${noun} match "${query}". Try a different name or ID.`;
        break;
      case "results":
        statusLine.textContent = `${options.length} ${options.length === 1 ? config.noun : noun} shown${hasMore ? ". More match, so keep typing to narrow the list" : ""}. Use the arrow keys, then Enter to add.`;
        break;
      default:
        statusLine.textContent = "";
    }
  }

  function renderOptions(): void {
    replaceChildren(
      doc,
      listbox,
      ...options.map((option, index) => {
        const selected = config.isSelected(option.id);
        const node = h(
          "li",
          {
            id: optionId(index),
            role: "option",
            class: `picker-option${selected ? " is-selected" : ""}${index === active ? " is-active" : ""}`,
            "aria-selected": selected ? "true" : "false",
            "data-id": option.id,
          },
          h(
            "span",
            { class: "opt-main" },
            h("strong", {}, option.name),
            " ",
            h("span", { class: "opt-id" }, option.idText),
            selected ? h("span", { class: "opt-flag" }, " Selected") : null,
          ),
          ...option.details.map((line) =>
            h("span", { class: "opt-detail" }, line),
          ),
        );
        node.addEventListener("mousedown", (event) => event.preventDefault());
        node.addEventListener("click", () => choose(index));
        return node;
      }),
    );
    listbox.hidden = !open || options.length === 0;
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option || disabled) return;
    config.choose(option);
    renderOptions();
    setActive(index);
    input.focus();
  }

  async function runSearch(): Promise<void> {
    const mine = ++sequence;
    status = "loading";
    options = [];
    active = -1;
    renderOptions();
    renderStatus();
    try {
      const result = await config.search(query);
      if (mine !== sequence) return;
      options = result.options;
      hasMore = result.hasMore;
      status = options.length === 0 ? "empty" : "results";
    } catch {
      if (mine !== sequence) return;
      options = [];
      status = "error";
    }
    renderOptions();
    renderStatus();
    setOpen(true);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    status = "loading";
    renderStatus();
    if (config.delayMs <= 0) {
      void runSearch();
      return;
    }
    timer = setTimeout(() => void runSearch(), config.delayMs);
  }

  input.addEventListener("input", () => {
    query = input.value.trim();
    setOpen(true);
    schedule();
  });
  input.addEventListener("click", () => {
    if (disabled || open) return;
    setOpen(true);
    if (status === "idle" || status === "error") schedule();
    else renderOptions();
  });
  retry.addEventListener("click", () => {
    schedule();
    input.focus();
  });
  input.addEventListener("keydown", (event) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          if (status === "idle" || status === "error") schedule();
          else renderOptions();
        }
        if (options.length > 0)
          setActive(Math.min(active + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (options.length > 0) setActive(Math.max(active - 1, 0));
        break;
      case "Home":
        if (open && options.length > 0) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open && options.length > 0) {
          event.preventDefault();
          setActive(options.length - 1);
        }
        break;
      case "Enter":
        // Never submits a surrounding form or adds an unhighlighted record.
        event.preventDefault();
        if (open && active >= 0) choose(active);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        } else if (input.value !== "") {
          event.preventDefault();
          input.value = "";
          query = "";
          status = "idle";
          options = [];
          renderOptions();
          renderStatus();
        }
        break;
      default:
    }
  });
  element.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && element.contains(next)) return;
    setOpen(false);
  });

  return {
    element,
    setDisabled(next: boolean): void {
      disabled = next;
      input.disabled = next;
      retry.disabled = next;
      if (next) setOpen(false);
    },
    refresh(): void {
      if (options.length > 0) renderOptions();
    },
    focus(): void {
      input.focus();
    },
  };
}

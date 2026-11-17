import type { ContentRevision } from "../contracts/content.js";
import { type DiffLine, diffLines, hasChanges } from "./diff.js";
import { el } from "./dom.js";

export interface CompareDraft {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly rel: {
    readonly countyFips: readonly string[];
    readonly personIds: readonly string[];
    readonly organizationIds: readonly string[];
  };
}

export interface CompareNames {
  readonly countyNames: ReadonlyMap<string, string>;
  readonly personNames: ReadonlyMap<string, string>;
  readonly organizationNames: ReadonlyMap<string, string>;
}

/** Read-only comparison of a historical revision with the current draft. */
export function buildRevisionCompare(
  doc: Document,
  revision: ContentRevision,
  draft: CompareDraft,
  names: CompareNames,
  renderDiff: (diff: DiffLine[]) => HTMLElement,
): HTMLElement {
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);
  const wrap = h("div", { class: "compare", id: "compare-panel" });
  const fields: [string, string, string][] = [
    ["Title", revision.title, draft.title],
    ["Summary", revision.summary ?? "", draft.summary],
  ];
  for (const [label, before, after] of fields) {
    wrap.appendChild(
      h(
        "p",
        { class: "compare-field" },
        h("strong", {}, `${label}: `),
        before === after
          ? "same as the current draft"
          : `changed (revision: "${before}" / current: "${after}")`,
      ),
    );
  }
  const describe = (
    label: string,
    before: readonly string[],
    after: readonly string[],
    lookup: ReadonlyMap<string, string>,
  ) => {
    const added = after.filter((value) => !before.includes(value));
    const removed = before.filter((value) => !after.includes(value));
    const name = (value: string) => lookup.get(value) ?? value;
    return h(
      "p",
      { class: "compare-field" },
      h("strong", {}, `${label}: `),
      added.length === 0 && removed.length === 0
        ? "same as the current draft"
        : `current draft adds ${added.map(name).join(", ") || "nothing"} and removes ${removed.map(name).join(", ") || "nothing"}`,
    );
  };
  wrap.appendChild(
    describe(
      "Counties",
      revision.relationships.countyFips,
      draft.rel.countyFips,
      names.countyNames,
    ),
  );
  wrap.appendChild(
    describe(
      "People",
      revision.relationships.personIds,
      draft.rel.personIds,
      names.personNames,
    ),
  );
  wrap.appendChild(
    describe(
      "Organizations",
      revision.relationships.organizationIds,
      draft.rel.organizationIds,
      names.organizationNames,
    ),
  );
  const diff = diffLines(revision.body, draft.body);
  wrap.appendChild(
    diff === null
      ? h(
          "p",
          { class: "help" },
          "The text is too long to compare line by line.",
        )
      : hasChanges(diff)
        ? h(
            "div",
            {},
            h("h3", {}, "Body: revision compared with the current draft"),
            renderDiff(diff),
          )
        : h(
            "p",
            { class: "help" },
            "The body is the same as the current draft.",
          ),
  );
  return wrap;
}

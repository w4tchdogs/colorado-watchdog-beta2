import type {
  OrganizationLookupItem,
  PersonLookupItem,
} from "../contracts/editor-lookup.js";
import type { EditorApiClient } from "./api-client.js";
import { el, replaceChildren } from "./dom.js";
import { createPicker, type PickerOption } from "./picker.js";
import {
  describeOrganization,
  describePerson,
  ORGANIZATION_GROUP_LABELS,
  ORGANIZATION_GROUP_ORDER,
  type OrganizationGroupKey,
  organizationGroup,
} from "./relationship-format.js";

export interface Rel {
  countyFips: string[];
  personIds: string[];
  organizationIds: string[];
}

export const MAX_PER_KIND = 50;
const PICKER_RESULTS = 10;

export interface RelationshipsPanelDeps {
  readonly doc: Document;
  readonly client: EditorApiClient;
  readonly idPrefix: string;
  readonly searchDelayMs: number;
  readonly counties: readonly {
    readonly fips: string;
    readonly name: string;
  }[];
  /** The current draft relationships. Read on every call, never cached. */
  getRel(): Rel;
  /** True while saving, working or read-only. Locks every control. */
  isLocked(): boolean;
  /** Called after a selection changes so the host refreshes its status. */
  onChange(): void;
  nextId(prefix: string): string;
}

export interface RelationshipsPanel {
  readonly element: HTMLElement;
  readonly countyNames: ReadonlyMap<string, string>;
  readonly personNames: ReadonlyMap<string, string>;
  readonly organizationNames: ReadonlyMap<string, string>;
  render(): void;
  /** Looks up unknown IDs once (for example those of a historical revision). */
  ensureResolved(
    people: readonly string[],
    organizations: readonly string[],
  ): Promise<void>;
  /** After a rejected save, forget cached records and check them again. */
  recheckSelected(): void;
}

/**
 * The relationships panel of the editor: search pickers for counties, people
 * and organizations plus the labeled groups of selected records. Selections
 * are stable IDs. Names and context only come from the bounded sandbox lookup.
 */
export function createRelationshipsPanel(
  deps: RelationshipsPanelDeps,
): RelationshipsPanel {
  const { doc } = deps;
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);
  const rel = () => deps.getRel();
  const idPrefix = deps.idPrefix;
  const root = h("section", {
    class: "panel",
    id: "relationships-panel",
    "aria-labelledby": `${idPrefix}-rel-h`,
  });
  const countyNames = new Map(
    deps.counties.map((county) => [county.fips, county.name]),
  );
  const personCache = new Map<string, PersonLookupItem>();
  const organizationCache = new Map<string, OrganizationLookupItem>();
  const personNames = new Map<string, string>();
  const organizationNames = new Map<string, string>();
  const missingPeople = new Set<string>();
  const missingOrganizations = new Set<string>();
  const requested = new Set<string>();
  const failedChecks = new Set<string>();

  const relMessage = h("p", {
    class: "help",
    id: "relationship-message",
    role: "status",
    "aria-live": "polite",
  });
  const say = (text: string) => {
    relMessage.textContent = text;
  };
  const checkSlot = h("div", { id: "record-check-slot" });
  const countySlot = h("div", { class: "selected-slot" });
  const peopleSlot = h("div", { class: "selected-slot" });
  const organizationSlot = h("div", { class: "selected-slot" });

  function rememberPeople(items: readonly PersonLookupItem[]): void {
    for (const person of items) {
      personCache.set(person.id, person);
      personNames.set(person.id, person.name);
      missingPeople.delete(person.id);
    }
  }
  function rememberOrganizations(
    items: readonly OrganizationLookupItem[],
  ): void {
    for (const organization of items) {
      organizationCache.set(organization.id, organization);
      organizationNames.set(organization.id, organization.name);
      missingOrganizations.delete(organization.id);
    }
  }

  /** Checks IDs once through the bounded lookup. Never loops on failure. */
  async function ensureResolved(
    people: readonly string[],
    organizations: readonly string[],
  ): Promise<void> {
    const needPeople = [...new Set(people)].filter(
      (id) =>
        !personCache.has(id) &&
        !missingPeople.has(id) &&
        !requested.has(`p:${id}`),
    );
    const needOrganizations = [...new Set(organizations)].filter(
      (id) =>
        !organizationCache.has(id) &&
        !missingOrganizations.has(id) &&
        !requested.has(`o:${id}`),
    );
    if (needPeople.length === 0 && needOrganizations.length === 0) return;
    for (const id of needPeople) requested.add(`p:${id}`);
    for (const id of needOrganizations) requested.add(`o:${id}`);
    const run = async (keys: string[], call: () => Promise<void>) => {
      try {
        await call();
        for (const key of keys) failedChecks.delete(key);
      } catch {
        for (const key of keys) failedChecks.add(key);
      }
    };
    try {
      await Promise.all([
        needPeople.length > 0
          ? run(
              needPeople.map((id) => `p:${id}`),
              async () => {
                const result = await deps.client.lookupPeople({
                  ids: needPeople,
                });
                rememberPeople(result.items);
                for (const id of result.missingIds) missingPeople.add(id);
              },
            )
          : null,
        needOrganizations.length > 0
          ? run(
              needOrganizations.map((id) => `o:${id}`),
              async () => {
                const result = await deps.client.lookupOrganizations({
                  ids: needOrganizations,
                });
                rememberOrganizations(result.items);
                for (const id of result.missingIds)
                  missingOrganizations.add(id);
              },
            )
          : null,
      ]);
    } finally {
      renderRelationships();
    }
  }

  /** After a rejected save: forget what was cached and check again. */
  function recheckSelected(): void {
    for (const id of rel().personIds) {
      personCache.delete(id);
      personNames.delete(id);
      missingPeople.delete(id);
      requested.delete(`p:${id}`);
    }
    for (const id of rel().organizationIds) {
      organizationCache.delete(id);
      organizationNames.delete(id);
      missingOrganizations.delete(id);
      requested.delete(`o:${id}`);
    }
    renderRelationships();
  }

  type RelKind = "countyFips" | "personIds" | "organizationIds";
  const KIND_PLURAL: Readonly<Record<RelKind, string>> = {
    countyFips: "counties",
    personIds: "people",
    organizationIds: "organizations",
  };

  function addSelection(kind: RelKind, id: string, label: string): void {
    if (deps.isLocked()) return;
    if (rel()[kind].includes(id)) {
      say(`${label} is already selected.`);
      return;
    }
    if (rel()[kind].length >= MAX_PER_KIND) {
      say(
        `At most ${MAX_PER_KIND} ${KIND_PLURAL[kind]} can be linked. Remove one to add another.`,
      );
      return;
    }
    rel()[kind] = [...rel()[kind], id];
    say(
      `Added ${label}. ${rel()[kind].length} of ${MAX_PER_KIND} ${KIND_PLURAL[kind]} selected.`,
    );
    deps.onChange();
  }

  const countyPicker = createPicker({
    doc,
    idPrefix: `${deps.idPrefix}-county`,
    noun: "county",
    nounPlural: "counties",
    label: "Search counties by name or FIPS",
    hint: "Type part of a county name or its five-digit FIPS code.",
    delayMs: 0,
    search: async (query) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = deps.counties.filter((county) =>
        words.every(
          (word) =>
            `${county.name.toLowerCase()} county`.includes(word) ||
            county.fips.includes(word),
        ),
      );
      return {
        options: matches.slice(0, PICKER_RESULTS).map((county) => ({
          id: county.fips,
          name: `${county.name} County`,
          idText: `FIPS ${county.fips}`,
          details: [],
        })),
        hasMore: matches.length > PICKER_RESULTS,
      };
    },
    isSelected: (id) => rel().countyFips.includes(id),
    choose: (option: PickerOption) =>
      addSelection("countyFips", option.id, option.name),
  });
  const capQuery = (query: string) =>
    query.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  const peoplePicker = createPicker({
    doc,
    idPrefix: `${deps.idPrefix}-person`,
    noun: "person",
    nounPlural: "people",
    label: "Search people by name or ID",
    hint: "Records with the same name are separate people. Check the ID and context before adding.",
    delayMs: deps.searchDelayMs,
    search: async (query) => {
      const result = await deps.client.lookupPeople({
        query: capQuery(query),
        limit: PICKER_RESULTS,
      });
      rememberPeople(result.items);
      return {
        options: result.items.map((person) => ({
          id: person.id,
          name: person.name,
          idText: `ID ${person.id}`,
          details: describePerson(person),
        })),
        hasMore: result.hasMore,
      };
    },
    isSelected: (id) => rel().personIds.includes(id),
    choose: (option) =>
      addSelection("personIds", option.id, `${option.name} (${option.id})`),
  });
  const organizationPicker = createPicker({
    doc,
    idPrefix: `${deps.idPrefix}-organization`,
    noun: "organization",
    nounPlural: "organizations",
    label: "Search organizations by name, county or ID",
    hint: "Check the type, county and ID before adding. Similar names can be different organizations.",
    delayMs: deps.searchDelayMs,
    search: async (query) => {
      const result = await deps.client.lookupOrganizations({
        query: capQuery(query),
        limit: PICKER_RESULTS,
      });
      rememberOrganizations(result.items);
      return {
        options: result.items.map((organization) => ({
          id: organization.id,
          name: organization.name,
          idText: `ID ${organization.id}`,
          details: describeOrganization(organization),
        })),
        hasMore: result.hasMore,
      };
    },
    isSelected: (id) => rel().organizationIds.includes(id),
    choose: (option) =>
      addSelection(
        "organizationIds",
        option.id,
        `${option.name} (${option.id})`,
      ),
  });

  function removeSelection(
    kind: RelKind,
    id: string,
    label: string,
    picker: { focus(): void },
  ): void {
    if (deps.isLocked()) return;
    rel()[kind] = rel()[kind].filter((entry) => entry !== id);
    say(
      `Removed ${label}. ${rel()[kind].length} of ${MAX_PER_KIND} ${KIND_PLURAL[kind]} selected.`,
    );
    deps.onChange();
    picker.focus();
  }

  function selectedRow(spec: {
    name: string;
    idText: string;
    details: readonly string[];
    warning?: string;
    removeLabel: string;
    locked: boolean;
    onRemove: () => void;
  }): HTMLElement {
    const remove = h(
      "button",
      {
        type: "button",
        class: "chip-remove",
        "aria-label": spec.removeLabel,
        disabled: spec.locked,
      },
      "Remove",
    );
    remove.addEventListener("click", spec.onRemove);
    return h(
      "li",
      { class: `selected-row${spec.warning ? " is-unavailable" : ""}` },
      h(
        "div",
        { class: "sel-main" },
        h("strong", {}, spec.name),
        " ",
        h("span", { class: "opt-id" }, spec.idText),
        ...spec.details.map((line) => h("span", { class: "opt-detail" }, line)),
        spec.warning ? h("span", { class: "sel-warning" }, spec.warning) : null,
      ),
      remove,
    );
  }

  const countLine = (kind: RelKind) =>
    h(
      "p",
      { class: "help rel-count" },
      `${rel()[kind].length} of ${MAX_PER_KIND} ${KIND_PLURAL[kind]} selected`,
    );
  const UNAVAILABLE =
    "Not found in the sandbox directory. It may have been removed. Remove it before saving.";

  function renderCounties(locked: boolean): void {
    const list = h("ul", {
      class: "selected-list",
      id: "selected-counties",
      "aria-label": "Selected counties",
    });
    for (const fips of [...rel().countyFips].sort()) {
      const name = countyNames.get(fips);
      const label = name ? `${name} County` : `county ${fips}`;
      list.appendChild(
        selectedRow({
          name: name ? `${name} County` : `County ${fips}`,
          idText: `FIPS ${fips}`,
          details: [],
          ...(name ? {} : { warning: UNAVAILABLE }),
          removeLabel: `Remove ${label} (FIPS ${fips})`,
          locked,
          onRemove: () =>
            removeSelection("countyFips", fips, label, countyPicker),
        }),
      );
    }
    replaceChildren(
      doc,
      countySlot,
      countLine("countyFips"),
      list,
      rel().countyFips.length === 0
        ? h("p", { class: "empty" }, "No counties selected.")
        : null,
    );
  }

  function renderPeople(locked: boolean): void {
    const list = h("ul", {
      class: "selected-list",
      id: "selected-people",
      "aria-label": "Selected people",
    });
    const label = (id: string) => personNames.get(id) ?? id;
    const sorted = [...rel().personIds].sort(
      (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
    );
    for (const id of sorted) {
      const person = personCache.get(id);
      const removeName = person ? person.name : `person ${id}`;
      list.appendChild(
        selectedRow({
          name: person ? person.name : id,
          idText: `ID ${id}`,
          details: person
            ? describePerson(person)
            : missingPeople.has(id) || failedChecks.has(`p:${id}`)
              ? []
              : ["Checking record..."],
          ...(missingPeople.has(id) ? { warning: UNAVAILABLE } : {}),
          removeLabel: `Remove ${removeName} (${id})`,
          locked,
          onRemove: () =>
            removeSelection(
              "personIds",
              id,
              `${removeName} (${id})`,
              peoplePicker,
            ),
        }),
      );
    }
    replaceChildren(
      doc,
      peopleSlot,
      countLine("personIds"),
      list,
      rel().personIds.length === 0
        ? h("p", { class: "empty" }, "No people selected.")
        : null,
    );
  }

  function renderOrganizations(locked: boolean): void {
    type GroupKey = OrganizationGroupKey | "unavailable" | "checking";
    const groups = new Map<GroupKey, string[]>();
    for (const id of rel().organizationIds) {
      const organization = organizationCache.get(id);
      const key: GroupKey = organization
        ? organizationGroup(organization.type)
        : missingOrganizations.has(id)
          ? "unavailable"
          : "checking";
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    const container = h("div", {
      id: "selected-organizations",
      class: "selected-groups",
    });
    const order: GroupKey[] = [
      ...ORGANIZATION_GROUP_ORDER,
      "unavailable",
      "checking",
    ];
    for (const key of order) {
      const ids = groups.get(key);
      if (!ids || ids.length === 0) continue;
      const title =
        key === "unavailable"
          ? "Unavailable records"
          : key === "checking"
            ? "Checking records"
            : ORGANIZATION_GROUP_LABELS[key];
      const list = h("ul", {
        class: "selected-list",
        "aria-label": `Selected ${title.toLowerCase()}`,
      });
      const named = (id: string) => organizationNames.get(id) ?? id;
      for (const id of [...ids].sort(
        (a, b) => named(a).localeCompare(named(b)) || a.localeCompare(b),
      )) {
        const organization = organizationCache.get(id);
        const removeName = organization
          ? organization.name
          : `organization ${id}`;
        list.appendChild(
          selectedRow({
            name: organization ? organization.name : id,
            idText: `ID ${id}`,
            details: organization
              ? describeOrganization(organization)
              : failedChecks.has(`o:${id}`) || key === "unavailable"
                ? []
                : ["Checking record..."],
            ...(key === "unavailable" ? { warning: UNAVAILABLE } : {}),
            removeLabel: `Remove ${removeName} (${id})`,
            locked,
            onRemove: () =>
              removeSelection(
                "organizationIds",
                id,
                `${removeName} (${id})`,
                organizationPicker,
              ),
          }),
        );
      }
      container.appendChild(
        h(
          "div",
          { class: "sel-group", role: "group", "aria-label": title },
          h("h4", {}, `${title} (${ids.length})`),
          list,
        ),
      );
    }
    replaceChildren(
      doc,
      organizationSlot,
      countLine("organizationIds"),
      container,
      rel().organizationIds.length === 0
        ? h("p", { class: "empty" }, "No organizations selected.")
        : null,
    );
  }

  function renderCheckSlot(): void {
    if (failedChecks.size === 0) {
      replaceChildren(doc, checkSlot);
      return;
    }
    const retryCheck = h(
      "button",
      { type: "button", id: "retry-record-check" },
      "Retry record check",
    );
    retryCheck.addEventListener("click", () => {
      for (const key of failedChecks) requested.delete(key);
      failedChecks.clear();
      renderRelationships();
    });
    replaceChildren(
      doc,
      checkSlot,
      h(
        "p",
        { class: "notice notice-error", role: "alert" },
        "Could not check some selected records. Your selections are unchanged and can still be saved or removed. ",
        retryCheck,
      ),
    );
  }

  function renderRelationships(): void {
    const locked = deps.isLocked();
    const active = doc.activeElement;
    const keepLabel =
      active && active.tagName === "BUTTON" && root.contains(active)
        ? active.getAttribute("aria-label")
        : null;
    for (const picker of [countyPicker, peoplePicker, organizationPicker]) {
      picker.setDisabled(locked);
      picker.refresh();
    }
    renderCounties(locked);
    renderPeople(locked);
    renderOrganizations(locked);
    renderCheckSlot();
    if (keepLabel) {
      for (const button of Array.from(
        root.querySelectorAll("button.chip-remove"),
      )) {
        if (button.getAttribute("aria-label") === keepLabel) {
          (button as HTMLElement).focus();
          break;
        }
      }
    }
    void ensureResolved(rel().personIds, rel().organizationIds);
  }

  const relSection = (
    title: string,
    ...children: Parameters<typeof el>[3][]
  ) => {
    const headingId = deps.nextId(`${deps.idPrefix}-relh`);
    return h(
      "section",
      { class: "rel-group", "aria-labelledby": headingId },
      h("h3", { id: headingId }, title),
      ...children,
    );
  };
  replaceChildren(
    doc,
    root,
    h("h2", { id: `${deps.idPrefix}-rel-h` }, "Relationships"),
    h(
      "p",
      { class: "help" },
      "Links use stable Website IDs for navigation only. They never claim employment, identity or any fact about a person, and nothing is linked automatically from names in the text.",
    ),
    checkSlot,
    relSection("Counties", countyPicker.element, countySlot),
    relSection("People", peoplePicker.element, peopleSlot),
    relSection(
      "Organizations",
      organizationPicker.element,
      h(
        "p",
        { class: "help" },
        "Parent records, affiliations and partner records are context only. They do not establish administrative authority.",
      ),
      organizationSlot,
    ),
    relMessage,
  );

  return {
    element: root,
    countyNames,
    personNames,
    organizationNames,
    render: renderRelationships,
    ensureResolved,
    recheckSelected,
  };
}

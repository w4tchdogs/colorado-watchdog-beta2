import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import {
  REPORT_GRIEVANCE_CATALOG,
  reportGrievanceCatalogEntry,
} from "../contracts/report-grievance-catalog.js";
import {
  countWords,
  daysInMonth,
  eventYears,
  formatEventDate,
  IDENTIFICATION_BASES,
  type IdentificationBasis,
  isValidEventDate,
  MAX_GRIEVANCE_CHARACTERS,
  MAX_GRIEVANCE_WORDS,
  MAX_GRIEVANCES,
  MAX_HEADLINE_LENGTH,
  MAX_POSITION_LENGTH,
  MAX_UNLISTED_NAME_LENGTH,
  MAX_UNLISTED_OFFICE_LENGTH,
  MONTH_NAMES,
  type ReportEventDate,
  type ReportEventSubject,
  type ReportGrievance,
  reportGrievanceTitle,
  reportGrievanceType,
} from "../contracts/report-grievances.js";
import { button, connectError, fieldError, node } from "./report-dom.js";

/** The picker's data source. The browser host fetches it from the public site. */
export interface PickerRole {
  readonly id: string;
  readonly title: string | null;
  readonly office: string | null;
  readonly county: { readonly fips: string; readonly name: string } | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly sourceCheckedAt: string;
  readonly group: "latest" | "prior" | "unrecorded";
}
export interface PickerPerson {
  readonly personId: string;
  readonly displayName: string;
  readonly matchingRoleCount: number;
  readonly role: PickerRole | null;
}
export interface ReportDirectoryClient {
  search(input: {
    county: string;
    office: string;
    query: string;
    page: number;
  }): Promise<{
    items: readonly PickerPerson[];
    total: number;
    page: number;
    pageCount: number;
  }>;
  offices(county: string): Promise<{
    offices: ReadonlyArray<{
      id: string;
      name: string;
      type: string;
      parentOrganizationId: string | null;
    }>;
  }>;
  roles(personId: string): Promise<{
    person: { personId: string; displayName: string };
    roles: readonly PickerRole[];
  }>;
}

export interface GrievanceFormOptions {
  readonly counties: readonly CountyRegistryEntry[];
  readonly directory?: ReportDirectoryClient;
  readonly now: () => Date;
}

export interface FieldProblem {
  readonly control: HTMLElement;
  readonly error: HTMLElement;
  readonly message?: string;
}

interface DateControls {
  readonly element: HTMLElement;
  readonly year: HTMLSelectElement;
  readonly month: HTMLSelectElement;
  readonly day: HTMLSelectElement;
  readonly yearError: HTMLElement;
  get(): { year?: number; month?: number; day?: number };
  set(value: { year?: number; month?: number; day?: number }): void;
}

interface EventControls {
  readonly county: HTMLSelectElement;
  readonly countyError: HTMLElement;
  readonly position: HTMLInputElement;
  readonly positionError: HTMLElement;
  readonly basis: HTMLSelectElement;
}

interface Card {
  readonly catalogId: number;
  readonly root: HTMLElement;
  readonly legend: HTMLElement;
  readonly remove: HTMLButtonElement;
  readonly details: HTMLTextAreaElement;
  readonly detailsError: HTMLElement;
  readonly date: DateControls;
  readonly event: EventControls;
  readonly role: HTMLSelectElement;
  readonly roleField: HTMLElement;
  readonly summary: HTMLElement;
}

function dash(value: string | null): string {
  return value ?? "Not recorded";
}

function labelled(
  document: Document,
  text: string,
  control: HTMLElement,
  extra?: HTMLElement,
): HTMLElement {
  const wrap = node(document, "div", "report-field");
  const label = node(document, "label");
  label.htmlFor = control.id;
  label.textContent = text;
  wrap.append(label);
  if (extra) wrap.append(extra);
  wrap.append(control);
  return wrap;
}

function countySelect(
  document: Document,
  id: string,
  counties: readonly CountyRegistryEntry[],
  placeholder: string,
): HTMLSelectElement {
  const select = node(document, "select");
  select.id = id;
  const first = node(document, "option");
  first.value = "";
  first.textContent = placeholder;
  select.append(first);
  for (const county of counties) {
    const option = node(document, "option");
    option.value = county.fips;
    option.textContent = county.name;
    select.append(option);
  }
  return select;
}

function makeDateControls(
  document: Document,
  prefix: string,
  now: () => Date,
  onChange: () => void,
): DateControls {
  const element = node(document, "div", "report-date-row");
  const year = node(document, "select");
  year.id = `${prefix}-year`;
  const yearPlaceholder = node(document, "option");
  yearPlaceholder.value = "";
  yearPlaceholder.textContent = "Choose year";
  year.append(yearPlaceholder);
  for (const value of eventYears(now())) {
    const option = node(document, "option");
    option.value = String(value);
    option.textContent = String(value);
    year.append(option);
  }
  const yearError = fieldError(document, year.id);
  connectError(year, null, yearError);
  const month = node(document, "select");
  month.id = `${prefix}-month`;
  const day = node(document, "select");
  day.id = `${prefix}-day`;
  const yearField = labelled(document, "Year · required", year, undefined);
  yearField.append(yearError);
  const monthField = labelled(document, "Month · optional", month);
  const dayField = labelled(document, "Day · optional", day);
  monthField.hidden = true;
  dayField.hidden = true;
  const fill = (select: HTMLSelectElement, empty: string, items: string[]) => {
    select.replaceChildren();
    const first = node(document, "option");
    first.value = "";
    first.textContent = empty;
    select.append(first);
    items.forEach((text, index) => {
      const option = node(document, "option");
      option.value = String(index + 1);
      option.textContent = text;
      select.append(option);
    });
  };
  fill(month, "Year only", [...MONTH_NAMES]);
  const refreshDays = () => {
    const y = Number(year.value);
    const m = Number(month.value);
    const keep = day.value;
    const count = y && m ? daysInMonth(y, m) : 0;
    fill(
      day,
      "Month only",
      Array.from({ length: count }, (_, i) => String(i + 1)),
    );
    if (keep && Number(keep) <= count) day.value = keep;
    dayField.hidden = !month.value;
  };
  const refresh = () => {
    monthField.hidden = !year.value;
    if (!year.value) month.value = "";
    refreshDays();
  };
  year.addEventListener("change", () => {
    refresh();
    onChange();
  });
  month.addEventListener("change", () => {
    day.value = "";
    refreshDays();
    onChange();
  });
  day.addEventListener("change", onChange);
  element.append(yearField, monthField, dayField);
  return {
    element,
    year,
    month,
    day,
    yearError,
    get() {
      return {
        ...(year.value ? { year: Number(year.value) } : {}),
        ...(year.value && month.value ? { month: Number(month.value) } : {}),
        ...(year.value && month.value && day.value
          ? { day: Number(day.value) }
          : {}),
      };
    },
    set(value) {
      year.value = value.year ? String(value.year) : "";
      refresh();
      month.value = value.month ? String(value.month) : "";
      refreshDays();
      day.value = value.day ? String(value.day) : "";
    },
  };
}

function makeEventControls(
  document: Document,
  prefix: string,
  counties: readonly CountyRegistryEntry[],
): { controls: EventControls; fields: HTMLElement[] } {
  const county = countySelect(
    document,
    `${prefix}-county`,
    counties,
    "Choose the event county",
  );
  const countyError = fieldError(document, county.id);
  connectError(county, null, countyError);
  const countyField = labelled(
    document,
    "County at the event · required",
    county,
  );
  countyField.append(countyError);
  const position = node(document, "input");
  position.id = `${prefix}-position`;
  position.type = "text";
  position.maxLength = MAX_POSITION_LENGTH;
  position.autocomplete = "off";
  const positionHint = node(document, "span", "report-field-hint");
  positionHint.id = `${prefix}-position-hint`;
  positionHint.textContent =
    "Review the role and county for the reported event. Directory filters do not move reports between counties.";
  const positionError = fieldError(document, position.id);
  connectError(position, positionHint, positionError);
  const positionField = labelled(
    document,
    "Position at the event · if known",
    position,
    positionHint,
  );
  positionField.append(positionError);
  const basis = node(document, "select");
  basis.id = `${prefix}-basis`;
  for (const item of IDENTIFICATION_BASES) {
    const option = node(document, "option");
    option.value = item.id;
    option.textContent = item.label;
    basis.append(option);
  }
  const basisField = labelled(document, "Identification basis", basis);
  return {
    controls: { county, countyError, position, positionError, basis },
    fields: [countyField, positionField, basisField],
  };
}

/**
 * The Employee & event and Grievances & sources steps of the report form,
 * following the archived Beta-1 layout. The first grievance's event fields
 * appear in step 1 and stay mirrored with its card in step 2.
 */
export function createGrievanceForm(
  document: Document,
  options: GrievanceFormOptions,
) {
  const { counties, directory } = options;
  const now = options.now;
  const countyName = (fips: string) =>
    counties.find((county) => county.fips === fips)?.name ?? fips;

  // ---- Step 1: subject ----
  let mode: "listed" | "unlisted" = "listed";
  let chosen: {
    personId: string;
    displayName: string;
    roles: readonly PickerRole[];
  } | null = null;
  let chosenRoleId = "";

  const subjectType = node(document, "select");
  subjectType.id = "report-subject-type";
  for (const [value, text] of [
    ["listed", "Listed employee / official"],
    ["unlisted", "Employee not in the directory"],
  ] as const) {
    const option = node(document, "option");
    option.value = value;
    option.textContent = text;
    subjectType.append(option);
  }
  const subjectTypeField = labelled(document, "Subject type", subjectType);

  const listedPanel = node(document, "div", "report-picker");
  const filterRow = node(document, "div", "report-filter-row");
  const filterCounty = countySelect(
    document,
    "report-filter-county",
    counties,
    "All counties",
  );
  const filterOffice = node(document, "select");
  filterOffice.id = "report-filter-office";
  const allOffices = node(document, "option");
  allOffices.value = "";
  allOffices.textContent = "All county offices & departments";
  filterOffice.append(allOffices);
  filterOffice.disabled = true;
  filterRow.append(
    labelled(document, "Filter by county", filterCounty),
    labelled(document, "Filter by county office · optional", filterOffice),
  );
  const search = node(document, "input");
  search.id = "report-employee-search";
  search.type = "search";
  search.maxLength = 100;
  search.autocomplete = "off";
  search.placeholder = "Find a current or prior employee";
  const searchError = fieldError(document, search.id);
  const searchField = labelled(
    document,
    "Search by name, title or department",
    search,
  );
  searchField.append(searchError);
  const resultsStatus = node(document, "p", "report-field-hint");
  resultsStatus.setAttribute("role", "status");
  resultsStatus.setAttribute("aria-live", "polite");
  const results = node(document, "ul", "report-picker-results");
  const pager = node(document, "div", "report-picker-pager");
  const previousPage = button(
    document,
    "← Previous",
    "report-button report-button-quiet",
  );
  const nextPage = button(
    document,
    "Next →",
    "report-button report-button-quiet",
  );
  const pageLabel = node(document, "span");
  pager.append(previousPage, pageLabel, nextPage);
  pager.hidden = true;
  const roleBox = node(document, "fieldset", "report-field report-role-box");
  roleBox.hidden = true;
  const roleLegend = node(document, "legend");
  roleLegend.textContent = "Selected profile / role";
  const roleBody = node(document, "div");
  const roleStatus = node(document, "p", "report-field-hint");
  roleStatus.setAttribute("role", "status");
  const roleWarning = node(document, "p", "report-field-hint");
  roleWarning.textContent =
    "Verification describes the source observation, not a hiring or departure date. Latest listed does not guarantee current employment. Choose a prior role when it matches the event.";
  roleBox.append(roleLegend, roleBody, roleStatus, roleWarning);
  const selectedSummary = node(document, "p", "report-selected-employee");
  selectedSummary.id = "report-selected-employee";
  selectedSummary.hidden = true;
  listedPanel.append(
    filterRow,
    searchField,
    resultsStatus,
    results,
    pager,
    roleBox,
    selectedSummary,
  );

  const unlistedPanel = node(document, "div", "report-picker");
  unlistedPanel.hidden = true;
  const unlistedName = node(document, "input");
  unlistedName.id = "report-unlisted-name";
  unlistedName.type = "text";
  unlistedName.maxLength = MAX_UNLISTED_NAME_LENGTH;
  unlistedName.autocomplete = "off";
  const unlistedNameError = fieldError(document, unlistedName.id);
  connectError(unlistedName, null, unlistedNameError);
  const unlistedOffice = node(document, "input");
  unlistedOffice.id = "report-unlisted-office";
  unlistedOffice.type = "text";
  unlistedOffice.maxLength = MAX_UNLISTED_OFFICE_LENGTH;
  unlistedOffice.autocomplete = "off";
  const unlistedOfficeError = fieldError(document, unlistedOffice.id);
  connectError(unlistedOffice, null, unlistedOfficeError);
  const unlistedHint = node(document, "p", "report-field-hint");
  unlistedHint.textContent =
    "An unlisted identity stays private until an editor reviews and approves the profile.";
  const nameField = labelled(
    document,
    "Employee’s name · required",
    unlistedName,
  );
  nameField.append(unlistedNameError);
  const officeField = labelled(
    document,
    "Office or department · required",
    unlistedOffice,
  );
  officeField.append(unlistedOfficeError);
  unlistedPanel.append(nameField, officeField, unlistedHint);

  // ---- Step 1: first grievance's event fields ----
  const events = makeEventControls(document, "report", counties);
  const eventDate = makeDateControls(document, "report-event", now, () =>
    mirrorToFirstCard(),
  );
  const dateHelp = node(document, "p", "report-field-hint");
  dateHelp.textContent =
    "Only the year is required. Add a month or day if you remember it. The year window is an editorial intake policy.";
  const laterNote = node(document, "p", "report-field-hint");
  laterNote.textContent =
    "Later grievances can have their own dates, event counties and role context.";

  const step1Fields: HTMLElement[] = [
    subjectTypeField,
    listedPanel,
    unlistedPanel,
    ...events.fields,
    eventDate.element,
    dateHelp,
    laterNote,
  ];

  // ---- Step 2: headline and cards ----
  const headline = node(document, "input");
  headline.id = "report-headline";
  headline.type = "text";
  headline.maxLength = MAX_HEADLINE_LENGTH;
  headline.autocomplete = "off";
  const headlineHint = node(document, "span", "report-field-hint");
  headlineHint.id = "report-headline-hint";
  headlineHint.textContent =
    "Editors may revise the headline for neutrality or privacy. Your submitted wording is retained privately.";
  headline.setAttribute("aria-describedby", headlineHint.id);
  const headlineField = labelled(
    document,
    "Proposed headline · optional",
    headline,
    headlineHint,
  );
  const cardIntro = node(document, "p", "report-confidentiality");
  cardIntro.textContent =
    "One to five grievances, up to 250 words each. Types organize allegations. They are not legal findings. Distinguish what you observed from information provided by others and your opinions.";
  const catalogControls = node(
    document,
    "div",
    "report-grievance-sort-controls",
  );
  catalogControls.setAttribute("role", "group");
  catalogControls.setAttribute("aria-label", "Commonality order");
  const commonalityLabel = node(document, "span");
  commonalityLabel.textContent = "Commonality order";
  const mostCommon = button(
    document,
    "Most common first",
    "report-button report-button-quiet",
  );
  const leastCommon = button(
    document,
    "Least common first",
    "report-button report-button-quiet",
  );
  mostCommon.type = "button";
  leastCommon.type = "button";
  mostCommon.setAttribute("aria-pressed", "true");
  leastCommon.setAttribute("aria-pressed", "false");
  catalogControls.append(commonalityLabel, mostCommon, leastCommon);
  const catalogScroll = node(document, "div", "report-grievance-table-scroll");
  const catalogTable = node(
    document,
    "table",
    "report-grievance-catalog-table",
  );
  const catalogCaption = node(document, "caption");
  catalogCaption.textContent =
    "Choose up to five grievances. Use the sorting controls to find an item.";
  const catalogHead = node(document, "thead");
  const catalogHeaderRow = node(document, "tr");
  const catalogBody = node(document, "tbody");
  const catalogRows = new Map<
    number,
    {
      entry: (typeof REPORT_GRIEVANCE_CATALOG)[number];
      row: HTMLTableRowElement;
      checkbox: HTMLInputElement;
    }
  >();
  let catalogSort: {
    key: "commonality" | "title" | "description" | "type";
    direction: "ascending" | "descending";
  } = {
    key: "commonality",
    direction: "descending",
  };
  const collator = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
  });
  const columns = [
    ["title", "Grievance"],
    ["description", "Description"],
    ["type", "Type"],
  ] as const;
  const catalogHeaders = new Map<string, HTMLTableCellElement>();
  for (const [key, title] of columns) {
    const th = node(document, "th");
    th.scope = "col";
    th.classList.add("is-sortable");
    const sortButton = button(document, "", "county-sort-button");
    sortButton.type = "button";
    const label = node(document, "span");
    label.textContent = title;
    const arrow = node(document, "span", "county-sort-arrow");
    arrow.setAttribute("aria-hidden", "true");
    sortButton.append(label, arrow);
    sortButton.addEventListener("click", () => {
      catalogSort = {
        key,
        direction:
          catalogSort.key === key && catalogSort.direction === "ascending"
            ? "descending"
            : "ascending",
      };
      updateCatalogSort();
    });
    th.append(sortButton);
    catalogHeaders.set(key, th);
    catalogHeaderRow.append(th);
  }
  catalogHead.append(catalogHeaderRow);
  catalogTable.append(catalogCaption, catalogHead, catalogBody);
  catalogScroll.append(catalogTable);
  const selectionStatus = node(document, "p", "report-field-hint");
  selectionStatus.id = "report-grievance-selection-status";
  selectionStatus.setAttribute("role", "status");
  selectionStatus.setAttribute("aria-live", "polite");
  const selectionError = fieldError(document, "report-grievance-selection");
  for (const entry of REPORT_GRIEVANCE_CATALOG) {
    const row = node(document, "tr");
    const titleCell = node(document, "td");
    const titleLabel = node(document, "label", "report-grievance-select");
    const checkbox = node(document, "input");
    checkbox.type = "checkbox";
    checkbox.id = `report-grievance-${entry.inventoryId}`;
    checkbox.value = String(entry.inventoryId);
    checkbox.setAttribute("aria-label", `Select ${entry.title}`);
    connectError(checkbox, selectionStatus, selectionError);
    titleLabel.append(checkbox, document.createTextNode(entry.title));
    titleCell.append(titleLabel);
    const descriptionCell = node(document, "td");
    descriptionCell.textContent = entry.description;
    const typeCell = node(document, "td");
    typeCell.textContent = entry.type;
    row.append(titleCell, descriptionCell, typeCell);
    catalogRows.set(entry.inventoryId, { entry, row, checkbox });
    catalogBody.append(row);
  }
  const updateCatalogSort = () => {
    const { key, direction } = catalogSort;
    const sign = direction === "ascending" ? 1 : -1;
    const sorted = [...catalogRows.values()].sort((left, right) => {
      if (key === "commonality") {
        return (
          (left.entry.commonalityScore - right.entry.commonalityScore) * sign ||
          left.entry.inventoryId - right.entry.inventoryId
        );
      }
      const leftValue = key === "title" ? left.entry.title : left.entry[key];
      const rightValue = key === "title" ? right.entry.title : right.entry[key];
      return (
        collator.compare(leftValue, rightValue) * sign ||
        left.entry.inventoryId - right.entry.inventoryId
      );
    });
    catalogBody.replaceChildren(...sorted.map(({ row }) => row));
    for (const [key, th] of catalogHeaders) {
      const active = catalogSort.key === key;
      th.setAttribute("aria-sort", active ? catalogSort.direction : "none");
      const sortButton = th.querySelector("button");
      sortButton?.setAttribute(
        "aria-label",
        `Sort ${columns.find(([column]) => column === key)?.[1]} ${active && direction === "ascending" ? "Z to A" : "A to Z"}`,
      );
    }
    mostCommon.setAttribute(
      "aria-pressed",
      String(key === "commonality" && direction === "descending"),
    );
    leastCommon.setAttribute(
      "aria-pressed",
      String(key === "commonality" && direction === "ascending"),
    );
  };
  mostCommon.addEventListener("click", () => {
    catalogSort = { key: "commonality", direction: "descending" };
    updateCatalogSort();
  });
  leastCommon.addEventListener("click", () => {
    catalogSort = { key: "commonality", direction: "ascending" };
    updateCatalogSort();
  });
  updateCatalogSort();
  const cardList = node(document, "div", "report-grievance-list");

  const cards: Card[] = [];
  let sequence = 0;

  const first = () => cards[0] as Card;

  const roleLabel = (role: PickerRole) =>
    [role.title ?? "Title not recorded", role.office, role.county?.name]
      .filter(Boolean)
      .join(" · ");

  const refreshRoleSelects = () => {
    for (const [index, card] of cards.entries()) {
      const showRole =
        mode === "listed" && chosen !== null && chosen.roles.length > 0;
      card.roleField.hidden = !showRole;
      const previous = card.role.value;
      card.role.replaceChildren();
      if (showRole && chosen) {
        for (const role of chosen.roles) {
          const option = node(document, "option");
          option.value = role.id;
          option.textContent = roleLabel(role);
          card.role.append(option);
        }
        const valid = chosen.roles.some((role) => role.id === previous);
        card.role.value =
          index > 0 && valid
            ? previous
            : chosenRoleId || (chosen.roles[0]?.id ?? "");
      }
      refreshSummary(card);
    }
  };

  const subjectName = () =>
    mode === "listed"
      ? (chosen?.displayName ?? "No employee selected")
      : unlistedName.value.trim() || "Unlisted employee";

  const refreshSummary = (card: Card) => {
    card.summary.textContent = `Event subjects & role context · ${subjectName()}`;
  };

  const mirrorToFirstCard = () => {
    const card = cards[0];
    if (!card) return;
    card.date.set(eventDate.get());
    card.event.county.value = events.controls.county.value;
    card.event.position.value = events.controls.position.value;
    card.event.basis.value = events.controls.basis.value;
  };
  const mirrorFromFirstCard = () => {
    const card = cards[0];
    if (!card) return;
    eventDate.set(card.date.get());
    events.controls.county.value = card.event.county.value;
    events.controls.position.value = card.event.position.value;
    events.controls.basis.value = card.event.basis.value;
  };
  for (const control of [
    events.controls.county,
    events.controls.position,
    events.controls.basis,
  ]) {
    control.addEventListener("input", mirrorToFirstCard);
    control.addEventListener("change", mirrorToFirstCard);
  }

  const renumber = () => {
    cards.forEach((card, index) => {
      const entry = reportGrievanceCatalogEntry(card.catalogId);
      card.legend.textContent = `Grievance ${index + 1}: ${entry?.title ?? "Unknown item"}`;
      card.remove.setAttribute("aria-label", `Remove grievance ${index + 1}`);
    });
    selectionStatus.textContent = `${cards.length} of ${MAX_GRIEVANCES} grievances selected. Select up to ${MAX_GRIEVANCES}.`;
    if (cards.length > 0) {
      selectionError.textContent = "";
      selectionError.hidden = true;
      const errorControl = catalogRows.values().next().value?.checkbox;
      const form = catalogTable.closest("form");
      if (errorControl) {
        errorControl.removeAttribute("aria-invalid");
        const summary = form?.querySelector<HTMLElement>(
          ".report-error-summary",
        );
        summary
          ?.querySelector(`a[href="#${errorControl.id}"]`)
          ?.parentElement?.remove();
        if (summary && !summary.querySelector("li")) summary.hidden = true;
      }
    }
  };

  const addGrievance = (catalogId: number, focus: boolean) => {
    if (cards.length >= MAX_GRIEVANCES) return false;
    const entry = reportGrievanceCatalogEntry(catalogId);
    if (!entry) return false;
    const key = sequence++;
    const prefix = `report-g${key}`;
    const root = node(document, "fieldset", "report-grievance-card");
    const legend = node(document, "legend");
    legend.textContent = `Grievance ${cards.length + 1}: ${entry.title}`;
    const catalogDescription = node(
      document,
      "p",
      "report-grievance-description",
    );
    catalogDescription.textContent = entry.description;

    const details = node(document, "textarea");
    details.id = `${prefix}-details`;
    details.rows = 6;
    details.maxLength = MAX_GRIEVANCE_CHARACTERS;
    details.autocomplete = "off";
    const count = node(document, "p", "report-word-count");
    count.id = `${prefix}-count`;
    count.textContent = `0 / ${MAX_GRIEVANCE_WORDS} words · 0 / ${MAX_GRIEVANCE_CHARACTERS} characters`;
    const detailsError = fieldError(document, details.id);
    connectError(details, count, detailsError);
    details.addEventListener("input", () => {
      const words = countWords(details.value);
      count.textContent = `${words} / ${MAX_GRIEVANCE_WORDS} words · ${details.value.length} / ${MAX_GRIEVANCE_CHARACTERS} characters`;
      count.classList.toggle("is-over", words > MAX_GRIEVANCE_WORDS);
    });
    const detailsField = labelled(
      document,
      "Grievance details · required",
      details,
      count,
    );
    detailsField.append(detailsError);

    const date = makeDateControls(document, prefix, now, () => {
      if (cards[0] === card) mirrorFromFirstCard();
    });
    const eventParts = makeEventControls(document, prefix, counties);
    const roleSelect = node(document, "select");
    roleSelect.id = `${prefix}-role`;
    const roleField = labelled(document, "Role at the event", roleSelect);
    roleField.hidden = true;
    const disclosure = node(document, "details", "report-event-details");
    const summary = node(document, "summary");
    disclosure.append(summary, roleField, ...eventParts.fields);
    const remove = button(
      document,
      "Remove grievance",
      "report-button report-button-quiet",
    );
    const card: Card = {
      catalogId,
      root,
      legend,
      remove,
      details,
      detailsError,
      date,
      event: eventParts.controls,
      role: roleSelect,
      roleField,
      summary,
    };
    for (const control of [
      eventParts.controls.county,
      eventParts.controls.position,
      eventParts.controls.basis,
    ]) {
      const sync = () => {
        if (cards[0] === card) mirrorFromFirstCard();
      };
      control.addEventListener("input", sync);
      control.addEventListener("change", sync);
    }
    roleSelect.addEventListener("change", () => {
      if (cards[0] === card) chosenRoleId = roleSelect.value;
    });
    remove.addEventListener("click", () => {
      const index = cards.indexOf(card);
      if (index < 0) return;
      cards.splice(index, 1);
      root.remove();
      const checkbox = catalogRows.get(catalogId)?.checkbox;
      if (checkbox) checkbox.checked = false;
      if (index === 0) {
        if (cards[0]) {
          mirrorFromFirstCard();
          chosenRoleId = first().role.value || chosenRoleId;
        }
      }
      renumber();
      refreshRoleSelects();
      catalogRows.get(catalogId)?.checkbox.focus();
    });
    root.append(
      legend,
      catalogDescription,
      detailsField,
      date.element,
      disclosure,
      remove,
    );
    // A new card starts from the first card's date and event context.
    const source = cards[0];
    if (source) {
      date.set(source.date.get());
      eventParts.controls.county.value = source.event.county.value;
      eventParts.controls.position.value = source.event.position.value;
      eventParts.controls.basis.value = source.event.basis.value;
    } else {
      date.set(eventDate.get());
      eventParts.controls.county.value = events.controls.county.value;
      eventParts.controls.position.value = events.controls.position.value;
      eventParts.controls.basis.value = events.controls.basis.value;
    }
    cards.push(card);
    cardList.append(root);
    const checkbox = catalogRows.get(catalogId)?.checkbox;
    if (checkbox) checkbox.checked = true;
    refreshRoleSelects();
    if (source && cards.length > 1) roleSelect.value = source.role.value;
    renumber();
    if (cards.length === 1) mirrorToFirstCard();
    if (focus) details.focus();
    return true;
  };
  for (const { entry, checkbox } of catalogRows.values()) {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (!addGrievance(entry.inventoryId, false)) {
          checkbox.checked = false;
          selectionStatus.textContent = `Maximum of ${MAX_GRIEVANCES} grievances selected. Remove one before selecting another.`;
          checkbox.focus();
        }
      } else {
        const card = cards.find((item) => item.catalogId === entry.inventoryId);
        if (card) card.remove.click();
      }
    });
  }

  const sources: HTMLElement[] = [];
  const step2Head: HTMLElement[] = [
    headlineField,
    cardIntro,
    catalogControls,
    catalogScroll,
    selectionStatus,
    selectionError,
    cardList,
  ];

  // ---- Directory picker behavior ----
  let requestToken = 0;
  let page = 1;
  let debounce: number | undefined;
  const win = document.defaultView;

  const shortDate = (value: string) => value.slice(0, 10);

  const renderRoles = (roles: readonly PickerRole[], personName: string) => {
    roleBody.replaceChildren();
    const groups: ReadonlyArray<[PickerRole["group"], string]> = [
      ["latest", "Latest listed roles"],
      ["prior", "Prior roles"],
      ["unrecorded", "Employment context not recorded"],
    ];
    for (const [group, title] of groups) {
      const list = roles.filter((role) => role.group === group);
      if (!list.length) continue;
      const heading = node(document, "h3", "report-role-group");
      heading.textContent = title;
      roleBody.append(heading);
      for (const role of list) {
        const label = node(document, "label", "report-role-option");
        const radio = node(document, "input");
        radio.type = "radio";
        radio.name = "report-role";
        radio.value = role.id;
        radio.checked = role.id === chosenRoleId;
        radio.addEventListener("change", () => {
          chosenRoleId = role.id;
          showSelected(personName);
          refreshRoleSelects();
        });
        const text = node(document, "span");
        const dates =
          role.startDate || role.endDate
            ? ` · Documented employment: ${role.startDate ?? "start not recorded"} to ${role.endDate ?? "no end recorded"}`
            : "";
        text.textContent = `${roleLabel(role)} · Source checked ${shortDate(role.sourceCheckedAt)}${dates}`;
        label.append(radio, text);
        roleBody.append(label);
      }
    }
  };

  const showSelected = (personName: string) => {
    const role = chosen?.roles.find((item) => item.id === chosenRoleId);
    selectedSummary.hidden = !role;
    selectedSummary.textContent = role
      ? `Selected: ${personName} · ${roleLabel(role)}`
      : "";
  };

  const choosePerson = async (person: PickerPerson) => {
    if (!directory) return;
    roleBox.hidden = false;
    roleBody.replaceChildren();
    roleStatus.textContent = "Loading roles…";
    const token = ++requestToken;
    try {
      const loaded = await directory.roles(person.personId);
      if (token !== requestToken) return;
      chosen = {
        personId: loaded.person.personId,
        displayName: loaded.person.displayName,
        roles: loaded.roles,
      };
      chosenRoleId =
        loaded.roles.length === 1 ? (loaded.roles[0]?.id ?? "") : "";
      roleStatus.textContent = loaded.roles.length
        ? `${loaded.roles.length} documented role${loaded.roles.length === 1 ? "" : "s"} for ${chosen.displayName}. Choose the role that matches the event.`
        : "This profile has no documented role to select.";
      renderRoles(loaded.roles, chosen.displayName);
      showSelected(chosen.displayName);
      refreshRoleSelects();
      // The role list loads below the results, so bring it into view.
      roleBox.scrollIntoView?.({ block: "nearest" });
      roleBody.querySelector<HTMLElement>("input")?.focus();
    } catch {
      if (token !== requestToken) return;
      roleStatus.textContent =
        "Couldn’t load this person’s roles. Select the person again to retry.";
    }
  };

  const runSearch = async () => {
    if (!directory) return;
    const query = search.value.trim();
    if (query.length === 1) {
      resultsStatus.textContent = "Enter at least two characters to search.";
      return;
    }
    const token = ++requestToken;
    resultsStatus.textContent = "Searching…";
    try {
      const found = await directory.search({
        county: filterCounty.value,
        office: filterOffice.value,
        query,
        page,
      });
      if (token !== requestToken) return;
      results.replaceChildren();
      for (const person of found.items) {
        const item = node(document, "li");
        const choose = button(
          document,
          person.displayName,
          "report-picker-result",
        );
        const detail = node(document, "span", "report-field-hint");
        const role = person.role;
        detail.textContent = role
          ? `${roleLabel(role)} · Source checked ${shortDate(role.sourceCheckedAt)}${person.matchingRoleCount > 1 ? ` · ${person.matchingRoleCount} documented roles` : ""}`
          : "No documented role";
        choose.setAttribute(
          "aria-label",
          `Select ${person.displayName}${role ? `, ${roleLabel(role)}, source checked ${shortDate(role.sourceCheckedAt)}` : ""}`,
        );
        choose.addEventListener("click", () => {
          void choosePerson(person);
        });
        item.append(choose, detail);
        results.append(item);
      }
      const where = filterCounty.value
        ? countyName(filterCounty.value)
        : "statewide";
      resultsStatus.textContent = `${found.total} matching profile${found.total === 1 ? "" : "s"} ${where === "statewide" ? "statewide" : `in ${where}`}`;
      pager.hidden = found.pageCount <= 1;
      pageLabel.textContent = `Page ${found.page} of ${found.pageCount}`;
      previousPage.disabled = found.page <= 1;
      nextPage.disabled = found.page >= found.pageCount;
    } catch {
      if (token !== requestToken) return;
      resultsStatus.textContent =
        "The employee directory couldn’t be loaded. Change a filter to try again, or choose an employee not in the directory.";
    }
  };

  const loadOffices = async () => {
    filterOffice.replaceChildren(allOffices);
    filterOffice.value = "";
    filterOffice.disabled = !filterCounty.value;
    if (!directory || !filterCounty.value) return;
    try {
      const loaded = await directory.offices(filterCounty.value);
      for (const office of loaded.offices) {
        const option = node(document, "option");
        option.value = office.id;
        option.textContent = office.name;
        filterOffice.append(option);
      }
    } catch {
      resultsStatus.textContent =
        "County offices couldn’t be loaded. You can still search by name.";
    }
  };

  filterCounty.addEventListener("change", () => {
    page = 1;
    void loadOffices().then(runSearch);
  });
  filterOffice.addEventListener("change", () => {
    page = 1;
    void runSearch();
  });
  search.addEventListener("input", () => {
    page = 1;
    if (debounce !== undefined) win?.clearTimeout(debounce);
    debounce = win?.setTimeout(() => void runSearch(), 250);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (debounce !== undefined) win?.clearTimeout(debounce);
      void runSearch();
    }
  });
  previousPage.addEventListener("click", () => {
    page = Math.max(1, page - 1);
    void runSearch();
  });
  nextPage.addEventListener("click", () => {
    page += 1;
    void runSearch();
  });
  subjectType.addEventListener("change", () => {
    mode = subjectType.value === "unlisted" ? "unlisted" : "listed";
    listedPanel.hidden = mode !== "listed";
    unlistedPanel.hidden = mode !== "unlisted";
    refreshRoleSelects();
  });
  unlistedName.addEventListener("input", () => {
    for (const card of cards) refreshSummary(card);
  });
  if (!directory) {
    // Without a directory source only the unlisted path can work.
    subjectType.value = "unlisted";
    subjectType.disabled = true;
    mode = "unlisted";
    listedPanel.hidden = true;
    unlistedPanel.hidden = false;
  } else {
    void runSearch();
  }

  // ---- Reading and checking the form ----
  const readCard = (card: Card, index: number): ReportGrievance => {
    const date = card.date.get();
    const subject: ReportEventSubject =
      mode === "listed"
        ? {
            kind: "listed",
            personId: chosen?.personId ?? "",
            roleId: card.role.value || chosenRoleId,
          }
        : {
            kind: "unlisted",
            name: unlistedName.value.trim(),
            office: unlistedOffice.value.trim(),
          };
    const eventControls = index === 0 ? events.controls : card.event;
    const position = eventControls.position.value.trim();
    return {
      catalogId: card.catalogId,
      details: card.details.value.trim(),
      date: date as ReportEventDate,
      countyId: eventControls.county.value,
      subject,
      ...(position ? { position } : {}),
      identificationBasis: eventControls.basis.value as IdentificationBasis,
    };
  };

  const collect = () => ({
    ...(headline.value.trim() ? { headline: headline.value.trim() } : {}),
    grievances: cards.map(readCard),
  });

  const validate = (): FieldProblem[] => {
    const problems: FieldProblem[] = [];
    const add = (control: HTMLElement, error: HTMLElement, message?: string) =>
      problems.push({ control, error, ...(message ? { message } : {}) });
    if (mode === "listed") {
      add(
        search,
        searchError,
        !chosen
          ? "Choose a listed employee, or choose an employee not in the directory."
          : !chosenRoleId
            ? "Choose the role that matches the event."
            : undefined,
      );
    } else {
      add(
        unlistedName,
        unlistedNameError,
        unlistedName.value.trim() ? undefined : "Enter the employee’s name.",
      );
      add(
        unlistedOffice,
        unlistedOfficeError,
        unlistedOffice.value.trim()
          ? undefined
          : "Enter the employee’s office or department.",
      );
    }
    const selectionMessage =
      cards.length < 1
        ? "Select at least one grievance."
        : cards.length > MAX_GRIEVANCES
          ? `Select no more than ${MAX_GRIEVANCES} grievances.`
          : undefined;
    selectionError.textContent = selectionMessage ?? "";
    selectionError.hidden = !selectionMessage;
    if (selectionMessage) {
      const firstCheckbox = catalogRows.values().next().value?.checkbox;
      if (firstCheckbox) {
        problems.push({
          control: firstCheckbox,
          error: selectionError,
          message: selectionMessage,
        });
      }
    }
    cards.forEach((card, index) => {
      const eventControls = index === 0 ? events.controls : card.event;
      const dateControls = index === 0 ? eventDate : card.date;
      const date = dateControls.get();
      add(
        eventControls.county,
        eventControls.countyError,
        counties.some((county) => county.fips === eventControls.county.value)
          ? undefined
          : "Choose the county where the event happened.",
      );
      add(
        dateControls.year,
        dateControls.yearError,
        date.year === undefined
          ? "Choose the year of the event."
          : isValidEventDate(date, now())
            ? undefined
            : "Enter a valid event date.",
      );
      const words = countWords(card.details.value);
      add(
        card.details,
        card.detailsError,
        words < 1
          ? "Describe the grievance."
          : words > MAX_GRIEVANCE_WORDS
            ? `Use ${MAX_GRIEVANCE_WORDS} words or fewer.`
            : card.details.value.length > MAX_GRIEVANCE_CHARACTERS
              ? `Use ${MAX_GRIEVANCE_CHARACTERS.toLocaleString("en-US")} characters or fewer.`
              : undefined,
      );
      add(
        eventControls.position,
        eventControls.positionError,
        eventControls.position.value.length > MAX_POSITION_LENGTH
          ? `Use ${MAX_POSITION_LENGTH} characters or fewer.`
          : undefined,
      );
    });
    return problems;
  };

  /** Fills the Review & sign summary from the current entries. */
  const renderReview = (container: HTMLElement) => {
    container.replaceChildren();
    const subject = node(document, "p");
    const role = chosen?.roles.find((item) => item.id === chosenRoleId);
    subject.textContent =
      mode === "listed"
        ? `Employee: ${chosen ? `${chosen.displayName}${role ? ` · ${roleLabel(role)}` : ""}` : "Not selected"}`
        : `Employee not in the directory: ${unlistedName.value.trim() || "Not provided"} · ${unlistedOffice.value.trim() || "Office not provided"}. This identity stays private until an editor reviews it.`;
    container.append(subject);
    if (headline.value.trim()) {
      const title = node(document, "p");
      title.textContent = `Proposed headline: ${headline.value.trim()}`;
      container.append(title);
    }
    cards.forEach((card, index) => {
      const entry = readCard(card, index);
      const block = node(document, "section", "report-review-grievance");
      const heading = node(document, "h3");
      heading.textContent = `Grievance ${index + 1}`;
      const facts = node(document, "dl");
      const rows: Array<[string, string]> = [
        [
          "Date",
          entry.date.year ? formatEventDate(entry.date) : "Not selected",
        ],
        ["Grievance", reportGrievanceTitle(entry)],
        ["Type", reportGrievanceType(entry)],
        [
          "Subject",
          entry.subject.kind === "listed"
            ? ((listed) => {
                const picked = chosen?.roles.find(
                  (item) => item.id === listed.roleId,
                );
                return `${chosen?.displayName ?? "Not selected"}${picked ? ` · ${roleLabel(picked)}` : ""}`;
              })(entry.subject)
            : `${entry.subject.name || "Not provided"} · ${entry.subject.office || "Office not provided"}`,
        ],
        [
          "County at the event",
          entry.countyId ? countyName(entry.countyId) : "Not selected",
        ],
        ["Position at the event", entry.position ?? dash(null)],
      ];
      for (const [term, value] of rows) {
        const dt = node(document, "dt");
        dt.textContent = term;
        const dd = node(document, "dd");
        dd.textContent = value;
        facts.append(dt, dd);
      }
      const text = node(document, "p", "report-review-description");
      text.textContent = entry.details || "Grievance details are missing.";
      block.append(heading, facts, text);
      container.append(block);
    });
  };

  return {
    step1Fields,
    step2Fields: step2Head,
    sources,
    collect,
    validate,
    renderReview,
  };
}

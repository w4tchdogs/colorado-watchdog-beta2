import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import {
  countWords,
  daysInMonth,
  eventYears,
  formatEventDate,
  GRIEVANCE_TYPES,
  grievanceTypeLabel,
  IDENTIFICATION_BASES,
  type IdentificationBasis,
  isValidEventDate,
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
  readonly sourceTitle: string;
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
  readonly key: number;
  readonly root: HTMLElement;
  readonly legend: HTMLElement;
  readonly remove: HTMLButtonElement;
  readonly type: HTMLSelectElement;
  readonly typeError: HTMLElement;
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
  const cardList = node(document, "div", "report-grievance-list");
  const addCard = button(
    document,
    "+ Add another grievance",
    "report-button report-button-quiet",
  );

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
      card.legend.textContent = `Grievance ${index + 1}`;
      card.remove.hidden = cards.length < 2;
      card.remove.setAttribute("aria-label", `Remove grievance ${index + 1}`);
    });
    addCard.disabled = cards.length >= MAX_GRIEVANCES;
    addCard.textContent =
      cards.length >= MAX_GRIEVANCES
        ? `Maximum of ${MAX_GRIEVANCES} grievances`
        : "+ Add another grievance";
  };

  const addGrievance = (focus: boolean) => {
    if (cards.length >= MAX_GRIEVANCES) return;
    const key = sequence++;
    const prefix = `report-g${key}`;
    const root = node(document, "fieldset", "report-grievance-card");
    const legend = node(document, "legend");
    const type = node(document, "select");
    type.id = `${prefix}-type`;
    const placeholder = node(document, "option");
    placeholder.value = "";
    placeholder.textContent = "Choose a type";
    type.append(placeholder);
    for (const item of GRIEVANCE_TYPES) {
      const option = node(document, "option");
      option.value = item.id;
      option.textContent = item.label;
      type.append(option);
    }
    const typeHelp = node(document, "p", "report-field-hint");
    typeHelp.id = `${prefix}-type-help`;
    typeHelp.hidden = true;
    const typeError = fieldError(document, type.id);
    connectError(type, typeHelp, typeError);
    type.addEventListener("change", () => {
      const found = GRIEVANCE_TYPES.find((item) => item.id === type.value);
      typeHelp.textContent = found?.help ?? "";
      typeHelp.hidden = !found;
    });
    const typeField = labelled(
      document,
      "Grievance type · required",
      type,
      typeHelp,
    );
    typeField.append(typeError);

    const details = node(document, "textarea");
    details.id = `${prefix}-details`;
    details.rows = 6;
    details.autocomplete = "off";
    const count = node(document, "p", "report-word-count");
    count.id = `${prefix}-count`;
    count.textContent = `0 / ${MAX_GRIEVANCE_WORDS} words`;
    const detailsError = fieldError(document, details.id);
    connectError(details, count, detailsError);
    details.addEventListener("input", () => {
      const words = countWords(details.value);
      count.textContent = `${words} / ${MAX_GRIEVANCE_WORDS} words`;
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
      key,
      root,
      legend,
      remove,
      type,
      typeError,
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
      if (index < 0 || cards.length < 2) return;
      cards.splice(index, 1);
      root.remove();
      if (index === 0) {
        mirrorFromFirstCard();
        chosenRoleId = first().role.value || chosenRoleId;
      }
      renumber();
      (cards[Math.min(index, cards.length - 1)] as Card).type.focus();
    });
    root.append(
      legend,
      typeField,
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
    }
    cards.push(card);
    cardList.append(root);
    refreshRoleSelects();
    if (source && cards.length > 1) roleSelect.value = source.role.value;
    renumber();
    if (focus) type.focus();
  };
  addCard.addEventListener("click", () => addGrievance(true));

  const sources: HTMLElement[] = [];
  const step2Head: HTMLElement[] = [
    headlineField,
    cardIntro,
    cardList,
    addCard,
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

  addGrievance(false);

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
      type: card.type.value as ReportGrievance["type"],
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
      add(
        card.type,
        card.typeError,
        card.type.value ? undefined : "Choose a grievance type.",
      );
      const words = countWords(card.details.value);
      add(
        card.details,
        card.detailsError,
        words < 1
          ? "Describe the grievance."
          : words > MAX_GRIEVANCE_WORDS
            ? `Use ${MAX_GRIEVANCE_WORDS} words or fewer.`
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
        ["Type", entry.type ? grievanceTypeLabel(entry.type) : "Not selected"],
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

import {
  AjaxModule,
  EditModule,
  FormatModule,
  FrozenColumnsModule,
  InteractionModule,
  KeybindingsModule,
  PageModule,
  ResizeColumnsModule,
  ResizeTableModule,
  SortModule,
  Tabulator,
  type TabulatorCell,
  type TabulatorColumnDefinition,
} from "tabulator-tables";
import {
  ALTERNATE_NAME_STATUSES,
  ALTERNATE_NAME_TYPE_INFO,
  ALTERNATE_NAME_TYPES,
  type AlternateNameFields,
  type AlternateNameList,
  type AlternateNameRecord,
  PROFILE_FIELDS,
  PROFILE_NAME_COMPONENT_COLUMNS,
  PROFILES_DEFAULT_PAGE_SIZE,
  PROFILES_MAX_CHANGES,
  PROFILES_MAX_NAME_AFFIX_LENGTH,
  PROFILES_MAX_NAME_COMPONENT_LENGTH,
  PROFILES_MAX_NAME_LENGTH,
  PROFILES_MAX_SELECT_ALL,
  type ProfileChange,
  type ProfileChangeIssue,
  type ProfileFacets,
  type ProfileFieldDefinition,
  type ProfilePage,
  type ProfilePreview,
  type ProfileQuery,
  type ProfileRow,
  type ProfileSelectionEntry,
} from "../contracts/profiles.js";
import {
  PROFILE_DELETE_REASONS,
  type ProfileDeletePreview,
  type ProfileDeleteReason,
} from "../contracts/profiles-delete.js";
import type { DashboardViewFactory } from "./dashboard.js";
import { clear, el } from "./dom.js";
import { ProfilesApiError, type ProfilesClient } from "./profiles-client.js";
import { createImportPanel } from "./profiles-import-view.js";

Tabulator.registerModule([
  AjaxModule,
  PageModule,
  SortModule,
  FormatModule,
  EditModule,
  ResizeColumnsModule,
  FrozenColumnsModule,
  InteractionModule,
  KeybindingsModule,
  ResizeTableModule,
]);

/**
 * Owner Profiles sheet (PROFILES-1).
 *
 * An Excel-style grid with one row per role. Everything the user types is
 * staged in the browser until Save changes, keyed by stable Profile and Role
 * IDs. Saving previews old and new values and the impact on shared records,
 * then sends one batch with an idempotency key. The server decides every
 * permission, version check and write. The browser never treats its own state
 * as authority.
 */

type RowKey = keyof ProfileRow;

/** Field map ID to the row property the grid shows. */
const ROW_KEY: Readonly<Record<string, RowKey>> = {
  profileId: "profileId",
  displayName: "displayName",
  firstName: "firstName",
  middleName: "middleName",
  lastName: "lastName",
  preferredFirstName: "preferredFirstName",
  namePrefix: "namePrefix",
  nameSuffix: "nameSuffix",
  alternateNameCount: "alternateNameCount",
  nameReview: "nameReview",
  visible: "visible",
  publicationStatus: "publicationStatus",
  createdOn: "createdOn",
  lastUploaded: "lastUploaded",
  county: "county",
  countyUnit: "countyUnit",
  countySubUnit: "countySubUnit",
  officeDepartment: "officeDepartment",
  position: "position",
  roleDuties: "roleDuties",
  employmentStart: "employmentStart",
  employmentEnd: "employmentEnd",
  affiliation: "affiliation",
  dateReviewed: "dateReviewed",
  roleId: "roleId",
  profileVersion: "profileVersion",
  roleVersion: "roleVersion",
};

const ROLE_BULK_FIELDS = [
  { id: "visible", column: "visible", label: "Visible" },
  { id: "employmentStart", column: "start_date", label: "Employment Start" },
  { id: "employmentEnd", column: "end_date", label: "Employment End" },
  { id: "dateReviewed", column: "source_checked_at", label: "Date Reviewed" },
] as const;

/** Person-level name fields. One Profile, one value, shown on every role row. */
const PERSON_NAME_COLUMNS: Readonly<Record<string, string>> = {
  displayName: "display_name",
  ...PROFILE_NAME_COMPONENT_COLUMNS,
};

const COLUMN_FOR_FIELD: Readonly<Record<string, string>> = {
  ...PERSON_NAME_COLUMNS,
  employmentStart: "start_date",
  employmentEnd: "end_date",
  dateReviewed: "source_checked_at",
};

interface Staged {
  change: ProfileChange;
  label: string;
  who: string;
  before: string | boolean | null;
  after: string | boolean | null;
  error: string | null;
  /** Alternate-name entries: the Profile and the effect on its active count. */
  profileId?: string;
  countDelta?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function emptyToNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();
}

function stagedKey(change: ProfileChange): string {
  if (change.kind === "visibility") return `v:${change.personId}`;
  if (change.kind === "alternate_name")
    return change.op === "add"
      ? `a:new:${change.personId}`
      : `a:${change.nameId}`;
  return `${change.entity}:${change.targetId}:${change.field}`;
}

function componentLimit(field: string): number {
  return field === "namePrefix" || field === "nameSuffix"
    ? PROFILES_MAX_NAME_AFFIX_LENGTH
    : PROFILES_MAX_NAME_COMPONENT_LENGTH;
}

function localError(field: string, value: string | null): string | null {
  if (field === "displayName") {
    if (!value?.trim()) return "Display Name cannot be blank.";
    if (value.trim().length > PROFILES_MAX_NAME_LENGTH)
      return `Display Name is limited to ${PROFILES_MAX_NAME_LENGTH} characters.`;
    return null;
  }
  if (field in PERSON_NAME_COLUMNS) {
    const limit = componentLimit(field);
    if (value !== null && value.trim().length > limit)
      return `This name part is limited to ${limit} characters.`;
    return null;
  }
  if (value === null || value.trim() === "") return null;
  const text = value.trim();
  if (field === "dateReviewed" && /^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  if (!DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))
    return "Use a date like 2026-03-14, or leave it blank.";
  return null;
}

function toSelection(row: ProfileRow): ProfileSelectionEntry {
  return {
    rowKey: row.rowKey,
    roleId: row.roleId,
    profileId: row.profileId,
    profileVersion: row.profileVersion,
    roleVersion: row.roleVersion,
    visibilityVersion: row.visibilityVersion,
    visible: row.visible,
    publicationReady: row.publicationReady,
    displayName: row.displayName,
    employmentStart: row.employmentStart,
    employmentEnd: row.employmentEnd,
    dateReviewed: row.dateReviewed,
  };
}

export function createProfilesView(options: {
  readonly client: ProfilesClient;
  /** Rows per page. Tests use a small value to exercise paging. */
  readonly pageSize?: number;
  readonly newKey?: () => string;
}): DashboardViewFactory {
  return (context) => {
    const { doc, container } = context;
    const client = options.client;
    const newKey = options.newKey ?? (() => crypto.randomUUID());
    let query: ProfileQuery = {
      query: "",
      countyFips: null,
      office: null,
      visibility: "all",
      unitLink: "all",
      sort: "displayName",
      direction: "asc",
      page: 1,
      pageSize: options.pageSize ?? PROFILES_DEFAULT_PAGE_SIZE,
    };
    const base = new Map<string, ProfileRow>();
    const staged = new Map<string, Staged>();
    const selected = new Map<string, ProfileSelectionEntry>();
    const visibleColumns = new Set(
      PROFILE_FIELDS.filter(
        (field) => field.defaultVisible && field.status !== "unavailable",
      ).map((field) => field.id),
    );
    let total = 0;
    let destroyed = false;
    let reviewKey: string | null = null;
    let reviewing = false;
    let deleting = false;
    let deleteRequest = 0;
    let matchingVisibilityRequest = 0;
    let matchingVisibilitySaving = false;
    let unitLinkSaving = false;
    let table: Tabulator | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let requestToken = 0;

    // ------------------------------------------------------------ layout
    const searchInput = el(doc, "input", {
      id: "profiles-search",
      type: "search",
      autocomplete: "off",
      maxlength: 100,
      placeholder: "Names, office, position, duties",
    });
    const countySelect = el(doc, "select", { id: "profiles-county" });
    const officeSelect = el(doc, "select", { id: "profiles-office" });
    const visibilitySelect = el(
      doc,
      "select",
      { id: "profiles-visibility" },
      el(doc, "option", { value: "all" }, "All"),
      el(doc, "option", { value: "visible" }, "Visible"),
      el(doc, "option", { value: "hidden" }, "Hidden"),
      el(
        doc,
        "option",
        { value: "incomplete" },
        "Missing information (cannot be visible)",
      ),
    );
    const counts = el(doc, "p", {
      class: "cw-profiles-counts",
      role: "status",
      "aria-live": "polite",
    });
    const unitLinkSelect = el(
      doc,
      "select",
      { id: "profiles-unit-link" },
      el(doc, "option", { value: "all" }, "All"),
      el(doc, "option", { value: "unlinked" }, "Unlinked"),
      el(doc, "option", { value: "linked" }, "Linked"),
    );
    const selectionStatus = el(doc, "p", { class: "cw-profiles-selection" });
    const stagedStatus = el(doc, "p", { class: "cw-profiles-staged" });
    const message = el(doc, "p", {
      class: "cw-profiles-message",
      role: "status",
      "aria-live": "polite",
    });
    const gridHost = el(doc, "div", {
      class: "cw-profiles-grid",
      id: "profiles-grid",
      "aria-label": "Profiles, one row per role",
    });
    const picker = el(doc, "details", { class: "cw-profiles-picker" });
    const reviewPanel = el(doc, "section", {
      class: "cw-profiles-review",
      "aria-labelledby": "profiles-review-h",
      hidden: true,
    });
    const matchingVisibilityPanel = el(doc, "section", {
      class: "cw-profiles-review",
      "aria-labelledby": "profiles-matching-visibility-h",
      hidden: true,
    });
    const unitLinkPanel = el(doc, "section", {
      class: "cw-profiles-review",
      "aria-labelledby": "profiles-unit-links-h",
      hidden: true,
    });
    const deletePanel = el(doc, "section", {
      class: "cw-profiles-review",
      "aria-labelledby": "profiles-delete-h",
      hidden: true,
    });
    const namesPanel = el(doc, "section", {
      class: "cw-profiles-names",
      "aria-labelledby": "profiles-names-h",
      hidden: true,
    });
    const setPanel = el(doc, "section", {
      class: "cw-profiles-set",
      "aria-labelledby": "profiles-set-h",
      hidden: true,
    });

    const button = (
      label: string,
      handler: () => void,
      attributes: Record<string, string | boolean> = {},
    ): HTMLButtonElement => {
      const node = el(doc, "button", { type: "button", ...attributes }, label);
      node.addEventListener("click", handler);
      return node;
    };
    const field = (label: string, control: HTMLElement, id: string) =>
      el(
        doc,
        "div",
        { class: "cw-profiles-field" },
        el(doc, "label", { for: id }, label),
        control,
      );

    const saveButton = button("Save changes", () => void review(), {
      id: "profiles-save",
    });
    const discardButton = button("Discard changes", () => askDiscard(), {
      id: "profiles-discard",
    });
    const discardConfirm = el(doc, "span", { hidden: true, role: "group" });
    const setButton = button("Set selected values", () => openSetPanel(), {
      id: "profiles-set",
    });
    const hideButton = button(
      "Hide selected Profiles",
      () => stageVisibility(false),
      {
        id: "profiles-hide",
      },
    );
    const restoreButton = button(
      "Restore selected Profiles",
      () => stageVisibility(true),
      { id: "profiles-restore" },
    );
    const deleteButton = button(
      "Delete selected Profiles",
      () => void reviewDelete(),
      { id: "profiles-delete-selected" },
    );
    const selectPage = button("Select this page", () => selectCurrentPage(), {
      id: "profiles-select-page",
    });
    const selectMatching = button(
      `Select matching rows (up to ${PROFILES_MAX_SELECT_ALL})`,
      () => void selectAllMatching(),
      { id: "profiles-select-matching-rows" },
    );
    const selectMatchingProfiles = button(
      "Select all matching",
      () => openMatchingVisibility(),
      { id: "profiles-select-all-matching" },
    );
    const linkExactMatches = button(
      "Link exact matches",
      () => void openUnitLinks(),
      { id: "profiles-link-exact" },
    );
    const clearSelection = button("Clear selection", () => {
      selected.clear();
      refreshSelectionState();
      announce("Selection cleared.");
    });

    container.appendChild(
      el(
        doc,
        "section",
        { class: "cw-profiles", "aria-labelledby": "profiles-heading" },
        el(doc, "h1", { id: "profiles-heading", tabindex: -1 }, "Profiles"),
        el(
          doc,
          "p",
          { class: "cw-profiles-intro" },
          "One row per role. Name columns belong to the person, so a change shows on every role row of that Profile. Edit cells in place or in bulk, open a row's alternate names to add, edit, remove or approve them, then choose Save changes. Edits go to the Website only. The private reviewed Profiles record is edited in its own workflow.",
        ),
        createImportPanel({
          doc,
          client,
          newKey,
          onChanged: () => {
            void reload();
          },
        }),
        el(
          doc,
          "form",
          {
            class: "cw-profiles-filters",
            role: "search",
            "aria-label": "Filter Profiles",
          },
          field("Search", searchInput, "profiles-search"),
          field("County", countySelect, "profiles-county"),
          field("Office / Unit", officeSelect, "profiles-office"),
          field("Visibility", visibilitySelect, "profiles-visibility"),
          field("Unit link", unitLinkSelect, "profiles-unit-link"),
          button(
            "Clear filters",
            () => {
              closeUnitLinks();
              searchInput.value = "";
              countySelect.value = "";
              officeSelect.value = "";
              visibilitySelect.value = "all";
              unitLinkSelect.value = "all";
              applyFilters();
            },
            { id: "profiles-clear" },
          ),
        ),
        el(
          doc,
          "div",
          { class: "cw-profiles-bar" },
          counts,
          selectionStatus,
          stagedStatus,
        ),
        el(
          doc,
          "div",
          {
            class: "cw-profiles-actions",
            role: "toolbar",
            "aria-label": "Profiles actions",
          },
          selectPage,
          selectMatchingProfiles,
          selectMatching,
          linkExactMatches,
          clearSelection,
          setButton,
          hideButton,
          deleteButton,
          restoreButton,
          saveButton,
          discardButton,
          discardConfirm,
          picker,
        ),
        message,
        setPanel,
        namesPanel,
        reviewPanel,
        matchingVisibilityPanel,
        unitLinkPanel,
        deletePanel,
        gridHost,
      ),
    );

    // ------------------------------------------------------ helpers
    function announce(text: string): void {
      message.textContent = text;
      context.announce(text);
    }

    function describeError(error: unknown): string {
      if (error instanceof ProfilesApiError) {
        if (error.status === 401)
          return "Your session ended. Sign in again. Your unsaved edits are still here.";
        if (error.status === 403) return "You do not have access to Profiles.";
        if (error.code === "network_error")
          return "The network failed. Your edits are kept. Try again.";
        return `The request failed (${error.code}). Your edits are kept.`;
      }
      return "Something went wrong. Your edits are kept.";
    }

    function rowFor(rowKey: string): ProfileRow | undefined {
      return base.get(rowKey);
    }

    /** Server values with this browser's staged edits laid over them. */
    function overlay(row: ProfileRow): ProfileRow {
      let next = row;
      for (const [fieldId, column] of Object.entries(PERSON_NAME_COLUMNS)) {
        const entry = staged.get(`people:${row.profileId}:${column}`);
        if (entry?.change.kind === "field")
          next = {
            ...next,
            [fieldId]:
              fieldId === "displayName"
                ? (entry.change.value ?? "")
                : emptyToNull(entry.change.value),
          };
      }
      let delta = 0;
      for (const entry of staged.values())
        if (entry.profileId === row.profileId) delta += entry.countDelta ?? 0;
      if (delta !== 0)
        next = {
          ...next,
          alternateNameCount: Math.max(0, next.alternateNameCount + delta),
        };
      const visible = staged.get(`v:${row.profileId}`);
      if (visible?.change.kind === "visibility")
        next = { ...next, visible: visible.change.visible };
      for (const spec of ROLE_BULK_FIELDS) {
        const entry = staged.get(`person_roles:${row.roleId}:${spec.column}`);
        if (entry?.change.kind === "field")
          next = { ...next, [spec.id]: entry.change.value };
      }
      return next;
    }

    function rowsOnPage(profileId: string): ProfileRow[] {
      return [...base.values()].filter((row) => row.profileId === profileId);
    }

    function refreshTableRows(): void {
      if (!table) return;
      for (const row of table.getRows()) {
        const data = row.getData() as unknown as ProfileRow;
        const fresh = base.get(data.rowKey);
        if (fresh)
          void row.update(overlay(fresh) as unknown as Record<string, unknown>);
      }
    }

    function refreshStatus(): void {
      counts.textContent = `${total} ${total === 1 ? "row" : "rows"} match. Page ${query.page}. A Profile with no role has one row.`;
      refreshSelectionState();
      const dirty = staged.size;
      stagedStatus.textContent = dirty
        ? `${dirty} unsaved ${dirty === 1 ? "change" : "changes"}.`
        : "No unsaved changes.";
      saveButton.disabled = dirty === 0 || reviewing;
      discardButton.disabled = dirty === 0;
    }

    function refreshSelectionState(): void {
      const profiles = new Set([...selected.values()].map((e) => e.profileId));
      selectionStatus.textContent = selected.size
        ? `${selected.size} role ${selected.size === 1 ? "row" : "rows"} selected across ${profiles.size} ${profiles.size === 1 ? "Profile" : "Profiles"}. The selection stays when you change page or filters, so it can include rows outside the current filter.`
        : "No rows selected.";
      const none = selected.size === 0;
      setButton.disabled = none;
      hideButton.disabled = none;
      deleteButton.disabled = none || deleting;
      restoreButton.disabled = none;
      clearSelection.disabled = none;
      for (const input of Array.from(
        gridHost.querySelectorAll<HTMLInputElement>("input[data-select-role]"),
      )) {
        input.checked = selected.has(input.dataset.selectRole ?? "");
      }
    }

    // --------------------------------------------------------- staging
    function stage(entry: Staged, explicitKey?: string): void {
      reviewKey = null;
      const key = explicitKey ?? stagedKey(entry.change);
      const baseline =
        entry.change.kind === "visibility" ? entry.before : entry.before;
      if (entry.after === baseline) staged.delete(key);
      else staged.set(key, entry);
    }

    function stageField(
      row: ProfileRow,
      fieldId: string,
      value: string | null,
    ): void {
      const clean = value === null || value.trim() === "" ? null : value.trim();
      const column = COLUMN_FOR_FIELD[fieldId];
      if (!column) return;
      const profileLevel = fieldId in PERSON_NAME_COLUMNS;
      // A roleless Profile row has no role fields to edit.
      if (!profileLevel && row.roleId === null) return;
      const required = fieldId === "displayName";
      const before = (row[ROW_KEY[fieldId] as RowKey] ?? null) as string | null;
      const change: ProfileChange = {
        kind: "field",
        entity: profileLevel ? "people" : "person_roles",
        targetId: profileLevel ? row.profileId : (row.roleId as string),
        field: column,
        expectedVersion: profileLevel ? row.profileVersion : row.roleVersion,
        value: required ? (value ?? "").trim() : clean,
      };
      const label =
        PROFILE_FIELDS.find((definition) => definition.id === fieldId)?.label ??
        fieldId;
      stage({
        change,
        label,
        who: row.displayName,
        profileId: row.profileId,
        before,
        after: required ? (value ?? "").trim() : clean,
        error: localError(fieldId, required ? value : clean),
      });
    }

    function stageVisibilityFor(row: ProfileRow, visible: boolean): void {
      stage({
        change: {
          kind: "visibility",
          personId: row.profileId,
          expectedVersion: row.visibilityVersion,
          visible,
        },
        label: "Visible on Website",
        who: row.displayName,
        profileId: row.profileId,
        before: row.visible,
        after: visible,
        error: null,
      });
    }

    function onCellEdited(cell: TabulatorCell): void {
      const data = cell.getRow().getData() as unknown as ProfileRow;
      const fieldId = cell.getField();
      const original = rowFor(data.rowKey);
      if (!original) return;
      const raw = cell.getValue();
      const value = raw === null || raw === undefined ? null : String(raw);
      stageField(original, fieldId, value);
      if (fieldId in PERSON_NAME_COLUMNS) {
        // One Profile, one name: every role row of that person shows it.
        const shown =
          fieldId === "displayName" ? (value ?? "").trim() : emptyToNull(value);
        for (const sibling of rowsOnPage(original.profileId))
          void table
            ?.getRows()
            .find(
              (row) =>
                (row.getData() as unknown as ProfileRow).rowKey ===
                sibling.rowKey,
            )
            ?.update({ [fieldId]: shown });
      }
      markErrors();
      refreshStatus();
    }

    function markErrors(): void {
      for (const element of Array.from(
        gridHost.querySelectorAll(".cw-cell-error"),
      )) {
        element.classList.remove("cw-cell-error");
        element.removeAttribute("aria-invalid");
      }
      for (const entry of staged.values()) {
        if (!entry.error) continue;
        for (const row of table?.getRows() ?? []) {
          const data = row.getData() as unknown as ProfileRow;
          const hit =
            entry.change.kind === "field"
              ? entry.change.entity === "people"
                ? data.profileId === entry.change.targetId
                : data.roleId === entry.change.targetId
              : false;
          if (!hit) continue;
          const fieldId = Object.entries(COLUMN_FOR_FIELD).find(
            ([, column]) =>
              entry.change.kind === "field" && column === entry.change.field,
          )?.[0];
          const cell = fieldId
            ? row.getElement().querySelector(`[tabulator-field="${fieldId}"]`)
            : null;
          cell?.classList.add("cw-cell-error");
          cell?.setAttribute("aria-invalid", "true");
        }
      }
    }

    function stageVisibility(visible: boolean): void {
      const profiles = new Map<string, ProfileSelectionEntry>();
      for (const entry of selected.values())
        if (!profiles.has(entry.profileId))
          profiles.set(entry.profileId, entry);
      let already = 0;
      let incomplete = 0;
      const pending: Staged[] = [];
      for (const entry of profiles.values()) {
        const current =
          (
            staged.get(`v:${entry.profileId}`)?.change as
              | { visible: boolean }
              | undefined
          )?.visible ?? entry.visible;
        if (current === visible) {
          already += 1;
          continue;
        }
        // The server refuses to publish an incomplete Profile. Staging it
        // would only fail the whole save, so it is left out and counted.
        if (visible && !entry.publicationReady) {
          incomplete += 1;
          continue;
        }
        pending.push({
          change: {
            kind: "visibility",
            personId: entry.profileId,
            expectedVersion: entry.visibilityVersion,
            visible,
          },
          label: "Visible on Website",
          who: entry.displayName,
          profileId: entry.profileId,
          before: entry.visible,
          after: visible,
          error: null,
        });
      }
      if (projectedStagedSize(pending) > PROFILES_MAX_CHANGES) {
        announceChangeLimit();
        return;
      }
      for (const entry of pending) stage(entry);
      refreshTableRows();
      refreshStatus();
      announce(
        `${visible ? "Visible" : "Hidden"}: ${pending.length} ${pending.length === 1 ? "Profile" : "Profiles"} will change; ${already} already have the requested value (${visible ? "Visible" : "Hidden"}).${incomplete ? ` ${incomplete} ${incomplete === 1 ? "Profile cannot" : "Profiles cannot"} be made Visible because ${incomplete === 1 ? "it is" : "they are"} missing required information.` : ""} Choose Save changes to review and apply.`,
      );
    }

    function projectedStagedSize(entries: readonly Staged[]): number {
      const projected = new Map(staged);
      for (const entry of entries) {
        const key = stagedKey(entry.change);
        const existing = projected.get(key);
        const baseline = existing ? existing.before : entry.before;
        if (entry.after === baseline) projected.delete(key);
        else projected.set(key, entry);
      }
      return projected.size;
    }

    function announceChangeLimit(): void {
      announce(
        `Nothing was staged because this would exceed the ${PROFILES_MAX_CHANGES}-change save limit. Reduce the selection with Clear selection, narrow your filters, or clear some staged edits, then try again. Changes are not split automatically.`,
      );
    }

    // ------------------------------------------------------ bulk set
    function openSetPanel(): void {
      clear(setPanel);
      setPanel.hidden = false;
      const fieldSelect = el(doc, "select", { id: "profiles-set-field" });
      for (const spec of ROLE_BULK_FIELDS)
        fieldSelect.appendChild(
          el(doc, "option", { value: spec.id }, spec.label),
        );
      const value = el(doc, "input", {
        id: "profiles-set-value",
        type: "text",
        placeholder: "YYYY-MM-DD",
        autocomplete: "off",
      });
      const blank = el(doc, "input", {
        id: "profiles-set-blank",
        type: "checkbox",
      });
      const visibilityValue = el(
        doc,
        "select",
        { id: "profiles-set-visibility-value", hidden: true },
        el(doc, "option", { value: "true" }, "Visible"),
        el(doc, "option", { value: "false" }, "Hidden"),
      );
      const valueField = field("Value", value, "profiles-set-value");
      const blankField = el(
        doc,
        "div",
        { class: "cw-profiles-field", id: "profiles-set-blank-field" },
        blank,
        el(
          doc,
          "label",
          { for: "profiles-set-blank" },
          "Leave blank (unknown)",
        ),
      );
      const error = el(doc, "p", { class: "cw-profiles-error", role: "alert" });
      const syncBulkField = () => {
        const isVisibility = fieldSelect.value === "visible";
        valueField.hidden = isVisibility;
        blankField.hidden = isVisibility;
        visibilityValue.hidden = !isVisibility;
      };
      fieldSelect.addEventListener("change", syncBulkField);
      syncBulkField();
      setPanel.append(
        el(doc, "h2", { id: "profiles-set-h" }, "Set selected values"),
        el(
          doc,
          "p",
          {},
          `Applies to the ${selected.size} selected ${selected.size === 1 ? "row" : "rows"}. Profile visibility is applied once per Profile, including roleless Profiles. Nothing is written until you choose Save changes.`,
        ),
        field("Field", fieldSelect, "profiles-set-field"),
        valueField,
        field("Value", visibilityValue, visibilityValue.id),
        blankField,
        error,
        button("Stage values", () => {
          if (fieldSelect.value === "visible") {
            stageVisibility(visibilityValue.value === "true");
            setPanel.hidden = true;
            setButton.focus();
            return;
          }
          const spec = ROLE_BULK_FIELDS.find(
            (item) => item.id === fieldSelect.value,
          );
          if (!spec) return;
          const text = blank.checked ? null : value.value.trim();
          if (!blank.checked && text === "") {
            error.textContent = "Enter a value or choose Leave blank.";
            return;
          }
          const problem = localError(spec.id, text);
          if (problem) {
            error.textContent = problem;
            return;
          }
          const pending: Staged[] = [];
          for (const entry of selected.values()) {
            if (entry.roleId === null) continue;
            const key = `person_roles:${entry.roleId}:${spec.column}`;
            const before =
              (staged.get(key)?.before as string | null | undefined) ??
              (entry as unknown as Record<string, string | null>)[spec.id] ??
              null;
            pending.push({
              change: {
                kind: "field",
                entity: "person_roles",
                targetId: entry.roleId,
                field: spec.column,
                expectedVersion: entry.roleVersion,
                value: text,
              },
              label: spec.label,
              who: entry.displayName,
              profileId: entry.profileId,
              before,
              after: text,
              error: null,
            });
          }
          if (projectedStagedSize(pending) > PROFILES_MAX_CHANGES) {
            error.textContent = `Nothing was staged because this would exceed the ${PROFILES_MAX_CHANGES}-change save limit. Reduce the selection with Clear selection, narrow your filters, or clear some staged edits, then try again. Changes are not split automatically.`;
            return;
          }
          for (const entry of pending) stage(entry);
          setPanel.hidden = true;
          refreshTableRows();
          refreshStatus();
          announce(
            `${spec.label} staged for ${pending.length} role ${pending.length === 1 ? "row" : "rows"}. Choose Save changes to review and apply.`,
          );
          setButton.focus();
        }),
        button("Cancel", () => {
          setPanel.hidden = true;
          setButton.focus();
        }),
      );
      fieldSelect.focus();
    }

    // ------------------------------------------------------ selection
    function selectCurrentPage(): void {
      for (const row of base.values())
        selected.set(row.rowKey, toSelection(row));
      refreshSelectionState();
      announce(`Selected ${base.size} role rows on this page.`);
    }

    async function selectAllMatching(): Promise<void> {
      try {
        const result = await client.selectAll(query);
        for (const entry of result.entries) selected.set(entry.rowKey, entry);
        refreshSelectionState();
        announce(
          result.truncated
            ? `Selected the first ${PROFILES_MAX_SELECT_ALL} matching role rows. Narrow the filters to select the rest.`
            : `Selected all ${result.entries.length} matching role rows.`,
        );
      } catch (error) {
        announce(describeError(error));
      }
    }

    function closeUnitLinks(): void {
      unitLinkPanel.hidden = true;
      clear(unitLinkPanel);
    }

    async function openUnitSuggestions(row: ProfileRow): Promise<void> {
      if (unitLinkSaving || !row.roleId) return;
      if (staged.size || reviewing || deleting) {
        announce("Finish or discard the current edits before linking roles.");
        return;
      }
      const roleId = row.roleId;
      closeUnitLinks();
      unitLinkPanel.hidden = false;
      const heading = el(
        doc,
        "h2",
        { id: "profiles-unit-links-h", tabindex: -1 },
        "Suggested units",
      );
      const status = el(
        doc,
        "p",
        { role: "status" },
        "Finding units in this role’s county.",
      );
      const close = button("Close", closeUnitLinks);
      unitLinkPanel.append(
        heading,
        el(
          doc,
          "p",
          {},
          [row.displayName, row.officeDepartment, row.county]
            .filter(Boolean)
            .join(" · "),
        ),
        status,
        close,
      );
      heading.focus();
      try {
        const { units } = await client.suggestUnits(roleId);
        if (destroyed || !unitLinkPanel.contains(status)) return;
        status.textContent = units.length
          ? "Suggestions share the start of the office name. Review the unit and its parent before linking."
          : "No unit names in this county start with the same letters.";
        if (!units.length) return;
        const choices = el(
          doc,
          "select",
          { id: "profiles-suggested-unit" },
          el(doc, "option", { value: "" }, "Choose a unit"),
          ...units.map(({ unitId, path }) =>
            el(doc, "option", { value: unitId }, `${path} (${unitId})`),
          ),
        );
        let key = newKey();
        const confirm = button(
          "Link selected unit",
          async () => {
            const unit = units.find(
              (choice) => choice.unitId === choices.value,
            );
            if (!unit || unitLinkSaving) return;
            if (staged.size || reviewing || deleting) {
              announce(
                "Finish or discard the current edits before linking roles.",
              );
              return;
            }
            unitLinkSaving = true;
            confirm.disabled = choices.disabled = close.disabled = true;
            try {
              await client.linkSuggestedUnit(roleId, unit, key);
              if (destroyed) return;
              closeUnitLinks();
              announce(`Linked this role to ${unit.path}.`);
              await reload().catch(() =>
                announce("Link saved. Reload the page to refresh the grid."),
              );
            } catch (error) {
              if (destroyed || !unitLinkPanel.contains(status)) return;
              if (
                error instanceof ProfilesApiError &&
                error.code === "stale_preview"
              ) {
                status.textContent =
                  "The role or its suggestions changed. Open Suggest units again to review the current options.";
                confirm.remove();
              } else {
                status.textContent = describeError(error);
                confirm.disabled = choices.disabled = false;
              }
            } finally {
              unitLinkSaving = false;
              close.disabled = false;
            }
          },
          { id: "profiles-link-suggested-unit" },
        );
        confirm.disabled = true;
        choices.addEventListener("change", () => {
          key = newKey();
          confirm.disabled = !choices.value;
        });
        unitLinkPanel.insertBefore(field("Unit", choices, choices.id), close);
        unitLinkPanel.insertBefore(confirm, close);
      } catch (error) {
        if (!destroyed && unitLinkPanel.contains(status))
          status.textContent = describeError(error);
      }
    }

    async function openUnitLinks(): Promise<void> {
      if (unitLinkSaving) return;
      if (staged.size || reviewing || deleting) {
        announce("Finish or discard the current edits before linking roles.");
        return;
      }
      const scope: ProfileQuery = {
        ...query,
        query: searchInput.value.trim(),
        countyFips: countySelect.value || null,
        office: officeSelect.value || null,
        visibility: visibilitySelect.value as ProfileQuery["visibility"],
        unitLink: unitLinkSelect.value as ProfileQuery["unitLink"],
      };
      closeUnitLinks();
      unitLinkPanel.hidden = false;
      const heading = el(
        doc,
        "h2",
        { id: "profiles-unit-links-h", tabindex: -1 },
        "Link exact matches",
      );
      const status = el(
        doc,
        "p",
        { role: "status" },
        "Checking role rows across all pages of the current filters.",
      );
      const cancel = button("Close", () => {
        closeUnitLinks();
        linkExactMatches.focus();
      });
      unitLinkPanel.append(heading, status, cancel);
      heading.focus();
      try {
        const reviewed = await client.previewUnitLinks(scope);
        if (destroyed || !unitLinkPanel.contains(status)) return;
        status.textContent = (
          [
            [reviewed.ready, "ready to link"],
            [reviewed.linked, "already linked"],
            [reviewed.unmatched, "with no exact match"],
            [reviewed.multiple, "with multiple matches"],
            [reviewed.review, "with an existing link to review"],
          ] as const
        )
          .map(([count, label]) => `${count.toLocaleString()} ${label}`)
          .join(" · ");
        if (!reviewed.ready) return;
        const key = newKey();
        const confirm = button(
          `Link ${reviewed.ready.toLocaleString()} ${reviewed.ready === 1 ? "role" : "roles"}`,
          async () => {
            if (unitLinkSaving) return;
            if (staged.size || reviewing || deleting) {
              announce(
                "Finish or discard the current edits before linking roles.",
              );
              return;
            }
            unitLinkSaving = true;
            confirm.disabled =
              cancel.disabled =
              linkExactMatches.disabled =
                true;
            try {
              const receipt = await client.commitUnitLinks(
                scope,
                reviewed.digest,
                key,
              );
              if (destroyed) return;
              closeUnitLinks();
              announce(
                `Linked ${receipt.attached.toLocaleString()} ${receipt.attached === 1 ? "role" : "roles"} to County Structure.`,
              );
              await reload().catch(() =>
                announce("Links saved. Reload the page to refresh the grid."),
              );
              linkExactMatches.focus();
            } catch (error) {
              if (destroyed) return;
              if (
                error instanceof ProfilesApiError &&
                error.code === "stale_preview"
              ) {
                confirm.remove();
                status.textContent =
                  "Roles, units, or placements changed. Choose Link exact matches to preview again.";
              } else {
                status.textContent = describeError(error);
                confirm.disabled = false;
              }
            } finally {
              unitLinkSaving = false;
              cancel.disabled = linkExactMatches.disabled = false;
            }
          },
          { id: "profiles-confirm-exact-links" },
        );
        unitLinkPanel.insertBefore(confirm, cancel);
      } catch (error) {
        if (!destroyed && unitLinkPanel.contains(status))
          status.textContent = describeError(error);
      }
    }

    function closeMatchingVisibility(): void {
      matchingVisibilityRequest++;
      matchingVisibilityPanel.hidden = true;
      clear(matchingVisibilityPanel);
    }

    function openMatchingVisibility(): void {
      if (matchingVisibilitySaving) return;
      if (staged.size || reviewing || deleting) {
        announce(
          "Finish or discard the current edits before changing visibility for all matching Profiles.",
        );
        return;
      }
      // Read the controls directly so a pending search debounce cannot
      // accidentally select the preceding search results.
      const scope: ProfileQuery = {
        ...query,
        query: searchInput.value.trim(),
        countyFips: countySelect.value || null,
        office: officeSelect.value || null,
        visibility: (visibilitySelect.value ||
          "all") as ProfileQuery["visibility"],
        unitLink: unitLinkSelect.value as ProfileQuery["unitLink"],
      };
      closeMatchingVisibility();
      matchingVisibilityPanel.hidden = false;
      const heading = el(
        doc,
        "h2",
        { id: "profiles-matching-visibility-h", tabindex: -1 },
        "All matching Profiles",
      );
      const status = el(doc, "p", { role: "status" });
      const confirmation = el(doc, "div", {});
      const cancel = button("Cancel", () => {
        closeMatchingVisibility();
        selectMatchingProfiles.focus();
      });
      const show = button("Preview making visible", () => void preview(true));
      const hide = button("Preview hiding", () => void preview(false));
      matchingVisibilityPanel.append(
        heading,
        el(
          doc,
          "p",
          {},
          "Applies to all Profiles matched by the current filters, across every page.",
        ),
        show,
        hide,
        cancel,
        status,
        confirmation,
      );
      heading.focus();

      async function preview(visible: boolean): Promise<void> {
        const requestId = ++matchingVisibilityRequest;
        clear(confirmation);
        status.textContent = "Counting matching Profiles.";
        try {
          const reviewed = await client.previewMatchingVisibility(
            scope,
            visible,
          );
          if (destroyed || requestId !== matchingVisibilityRequest) return;
          status.textContent = `${reviewed.matched.toLocaleString()} Profiles match. ${reviewed.willChange.toLocaleString()} will become ${visible ? "visible" : "hidden"}. ${reviewed.alreadySet.toLocaleString()} already have that visibility.${reviewed.incomplete ? ` ${reviewed.incomplete.toLocaleString()} incomplete Profiles will stay hidden.` : ""}`;
          if (reviewed.willChange === 0) return;
          const key = newKey();
          const confirm = button(
            visible
              ? `Make ${reviewed.willChange.toLocaleString()} Profiles visible`
              : `Hide ${reviewed.willChange.toLocaleString()} Profiles`,
            () => void commit(),
            { id: "profiles-confirm-matching-visibility" },
          );
          confirmation.appendChild(confirm);

          async function commit(): Promise<void> {
            if (
              matchingVisibilitySaving ||
              requestId !== matchingVisibilityRequest
            )
              return;
            if (staged.size || reviewing || deleting) {
              announce(
                "Finish or discard the current edits before changing all matching Profiles.",
              );
              return;
            }
            matchingVisibilitySaving = true;
            confirm.disabled = true;
            show.disabled = true;
            hide.disabled = true;
            cancel.disabled = true;
            status.textContent = "Saving visibility changes.";
            try {
              const result = await client.saveMatchingVisibility(
                scope,
                visible,
                reviewed.digest,
                key,
              );
              if (destroyed) return;
              closeMatchingVisibility();
              selected.clear();
              refreshSelectionState();
              announce(
                `${result.applied.toLocaleString()} Profiles ${visible ? "made visible" : "hidden"}.`,
              );
              await reload().catch(() =>
                announce(
                  "Visibility saved. Reload the page to refresh the grid.",
                ),
              );
              selectMatchingProfiles.focus();
            } catch (error) {
              if (destroyed || requestId !== matchingVisibilityRequest) return;
              if (
                error instanceof ProfilesApiError &&
                error.code === "stale_version"
              ) {
                clear(confirmation);
                status.textContent =
                  "The Website changed since this preview. Preview the matching Profiles again.";
              } else {
                status.textContent = describeError(error);
                confirm.disabled = false;
              }
            } finally {
              matchingVisibilitySaving = false;
              show.disabled = false;
              hide.disabled = false;
              cancel.disabled = false;
            }
          }
        } catch (error) {
          if (!destroyed && requestId === matchingVisibilityRequest)
            status.textContent = describeError(error);
        }
      }
    }

    // ------------------------------------------- alternate-name editor
    let addCounter = 0;
    const STATUS_LABEL: Readonly<Record<string, string>> = {
      requires_review: "Requires review",
      confirmed: "Confirmed",
    };

    function typeLabel(type: string): string {
      return (
        ALTERNATE_NAME_TYPE_INFO[type as keyof typeof ALTERNATE_NAME_TYPE_INFO]
          ?.label ?? type
      );
    }

    function fieldsText(f: AlternateNameFields): string {
      const parts = [
        `${typeLabel(f.nameType)}: ${f.publishedName}`,
        [f.namePrefix, f.firstName, f.middleName, f.lastName, f.nameSuffix]
          .filter((part) => part)
          .join(" "),
        f.appliesFrom || f.appliesUntil
          ? `${f.appliesFrom ?? "?"} to ${f.appliesUntil ?? "?"}`
          : "",
        STATUS_LABEL[f.verificationStatus] ?? f.verificationStatus,
        f.publicDisplay ? "public" : "private",
      ];
      return parts.filter((part) => part).join(" | ");
    }

    function recordFields(record: AlternateNameRecord): AlternateNameFields {
      return {
        nameType: record.nameType,
        firstName: record.firstName,
        middleName: record.middleName,
        lastName: record.lastName,
        namePrefix: record.namePrefix,
        nameSuffix: record.nameSuffix,
        publishedName: record.publishedName,
        appliesFrom: record.appliesFrom,
        appliesUntil: record.appliesUntil,
        verificationStatus: record.verificationStatus,
        publicDisplay: record.publicDisplay,
      };
    }

    function nameProblem(f: AlternateNameFields): string | null {
      if (!f.publishedName) return "Enter the name as it was published.";
      if (f.publishedName.length > PROFILES_MAX_NAME_LENGTH)
        return `Name as published is limited to ${PROFILES_MAX_NAME_LENGTH} characters.`;
      for (const [label, value, limit] of [
        ["First Name", f.firstName, PROFILES_MAX_NAME_COMPONENT_LENGTH],
        ["Middle Name", f.middleName, PROFILES_MAX_NAME_COMPONENT_LENGTH],
        ["Last Name", f.lastName, PROFILES_MAX_NAME_COMPONENT_LENGTH],
        ["Name Prefix", f.namePrefix, PROFILES_MAX_NAME_AFFIX_LENGTH],
        ["Name Suffix", f.nameSuffix, PROFILES_MAX_NAME_AFFIX_LENGTH],
      ] as const)
        if (value !== null && value.length > limit)
          return `${label} is limited to ${limit} characters.`;
      for (const [label, value] of [
        ["Applies From", f.appliesFrom],
        ["Applies Until", f.appliesUntil],
      ] as const)
        if (
          value !== null &&
          (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
        )
          return `${label} must be a date like 2026-03-14, or blank.`;
      if (f.appliesFrom && f.appliesUntil && f.appliesUntil < f.appliesFrom)
        return "Applies Until cannot be before Applies From.";
      if (f.publicDisplay && f.verificationStatus !== "confirmed")
        return "Only a confirmed name can be shown publicly. Mark it Confirmed first.";
      return null;
    }

    function closeNames(profileId: string): void {
      namesPanel.hidden = true;
      clear(namesPanel);
      container
        .querySelector<HTMLElement>(`[data-names-for="${profileId}"]`)
        ?.focus();
    }

    async function openNamesEditor(row: ProfileRow): Promise<void> {
      clear(namesPanel);
      namesPanel.hidden = false;
      const heading = el(
        doc,
        "h2",
        { id: "profiles-names-h", tabindex: -1 },
        `Alternate names for ${row.displayName}`,
      );
      namesPanel.append(
        heading,
        el(doc, "p", { role: "status" }, "Loading alternate names."),
      );
      heading.focus();
      let list: AlternateNameList;
      try {
        list = await client.alternateNames(row.profileId);
      } catch (error) {
        if (destroyed) return;
        clear(namesPanel);
        namesPanel.append(
          heading,
          el(doc, "p", { role: "alert" }, describeError(error)),
          button("Close", () => closeNames(row.profileId)),
        );
        return;
      }
      if (destroyed) return;
      renderNames(row, list, null);
    }

    function stagedAdds(profileId: string): [string, Staged][] {
      return [...staged.entries()].filter(([key]) =>
        key.startsWith(`a:new:${profileId}:`),
      );
    }

    function renderNames(
      row: ProfileRow,
      list: AlternateNameList,
      editing: {
        key: string | null;
        record: AlternateNameRecord | null;
        fields: AlternateNameFields;
      } | null,
    ): void {
      clear(namesPanel);
      const heading = el(
        doc,
        "h2",
        { id: "profiles-names-h", tabindex: -1 },
        `Alternate names for ${row.displayName}`,
      );
      namesPanel.append(
        heading,
        el(
          doc,
          "p",
          {},
          "A name is private and needs review until you mark it Confirmed and approve public display. Private research evidence stays in the private Profiles workflow and is never stored here. Changes here are staged with the rest of the sheet and saved together with Save changes, so a failed save never leaves the primary and alternate names half updated.",
        ),
      );
      if (list.truncated)
        namesPanel.append(
          el(
            doc,
            "p",
            { role: "note" },
            "This Profile has more names than one view carries. The first names are shown.",
          ),
        );
      const tableEl = el(
        doc,
        "table",
        { class: "cw-profiles-diff cw-profiles-names-table" },
        el(
          doc,
          "caption",
          {},
          `${list.names.length} saved ${list.names.length === 1 ? "name" : "names"}`,
        ),
        el(
          doc,
          "thead",
          {},
          el(
            doc,
            "tr",
            {},
            ...[
              "Type",
              "Name as published",
              "Dates",
              "Status",
              "Public",
              "Actions",
            ].map((title) => el(doc, "th", { scope: "col" }, title)),
          ),
        ),
      );
      const body = el(doc, "tbody");
      const addRow = (
        fields: AlternateNameFields,
        note: string,
        actions: HTMLElement[],
        removed: boolean,
      ) => {
        body.appendChild(
          el(
            doc,
            "tr",
            removed ? { class: "cw-row-hidden" } : {},
            el(doc, "td", {}, typeLabel(fields.nameType)),
            el(doc, "th", { scope: "row" }, fields.publishedName),
            el(
              doc,
              "td",
              {},
              fields.appliesFrom || fields.appliesUntil
                ? `${fields.appliesFrom ?? "?"} to ${fields.appliesUntil ?? "?"}`
                : "",
            ),
            el(doc, "td", {}, STATUS_LABEL[fields.verificationStatus] ?? ""),
            el(doc, "td", {}, fields.publicDisplay ? "Public" : "Private"),
            el(
              doc,
              "td",
              {},
              note ? el(doc, "em", {}, `${note} `) : null,
              ...actions,
            ),
          ),
        );
      };
      const refreshAll = () => {
        refreshTableRows();
        refreshStatus();
        renderNames(row, list, null);
      };
      for (const record of list.names) {
        const key = `a:${record.id}`;
        const entry = staged.get(key);
        const change = entry?.change;
        const label = record.publishedName;
        if (change?.kind === "alternate_name" && change.op === "remove") {
          addRow(
            recordFields(record),
            "Removal staged.",
            [
              button("Undo", () => {
                staged.delete(key);
                refreshAll();
                announce(`Removal of ${label} undone.`);
              }),
            ],
            true,
          );
          continue;
        }
        if (change?.kind === "alternate_name" && change.op === "restore") {
          addRow(
            { ...recordFields(record), publicDisplay: false },
            "Restore staged.",
            [
              button("Undo", () => {
                staged.delete(key);
                refreshAll();
                announce(`Restore of ${label} undone.`);
              }),
            ],
            false,
          );
          continue;
        }
        if (record.removed) {
          addRow(
            recordFields(record),
            "Removed.",
            [
              button("Restore", () => {
                stage(
                  {
                    change: {
                      kind: "alternate_name",
                      op: "restore",
                      personId: row.profileId,
                      nameId: record.id,
                      expectedVersion: record.version,
                    },
                    label: "Alternate name (restore)",
                    who: row.displayName,
                    before: fieldsText(recordFields(record)),
                    after: `${fieldsText({ ...recordFields(record), publicDisplay: false })} (restored, private)`,
                    error: null,
                    profileId: row.profileId,
                    countDelta: 1,
                  },
                  key,
                );
                refreshAll();
                announce(
                  `Restore of ${label} staged. Choose Save changes to apply.`,
                );
              }),
            ],
            true,
          );
          continue;
        }
        const updated =
          change?.kind === "alternate_name" && change.op === "update"
            ? change.fields
            : null;
        const shown = updated ?? recordFields(record);
        addRow(
          shown,
          updated ? "Edit staged." : "",
          [
            button("Edit", () =>
              renderNames(row, list, { key, record, fields: shown }),
            ),
            button("Remove", () => {
              stage(
                {
                  change: {
                    kind: "alternate_name",
                    op: "remove",
                    personId: row.profileId,
                    nameId: record.id,
                    expectedVersion: record.version,
                  },
                  label: "Alternate name (remove)",
                  who: row.displayName,
                  before: fieldsText(recordFields(record)),
                  after: null,
                  error: null,
                  profileId: row.profileId,
                  countDelta: -1,
                },
                key,
              );
              refreshAll();
              announce(
                `Removal of ${label} staged. Choose Save changes to apply.`,
              );
            }),
            ...(updated
              ? [
                  button("Undo edit", () => {
                    staged.delete(key);
                    refreshAll();
                    announce(`Edit of ${label} undone.`);
                  }),
                ]
              : []),
          ],
          false,
        );
      }
      for (const [key, entry] of stagedAdds(row.profileId)) {
        if (entry.change.kind !== "alternate_name" || entry.change.op !== "add")
          continue;
        const fields = entry.change.fields;
        addRow(
          fields,
          "New, unsaved.",
          [
            button("Edit", () =>
              renderNames(row, list, { key, record: null, fields }),
            ),
            button("Discard", () => {
              staged.delete(key);
              refreshAll();
              announce("New alternate name discarded.");
            }),
          ],
          false,
        );
      }
      tableEl.appendChild(body);
      namesPanel.appendChild(tableEl);
      if (!editing) {
        namesPanel.append(
          button(
            "Add alternate name",
            () =>
              renderNames(row, list, {
                key: null,
                record: null,
                fields: {
                  nameType: "other",
                  firstName: null,
                  middleName: null,
                  lastName: null,
                  namePrefix: null,
                  nameSuffix: null,
                  publishedName: "",
                  appliesFrom: null,
                  appliesUntil: null,
                  verificationStatus: "requires_review",
                  publicDisplay: false,
                },
              }),
            { id: "profiles-names-add" },
          ),
          button("Close", () => closeNames(row.profileId), {
            id: "profiles-names-close",
          }),
        );
        heading.focus();
        return;
      }
      namesPanel.appendChild(renderNameForm(row, list, editing));
    }

    function renderNameForm(
      row: ProfileRow,
      list: AlternateNameList,
      editing: {
        key: string | null;
        record: AlternateNameRecord | null;
        fields: AlternateNameFields;
      },
    ): HTMLElement {
      const f = editing.fields;
      const text = (id: string, value: string | null, max: number) =>
        el(doc, "input", {
          id,
          type: "text",
          autocomplete: "off",
          maxlength: max,
          value: value ?? "",
        });
      const type = el(doc, "select", { id: "pn-type" });
      for (const value of ALTERNATE_NAME_TYPES)
        type.appendChild(el(doc, "option", { value }, typeLabel(value)));
      type.value = f.nameType;
      const help = el(doc, "small", { id: "pn-type-help" });
      const showHelp = () => {
        help.textContent =
          ALTERNATE_NAME_TYPE_INFO[
            type.value as keyof typeof ALTERNATE_NAME_TYPE_INFO
          ]?.meaning ?? "";
      };
      type.addEventListener("change", showHelp);
      showHelp();
      const published = text(
        "pn-published",
        f.publishedName,
        PROFILES_MAX_NAME_LENGTH,
      );
      const first = text(
        "pn-first",
        f.firstName,
        PROFILES_MAX_NAME_COMPONENT_LENGTH,
      );
      const middle = text(
        "pn-middle",
        f.middleName,
        PROFILES_MAX_NAME_COMPONENT_LENGTH,
      );
      const last = text(
        "pn-last",
        f.lastName,
        PROFILES_MAX_NAME_COMPONENT_LENGTH,
      );
      const prefix = text(
        "pn-prefix",
        f.namePrefix,
        PROFILES_MAX_NAME_AFFIX_LENGTH,
      );
      const suffix = text(
        "pn-suffix",
        f.nameSuffix,
        PROFILES_MAX_NAME_AFFIX_LENGTH,
      );
      const from = text("pn-from", f.appliesFrom, 10);
      from.setAttribute("placeholder", "YYYY-MM-DD");
      const until = text("pn-until", f.appliesUntil, 10);
      until.setAttribute("placeholder", "YYYY-MM-DD");
      const status = el(doc, "select", { id: "pn-status" });
      for (const value of ALTERNATE_NAME_STATUSES)
        status.appendChild(
          el(doc, "option", { value }, STATUS_LABEL[value] ?? value),
        );
      status.value = f.verificationStatus;
      const isPublic = el(doc, "input", { id: "pn-public", type: "checkbox" });
      isPublic.checked = f.publicDisplay;
      const publicHint = el(doc, "small", { id: "pn-public-hint" });
      const syncPublic = () => {
        const confirmed = status.value === "confirmed";
        isPublic.disabled = !confirmed;
        if (!confirmed) isPublic.checked = false;
        publicHint.textContent = confirmed
          ? " Approve to show this name on the public Profile page and in public search."
          : " Mark the name Confirmed before it can be shown publicly.";
      };
      status.addEventListener("change", syncPublic);
      syncPublic();
      const error = el(doc, "p", { class: "cw-profiles-error", role: "alert" });
      const optional = (input: HTMLInputElement): string | null =>
        emptyToNull(input.value);
      return el(
        doc,
        "form",
        { class: "cw-profiles-name-form", "aria-label": "Alternate name" },
        field("Name type", type, "pn-type"),
        help,
        field("Name as published", published, "pn-published"),
        field("First Name", first, "pn-first"),
        field("Middle Name", middle, "pn-middle"),
        field("Last Name", last, "pn-last"),
        field("Name Prefix", prefix, "pn-prefix"),
        field("Name Suffix", suffix, "pn-suffix"),
        field("Applies From", from, "pn-from"),
        field("Applies Until", until, "pn-until"),
        field("Verification status", status, "pn-status"),
        el(
          doc,
          "div",
          { class: "cw-profiles-field" },
          isPublic,
          el(doc, "label", { for: "pn-public" }, "Show publicly"),
          publicHint,
        ),
        error,
        button(
          "Stage name",
          () => {
            const fields: AlternateNameFields = {
              nameType: type.value as AlternateNameFields["nameType"],
              firstName: optional(first),
              middleName: optional(middle),
              lastName: optional(last),
              namePrefix: optional(prefix),
              nameSuffix: optional(suffix),
              publishedName: published.value.trim(),
              appliesFrom: optional(from),
              appliesUntil: optional(until),
              verificationStatus:
                status.value as AlternateNameFields["verificationStatus"],
              publicDisplay: isPublic.checked,
            };
            const problem = nameProblem(fields);
            if (problem) {
              error.textContent = problem;
              return;
            }
            if (editing.record) {
              const current = recordFields(editing.record);
              if (fieldsText(fields) === fieldsText(current)) {
                staged.delete(`a:${editing.record.id}`);
                refreshTableRows();
                refreshStatus();
                renderNames(row, list, null);
                announce("No change to stage for this name.");
                return;
              }
              stage(
                {
                  change: {
                    kind: "alternate_name",
                    op: "update",
                    personId: row.profileId,
                    nameId: editing.record.id,
                    expectedVersion: editing.record.version,
                    fields,
                  },
                  label: "Alternate name (edit)",
                  who: row.displayName,
                  before: fieldsText(current),
                  after: fieldsText(fields),
                  error: null,
                  profileId: row.profileId,
                  countDelta: 0,
                },
                `a:${editing.record.id}`,
              );
            } else {
              addCounter += 1;
              const key = editing.key ?? `a:new:${row.profileId}:${addCounter}`;
              stage(
                {
                  change: {
                    kind: "alternate_name",
                    op: "add",
                    personId: row.profileId,
                    fields,
                  },
                  label: "Alternate name (add)",
                  who: row.displayName,
                  before: null,
                  after: fieldsText(fields),
                  error: null,
                  profileId: row.profileId,
                  countDelta: editing.key ? 0 : 1,
                },
                key,
              );
              if (editing.key) {
                // Editing a staged add keeps its single +1 on the count.
                const kept = staged.get(key);
                if (kept) kept.countDelta = 1;
              }
            }
            refreshTableRows();
            refreshStatus();
            renderNames(row, list, null);
            announce(
              "Alternate name staged. Choose Save changes to review and apply.",
            );
          },
          { id: "pn-stage" },
        ),
        button("Cancel", () => renderNames(row, list, null)),
      );
    }

    async function reviewDelete(): Promise<void> {
      if (deleting) return;
      const ids = new Set(
        [...selected.values()].map((entry) => entry.profileId),
      );
      if (!ids.size) return;
      const hasPendingEdits = () =>
        [...staged.values()].some(
          (entry) => entry.profileId && ids.has(entry.profileId),
        );
      if (hasPendingEdits() || reviewing) {
        announce(
          "Save or discard pending edits for the selected Profiles before deleting.",
        );
        return;
      }

      const request = ++deleteRequest;
      const heading = el(
        doc,
        "h2",
        { id: "profiles-delete-h", tabindex: -1 },
        "Delete selected Website Profiles",
      );
      const status = el(doc, "p", { role: "status" });
      const close = () => {
        ++deleteRequest;
        deletePanel.hidden = true;
        clear(deletePanel);
        (deleteButton.disabled ? searchInput : deleteButton).focus();
      };
      const cancel = button("Cancel", close);
      const list = el(doc, "ul");
      clear(deletePanel);
      deletePanel.append(
        heading,
        el(
          doc,
          "p",
          {},
          "Review every selected Profile, including selections on other pages. Each deletion is permanent and is recorded separately.",
        ),
        list,
        status,
        cancel,
      );
      deletePanel.hidden = false;
      heading.focus();

      const previews: ProfileDeletePreview[] = [];
      let blocked = false;
      try {
        for (const id of ids) {
          status.textContent = `Checking Profile ${previews.length + 1} of ${ids.size}.`;
          const preview = await client.deletePreview(id);
          if (destroyed || request !== deleteRequest) return;
          previews.push(preview);
          const blockers = [
            preview.blockers.reports
              ? `${preview.blockers.reports} grievance references. Review them in Reports.`
              : "",
            preview.blockers.editorialLinks
              ? `${preview.blockers.editorialLinks} editorial links. Remove the live associations in Posts & Stories.`
              : "",
            preview.blockers.duplicateReviews
              ? `${preview.blockers.duplicateReviews} duplicate-review records. Resolve these references first.`
              : "",
          ].filter(Boolean);
          blocked ||= blockers.length > 0;
          list.appendChild(
            el(
              doc,
              "li",
              {},
              el(doc, "strong", {}, preview.displayName),
              el(
                doc,
                "p",
                {},
                `Website Profile ID ${preview.profileId}. ${preview.visible ? "Visible" : "Hidden"}. Counties ${preview.counties.join(", ") || "none"}.`,
              ),
              el(
                doc,
                "p",
                {},
                `${preview.counts.roles} roles, ${preview.counts.names} alternate names and ${preview.counts.countyLinks} County Structure links will be removed.`,
              ),
              ...blockers.map((item) =>
                el(doc, "p", { class: "cw-profiles-error" }, item),
              ),
            ),
          );
        }
      } catch (error) {
        if (!destroyed && request === deleteRequest)
          status.textContent = describeError(error);
        return;
      }

      if (blocked) {
        status.textContent =
          "Resolve the listed references or change the selection and preview again.";
        return;
      }
      status.textContent = "";
      deletePanel.insertBefore(
        el(
          doc,
          "p",
          {},
          "The offline master and source catalog stay intact. Re-add a corrected copy from a fresh import preview.",
        ),
        status,
      );
      const reason = el(
        doc,
        "select",
        { id: "profiles-delete-reason" },
        el(doc, "option", { value: "" }, "Choose a reason"),
        ...Object.entries(PROFILE_DELETE_REASONS).map(([value, label]) =>
          el(doc, "option", { value }, label),
        ),
      );
      const confirmation = el(doc, "input", {
        id: "profiles-delete-confirmation",
        type: "text",
        autocomplete: "off",
        maxlength: 6,
      });
      const keys = previews.map(() => newKey());
      let completed = 0;
      const confirm = button(
        ids.size === 1
          ? "Delete Website Profile"
          : `Delete ${ids.size} Website Profiles`,
        () => void commit(),
      );
      const syncConfirmation = () => {
        confirm.disabled = confirmation.value !== "DELETE" || !reason.value;
      };
      syncConfirmation();
      confirmation.addEventListener("input", syncConfirmation);
      reason.addEventListener("change", syncConfirmation);
      deletePanel.insertBefore(field("Reason", reason, reason.id), status);
      deletePanel.insertBefore(
        field("Type DELETE to confirm", confirmation, confirmation.id),
        status,
      );
      deletePanel.insertBefore(confirm, cancel);

      async function commit(): Promise<void> {
        if (deleting || confirm.disabled || request !== deleteRequest) return;
        const current = new Set(
          [...selected.values()].map((entry) => entry.profileId),
        );
        if (
          current.size !== previews.length - completed ||
          previews.slice(completed).some((item) => !current.has(item.profileId))
        ) {
          status.textContent =
            "Selection changed. Cancel and open a new deletion preview.";
          return;
        }
        if (hasPendingEdits() || reviewing) {
          status.textContent = "Save or discard pending edits before deleting.";
          return;
        }
        deleting = true;
        gridHost.inert = true;
        const actions = deleteButton.parentElement;
        if (actions) actions.inert = true;
        confirm.disabled =
          cancel.disabled =
          reason.disabled =
          confirmation.disabled =
            true;
        namesPanel.hidden = true;
        clear(namesPanel);
        const previouslyCompleted = completed;
        let retry = false;
        try {
          while (!destroyed && completed < previews.length) {
            const preview = previews[completed];
            if (!preview) break;
            status.textContent = `Deleting ${preview.displayName} (${completed + 1} of ${previews.length}).`;
            await client.deleteProfile(
              {
                profileId: preview.profileId,
                digest: preview.digest,
                reason: reason.value as ProfileDeleteReason,
                confirmation: confirmation.value,
              },
              keys[completed] ?? "",
            );
            completed++;
            for (const [rowKey, selection] of selected)
              if (selection.profileId === preview.profileId)
                selected.delete(rowKey);
          }
        } catch (error) {
          const failed = previews[completed]?.displayName ?? "The next Profile";
          const partial = `${completed} of ${previews.length} Profiles deleted. ${failed}: `;
          if (
            error instanceof ProfilesApiError &&
            [404, 409].includes(error.status)
          ) {
            status.textContent = `${partial}the Profile or its references changed. Cancel and preview the remaining selection.`;
          } else {
            status.textContent = partial + describeError(error);
            // Retry the same request and key if the response was lost.
            confirm.textContent = "Retry remaining deletions";
            retry = true;
          }
        } finally {
          if (!destroyed && completed > previouslyCompleted) {
            try {
              await reload();
            } catch {
              announce("Reload the page to refresh the Profiles grid.");
            }
          }
          deleting = false;
          gridHost.inert = false;
          if (actions) actions.inert = false;
          cancel.disabled = false;
          confirm.disabled = !retry;
          refreshSelectionState();
        }

        if (
          !destroyed &&
          request === deleteRequest &&
          completed === previews.length
        ) {
          close();
          announce(
            `${completed} Website ${completed === 1 ? "Profile" : "Profiles"} deleted.`,
          );
        }
      }
    }

    // ----------------------------------------------------- save flow
    function askDiscard(): void {
      clear(discardConfirm);
      discardConfirm.hidden = false;
      discardConfirm.append(
        `Discard ${staged.size} unsaved ${staged.size === 1 ? "change" : "changes"}? `,
        button("Yes, discard", () => {
          staged.clear();
          reviewKey = null;
          discardConfirm.hidden = true;
          reviewPanel.hidden = true;
          refreshTableRows();
          markErrors();
          refreshStatus();
          announce("Unsaved changes discarded.");
          discardButton.focus();
        }),
        button("Keep editing", () => {
          discardConfirm.hidden = true;
          discardButton.focus();
        }),
      );
    }

    function changeList(): ProfileChange[] {
      return [...staged.values()].map((entry) => entry.change);
    }

    function showIssues(
      issues: readonly ProfileChangeIssue[],
      parent: HTMLElement,
    ): void {
      const entries = [...staged.values()];
      const list = el(doc, "ul", { class: "cw-profiles-issues" });
      for (const issue of issues) {
        const entry = entries[issue.index];
        list.appendChild(
          el(
            doc,
            "li",
            {},
            `${entry ? `${entry.label} for ${entry.who}: ` : ""}${issue.message}`,
            issue.currentVersion !== undefined
              ? ` Current value: ${String(issue.currentValue ?? "blank")}.`
              : "",
          ),
        );
      }
      parent.appendChild(list);
    }

    async function review(): Promise<void> {
      if (!staged.size || reviewing) return;
      const local = [...staged.values()].filter((entry) => entry.error);
      clear(reviewPanel);
      reviewPanel.hidden = false;
      reviewPanel.appendChild(
        el(
          doc,
          "h2",
          { id: "profiles-review-h", tabindex: -1 },
          "Review changes",
        ),
      );
      if (local.length) {
        reviewPanel.append(
          el(doc, "p", { role: "alert" }, "Fix these before saving:"),
        );
        const list = el(doc, "ul", { class: "cw-profiles-issues" });
        for (const entry of local)
          list.appendChild(
            el(
              doc,
              "li",
              {},
              `${entry.label} for ${entry.who}: ${entry.error}`,
            ),
          );
        reviewPanel.append(
          list,
          button("Close", () => {
            reviewPanel.hidden = true;
          }),
        );
        markErrors();
        return;
      }
      reviewing = true;
      refreshStatus();
      let preview: ProfilePreview;
      try {
        preview = await client.preview(changeList());
      } catch (error) {
        reviewing = false;
        refreshStatus();
        reviewPanel.append(
          el(doc, "p", { role: "alert" }, describeError(error)),
          button("Close", () => {
            reviewPanel.hidden = true;
          }),
        );
        return;
      }
      reviewing = false;
      refreshStatus();
      if (destroyed) return;
      renderPreview(preview);
    }

    function renderPreview(preview: ProfilePreview): void {
      clear(reviewPanel);
      const heading = el(
        doc,
        "h2",
        { id: "profiles-review-h", tabindex: -1 },
        "Review changes",
      );
      reviewPanel.appendChild(heading);
      const entries = [...staged.values()];
      const tableEl = el(
        doc,
        "table",
        { class: "cw-profiles-diff" },
        el(
          doc,
          "caption",
          {},
          `${preview.items.length} ${preview.items.length === 1 ? "change" : "changes"} with old and new values`,
        ),
        el(
          doc,
          "thead",
          {},
          el(
            doc,
            "tr",
            {},
            ...["Row", "Field", "Old value", "New value", "Impact"].map(
              (title) => el(doc, "th", { scope: "col" }, title),
            ),
          ),
        ),
      );
      const body = el(doc, "tbody");
      for (const item of preview.items) {
        const entry = entries[item.index];
        const show = (value: string | boolean | null) =>
          value === null || value === ""
            ? "(blank)"
            : typeof value === "boolean"
              ? value
                ? "Visible"
                : "Hidden"
              : value;
        body.appendChild(
          el(
            doc,
            "tr",
            {},
            el(doc, "th", { scope: "row" }, entry?.who ?? item.targetId),
            el(doc, "td", {}, item.label),
            el(doc, "td", {}, show(item.before)),
            el(doc, "td", {}, show(item.after)),
            el(
              doc,
              "td",
              {},
              item.impact.shared
                ? el(doc, "strong", {}, "Shared record. ")
                : null,
              item.impact.summary,
            ),
          ),
        );
      }
      tableEl.appendChild(body);
      reviewPanel.appendChild(tableEl);
      if (!preview.ok) {
        reviewPanel.append(
          el(doc, "p", { role: "alert" }, "These changes cannot be saved yet:"),
        );
        showIssues(preview.issues, reviewPanel);
        const stale = preview.issues.filter(
          (issue) => issue.code === "stale_version",
        );
        if (stale.length) reviewPanel.appendChild(refreshVersionsButton(stale));
      } else {
        reviewKey ??= newKey();
        reviewPanel.append(
          el(
            doc,
            "p",
            {},
            "Saving applies every change above together or none of them.",
          ),
          button("Confirm and save", () => void confirmSave(), {
            id: "profiles-confirm",
          }),
        );
      }
      reviewPanel.appendChild(
        button("Back to editing", () => {
          reviewPanel.hidden = true;
          saveButton.focus();
        }),
      );
      heading.focus();
    }

    function refreshVersionsButton(
      stale: readonly ProfileChangeIssue[],
    ): HTMLButtonElement {
      return button("Keep my edits on the latest versions", () => {
        const entries = [...staged.entries()];
        for (const issue of stale) {
          const found = entries[issue.index];
          if (found && issue.currentVersion !== undefined)
            found[1].change = {
              ...found[1].change,
              expectedVersion: issue.currentVersion,
            } as ProfileChange;
          if (found && issue.currentValue !== undefined)
            found[1].before = issue.currentValue as string | boolean | null;
        }
        reviewKey = null;
        reviewPanel.hidden = true;
        announce(
          "Versions refreshed. Your edits are kept. Choose Save changes to review them again.",
        );
        void review();
      });
    }

    async function confirmSave(): Promise<void> {
      if (!reviewKey) reviewKey = newKey();
      const key = reviewKey;
      const confirm =
        reviewPanel.querySelector<HTMLButtonElement>("#profiles-confirm");
      if (confirm) confirm.disabled = true;
      try {
        const visibilityUpdates = new Map<string, boolean>();
        for (const entry of staged.values())
          if (entry.change.kind === "visibility")
            visibilityUpdates.set(entry.change.personId, entry.change.visible);
        const result = await client.save(changeList(), key);
        for (const [rowKey, selection] of selected)
          if (visibilityUpdates.has(selection.profileId))
            selected.set(rowKey, {
              ...selection,
              visible: visibilityUpdates.get(selection.profileId) ?? false,
              visibilityVersion: selection.visibilityVersion + 1,
            });
        staged.clear();
        reviewKey = null;
        reviewPanel.hidden = true;
        announce(
          `Saved ${result.applied} ${result.applied === 1 ? "change" : "changes"}${result.replayed ? " (this save had already been applied)" : ""}.`,
        );
        await reload();
        saveButton.focus();
      } catch (error) {
        if (confirm) confirm.disabled = false;
        if (
          error instanceof ProfilesApiError &&
          error.status === 409 &&
          error.code === "stale_version"
        ) {
          clear(reviewPanel);
          reviewPanel.append(
            el(
              doc,
              "h2",
              { id: "profiles-review-h", tabindex: -1 },
              "Some rows changed",
            ),
            el(
              doc,
              "p",
              { role: "alert" },
              "Another change landed first. Nothing was saved and your edits are kept.",
            ),
          );
          showIssues(error.issues, reviewPanel);
          reviewPanel.append(
            refreshVersionsButton(error.issues),
            button("Close", () => {
              reviewPanel.hidden = true;
            }),
          );
          return;
        }
        if (error instanceof ProfilesApiError && error.status === 422) {
          clear(reviewPanel);
          reviewPanel.append(
            el(
              doc,
              "h2",
              { id: "profiles-review-h", tabindex: -1 },
              "Fix these changes",
            ),
          );
          showIssues(error.issues, reviewPanel);
          reviewPanel.appendChild(
            button("Close", () => {
              reviewPanel.hidden = true;
            }),
          );
          return;
        }
        // A network failure keeps the same key, so a retry is safe.
        announce(describeError(error));
      }
    }

    // ------------------------------------------------- data and grid
    async function loadPage(params: Record<string, unknown>): Promise<unknown> {
      const token = ++requestToken;
      const sort = Array.isArray(params.sort)
        ? (params.sort[0] as { field?: string; dir?: string } | undefined)
        : undefined;
      query = {
        ...query,
        page: Number(params.page) || 1,
        pageSize: Number(params.size) || query.pageSize,
        sort: sort?.field ?? query.sort,
        direction: sort?.dir === "desc" ? "desc" : "asc",
      };
      let page: ProfilePage;
      try {
        page = await client.rows(query);
      } catch (error) {
        announce(describeError(error));
        throw error;
      }
      if (token !== requestToken || destroyed)
        return { last_page: 1, data: [] };
      total = page.total;
      query = { ...query, page: page.page };
      base.clear();
      for (const row of page.rows) {
        base.set(row.rowKey, row);
        if (selected.has(row.rowKey))
          selected.set(row.rowKey, toSelection(row));
      }
      queueMicrotask(() => {
        refreshStatus();
        markErrors();
        syncSelectionBoxes();
      });
      return {
        last_page: page.lastPage,
        // Tabulator edits the objects it is given, so hand it copies. The
        // untouched server rows in `base` are what staged edits compare against.
        data: page.rows.map((row) => ({ ...overlay(row) })),
      };
    }

    function syncSelectionBoxes(): void {
      refreshSelectionState();
    }

    async function reload(): Promise<void> {
      await table?.setData();
    }

    function columnDefinitions(): TabulatorColumnDefinition[] {
      const columns: TabulatorColumnDefinition[] = [
        {
          title: "Select",
          headerSort: false,
          resizable: false,
          frozen: true,
          width: 68,
          cssClass: "cw-col-select",
          formatter: (cell) => {
            const row = cell.getRow().getData() as unknown as ProfileRow;
            const input = el(doc, "input", {
              type: "checkbox",
              "data-select-role": row.rowKey,
              "aria-label": `Select ${row.roleId ? "role row" : "Profile row"} for ${row.displayName}${row.position ? `, ${row.position}` : ""}`,
            });
            input.checked = selected.has(row.rowKey);
            input.addEventListener("change", () => {
              const source = base.get(row.rowKey);
              if (!source) return;
              if (input.checked) selected.set(row.rowKey, toSelection(source));
              else selected.delete(row.rowKey);
              refreshSelectionState();
            });
            return input;
          },
        },
      ];
      const order = [
        "visible",
        "displayName",
        ...PROFILE_FIELDS.filter(
          (item) =>
            item.status !== "unavailable" &&
            item.id !== "displayName" &&
            item.id !== "visible",
        ).map((item) => item.id),
      ];
      for (const id of order) {
        const definition = PROFILE_FIELDS.find((item) => item.id === id);
        if (!definition) continue;
        columns.push(columnFor(definition));
      }
      return columns;
    }

    function columnFor(
      definition: ProfileFieldDefinition,
    ): TabulatorColumnDefinition {
      const frozen =
        definition.id === "displayName" || definition.id === "visible";
      const common: TabulatorColumnDefinition = {
        title: definition.label,
        field: definition.id,
        visible: visibleColumns.has(definition.id) || frozen,
        frozen,
        resizable: true,
        headerSort: definition.sortable,
        minWidth: 90,
        width: frozen
          ? definition.id === "displayName"
            ? 220
            : 90
          : undefined,
        headerTooltip: false,
        cssClass: `cw-col-${definition.status}`,
      } as TabulatorColumnDefinition;
      if (definition.id === "visible") {
        return {
          ...common,
          formatter: (cell) => {
            const row = cell.getRow().getData() as unknown as ProfileRow;
            const blocked = !row.publicationReady && !row.visible;
            const missing = row.missingForPublication.join(", ");
            const input = el(doc, "input", {
              type: "checkbox",
              "aria-label": blocked
                ? `Visible on Website for ${row.displayName}, unavailable: missing ${missing}`
                : `Visible on Website for ${row.displayName}`,
              ...(blocked
                ? { title: `Cannot be visible yet. Missing ${missing}.` }
                : {}),
            });
            input.checked = row.visible;
            // An incomplete Profile cannot be published. Once the missing
            // information is restored the box is enabled and stays unchecked
            // until the owner publishes.
            input.disabled = blocked;
            input.addEventListener("change", () => {
              const source = base.get(row.rowKey);
              if (!source) return;
              stageVisibilityFor(source, input.checked);
              // One Profile, one checkbox: every role row of the person follows.
              refreshTableRows();
              refreshStatus();
              announce(
                `${source.displayName} will be ${input.checked ? "visible" : "hidden"} after you choose Save changes.`,
              );
            });
            return input;
          },
        };
      }
      if (definition.id === "unitLink") {
        return {
          ...common,
          formatter: (cell) => {
            const row = cell.getRow().getData() as unknown as ProfileRow;
            const link = row.unitLink;
            if (!link) return "";
            const suggest = () =>
              button("Suggest units", () => void openUnitSuggestions(row), {
                "aria-label": `Suggest units for ${row.displayName}, ${row.officeDepartment}`,
              });
            if (link.state === "multiple")
              return el(
                doc,
                "details",
                {},
                el(doc, "summary", {}, "Multiple matches"),
                suggest(),
                el(
                  doc,
                  "ul",
                  {},
                  ...link.paths.map((path) => el(doc, "li", {}, path)),
                ),
              );
            return el(
              doc,
              "span",
              {},
              {
                linked: "✓ Linked",
                ready: "Exact match · ready to link",
                unmatched: "No exact match",
                review: "Review existing link",
              }[link.state],
              ...(row.officeDepartment &&
              row.countyFips &&
              link.state === "unmatched"
                ? [doc.createTextNode(" "), suggest()]
                : []),
            );
          },
        };
      }
      if (definition.id === "alternateNameCount") {
        return {
          ...common,
          formatter: (cell) => {
            const row = cell.getRow().getData() as unknown as ProfileRow;
            const source = base.get(row.rowKey);
            const open = button(
              `${row.alternateNameCount} ${row.alternateNameCount === 1 ? "name" : "names"}`,
              () => {
                if (source) void openNamesEditor(source);
              },
              {
                "data-names-for": row.profileId,
                "aria-label": `Edit alternate names for ${row.displayName}, ${row.alternateNameCount} ${row.alternateNameCount === 1 ? "name" : "names"}`,
              },
            );
            return open;
          },
        };
      }
      if (definition.status === "editable") {
        return {
          ...common,
          editor: "input",
          // A roleless Profile row has no role to edit.
          ...(definition.scope === "role"
            ? {
                editable: (cell: TabulatorCell) =>
                  (cell.getRow().getData() as unknown as ProfileRow).roleId !==
                  null,
              }
            : {}),
          editorParams: {
            elementAttributes: {
              "aria-label": definition.label,
              maxlength:
                definition.id === "displayName"
                  ? PROFILES_MAX_NAME_LENGTH
                  : definition.id in PERSON_NAME_COLUMNS
                    ? componentLimit(definition.id)
                    : 30,
            },
          },
          cellEdited: onCellEdited,
        };
      }
      return {
        ...common,
        formatter: (cell) => {
          const value = cell.getValue();
          const text =
            value === null || value === undefined || value === ""
              ? ""
              : String(value);
          return doc.createTextNode(text) as unknown as HTMLElement;
        },
      };
    }

    function applyFilters(): void {
      query = {
        ...query,
        query: searchInput.value.trim(),
        countyFips: countySelect.value || null,
        office: officeSelect.value || null,
        visibility: visibilitySelect.value as ProfileQuery["visibility"],
        unitLink: unitLinkSelect.value as ProfileQuery["unitLink"],
        page: 1,
      };
      void reload();
    }

    function buildPicker(): void {
      picker.appendChild(el(doc, "summary", {}, "Columns"));
      const groups: [string, ProfileFieldDefinition[]][] = [
        ["Editable", PROFILE_FIELDS.filter((f) => f.status === "editable")],
        ["Read-only", PROFILE_FIELDS.filter((f) => f.status === "read-only")],
        [
          "Unavailable on the Website",
          PROFILE_FIELDS.filter((f) => f.status === "unavailable"),
        ],
      ];
      for (const [title, fields] of groups) {
        const group = el(doc, "fieldset", {}, el(doc, "legend", {}, title));
        for (const definition of fields) {
          const id = `profiles-col-${definition.id}`;
          const input = el(doc, "input", {
            type: "checkbox",
            id,
            "data-column": definition.id,
          });
          const locked =
            definition.status === "unavailable" ||
            definition.id === "displayName" ||
            definition.id === "visible";
          input.checked =
            definition.status !== "unavailable" &&
            (visibleColumns.has(definition.id) || locked);
          if (locked) input.disabled = true;
          input.addEventListener("change", () => {
            if (input.checked) {
              visibleColumns.add(definition.id);
              table?.showColumn(definition.id);
            } else {
              visibleColumns.delete(definition.id);
              table?.hideColumn(definition.id);
            }
            announce(
              `${definition.label} column ${input.checked ? "shown" : "hidden"}.`,
            );
          });
          group.appendChild(
            el(
              doc,
              "div",
              { class: "cw-profiles-picker-item" },
              input,
              el(doc, "label", { for: id }, definition.label),
              definition.status === "unavailable" && definition.reason
                ? el(doc, "small", {}, ` ${definition.reason}`)
                : null,
              definition.id === "displayName" || definition.id === "visible"
                ? el(doc, "small", {}, " Always shown.")
                : null,
            ),
          );
        }
        picker.appendChild(group);
      }
    }

    function fillFacets(facets: ProfileFacets): void {
      countySelect.appendChild(
        el(doc, "option", { value: "" }, "All counties"),
      );
      for (const county of facets.counties)
        countySelect.appendChild(
          el(doc, "option", { value: county.fips }, county.name),
        );
      officeSelect.appendChild(el(doc, "option", { value: "" }, "All offices"));
      for (const office of facets.offices)
        officeSelect.appendChild(el(doc, "option", { value: office }, office));
    }

    // ------------------------------------------------------- start up
    buildPicker();
    refreshStatus();
    table = new Tabulator(gridHost, {
      index: "rowKey",
      columns: columnDefinitions(),
      layout: "fitData",
      height: "87.5vh",
      renderVertical: "basic",
      pagination: true,
      paginationMode: "remote",
      paginationSize: query.pageSize,
      paginationSizeSelector: [50, 100, 250, 500, 1_000],
      paginationCounter: "rows",
      locale: "default",
      langs: { default: { pagination: { page_size: "Rows per page" } } },
      sortMode: "remote",
      ajaxURL: "profiles",
      ajaxRequestFunc: (_url, _config, params) => loadPage(params),
      initialSort: [{ column: "displayName", dir: "asc" }],
      placeholder: "No roles match these filters.",
      editTriggerEvent: "focus",
      rowFormatter: (row) => {
        const data = row.getData() as unknown as ProfileRow;
        row
          .getElement()
          .classList.toggle("cw-row-hidden", data.visible === false);
      },
      tabEndNewRow: false,
    });
    gridHost.setAttribute("aria-label", "Profiles, one row per role");
    table.on(
      "tableBuilt" as never,
      (() => {
        gridHost.setAttribute("aria-rowcount", String(total));
      }) as never,
    );
    searchInput.addEventListener("input", () => {
      closeMatchingVisibility();
      closeUnitLinks();
      if (timer) clearTimeout(timer);
      timer = setTimeout(applyFilters, 350);
    });
    for (const control of [
      countySelect,
      officeSelect,
      visibilitySelect,
      unitLinkSelect,
    ])
      control.addEventListener("change", () => {
        closeMatchingVisibility();
        closeUnitLinks();
        applyFilters();
      });
    container
      .querySelector("form.cw-profiles-filters")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        closeMatchingVisibility();
        closeUnitLinks();
        applyFilters();
      });
    void client
      .facets()
      .then(fillFacets)
      .catch((error: unknown) => announce(describeError(error)));

    return {
      canLeave: () => staged.size === 0,
      destroy() {
        destroyed = true;
        if (timer) clearTimeout(timer);
        table?.destroy();
        table = null;
      },
    };
  };
}

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
  PROFILE_FIELDS,
  PROFILES_DEFAULT_PAGE_SIZE,
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
import type { DashboardViewFactory } from "./dashboard.js";
import { clear, el } from "./dom.js";
import { type ProfilesClient, ProfilesApiError } from "./profiles-client.js";

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
  fullName: "fullName",
  visible: "visible",
  createdOn: "createdOn",
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
  { id: "employmentStart", column: "start_date", label: "Employment Start" },
  { id: "employmentEnd", column: "end_date", label: "Employment End" },
  { id: "dateReviewed", column: "source_checked_at", label: "Date Reviewed" },
] as const;

const COLUMN_FOR_FIELD: Readonly<Record<string, string>> = {
  fullName: "display_name",
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
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function stagedKey(change: ProfileChange): string {
  return change.kind === "visibility"
    ? `v:${change.personId}`
    : `${change.entity}:${change.targetId}:${change.field}`;
}

function localError(field: string, value: string | null): string | null {
  if (field === "fullName") {
    if (!value?.trim()) return "Full Name cannot be blank.";
    if (value.trim().length > PROFILES_MAX_NAME_LENGTH)
      return `Full Name is limited to ${PROFILES_MAX_NAME_LENGTH} characters.`;
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
    roleId: row.roleId,
    profileId: row.profileId,
    profileVersion: row.profileVersion,
    roleVersion: row.roleVersion,
    visibilityVersion: row.visibilityVersion,
    visible: row.visible,
    fullName: row.fullName,
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
      sort: "fullName",
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
    );
    const counts = el(doc, "p", {
      class: "cw-profiles-counts",
      role: "status",
      "aria-live": "polite",
    });
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
    const hideButton = button("Hide selected Profiles", () => stageVisibility(false), {
      id: "profiles-hide",
    });
    const restoreButton = button(
      "Restore selected Profiles",
      () => stageVisibility(true),
      { id: "profiles-restore" },
    );
    const selectPage = button("Select this page", () => selectCurrentPage());
    const selectMatching = button(
      `Select all matching (up to ${PROFILES_MAX_SELECT_ALL})`,
      () => void selectAllMatching(),
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
          "One row per role. Edit cells in place or in bulk, then choose Save changes. Edits go to the Website only. The private reviewed Profiles record is edited in its own workflow.",
        ),
        el(
          doc,
          "form",
          { class: "cw-profiles-filters", role: "search", "aria-label": "Filter Profiles" },
          field("Search", searchInput, "profiles-search"),
          field("County", countySelect, "profiles-county"),
          field("Office / Unit", officeSelect, "profiles-office"),
          field("Visibility", visibilitySelect, "profiles-visibility"),
          button(
            "Clear filters",
            () => {
              searchInput.value = "";
              countySelect.value = "";
              officeSelect.value = "";
              visibilitySelect.value = "all";
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
          { class: "cw-profiles-actions", role: "toolbar", "aria-label": "Profiles actions" },
          selectPage,
          selectMatching,
          clearSelection,
          setButton,
          hideButton,
          restoreButton,
          saveButton,
          discardButton,
          discardConfirm,
          picker,
        ),
        message,
        setPanel,
        reviewPanel,
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
        if (error.status === 403)
          return "You do not have access to Profiles.";
        if (error.code === "network_error")
          return "The network failed. Your edits are kept. Try again.";
        return `The request failed (${error.code}). Your edits are kept.`;
      }
      return "Something went wrong. Your edits are kept.";
    }

    function rowFor(roleId: string): ProfileRow | undefined {
      return base.get(roleId);
    }

    /** Server values with this browser's staged edits laid over them. */
    function overlay(row: ProfileRow): ProfileRow {
      let next = row;
      const name = staged.get(`people:${row.profileId}:display_name`);
      if (name?.change.kind === "field")
        next = { ...next, fullName: name.change.value ?? "" };
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
        const fresh = base.get(data.roleId);
        if (fresh) void row.update(overlay(fresh) as unknown as Record<string, unknown>);
      }
    }

    function refreshStatus(): void {
      counts.textContent = `${total} ${total === 1 ? "role" : "roles"} match. Page ${query.page}.`;
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
      restoreButton.disabled = none;
      clearSelection.disabled = none;
      for (const input of Array.from(
        gridHost.querySelectorAll<HTMLInputElement>("input[data-select-role]"),
      )) {
        input.checked = selected.has(input.dataset.selectRole ?? "");
      }
    }

    // --------------------------------------------------------- staging
    function stage(entry: Staged): void {
      reviewKey = null;
      const key = stagedKey(entry.change);
      const baseline =
        entry.change.kind === "visibility"
          ? entry.before
          : entry.before;
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
      const profileLevel = fieldId === "fullName";
      const before = (row[ROW_KEY[fieldId] as RowKey] ?? null) as string | null;
      const change: ProfileChange = {
        kind: "field",
        entity: profileLevel ? "people" : "person_roles",
        targetId: profileLevel ? row.profileId : row.roleId,
        field: column,
        expectedVersion: profileLevel ? row.profileVersion : row.roleVersion,
        value: profileLevel ? (value ?? "").trim() : clean,
      };
      const label =
        PROFILE_FIELDS.find((definition) => definition.id === fieldId)?.label ??
        fieldId;
      stage({
        change,
        label,
        who: row.fullName,
        before,
        after: profileLevel ? (value ?? "").trim() : clean,
        error: localError(fieldId, profileLevel ? value : clean),
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
        who: row.fullName,
        before: row.visible,
        after: visible,
        error: null,
      });
    }

    function onCellEdited(cell: TabulatorCell): void {
      const data = cell.getRow().getData() as unknown as ProfileRow;
      const fieldId = cell.getField();
      const original = rowFor(data.roleId);
      if (!original) return;
      const raw = cell.getValue();
      const value = raw === null || raw === undefined ? null : String(raw);
      stageField(original, fieldId, value);
      if (fieldId === "fullName") {
        // One Profile, one name: every role row of that person shows it.
        for (const sibling of rowsOnPage(original.profileId))
          void table
            ?.getRows()
            .find(
              (row) => (row.getData() as unknown as ProfileRow).roleId === sibling.roleId,
            )
            ?.update({ fullName: (value ?? "").trim() });
      }
      markErrors();
      refreshStatus();
    }

    function markErrors(): void {
      for (const element of Array.from(gridHost.querySelectorAll(".cw-cell-error"))) {
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
        if (!profiles.has(entry.profileId)) profiles.set(entry.profileId, entry);
      let staging = 0;
      let skipped = 0;
      for (const entry of profiles.values()) {
        const current =
          (staged.get(`v:${entry.profileId}`)?.change as
            | { visible: boolean }
            | undefined)?.visible ?? entry.visible;
        if (current === visible && !staged.has(`v:${entry.profileId}`)) {
          skipped += 1;
          continue;
        }
        stageVisibilityFor(
          {
            ...(base.get(entry.roleId) ?? ({} as ProfileRow)),
            roleId: entry.roleId,
            profileId: entry.profileId,
            profileVersion: entry.profileVersion,
            roleVersion: entry.roleVersion,
            visibilityVersion: entry.visibilityVersion,
            visible: entry.visible,
            fullName: entry.fullName,
          } as ProfileRow,
          visible,
        );
        staging += 1;
      }
      refreshTableRows();
      refreshStatus();
      announce(
        `${visible ? "Restore" : "Hide"} staged for ${staging} ${staging === 1 ? "Profile" : "Profiles"} from ${selected.size} selected role ${selected.size === 1 ? "row" : "rows"}.${skipped ? ` ${skipped} already ${visible ? "visible" : "hidden"}.` : ""} Choose Save changes to apply.`,
      );
    }

    // ------------------------------------------------------ bulk set
    function openSetPanel(): void {
      clear(setPanel);
      setPanel.hidden = false;
      const fieldSelect = el(doc, "select", { id: "profiles-set-field" });
      for (const spec of ROLE_BULK_FIELDS)
        fieldSelect.appendChild(el(doc, "option", { value: spec.id }, spec.label));
      const value = el(doc, "input", {
        id: "profiles-set-value",
        type: "text",
        placeholder: "YYYY-MM-DD",
        autocomplete: "off",
      });
      const blank = el(doc, "input", { id: "profiles-set-blank", type: "checkbox" });
      const error = el(doc, "p", { class: "cw-profiles-error", role: "alert" });
      setPanel.append(
        el(doc, "h2", { id: "profiles-set-h" }, "Set selected values"),
        el(
          doc,
          "p",
          {},
          `Applies to the ${selected.size} selected role ${selected.size === 1 ? "row" : "rows"}. Only supported role fields can be set in bulk. Nothing is written until you choose Save changes.`,
        ),
        field("Field", fieldSelect, "profiles-set-field"),
        field("Value", value, "profiles-set-value"),
        el(
          doc,
          "div",
          { class: "cw-profiles-field" },
          blank,
          el(doc, "label", { for: "profiles-set-blank" }, "Leave blank (unknown)"),
        ),
        error,
        button("Stage values", () => {
          const spec = ROLE_BULK_FIELDS.find((item) => item.id === fieldSelect.value);
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
          let count = 0;
          for (const entry of selected.values()) {
            const key = `person_roles:${entry.roleId}:${spec.column}`;
            const before =
              (staged.get(key)?.before as string | null | undefined) ??
              ((entry as unknown as Record<string, string | null>)[spec.id] ?? null);
            stage({
              change: {
                kind: "field",
                entity: "person_roles",
                targetId: entry.roleId,
                field: spec.column,
                expectedVersion: entry.roleVersion,
                value: text,
              },
              label: spec.label,
              who: entry.fullName,
              before,
              after: text,
              error: null,
            });
            count += 1;
          }
          setPanel.hidden = true;
          refreshTableRows();
          refreshStatus();
          announce(
            `${spec.label} staged for ${count} role ${count === 1 ? "row" : "rows"}. Choose Save changes to apply.`,
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
      for (const row of base.values()) selected.set(row.roleId, toSelection(row));
      refreshSelectionState();
      announce(`Selected ${base.size} role rows on this page.`);
    }

    async function selectAllMatching(): Promise<void> {
      try {
        const result = await client.selectAll(query);
        for (const entry of result.entries) selected.set(entry.roleId, entry);
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
        el(doc, "h2", { id: "profiles-review-h", tabindex: -1 }, "Review changes"),
      );
      if (local.length) {
        reviewPanel.append(
          el(doc, "p", { role: "alert" }, "Fix these before saving:"),
        );
        const list = el(doc, "ul", { class: "cw-profiles-issues" });
        for (const entry of local)
          list.appendChild(
            el(doc, "li", {}, `${entry.label} for ${entry.who}: ${entry.error}`),
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
            ...["Row", "Field", "Old value", "New value", "Impact"].map((title) =>
              el(doc, "th", { scope: "col" }, title),
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
              item.impact.shared ? el(doc, "strong", {}, "Shared record. ") : null,
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
      const confirm = reviewPanel.querySelector<HTMLButtonElement>(
        "#profiles-confirm",
      );
      if (confirm) confirm.disabled = true;
      try {
        const result = await client.save(changeList(), key);
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
        if (error instanceof ProfilesApiError && error.status === 409 && error.code === "stale_version") {
          clear(reviewPanel);
          reviewPanel.append(
            el(doc, "h2", { id: "profiles-review-h", tabindex: -1 }, "Some rows changed"),
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
            el(doc, "h2", { id: "profiles-review-h", tabindex: -1 }, "Fix these changes"),
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
      if (token !== requestToken || destroyed) return { last_page: 1, data: [] };
      total = page.total;
      query = { ...query, page: page.page };
      base.clear();
      for (const row of page.rows) base.set(row.roleId, row);
      queueMicrotask(() => {
        refreshStatus();
        markErrors();
        syncSelectionBoxes();
      });
      return {
        last_page: page.lastPage,
        data: page.rows.map((row) => overlay(row)),
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
          title: "Select row",
          headerSort: false,
          resizable: false,
          frozen: true,
          width: 90,
          cssClass: "cw-col-select",
          formatter: (cell) => {
            const row = cell.getRow().getData() as unknown as ProfileRow;
            const input = el(doc, "input", {
              type: "checkbox",
              "data-select-role": row.roleId,
              "aria-label": `Select role row for ${row.fullName}${row.position ? `, ${row.position}` : ""}`,
            });
            input.checked = selected.has(row.roleId);
            input.addEventListener("change", () => {
              const source = base.get(row.roleId);
              if (!source) return;
              if (input.checked) selected.set(row.roleId, toSelection(source));
              else selected.delete(row.roleId);
              refreshSelectionState();
            });
            return input;
          },
        },
      ];
      const order = [
        "fullName",
        "visible",
        ...PROFILE_FIELDS.filter(
          (item) =>
            item.status !== "unavailable" &&
            item.id !== "fullName" &&
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

    function columnFor(definition: ProfileFieldDefinition): TabulatorColumnDefinition {
      const frozen = definition.id === "fullName" || definition.id === "visible";
      const common: TabulatorColumnDefinition = {
        title: definition.label,
        field: definition.id,
        visible: visibleColumns.has(definition.id) || frozen,
        frozen,
        resizable: true,
        headerSort: definition.sortable,
        minWidth: 90,
        width: frozen ? (definition.id === "fullName" ? 220 : 130) : undefined,
        headerTooltip: false,
        cssClass: `cw-col-${definition.status}`,
      } as TabulatorColumnDefinition;
      if (definition.id === "visible") {
        return {
          ...common,
          formatter: (cell) => {
            const row = cell.getRow().getData() as unknown as ProfileRow;
            const input = el(doc, "input", {
              type: "checkbox",
              "aria-label": `Visible on Website for ${row.fullName}`,
            });
            input.checked = row.visible;
            input.addEventListener("change", () => {
              const source = base.get(row.roleId);
              if (!source) return;
              stageVisibilityFor(source, input.checked);
              // One Profile, one checkbox: every role row of the person follows.
              refreshTableRows();
              refreshStatus();
              announce(
                `${source.fullName} will be ${input.checked ? "visible" : "hidden"} after you choose Save changes.`,
              );
            });
            return input;
          },
        };
      }
      if (definition.status === "editable") {
        return {
          ...common,
          editor: "input",
          editorParams: {
            elementAttributes: {
              "aria-label": definition.label,
              maxlength: definition.id === "fullName" ? PROFILES_MAX_NAME_LENGTH : 30,
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
        const group = el(
          doc,
          "fieldset",
          {},
          el(doc, "legend", {}, title),
        );
        for (const definition of fields) {
          const id = `profiles-col-${definition.id}`;
          const input = el(doc, "input", {
            type: "checkbox",
            id,
            "data-column": definition.id,
          });
          const locked =
            definition.status === "unavailable" ||
            definition.id === "fullName" ||
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
              definition.id === "fullName" || definition.id === "visible"
                ? el(doc, "small", {}, " Always shown.")
                : null,
            ),
          );
        }
        picker.appendChild(group);
      }
    }

    function fillFacets(facets: ProfileFacets): void {
      countySelect.appendChild(el(doc, "option", { value: "" }, "All counties"));
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
      index: "roleId",
      columns: columnDefinitions(),
      layout: "fitData",
      height: "70vh",
      renderVertical: "basic",
      pagination: true,
      paginationMode: "remote",
      paginationSize: query.pageSize,
      sortMode: "remote",
      ajaxURL: "profiles",
      ajaxRequestFunc: (_url, _config, params) => loadPage(params),
      initialSort: [{ column: "fullName", dir: "asc" }],
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
    table.on("tableBuilt" as never, (() => {
      gridHost.setAttribute("aria-rowcount", String(total));
    }) as never);
    searchInput.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(applyFilters, 350);
    });
    for (const control of [countySelect, officeSelect, visibilitySelect])
      control.addEventListener("change", applyFilters);
    container
      .querySelector("form.cw-profiles-filters")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
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

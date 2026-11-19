import {
  type ChangeItem,
  type CountySummary,
  type CsvIssue,
  IMPORT_MODES,
  type ImportMode,
  type ImportSummary,
  ORGANIZATION_TYPES,
  type PreparedImport,
  type StructureRecord,
  UNIT_STATUSES,
  type UnitNode,
} from "../contracts/county-structure.js";
import {
  type CountyDetailResponse,
  CountyStructureApiError,
  type CountyStructureClient,
  type LinkedRoleResponse,
} from "./county-structure-client.js";
import type { DashboardViewFactory } from "./dashboard.js";
import { clear, el } from "./dom.js";

const MODE_LABELS: Readonly<Record<ImportMode, string>> = {
  merge: "Merge into existing structure",
  replace_county: "Replace one county",
  replace_state: "Replace all 64 counties",
};

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  stale_version:
    "The structure changed after this page loaded. Reload the county and try again.",
  already_committed: "This import was already committed.",
  idempotency_reuse:
    "That request key was already used for a different action.",
  blocked: "A Profile still points at something this change would remove.",
  not_reversible:
    "This import cannot be reversed because later changes or Profile links depend on it.",
  not_prepared: "This import is not ready to commit. Prepare it again.",
  forbidden: "Only the owner can change the County Structure.",
  network_error: "The request did not reach the server. Check the connection.",
};

function describe(error: unknown): string {
  if (error instanceof CountyStructureApiError) {
    if (error.issues.length > 0) {
      return error.issues
        .slice(0, 5)
        .map((issue) => formatIssue(issue))
        .join(" ");
    }
    return (
      ERROR_MESSAGES[error.code] ?? error.message ?? "Something went wrong."
    );
  }
  return "Something went wrong.";
}

function formatIssue(issue: CsvIssue): string {
  const where = issue.row > 0 ? `Row ${issue.row}` : "File";
  const column = issue.column ? `, ${issue.column}` : "";
  return `${where}${column}: ${issue.message}`;
}

const typeLabel = (record: StructureRecord): string =>
  record.kind === "display_group" ? "Display group" : record.organizationType;

export function createCountyStructureView(options: {
  readonly client: CountyStructureClient;
  readonly newKey?: () => string;
  /** Replaces the browser download. Tests pass a recorder. */
  readonly download?: (fileName: string, text: string) => void;
}): DashboardViewFactory {
  return (context) => {
    const { doc, container } = context;
    const client = options.client;
    const newKey = options.newKey ?? (() => crypto.randomUUID());
    let destroyed = false;
    let counties: readonly CountySummary[] = [];
    let version = 0;
    let selectedCounty: string | null = null;
    let detail: CountyDetailResponse | null = null;
    let selectedId: string | null = null;
    let prepared: PreparedImport | null = null;
    let commitKey: string | null = null;
    let recent: readonly ImportSummary[] = [];

    const status = el(doc, "p", {
      class: "cs-status",
      role: "status",
      "aria-live": "polite",
    });
    const say = (text: string) => {
      status.textContent = text;
      context.announce(text);
    };

    const countySelect = el(doc, "select", {
      id: "cs-county",
      "aria-label": "County",
    });
    const counts = el(doc, "p", { class: "cs-counts" });
    const tree = el(doc, "div", { class: "cs-tree" });
    const editor = el(doc, "div", { class: "cs-editor" });
    const importPanel = el(doc, "div", { class: "cs-import" });
    const historyPanel = el(doc, "div", { class: "cs-history" });

    container.append(
      el(doc, "h2", {}, "County Structure"),
      el(
        doc,
        "p",
        { class: "cs-note" },
        "Offices and units for each county. Elected Official is a display group, not a parent. Evidence and sources are private and never appear on the public site.",
      ),
      status,
      el(
        doc,
        "div",
        { class: "cs-toolbar" },
        el(doc, "label", { for: "cs-county" }, "County"),
        countySelect,
      ),
      counts,
      el(doc, "div", { class: "cs-columns" }, tree, editor),
      importPanel,
      historyPanel,
    );

    // ---------------------------------------------------------- data
    const findNode = (
      nodes: readonly UnitNode[],
      id: string,
    ): UnitNode | null => {
      for (const node of nodes) {
        if (node.record.id === id) return node;
        const inner = findNode(node.children, id);
        if (inner) return inner;
      }
      return null;
    };
    const flatten = (nodes: readonly UnitNode[]): UnitNode[] =>
      nodes.flatMap((node) => [node, ...flatten(node.children)]);

    async function loadCounties(): Promise<void> {
      try {
        const result = await client.counties();
        counties = result.counties;
        version = result.version;
        clear(countySelect);
        countySelect.append(
          el(doc, "option", { value: "" }, "Choose a county"),
          ...counties.map((county) =>
            el(
              doc,
              "option",
              {
                value: county.fips,
                selected: county.fips === selectedCounty,
              },
              `${county.name} (${county.fips}) - ${county.counts.units} units, ${county.counts.displayGroups} groups`,
            ),
          ),
        );
      } catch (error) {
        say(describe(error));
      }
    }

    async function loadCounty(fips: string | null): Promise<void> {
      selectedCounty = fips;
      selectedId = null;
      if (!fips) {
        detail = null;
        renderAll();
        return;
      }
      try {
        detail = await client.county(fips);
        version = detail.version;
      } catch (error) {
        detail = null;
        say(describe(error));
      }
      renderAll();
    }

    async function refresh(): Promise<void> {
      await loadCounties();
      await loadCounty(selectedCounty);
      await loadImports();
    }

    async function loadImports(): Promise<void> {
      try {
        recent = (await client.imports()).imports;
      } catch {
        recent = [];
      }
      renderHistory();
    }

    // ---------------------------------------------------------- tree
    function renderTree(): void {
      clear(tree);
      if (!detail) {
        tree.append(
          el(
            doc,
            "p",
            { class: "cs-empty" },
            "Choose a county to see its structure.",
          ),
        );
        return;
      }
      if (detail.roots.length === 0) {
        tree.append(
          el(
            doc,
            "p",
            { class: "cs-empty" },
            "This county has no offices or units yet. Add one, or import county.csv.",
          ),
        );
      }
      const list = (nodes: readonly UnitNode[]): HTMLElement => {
        const ul = el(doc, "ul", { class: "cs-list", role: "group" });
        for (const node of nodes) {
          const record = node.record;
          const button = el(
            doc,
            "button",
            {
              type: "button",
              class: `cs-node${record.id === selectedId ? " is-selected" : ""}`,
              "data-unit-id": record.id,
              "aria-pressed": record.id === selectedId ? "true" : "false",
            },
            record.name,
            el(doc, "span", { class: "cs-tag" }, typeLabel(record)),
            record.status === "active"
              ? ""
              : el(
                  doc,
                  "span",
                  { class: "cs-tag cs-tag-status" },
                  record.status,
                ),
            node.profileReferences > 0
              ? el(
                  doc,
                  "span",
                  { class: "cs-tag" },
                  `${node.profileReferences} Profile link${node.profileReferences === 1 ? "" : "s"}`,
                )
              : "",
          );
          button.addEventListener("click", () => {
            selectedId = record.id;
            renderTree();
            void renderEditor();
          });
          const item = el(doc, "li", {}, button);
          if (node.children.length > 0) item.append(list(node.children));
          ul.append(item);
        }
        return ul;
      };
      if (detail.roots.length > 0) tree.append(list(detail.roots));
      const addGroup = el(
        doc,
        "button",
        { type: "button" },
        "Add display group",
      );
      addGroup.addEventListener(
        "click",
        () => void promptCreate(null, "group"),
      );
      const addTop = el(
        doc,
        "button",
        { type: "button" },
        "Add top-level unit",
      );
      addTop.addEventListener("click", () => void promptCreate(null, "unit"));
      tree.append(el(doc, "div", { class: "cs-actions" }, addTop, addGroup));
    }

    function renderCounts(): void {
      if (!detail) {
        counts.textContent = "";
        return;
      }
      const c = detail.counts;
      counts.textContent = `${c.units} units, ${c.subunits} sub-units, ${c.displayGroups} display groups, ${c.profiles} linked Profiles, ${c.unresolved} needing review.`;
    }

    // ---------------------------------------------------------- edits
    async function runEdit(
      edit: { op: string; [key: string]: unknown },
      done: string,
    ): Promise<void> {
      try {
        const result = await client.edit(version, edit);
        version = result.structureVersion;
        say(done);
        const keep = selectedId;
        await refresh();
        if (keep && detail && findNode(detail.roots, keep)) {
          selectedId = keep;
          renderTree();
          await renderEditor();
        }
      } catch (error) {
        say(describe(error));
      }
    }

    async function promptCreate(
      parentId: string | null,
      kind: "unit" | "group",
    ): Promise<void> {
      if (!selectedCounty) return;
      const name =
        typeof globalThis.prompt === "function"
          ? globalThis.prompt(
              kind === "group" ? "Display group name" : "Unit name",
            )
          : null;
      if (!name?.trim()) return;
      await runEdit(
        {
          op: kind === "group" ? "create_group" : "create_unit",
          countyFips: selectedCounty,
          name: name.trim(),
          ...(kind === "unit" ? { organizationType: "office" } : {}),
          ...(parentId ? { parentId, relationship: "part_of" } : {}),
        },
        "Added.",
      );
    }

    async function renderEditor(): Promise<void> {
      clear(editor);
      if (!detail || !selectedId) {
        editor.append(
          el(doc, "p", { class: "cs-empty" }, "Select a unit to edit it."),
        );
        return;
      }
      const node = findNode(detail.roots, selectedId);
      if (!node) return;
      const record = node.record;
      const isGroup = record.kind === "display_group";

      const nameInput = el(doc, "input", {
        id: "cs-name",
        type: "text",
        value: record.name,
        maxlength: "200",
      });
      const typeSelect = el(
        doc,
        "select",
        { id: "cs-type", disabled: isGroup },
        ...ORGANIZATION_TYPES.map((type) =>
          el(
            doc,
            "option",
            { value: type, selected: type === record.organizationType },
            type,
          ),
        ),
      );
      const statusSelect = el(
        doc,
        "select",
        { id: "cs-status-select" },
        ...UNIT_STATUSES.map((value) =>
          el(
            doc,
            "option",
            { value, selected: value === record.status },
            value,
          ),
        ),
      );
      const aliasInput = el(
        doc,
        "textarea",
        { id: "cs-aliases", rows: "3" },
        record.aliases.map((alias) => alias.name).join("\n"),
      );
      const evidenceInput = el(
        doc,
        "textarea",
        { id: "cs-evidence", rows: "3" },
        record.evidence ?? "",
      );
      const sourcesInput = el(
        doc,
        "textarea",
        { id: "cs-sources", rows: "2" },
        record.sources ?? "",
      );
      const parentSelect = el(doc, "select", { id: "cs-parent" });
      const everyone = flatten(detail.roots);
      const blocked = new Set(
        flatten([node]).map((descendant) => descendant.record.id),
      );
      parentSelect.append(
        el(doc, "option", { value: "" }, "Top level"),
        ...everyone
          .filter((candidate) => !blocked.has(candidate.record.id))
          .filter(
            (candidate) =>
              !(isGroup && candidate.record.kind !== "display_group"),
          )
          .map((candidate) =>
            el(
              doc,
              "option",
              {
                value: candidate.record.id,
                selected:
                  candidate.record.id ===
                  (record.parentId ?? record.displayGroupId),
              },
              candidate.record.kind === "display_group"
                ? `${candidate.record.name} (display group)`
                : candidate.record.name,
            ),
          ),
      );

      const save = el(doc, "button", { type: "button" }, "Save changes");
      save.addEventListener("click", () => {
        void runEdit(
          {
            op: "update",
            id: record.id,
            name: nameInput.value.trim(),
            ...(isGroup ? {} : { organizationType: typeSelect.value }),
            status: statusSelect.value,
            aliases: aliasInput.value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((name) => ({ name })),
            evidence: evidenceInput.value || null,
            sources: sourcesInput.value || null,
          },
          "Saved.",
        );
      });
      const move = el(doc, "button", { type: "button" }, "Move");
      move.addEventListener("click", () => {
        void runEdit(
          { op: "move", id: record.id, parentId: parentSelect.value || null },
          "Moved.",
        );
      });
      const hide = el(
        doc,
        "button",
        { type: "button" },
        "Hide from public site",
      );
      hide.addEventListener("click", () => {
        void runEdit(
          { op: "update", id: record.id, status: "hidden" },
          "Hidden.",
        );
      });
      const addChild = el(doc, "button", { type: "button" }, "Add sub-unit");
      addChild.addEventListener(
        "click",
        () => void promptCreate(record.id, "unit"),
      );
      const remove = el(
        doc,
        "button",
        { type: "button", class: "cs-danger" },
        "Delete",
      );
      remove.addEventListener("click", () => {
        void runEdit({ op: "delete", id: record.id }, "Deleted.");
      });

      editor.append(
        el(doc, "h3", {}, record.name),
        el(doc, "p", { class: "cs-note" }, `ID: ${record.id}`),
        field(doc, "Name", "cs-name", nameInput),
        field(doc, "Type", "cs-type", typeSelect),
        field(doc, "Status", "cs-status-select", statusSelect),
        field(doc, "Alternate names (one per line)", "cs-aliases", aliasInput),
        field(doc, "Evidence (private)", "cs-evidence", evidenceInput),
        field(doc, "Source references (private)", "cs-sources", sourcesInput),
        el(doc, "div", { class: "cs-actions" }, save, hide, remove),
        field(doc, "Move under", "cs-parent", parentSelect),
        el(doc, "div", { class: "cs-actions" }, move, isGroup ? "" : addChild),
      );

      if (!isGroup) {
        const roles = el(doc, "div", { class: "cs-roles" });
        editor.append(el(doc, "h4", {}, "Linked Profiles"), roles);
        try {
          const result = await client.linkedRoles(record.id);
          renderRoles(roles, result.roles);
        } catch (error) {
          roles.textContent = describe(error);
        }
      }
    }

    function renderRoles(
      target: HTMLElement,
      roles: readonly LinkedRoleResponse[],
    ): void {
      if (roles.length === 0) {
        target.textContent = "No Profiles are linked to this unit.";
        return;
      }
      const ul = el(doc, "ul", {});
      for (const role of roles) {
        ul.append(
          el(
            doc,
            "li",
            {},
            `${role.displayName}${role.title ? `, ${role.title}` : ""} (${role.listing.replace("_", " ")})`,
          ),
        );
      }
      target.append(ul);
    }

    // ---------------------------------------------------------- import
    const fileInput = el(doc, "input", {
      id: "cs-file",
      type: "file",
      accept: ".csv,text/csv",
    });
    const modeSelect = el(
      doc,
      "select",
      { id: "cs-mode" },
      ...IMPORT_MODES.map((mode) =>
        el(doc, "option", { value: mode }, MODE_LABELS[mode]),
      ),
    );
    const preview = el(doc, "div", { class: "cs-preview" });
    const prepare = el(
      doc,
      "button",
      { type: "button" },
      "Validate and preview",
    );
    const commit = el(
      doc,
      "button",
      { type: "button", disabled: true },
      "Commit import",
    );
    const exportButton = el(
      doc,
      "button",
      { type: "button" },
      "Export county.csv",
    );

    importPanel.append(
      el(doc, "h3", {}, "Import and export"),
      el(
        doc,
        "p",
        { class: "cs-note" },
        "Import is two steps. Validate and preview changes nothing. Commit applies the exact previewed change in one transaction.",
      ),
      field(doc, "county.csv file", "cs-file", fileInput),
      field(doc, "Import mode", "cs-mode", modeSelect),
      el(doc, "div", { class: "cs-actions" }, prepare, commit, exportButton),
      preview,
    );

    function renderPreview(): void {
      clear(preview);
      commit.disabled = !(prepared?.committable ?? false);
      if (!prepared) return;
      const c = prepared.import.counts;
      preview.append(
        el(
          doc,
          "p",
          {},
          `Preview: ${c.add} to add, ${c.update} to update, ${c.move} to move, ${c.retire} to retire, ${c.remove} to remove, ${c.unchanged} unchanged, ${c.blocked} blocked. ${c.affectedProfileReferences} Profile links affected.`,
        ),
      );
      if (prepared.issues.length > 0) {
        const ul = el(doc, "ul", { class: "cs-issues" });
        for (const issue of prepared.issues.slice(0, 50)) {
          ul.append(el(doc, "li", {}, formatIssue(issue)));
        }
        preview.append(ul);
      }
      const notable = prepared.items.filter(
        (item) => item.action !== "update" || item.blocked,
      );
      const rows = (notable.length > 0 ? notable : prepared.items).slice(
        0,
        100,
      );
      if (rows.length > 0) {
        const table = el(doc, "table", { class: "cs-items" });
        table.append(
          el(
            doc,
            "thead",
            {},
            el(
              doc,
              "tr",
              {},
              ...["Action", "ID", "Name", "County", "Note"].map((label) =>
                el(doc, "th", { scope: "col" }, label),
              ),
            ),
          ),
        );
        const body = el(doc, "tbody", {});
        for (const item of rows) body.append(itemRow(item));
        table.append(body);
        preview.append(table);
      }
    }

    function itemRow(item: ChangeItem): HTMLElement {
      const record = item.after ?? item.before;
      return el(
        doc,
        "tr",
        {},
        el(
          doc,
          "td",
          {},
          item.blocked ? `${item.action} (blocked)` : item.action,
        ),
        el(doc, "td", {}, item.entityId),
        el(doc, "td", {}, record?.name ?? ""),
        el(doc, "td", {}, item.countyFips),
        el(doc, "td", {}, item.reason ?? ""),
      );
    }

    prepare.addEventListener("click", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        say("Choose a county.csv file first.");
        return;
      }
      const mode = modeSelect.value as ImportMode;
      if (mode === "replace_county" && !selectedCounty) {
        say("Choose the county to replace first.");
        return;
      }
      try {
        const text = await file.text();
        prepared = await client.prepare({
          fileName: file.name,
          csv: text,
          mode,
          countyFips: mode === "replace_county" ? selectedCounty : null,
        });
        commitKey = newKey();
        say(
          prepared.committable
            ? "Preview ready. Nothing has changed yet."
            : "The file has problems or blocked changes. Nothing can be committed.",
        );
      } catch (error) {
        prepared = null;
        commitKey = null;
        say(describe(error));
      }
      renderPreview();
    });

    commit.addEventListener("click", async () => {
      if (!prepared || !commitKey) return;
      commit.disabled = true;
      try {
        const result = await client.commit(
          prepared.import.id,
          {
            changesetSha256: prepared.import.changesetSha256,
            expectedVersion: version,
          },
          commitKey,
        );
        say(
          result.noop
            ? "Nothing needed to change."
            : result.replayed
              ? "This import had already been committed."
              : "Import committed.",
        );
        prepared = null;
        commitKey = null;
        renderPreview();
        await refresh();
      } catch (error) {
        say(describe(error));
        commit.disabled = false;
      }
    });

    exportButton.addEventListener("click", async () => {
      try {
        const file = await client.exportCsv(selectedCounty ?? undefined);
        const fileName = selectedCounty
          ? `county-${selectedCounty}.csv`
          : "county.csv";
        if (options.download) options.download(fileName, file.csv);
        else downloadText(doc, fileName, file.csv);
        say(`Exported ${fileName}.`);
      } catch (error) {
        say(describe(error));
      }
    });

    // ---------------------------------------------------------- history
    function renderHistory(): void {
      clear(historyPanel);
      historyPanel.append(el(doc, "h3", {}, "Recent imports"));
      if (recent.length === 0) {
        historyPanel.append(
          el(doc, "p", { class: "cs-empty" }, "No imports yet."),
        );
        return;
      }
      const ul = el(doc, "ul", { class: "cs-imports" });
      for (const item of recent) {
        const li = el(
          doc,
          "li",
          {},
          `${item.createdAt} - ${item.fileName} (${item.mode}) - ${item.status}`,
        );
        if (item.status === "committed" && item.mode !== "reversal") {
          const reverse = el(doc, "button", { type: "button" }, "Reverse");
          reverse.addEventListener("click", async () => {
            try {
              await client.reverse(item.id, newKey());
              say("Import reversed.");
              await refresh();
            } catch (error) {
              say(describe(error));
            }
          });
          li.append(" ", reverse);
        }
        ul.append(li);
      }
      historyPanel.append(ul);
    }

    function renderAll(): void {
      renderCounts();
      renderTree();
      void renderEditor();
    }

    countySelect.addEventListener("change", () => {
      void loadCounty(countySelect.value || null);
    });

    renderPreview();
    renderHistory();
    renderAll();
    void refresh();

    return {
      canLeave: () => true,
      destroy() {
        destroyed = true;
        void destroyed;
        clear(container);
      },
    };
  };
}

function field(
  doc: Document,
  label: string,
  id: string,
  control: HTMLElement,
): HTMLElement {
  return el(
    doc,
    "div",
    { class: "cs-field" },
    el(doc, "label", { for: id }, label),
    control,
  );
}

function downloadText(doc: Document, fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = el(doc, "a", { href: url, download: fileName });
  doc.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

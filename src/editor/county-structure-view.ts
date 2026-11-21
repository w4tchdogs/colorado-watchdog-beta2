import {
  type ChangeItem,
  type CountyStructureLayout,
  type CountyStructurePinnedGroup,
  type CountySummary,
  type CsvIssue,
  IMPORT_MODES,
  type ImportMode,
  type ImportSummary,
  ORGANIZATION_TYPES,
  type ParentRelationship,
  type PreparedImport,
  type StructureRecord,
  UNIT_STATUSES,
  type UnitNode,
} from "../contracts/county-structure.js";
import type { AttachmentItem } from "../services/county-role-attachment.js";
import type {
  RoleAttachmentPreview,
  RoleAttachmentReceipt,
} from "../services/county-role-attachment-d1.js";
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
  stale_preview:
    "The roles, units or links changed after this preview. Please preview the file again.",
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

const placementParent = (record: StructureRecord): string | null =>
  record.parentId ?? record.displayGroupId;

const RELATIONSHIP_LABELS: Readonly<Record<ParentRelationship, string>> = {
  part_of: "Part of",
  reports_to: "Reports to",
  display_group: "Browse only",
};

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
    let countyLoad = 0;
    let drag: { unit: UnitNode; targets: ReadonlySet<string> } | null = null;
    let dropTarget: HTMLElement | null = null;
    let reordering = false;
    let prepared: PreparedImport | null = null;
    let commitKey: string | null = null;
    let recent: readonly ImportSummary[] = [];
    let attachmentPreview: RoleAttachmentPreview | null = null;
    let attachmentCsv: string | null = null;
    let attachmentFileName: string | null = null;
    let attachmentKey: string | null = null;
    let attachmentReceipt: RoleAttachmentReceipt | null = null;
    let countyLayout: CountyStructureLayout | null = null;
    let layoutLoad = 0;
    let layoutError: string | null = null;
    let layoutPending: {
      readonly countyFips: string;
      readonly expectedVersion: number;
      readonly pinnedGroups: readonly CountyStructurePinnedGroup[];
      readonly idempotencyKey: string;
    } | null = null;

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
    const tree = el(doc, "section", {
      class: "cs-tree",
      "aria-labelledby": "cs-hierarchy-title",
    });
    const editor = el(doc, "div", { class: "cs-editor" });
    const layoutPanel = el(doc, "section", {
      class: "cs-import cs-layout",
      "aria-labelledby": "cs-layout-title",
    });
    const importPanel = el(doc, "div", { class: "cs-import" });
    const attachmentPanel = el(doc, "div", {
      class: "cs-import cs-attachments",
    });
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
      layoutPanel,
      importPanel,
      attachmentPanel,
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
      const request = ++countyLoad;
      if (fips !== selectedCounty) {
        invalidateAttachmentPreview();
        detail = null;
      }
      selectedCounty = fips;
      void loadCountyLayout(fips);
      renderAttachmentPreview();
      selectedId = null;
      if (!fips) {
        renderAll();
        return;
      }
      if (!detail) renderAll();
      try {
        const result = await client.county(fips);
        if (destroyed || request !== countyLoad) return;
        detail = result;
        version = detail.version;
      } catch (error) {
        if (destroyed || request !== countyLoad) return;
        detail = null;
        say(describe(error));
      }
      renderAll();
    }

    async function loadCountyLayout(fips: string | null): Promise<void> {
      const request = ++layoutLoad;
      countyLayout = null;
      layoutError = null;
      layoutPending = null;
      renderCountyLayout();
      if (!fips) return;
      try {
        const result = await client.countyLayout(fips);
        if (destroyed || request !== layoutLoad || selectedCounty !== fips)
          return;
        countyLayout = result;
      } catch (error) {
        if (destroyed || request !== layoutLoad || selectedCounty !== fips)
          return;
        layoutError = describe(error);
        say(layoutError);
      }
      renderCountyLayout();
    }

    function renderCountyLayout(): void {
      clear(layoutPanel);
      layoutPanel.append(
        el(doc, "h3", { id: "cs-layout-title" }, "Public page layout"),
        el(
          doc,
          "p",
          { class: "cs-note" },
          "Pin a public County Structure group to the left or right column and set its vertical position. Unpinned groups use the masonry layout. These display preferences do not change the county.csv hierarchy.",
        ),
      );
      if (!selectedCounty) {
        layoutPanel.append(
          el(
            doc,
            "p",
            { class: "cs-empty" },
            "Choose a county to edit its public page layout.",
          ),
        );
        return;
      }
      if (!countyLayout) {
        layoutPanel.append(
          el(
            doc,
            "p",
            { class: "cs-empty" },
            layoutError ?? "Loading this county’s layout…",
          ),
        );
        return;
      }

      const pinned = new Map(
        countyLayout.pinnedGroups.map((item) => [item.groupId, item]),
      );
      const controls = new Map<
        string,
        { column: HTMLSelectElement; position: HTMLInputElement }
      >();
      const list = el(doc, "div", { class: "cs-layout-list" });
      countyLayout.availableGroups.forEach((group, index) => {
        const current = pinned.get(group.id);
        const columnId = `cs-layout-column-${index}`;
        const positionId = `cs-layout-position-${index}`;
        const column = el(doc, "select", {
          id: columnId,
          "aria-label": `Column for ${group.name}`,
        }) as HTMLSelectElement;
        column.append(
          el(doc, "option", { value: "" }, "Masonry (unpinned)"),
          el(doc, "option", { value: "left" }, "Left column"),
          el(doc, "option", { value: "right" }, "Right column"),
        );
        column.value = current?.column ?? "";
        const position = el(doc, "input", {
          id: positionId,
          type: "number",
          min: "1",
          max: "100",
          value: String(current?.position ?? 1),
          disabled: !current,
          "aria-label": `Position for ${group.name}`,
        }) as HTMLInputElement;
        column.addEventListener("change", () => {
          position.disabled = column.value === "";
          if (column.value) {
            const used = [...controls.entries()]
              .filter(
                ([otherId, control]) =>
                  otherId !== group.id && control.column.value === column.value,
              )
              .map(([, control]) => Number(control.position.value))
              .filter((value) => Number.isSafeInteger(value) && value > 0);
            position.value = String(Math.max(0, ...used) + 1);
          }
        });
        controls.set(group.id, { column, position });
        list.append(
          el(
            doc,
            "div",
            { class: "cs-layout-row" },
            el(doc, "strong", {}, group.name),
            field(doc, "Column", columnId, column),
            field(doc, "Position", positionId, position),
          ),
        );
      });

      const save = el(doc, "button", { type: "button" }, "Save public layout");
      save.addEventListener("click", async () => {
        const fips = selectedCounty;
        const before = countyLayout;
        if (!fips || !before) return;
        let pending = layoutPending;
        if (!pending) {
          const next: CountyStructurePinnedGroup[] = [];
          for (const [groupId, control] of controls) {
            if (!control.column.value) continue;
            const position = Number(control.position.value);
            if (
              !Number.isSafeInteger(position) ||
              position < 1 ||
              position > 100
            ) {
              say("Each pinned group needs a position from 1 to 100.");
              control.position.focus();
              return;
            }
            next.push({
              groupId,
              column: control.column.value as "left" | "right",
              position,
            });
          }
          for (const column of ["left", "right"] as const) {
            const positions = next
              .filter((pin) => pin.column === column)
              .map((pin) => pin.position)
              .sort((a, b) => a - b);
            if (positions.some((position, index) => position !== index + 1)) {
              say(
                `Positions in the ${column} column must be unique and start at 1 with no gaps.`,
              );
              const invalid = [...controls.values()].find(
                (control) => control.column.value === column,
              );
              invalid?.position.focus();
              return;
            }
          }
          pending = {
            countyFips: fips,
            expectedVersion: before.version,
            pinnedGroups: next,
            idempotencyKey: newKey(),
          };
          layoutPending = pending;
        }
        save.disabled = true;
        try {
          const result = await client.saveCountyLayout(
            pending.countyFips,
            {
              expectedVersion: pending.expectedVersion,
              pinnedGroups: pending.pinnedGroups,
            },
            pending.idempotencyKey,
          );
          layoutPending = null;
          if (selectedCounty !== pending.countyFips) return;
          countyLayout = {
            ...before,
            version: result.version,
            pinnedGroups: result.pinnedGroups,
          };
          say(
            result.noop
              ? "Public layout is already up to date."
              : result.replayed
                ? "This public layout change had already been saved."
                : "Public layout saved.",
          );
          renderCountyLayout();
        } catch (error) {
          say(describe(error));
          if (
            error instanceof CountyStructureApiError &&
            error.code === "stale_version"
          ) {
            layoutPending = null;
            await loadCountyLayout(fips);
          } else if (
            error instanceof CountyStructureApiError &&
            error.status === 0
          ) {
            for (const control of controls.values()) {
              control.column.disabled = true;
              control.position.disabled = true;
            }
            save.textContent = "Retry same save";
            save.disabled = false;
          } else {
            layoutPending = null;
            save.disabled = false;
          }
        }
      });
      layoutPanel.append(list, el(doc, "div", { class: "cs-actions" }, save));
    }

    function invalidateAttachmentPreview(): void {
      attachmentPreview = null;
      attachmentCsv = null;
      attachmentFileName = null;
      attachmentKey = null;
      attachmentReceipt = null;
      renderAttachmentPreview();
    }

    function countyLabel(fips: string): string {
      const county = counties.find((item) => item.fips === fips);
      return county ? `${county.name} (${fips})` : fips;
    }

    const attachmentFile = el(doc, "input", {
      id: "cs-role-file",
      type: "file",
      accept: ".csv,text/csv",
    });
    const attachmentPreviewPanel = el(doc, "div", { class: "cs-preview" });
    const attachmentCounty = el(
      doc,
      "p",
      { class: "cs-note", id: "cs-attachment-county" },
      "Choose a county above.",
    );
    const attachmentPrepare = el(
      doc,
      "button",
      { type: "button" },
      "Preview attachments",
    );
    const attachmentCommit = el(
      doc,
      "button",
      { type: "button", disabled: true },
      "Commit attachments",
    );
    attachmentPanel.append(
      el(doc, "h3", {}, "Attach Roles"),
      el(
        doc,
        "p",
        { class: "cs-note" },
        "Attach imported Profile roles to this county’s units using stable IDs from profile_role.csv. This action does not import County Structure or change Profile visibility.",
      ),
      attachmentCounty,
      field(doc, "profile_role.csv file", "cs-role-file", attachmentFile),
      el(
        doc,
        "div",
        { class: "cs-actions" },
        attachmentPrepare,
        attachmentCommit,
      ),
      attachmentPreviewPanel,
    );

    function renderAttachmentPreview(): void {
      clear(attachmentPreviewPanel);
      attachmentCounty.textContent = selectedCounty
        ? `Selected county: ${countyLabel(selectedCounty)}. File: ${attachmentFile.files?.[0]?.name ?? "Choose profile_role.csv"}.`
        : "Choose a county above.";
      const preview = attachmentPreview;
      attachmentCommit.disabled =
        !preview?.committable ||
        preview.counts.blocked > 0 ||
        preview.counts.attach + preview.counts.remap === 0;
      if (attachmentReceipt) {
        const receipt = attachmentReceipt;
        attachmentPreviewPanel.append(
          el(
            doc,
            "p",
            { role: "status" },
            `Receipt: ${receipt.attached} attached, ${receipt.remapped} remapped, ${receipt.unchanged} unchanged, ${receipt.skipped} skipped${receipt.replayed ? " (same-key retry)" : ""}.`,
          ),
        );
      }
      if (!preview) return;
      attachmentPreviewPanel.append(
        el(
          doc,
          "p",
          {},
          `Reviewing ${countyLabel(preview.countyFips)} · ${attachmentFileName ?? "profile_role.csv"}. ${preview.counts.attach} attachments, ${preview.counts.remap} remaps, ${preview.counts.unchanged} unchanged, ${preview.counts.unattached} rows with no unit ID (existing links kept), ${preview.counts.skipped} skipped, ${preview.counts.blocked} blockers. ${preview.counts.otherCounties} rows for other counties were not included.`,
        ),
      );
      if (preview.counts.skipped > 0)
        attachmentPreviewPanel.append(
          el(
            doc,
            "p",
            { class: "cs-note" },
            "Skipped roles have not been imported into Profiles yet. Import their Profiles, then preview this file again.",
          ),
        );
      if (!attachmentCsv || !attachmentFileName)
        attachmentCommit.disabled = true;
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
            ...["Row", "Role ID", "Action", "Unit ID", "Reason"].map((label) =>
              el(doc, "th", { scope: "col" }, label),
            ),
          ),
        ),
      );
      const body = el(doc, "tbody", {});
      for (const item of preview.items) body.append(attachmentRow(item));
      table.append(body);
      attachmentPreviewPanel.append(table);
    }

    function attachmentRow(item: AttachmentItem): HTMLElement {
      return el(
        doc,
        "tr",
        {},
        el(doc, "td", {}, String(item.line)),
        el(doc, "td", {}, item.roleKey),
        el(doc, "td", {}, item.action),
        el(doc, "td", {}, item.unitId ?? "—"),
        el(
          doc,
          "td",
          {},
          item.reason ??
            (item.action === "attach"
              ? "Will attach."
              : item.action === "remap"
                ? `Will move from ${item.currentUnitId}.`
                : ""),
        ),
      );
    }

    attachmentFile.addEventListener("change", () => {
      invalidateAttachmentPreview();
      attachmentReceipt = null;
      say("File changed. Preview it again before committing.");
    });
    attachmentPrepare.addEventListener("click", async () => {
      const file = attachmentFile.files?.[0];
      if (!selectedCounty) {
        say("Choose a county before previewing role attachments.");
        return;
      }
      if (!file) {
        say("Choose a profile_role.csv file first.");
        return;
      }
      invalidateAttachmentPreview();
      try {
        const csv = await file.text();
        const result = await client.previewRoleAttachments({
          csv,
          countyFips: selectedCounty,
        });
        attachmentCsv = csv;
        attachmentFileName = file.name;
        attachmentPreview = result;
        attachmentKey = newKey();
        attachmentReceipt = null;
        say(
          result.committable &&
            result.counts.blocked === 0 &&
            result.counts.attach + result.counts.remap > 0
            ? "Attachment preview ready. Nothing has changed yet."
            : "Review the attachment rows. Commit is available only when there are eligible changes and no blockers.",
        );
      } catch (error) {
        invalidateAttachmentPreview();
        say(describe(error));
      }
      renderAttachmentPreview();
    });
    attachmentCommit.addEventListener("click", async () => {
      if (
        !attachmentPreview ||
        !attachmentCsv ||
        !attachmentKey ||
        !selectedCounty
      )
        return;
      attachmentCommit.disabled = true;
      try {
        attachmentReceipt = await client.commitRoleAttachments(
          {
            csv: attachmentCsv,
            countyFips: attachmentPreview.countyFips,
            digest: attachmentPreview.digest,
          },
          attachmentKey,
        );
        attachmentPreview = null;
        attachmentCsv = null;
        attachmentFileName = null;
        attachmentKey = null;
        attachmentFile.value = "";
        renderAttachmentPreview();
        say(
          "Role attachments committed. The selected county has been refreshed.",
        );
        await loadCounty(selectedCounty);
      } catch (error) {
        if (
          error instanceof CountyStructureApiError &&
          error.code === "stale_preview"
        ) {
          invalidateAttachmentPreview();
          say(
            "This preview is stale. Please preview the file again before committing.",
          );
        } else {
          say(describe(error));
          renderAttachmentPreview();
        }
      }
    });

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
    function focusUnit(id: string): void {
      for (const button of Array.from(
        tree.querySelectorAll<HTMLButtonElement>("button[data-unit-id]"),
      )) {
        if (button.dataset.unitId === id) {
          button.focus();
          break;
        }
      }
    }

    function moveTargets(unit: UnitNode): UnitNode[] {
      if (!detail || unit.record.countyFips !== detail.county.fips) return [];
      const subtree = new Set(flatten([unit]).map((node) => node.record.id));
      return flatten(detail.roots).filter(
        (node) => !subtree.has(node.record.id),
      );
    }

    async function editWithArrow(
      event: KeyboardEvent,
      node: UnitNode,
      siblings: readonly UnitNode[],
      parent: UnitNode | null,
    ): Promise<void> {
      const record = node.record;
      if (
        !detail ||
        selectedId !== record.id ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      if (reordering || event.repeat) return;
      const index = siblings.indexOf(node);
      const previous = siblings[index - 1];
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (record.kind === "display_group") {
          say("Display groups stay at the top level.");
        } else if (event.key === "ArrowLeft") {
          if (parent) openMove(node, placementParent(parent.record));
          else say("This unit is already at the top level.");
        } else if (previous) {
          openMove(node, previous.record.id);
        } else {
          say("There is no previous sibling to move this unit under.");
        }
        return;
      }
      const offset = event.key === "ArrowUp" ? -1 : 1;
      const neighbor = siblings[index + offset];
      if (!neighbor) {
        say(
          offset < 0
            ? "Already first in this group."
            : "Already last in this group.",
        );
        return;
      }
      const orderedIds = siblings.map(({ record }) => record.id);
      orderedIds[index] = neighbor.record.id;
      orderedIds[index + offset] = record.id;
      reordering = true;
      try {
        await runEdit(
          {
            op: "reorder",
            countyFips: detail.county.fips,
            parentId: placementParent(record),
            orderedIds,
          },
          `${record.name} moved ${offset < 0 ? "up" : "down"}.`,
          detail.version,
          true,
        );
      } finally {
        reordering = false;
      }
    }

    function highlightDrop(target: HTMLElement | null): void {
      dropTarget?.classList.remove("is-drop-target");
      dropTarget = target;
      dropTarget?.classList.add("is-drop-target");
    }

    function endDrag(): void {
      highlightDrop(null);
      drag = null;
      tree.classList.remove("is-dragging");
    }

    function receiveDrop(target: HTMLElement, parentId: string | null): void {
      target.addEventListener("dragover", (event) => {
        if (!drag || (parentId !== null && !drag.targets.has(parentId))) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (dropTarget !== target) highlightDrop(target);
      });
      target.addEventListener("dragleave", (event) => {
        const next = event.relatedTarget;
        const NodeConstructor = doc.defaultView?.Node;
        if (
          dropTarget === target &&
          !(
            NodeConstructor &&
            next instanceof NodeConstructor &&
            target.contains(next)
          )
        ) {
          highlightDrop(null);
        }
      });
      target.addEventListener("drop", (event) => {
        if (!drag || (parentId !== null && !drag.targets.has(parentId))) return;
        event.preventDefault();
        const unit = drag.unit;
        endDrag();
        openMove(unit, parentId);
      });
    }

    function renderTree(): void {
      endDrag();
      clear(tree);
      tree.append(el(doc, "h3", { id: "cs-hierarchy-title" }, "Hierarchy"));
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
      const top = el(doc, "div", { class: "cs-drop-top" }, "Move to top level");
      receiveDrop(top, null);
      tree.append(top);
      if (detail.counts.units > 0) {
        tree.append(
          el(
            doc,
            "p",
            { class: "cs-note", id: "cs-hierarchy-help" },
            "Drag a unit onto its destination or choose Move unit. On a selected row, Up and Down reorder within the same level. Left moves out one level, and Right moves under the previous sibling. Review the placement before saving a level change.",
          ),
        );
      }
      const list = (
        nodes: readonly UnitNode[],
        parent: UnitNode | null,
      ): HTMLElement => {
        const ul = el(doc, "ul", { class: "cs-list", role: "group" });
        for (const node of nodes) {
          const record = node.record;
          const button = el(
            doc,
            "button",
            {
              type: "button",
              class: "cs-node",
              "data-unit-id": record.id,
              draggable: record.kind === "unit" ? "true" : null,
              "aria-pressed": record.id === selectedId ? "true" : "false",
              "aria-describedby":
                record.id === selectedId && detail?.counts.units
                  ? "cs-hierarchy-help"
                  : null,
              "aria-keyshortcuts":
                record.kind === "unit"
                  ? "ArrowUp ArrowDown ArrowLeft ArrowRight"
                  : "ArrowUp ArrowDown",
            },
            record.name,
            el(doc, "span", { class: "cs-tag" }, typeLabel(record)),
            record.relationship
              ? el(
                  doc,
                  "span",
                  { class: "cs-tag" },
                  RELATIONSHIP_LABELS[record.relationship],
                )
              : "",
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
            focusUnit(record.id);
          });
          button.addEventListener("keydown", (event) => {
            void editWithArrow(event, node, nodes, parent);
          });
          if (record.kind === "unit") {
            button.addEventListener("dragstart", (event) => {
              drag = {
                unit: node,
                targets: new Set(
                  moveTargets(node).map(({ record }) => record.id),
                ),
              };
              tree.classList.add("is-dragging");
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", record.id);
              }
            });
            button.addEventListener("dragend", endDrag);
          }
          receiveDrop(button, record.id);
          const item = el(doc, "li", {}, button);
          if (node.children.length > 0) item.append(list(node.children, node));
          ul.append(item);
        }
        return ul;
      };
      if (detail.roots.length > 0) tree.append(list(detail.roots, null));
      const addGroup = el(
        doc,
        "button",
        { type: "button", id: "cs-add-group" },
        "Add display group",
      );
      addGroup.addEventListener("click", () => openCreate("group", null));
      const addTop = el(
        doc,
        "button",
        { type: "button", id: "cs-add-top" },
        "Add top-level unit",
      );
      addTop.addEventListener("click", () => openCreate("unit", null));
      tree.append(el(doc, "div", { class: "cs-actions" }, addTop, addGroup));
    }

    function renderCounts(): void {
      if (!detail) {
        counts.textContent = "";
        return;
      }
      const c = detail.counts;
      const topLevel = c.units - c.subunits;
      const groups = `${c.displayGroups} display ${c.displayGroups === 1 ? "group" : "groups"}`;
      counts.textContent = `${c.units + c.displayGroups} entries: ${topLevel} top-level ${topLevel === 1 ? "unit" : "units"}, ${c.subunits} ${c.subunits === 1 ? "sub-unit" : "sub-units"} (under a unit or a display group) and ${groups}. ${c.profiles} linked Profiles, ${c.unresolved} needing review.`;
    }

    // ---------------------------------------------------------- edits
    async function runEdit(
      edit: { op: string; [key: string]: unknown },
      done: string,
      expectedVersion = version,
      focusEdited = false,
    ): Promise<void> {
      const county = selectedCounty;
      try {
        const result = await client.edit(expectedVersion, edit);
        version = result.structureVersion;
        say(done);
        const keep = focusEdited ? (result.entityId ?? selectedId) : selectedId;
        await refresh();
        if (
          keep &&
          detail?.county.fips === county &&
          findNode(detail.roots, keep)
        ) {
          selectedId = keep;
          renderTree();
          void renderEditor();
          if (focusEdited) focusUnit(keep);
        }
      } catch (error) {
        say(describe(error));
      }
    }

    function relationshipSelect(id: string): HTMLSelectElement {
      return el(
        doc,
        "select",
        { id },
        el(doc, "option", { value: "" }, "Choose a relationship"),
        ...Object.entries(RELATIONSHIP_LABELS).map(([value, label]) =>
          el(doc, "option", { value }, label),
        ),
      );
    }

    function placementText(
      parent: StructureRecord | null,
      relationship: string,
    ): string {
      if (!parent) return "Top level";
      if (relationship === "display_group")
        return `Browse only under ${parent.name}`;
      if (relationship === "reports_to") return `Reports to ${parent.name}`;
      if (relationship === "part_of") return `Part of ${parent.name}`;
      return `Choose how to place the unit under ${parent.name}.`;
    }

    function openCreate(
      kind: "unit" | "group",
      parent: StructureRecord | null,
    ): void {
      if (!detail) return;
      const { county, version: expectedVersion } = detail;
      const form = el(doc, "form", { class: "cs-hierarchy-form" });
      const name = el(doc, "input", {
        id: "cs-create-name",
        type: "text",
        required: true,
        maxlength: 300,
      });
      const type = el(
        doc,
        "select",
        { id: "cs-create-type" },
        ...ORGANIZATION_TYPES.map((value) =>
          el(doc, "option", { value, selected: value === "office" }, value),
        ),
      );
      const relationship = relationshipSelect("cs-create-relationship");
      relationship.required = parent?.kind === "unit";
      const summary = el(doc, "p", { class: "cs-note" });
      const placement = () =>
        parent?.kind === "display_group" ? "display_group" : relationship.value;
      const updateSummary = () => {
        summary.textContent = placementText(parent, placement());
      };
      updateSummary();
      relationship.addEventListener("change", updateSummary);
      const submit = el(doc, "button", { type: "submit" }, "Add");
      const cancel = el(doc, "button", { type: "button" }, "Cancel");
      cancel.addEventListener("click", () => {
        void renderEditor();
        if (selectedId) focusUnit(selectedId);
        else
          tree
            .querySelector<HTMLButtonElement>(
              kind === "group" ? "#cs-add-group" : "#cs-add-top",
            )
            ?.focus();
      });
      name.addEventListener("input", () => name.setCustomValidity(""));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submit.disabled || selectedCounty !== county.fips) return;
        const value = name.value.trim();
        if (!value) {
          name.setCustomValidity("Enter a name.");
          name.reportValidity();
          return;
        }
        if (!relationship.reportValidity()) return;
        submit.disabled = true;
        cancel.disabled = true;
        await runEdit(
          {
            op: kind === "group" ? "create_group" : "create_unit",
            countyFips: county.fips,
            name: value,
            ...(kind === "unit" ? { organizationType: type.value } : {}),
            ...(parent
              ? { parentId: parent.id, relationship: placement() }
              : {}),
          },
          "Added.",
          expectedVersion,
          true,
        );
        submit.disabled = false;
        cancel.disabled = false;
      });
      form.append(
        el(doc, "h3", {}, kind === "group" ? "Add display group" : "Add unit"),
        el(doc, "p", { class: "cs-note" }, county.name),
        field(doc, "Name", name.id, name),
        kind === "unit" ? field(doc, "Type", type.id, type) : "",
        relationship.required
          ? field(doc, "Relationship", relationship.id, relationship)
          : "",
        summary,
        el(doc, "div", { class: "cs-actions" }, submit, cancel),
      );
      clear(editor);
      editor.append(form);
      name.focus();
    }

    function openMove(
      unit: UnitNode,
      destination = placementParent(unit.record),
    ): void {
      if (!detail || unit.record.kind !== "unit") return;
      const { county, version: expectedVersion } = detail;
      const record = unit.record;
      if (record.countyFips !== county.fips) return;
      const targets = new Map(
        moveTargets(unit).map(({ record }) => [record.id, record]),
      );
      if (destination !== null && !targets.has(destination)) return;
      const previous = placementParent(record);
      const form = el(doc, "form", { class: "cs-hierarchy-form" });
      const parent = el(
        doc,
        "select",
        { id: "cs-move-destination" },
        el(doc, "option", { value: "" }, "Top level"),
        ...Array.from(targets.values(), (candidate) =>
          el(
            doc,
            "option",
            { value: candidate.id },
            candidate.kind === "display_group"
              ? `${candidate.name} (display group)`
              : candidate.name,
          ),
        ),
      );
      parent.value = destination ?? "";
      const relationship = relationshipSelect("cs-move-relationship");
      const relationshipField = field(
        doc,
        "Relationship",
        relationship.id,
        relationship,
      );
      const summary = el(doc, "p", { class: "cs-note", "aria-live": "polite" });
      const submit = el(doc, "button", { type: "submit" }, "Move");
      const cancel = el(doc, "button", { type: "button" }, "Cancel");
      const target = () => targets.get(parent.value) ?? null;
      const placement = () =>
        target()?.kind === "display_group"
          ? "display_group"
          : relationship.value;
      const updatePreview = () => {
        const next = target();
        const relation = next ? placement() : "";
        const unchanged =
          (next?.id ?? null) === previous &&
          relation === (record.relationship ?? "");
        submit.disabled = unchanged || (next !== null && !relation);
        summary.textContent = placementText(next, relation);
      };
      const selectDestination = () => {
        relationship.required = target()?.kind === "unit";
        relationshipField.hidden = !relationship.required;
        relationship.value =
          parent.value === previous ? (record.relationship ?? "") : "";
        updatePreview();
      };
      selectDestination();
      parent.addEventListener("change", selectDestination);
      relationship.addEventListener("change", updatePreview);
      cancel.addEventListener("click", () => {
        void renderEditor();
        focusUnit(record.id);
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submit.disabled || selectedCounty !== county.fips) return;
        const parentId = target()?.id ?? null;
        const relation = placement();
        submit.disabled = true;
        cancel.disabled = true;
        parent.disabled = true;
        relationship.disabled = true;
        await runEdit(
          {
            op: "move",
            id: record.id,
            parentId,
            ...(parentId ? { relationship: relation } : {}),
          },
          "Moved.",
          expectedVersion,
          true,
        );
        cancel.disabled = false;
        parent.disabled = false;
        relationship.disabled = false;
        updatePreview();
      });
      form.append(
        el(doc, "h3", {}, `Move ${record.name}`),
        el(
          doc,
          "p",
          { class: "cs-note" },
          `Current placement: ${placementText(
            previous ? (targets.get(previous) ?? null) : null,
            record.relationship ?? "",
          )}`,
        ),
        field(doc, "Destination", parent.id, parent),
        relationshipField,
        summary,
        el(doc, "div", { class: "cs-actions" }, submit, cancel),
      );
      selectedId = record.id;
      renderTree();
      clear(editor);
      editor.append(form);
      (destination !== previous && relationship.required
        ? relationship
        : parent
      ).focus();
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
      const move = el(doc, "button", { type: "button" }, "Move unit");
      move.addEventListener("click", () => openMove(node));
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
      const addChild = el(
        doc,
        "button",
        { type: "button" },
        isGroup ? "Add unit to group" : "Add sub-unit",
      );
      addChild.addEventListener("click", () => openCreate("unit", record));
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
        el(doc, "div", { class: "cs-actions" }, isGroup ? "" : move, addChild),
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

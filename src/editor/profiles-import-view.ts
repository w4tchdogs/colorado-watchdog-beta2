import type {
  ImportRowReport,
  ProfilesImportCounts,
  ProfilesImportFiles,
  ProfilesImportPreview,
  ProfilesImportReceipt,
} from "../contracts/profiles-import.js";
import { clear, el } from "./dom.js";
import { ProfilesApiError, type ProfilesClient } from "./profiles-client.js";

/**
 * Owner CSV import panel inside the Profiles tab (SYNC-1).
 *
 * Choose files, Preview, inspect the exact adds, updates, conflicts and
 * visibility, then Commit. The browser reads file text and sends it. It never
 * parses, matches or decides: the server previews read-only, binds the commit
 * to the reviewed digest, and writes through the shared sync service. New
 * Profiles are created hidden, so nothing becomes public until the owner
 * publishes it.
 */
export function createImportPanel(options: {
  readonly doc: Document;
  readonly client: ProfilesClient;
  readonly newKey: () => string;
  /** Called after a commit or reversal so the grid reloads. */
  readonly onChanged: () => void;
}): HTMLElement {
  const { doc, client } = options;
  let preview: ProfilesImportPreview | null = null;
  let files: ProfilesImportFiles | null = null;
  /** One key per reviewed digest, so a retry after a network failure replays. */
  let commitKey: { digest: string; key: string } | null = null;
  let receipt: ProfilesImportReceipt | null = null;
  let busy = false;

  const profileInput = el(doc, "input", {
    type: "file",
    accept: ".csv,text/csv",
    id: "import-profile-file",
  });
  const roleInput = el(doc, "input", {
    type: "file",
    accept: ".csv,text/csv",
    id: "import-role-file",
  });
  const status = el(doc, "p", {
    class: "cw-import-status",
    role: "status",
    "aria-live": "polite",
  });
  const results = el(doc, "div", { class: "cw-import-results" });
  const previewButton = el(
    doc,
    "button",
    { type: "button", id: "import-preview" },
    "Preview import",
  );
  const commitButton = el(
    doc,
    "button",
    { type: "button", id: "import-commit", disabled: true },
    "Commit import",
  );
  const reverseButton = el(
    doc,
    "button",
    { type: "button", id: "import-reverse", hidden: true },
    "Reverse this import",
  );

  const say = (text: string) => {
    status.textContent = text;
  };
  const setBusy = (value: boolean) => {
    busy = value;
    for (const control of [
      previewButton,
      commitButton,
      reverseButton,
    ] as HTMLButtonElement[])
      if (value) control.setAttribute("disabled", "");
    if (!value) refreshControls();
  };
  const refreshControls = () => {
    if (busy) return;
    const reviewable =
      preview?.canCommit === true &&
      !receipt &&
      preview.profiles.add +
        preview.profiles.update +
        preview.roles.add +
        preview.roles.update +
        preview.sources.add +
        preview.sources.update >
        0;
    toggle(commitButton, !reviewable);
    toggle(previewButton, false);
    toggle(reverseButton, false);
    reverseButton.hidden = !(
      receipt &&
      receipt.status === "committed" &&
      receipt.batchId
    );
  };
  const toggle = (button: HTMLButtonElement, disabled: boolean) => {
    if (disabled) button.setAttribute("disabled", "");
    else button.removeAttribute("disabled");
  };

  function failureText(error: unknown): string {
    if (error instanceof ProfilesApiError) {
      if (error.status === 409 && error.code === "stale_preview")
        return "The Website or the files changed since this preview. Nothing was written. Preview again.";
      if (error.status === 409 && error.code === "reversal_blocked")
        return "This import cannot be reversed because other records now depend on it. Nothing was changed.";
      if (error.status === 409)
        return "This request conflicts with an earlier one. Nothing was written.";
      if (error.status === 401 || error.status === 403)
        return "You are not signed in as an owner who can import Profiles.";
      if (error.status === 422)
        return "The import has blocking issues. Nothing was written.";
      if (error.status === 413) return "The files are too large.";
      if (error.status === 0)
        return "The network failed. Nothing is known to be written. Retry the same step to be safe.";
      return "The import could not be completed. Nothing was written.";
    }
    return "The import could not be completed. Nothing was written.";
  }

  async function readFile(input: HTMLInputElement): Promise<string | null> {
    const file = input.files?.[0];
    return file ? await file.text() : null;
  }

  previewButton.addEventListener("click", async () => {
    if (busy) return;
    const profile = await readFile(profileInput);
    if (profile === null) {
      say("Choose profile.csv first.");
      return;
    }
    const role = await readFile(roleInput);
    files = { profile, ...(role !== null ? { profileRole: role } : {}) };
    receipt = null;
    setBusy(true);
    say("Reading the files. Nothing is written during a preview.");
    try {
      preview = await client.importPreview(files);
      render();
      say(
        preview.canCommit
          ? "Preview ready. Review every row, then choose Commit import."
          : "Preview has blocking issues. Fix the files and preview again. Nothing was written.",
      );
    } catch (error) {
      preview = null;
      render();
      say(failureText(error));
    } finally {
      setBusy(false);
    }
  });

  commitButton.addEventListener("click", async () => {
    if (busy || !preview || !files || !preview.canCommit) return;
    if (!commitKey || commitKey.digest !== preview.digest)
      commitKey = { digest: preview.digest, key: options.newKey() };
    setBusy(true);
    say("Committing. All changes are written together or not at all.");
    try {
      receipt = await client.importCommit(files, preview.digest, commitKey.key);
      render();
      say(
        receipt.status === "nothing_to_commit"
          ? "Nothing to commit. The Website already matches the file."
          : receipt.replayed
            ? "This import was already committed. Showing its receipt."
            : "Committed. New Profiles are hidden until you publish them.",
      );
      options.onChanged();
    } catch (error) {
      say(failureText(error));
      if (
        error instanceof ProfilesApiError &&
        error.status === 409 &&
        error.code === "stale_preview"
      ) {
        preview = null;
        render();
      }
    } finally {
      setBusy(false);
    }
  });

  reverseButton.addEventListener("click", async () => {
    if (busy || !receipt?.batchId) return;
    setBusy(true);
    say("Reversing this import.");
    try {
      await client.importReverse(receipt.batchId, options.newKey());
      receipt = null;
      preview = null;
      render();
      say(
        "Import reversed. The records it created were removed. Preview again to re-import.",
      );
      options.onChanged();
    } catch (error) {
      say(failureText(error));
    } finally {
      setBusy(false);
    }
  });

  function countsRow(label: string, c: ProfilesImportCounts): HTMLElement {
    return el(
      doc,
      "tr",
      {},
      el(doc, "th", { scope: "row" }, label),
      ...(["add", "update", "unchanged", "conflict", "blocked"] as const).map(
        (k) => el(doc, "td", {}, String(c[k])),
      ),
    );
  }

  function rowLine(row: ImportRowReport): HTMLElement {
    const changes = (row.fields ?? [])
      .map(
        (f) =>
          `${f.field}: ${f.current ?? "(empty)"} to ${f.proposed ?? "(empty)"}`,
      )
      .join("; ");
    return el(
      doc,
      "tr",
      { "data-action": row.action },
      el(doc, "td", {}, row.action),
      el(doc, "td", {}, row.kind),
      el(doc, "td", {}, row.key),
      el(doc, "td", {}, row.label),
      el(doc, "td", {}, visibilityText(row.visibility)),
      el(doc, "td", {}, [changes, row.reason].filter(Boolean).join(" ")),
    );
  }

  function visibilityText(v: ImportRowReport["visibility"]): string {
    return v === "hidden_on_create"
      ? "Created hidden"
      : v === "stays_hidden"
        ? "Stays hidden"
        : v === "stays_visible"
          ? "Stays visible"
          : "";
  }

  function render(): void {
    clear(results);
    if (receipt) {
      results.appendChild(
        el(
          doc,
          "div",
          { class: "cw-import-receipt", id: "import-receipt" },
          el(doc, "h3", {}, "Import receipt"),
          el(
            doc,
            "p",
            {},
            receipt.status === "nothing_to_commit"
              ? "Nothing needed to change."
              : `Batch ${receipt.batchId}. Created ${receipt.created.profiles} Profiles, ${receipt.created.roles} roles and ${receipt.created.sources} sources (${receipt.created.reusedSources} existing sources reused). Updated ${receipt.updated.profiles} Profiles and ${receipt.updated.roles} roles. ${receipt.newProfilesHidden} new Profiles are hidden until you publish them.`,
          ),
        ),
      );
      return;
    }
    if (!preview) return;
    const p = preview;
    results.appendChild(
      el(
        doc,
        "div",
        { class: "cw-import-preview", id: "import-preview-result" },
        el(doc, "h3", {}, "Preview"),
        el(
          doc,
          "table",
          { class: "cw-import-counts" },
          el(
            doc,
            "thead",
            {},
            el(
              doc,
              "tr",
              {},
              el(doc, "th", { scope: "col" }, "Records"),
              ...["Add", "Update", "Unchanged", "Conflict", "Blocked"].map(
                (h) => el(doc, "th", { scope: "col" }, h),
              ),
            ),
          ),
          el(
            doc,
            "tbody",
            {},
            countsRow("Profiles", p.profiles),
            countsRow("Roles", p.roles),
            countsRow("Sources", p.sources),
          ),
        ),
        el(
          doc,
          "p",
          { id: "import-visibility" },
          `${p.newProfilesHidden} new Profiles will be created hidden and stay hidden until you publish them. Existing Profiles keep their current visibility.`,
        ),
        el(
          doc,
          "p",
          {},
          `Not in the file and left untouched: ${p.untouchedProfiles} Profiles and ${p.untouchedRoles} roles.`,
        ),
        ...p.notes.map((n) => el(doc, "p", { class: "cw-import-note" }, n)),
        ...p.ignoredColumns.map((c) =>
          el(
            doc,
            "p",
            { class: "cw-import-note" },
            `${c.file}: columns not imported in this version: ${c.columns.join(", ")}.`,
          ),
        ),
      ),
    );
    if (p.issues.length) {
      results.appendChild(
        el(
          doc,
          "div",
          { class: "cw-import-issues", role: "alert" },
          el(doc, "h3", {}, "Blocking issues"),
          el(
            doc,
            "ul",
            {},
            ...p.issues.map((i) =>
              el(
                doc,
                "li",
                {},
                `${i.file}${i.line ? ` line ${i.line}` : ""}${i.key ? ` (${i.key})` : ""}: ${i.message}`,
              ),
            ),
          ),
        ),
      );
    }
    if (p.rows.length) {
      results.appendChild(
        el(
          doc,
          "table",
          { class: "cw-import-rows" },
          el(
            doc,
            "caption",
            {},
            p.rowsTruncated
              ? "First rows of the preview. Conflicts and blocked rows come first."
              : "Every row in the files",
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
                "Action",
                "Kind",
                "Key",
                "Label",
                "Visibility",
                "Details",
              ].map((h) => el(doc, "th", { scope: "col" }, h)),
            ),
          ),
          el(doc, "tbody", {}, ...p.rows.map(rowLine)),
        ),
      );
    }
  }

  const panel = el(
    doc,
    "details",
    { class: "cw-profiles-import", id: "profiles-import" },
    el(doc, "summary", {}, "Import CSV"),
    el(
      doc,
      "p",
      {},
      "Upload reviewed profile.csv, and optionally profile_role.csv with its source columns. Preview changes nothing. New Profiles are created hidden.",
    ),
    el(
      doc,
      "div",
      { class: "cw-import-fields" },
      el(doc, "label", { for: "import-profile-file" }, "profile.csv"),
      profileInput,
      el(
        doc,
        "label",
        { for: "import-role-file" },
        "profile_role.csv (optional)",
      ),
      roleInput,
    ),
    el(
      doc,
      "div",
      {
        class: "cw-import-actions",
        role: "toolbar",
        "aria-label": "Import actions",
      },
      previewButton,
      commitButton,
      reverseButton,
    ),
    status,
    results,
  );
  return panel;
}

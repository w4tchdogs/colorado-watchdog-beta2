import {
  formatEventDate,
  type ReportGrievance,
  reportGrievanceTitle,
  reportGrievanceType,
} from "../contracts/report-grievances.js";

type EmployeeNames = Record<
  string,
  {
    name: string;
    roles: Record<
      string,
      {
        title: string | null;
        office: string | null;
        sourceCheckedAt: string;
        startDate: string | null;
        endDate: string | null;
      }
    >;
  }
>;

type Status =
  | "submitted"
  | "triage"
  | "under-review"
  | "needs-information"
  | "accepted"
  | "declined"
  | "closed";
interface QueueItem {
  id: string;
  countyId: string;
  countyName?: string;
  subject?: { kind: string; id: string };
  status: Status;
  version: number;
  createdAt: string;
}
interface Report extends QueueItem {
  description: string;
  headline?: string;
  grievances?: ReportGrievance[];
  countyNames?: Record<string, string>;
  employees?: EmployeeNames;
  reporter: {
    name?: string;
    email?: string;
    attribution: string;
    contactPreference: string;
    confidential: boolean;
  };
  evidence: Array<{ title: string; url?: string; note?: string }>;
}
interface HistoryItem {
  from: Status | null;
  to: Status;
  at: string;
  actor: { kind: string; accountId?: string; role?: string };
  note?: string;
  version: number;
}

const root = document.querySelector<HTMLElement>(".staff-reports");
if (root) start(root);

function start(root: HTMLElement): void {
  const required = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element)
      throw new Error(`Missing staff interface element: ${selector}`);
    return element;
  };
  const status = required<HTMLElement>("#staff-status");
  const list = required<HTMLElement>("#staff-queue-list");
  const filter = required<HTMLSelectElement>("#staff-filter");
  const next = required<HTMLButtonElement>("#staff-next");
  const refresh = required<HTMLButtonElement>("#staff-refresh");
  const detail = required<HTMLElement>("#staff-detail");
  let cursor: string | null = null;
  let currentReportId: string | null = null;
  let selectedButton: HTMLButtonElement | null = null;
  let loading = false;

  const announce = (message: string) => {
    status.textContent = message;
  };
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { ...(init?.headers ?? {}) },
    });
    if (!response.ok)
      throw Object.assign(new Error("The request could not be completed."), {
        status: response.status,
      });
    return response.json() as Promise<T>;
  }
  async function loadQueue(reset = false): Promise<void> {
    if (loading) return;
    loading = true;
    if (reset) {
      cursor = null;
      list.replaceChildren();
    }
    list.setAttribute("aria-busy", "true");
    next.disabled = true;
    announce("Loading report queue…");
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (cursor) params.set("after", cursor);
      if (filter.value) params.set("status", filter.value);
      const result = await api<{ reports: QueueItem[]; next: string | null }>(
        `/api/v1/reports?${params}`,
      );
      if (!result.reports.length && reset) {
        const empty = document.createElement("p");
        empty.className = "staff-empty";
        empty.textContent = "No reports match this filter.";
        list.append(empty);
      }
      for (const item of result.reports) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "staff-queue-item";
        button.dataset.reportId = item.id;
        button.setAttribute(
          "aria-label",
          `Review report ${item.id}, ${item.countyId}, ${item.status}`,
        );
        const heading = document.createElement("strong");
        heading.textContent = `Report ${item.id}`;
        const meta = document.createElement("span");
        meta.textContent = `County ${item.countyName ?? item.countyId} · ${label(item.status)} · ${date(item.createdAt)} · Version ${item.version}`;
        button.append(heading, meta);
        if (item.subject) {
          const subject = document.createElement("span");
          subject.textContent = `Subject reference: ${item.subject.kind} ${item.subject.id}`;
          button.append(subject);
        }
        button.addEventListener("click", () => {
          selectedButton?.removeAttribute("aria-current");
          selectedButton = button;
          button.setAttribute("aria-current", "true");
          void loadDetail(item.id);
        });
        list.append(button);
      }
      cursor = result.next;
      next.disabled = !cursor;
      announce(
        result.reports.length
          ? `${result.reports.length} report${result.reports.length === 1 ? "" : "s"} loaded.`
          : "No reports found.",
      );
    } catch (error) {
      announce(errorMessage(error));
    } finally {
      list.setAttribute("aria-busy", "false");
      loading = false;
    }
  }
  async function loadDetail(id: string, focus = true): Promise<void> {
    currentReportId = id;
    announce("Loading confidential report details…");
    detail.replaceChildren();
    const title = document.createElement("h2");
    title.id = "detail-title";
    title.textContent = `Report ${id}`;
    detail.append(title);
    try {
      const [
        { report, allowedNextStatuses, countyName, countyNames, employees },
        { history },
      ] = await Promise.all([
        api<{
          report: Report;
          countyName: string;
          countyNames?: Record<string, string>;
          employees?: EmployeeNames;
          allowedNextStatuses: Status[];
        }>(`/api/v1/reports/${encodeURIComponent(id)}`),
        api<{ history: HistoryItem[] }>(
          `/api/v1/reports/${encodeURIComponent(id)}/history`,
        ),
      ]);
      if (currentReportId !== id) return;
      renderReport(
        { ...report, countyName, countyNames, employees },
        history,
        allowedNextStatuses,
      );
      announce(`Report ${id} loaded. Unverified allegation.`);
      if (focus) detail.focus();
    } catch (error) {
      detail.replaceChildren(title, text("p", errorMessage(error)));
      announce(errorMessage(error));
    }
  }
  function renderReport(
    report: Report,
    history: HistoryItem[],
    allowedNextStatuses: Status[],
  ): void {
    detail.replaceChildren();
    const title = document.createElement("h2");
    title.id = "detail-title";
    title.textContent = `Report ${report.id}`;
    detail.append(title);
    const alert = document.createElement("p");
    alert.className = "staff-allegation-notice";
    alert.textContent =
      "Unverified allegation — the report content below has not been independently established.";
    detail.append(alert);
    const summary = section("Report information");
    summary.append(
      pair("County", report.countyName ?? report.countyId),
      pair("County FIPS", report.countyId),
      pair("Submitted", date(report.createdAt)),
      pair("Status", label(report.status)),
      pair("Record version", String(report.version)),
    );
    if (report.subject)
      summary.append(
        pair(
          "Subject reference",
          `${report.subject.kind}: ${report.subject.id}`,
        ),
      );
    if (report.grievances?.length) {
      if (report.headline)
        summary.append(pair("Proposed headline", report.headline));
      report.grievances.forEach((item, index) => {
        const card = document.createElement("article");
        card.className = "staff-grievance";
        card.append(
          text(
            "h3",
            `Grievance ${index + 1}${"catalogId" in item ? `: ${reportGrievanceTitle(item)}` : ""}`,
          ),
          pair("Type", reportGrievanceType(item)),
          ...("catalogId" in item
            ? [pair("Inventory ID", String(item.catalogId))]
            : []),
          pair("Event date", formatEventDate(item.date)),
          pair(
            "County at the event",
            `${report.countyNames?.[item.countyId] ?? item.countyId} (${item.countyId})`,
          ),
        );
        if (item.subject.kind === "listed") {
          const person = report.employees?.[item.subject.personId];
          const role = person?.roles[item.subject.roleId];
          card.append(
            pair(
              "Listed employee",
              `${person?.name ?? "Name unavailable"} (${item.subject.personId})`,
            ),
            pair(
              "Selected role",
              role
                ? `${role.title ?? "Title not recorded"} · ${role.office ?? "Office not recorded"} · source checked ${role.sourceCheckedAt.slice(0, 10)}${role.startDate || role.endDate ? ` · documented ${role.startDate ?? "start not recorded"} to ${role.endDate ?? "no end recorded"}` : ""}`
                : "Role details unavailable",
            ),
            pair("Role ID", item.subject.roleId),
          );
        } else {
          card.append(
            pair("Unlisted employee", item.subject.name),
            pair("Office or department", item.subject.office),
          );
        }
        if (item.position)
          card.append(pair("Position at the event", item.position));
        card.append(
          pair(
            "Identification basis",
            item.identificationBasis === "documented"
              ? "Documented context"
              : "As described by contributor",
          ),
          text("h4", "Details"),
          text("p", item.details),
        );
        summary.append(card);
      });
    } else {
      summary.append(
        text("h3", "Submitted description"),
        text("p", report.description),
      );
    }
    detail.append(summary);
    const reporter = section("Reporter information");
    reporter.append(
      pair("Attribution", report.reporter.attribution),
      pair("Contact preference", report.reporter.contactPreference),
      pair("Confidential", report.reporter.confidential ? "Yes" : "No"),
    );
    if (report.reporter.name)
      reporter.append(pair("Name", report.reporter.name));
    if (report.reporter.email)
      reporter.append(pair("Email", report.reporter.email));
    detail.append(reporter);
    const evidence = section("Reporter-submitted evidence");
    if (!report.evidence.length)
      evidence.append(text("p", "No evidence entries were submitted."));
    for (const item of report.evidence) {
      const entry = document.createElement("article");
      entry.className = "staff-evidence";
      entry.append(text("h4", item.title));
      if (item.note) entry.append(text("p", item.note));
      if (item.url) {
        const safe = safeHttps(item.url);
        if (safe) {
          const link = document.createElement("a");
          link.href = safe;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          link.textContent = safe;
          entry.append(link);
        } else
          entry.append(
            text(
              "p",
              "Evidence URL omitted because it is not a safe HTTPS link.",
            ),
          );
      }
      evidence.append(entry);
    }
    detail.append(evidence);
    const historySection = section("Private review history");
    if (!history.length)
      historySection.append(text("p", "No review history is available."));
    for (const event of history) {
      const entry = document.createElement("article");
      entry.className = "staff-history";
      entry.append(
        text(
          "h4",
          `${event.from ? label(event.from) : "Created"} → ${label(event.to)}`,
        ),
        pair("Time", date(event.at)),
        pair(
          "Actor",
          `${event.actor.role ?? event.actor.kind}${event.actor.accountId ? ` · ${event.actor.accountId}` : ""}`,
        ),
        pair("Record version", String(event.version)),
      );
      if (event.note) {
        const note = document.createElement("p");
        note.className = "staff-private-note";
        note.append(
          text("strong", "Private staff note: "),
          document.createTextNode(event.note),
        );
        entry.append(note);
      }
      historySection.append(entry);
    }
    detail.append(historySection, statusForm(report, allowedNextStatuses));
  }
  function statusForm(
    report: Report,
    allowedNextStatuses: Status[],
  ): HTMLElement {
    const form = document.createElement("form");
    form.className = "staff-status-form";
    form.append(text("h3", "Change status"));
    const labelEl = document.createElement("label");
    labelEl.htmlFor = "staff-next-status";
    labelEl.textContent = "Next status";
    const select = document.createElement("select");
    select.id = "staff-next-status";
    select.required = true;
    for (const value of allowedNextStatuses) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label(value);
      select.append(option);
    }
    form.append(labelEl, select);
    const noteLabel = document.createElement("label");
    noteLabel.htmlFor = "staff-private-note";
    noteLabel.textContent = "Private staff note (optional)";
    const note = document.createElement("textarea");
    note.id = "staff-private-note";
    note.maxLength = 4000;
    const help = text(
      "p",
      "Visible to authorized staff only. This note is not shown to reporters.",
    );
    help.id = "staff-note-help";
    note.setAttribute("aria-describedby", help.id);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Save status change";
    form.append(noteLabel, note, help, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      announce("Saving status change…");
      try {
        await api(`/api/v1/reports/${encodeURIComponent(report.id)}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: report.version,
            status: select.value,
            ...(note.value ? { note: note.value } : {}),
          }),
        });
        await loadQueue(true);
        await loadDetail(report.id, false);
        announce("Status change saved. Report details and history refreshed.");
      } catch (error) {
        if ((error as { status?: number }).status === 409) {
          await loadDetail(report.id, false);
          await loadQueue(true);
          announce(
            "This report changed since it was loaded. The latest state has been reloaded; review it before trying again.",
          );
        } else announce(errorMessage(error));
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }
  filter.addEventListener("change", () => {
    selectedButton = null;
    currentReportId = null;
    detail.replaceChildren(
      text("h2", "Report details"),
      text(
        "p",
        "Select a report from the queue to review its confidential details.",
      ),
    );
    void loadQueue(true);
  });
  next.addEventListener("click", () => void loadQueue(false));
  refresh.addEventListener("click", () => {
    void loadQueue(true);
    if (currentReportId) void loadDetail(currentReportId, false);
  });
  void loadQueue(true);

  function errorMessage(error: unknown): string {
    const code = (error as { status?: number }).status;
    if (code === 401 || code === 403)
      return "Your staff access is unavailable. Sign in with an authorized account and reload.";
    if (code === 404) return "This report is unavailable or no longer exists.";
    return "Reports could not be loaded. Please refresh and try again.";
  }
}

function text(tag: string, value: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
function section(title: string): HTMLElement {
  const element = document.createElement("section");
  element.className = "staff-card";
  element.append(text("h3", title));
  return element;
}
function pair(name: string, value: string): HTMLElement {
  const element = document.createElement("p");
  const label = document.createElement("strong");
  label.textContent = `${name}: `;
  element.append(label, document.createTextNode(value));
  return element;
}
function label(value: string): string {
  return value
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}
function safeHttps(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

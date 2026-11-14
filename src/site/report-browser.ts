import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import type { ReportSubmission } from "../contracts/report-intake.js";
import { mountReportInterface } from "./report-interface.js";

const root = document.getElementById("report-interface-root");
if (root) {
  const counties = JSON.parse(
    root.getAttribute("data-report-counties") ?? "[]",
  ) as CountyRegistryEntry[];
  const enabled = root.getAttribute("data-report-enabled") === "true";
  if (root.getAttribute("data-report-mode") === "track") {
    window.history.replaceState(null, "", `${location.pathname}#report-track`);
  }
  mountReportInterface(root, {
    counties,
    trackingHref: "/track-report",
    demoNotice: enabled
      ? "Local fictional-data test only. Do not enter real information."
      : "Report submission is currently unavailable. Do not enter real information.",
    adapter: {
      async submit(input: ReportSubmission) {
        const response = await fetch("/api/v1/reports", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error("Submission unavailable");
        const value = (await response.json()) as {
          reference: string;
          recoveryKey?: string;
        };
        return value;
      },
      async track(reference, recoveryKey) {
        const response = await fetch("/api/v1/reports/track", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reference, recoveryKey }),
        });
        if (!response.ok) throw new Error("Tracking unavailable");
        return (await response.json()) as {
          status:
            | "submitted"
            | "triage"
            | "under-review"
            | "needs-information"
            | "accepted"
            | "declined"
            | "closed";
          submittedAt: string;
          history: Array<{
            from:
              | "submitted"
              | "triage"
              | "under-review"
              | "needs-information"
              | "accepted"
              | "declined"
              | "closed"
              | null;
            to:
              | "submitted"
              | "triage"
              | "under-review"
              | "needs-information"
              | "accepted"
              | "declined"
              | "closed";
            at: string;
          }>;
        };
      },
    },
  });
}

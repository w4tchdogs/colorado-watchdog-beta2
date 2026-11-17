import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import type { ReportSubmission } from "../contracts/report-intake.js";
import { CHALLENGE_TOKEN_HEADER } from "../services/report-challenge.js";
import {
  mountReportInterface,
  ReportChallengeRejectedError,
} from "./report-interface.js";
import { createTurnstileChallenge } from "./turnstile-widget.js";

const root = document.getElementById("report-interface-root");
if (root) {
  const counties = JSON.parse(
    root.getAttribute("data-report-counties") ?? "[]",
  ) as CountyRegistryEntry[];
  const enabled = root.getAttribute("data-report-enabled") === "true";
  const mode = root.getAttribute("data-report-mode");
  const accountId = root.getAttribute("data-report-account-id");
  if (mode === "track") {
    window.history.replaceState(null, "", `${location.pathname}#report-track`);
  }
  const sitekey = root.getAttribute("data-report-challenge-sitekey");
  const challenge =
    enabled && sitekey ? createTurnstileChallenge(sitekey) : undefined;
  mountReportInterface(root, {
    counties,
    ...(challenge ? { challenge } : {}),
    ...(mode === "guest" || mode === "account" ? { submissionFlow: mode } : {}),
    ...(mode === "account" && accountId ? { account: { accountId } } : {}),
    submitHref: "/submit-report",
    trackingHref: "/track-report",
    submissionsEnabled:
      enabled &&
      (mode === "guest" || (mode === "account" && Boolean(accountId))),
    ...(enabled && mode !== "track" && !challenge
      ? {
          demoNotice:
            "Local fictional-data test only. Do not enter real information.",
        }
      : {}),
    adapter: {
      async submit(input: ReportSubmission, context) {
        const response = await fetch("/api/v1/reports", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...(context?.challengeToken
              ? { [CHALLENGE_TOKEN_HEADER]: context.challengeToken }
              : {}),
          },
          body: JSON.stringify(input),
        });
        if (response.status === 429 && context?.challengeToken)
          throw new ReportChallengeRejectedError("Challenge rejected");
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

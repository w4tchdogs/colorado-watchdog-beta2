import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import {
  REPORT_ACCOUNT_EXPECTATION_HEADER,
  type ReportSubmission,
} from "../contracts/report-intake.js";
import { CHALLENGE_TOKEN_HEADER } from "../services/report-challenge.js";
import type { ReportDirectoryClient } from "./report-grievance-form.js";
import {
  mountReportInterface,
  ReportAccountChangedError,
  ReportChallengeRejectedError,
} from "./report-interface.js";
import { createTurnstileChallenge } from "./turnstile-widget.js";

async function directoryJson<T>(params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const response = await fetch(
    `/submit-report/directory${query.size ? `?${query}` : ""}`,
    { credentials: "same-origin", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error("Directory unavailable");
  return (await response.json()) as T;
}

function createDirectoryClient(): ReportDirectoryClient {
  return {
    search: ({ county, office, query, page }) =>
      directoryJson({ county, office, q: query, page: String(page) }),
    offices: (county) => directoryJson({ offices: county }),
    roles: (personId) => directoryJson({ person: personId }),
  };
}

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
    directory: createDirectoryClient(),
    ...(challenge ? { challenge } : {}),
    ...(mode === "guest" || mode === "account" ? { submissionFlow: mode } : {}),
    ...(mode === "account" && accountId ? { account: { accountId } } : {}),
    submitHref: "/submit-report",
    accountRecovery: {
      signInHref: `/auth/login?return_to=${encodeURIComponent("/submit-report?account=1")}`,
      reloadHref: "/submit-report?account=1",
    },
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
            ...(context?.accountExpectation
              ? {
                  [REPORT_ACCOUNT_EXPECTATION_HEADER]:
                    context.accountExpectation,
                }
              : {}),
          },
          body: JSON.stringify(input),
        });
        if (
          context?.accountExpectation &&
          (response.status === 401 || response.status === 409)
        )
          throw new ReportAccountChangedError("Account changed");
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

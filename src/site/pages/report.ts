import { html } from "../html.js";
import type { AccountEntry, Page, SiteContext } from "../types.js";

type ReportPageMode = "choose" | "guest" | "account" | "track";
const ACCOUNT_REPORT = "/submit-report?account=1";
const ACCOUNT_LOGIN = `/auth/login?return_to=${encodeURIComponent(ACCOUNT_REPORT)}`;

export async function reportPage(
  context: SiteContext,
  mode: ReportPageMode,
  entry: AccountEntry | null,
  accountId?: string | null,
): Promise<Page> {
  const tracking = mode === "track";
  const available = context.reportSubmissionsEnabled === true;
  const guestAvailable = available && context.reportGuestEnabled === true;
  const showForm =
    (guestAvailable && mode === "guest") ||
    (available && mode === "account" && Boolean(accountId));
  const accountAvailable = available && entry !== null;
  const accountHref =
    entry === "signed-in" && mode === "choose" ? ACCOUNT_REPORT : ACCOUNT_LOGIN;

  if (!tracking && !showForm) {
    return {
      title: "Submit a Report",
      description: "Choose how to send a report for private editorial review.",
      head: html`<link rel="stylesheet" href="/assets/report-interface.css">`,
      body: html`<section class="report-interface report-entry" data-report-enabled="${available ? "true" : "false"}" aria-labelledby="report-entry-heading">
        <p class="eyebrow">${guestAvailable && !context.reportChallenge ? "Local preview · Fictional reports only" : "Private editorial review"}</p>
        <h1 class="report-heading" id="report-entry-heading">Submit a report</h1>
        <p class="report-intro">Choose to use an account or continue as a guest. Both paths ask you to certify your report for private editorial review. Signing in does not establish an allegation as fact.</p>
        ${!available ? html`<p class="report-disabled-notice" role="note"><strong>Report submission is currently unavailable.</strong> Tracking remains available.</p>` : ""}
        <div class="report-choices">
          <section class="report-choice" aria-labelledby="report-account-heading">
            <h2 id="report-account-heading">Use an account</h2>
            <p>${entry === "signed-in" ? "Submit using your linked account." : "Sign in to submit using an existing linked account."} Account drafts and contribution history are unavailable.</p>
            ${
              accountAvailable
                ? html`<a class="report-button" href="${accountHref}">${accountHref === ACCOUNT_REPORT ? "Start an account report →" : "Log in"}</a>`
                : html`<p class="report-field-hint">${available ? "Account sign-in is unavailable here." : "Account reporting is unavailable."}</p>`
            }
          </section>
          <section class="report-choice" aria-labelledby="report-guest-heading">
            <h2 id="report-guest-heading">Continue as a guest</h2>
            <p>No account, legal name or email is required. Keep the private reference and recovery key shown after submission.</p>
            ${
              guestAvailable
                ? html`<a class="report-button report-button-quiet" href="/submit-report?guest=1">Start a guest report →</a>`
                : html`<p class="report-field-hint">Guest reporting is unavailable.</p>`
            }
          </section>
        </div>
        <a class="report-track-link" href="/track-report">Track an existing submission →</a>
        <p class="report-field-hint">Reports go to private editorial review. They are never published automatically.</p>
      </section>`,
    };
  }

  const counties = tracking ? [] : await context.services.listCounties();
  const sitekey = showForm ? context.reportChallenge?.sitekey : undefined;
  return {
    title: tracking ? "Track a Report" : "Submit a Report",
    description:
      "Submit a private concern for review or check the status of a report.",
    section: "about",
    head: html`<link rel="stylesheet" href="/assets/report-interface.css">
      <script type="module" src="/assets/report-interface.js"></script>`,
    body: html`<div id="report-interface-root"
      data-report-counties="${JSON.stringify(counties)}"
      data-report-mode="${mode}"
      data-report-enabled="${available ? "true" : "false"}"
      ${guestAvailable && !context.reportChallenge ? html`data-report-demo="true"` : ""}
      ${!tracking && accountId ? html`data-report-account-id="${accountId}"` : ""}
      ${sitekey ? html`data-report-challenge-sitekey="${sitekey}"` : ""}></div>`,
  };
}

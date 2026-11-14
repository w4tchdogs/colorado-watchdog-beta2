import { html } from "../html.js";
import type { Page, SiteContext } from "../types.js";

export async function reportPage(
  context: SiteContext,
  tracking: boolean,
): Promise<Page> {
  const counties = await context.services.listCounties();
  const available = context.reportSubmissionsEnabled === true;
  return {
    title: tracking ? "Track a Report" : "Submit a Report",
    description:
      "Submit a private concern for review or check the status of a report.",
    section: "about",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: tracking ? "Track a Report" : "Submit a Report" },
    ],
    head: html`<link rel="stylesheet" href="/assets/report-interface.css">
      <script type="module" src="/assets/report-interface.js"></script>`,
    body: html`<div id="report-interface-root"
      data-report-counties="${JSON.stringify(counties)}"
      data-report-mode="${tracking ? "track" : "submit"}"
      data-report-enabled="${available ? "true" : "false"}"></div>`,
  };
}

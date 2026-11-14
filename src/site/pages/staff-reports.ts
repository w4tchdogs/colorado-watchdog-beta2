import { html } from "../html.js";
import type { Page } from "../types.js";

export function staffReportsPage(): Page {
  return {
    title: "Private Report Review",
    section: "about",
    head: html`<link rel="stylesheet" href="/assets/staff-reports.css">
      <script type="module" src="/assets/staff-reports.js"></script>`,
    body: html`<section class="staff-reports" aria-labelledby="staff-title">
      <p class="eyebrow">Authorized staff workspace</p>
      <h1 id="staff-title">Report review</h1>
      <p class="staff-allegation-notice"><strong>Unverified reports</strong> are allegations submitted for review. They are not established findings.</p>
      <p id="staff-status" class="staff-live" role="status" aria-live="polite">Loading reports…</p>
      <div class="staff-workspace">
        <section class="staff-queue" aria-labelledby="queue-title">
          <div class="staff-section-heading"><h2 id="queue-title">Queue</h2><button id="staff-refresh" type="button">Refresh</button></div>
          <label for="staff-filter">Filter by status</label>
          <select id="staff-filter">
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option><option value="triage">Triage</option>
            <option value="under-review">Under review</option><option value="needs-information">Needs information</option>
            <option value="accepted">Accepted</option><option value="declined">Declined</option><option value="closed">Closed</option>
          </select>
          <div id="staff-queue-list" aria-busy="true"></div>
          <button id="staff-next" type="button" disabled>Load next page</button>
        </section>
        <section id="staff-detail" class="staff-detail" aria-labelledby="detail-title" tabindex="-1">
          <h2 id="detail-title">Report details</h2>
          <p>Select a report from the queue to review its confidential details.</p>
        </section>
      </div>
    </section>`,
  };
}

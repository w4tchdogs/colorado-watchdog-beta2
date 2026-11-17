import { pageHeader } from "../components.js";
import { html } from "../html.js";
import type { Page } from "../types.js";

export function aboutPage(): Page {
  return {
    title: "About Colorado Watchdog",
    description:
      "What Colorado Watchdog is, what it documents and what it does not claim.",
    section: "about",
    breadcrumbs: [{ label: "Home", href: "/" }, { label: "About" }],
    body: html`${pageHeader(
      "About Colorado Watchdog",
      "An independent public-information project about county government in Colorado.",
      undefined,
      "Independent \u00b7 Community-run",
    )}
    <div class="split">
      <section class="card prose">
        <h2>What this site documents</h2>
        <p>Colorado has 64 counties, and each one organizes its government differently. Colorado Watchdog records the organizations that make up or serve each county, the positions documented within them, and the people public sources name in those positions.</p>
        <p>The site also has a place for Stories and Posts: reporting that connects those records and cites its sources.</p>
        <h3>What it relies on</h3>
        <p>Records come from public sources such as official county webpages and public documents. A role is listed only when a source ties a person's name to a position. Each role shows that source and the date it was checked.</p>
        <img class="mascot" src="/assets/brand-mascot-sit-alert.png" alt="" width="210" height="212">
      </section>
      <section class="card prose">
        <h2>What it does not claim</h2>
        <ul>
          <li>It is not a complete roster of any county, organization or office.</li>
          <li>It does not state who currently holds a position. It states what a source said when it was checked.</li>
          <li>It does not treat a missing name or position as a vacancy.</li>
          <li>It does not merge people because their names match or resemble each other.</li>
          <li>It does not describe a regional or partner organization as a county department.</li>
        </ul>
        <h3>Independence</h3>
        <p>Colorado Watchdog is independent. It is not operated by, affiliated with or endorsed by any county or state agency.</p>
        <p><a href="/reading-records">How to read these records</a> explains citations, dates and organization relationships in detail.</p>
      </section>
    </div>`,
  };
}

export function readingRecordsPage(): Page {
  return {
    title: "How to read these records",
    description:
      "How to interpret documented roles, dates, and organization relationships on Colorado Watchdog.",
    section: "about",
    breadcrumbs: [
      { label: "Home", href: "/" },
      { label: "About", href: "/about" },
      { label: "How to read these records" },
    ],
    body: html`${pageHeader(
      "How to read these records",
      "What a documented role, a citation and each date on this site do and do not tell you.",
      undefined,
      "Public records, cited sources",
    )}
    <div class="prose">
      <h2>Documented roles</h2>
      <p>A documented role is a single record: one person, one position, one public source. The same person record can have several roles. A role appears because a source named that person in that position, not because anyone confirmed it independently.</p>

      <h2>Supporting evidence</h2>
      <p>Colorado Watchdog keeps supporting evidence for documented roles in its research records.</p>

      <h2>The three dates</h2>
      <dl class="definitions">
        <div><dt>Role start</dt><dd>The start date stored for the role, when a source gives one. Often it is not recorded.</dd></div>
        <div><dt>Role end</dt><dd>The end date stored for the role, when a source gives one. "Not recorded" means only that no end date is stored. It does not mean the person holds the role today.</dd></div>
        <div><dt>Source checked</dt><dd>The date the supporting source was last reviewed. It is not an employment date and says nothing about when a role began.</dd></div>
      </dl>

      <h2>People with the same name</h2>
      <p>Every person record has its own identifier, shown as its record ID. Two records with an identical name are two documented people. Names, nicknames and similar spellings are never used on their own to decide that two records are the same person.</p>

      <h2>County organizations and affiliated organizations</h2>
      <p>A county organization is recorded as part of that county's own government. An affiliated organization has a documented relationship to a county: it serves the county, partners with it or provides a shared service. Affiliated organizations are not county departments, and an affiliation does not mean they report to the county.</p>
      <p>Organization types such as office, department, division, regional organization and partner organization are the stored record types. "Reports to" is a documented reporting relationship. "Grouped under" is only a listing arrangement.</p>

      <h2>What absence means</h2>
      <p>The database grows as research is completed. A county with no records, an organization with no positions or a position with no person has not been documented yet. None of these is evidence of a vacancy or of how a government is staffed.</p>

      <h2>Counts</h2>
      <p>Counts on county pages describe records in this database. Role counts are role records, not unique people.</p>
    </div>`,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { REPORT_GRIEVANCE_CATALOG } from "../dist/contracts/report-grievance-catalog.js";
import { mountReportInterface } from "../dist/site/report-interface.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const counties = [
  { fips: "08001", name: "Adams" },
  { fips: "08003", name: "Alamosa" },
  { fips: "08069", name: "Larimer" },
];
const role = (id, overrides = {}) => ({
  id,
  title: "Fictional Clerk",
  office: "Fictional Clerk Office",
  county: { fips: "08001", name: "Adams" },
  startDate: "2023-01-10",
  endDate: null,
  sourceCheckedAt: "2026-10-02",
  group: "latest",
  ...overrides,
});
const people = [
  {
    personId: "p-jordan",
    displayName: "Jordan Example",
    matchingRoleCount: 2,
    role: role("r-jordan-now"),
  },
  {
    personId: "p-riley",
    displayName: "Riley Placeholder",
    matchingRoleCount: 1,
    role: role("r-riley", { startDate: null, group: "unrecorded" }),
  },
];
const rolesByPerson = {
  "p-jordan": [
    role("r-jordan-now"),
    role("r-jordan-prior", {
      title: "Fictional Deputy",
      endDate: "2023-01-09",
      startDate: "2019-03-01",
      group: "prior",
      sourceCheckedAt: "2026-09-01",
    }),
  ],
  "p-riley": [role("r-riley", { startDate: null, group: "unrecorded" })],
};

function harness(overrides = {}) {
  const dom = new JSDOM("<!doctype html><main id='app'></main>", {
    url: "https://demo.invalid/",
  });
  const document = dom.window.document;
  const calls = { searches: [], offices: [], roles: [], submissions: [] };
  const directory = {
    async search(input) {
      calls.searches.push(input);
      if (overrides.directoryFails)
        throw new Error("synthetic directory failure");
      const items = people.filter(
        (person) =>
          !input.query ||
          person.displayName.toLowerCase().includes(input.query.toLowerCase()),
      );
      return { items, total: items.length, page: input.page, pageCount: 1 };
    },
    async offices(county) {
      calls.offices.push(county);
      return {
        offices: [
          {
            id: "org-1",
            name: "Fictional Clerk Office",
            type: "office",
            parentOrganizationId: null,
          },
        ],
      };
    },
    async roles(personId) {
      calls.roles.push(personId);
      return {
        person: {
          personId,
          displayName: people.find((p) => p.personId === personId).displayName,
        },
        roles: rolesByPerson[personId],
      };
    },
  };
  let failures = overrides.failures ?? 0;
  mountReportInterface(document.getElementById("app"), {
    counties,
    submissionFlow: "guest",
    directory,
    now: () => NOW,
    createIdempotencyKey: () => "synthetic-idempotency-key",
    adapter: {
      async submit(input) {
        calls.submissions.push(input);
        if (failures > 0) {
          failures -= 1;
          throw new Error("synthetic 503");
        }
        return {
          reference: "CW-0011223344556677",
          recoveryKey: "a".repeat(64),
        };
      },
      async track() {
        throw new Error("unused");
      },
    },
  });
  const $ = (id) => document.getElementById(id);
  const win = dom.window;
  const fire = (element, type) =>
    element.dispatchEvent(new win.Event(type, { bubbles: true }));
  const change = (id, value) => {
    $(id).value = value;
    fire($(id), "change");
  };
  const selectCatalog = (inventoryId) => {
    const checkbox = $(`report-grievance-${inventoryId}`);
    if (checkbox.checked) return;
    checkbox.checked = true;
    fire(checkbox, "change");
  };
  const tick = async () => {
    for (let i = 0; i < 4; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const submit = async () => {
    // The form only validates and sends from the last step.
    document.querySelector('button[aria-controls="report-step-3"]').click();
    document
      .querySelector("#report-submit form")
      .dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
    await tick();
  };
  const choose = async (name) => {
    const button = [...document.querySelectorAll(".report-picker-result")].find(
      (b) => b.textContent === name,
    );
    button.click();
    await tick();
  };
  const pickRole = (id) => {
    const radio = document.querySelector(
      `input[name="report-role"][value="${id}"]`,
    );
    radio.checked = true;
    fire(radio, "change");
  };
  return {
    document,
    win,
    calls,
    $,
    change,
    selectCatalog,
    fire,
    tick,
    submit,
    choose,
    pickRole,
  };
}

test("listed employee: filters, search, individually selectable roles and prior-role grouping", async () => {
  const h = harness();
  await h.tick();
  const { $, document, calls } = h;
  assert.equal($("report-subject-type").value, "listed");
  assert.equal($("report-filter-office").disabled, true);
  assert.equal(calls.searches.length, 1);
  assert.match(
    document.querySelector(".report-picker .report-field-hint").textContent,
    /2 matching profiles statewide/,
  );
  // County filter loads offices, enables the office filter and resets paging.
  h.change("report-filter-county", "08001");
  await h.tick();
  assert.deepEqual(calls.offices, ["08001"]);
  assert.equal($("report-filter-office").disabled, false);
  assert.equal(calls.searches.at(-1).county, "08001");
  h.change("report-filter-office", "org-1");
  await h.tick();
  assert.equal(calls.searches.at(-1).office, "org-1");
  // Changing the county clears the office filter.
  h.change("report-filter-county", "08003");
  await h.tick();
  assert.equal($("report-filter-office").value, "");
  // Search by name.
  $("report-employee-search").value = "riley";
  h.fire($("report-employee-search"), "input");
  $("report-employee-search").dispatchEvent(
    new h.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await h.tick();
  assert.equal(calls.searches.at(-1).query, "riley");
  $("report-employee-search").value = "";
  $("report-employee-search").dispatchEvent(
    new h.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await h.tick();
  // A person with two roles needs an explicit choice, and prior roles show apart.
  await h.choose("Jordan Example");
  h.selectCatalog(1);
  const headings = [...document.querySelectorAll(".report-role-group")].map(
    (e) => e.textContent,
  );
  assert.deepEqual(headings, ["Latest listed roles", "Prior roles"]);
  assert.equal(
    document.querySelectorAll('input[name="report-role"]:checked').length,
    0,
  );
  const prior = document.querySelector('input[value="r-jordan-prior"]')
    .parentElement.textContent;
  assert.match(prior, /Source checked 2026-09-01/);
  assert.match(prior, /Documented employment: 2019-03-01 to 2023-01-09/);
  h.pickRole("r-jordan-prior");
  assert.match($("report-selected-employee").textContent, /Fictional Deputy/);
  // Mirrored role select on the first grievance follows the choice.
  assert.equal($("report-g0-role").value, "r-jordan-prior");
});

test("a failing directory shows a recoverable message and the unlisted path still works", async () => {
  const h = harness({ directoryFails: true });
  await h.tick();
  assert.match(
    h.document.querySelector(".report-picker .report-field-hint").textContent,
    /directory couldn’t be loaded/,
  );
  h.change("report-subject-type", "unlisted");
  assert.equal(
    h.$("report-unlisted-name").closest(".report-picker").hidden,
    false,
  );
  assert.equal(
    h.$("report-employee-search").closest(".report-picker").hidden,
    true,
  );
});

test("event date: year window, optional month and day, leap-day cleanup", async () => {
  const h = harness();
  const { $ } = h;
  h.selectCatalog(1);
  const years = [...$("report-event-year").options].map((o) => o.value);
  assert.deepEqual(years.slice(0, 3), ["", "2026", "2025"]);
  assert.equal(years.at(-1), "2016");
  assert.equal(years.length, 12);
  assert.equal($("report-event-year").closest(".report-field").hidden, false);
  assert.equal($("report-event-month").closest(".report-field").hidden, true);
  assert.equal($("report-event-day").closest(".report-field").hidden, true);
  h.change("report-event-year", "2024");
  assert.equal($("report-event-month").closest(".report-field").hidden, false);
  assert.equal($("report-event-day").closest(".report-field").hidden, true);
  h.change("report-event-month", "2");
  assert.equal($("report-event-day").closest(".report-field").hidden, false);
  assert.equal($("report-event-day").options.length, 30);
  h.change("report-event-day", "29");
  h.change("report-event-year", "2025");
  assert.equal($("report-event-day").value, "");
  assert.equal($("report-event-day").options.length, 29);
  // Clearing the year hides and clears month and day.
  h.change("report-event-year", "");
  assert.equal($("report-event-month").closest(".report-field").hidden, true);
  assert.equal($("report-event-month").value, "");
  // The first grievance card mirrors the step 1 date.
  h.change("report-event-year", "2025");
  h.change("report-event-month", "6");
  assert.equal($("report-g0-year").value, "2025");
  assert.equal($("report-g0-month").value, "6");
});

test("catalog table exposes all 61 rows and stable commonality and alphabetical orders", () => {
  const { document } = harness();
  const rows = () => [
    ...document.querySelectorAll(".report-grievance-catalog-table tbody tr"),
  ];
  const ids = () =>
    rows().map((row) => Number(row.querySelector("input").value));
  assert.equal(rows().length, 61);
  assert.ok(rows().every((row) => row.querySelectorAll("td").length === 3));
  assert.ok(
    [...document.querySelectorAll(".report-grievance-select input")].every(
      (checkbox) =>
        checkbox.type === "checkbox" && checkbox.getAttribute("aria-label"),
    ),
  );
  assert.ok(
    [...document.querySelectorAll(".report-grievance-select input")].every(
      (checkbox) =>
        checkbox.tabIndex === 0 &&
        checkbox.labels.length === 1 &&
        checkbox.labels[0].textContent.includes(
          checkbox.getAttribute("aria-label").slice(7),
        ),
    ),
  );
  const headers = [
    ...document.querySelectorAll(".report-grievance-catalog-table th"),
  ];
  assert.equal(headers.length, 3);
  assert.ok(
    headers.every(
      (header) =>
        header.scope === "col" &&
        header.getAttribute("aria-sort") === "none" &&
        header.querySelector("button").type === "button" &&
        header.querySelector("button").tabIndex === 0 &&
        header
          .querySelector("button")
          .getAttribute("aria-label")
          .includes("A to Z"),
    ),
  );
  const byId = (a, b) => a.inventoryId - b.inventoryId;
  const expectedCommon = [...REPORT_GRIEVANCE_CATALOG]
    .sort((a, b) => b.commonalityScore - a.commonalityScore || byId(a, b))
    .map((entry) => entry.inventoryId);
  const expectedUncommon = [...REPORT_GRIEVANCE_CATALOG]
    .sort((a, b) => a.commonalityScore - b.commonalityScore || byId(a, b))
    .map((entry) => entry.inventoryId);
  assert.deepEqual(ids(), expectedCommon);
  document.querySelector('button[aria-pressed="false"]').click();
  assert.deepEqual(ids(), expectedUncommon);
  document.querySelector('button[aria-pressed="false"]').click();
  assert.deepEqual(ids(), expectedCommon);

  const collator = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
  });
  for (const [key, label] of [
    ["title", "Grievance"],
    ["description", "Description"],
    ["type", "Type"],
  ]) {
    const header = [
      ...document.querySelectorAll(".report-grievance-catalog-table th"),
    ].find((cell) => cell.textContent.includes(label));
    const sort = header.querySelector("button");
    sort.click();
    const ascending = [...REPORT_GRIEVANCE_CATALOG]
      .sort((a, b) => collator.compare(a[key], b[key]) || byId(a, b))
      .map((entry) => entry.inventoryId);
    assert.deepEqual(ids(), ascending, `${label} A–Z`);
    assert.equal(header.getAttribute("aria-sort"), "ascending");
    sort.click();
    const descending = [...REPORT_GRIEVANCE_CATALOG]
      .sort((a, b) => collator.compare(b[key], a[key]) || byId(a, b))
      .map((entry) => entry.inventoryId);
    assert.deepEqual(ids(), descending, `${label} Z–A`);
    assert.equal(header.getAttribute("aria-sort"), "descending");
  }
});

test("catalog selection creates up to five detail cards and deselection frees a slot", async () => {
  const h = harness();
  const { $, document } = h;
  h.change("report-county", "08001");
  h.change("report-event-year", "2025");
  h.change("report-event-month", "6");
  $("report-position").value = "Fictional Clerk";
  h.fire($("report-position"), "input");
  h.selectCatalog(1);
  h.selectCatalog(2);
  assert.equal(document.querySelectorAll(".report-grievance-card").length, 2);
  // The new card starts from the first card's date and event context.
  assert.equal($("report-g1-year").value, "2025");
  assert.equal($("report-g1-month").value, "6");
  assert.equal($("report-g1-county").value, "08001");
  assert.equal($("report-g1-position").value, "Fictional Clerk");
  assert.equal($("report-g1-details").maxLength, 4000);
  // Editing the second card leaves the first unchanged.
  h.change("report-g1-county", "08069");
  h.change("report-g1-year", "2024");
  assert.equal($("report-county").value, "08001");
  assert.equal($("report-event-year").value, "2025");
  // Live word count, including the over-limit state.
  $("report-g1-details").value = "one two three";
  h.fire($("report-g1-details"), "input");
  assert.match(
    $("report-g1-count").textContent,
    /^3 \/ 250 words · 13 \/ 4000 characters$/,
  );
  $("report-g1-details").value = Array(251).fill("w").join(" ");
  h.fire($("report-g1-details"), "input");
  assert.equal($("report-g1-count").classList.contains("is-over"), true);
  // Up to five cards; a sixth check is refused without evicting a selection.
  h.selectCatalog(3);
  h.selectCatalog(4);
  h.selectCatalog(5);
  const sixth = $("report-grievance-6");
  sixth.checked = true;
  h.fire(sixth, "change");
  assert.equal(document.querySelectorAll(".report-grievance-card").length, 5);
  assert.equal(sixth.checked, false);
  assert.match(
    $("report-grievance-selection-status").textContent,
    /Maximum of 5/,
  );
  // Deselecting one item removes its details and makes room for another.
  const firstCheckbox = $("report-grievance-1");
  firstCheckbox.checked = false;
  h.fire(firstCheckbox, "change");
  h.selectCatalog(6);
  assert.equal(document.querySelectorAll(".report-grievance-card").length, 5);
  // Remove one remaining card with its control.
  document
    .querySelectorAll(".report-grievance-card")[1]
    .querySelector("button.report-button-quiet")
    .click();
  const legends = [
    ...document.querySelectorAll(".report-grievance-card legend"),
  ];
  assert.deepEqual(
    legends.map((l) => l.textContent),
    [
      "Grievance 1: Wrong or unfair decision by an office",
      "Grievance 2: Waiting too long for a response, action, or decision",
      "Grievance 3: Problem caused by a law or regulation",
      "Grievance 4: Unfair or inconsistent enforcement",
    ],
  );
  // Every selected card can be removed, including the last one.
  for (let i = 0; i < 4; i += 1)
    document
      .querySelector(".report-grievance-card:last-child .report-button-quiet")
      .click();
  assert.equal(document.querySelectorAll(".report-grievance-card").length, 0);
});

test("an empty catalog selection is a linked, accessible validation error", async () => {
  const h = harness();
  await h.submit();
  const link = h.document.querySelector(
    '.report-error-summary a[href="#report-grievance-1"]',
  );
  assert.ok(link);
  assert.equal(h.$("report-grievance-1").getAttribute("aria-invalid"), "true");
  assert.match(
    h.$("report-grievance-selection-error").textContent,
    /Select at least one/,
  );
});

test("removing the first card moves the next card's event details into step 1", async () => {
  const h = harness();
  const { $, document } = h;
  h.change("report-county", "08001");
  h.change("report-event-year", "2025");
  h.selectCatalog(1);
  h.selectCatalog(2);
  h.change("report-g1-county", "08069");
  h.change("report-g1-year", "2023");
  document.querySelector(".report-grievance-card .report-button-quiet").click();
  assert.equal($("report-county").value, "08069");
  assert.equal($("report-event-year").value, "2023");
});

test("submits structured grievances with different event counties and shows them in Review & sign", async () => {
  const h = harness();
  const { $, document, calls } = h;
  await h.tick();
  await h.choose("Jordan Example");
  h.pickRole("r-jordan-now");
  h.change("report-county", "08001");
  h.change("report-event-year", "2026");
  h.change("report-event-month", "3");
  $("report-position").value = "Fictional Clerk";
  h.fire($("report-position"), "input");
  h.selectCatalog(1);
  $("report-g0-details").value = "First fictional grievance details.";
  h.fire($("report-g0-details"), "input");
  h.selectCatalog(4);
  h.change("report-g1-county", "08069");
  h.change("report-g1-year", "2020");
  h.change("report-g1-role", "r-jordan-prior");
  $("report-g1-details").value = "Second fictional grievance details.";
  h.fire($("report-g1-details"), "input");
  $("report-headline").value = "A synthetic headline";
  const descriptionHeader = [
    ...document.querySelectorAll(".report-grievance-catalog-table th"),
  ].find((cell) => cell.textContent.includes("Description"));
  descriptionHeader.querySelector("button").click();
  descriptionHeader.querySelector("button").click();
  assert.equal($("report-grievance-1").checked, true);
  assert.equal($("report-grievance-4").checked, true);
  assert.equal(
    $("report-g0-details").value,
    "First fictional grievance details.",
  );
  assert.equal(
    $("report-g1-details").value,
    "Second fictional grievance details.",
  );
  document.querySelector('button[aria-controls="report-step-3"]').click();
  const review = $("report-step-3").textContent;
  assert.match(review, /Grievance 1/);
  assert.match(review, /Grievance 2/);
  assert.match(review, /March 2026/);
  assert.match(review, /Adams/);
  assert.match(review, /Larimer/);
  assert.match(review, /Fictional Deputy/);
  assert.match(review, /Difficulty getting a service or poor service/);
  assert.match(review, /Waiting too long for a response, action, or decision/);
  assert.match(review, /TypeService/g);
  assert.match(review, /A synthetic headline/);
  document.querySelector('button[aria-controls="report-step-2"]').click();
  assert.equal(
    $("report-g0-details").value,
    "First fictional grievance details.",
  );
  assert.equal($("report-g1-role").value, "r-jordan-prior");
  document.querySelector('button[aria-controls="report-step-3"]').click();
  $("report-certification").checked = true;
  await h.submit();
  assert.equal(calls.submissions.length, 1);
  const sent = calls.submissions[0];
  assert.equal(sent.headline, "A synthetic headline");
  assert.equal(sent.countyId, "08001");
  assert.deepEqual(sent.subject, { kind: "person", id: "p-jordan" });
  assert.equal(sent.grievances.length, 2);
  assert.deepEqual(sent.grievances[0], {
    catalogId: 1,
    details: "First fictional grievance details.",
    date: { year: 2026, month: 3 },
    countyId: "08001",
    subject: { kind: "listed", personId: "p-jordan", roleId: "r-jordan-now" },
    position: "Fictional Clerk",
    identificationBasis: "contributor",
  });
  assert.equal(sent.grievances[1].countyId, "08069");
  assert.equal(sent.grievances[1].catalogId, 4);
  // The card copied month 3 from the first card. Changing its year kept that month.
  assert.deepEqual(sent.grievances[1].date, { year: 2020, month: 3 });
  assert.equal(sent.grievances[1].subject.roleId, "r-jordan-prior");
  assert.match(sent.description, /Grievance 2: Second fictional/);
});

test("unlisted employee path sends the name and office and flags private review", async () => {
  const h = harness();
  const { $, document, calls } = h;
  h.change("report-subject-type", "unlisted");
  $("report-unlisted-name").value = "Fictional Unlisted";
  $("report-unlisted-office").value = "Fictional Unlisted Office";
  h.change("report-county", "08003");
  h.change("report-event-year", "2025");
  h.selectCatalog(1);
  $("report-g0-details").value = "Unlisted fictional grievance.";
  h.fire($("report-g0-details"), "input");
  document.querySelector('button[aria-controls="report-step-3"]').click();
  assert.match(
    $("report-step-3").textContent,
    /Fictional Unlisted · Fictional Unlisted Office/,
  );
  $("report-certification").checked = true;
  await h.submit();
  const sent = calls.submissions[0];
  assert.equal(sent.subject, undefined);
  assert.deepEqual(sent.grievances[0].subject, {
    kind: "unlisted",
    name: "Fictional Unlisted",
    office: "Fictional Unlisted Office",
  });
  assert.deepEqual(sent.grievances[0].date, { year: 2025 });
});

test("validation: empty and incomplete entries are reported with links and nothing is sent", async () => {
  const h = harness();
  const { $, document, calls } = h;
  h.selectCatalog(1);
  await h.submit();
  assert.equal(calls.submissions.length, 0);
  const links = [...document.querySelectorAll(".report-error-summary a")].map(
    (a) => a.getAttribute("href"),
  );
  for (const id of [
    "#report-employee-search",
    "#report-county",
    "#report-event-year",
    "#report-g0-details",
  ])
    assert.ok(links.includes(id), id);
  // The first error is in step 1, so step 1 is shown.
  assert.equal($("report-step-1").hidden, false);
  // More than 250 words is refused.
  h.change("report-subject-type", "unlisted");
  $("report-unlisted-name").value = "Fictional";
  $("report-unlisted-office").value = "Office";
  h.change("report-county", "08001");
  h.change("report-event-year", "2026");
  h.selectCatalog(1);
  $("report-g0-details").value = Array(251).fill("w").join(" ");
  $("report-certification").checked = true;
  await h.submit();
  assert.equal(calls.submissions.length, 0);
  assert.equal($("report-g0-details").getAttribute("aria-invalid"), "true");
  assert.match($("report-g0-details-error").textContent, /250 words or fewer/);
  assert.equal($("report-step-2").hidden, false);
  $("report-g0-details").value = "x".repeat(4001);
  await h.submit();
  assert.equal(calls.submissions.length, 0);
  assert.match(
    $("report-g0-details-error").textContent,
    /4,000 characters or fewer/,
  );
});

test("a synthetic 503 keeps every entry and the retry reuses the idempotency key", async () => {
  const h = harness({ failures: 1 });
  const { $, document, calls } = h;
  h.change("report-subject-type", "unlisted");
  $("report-unlisted-name").value = "Fictional";
  $("report-unlisted-office").value = "Office";
  h.change("report-county", "08001");
  h.change("report-event-year", "2026");
  h.selectCatalog(1);
  $("report-g0-details").value = "A fictional grievance for recovery.";
  h.fire($("report-g0-details"), "input");
  h.selectCatalog(4);
  h.change("report-g1-county", "08069");
  $("report-g1-details").value = "A second fictional grievance.";
  h.fire($("report-g1-details"), "input");
  $("report-certification").checked = true;
  await h.submit();
  assert.match(
    document.querySelector(".report-status").textContent,
    /couldn't submit this report/,
  );
  assert.equal(document.querySelectorAll(".report-grievance-card").length, 2);
  assert.equal($("report-g1-county").value, "08069");
  assert.equal(
    $("report-g0-details").value,
    "A fictional grievance for recovery.",
  );
  assert.equal($("report-unlisted-name").value, "Fictional");
  await h.submit();
  assert.equal(calls.submissions.length, 2);
  assert.equal(
    calls.submissions[0].idempotencyKey,
    calls.submissions[1].idempotencyKey,
  );
  assert.equal(document.activeElement.id, "report-receipt-heading");
});

test("fixing a field removes its error link, including the event county", async () => {
  const h = harness();
  const { $, document } = h;
  h.selectCatalog(1);
  await h.submit();
  const link = () =>
    document.querySelector('.report-error-summary a[href="#report-county"]');
  assert.ok(link());
  assert.equal($("report-county").getAttribute("aria-invalid"), "true");
  h.change("report-county", "08001");
  assert.equal($("report-county").hasAttribute("aria-invalid"), false);
  assert.equal(link(), null);
});

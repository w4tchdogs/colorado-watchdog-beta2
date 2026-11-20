import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const bundle = new URL(
  "../dist/site-browser/staff-reports.js",
  import.meta.url,
);
const base = {
  countyId: "08001",
  status: "submitted",
  version: 1,
  createdAt: "2026-11-01T10:00:00.000Z",
  reporter: {
    attribution: "anonymous",
    contactPreference: "none",
    confidential: true,
  },
  evidence: [],
};
const structured = {
  ...base,
  id: "synthetic-structured",
  description: "Grievance 1: derived text",
  headline: "A synthetic headline",
  grievances: [
    {
      type: "retaliation",
      details: "First fictional grievance.",
      date: { year: 2026, month: 3, day: 4 },
      countyId: "08001",
      subject: { kind: "listed", personId: "p-1", roleId: "r-prior" },
      position: "Fictional Deputy",
      identificationBasis: "documented",
    },
    {
      catalogId: 4,
      details: "Second fictional grievance.",
      date: { year: 2025 },
      countyId: "08069",
      subject: {
        kind: "unlisted",
        name: "Fictional Unlisted",
        office: "Office",
      },
      identificationBasis: "contributor",
    },
  ],
};
const legacy = {
  ...base,
  id: "synthetic-legacy",
  description: "Legacy single narrative text.",
};

async function open(report, extra = {}) {
  const dom = new JSDOM(
    `<!doctype html><main><section class="staff-reports"><p id="staff-status" role="status"></p>
    <select id="staff-filter"><option value="">All</option></select><button id="staff-refresh"></button>
    <button id="staff-next"></button><div id="staff-queue-list"></div>
    <section id="staff-detail" tabindex="-1"><h2 id="detail-title"></h2></section></section></main>`,
    { url: "https://watchdog.test/admin/reports", runScripts: "outside-only" },
  );
  dom.window.fetch = async (input) => {
    const url = new URL(input, dom.window.location.href);
    if (url.pathname === "/api/v1/reports")
      return Response.json({ reports: [report], next: null });
    if (url.pathname.endsWith("/history"))
      return Response.json({ history: [] });
    if (url.pathname === `/api/v1/reports/${report.id}`)
      return Response.json({
        report,
        countyName: "Adams",
        allowedNextStatuses: ["triage"],
        ...extra,
      });
    return new Response("nope", { status: 404 });
  };
  dom.window.eval(await readFile(bundle, "utf8"));
  for (let i = 0; i < 30; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.document.querySelector(".staff-queue-item").click();
  for (let i = 0; i < 30; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  return dom;
}

test("staff detail shows every stored grievance with its own date, county, role and subject", async () => {
  const dom = await open(structured, {
    countyNames: { "08001": "Adams", "08069": "Larimer" },
    employees: {
      "p-1": {
        name: "Jordan Example",
        roles: {
          "r-prior": {
            title: "Fictional Deputy",
            office: "Fictional Office",
            sourceCheckedAt: "2026-09-01T00:00:00Z",
            startDate: "2019-03-01",
            endDate: "2023-01-09",
          },
        },
      },
    },
  });
  const text = dom.window.document.querySelector("#staff-detail").textContent;
  assert.match(text, /A synthetic headline/);
  assert.match(text, /Grievance 1/);
  assert.match(text, /Grievance 2/);
  assert.match(text, /Waiting too long for a response, action, or decision/);
  assert.match(text, /Inventory ID: 4/);
  assert.match(text, /Retaliation for raising a concern/);
  assert.match(text, /March 4, 2026/);
  assert.match(text, /Adams \(08001\)/);
  assert.match(text, /Larimer \(08069\)/);
  assert.match(text, /Jordan Example \(p-1\)/);
  assert.match(
    text,
    /source checked 2026-09-01 · documented 2019-03-01 to 2023-01-09/,
  );
  assert.match(text, /Fictional Unlisted/);
  assert.match(text, /Documented context/);
  assert.match(text, /First fictional grievance\./);
  assert.doesNotMatch(text, /Submitted description/);
  dom.window.close();
});

test("staff detail still shows a legacy single narrative", async () => {
  const dom = await open(legacy);
  const text = dom.window.document.querySelector("#staff-detail").textContent;
  assert.match(text, /Submitted description/);
  assert.match(text, /Legacy single narrative text\./);
  assert.doesNotMatch(text, /Grievance 1/);
  dom.window.close();
});

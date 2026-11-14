import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

const bundle = new URL(
  "../dist/site-browser/staff-reports.js",
  import.meta.url,
);
let dom;
let calls;

before(async () => {
  calls = [];
  const html = `<!doctype html><main>
    <section class="staff-reports"><p id="staff-status" role="status"></p><select id="staff-filter"><option value="">All</option><option value="triage">Triage</option></select>
    <button id="staff-refresh"></button><button id="staff-next"></button><div id="staff-queue-list"></div>
    <section id="staff-detail" tabindex="-1"><h2 id="detail-title"></h2></section></section></main>`;
  dom = new JSDOM(html, {
    url: "https://watchdog.test/admin/reports",
    runScripts: "outside-only",
  });
  const report = {
    id: "synthetic-report-001",
    countyId: "08001",
    countyName: "Synthetic Adams County",
    status: "triage",
    version: 2,
    createdAt: "2026-11-01T10:00:00.000Z",
    subject: { kind: "person", id: "fictional-person-1" },
    description: "Fictional unverified allegation text.",
    reporter: {
      attribution: "signed",
      contactPreference: "email",
      confidential: true,
      name: "Synthetic Reporter",
      email: "reporter@example.test",
    },
    evidence: [
      {
        title: "Fictional source",
        url: "https://example.test/evidence",
        note: "Synthetic evidence note",
      },
      { title: "Unsafe URL", url: "javascript:alert(1)" },
    ],
  };
  let changed = false;
  dom.window.fetch = async (input, init = {}) => {
    const url = new URL(input, dom.window.location.href);
    calls.push({
      url: url.pathname + url.search,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (url.pathname.endsWith("/status") && init.method === "PATCH") {
      changed = true;
      return Response.json({ ok: true });
    }
    if (
      url.pathname === "/api/v1/reports" &&
      url.searchParams.get("status") === "triage"
    )
      return Response.json({ reports: [report], next: null });
    if (
      url.pathname === "/api/v1/reports" &&
      url.searchParams.get("after") === "synthetic-cursor"
    )
      return Response.json({
        reports: [
          {
            id: "synthetic-report-002",
            countyId: "08013",
            countyName: "Synthetic Boulder County",
            status: "submitted",
            version: 1,
            createdAt: "2026-11-02T10:00:00.000Z",
          },
        ],
        next: null,
      });
    if (url.pathname === "/api/v1/reports")
      return Response.json({
        reports: changed
          ? [{ ...report, status: "under-review", version: 3 }]
          : [report],
        next: changed ? null : "synthetic-cursor",
      });
    if (url.pathname.endsWith("/history"))
      return Response.json({
        history: [
          {
            from: "submitted",
            to: changed ? "under-review" : "triage",
            at: "2026-11-01T11:00:00.000Z",
            actor: {
              kind: "staff",
              role: "editor",
              accountId: "synthetic-editor",
            },
            note: changed
              ? "Synthetic private follow-up"
              : "Synthetic intake review",
            version: changed ? 3 : 2,
          },
        ],
      });
    if (url.pathname === `/api/v1/reports/${report.id}`)
      return Response.json({
        report: changed
          ? { ...report, status: "under-review", version: 3 }
          : report,
        countyName: report.countyName,
        allowedNextStatuses: changed
          ? ["needs-information", "accepted", "declined"]
          : ["under-review", "needs-information", "declined"],
      });
    return new Response("not found", { status: 404 });
  };
  dom.window.eval(await readFile(bundle, "utf8"));
});

after(() => dom?.window.close());

async function settle() {
  for (let i = 0; i < 30; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test("loads the staff queue, filters and safely renders confidential detail and evidence", async () => {
  await settle();
  const firstQueueCall = calls.find((call) =>
    call.url.startsWith("/api/v1/reports?"),
  );
  assert.match(firstQueueCall.url, /limit=25/);
  assert.equal(
    dom.window.document.querySelectorAll(".staff-queue-item").length,
    1,
  );
  dom.window.document.querySelector("#staff-next").click();
  await settle();
  assert.ok(calls.some((call) => call.url.includes("after=synthetic-cursor")));
  assert.equal(
    dom.window.document.querySelectorAll(".staff-queue-item").length,
    2,
  );
  dom.window.document.querySelector(".staff-queue-item").click();
  await settle();
  const detail = dom.window.document.querySelector("#staff-detail");
  assert.match(detail.textContent, /Fictional unverified allegation text/);
  assert.match(detail.textContent, /Synthetic intake review/);
  assert.equal(
    detail.querySelector('a[href^="https://example.test"]')?.textContent,
    "https://example.test/evidence",
  );
  assert.equal(detail.querySelector('a[href^="javascript:"]'), null);
  assert.match(detail.textContent, /Unsafe URL/);
  dom.window.document.querySelector("#staff-filter").value = "triage";
  dom.window.document
    .querySelector("#staff-filter")
    .dispatchEvent(new dom.window.Event("change"));
  await settle();
  assert.ok(calls.some((call) => call.url.includes("status=triage")));
});

test("records a version-checked private status note and refreshes detail and history", async () => {
  const reportButton = dom.window.document.querySelector(".staff-queue-item");
  reportButton.click();
  await settle();
  const note = dom.window.document.querySelector("#staff-private-note");
  note.value = "Synthetic private follow-up";
  dom.window.document.querySelector("#staff-next-status").value =
    "under-review";
  dom.window.document
    .querySelector(".staff-status-form")
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await settle();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, {
    expectedVersion: 2,
    status: "under-review",
    note: "Synthetic private follow-up",
  });
  assert.match(
    dom.window.document.querySelector("#staff-detail").textContent,
    /Synthetic private follow-up/,
  );
  assert.match(
    dom.window.document.querySelector("#staff-detail").textContent,
    /Record version/,
  );
  assert.match(
    dom.window.document.querySelector("#staff-status").textContent,
    /refreshed/,
  );
  assert.equal(dom.window.localStorage.length, 0);
});

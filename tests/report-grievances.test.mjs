import assert from "node:assert/strict";
import test from "node:test";
import {
  countWords,
  denverYear,
  eventYears,
  formatEventDate,
  GRIEVANCE_TYPES,
  isValidEventDate,
} from "../dist/contracts/report-grievances.js";
import { createReportApiModule } from "../dist/report-api.js";
import { createServices } from "../dist/services/index.js";
import {
  getReportForStaff,
  submitReport,
} from "../dist/services/report-intake.js";
import { MemoryReportIntakeStore } from "../dist/services/report-intake-memory.js";
import { createPublicSite } from "../dist/site/index.js";
import { get, siteAssets, withPreview } from "./site-fixtures.mjs";

const NOW = new Date("2026-11-13T12:00:00Z");
const reporter = { kind: "reporter" };
const editor = { kind: "staff", accountId: "synthetic-editor", role: "editor" };

const grievance = (overrides = {}) => ({
  type: "other",
  details: "A fictional event used only to test structured intake.",
  date: { year: 2026, month: 3 },
  countyId: "synthetic-county",
  subject: {
    kind: "listed",
    personId: "synthetic-person",
    roleId: "synthetic-person-role-1",
  },
  identificationBasis: "contributor",
  ...overrides,
});
const structured = (grievances, overrides = {}) => ({
  countyId: "ignored",
  description: "ignored",
  grievances,
  evidence: [],
  reporter: {
    attribution: "anonymous",
    confidential: true,
    contactPreference: "none",
  },
  idempotencyKey: "synthetic-structured-001",
  ...overrides,
});

test("13 grievance types carry help text and the word count ignores extra whitespace", () => {
  assert.equal(GRIEVANCE_TYPES.length, 13);
  assert.ok(GRIEVANCE_TYPES.every((type) => type.label && type.help));
  assert.equal(countWords("  one  two\nthree\t"), 3);
  assert.equal(countWords("   "), 0);
});

test("the year window is the Denver year and the ten before it", () => {
  // 02:00 UTC on 1 January is still 31 December in Denver.
  const newYear = new Date("2027-01-01T02:00:00Z");
  assert.equal(denverYear(newYear), 2026);
  assert.deepEqual(eventYears(newYear).slice(0, 2), [2026, 2025]);
  assert.equal(eventYears(NOW).length, 11);
  assert.equal(eventYears(NOW).at(-1), 2016);
});

test("partial dates need a year and reject impossible calendar dates", () => {
  for (const good of [
    { year: 2026 },
    { year: 2026, month: 2 },
    { year: 2024, month: 2, day: 29 },
    { year: 2016, month: 12, day: 31 },
  ])
    assert.equal(isValidEventDate(good, NOW), true, JSON.stringify(good));
  for (const bad of [
    {},
    { month: 3 },
    { year: 2026, day: 4 },
    { year: 2025, month: 2, day: 29 },
    { year: 2026, month: 4, day: 31 },
    { year: 2026, month: 13 },
    { year: 2015 },
    { year: 2027 },
    { year: "2026" },
    { year: 2026, extra: 1 },
  ])
    assert.equal(isValidEventDate(bad, NOW), false, JSON.stringify(bad));
  assert.equal(
    formatEventDate({ year: 2026, month: 3, day: 4 }),
    "March 4, 2026",
  );
  assert.equal(formatEventDate({ year: 2026, month: 3 }), "March 2026");
});

test("structured intake derives legacy fields, stores every grievance and replays", async () => {
  const store = new MemoryReportIntakeStore();
  const grievances = [
    grievance(),
    grievance({
      countyId: "synthetic-county-2",
      date: { year: 2025 },
      position: "Synthetic Clerk",
      subject: {
        kind: "unlisted",
        name: "Synthetic Unlisted",
        office: "Synthetic Office",
      },
    }),
  ];
  const first = await submitReport(
    store,
    structured(grievances, { headline: "A synthetic headline" }),
    reporter,
    NOW,
  );
  const replay = await submitReport(
    store,
    structured(grievances, { headline: "A synthetic headline" }),
    reporter,
    NOW,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.recoveryKey, undefined);
  const id = store.reportIdForReference(first.receipt.reference);
  const { report } = await getReportForStaff(store, id, editor);
  assert.deepEqual(report.grievances, grievances);
  assert.equal(report.headline, "A synthetic headline");
  assert.equal(report.countyId, "synthetic-county");
  assert.deepEqual(report.subject, { kind: "person", id: "synthetic-person" });
  assert.match(report.description, /^Grievance 1: A fictional event/);
  assert.match(report.description, /Grievance 2:/);
  // A changed payload under the same key is a conflict, not a replay.
  await assert.rejects(
    submitReport(store, structured([grievance()]), reporter, NOW),
    /changed/,
  );
});

test("structured intake rejects every invalid grievance field", async () => {
  const bad = {
    "no grievances": [],
    "six grievances": Array.from({ length: 6 }, () => grievance()),
    "unknown type": [grievance({ type: "made-up" })],
    "empty details": [grievance({ details: "   " })],
    "251 words": [grievance({ details: Array(251).fill("word").join(" ") })],
    "no year": [grievance({ date: {} })],
    "day without month": [grievance({ date: { year: 2026, day: 3 } })],
    "impossible date": [grievance({ date: { year: 2026, month: 2, day: 30 } })],
    "year outside window": [grievance({ date: { year: 2015 } })],
    "unknown county": [grievance({ countyId: "elsewhere" })],
    "role not for person": [
      grievance({
        subject: {
          kind: "listed",
          personId: "synthetic-person",
          roleId: "synthetic-other-role-1",
        },
      }),
    ],
    "unlisted without office": [
      grievance({ subject: { kind: "unlisted", name: "Name", office: " " } }),
    ],
    "bad basis": [grievance({ identificationBasis: "guess" })],
    "long position": [grievance({ position: "x".repeat(201) })],
    "extra key": [grievance({ extra: true })],
  };
  for (const [name, grievances] of Object.entries(bad)) {
    await assert.rejects(
      submitReport(
        new MemoryReportIntakeStore(),
        structured(grievances),
        reporter,
        NOW,
      ),
      /invalid/i,
      name,
    );
  }
  await assert.rejects(
    submitReport(
      new MemoryReportIntakeStore(),
      structured([grievance()], { headline: "x".repeat(181) }),
      reporter,
      NOW,
    ),
    /invalid/i,
  );
});

test("a legacy single-narrative submission still works and reads back unchanged", async () => {
  const store = new MemoryReportIntakeStore();
  const result = await submitReport(
    store,
    {
      countyId: "synthetic-county",
      description:
        "A fictional legacy narrative of at least twenty characters.",
      evidence: [],
      reporter: {
        attribution: "anonymous",
        confidential: true,
        contactPreference: "none",
      },
      idempotencyKey: "synthetic-legacy-001",
    },
    reporter,
    NOW,
  );
  const { report } = await getReportForStaff(
    store,
    store.reportIdForReference(result.receipt.reference),
    editor,
  );
  assert.equal(report.grievances, undefined);
  assert.match(report.description, /legacy narrative/);
});

test("the form's directory lookup reuses the officials directory and separates prior roles", async () => {
  await withPreview("fictional", async (preview) => {
    const services = createServices({ database: preview.database });
    const site = createPublicSite({
      services,
      assets: siteAssets(),
      reportSubmissionsEnabled: true,
      now: () => NOW,
    });
    const json = async (path) => {
      const result = await get(site, path);
      return { status: result.status, body: JSON.parse(result.text) };
    };
    const roles = await json(
      "/submit-report/directory?person=demo-person-jordan-a",
    );
    assert.equal(roles.status, 200);
    assert.equal(roles.body.roles.length, 2);
    const byId = Object.fromEntries(roles.body.roles.map((r) => [r.id, r]));
    assert.equal(byId["demo-role-01"].group, "latest");
    assert.equal(byId["demo-role-02"].group, "prior");
    // A source-check date is not an employment date.
    assert.equal(byId["demo-role-02"].endDate, "2023-01-09");
    assert.equal(byId["demo-role-02"].sourceCheckedAt, "2026-10-02");
    const undated = await json(
      "/submit-report/directory?person=demo-person-riley",
    );
    assert.ok(undated.body.roles.some((r) => r.group === "unrecorded"));

    const filtered = await json(
      "/submit-report/directory?county=08069&q=Fixture",
    );
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.total >= 1);
    assert.ok(
      filtered.body.items.every((item) => /Fixture/.test(item.displayName)),
    );
    const offices = await json("/submit-report/directory?offices=08069");
    assert.ok(offices.body.offices.some((o) => o.id === "demo-larimer-dev"));
    const byOffice = await json(
      "/submit-report/directory?county=08069&office=demo-larimer-dev",
    );
    assert.equal(byOffice.status, 200);
    assert.ok(byOffice.body.total >= 1);

    for (const bad of [
      "?q=a",
      "?county=xyz",
      "?office=type:nope",
      "?page=0",
      "?person=bad%20id",
      "?surprise=1",
    ])
      assert.equal(
        (await json(`/submit-report/directory${bad}`)).status,
        400,
        bad,
      );
    assert.equal(
      (await json("/submit-report/directory?person=missing-person")).status,
      404,
    );
    const disabled = createPublicSite({ services, assets: siteAssets() });
    assert.equal((await get(disabled, "/submit-report/directory")).status, 404);
  });
});

test("the API accepts structured grievances and staff detail reads them back with names", async () => {
  const store = new MemoryReportIntakeStore();
  const api = createReportApiModule({
    store,
    services: {
      async listCounties() {
        return [
          { fips: "synthetic-county", name: "Synthetic" },
          { fips: "synthetic-county-2", name: "Synthetic Two" },
        ];
      },
      async resolvePrincipal() {
        return { accountId: "synthetic-editor", role: "editor", kind: "human" };
      },
      async hasCapability() {
        return true;
      },
      async getPersonProfile({ personId }) {
        return {
          person: { id: personId, displayName: "Synthetic Person" },
          items: [
            {
              role: {
                id: "synthetic-person-role-1",
                publishedTitle: "Synthetic Clerk",
                publishedOffice: "Synthetic Office",
                sourceCheckedAt: "2026-10-02",
                startDate: null,
                endDate: "2023-01-09",
              },
              position: null,
              organization: null,
            },
          ],
          nextCursor: null,
          hasMore: false,
        };
      },
    },
    guestSubmissions: {
      enabled: true,
      abuseControl: { check: async () => ({ allowed: true }) },
    },
  });
  const origin = "https://local.test";
  const body = structured([
    grievance(),
    grievance({ countyId: "synthetic-county-2", date: { year: 2025 } }),
  ]);
  const created = await api.fetch(
    new Request(`${origin}/api/v1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    }),
  );
  assert.equal(created.status, 201);
  const { reference } = await created.json();
  const id = store.reportIdForReference(reference);
  const detail = await (
    await api.fetch(new Request(`${origin}/api/v1/reports/${id}`))
  ).json();
  assert.equal(detail.report.grievances.length, 2);
  assert.equal(detail.countyNames["synthetic-county-2"], "Synthetic Two");
  assert.equal(detail.employees["synthetic-person"].name, "Synthetic Person");
  assert.equal(
    detail.employees["synthetic-person"].roles["synthetic-person-role-1"].title,
    "Synthetic Clerk",
  );
  // An unknown key inside a grievance is refused, not stored.
  const rejected = await api.fetch(
    new Request(`${origin}/api/v1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(
        structured([grievance({ surprise: 1 })], {
          idempotencyKey: "synthetic-structured-002",
        }),
      ),
    }),
  );
  assert.equal(rejected.status, 400);
});

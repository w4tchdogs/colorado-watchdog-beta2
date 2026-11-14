import assert from "node:assert/strict";
import test from "node:test";
import {
  getReportForStaff,
  submitReport,
  trackReport,
  transitionReport,
} from "../dist/services/report-intake.js";
import { MemoryReportIntakeStore } from "../dist/services/report-intake-memory.js";

const reporter = { kind: "reporter" };
const editor = { kind: "staff", accountId: "synthetic-editor", role: "editor" };
const submission = (overrides = {}) => ({
  countyId: "synthetic-county",
  subject: { kind: "person", id: "synthetic-person" },
  description: "A fictional report used only to test private intake.",
  evidence: [
    { title: "Synthetic source", url: "https://example.invalid/source" },
  ],
  reporter: {
    attribution: "anonymous",
    confidential: true,
    contactPreference: "none",
  },
  idempotencyKey: "synthetic-request-001",
  ...overrides,
});

test("validates, accepts a private report, and authenticates tracking separately", async () => {
  const store = new MemoryReportIntakeStore();
  const result = await submitReport(store, submission(), reporter);
  assert.deepEqual(Object.keys(result.receipt).sort(), [
    "recoveryKey",
    "reference",
  ]);
  assert.equal(result.receipt.reference.includes("rpt_"), false);
  const tracking = await trackReport(
    store,
    result.receipt.reference,
    result.receipt.recoveryKey,
  );
  assert.equal(tracking.status, "submitted");
  assert.deepEqual(
    tracking.history.map(({ to }) => to),
    ["submitted"],
  );
  await assert.rejects(
    trackReport(store, result.receipt.reference, "incorrect"),
    { code: "NOT_FOUND", message: "Report is unavailable." },
  );
  await assert.rejects(
    trackReport(store, "rpt_internal", result.receipt.recoveryKey),
    { code: "NOT_FOUND", message: "Report is unavailable." },
  );
  await assert.rejects(
    getReportForStaff(
      store,
      store.reportIdForReference(result.receipt.reference),
      reporter,
    ),
    {
      code: "NOT_FOUND",
      message: "Report is unavailable.",
    },
  );
  assert.equal(
    (
      await getReportForStaff(
        store,
        store.reportIdForReference(result.receipt.reference),
        editor,
      )
    ).report.description,
    submission().description,
  );
});

test("is idempotent for identical requests and conflicts on changed replay", async () => {
  const store = new MemoryReportIntakeStore();
  const first = await submitReport(store, submission(), reporter);
  const retry = await submitReport(store, submission(), reporter);
  assert.equal(retry.replayed, true);
  assert.equal(Object.hasOwn(retry.receipt, "reportId"), false);
  assert.equal(retry.receipt.reference, first.receipt.reference);
  assert.equal(retry.receipt.recoveryKey, undefined);
  await assert.rejects(
    submitReport(
      store,
      submission({ description: "A different fictional report body." }),
      reporter,
    ),
    { code: "CONFLICT" },
  );
});

test("concurrent transitions commit once and leave one append-only event", async () => {
  const store = new MemoryReportIntakeStore();
  const { receipt } = await submitReport(store, submission(), reporter);
  const reportId = store.reportIdForReference(receipt.reference);
  const outcomes = await Promise.allSettled([
    transitionReport(store, reportId, 1, "triage", editor),
    transitionReport(store, reportId, 1, "triage", editor),
  ]);
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(({ status }) => status === "rejected").length,
    1,
  );
  const commit = await getReportForStaff(store, reportId, editor);
  assert.equal(commit.history.length, 2);
  assert.equal(commit.audit.length, 2);
});

test("rejects invalid fields and caller-supplied account authority", async () => {
  const store = new MemoryReportIntakeStore();
  await assert.rejects(
    submitReport(store, submission({ countyId: "../private" }), reporter),
    {
      code: "INVALID_SUBMISSION",
    },
  );
  await assert.rejects(
    submitReport(store, submission({ countyId: "synthetic-other" }), reporter),
    { code: "INVALID_SUBMISSION" },
  );
  await assert.rejects(
    submitReport(
      store,
      submission({
        reporter: { ...submission().reporter, accountId: "spoofed" },
      }),
      reporter,
    ),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    submitReport(
      store,
      submission({
        evidence: [{ title: "bad", url: "javascript:alert(1)" }],
      }),
      reporter,
    ),
    { code: "INVALID_SUBMISSION" },
  );
  await assert.rejects(
    submitReport(
      store,
      submission({
        reporter: {
          ...submission().reporter,
          attribution: "signed",
          name: "",
        },
      }),
      reporter,
    ),
    { code: "INVALID_SUBMISSION" },
  );
  await assert.rejects(
    submitReport(store, submission({ subject: null }), reporter),
    { code: "INVALID_SUBMISSION" },
  );
});

test("staff transitions are authorized, versioned, and append history/audit once", async () => {
  const store = new MemoryReportIntakeStore();
  const { receipt } = await submitReport(store, submission(), reporter);
  const reportId = store.reportIdForReference(receipt.reference);
  await assert.rejects(
    transitionReport(store, reportId, 1, "triage", reporter),
    {
      code: "NOT_FOUND",
    },
  );
  await assert.rejects(
    transitionReport(store, reportId, 1, "accepted", editor),
    {
      code: "INVALID_TRANSITION",
    },
  );
  await transitionReport(store, reportId, 1, "triage", editor);
  await assert.rejects(
    transitionReport(store, reportId, 1, "under-review", editor),
    {
      code: "CONFLICT",
    },
  );
  const commit = await getReportForStaff(store, reportId, editor);
  assert.equal(commit.report.version, 2);
  assert.deepEqual(
    commit.history.map(({ to }) => to),
    ["submitted", "triage"],
  );
  assert.deepEqual(
    commit.audit.map(({ action }) => action),
    ["submitted", "status-changed"],
  );
  assert.equal(commit.history[1].actor.accountId, editor.accountId);
});

import type {
  IntakeCommit,
  ReportActor,
  ReportAuditEvent,
  ReportIntakeStore,
  ReportRecord,
  ReportStatus,
  ReportStatusEvent,
  ReportSubmission,
} from "../contracts/report-intake.js";
import { ReportIntakeError } from "../contracts/report-intake.js";

const transitions: Record<ReportStatus, readonly ReportStatus[]> = {
  submitted: ["triage"],
  triage: ["under-review", "needs-information", "declined"],
  "under-review": ["needs-information", "accepted", "declined"],
  "needs-information": ["under-review", "closed"],
  accepted: ["closed"],
  declined: ["closed"],
  closed: [],
};

const id = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const digest = async (value: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
const token = (bytes: number) => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export function validateSubmission(value: ReportSubmission): void {
  const invalid =
    !value ||
    typeof value.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(value.idempotencyKey) ||
    typeof value.countyId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value.countyId) ||
    typeof value.description !== "string" ||
    value.description.trim().length < 20 ||
    value.description.length > 12000 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 10 ||
    !value.reporter ||
    typeof value.reporter !== "object" ||
    value.reporter.confidential !== true ||
    !["anonymous", "signed"].includes(value.reporter.attribution) ||
    (value.reporter.name !== undefined &&
      (typeof value.reporter.name !== "string" ||
        value.reporter.name.trim().length < 1 ||
        value.reporter.name.length > 200)) ||
    (value.reporter.attribution === "signed" && !value.reporter.name) ||
    !["none", "email"].includes(value.reporter.contactPreference) ||
    (value.reporter.email !== undefined &&
      (typeof value.reporter.email !== "string" ||
        value.reporter.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.reporter.email))) ||
    (value.reporter.contactPreference === "email" && !value.reporter.email) ||
    (value.subject !== undefined &&
      (!value.subject ||
        typeof value.subject !== "object" ||
        !["person", "organization"].includes(value.subject.kind) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(value.subject.id)));
  if (invalid) throw new ReportIntakeError("INVALID_SUBMISSION");
  for (const item of value.evidence) {
    if (
      !item ||
      typeof item.title !== "string" ||
      item.title.trim().length < 1 ||
      item.title.length > 200 ||
      (item.note !== undefined &&
        (typeof item.note !== "string" || item.note.length > 2000)) ||
      (item.url !== undefined &&
        (typeof item.url !== "string" ||
          item.url.length > 2048 ||
          !/^https:\/\/\S+$/i.test(item.url)))
    ) {
      throw new ReportIntakeError("INVALID_SUBMISSION");
    }
  }
}

export async function submitReport(
  store: ReportIntakeStore,
  value: ReportSubmission,
  actor: ReportActor,
  now = new Date(),
): Promise<{
  receipt: Omit<IntakeCommit["receipt"], "reportId" | "recoveryKey"> & {
    recoveryKey?: string;
  };
  replayed: boolean;
}> {
  validateSubmission(value);
  if (
    !(await store.validateReferences({
      countyId: value.countyId,
      subject: value.subject,
    }))
  ) {
    throw new ReportIntakeError("INVALID_SUBMISSION");
  }
  if (
    actor.kind === "reporter" &&
    value.reporter.accountId &&
    actor.accountId !== value.reporter.accountId
  ) {
    throw new ReportIntakeError("FORBIDDEN");
  }
  const normalized = structuredClone(value);
  normalized.description = value.description.trim();
  normalized.reporter.accountId =
    actor.kind === "reporter" ? actor.accountId : undefined;
  const fingerprint = await digest(
    JSON.stringify({ ...normalized, idempotencyKey: undefined }),
  );
  const receipt = {
    reportId: id("rpt"),
    reference: `CW-${token(8).toUpperCase()}`,
  };
  const recoveryKey = token(32);
  const report: ReportRecord = {
    id: receipt.reportId,
    countyId: normalized.countyId,
    subject: normalized.subject,
    description: normalized.description,
    evidence: normalized.evidence,
    reporter: normalized.reporter,
    status: "submitted",
    version: 1,
    createdAt: now.toISOString(),
  };
  const event: ReportStatusEvent = {
    id: id("rse"),
    reportId: report.id,
    from: null,
    to: "submitted",
    actor,
    at: now.toISOString(),
    version: 1,
  };
  const audit: ReportAuditEvent = {
    id: id("aud"),
    reportId: report.id,
    action: "submitted",
    actor,
    at: now.toISOString(),
    version: 1,
  };
  const result = await store.create({
    report,
    receipt,
    receiptDigest: await digest(recoveryKey),
    idempotencyKey: `${actor.kind}:${actor.accountId ?? "guest"}:${value.idempotencyKey}`,
    fingerprint,
    history: event,
    audit,
  });
  const { reportId: _internalReportId, ...safeReceipt } = result.commit.receipt;
  return {
    receipt: result.replayed ? safeReceipt : { ...safeReceipt, recoveryKey },
    replayed: result.replayed,
  };
}

export async function trackReport(
  store: ReportIntakeStore,
  reference: string,
  recoveryKey: string,
): Promise<{
  status: ReportStatus;
  submittedAt: string;
  history: Array<Pick<ReportStatusEvent, "from" | "to" | "at">>;
}> {
  if (
    typeof reference !== "string" ||
    !/^CW-[A-F0-9]{16}$/.test(reference) ||
    typeof recoveryKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(recoveryKey)
  ) {
    throw new ReportIntakeError("NOT_FOUND");
  }
  const commit = await store.findByReceipt(
    reference,
    await digest(recoveryKey),
  );
  if (!commit) throw new ReportIntakeError("NOT_FOUND");
  return {
    status: commit.report.status,
    submittedAt: commit.report.createdAt,
    history: commit.history.map(({ from, to, at }) => ({ from, to, at })),
  };
}

export async function getReportForStaff(
  store: ReportIntakeStore,
  reportId: string,
  actor: ReportActor,
): Promise<IntakeCommit> {
  if (actor.kind !== "staff") throw new ReportIntakeError("NOT_FOUND");
  const commit = await store.getPrivate(reportId, actor);
  if (!commit) throw new ReportIntakeError("NOT_FOUND");
  return commit;
}

export async function transitionReport(
  store: ReportIntakeStore,
  reportId: string,
  expectedVersion: number,
  status: ReportStatus,
  actor: ReportActor,
  note?: string,
  now = new Date(),
): Promise<void> {
  if (actor.kind !== "staff") throw new ReportIntakeError("NOT_FOUND");
  if (
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1 ||
    (note && note.length > 4000)
  ) {
    throw new ReportIntakeError("INVALID_SUBMISSION");
  }
  const current = await store.getPrivate(reportId, actor);
  if (!current) throw new ReportIntakeError("NOT_FOUND");
  if (current.report.version !== expectedVersion)
    throw new ReportIntakeError("CONFLICT");
  if (!transitions[current.report.status].includes(status))
    throw new ReportIntakeError("INVALID_TRANSITION");
  const version = expectedVersion + 1;
  const next = { ...current.report, status, version };
  const history: ReportStatusEvent = {
    id: id("rse"),
    reportId,
    from: current.report.status,
    to: status,
    actor,
    at: now.toISOString(),
    note,
    version,
  };
  const audit: ReportAuditEvent = {
    id: id("aud"),
    reportId,
    action: "status-changed",
    actor,
    at: now.toISOString(),
    version,
  };
  if (
    !(await store.compareAndSet({
      reportId,
      actor,
      expectedVersion,
      next,
      history,
      audit,
    }))
  ) {
    throw new ReportIntakeError("CONFLICT");
  }
}

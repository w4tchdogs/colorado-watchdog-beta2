export type ReportStatus =
  | "submitted"
  | "triage"
  | "under-review"
  | "needs-information"
  | "accepted"
  | "declined"
  | "closed";

export type ReportActor =
  | { kind: "reporter"; accountId?: string }
  | { kind: "staff"; accountId: string; role: "editor" | "administrator" };

export interface ReportSubmission {
  countyId: string;
  subject?: { kind: "person" | "organization"; id: string };
  description: string;
  evidence: Array<{ title: string; url?: string; note?: string }>;
  reporter: {
    accountId?: string;
    name?: string;
    email?: string;
    attribution: "anonymous" | "signed";
    confidential: true;
    contactPreference: "none" | "email";
  };
  idempotencyKey: string;
}

export interface ReportRecord {
  id: string;
  countyId: string;
  subject?: ReportSubmission["subject"];
  description: string;
  evidence: ReportSubmission["evidence"];
  reporter: ReportSubmission["reporter"];
  status: ReportStatus;
  version: number;
  createdAt: string;
}

export interface ReportStatusEvent {
  id: string;
  reportId: string;
  from: ReportStatus | null;
  to: ReportStatus;
  actor: ReportActor;
  at: string;
  note?: string;
  version: number;
}

export interface ReportAuditEvent {
  id: string;
  reportId: string;
  action: "submitted" | "status-changed";
  actor: ReportActor;
  at: string;
  version: number;
}

/** Only a digest of this credential is persisted by a durable adapter. */
export interface ReportReceipt {
  reportId: string;
  reference: string;
}

export interface IntakeCommit {
  report: ReportRecord;
  receipt: ReportReceipt;
  history: ReportStatusEvent[];
  audit: ReportAuditEvent[];
}

export interface ReportIntakeStore {
  validateReferences(input: {
    countyId: string;
    subject?: ReportSubmission["subject"];
  }): Promise<boolean>;
  /** Atomically enforces idempotency and persists report, receipt digest, history and audit. */
  create(input: {
    report: ReportRecord;
    receipt: ReportReceipt;
    receiptDigest: string;
    idempotencyKey: string;
    fingerprint: string;
    history: ReportStatusEvent;
    audit: ReportAuditEvent;
  }): Promise<{ commit: IntakeCommit; replayed: boolean }>;
  /** actor is supplied by the server-side authorization boundary, never the request body. */
  getPrivate(
    reportId: string,
    actor: Extract<ReportActor, { kind: "staff" }>,
  ): Promise<IntakeCommit | undefined>;
  findByReceipt(
    reference: string,
    recoveryDigest: string,
  ): Promise<IntakeCommit | undefined>;
  compareAndSet(input: {
    reportId: string;
    actor: Extract<ReportActor, { kind: "staff" }>;
    expectedVersion: number;
    next: ReportRecord;
    history: ReportStatusEvent;
    audit: ReportAuditEvent;
  }): Promise<boolean>;
}

export type ReportIntakeErrorCode =
  | "INVALID_SUBMISSION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INVALID_TRANSITION";

export class ReportIntakeError extends Error {
  constructor(public readonly code: ReportIntakeErrorCode) {
    super(
      code === "NOT_FOUND" || code === "FORBIDDEN"
        ? "Report is unavailable."
        : code === "CONFLICT"
          ? "The report changed. Reload and try again."
          : code === "INVALID_TRANSITION"
            ? "This status change is not allowed."
            : "The report submission is invalid.",
    );
    this.name = "ReportIntakeError";
  }
}

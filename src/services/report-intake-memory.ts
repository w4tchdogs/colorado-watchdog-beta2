import type {
  IntakeCommit,
  ReportAuditEvent,
  ReportIntakeStore,
  ReportReceipt,
  ReportRecord,
  ReportStatusEvent,
} from "../contracts/report-intake.js";
import { ReportIntakeError } from "../contracts/report-intake.js";

/** Synthetic-only adapter. Production adapters must hash receipt credentials at rest. */
export class MemoryReportIntakeStore implements ReportIntakeStore {
  #records = new Map<string, IntakeCommit>();
  #receipts = new Map<string, { reportId: string; digest: string }>();
  #idempotency = new Map<string, { fingerprint: string; reportId: string }>();

  /** Test-only lookup; never expose this helper from a production adapter. */
  reportIdForReference(reference: string): string | undefined {
    return this.#receipts.get(reference)?.reportId;
  }

  async validateReferences(input: {
    countyId: string;
    subject?: { kind: "person" | "organization"; id: string };
  }): Promise<boolean> {
    return (
      input.countyId === "synthetic-county" &&
      (!input.subject || input.subject.id.startsWith("synthetic-"))
    );
  }

  async create(input: {
    report: ReportRecord;
    receipt: ReportReceipt;
    receiptDigest: string;
    idempotencyKey: string;
    fingerprint: string;
    history: ReportStatusEvent;
    audit: ReportAuditEvent;
  }): Promise<{ commit: IntakeCommit; replayed: boolean }> {
    const old = this.#idempotency.get(input.idempotencyKey);
    if (old) {
      if (old.fingerprint !== input.fingerprint)
        throw new ReportIntakeError("CONFLICT");
      const commit = this.#records.get(old.reportId);
      if (!commit) throw new ReportIntakeError("CONFLICT");
      return { commit: structuredClone(commit), replayed: true };
    }
    const commit = {
      report: structuredClone(input.report),
      receipt: structuredClone(input.receipt),
      history: [structuredClone(input.history)],
      audit: [structuredClone(input.audit)],
    };
    this.#records.set(input.report.id, commit);
    this.#receipts.set(input.receipt.reference, {
      reportId: input.report.id,
      digest: input.receiptDigest,
    });
    this.#idempotency.set(input.idempotencyKey, {
      fingerprint: input.fingerprint,
      reportId: input.report.id,
    });
    return { commit: structuredClone(commit), replayed: false };
  }

  async getPrivate(reportId: string): Promise<IntakeCommit | undefined> {
    const value = this.#records.get(reportId);
    return value && structuredClone(value);
  }

  async findByReceipt(
    reference: string,
    recoveryDigest: string,
  ): Promise<IntakeCommit | undefined> {
    const receipt = this.#receipts.get(reference);
    if (!receipt || receipt.digest !== recoveryDigest) return undefined;
    const value = this.#records.get(receipt.reportId);
    return value && structuredClone(value);
  }

  async compareAndSet(input: {
    reportId: string;
    expectedVersion: number;
    next: ReportRecord;
    history: ReportStatusEvent;
    audit: ReportAuditEvent;
  }): Promise<boolean> {
    const current = this.#records.get(input.reportId);
    if (!current || current.report.version !== input.expectedVersion)
      return false;
    current.report = structuredClone(input.next);
    current.history.push(structuredClone(input.history));
    current.audit.push(structuredClone(input.audit));
    return true;
  }
}

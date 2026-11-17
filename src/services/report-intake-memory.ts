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
    grievances?: ReadonlyArray<{
      countyId: string;
      subject:
        | { kind: "listed"; personId: string; roleId: string }
        | { kind: "unlisted"; name: string; office: string };
    }>;
  }): Promise<boolean> {
    const county = (id: string) => id.startsWith("synthetic-county");
    return (
      county(input.countyId) &&
      (!input.subject || input.subject.id.startsWith("synthetic-")) &&
      (input.grievances ?? []).every(
        (g) =>
          county(g.countyId) &&
          (g.subject.kind === "unlisted" ||
            (g.subject.personId.startsWith("synthetic-") &&
              g.subject.roleId.startsWith(`${g.subject.personId}-role`))),
      )
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
    if (this.#receipts.has(input.receipt.reference))
      throw new ReportIntakeError("CONFLICT");
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

  async getPrivate(
    reportId: string,
    _actor: {
      kind: "staff";
      accountId: string;
      role: "editor" | "administrator";
    },
  ): Promise<IntakeCommit | undefined> {
    const value = this.#records.get(reportId);
    return value && structuredClone(value);
  }

  async findByReceipt(
    reference: string,
    recoveryDigest: string,
  ): Promise<IntakeCommit | undefined> {
    const receipt = this.#receipts.get(reference);
    if (!receipt || !constantTimeEqual(receipt.digest, recoveryDigest))
      return undefined;
    const value = this.#records.get(receipt.reportId);
    return value && structuredClone(value);
  }

  async compareAndSet(input: {
    reportId: string;
    actor: {
      kind: "staff";
      accountId: string;
      role: "editor" | "administrator";
    };
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

  async listPrivate(input: {
    limit: number;
    after?: string;
    status?: ReportRecord["status"];
  }): Promise<{
    reports: Array<
      Pick<
        ReportRecord,
        "id" | "countyId" | "subject" | "status" | "version" | "createdAt"
      >
    >;
    next: string | null;
  }> {
    const rows = [...this.#records.values()]
      .map(({ report }) => report)
      .filter((report) => !input.status || report.status === input.status)
      .filter((report) => !input.after || report.id > input.after)
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = rows.slice(0, input.limit + 1);
    const more = page.length > input.limit;
    const reports = page.slice(0, input.limit);
    return {
      reports: structuredClone(
        reports.map(
          ({ id, countyId, subject, status, version, createdAt }) => ({
            id,
            countyId,
            subject,
            status,
            version,
            createdAt,
          }),
        ),
      ),
      next: more ? (reports.at(-1)?.id ?? null) : null,
    };
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1)
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

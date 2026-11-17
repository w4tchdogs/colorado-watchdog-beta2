import type {
  IntakeCommit,
  ReportAuditEvent,
  ReportIntakeStore,
  ReportQueueItem,
  ReportReceipt,
  ReportRecord,
  ReportStatusEvent,
} from "../contracts/report-intake.js";
import { ReportIntakeError } from "../contracts/report-intake.js";
import type { AsyncD1Database } from "../database/d1.js";

type Row = Record<string, unknown>;

/**
 * Private report storage for the Website D1 binding. Authorization is deliberately
 * outside this adapter: callers must authorize staff before invoking private reads.
 */
export class D1ReportIntakeStore implements ReportIntakeStore {
  constructor(
    private readonly db: AsyncD1Database,
    /**
     * Must close over ACCT-1's verified server-side principal/session. Do not
     * implement this by trusting the actor's role or accountId fields.
     */
    private readonly authorizeStaff: (actor: {
      kind: "staff";
      accountId: string;
      role: "editor" | "administrator" | "owner";
    }) => Promise<boolean>,
  ) {}

  async validateReferences(input: {
    countyId: string;
    subject?: ReportRecord["subject"];
    grievances?: ReportRecord["grievances"];
  }): Promise<boolean> {
    if (
      !(await this.db.first("SELECT fips FROM counties WHERE fips = ?", [
        input.countyId,
      ]))
    )
      return false;
    for (const grievance of input.grievances ?? []) {
      if (
        !(await this.db.first("SELECT fips FROM counties WHERE fips = ?", [
          grievance.countyId,
        ]))
      )
        return false;
      if (
        grievance.subject.kind === "listed" &&
        !(await this.db.first(
          "SELECT id FROM person_roles WHERE id = ? AND person_id = ?",
          [grievance.subject.roleId, grievance.subject.personId],
        ))
      )
        return false;
    }
    if (!input.subject) return true;
    const table = input.subject.kind === "person" ? "people" : "organizations";
    return Boolean(
      await this.db.first(`SELECT id FROM ${table} WHERE id = ?`, [
        input.subject.id,
      ]),
    );
  }

  async create(input: {
    report: ReportRecord;
    receipt: ReportReceipt;
    recoveryKey: string;
    receiptDigest: string;
    idempotencyKey: string;
    fingerprint: string;
    history: ReportStatusEvent;
    audit: ReportAuditEvent;
  }): Promise<{ commit: IntakeCommit; replayed: boolean }> {
    const separator = input.idempotencyKey.indexOf(":");
    const scope = input.idempotencyKey.slice(0, separator);
    const key = input.idempotencyKey.slice(separator + 1);
    const existing = await this.db.first<Row>(
      "SELECT fingerprint, report_id FROM report_idempotency WHERE actor_scope = ? AND idempotency_key = ?",
      [scope, key],
    );
    if (existing) return this.replay(existing, input.fingerprint);

    const report = input.report;
    const statements = [
      this.db.prepare(
        `INSERT INTO reports (id, county_fips, subject_kind, subject_id, private_json, status, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          report.id,
          report.countyId,
          report.subject?.kind ?? null,
          report.subject?.id ?? null,
          JSON.stringify({
            description: report.description,
            ...(report.headline !== undefined
              ? { headline: report.headline }
              : {}),
            ...(report.grievances ? { grievances: report.grievances } : {}),
            reporter: report.reporter,
          }),
          report.status,
          report.version,
          report.createdAt,
        ],
      ),
      this.db.prepare(
        "INSERT INTO report_receipts (report_id, reference, credential_digest, created_at) VALUES (?, ?, ?, ?)",
        [
          report.id,
          input.receipt.reference,
          input.receiptDigest,
          report.createdAt,
        ],
      ),
      ...report.evidence.map((evidence) =>
        this.db.prepare(
          "INSERT INTO report_evidence (report_id, evidence_id, private_json) VALUES (?, ?, ?)",
          [report.id, crypto.randomUUID(), JSON.stringify(evidence)],
        ),
      ),
      this.historyStatement(input.history),
      this.auditStatement(input.audit),
      this.db.prepare(
        "INSERT INTO report_idempotency (actor_scope, idempotency_key, fingerprint, report_id) VALUES (?, ?, ?, ?)",
        [scope, key, input.fingerprint, report.id],
      ),
    ];
    try {
      await this.db.batch(statements);
      return {
        commit: {
          report: structuredClone(report),
          receipt: structuredClone(input.receipt),
          history: [structuredClone(input.history)],
          audit: [structuredClone(input.audit)],
        },
        replayed: false,
      };
    } catch {
      // A unique-key race is resolved by reading only the idempotency winner.
      const winner = await this.db.first<Row>(
        "SELECT fingerprint, report_id FROM report_idempotency WHERE actor_scope = ? AND idempotency_key = ?",
        [scope, key],
      );
      if (winner) return this.replay(winner, input.fingerprint);
      throw new ReportIntakeError("CONFLICT");
    }
  }

  async getPrivate(
    reportId: string,
    actor: {
      kind: "staff";
      accountId: string;
      role: "editor" | "administrator" | "owner";
    },
  ): Promise<IntakeCommit | undefined> {
    if (!(await this.authorizeStaff(actor)))
      throw new ReportIntakeError("NOT_FOUND");
    return this.load(reportId);
  }

  async findByReceipt(
    reference: string,
    recoveryDigest: string,
  ): Promise<IntakeCommit | undefined> {
    const row = await this.db.first<Row>(
      "SELECT report_id, credential_digest FROM report_receipts WHERE reference = ?",
      [reference],
    );
    if (
      !row ||
      typeof row.report_id !== "string" ||
      typeof row.credential_digest !== "string" ||
      !constantTimeEqual(row.credential_digest, recoveryDigest)
    )
      return undefined;
    return this.load(row.report_id);
  }

  async compareAndSet(input: {
    reportId: string;
    actor: {
      kind: "staff";
      accountId: string;
      role: "editor" | "administrator" | "owner";
    };
    expectedVersion: number;
    next: ReportRecord;
    history: ReportStatusEvent;
    audit: ReportAuditEvent;
  }): Promise<boolean> {
    if (!(await this.authorizeStaff(input.actor))) return false;
    try {
      await this.db.batch([
        this.db.prepare(
          "UPDATE reports SET status = ?, version = ? WHERE id = ? AND version = ?",
          [
            input.next.status,
            input.next.version,
            input.reportId,
            input.expectedVersion,
          ],
        ),
        this.historyStatement(input.history),
        this.auditStatement(input.audit),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async listPrivate(
    input: { limit: number; after?: string; status?: ReportRecord["status"] },
    actor: {
      kind: "staff";
      accountId: string;
      role: "editor" | "administrator" | "owner";
    },
  ): Promise<{ reports: ReportQueueItem[]; next: string | null }> {
    if (!(await this.authorizeStaff(actor)))
      throw new ReportIntakeError("NOT_FOUND");
    const rows = await this.db.all<Row>(
      `SELECT id, county_fips, subject_kind, subject_id, status, version, created_at
       FROM reports
       WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id > ?)
       ORDER BY id`,
      input.limit + 1,
      [
        input.status ?? null,
        input.status ?? null,
        input.after ?? null,
        input.after ?? null,
      ],
    );
    const more = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      reports: page.map((row) => ({
        id: String(row.id),
        countyId: String(row.county_fips),
        ...(row.subject_kind === null
          ? {}
          : {
              subject: {
                kind: row.subject_kind as "person" | "organization",
                id: String(row.subject_id),
              },
            }),
        status: row.status as ReportRecord["status"],
        version: Number(row.version),
        createdAt: String(row.created_at),
      })),
      next: more ? String(page.at(-1)?.id) : null,
    };
  }

  private async replay(
    row: Row,
    fingerprint: string,
  ): Promise<{ commit: IntakeCommit; replayed: true }> {
    if (row.fingerprint !== fingerprint || typeof row.report_id !== "string")
      throw new ReportIntakeError("CONFLICT");
    const commit = await this.load(row.report_id);
    if (!commit) throw new ReportIntakeError("CONFLICT");
    return { commit, replayed: true };
  }

  private async load(reportId: string): Promise<IntakeCommit | undefined> {
    const [reportRow, receiptRow, evidenceRows, historyRows, auditRows] =
      await Promise.all([
        this.db.first<Row>("SELECT * FROM reports WHERE id = ?", [reportId]),
        this.db.first<Row>(
          "SELECT report_id, reference FROM report_receipts WHERE report_id = ?",
          [reportId],
        ),
        this.db.all<Row>(
          "SELECT private_json FROM report_evidence WHERE report_id = ? ORDER BY evidence_id",
          10,
          [reportId],
        ),
        this.db.all<Row>(
          "SELECT * FROM report_status_history WHERE report_id = ? ORDER BY version",
          100,
          [reportId],
        ),
        this.db.all<Row>(
          "SELECT * FROM report_audit WHERE report_id = ? ORDER BY version",
          100,
          [reportId],
        ),
      ]);
    if (!reportRow || !receiptRow) return undefined;
    const privateData = parseJson<{
      description: string;
      headline?: string;
      grievances?: ReportRecord["grievances"];
      reporter: ReportRecord["reporter"];
    }>(reportRow.private_json);
    const subject =
      reportRow.subject_kind === null
        ? undefined
        : {
            kind: reportRow.subject_kind as "person" | "organization",
            id: String(reportRow.subject_id),
          };
    const report: ReportRecord = {
      id: String(reportRow.id),
      countyId: String(reportRow.county_fips),
      subject,
      description: privateData.description,
      ...(privateData.headline !== undefined
        ? { headline: privateData.headline }
        : {}),
      ...(privateData.grievances ? { grievances: privateData.grievances } : {}),
      reporter: privateData.reporter,
      evidence: evidenceRows.map((item) => parseJson(item.private_json)),
      status: reportRow.status as ReportRecord["status"],
      version: Number(reportRow.version),
      createdAt: String(reportRow.created_at),
    };
    return {
      report,
      receipt: {
        reportId,
        reference: String(receiptRow.reference),
      },
      history: historyRows.map((item) => ({
        id: String(item.id),
        reportId,
        from: item.from_status as ReportStatusEvent["from"],
        to: item.to_status as ReportStatusEvent["to"],
        actor: parseJson(item.actor_json),
        at: String(item.occurred_at),
        note: item.private_note == null ? undefined : String(item.private_note),
        version: Number(item.version),
      })),
      audit: auditRows.map((item) => ({
        id: String(item.id),
        reportId,
        action: item.action as ReportAuditEvent["action"],
        actor: parseJson(item.actor_json),
        at: String(item.occurred_at),
        version: Number(item.version),
      })),
    };
  }

  private historyStatement(event: ReportStatusEvent) {
    return this.db.prepare(
      `INSERT INTO report_status_history
       (id, report_id, from_status, to_status, actor_json, occurred_at, private_note, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.reportId,
        event.from,
        event.to,
        JSON.stringify(event.actor),
        event.at,
        event.note ?? null,
        event.version,
      ],
    );
  }

  private auditStatement(event: ReportAuditEvent) {
    return this.db.prepare(
      "INSERT INTO report_audit (id, report_id, action, actor_json, occurred_at, version) VALUES (?, ?, ?, ?, ?, ?)",
      [
        event.id,
        event.reportId,
        event.action,
        JSON.stringify(event.actor),
        event.at,
        event.version,
      ],
    );
  }
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Invalid private report data");
  return JSON.parse(value) as T;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1)
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

import type { ReportSubmission } from "../contracts/report-intake.js";
import type {
  ReportTrackingProjection,
  ReportUiAdapter,
} from "../site/report-interface.js";

interface DemoRecord {
  readonly recoveryDigest: string;
  readonly projection: ReportTrackingProjection;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Browser-only fixture adapter. It stores no report text and makes no requests. */
export function createFictionalReportAdapter(
  now: () => Date = () => new Date(),
): ReportUiAdapter {
  const records = new Map<string, DemoRecord>();
  const idempotency = new Map<string, string>();
  return {
    async submit(input: ReportSubmission) {
      const priorReference = idempotency.get(input.idempotencyKey);
      if (priorReference) return { reference: priorReference };
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const reference = `CW-${[...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`;
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const recoveryKey = [...keyBytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const submittedAt = now().toISOString();
      records.set(reference, {
        recoveryDigest: await digest(recoveryKey),
        projection: {
          status: "submitted",
          submittedAt,
          history: [{ from: null, to: "submitted", at: submittedAt }],
        },
      });
      idempotency.set(input.idempotencyKey, reference);
      return { reference, recoveryKey };
    },
    async track(reference: string, recoveryKey: string) {
      const record = records.get(reference);
      if (
        !record ||
        !equalDigest(record.recoveryDigest, await digest(recoveryKey))
      ) {
        throw new Error("Report is unavailable.");
      }
      return record.projection;
    },
  };
}

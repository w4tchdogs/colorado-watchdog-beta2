import { createHash, randomBytes } from "node:crypto";
import type { CheckpointLimits } from "../../contracts/checkpoints.js";

const MIB = 1024 * 1024;

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxTables: 1000,
  maxRows: 5_000_000,
  maxDatabaseBytes: 512 * MIB,
  maxSchemaBytes: 4 * MIB,
  maxFiles: 100_000,
  maxFileBytes: 256 * MIB,
  maxTotalFileBytes: 4096 * MIB,
  maxManifestBytes: 32 * MIB,
  maxMembers: 200_000,
  maxFailures: 20,
};

export interface CheckpointErrorOptions {
  readonly subject?: string;
  /** True when the error describes a defect in bundle contents. */
  readonly bundleDefect?: boolean;
}

/**
 * Checkpoint failure with a stable code. Messages are bounded and must never
 * contain row values or file contents.
 */
export class CheckpointError extends Error {
  readonly code: string;
  readonly subject: string;
  readonly bundleDefect: boolean;

  constructor(
    code: string,
    message: string,
    options: CheckpointErrorOptions = {},
  ) {
    super(sanitizeDiagnostic(message));
    this.name = "CheckpointError";
    this.code = code;
    this.subject = sanitizeDiagnostic(options.subject ?? "", 120);
    this.bundleDefect = options.bundleDefect ?? false;
  }
}

export function bundleDefect(
  code: string,
  message: string,
  subject = "",
): CheckpointError {
  return new CheckpointError(code, message, { subject, bundleDefect: true });
}

/** Removes control characters and bounds length for logs and reports. */
export function sanitizeDiagnostic(text: string, maxLength = 200): string {
  let clean = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? "?" : character;
    if (clean.length >= maxLength) {
      return `${clean.slice(0, maxLength - 3)}...`;
    }
  }
  return clean;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, integers only. Used for the manifest and the schema document.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CheckpointError(
        "canonical_json_unsupported",
        "Canonical JSON accepts only safe integers",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new CheckpointError(
    "canonical_json_unsupported",
    "Canonical JSON received an unsupported value",
  );
}

const CHECKPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function assertCheckpointId(id: string): void {
  if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) {
    throw new CheckpointError(
      "invalid_checkpoint_id",
      "Checkpoint identifiers use 8 to 64 lowercase letters, digits or hyphens",
    );
  }
}

export function newCheckpointId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "z")
    .toLowerCase();
  return `ckpt-${stamp}-${randomBytes(8).toString("hex")}`;
}

const APPLICATION_COMMIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export function assertApplicationCommit(commit: string): void {
  if (typeof commit !== "string" || !APPLICATION_COMMIT_PATTERN.test(commit)) {
    throw new CheckpointError(
      "invalid_application_commit",
      "Application commit must be a short version or commit identifier",
    );
  }
}

const KEY_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Logical file keys are forward-slash paths of conservative segments. The
 * grammar is deliberately narrower than R2's so every key is a safe relative
 * path on Windows, macOS and Linux.
 */
export function assertFileKey(key: string): void {
  const segments = typeof key === "string" ? key.split("/") : [];
  const safe =
    typeof key === "string" &&
    key.length <= 512 &&
    segments.length >= 1 &&
    segments.length <= 16 &&
    segments.every(
      (segment) =>
        KEY_SEGMENT.test(segment) &&
        segment !== "." &&
        segment !== ".." &&
        !segment.endsWith(".") &&
        !WINDOWS_DEVICE.test(segment),
    );
  if (!safe) {
    throw new CheckpointError("unsafe_file_key", "Unsafe or unsupported key", {
      subject: typeof key === "string" ? key : "",
    });
  }
}

/** Keys that differ only by case collide on case-insensitive filesystems. */
export function foldKey(key: string): string {
  return key.toLowerCase();
}

const MEMBER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertMemberPath(path: string): void {
  const segments = typeof path === "string" ? path.split("/") : [];
  const safe =
    segments.length >= 1 &&
    segments.length <= 4 &&
    segments.every(
      (segment) => MEMBER_SEGMENT.test(segment) && !segment.endsWith("."),
    );
  if (!safe) {
    throw bundleDefect(
      "unsafe_member_path",
      "Unsafe bundle member path",
      typeof path === "string" ? path : "",
    );
  }
}

const SAFE_TABLE_FILE = /^[a-z_][a-z0-9_]{0,63}$/;

/** Deterministic bundle member for a table, safe for any table name. */
export function tableMemberPath(tableName: string): string {
  const file = SAFE_TABLE_FILE.test(tableName)
    ? tableName
    : `x-${sha256Hex(tableName).slice(0, 32)}`;
  return `db/tables/${file}.jsonl`;
}

export function fileMemberPath(sha256: string): string {
  return `files/${sha256}`;
}

/**
 * One exported cell. Integers and reals are decimal strings so 64-bit values
 * survive JSON. Text is "t" when it is valid UTF-8 and "x" (hex of the stored
 * bytes) otherwise. Blobs are uppercase hex. SQL NULL is JSON null.
 */
export type CheckpointCell =
  | null
  | readonly ["i" | "r" | "t" | "x" | "b", string];

const INTEGER_TEXT = /^-?(0|[1-9][0-9]*)$/;
const HEX_TEXT = /^([0-9A-F]{2})*$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Serializes a row as one ASCII-only JSON line. */
export function encodeRowLine(cells: readonly CheckpointCell[]): string {
  return JSON.stringify(cells).replace(
    /[\u007f-￿]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function decodeRowLine(
  line: string,
  columnCount: number,
  subject: string,
): CheckpointCell[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw bundleDefect("table_row_malformed", "Row is not valid JSON", subject);
  }
  if (!Array.isArray(parsed) || parsed.length !== columnCount) {
    throw bundleDefect(
      "table_row_malformed",
      "Row does not match the declared columns",
      subject,
    );
  }
  const cells = parsed.map((cell) => validateCell(cell, subject));
  if (encodeRowLine(cells) !== line) {
    throw bundleDefect(
      "table_row_malformed",
      "Row is not in canonical form",
      subject,
    );
  }
  return cells;
}

function validateCell(cell: unknown, subject: string): CheckpointCell {
  if (cell === null) {
    return null;
  }
  if (
    Array.isArray(cell) &&
    cell.length === 2 &&
    typeof cell[0] === "string" &&
    typeof cell[1] === "string"
  ) {
    const [tag, text] = cell as [string, string];
    if (tag === "t") {
      return ["t", text];
    }
    if ((tag === "x" || tag === "b") && HEX_TEXT.test(text)) {
      return [tag, text];
    }
    if (tag === "i" && INTEGER_TEXT.test(text) && text.length <= 20) {
      const integer = BigInt(text);
      if (integer >= INT64_MIN && integer <= INT64_MAX) {
        return ["i", text];
      }
    }
    // "-0" is the canonical form of negative zero, which String() cannot emit.
    if (
      tag === "r" &&
      text !== "NaN" &&
      (text === "-0" || String(Number(text)) === text)
    ) {
      return ["r", text];
    }
  }
  throw bundleDefect("table_row_malformed", "Row has an invalid cell", subject);
}

export function compareLines(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

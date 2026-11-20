import { reportGrievanceCatalogEntry } from "./report-grievance-catalog.js";
import type { ReportSubmission } from "./report-intake.js";

/**
 * Structured grievance fields shared by the browser form and the server.
 * The wording of types and help text follows the archived Beta-1 form.
 */

export const GRIEVANCE_TYPES = [
  {
    id: "delay-or-failure-to-perform",
    label: "Delay or failure to perform a duty",
    help: "Describe the duty, request, expected action, and delay.",
  },
  {
    id: "incorrect-or-misleading-information",
    label: "Incorrect or misleading information",
    help: "Identify what was said or provided and why you believe it was incorrect.",
  },
  {
    id: "unfair-process-or-enforcement",
    label: "Unfair process or inconsistent enforcement",
    help: "Describe the process, decision, or difference in treatment.",
  },
  {
    id: "records-access-or-transparency",
    label: "Records access or transparency",
    help: "Identify the request, meeting, missing record, or withheld explanation.",
  },
  {
    id: "discrimination-or-harassment",
    label: "Discrimination or harassment",
    help: "Describe the specific conduct and relevant context.",
  },
  {
    id: "retaliation",
    label: "Retaliation for raising a concern",
    help: "Describe the concern raised and the alleged response.",
  },
  {
    id: "abuse-of-authority",
    label: "Abuse of authority, threats or force",
    help: "Describe the exercise of authority, threat, or force.",
  },
  {
    id: "conflict-of-interest",
    label: "Conflict of interest or improper benefit",
    help: "Identify the interest or benefit and the employee’s involvement.",
  },
  {
    id: "misuse-of-public-resources",
    label: "Misuse of public funds or resources",
    help: "Identify the public money, property, work time, or procurement activity.",
  },
  {
    id: "privacy-or-confidentiality",
    label: "Privacy or confidentiality",
    help: "Describe the information and its alleged disclosure or misuse; omit sensitive details.",
  },
  {
    id: "safety-or-care",
    label: "Failure to protect safety or provide care",
    help: "Describe the safety or care duty and the alleged failure.",
  },
  {
    id: "unprofessional-conduct",
    label: "Unprofessional or disrespectful conduct",
    help: "Describe the words or conduct and the county-role context.",
  },
  {
    id: "other",
    label: "Other county-role grievance",
    help: "Describe the conduct and its connection to the county role.",
  },
] as const;

export type GrievanceTypeId = (typeof GRIEVANCE_TYPES)[number]["id"];

export const MAX_GRIEVANCES = 5;
export const MAX_GRIEVANCE_WORDS = 250;
export const MAX_GRIEVANCE_CHARACTERS = 4000;
export const MAX_HEADLINE_LENGTH = 180;
export const MAX_POSITION_LENGTH = 200;
export const MAX_UNLISTED_NAME_LENGTH = 200;
export const MAX_UNLISTED_OFFICE_LENGTH = 200;
/** The current Denver year and the ten before it. */
export const EVENT_YEAR_SPAN = 10;

export const IDENTIFICATION_BASES = [
  { id: "contributor", label: "As described by contributor" },
  { id: "documented", label: "Documented context" },
] as const;
export type IdentificationBasis = (typeof IDENTIFICATION_BASES)[number]["id"];

export interface ReportEventDate {
  readonly year: number;
  readonly month?: number;
  readonly day?: number;
}

/** Who an event concerns. A listed person always names one stored role. */
export type ReportEventSubject =
  | {
      readonly kind: "listed";
      readonly personId: string;
      readonly roleId: string;
    }
  | {
      readonly kind: "unlisted";
      readonly name: string;
      readonly office: string;
    };

interface ReportGrievanceContext {
  readonly details: string;
  readonly date: ReportEventDate;
  /** The county where the event happened. Not a directory filter. */
  readonly countyId: string;
  readonly subject: ReportEventSubject;
  readonly position?: string;
  readonly identificationBasis: IdentificationBasis;
}

/** A historical grievance retains its original category identifier. */
export interface LegacyReportGrievance extends ReportGrievanceContext {
  readonly type: GrievanceTypeId;
}

/** A new catalog grievance stores the exact inventory crosswalk ID. */
export interface CatalogReportGrievance extends ReportGrievanceContext {
  readonly catalogId: number;
}

export type ReportGrievance = LegacyReportGrievance | CatalogReportGrievance;

export function reportGrievanceTitle(grievance: ReportGrievance): string {
  if ("catalogId" in grievance) {
    return (
      reportGrievanceCatalogEntry(grievance.catalogId)?.title ??
      `Unknown catalog item ${grievance.catalogId}`
    );
  }
  return grievanceTypeLabel(grievance.type);
}

export function reportGrievanceType(grievance: ReportGrievance): string {
  if ("catalogId" in grievance) {
    return (
      reportGrievanceCatalogEntry(grievance.catalogId)?.type ?? "Unknown type"
    );
  }
  return grievanceTypeLabel(grievance.type);
}

export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/** The calendar year in Denver, which sets the form's year window. */
export function denverYear(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      year: "numeric",
    }).format(now),
  );
}

/** Years offered for an event, newest first. */
export function eventYears(now: Date): number[] {
  const current = denverYear(now);
  return Array.from({ length: EVENT_YEAR_SPAN + 1 }, (_, i) => current - i);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True when the date is a real calendar date inside the year window. */
export function isValidEventDate(value: unknown, now: Date): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { year, month, day, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return false;
  if (typeof year !== "number" || !eventYears(now).includes(year)) return false;
  if (month === undefined) return day === undefined;
  if (typeof month !== "number" || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;
  return (
    typeof day === "number" &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export const MONTH_NAMES: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatEventDate(date: ReportEventDate): string {
  if (date.month === undefined) return String(date.year);
  const month = MONTH_NAMES[date.month - 1] ?? "";
  return date.day === undefined
    ? `${month} ${date.year}`
    : `${month} ${date.day}, ${date.year}`;
}

export function grievanceTypeLabel(id: string): string {
  return GRIEVANCE_TYPES.find((type) => type.id === id)?.label ?? id;
}

/** Legacy fields a structured report derives from its first grievance. */
export function deriveLegacyFields(
  grievances: readonly ReportGrievance[],
): Pick<ReportSubmission, "countyId" | "subject" | "description"> {
  const first = grievances[0] as ReportGrievance;
  const description = grievances
    .map(
      (g, index) =>
        `${grievances.length > 1 ? `Grievance ${index + 1}: ` : ""}${g.details.trim()}`,
    )
    .join("\n\n");
  return {
    countyId: first.countyId,
    ...(first.subject.kind === "listed"
      ? { subject: { kind: "person", id: first.subject.personId } as const }
      : {}),
    description,
  };
}

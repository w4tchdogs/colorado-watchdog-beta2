import type {
  CountyAffiliationType,
  OrganizationType,
} from "../contracts/directory.js";

const MONTHS = [
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
] as const;

/**
 * Formats a stored date for display without interpreting it. Values that are
 * not a recognizable calendar date are shown exactly as stored.
 */
export function formatStoredDate(value: string): string {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:$|[T ])/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  if (!month) return String(year);
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return value;
  if (!day) return `${monthName} ${year}`;
  const dayNumber = Number(day);
  if (dayNumber < 1 || dayNumber > 31) return value;
  return `${monthName} ${dayNumber}, ${year}`;
}

export const ORGANIZATION_TYPE_LABELS: Readonly<
  Record<OrganizationType, string>
> = {
  county_government: "County government",
  office: "Office",
  department: "Department",
  division: "Division",
  regional: "Regional organization",
  partner: "Partner organization",
  other: "Other organization",
};

export function organizationTypeLabel(type: string): string {
  return (
    ORGANIZATION_TYPE_LABELS[type as OrganizationType] ?? "Other organization"
  );
}

/** CSS-safe modifier for a stored organization type. */
export function organizationTypeClass(type: string): string {
  return type in ORGANIZATION_TYPE_LABELS ? type.replace("_", "-") : "other";
}

const AFFILIATION_LABELS: Readonly<Record<CountyAffiliationType, string>> = {
  serves: "Serves",
  partner_for: "Partner for",
  shared_service: "Shared service for",
};

/** Phrase that precedes a county name, for example "Serves Adams County". */
export function affiliationVerb(type: string): string {
  return AFFILIATION_LABELS[type as CountyAffiliationType] ?? "Affiliated with";
}

const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  official_page: "Official webpage",
  public_document: "Public document",
  other_public: "Other public source",
};

export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPE_LABELS[type] ?? "Public source";
}

const PARENT_LABELS: Readonly<Record<string, string>> = {
  reports_to: "Reports to",
  grouped_under: "Grouped under",
};

export function parentRelationshipLabel(type: string | null): string {
  return (type && PARENT_LABELS[type]) || "Listed under";
}

export function countyTitle(name: string): string {
  return /county$/i.test(name) ? name : `${name} County`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export function isStableId(value: string | null): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isCountyFips(value: string): boolean {
  return /^08\d{3}$/.test(value);
}

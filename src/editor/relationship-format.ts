import type {
  OrganizationLookupItem,
  PersonLookupItem,
  SandboxAffiliationType,
  SandboxOrganizationType,
} from "../contracts/editor-lookup.js";

/**
 * Plain-text descriptions of sandbox people and organizations. They keep the
 * recorded distinctions (county organization, regional office, affiliated
 * organization, partner) and use neutral wording: a parent record, an
 * affiliation or a role record is context only and never claims authority,
 * employment or identity.
 */
export const ORGANIZATION_TYPE_LABELS: Readonly<
  Record<SandboxOrganizationType, string>
> = {
  county_government: "County government",
  office: "Office",
  department: "Department",
  division: "Division",
  regional: "Regional office",
  partner: "Partner organization",
  other: "Other organization",
};

const AFFILIATION_LABELS: Readonly<Record<SandboxAffiliationType, string>> = {
  serves: "Recorded as serving",
  partner_for: "Recorded as a partner for",
  shared_service: "Recorded as a shared service for",
};

export type OrganizationGroupKey =
  | "county"
  | "regional"
  | "partner"
  | "affiliated";

export const ORGANIZATION_GROUP_LABELS: Readonly<
  Record<OrganizationGroupKey, string>
> = {
  county: "County organizations",
  regional: "Regional offices",
  partner: "Partner organizations",
  affiliated: "Other affiliated organizations",
};

export const ORGANIZATION_GROUP_ORDER: readonly OrganizationGroupKey[] = [
  "county",
  "regional",
  "partner",
  "affiliated",
];

export function organizationGroup(
  type: SandboxOrganizationType,
): OrganizationGroupKey {
  switch (type) {
    case "regional":
      return "regional";
    case "partner":
      return "partner";
    case "other":
      return "affiliated";
    default:
      return "county";
  }
}

export function describePerson(person: PersonLookupItem): string[] {
  if (person.roles.length === 0) return ["No role record in the sandbox"];
  return person.roles.map(
    (role) => `Role record: ${role.title}, ${role.organizationName}`,
  );
}

export function describeOrganization(
  organization: OrganizationLookupItem,
): string[] {
  const lines = [`Type: ${ORGANIZATION_TYPE_LABELS[organization.type]}`];
  lines.push(
    organization.county
      ? `County: ${organization.county.name} (FIPS ${organization.county.fips})`
      : "County: none recorded",
  );
  if (organization.parent) {
    lines.push(
      `Parent record: ${organization.parent.name} (${organization.parent.id}), recorded as ${
        organization.parent.relationship === "reports_to"
          ? "reports to"
          : "grouped under"
      }`,
    );
  }
  for (const affiliation of organization.affiliations) {
    lines.push(
      `${AFFILIATION_LABELS[affiliation.relationshipType]} ${affiliation.name} County (FIPS ${affiliation.fips})`,
    );
  }
  return lines;
}

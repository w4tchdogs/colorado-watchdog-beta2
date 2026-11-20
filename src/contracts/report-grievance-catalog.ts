/**
 * Public catalog used by the signed-in report intake form. Inventory IDs,
 * commonality scores, subgroups and evidence references stay internal.
 * Descriptions are neutral drafting copy based on each title and subgroup.
 */
export interface ReportGrievanceCatalogEntry {
  readonly inventoryId: number;
  readonly title: string;
  readonly description: string;
  readonly type: string;
  readonly subgroup: string;
  readonly commonalityScore: number;
}

export const REPORT_GRIEVANCE_CATALOG: readonly ReportGrievanceCatalogEntry[] =
  [
    {
      inventoryId: 1,
      title: "Difficulty getting a service or poor service",
      type: "Service",
      subgroup: "Service access",
      commonalityScore: 10,
      description:
        "A concern about getting a county service or the quality of service provided.",
    },
    {
      inventoryId: 2,
      title: "Wrong or unfair decision by an office",
      type: "Decisions",
      subgroup: "Decisions and fair process",
      commonalityScore: 10,
      description:
        "A concern that a county office made an incorrect or unfair decision.",
    },
    {
      inventoryId: 3,
      title: "Poor communication or unclear information",
      type: "Communication",
      subgroup: "Information and advice",
      commonalityScore: 10,
      description:
        "A concern about unclear, incomplete, or unhelpful communication or information.",
    },
    {
      inventoryId: 4,
      title: "Waiting too long for a response, action, or decision",
      type: "Service",
      subgroup: "Response delays",
      commonalityScore: 9,
      description:
        "A concern about delay in receiving a response, action, or decision.",
    },
    {
      inventoryId: 5,
      title: "Problem caused by a law or regulation",
      type: "Decisions",
      subgroup: "Rules and policies",
      commonalityScore: 7,
      description:
        "A concern that a law or regulation led to an unwanted county outcome.",
    },
    {
      inventoryId: 6,
      title: "Unfair or inconsistent enforcement",
      type: "Decisions",
      subgroup: "Rules and policies",
      commonalityScore: 8,
      description:
        "A concern that county rules were enforced inconsistently or were not enforced in a particular situation.",
    },
    {
      inventoryId: 7,
      title: "Problem caused by a broader policy",
      type: "Decisions",
      subgroup: "Rules and policies",
      commonalityScore: 7,
      description:
        "A concern about an outcome caused by a broader county policy.",
    },
    {
      inventoryId: 8,
      title: "Skipped steps or unfair procedures",
      type: "Decisions",
      subgroup: "Decisions and fair process",
      commonalityScore: 8,
      description:
        "A concern that required steps were skipped or a procedure was unfair.",
    },
    {
      inventoryId: 9,
      title: "Mishandled complaint or appeal",
      type: "Service",
      subgroup: "Complaint handling and follow-through",
      commonalityScore: 9,
      description:
        "A concern about how a complaint or appeal was handled or followed up.",
    },
    {
      inventoryId: 10,
      title: "Wrong fee, charge, payment, or funding decision",
      type: "Decisions",
      subgroup: "Fees and funding",
      commonalityScore: 9,
      description:
        "A concern about an incorrect fee, charge, payment, or funding decision.",
    },
    {
      inventoryId: 11,
      title: "Rude or unprofessional behavior",
      type: "Conduct",
      subgroup: "Respect and fair treatment",
      commonalityScore: 7,
      description:
        "A concern about rude or unprofessional conduct in a county interaction.",
    },
    {
      inventoryId: 12,
      title: "Inadequate investigation",
      type: "Decisions",
      subgroup: "Decisions and fair process",
      commonalityScore: 6,
      description:
        "A concern that an investigation was incomplete or did not address the issue raised.",
    },
    {
      inventoryId: 13,
      title: "Discrimination or barriers to equal access",
      type: "Conduct",
      subgroup: "Respect and fair treatment",
      commonalityScore: 6,
      description:
        "A concern about discrimination or a barrier to equal access to a county service.",
    },
    {
      inventoryId: 14,
      title: "Harassment or unwanted sexual comments or advances",
      type: "Conduct",
      subgroup: "Harassment and sexual misconduct",
      commonalityScore: 5,
      description:
        "A concern about harassment or unwanted sexual comments or advances.",
    },
    {
      inventoryId: 15,
      title: "Abuse of authority, threats, or coercion",
      type: "Use of authority",
      subgroup: "Threats, pressure, and silencing",
      commonalityScore: 6,
      description:
        "A concern about authority being used to threaten, pressure, or coerce someone.",
    },
    {
      inventoryId: 16,
      title: "Excessive force or physical mistreatment",
      type: "Use of authority",
      subgroup: "Force, stops, searches, and seizures",
      commonalityScore: 6,
      description:
        "A concern about excessive force or physical mistreatment by an official.",
    },
    {
      inventoryId: 17,
      title: "Failure to protect safety or provide care",
      type: "Service",
      subgroup: "Safety and care",
      commonalityScore: 7,
      description:
        "A concern that a county office did not protect safety or provide needed care.",
    },
    {
      inventoryId: 18,
      title: "Public records or information withheld",
      type: "Communication",
      subgroup: "Public records and meetings",
      commonalityScore: 6,
      description:
        "A concern about access to public records or information, including being told records do not exist or belong to another office.",
    },
    {
      inventoryId: 19,
      title: "Private information improperly shared or used",
      type: "Privacy",
      subgroup: "Disclosure and exposure",
      commonalityScore: 5,
      description:
        "A concern that private information was shared or used inappropriately.",
    },
    {
      inventoryId: 20,
      title: "Retaliation for reporting a concern or cooperating",
      type: "Conduct",
      subgroup: "Retaliation",
      commonalityScore: 5,
      description:
        "A concern about adverse treatment after reporting an issue or cooperating with a review.",
    },
    {
      inventoryId: 21,
      title: "Conflict of interest or favoritism",
      type: "Integrity",
      subgroup: "Conflicts, gifts, and influence",
      commonalityScore: 5,
      description:
        "A concern about a conflict of interest or favoritism in county work.",
    },
    {
      inventoryId: 22,
      title: "Bribery or kickbacks",
      type: "Integrity",
      subgroup: "Conflicts, gifts, and influence",
      commonalityScore: 2,
      description:
        "A concern about a bribe or kickback connected to county work.",
    },
    {
      inventoryId: 23,
      title: "Fraud or false claims",
      type: "Integrity",
      subgroup: "Fraud, theft, and misuse",
      commonalityScore: 4,
      description:
        "A concern about a fraudulent act or false claim involving county work or resources.",
    },
    {
      inventoryId: 24,
      title: "Public resources used for personal purposes",
      type: "Integrity",
      subgroup: "Fraud, theft, and misuse",
      commonalityScore: 5,
      description:
        "A concern that public funds, property, or work time were used for personal purposes.",
    },
    {
      inventoryId: 25,
      title: "Required work left undone",
      type: "Service",
      subgroup: "Duties and oversight",
      commonalityScore: 9,
      description:
        "A concern that a county office did not complete required work or act on a duty it was responsible for.",
    },
    {
      inventoryId: 26,
      title: "Incorrect information or advice",
      type: "Communication",
      subgroup: "Information and advice",
      commonalityScore: 8,
      description:
        "A concern that information or advice from a county office was incorrect.",
    },
    {
      inventoryId: 27,
      title: "Improper stop, search, or detention",
      type: "Use of authority",
      subgroup: "Force, stops, searches, and seizures",
      commonalityScore: 5,
      description:
        "A concern about an improper stop, search, or detention by an official.",
    },
    {
      inventoryId: 28,
      title: "Lost paperwork or error in a record",
      type: "Service",
      subgroup: "Paperwork and records",
      commonalityScore: 6,
      description:
        "A concern about lost paperwork or an error in a county record.",
    },
    {
      inventoryId: 29,
      title: "Deliberate falsification of an official record",
      type: "Integrity",
      subgroup: "False records and missing disclosures",
      commonalityScore: 3,
      description:
        "A concern that an official record was deliberately falsified.",
    },
    {
      inventoryId: 30,
      title: "Interference with an investigation",
      type: "Integrity",
      subgroup: "Reporting and oversight",
      commonalityScore: 3,
      description:
        "A concern that someone interfered with an investigation or oversight process.",
    },
    {
      inventoryId: 31,
      title: "Improper gifts or benefits",
      type: "Integrity",
      subgroup: "Conflicts, gifts, and influence",
      commonalityScore: 4,
      description:
        "A concern about an improper gift or benefit connected to county work.",
    },
    {
      inventoryId: 32,
      title: "Unfair bidding or contracting",
      type: "Decisions",
      subgroup: "Hiring and contracts",
      commonalityScore: 4,
      description:
        "A concern that a county bidding or contracting process was unfair.",
    },
    {
      inventoryId: 33,
      title: "Improper hiring or promotion",
      type: "Decisions",
      subgroup: "Hiring and contracts",
      commonalityScore: 4,
      description:
        "A concern about an improper county hiring or promotion decision.",
    },
    {
      inventoryId: 34,
      title: "Public office or resources used for campaigning",
      type: "Integrity",
      subgroup: "Campaigning",
      commonalityScore: 3,
      description:
        "A concern that public office or resources were used for campaign activity.",
    },
    {
      inventoryId: 35,
      title: "Public meeting notice or access problem",
      type: "Communication",
      subgroup: "Public records and meetings",
      commonalityScore: 5,
      description:
        "A concern about public meeting notice or access, including a decision made in an improperly closed session.",
    },
    {
      inventoryId: 36,
      title: "Unauthorized lookup of private information",
      type: "Privacy",
      subgroup: "Access, monitoring, and collection",
      commonalityScore: 3,
      description:
        "A concern that someone accessed private information without authorization.",
    },
    {
      inventoryId: 37,
      title: "Official refused to identify themselves",
      type: "Communication",
      subgroup: "Notices, explanations, and identification",
      commonalityScore: 3,
      description:
        "A concern that an official would not identify themselves during an interaction.",
    },
    {
      inventoryId: 38,
      title: "Personal property lost or damaged in an office’s care",
      type: "Service",
      subgroup: "Personal property loss or damage",
      commonalityScore: 4,
      description:
        "A concern that personal property was lost or damaged while in a county office’s care.",
    },
    {
      inventoryId: 39,
      title: "Wasteful public spending",
      type: "Integrity",
      subgroup: "Fraud, theft, and misuse",
      commonalityScore: 4,
      description: "A concern that public funds were spent wastefully.",
    },
    {
      inventoryId: 40,
      title: "Promised fix never carried out",
      type: "Service",
      subgroup: "Complaint handling and follow-through",
      commonalityScore: 4,
      description:
        "A concern that an agreed or promised fix was not carried out.",
    },
    {
      inventoryId: 41,
      title: "Missing notice of a change or decision",
      type: "Communication",
      subgroup: "Notices, explanations, and identification",
      commonalityScore: 6,
      description:
        "A concern that notice of a change or decision was not provided.",
    },
    {
      inventoryId: 42,
      title: "No explanation for a decision",
      type: "Communication",
      subgroup: "Notices, explanations, and identification",
      commonalityScore: 6,
      description: "A concern that a county office did not explain a decision.",
    },
    {
      inventoryId: 43,
      title: "Blocked from pursuing an appeal",
      type: "Decisions",
      subgroup: "Decisions and fair process",
      commonalityScore: 4,
      description:
        "A concern that a person was prevented from pursuing an appeal.",
    },
    {
      inventoryId: 44,
      title: "Sent from office to office without getting help",
      type: "Service",
      subgroup: "Getting help",
      commonalityScore: 4,
      description:
        "A concern about being referred between offices without receiving help.",
    },
    {
      inventoryId: 45,
      title: "Online-only service with no usable alternative",
      type: "Service",
      subgroup: "Service access",
      commonalityScore: 4,
      description:
        "A concern that an online-only county service had no usable alternative.",
    },
    {
      inventoryId: 46,
      title: "Stopped from speaking during public comment",
      type: "Use of authority",
      subgroup: "Threats, pressure, and silencing",
      commonalityScore: 2,
      description:
        "A concern about being stopped from speaking during public comment.",
    },
    {
      inventoryId: 47,
      title: "Property damaged by government work",
      type: "Service",
      subgroup: "Personal property loss or damage",
      commonalityScore: 3,
      description: "A concern that government work damaged personal property.",
    },
    {
      inventoryId: 48,
      title: "Personal property improperly seized or kept",
      type: "Use of authority",
      subgroup: "Force, stops, searches, and seizures",
      commonalityScore: 4,
      description:
        "A concern that personal property was improperly seized or not returned.",
    },
    {
      inventoryId: 49,
      title: "Theft of personal money or belongings",
      type: "Integrity",
      subgroup: "Fraud, theft, and misuse",
      commonalityScore: 2,
      description:
        "A concern about theft of personal money or belongings connected to an official interaction.",
    },
    {
      inventoryId: 50,
      title: "Improper surveillance",
      type: "Privacy",
      subgroup: "Access, monitoring, and collection",
      commonalityScore: 2,
      description:
        "A concern about surveillance that was improper or unauthorized.",
    },
    {
      inventoryId: 51,
      title: "More private information collected than needed",
      type: "Privacy",
      subgroup: "Access, monitoring, and collection",
      commonalityScore: 2,
      description:
        "A concern that more private information was collected than needed for a county purpose.",
    },
    {
      inventoryId: 52,
      title: "Private information left exposed",
      type: "Privacy",
      subgroup: "Disclosure and exposure",
      commonalityScore: 3,
      description:
        "A concern that private information was left exposed or accessible.",
    },
    {
      inventoryId: 53,
      title: "Action taken without required approval",
      type: "Use of authority",
      subgroup: "Required approvals",
      commonalityScore: 3,
      description:
        "A concern that an action was taken without a required approval.",
    },
    {
      inventoryId: 54,
      title: "Failure to supervise or fix a recurring problem",
      type: "Service",
      subgroup: "Duties and oversight",
      commonalityScore: 4,
      description:
        "A concern that a recurring problem was not supervised or corrected.",
    },
    {
      inventoryId: 55,
      title: "Failure to report known misconduct",
      type: "Integrity",
      subgroup: "Reporting and oversight",
      commonalityScore: 2,
      description:
        "A concern that known misconduct was not reported through an appropriate channel.",
    },
    {
      inventoryId: 56,
      title: "Missing required financial disclosure",
      type: "Integrity",
      subgroup: "False records and missing disclosures",
      commonalityScore: 3,
      description:
        "A concern that a required financial disclosure was missing.",
    },
    {
      inventoryId: 57,
      title: "Improper outside work or post-employment activity",
      type: "Integrity",
      subgroup: "Conflicts, gifts, and influence",
      commonalityScore: 3,
      description:
        "A concern about outside work or post-employment activity that may conflict with county duties.",
    },
    {
      inventoryId: 58,
      title: "Unsafe driving on duty",
      type: "Conduct",
      subgroup: "Safety on duty",
      commonalityScore: 2,
      description:
        "A concern about unsafe driving while performing county duties.",
    },
    {
      inventoryId: 59,
      title: "Impairment on duty",
      type: "Conduct",
      subgroup: "Safety on duty",
      commonalityScore: 1,
      description:
        "A concern that an official was impaired while performing county duties.",
    },
    {
      inventoryId: 60,
      title: "Sexual assault or abuse by an official",
      type: "Conduct",
      subgroup: "Harassment and sexual misconduct",
      commonalityScore: 3,
      description: "A concern about sexual assault or abuse by an official.",
    },
    {
      inventoryId: 61,
      title: "Required records never made or kept",
      type: "Service",
      subgroup: "Paperwork and records",
      commonalityScore: 4,
      description:
        "A concern that a county office failed to create or keep required records, including being told records do not exist or belong to another office.",
    },
  ];

export function reportGrievanceCatalogEntry(
  inventoryId: number,
): ReportGrievanceCatalogEntry | undefined {
  return REPORT_GRIEVANCE_CATALOG.find(
    (entry) => entry.inventoryId === inventoryId,
  );
}

export function isReportGrievanceCatalogId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    reportGrievanceCatalogEntry(value) !== undefined
  );
}

import type { WebsiteDatabase } from "../database/sqlite.js";
import type {
  EditorialArticle,
  EditorialSource,
} from "../site/editorial-source.js";

/**
 * Fictional demonstration records for the local public-site preview and its
 * tests. Nothing here describes a real person, organization or source. Every
 * name says so, and every source address uses the reserved `.invalid` domain.
 */
const GIVEN = ["Avery", "Blair", "Casey", "Devon", "Emery", "Finley", "Gray"];
const FAMILY = ["Sample", "Placeholder", "Specimen", "Mockford", "Testwell"];

export function seedFictionalDirectory(database: WebsiteDatabase): void {
  database.exec(`
    INSERT INTO organizations (id, name, organization_type, county_fips)
    VALUES ('demo-adams-gov','Fictional Adams County Government','county_government','08001'),
           ('demo-larimer-gov','Fictional Larimer County Government','county_government','08069'),
           ('demo-regional-health','Fictional Front Range Health District','regional',NULL),
           ('demo-partner-library','Fictional Community Library Partnership','partner',NULL),
           ('demo-shared-dispatch','Fictional Shared Dispatch Center','other',NULL);
    INSERT INTO organizations (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
    VALUES ('demo-adams-clerk','Fictional Clerk and Recorder Office','office','08001','demo-adams-gov','grouped_under'),
           ('demo-adams-works','Fictional Public Works Department','department','08001','demo-adams-gov','reports_to'),
           ('demo-larimer-clerk','Fictional Clerk and Recorder Office','office','08069','demo-larimer-gov','grouped_under');
    INSERT INTO organizations (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
    VALUES ('demo-adams-roads','Fictional Road Maintenance Division','division','08001','demo-adams-works','reports_to');
    INSERT INTO organization_county_affiliations (id, organization_id, county_fips, relationship_type)
    VALUES ('demo-aff-1','demo-regional-health','08001','serves'),
           ('demo-aff-2','demo-regional-health','08069','serves'),
           ('demo-aff-3','demo-partner-library','08001','partner_for'),
           ('demo-aff-4','demo-shared-dispatch','08001','shared_service'),
           ('demo-aff-5','demo-shared-dispatch','08069','shared_service');
    INSERT INTO positions (id, organization_id, title)
    VALUES ('demo-pos-clerk','demo-adams-clerk','Fictional Clerk and Recorder'),
           ('demo-pos-deputy','demo-adams-clerk','Fictional Deputy Clerk'),
           ('demo-pos-director','demo-adams-works','Fictional Public Works Director'),
           ('demo-pos-roads','demo-adams-roads','Fictional Road Supervisor'),
           ('demo-pos-crew','demo-adams-roads','Fictional Road Crew Member'),
           ('demo-pos-health','demo-regional-health','Fictional District Health Officer'),
           ('demo-pos-library','demo-partner-library','Fictional Partnership Coordinator'),
           ('demo-pos-larimer-clerk','demo-larimer-clerk','Fictional Clerk and Recorder'),
           ('demo-pos-vacant-looking','demo-adams-works','Fictional Fleet Manager');
    INSERT INTO role_sources (id, url, title, source_type)
    VALUES ('demo-src-adams','https://example.invalid/fictional-adams/staff-directory','Fictional Adams County staff directory','official_page'),
           ('demo-src-minutes','https://example.invalid/fictional-adams/minutes-2025.pdf','Fictional board meeting minutes','public_document'),
           ('demo-src-health','https://example.invalid/fictional-health-district/leadership','Fictional health district leadership page','official_page'),
           ('demo-src-news','https://example.invalid/fictional-gazette/library-partnership','Fictional newspaper notice','other_public'),
           ('demo-src-larimer','https://example.invalid/fictional-larimer/clerk','Fictional Larimer County clerk page','official_page');
    INSERT INTO people (id, display_name)
    VALUES ('demo-person-jordan-a','Jordan Example (fictional)'),
           ('demo-person-jordan-b','Jordan Example (fictional)'),
           ('demo-person-riley','Riley Placeholder (fictional)'),
           ('demo-person-morgan','Morgan Sample (fictional)'),
           ('demo-person-quinn','Quinn Specimen (fictional)'),
           ('demo-person-no-roles','Harper Unlisted (fictional)');
    INSERT INTO person_roles (id, person_id, position_id, source_id, start_date, end_date, source_checked_at, published_title)
    VALUES ('demo-role-01','demo-person-jordan-a','demo-pos-clerk','demo-src-adams','2023-01-10',NULL,'2026-10-02', 'Fictional Clerk and Recorder'),
           ('demo-role-02','demo-person-jordan-a','demo-pos-deputy','demo-src-minutes','2019-03-01','2023-01-09','2026-10-02', 'Fictional Deputy Clerk'),
           ('demo-role-03','demo-person-jordan-b','demo-pos-larimer-clerk','demo-src-larimer',NULL,NULL,'2026-09-18', 'Fictional Clerk and Recorder'),
           ('demo-role-04','demo-person-riley','demo-pos-director','demo-src-adams',NULL,NULL,'2026-10-02', 'Fictional Public Works Director'),
           ('demo-role-05','demo-person-morgan','demo-pos-health','demo-src-health','2021-06-15',NULL,'2026-08-30', 'Fictional District Health Officer'),
           ('demo-role-06','demo-person-quinn','demo-pos-library','demo-src-news',NULL,'2025-12-31','2026-07-04', 'Fictional Partnership Coordinator'),
           ('demo-role-07','demo-person-riley','demo-pos-roads','demo-src-minutes','2015-05-01','2020-04-30','2026-10-02', 'Fictional Road Supervisor');
  `);
  // Larimer: a department with a division, a second office and a person who
  // also has a role in another county.
  database.exec(`
    INSERT INTO organizations (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
    VALUES ('demo-larimer-assessor','Fictional Assessor Office','office','08069','demo-larimer-gov','grouped_under'),
           ('demo-larimer-dev','Fictional Community Development Department','department','08069','demo-larimer-gov','reports_to');
    INSERT INTO organizations (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
    VALUES ('demo-larimer-building','Fictional Building Division','division','08069','demo-larimer-dev','reports_to');
    INSERT INTO positions (id, organization_id, title)
    VALUES ('demo-pos-l-assessor','demo-larimer-assessor','Fictional Assessor'),
           ('demo-pos-l-director','demo-larimer-dev','Fictional Community Development Director'),
           ('demo-pos-l-planner','demo-larimer-dev','Fictional Senior Planner for Long-Range Land Use and Rural Area Coordination'),
           ('demo-pos-l-inspector','demo-larimer-building','Fictional Building Inspector'),
           ('demo-pos-l-permit','demo-larimer-building','Fictional Permit Technician');
    INSERT INTO role_sources (id, url, title, source_type)
    VALUES ('demo-src-larimer-dev','https://example.invalid/fictional-larimer/community-development','Fictional Larimer community development page','official_page');
    INSERT INTO people (id, display_name)
    VALUES ('demo-l-01','Addison Fixture (fictional)'),
           ('demo-l-02','Bellamy Fixture (fictional)'),
           ('demo-l-03','Carson Mockup (fictional)'),
           ('demo-l-04','Dakota Mockup (fictional)'),
           ('demo-l-05','Ellis Dummy (fictional)'),
           ('demo-l-06','Frankie Dummy (fictional)'),
           ('demo-l-07','Greer Standin (fictional)'),
           ('demo-l-08','Hollis Standin (fictional)');
    INSERT INTO person_roles (id, person_id, position_id, source_id, start_date, end_date, source_checked_at, published_title)
    VALUES ('demo-role-l-01','demo-l-01','demo-pos-l-assessor','demo-src-larimer','2023-01-10',NULL,'2026-09-18', 'Fictional Assessor'),
           ('demo-role-l-02','demo-l-02','demo-pos-l-director','demo-src-larimer-dev','2020-02-03',NULL,'2026-10-20', 'Fictional Community Development Director'),
           ('demo-role-l-03','demo-l-03','demo-pos-l-planner','demo-src-larimer-dev',NULL,NULL,'2026-10-20', 'Fictional Senior Planner for Long-Range Land Use and Rural Area Coordination'),
           ('demo-role-l-04','demo-l-04','demo-pos-l-planner','demo-src-larimer-dev',NULL,'2025-06-30','2026-10-20', 'Fictional Senior Planner for Long-Range Land Use and Rural Area Coordination'),
           ('demo-role-l-05','demo-l-05','demo-pos-l-inspector','demo-src-larimer-dev',NULL,NULL,'2026-10-21', 'Fictional Building Inspector'),
           ('demo-role-l-06','demo-l-06','demo-pos-l-inspector','demo-src-larimer-dev',NULL,NULL,'2026-10-21', 'Fictional Building Inspector'),
           ('demo-role-l-07','demo-l-07','demo-pos-l-permit','demo-src-larimer-dev','2024-08-12',NULL,'2026-10-21', 'Fictional Permit Technician'),
           ('demo-role-l-08','demo-l-08','demo-pos-l-permit','demo-src-larimer-dev',NULL,NULL,'2026-10-21', 'Fictional Permit Technician'),
           ('demo-role-l-09','demo-l-05','demo-pos-l-permit','demo-src-larimer-dev','2019-01-07','2022-03-31','2026-10-21', 'Fictional Permit Technician'),
           ('demo-role-l-10','demo-person-riley','demo-pos-l-director','demo-src-larimer-dev','2012-04-02','2015-04-30','2026-10-20', 'Fictional Community Development Director');
  `);
  const person = database.prepare(
    "INSERT INTO people (id, display_name) VALUES (?, ?)",
  );
  const role = database.prepare(
    `INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at, published_title)
     VALUES (?, ?, 'demo-pos-crew', 'demo-src-adams', '2026-10-02', 'Fictional Road Crew Member')`,
  );
  // Enough crew records to demonstrate bounded pagination.
  for (let index = 0; index < 32; index += 1) {
    const id = `demo-crew-${String(index).padStart(2, "0")}`;
    const given = GIVEN[index % GIVEN.length];
    const family = FAMILY[index % FAMILY.length];
    person.run(id, `${given} ${family} (fictional)`);
    role.run(`demo-role-crew-${String(index).padStart(2, "0")}`, id);
  }
}

const NOTE =
  "This article is a fictional demonstration of the Colorado Watchdog article template. Nothing in it happened.";

const ARTICLES: readonly EditorialArticle[] = [
  {
    type: "story",
    slug: "fictional-road-budget-review",
    pathway: "local-series",
    series: { slug: "fictional-roads-series", label: "Fictional Roads Series" },
    topics: [{ slug: "county-budgets", label: "County budgets" }],
    title: "Fictional story: how a county road budget review might be reported",
    summary:
      "A made-up long-form piece that shows headings, quotations, lists, related records and source references.",
    date: "2026-01-15",
    byline: "Demonstration byline",
    fictional: true,
    body: [
      { kind: "paragraph", text: NOTE },
      {
        kind: "paragraph",
        text: "A story opens with the finding, stated plainly, and says where the evidence comes from. Body text is set for sustained reading, with a measure of about seventy characters.",
      },
      { kind: "heading", text: "What the records show" },
      {
        kind: "paragraph",
        text: "Sections break a story into parts a reader can scan. Each claim in a real story would point to a source listed beside the article.",
      },
      {
        kind: "list",
        items: [
          "A first fictional finding, with its source.",
          "A second fictional finding, with its source.",
          "A point the records do not settle.",
        ],
      },
      {
        kind: "quote",
        text: "A quotation from a public meeting would be set apart like this, attributed in the surrounding text.",
      },
      { kind: "heading", text: "What is not known" },
      {
        kind: "paragraph",
        text: "Stories state the limits of their evidence. Absence from a record is reported as absence, not as a conclusion.",
      },
    ],
    related: {
      counties: [{ fips: "08001", name: "Adams" }],
      people: [
        {
          id: "demo-person-riley",
          displayName: "Riley Placeholder (fictional)",
        },
      ],
      organizations: [
        { id: "demo-adams-works", name: "Fictional Public Works Department" },
        { id: "demo-adams-roads", name: "Fictional Road Maintenance Division" },
      ],
    },
    sources: [
      {
        title: "Fictional board meeting minutes",
        url: "https://example.invalid/fictional-adams/minutes-2025.pdf",
      },
      {
        title: "Fictional Adams County staff directory",
        url: "https://example.invalid/fictional-adams/staff-directory",
      },
    ],
  },
  {
    type: "story",
    slug: "fictional-health-district-explainer",
    pathway: "statewide-issues",
    topics: [{ slug: "regional-districts", label: "Regional districts" }],
    title:
      "Fictional story: explaining a regional district that serves two counties",
    summary:
      "A made-up explainer showing how a story links to a regional organization without calling it a county department.",
    date: "2026-01-08",
    byline: "Demonstration byline",
    fictional: true,
    body: [
      { kind: "paragraph", text: NOTE },
      {
        kind: "paragraph",
        text: "Regional organizations serve counties without being part of them. A story about one links to the organization and to each county it is recorded as serving.",
      },
    ],
    related: {
      counties: [
        { fips: "08001", name: "Adams" },
        { fips: "08069", name: "Larimer" },
      ],
      people: [],
      organizations: [
        {
          id: "demo-regional-health",
          name: "Fictional Front Range Health District",
        },
      ],
    },
    sources: [
      {
        title: "Fictional health district leadership page",
        url: "https://example.invalid/fictional-health-district/leadership",
      },
    ],
  },
  {
    type: "story",
    slug: "fictional-guest-perspective",
    pathway: "guest-voices",
    title: "Fictional story: a resident describes a permit process",
    summary:
      "A made-up guest piece with a pathway but no series or topic, to show how missing optional metadata is handled.",
    date: "2026-01-11",
    byline: "Fictional guest contributor",
    fictional: true,
    body: [
      { kind: "paragraph", text: NOTE },
      {
        kind: "paragraph",
        text: "A guest piece is written by someone outside the project and is labelled with the pathway editors assigned it to.",
      },
    ],
    related: {
      counties: [{ fips: "08013", name: "Boulder" }],
      people: [],
      organizations: [],
    },
    sources: [],
  },
  ...[
    [
      "fictional-directory-update",
      "Fictional post: a county directory page was rechecked",
      "2026-01-20",
    ],
    [
      "fictional-new-county-added",
      "Fictional post: records added for one county",
      "2026-01-12",
    ],
    [
      "fictional-source-note",
      "Fictional post: a note about a source that moved",
      "2026-01-05",
    ],
  ].map(
    ([slug, title, date]): EditorialArticle => ({
      ...(slug === "fictional-new-county-added"
        ? {
            pathway: "local-series" as const,
            series: {
              slug: "fictional-roads-series",
              label: "Fictional Roads Series",
            },
            topics: [{ slug: "county-budgets", label: "County budgets" }],
          }
        : {}),
      type: "post",
      slug: String(slug),
      title: String(title),
      summary:
        "A made-up short update demonstrating the Post card and article layout.",
      date: String(date),
      byline: "Demonstration byline",
      fictional: true,
      body: [
        { kind: "paragraph", text: NOTE },
        {
          kind: "paragraph",
          text: "Posts are short. They say what changed, link to the affected records and cite the source.",
        },
      ],
      related: {
        counties: [{ fips: "08001", name: "Adams" }],
        people: [],
        organizations: [],
      },
      sources: [],
    }),
  ),
  {
    type: "post",
    slug: "fictional-guest-note",
    pathway: "guest-voices",
    topics: [{ slug: "regional-districts", label: "Regional districts" }],
    title: "Fictional post: a guest note about a regional district",
    summary:
      "A made-up short guest note in Denver County, so county and pathway filters have more than one combination to test.",
    date: "2026-01-14",
    byline: "Fictional guest contributor",
    fictional: true,
    body: [
      { kind: "paragraph", text: NOTE },
      {
        kind: "paragraph",
        text: "Guest notes are short and say who wrote them.",
      },
    ],
    related: {
      counties: [{ fips: "08031", name: "Denver" }],
      people: [],
      organizations: [],
    },
    sources: [],
  },
];

export const fictionalEditorialSource: EditorialSource = {
  list: (type) => ARTICLES.filter((article) => article.type === type),
  get: (type, slug) =>
    ARTICLES.find(
      (article) => article.type === type && article.slug === slug,
    ) ?? null,
};

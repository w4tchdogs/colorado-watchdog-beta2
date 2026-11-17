/**
 * Synthetic scale fixtures from the Cloudflare staging rehearsal (Issue #141).
 * Every name is invented and every URL uses example.invalid.
 */

const REQUEST_IDS = {
  mixed: "8a3f5c10-0816-4d16-9a01-000000000816",
  base: "8a3f5c10-0291-4d16-9a01-000000000291",
  references: "8a3f5c10-0251-4d16-9a01-000000000251",
};

const CHECKED = "2026-11-12T12:00:00Z";

/**
 * The 816-operation mixed changeset: 3 organizations, 8 positions, 40 sources,
 * 262 people and 503 roles (495 unstructured, 8 linked to a position).
 */
export function mixedChangeset(intent = "commit", tag = "mixed") {
  const changes = [];
  changes.push({
    op: "create_organization",
    entity: "organizations",
    clientRef: "org-0",
    fields: {
      name: `Synthetic County Government ${tag}`,
      organization_type: "county_government",
      county_fips: "08001",
    },
  });
  for (let o = 1; o < 3; o++)
    changes.push({
      op: "create_organization",
      entity: "organizations",
      clientRef: `org-${o}`,
      fields: {
        name: `Synthetic Department ${tag} ${o}`,
        organization_type: "department",
        county_fips: "08001",
        parent_organization_ref: "org-0",
        parent_relationship: "reports_to",
      },
    });
  for (let p = 0; p < 8; p++)
    changes.push({
      op: "create_position",
      entity: "positions",
      clientRef: `position-${p}`,
      fields: {
        title: `Synthetic Position ${tag} ${p}`,
        organization_ref: `org-${p % 3}`,
      },
    });
  for (let s = 0; s < 40; s++) changes.push(source(s, tag));
  for (let p = 0; p < 262; p++)
    changes.push({
      op: "create_person",
      entity: "people",
      clientRef: `person-${p}`,
      fields: { display_name: `Synthetic Person ${tag} ${p}` },
    });
  for (let r = 0; r < 503; r++) {
    const fields = {
      person_ref: `person-${r % 262}`,
      source_ref: `source-${r % 40}`,
      county_fips: "08001",
      source_checked_at: CHECKED,
    };
    if (r < 8) fields.position_ref = `position-${r}`;
    else fields.published_office = `Synthetic Office ${tag} ${r}`;
    changes.push({
      op: "create_person_role",
      entity: "person_roles",
      clientRef: `role-${r}`,
      fields,
    });
  }
  return {
    contractVersion: "m2-sync/v1",
    requestId: REQUEST_IDS.mixed,
    intent,
    changes,
  };
}

/** People and sources that the 251-role reference changeset points at. */
export function referenceBaseChangeset(intent = "commit", tag = "refs") {
  const changes = [];
  for (let s = 0; s < 40; s++) changes.push(source(s, tag));
  for (let p = 0; p < 251; p++)
    changes.push({
      op: "create_person",
      entity: "people",
      clientRef: `person-${p}`,
      fields: { display_name: `Synthetic Person ${tag} ${p}` },
    });
  return {
    contractVersion: "m2-sync/v1",
    requestId: REQUEST_IDS.base,
    intent,
    changes,
  };
}

/**
 * 251 roles that each name an existing person and source by Website ID, as the
 * continuation batch after the base commit. `ids` maps base clientRefs to IDs.
 */
export function referenceRolesChangeset(ids, intent = "commit", tag = "refs") {
  const changes = [];
  for (let r = 0; r < 251; r++)
    changes.push({
      op: "create_person_role",
      entity: "person_roles",
      clientRef: `ref-role-${r}`,
      fields: {
        person_id: ids.get(`person-${r}`),
        source_id: ids.get(`source-${r % 40}`),
        county_fips: "08001",
        published_office: `Synthetic Office ${tag} ${r}`,
        source_checked_at: CHECKED,
      },
    });
  return {
    contractVersion: "m2-sync/v1",
    requestId: REQUEST_IDS.references,
    intent,
    changes,
  };
}

function source(s, tag) {
  return {
    op: "register_source",
    entity: "role_sources",
    clientRef: `source-${s}`,
    fields: {
      url: `https://example.invalid/${tag}/source-${s}`,
      title: `Synthetic source ${tag} ${s}`,
      publisher_classification: "official",
      source_type: "official_page",
    },
  };
}

/**
 * Local D1 binding over node:sqlite that counts every query the Worker would send
 * to D1. A batch counts as one call, as it does on Cloudflare.
 */
export function countingD1Binding(database) {
  const counter = { first: 0, all: 0, run: 0, batch: 0, batchStatements: 0 };
  const binding = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...parameters) {
          values = parameters;
          return statement;
        },
        async first() {
          counter.first++;
          return database.prepare(sql).get(...values) ?? null;
        },
        async all() {
          counter.all++;
          return {
            success: true,
            results: database.prepare(sql).all(...values),
          };
        },
        async run() {
          counter.run++;
          database.prepare(sql).run(...values);
          return { success: true };
        },
        runSync() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements) {
      counter.batch++;
      counter.batchStatements += statements.length;
      return database.transaction(() =>
        statements.map((statement) => statement.runSync()),
      )();
    },
  };
  const total = () => counter.first + counter.all + counter.run + counter.batch;
  return { binding, counter, total };
}

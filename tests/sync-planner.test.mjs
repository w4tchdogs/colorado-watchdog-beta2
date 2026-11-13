import assert from "node:assert/strict";
import test from "node:test";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { planSyncChangeset } from "../dist/services/sync-planner.js";

async function fixture(callback) {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    seed(database);
    await callback(database);
  } finally {
    database.close();
  }
}

function seed(db) {
  db.prepare(`INSERT INTO organizations (id,name,organization_type,county_fips,parent_organization_id,parent_relationship) VALUES
    ('org-a','Synthetic Adams Government','county_government','08001',NULL,NULL),
    ('org-child','Synthetic Adams Child','office','08001','org-a','reports_to'),
    ('org-b','Synthetic Boulder Government','county_government','08013',NULL,NULL),
    ('regional-null','Synthetic Regional Office','regional',NULL,NULL,NULL)`).run();
  db.prepare(
    "INSERT INTO organization_county_affiliations(id,organization_id,county_fips,relationship_type) VALUES ('aff-a','org-a','08013','serves')",
  ).run();
  db.prepare(
    "INSERT INTO people(id,display_name) VALUES ('person-a','Synthetic Person'),('person-b','Synthetic Person')",
  ).run();
  db.prepare(
    "INSERT INTO positions(id,organization_id,title) VALUES ('position-a','org-a','Synthetic Clerk')",
  ).run();
  db.prepare(
    "INSERT INTO role_sources(id,url,title,source_type) VALUES ('source-a','https://example.invalid/exact','Synthetic source','official_page')",
  ).run();
  db.prepare(
    "INSERT INTO person_roles(id,person_id,position_id,source_id,start_date,end_date,source_checked_at) VALUES ('role-a','person-a','position-a','source-a','2020-01-01',NULL,'2026-01-01T00:00:00Z')",
  ).run();
}

const request = (changes, extra = {}) => ({
  contractVersion: "m2-sync/v1",
  requestId: "6b5f57a2-84b7-4a4d-b300-33aea9feeb19",
  intent: "dry_run",
  changes,
  ...extra,
});
const create = (op, entity, clientRef, fields) => ({
  op,
  entity,
  clientRef,
  fields,
});
const update = (entity, targetId, expectedVersion, fields) => ({
  op: "update_record",
  entity,
  targetId,
  expectedVersion,
  fields,
});
const validOrg = (
  clientRef = "org-new",
  fields = {
    name: "Synthetic New County",
    organization_type: "county_government",
    county_fips: "08001",
  },
) => create("create_organization", "organizations", clientRef, fields);

function state(db) {
  return db
    .prepare(`SELECT (SELECT count(*) FROM organizations) orgs,
    (SELECT count(*) FROM organization_county_affiliations) affiliations,
    (SELECT count(*) FROM people) people,(SELECT count(*) FROM positions) positions,
    (SELECT count(*) FROM role_sources) sources,(SELECT count(*) FROM person_roles) roles,
    (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM operations) operations,
    (SELECT count(*) FROM schema_migrations) migrations`)
    .get();
}

test("plans same-request dependencies in order and never writes or reserves IDs", async () => {
  await fixture((db) => {
    const before = state(db);
    const plan = planSyncChangeset(
      db,
      request([
        validOrg(),
        create(
          "add_county_affiliation",
          "organization_county_affiliations",
          "aff-new",
          {
            organization_ref: "org-new",
            county_fips: "08013",
            relationship_type: "serves",
          },
        ),
        create("create_person", "people", "person-new", {
          display_name: "Synthetic New Person",
        }),
        create("create_position", "positions", "position-new", {
          organization_ref: "org-new",
          title: "Synthetic Clerk",
        }),
        create("register_source", "role_sources", "source-new", {
          url: "https://example.invalid/new",
          title: "Synthetic source",
          source_type: "official_page",
        }),
        create("create_person_role", "person_roles", "role-new", {
          person_ref: "person-new",
          position_ref: "position-new",
          source_ref: "source-new",
          start_date: "2024-02-29",
          source_checked_at: "2026-11-12T00:00:00Z",
        }),
      ]),
      () => new Date("2026-11-13T00:00:00Z"),
    );
    assert.equal(plan.eligible, true, JSON.stringify(plan.errors));
    assert.deepEqual(
      plan.items.map((x) => x.action),
      Array(6).fill("would_create"),
    );
    assert.deepEqual(plan.items[5].dependencies, [
      "person-new",
      "position-new",
      "source-new",
    ]);
    assert.equal(
      plan.items.some((x) => x.websiteId),
      false,
    );
    assert.deepEqual(state(db), before);
  });
});

test("allowlists updates, rejects duplicate targets and returns safe stale versions", async () => {
  await fixture((db) => {
    const before = state(db);
    for (const change of [
      update("accounts", "owner", 1, { role: "owner" }),
      update("identities", "identity-a", 1, { revoked_at: null }),
      update("operations", "operation-a", 1, { status: "completed" }),
      update("checkpoints", "checkpoint-a", 1, {
        verification_status: "verified",
      }),
      update("audit_events", "audit-a", 1, { summary: "changed" }),
      update("counties", "08001", 1, { name: "changed" }),
      update("organizations", "org-a", 1, { actor_id: "secret-actor" }),
      update("positions", "position-a", 1, { organization_id: "org-b" }),
      update("role_sources", "source-a", 1, {
        url: "https://attacker.invalid/secret",
      }),
      update("role_sources", "source-a", 1, { source_type: "other_public" }),
      update("person_roles", "role-a", 1, { person_id: "person-b" }),
      update("organization_county_affiliations", "aff-a", 1, {
        organization_id: "org-b",
      }),
    ]) {
      const plan = planSyncChangeset(db, request([change]));
      assert.equal(plan.eligible, false);
      assert.ok(
        ["unsupported_entity", "unsupported_field"].includes(
          plan.errors[0].code,
        ),
      );
      assert.equal(JSON.stringify(plan).includes("attacker.invalid"), false);
      assert.equal(JSON.stringify(plan).includes("secret-actor"), false);
    }
    const duplicate = planSyncChangeset(
      db,
      request([
        update("people", "person-a", 1, { display_name: "A" }),
        update("people", "person-a", 1, { display_name: "B" }),
      ]),
    );
    assert.ok(duplicate.errors.some((x) => x.code === "duplicate_target"));
    const stale = planSyncChangeset(
      db,
      request([update("people", "person-a", 99, { display_name: "A" })]),
    );
    assert.deepEqual(stale.errors[0], {
      code: "stale_version",
      itemIndex: 0,
      currentVersion: 1,
      message:
        "The target record changed; read its current version before retrying.",
    });
    assert.deepEqual(state(db), before);
  });
});

test("source reuse is byte-exact and source evidence cannot be silently retained", async () => {
  await fixture((db) => {
    const reuse = planSyncChangeset(
      db,
      request([
        create("register_source", "role_sources", "source-ref", {
          url: "https://example.invalid/exact",
          title: "Synthetic source",
          source_type: "official_page",
        }),
      ]),
    );
    assert.equal(reuse.items[0].action, "would_reuse");
    assert.equal(reuse.items[0].websiteId, "source-a");
    const distinct = planSyncChangeset(
      db,
      request([
        create("register_source", "role_sources", "source-ref", {
          url: "https://example.invalid/exact/",
          title: "Synthetic source",
          source_type: "official_page",
        }),
      ]),
    );
    assert.equal(distinct.items[0].action, "would_create");
    const conflict = planSyncChangeset(
      db,
      request([
        create("register_source", "role_sources", "source-ref", {
          url: "https://example.invalid/exact",
          title: "Changed title",
          source_type: "official_page",
        }),
      ]),
    );
    assert.ok(
      conflict.errors.some((x) => x.code === "source_metadata_conflict"),
    );
    const sourceChange = planSyncChangeset(
      db,
      request([update("person_roles", "role-a", 1, { source_id: "source-a" })]),
    );
    assert.equal(sourceChange.errors[0].code, "source_check_required");
    const title = planSyncChangeset(
      db,
      request([
        update("role_sources", "source-a", 1, {
          title: "Revised source title",
        }),
      ]),
    );
    assert.equal(title.eligible, true);
    assert.equal(
      db
        .prepare("SELECT source_checked_at FROM person_roles WHERE id='role-a'")
        .get().source_checked_at,
      "2026-01-01T00:00:00Z",
    );
  });
});

test("rejects malformed dates, future timestamps, malformed URLs and accepts reserved invalid hosts", async () => {
  await fixture((db) => {
    const invalid = [
      { start_date: "2024-2-01" },
      { start_date: "2024-02-30" },
      { start_date: "2024-01-01", end_date: "2024-2-01" },
      { source_checked_at: "2026-11-14T00:00:00Z" },
    ];
    for (const dates of invalid) {
      const fields = {
        person_ref: "unknown",
        position_ref: "unknown",
        source_ref: "unknown",
        source_checked_at: "2026-11-12T00:00:00Z",
        ...dates,
      };
      const plan = planSyncChangeset(
        db,
        request([
          create("create_person_role", "person_roles", "role-x", fields),
        ]),
        () => new Date("2026-11-13T00:00:00Z"),
      );
      assert.equal(plan.eligible, false);
      assert.ok(
        plan.errors.some((x) =>
          ["invalid_date", "future_timestamp"].includes(x.code),
        ),
      );
    }
    for (const url of [
      "file:///tmp/x",
      "https://user:pass@example.invalid/x",
      "https://",
      `https://example.invalid/${"x".repeat(2050)}`,
    ]) {
      const plan = planSyncChangeset(
        db,
        request([
          create("register_source", "role_sources", "s", {
            url,
            title: "Synthetic",
            source_type: "official_page",
          }),
        ]),
      );
      assert.ok(plan.errors.some((x) => x.code === "invalid_url"));
    }
    const allowed = planSyncChangeset(
      db,
      request([
        create("register_source", "role_sources", "s", {
          url: "https://example.invalid/synthetic",
          title: "Synthetic",
          source_type: "official_page",
        }),
      ]),
    );
    assert.equal(allowed.eligible, true);
  });
});

test("rejects invalid and forward references, entity mismatch, and resolves earlier compatible refs", async () => {
  await fixture((db) => {
    const valid = planSyncChangeset(
      db,
      request([
        validOrg(),
        create("create_position", "positions", "position-new", {
          organization_ref: "org-new",
          title: "Synthetic Clerk",
        }),
        create("create_person", "people", "person-new", {
          display_name: "Synthetic Person",
        }),
        create("create_person_role", "person_roles", "role-new", {
          person_ref: "person-new",
          position_ref: "position-new",
          source_id: "source-a",
          source_checked_at: "2026-11-12T00:00:00Z",
        }),
      ]),
    );
    assert.equal(valid.eligible, true, JSON.stringify(valid.errors));
    const cases = [
      [
        create("create_position", "positions", "p", {
          organization_ref: "later",
          title: "Role",
        }),
        validOrg("later"),
      ],
      [
        create("create_person_role", "person_roles", "r", {
          person_ref: "x",
          position_id: "person-a",
          source_id: "source-a",
          source_checked_at: "2026-11-12T00:00:00Z",
        }),
      ],
      [
        validOrg("self", {
          name: "Synthetic",
          organization_type: "department",
          county_fips: "08001",
          parent_organization_ref: "self",
          parent_relationship: "reports_to",
        }),
      ],
    ];
    for (const changes of cases)
      assert.equal(planSyncChangeset(db, request(changes)).eligible, false);
    const forward = planSyncChangeset(
      db,
      request([
        create("create_position", "positions", "position-x", {
          organization_ref: "later-org",
          title: "Synthetic",
        }),
        validOrg("later-org"),
      ]),
    );
    assert.ok(forward.errors.some((x) => x.code === "forward_reference"));
    const unknown = planSyncChangeset(
      db,
      request([
        create("create_position", "positions", "position-x", {
          organization_ref: "unknown-org",
          title: "Synthetic",
        }),
      ]),
    );
    assert.ok(unknown.errors.some((x) => x.code === "invalid_reference"));
    const wrongEntity = planSyncChangeset(
      db,
      request([
        create("create_person", "people", "person-x", {
          display_name: "Synthetic",
        }),
        create("create_position", "positions", "position-x", {
          organization_ref: "person-x",
          title: "Synthetic",
        }),
      ]),
    );
    assert.ok(
      wrongEntity.errors.some((x) => x.code === "wrong_entity_reference"),
    );
    const idSlot = planSyncChangeset(
      db,
      request([
        create("create_person", "people", "person-x", {
          display_name: "Synthetic",
        }),
        create("create_person_role", "person_roles", "role-x", {
          person_id: "person-x",
          position_id: "position-a",
          source_id: "source-a",
          source_checked_at: "2026-11-12T00:00:00Z",
        }),
      ]),
    );
    assert.ok(idSlot.errors.some((x) => x.code === "client_ref_in_id_field"));
    const self = planSyncChangeset(
      db,
      request([
        validOrg("self-org", {
          name: "Synthetic",
          organization_type: "office",
          county_fips: "08001",
          parent_organization_ref: "self-org",
          parent_relationship: "reports_to",
        }),
      ]),
    );
    assert.ok(self.errors.some((x) => x.code === "invalid_reference"));
  });
});

test("planner agrees with representative M1-A county, cycle, uniqueness and enum constraints without mutations", async () => {
  await fixture((db) => {
    const before = state(db);
    const badCounty = planSyncChangeset(
      db,
      request([
        validOrg("county-mismatch", {
          name: "Synthetic child",
          organization_type: "office",
          county_fips: "08013",
          parent_organization_id: "org-a",
          parent_relationship: "reports_to",
        }),
      ]),
    );
    assert.ok(
      badCounty.errors.some((x) => x.code === "hierarchy_county_mismatch"),
    );
    const nullCountyMismatch = planSyncChangeset(
      db,
      request([
        validOrg("null-parent-child", {
          name: "Synthetic child",
          organization_type: "office",
          county_fips: "08001",
          parent_organization_id: "regional-null",
          parent_relationship: "reports_to",
        }),
      ]),
    );
    assert.ok(
      nullCountyMismatch.errors.some(
        (x) => x.code === "hierarchy_county_mismatch",
      ),
    );
    const split = planSyncChangeset(
      db,
      request([update("organizations", "org-a", 1, { county_fips: "08013" })]),
    );
    assert.ok(
      split.errors.some((x) => x.code === "county_change_splits_hierarchy"),
    );
    const duplicateAff = planSyncChangeset(
      db,
      request([
        create(
          "add_county_affiliation",
          "organization_county_affiliations",
          "dup-aff",
          {
            organization_id: "org-a",
            county_fips: "08013",
            relationship_type: "serves",
          },
        ),
      ]),
    );
    assert.ok(
      duplicateAff.errors.some((x) => x.code === "duplicate_affiliation"),
    );
    const badEnum = planSyncChangeset(
      db,
      request([
        create("create_organization", "organizations", "bad-enum", {
          name: "Synthetic",
          organization_type: "not-a-type",
        }),
      ]),
    );
    assert.ok(badEnum.errors.some((x) => x.code === "invalid_enum"));
    assert.deepEqual(state(db), before);

    assert.throws(() =>
      db
        .prepare(
          "UPDATE organizations SET parent_organization_id='org-child',parent_relationship='reports_to',version=version+1 WHERE id='org-a'",
        )
        .run(),
    );
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO organization_county_affiliations(id,organization_id,county_fips,relationship_type) VALUES ('dup','org-a','08013','serves')",
        )
        .run(),
    );
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO organizations(id,name,organization_type) VALUES ('bad','Bad','not-a-type')",
        )
        .run(),
    );
    const cyclicPlan = planSyncChangeset(
      db,
      request([
        update("organizations", "org-a", 1, {
          parent_organization_id: "org-child",
          parent_relationship: "reports_to",
        }),
      ]),
    );
    assert.ok(cyclicPlan.errors.some((x) => x.code === "hierarchy_cycle"));
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO organizations(id,name,organization_type,county_fips,parent_organization_id,parent_relationship) VALUES ('null-parent-child','Synthetic','office','08001','regional-null','reports_to')",
        )
        .run(),
    );
  });
});

test("enforces request bounds, strict unknown keys, advisory flags and dry-run nonlocking", async () => {
  await fixture((db) => {
    db.transaction = () => {
      throw new Error("planner must not open a write transaction");
    };
    const malformed = planSyncChangeset(db, {
      ...request([validOrg()]),
      expectedVersions: {},
    });
    assert.equal(malformed.eligible, false);
    const actor = planSyncChangeset(db, {
      ...request([validOrg()]),
      actorId: "secret actor",
    });
    assert.equal(actor.errors[0].code, "invalid_request");
    assert.equal(JSON.stringify(actor).includes("secret actor"), false);
    const callerId = planSyncChangeset(
      db,
      request([
        create("create_person", "people", "person-new", {
          id: "chosen-id",
          display_name: "Synthetic Person",
        }),
      ]),
    );
    assert.ok(callerId.errors.some((x) => x.code === "unsupported_field"));
    const tooLarge = planSyncChangeset(
      db,
      request([
        validOrg("huge", {
          name: "x".repeat(33_000),
          organization_type: "office",
        }),
      ]),
    );
    assert.ok(tooLarge.errors.some((x) => x.code === "item_too_large"));
    const flags = planSyncChangeset(
      db,
      request([validOrg()], {
        duplicateFlags: [
          {
            targetType: "person",
            targetRef: "person-a",
            possibleDuplicateOf: "person-b",
            category: "possible_match",
            reason: "Synthetic advisory",
            nonblocking: true,
          },
        ],
      }),
    );
    assert.equal(flags.eligible, true);
    assert.equal(flags.duplicateFlags.length, 1);
    const initial = planSyncChangeset(
      db,
      request([
        update("people", "person-a", 1, { display_name: "Synthetic Updated" }),
      ]),
    );
    assert.equal(initial.eligible, true);
    db.prepare(
      "UPDATE people SET display_name='Intervening edit',version=version+1 WHERE id='person-a'",
    ).run();
    const later = planSyncChangeset(
      db,
      request([
        update("people", "person-a", 1, { display_name: "Synthetic Updated" }),
      ]),
    );
    assert.equal(later.errors[0].code, "stale_version");
    const oversizedTotal = planSyncChangeset(
      db,
      request(
        Array.from({ length: 17 }, (_, i) => ({
          ...validOrg(`org-${i}`),
          untrustedPadding: "x".repeat(31_000),
        })),
      ),
    );
    assert.ok(
      oversizedTotal.errors.some((x) => x.code === "request_too_large"),
    );
    const tooManySources = planSyncChangeset(
      db,
      request(
        Array.from({ length: 26 }, (_, i) =>
          create("register_source", "role_sources", `source-${i}`, {
            url: `https://example.invalid/${i}`,
            title: "Synthetic source",
            source_type: "official_page",
          }),
        ),
      ),
    );
    assert.ok(
      tooManySources.errors.some((x) => x.code === "too_many_citations"),
    );
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import {
  loadWebsiteMigrations,
  migrateWebsiteDatabase,
  migrationChecksum,
} from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { handleWebsiteMcpRequest } from "../dist/mcp/website.js";
import { createD1WebsiteInspectionService } from "../dist/services/d1-inspection.js";

const principal = {
  accountId: "synthetic-agent-admin",
  identityId: "synthetic-agent-identity",
  kind: "agent",
  role: "administrator",
  provider: "agent-key",
};

test("Website MCP exposes the bounded tool set and denies unauthenticated calls", async () => {
  const fixture = await createFixture();
  try {
    const noCredential = await fixture.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "website_inspection_status", arguments: {} },
    });
    assert.equal(noCredential.status, 200);
    assert.equal((await noCredential.json()).result.isError, true);

    const discovery = await fixture.request({
      jsonrpc: "2.0",
      id: 2,
      method: "server/discover",
    });
    assert.deepEqual((await discovery.json()).result.supportedVersions, [
      "2026-07-28",
    ]);

    const listed = await fixture.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "website_inspection_status",
      "website_county_reference_counts",
      "website_migration_history",
      "website_county_provenance_summary",
      "website_banner_county",
      "website_banner_publications",
      "website_banner_publish",
      "website_banner_withdraw",
      "website_banner_restore",
      "website_sync_dry_run",
      "website_sync_commit",
      "website_sync_lookup",
      "website_sync_reverse",
    ]);
  } finally {
    fixture.database.close();
  }
});

test("Website D1 inspection is read-only, bounded and provenance-conservative", async () => {
  const fixture = await createFixture();
  try {
    const before = fingerprint(fixture.database);
    const status = await fixture.call("website_inspection_status", {});
    assert.equal(status.state, "ready");
    assert.equal(status.physicalDatabaseIdentity, "unavailable");
    assert.equal(status.migration0014Present, true);
    assert.equal(status.migration0015Present, true);
    assert.deepEqual(
      status.countyRegistry.map((item) => item.matchesCanonical),
      [true, true],
    );

    const history = await fixture.call("website_migration_history", {});
    assert.equal(history.orderedHistoryValid, true);
    assert.equal(history.migrations.length, 35);
    assert.equal(history.migrations.at(-1).name, "0035_profile_delete.sql");

    const references = await fixture.call("website_county_reference_counts", {
      countyFips: ["08065", "08067"],
    });
    const rows = references.references;
    assert.equal(
      rows.every((item) => item.supported),
      true,
    );
    const lakeOrg = rows.find(
      (item) =>
        item.countyFips === "08065" && item.relationship === "organizations",
    );
    const plataOrg = rows.find(
      (item) =>
        item.countyFips === "08067" && item.relationship === "organizations",
    );
    const rolesLake = rows.find(
      (item) =>
        item.countyFips === "08065" &&
        item.relationship === "person_roles_through_positions",
    );
    assert.equal(lakeOrg.count, 1);
    assert.equal(plataOrg.count, 0);
    assert.equal(rolesLake.count, 1);
    assert.equal(
      rows.find(
        (item) =>
          item.relationship === "reports" && item.countyFips === "08065",
      ).result,
      "suppressed",
    );
    assert.equal(
      JSON.stringify(references).includes("PRIVATE REPORT NOTE"),
      false,
    );
    assert.equal(
      JSON.stringify(references).includes("Synthetic Person"),
      false,
    );

    const summary = await fixture.call("website_county_provenance_summary", {
      countyFips: ["08065"],
    });
    assert.equal(summary[0].classification, "unresolved");
    assert.match(summary[0].rationale, /do not retain verified evidence/);
    assert.equal(fingerprint(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});

test("Website MCP rejects unrestricted county input and insufficient capability", async () => {
  const fixture = await createFixture({ authorized: false });
  try {
    const invalid = await fixture.request(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "website_county_reference_counts",
          arguments: { countyFips: ["08001"] },
        },
      },
      true,
    );
    assert.equal((await invalid.json()).result.isError, true);
    assert.equal(fixture.serviceCalls, 0);

    const denied = await fixture.request(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "website_inspection_status", arguments: {} },
      },
      true,
    );
    assert.equal(
      (await denied.json()).result.content[0].text,
      '{"error":"not_authorized"}',
    );
    assert.equal(fixture.serviceCalls, 1);
  } finally {
    fixture.database.close();
  }
});

test("Website migration checksums detect drift without changing the ledger", async () => {
  const fixture = await createFixture();
  const expected = loadWebsiteMigrations().map((migration) => ({
    version: migration.version,
    name: migration.name,
    sha256: migrationChecksum(migration.sql),
  }));
  expected[14].sha256 = "0".repeat(64);
  try {
    const inspection = createD1WebsiteInspectionService(
      new AsyncD1Database(fixture.binding),
      expected,
      { projectId: "synthetic-project", authorize: () => true },
    );
    const before = fingerprint(fixture.database);
    const result = await inspection.migrationHistory(principal);
    assert.equal(result.orderedHistoryValid, false);
    assert.ok(result.issues.includes("migration_checksum_mismatch"));
    assert.equal(fingerprint(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});

async function createFixture({ authorized = true } = {}) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(`
    INSERT INTO accounts (id,kind,role,display_name) VALUES
      ('synthetic-agent-admin','agent','administrator','Synthetic MCP Administrator');
    INSERT INTO organizations (id,name,organization_type,county_fips)
      VALUES ('synthetic-lake-org','Synthetic Lake Office','county_government','08065');
    INSERT INTO organizations (id,name,organization_type,county_fips)
      VALUES ('synthetic-regional-org','Synthetic Regional Office','regional',NULL);
    INSERT INTO organization_county_affiliations (id,organization_id,county_fips,relationship_type)
      VALUES ('synthetic-plata-affiliation','synthetic-regional-org','08067','serves');
    INSERT INTO positions (id,organization_id,title)
      VALUES ('synthetic-lake-position','synthetic-lake-org','Synthetic Position');
    INSERT INTO people (id,display_name) VALUES ('synthetic-person','Synthetic Person');
    INSERT INTO role_sources (id,url,title,source_type)
      VALUES ('synthetic-source','https://example.invalid/official','Synthetic source','official_page');
    INSERT INTO person_roles (id,person_id,position_id,source_id,source_checked_at)
      VALUES ('synthetic-role','synthetic-person','synthetic-lake-position','synthetic-source','2026-11-14T12:00:00Z');
    INSERT INTO reports (id,county_fips,private_json,status,version,created_at)
      VALUES ('synthetic-report','08065','{"note":"PRIVATE REPORT NOTE"}','submitted',1,'2026-11-14T12:00:00Z');
  `);
  const expectedMigrations = loadWebsiteMigrations().map((migration) => ({
    version: migration.version,
    name: migration.name,
    sha256: migrationChecksum(migration.sql),
  }));
  const binding = sqlJsBinding(database);
  const inspection = createD1WebsiteInspectionService(
    new AsyncD1Database(binding),
    expectedMigrations,
    {
      projectId: "synthetic-project",
      authorize: async (candidate) =>
        authorized &&
        candidate.kind === "agent" &&
        candidate.role === "administrator",
    },
  );
  let serviceCalls = 0;
  const handlerServices = {
    async resolvePrincipal(request) {
      return request.headers.get("authorization") === "Bearer synthetic"
        ? principal
        : null;
    },
    async hasCapability(candidate, capability) {
      serviceCalls += 1;
      return Boolean(candidate && authorized && capability === "d1.inspect");
    },
  };
  return {
    database,
    binding,
    inspection,
    get serviceCalls() {
      return serviceCalls;
    },
    async request(body, authenticated = false) {
      const request = new Request("https://watchdog.test/mcp", {
        method: "POST",
        headers: authenticated ? { authorization: "Bearer synthetic" } : {},
        body: JSON.stringify(body),
      });
      return handleWebsiteMcpRequest(request, handlerServices, inspection);
    },
    async call(name, args) {
      const response = await this.request(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        true,
      );
      const envelope = await response.json();
      assert.equal(
        envelope.result.isError,
        undefined,
        envelope.result.content?.[0]?.text,
      );
      return envelope.result.structuredContent.result;
    },
  };
}

function sqlJsBinding(database) {
  return {
    prepare(sql) {
      let values = [];
      const execute = () => {
        const statement = database.prepare(sql);
        return values.length ? statement.all(...values) : statement.all();
      };
      const statement = {
        bind(...bound) {
          values = bound;
          return statement;
        },
        async first() {
          return execute()[0] ?? null;
        },
        async all() {
          return { success: true, results: execute() };
        },
        async run() {
          return { success: false, error: "write not supported" };
        },
      };
      return statement;
    },
    async batch() {
      throw new Error("batch not supported in inspection fixture");
    },
  };
}

function fingerprint(database) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const snapshot = tables.map((name) => {
    const quoted = `"${String(name).replaceAll('"', '""')}"`;
    return [name, database.prepare(`SELECT * FROM ${quoted}`).all()];
  });
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

test("Website MCP accepts the protocol 2026-07-28 request _meta envelope without trusting it", async () => {
  const fixture = await createFixture();
  try {
    // Shape observed from Claude Code 2.1.325 (synthetic values).
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "synthetic-client",
        version: "0.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": { roots: {} },
    };
    const call = (params, authenticated = true) =>
      fixture
        .request(
          { jsonrpc: "2.0", id: 9, method: "tools/call", params },
          authenticated,
        )
        .then((response) => response.json());

    const ok = await call({
      name: "website_inspection_status",
      arguments: {},
      _meta: meta,
    });
    assert.equal(ok.result.isError, undefined);
    assert.equal(ok.result.structuredContent.result.state, "ready");

    const counts = await call({
      name: "website_county_reference_counts",
      arguments: { countyFips: ["08065"] },
      _meta: meta,
    });
    assert.equal(counts.result.isError, undefined);

    // The envelope never authenticates: without a bearer the call is refused.
    const anonymous = await call(
      {
        name: "website_inspection_status",
        _meta: { ...meta, actor: "synthetic-agent-admin" },
      },
      false,
    );
    assert.equal(anonymous.result.isError, true);
    assert.match(anonymous.result.content[0].text, /authentication_required/);

    // A non-object envelope and unknown extra keys are still invalid.
    for (const params of [
      { name: "website_inspection_status", _meta: "x" },
      { name: "website_inspection_status", _meta: null },
      { name: "website_inspection_status", _meta: [] },
      { name: "website_inspection_status", _meta: meta, sql: "SELECT 1" },
    ]) {
      const rejected = await call(params);
      assert.equal(rejected.error?.message, "invalid_params");
    }
  } finally {
    fixture.database.close();
  }
});

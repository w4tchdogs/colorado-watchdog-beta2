import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bannerAdminFixtures } from "../tests/d1/banner-admin-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = join(root, "wrangler.d1-test.toml");
const persist = mkdtempSync(join(tmpdir(), "watchdog-d1-local-"));
const migrationsDirectory = join(root, "website", "migrations");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const migrations = [
  "0001_counties.sql",
  "0002_foundation.sql",
  "0003_county_fips_prefix.sql",
  "0004_m1_county_roles.sql",
  "0005_m2_sync_batches.sql",
  "0006_m2_sync_reversals.sql",
  "0007_m2_duplicate_flags.sql",
  "0008_duplicate_flag_observations.sql",
  "0009_content_foundation.sql",
  "0010_content_revisions.sql",
  "0011_m2_dependency_generation.sql",
  "0012_banner_assets.sql",
  "0013_private_report_intake.sql",
  "0014_owner_bootstrap_audit.sql",
  "0015_correct_lake_la_plata_county_names.sql",
  "0016_banner_homepage_curation.sql",
  "0017_content_publication.sql",
  "0018_banner_publications.sql",
  "0019_human_sign_in.sql",
  "0020_role_source_publisher_classification.sql",
  "0021_report_challenge_claims.sql",
  "0022_unstructured_person_roles.sql",
  "0023_sync_batch_result_size.sql",
  "0024_agent_capability_grants.sql",
  "0025_agent_inspect_grant.sql",
  "0026_agent_banner_publish_grant.sql",
];

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
  });
  if (result.status !== 0) {
    throw new Error(
      `Wrangler failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function checksum(sql) {
  return createHash("sha256")
    .update(sql.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitForWorker(url, process) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null)
      throw new Error(`Wrangler dev exited early (${process.exitCode})`);
    try {
      const response = await fetch(`${url}/read`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Wrangler local Worker did not start: ${lastError}`);
}

async function main() {
  const history = `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')) STRICT;`;
  const sections = [history];
  for (const [index, name] of migrations.entries()) {
    const path = join(migrationsDirectory, name);
    const sql = readFileSync(path, "utf8");
    const escapedName = name.replaceAll("'", "''");
    sections.push(sql);
    sections.push(
      `INSERT INTO schema_migrations (version, name, sha256) VALUES (${index + 1}, '${escapedName}', '${checksum(sql)}');`,
    );
    if (index === 6) {
      sections.push(`
        INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-backfill-actor', 'human', 'contributor', 'Synthetic Backfill Actor');
        INSERT INTO people (id, display_name) VALUES ('d1-backfill-person-a', 'Synthetic Person A'), ('d1-backfill-person-b', 'Synthetic Person B');
        INSERT INTO sync_batches (id, actor_account_id, idempotency_key, request_fingerprint, contract_version, request_id, status, committed_at, result_json)
          VALUES ('d1-backfill-batch', 'd1-backfill-actor', 'd1-backfill-key', '${"a".repeat(64)}', 'm2-sync/v1', 'd1-backfill-request', 'committed', '2026-11-13T00:00:00.000Z', '{}');
        INSERT INTO person_duplicate_flags (id, person_id, possible_duplicate_person_id, pair_low_id, pair_high_id, category, reason, nonblocking, origin_batch_id, origin_actor_account_id, created_at, updated_at, status_changed_at, status_changed_by_account_id)
          VALUES ('d1-backfill-flag', 'd1-backfill-person-a', 'd1-backfill-person-b', 'd1-backfill-person-a', 'd1-backfill-person-b', 'possible_match', 'Synthetic legacy observation', 1, 'd1-backfill-batch', 'd1-backfill-actor', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'd1-backfill-actor');
      `);
    }
    if (index === 8) {
      sections.push(`
        INSERT INTO accounts (id, kind, role, display_name) VALUES
          ('d1-content-author', 'human', 'contributor', 'Synthetic Content Author'),
          ('d1-content-editor', 'human', 'editor', 'Synthetic Content Editor');
        INSERT INTO people (id, display_name) VALUES
          ('d1-content-person-b', 'Synthetic Person B'),
          ('d1-content-person-a', 'Synthetic Person A');
        INSERT INTO organizations (id, name, organization_type, county_fips)
          VALUES ('d1-content-org', 'Synthetic Organization', 'county_government', '08001');
        INSERT INTO content_items
          (id, content_type, title, summary, body, status, archived_at, created_by_account_id,
           last_edited_by_account_id, version, created_at, updated_at)
        VALUES
          ('d1-content-post', 'post', 'Synthetic legacy post', 'Full summary',
           '# Full Markdown' || char(10) || char(10) || '**Preserve every character.**', 'draft', NULL,
           'd1-content-author', 'd1-content-editor', 4,
           '2026-10-01T12:00:00.000Z', '2026-11-12T18:45:12.345Z'),
          ('d1-content-story', 'story', 'Synthetic archived story', NULL,
           'Archived body', 'archived', '2026-11-10T07:08:09.010Z', 'd1-content-author', 'd1-content-author', 3,
           '2026-09-01T00:00:00.000Z', '2026-11-10T07:08:09.010Z');
        INSERT INTO content_item_counties (content_id, county_fips) VALUES
          ('d1-content-post', '08013'), ('d1-content-post', '08001');
        INSERT INTO content_item_people (content_id, person_id) VALUES
          ('d1-content-post', 'd1-content-person-b'), ('d1-content-post', 'd1-content-person-a');
        INSERT INTO content_item_organizations (content_id, organization_id)
          VALUES ('d1-content-post', 'd1-content-org');
      `);
    }
  }
  const migrationFile = join(persist, "website-migrations.sql");
  writeFileSync(migrationFile, sections.join("\n"));
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    persist,
    "--file",
    migrationFile,
  ]);

  const guardedTables = [
    "accounts",
    "identities",
    "counties",
    "organizations",
    "organization_county_affiliations",
    "people",
    "positions",
    "role_sources",
    "person_roles",
    "sync_batches",
    "sync_batch_items",
    "sync_batch_reversals",
    "person_duplicate_flags",
    "person_duplicate_flag_observations",
    "audit_events",
    "content_items",
    "content_item_counties",
    "content_item_people",
    "content_item_organizations",
    "content_revisions",
    "content_publications",
    "guard_probe_writes",
  ];
  const guardTriggers = guardedTables.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((operation) => {
      const suffix = operation.toLowerCase();
      return `CREATE TRIGGER guard_${table}_${suffix} AFTER ${operation} ON ${table}
        BEGIN UPDATE transaction_guard SET generation = generation + 1 WHERE id = 1; END;`;
    }),
  );
  const guardSetup = [
    `CREATE TABLE transaction_guard (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL CHECK (generation >= 0)) STRICT;
     INSERT INTO transaction_guard VALUES (1, 0);
     CREATE TABLE transaction_guard_assertions (id INTEGER PRIMARY KEY CHECK (id = 1), valid INTEGER NOT NULL CHECK (valid = 1)) STRICT;
     CREATE TABLE guard_probe_writes (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;`,
    `INSERT INTO accounts (id, kind, role, display_name)
       VALUES ('d1-guard-shared', 'human', 'administrator', 'Shared versioned record');`,
    ...Array.from({ length: 8 }, (_, index) => {
      const key = `case-${index}`;
      return `INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-guard-actor-${key}', 'human', 'administrator', 'Synthetic guard actor');
        INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('d1-guard-org-${key}', 'Synthetic guard organization', 'county_government', '08001');`;
    }),
    ...guardTriggers,
  ].join("\n");
  const guardFile = join(persist, "transaction-guard-fixture.sql");
  writeFileSync(guardFile, guardSetup);
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    persist,
    "--file",
    guardFile,
  ]);

  // A second independent local store exercises the empty-database path.
  const freshPersist = join(persist, "fresh-database");
  mkdirSync(freshPersist);
  const freshSections = [history];
  const expectedHistory = [];
  for (const [index, name] of migrations.entries()) {
    const sql = readFileSync(join(migrationsDirectory, name), "utf8");
    const digest = checksum(sql);
    expectedHistory.push({ version: index + 1, name, digest });
    freshSections.push(sql);
    freshSections.push(
      `INSERT INTO schema_migrations (version, name, sha256) VALUES (${index + 1}, '${name}', '${digest}');`,
    );
  }
  const freshMigrationFile = join(freshPersist, "fresh-migrations.sql");
  writeFileSync(freshMigrationFile, freshSections.join("\n"));
  const freshArgs = [
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    freshPersist,
    "--file",
    freshMigrationFile,
  ];
  runWrangler(freshArgs);
  const historyChecks = expectedHistory
    .map(
      ({ version, name, digest }) =>
        `EXISTS (SELECT 1 FROM schema_migrations WHERE version = ${version} AND name = '${name}' AND sha256 = '${digest}')`,
    )
    .join(" AND ");
  const freshOutput = runWrangler([
    "d1",
    "execute",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    freshPersist,
    "--command",
    `SELECT CASE WHEN (SELECT COUNT(*) FROM schema_migrations) = 26 AND ${historyChecks} AND (SELECT COUNT(*) FROM counties) = 64 AND (SELECT name FROM counties WHERE fips='08065') = 'Lake' AND (SELECT name FROM counties WHERE fips='08067') = 'La Plata' AND (SELECT COUNT(*) FROM content_revisions) = 0 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_capability_grants') = 1 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('content_items','content_item_counties','content_item_people','content_item_organizations','content_revisions')) = 5 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('banner_assets','banner_asset_versions','banner_stage_operations','banner_publications','banner_admin_operations')) = 5 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('reports','report_receipts','report_idempotency','report_evidence','report_status_history','report_audit')) = 6 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='content_revisions_editor') = 1 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('content_revisions_no_update','content_revisions_no_delete','content_revisions_match_current')) = 3 AND (SELECT generation FROM website_dependency_generation WHERE id = 1) = 3 THEN 'PASS fresh migration history, checksums, schema, and corrected county registry' ELSE 'FAIL fresh migration verification' END AS result;`,
  ]);
  if (!freshOutput.includes("PASS fresh migration history")) {
    throw new Error(`Fresh local D1 verification failed:\n${freshOutput}`);
  }

  const port = await unusedPort();
  const worker = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--config",
      config,
      "--local",
      "--persist-to",
      persist,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  let workerOutput = "";
  worker.stdout.setEncoding("utf8").on("data", (chunk) => {
    workerOutput += chunk;
  });
  worker.stderr.setEncoding("utf8").on("data", (chunk) => {
    workerOutput += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForWorker(base, worker);
    const checks = await fetch(`${base}/verify`);
    const responseBody = await checks.text();
    let detail;
    try {
      detail = JSON.parse(responseBody);
    } catch {
      const message =
        responseBody.match(/D1 check failed:[^<]*/)?.[0] ??
        responseBody.slice(0, 200);
      throw new Error(
        `Local Worker returned HTTP ${checks.status}: ${message}\n${workerOutput.slice(-2_000)}`,
      );
    }
    if (!checks.ok || !detail.success) throw new Error(JSON.stringify(detail));

    const reportCheckResponse = await fetch(`${base}/reports/verify`, {
      method: "POST",
    });
    const reportCheck = await reportCheckResponse.json();
    if (!reportCheckResponse.ok || !reportCheck.success) {
      throw new Error(
        `Local D1 report-intake verification failed: ${JSON.stringify(reportCheck)}`,
      );
    }
    console.log(
      "PASS D1 report intake: atomic writes/rollback, private projections, receipt digest, replay, reference validation, credential checks, and concurrent version transitions",
    );

    const races = [
      ["organization", "county hierarchy/row version"],
      ["relationship", "missing related position appeared"],
      ["source", "unique source URL inserted"],
      ["affiliation", "county affiliation inserted"],
      ["account", "actor became inactive"],
      ["idempotency", "actor-scoped idempotency key claimed"],
    ];
    for (const [index, [mode, label]] of races.entries()) {
      const key = `case-${index}`;
      const snapshot = await (
        await fetch(`${base}/guard/snapshot`, { method: "POST" })
      ).json();
      const changeResponse = await fetch(
        `${base}/guard/change?key=${key}&mode=${mode}`,
        { method: "POST" },
      );
      const planResponse = await fetch(
        `${base}/guard/commit?key=${key}&generation=${snapshot.generation}${mode === "organization" ? "&row=organization" : ""}`,
        { method: "POST" },
      );
      const outcome = await planResponse.json();
      if (
        changeResponse.status !== 200 ||
        planResponse.status !== 409 ||
        outcome.committed
      ) {
        throw new Error(
          `Guard failed to reject ${label}: ${JSON.stringify(outcome)}`,
        );
      }
      const state = await (
        await fetch(`${base}/guard/state?key=${key}`)
      ).json();
      if (state.planned !== 0 || state.audit !== 0 || state.assertions !== 0) {
        throw new Error(`Stale ${label} left partial writes or audit`);
      }
      if (
        mode === "organization" &&
        (state.org_version !== 2 ||
          state.org_name !== "Changed after planner read")
      ) {
        throw new Error(
          "Stale same-record writer overwrote the competing version",
        );
      }
      console.log(
        `PASS transaction guard rejects stale ${label} and rolls back writes/audit`,
      );
      if (mode === "organization") {
        console.log(
          "PASS competing version-1 organization update is preserved; stale same-row update is rejected",
        );
      }
    }
    const sameVersion = await (
      await fetch(`${base}/guard/snapshot`, { method: "POST" })
    ).json();
    const firstWriter = await fetch(
      `${base}/guard/commit?key=case-7a&generation=${sameVersion.generation}&row=organization&target=case-7`,
      { method: "POST" },
    );
    const secondWriter = await fetch(
      `${base}/guard/commit?key=case-7b&generation=${sameVersion.generation}&row=organization&target=case-7`,
      { method: "POST" },
    );
    const [firstOutcome, secondOutcome] = await Promise.all([
      firstWriter.json(),
      secondWriter.json(),
    ]);
    if (
      !firstOutcome.committed ||
      secondWriter.status !== 409 ||
      secondOutcome.committed
    ) {
      throw new Error(
        "Same-version writers did not produce one guarded winner",
      );
    }
    console.log(
      "PASS two requests planned at one version: first writer commits, second writer is rejected",
    );

    const successKey = "case-6";
    const successSnapshot = await (
      await fetch(`${base}/guard/snapshot`, { method: "POST" })
    ).json();
    const successResponse = await fetch(
      `${base}/guard/commit?key=${successKey}&generation=${successSnapshot.generation}`,
      { method: "POST" },
    );
    const successState = await (
      await fetch(`${base}/guard/state?key=${successKey}`)
    ).json();
    if (
      !successResponse.ok ||
      successState.planned !== 1 ||
      successState.audit !== 1 ||
      successState.assertions !== 0
    ) {
      throw new Error(
        "Guarded successful batch did not preserve its write and audit",
      );
    }
    console.log(
      "PASS guarded D1 batch commits expected write and audit together",
    );

    const setupAsync = await fetch(`${base}/sync/setup`, { method: "POST" });
    if (!setupAsync.ok)
      throw new Error("Could not prepare the synthetic async D1 principal");
    const asyncBatch = {
      contractVersion: "m2-sync/v1",
      requestId: "6b5f57a2-84b7-4a4d-b300-33aea9feeb19",
      intent: "commit",
      changes: [
        {
          op: "create_organization",
          entity: "organizations",
          clientRef: "org",
          fields: {
            name: "Synthetic Async Office",
            organization_type: "office",
            county_fips: "08001",
          },
        },
        {
          op: "add_county_affiliation",
          entity: "organization_county_affiliations",
          clientRef: "aff",
          fields: {
            organization_ref: "org",
            county_fips: "08013",
            relationship_type: "serves",
          },
        },
        {
          op: "create_position",
          entity: "positions",
          clientRef: "position",
          fields: { organization_ref: "org", title: "Synthetic Async Clerk" },
        },
        {
          op: "create_person",
          entity: "people",
          clientRef: "person",
          fields: { display_name: "Fictional Async Person" },
        },
        {
          op: "register_source",
          entity: "role_sources",
          clientRef: "source",
          fields: {
            url: "https://example.invalid/d1-async",
            title: "Synthetic async source",
            publisher_classification: "official",
            source_type: "official_page",
          },
        },
        {
          op: "create_person_role",
          entity: "person_roles",
          clientRef: "role",
          fields: {
            person_ref: "person",
            position_ref: "position",
            source_ref: "source",
            county_fips: "08001",
            source_checked_at: "2026-11-12T12:00:00Z",
          },
        },
      ],
      duplicateFlags: [
        {
          targetType: "person",
          targetRef: "person",
          possibleDuplicateOf: "d1-backfill-person-a",
          category: "possible_match",
          reason: "Synthetic async local observation",
          evidenceSourceRefs: ["source"],
          nonblocking: true,
        },
      ],
    };
    const asyncCommitResponse = await fetch(
      `${base}/sync/commit?key=async-commit-key`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(asyncBatch),
      },
    );
    const asyncCommit = await asyncCommitResponse.json();
    if (
      !asyncCommitResponse.ok ||
      asyncCommit.status !== "committed" ||
      asyncCommit.items?.length !== 6 ||
      asyncCommit.replayed
    ) {
      throw new Error(
        `Async D1 complete commit failed: ${JSON.stringify(asyncCommit)}`,
      );
    }
    const asyncReplayResponse = await fetch(
      `${base}/sync/commit?key=async-commit-key`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...asyncBatch,
          requestId: "7b5f57a2-84b7-4a4d-b300-33aea9feeb20",
        }),
      },
    );
    const asyncReplay = await asyncReplayResponse.json();
    if (
      !asyncReplayResponse.ok ||
      asyncReplay.batchId !== asyncCommit.batchId ||
      !asyncReplay.replayed ||
      JSON.stringify(asyncReplay.items) !== JSON.stringify(asyncCommit.items)
    ) {
      throw new Error(
        `Async D1 durable replay failed: ${JSON.stringify(asyncReplay)}`,
      );
    }
    const persistedAsync = await (
      await fetch(`${base}/sync/state?key=async-commit-key`)
    ).json();
    if (
      persistedAsync.batches !== 1 ||
      persistedAsync.items !== 6 ||
      persistedAsync.audits !== 1 ||
      persistedAsync.flags !== 1 ||
      persistedAsync.observations !== 1 ||
      persistedAsync.dependency_assertions !== 0 ||
      persistedAsync.version_assertions !== 0
    ) {
      throw new Error(
        `Async D1 commit left inconsistent durable state: ${JSON.stringify(persistedAsync)}`,
      );
    }
    console.log(
      "PASS production-code async D1 commit persists records, mappings, inverse metadata, audit, and replay",
    );

    const raceBatch = {
      ...asyncBatch,
      requestId: "8b5f57a2-84b7-4a4d-b300-33aea9feeb21",
      changes: [
        {
          op: "create_person",
          entity: "people",
          clientRef: "racer",
          fields: { display_name: "Fictional Async Race Person" },
        },
      ],
      duplicateFlags: [],
    };
    const racePayload = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raceBatch),
    };
    const racedResponses = await Promise.all([
      fetch(`${base}/sync/commit?key=async-race-key`, racePayload),
      fetch(`${base}/sync/commit?key=async-race-key`, racePayload),
    ]);
    const racedResults = await Promise.all(
      racedResponses.map((response) => response.json()),
    );
    if (
      racedResponses.some((response) => !response.ok) ||
      racedResults.some((result) => result.status !== "committed") ||
      racedResults[0].batchId !== racedResults[1].batchId ||
      Number(racedResults[0].replayed) + Number(racedResults[1].replayed) !== 1
    ) {
      throw new Error(
        `Async D1 idempotency race did not return one durable winner: ${JSON.stringify(racedResults)}`,
      );
    }
    const persistedRace = await (
      await fetch(`${base}/sync/state?key=async-race-key`)
    ).json();
    if (
      persistedRace.batches !== 1 ||
      persistedRace.items !== 1 ||
      persistedRace.audits !== 1 ||
      persistedRace.dependency_assertions !== 0 ||
      persistedRace.version_assertions !== 0
    ) {
      throw new Error(
        `Async D1 idempotency race left inconsistent durable state: ${JSON.stringify(persistedRace)}`,
      );
    }
    console.log(
      "PASS independent Worker requests racing for one idempotency key return the stored winning result",
    );

    const asyncOrganizationId = asyncCommit.items.find(
      (item) => item.entity === "organizations",
    )?.websiteId;
    if (!asyncOrganizationId)
      throw new Error("Async commit did not return its organization mapping");
    const competingUpdates = [
      {
        ...asyncBatch,
        requestId: "ab5f57a2-84b7-4a4d-b300-33aea9feeb20",
        duplicateFlags: [],
        changes: [
          {
            op: "update_record",
            entity: "organizations",
            targetId: asyncOrganizationId,
            expectedVersion: 1,
            fields: { name: "Synthetic Async Winner A" },
          },
        ],
      },
      {
        ...asyncBatch,
        requestId: "bb5f57a2-84b7-4a4d-b300-33aea9feeb20",
        duplicateFlags: [],
        changes: [
          {
            op: "update_record",
            entity: "organizations",
            targetId: asyncOrganizationId,
            expectedVersion: 1,
            fields: { name: "Synthetic Async Winner B" },
          },
        ],
      },
    ];
    const updateResponses = await Promise.all(
      competingUpdates.map((body, index) =>
        fetch(`${base}/sync/commit?key=async-update-${index}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
    const updateResults = await Promise.all(
      updateResponses.map((response) => response.json()),
    );
    const finalOrg = await (
      await fetch(
        `${base}/sync/record?id=${encodeURIComponent(asyncOrganizationId)}`,
      )
    ).json();
    if (
      updateResults.filter((result) => result.status === "committed").length !==
        1 ||
      updateResults.filter((result) => result.status === "rejected").length !==
        1 ||
      finalOrg.version !== 2 ||
      !["Synthetic Async Winner A", "Synthetic Async Winner B"].includes(
        finalOrg.name,
      )
    ) {
      throw new Error(
        `Async D1 competing row updates were not version guarded: ${JSON.stringify({ updateResults, finalOrg })}`,
      );
    }
    console.log(
      "PASS production-code async D1 same-row updates preserve one expected-version winner",
    );

    const raceBatchId = racedResults[0].batchId;
    const reverseResponse = await fetch(
      `${base}/sync/reverse?batch=${encodeURIComponent(raceBatchId)}&key=async-reversal-key`,
      { method: "POST" },
    );
    const reversal = await reverseResponse.json();
    if (!reverseResponse.ok || reversal.status !== "reverted") {
      throw new Error(`Async D1 reversal failed: ${JSON.stringify(reversal)}`);
    }
    const reverseReplayResponse = await fetch(
      `${base}/sync/reverse?batch=${encodeURIComponent(raceBatchId)}&key=async-reversal-key`,
      { method: "POST" },
    );
    const reverseReplay = await reverseReplayResponse.json();
    if (
      !reverseReplayResponse.ok ||
      reverseReplay.status !== "reverted" ||
      !reverseReplay.replayed
    ) {
      throw new Error(
        `Async D1 reversal replay failed: ${JSON.stringify(reverseReplay)}`,
      );
    }
    const reversedState = await (
      await fetch(`${base}/sync/state?key=async-race-key`)
    ).json();
    if (
      reversedState.items !== 1 ||
      reversedState.audits !== 1 ||
      reversedState.reversals !== 1 ||
      reversedState.reversal_audits !== 1 ||
      reversedState.dependency_assertions !== 0 ||
      reversedState.version_assertions !== 0
    ) {
      throw new Error(
        `Async D1 reversal left inconsistent durable state: ${JSON.stringify(reversedState)}`,
      );
    }
    console.log(
      "PASS production-code async D1 reversal atomically removes its batch data, retains history, and replays",
    );

    for (const [index, stage] of ["early", "middle", "final"].entries()) {
      const failureBatch = structuredClone(asyncBatch);
      failureBatch.requestId = `cb5f57a2-84b7-4a4d-b300-33aea9feeb0${index}`;
      failureBatch.changes[0].fields.name = `Synthetic Reversal Failure ${stage}`;
      failureBatch.changes[4].fields.url = `https://example.invalid/d1-reversal-failure-${stage}`;
      const failureCommitResponse = await fetch(
        `${base}/sync/commit?key=reversal-failure-batch-${stage}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(failureBatch),
        },
      );
      const failureCommit = await failureCommitResponse.json();
      if (!failureCommitResponse.ok || failureCommit.status !== "committed") {
        throw new Error(
          `Failed to prepare ${stage} reversal fixture: ${JSON.stringify(failureCommit)}`,
        );
      }
      const injectedResponse = await fetch(
        `${base}/sync/reverse-failure?batch=${encodeURIComponent(failureCommit.batchId)}&stage=${stage}`,
        { method: "POST" },
      );
      const injected = await injectedResponse.json();
      const failureStateResponse = await fetch(
        `${base}/sync/reversal-state?batch=${encodeURIComponent(failureCommit.batchId)}`,
      );
      const failureStateText = await failureStateResponse.text();
      let failureState;
      try {
        failureState = JSON.parse(failureStateText);
      } catch {
        throw new Error(
          `Reversal state endpoint failed (${failureStateResponse.status}): ${failureStateText.slice(-3000)}`,
        );
      }
      if (
        injectedResponse.status !== 409 ||
        injected.status !== "reversal_blocked" ||
        failureState.items !== 6 ||
        failureState.receipts !== 0 ||
        failureState.audits !== 0 ||
        failureState.flags !== 1 ||
        failureState.observations !== 1 ||
        failureState.roles !== 1 ||
        failureState.positions !== 1 ||
        failureState.people !== 1 ||
        failureState.sources !== 1 ||
        failureState.organizations !== 1 ||
        failureState.affiliations !== 1 ||
        failureState.dependency_assertions !== 0 ||
        failureState.version_assertions !== 0
      ) {
        throw new Error(
          `D1 ${stage} reversal failure left partial state: ${JSON.stringify({ injected, failureState })}`,
        );
      }
    }
    console.log(
      "PASS local D1 early, middle, and final reversal failures roll back all data, receipts, and audits",
    );

    const concurrentBatch = structuredClone(asyncBatch);
    concurrentBatch.requestId = "db5f57a2-84b7-4a4d-b300-33aea9feeb10";
    concurrentBatch.changes[0].fields.name = "Synthetic Concurrent Reversal";
    concurrentBatch.changes[4].fields.url =
      "https://example.invalid/d1-concurrent-reversal";
    const concurrentCommitResponse = await fetch(
      `${base}/sync/commit?key=concurrent-reversal-batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(concurrentBatch),
      },
    );
    const concurrentCommit = await concurrentCommitResponse.json();
    if (
      !concurrentCommitResponse.ok ||
      concurrentCommit.status !== "committed"
    ) {
      throw new Error(
        `Failed to prepare concurrent reversal fixture: ${JSON.stringify(concurrentCommit)}`,
      );
    }
    const concurrentReversals = await Promise.all([
      fetch(
        `${base}/sync/reverse?batch=${encodeURIComponent(concurrentCommit.batchId)}&key=concurrent-reverse-a`,
        { method: "POST" },
      ),
      fetch(
        `${base}/sync/reverse?batch=${encodeURIComponent(concurrentCommit.batchId)}&key=concurrent-reverse-b`,
        { method: "POST" },
      ),
    ]);
    const concurrentResults = await Promise.all(
      concurrentReversals.map((response) => response.json()),
    );
    const concurrentState = await (
      await fetch(
        `${base}/sync/reversal-state?batch=${encodeURIComponent(concurrentCommit.batchId)}`,
      )
    ).json();
    if (
      concurrentResults.filter((result) => result.status === "reverted")
        .length !== 1 ||
      concurrentState.receipts !== 1 ||
      concurrentState.audits !== 1 ||
      concurrentState.dependency_assertions !== 0 ||
      concurrentState.version_assertions !== 0
    ) {
      throw new Error(
        `Concurrent reversals were not serialized safely: ${JSON.stringify({ concurrentResults, concurrentState })}`,
      );
    }
    console.log(
      "PASS local D1 concurrent reversal requests produce exactly one durable receipt and audit",
    );

    for (const [index, mode] of ["version", "generation"].entries()) {
      const staleBatch = structuredClone(asyncBatch);
      staleBatch.requestId = `eb5f57a2-84b7-4a4d-b300-33aea9feeb0${index}`;
      staleBatch.changes[0].fields.name = `Synthetic Stale Reversal ${mode}`;
      staleBatch.changes[4].fields.url = `https://example.invalid/d1-stale-reversal-${mode}`;
      const staleCommitResponse = await fetch(
        `${base}/sync/commit?key=stale-reversal-batch-${mode}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(staleBatch),
        },
      );
      const staleCommit = await staleCommitResponse.json();
      if (!staleCommitResponse.ok || staleCommit.status !== "committed") {
        throw new Error(
          `Failed to prepare ${mode} reversal fixture: ${JSON.stringify(staleCommit)}`,
        );
      }
      const staleResponse = await fetch(
        `${base}/sync/reverse-stale?batch=${encodeURIComponent(staleCommit.batchId)}&mode=${mode}`,
        { method: "POST" },
      );
      const staleResult = await staleResponse.json();
      const staleState = await (
        await fetch(
          `${base}/sync/reversal-state?batch=${encodeURIComponent(staleCommit.batchId)}`,
        )
      ).json();
      if (
        staleResponse.status !== 409 ||
        staleResult.status !== "reversal_blocked" ||
        staleState.items !== 6 ||
        staleState.receipts !== 0 ||
        staleState.audits !== 0 ||
        staleState.dependency_assertions !== 0 ||
        staleState.version_assertions !== 0
      ) {
        throw new Error(
          `D1 ${mode} reversal protection failed: ${JSON.stringify({ staleResult, staleState })}`,
        );
      }
    }
    console.log(
      "PASS local D1 reversal rejects changed row versions and dependency generations without receipts or audits",
    );

    const invalidInverseBatch = structuredClone(asyncBatch);
    invalidInverseBatch.requestId = "fb5f57a2-84b7-4a4d-b300-33aea9feeb01";
    invalidInverseBatch.changes[0].fields.name = "Synthetic Invalid Inverse";
    invalidInverseBatch.changes[4].fields.url =
      "https://example.invalid/d1-invalid-inverse";
    const invalidInverseCommitResponse = await fetch(
      `${base}/sync/commit?key=invalid-inverse-batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidInverseBatch),
      },
    );
    const invalidInverseCommit = await invalidInverseCommitResponse.json();
    if (
      !invalidInverseCommitResponse.ok ||
      invalidInverseCommit.status !== "committed"
    ) {
      throw new Error(
        `Failed to prepare invalid inverse fixture: ${JSON.stringify(invalidInverseCommit)}`,
      );
    }
    const invalidInverseResponse = await fetch(
      `${base}/sync/reverse-corrupt?batch=${encodeURIComponent(invalidInverseCommit.batchId)}`,
      { method: "POST" },
    );
    const invalidInverse = await invalidInverseResponse.json();
    const invalidInverseState = await (
      await fetch(
        `${base}/sync/reversal-state?batch=${encodeURIComponent(invalidInverseCommit.batchId)}`,
      )
    ).json();
    if (
      invalidInverseResponse.status !== 409 ||
      invalidInverse.status !== "reversal_blocked" ||
      invalidInverseState.items !== 6 ||
      invalidInverseState.receipts !== 0 ||
      invalidInverseState.audits !== 0 ||
      invalidInverseState.flags !== 1 ||
      invalidInverseState.observations !== 1
    ) {
      throw new Error(
        `Corrupt D1 inverse metadata was not blocked safely: ${JSON.stringify({ invalidInverse, invalidInverseState })}`,
      );
    }
    for (const mode of ["foreign", "inactive", "revoked"]) {
      const securityResponse = await fetch(
        `${base}/sync/reverse-security?batch=${encodeURIComponent(invalidInverseCommit.batchId)}&mode=${mode}`,
        { method: "POST" },
      );
      const securityResult = await securityResponse.json();
      if (
        (mode === "foreign" &&
          (securityResponse.status !== 409 ||
            securityResult.status !== "reversal_blocked")) ||
        (mode !== "foreign" &&
          (securityResponse.status !== 403 || securityResult.denied !== true))
      ) {
        throw new Error(
          `D1 ${mode} reversal authorization was not denied: ${JSON.stringify(securityResult)}`,
        );
      }
    }
    console.log(
      "PASS local D1 rejects corrupt inverse metadata, cross-actor access, inactive accounts, and revoked identities",
    );

    for (const [index, mode] of [
      "dependent",
      "flag-decided",
      "later-observation",
    ].entries()) {
      const protectedBatch = structuredClone(asyncBatch);
      protectedBatch.requestId = `0b5f57a2-84b7-4a4d-b300-33aea9feeb0${index}`;
      protectedBatch.changes[0].fields.name = `Synthetic Protected Reversal ${mode}`;
      protectedBatch.changes[4].fields.url = `https://example.invalid/d1-protected-reversal-${mode}`;
      const protectedCommitResponse = await fetch(
        `${base}/sync/commit?key=protected-reversal-batch-${mode}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(protectedBatch),
        },
      );
      const protectedCommit = await protectedCommitResponse.json();
      if (
        !protectedCommitResponse.ok ||
        protectedCommit.status !== "committed"
      ) {
        throw new Error(
          `Failed to prepare ${mode} dependency fixture: ${JSON.stringify(protectedCommit)}`,
        );
      }
      const protectedResponse = await fetch(
        `${base}/sync/reverse-protection?batch=${encodeURIComponent(protectedCommit.batchId)}&mode=${mode}`,
        { method: "POST" },
      );
      const protectedText = await protectedResponse.text();
      let protectedResult;
      try {
        protectedResult = JSON.parse(protectedText);
      } catch {
        throw new Error(
          `D1 ${mode} protection endpoint failed (${protectedResponse.status}): ${protectedText.slice(-2000)}`,
        );
      }
      const protectedState = await (
        await fetch(
          `${base}/sync/reversal-state?batch=${encodeURIComponent(protectedCommit.batchId)}`,
        )
      ).json();
      if (
        protectedResponse.status !== 409 ||
        protectedResult.status !== "reversal_blocked" ||
        protectedState.items !== 6 ||
        protectedState.receipts !== 0 ||
        protectedState.audits !== 0 ||
        protectedState.flags !== 1 ||
        protectedState.roles !== 1 ||
        protectedState.positions !== 1 ||
        protectedState.people !== 1 ||
        protectedState.sources !== 1 ||
        protectedState.organizations !== 1 ||
        protectedState.affiliations !== 1
      ) {
        throw new Error(
          `D1 ${mode} dependency did not safely block reversal: ${JSON.stringify({ protectedResult, protectedState })}`,
        );
      }
    }
    console.log(
      "PASS local D1 protects later dependents, duplicate-flag decisions, and later duplicate observations",
    );

    const committedPersonId = asyncCommit.items.find(
      (item) => item.entity === "people",
    )?.websiteId;
    if (!committedPersonId)
      throw new Error("Async commit did not return its person mapping");
    const failureStages = ["record", "batch", "duplicate", "audit"];
    for (const [index, stage] of failureStages.entries()) {
      const ref = `injected-${stage}`;
      const failureBatch = {
        ...asyncBatch,
        requestId: `9b5f57a2-84b7-4a4d-b300-33aea9feeb2${index}`,
        changes: [
          {
            op: "create_person",
            entity: "people",
            clientRef: ref,
            fields: { display_name: `Injected failure ${stage}` },
          },
        ],
        duplicateFlags:
          stage === "duplicate"
            ? [
                {
                  targetType: "person",
                  targetRef: ref,
                  possibleDuplicateOf: committedPersonId,
                  category: "possible_match",
                  reason: "Injected failure duplicate",
                  evidenceSourceRefs: [],
                  nonblocking: true,
                },
              ]
            : [],
      };
      const failureResponse = await fetch(
        `${base}/sync/failure?stage=${stage}&key=async-failure-${stage}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(failureBatch),
        },
      );
      const failureResult = await failureResponse.json();
      const failureState = await (
        await fetch(`${base}/sync/state?key=async-failure-${stage}`)
      ).json();
      if (
        failureResponse.status !== 409 ||
        failureResult.status !== "rejected" ||
        failureState.batches !== 0 ||
        failureState.items !== 0 ||
        failureState.audits !== 0 ||
        failureState.injected_people !== 0 ||
        failureState.dependency_assertions !== 0 ||
        failureState.version_assertions !== 0
      ) {
        throw new Error(
          `Async D1 ${stage} failure left partial commit state: ${JSON.stringify({ failureResult, failureState })}`,
        );
      }
    }
    console.log(
      "PASS async D1 injected record, batch item, duplicate observation, and audit failures roll back all state",
    );

    const bannerResponse = await fetch(`${base}/banners/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bannerAdminFixtures()),
    });
    const bannerCheck = await bannerResponse.json();
    if (!bannerResponse.ok || !bannerCheck.success) {
      throw new Error(
        `Local D1 banner administration verification failed: ${JSON.stringify(bannerCheck)}`,
      );
    }
    console.log(
      `PASS D1 banner administration: ${bannerCheck.checks.length} checks for authority, bounded reads, image inspection, idempotent staging, storage failure and lost-authority reconciliation`,
    );

    console.log(
      `PASS D1 banner publication: ${bannerCheck.publishChecks.length} checks for publish, replace, restore with recorded text, withdraw, metadata, order, stale writes, corrupt objects, lost authority and history immutability`,
    );

    console.log(
      `PASS D1 banner administration API: ${bannerCheck.apiChecks.length} checks for denial, origin, stage, private preview, publish, replace, restore, stale and idempotent writes, corrupt and missing objects, storage failure and revocation after the permission check`,
    );
    console.log(
      `PASS D1 banner MCP tools: ${bannerCheck.mcpChecks.length} checks for protected-API staging, MCP lookup, publish, same-key replay, stale and unverified refusal, readback, withdraw, recorded restore, audit, denied credentials and a grant revoked during the write`,
    );

    const write = await fetch(`${base}/write`, { method: "POST" });
    const inserted = await write.json();
    const read = await fetch(`${base}/read`);
    const persisted = await read.json();
    if (!write.ok || inserted.version !== 1 || persisted?.id !== inserted?.id) {
      throw new Error(
        "Local D1 state did not survive separate Worker requests",
      );
    }
    console.log(
      `PASS local Wrangler D1: migrations 0001–0026; ${detail.checks.length} API checks; state persisted across requests`,
    );
  } finally {
    if (process.platform === "win32" && worker.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {}
    } else {
      try {
        process.kill(-worker.pid, "SIGTERM");
      } catch {}
    }
    await Promise.race([
      new Promise((resolveExit) => worker.once("exit", resolveExit)),
      delay(5_000),
    ]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(persist, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4 || error.code !== "EBUSY") {
          console.error(
            `Unable to remove disposable D1 state: ${error.message}`,
          );
          process.exitCode = 1;
          break;
        }
        await delay(250 * (attempt + 1));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

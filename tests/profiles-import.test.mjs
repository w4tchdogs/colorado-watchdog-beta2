import assert from "node:assert/strict";
import test from "node:test";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createD1PublicReadServices } from "../dist/services/d1-public-reads.js";
import { createServices } from "../dist/services/index.js";
import { createD1ProfilesService } from "../dist/services/profiles-d1.js";
import {
  normalizeHeader,
  parseImportFile,
  readCsv,
} from "../dist/services/profiles-import-csv.js";
import {
  createD1ProfilesImportService,
  ImportIdempotencyError,
  ImportStalePreviewError,
  ImportValidationError,
} from "../dist/services/profiles-import-d1.js";
import {
  createTestHumanIdentityAdapter,
  resolvePrincipal,
} from "../dist/services/security.js";
import { commitSyncChangesetD1 } from "../dist/services/sync-commit-d1.js";
import { createProfilesApiTransport } from "../dist/transport/profiles-api.js";
import { buildAdamsFixture } from "../scripts/profiles-import-fixture.mjs";

const ORIGIN = "https://watchdog.invalid";
const NOW = () => new Date("2026-11-19T12:00:00.000Z");

function d1Over(database) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    async first() {
      return database.prepare(sql).get(...values) ?? null;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values) };
    },
    async run() {
      database.prepare(sql).run(...values);
      return { success: true };
    },
    runSync() {
      database.prepare(sql).run(...values);
      return { success: true };
    },
  });
  return new AsyncD1Database({
    prepare: (sql) => statement(sql),
    async batch(statements) {
      return database.transaction(() => statements.map((s) => s.runSync()))();
    },
  });
}

/** Synthetic Website with one pre-existing Profile the file never mentions. */
const SEED = `
  INSERT INTO accounts (id, kind, role, display_name) VALUES ('acct-owner', 'human', 'owner', 'Synthetic Owner'), ('acct-editor', 'human', 'editor', 'Synthetic Editor');
  INSERT INTO identities (id, account_id, provider, subject) VALUES ('ident-owner', 'acct-owner', 'test-human', 'owner'), ('ident-editor', 'acct-editor', 'test-human', 'editor');
  INSERT INTO organizations (id, name, organization_type, county_fips) VALUES ('org-adams', 'Synthetic Adams Office', 'office', '08001');
  INSERT INTO positions (id, organization_id, title) VALUES ('pos-adams', 'org-adams', 'Synthetic Clerk');
  INSERT INTO role_sources (id, url, title, source_type) VALUES ('src-keep', 'https://example.invalid/keep', 'Synthetic keep source', 'official_page');
  INSERT INTO people (id, display_name) VALUES ('person-keep', 'Synthetic Untouched Person');
  INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at) VALUES ('role-keep', 'person-keep', 'pos-adams', 'src-keep', '2026-10-01T00:00:00Z');
`;

const csv = (rows) => `${rows.map((r) => r.join(",")).join("\r\n")}\r\n`;
const PROFILE_HEAD = ["profile_id", "display_name"];
const ROLE_HEAD = [
  "role_id",
  "profile_id",
  "county_fips",
  "published_office",
  "source_id",
  "source_url",
  "source_title",
  "publisher_classification",
  "source_type",
  "source_checked_at",
];
const role = (id, profile, source = "S1", extra = {}) => [
  id,
  profile,
  extra.county ?? "08001",
  extra.office ?? "Synthetic Recorder",
  source,
  extra.url ?? `https://example.invalid/${source}`,
  extra.title ?? `Source ${source}`,
  "official",
  "official_page",
  extra.checked ?? "2026-11-01T00:00:00Z",
];
const small = (names = { P1: "Synthetic Alpha", P2: "Synthetic Beta" }) => ({
  profile: csv([
    PROFILE_HEAD,
    ...Object.entries(names).map(([k, v]) => [k, v]),
  ]),
  profileRole: csv([ROLE_HEAD, role("R1", "P1"), role("R2", "P2", "S1")]),
});

async function withService(callback) {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database.exec(SEED);
  const adapter = createTestHumanIdentityAdapter({
    owner: "owner",
    editor: "editor",
  });
  const principal = (subject) =>
    resolvePrincipal(
      database,
      new Request(ORIGIN, { headers: { "x-test-human-subject": subject } }),
      adapter,
    );
  const d1 = d1Over(database);
  const authorize = async (p) => p.accountId === "acct-owner";
  const service = createD1ProfilesImportService(d1, { authorize, now: NOW });
  const profiles = createD1ProfilesService(d1, { authorize, now: NOW });
  const count = (table) =>
    database.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  try {
    await callback({
      database,
      d1,
      service,
      profiles,
      count,
      owner: await principal("owner"),
      editor: await principal("editor"),
      principal,
      adapter,
      authorize,
    });
  } finally {
    database.close();
  }
}

const TABLES = [
  "people",
  "person_roles",
  "role_sources",
  "person_visibility",
  "sync_batches",
  "sync_batch_items",
  "audit_events",
];
const snapshot = (count) =>
  Object.fromEntries(TABLES.map((t) => [t, count(t)]));
const idFor = (database, key) =>
  database
    .prepare("SELECT target_id id FROM sync_batch_items WHERE client_ref = ?")
    .get(`dash:profile:${key}`)?.id;

test("reads quoted fields, a byte order mark, CRLF and v6 header aliases", () => {
  const text =
    '﻿Profile ID,Display Name\r\nP1,"Doe, ""Jo"""\r\nP2,"two\nlines"\r\n';
  const { records, error } = readCsv(text);
  assert.equal(error, null);
  assert.equal(records.length, 3);
  assert.equal(records[1].cells[1], 'Doe, "Jo"');
  assert.equal(records[2].line, 3);
  assert.equal(normalizeHeader("County code"), "county_fips");
  const parsed = parseImportFile("profile.csv", text);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].values.display_name, 'Doe, "Jo"');
  const withExtra = parseImportFile(
    "profile.csv",
    "profile_id,display_name,first_name,claim_id\r\nP1,A,Jo,c1\r\n",
  );
  assert.deepEqual(withExtra.ignoredColumns, ["first_name", "claim_id"]);
  assert.equal(
    parseImportFile("profile.csv", "profile_id\r\nP1\r\n").issues[0].code,
    "missing_column",
  );
});

test("preview is read-only and reports exact adds, hidden-on-create and untouched records", async () => {
  await withService(async ({ service, owner, count, database }) => {
    const before = snapshot(count);
    const preview = await service.preview(owner, { files: small() });
    assert.deepEqual(snapshot(count), before, "preview wrote nothing");
    assert.equal(preview.canCommit, true);
    assert.equal(preview.profiles.add, 2);
    assert.equal(preview.roles.add, 2);
    assert.equal(preview.sources.add, 1, "one source shared by two roles");
    assert.equal(preview.newProfilesHidden, 2);
    assert.ok(
      preview.rows
        .filter((r) => r.kind === "profile")
        .every((r) => r.visibility === "hidden_on_create"),
    );
    assert.equal(preview.untouchedProfiles, 1);
    assert.equal(preview.untouchedRoles, 1);
    assert.match(preview.digest, /^[0-9a-f]{64}$/);
    // The same files give the same digest.
    assert.equal(
      (await service.preview(owner, { files: small() })).digest,
      preview.digest,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) c FROM sync_batches").get().c,
      0,
    );
  });
});

test("commit is atomic, assigns Website IDs and creates every new Profile hidden in the same batch", async () => {
  await withService(async ({ service, owner, count, database }) => {
    const files = small();
    const { digest } = await service.preview(owner, { files });
    const receipt = await service.commit(owner, "key-commit-0001", {
      files,
      digest,
    });
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.replayed, false);
    assert.deepEqual(receipt.created, {
      profiles: 2,
      roles: 2,
      sources: 1,
      reusedSources: 0,
    });
    assert.equal(count("people"), 3);
    assert.equal(count("person_roles"), 3);
    assert.equal(count("sync_batches"), 1);
    const hidden = database
      .prepare(
        "SELECT person_id, visible, version FROM person_visibility ORDER BY person_id",
      )
      .all();
    assert.equal(hidden.length, 2);
    assert.ok(hidden.every((r) => r.visible === 0 && r.version === 1));
    assert.deepEqual(
      hidden.map((r) => r.person_id).sort(),
      receipt.createdProfiles.map((p) => p.profileId).sort(),
    );
    assert.ok(
      receipt.createdProfiles.every(
        (p) => p.profileId !== p.key && p.hidden === true,
      ),
      "Website assigns IDs",
    );
    // The shared service wrote its audit event and a per-item inverse for reversal.
    assert.equal(count("sync_batch_items"), 5);
    assert.ok(
      database
        .prepare(
          "SELECT COUNT(*) c FROM audit_events WHERE action = 'sync.batch.commit'",
        )
        .get().c >= 1,
    );
  });
});

test("a file with any blocking issue writes nothing, even beside valid rows", async () => {
  await withService(async ({ service, owner, count }) => {
    const files = {
      profile: csv([
        PROFILE_HEAD,
        ["P1", "Synthetic Alpha"],
        ["P2", "Synthetic Beta"],
      ]),
      // R2 names an unknown county, so the planner rejects the whole set.
      profileRole: csv([
        ROLE_HEAD,
        role("R1", "P1"),
        role("R2", "P2", "S2", { county: "08999" }),
      ]),
    };
    const preview = await service.preview(owner, { files });
    assert.equal(preview.canCommit, false);
    assert.ok(preview.issues.some((i) => i.code === "unknown_county"));
    const before = snapshot(count);
    await assert.rejects(
      () =>
        service.commit(owner, "key-blocked-001", {
          files,
          digest: preview.digest,
        }),
      ImportValidationError,
    );
    assert.deepEqual(snapshot(count), before);
  });
});

test("same-key retry replays the stored receipt and never applies twice", async () => {
  await withService(async ({ service, owner, count }) => {
    const files = small();
    const { digest } = await service.preview(owner, { files });
    const first = await service.commit(owner, "key-retry-00001", {
      files,
      digest,
    });
    const after = snapshot(count);
    const second = await service.commit(owner, "key-retry-00001", {
      files,
      digest,
    });
    assert.equal(second.replayed, true);
    assert.equal(second.batchId, first.batchId);
    assert.deepEqual(second.createdProfiles, first.createdProfiles);
    assert.deepEqual(snapshot(count), after);
    // The same key for a different reviewed import is refused.
    const other = small({ P1: "Synthetic Alpha", P2: "Synthetic Gamma" });
    const otherPreview = await service.preview(owner, { files: other });
    await assert.rejects(
      () =>
        service.commit(owner, "key-retry-00001", {
          files: other,
          digest: otherPreview.digest,
        }),
      ImportIdempotencyError,
    );
    assert.deepEqual(snapshot(count), after);
  });
});

test("a stale preview is refused when the Website or the files changed after review", async () => {
  await withService(async ({ service, owner, count, database }) => {
    const files = small();
    const reviewed = await service.preview(owner, { files });
    // Files edited after review.
    await assert.rejects(
      () =>
        service.commit(owner, "key-stale-00001", {
          files: small({ P1: "Synthetic Alpha", P2: "Synthetic Edited" }),
          digest: reviewed.digest,
        }),
      ImportStalePreviewError,
    );
    // Website changed after review: the source URL now exists with other metadata.
    database.exec(
      "INSERT INTO role_sources (id, url, title, source_type, publisher_classification) VALUES ('src-new', 'https://example.invalid/S1', 'Different title', 'official_page', 'official')",
    );
    const before = snapshot(count);
    await assert.rejects(
      () =>
        service.commit(owner, "key-stale-00002", {
          files,
          digest: reviewed.digest,
        }),
      ImportStalePreviewError,
    );
    assert.deepEqual(snapshot(count), before);
    // A fresh preview now shows the conflict as a blocking issue.
    const fresh = await service.preview(owner, { files });
    assert.equal(fresh.canCommit, false);
    assert.ok(fresh.issues.some((i) => i.code === "source_metadata_conflict"));
  });
});

test("a re-upload updates through stable IDs and field versions, and preserves everything else", async () => {
  await withService(async ({ service, profiles, owner, count, database }) => {
    const first = small();
    const p1 = await service.preview(owner, { files: first });
    await service.commit(owner, "key-first-00001", {
      files: first,
      digest: p1.digest,
    });
    const alphaId = idFor(database, "P1");
    const betaId = idFor(database, "P2");
    // The owner publishes Alpha and edits Beta's name in the sheet.
    await profiles.save(owner, "key-owner-pub-1", [
      {
        kind: "visibility",
        personId: alphaId,
        expectedVersion: 1,
        visible: true,
      },
    ]);
    const betaVersion = database
      .prepare("SELECT version v FROM people WHERE id = ?")
      .get(betaId).v;
    await profiles.save(owner, "key-owner-edit1", [
      {
        kind: "field",
        entity: "people",
        targetId: betaId,
        field: "display_name",
        expectedVersion: betaVersion,
        value: "Synthetic Beta Edited By Owner",
      },
    ]);
    // Second file renames Alpha, tries to rename Beta, and adds Gamma. Delta is absent.
    const second = {
      profile: csv([
        PROFILE_HEAD,
        ["P1", "Synthetic Alpha Renamed"],
        ["P2", "Synthetic Beta Renamed By File"],
        ["P3", "Synthetic Gamma"],
      ]),
      profileRole: csv([
        ROLE_HEAD,
        role("R1", "P1"),
        role("R2", "P2"),
        role("R3", "P3"),
      ]),
    };
    const preview = await service.preview(owner, { files: second });
    const byKey = Object.fromEntries(
      preview.rows.filter((r) => r.kind === "profile").map((r) => [r.key, r]),
    );
    assert.equal(byKey.P1.action, "update");
    assert.equal(
      byKey.P1.websiteId,
      alphaId,
      "matched by stable ID, not by name",
    );
    assert.equal(byKey.P1.visibility, "stays_visible");
    assert.equal(byKey.P2.action, "conflict", "owner edit is preserved");
    assert.equal(byKey.P3.action, "add");
    const before = snapshot(count);
    const receipt = await service.commit(owner, "key-second-0001", {
      files: second,
      digest: preview.digest,
    });
    assert.deepEqual(receipt.updated, { profiles: 1, roles: 0 });
    assert.equal(count("people"), before.people + 1);
    const name = (id) =>
      database.prepare("SELECT display_name n FROM people WHERE id = ?").get(id)
        .n;
    assert.equal(name(alphaId), "Synthetic Alpha Renamed");
    assert.equal(name(betaId), "Synthetic Beta Edited By Owner");
    assert.equal(name("person-keep"), "Synthetic Untouched Person");
    // Alpha stays published, Gamma is hidden.
    const vis = (id) =>
      database
        .prepare("SELECT visible v FROM person_visibility WHERE person_id = ?")
        .get(id)?.v;
    assert.equal(vis(alphaId), 1);
    assert.equal(vis(idFor(database, "P3")), 0);
    // Uploading the same file again changes nothing.
    const again = await service.preview(owner, { files: second });
    assert.equal(again.profiles.update, 0);
    assert.equal(again.profiles.add, 0);
  });
});

test("only a signed-in owner can preview, commit or reverse", async () => {
  await withService(async ({ service, owner, editor, count, principal }) => {
    const files = small();
    const { digest } = await service.preview(owner, { files });
    const before = snapshot(count);
    await assert.rejects(() => service.preview(editor, { files }));
    await assert.rejects(() =>
      service.commit(editor, "key-denied-0001", { files, digest }),
    );
    await assert.rejects(() =>
      service.reverse(editor, "batch", "key-denied-0002"),
    );
    const agent = { ...(await principal("owner")), kind: "agent" };
    await assert.rejects(() => service.preview(agent, { files }));
    assert.deepEqual(snapshot(count), before);
  });
});

test("HTTP routes need an owner session, the exact origin, JSON, a key and the reviewed digest", async () => {
  await withService(async ({ d1, principal, authorize, count }) => {
    const resolvePrincipalFor = async (request) => {
      const subject = request.headers.get("x-test-human-subject");
      return subject ? principal(subject) : null;
    };
    const transport = createProfilesApiTransport({
      resolvePrincipal: resolvePrincipalFor,
      authorize,
      service: createD1ProfilesService(d1, { authorize, now: NOW }),
      importService: createD1ProfilesImportService(d1, { authorize, now: NOW }),
    });
    const call = (
      path,
      {
        subject,
        body,
        headers = {},
        origin = ORIGIN,
        type = "application/json",
      } = {},
    ) =>
      transport.fetch(
        new Request(`${ORIGIN}/api/admin/profiles/import/${path}`, {
          method: "POST",
          headers: {
            "content-type": type,
            origin,
            ...(subject ? { "x-test-human-subject": subject } : {}),
            ...headers,
          },
          body: JSON.stringify(body ?? {}),
        }),
      );
    const files = small();
    const before = snapshot(count);
    assert.equal((await call("preview", { body: { files } })).status, 401);
    assert.equal(
      (await call("preview", { subject: "editor", body: { files } })).status,
      403,
    );
    assert.equal(
      (
        await call("preview", {
          subject: "owner",
          body: { files },
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("preview", {
          subject: "owner",
          body: { files },
          type: "text/plain",
        })
      ).status,
      415,
    );
    const ok = await call("preview", { subject: "owner", body: { files } });
    assert.equal(ok.status, 200);
    const preview = await ok.json();
    assert.equal(preview.canCommit, true);
    assert.equal(
      (
        await call("commit", {
          subject: "owner",
          body: { files, digest: preview.digest },
        })
      ).status,
      400,
      "key required",
    );
    assert.equal(
      (
        await call("commit", {
          subject: "owner",
          body: { files },
          headers: { "idempotency-key": "key-http-00001" },
        })
      ).status,
      400,
      "digest required",
    );
    assert.equal(
      (
        await call("commit", {
          subject: "editor",
          body: { files, digest: preview.digest },
          headers: { "idempotency-key": "key-http-00002" },
        })
      ).status,
      403,
    );
    assert.deepEqual(snapshot(count), before);
    const stale = await call("commit", {
      subject: "owner",
      body: { files, digest: "0".repeat(64) },
      headers: { "idempotency-key": "key-http-00003" },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "stale_preview");
    const done = await call("commit", {
      subject: "owner",
      body: { files, digest: preview.digest },
      headers: { "idempotency-key": "key-http-00004" },
    });
    assert.equal(done.status, 200);
    const receipt = await done.json();
    assert.equal(receipt.newProfilesHidden, 2);
    const reversed = await call("reverse", {
      subject: "owner",
      body: { batchId: receipt.batchId },
      headers: { "idempotency-key": "key-http-00005" },
    });
    assert.equal(reversed.status, 200);
    // Reversal keeps the batch history and removes only what the batch created.
    for (const table of [
      "people",
      "person_roles",
      "role_sources",
      "person_visibility",
    ])
      assert.equal(count(table), before[table], table);
  });
});

test("created Profiles are absent from every public read until explicitly published", async () => {
  await withService(async ({ service, profiles, owner, d1, database }) => {
    const files = small();
    const { digest } = await service.preview(owner, { files });
    await service.commit(owner, "key-public-0001", { files, digest });
    const alphaId = idFor(database, "P1");
    const runtimes = [
      ["SQL.js", createServices({ database })],
      ["D1", createD1PublicReadServices(d1)],
    ];
    for (const [label, services] of runtimes) {
      assert.equal(
        await services.getPersonProfile({ personId: alphaId, limit: 10 }),
        null,
        `${label} person page`,
      );
      assert.deepEqual(
        (await services.searchPeople({ query: "Synthetic Alpha" })).items,
        [],
        `${label} search`,
      );
      assert.equal(
        (await services.browsePeople({})).items.some((i) => i.id === alphaId),
        false,
        `${label} browse`,
      );
      const county = (
        await services.listCountyRoleEntries({ countyFips: "08001" })
      ).items;
      assert.equal(
        county.some(
          (i) => i.role.person_id === alphaId || i.person?.id === alphaId,
        ),
        false,
        `${label} county roles`,
      );
      // The pre-existing Profile stays public throughout.
      assert.ok(
        await services.getPersonProfile({ personId: "person-keep", limit: 10 }),
        `${label} existing profile`,
      );
    }
    await profiles.save(owner, "key-publish-001", [
      {
        kind: "visibility",
        personId: alphaId,
        expectedVersion: 1,
        visible: true,
      },
    ]);
    for (const [label, services] of runtimes)
      assert.ok(
        await services.getPersonProfile({ personId: alphaId, limit: 10 }),
        `${label} published`,
      );
  });
});

test("a role without its Profile or source is a missing dependency and blocks the commit", async () => {
  await withService(async ({ service, owner, count }) => {
    const noProfile = {
      profile: csv([PROFILE_HEAD, ["P1", "Synthetic Alpha"]]),
      profileRole: csv([ROLE_HEAD, role("R1", "P1"), role("R9", "P-MISSING")]),
    };
    const a = await service.preview(owner, { files: noProfile });
    assert.equal(a.canCommit, false);
    assert.ok(
      a.issues.some(
        (i) =>
          i.code === "missing_profile" &&
          i.key === "R9" &&
          i.file === "profile_role.csv",
      ),
    );
    assert.equal(a.roles.blocked, 1);
    const blankSource = ROLE_HEAD.map((h) =>
      h.startsWith("source_") && h !== "source_checked_at" ? "" : null,
    );
    const row = role("R2", "P1").map((value, i) =>
      blankSource[i] === "" ? "" : value,
    );
    const noSource = {
      profile: csv([PROFILE_HEAD, ["P1", "Synthetic Alpha"]]),
      profileRole: csv([ROLE_HEAD, row]),
    };
    const b = await service.preview(owner, { files: noSource });
    assert.equal(b.canCommit, false);
    assert.ok(b.issues.some((i) => i.code === "missing_source"));
    const before = snapshot(count);
    await assert.rejects(
      () =>
        service.commit(owner, "key-missing-0001", {
          files: noSource,
          digest: b.digest,
        }),
      ImportValidationError,
    );
    assert.deepEqual(snapshot(count), before);
  });
});

test("Adams-sized synthetic file previews and commits 262 Profiles and 413 roles hidden", async () => {
  await withService(async ({ service, owner, count, database }) => {
    const files = buildAdamsFixture();
    const preview = await service.preview(owner, { files });
    assert.equal(
      preview.canCommit,
      true,
      JSON.stringify(preview.issues.slice(0, 3)),
    );
    assert.equal(preview.profiles.add, 262);
    assert.equal(preview.roles.add, 413);
    assert.equal(preview.sources.add, 138);
    const receipt = await service.commit(owner, "key-adams-00001", {
      files,
      digest: preview.digest,
    });
    assert.equal(receipt.created.profiles, 262);
    assert.equal(receipt.created.roles, 413);
    assert.equal(count("person_visibility"), 262);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) c FROM person_visibility WHERE visible = 0")
        .get().c,
      262,
    );
    const again = await service.preview(owner, { files });
    assert.equal(again.profiles.unchanged, 262);
    assert.equal(again.profiles.add + again.roles.add + again.sources.add, 0);
  });
});

test("reversal removes the hidden Profiles it created and leaves the rest", async () => {
  await withService(async ({ service, owner, count }) => {
    const before = snapshot(count);
    const files = small();
    const { digest } = await service.preview(owner, { files });
    const receipt = await service.commit(owner, "key-reverse-001", {
      files,
      digest,
    });
    const reversal = await service.reverse(
      owner,
      receipt.batchId,
      "key-reverse-002",
    );
    assert.equal(reversal.status, "reverted");
    for (const table of [
      "people",
      "person_roles",
      "role_sources",
      "person_visibility",
    ])
      assert.equal(count(table), before[table], table);
    // The stable keys are free again, so the same file previews as adds.
    assert.equal((await service.preview(owner, { files })).profiles.add, 2);
  });
});

const unrelatedBatch = (changes) => ({
  contractVersion: "m2-sync/v1",
  requestId: crypto.randomUUID(),
  intent: "commit",
  changes,
});

test("stable mappings come only from live importer batches, never a reversed or unrelated one", async () => {
  await withService(async ({ service, owner, d1, database, count }) => {
    const files = small();
    const first = await service.preview(owner, { files });
    const r1 = await service.commit(owner, "key-map-0000001", {
      files,
      digest: first.digest,
    });
    const oldAlpha = idFor(database, "P1");
    assert.ok(oldAlpha);

    // An unrelated sync batch that borrows the importer's reference namespace.
    const other = await commitSyncChangesetD1(
      d1,
      owner,
      "other-client-key-1",
      unrelatedBatch([
        {
          op: "create_person",
          entity: "people",
          clientRef: "dash:profile:PX",
          fields: { display_name: "Synthetic Unrelated" },
        },
        {
          op: "update_record",
          entity: "people",
          targetId: oldAlpha,
          expectedVersion: 1,
          fields: { display_name: "Synthetic Alpha Moved By Other Client" },
        },
      ]),
      { authorize: async () => true },
    );
    assert.equal(other.status, "committed");
    const withPx = {
      profile: csv([
        PROFILE_HEAD,
        ["P1", "Synthetic Alpha"],
        ["P2", "Synthetic Beta"],
        ["PX", "Synthetic Unrelated"],
      ]),
      profileRole: small().profileRole,
    };
    const preview = await service.preview(owner, { files: withPx });
    const byKey = Object.fromEntries(
      preview.rows.filter((r) => r.kind === "profile").map((r) => [r.key, r]),
    );
    assert.equal(
      byKey.PX.action,
      "add",
      "an unrelated batch never supplies a mapping",
    );
    assert.equal(byKey.PX.websiteId, undefined);
    assert.equal(byKey.P1.websiteId, oldAlpha);
    assert.equal(
      byKey.P1.action,
      "conflict",
      "another client's edit counts as a change since the last import",
    );
    // The importer will not reverse a batch it did not commit.
    await assert.rejects(() =>
      service.reverse(owner, other.batchId, "key-rev-other-01"),
    );
    assert.equal(count("people"), 4);

    // Another client edited the Profile after the import, so the importer refuses to reverse it.
    await assert.rejects(() =>
      service.reverse(owner, r1.batchId, "key-rev-import-01"),
    );
  });
});

test("after a reversal the same keys preview as adds and the reversed IDs are never selected", async () => {
  await withService(async ({ service, owner, database, count }) => {
    const before = snapshot(count);
    const files = small();
    const first = await service.preview(owner, { files });
    const r1 = await service.commit(owner, "key-rev-000001", {
      files,
      digest: first.digest,
    });
    const reversedIds = new Set(r1.createdProfiles.map((p) => p.profileId));
    await service.reverse(owner, r1.batchId, "key-rev-000002");
    const again = await service.preview(owner, { files });
    assert.equal(again.profiles.add, 2);
    assert.equal(again.roles.add, 2);
    assert.equal(again.sources.add, 1);
    assert.equal(
      again.profiles.update +
        again.profiles.unchanged +
        again.profiles.conflict,
      0,
    );
    assert.ok(
      again.rows.every((r) => r.websiteId === undefined),
      "no reversed mapping is selected",
    );
    const r2 = await service.commit(owner, "key-rev-000003", {
      files,
      digest: again.digest,
    });
    assert.equal(r2.created.profiles, 2);
    for (const p of r2.createdProfiles)
      assert.equal(reversedIds.has(p.profileId), false, "new Website IDs");
    assert.equal(count("people"), before.people + 2);
    // Exactly one live mapping per key.
    const live = database
      .prepare(`SELECT i.client_ref ref, COUNT(*) n FROM sync_batch_items i
        LEFT JOIN sync_batch_reversals r ON r.batch_id = i.batch_id
        WHERE r.batch_id IS NULL AND i.client_ref LIKE 'dash:profile:%' GROUP BY i.client_ref`)
      .all();
    assert.deepEqual(
      live.map((r) => r.n),
      [1, 1],
    );
  });
});

/** Mirrors the reviewed follow-on shape: 5 Profiles, 7 roles, 1 shared source. */
const followOn = (sourceFields = {}) => {
  const src = {
    url: "https://example.invalid/shared-source",
    title: "Shared synthetic source",
    ...sourceFields,
  };
  const r = (id, profile, office) => [
    id,
    profile,
    "08001",
    office,
    "SHARED",
    src.url,
    src.title,
    "official",
    "official_page",
    "2026-11-01T00:00:00Z",
  ];
  return {
    profile: csv([
      PROFILE_HEAD,
      ["F1", "Synthetic Follow One"],
      ["F2", "Synthetic Follow Two"],
      ["F3", "Synthetic Follow Three"],
      ["F4", "Synthetic Follow Four"],
      ["F5", "Synthetic Follow Five"],
    ]),
    profileRole: csv([
      ROLE_HEAD,
      r("FR1", "F1", "Synthetic Office A"),
      r("FR2", "F1", "Synthetic Office B"),
      r("FR3", "F1", "Synthetic Office C"),
      r("FR4", "F2", "Synthetic Office D"),
      r("FR5", "F3", "Synthetic Office E"),
      r("FR6", "F4", "Synthetic Office F"),
      r("FR7", "F5", "Synthetic Office G"),
    ]),
  };
};

test("a follow-on batch keeps three distinct roles on one Profile, reuses the shared source and hides each Profile once", async () => {
  await withService(async ({ service, owner, database, count }) => {
    // Pilot batch first: 3 Profiles, 3 roles, the same shared source.
    const pilotRole = (id, profile) => [
      id,
      profile,
      "08001",
      `Synthetic Pilot Office ${id}`,
      "SHARED",
      "https://example.invalid/shared-source",
      "Shared synthetic source",
      "official",
      "official_page",
      "2026-11-01T00:00:00Z",
    ];
    const pilot = {
      profile: csv([
        PROFILE_HEAD,
        ["A1", "Synthetic Pilot One"],
        ["A2", "Synthetic Pilot Two"],
        ["A3", "Synthetic Pilot Three"],
      ]),
      profileRole: csv([
        ROLE_HEAD,
        pilotRole("AR1", "A1"),
        pilotRole("AR2", "A2"),
        pilotRole("AR3", "A3"),
      ]),
    };
    const p0 = await service.preview(owner, { files: pilot });
    const rp = await service.commit(owner, "key-pilot-00001", {
      files: pilot,
      digest: p0.digest,
    });
    assert.deepEqual(rp.created, {
      profiles: 3,
      roles: 3,
      sources: 1,
      reusedSources: 0,
    });
    const sourceCount = count("role_sources");
    const sharedId = database
      .prepare(
        "SELECT id FROM role_sources WHERE url = 'https://example.invalid/shared-source'",
      )
      .get().id;

    const files = followOn();
    const preview = await service.preview(owner, { files });
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    assert.equal(preview.profiles.add, 5);
    assert.equal(preview.roles.add, 7);
    assert.equal(preview.sources.add, 0);
    assert.equal(
      preview.sources.unchanged,
      1,
      "the existing shared source is reused",
    );
    assert.equal(preview.newProfilesHidden, 5);
    const receipt = await service.commit(owner, "key-follow-0001", {
      files,
      digest: preview.digest,
    });
    assert.deepEqual(receipt.created, {
      profiles: 5,
      roles: 7,
      sources: 0,
      reusedSources: 0,
    });
    assert.equal(count("role_sources"), sourceCount, "no second source row");
    const f1 = idFor(database, "F1");
    const f1Roles = database
      .prepare(
        "SELECT id, published_office o, source_id s FROM person_roles WHERE person_id = ? ORDER BY published_office",
      )
      .all(f1);
    assert.equal(f1Roles.length, 3);
    assert.equal(new Set(f1Roles.map((r) => r.id)).size, 3);
    assert.deepEqual(
      f1Roles.map((r) => r.o),
      ["Synthetic Office A", "Synthetic Office B", "Synthetic Office C"],
    );
    const followRoleSources = database
      .prepare(
        "SELECT DISTINCT source_id s FROM person_roles WHERE published_office LIKE 'Synthetic Office %'",
      )
      .all();
    assert.deepEqual(
      followRoleSources.map((r) => r.s),
      [sharedId],
    );
    // Visibility is applied once per new Profile: 3 pilot + 5 follow-on, one row each, all hidden at version 1.
    const vis = database
      .prepare("SELECT person_id, visible, version FROM person_visibility")
      .all();
    assert.equal(vis.length, 8);
    assert.equal(new Set(vis.map((v) => v.person_id)).size, 8);
    assert.ok(vis.every((v) => v.visible === 0 && v.version === 1));
    assert.equal(
      database
        .prepare("SELECT COUNT(*) c FROM person_visibility WHERE person_id = ?")
        .get(f1).c,
      1,
    );
    // Re-uploading the follow-on file changes nothing.
    const again = await service.preview(owner, { files });
    assert.equal(
      again.profiles.add +
        again.roles.add +
        again.profiles.update +
        again.roles.update,
      0,
    );
  });
});

test("a shared source that already exists on the Website but was never imported is reused, not duplicated", async () => {
  await withService(async ({ service, owner, count, database }) => {
    database.exec(
      "UPDATE role_sources SET publisher_classification = 'official', version = version + 1 WHERE id = 'src-keep'",
    );
    const existing = database
      .prepare(
        "SELECT url, title, source_type, publisher_classification FROM role_sources WHERE id = 'src-keep'",
      )
      .get();
    const row = (id, profile, office) => [
      id,
      profile,
      "08001",
      office,
      "KEEP",
      existing.url,
      existing.title,
      "official",
      existing.source_type,
      "2026-11-01T00:00:00Z",
    ];
    const files = {
      profile: csv([PROFILE_HEAD, ["F1", "Synthetic Follow One"]]),
      profileRole: csv([
        ROLE_HEAD,
        row("FR1", "F1", "Synthetic Office A"),
        row("FR2", "F1", "Synthetic Office B"),
        row("FR3", "F1", "Synthetic Office C"),
      ]),
    };
    const sources = count("role_sources");
    const preview = await service.preview(owner, { files });
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    const receipt = await service.commit(owner, "key-reuse-00001", {
      files,
      digest: preview.digest,
    });
    assert.equal(receipt.created.sources, 0);
    assert.equal(receipt.created.reusedSources, 1);
    assert.equal(count("role_sources"), sources);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) c FROM person_roles WHERE source_id = 'src-keep'",
        )
        .get().c,
      4,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) c FROM person_visibility").get().c,
      1,
    );
  });
});

test("an exact published_title with blank office and duties survives preview, commit and Position readback", async () => {
  await withService(async ({ service, owner, profiles, database }) => {
    const title = "Training, Records & Development Manager";
    const head = [
      "role_id",
      "profile_id",
      "county_fips",
      "published_title",
      "source_id",
      "source_url",
      "source_title",
      "publisher_classification",
      "source_type",
      "source_checked_at",
    ];
    const files = {
      profile: csv([PROFILE_HEAD, ["T1", "Synthetic Title Holder"]]),
      profileRole: csv([
        head,
        [
          "TR1",
          "T1",
          "08001",
          `"${title}"`,
          "TS1",
          "https://example.invalid/title-source",
          "Synthetic title source",
          "official",
          "official_page",
          "2026-11-01T00:00:00Z",
        ],
      ]),
    };
    const preview = await service.preview(owner, { files });
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    const row = preview.rows.find((r) => r.kind === "role");
    assert.equal(row.action, "add");
    assert.equal(row.label, title, "the preview shows the exact title");
    const receipt = await service.commit(owner, "key-title-000001", {
      files,
      digest: preview.digest,
    });
    assert.equal(receipt.created.roles, 1);
    const stored = database
      .prepare(
        `SELECT published_title t, published_office o, job_description d, position_id p
         FROM person_roles WHERE person_id = ?`,
      )
      .all(receipt.createdProfiles[0].profileId);
    assert.deepEqual(stored, [{ t: title, o: null, d: null, p: null }]);
    const listed = await profiles.listRows(owner, {
      query: "Synthetic Title Holder",
    });
    assert.equal(listed.total, 1);
    assert.equal(
      listed.rows[0].position,
      title,
      "the Position column shows the exact title",
    );
    assert.ok(!listed.rows[0].office, "no office is shown");
    // A re-upload with the identical title is unchanged.
    const again = await service.preview(owner, { files });
    assert.equal(again.roles.unchanged, 1);
    assert.equal(
      again.roles.add + again.roles.update + again.roles.conflict,
      0,
    );
  });
});

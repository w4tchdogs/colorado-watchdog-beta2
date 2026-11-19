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

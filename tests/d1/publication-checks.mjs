import { AsyncD1Database } from "../../src/database/d1.ts";
import { createD1ProfilesService } from "../../src/services/profiles-d1.ts";

/**
 * Profile publication rule over the real isolated local D1 (migration 0034):
 * the readiness view, refusal to publish an incomplete Profile, automatic
 * hiding when the last qualifying role is removed, a Profile with a second
 * qualifying role staying visible, and the rebuilt visibility table.
 */
export async function runPublicationChecks(env) {
  const checks = [];
  const check = (name, ok, detail = "") => {
    if (!ok) throw new Error(`${name} failed ${detail}`);
    checks.push(name);
  };
  const one = (sql, ...values) =>
    env.DB.prepare(sql)
      .bind(...values)
      .first();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES ('pub-owner', 'human', 'owner', 'Synthetic Publication Owner')",
    ),
    env.DB.prepare(
      "INSERT INTO role_sources (id, url, title, source_type) VALUES ('pub-src', 'https://example.invalid/pub', 'Synthetic', 'official_page')",
    ),
    env.DB.prepare(
      "INSERT INTO people (id, display_name) VALUES ('pub-multi', 'Synthetic Multi'), ('pub-solo', 'Synthetic Solo'), ('pub-draft', 'Synthetic Draft')",
    ),
    env.DB.prepare(
      `INSERT INTO person_roles (id, person_id, source_id, county_fips, published_title) VALUES
        ('pub-m1', 'pub-multi', 'pub-src', '08001', 'Synthetic One'),
        ('pub-m2', 'pub-multi', 'pub-src', '08001', 'Synthetic Two'),
        ('pub-s1', 'pub-solo', 'pub-src', '08001', 'Synthetic Solo Title')`,
    ),
  ]);
  const ready = await env.DB.prepare(
    "SELECT person_id FROM profile_publication_ready WHERE person_id LIKE 'pub-%' ORDER BY person_id",
  ).all();
  check(
    "the readiness view lists complete Profiles only",
    JSON.stringify(ready.results.map((r) => r.person_id)) ===
      JSON.stringify(["pub-multi", "pub-solo"]),
  );
  let refused = false;
  try {
    await env.DB.prepare(
      "INSERT INTO person_visibility (person_id, visible, changed_by_account_id) VALUES ('pub-draft', 1, 'pub-owner')",
    ).run();
  } catch {
    refused = true;
  }
  check("publishing an incomplete Profile is refused", refused);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM person_roles WHERE id = 'pub-m2'"),
    env.DB.prepare("DELETE FROM person_roles WHERE id = 'pub-s1'"),
  ]);
  const multi = await one(
    "SELECT COUNT(*) AS n FROM person_visibility WHERE person_id = 'pub-multi'",
  );
  check("a Profile with another qualifying role stays visible", multi?.n === 0);
  const solo = await one(
    "SELECT visible, hidden_reason, changed_by_account_id FROM person_visibility WHERE person_id = 'pub-solo'",
  );
  check(
    "losing the last qualifying role hides the Profile with a reason",
    solo?.visible === 0 &&
      solo?.hidden_reason === "incomplete" &&
      solo?.changed_by_account_id === null,
    JSON.stringify(solo),
  );
  await env.DB.prepare(
    "INSERT INTO person_roles (id, person_id, source_id, county_fips, published_title) VALUES ('pub-s2', 'pub-solo', 'pub-src', '08001', 'Synthetic Restored')",
  ).run();
  const still = await one(
    "SELECT visible FROM person_visibility WHERE person_id = 'pub-solo'",
  );
  check("restoring a role leaves the Profile hidden", still?.visible === 0);
  await env.DB.prepare(
    "UPDATE person_visibility SET visible = 1, version = version + 1, hidden_reason = NULL, changed_by_account_id = 'pub-owner' WHERE person_id = 'pub-solo'",
  ).run();
  const published = await one(
    "SELECT visible FROM person_visibility WHERE person_id = 'pub-solo'",
  );
  check("the owner can publish once it is complete", published?.visible === 1);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO identities (id, account_id, provider, subject)
      VALUES ('pub-identity', 'pub-owner', 'test-human', 'synthetic-publication-owner')`),
    env.DB.prepare(`INSERT INTO profile_names (id, person_id, name_type, published_name)
      VALUES ('pub-alt', 'pub-solo', 'nickname', 'Synthetic Alias')`),
    env.DB.prepare(`INSERT INTO profile_name_events (id, person_id, profile_name_id, action, actor_account_id)
      VALUES ('pub-history', 'pub-solo', 'pub-alt', 'alternate_add', 'pub-owner')`),
  ]);
  const profiles = createD1ProfilesService(new AsyncD1Database(env.DB), {
    authorize: async (principal) => principal.accountId === "pub-owner",
  });
  const owner = {
    kind: "human",
    role: "owner",
    accountId: "pub-owner",
    identityId: "pub-identity",
    provider: "test-human",
  };
  const preview = await profiles.previewDelete(owner, {
    profileId: "pub-solo",
  });
  check(
    "delete preview includes the role and alternate name",
    preview.visible && preview.counts.roles === 1 && preview.counts.names === 1,
  );
  const deletion = {
    profileId: preview.profileId,
    digest: preview.digest,
    reason: "incorrect",
    confirmation: "DELETE",
  };
  const deleted = await profiles.commitDelete(owner, "pub-delete-1", deletion);
  const replay = await profiles.commitDelete(owner, "pub-delete-1", deletion);
  check(
    "single Profile deletion commits once on D1",
    !deleted.replayed && replay.replayed,
  );
  const after = await one(`SELECT
    EXISTS(SELECT 1 FROM people WHERE id = 'pub-solo') AS person,
    EXISTS(SELECT 1 FROM person_roles WHERE person_id = 'pub-solo') AS role,
    EXISTS(SELECT 1 FROM person_visibility WHERE person_id = 'pub-solo') AS visibility,
    EXISTS(SELECT 1 FROM profile_names WHERE id = 'pub-alt') AS name,
    EXISTS(SELECT 1 FROM profile_name_events WHERE id = 'pub-history') AS history,
    EXISTS(SELECT 1 FROM person_roles WHERE person_id = 'pub-multi' AND source_id = 'pub-src') AS shared_source,
    (SELECT COUNT(*) FROM profile_deleted_targets WHERE profile_id = 'pub-solo') AS retired`);
  check(
    "deletion keeps audit history and the other Profile's source",
    after.person === 0 &&
      after.role === 0 &&
      after.visibility === 0 &&
      after.name === 0 &&
      after.history === 1 &&
      after.shared_source === 1 &&
      after.retired === 3,
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM person_roles WHERE person_id LIKE 'pub-%'"),
    env.DB.prepare(
      "DELETE FROM person_visibility WHERE person_id LIKE 'pub-%'",
    ),
    env.DB.prepare("DELETE FROM people WHERE id LIKE 'pub-%'"),
    env.DB.prepare("DELETE FROM role_sources WHERE id = 'pub-src'"),
  ]);
  return { checks };
}

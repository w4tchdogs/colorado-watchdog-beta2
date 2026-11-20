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
    env.DB.prepare("DELETE FROM person_roles WHERE person_id LIKE 'pub-%'"),
    env.DB.prepare(
      "DELETE FROM person_visibility WHERE person_id LIKE 'pub-%'",
    ),
    env.DB.prepare("DELETE FROM people WHERE id LIKE 'pub-%'"),
    env.DB.prepare("DELETE FROM role_sources WHERE id = 'pub-src'"),
  ]);
  return { checks };
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/write" && request.method === "POST") {
      const result = await env.DB.prepare(
        "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, ?, ?, ?) RETURNING id, role, version",
      )
        .bind("d1-durable-account", "human", "contributor", "Synthetic D1 User")
        .first();
      return json(result);
    }
    if (url.pathname === "/read") {
      return json(
        await env.DB.prepare(
          "SELECT id, role, version FROM accounts WHERE id = ?",
        )
          .bind("d1-durable-account")
          .first(),
      );
    }
    if (url.pathname !== "/verify") return json({ error: "not found" }, 404);

    const checks = [];
    const check = (name, passed) => {
      if (!passed) throw new Error(`D1 check failed: ${name}`);
      checks.push(name);
    };
    const history = await env.DB.prepare(
      "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
    ).all();
    check(
      "ordered custom migration history and checksums",
      history.results?.length === 9 &&
        history.results.every(
          (row, index) =>
            row.version === index + 1 &&
            row.name ===
              `000${index + 1}_${["counties", "foundation", "county_fips_prefix", "m1_county_roles", "m2_sync_batches", "m2_sync_reversals", "m2_duplicate_flags", "duplicate_flag_observations", "content_foundation"][index]}.sql` &&
            /^[0-9a-f]{64}$/.test(row.sha256),
        ),
    );
    const schemaObjects = await env.DB.prepare(
      "SELECT type, COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type",
    ).all();
    const counts = Object.fromEntries(
      schemaObjects.results.map((row) => [row.type, row.count]),
    );
    check(
      "migrated tables, indexes and triggers exist",
      counts.table >= 22 && counts.index >= 14 && counts.trigger >= 20,
    );
    const strictTables = await env.DB.prepare("PRAGMA table_list").all();
    check(
      "Website tables use STRICT mode",
      strictTables.results.some(
        (row) => row.name === "content_items" && row.strict === 1,
      ) &&
        strictTables.results.some(
          (row) =>
            row.name === "person_duplicate_flag_observations" &&
            row.strict === 1,
        ),
    );
    const backfill = await env.DB.prepare(
      "SELECT duplicate_flag_id, batch_id, actor_account_id, report_position, reason FROM person_duplicate_flag_observations WHERE id = ?",
    )
      .bind("legacy-observation:d1-backfill-flag")
      .first();
    check(
      "0008 legacy observation backfill",
      backfill?.duplicate_flag_id === "d1-backfill-flag" &&
        backfill.batch_id === "d1-backfill-batch" &&
        backfill.actor_account_id === "d1-backfill-actor" &&
        backfill.report_position === 0,
    );
    const content = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('content_items', 'content_item_counties', 'content_item_people', 'content_item_organizations')",
    ).first();
    const fkCheck = await env.DB.prepare("PRAGMA foreign_key_check").all();
    check("0009 content relationships", content.count === 4);
    check("foreign_key_check", fkCheck.results?.length === 0);

    const query = await env.DB.prepare(
      "SELECT ? AS label, json_valid(?) AS valid_json",
    )
      .bind("bound-value", '{"ok":true}')
      .all();
    check(
      "async prepared statement binding and all() result shape",
      query.success === true &&
        query.results?.[0]?.label === "bound-value" &&
        query.results[0].valid_json === 1,
    );
    const first = await env.DB.prepare("SELECT ? AS label")
      .bind("first-value")
      .first();
    check("first() row shape", first?.label === "first-value");

    let constraintRejected = false;
    try {
      await env.DB.prepare(
        "INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-invalid-json', 'human', 'contributor', 'Synthetic', '{')",
      ).run();
    } catch {
      constraintRejected = true;
    }
    check("JSON constraint rejection", constraintRejected);

    let foreignKeyRejected = false;
    try {
      await env.DB.prepare(
        "INSERT INTO identities (id, account_id, provider, subject) VALUES ('d1-orphan-identity', 'missing-account', 'test', 'subject')",
      ).run();
    } catch {
      foreignKeyRejected = true;
    }
    check("foreign-key rejection", foreignKeyRejected);

    const accountInsert = env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'human', 'contributor', 'Synthetic Batch Actor')",
    ).bind("d1-batch-rollback-account");
    const invalidInsert = env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-batch-invalid', 'invalid', 'contributor', 'Synthetic')",
    );
    let batchRejected = false;
    try {
      await env.DB.batch([accountInsert, invalidInsert]);
    } catch {
      batchRejected = true;
    }
    const rolledBack = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM accounts WHERE id = 'd1-batch-rollback-account'",
    ).first();
    check(
      "batch failure rolls back prior statement",
      batchRejected && rolledBack.count === 0,
    );

    await env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES ('d1-api-actor', 'human', 'contributor', 'Synthetic D1 API Actor')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO sync_batches (id, actor_account_id, idempotency_key, request_fingerprint, contract_version, request_id, status, committed_at, result_json) VALUES (?, ?, ?, ?, 'm2-sync/v1', ?, 'committed', ?, '{}')",
    )
      .bind(
        "d1-batch-actor",
        "d1-api-actor",
        "d1-unique-key",
        "a".repeat(64),
        "request-1",
        "2026-11-13T00:00:00.000Z",
      )
      .run();
    let duplicateRejected = false;
    try {
      await env.DB.prepare(
        "INSERT INTO sync_batches (id, actor_account_id, idempotency_key, request_fingerprint, contract_version, request_id, status, committed_at, result_json) VALUES ('d1-batch-actor-duplicate', 'd1-api-actor', 'd1-unique-key', ?, 'm2-sync/v1', 'request-2', 'committed', '2026-11-13T00:00:00.000Z', '{}')",
      )
        .bind("b".repeat(64))
        .run();
    } catch {
      duplicateRejected = true;
    }
    check("unique actor/idempotency-key enforcement", duplicateRejected);

    const versioned = await env.DB.prepare(
      "UPDATE accounts SET display_name = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version",
    )
      .bind("Synthetic D1 Updated", "d1-api-actor", 1)
      .first();
    const stale = await env.DB.prepare(
      "UPDATE accounts SET display_name = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version",
    )
      .bind("Stale Synthetic Update", "d1-api-actor", 1)
      .first();
    check("version-guarded update", versioned?.version === 2 && stale === null);

    return json({ success: true, checks });
  },
};

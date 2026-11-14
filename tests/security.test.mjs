import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createServices,
  createTestHumanIdentityAdapter,
} from "../dist/services/index.js";
import { hashCredential, resolvePrincipal } from "../dist/services/security.js";
import { createSitesIdentityAdapter } from "../dist/services/sites-identity.js";
import {
  createSyncAuthorization,
  syncCapabilityFor,
} from "../dist/services/sync-authorization.js";

async function createFixture() {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database
    .prepare(
      `INSERT INTO accounts (id, kind, role, display_name) VALUES
          ('synthetic-owner', 'human', 'owner', 'Synthetic Owner'),
          ('synthetic-admin', 'human', 'administrator', 'Synthetic Admin'),
          ('synthetic-editor', 'human', 'editor', 'Synthetic Editor'),
          ('synthetic-contributor', 'human', 'contributor', 'Synthetic Contributor')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO identities (id, account_id, provider, subject) VALUES
          ('identity-owner', 'synthetic-owner', 'test-human', 'subject-owner'),
          ('identity-admin', 'synthetic-admin', 'test-human', 'subject-admin'),
          ('identity-editor', 'synthetic-editor', 'test-human', 'subject-editor'),
          ('identity-contributor', 'synthetic-contributor', 'test-human', 'subject-contributor')`,
    )
    .run();

  let now = new Date();
  const services = createServices({
    database,
    humanIdentityAdapter: createTestHumanIdentityAdapter({
      "owner-login": "subject-owner",
      "admin-login": "subject-admin",
      "editor-login": "subject-editor",
      "contributor-login": "subject-contributor",
    }),
    now: () => now,
  });
  const principalFor = async (login) =>
    services.resolvePrincipal(
      new Request("https://watchdog.test/", {
        headers: { "x-test-human-subject": login },
      }),
    );
  return {
    database,
    services,
    principalFor,
    setNow(value) {
      now = value;
    },
    async close() {
      database.close();
    },
  };
}

test("human sign-in resolves one account and capability checks deny unknown and prune", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const admin = await fixture.principalFor("admin-login");
    const contributor = await fixture.principalFor("contributor-login");

    assert.equal(owner.accountId, "synthetic-owner");
    assert.equal(
      fixture.services.hasCapability(owner, "checkpoint.create"),
      true,
    );
    assert.equal(
      fixture.services.hasCapability(
        {
          accountId: owner.accountId,
          kind: "human",
          role: "owner",
          provider: "test-human",
        },
        "account.create",
      ),
      false,
    );
    assert.equal(
      fixture.services.hasCapability(admin, "checkpoint.verify"),
      true,
    );
    assert.equal(
      fixture.services.hasCapability(contributor, "account.create"),
      false,
    );
    assert.equal(
      fixture.services.getAccount(owner, "synthetic-contributor").role,
      "contributor",
    );
    assert.throws(
      () => fixture.services.getAccount(contributor, "synthetic-owner"),
      { name: "AuthorizationError" },
    );
    for (const principal of [owner, admin, contributor]) {
      assert.equal(
        fixture.services.hasCapability(principal, "checkpoint.prune"),
        false,
      );
      assert.equal(
        fixture.services.hasCapability(principal, "not.a.capability"),
        false,
      );
    }

    assert.equal(
      await fixture.services.resolvePrincipal(
        new Request("https://watchdog.test/", {
          headers: {
            authorization: "Bearer malformed",
            "x-test-human-subject": "owner-login",
          },
        }),
      ),
      null,
    );
  } finally {
    await fixture.close();
  }
});

test("report review is explicitly granted only to editor, administrator, and owner", async () => {
  const fixture = await createFixture();
  try {
    const principals = await Promise.all([
      fixture.principalFor("contributor-login"),
      fixture.principalFor("editor-login"),
      fixture.principalFor("admin-login"),
      fixture.principalFor("owner-login"),
    ]);
    assert.deepEqual(
      principals.map((principal) =>
        fixture.services.hasCapability(principal, "report.review"),
      ),
      [false, true, true, true],
    );
  } finally {
    await fixture.close();
  }
});

test("sync capabilities are separated and default-deny current principals", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.exec(`
      INSERT INTO accounts (id, kind, role, display_name)
      VALUES ('synthetic-agent', 'agent', 'administrator', 'Synthetic Agent');
      INSERT INTO identities (id, account_id, provider, subject)
      VALUES ('identity-agent', 'synthetic-agent', 'test-human', 'subject-agent');
    `);
    const agentAdapter = createTestHumanIdentityAdapter({
      agent: "subject-agent",
    });
    const agent = await resolvePrincipal(
      fixture.database,
      new Request("https://watchdog.test/", {
        headers: { "x-test-human-subject": "agent" },
      }),
      agentAdapter,
    );
    const principals = [
      await fixture.principalFor("owner-login"),
      await fixture.principalFor("admin-login"),
      await fixture.principalFor("contributor-login"),
      agent,
    ];
    const authorize = createSyncAuthorization(fixture.database);
    const operations = ["dry_run", "lookup", "commit", "reverse"];

    assert.deepEqual(
      operations.map((operation) => syncCapabilityFor(operation)),
      ["sync.read", "sync.read", "sync.apply", "sync.revert"],
    );
    for (const principal of principals) {
      for (const operation of operations) {
        assert.equal(authorize(principal, operation), false);
      }
    }

    const cachedOwner = principals[0];
    fixture.database
      .prepare(
        "UPDATE identities SET revoked_at = '2026-11-13T00:00:00Z', version = version + 1 WHERE id = ?",
      )
      .run(cachedOwner.identityId);
    assert.equal(
      fixture.services.hasCapability(cachedOwner, "sync.read"),
      false,
    );

    const cachedAdmin = principals[1];
    fixture.database
      .prepare(
        "UPDATE identities SET expires_at = '2000-01-01T00:00:00Z', version = version + 1 WHERE id = ?",
      )
      .run(cachedAdmin.identityId);
    assert.equal(
      fixture.services.hasCapability(cachedAdmin, "sync.apply"),
      false,
    );

    const cachedContributor = principals[2];
    fixture.database
      .prepare(
        "UPDATE accounts SET role = 'administrator', version = version + 1 WHERE id = ?",
      )
      .run(cachedContributor.accountId);
    assert.equal(
      fixture.services.hasCapability(cachedContributor, "sync.read"),
      false,
    );
    assert.equal(authorize(cachedContributor, "lookup"), false);
  } finally {
    await fixture.close();
  }
});

test("agent credentials are hashed, expire, and revoke with a versioned audit", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const agent = fixture.services.createAccount(owner, {
      kind: "agent",
      role: "contributor",
      displayName: "Synthetic Assistant",
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const issued = await fixture.services.issueAgentCredential(
      owner,
      agent.id,
      expiresAt,
    );
    assert.match(issued.secret, /^cwa_[A-Za-z0-9_-]{43}$/);
    assert.equal(
      fixture.database
        .prepare("SELECT credential_hash FROM identities WHERE id = ?")
        .get(issued.identityId).credential_hash.length,
      64,
    );
    assert.equal(
      fixture.database
        .prepare("SELECT subject FROM identities WHERE id = ?")
        .get(issued.identityId).subject,
      issued.identityId,
    );
    assert.equal(
      JSON.stringify(fixture.services.listAuditEvents(owner)).includes(
        issued.secret,
      ),
      false,
    );
    assert.throws(
      () => fixture.services.createOperation(owner, issued.secret),
      /Audit data cannot contain credentials/,
    );
    assert.equal(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM operations").get()
        .count,
      0,
    );

    const agentPrincipal = await fixture.services.resolvePrincipal(
      new Request("https://watchdog.test/", {
        headers: { authorization: `Bearer ${issued.secret}` },
      }),
    );
    assert.equal(agentPrincipal.accountId, agent.id);
    assert.equal(
      fixture.services.hasCapability(agentPrincipal, "checkpoint.prune"),
      false,
    );

    fixture.setNow(new Date(Date.parse(expiresAt) + 1));
    assert.equal(
      await fixture.services.resolvePrincipal(
        new Request("https://watchdog.test/", {
          headers: { authorization: `Bearer ${issued.secret}` },
        }),
      ),
      null,
    );

    fixture.services.revokeIdentity(owner, issued.identityId, 1);
    assert.equal(
      fixture.database
        .prepare("SELECT version FROM identities WHERE id = ?")
        .get(issued.identityId).version,
      2,
    );
    const audit = fixture.services
      .listAuditEvents(owner)
      .filter((event) => event.target_id === issued.identityId);
    assert.deepEqual(audit.map((event) => event.action).sort(), [
      "identity.agent_key.issue",
      "identity.revoke",
    ]);
    assert.equal(JSON.stringify(audit).includes(issued.secret), false);
  } finally {
    await fixture.close();
  }
});

test("human sign-in identities can be linked without storing credential material", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const account = fixture.services.createAccount(owner, {
      kind: "human",
      role: "administrator",
      displayName: "Synthetic Linked Human",
      email: "synthetic@example.test",
    });
    const identityId = fixture.services.createHumanIdentity(
      owner,
      account.id,
      "test-human",
      "linked-subject",
    );
    const identity = fixture.database
      .prepare(
        "SELECT provider, subject, credential_hash FROM identities WHERE id = ?",
      )
      .get(identityId);
    assert.deepEqual(identity, {
      provider: "test-human",
      subject: "linked-subject",
      credential_hash: null,
    });
    assert.equal(
      fixture.services
        .listAuditEvents(owner)
        .filter((event) => event.target_id === identityId).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("account role changes are versioned and audited in the attributed operation", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const operationId = fixture.services.createOperation(
      owner,
      "account.maintenance",
      "synthetic-operation",
    );
    const account = fixture.services.createAccount(
      owner,
      {
        kind: "agent",
        role: "contributor",
        displayName: "Synthetic Role Test",
      },
      operationId,
    );
    assert.equal(
      fixture.services.changeAccountRole(
        owner,
        account.id,
        account.version,
        "administrator",
        operationId,
      ),
      2,
    );
    const events = fixture.services
      .listAuditEvents(owner)
      .filter((event) => event.operation_id === operationId);
    assert.deepEqual(events.map((event) => event.action).sort(), [
      "account.create",
      "account.role.change",
      "operation.create",
    ]);
    assert.ok(
      events.every((event) => event.actor_account_id === owner.accountId),
    );
    assert.equal(
      fixture.services.hasCapability(
        await fixture.principalFor("admin-login"),
        "checkpoint.read",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("audit failure rolls back the account mutation and denied role promotion changes nothing", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const admin = await fixture.principalFor("admin-login");
    const accountCount = fixture.database
      .prepare("SELECT COUNT(*) AS count FROM accounts")
      .get().count;
    assert.throws(() =>
      fixture.services.createAccount(
        owner,
        {
          kind: "agent",
          role: "contributor",
          displayName: "Rolled Back Account",
        },
        "missing-operation",
      ),
    );
    assert.equal(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM accounts").get()
        .count,
      accountCount,
    );
    assert.throws(
      () =>
        fixture.services.changeAccountRole(
          admin,
          "synthetic-contributor",
          1,
          "administrator",
        ),
      { name: "AuthorizationError" },
    );
    assert.equal(
      fixture.database
        .prepare("SELECT role, version FROM accounts WHERE id = ?")
        .get("synthetic-contributor").role,
      "contributor",
    );
  } finally {
    await fixture.close();
  }
});

test("HTTP account creation uses the authenticated principal and request body", async () => {
  const fixture = await createFixture();
  try {
    const application = createApplication(fixture.services);
    const response = await application.fetch(
      new Request("https://watchdog.test/api/accounts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-human-subject": "admin-login",
        },
        body: JSON.stringify({
          kind: "agent",
          role: "contributor",
          displayName: "Synthetic HTTP Agent",
        }),
      }),
    );
    assert.equal(response.status, 201);
    const account = await response.json();
    assert.equal(account.kind, "agent");
    assert.equal(account.role, "contributor");
    assert.equal(account.displayName, "Synthetic HTTP Agent");
  } finally {
    await fixture.close();
  }
});

test("unexpected HTTP errors are sanitized instead of exposing credentials", async () => {
  const fixture = await createFixture();
  try {
    const application = createApplication({
      ...fixture.services,
      async resolvePrincipal() {
        throw new Error("cwa_sensitive_synthetic_secret");
      },
    });
    const response = await application.fetch(
      new Request("https://watchdog.test/_internal/principal"),
    );
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "internal_error" });
    assert.equal(body.includes("cwa_sensitive"), false);
  } finally {
    await fixture.close();
  }
});

test("account administration is bounded, redacts credential hashes, and rejects unauthorized pages", async () => {
  const fixture = await createFixture();
  try {
    const app = createApplication(fixture.services);
    const denied = await app.fetch(
      new Request("https://watchdog.test/admin/accounts"),
    );
    assert.equal(denied.status, 401);
    const adminPage = await app.fetch(
      new Request("https://watchdog.test/admin/accounts", {
        headers: { "x-test-human-subject": "admin-login" },
      }),
    );
    assert.equal(adminPage.status, 200);
    const admin = await fixture.principalFor("admin-login");
    const agent = fixture.services.createAccount(admin, {
      kind: "agent",
      role: "contributor",
      displayName: "Synthetic list agent",
    });
    const credential = await fixture.services.issueAgentCredential(
      admin,
      agent.id,
    );
    const details = await app.fetch(
      new Request(`https://watchdog.test/api/admin/accounts/${agent.id}`, {
        headers: { "x-test-human-subject": "admin-login" },
      }),
    );
    assert.equal(details.status, 200);
    const text = await details.text();
    assert.equal(text.includes(credential.secret), false);
    assert.equal(text.includes("credential_hash"), false);
    assert.equal(text.includes(await hashCredential(credential.secret)), false);
    const auditResponse = await app.fetch(
      new Request(
        `https://watchdog.test/api/admin/accounts/${agent.id}/audit`,
        {
          headers: { "x-test-human-subject": "admin-login" },
        },
      ),
    );
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.ok(
      audit.events.some((event) => event.action === "identity.agent_key.issue"),
    );
    assert.ok(
      audit.events.every((event) => event.actorAccountId === "synthetic-admin"),
    );
    const listed = await app.fetch(
      new Request(
        "https://watchdog.test/api/admin/accounts?kind=agent&limit=1",
        { headers: { "x-test-human-subject": "admin-login" } },
      ),
    );
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).accounts.length, 1);
    const contributor = await app.fetch(
      new Request("https://watchdog.test/admin/accounts", {
        headers: { "x-test-human-subject": "contributor-login" },
      }),
    );
    assert.equal(contributor.status, 403);
    const badOrigin = await app.fetch(
      new Request(`https://watchdog.test/api/admin/accounts/${agent.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
          "x-test-human-subject": "admin-login",
        },
        body: JSON.stringify({ expectedVersion: 1, status: "disabled" }),
      }),
    );
    assert.equal(badOrigin.status, 403);
  } finally {
    await fixture.close();
  }
});

test("Sites identity adapter trusts only a verified host context and fails closed", async () => {
  const request = new Request("https://watchdog.test/", {
    headers: {
      "oai-authenticated-user-id": "forged-user",
      "x-oai-authenticated-user-id": "forged-user",
    },
  });
  assert.equal(
    await createSitesIdentityAdapter({ siteId: "site-alpha" }).resolve(request),
    null,
  );
  assert.equal(
    await createSitesIdentityAdapter({
      siteId: "site-alpha",
      context: async () => null,
    }).resolve(request),
    null,
  );
  const claim = {
    userId: "verified-synthetic-user",
    email: "one@example.test",
    fullName: "Synthetic One",
  };
  const alpha = createSitesIdentityAdapter({
    siteId: "site-alpha",
    context: async () => claim,
  });
  const beta = createSitesIdentityAdapter({
    siteId: "site-beta",
    context: async () => claim,
  });
  assert.deepEqual(await alpha.resolve(request), {
    provider: "chatgpt-sites:site-alpha",
    subject: "verified-synthetic-user",
    email: "one@example.test",
    displayName: "Synthetic One",
  });
  assert.equal(
    (await beta.resolve(request)).provider,
    "chatgpt-sites:site-beta",
  );
  assert.equal(
    (await alpha.resolve(request)).subject,
    "verified-synthetic-user",
  );
  assert.equal(
    (
      await createSitesIdentityAdapter({
        siteId: "site-alpha",
        context: async () => ({
          userId: "verified-synthetic-user",
          email: "two@example.test",
        }),
      }).resolve(request)
    ).subject,
    "verified-synthetic-user",
  );
  assert.equal(
    await createSitesIdentityAdapter({
      siteId: "site-alpha",
      context: async () => ({ userId: "", email: "two@example.test" }),
    }).resolve(request),
    null,
  );
  assert.equal(
    await createSitesIdentityAdapter({
      siteId: "site-alpha",
      context: async () => ({ userId: "verified-synthetic-user", email: "" }),
    }).resolve(request),
    null,
  );
  assert.throws(() => createSitesIdentityAdapter({ siteId: "" }), TypeError);
});

test("Sites stable subject ignores metadata for authorization and enforces account state", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const contributor = fixture.database
      .prepare("SELECT * FROM accounts WHERE id = 'synthetic-contributor'")
      .get();
    fixture.database
      .prepare(
        "INSERT INTO identities (id, account_id, provider, subject) VALUES ('site-contributor', ?, 'chatgpt-sites:synthetic-site', 'stable-user-1')",
      )
      .run(contributor.id);
    assert.throws(
      () =>
        fixture.services.createHumanIdentity(
          owner,
          "synthetic-owner",
          "chatgpt-sites:synthetic-site",
          "stable-user-1",
        ),
      { name: "InvalidInputError" },
    );
    let identity = {
      userId: "stable-user-1",
      email: "admin@example.test",
      fullName: "Site Admin",
    };
    const adapter = createSitesIdentityAdapter({
      siteId: "synthetic-site",
      context: async () => identity,
    });
    const request = new Request("https://watchdog.test/");
    let principal = await resolvePrincipal(fixture.database, request, adapter);
    assert.equal(principal.accountId, "synthetic-contributor");
    assert.equal(principal.role, "contributor");
    assert.throws(
      () =>
        fixture.services.changeAccountRole(
          principal,
          principal.accountId,
          contributor.version,
          "administrator",
        ),
      { name: "AuthorizationError" },
    );
    identity = {
      userId: "stable-user-1",
      email: "changed@example.test",
      fullName: "Changed Name",
    };
    principal = await resolvePrincipal(fixture.database, request, adapter);
    assert.equal(principal.accountId, "synthetic-contributor");
    fixture.database
      .prepare(
        "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = ?",
      )
      .run(contributor.id);
    assert.equal(
      await resolvePrincipal(fixture.database, request, adapter),
      null,
    );
  } finally {
    await fixture.close();
  }
});

test("owner safeguards, identity collisions, and stale account versions fail safely", async () => {
  const fixture = await createFixture();
  try {
    const owner = await fixture.principalFor("owner-login");
    const agent = fixture.services.createAccount(owner, {
      kind: "agent",
      role: "contributor",
      displayName: "Synthetic Owner Guard Agent",
    });
    assert.throws(
      () =>
        fixture.services.changeAccountRole(
          owner,
          agent.id,
          agent.version,
          "owner",
        ),
      { name: "InvalidInputError" },
    );
    assert.throws(
      () =>
        fixture.services.updateAccount(owner, owner.accountId, 1, {
          status: "disabled",
        }),
      { name: "InvalidInputError" },
    );
    assert.throws(
      () => fixture.services.revokeIdentity(owner, "identity-owner", 1),
      { name: "InvalidInputError" },
    );
    assert.throws(
      () => fixture.services.changeAccountRole(owner, agent.id, 77, "editor"),
      { name: "StaleVersionError" },
    );
    assert.throws(
      () =>
        fixture.services.createAccount(owner, {
          kind: "agent",
          role: "owner",
          displayName: "Invalid agent owner",
        }),
      { name: "InvalidInputError" },
    );
    const human = fixture.services.createAccount(owner, {
      kind: "human",
      role: "contributor",
      displayName: "Synthetic collision target",
    });
    assert.throws(
      () =>
        fixture.services.createHumanIdentity(
          owner,
          human.id,
          "test-human",
          "subject-owner",
        ),
      { name: "InvalidInputError" },
    );
    const account = fixture.services.getAccount(owner, agent.id);
    assert.equal(account.role, "contributor");
    assert.equal(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM identities WHERE provider = 'test-human' AND subject = 'subject-owner'",
        )
        .get().count,
      1,
    );
  } finally {
    await fixture.close();
  }
});

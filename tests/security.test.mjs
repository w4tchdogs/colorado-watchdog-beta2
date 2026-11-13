import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import {
  createServices,
  createTestHumanIdentityAdapter,
} from "../dist/services/index.js";

async function createFixture() {
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  database
    .prepare(
      `INSERT INTO accounts (id, kind, role, display_name) VALUES
         ('synthetic-owner', 'human', 'owner', 'Synthetic Owner'),
         ('synthetic-admin', 'human', 'administrator', 'Synthetic Admin'),
         ('synthetic-contributor', 'human', 'contributor', 'Synthetic Contributor')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO identities (id, account_id, provider, subject) VALUES
         ('identity-owner', 'synthetic-owner', 'test-human', 'subject-owner'),
         ('identity-admin', 'synthetic-admin', 'test-human', 'subject-admin'),
         ('identity-contributor', 'synthetic-contributor', 'test-human', 'subject-contributor')`,
    )
    .run();

  let now = new Date();
  const services = createServices({
    database,
    humanIdentityAdapter: createTestHumanIdentityAdapter({
      "owner-login": "subject-owner",
      "admin-login": "subject-admin",
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

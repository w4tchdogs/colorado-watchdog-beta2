import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { AsyncD1Database } from "../dist/database/d1.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";

export const ORIGIN = "https://watchdog.example.test";
export const CLIENT_ID = "synthetic-client-id";
export const CLIENT_SECRET = "synthetic-client-secret-0001";
export const SESSION_COOKIE = "__Host-wd-session";
export const LOGIN_COOKIE = "__Host-wd-login";

let tenantCounter = 0;

export const base64Url = (input) =>
  Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function newKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    jwk: { ...jwk, kid, use: "sig", alg: "RS256" },
  };
}

/**
 * Builds a compact JWT from raw JSON text, so tests can include duplicate
 * members and other shapes a library would refuse to produce.
 */
export function compactJwt({ headerJson, claimsJson, key, signWith }) {
  const signingInput = `${base64Url(headerJson)}.${base64Url(claimsJson)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign((signWith ?? key).privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

export function idToken(world, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: world.issuer,
    aud: CLIENT_ID,
    sub: overrides.sub,
    nonce: overrides.nonce,
    iat: now,
    exp: now + 600,
    ...overrides.claims,
  };
  for (const name of overrides.remove ?? []) delete claims[name];
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: (overrides.key ?? world.key).kid,
    ...overrides.header,
  };
  return compactJwt({
    headerJson: overrides.headerJson ?? JSON.stringify(header),
    claimsJson: overrides.claimsJson ?? JSON.stringify(claims),
    key: overrides.key ?? world.key,
    signWith: overrides.signWith,
  });
}

/** Local D1 binding over the sql.js Website database. */
export function createD1(database) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...parameters) {
          values = parameters;
          return statement;
        },
        async first() {
          return database.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: database.prepare(sql).all(...values),
          };
        },
        async run() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
        runSync() {
          database.prepare(sql).run(...values);
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements) {
      return database.transaction(() =>
        statements.map((statement) => statement.runSync()),
      )();
    },
  };
}

/**
 * A synthetic world: a migrated Website database, one fictional tenant with
 * a signing key, and a fake upstream that answers token and key requests.
 */
export async function createWorld(options = {}) {
  tenantCounter += 1;
  const database = await openWebsiteDatabase();
  migrateWebsiteDatabase(database);
  const issuer = `https://tenant-${tenantCounter}.example.test/`;
  const provider = `auth0:${issuer}`;
  const world = {
    database,
    d1: createD1(database),
    asyncD1: new AsyncD1Database(createD1(database)),
    issuer,
    provider,
    key: options.key ?? newKey(`kid-${tenantCounter}`),
    keys: undefined,
    codes: new Map(),
    upstreamLog: [],
    tokenBehavior: null,
    jwksBehavior: null,
    env: {},
  };
  world.keys = [world.key];
  world.env = {
    AUTH0_ENABLED: "true",
    AUTH0_ISSUER: issuer,
    AUTH0_CLIENT_ID: CLIENT_ID,
    AUTH0_CLIENT_SECRET: CLIENT_SECRET,
    AUTH0_CANONICAL_ORIGIN: ORIGIN,
    AUTH0_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    DB: world.d1,
  };
  if (options.seed !== false) seedAccounts(world);
  return world;
}

export function seedAccounts(world) {
  const { database, provider } = world;
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name) VALUES
      ('h-owner', 'human', 'owner', 'Synthetic Owner'),
      ('h-admin', 'human', 'administrator', 'Synthetic Administrator'),
      ('h-editor', 'human', 'editor', 'Synthetic <Editor> & Co'),
      ('h-contributor', 'human', 'contributor', 'Synthetic Contributor'),
      ('h-agent-kind', 'agent', 'editor', 'Synthetic Agent Holding Human Link');
    INSERT INTO accounts (id, kind, role, display_name, status) VALUES
      ('h-disabled', 'human', 'editor', 'Synthetic Disabled Human', 'disabled');
    INSERT INTO identities (id, account_id, provider, subject, expires_at, revoked_at) VALUES
      ('i-owner', 'h-owner', '${provider}', 'github|synthetic-owner', NULL, NULL),
      ('i-admin', 'h-admin', '${provider}', 'github|synthetic-admin', NULL, NULL),
      ('i-editor', 'h-editor', '${provider}', 'github|synthetic-editor', NULL, NULL),
      ('i-contributor', 'h-contributor', '${provider}', 'github|synthetic-contributor', NULL, NULL),
      ('i-disabled', 'h-disabled', '${provider}', 'github|synthetic-disabled', NULL, NULL),
      ('i-agent-kind', 'h-agent-kind', '${provider}', 'github|synthetic-agent-kind', NULL, NULL),
      ('i-expired', 'h-editor', '${provider}', 'github|synthetic-expired', '2000-01-01T00:00:00.000Z', NULL),
      ('i-revoked', 'h-editor', '${provider}', 'github|synthetic-revoked', NULL, '2026-11-13T00:00:00.000Z'),
      ('i-other-tenant', 'h-editor', 'auth0:https://other-tenant.example.test/', 'github|synthetic-editor', NULL, NULL);
  `);
}

export function count(world, table, where = "1 = 1") {
  return world.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get().count;
}

export function snapshotCounts(world) {
  return {
    accounts: count(world, "accounts"),
    identities: count(world, "identities"),
    sessions: count(world, "auth_sessions"),
    audit: count(world, "audit_events"),
  };
}

/**
 * Installs a fake global fetch for the world's tenant. Token requests are
 * answered from `world.codes`, key requests from `world.keys`. Behaviors let a
 * test replace either response.
 */
export function installUpstream(world) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    world.upstreamLog.push({
      url,
      method: init.method ?? "GET",
      redirect: init.redirect,
      hasSignal: init.signal instanceof AbortSignal,
      body: init.body,
    });
    if (url === `${world.issuer}oauth/token`) {
      if (world.tokenBehavior) return world.tokenBehavior(init);
      const body = JSON.parse(String(init.body));
      const entry = world.codes.get(body.code);
      if (!entry || entry.used) return Response.json({}, { status: 403 });
      entry.used = true;
      entry.request = body;
      return Response.json({
        access_token: "synthetic-access-token",
        id_token: entry.idToken(),
        token_type: "Bearer",
      });
    }
    if (url === `${world.issuer}.well-known/jwks.json`) {
      if (world.jwksBehavior) return world.jwksBehavior();
      return Response.json({ keys: world.keys.map((key) => key.jwk) });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

export function cookieJar() {
  const cookies = new Map();
  return {
    cookies,
    absorb(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line
          .split(";")
          .map((part) => part.trim());
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        const maxAge = attributes.find((a) => /^max-age=/i.test(a));
        if (value === "" || maxAge?.toLowerCase() === "max-age=0")
          cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}

export function request(_world, path, options = {}) {
  const { method = "GET", origin = ORIGIN, headers = {}, body } = options;
  return new Request(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: "manual",
  });
}

export function parseSetCookie(line) {
  const [pair, ...attributes] = line.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    attributes: attributes.map((attribute) => attribute.toLowerCase()),
  };
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker, { verifyIdToken } from "../worker.mjs";

const issuer = "https://synthetic-tenant.example/";
const env = { AUTH0_ENABLED:"true", AUTH0_ISSUER:issuer, AUTH0_CLIENT_ID:"synthetic-client", AUTH0_CLIENT_SECRET:"synthetic-secret", AUTH0_REDIRECT_URI:"https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site/auth/callback", PILOT_ORIGIN:"ignored" };
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const signingPair = await crypto.subtle.generateKey({ name:"RSASSA-PKCS1-v1_5", modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256" },true,["sign","verify"]);
const signingJwk = await crypto.subtle.exportKey("jwk", signingPair.publicKey);
signingJwk.kid = crypto.randomUUID(); signingJwk.alg = "RS256"; signingJwk.use = "sig";
async function signedToken(claimOverrides = {}, headerOverrides = {}) {
  globalThis.syntheticJwk = signingJwk;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys:[signingJwk] }),{headers:{"content-type":"application/json"}});
  const head = b64({ alg:"RS256", kid:signingJwk.kid, ...headerOverrides });
  const now = Math.floor(Date.now()/1000);
  const claims = b64({ iss:issuer, aud:"synthetic-client", sub:"github|synthetic-123", nonce:"nonce-1", exp:now+600, iat:now, ...claimOverrides });
  const input = `${head}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingPair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

test("valid Auth0 RS256 issuer, audience, expiry, nonce, and opaque subject pass", async () => {
  const token = await signedToken();
  assert.deepEqual(await verifyIdToken(token,env,"nonce-1"),{iss:issuer,sub:"github|synthetic-123"});
});

function fakeDb({ linked = true } = {}) {
  const state = { transaction:null, consumed:false, session:null, revokedIdentity:false };
  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith("INSERT INTO auth_transactions")) state.transaction = { stateHash:values[0], browserHash:values[1], nonce:values[2], verifier:values[3] };
              if (sql.startsWith("INSERT INTO auth_sessions")) state.session = { id:values[0], tokenHash:values[1], provider:values[2], issuer:values[3], subject:values[4], accountId:values[5], identityId:values[6], idle:values[8], absolute:values[9] };
              if (sql.startsWith("UPDATE auth_sessions SET revoked_at") && state.session && values[1] === state.session.tokenHash) state.session.revokedAt = values[0];
            },
            async first() {
              if (sql.startsWith("UPDATE auth_transactions")) {
                if (state.consumed || !state.transaction || values[1] !== state.transaction.stateHash || values[2] !== state.transaction.browserHash) return null;
                state.consumed = true;
                return { nonce:state.transaction.nonce, verifier:state.transaction.verifier };
              }
              if (sql.includes("FROM identities i JOIN accounts a")) return linked ? { identity_id:"auth3-synthetic-identity", account_id:"auth3-synthetic-contributor", role:"contributor" } : null;
              if (sql.includes("SELECT s.id")) return state.session && !state.session.revokedAt && !state.revokedIdentity && values[0] === state.session.tokenHash ? { id:state.session.id } : null;
              return null;
            }
          };
        }
      };
    }
  };
}

async function startAndCallback(db) {
  const start = await worker.fetch(new Request(`${env.AUTH0_REDIRECT_URI.replace("/auth/callback","")}/auth/login`),{...env,DB:db});
  assert.equal(start.status,302);
  const authorize = new URL(start.headers.get("location"));
  const state = authorize.searchParams.get("state");
  const browser = start.headers.get("set-cookie").split(";")[0].split("=")[1];
  const expectedChallenge = Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(db.state.transaction.verifier))).toString("base64url");
  assert.equal(authorize.searchParams.get("code_challenge_method"),"S256");
  assert.equal(authorize.searchParams.get("code_challenge"),expectedChallenge);
  const token = await signedToken({nonce:db.state.transaction.nonce});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input,options) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      const body = JSON.parse(options?.body ?? "{}");
      assert.equal(body.code_verifier,db.state.transaction.verifier);
      return new Response(JSON.stringify({id_token:token}),{headers:{"content-type":"application/json"}});
    }
    if (url.endsWith("/.well-known/jwks.json")) return new Response(JSON.stringify({keys:[globalThis.syntheticJwk]}),{headers:{"content-type":"application/json"}});
    throw new Error(`Unexpected outbound request ${url}`);
  };
  const callbackRequest = new Request(`${env.AUTH0_REDIRECT_URI}?code=synthetic-code&state=${state}`,{headers:{cookie:`__Host-wd-auth3-state=${browser}`}});
  const callback = await worker.fetch(callbackRequest,{...env,DB:db});
  globalThis.fetch = originalFetch;
  return { callback, callbackRequest };
}

test("callback consumes browser-bound state once, sets secure session cookie, and revocation denies next request", async () => {
  const db = fakeDb();
  const { callback, callbackRequest } = await startAndCallback(db);
  assert.equal(callback.status,302);
  assert.equal(callback.headers.get("location"),"/auth/test-view");
  const setCookies = callback.headers.getSetCookie();
  const sessionCookie = setCookies.find(value=>value.startsWith("__Host-wd-auth3-session="));
  assert.match(sessionCookie,/; Secure; HttpOnly; SameSite=Lax; Path=\/|; Path=\/; Max-Age=.*Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await worker.fetch(callbackRequest,{...env,DB:db})).status,400);
  const raw = sessionCookie.split(";")[0].split("=")[1];
  const protectedRequest = () => worker.fetch(new Request(`${env.AUTH0_REDIRECT_URI.replace("/auth/callback","")}/auth/test-view`,{headers:{cookie:`__Host-wd-auth3-session=${raw}`}}),{...env,DB:db});
  assert.equal((await protectedRequest()).status,200);
  db.state.revokedIdentity = true;
  assert.equal((await protectedRequest()).status,401);
});

test("cryptographically verified but unlinked subject receives no session", async () => {
  const db = fakeDb({linked:false});
  const { callback } = await startAndCallback(db);
  assert.equal(callback.status,403);
  assert.equal(db.state.session,null);
});
test("wrong issuer, audience, expiry, nonce, algorithm, and signature fail closed", async () => {
  for (const override of [
    { claims:{iss:"https://attacker.example/"} },
    { claims:{aud:"other-client"} },
    { claims:{exp:1} },
    { claims:{nonce:"wrong"} },
    { header:{alg:"none"} },
    { claims:{sub:""} },
  ]) {
    const token = await signedToken(override.claims,override.header);
    await assert.rejects(verifyIdToken(token,env,"nonce-1"));
  }
  const valid = await signedToken();
  // Flip a middle signature character. The final base64url character of a 2048-bit signature carries unused bits, so changing only it can leave the decoded signature identical.
  const [tHead,tClaims,tSig] = valid.split(".");
  await assert.rejects(verifyIdToken(`${tHead}.${tClaims}.${tSig.slice(0,10)}${tSig[10] === "A" ? "B" : "A"}${tSig.slice(11)}`,env,"nonce-1"));
});
test("duplicate JWT claim names are rejected", async () => {
  const now = Math.floor(Date.now()/1000);
  const header = Buffer.from(JSON.stringify({alg:"RS256",kid:signingJwk.kid})).toString("base64url");
  const payload = Buffer.from(`{"iss":"${issuer}","aud":"synthetic-client","aud":"synthetic-client","sub":"github|synthetic-123","nonce":"nonce-1","iat":${now},"exp":${now+600}}`).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5",signingPair.privateKey,new TextEncoder().encode(input));
  await assert.rejects(verifyIdToken(`${input}.${Buffer.from(signature).toString("base64url")}`,env,"nonce-1"),/duplicate_json_member/);
});
test("public browsing works while auth is disabled and protected view denies", async () => {
  const db = { prepare() { throw new Error("unexpected database access"); } };
  const home = await worker.fetch(new Request("https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site/"),{AUTH0_ENABLED:"false",DB:db});
  assert.equal(home.status,200);
  assert.match(await home.text(),/Public browsing works without an account/);
  const login = await worker.fetch(new Request("https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site/auth/login"),{AUTH0_ENABLED:"false",DB:db});
  assert.equal(login.status,503);
  const view = await worker.fetch(new Request("https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site/auth/test-view"),{AUTH0_ENABLED:"false",DB:db});
  assert.equal(view.status,401);
});

const pilotOrigin = env.AUTH0_REDIRECT_URI.replace("/auth/callback","");
async function signedInSession(db) {
  const { callback } = await startAndCallback(db);
  assert.equal(callback.status,302);
  const sessionCookie = callback.headers.getSetCookie().find(value=>value.startsWith("__Host-wd-auth3-session="));
  return { callback, raw:sessionCookie.split(";")[0].split("=")[1] };
}
const viewWith = (db,raw) => worker.fetch(new Request(`${pilotOrigin}/auth/test-view`,{headers:{cookie:`__Host-wd-auth3-session=${raw}`}}),{...env,DB:db});
const logoutWith = (db,raw,headers) => worker.fetch(new Request(`${pilotOrigin}/auth/logout`,{method:"POST",headers:{cookie:`__Host-wd-auth3-session=${raw}`,...headers}}),{...env,DB:db});

test("only the test page that posts to logout relaxes the referrer policy, so the browser sends a usable Origin", async () => {
  const db = fakeDb();
  const login = await worker.fetch(new Request(`${pilotOrigin}/auth/login`),{...env,DB:db});
  assert.equal(login.headers.get("referrer-policy"),"no-referrer");
  const { callback, raw } = await signedInSession(fakeDb());
  assert.equal(callback.headers.get("referrer-policy"),"no-referrer");
  const view = await viewWith(db, (await signedInSession(db)).raw);
  assert.equal(view.status,200);
  assert.equal(view.headers.get("referrer-policy"),"same-origin");
  assert.equal(view.headers.get("cache-control"),"no-store");
  assert.match(await view.text(),/<form method="post" action="\/auth\/logout">/);
  assert.ok(raw);
});

test("logout with the exact origin revokes the session server side, clears the cookie, and denies the next request", async () => {
  const db = fakeDb();
  const { raw } = await signedInSession(db);
  assert.equal((await viewWith(db,raw)).status,200);
  const out = await logoutWith(db,raw,{origin:pilotOrigin});
  assert.equal(out.status,303);
  assert.equal(out.headers.get("location"),"/");
  assert.equal(out.headers.get("referrer-policy"),"no-referrer");
  assert.match(out.headers.get("set-cookie"),/^__Host-wd-auth3-session=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Lax$/);
  assert.ok(db.state.session.revokedAt);
  assert.equal((await viewWith(db,raw)).status,401);
});

test("logout denies missing, null, foreign, and lookalike origins and leaves the session active", async () => {
  const db = fakeDb();
  const { raw } = await signedInSession(db);
  for (const headers of [{}, {origin:"null"}, {origin:"https://evil.example"}, {origin:`${pilotOrigin}.evil.example`}, {origin:"http://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site"}]) {
    const denied = await logoutWith(db,raw,headers);
    assert.equal(denied.status,403,JSON.stringify(headers));
    assert.equal(denied.headers.get("set-cookie"),null);
  }
  assert.equal(db.state.session.revokedAt,undefined);
  assert.equal((await viewWith(db,raw)).status,200);
});

// Bootstrap link tests. Block scope keeps their synthetic helpers separate from the tests above.
{
// Real SQLite using the deployed Drizzle migration and synthetic data only. Not D1 itself.
const migration = readFileSync(new URL("../.openai/drizzle/0001_auth3_pilot.sql", import.meta.url), "utf8");
const issuer = "https://synthetic-bootstrap-tenant.example/";
const origin = "https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site";
const SUB = "github|synthetic-bootstrap-1";
const baseEnv = { AUTH0_ENABLED:"true", AUTH0_ISSUER:issuer, AUTH0_CLIENT_ID:"synthetic-client", AUTH0_CLIENT_SECRET:"synthetic-secret", AUTH0_REDIRECT_URI:`${origin}/auth/callback`, AUTH3_PILOT_BOOTSTRAP_SUBJECT:SUB };
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const pair = await crypto.subtle.generateKey({ name:"RSASSA-PKCS1-v1_5", modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256" }, true, ["sign","verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
jwk.kid = crypto.randomUUID(); jwk.alg = "RS256"; jwk.use = "sig";
async function token(nonce, claims = {}) {
  const now = Math.floor(Date.now()/1000);
  const input = `${b64({ alg:"RS256", kid:jwk.kid })}.${b64({ iss:issuer, aud:"synthetic-client", sub:SUB, nonce, exp:now+600, iat:now, ...claims })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString("base64url")}`;
}

// D1-shaped adapter over node:sqlite. `before(sql)` lets a test inject a competing write or a failure.
function makeDb(before = () => {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = {
    sqlite,
    prepare(sql) {
      return { bind: (...values) => ({
        async run() { before(sql, sqlite); sqlite.prepare(sql).run(...values); },
        async first() { before(sql, sqlite); return sqlite.prepare(sql).get(...values) ?? null; },
      }) };
    },
  };
  return db;
}
const plain = rows => rows.map(row => ({ ...row }));
const identityRow = db => plain(db.sqlite.prepare("SELECT id,account_id,provider,subject,revoked_at FROM identities").all());
const sessionCount = db => db.sqlite.prepare("SELECT COUNT(*) n FROM auth_sessions").get().n;
const SEEDED = { id:"auth3-synthetic-identity", account_id:"auth3-synthetic-contributor", provider:"auth0:https://tenant-placeholder.invalid/", subject:"synthetic-unlinked-sentinel", revoked_at:null };

async function signIn(db, env, { claims, tokenOverride } = {}) {
  const start = await worker.fetch(new Request(`${origin}/auth/login`), { ...env, DB:db });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const browser = start.headers.get("set-cookie").split(";")[0].split("=")[1];
  const txn = db.sqlite.prepare("SELECT nonce FROM auth_transactions ORDER BY rowid DESC LIMIT 1").get();
  const idToken = tokenOverride ?? await token(txn.nonce, claims);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ id_token:idToken }), { headers:{ "content-type":"application/json" } });
    if (url.endsWith("/.well-known/jwks.json")) return new Response(JSON.stringify({ keys:[jwk] }), { headers:{ "content-type":"application/json" } });
    throw new Error(`Unexpected outbound request ${url}`);
  };
  const request = () => new Request(`${origin}/auth/callback?code=synthetic-code&state=${state}`, { headers:{ cookie:`__Host-wd-auth3-state=${browser}` } });
  try { return { callback:await worker.fetch(request(), { ...env, DB:db }), replay:() => worker.fetch(request(), { ...env, DB:db }) }; }
  finally { globalThis.fetch = realFetch; }
}
const linked = { id:"auth3-synthetic-identity", account_id:"auth3-synthetic-contributor", provider:`auth0:${issuer}`, subject:SUB, revoked_at:null };
const mustNotLink = (db, result, status) => {
  assert.equal(result.callback.status, status);
  assert.equal(sessionCount(db), 0);
  assert.equal(result.callback.headers.getSetCookie().some(c => c.startsWith("__Host-wd-auth3-session=") && !c.includes("Max-Age=0")), false);
};

test("matching setting links only the seeded row, preserves the trailing slash, and issues a session", async () => {
  const db = makeDb();
  const { callback } = await signIn(db, baseEnv);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/auth/test-view");
  assert.deepEqual(identityRow(db), [linked]);
  assert.match(identityRow(db)[0].provider, /\/$/);
  assert.equal(sessionCount(db), 1);
  assert.deepEqual(plain(db.sqlite.prepare("SELECT id,kind,role,status,display_name FROM accounts").all()), [{ id:"auth3-synthetic-contributor", kind:"human", role:"contributor", status:"active", display_name:"Synthetic AUTH-3 Pilot Account" }]);
});

test("after linking, ordinary sign-in works with the setting removed", async () => {
  const db = makeDb();
  assert.equal((await signIn(db, baseEnv)).callback.status, 302);
  const without = { ...baseEnv }; delete without.AUTH3_PILOT_BOOTSTRAP_SUBJECT;
  assert.equal((await signIn(db, without)).callback.status, 302);
  assert.equal(sessionCount(db), 2);
  assert.deepEqual(identityRow(db), [linked]);
});

test("absent, empty, or mismatched setting links nothing and issues no session", async () => {
  for (const setting of [undefined, "", "github|someone-else", ` ${SUB}`, SUB.toUpperCase()]) {
    const db = makeDb();
    const env = { ...baseEnv }; if (setting === undefined) delete env.AUTH3_PILOT_BOOTSTRAP_SUBJECT; else env.AUTH3_PILOT_BOOTSTRAP_SUBJECT = setting;
    const result = await signIn(db, env);
    mustNotLink(db, result, 403);
    assert.equal(await result.callback.text(), "This identity is not linked to the pilot test account.");
    assert.deepEqual(identityRow(db), [SEEDED]);
  }
});

test("AUTH0_ENABLED=false blocks the callback before any link attempt", async () => {
  const db = makeDb();
  const { callback } = await signIn(db, baseEnv);
  assert.equal(callback.status, 302);
  const off = makeDb();
  const result = await worker.fetch(new Request(`${origin}/auth/callback?code=x&state=y`), { ...baseEnv, AUTH0_ENABLED:"false", DB:off });
  assert.equal(result.status, 503);
  assert.deepEqual(identityRow(off), [SEEDED]);
});

test("invalid tokens and replayed callbacks never link and never create a session", async () => {
  for (const claims of [{ iss:"https://attacker.example/" }, { aud:"other-client" }, { exp:1 }, { nonce:"wrong" }, { sub:"" }]) {
    const db = makeDb();
    mustNotLink(db, await signIn(db, baseEnv, { claims }), 400);
    assert.deepEqual(identityRow(db), [SEEDED]);
  }
  const db = makeDb();
  mustNotLink(db, await signIn(db, baseEnv, { tokenOverride:"not.a.jwt" }), 400);
  assert.deepEqual(identityRow(db), [SEEDED]);
  const good = makeDb();
  const first = await signIn(good, baseEnv);
  assert.equal(first.callback.status, 302);
  const replay = await first.replay();
  assert.equal(replay.status, 400);
  assert.equal(sessionCount(good), 1);
  assert.deepEqual(identityRow(good), [linked]);
});

test("revoked seeded identity is not linked", async () => {
  const db = makeDb();
  db.sqlite.exec("UPDATE identities SET revoked_at='2026-01-01T00:00:00.000Z'");
  mustNotLink(db, await signIn(db, baseEnv), 403);
  assert.deepEqual(identityRow(db), [{ ...SEEDED, revoked_at:"2026-01-01T00:00:00.000Z" }]);
});

test("disabled contributor is not linked", async () => {
  const db = makeDb();
  db.sqlite.exec("UPDATE accounts SET status='disabled'");
  mustNotLink(db, await signIn(db, baseEnv), 403);
  assert.deepEqual(identityRow(db), [SEEDED]);
});

test("an already-linked row is never overwritten, even with a matching setting", async () => {
  const db = makeDb();
  db.sqlite.exec(`UPDATE identities SET provider='auth0:${issuer}', subject='github|established-other'`);
  mustNotLink(db, await signIn(db, baseEnv), 403);
  assert.deepEqual(identityRow(db), [{ ...linked, subject:"github|established-other" }]);
});

test("a row that differs from the seed in any guarded column is not updated", async () => {
  for (const column of ["provider", "subject"]) {
    const db = makeDb();
    db.sqlite.exec(`UPDATE identities SET ${column}='changed'`);
    const before = identityRow(db);
    mustNotLink(db, await signIn(db, baseEnv), 403);
    assert.deepEqual(identityRow(db), before);
  }
});

test("a concurrent callback that already set the same link does not block this one and the row is unchanged", async () => {
  let done = false;
  const db = makeDb((sql, sqlite) => {
    if (!done && sql.startsWith("UPDATE identities")) { done = true; sqlite.exec(`UPDATE identities SET provider='auth0:${issuer}', subject='${SUB}'`); }
  });
  const { callback } = await signIn(db, baseEnv);
  assert.equal(callback.status, 302);
  assert.equal(sessionCount(db), 1);
  assert.deepEqual(identityRow(db), [linked]);
});

test("a concurrent callback that linked a different subject wins and this callback gets no session", async () => {
  let done = false;
  const db = makeDb((sql, sqlite) => {
    if (!done && sql.startsWith("UPDATE identities")) { done = true; sqlite.exec(`UPDATE identities SET provider='auth0:${issuer}', subject='github|winner'`); }
  });
  mustNotLink(db, await signIn(db, baseEnv), 403);
  assert.deepEqual(identityRow(db), [{ ...linked, subject:"github|winner" }]);
});

test("a zero-row update with no active link issues no session", async () => {
  let done = false;
  const db = makeDb((sql, sqlite) => {
    if (!done && sql.startsWith("UPDATE identities")) { done = true; sqlite.exec("UPDATE identities SET revoked_at='2026-01-01T00:00:00.000Z'"); }
  });
  mustNotLink(db, await signIn(db, baseEnv), 403);
  assert.deepEqual(identityRow(db), [{ ...SEEDED, revoked_at:"2026-01-01T00:00:00.000Z" }]);
});

test("a D1 failure during the update issues no session and returns the generic failure", async () => {
  const db = makeDb(sql => { if (sql.startsWith("UPDATE identities")) throw new Error("synthetic D1 failure"); });
  const result = await signIn(db, baseEnv);
  mustNotLink(db, result, 400);
  assert.equal(await result.callback.text(), "Sign-in could not be completed.");
  assert.deepEqual(identityRow(db), [SEEDED]);
});

test("the setting value never appears in responses", async () => {
  for (const setting of [SUB, "github|other"]) {
    const db = makeDb();
    const { callback } = await signIn(db, { ...baseEnv, AUTH3_PILOT_BOOTSTRAP_SUBJECT:setting });
    assert.equal((await callback.text()).includes(SUB), false);
    assert.equal(JSON.stringify([...callback.headers]).includes(SUB), false);
  }
});
// Callback diagnostics. Synthetic sensitive values below must never reach the logs.
const CODE = "synthetic-code-LEAK-1";
const LEAKS = [CODE, "synthetic-secret", "LEAK-error-detail", "LEAK-body-detail", SUB, "synthetic-bootstrap-tenant.example"];
const ALLOWED_KEYS = ["event", "outcome", "stage", "upstream_status"];
async function diagRun(db, { code = CODE, extra = "", tokenFetch, idToken } = {}) {
  const start = await worker.fetch(new Request(`${origin}/auth/login`), { ...baseEnv, DB:db });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const browser = start.headers.get("set-cookie").split(";")[0].split("=")[1];
  const txn = db.sqlite.prepare("SELECT nonce,verifier FROM auth_transactions ORDER BY rowid DESC LIMIT 1").get();
  const idTok = idToken ?? await token(txn.nonce);
  const realFetch = globalThis.fetch, realLog = console.log, logs = [];
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) return tokenFetch ? tokenFetch() : new Response(JSON.stringify({ id_token:idTok }), { headers:{ "content-type":"application/json" } });
    if (url.endsWith("/.well-known/jwks.json")) return new Response(JSON.stringify({ keys:[jwk] }), { headers:{ "content-type":"application/json" } });
    throw new Error(`Unexpected outbound request ${url}`);
  };
  console.log = (...args) => { logs.push(args); };
  const query = `${code === null ? "" : `code=${code}&`}state=${state}${extra}`;
  try {
    const callback = await worker.fetch(new Request(`${origin}/auth/callback?${query}`, { headers:{ cookie:`__Host-wd-auth3-state=${browser}` } }), { ...baseEnv, DB:db });
    return { callback, logs, secrets:[...LEAKS, state, browser, txn.nonce, txn.verifier, idTok, idTok.split(".")[2]] };
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
}
const entries = logs => logs.map(args => { assert.equal(args.length, 1); return JSON.parse(args[0]); });
function assertClean(result) {
  const text = JSON.stringify(result.logs);
  for (const secret of result.secrets) assert.equal(text.includes(secret), false, `log leaked ${secret}`);
  for (const entry of entries(result.logs)) {
    assert.deepEqual(Object.keys(entry).filter(k => !ALLOWED_KEYS.includes(k)), []);
    assert.equal(entry.event, "auth3_callback");
  }
}
const summary = logs => entries(logs).map(e => `${e.stage}:${e.outcome}${e.upstream_status ? `:${e.upstream_status}` : ""}`);

test("diagnostics: a successful callback logs each stage in order, allowlisted fields only", async () => {
  const db = makeDb();
  const result = await diagRun(db);
  assert.equal(result.callback.status, 302);
  assert.deepEqual(summary(result.logs), ["token_request:started", "token_request:response_received:200", "id_token:verified", "identity:linked", "session:created", "callback:completed"]);
  assertClean(result);
});

const FAILURES = [
  { name: "token fetch fails", opts: { tokenFetch: () => { throw new Error("LEAK-error-detail synthetic-secret"); } }, expect: ["token_request:started", "token_request:fetch_failed"] },
  { name: "upstream rejects with 401", opts: { tokenFetch: () => new Response('{"error":"LEAK-body-detail synthetic-secret"}', { status:401, headers:{ "content-type":"application/json" } }) }, expect: ["token_request:started", "token_request:upstream_rejected:401"] },
  { name: "upstream returns 500", opts: { tokenFetch: () => new Response("LEAK-body-detail", { status:500 }) }, expect: ["token_request:started", "token_request:upstream_rejected:500"] },
  { name: "token response is not JSON", opts: { tokenFetch: () => new Response("LEAK-body-detail not json", { status:200 }) }, expect: ["token_request:started", "token_request:response_unparseable:200"] },
  { name: "ID token fails verification", opts: { idToken: "not.a.jwt" }, expect: ["token_request:started", "token_request:response_received:200", "id_token:verification_failed"] },
  { name: "missing code after the transaction is consumed", opts: { code: null }, expect: ["input:code_missing_or_duplicate_after_consume"] },
  { name: "provider error parameter after the transaction is consumed", opts: { extra: "&error=access_denied&error_description=LEAK-body-detail" }, expect: ["input:provider_error_param_after_consume"] },
];
for (const failure of FAILURES) {
  test(`diagnostics: ${failure.name} keeps the generic 400 and logs only labels`, async () => {
    const db = makeDb();
    const result = await diagRun(db, failure.opts);
    mustNotLink(db, result, 400);
    assert.equal(await result.callback.text(), "Sign-in could not be completed.");
    assert.deepEqual(identityRow(db), [SEEDED]);
    assert.deepEqual(summary(result.logs), failure.expect);
    assertClean(result);
  });
}

test("diagnostics: identity lookup failure keeps the generic 400", async () => {
  const db = makeDb(sql => { if (sql.includes("FROM identities i JOIN accounts a")) throw new Error("LEAK-error-detail"); });
  const result = await diagRun(db);
  mustNotLink(db, result, 400);
  assert.deepEqual(summary(result.logs).slice(-2), ["id_token:verified", "identity:lookup_or_bootstrap_failed"]);
  assertClean(result);
});

test("diagnostics: bootstrap failure is reported as an identity-stage failure", async () => {
  const db = makeDb(sql => { if (sql.startsWith("UPDATE identities")) throw new Error("LEAK-error-detail"); });
  const result = await diagRun(db);
  mustNotLink(db, result, 400);
  assert.equal(summary(result.logs).at(-1), "identity:lookup_or_bootstrap_failed");
  assertClean(result);
});

test("diagnostics: no eligible link keeps the 403 and logs not_linked", async () => {
  const db = makeDb();
  db.sqlite.exec("UPDATE accounts SET status='disabled'");
  const result = await diagRun(db);
  mustNotLink(db, result, 403);
  assert.deepEqual(summary(result.logs).slice(-2), ["id_token:verified", "identity:not_linked"]);
  assertClean(result);
});

test("diagnostics: session creation failure keeps the generic 400", async () => {
  const db = makeDb(sql => { if (sql.startsWith("INSERT INTO auth_sessions")) throw new Error("LEAK-error-detail"); });
  const result = await diagRun(db);
  mustNotLink(db, result, 400);
  assert.deepEqual(summary(result.logs).slice(-2), ["identity:linked", "session:creation_failed"]);
  assertClean(result);
});

test("diagnostics: a callback whose state matches no transaction logs a rejection", async () => {
  const db = makeDb();
  const start = await worker.fetch(new Request(`${origin}/auth/login`), { ...baseEnv, DB:db });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const browser = start.headers.get("set-cookie").split(";")[0].split("=")[1];
  const logs = [], realLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const res = await worker.fetch(new Request(`${origin}/auth/callback?code=${CODE}&state=wrong-${state}`, { headers:{ cookie:`__Host-wd-auth3-state=${browser}` } }), { ...baseEnv, DB:db });
    assert.equal(res.status, 400);
  } finally { console.log = realLog; }
  assert.deepEqual(summary(logs), ["input:transaction_rejected"]);
  assert.equal(JSON.stringify(logs).includes(state), false);
});
}

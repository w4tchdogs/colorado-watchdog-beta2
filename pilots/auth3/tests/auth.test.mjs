import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { verifyIdToken } from "../worker.mjs";

const issuer = "https://synthetic-tenant.example/";
const env = { AUTH0_ENABLED:"true", AUTH0_ISSUER:issuer, AUTH0_CLIENT_ID:"synthetic-client", AUTH0_CLIENT_SECRET:"synthetic-secret", AUTH0_REDIRECT_URI:"https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site/auth/callback", PILOT_ORIGIN:"ignored" };
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
async function signedToken(claimOverrides = {}, headerOverrides = {}) {
  const pair = await crypto.subtle.generateKey({ name:"RSASSA-PKCS1-v1_5", modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256" },true,["sign","verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = crypto.randomUUID(); jwk.alg = "RS256"; jwk.use = "sig";
  globalThis.syntheticJwk = jwk;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys:[jwk] }),{headers:{"content-type":"application/json"}});
  const head = b64({ alg:"RS256", kid:jwk.kid, ...headerOverrides });
  const now = Math.floor(Date.now()/1000);
  const claims = b64({ iss:issuer, aud:"synthetic-client", sub:"github|synthetic-123", nonce:"nonce-1", exp:now+600, iat:now, ...claimOverrides });
  const input = `${head}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
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
            },
            async first() {
              if (sql.startsWith("UPDATE auth_transactions")) {
                if (state.consumed || !state.transaction || values[1] !== state.transaction.stateHash || values[2] !== state.transaction.browserHash) return null;
                state.consumed = true;
                return { nonce:state.transaction.nonce, verifier:state.transaction.verifier };
              }
              if (sql.includes("FROM identities i JOIN accounts a")) return linked ? { identity_id:"auth3-synthetic-identity", account_id:"auth3-synthetic-contributor", role:"contributor" } : null;
              if (sql.includes("SELECT s.id")) return state.session && !state.revokedIdentity && values[0] === state.session.tokenHash ? { id:state.session.id } : null;
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
  const token = await signedToken({nonce:db.state.transaction.nonce});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({id_token:token}),{headers:{"content-type":"application/json"}});
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
  await assert.rejects(verifyIdToken(`${valid.slice(0,-1)}${valid.endsWith("A") ? "B" : "A"}`,env,"nonce-1"));
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

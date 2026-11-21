import { createRemoteJWKSet, jwtVerify } from "jose";

const COOKIE = "__Host-wd-auth3-session";
const STATE_COOKIE = "__Host-wd-auth3-state";
const PILOT_ORIGIN = "https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site";
const encoder = new TextEncoder();
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

function response(body, status = 200, headers = {}) {
  const output = new Headers(noStore);
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) output.append(key, item);
    else output.set(key, value);
  }
  return new Response(body, { status, headers: output });
}
function cookie(request, name) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function randomToken(size = 32) { const bytes = crypto.getRandomValues(new Uint8Array(size)); return b64url(bytes); }
async function hash(value) { return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
function setCookie(name, value, maxAge) { return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`; }
function clearCookie(name) { return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`; }
function issuer(env) {
  if (!env.AUTH0_ISSUER || !env.AUTH0_ISSUER.startsWith("https://") || !env.AUTH0_ISSUER.endsWith("/")) throw new Error("invalid_configuration");
  const url = new URL(env.AUTH0_ISSUER);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("invalid_configuration");
  return env.AUTH0_ISSUER;
}
function assertNoDuplicateJsonMembers(text) {
  let position = 0;
  const whitespace = () => { while (/\s/.test(text[position] ?? "")) position++; };
  function stringValue() {
    const start = position++;
    while (position < text.length) {
      if (text[position] === "\\") position += 2;
      else if (text[position++] === '"') return JSON.parse(text.slice(start, position));
    }
    throw new Error("invalid_json");
  }
  function value() {
    whitespace();
    if (text[position] === '"') { stringValue(); return; }
    if (text[position] === "{") {
      position++; whitespace();
      const names = new Set();
      if (text[position] === "}") { position++; return; }
      for (;;) {
        whitespace();
        if (text[position] !== '"') throw new Error("invalid_json");
        const name = stringValue();
        if (names.has(name)) throw new Error("duplicate_json_member");
        names.add(name); whitespace();
        if (text[position++] !== ":") throw new Error("invalid_json");
        value(); whitespace();
        const separator = text[position++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("invalid_json");
      }
    }
    if (text[position] === "[") {
      position++; whitespace();
      if (text[position] === "]") { position++; return; }
      for (;;) {
        value(); whitespace();
        const separator = text[position++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("invalid_json");
      }
    }
    const start = position;
    while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
    if (position === start) throw new Error("invalid_json");
  }
  value(); whitespace();
  if (position !== text.length) throw new Error("invalid_json");
  JSON.parse(text);
}
function jsonSegment(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("invalid_token");
  const binary = atob(part.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(part.length/4)*4,"="));
  const bytes = Uint8Array.from(binary, c=>c.charCodeAt(0));
  const text = new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  assertNoDuplicateJsonMembers(text);
  return JSON.parse(text);
}
function parseJwt(token) {
  if (typeof token !== "string" || token.length > 16384) throw new Error("invalid_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token");
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error("invalid_token");
  return { header:jsonSegment(parts[0]), claims:jsonSegment(parts[1]) };
}
const jwksResolvers = new Map();
function getJwks(iss) {
  if (!jwksResolvers.has(iss)) {
    const url = new URL(".well-known/jwks.json", iss);
    if (url.origin !== new URL(iss).origin) throw new Error("invalid_jwks_url");
    jwksResolvers.set(iss, createRemoteJWKSet(url, {
      cacheMaxAge:5*60_000,
      cooldownDuration:30_000,
      timeoutDuration:5_000,
    }));
  }
  return jwksResolvers.get(iss);
}
export async function verifyIdToken(token, env, nonce, now = Date.now()) {
  const iss = issuer(env);
  const parsed = parseJwt(token);
  const { header, claims } = parsed;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.jku || header.x5u) throw new Error("invalid_token_header");
  if (!claims || claims.iss !== iss || (claims.aud !== env.AUTH0_CLIENT_ID && !(Array.isArray(claims.aud) && claims.aud.length < 10 && claims.aud.includes(env.AUTH0_CLIENT_ID)))) throw new Error("invalid_issuer_or_audience");
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== env.AUTH0_CLIENT_ID) throw new Error("invalid_authorized_party");
  if (claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 512 || /[\u0000-\u001f\u007f]/.test(claims.sub)) throw new Error("invalid_nonce_or_subject");
  const { payload } = await jwtVerify(token,getJwks(iss),{
    algorithms:["RS256"], issuer:iss, audience:env.AUTH0_CLIENT_ID,
    clockTolerance:30, maxTokenAge:"15m",
    requiredClaims:["iss","aud","exp","iat","sub"],
    currentDate:new Date(now),
  });
  if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 512 || /[\u0000-\u001f\u007f]/.test(payload.sub)) throw new Error("invalid_nonce_or_subject");
  return { iss, sub:payload.sub };
}
function sameOrigin(request, env) { return request.headers.get("origin") === new URL(env.AUTH0_REDIRECT_URI).origin; }
function validConfig(env) {
  if (env.AUTH0_ENABLED !== "true" || !env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET || !env.AUTH0_REDIRECT_URI) return false;
  const callback = new URL(env.AUTH0_REDIRECT_URI);
  return callback.href === `${PILOT_ORIGIN}/auth/callback`;
}
async function activeLink(db, iss, sub) {
  return db.prepare(`SELECT i.id identity_id, i.account_id, a.role FROM identities i JOIN accounts a ON a.id=i.account_id WHERE i.provider=? AND i.subject=? AND i.revoked_at IS NULL AND a.status='active' AND a.kind='human' AND a.role='contributor'`).bind(`auth0:${iss}`, sub).first();
}
const SEED_IDENTITY = { id:"auth3-synthetic-identity", accountId:"auth3-synthetic-contributor", provider:"auth0:https://tenant-placeholder.invalid/", subject:"synthetic-unlinked-sentinel" };
// Pilot-only one-time link. Runs only after the callback has verified the transaction and ID token. The guards live in the UPDATE itself so a concurrent callback cannot overwrite an established link.
async function bootstrapLink(db, env, identity) {
  const configured = env.AUTH3_PILOT_BOOTSTRAP_SUBJECT;
  if (env.AUTH0_ENABLED !== "true" || typeof configured !== "string" || configured === "" || configured !== identity.sub) return null;
  await db.prepare(`UPDATE identities SET provider=?, subject=? WHERE id=? AND account_id=? AND provider=? AND subject=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=identities.account_id AND a.status='active' AND a.kind='human' AND a.role='contributor')`).bind(`auth0:${identity.iss}`, identity.sub, SEED_IDENTITY.id, SEED_IDENTITY.accountId, SEED_IDENTITY.provider, SEED_IDENTITY.subject).run();
  const link = await activeLink(db, identity.iss, identity.sub);
  return link && link.identity_id === SEED_IDENTITY.id && link.account_id === SEED_IDENTITY.accountId ? link : null;
}
async function resolveSession(request, env, db) {
  // Disabling sign-in denies access for existing sessions too. Stored rows are left untouched, so re-enabling restores any session that has not expired or been revoked. Logout does not call this function and stays available.
  if (env.AUTH0_ENABLED !== "true") return null;
  const raw = cookie(request, COOKIE);
  if (!raw || !/^[A-Za-z0-9_-]{40,64}$/.test(raw)) return null;
  const session = await db.prepare(`SELECT s.id, s.issuer, s.subject, s.account_id, s.identity_id, s.idle_expires_at, s.absolute_expires_at FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.idle_expires_at>? AND s.absolute_expires_at>? AND i.provider=s.provider AND i.subject=s.subject AND i.revoked_at IS NULL AND a.status='active' AND a.kind='human' AND a.role='contributor'`).bind(await hash(raw), new Date().toISOString(), new Date().toISOString()).first();
  if (!session) return null;
  await db.prepare("UPDATE auth_sessions SET idle_expires_at=? WHERE id=? AND revoked_at IS NULL").bind(new Date(Date.now()+30*60_000).toISOString(), session.id).run();
  return session;
}
async function login(request, env, db) {
  if (!validConfig(env)) return response("Pilot sign-in is disabled.", 503);
  const state = randomToken(), browser = randomToken(), nonce = randomToken(), verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
  const iss = issuer(env);
  await db.prepare("INSERT INTO auth_transactions(state_hash,browser_hash,nonce,verifier,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(await hash(state), await hash(browser), nonce, verifier, new Date().toISOString(), new Date(Date.now()+5*60_000).toISOString()).run();
  const url = new URL("authorize", iss);
  url.search = new URLSearchParams({ response_type:"code", client_id:env.AUTH0_CLIENT_ID, redirect_uri:env.AUTH0_REDIRECT_URI, scope:"openid", state, nonce, code_challenge:challenge, code_challenge_method:"S256", prompt:"login" }).toString();
  return response(null, 302, { location:url.href, "set-cookie":setCookie(STATE_COOKIE,browser,300) });
}
// Callback diagnostics. Fixed labels and an optional numeric upstream HTTP status are the only fields ever logged. Never pass URLs, errors, bodies, codes, state, nonce, PKCE values, tokens, cookies, secrets or identifiers here.
const DIAG_OUTCOMES = {
  input: ["state_or_cookie_missing", "transaction_rejected", "code_missing_or_duplicate_after_consume", "provider_error_param_after_consume"],
  token_request: ["started", "fetch_failed", "upstream_rejected", "response_unparseable", "response_received"],
  id_token: ["verified", "verification_failed"],
  identity: ["linked", "not_linked", "lookup_or_bootstrap_failed"],
  session: ["created", "creation_failed"],
  callback: ["completed"],
};
function diag(stage, outcome, upstreamStatus) {
  try {
    if (!DIAG_OUTCOMES[stage]?.includes(outcome)) return;
    const entry = { event: "auth3_callback", stage, outcome };
    if (Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599) entry.upstream_status = upstreamStatus;
    console.log(JSON.stringify(entry));
  } catch {}
}
async function callback(request, env, db) {
  if (new URL(request.url).origin !== PILOT_ORIGIN) return response("Not found",404,{"set-cookie":clearCookie(STATE_COOKIE)});
  if (!validConfig(env)) return response("Pilot sign-in is disabled.", 503, { "set-cookie":clearCookie(STATE_COOKIE) });
  const url = new URL(request.url);
  const states = url.searchParams.getAll("state"), codes = url.searchParams.getAll("code");
  const stateCookie = cookie(request, STATE_COOKIE);
  if (states.length !== 1 || !states[0] || !stateCookie) { diag("input", "state_or_cookie_missing"); return response("Sign-in could not be completed.", 400, { "set-cookie":clearCookie(STATE_COOKIE) }); }
  const txn = await db.prepare("UPDATE auth_transactions SET consumed_at=? WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING nonce,verifier").bind(new Date().toISOString(), await hash(states[0]), await hash(stateCookie), new Date().toISOString()).first();
  if (!txn) { diag("input", "transaction_rejected"); return response("Sign-in could not be completed.", 400, { "set-cookie":clearCookie(STATE_COOKIE) }); }
  if (url.searchParams.has("error")) { diag("input", "provider_error_param_after_consume"); return response("Sign-in could not be completed.", 400, { "set-cookie":clearCookie(STATE_COOKIE) }); }
  if (codes.length !== 1 || !codes[0]) { diag("input", "code_missing_or_duplicate_after_consume"); return response("Sign-in could not be completed.", 400, { "set-cookie":clearCookie(STATE_COOKIE) }); }
  let step = { stage:"token_request", outcome:"fetch_failed" };
  try {
    const iss = issuer(env);
    diag("token_request", "started");
    const tokenResponse = await fetch(new URL("oauth/token", iss), { method:"POST", redirect:"manual", headers:{"content-type":"application/json",accept:"application/json"}, body:JSON.stringify({ grant_type:"authorization_code", client_id:env.AUTH0_CLIENT_ID, client_secret:env.AUTH0_CLIENT_SECRET, code:codes[0], redirect_uri:env.AUTH0_REDIRECT_URI, code_verifier:txn.verifier }) });
    if (!tokenResponse.ok) { step = { stage:"token_request", outcome:"upstream_rejected", status:tokenResponse.status }; throw new Error("token_exchange_failed"); }
    step = { stage:"token_request", outcome:"response_unparseable", status:tokenResponse.status };
    const tokens = await tokenResponse.json();
    diag("token_request", "response_received", tokenResponse.status);
    step = { stage:"id_token", outcome:"verification_failed" };
    const identity = await verifyIdToken(tokens.id_token, env, txn.nonce);
    diag("id_token", "verified");
    step = { stage:"identity", outcome:"lookup_or_bootstrap_failed" };
    const link = (await activeLink(db, identity.iss, identity.sub)) ?? (await bootstrapLink(db, env, identity));
    if (!link) { diag("identity", "not_linked"); return response("This identity is not linked to the pilot test account.", 403, { "set-cookie":clearCookie(STATE_COOKIE) }); }
    diag("identity", "linked");
    step = { stage:"session", outcome:"creation_failed" };
    const raw = randomToken();
    await db.prepare("INSERT INTO auth_sessions(id,token_hash,provider,issuer,subject,account_id,identity_id,issued_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), await hash(raw), `auth0:${identity.iss}`, identity.iss, identity.sub, link.account_id, link.identity_id, new Date().toISOString(), new Date(Date.now()+30*60_000).toISOString(), new Date(Date.now()+8*60*60_000).toISOString()).run();
    diag("session", "created");
    diag("callback", "completed");
    return response(null, 302, { location:"/auth/test-view", "set-cookie":[setCookie(COOKIE,raw,8*60*60), clearCookie(STATE_COOKIE)] });
  } catch {
    diag(step.stage, step.outcome, step.status);
    return response("Sign-in could not be completed.", 400, { "set-cookie":clearCookie(STATE_COOKIE) });
  }
}
async function logout(request, db) {
  if (request.method !== "POST") return response("Method not allowed.",405,{allow:"POST"});
  const raw = cookie(request, COOKIE);
  if (raw) await db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").bind(new Date().toISOString(), await hash(raw)).run();
  return response(null,303,{location:"/","set-cookie":clearCookie(COOKIE)});
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AUTH-3 isolated pilot</title></head><body><main><h1>Colorado Watchdog sign-in pilot</h1><p>Public browsing works without an account. This disposable site has synthetic test data only.</p><a href="/auth/login">Try pilot sign-in</a></main></body></html>`,200,{"content-type":"text/html; charset=utf-8"});
  if (url.pathname.startsWith("/auth/") && ["/auth/login","/auth/callback","/auth/logout","/auth/test-view"].includes(url.pathname)) {
    if (!env.DB) return response("Pilot database unavailable.",503);
    if (url.pathname === "/auth/login" && request.method === "GET") return login(request,env,env.DB).catch(()=>response("Sign-in unavailable.",503));
    if (url.pathname === "/auth/callback" && request.method === "GET") return callback(request,env,env.DB);
    if (url.pathname === "/auth/logout") return sameOrigin(request,env) ? logout(request,env.DB) : response("Forbidden",403);
    if (url.pathname === "/auth/test-view" && request.method === "GET") {
      const principal = await resolveSession(request,env,env.DB);
      if (!principal) return response("Authentication required.",401);
      return response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AUTH-3 test view</title></head><body><main><h1>Signed in</h1><p>Synthetic low-privilege test view. Account access is contributor-only.</p><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></main></body></html>`,200,{"content-type":"text/html; charset=utf-8","referrer-policy":"same-origin"});
    }
  }
  return response("Not found",404);
} };

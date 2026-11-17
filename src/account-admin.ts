import { InvalidInputError } from "./services/accounts.js";
import type { ApplicationServices } from "./services/index.js";
import { AuthorizationError } from "./services/security.js";

/** Independently mountable account administration surface; no UI framework. */
export function createAccountAdminModule(
  services: ApplicationServices,
  options: { readonly humanSignIn?: boolean } = {},
) {
  const humanSignIn = options.humanSignIn === true;
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/admin/accounts.js" && request.method === "GET")
        return new Response(ADMIN_JS, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      if (url.pathname === "/admin/accounts" && request.method === "GET") {
        const principal = await services.resolvePrincipal(request);
        if (!principal)
          return adminAccessPage(
            401,
            humanSignIn
              ? "Sign in to continue."
              : "Human sign-in is not available yet.",
            true,
            humanSignIn,
          );
        if (!(await services.hasCapability(principal, "account.read")))
          return adminAccessPage(
            403,
            "This Website account is not authorized to manage accounts.",
            false,
            humanSignIn,
          );
        return new Response(ADMIN_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (
        url.pathname !== "/api/admin/accounts" &&
        !url.pathname.startsWith("/api/admin/accounts/")
      )
        return json(404, { error: "not_found" });
      const principal = await services.resolvePrincipal(request);
      if (!principal) return json(401, { error: "authentication_required" });
      if (!(await services.hasCapability(principal, "account.read")))
        return json(403, { error: "forbidden" });
      if (request.method !== "GET" && !sameOrigin(request))
        return json(403, { error: "origin_rejected" });
      try {
        if (
          url.pathname === "/api/admin/accounts" &&
          request.method === "POST"
        ) {
          const body = await readJson(request);
          if (
            !isObject(body) ||
            Object.keys(body).some(
              (k) => !["kind", "role", "displayName", "email"].includes(k),
            ) ||
            typeof body.kind !== "string" ||
            typeof body.role !== "string" ||
            typeof body.displayName !== "string" ||
            (body.email !== undefined &&
              body.email !== null &&
              typeof body.email !== "string")
          )
            return json(400, { error: "invalid_request" });
          return json(201, {
            ...(await services.createAccount(principal, body as never)),
          });
        }
        if (
          url.pathname === "/api/admin/accounts" &&
          request.method === "GET"
        ) {
          const limitText = url.searchParams.get("limit");
          const result = await services.listAccounts(principal, {
            query: url.searchParams.get("query") ?? undefined,
            kind: optionalEnum(url.searchParams.get("kind"), [
              "human",
              "agent",
            ] as const),
            role: optionalEnum(url.searchParams.get("role"), [
              "contributor",
              "editor",
              "administrator",
              "owner",
            ] as const),
            status: optionalEnum(url.searchParams.get("status"), [
              "active",
              "disabled",
              "archived",
            ] as const),
            limit: limitText === null ? undefined : Number(limitText),
            afterId: url.searchParams.get("afterId") ?? undefined,
          });
          return json(200, result);
        }
        const match =
          /^\/api\/admin\/accounts\/([^/]+)(?:\/(role|identities|credentials|audit|capabilities|archive))?$/.exec(
            url.pathname,
          );
        const matchedId = match?.[1];
        if (!matchedId) return json(404, { error: "not_found" });
        const id = decodeURIComponent(matchedId);
        const action = match[2];
        if (action === "audit" && request.method === "GET") {
          const detail = await services.getAccountDetails(principal, id);
          if (!detail) return json(404, { error: "not_found" });
          const identityIds = new Set(
            detail.identities.map((identity) => identity.id),
          );
          const events = (await services.listAuditEvents(principal, 100))
            .filter(
              (event) =>
                event.target_id === id ||
                (typeof event.target_id === "string" &&
                  identityIds.has(event.target_id)) ||
                accountIdFromDetails(event.details_json) === id,
            )
            .map((event) => ({
              actorAccountId: event.actor_account_id,
              action: event.action,
              targetType: event.target_type,
              summary: event.summary,
              createdAt: event.created_at,
            }));
          return json(200, { events });
        }
        if (!action && request.method === "GET") {
          const result = await services.getAccountDetails(principal, id);
          return result
            ? json(200, { ...result })
            : json(404, { error: "not_found" });
        }
        if (!action && request.method === "PATCH") {
          const body = await readJson(request);
          if (
            !isObject(body) ||
            Object.keys(body).some(
              (k) =>
                ![
                  "expectedVersion",
                  "displayName",
                  "email",
                  "status",
                  "preferences",
                ].includes(k),
            ) ||
            !Number.isInteger(body.expectedVersion)
          )
            return json(400, { error: "invalid_request" });
          const { expectedVersion, ...changes } = body;
          const version = await services.updateAccount(
            principal,
            id,
            expectedVersion as number,
            changes,
          );
          return json(200, { version });
        }
        if (action === "archive" && request.method === "POST") {
          const body = await readJson(request);
          if (
            !isObject(body) ||
            Object.keys(body).some((key) => key !== "expectedVersion") ||
            !Number.isInteger(body.expectedVersion)
          )
            return json(400, { error: "invalid_request" });
          return json(200, {
            version: await services.archiveAccount(
              principal,
              id,
              body.expectedVersion as number,
            ),
          });
        }
        if (action === "role" && request.method === "PUT") {
          const body = await readJson(request);
          if (
            !isObject(body) ||
            Object.keys(body).some(
              (k) => !["expectedVersion", "role"].includes(k),
            ) ||
            !Number.isInteger(body.expectedVersion)
          )
            return json(400, { error: "invalid_request" });
          const version = await services.changeAccountRole(
            principal,
            id,
            body.expectedVersion as number,
            body.role as never,
          );
          return json(200, { version });
        }
        if (action === "identities" && request.method === "POST") {
          const body = await readJson(request);
          if (
            !isObject(body) ||
            Object.keys(body).some(
              (k) => !["provider", "subject"].includes(k),
            ) ||
            typeof body.provider !== "string" ||
            typeof body.subject !== "string"
          )
            return json(400, { error: "invalid_request" });
          return json(201, {
            identityId: await services.createHumanIdentity(
              principal,
              id,
              body.provider,
              body.subject,
            ),
          });
        }
        if (action === "capabilities") {
          if (!services.setAgentCapability || !services.listAgentCapabilities)
            return json(404, { error: "not_found" });
          if (request.method === "GET")
            return json(200, {
              capabilities: await services.listAgentCapabilities(principal, id),
            });
          if (request.method === "PUT" || request.method === "DELETE") {
            const body = await readJson(request);
            if (
              !isObject(body) ||
              Object.keys(body).some((k) => k !== "capability") ||
              typeof body.capability !== "string"
            )
              return json(400, { error: "invalid_request" });
            await services.setAgentCapability(
              principal,
              id,
              body.capability,
              request.method === "PUT",
            );
            return json(200, {
              capabilities: await services.listAgentCapabilities(principal, id),
            });
          }
        }
        if (action === "credentials" && request.method === "POST") {
          const body = await readJson(request);
          if (
            !isObject(body) ||
            Object.keys(body).some((k) => k !== "expiresAt") ||
            (body.expiresAt !== undefined &&
              body.expiresAt !== null &&
              typeof body.expiresAt !== "string")
          )
            return json(400, { error: "invalid_request" });
          return json(
            201,
            await services.issueAgentCredential(
              principal,
              id,
              body.expiresAt as string | null | undefined,
            ),
          );
        }
        if (action === "identities" && request.method === "DELETE") {
          const identityId = url.searchParams.get("id");
          const version = Number(url.searchParams.get("version"));
          if (!identityId || !Number.isInteger(version))
            return json(400, { error: "invalid_request" });
          return json(200, {
            version: await services.revokeIdentity(
              principal,
              identityId,
              version,
            ),
          });
        }
        return json(405, { error: "method_not_allowed" });
      } catch (error) {
        if (error instanceof AuthorizationError)
          return json(403, { error: "forbidden" });
        if (error instanceof InvalidInputError || error instanceof SyntaxError)
          return json(400, { error: "invalid_request" });
        return json(409, { error: "conflict_or_unavailable" });
      }
    },
  };
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}
async function readJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new InvalidInputError();
  return request.json();
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function accountIdFromDetails(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) && typeof parsed.accountId === "string"
      ? parsed.accountId
      : null;
  } catch {
    return null;
  }
}
function optionalEnum<T extends readonly string[]>(
  value: string | null,
  allowed: T,
): T[number] | undefined {
  if (value === null) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new InvalidInputError();
  return value as T[number];
}
function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const ADMIN_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account management · Colorado Watchdog</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#211f1d}h1{color:#a62026}button,select,input{font:inherit;padding:.5rem}button{cursor:pointer}.layout{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:1rem}li{margin:.5rem 0}li button{width:100%;text-align:left}.error{color:#a62026;min-height:1.5em}@media(max-width:650px){.layout{grid-template-columns:1fr}}</style><h1>Account management</h1><p><a href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a></p><p id="message" class="error" role="status"></p><label>Filter <input id="query" maxlength="100"></label> <button id="search">Search</button> <label><input id="archived" type="checkbox"> Include archived accounts</label> <button id="create">Create account</button><div class="layout"><ul id="accounts"></ul><section id="detail"><p>Select an account to view its details.</p></section></div><script type="module" src="/admin/accounts.js"></script></html>`;

function adminAccessPage(
  status: 401 | 403,
  message: string,
  canSignIn: boolean,
  humanSignIn: boolean,
): Response {
  const action = !humanSignIn
    ? ""
    : canSignIn
      ? '<a href="/auth/login?return_to=%2Fadmin%2Faccounts">Sign in</a>'
      : '<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>';
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account access · Colorado Watchdog</title><main><h1>Account management</h1><p>${message}</p>${canSignIn ? "<p>If you have signed in but do not have a Website account yet, ask an owner to provision one.</p>" : ""}<p>${action}</p></main></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        // Same-origin referrers keep the exact Origin on the sign-out POST.
        "referrer-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

const ADMIN_JS = `const $=s=>document.querySelector(s);let selected=null;const message=(s="")=>$("#message").textContent=s;async function call(path,options={}){const r=await fetch(path,{...options,credentials:"same-origin",headers:{...(options.body?{"content-type":"application/json"}:{}),...options.headers}});const b=await r.json();if(!r.ok)throw Error(b.error||"Request failed");return b}async function load(){try{const q=$("#query").value.trim();const params=new URLSearchParams();if(q)params.set("query",q);if($("#archived").checked)params.set("status","archived");const data=await call("/api/admin/accounts?"+params);$("#accounts").replaceChildren(...data.accounts.map(a=>{const li=document.createElement("li"),b=document.createElement("button");b.textContent=a.displayName+" · "+a.role+" · "+a.status;b.onclick=()=>show(a.id);li.append(b);return li}));message("")}catch(e){message("Could not load accounts: "+e.message)}}async function show(id){try{selected=await call("/api/admin/accounts/"+encodeURIComponent(id));const d=$("#detail");d.replaceChildren();const h=document.createElement("h2");h.textContent=selected.displayName;d.append(h);const info=document.createElement("p");info.textContent=selected.kind+" · "+selected.id+" · version "+selected.version;d.append(info);const role=document.createElement("select");for(const v of ["contributor","editor","administrator","owner"]){const o=document.createElement("option");o.value=v;o.textContent=v;o.selected=v===selected.role;role.append(o)}const saveRole=button("Save role",async()=>{await call("/api/admin/accounts/"+id+"/role",{method:"PUT",body:JSON.stringify({expectedVersion:selected.version,role:role.value})});await show(id);await load()});d.append(role,saveRole);const status=button(selected.status==="active"?"Disable account":"Enable account",async()=>{await call("/api/admin/accounts/"+id,{method:"PATCH",body:JSON.stringify({expectedVersion:selected.version,status:selected.status==="active"?"disabled":"active"})});await show(id);await load()});d.append(status);if(selected.kind==="agent"){d.append(button("Issue agent credential",async()=>{const result=await call("/api/admin/accounts/"+id+"/credentials",{method:"POST",body:JSON.stringify({})});const p=document.createElement("pre");p.textContent="Copy this credential now. It is shown only once:\\n"+result.secret;d.append(p)}))}if(selected.kind==="agent"){const gh=document.createElement("h3");gh.textContent="Agent capabilities";d.append(gh);let held=[];try{held=(await call("/api/admin/accounts/"+id+"/capabilities")).capabilities}catch(e){}for(const cap of ["sync.read","sync.apply","sync.revert","d1.inspect"]){const on=held.includes(cap);d.append(button((on?"Revoke ":"Grant ")+cap,async()=>{await call("/api/admin/accounts/"+id+"/capabilities",{method:on?"DELETE":"PUT",body:JSON.stringify({capability:cap})});await show(id)}))}}const ids=document.createElement("h3");ids.textContent="Identities";d.append(ids);for(const identity of selected.identities){const line=document.createElement("p");line.textContent=identity.provider+" · "+identity.subject+(identity.revokedAt?" · revoked":"")+(identity.expiresAt?" · expires "+identity.expiresAt:"");d.append(line);if(!identity.revokedAt)d.append(button("Revoke",async()=>{await call("/api/admin/accounts/"+id+"/identities?id="+encodeURIComponent(identity.id)+"&version="+identity.version,{method:"DELETE"});await show(id)}))}const audit=await call("/api/admin/accounts/"+encodeURIComponent(id)+"/audit");const ah=document.createElement("h3");ah.textContent="Recent audit activity";d.append(ah);for(const event of audit.events){const line=document.createElement("p");line.textContent=event.createdAt+" · "+event.action+" · actor "+event.actorAccountId+" · "+event.summary;d.append(line)}if(!audit.events.length){const empty=document.createElement("p");empty.textContent="No audit activity in the latest 100 events.";d.append(empty)}message("")}catch(e){message("Could not open account: "+e.message)}}function button(label,action){const b=document.createElement("button");b.textContent=label;b.onclick=async()=>{try{message("");await action()}catch(e){message("Action failed: "+e.message)}};return b}$("#create").onclick=async()=>{const name=window.prompt("Display name for the new account");if(!name)return;const kind=window.prompt("Account kind: human or agent","agent");if(kind!=="human"&&kind!=="agent"){message("Choose human or agent.");return}const role=window.prompt("Role: contributor, editor, administrator or owner","contributor");try{const result=await call("/api/admin/accounts",{method:"POST",body:JSON.stringify({kind,role,displayName:name})});message("Account created. Link a verified human identity before human sign-in.");await load();await show(result.id)}catch(e){message("Could not create account: "+e.message)}};$("#search").onclick=load;$("#archived").onchange=load;load();`;

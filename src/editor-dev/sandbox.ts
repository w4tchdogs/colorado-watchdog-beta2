import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentAction } from "../contracts/content.js";
import { DASHBOARD_API_PATHS } from "../contracts/dashboard.js";
import { AsyncD1Database } from "../database/d1.js";
import { migrateWebsiteDatabase } from "../database/migrations.js";
import {
  openWebsiteDatabase,
  type WebsiteDatabase,
} from "../database/sqlite.js";
import { D1BannerAdministration } from "../services/banner-admin-d1.js";
import { MemoryBannerObjectStorage } from "../services/banner-storage.js";
import { createContentService } from "../services/content.js";
import { createDashboardService } from "../services/dashboard.js";
import {
  createTestHumanIdentityAdapter,
  hasCapability,
  resolvePrincipal,
  type TrustedPrincipal,
} from "../services/security.js";
import {
  createBannerAdminApiTransport,
  isBannerAdminPath,
} from "../transport/banner-admin-api.js";
import {
  CONTENT_API_PATHS,
  createContentApiTransport,
  createContentTransportOperations,
} from "../transport/content-api.js";
import { createDashboardApiTransport } from "../transport/dashboard-api.js";
import { createLocalD1Binding } from "./d1-binding.js";
import { LookupRequestError, parseLookupRequest, runLookup } from "./lookup.js";

/**
 * Local, disposable dashboard and editorial sandbox. It is a development tool
 * only: it owns a fresh in-memory Website database, never reads DATABASE_PATH
 * or any other environment, and is never imported by the public application or
 * Worker. The synthetic account switch below exists nowhere else.
 */
export const SANDBOX_TOKEN_HEADER = "x-editor-token";
export const SANDBOX_ACCOUNT_HEADER = "x-test-human-subject";
export const SANDBOX_INFO_PATH = "/sandbox/info";
export const SANDBOX_LOOKUP_PATH = "/sandbox/lookup";
const MAX_LOOKUP_BODY_BYTES = 4096;
export const TOKEN_PLACEHOLDER = "__EDITOR_TOKEN__";

/** Sandbox account key -> synthetic identity subject. */
const SUBJECTS = {
  author: "sandbox-subject-author",
  editor: "sandbox-subject-editor",
  readonly: "sandbox-subject-readonly",
  admin: "sandbox-subject-admin",
  owner: "sandbox-subject-owner",
  retired: "sandbox-subject-retired",
} as const;

/**
 * Synthetic accounts for the switcher. Roles are real rows in the sandbox
 * database, so access follows the existing role matrix. `anonymous` maps to no
 * identity at all and behaves like a signed-out visitor.
 */
export const SANDBOX_ACCOUNTS = [
  { key: "author", label: "Avery Author (editor)", accountId: "sbx-author" },
  { key: "editor", label: "Eli Editor (editor)", accountId: "sbx-editor" },
  {
    key: "readonly",
    label: "Riley Reader (contributor)",
    accountId: "sbx-readonly",
  },
  {
    key: "admin",
    label: "Ada Administrator (administrator)",
    accountId: "sbx-admin",
  },
  { key: "owner", label: "Olive Owner (owner)", accountId: "sbx-owner" },
  {
    key: "retired",
    label: "Rene Retired (disabled account)",
    accountId: "sbx-retired",
  },
  { key: "anonymous", label: "Signed-out visitor", accountId: null },
] as const;

/** The existing editorial capability gates every content action here. */
const EDITORIAL_CAPABILITY = "content.publish";

export interface EditorSandboxOptions {
  /** Directory holding index.html and editor.css. */
  readonly staticDirectory: string;
  /** Directory holding the compiled browser modules (dist/editor). */
  readonly scriptDirectory: string;
  /** Exact host:port values accepted in the Host header. */
  readonly allowedHosts: readonly string[];
  readonly token?: string;
  /**
   * Loopback address of the local public site preview, used for the "View
   * public site" link. Anything that is not a loopback http URL is ignored.
   */
  readonly publicSiteUrl?: string;
}

export interface EditorSandbox {
  readonly token: string;
  readonly database: WebsiteDatabase;
  /** In-memory banner object storage, exposed so tests can hide or corrupt objects. */
  readonly bannerStorage: MemoryBannerObjectStorage;
  fetch(request: Request): Promise<Response>;
  close(): void;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

export function sandboxJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function tokensEqual(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATIC_FILES: Readonly<
  Record<string, { directory: "static" | "script"; file: string; type: string }>
> = {
  "/": {
    directory: "static",
    file: "index.html",
    type: "text/html; charset=utf-8",
  },
  "/editor.css": {
    directory: "static",
    file: "editor.css",
    type: "text/css; charset=utf-8",
  },
  "/app/main.js": {
    directory: "script",
    file: "main.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/app.js": {
    directory: "script",
    file: "app.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/api-client.js": {
    directory: "script",
    file: "api-client.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/diff.js": {
    directory: "script",
    file: "diff.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/dom.js": {
    directory: "script",
    file: "dom.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/markdown.js": {
    directory: "script",
    file: "markdown.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/relationships.js": {
    directory: "script",
    file: "relationships.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/picker.js": {
    directory: "script",
    file: "picker.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/relationship-format.js": {
    directory: "script",
    file: "relationship-format.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/visual-model.js": {
    directory: "script",
    file: "visual-model.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/visual-canvas.js": {
    directory: "script",
    file: "visual-canvas.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/preview.js": {
    directory: "script",
    file: "preview.js",
    type: "text/javascript; charset=utf-8",
  },
  "/dashboard.css": {
    directory: "static",
    file: "dashboard.css",
    type: "text/css; charset=utf-8",
  },
  "/app/dashboard.js": {
    directory: "script",
    file: "dashboard.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/dashboard-sandbox.js": {
    directory: "script",
    file: "dashboard-sandbox.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/dashboard-client.js": {
    directory: "script",
    file: "dashboard-client.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/dashboard-views.js": {
    directory: "script",
    file: "dashboard-views.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/banner-admin-client.js": {
    directory: "script",
    file: "banner-admin-client.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/banner-filename.js": {
    directory: "script",
    file: "banner-filename.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app/banner-views.js": {
    directory: "script",
    file: "banner-views.js",
    type: "text/javascript; charset=utf-8",
  },
};

function loopbackUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function createEditorSandbox(
  options: EditorSandboxOptions,
): Promise<EditorSandbox> {
  // Always a fresh in-memory database. No path, URL or environment is read.
  const database = await openWebsiteDatabase(":memory:");
  migrateWebsiteDatabase(database);
  seedAccountsAndDirectory(database);

  // Development-only wiring of the existing role matrix: a synthetic
  // test-human principal may edit only while its role holds the capability.
  const sandboxPolicy = (
    principal: TrustedPrincipal,
    _action?: ContentAction | string,
  ): boolean =>
    principal.provider === "test-human" &&
    hasCapability(database, principal, EDITORIAL_CAPABILITY);

  const service = createContentService(database, { authorize: sandboxPolicy });
  const dashboard = createDashboardService(database, {
    recentContent: (principal) =>
      service.listDrafts(principal, { limit: 5, sort: "modified" }).items,
  });
  const publicSiteUrl = loopbackUrl(options.publicSiteUrl);
  const adapter = createTestHumanIdentityAdapter(SUBJECTS);
  const token = options.token ?? randomBytes(32).toString("base64url");
  const allowedHosts = new Set(
    options.allowedHosts.map((h) => h.toLowerCase()),
  );

  const transport = createContentApiTransport({
    resolvePrincipal: (request) => resolvePrincipal(database, request, adapter),
    authorize: (principal) => sandboxPolicy(principal),
    operations: createContentTransportOperations(service),
  });
  const dashboardTransport = createDashboardApiTransport({
    resolvePrincipal: (request) => resolvePrincipal(database, request, adapter),
    service: dashboard,
  });
  // The merged banner administration service runs over a sync->async database
  // adapter with an in-memory object store, so the local preview behaves like
  // the hosted deployment without touching any real binding.
  const bannerStorage = new MemoryBannerObjectStorage();
  const bannerTransport = createBannerAdminApiTransport({
    resolvePrincipal: (request) => resolvePrincipal(database, request, adapter),
    authorize: (principal) =>
      hasCapability(database, principal, "banner.manage"),
    administration: new D1BannerAdministration(
      new AsyncD1Database(createLocalD1Binding(database)),
      bannerStorage,
    ),
  });

  await seedContent(database, service);

  const info = () => {
    const counties = database
      .prepare("SELECT fips, name FROM counties ORDER BY name")
      .all()
      .map((row) => ({ fips: String(row.fips), name: String(row.name) }));
    return {
      sandbox: true as const,
      accounts: SANDBOX_ACCOUNTS.map(({ key, label }) => ({ key, label })),
      counties,
      publicSiteUrl,
    };
  };

  async function serveStatic(pathname: string): Promise<Response> {
    const entry = STATIC_FILES[pathname];
    if (!entry) return sandboxJson(404, { error: "not_found" });
    const directory =
      entry.directory === "static"
        ? options.staticDirectory
        : options.scriptDirectory;
    let text: string;
    try {
      text = await readFile(join(directory, entry.file), "utf8");
    } catch {
      return sandboxJson(503, { error: "operation_unavailable" });
    }
    if (pathname === "/") text = text.replaceAll(TOKEN_PLACEHOLDER, token);
    return new Response(text, {
      status: 200,
      headers: { ...SECURITY_HEADERS, "content-type": entry.type },
    });
  }

  /**
   * Bounded read-only lookup of the fictional people and organizations. It is
   * gated like the editorial API: a trusted principal and the sandbox policy.
   */
  async function handleLookup(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return sandboxJson(405, { error: "method_not_allowed" });
    }
    const principal = await resolvePrincipal(database, request, adapter);
    if (!principal)
      return sandboxJson(401, { error: "authentication_required" });
    if (!sandboxPolicy(principal, "content.read")) {
      return sandboxJson(403, { error: "forbidden" });
    }
    if (
      !(request.headers.get("content-type") ?? "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      return sandboxJson(400, { error: "invalid_request" });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_LOOKUP_BODY_BYTES) {
      return sandboxJson(413, { error: "request_too_large" });
    }
    try {
      const parsed = parseLookupRequest(JSON.parse(text));
      return sandboxJson(200, runLookup(database, parsed));
    } catch (error) {
      if (error instanceof LookupRequestError || error instanceof SyntaxError) {
        return sandboxJson(400, { error: "invalid_request" });
      }
      return sandboxJson(500, { error: "internal_error" });
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // DNS-rebinding defense: only the exact local origins are served.
    if (!allowedHosts.has(url.host.toLowerCase())) {
      return sandboxJson(403, { error: "forbidden" });
    }
    const isApi =
      url.pathname === SANDBOX_INFO_PATH ||
      url.pathname === SANDBOX_LOOKUP_PATH ||
      url.pathname === DASHBOARD_API_PATHS.session ||
      url.pathname === DASHBOARD_API_PATHS.view ||
      isBannerAdminPath(url.pathname) ||
      Object.values(CONTENT_API_PATHS).includes(
        url.pathname as (typeof CONTENT_API_PATHS)[keyof typeof CONTENT_API_PATHS],
      );
    if (!isApi) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sandboxJson(405, { error: "method_not_allowed" });
      }
      return serveStatic(url.pathname);
    }

    // Cross-origin defense for every API call, including reads.
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "same-origin") {
      return sandboxJson(403, { error: "forbidden" });
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) {
      return sandboxJson(403, { error: "forbidden" });
    }
    if (request.method === "POST" && origin === null && fetchSite === null) {
      return sandboxJson(403, { error: "forbidden" });
    }
    if (!tokensEqual(token, request.headers.get(SANDBOX_TOKEN_HEADER))) {
      return sandboxJson(403, { error: "forbidden" });
    }
    if (url.pathname === SANDBOX_INFO_PATH) {
      if (request.method !== "GET") {
        return sandboxJson(405, { error: "method_not_allowed" });
      }
      return sandboxJson(200, info());
    }
    if (url.pathname === SANDBOX_LOOKUP_PATH) {
      return handleLookup(request);
    }
    const response = await (url.pathname === DASHBOARD_API_PATHS.session ||
    url.pathname === DASHBOARD_API_PATHS.view
      ? dashboardTransport
      : isBannerAdminPath(url.pathname)
        ? bannerTransport
        : transport
    ).fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  }

  return {
    token,
    database,
    bannerStorage,
    fetch: handle,
    close: () => database.close(),
  };
}

function seedAccountsAndDirectory(database: WebsiteDatabase): void {
  database.exec(`
    INSERT INTO accounts (id, kind, role, display_name, email, status)
    VALUES ('sbx-author','human','editor','Avery Author','author@example.invalid','active'),
           ('sbx-editor','human','editor','Eli Editor','editor@example.invalid','active'),
           ('sbx-readonly','human','contributor','Riley Reader','reader@example.invalid','active'),
           ('sbx-admin','human','administrator','Ada Administrator','admin@example.invalid','active'),
           ('sbx-owner','human','owner','Olive Owner','owner@example.invalid','active'),
           ('sbx-retired','human','editor','Rene Retired',NULL,'disabled');
    INSERT INTO identities (id, account_id, provider, subject)
    VALUES ('sbx-id-author','sbx-author','test-human','${SUBJECTS.author}'),
           ('sbx-id-editor','sbx-editor','test-human','${SUBJECTS.editor}'),
           ('sbx-id-readonly','sbx-readonly','test-human','${SUBJECTS.readonly}'),
           ('sbx-id-admin','sbx-admin','test-human','${SUBJECTS.admin}'),
           ('sbx-id-owner','sbx-owner','test-human','${SUBJECTS.owner}'),
           ('sbx-id-retired','sbx-retired','test-human','${SUBJECTS.retired}');
    INSERT INTO organizations (id, name, organization_type, county_fips)
    VALUES ('sbx-org-1','Fictional Records Office','office','08001'),
           ('sbx-org-2','Fictional Regional Board','regional',NULL),
           ('sbx-org-3','Fictional County Government','county_government','08001'),
           ('sbx-org-5','Fictional Records Office','office','08005'),
           ('sbx-org-6','Fictional Community Partner','partner',NULL),
           ('sbx-org-7','Fictional Shared Services Group','other',NULL);
    INSERT INTO organizations (id, name, organization_type, county_fips, parent_organization_id, parent_relationship)
    VALUES ('sbx-org-4','Fictional Records Department','department','08001','sbx-org-3','reports_to');
    INSERT INTO organization_county_affiliations (id, organization_id, county_fips, relationship_type)
    VALUES ('sbx-aff-1','sbx-org-2','08001','serves'),
           ('sbx-aff-2','sbx-org-2','08005','serves'),
           ('sbx-aff-3','sbx-org-6','08001','partner_for'),
           ('sbx-aff-4','sbx-org-7','08001','shared_service'),
           ('sbx-aff-5','sbx-org-7','08005','shared_service');
    INSERT INTO people (id, display_name)
    VALUES ('sbx-person-1','Fictional Person One'),
           ('sbx-person-2','Fictional Person Two'),
           ('sbx-person-3','Fictional Person Three'),
           ('sbx-person-4','Fictional Person One'),
           ('sbx-person-5','Fictional Person Five');
    INSERT INTO positions (id, organization_id, title)
    VALUES ('sbx-pos-1','sbx-org-1','Fictional Records Clerk'),
           ('sbx-pos-2','sbx-org-5','Fictional Records Analyst');
    INSERT INTO role_sources (id, url, title, source_type)
    VALUES ('sbx-src-1','https://example.invalid/sandbox-source-1','Fictional source one','other_public'),
           ('sbx-src-2','https://example.invalid/sandbox-source-2','Fictional source two','other_public');
    INSERT INTO person_roles (id, person_id, position_id, source_id, source_checked_at)
    VALUES ('sbx-role-1','sbx-person-1','sbx-pos-1','sbx-src-1','2026-01-01'),
           ('sbx-role-2','sbx-person-4','sbx-pos-2','sbx-src-2','2026-01-01');
  `);
}

const SAMPLE_BODY = [
  "## Overview",
  "",
  "This is **fictional** sandbox text with *emphasis* and a",
  "[sample link](https://example.invalid/sandbox).",
  "",
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod",
  "tempor incididunt ut labore et dolore magna aliqua.",
  "",
  "- First point",
  "- Second point",
  "",
  "> A fictional quotation for preview testing.",
  "",
  "Inline `code` is supported.",
].join("\n");

async function seedContent(
  database: WebsiteDatabase,
  service: ReturnType<typeof createContentService>,
): Promise<void> {
  const adapter = createTestHumanIdentityAdapter(SUBJECTS);
  const as = async (key: keyof typeof SUBJECTS) => {
    const principal = await resolvePrincipal(
      database,
      new Request("http://sandbox.invalid", {
        headers: { [SANDBOX_ACCOUNT_HEADER]: key },
      }),
      adapter,
    );
    if (!principal) throw new Error("Sandbox seed account is unavailable");
    return principal;
  };
  const author = await as("author");
  const editor = await as("editor");

  const ids: string[] = [];
  for (let index = 1; index <= 14; index += 1) {
    const isPost = index % 2 === 1;
    const created = service.createDraft(author, {
      contentType: isPost ? "post" : "story",
      title: `${isPost ? "Fictional Post" : "Fictional Story"} ${index}`,
      summary: `Sandbox ${isPost ? "post" : "story"} number ${index}. Lorem ipsum dolor sit amet.`,
      body: `${SAMPLE_BODY}\n\nItem number ${index}.`,
      relationships:
        index % 3 === 0
          ? {
              countyFips: ["08001"],
              personIds: ["sbx-person-1"],
              organizationIds: ["sbx-org-1"],
            }
          : { countyFips: [], personIds: [], organizationIds: [] },
    });
    ids.push(created.id);
  }
  // A few edits so revision history has something to show.
  const first = ids[0];
  if (first) {
    let current = service.getDraft(author, first);
    if (current) {
      current = service.updateDraft(editor, first, current.version, {
        body: `${SAMPLE_BODY}\n\nSecond edit by the sandbox editor.`,
      });
      current = service.updateDraft(author, first, current.version, {
        title: "Fictional Post 1 (revised)",
      });
    }
  }
  // Two archived items.
  for (const id of [ids[3], ids[7]]) {
    if (!id) continue;
    const current = service.getDraft(author, id);
    if (current) service.archiveDraft(author, id, current.version);
  }
}

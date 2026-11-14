import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../dist/application.js";
import { StorageUnavailableError } from "../dist/contracts/storage.js";
import { migrateWebsiteDatabase } from "../dist/database/migrations.js";
import { openWebsiteDatabase } from "../dist/database/sqlite.js";
import { createServices } from "../dist/services/index.js";
import { citation } from "../dist/site/components.js";
import { formatStoredDate } from "../dist/site/format.js";
import { html, safeExternalUrl } from "../dist/site/html.js";
import { createPublicSite, createWebsite } from "../dist/site/index.js";
import {
  FIXED_NOW,
  get,
  getEnhanced,
  siteAssets,
  withPreview,
} from "./site-fixtures.mjs";

const PAGES = [
  "/",
  "/counties",
  "/counties/08001",
  "/people",
  "/people?query=fictional",
  "/people/demo-person-jordan-a",
  "/officials",
  "/officials?county=08069",
  "/officials?county=08069&directoryView=structure",
  "/officials?directoryView=structure",
  "/officials?county=08005",
  "/officials?q=zzzz",
  "/organizations?query=fictional",
  "/organizations/demo-adams-works",
  "/stories",
  "/stories/fictional-road-budget-review",
  "/posts",
  "/about",
  "/reading-records",
  "/missing",
];

test("hostile stored content is rendered as inert text", async () => {
  await withPreview("empty", async (preview) => {
    const script = "<script>window.pwned=1</script>";
    const attribute = `"><img src=x onerror="window.pwned=1">`;
    preview.database
      .prepare(
        "INSERT INTO organizations (id,name,organization_type,county_fips) VALUES (?,?,?,?)",
      )
      .run("evil-org", `Evil ${attribute} Org`, "office", "08001");
    preview.database
      .prepare("INSERT INTO people (id,display_name) VALUES (?,?)")
      .run("evil-person", `Evil ${script} Person`);
    preview.database
      .prepare(
        "INSERT INTO positions (id,organization_id,title) VALUES (?,?,?)",
      )
      .run("evil-pos", "evil-org", `Title ${script}`);
    preview.database
      .prepare(
        "INSERT INTO role_sources (id,url,title,source_type) VALUES (?,?,?,?)",
      )
      .run(
        "evil-src",
        "https://user:secret@example.invalid/x",
        `Source ${attribute}`,
        "other_public",
      );
    preview.database
      .prepare(
        "INSERT INTO role_sources (id,url,title,source_type) VALUES (?,?,?,?)",
      )
      .run(
        "odd-src",
        `https://example.invalid/a"onmouseover="x`,
        "Odd source",
        "official_page",
      );
    preview.database
      .prepare(
        "INSERT INTO person_roles (id,person_id,position_id,source_id,start_date,source_checked_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        "evil-role",
        "evil-person",
        "evil-pos",
        "evil-src",
        "<b>soon</b>",
        "2026-01-01",
      );
    preview.database
      .prepare(
        "INSERT INTO person_roles (id,person_id,position_id,source_id,source_checked_at) VALUES (?,?,?,?,?)",
      )
      .run("odd-role", "evil-person", "evil-pos", "odd-src", "2026-01-01");

    for (const path of [
      "/counties/08001",
      "/people?query=Evil",
      "/people/evil-person",
      "/organizations?query=Evil",
      "/organizations/evil-org",
      `/people?query=${encodeURIComponent(script)}`,
      `/counties?q=${encodeURIComponent(attribute)}`,
    ]) {
      const page = await get(preview, path);
      assert.equal(page.status, 200, path);
      assert.equal(page.$$("script").length, 1, path);
      assert.equal(page.$("script").getAttribute("src"), "/assets/site.js");
      assert.ok(
        page
          .$$("img")
          .every((img) => img.getAttribute("src").startsWith("/assets/brand-")),
        path,
      );
      assert.equal(
        page.$$("[onerror],[onmouseover],[onclick],[onload]").length,
        0,
        path,
      );
      assert.doesNotMatch(page.text, /<script>window\.pwned/, path);
    }
    const profile = await get(preview, "/people/evil-person");
    assert.equal(profile.$("h1").textContent, `Evil ${script} Person`);
    assert.match(profile.main(), /<b>soon<\/b>/);
    // A stored address with credentials is never rendered as a link.
    assert.match(profile.main(), /link withheld/);
    assert.equal(profile.$$('a[href*="secret"]').length, 0);
    for (const link of profile.$$(".citation a")) {
      assert.match(link.getAttribute("href"), /^https:\/\/example\.invalid\//);
    }
  });
});

test("link and date helpers refuse unsafe or uninterpretable values", () => {
  for (const value of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>1</script>",
    "vbscript:x",
    "/relative",
    "//example.invalid/x",
    "ftp://example.invalid/x",
    "https://user@example.invalid/",
    "",
    "not a url",
    `https://example.invalid/${"a".repeat(3000)}`,
  ]) {
    assert.equal(safeExternalUrl(value), null, value);
  }
  assert.equal(
    safeExternalUrl("https://example.invalid/a b"),
    "https://example.invalid/a%20b",
  );
  const withheld = citation({ title: "T", url: "javascript:alert(1)" }).value;
  assert.doesNotMatch(withheld, /href/);
  assert.match(withheld, /link withheld/);
  assert.equal(
    html`<p title="${'"><x'}">${"<&>"}</p>`.value,
    '<p title="&quot;&gt;&lt;x">&lt;&amp;&gt;</p>',
  );

  assert.equal(formatStoredDate("2026-10-02"), "October 2, 2026");
  assert.equal(formatStoredDate("2026-10-02T00:00:00Z"), "October 2, 2026");
  assert.equal(formatStoredDate("2026-10"), "October 2026");
  assert.equal(formatStoredDate("2026"), "2026");
  assert.equal(formatStoredDate("2026-13-01"), "2026-13-01");
  assert.equal(formatStoredDate("sometime"), "sometime");
});

test("responses carry security headers and the site is read-only", async () => {
  await withPreview("fictional", async (preview) => {
    const page = await get(preview, "/");
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.doesNotMatch(page.text, /\sstyle="/);
    assert.doesNotMatch(page.text, /<style/);

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await get(preview, "/people", { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
    const head = await preview.fetch(
      new Request("http://127.0.0.1:8790/counties", { method: "HEAD" }),
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const css = await get(preview, "/assets/site.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    const js = await get(preview, "/assets/site.js");
    assert.match(js.headers.get("content-type"), /javascript/);
    for (const name of [
      "favicon-light.png",
      "favicon-dark.png",
      "brand-logo-white.png",
    ]) {
      const image = await preview.fetch(
        new Request(`http://127.0.0.1:8790/assets/${name}`),
      );
      assert.equal(image.status, 200, name);
      assert.equal(image.headers.get("content-type"), "image/png");
      const bytes = new Uint8Array(await image.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], name);
    }
    for (const path of [
      "/assets/../package.json",
      "/assets/%2e%2e%2fpackage.json",
      "/assets/other.css",
      "/assets/site.css.map",
    ]) {
      assert.equal((await get(preview, path)).status, 404, path);
    }
    assert.equal(
      (await get(preview, `/people?query=${"a".repeat(101)}`)).status,
      400,
    );
    assert.equal(
      (await get(preview, `/people?query=ab&cursor=${"a".repeat(2000)}`))
        .status,
      404,
    );
  });
});

test("service failures become clear error pages", async () => {
  const failing = (error) =>
    createPublicSite({
      assets: siteAssets(),
      now: FIXED_NOW,
      services: new Proxy(
        {},
        {
          get: () => () => {
            throw error;
          },
        },
      ),
    });
  const unavailable = await get(
    failing(new StorageUnavailableError()),
    "/counties",
  );
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.main(), /temporarily unavailable/);
  assert.ok(unavailable.$("#site-nav"));
  const broken = await get(
    failing(new Error("secret detail")),
    "/people?query=ab",
  );
  assert.equal(broken.status, 500);
  assert.match(broken.main(), /Something went wrong/);
  assert.doesNotMatch(broken.text, /secret detail/);
  // A site with no database at all (as in the current Worker) degrades the same way.
  const noDatabase = createPublicSite({
    assets: siteAssets(),
    services: createServices(),
  });
  assert.equal((await get(noDatabase, "/")).status, 503);
  assert.equal((await get(noDatabase, "/about")).status, 200);
});

test("existing public APIs are unchanged behind the composed website", async () => {
  const database = await openWebsiteDatabase();
  try {
    migrateWebsiteDatabase(database);
    const services = createServices({ database });
    const application = createApplication(services);
    const website = createWebsite({
      application,
      site: createPublicSite({ services, assets: siteAssets() }),
    });
    for (const [path, init] of [
      ["/api/counties/08001", {}],
      ["/api/counties/08001/organizations", {}],
      ["/api/counties/08001/roles?limit=5", {}],
      ["/api/counties/99999", {}],
      ["/api/people?query=ab", {}],
      ["/api/people?query=a", {}],
      ["/api/people/unknown", {}],
      ["/api/organizations?query=ab", {}],
      ["/api/organizations/unknown", {}],
      ["/api/organizations/unknown/roles", {}],
      ["/api/unknown", {}],
      ["/api/accounts", { method: "POST" }],
      ["/_internal/live", {}],
      ["/_internal/ready", {}],
      ["/internal/sync/batches/lookup", {}],
    ]) {
      const direct = await application.fetch(
        new Request(`https://watchdog.test${path}`, init),
      );
      const composed = await website.fetch(
        new Request(`https://watchdog.test${path}`, init),
      );
      assert.equal(composed.status, direct.status, path);
      assert.equal(
        composed.headers.get("content-type"),
        direct.headers.get("content-type"),
        path,
      );
      assert.equal(await composed.text(), await direct.text(), path);
    }
    // The application itself still has no HTML routes.
    const root = await application.fetch(new Request("https://watchdog.test/"));
    assert.equal(root.status, 404);
    assert.deepEqual(await root.json(), { error: "not_found" });
    assert.equal(services.listCounties().length, 64);
  } finally {
    database.close();
  }
});

test("mobile navigation toggles and closes with Escape", async () => {
  await withPreview("fictional", async (preview) => {
    const plain = await get(preview, "/");
    // Without JavaScript the toggle stays hidden and the navigation is visible.
    assert.equal(plain.$(".nav-toggle").hidden, true);

    const page = await getEnhanced(preview, "/");
    const toggle = page.$(".nav-toggle");
    const nav = page.$("#site-nav");
    assert.equal(toggle.tagName, "BUTTON");
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.getAttribute("aria-controls"), "site-nav");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(nav.classList.contains("is-open"), false);
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(nav.classList.contains("is-open"), true);
    page.key("Escape");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(nav.classList.contains("is-open"), false);
    assert.equal(page.document.activeElement, toggle);
    toggle.click();
    toggle.click();
    assert.equal(nav.classList.contains("is-open"), false);
  });
});

test("every page family is keyboard accessible and semantically structured", async () => {
  for (const data of ["fictional", "empty"])
    await withPreview(data, async (preview) => {
      for (const path of PAGES) {
        const page = await get(preview, path);
        assert.equal(page.document.documentElement.lang, "en", path);
        assert.ok(page.$("title").textContent.length > 0, path);
        assert.equal(page.$$("h1").length, 1, path);
        assert.equal(page.$$("main").length, 1, path);
        assert.ok(
          page.$("header.site-header") && page.$("footer.site-footer"),
          path,
        );

        // The skip link is the first focusable element and targets main.
        const focusable = page.$$(
          "a[href], button, input, select, textarea, [tabindex]",
        );
        assert.equal(focusable[0].className, "skip-link", path);
        assert.equal(focusable[0].getAttribute("href"), "#main", path);
        assert.equal(page.$("#main").tagName, "MAIN", path);
        assert.ok(
          !page
            .$$("[tabindex]")
            .some((el) => Number(el.getAttribute("tabindex")) > 0),
          path,
        );

        // Controls are native elements with accessible names.
        assert.equal(
          page.$$("[role=button], [role=link], div[onclick]").length,
          0,
          path,
        );
        for (const input of page.$$("input:not([type=hidden]), select")) {
          assert.ok(page.$(`label[for="${input.id}"]`), `${path} #${input.id}`);
          const described = input.getAttribute("aria-describedby");
          if (described)
            assert.ok(page.document.getElementById(described), path);
        }
        for (const control of page.$$("a[href], button")) {
          assert.ok(
            control.textContent.trim().length > 0,
            `${path} ${control.outerHTML}`,
          );
        }
        for (const nav of page.$$("nav")) {
          assert.ok(nav.getAttribute("aria-label"), path);
        }
        for (const labelled of page.$$("[aria-labelledby]")) {
          assert.ok(
            page.document.getElementById(
              labelled.getAttribute("aria-labelledby"),
            ),
            path,
          );
        }
        const ids = page.$$("[id]").map((el) => el.id);
        assert.equal(new Set(ids).size, ids.length, `${path} duplicate ids`);
        // Heading levels never skip.
        let previous = 0;
        for (const heading of page.$$("h1, h2, h3, h4")) {
          const level = Number(heading.tagName.slice(1));
          assert.ok(
            level <= previous + 1,
            `${path} ${heading.tagName} ${heading.textContent}`,
          );
          previous = level;
        }
      }
      if (data === "empty") return;
      const section = await get(preview, "/people/demo-person-jordan-a");
      assert.equal(
        section.$("#site-nav a[aria-current]").textContent,
        "Officials",
      );
      assert.equal(
        section.$(".breadcrumbs [aria-current=page]").textContent,
        "Jordan Example (fictional)",
      );
    });
});

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createBannerAdminClient } from "../dist/editor/banner-admin-client.js";
import { createBannersView } from "../dist/editor/banner-views.js";
import { mountDashboard } from "../dist/editor/dashboard.js";
import { createDashboardClient } from "../dist/editor/dashboard-client.js";
import { accountView, overviewView } from "../dist/editor/dashboard-views.js";
import { bannerAdminFixtures } from "./d1/banner-admin-fixtures.mjs";

const bytesOf = (fixture) =>
  new Uint8Array(Buffer.from(fixture.base64, "base64"));

import {
  ORIGIN,
  sandboxFetch,
  startSandbox,
  waitFor,
} from "./editor-fixtures.mjs";

const ACCOUNTS = [
  { key: "author", label: "Avery Author (editor)" },
  { key: "readonly", label: "Riley Reader (contributor)" },
  { key: "admin", label: "Ada Administrator (administrator)" },
  { key: "owner", label: "Olive Owner (owner)" },
  { key: "anonymous", label: "Signed-out visitor" },
];

/** Mounts the real dashboard shell with the banners view over the real sandbox. */
async function mountBanners({
  account = "admin",
  hash = "#/banners",
  hook,
} = {}) {
  const sandbox = await startSandbox();
  const dom = new JSDOM("<!doctype html><body><div id=app></div></body>", {
    url: `${ORIGIN}/${hash}`,
  });
  const { window } = dom;
  const session = { account };
  const calls = [];
  const connection = {
    fetch: sandboxFetch(sandbox, (call) => {
      calls.push(call);
      return hook?.(call);
    }),
    token: sandbox.token,
    account: () => session.account,
  };
  let previewCount = 0;
  const dashboard = mountDashboard(window.document.getElementById("app"), {
    doc: window.document,
    client: createDashboardClient(connection),
    publicSiteUrl: null,
    views: {
      overview: overviewView,
      account: accountView,
      banners: createBannersView({
        client: createBannerAdminClient(connection),
        createPreviewUrl: (_bytes, _mediaType) =>
          `blob:preview-${++previewCount}-${_mediaType}-${_bytes.byteLength}`,
        revokePreviewUrl: () => {},
      }),
    },
    sandbox: {
      accounts: ACCOUNTS,
      current: () => session.account,
      switchTo: (key) => {
        session.account = key;
      },
    },
  });
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const text = (selector) => $(selector)?.textContent ?? "";
  return {
    sandbox,
    window,
    session,
    calls,
    $,
    $$,
    text,
    nav: () => $$("#dash-sidebar a[data-view]").map((a) => a.textContent),
    go: (target) => {
      window.location.hash = target;
    },
    type(element, value) {
      element.value = value;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    click(target) {
      const element = typeof target === "string" ? $(target) : target;
      if (!element) throw new Error(`Missing element: ${target}`);
      element.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    },
    change(element) {
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    chooseFile(selector, bytes, name, type = "image/png") {
      const input = $(selector);
      const file = new window.File([bytes], name, { type });
      Object.defineProperty(input, "files", {
        value: [file],
        configurable: true,
      });
      this.change(input);
      return file;
    },
    live: () => $('[aria-live="polite"]')?.textContent ?? "",
    notice: () => $(".dash-notice")?.textContent ?? "",
    switchAccount(key) {
      const select = $("#sandbox-account");
      select.value = key;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    close() {
      dashboard.destroy();
      window.close();
      sandbox.close();
    },
  };
}

const openCounty = async (d, fips, name) => {
  d.type(d.$("#banner-county-query"), fips);
  d.click("#banner-county-submit");
  await waitFor(
    () => new RegExp(`${name} \\(${fips}\\)`).test(d.text("#banner-counties")),
    `county ${fips} listed`,
  );
  d.click(`button.banner-county-open[data-fips="${fips}"]`);
  return waitFor(() => d.$("#banner-county"), "county detail");
};

const stageInput = (
  d,
  _fips,
  id,
  bytes,
  name,
  type = "image/png",
  order = "0",
) => {
  d.type(d.$("#banner-new-id"), id);
  d.chooseFile("#banner-new-file", bytes, name, type);
  d.type(d.$("#banner-new-alt"), `Alt text for ${id}`);
  d.type(d.$("#banner-new-caption"), `Caption for ${id}`);
  d.type(d.$("#banner-new-order"), order);
  d.click("#banner-new-stage");
  return waitFor(
    () => d.$(`#banner-staged-image-${id}`),
    `staged preview for ${id}`,
  );
};

const publishStaged = async (d, id, countyName) => {
  d.type(d.$(`#banner-alt-${id}`), `Published alt for ${id}`);
  d.click(`#banner-publish-${id}`);
  await waitFor(() => d.$(`#banner-confirm-${id}`), "confirm panel");
  assert.match(d.text(`#banner-confirm-${id}`), new RegExp(countyName));
  assert.match(d.text(`#banner-confirm-${id}`), new RegExp(id));
  assert.match(d.text(`#banner-confirm-${id}`), /local sandbox/);
  // Keyboard continuity: focus moves into the confirmation, not to the page.
  assert.equal(
    d.$(`#banner-confirm-${id}`).ownerDocument.activeElement?.id,
    `banner-confirm-no-${id}`,
  );
  d.click(`#banner-confirm-yes-${id}`);
  return waitFor(() => /Published\./.test(d.notice()), "published notice");
};

test("an administrator can find counties, stage a new banner and publish it", async () => {
  const fixtures = bannerAdminFixtures();
  const d = await mountBanners();
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    assert.ok(d.nav().includes("Banners"));

    d.type(d.$("#banner-county-query"), "Adams");
    d.click("#banner-county-submit");
    await waitFor(() => d.$("#banner-counties"), "county results");
    assert.match(d.text("#banner-counties"), /Adams \(08001\)/);

    d.type(d.$("#banner-county-query"), "08005");
    d.click("#banner-county-submit");
    await waitFor(
      () => /Arapahoe \(08005\)/.test(d.text("#banner-counties")),
      "FIPS search",
    );

    await openCounty(d, "08001", "Adams");
    assert.ok(d.$("#banner-county-empty"));
    assert.ok(d.$("#banner-new"));

    const staged = await stageInput(
      d,
      "08001",
      "test-banner",
      bytesOf(fixtures.pngA),
      "fixture-a.png",
    );
    assert.match(staged.getAttribute("src"), /^blob:preview-/);
    const imageCalls = d.calls.filter((call) =>
      call.path.startsWith("/api/admin/banners/versions/"),
    );
    assert.ok(imageCalls.length >= 1);

    await publishStaged(d, "test-banner", "Adams");

    const banner = d.sandbox.database
      .prepare("SELECT * FROM banner_assets WHERE id = 'test-banner'")
      .get();
    assert.equal(banner.status, "active");
    assert.ok(banner.selected_version_id);
    assert.equal(banner.alt_text, "Published alt for test-banner");
    const publications = d.sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM banner_publications WHERE banner_id = 'test-banner'",
      )
      .get().n;
    assert.equal(publications, 1);
    assert.match(d.text("#banner-test-banner"), /Public/);
  } finally {
    d.close();
  }
});

test("replace, details edit, reorder, withdraw and restore keep a full history", async () => {
  const fixtures = bannerAdminFixtures();
  const d = await mountBanners();
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    await openCounty(d, "08001", "Adams");
    await stageInput(
      d,
      "08001",
      "test-banner",
      bytesOf(fixtures.pngA),
      "a.png",
    );
    await publishStaged(d, "test-banner", "Adams");
    const firstPublication = d.sandbox.database
      .prepare(
        "SELECT id, version_id, caption FROM banner_publications WHERE banner_id = 'test-banner' ORDER BY sequence LIMIT 1",
      )
      .get();
    assert.ok(firstPublication);
    const firstVersion = d.sandbox.database
      .prepare(
        "SELECT selected_version_id AS id FROM banner_assets WHERE id = 'test-banner'",
      )
      .get().id;

    const before =
      d.$("#banner-staged-image-test-banner")?.getAttribute("src") ?? "";
    d.chooseFile("#banner-file-test-banner", bytesOf(fixtures.pngB), "b.png");
    await waitFor(
      () =>
        (d.$("#banner-staged-image-test-banner")?.getAttribute("src") ?? "") !==
        before,
      "replacement staged",
    );
    await publishStaged(d, "test-banner", "Adams");
    const secondVersion = d.sandbox.database
      .prepare(
        "SELECT selected_version_id AS id FROM banner_assets WHERE id = 'test-banner'",
      )
      .get().id;
    assert.notEqual(secondVersion, firstVersion);

    d.click("#banner-details-test-banner");
    await waitFor(
      () => d.$(`#banner-detail-caption-test-banner`),
      "details form",
    );
    d.type(d.$("#banner-detail-caption-test-banner"), "Edited caption");
    d.click("#banner-detail-save-test-banner");
    await waitFor(() => /Details saved\./.test(d.notice()), "details saved");
    assert.equal(
      d.sandbox.database
        .prepare("SELECT caption FROM banner_assets WHERE id = 'test-banner'")
        .get().caption,
      "Edited caption",
    );
    assert.notEqual(firstPublication.caption, "Edited caption");

    await stageInput(
      d,
      "08001",
      "test-banner-2",
      bytesOf(fixtures.pngC),
      "c.png",
      "image/png",
      "1",
    );
    await publishStaged(d, "test-banner-2", "Adams");
    assert.ok(d.$("#banner-move-down-test-banner"));
    d.click("#banner-move-down-test-banner");
    d.click("#banner-order-save");
    await waitFor(
      () => /Display order saved\./.test(d.notice()),
      "order saved",
    );
    const orders = d.sandbox.database
      .prepare(
        "SELECT id, display_order FROM banner_assets WHERE county_fips = '08001' ORDER BY display_order",
      )
      .all();
    assert.deepEqual(
      orders.map((row) => row.id),
      ["test-banner-2", "test-banner"],
    );

    d.click("#banner-withdraw-test-banner");
    await waitFor(() => d.$("#banner-confirm-test-banner"), "withdraw confirm");
    assert.match(d.text("#banner-confirm-test-banner"), /Withdraw/);
    d.click("#banner-confirm-yes-test-banner");
    await waitFor(
      () => /Withdrawn from public view\./.test(d.notice()),
      "withdrawn",
    );
    assert.equal(
      d.sandbox.database
        .prepare("SELECT status FROM banner_assets WHERE id = 'test-banner'")
        .get().status,
      "withdrawn",
    );

    await waitFor(() => d.$("#banner-history-test-banner"), "history");
    const restore = d
      .$$("#banner-history-test-banner button.banner-restore[data-publication]")
      .find(
        (button) =>
          button.getAttribute("data-publication") === firstPublication.id,
      );
    assert.ok(restore);
    d.click(restore);
    await waitFor(
      () =>
        d.$(`#banner-confirm-test-banner`) &&
        /Restore the recorded publication/.test(
          d.text("#banner-confirm-test-banner"),
        ),
      "restore confirm",
    );
    d.click("#banner-confirm-yes-test-banner");
    await waitFor(() => /Restored\./.test(d.notice()), "restored");
    assert.equal(
      d.sandbox.database
        .prepare("SELECT status FROM banner_assets WHERE id = 'test-banner'")
        .get().status,
      "active",
    );
    const restored = d.sandbox.database
      .prepare(
        "SELECT origin, restored_from_publication_id, version_id, caption FROM banner_publications WHERE banner_id = 'test-banner' ORDER BY sequence DESC LIMIT 1",
      )
      .get();
    assert.equal(restored.origin, "restore_recorded");
    assert.equal(restored.restored_from_publication_id, firstPublication.id);
    assert.equal(restored.version_id, firstPublication.version_id);
    assert.equal(restored.caption, firstPublication.caption);
    const restoredBanner = d.sandbox.database
      .prepare(
        "SELECT selected_version_id, caption FROM banner_assets WHERE id = 'test-banner'",
      )
      .get();
    assert.equal(
      restoredBanner.selected_version_id,
      firstPublication.version_id,
    );
    assert.equal(restoredBanner.caption, firstPublication.caption);
  } finally {
    d.close();
  }
});

test("a stale version keeps the typed edits and recovers after refresh", async () => {
  const fixtures = bannerAdminFixtures();
  const d = await mountBanners();
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    await openCounty(d, "08001", "Adams");
    await stageInput(
      d,
      "08001",
      "test-banner",
      bytesOf(fixtures.pngA),
      "a.png",
    );
    await publishStaged(d, "test-banner", "Adams");

    d.chooseFile("#banner-file-test-banner", bytesOf(fixtures.pngB), "b.png");
    await waitFor(
      () => d.$("#banner-staged-image-test-banner"),
      "staged again",
    );
    d.type(d.$(`#banner-alt-test-banner`), "Edited during conflict");

    d.sandbox.database
      .prepare("UPDATE banner_assets SET version = version + 1 WHERE id = ?")
      .run("test-banner");

    d.click(`#banner-publish-test-banner`);
    await waitFor(() => d.$("#banner-confirm-test-banner"), "confirm");
    d.click(`#banner-confirm-yes-test-banner`);
    await waitFor(() => d.$(`#banner-conflict-test-banner`), "conflict panel");
    assert.match(
      d.text(`#banner-conflict-test-banner`),
      /Another change was saved first/,
    );
    assert.equal(
      d.$(`#banner-alt-test-banner`).value,
      "Edited during conflict",
    );
    const publications = d.sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM banner_publications WHERE banner_id = 'test-banner'",
      )
      .get().n;
    assert.equal(publications, 1);

    d.click(`#banner-conflict-refresh-test-banner`);
    await waitFor(
      () =>
        /Current state is shown/.test(d.text(`#banner-conflict-test-banner`)),
      "refreshed",
    );
    d.click(`#banner-publish-test-banner`);
    await waitFor(() => d.$("#banner-confirm-test-banner"), "confirm again");
    d.click(`#banner-confirm-yes-test-banner`);
    await waitFor(
      () => /Published\./.test(d.notice()),
      "published after refresh",
    );
    assert.equal(
      d.sandbox.database
        .prepare(
          "SELECT COUNT(*) AS n FROM banner_publications WHERE banner_id = 'test-banner'",
        )
        .get().n,
      2,
    );
  } finally {
    d.close();
  }
});

test("a failed stage retries with the same idempotency key and does not duplicate", async () => {
  const fixtures = bannerAdminFixtures();
  let stageCalls = 0;
  const keys = [];
  const d = await mountBanners({
    hook: (call) => {
      if (!call.path.endsWith("/stage")) return undefined;
      stageCalls += 1;
      const header = call.init.headers["x-banner-stage"];
      if (header) {
        keys.push(JSON.parse(Buffer.from(header, "base64url").toString()));
      }
      if (stageCalls === 2) {
        return new Response(JSON.stringify({ error: "storage_failed" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return undefined;
    },
  });
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    await openCounty(d, "08001", "Adams");
    await stageInput(
      d,
      "08001",
      "test-banner",
      bytesOf(fixtures.pngA),
      "a.png",
    );
    await publishStaged(d, "test-banner", "Adams");

    d.chooseFile("#banner-file-test-banner", bytesOf(fixtures.pngB), "b.png");
    await waitFor(() => d.$("#banner-retry-test-banner"), "retry affordance");

    d.click("#banner-retry-test-banner");
    await waitFor(
      () => d.$("#banner-staged-image-test-banner"),
      "staged after retry",
    );
    assert.equal(keys.length, 3);
    assert.equal(keys[1].idempotencyKey, keys[2].idempotencyKey);
    assert.equal(keys[2].bannerId, "test-banner");
    const versions = d.sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM banner_asset_versions WHERE banner_id = 'test-banner'",
      )
      .get().n;
    assert.equal(versions, 2);
  } finally {
    d.close();
  }
});

test("a lost new-banner stage response retries with the same key and recovers the committed version", async () => {
  const fixtures = bannerAdminFixtures();
  let stageCalls = 0;
  const payloads = [];
  const d = await mountBanners({
    hook: (call) => {
      if (!call.path.endsWith("/stage")) return undefined;
      stageCalls += 1;
      const header = call.init.headers["x-banner-stage"];
      const payload = header
        ? JSON.parse(Buffer.from(header, "base64url").toString())
        : null;
      if (stageCalls === 1) {
        return (async () => {
          const response = await d.sandbox.fetch(
            new Request(`${ORIGIN}${call.path}`, {
              method: call.init.method,
              headers: call.init.headers,
              body: call.init.body,
            }),
          );
          await response.arrayBuffer();
          payloads.push(payload);
          throw new TypeError("Failed to fetch");
        })();
      }
      payloads.push(payload);
      if (stageCalls === 3) {
        return new Response(JSON.stringify({ error: "storage_failed" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return undefined;
    },
  });
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    await openCounty(d, "08001", "Adams");

    d.type(d.$("#banner-new-id"), "test-banner");
    d.chooseFile("#banner-new-file", bytesOf(fixtures.pngA), "a.png");
    d.type(d.$("#banner-new-alt"), "Alt text for test-banner");
    d.type(d.$("#banner-new-caption"), "Caption for test-banner");
    d.click("#banner-new-stage");

    await waitFor(() => d.$("#banner-new-retry"), "retained retry affordance");
    assert.match(d.live(), /The server could not be reached\./);

    const committed = d.sandbox.database
      .prepare(
        "SELECT id AS version FROM banner_asset_versions WHERE banner_id = 'test-banner'",
      )
      .all();
    assert.equal(committed.length, 1);
    const committedVersion = committed[0].version;

    d.click("#banner-new-retry");
    await waitFor(
      () => d.$("#banner-staged-image-test-banner"),
      "staged preview after retry",
    );
    assert.match(
      d.notice(),
      new RegExp(`Staged version ${committedVersion} for banner test-banner`),
    );

    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[1], payloads[0]);
    assert.equal(payloads[0].bannerId, "test-banner");
    assert.ok(payloads[0].idempotencyKey);

    const versions = d.sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM banner_asset_versions WHERE banner_id = 'test-banner'",
      )
      .get().n;
    assert.equal(versions, 1);
    const banners = d.sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM banner_assets WHERE id = 'test-banner'",
      )
      .get().n;
    assert.equal(banners, 1);

    d.type(d.$("#banner-new-id"), "test-banner-2");
    d.chooseFile("#banner-new-file", bytesOf(fixtures.pngB), "b.png");
    d.type(d.$("#banner-new-alt"), "Alt text for test-banner-2");
    d.type(d.$("#banner-new-order"), "1");
    d.click("#banner-new-stage");
    await waitFor(
      () => d.$("#banner-new-retry"),
      "retry affordance after storage failure",
    );
    assert.equal(payloads.length, 3);

    d.chooseFile("#banner-new-file", bytesOf(fixtures.pngB), "b.png");
    d.type(d.$("#banner-new-alt"), "Changed alt for test-banner-2");
    d.type(d.$("#banner-new-order"), "1");
    d.click("#banner-new-stage");
    await waitFor(
      () => d.$("#banner-staged-image-test-banner-2"),
      "staged preview for the changed submission",
    );
    assert.equal(payloads.length, 4);
    assert.notEqual(payloads[2].idempotencyKey, payloads[3].idempotencyKey);
    assert.equal(payloads[3].bannerId, "test-banner-2");
    assert.equal(
      payloads[3].target.metadata.altText,
      "Changed alt for test-banner-2",
    );
    assert.ok(!d.$("#banner-new-retry"));
    const secondVersions = d.sandbox.database
      .prepare(
        "SELECT COUNT(*) AS n FROM banner_asset_versions WHERE banner_id = 'test-banner-2'",
      )
      .get().n;
    assert.equal(secondVersions, 1);
  } finally {
    d.close();
  }
});

test("a missing stored image fails safely and reconcile reports it", async () => {
  const fixtures = bannerAdminFixtures();
  const d = await mountBanners();
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    await openCounty(d, "08001", "Adams");
    await stageInput(
      d,
      "08001",
      "test-banner",
      bytesOf(fixtures.pngA),
      "a.png",
    );

    const version = d.sandbox.database
      .prepare(
        "SELECT id, object_key FROM banner_asset_versions WHERE banner_id = 'test-banner' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    d.sandbox.bannerStorage.hideForTest(version.object_key);

    d.click(`button.banner-preview[data-version="${version.id}"]`);
    await waitFor(
      () => d.$(`#banner-staged-error-test-banner`),
      "staged error",
    );
    assert.match(
      d.text(`#banner-staged-error-test-banner`),
      /The stored image is missing or damaged/,
    );

    d.click(`#banner-reconcile-test-banner`);
    await waitFor(
      () =>
        /verified, but the stored image is missing/.test(
          d.text(`#banner-reconcile-report-test-banner`),
        ),
      "reconcile report",
    );
  } finally {
    d.close();
  }
});

test("banner access follows the live role matrix and stays private", async () => {
  const fixtures = bannerAdminFixtures();
  const d = await mountBanners();
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    await openCounty(d, "08001", "Adams");
    await stageInput(
      d,
      "08001",
      "test-banner",
      bytesOf(fixtures.pngA),
      "a.png",
    );
    await publishStaged(d, "test-banner", "Adams");
    const version = d.sandbox.database
      .prepare(
        "SELECT id FROM banner_asset_versions WHERE banner_id = 'test-banner' ORDER BY created_at DESC LIMIT 1",
      )
      .get();

    const as = (account) =>
      createBannerAdminClient({
        fetch: sandboxFetch(d.sandbox),
        token: d.sandbox.token,
        account: () => account,
      });

    await assert.rejects(
      () => as("readonly").listCounties({ limit: 5 }),
      (error) => error instanceof Error && /forbidden/.test(error.message),
    );
    await assert.rejects(
      () => as("readonly").versionImage(version.id),
      (error) => error instanceof Error && /forbidden/.test(error.message),
    );
    await assert.rejects(
      () => as("anonymous").listCounties({ limit: 5 }),
      (error) => error instanceof Error,
    );

    const publicDelivery = await d.sandbox.fetch(
      new Request(`${ORIGIN}/banner-assets/${version.id}`),
    );
    assert.equal(publicDelivery.status, 404);

    d.sandbox.database
      .prepare(
        "UPDATE accounts SET role = 'contributor', version = version + 1 WHERE id = 'sbx-admin'",
      )
      .run();
    d.session.account = "admin";
    await assert.rejects(
      () => as("admin").listCounties({ limit: 5 }),
      (error) => error instanceof Error && /forbidden/.test(error.message),
    );
  } finally {
    d.close();
  }
});

test("the banners view is keyboard operable and labelled", async () => {
  const d = await mountBanners();
  try {
    await waitFor(() => d.$("#banners-heading"), "banners view");
    assert.equal(
      d.$('label[for="banner-county-query"]').textContent.length > 0,
      true,
    );
    assert.equal(d.$("#banner-county-submit").tagName, "BUTTON");
    await openCounty(d, "08001", "Adams");
    for (const id of [
      "banner-new-id",
      "banner-new-file",
      "banner-new-caption",
      "banner-new-alt",
      "banner-new-order",
    ]) {
      assert.ok(d.$(`label[for="${id}"]`), id);
    }
    assert.equal(d.$("#banner-new-primary").getAttribute("type"), "checkbox");
    assert.equal(d.text("#banners-heading"), "Banners");
    assert.ok(d.$("h1#banners-heading"));
  } finally {
    d.close();
  }
});

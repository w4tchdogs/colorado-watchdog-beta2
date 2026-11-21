import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DASHBOARD_API_PATHS } from "../dist/contracts/dashboard.js";
import { createBannerAdminClient } from "../dist/editor/banner-admin-client.js";
import { createCountyStructureClient } from "../dist/editor/county-structure-client.js";
import { createProfilesClient } from "../dist/editor/profiles-client.js";
import { openDraftPreviewDatabase } from "../dist/editor-dev/draft-database.js";
import { readCsvTable } from "../dist/services/county-structure-csv.js";
import {
  createDraftSitePreview,
  createSitePreview,
} from "../dist/site-dev/preview.js";
import { bannerAdminFixtures } from "./d1/banner-admin-fixtures.mjs";
import { ORIGIN, startSandbox } from "./editor-fixtures.mjs";
import { buildProfilesWorkbook } from "./support/profiles-workbook.mjs";

const staticDirectory = fileURLToPath(
  new URL("../website/site/", import.meta.url),
);
const countyCsv = readFileSync(
  new URL("./fixtures/county-structure-example.csv.txt", import.meta.url),
  "utf8",
);

function clients(sandbox, account = "owner") {
  const fetch = (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", ORIGIN);
    headers.set("x-editor-token", sandbox.token);
    headers.set("x-test-human-subject", account);
    return sandbox.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
  };
  return {
    fetch,
    banners: createBannerAdminClient({ fetch }),
    profiles: createProfilesClient({ fetch }),
    structure: createCountyStructureClient({ fetch }),
    site: createDraftSitePreview(
      sandbox.database,
      staticDirectory,
      sandbox.bannerStorage,
    ),
  };
}

function requestPage(site, path) {
  return site.fetch(new Request(`http://127.0.0.1:8790${path}`));
}

test("the local owner can pin a fictional group and see it in the companion preview", async () => {
  const sandbox = await startSandbox();
  const site = await createSitePreview({
    staticDirectory,
    data: "fictional",
    countyStructure: sandbox.countyStructure,
  });
  try {
    const { structure } = clients(sandbox);
    const fips = "08001";
    const countyPath = `/counties/${fips}`;
    const before = await (await requestPage(site, countyPath)).text();
    assert.match(before, /Fictional Offices/);
    assert.doesNotMatch(before, /aria-label="Pinned right column"/);

    const layout = await structure.countyLayout(fips);
    const group = layout.availableGroups.find(
      ({ name }) => name === "Fictional Offices",
    );
    assert.ok(group);
    await assert.rejects(
      clients(sandbox, "readonly").structure.countyLayout(fips),
      { status: 403 },
    );
    await structure.saveCountyLayout(
      fips,
      {
        expectedVersion: layout.version,
        pinnedGroups: [{ groupId: group.id, column: "right", position: 1 }],
      },
      "preview-pin-fictional-offices",
    );
    const after = await (await requestPage(site, countyPath)).text();
    assert.match(
      after,
      /aria-label="Pinned right column">\s*<section[^>]*>\s*<h3[^>]*>Fictional Offices<\/h3>/,
    );
    assert.match(
      after,
      /class="county-structure-grid"[\s\S]*Fictional Services/,
    );
  } finally {
    site.close();
    sandbox.close();
  }
});

test("draft Profiles and County Structure workbooks and layout pins survive restart and share public visibility", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-draft-review-"));
  const start = () =>
    startSandbox({ draftDatabase: openDraftPreviewDatabase(directory) });
  const workbook = buildProfilesWorkbook({
    Profiles: [
      ["profile_id", "display_name"],
      ["draft-person", "Synthetic Draft Officer"],
    ],
    Roles: [
      ["role_id", "profile_id", "county_fips", "published_office"],
      ["draft-role", "draft-person", "08001", "Synthetic Recorder"],
      ["draft-second-role", "draft-person", "08003", "Synthetic Clerk"],
    ],
  }).toString("base64");
  let sandbox = await start();
  let personId;
  let pinnedGroup;
  try {
    const { profiles, structure, site, fetch } = clients(sandbox);
    assert.equal(
      (await (await fetch("/sandbox/info")).json()).draftReview,
      true,
    );
    assert.equal(
      sandbox.database.prepare("SELECT COUNT(*) AS n FROM people").get().n,
      0,
    );

    const { rows: countyRows } = readCsvTable(countyCsv);
    const countyWorkbook = buildProfilesWorkbook({
      "County Structure": countyRows,
    }).toString("base64");
    await assert.rejects(
      structure.prepare({
        fileName: "county.xlsx",
        csv: countyCsv,
        workbook: countyWorkbook,
        mode: "merge",
      }),
      { status: 400 },
    );
    const county = await structure.prepare({
      fileName: "county.xlsx",
      workbook: countyWorkbook,
      mode: "merge",
      countyFips: null,
    });
    assert.equal(county.committable, true);
    assert.equal(county.import.fileName, "county.xlsx");
    assert.equal(
      sandbox.database.prepare("SELECT COUNT(*) AS n FROM county_unit").get().n,
      0,
    );
    await structure.commit(
      county.import.id,
      {
        changesetSha256: county.import.changesetSha256,
        expectedVersion: (await structure.counties()).version,
      },
      "draft-preview-counties",
    );
    const layout = await structure.countyLayout("08001");
    const group = layout.availableGroups.find(
      ({ name }) => name === "Elected Official",
    );
    assert.ok(group);
    pinnedGroup = { groupId: group.id, column: "left", position: 1 };
    await structure.saveCountyLayout(
      "08001",
      { expectedVersion: layout.version, pinnedGroups: [pinnedGroup] },
      "draft-preview-pin-officials",
    );
    const planned = await profiles.importPreview({ workbook });
    assert.equal(planned.canCommit, true, JSON.stringify(planned.issues));
    await profiles.importCommit(
      { workbook },
      planned.digest,
      "draft-preview-profiles",
    );
    const page = await (await fetch("/api/admin/profiles/rows")).json();
    const [row] = page.rows;
    assert.equal(row.displayName, "Synthetic Draft Officer");
    assert.equal(row.visible, false);
    personId = row.profileId;
    assert.equal((await requestPage(site, `/people/${personId}`)).status, 404);
    const home = await requestPage(site, "/");
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /<dt>Colorado counties<\/dt><dd>64<\/dd>/);
    assert.match(homeHtml, /<dt>Departments and offices<\/dt><dd>7<\/dd>/);
    assert.match(
      homeHtml,
      /<dt>County officials and employees<\/dt><dd>0<\/dd>/,
    );
    const countyPage = await requestPage(site, "/counties/08001");
    assert.equal(countyPage.status, 200);
    const html = await countyPage.text();
    assert.match(html, /Private local draft review/);
    assert.match(html, /Patrol Division/);
    assert.doesNotMatch(
      html,
      /Synthetic evidence, line one|example.invalid\/sheriff/,
    );
    await profiles.save(
      [
        {
          kind: "visibility",
          personId,
          expectedVersion: row.visibilityVersion,
          visible: true,
        },
      ],
      "draft-preview-visible",
    );
    const person = await requestPage(site, `/people/${personId}`);
    assert.equal(person.status, 200);
    const personHtml = await person.text();
    assert.match(personHtml, /Synthetic Draft Officer/);
    assert.match(personHtml, /Synthetic Recorder/);
    const officials = await requestPage(
      site,
      "/officials?q=Synthetic+Draft+Officer",
    );
    assert.match(await officials.text(), /Synthetic Draft Officer/);
    assert.match(
      await (await requestPage(site, "/")).text(),
      /<dt>County officials and employees<\/dt><dd>1<\/dd>/,
    );
  } finally {
    sandbox.close();
  }

  sandbox = await start();
  try {
    const { fetch, structure, site } = clients(sandbox);
    const page = await (await fetch("/api/admin/profiles/rows")).json();
    assert.equal(page.rows[0].profileId, personId);
    assert.equal(page.rows[0].visible, true);
    assert.ok((await structure.county("08001")).counts.units > 0);
    assert.deepEqual((await structure.countyLayout("08001")).pinnedGroups, [
      pinnedGroup,
    ]);
    const countyHtml = await (
      await requestPage(site, "/counties/08001")
    ).text();
    assert.match(
      countyHtml,
      /aria-label="Pinned left column">\s*<section[^>]*>\s*<h3[^>]*>Elected Official<\/h3>/,
    );
    assert.equal((await requestPage(site, `/people/${personId}`)).status, 200);
  } finally {
    sandbox.close();
  }
});

test("large workbook previews and commits only in private draft review", async () => {
  const count = 4_000;
  const duties = "Synthetic office duty. ".repeat(84).trim();
  const profiles = [["profile_id", "display_name"]];
  const roles = [
    [
      "role_id",
      "profile_id",
      "county_fips",
      "job_description",
      "source_id",
      "source_url",
      "source_title",
      "publisher_classification",
      "source_type",
    ],
  ];
  for (let index = 1; index <= count; index++) {
    const profileId = `draft-profile-${index}`;
    profiles.push([profileId, `Synthetic Person ${index}`]);
    roles.push([
      `draft-role-${index}`,
      profileId,
      "08001",
      duties,
      "draft-source",
      "https://example.invalid/draft-source",
      "Synthetic Source",
      "official",
      "official_page",
    ]);
  }
  const workbook = buildProfilesWorkbook({
    Profiles: profiles,
    Roles: roles,
  }).toString("base64");
  const standard = await startSandbox();
  try {
    await assert.rejects(
      clients(standard).profiles.importPreview({ workbook }),
      /workbook's import data exceeds 4 MiB/,
    );
  } finally {
    standard.close();
  }
  const directory = mkdtempSync(join(tmpdir(), "watchdog-large-workbook-"));
  const draft = await startSandbox({
    draftDatabase: openDraftPreviewDatabase(directory),
  });
  try {
    const { profiles } = clients(draft);
    const preview = await profiles.importPreview({ workbook });
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    assert.equal(preview.profiles.add, count);
    assert.equal(preview.roles.add, count);
    assert.equal(
      draft.database.prepare("SELECT COUNT(*) AS n FROM people").get().n,
      0,
    );
    const receipt = await profiles.importCommit(
      { workbook },
      preview.digest,
      "draft-large-workbook",
    );
    assert.equal(receipt.newProfilesHidden, count);
    assert.equal(receipt.created.roles, count);
    assert.equal(receipt.created.sources, 0);
  } finally {
    draft.close();
  }
});

test("draft review refuses an existing SQLite file without its marker", () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-unmanaged-review-"));
  const path = join(directory, "website-draft.sqlite");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  database.close();
  const original = readFileSync(path);
  assert.throws(
    () => openDraftPreviewDatabase(directory),
    /not a Website draft preview/,
  );
  assert.deepEqual(readFileSync(path), original);
});

test("local banner bytes and publication survive restart with private preview and withdrawal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-draft-banner-"));
  const start = () =>
    startSandbox({ draftDatabase: openDraftPreviewDatabase(directory) });
  const { publishJpeg } = bannerAdminFixtures();
  const bytes = new Uint8Array(Buffer.from(publishJpeg.base64, "base64"));
  const bannerId = "synthetic-draft-banner";
  const caption = "Synthetic Adams draft banner caption";
  const altText = "Generated pattern for local review";
  const upload = {
    bannerId,
    countyFips: "08001",
    sourceFilename: "synthetic-draft-banner.jpg",
    mediaType: "image/jpeg",
    idempotencyKey: "local-banner-stage",
    metadata: {
      caption,
      altText,
      displayOrder: 0,
      isPrimary: true,
      displayMode: "cover",
      focalX: 0.5,
      focalY: 0.5,
    },
    bytes,
  };
  let staged;
  let sandbox = await start();
  try {
    const { banners, site, fetch } = clients(sandbox);
    const dashboard = await (await fetch(DASHBOARD_API_PATHS.session)).json();
    assert.ok(dashboard.modules.some((module) => module.id === "banners"));
    staged = await banners.stageNew(upload);
    assert.equal(staged.verified, true);
    assert.deepEqual(
      (await banners.versionImage(staged.version.id)).bytes,
      bytes,
    );
    const path = `/banner-assets/${staged.version.id}`;
    assert.equal((await requestPage(site, path)).status, 404);
    assert.doesNotMatch(
      await (await requestPage(site, "/counties/08001")).text(),
      /Synthetic Adams draft banner caption/,
    );
    const visitor = clients(sandbox, "anonymous");
    const privateImage = `/api/admin/banners/versions/${staged.version.id}/image`;
    assert.equal((await visitor.fetch(privateImage)).status, 401);
    assert.equal((await requestPage(site, privateImage)).status, 404);
  } finally {
    sandbox.close();
  }

  sandbox = await start();
  let published;
  try {
    const { banners, site } = clients(sandbox);
    const replay = await banners.stageNew(upload);
    assert.equal(replay.replayed, true);
    assert.equal(replay.version.id, staged.version.id);
    assert.equal(
      (await sandbox.bannerStorage.listKeys("banner-assets/")).length,
      1,
    );
    assert.deepEqual(
      (await banners.versionImage(staged.version.id)).bytes,
      bytes,
    );
    published = await banners.publish({
      bannerId,
      versionId: staged.version.id,
      expectedRowVersion: staged.bannerRowVersion,
      idempotencyKey: "local-banner-publish",
    });
    assert.equal(published.status, "active");
    const countyHtml = await (
      await requestPage(site, "/counties/08001")
    ).text();
    assert.ok(countyHtml.includes(caption));
    assert.ok(countyHtml.includes(altText));
    assert.ok((await (await requestPage(site, "/")).text()).includes(caption));
  } finally {
    sandbox.close();
  }

  sandbox = await start();
  try {
    const { banners, site } = clients(sandbox);
    const path = `/banner-assets/${staged.version.id}`;
    const image = await requestPage(site, path);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
    const result = await banners.withdraw(
      bannerId,
      published.rowVersion,
      "local-banner-withdraw",
    );
    assert.equal(result.status, "withdrawn");
    assert.equal((await requestPage(site, path)).status, 404);
    assert.ok((await banners.listPublications(bannerId)).length > 0);
    assert.deepEqual(
      (await banners.versionImage(staged.version.id)).bytes,
      bytes,
    );
  } finally {
    sandbox.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCountyStructureClient } from "../dist/editor/county-structure-client.js";
import { createProfilesClient } from "../dist/editor/profiles-client.js";
import { openDraftPreviewDatabase } from "../dist/editor-dev/draft-database.js";
import { createDraftSitePreview } from "../dist/site-dev/preview.js";
import { ORIGIN, startSandbox } from "./editor-fixtures.mjs";
import { buildProfilesWorkbook } from "./support/profiles-workbook.mjs";

const staticDirectory = fileURLToPath(
  new URL("../website/site/", import.meta.url),
);
const countyCsv = readFileSync(
  new URL("./fixtures/county-structure-example.csv.txt", import.meta.url),
  "utf8",
);

function clients(sandbox) {
  const fetch = (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", ORIGIN);
    headers.set("x-editor-token", sandbox.token);
    headers.set("x-test-human-subject", "owner");
    return sandbox.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
  };
  return {
    fetch,
    profiles: createProfilesClient({ fetch }),
    structure: createCountyStructureClient({ fetch }),
    site: createDraftSitePreview(sandbox.database, staticDirectory),
  };
}

test("draft workbook and county CSV survive restart and share public visibility", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-draft-review-"));
  const start = () =>
    startSandbox({ draftDatabase: openDraftPreviewDatabase(directory) });
  const requestPage = (site, path) =>
    site.fetch(new Request(`http://127.0.0.1:8790${path}`));
  const workbook = buildProfilesWorkbook({
    Profiles: [
      ["profile_id", "display_name"],
      ["draft-person", "Synthetic Draft Officer"],
    ],
    Roles: [
      [
        "role_id",
        "profile_id",
        "county_fips",
        "published_office",
        "source_id",
        "source_url",
        "source_title",
        "publisher_classification",
        "source_type",
      ],
      [
        "draft-role",
        "draft-person",
        "08001",
        "Synthetic Recorder",
        "draft-source",
        "https://example.invalid/draft-source",
        "Synthetic Source",
        "official",
        "official_page",
      ],
    ],
  }).toString("base64");
  let sandbox = await start();
  let personId;
  try {
    const { profiles, structure, site, fetch } = clients(sandbox);
    assert.equal(
      (await (await fetch("/sandbox/info")).json()).draftReview,
      true,
    );
    assert.equal((await fetch("/api/admin/banners/counties")).status, 404);
    assert.equal(
      sandbox.database.prepare("SELECT COUNT(*) AS n FROM people").get().n,
      0,
    );

    const county = await structure.prepare({
      fileName: "county.csv",
      csv: countyCsv,
      mode: "merge",
      countyFips: null,
    });
    assert.equal(county.committable, true);
    await structure.commit(
      county.import.id,
      {
        changesetSha256: county.import.changesetSha256,
        expectedVersion: (await structure.counties()).version,
      },
      "draft-preview-counties",
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
    assert.match(await person.text(), /Synthetic Draft Officer/);
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
    assert.equal((await requestPage(site, `/people/${personId}`)).status, 200);
  } finally {
    sandbox.close();
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

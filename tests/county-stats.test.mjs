import assert from "node:assert/strict";
import test from "node:test";
import { D1CountyStructurePublicService } from "../dist/services/county-structure-public.js";
import { createD1PublicReadServices } from "../dist/services/d1-public-reads.js";
import { countyStructureSection } from "../dist/site/pages/county-structure-section.js";
import { withStructure } from "./county-structure-fixtures.mjs";

test("synthetic county totals and exact-unit badges survive duplicate roles and the 1000-row read cap", async () => {
  await withStructure(async ({ database: db, d1 }) => {
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    run(
      "INSERT INTO county_unit(id,county_fips,name,organization_type) VALUES ('root','08081','Synthetic Office','office')",
    );
    run(
      "INSERT INTO county_unit(id,county_fips,name,organization_type,parent_unit_id,parent_relationship) VALUES ('child','08081','Synthetic Section','section','root','part_of')",
    );
    run(
      "INSERT INTO county_unit(id,county_fips,name,organization_type,status) VALUES ('hidden','08081','Hidden','office','hidden')",
    );
    for (let i = 0; i < 1005; i++) {
      run(
        "INSERT INTO people(id,display_name) VALUES (?,?)",
        `p${i}`,
        `Synthetic ${String(i).padStart(4, "0")}`,
      );
      run(
        "INSERT INTO person_roles(id,person_id,county_fips,published_title) VALUES (?,?,'08081','Synthetic role')",
        `r${i}`,
        `p${i}`,
      );
      run(
        "INSERT INTO person_visibility(person_id,visible,changed_by_account_id) VALUES (?,1,'cs-owner') ON CONFLICT(person_id) DO UPDATE SET visible=1,version=person_visibility.version+1",
        `p${i}`,
      );
      run(
        "INSERT INTO county_role_display(id,person_role_id,county_fips,unit_id,listing,reviewed_by_account_id) VALUES (?,?,'08081','child','home','cs-owner')",
        `d${i}`,
        `r${i}`,
      );
      run(
        "INSERT INTO county_unit(id,county_fips,name,organization_type) VALUES (?,'08081',?,'program')",
        `extra${i}`,
        `Synthetic program ${i}`,
      );
    }
    run(
      "INSERT INTO person_roles(id,person_id,county_fips,published_title) VALUES ('duplicate','p0','08081','Second role'),('other-county','p0','08001','Other county')",
    );
    run(
      "INSERT INTO county_role_display(id,person_role_id,county_fips,unit_id,listing,reviewed_by_account_id) VALUES ('duplicate','duplicate','08081','child','home','cs-owner'),('elected','r0','08081','root','elected_official','cs-owner')",
    );
    run(
      "UPDATE person_visibility SET visible=0,version=version+1 WHERE person_id='p1'",
    );
    run(
      "INSERT INTO people(id,display_name) VALUES ('unattached','Synthetic Unattached')",
    );
    run(
      "INSERT INTO person_roles(id,person_id,county_fips,published_title) VALUES ('unattached','unattached','08081','Synthetic role')",
    );
    run(
      "INSERT INTO person_visibility(person_id,visible,changed_by_account_id) VALUES ('unattached',1,'cs-owner') ON CONFLICT(person_id) DO UPDATE SET visible=1,version=person_visibility.version+1",
    );
    const reads = createD1PublicReadServices(d1);
    const reader = new D1CountyStructurePublicService(d1);
    assert.equal(await reads.countPublicPeople("08081"), 1005);
    assert.equal(await reads.countPublicPeople("08001"), 1);
    assert.equal(await reads.countPublicPeople(), 1005);
    assert.equal(await reads.countPublicPeople("08003"), 0);
    assert.equal(await reader.countPublicUnits("08081"), 1007);
    assert.equal(await reader.countPublicUnits("08003"), 0);
    const structure = await reader.getCountyStructure("08081");
    const units = structure.groups.flatMap((g) => g.units);
    assert.equal(units.length, 1006);
    const root = units.find((u) => u.id === "root");
    assert.equal(root.profileCount, 0);
    assert.equal(root.children[0].profileCount, 1004);
    const unitDirectory = await reads.listOfficials({
      countyFips: "08081",
      countyUnitId: "child",
      page: 11,
      limit: 100,
    });
    assert.equal(unitDirectory.total, 1004);
    assert.equal(unitDirectory.items.length, 4);
    assert.equal((await reader.listPublicUnits("08081")).length, 1007);
    assert.ok(root.children[0].people.length < 1004);
    assert.equal(
      new Set(root.children[0].people.map((p) => p.personId)).size,
      root.children[0].people.length,
    );
    assert.match(
      countyStructureSection("Moffat County", structure).value,
      /1004 profiles/,
    );
    run(
      "INSERT INTO county_role_display(id,person_role_id,county_fips,unit_id,listing,reviewed_by_account_id) VALUES ('hidden-unit','unattached','08081','hidden','home','cs-owner')",
    );
    assert.equal(await reads.countPublicPeople("08081"), 1005);
    assert.ok(!units.some((u) => u.id === "hidden"));
  });
});

import { createServices } from "../dist/services/index.js";
import { createPublicSite } from "../dist/site/index.js";
import { get, siteAssets, withPreview } from "./site-fixtures.mjs";

test("county routes keep verified zeros, unavailable reads and pending totals distinct for all 64 counties", async () => {
  await withPreview("empty", async (preview) => {
    const services = createServices({ database: preview.database });
    for (const county of services.listCounties()) {
      const page = await get(preview, `/counties/${county.fips}`);
      assert.equal(page.status, 200);
      assert.deepEqual(
        page.$$(".stat-row dt").map((d) => d.textContent),
        [
          "Departments and offices",
          "County officials and employees",
          "Reports",
          "Grievances",
        ],
      );
      assert.deepEqual(
        page.$$(".stat-row dd").map((d) => d.textContent),
        ["0", "0", "\u2014", "\u2014"],
      );
      assert.deepEqual(
        page.$$(".hero-actions a").map((a) => a.textContent),
        ["Find an official \u2197", "Submit a report \u2197"],
      );
      assert.deepEqual(
        page.$$(".county-entry-card").map((a) => a.getAttribute("href")),
        [
          `/officials?county=${county.fips}`,
          `/counties/${county.fips}#structure`,
        ],
      );
      assert.match(
        page.$(".county-entry-grid").textContent,
        /No office structure has been recorded/,
      );
      assert.ok(page.$(`.county-nav a[href="/stories?county=${county.fips}"]`));
      assert.equal(
        page.$("#county-switch option[selected]").value,
        county.fips,
      );
    }
    const site = createPublicSite({
      assets: siteAssets(),
      services: new Proxy(services, {
        get(target, name) {
          return name === "countPublicPeople"
            ? async () => {
                throw new Error("private detail");
              }
            : target[name];
        },
      }),
      countyStructure: {
        countPublicUnits: async () => {
          throw new Error("private detail");
        },
        getCountyStructure: async () => {
          throw new Error("private detail");
        },
      },
    });
    const page = await get(site, "/counties/08081");
    assert.equal(page.status, 200);
    assert.deepEqual(
      page.$$(".stat-status").map((d) => d.textContent),
      ["Unavailable", "Unavailable", "Pending", "Pending"],
    );
    assert.deepEqual(
      page.$$(".stat-row dd").map((d) => d.textContent),
      Array(4).fill("\u2014"),
    );
    assert.doesNotMatch(
      page.text,
      /private detail|No office structure has been recorded/,
    );
    for (const font of ["inter-latin.woff2", "archivo-black-latin.woff2"]) {
      const asset = await get(preview, `/assets/${font}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get("content-type"), "font/woff2");
    }
  });
});

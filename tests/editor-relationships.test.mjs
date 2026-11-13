import assert from "node:assert/strict";
import test from "node:test";
import {
  makeClient,
  mountWorkspace,
  ORIGIN,
  startSandbox,
  waitFor,
} from "./editor-fixtures.mjs";

// --- sandbox lookup (server side) -----------------------------------------

const LOOKUP = "/sandbox/lookup";
function lookup(sandbox, body, headers = {}, method = "POST") {
  return sandbox.fetch(
    new Request(`${ORIGIN}${LOOKUP}`, {
      method,
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-editor-token": sandbox.token,
        "x-test-human-subject": "author",
        ...headers,
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
const json = (response) => response.json();

test("person lookup keeps identical names as separate records with context", async () => {
  const sandbox = await startSandbox();
  try {
    const response = await lookup(sandbox, {
      kind: "person",
      query: "fictional person one",
    });
    assert.equal(response.status, 200);
    const result = await json(response);
    const ones = result.items.filter((p) => p.name === "Fictional Person One");
    assert.deepEqual(ones.map((p) => p.id).sort(), [
      "sbx-person-1",
      "sbx-person-4",
    ]);
    const byId = Object.fromEntries(ones.map((p) => [p.id, p]));
    assert.equal(
      byId["sbx-person-1"].roles[0].title,
      "Fictional Records Clerk",
    );
    assert.equal(
      byId["sbx-person-4"].roles[0].organizationName,
      "Fictional Records Office",
    );
    assert.notEqual(
      byId["sbx-person-1"].roles[0].title,
      byId["sbx-person-4"].roles[0].title,
    );
  } finally {
    sandbox.close();
  }
});

test("organization lookup reports type, county, parent and affiliation context", async () => {
  const sandbox = await startSandbox();
  try {
    const all = await json(
      await lookup(sandbox, {
        kind: "organization",
        query: "fictional",
        limit: 25,
      }),
    );
    const byId = Object.fromEntries(all.items.map((o) => [o.id, o]));
    assert.equal(byId["sbx-org-3"].type, "county_government");
    assert.equal(byId["sbx-org-2"].type, "regional");
    assert.equal(byId["sbx-org-6"].type, "partner");
    assert.equal(byId["sbx-org-7"].type, "other");
    assert.equal(byId["sbx-org-2"].county, null);
    assert.deepEqual(
      byId["sbx-org-2"].affiliations.map((a) => [a.fips, a.relationshipType]),
      [
        ["08001", "serves"],
        ["08005", "serves"],
      ],
    );
    assert.equal(
      byId["sbx-org-6"].affiliations[0].relationshipType,
      "partner_for",
    );
    assert.deepEqual(byId["sbx-org-4"].parent, {
      id: "sbx-org-3",
      name: "Fictional County Government",
      relationship: "reports_to",
    });
    // Same name, different counties: separate records.
    assert.equal(byId["sbx-org-1"].name, byId["sbx-org-5"].name);
    assert.equal(byId["sbx-org-1"].county.fips, "08001");
    assert.equal(byId["sbx-org-5"].county.fips, "08005");
    // A county name finds the organizations located in that county.
    const adams = await json(
      await lookup(sandbox, { kind: "organization", query: "adams" }),
    );
    assert.ok(adams.items.every((o) => o.county?.name === "Adams"));
    assert.ok(adams.items.some((o) => o.id === "sbx-org-1"));
  } finally {
    sandbox.close();
  }
});

test("lookup is bounded, resolves exact IDs and reports missing ones", async () => {
  const sandbox = await startSandbox();
  try {
    const page = await json(
      await lookup(sandbox, { kind: "person", limit: 2 }),
    );
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, true);
    const exact = await json(
      await lookup(sandbox, {
        kind: "organization",
        ids: ["sbx-org-1", "no-such-org", "sbx-org-1"],
      }),
    );
    assert.deepEqual(
      exact.items.map((o) => o.id),
      ["sbx-org-1"],
    );
    assert.deepEqual(exact.missingIds, ["no-such-org"]);
    assert.equal(
      (await json(await lookup(sandbox, { kind: "person", query: "zzz-none" })))
        .items.length,
      0,
    );
    // Wildcards and quotes match literally and never widen the search.
    for (const query of ["%", "_", "'; DROP TABLE people; --", "\\"]) {
      const result = await json(
        await lookup(sandbox, { kind: "person", query }),
      );
      assert.equal(result.items.length, 0, query);
    }
    assert.equal(
      sandbox.database.prepare("SELECT COUNT(*) AS n FROM people").get().n,
      5,
    );
  } finally {
    sandbox.close();
  }
});

test("invalid lookup requests are rejected before any lookup", async () => {
  const sandbox = await startSandbox();
  try {
    const bad = [
      {},
      { kind: "county" },
      { kind: "person", extra: 1 },
      { kind: "person", query: 5 },
      { kind: "person", query: "a b c d e f" },
      { kind: "person", query: "x".repeat(101) },
      { kind: "person", query: "bad\u0000text" },
      { kind: "person", limit: 0 },
      { kind: "person", limit: 26 },
      { kind: "person", limit: 1.5 },
      { kind: "person", ids: "sbx-person-1" },
      { kind: "person", ids: ["bad id!"] },
      { kind: "person", ids: [5] },
      { kind: "person", ids: ["a"], query: "a" },
      { kind: "person", ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) },
      [],
      null,
    ];
    for (const body of bad) {
      const response = await lookup(sandbox, body);
      assert.equal(response.status, 400, JSON.stringify(body)?.slice(0, 60));
      assert.deepEqual(await json(response), { error: "invalid_request" });
    }
    const notJson = await sandbox.fetch(
      new Request(`${ORIGIN}${LOOKUP}`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "x-editor-token": sandbox.token,
          "x-test-human-subject": "author",
        },
        body: "{not json",
      }),
    );
    assert.equal(notJson.status, 400);
    const huge = await lookup(sandbox, {
      kind: "person",
      query: "a".repeat(5000),
    });
    assert.equal(huge.status, 413);
    const wrongType = await lookup(
      sandbox,
      {},
      { "content-type": "text/plain" },
    );
    assert.equal(wrongType.status, 400);
    assert.equal((await lookup(sandbox, {}, {}, "GET")).status, 405);
  } finally {
    sandbox.close();
  }
});

test("lookup requires the token, same origin and an authorized account", async () => {
  const sandbox = await startSandbox();
  try {
    const body = { kind: "person" };
    assert.equal(
      (await lookup(sandbox, body, { "x-editor-token": "wrong" })).status,
      403,
    );
    assert.equal(
      (await lookup(sandbox, body, { origin: "https://evil.invalid" })).status,
      403,
    );
    assert.equal(
      (await lookup(sandbox, body, { "sec-fetch-site": "cross-site" })).status,
      403,
    );
    assert.equal(
      (await lookup(sandbox, body, { "x-test-human-subject": "" })).status,
      401,
    );
    assert.equal(
      (await lookup(sandbox, body, { "x-test-human-subject": "retired" }))
        .status,
      401,
    );
    const readonly = await lookup(sandbox, body, {
      "x-test-human-subject": "readonly",
    });
    assert.equal(readonly.status, 403);
    assert.deepEqual(await json(readonly), { error: "forbidden" });
    assert.equal(
      (await lookup(sandbox, body, { "x-test-human-subject": "editor" }))
        .status,
      200,
    );
    assert.equal(
      (
        await sandbox.fetch(
          new Request(`http://evil.invalid${LOOKUP}`, {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
      403,
    );
  } finally {
    sandbox.close();
  }
});

test("lookup is read-only and leaves content and audit state unchanged", async () => {
  const sandbox = await startSandbox();
  try {
    const count = (sql) => sandbox.database.prepare(sql).get().n;
    const before = [
      count("SELECT COUNT(*) AS n FROM audit_events"),
      count("SELECT COUNT(*) AS n FROM content_items"),
      count("SELECT COUNT(*) AS n FROM content_revisions"),
      count("SELECT COUNT(*) AS n FROM people"),
      count("SELECT COUNT(*) AS n FROM organizations"),
    ];
    for (const kind of ["person", "organization"]) {
      await lookup(sandbox, { kind, query: "fictional" });
      await lookup(sandbox, { kind, ids: ["sbx-person-1", "sbx-org-1"] });
    }
    const after = [
      count("SELECT COUNT(*) AS n FROM audit_events"),
      count("SELECT COUNT(*) AS n FROM content_items"),
      count("SELECT COUNT(*) AS n FROM content_revisions"),
      count("SELECT COUNT(*) AS n FROM people"),
      count("SELECT COUNT(*) AS n FROM organizations"),
    ];
    assert.deepEqual(after, before);
  } finally {
    sandbox.close();
  }
});

// --- discovery UI -----------------------------------------------------------

const savedLine = (w) => w.text("#save-state");
const picker = (w, kind) => w.$(`input[role=combobox][id$=-${kind}-input]`);
const optionsOf = (w, kind) =>
  w.$$(`ul[role=listbox][id$=-${kind}-listbox] li[role=option]`);
const statusOf = (w, kind) => w.text(`[id$=-${kind}-status]`);

async function openEditor(w) {
  const page = await w.client.listDrafts({ limit: 100 });
  const item = page.items.find((i) => i.status === "draft" && i.id && true);
  // Pick a draft with no relationships so assertions start from empty.
  let target = null;
  for (const candidate of page.items) {
    if (candidate.status !== "draft") continue;
    const full = await w.client.getDraft(candidate.id);
    const rel = full.relationships;
    if (
      rel.countyFips.length +
        rel.personIds.length +
        rel.organizationIds.length ===
      0
    ) {
      target = full;
      break;
    }
  }
  assert.ok(target ?? item);
  w.window.location.hash = `#/item/${(target ?? item).id}`;
  await waitFor(() => w.titleInput(), "editor loads");
  await waitFor(() => picker(w, "person"), "pickers render");
  return (target ?? item).id;
}

async function search(w, kind, text) {
  w.type(picker(w, kind), text);
  await waitFor(
    () => !/Searching/.test(statusOf(w, kind)) && statusOf(w, kind) !== "",
    `${kind} results for "${text}"`,
  );
}
const key = (w, element, name) =>
  element.dispatchEvent(
    new w.window.KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
const titles = (w, kind) =>
  optionsOf(w, kind).map((o) => o.querySelector("strong").textContent);

test("county search shows name and FIPS, selects, and prevents duplicates", async () => {
  const w = await mountWorkspace();
  try {
    await openEditor(w);
    await search(w, "county", "adam");
    assert.deepEqual(titles(w, "county"), ["Adams County"]);
    assert.match(optionsOf(w, "county")[0].textContent, /FIPS 08001/);
    w.click(optionsOf(w, "county")[0]);
    assert.match(w.text("#selected-counties"), /Adams County/);
    assert.match(w.text("#selected-counties"), /FIPS 08001/);
    assert.match(w.text("#relationship-message"), /Added Adams County/);
    assert.equal(
      optionsOf(w, "county")[0].getAttribute("aria-selected"),
      "true",
    );
    assert.match(optionsOf(w, "county")[0].textContent, /Selected/);
    // Choosing it again never adds a second copy.
    w.click(optionsOf(w, "county")[0]);
    assert.match(w.text("#relationship-message"), /already selected/);
    assert.equal(w.$$("#selected-counties li").length, 1);
    // A FIPS search works too and an unmatched search is explained.
    await search(w, "county", "08005");
    assert.deepEqual(titles(w, "county"), ["Arapahoe County"]);
    await search(w, "county", "nowhere");
    assert.match(statusOf(w, "county"), /No counties match "nowhere"/);
    assert.equal(optionsOf(w, "county").length, 0);
    // Removal is explicit and labeled.
    w.click("[aria-label='Remove Adams County (FIPS 08001)']");
    assert.equal(w.$$("#selected-counties li").length, 0);
    assert.match(w.text(".selected-slot"), /No counties selected/);
    assert.match(savedLine(w), /Unsaved|All changes saved/);
  } finally {
    await w.close();
  }
});

test("person search keeps identical names separate and selects by stable ID", async () => {
  const w = await mountWorkspace();
  try {
    const id = await openEditor(w);
    await search(w, "person", "Fictional Person One");
    const options = optionsOf(w, "person");
    assert.equal(options.length, 2);
    assert.deepEqual(options.map((o) => o.getAttribute("data-id")).sort(), [
      "sbx-person-1",
      "sbx-person-4",
    ]);
    const texts = options.map((o) => o.textContent);
    assert.ok(
      texts.some((t) => /ID sbx-person-1/.test(t) && /Records Clerk/.test(t)),
    );
    assert.ok(
      texts.some((t) => /ID sbx-person-4/.test(t) && /Records Analyst/.test(t)),
    );
    // Choose only the second record: the first is never inferred from the name.
    w.click(options.find((o) => o.getAttribute("data-id") === "sbx-person-4"));
    assert.equal(w.$$("#selected-people li").length, 1);
    assert.match(w.text("#selected-people"), /sbx-person-4/);
    w.click("#save");
    await waitFor(() => /All changes saved/.test(savedLine(w)), "saved");
    assert.deepEqual((await w.client.getDraft(id)).relationships.personIds, [
      "sbx-person-4",
    ]);
    // The other same-named record is a separate, still-selectable record.
    w.click(
      optionsOf(w, "person").find(
        (o) => o.getAttribute("data-id") === "sbx-person-1",
      ),
    );
    assert.equal(w.$$("#selected-people li").length, 2);
    assert.match(w.text("#relationship-message"), /2 of 50 people selected/);
    w.click("#save");
    await waitFor(() => /All changes saved/.test(savedLine(w)), "saved both");
    assert.deepEqual(
      [...(await w.client.getDraft(id)).relationships.personIds].sort(),
      ["sbx-person-1", "sbx-person-4"],
    );
  } finally {
    await w.close();
  }
});

test("organization search shows type, county and context and groups selections by type", async () => {
  const w = await mountWorkspace();
  try {
    const id = await openEditor(w);
    await search(w, "organization", "fictional");
    const text = (orgId) =>
      optionsOf(w, "organization").find(
        (o) => o.getAttribute("data-id") === orgId,
      )?.textContent ?? "";
    assert.match(text("sbx-org-3"), /Type: County government/);
    assert.match(text("sbx-org-3"), /FIPS 08001/);
    assert.match(
      text("sbx-org-4"),
      /Parent record: Fictional County Government \(sbx-org-3\), recorded as reports to/,
    );
    assert.match(text("sbx-org-2"), /Type: Regional office/);
    assert.match(text("sbx-org-2"), /Recorded as serving Adams County/);
    assert.match(text("sbx-org-6"), /Type: Partner organization/);
    assert.match(text("sbx-org-6"), /Recorded as a partner for Adams County/);
    assert.match(text("sbx-org-7"), /Type: Other organization/);
    assert.match(text("sbx-org-1"), /County: Adams \(FIPS 08001\)/);
    assert.match(text("sbx-org-5"), /County: Arapahoe \(FIPS 08005\)/);
    // The words "authority" or "controls" are never used for a record.
    assert.doesNotMatch(
      optionsOf(w, "organization")
        .map((o) => o.textContent)
        .join(" "),
      /authority|controls|oversees/i,
    );
    for (const orgId of [
      "sbx-org-3",
      "sbx-org-2",
      "sbx-org-6",
      "sbx-org-7",
      "sbx-org-5",
    ]) {
      w.click(
        optionsOf(w, "organization").find(
          (o) => o.getAttribute("data-id") === orgId,
        ),
      );
    }
    const groups = w
      .$$("#selected-organizations [role=group]")
      .map((g) => g.getAttribute("aria-label"));
    assert.deepEqual(groups, [
      "County organizations",
      "Regional offices",
      "Partner organizations",
      "Other affiliated organizations",
    ]);
    assert.match(
      w.text("#relationships-panel"),
      /do not establish administrative authority/,
    );
    w.click("#save");
    await waitFor(() => /All changes saved/.test(savedLine(w)), "saved");
    assert.deepEqual(
      [...(await w.client.getDraft(id)).relationships.organizationIds].sort(),
      ["sbx-org-2", "sbx-org-3", "sbx-org-5", "sbx-org-6", "sbx-org-7"],
    );
    // Same-named offices stay distinct.
    await search(w, "organization", "Fictional Records Office");
    assert.deepEqual(
      optionsOf(w, "organization")
        .map((o) => o.getAttribute("data-id"))
        .sort(),
      ["sbx-org-1", "sbx-org-5"],
    );
  } finally {
    await w.close();
  }
});

test("relationship limits are enforced with clear feedback", async () => {
  const w = await mountWorkspace();
  try {
    await openEditor(w);
    const counties = (await w.client.sandboxInfo()).counties;
    for (const county of counties.slice(0, 50)) {
      await search(w, "county", county.fips);
      w.click(optionsOf(w, "county")[0]);
    }
    assert.equal(w.$$("#selected-counties li").length, 50);
    await search(w, "county", counties[50].fips);
    w.click(optionsOf(w, "county")[0]);
    assert.match(w.text("#relationship-message"), /At most 50 counties/);
    assert.equal(w.$$("#selected-counties li").length, 50);
    w.click("#save");
    await waitFor(() => /All changes saved/.test(savedLine(w)), "saved 50");
  } finally {
    await w.close();
  }
});

test("removing a relationship keeps every other unsaved change", async () => {
  const w = await mountWorkspace();
  try {
    await openEditor(w);
    w.type(w.titleInput(), "Unsaved title kept");
    w.type(w.bodyInput(), "Unsaved body kept");
    await search(w, "person", "Person Two");
    w.click(optionsOf(w, "person")[0]);
    await search(w, "county", "adams");
    w.click(optionsOf(w, "county")[0]);
    w.click("[aria-label='Remove Fictional Person Two (sbx-person-2)']");
    assert.equal(w.$$("#selected-people li").length, 0);
    assert.equal(w.titleInput().value, "Unsaved title kept");
    assert.equal(w.bodyInput().value, "Unsaved body kept");
    assert.equal(w.$$("#selected-counties li").length, 1);
    assert.match(savedLine(w), /Unsaved/);
    assert.match(
      w.text("#relationship-message"),
      /Removed Fictional Person Two/,
    );
    // Focus returns to the picker so keyboard users keep their place.
    assert.equal(w.window.document.activeElement, picker(w, "person"));
  } finally {
    await w.close();
  }
});

test("keyboard navigation selects, closes and never adds an unhighlighted record", async () => {
  const w = await mountWorkspace();
  try {
    await openEditor(w);
    const box = picker(w, "person");
    assert.equal(box.getAttribute("aria-expanded"), "false");
    key(w, box, "ArrowDown");
    await waitFor(() => optionsOf(w, "person").length > 0, "opened by arrow");
    assert.equal(box.getAttribute("aria-expanded"), "true");
    key(w, box, "ArrowDown");
    key(w, box, "ArrowDown");
    const options = optionsOf(w, "person");
    assert.equal(box.getAttribute("aria-activedescendant"), options[1].id);
    assert.ok(options[1].classList.contains("is-active"));
    key(w, box, "ArrowUp");
    assert.equal(box.getAttribute("aria-activedescendant"), options[0].id);
    key(w, box, "End");
    assert.equal(box.getAttribute("aria-activedescendant"), options.at(-1).id);
    key(w, box, "Home");
    assert.equal(box.getAttribute("aria-activedescendant"), options[0].id);
    key(w, box, "Enter");
    assert.equal(w.$$("#selected-people li").length, 1);
    assert.equal(
      optionsOf(w, "person")[0].getAttribute("aria-selected"),
      "true",
    );
    // Escape closes the list first, then clears the text.
    key(w, box, "Escape");
    assert.equal(box.getAttribute("aria-expanded"), "false");
    assert.equal(box.hasAttribute("aria-activedescendant"), false);
    w.type(box, "two");
    await waitFor(() => /shown|No people/.test(statusOf(w, "person")), "typed");
    key(w, box, "Enter");
    assert.equal(w.$$("#selected-people li").length, 1);
    key(w, box, "Escape");
    key(w, box, "Escape");
    assert.equal(box.value, "");
  } finally {
    await w.close();
  }
});

test("controls have explicit labels, roles and screen-reader status regions", async () => {
  const w = await mountWorkspace();
  try {
    await openEditor(w);
    for (const [kind, label] of [
      ["county", "Search counties by name or FIPS"],
      ["person", "Search people by name or ID"],
      ["organization", "Search organizations by name, county or ID"],
    ]) {
      const box = picker(w, kind);
      const labelElement = w.$(`label[for='${box.id}']`);
      assert.equal(labelElement.textContent, label);
      assert.equal(box.getAttribute("role"), "combobox");
      assert.equal(box.getAttribute("aria-autocomplete"), "list");
      const list = w.window.document.getElementById(
        box.getAttribute("aria-controls"),
      );
      assert.equal(list.getAttribute("role"), "listbox");
      assert.ok(list.getAttribute("aria-label"));
      const status = w.$(`[id$=-${kind}-status]`);
      assert.equal(status.getAttribute("role"), "status");
      assert.equal(status.getAttribute("aria-live"), "polite");
      assert.ok(box.getAttribute("aria-describedby").includes(status.id));
    }
    assert.equal(w.$("#relationship-message").getAttribute("role"), "status");
    await search(w, "person", "five");
    const option = optionsOf(w, "person")[0];
    assert.equal(option.getAttribute("aria-selected"), "false");
    w.click(option);
    assert.equal(
      optionsOf(w, "person")[0].getAttribute("aria-selected"),
      "true",
    );
    // Selection is shown with text, not color alone.
    assert.match(optionsOf(w, "person")[0].textContent, /Selected/);
    const remove = w.$(
      "[aria-label='Remove Fictional Person Five (sbx-person-5)']",
    );
    assert.ok(remove);
    assert.equal(remove.tagName, "BUTTON");
    assert.equal(
      w.$("#selected-people").getAttribute("aria-label"),
      "Selected people",
    );
    // Nothing is built with markup parsing.
    assert.equal(w.$$("#relationships-panel script").length, 0);
  } finally {
    await w.close();
  }
});

test("error and retry states are announced and keep selections", async () => {
  let fail = false;
  const w = await mountWorkspace({
    hook: ({ path }) =>
      fail && path === "/sandbox/lookup"
        ? new Response(JSON.stringify({ error: "internal_error" }), {
            status: 500,
          })
        : undefined,
  });
  try {
    await openEditor(w);
    await search(w, "county", "adams");
    w.click(optionsOf(w, "county")[0]);
    fail = true;
    w.type(picker(w, "person"), "one");
    await waitFor(
      () => /Could not load people/.test(statusOf(w, "person")),
      "error",
    );
    assert.ok(w.$("[id$=-person-picker] .picker-retry:not([hidden])"));
    assert.equal(optionsOf(w, "person").length, 0);
    assert.equal(w.$$("#selected-counties li").length, 1);
    fail = false;
    w.click("[id$=-person-picker] .picker-retry");
    await waitFor(() => optionsOf(w, "person").length > 0, "recovered");
    assert.match(statusOf(w, "person"), /shown/);
    assert.ok(w.$("[id$=-person-picker] .picker-retry[hidden]"));
  } finally {
    await w.close();
  }
});

test("a loading state is shown while a search is pending", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let hold = false;
  const w = await mountWorkspace({
    hook: ({ path }) => {
      if (path !== "/sandbox/lookup" || !hold) return undefined;
      return gate.then(
        () =>
          new Response(
            JSON.stringify({
              kind: "person",
              items: [],
              hasMore: false,
              missingIds: [],
            }),
            { status: 200 },
          ),
      );
    },
  });
  try {
    await openEditor(w);
    hold = true;
    w.type(picker(w, "person"), "one");
    assert.match(statusOf(w, "person"), /Searching people/);
    assert.equal(
      w.$("ul[role=listbox][id$=-person-listbox]").getAttribute("aria-busy"),
      "true",
    );
    release();
    await waitFor(
      () => /No people match/.test(statusOf(w, "person")),
      "settled",
    );
  } finally {
    await w.close();
  }
});

test("an unauthorized account cannot use the lookup and the denial is explained", async () => {
  const w = await mountWorkspace();
  try {
    await openEditor(w);
    w.session.account = "readonly";
    w.type(picker(w, "person"), "one");
    await waitFor(
      () => /Could not load people/.test(statusOf(w, "person")),
      "denied",
    );
    assert.equal(optionsOf(w, "person").length, 0);
    assert.equal(w.$$("#selected-people li").length, 0);
  } finally {
    await w.close();
  }
});

test("a failed save keeps relationship selections and allows a retry", async () => {
  let down = false;
  const w = await mountWorkspace({
    hook: ({ path }) => {
      if (down && path.includes("/drafts/update")) {
        return Promise.reject(new Error("offline"));
      }
      return undefined;
    },
  });
  try {
    const id = await openEditor(w);
    await search(w, "person", "Person Three");
    w.click(optionsOf(w, "person")[0]);
    await search(w, "county", "adams");
    w.click(optionsOf(w, "county")[0]);
    down = true;
    w.click("#save");
    await waitFor(() => w.$("#messages .notice-error"), "failed save");
    assert.match(w.text("#messages"), /still here and were not saved/);
    assert.equal(w.$$("#selected-people li").length, 1);
    assert.equal(w.$$("#selected-counties li").length, 1);
    assert.match(savedLine(w), /Unsaved/);
    down = false;
    w.click("#save");
    await waitFor(() => /All changes saved/.test(savedLine(w)), "retry saved");
    const saved = (await w.client.getDraft(id)).relationships;
    assert.deepEqual(saved.personIds, ["sbx-person-3"]);
    assert.deepEqual(saved.countyFips, ["08001"]);
  } finally {
    await w.close();
  }
});

test("a version conflict never discards selected relationships", async () => {
  const w = await mountWorkspace();
  try {
    const id = await openEditor(w);
    const loaded = await w.client.getDraft(id);
    const rival = makeClient(w.sandbox, { account: "editor" });
    await rival.updateDraft(id, loaded.version, { body: "RIVAL TEXT" });
    await search(w, "organization", "partner");
    w.click(optionsOf(w, "organization")[0]);
    w.click("#save");
    await waitFor(() => w.$("#conflict-panel"), "conflict panel");
    assert.equal(w.$$("#selected-organizations li").length, 1);
    assert.match(w.text("#conflict-panel"), /Nothing you typed has been lost/);
    const server = await w.client.getDraft(id);
    assert.equal(server.body, "RIVAL TEXT");
    assert.deepEqual(server.relationships.organizationIds, []);
  } finally {
    await w.close();
  }
});

test("a record that disappears is flagged, the save is refused and removal fixes it", async () => {
  const w = await mountWorkspace();
  try {
    const id = await openEditor(w);
    await search(w, "person", "Person Five");
    w.click(optionsOf(w, "person")[0]);
    // The record is removed from the sandbox directory behind the editor's back.
    w.sandbox.database
      .prepare("DELETE FROM people WHERE id = 'sbx-person-5'")
      .run();
    w.click("#save");
    await waitFor(() => w.$("#messages .notice-error"), "server refusal");
    assert.match(w.text("#messages"), /no longer available/);
    assert.match(w.text("#messages"), /Your changes are still here/);
    await waitFor(
      () =>
        /Not found in the sandbox directory/.test(w.text("#selected-people")),
      "flagged unavailable",
    );
    assert.ok(w.$("#selected-people .is-unavailable"));
    assert.equal(w.$$("#selected-people li").length, 1);
    assert.deepEqual((await w.client.getDraft(id)).relationships.personIds, []);
    w.click("[aria-label='Remove person sbx-person-5 (sbx-person-5)']");
    assert.equal(w.$$("#selected-people li").length, 0);
  } finally {
    await w.close();
  }
});

test("a lookup outage while checking selected records is reported with a retry", async () => {
  let fail = true;
  const w = await mountWorkspace({
    hook: ({ path, init }) => {
      if (fail && path === "/sandbox/lookup" && /"ids"/.test(init.body ?? "")) {
        return new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
        });
      }
      return undefined;
    },
  });
  try {
    await openEditor(w);
    await search(w, "county", "adams");
    w.click(optionsOf(w, "county")[0]);
    // Selected people are checked by ID. Search results carry the details, so a
    // saved selection reopened later must be checked through the lookup.
    await search(w, "person", "Person Two");
    w.click(optionsOf(w, "person")[0]);
    w.click("#save");
    await waitFor(() => /All changes saved/.test(savedLine(w)), "saved");
    const id = w.window.location.hash.replace("#/item/", "");
    w.window.location.hash = "#/";
    await waitFor(() => w.$("#new-post"), "dashboard");
    w.window.location.hash = `#/item/${id}`;
    await waitFor(() => w.$("#retry-record-check"), "check failed notice");
    assert.match(
      w.text("#record-check-slot"),
      /Could not check some selected records/,
    );
    assert.equal(w.$$("#selected-people li").length, 1);
    fail = false;
    w.click("#retry-record-check");
    await waitFor(
      () => /Fictional Person Two/.test(w.text("#selected-people")),
      "records resolved",
    );
    assert.equal(w.$("#retry-record-check"), null);
  } finally {
    await w.close();
  }
});

test("archived articles keep relationship controls read-only", async () => {
  const w = await mountWorkspace();
  try {
    const page = await w.client.listDrafts({ limit: 100 });
    const archived = page.items.find((i) => i.status === "archived");
    w.window.location.hash = `#/item/${archived.id}`;
    await waitFor(() => w.$("#archived-banner"), "archived banner");
    await waitFor(() => picker(w, "person"), "pickers");
    for (const kind of ["county", "person", "organization"]) {
      assert.equal(picker(w, kind).disabled, true, kind);
    }
    assert.ok(
      w.$$("#relationships-panel .chip-remove").every((b) => b.disabled),
    );
  } finally {
    await w.close();
  }
});

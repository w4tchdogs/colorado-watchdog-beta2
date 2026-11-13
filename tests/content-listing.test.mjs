import assert from "node:assert/strict";
import test from "node:test";
import { ContentInputError } from "../dist/services/content.js";
import { AuthorizationError } from "../dist/services/security.js";
import {
  CONTENT_API_PATHS,
  createContentApiTransport,
  createContentTransportOperations,
} from "../dist/transport/content-api.js";
import {
  allowSynthetic,
  auditCount,
  revisionCount,
  withContentFixture,
} from "./content-fixtures.mjs";

/** Forces exact timestamps. Test-only raw SQL, never a service path. */
function stamp(database, id, updatedAt) {
  const row = database
    .prepare("SELECT version FROM content_items WHERE id = ?")
    .get(id);
  database
    .prepare(
      "UPDATE content_items SET updated_at = ?, version = ? WHERE id = ?",
    )
    .run(updatedAt, row.version + 1, id);
}

function seed(service, author, count = 7) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push(
      service.createDraft(author, {
        contentType: index % 2 === 0 ? "post" : "story",
        title: `Fictional listing ${index}`,
        summary: index % 3 === 0 ? `Budget notes ${index}` : null,
        body: "Body text that listings must not return",
      }),
    );
  }
  return items;
}

function walk(service, principal, request) {
  const ids = [];
  const cursorKey = request.sort === "modified" ? "cursor" : "afterId";
  let position = null;
  let pages = 0;
  for (;;) {
    const page = service.listDrafts(principal, {
      ...request,
      ...(position ? { [cursorKey]: position } : {}),
    });
    assert.ok(page.items.length <= request.limit);
    ids.push(...page.items.map((item) => item.id));
    pages += 1;
    assert.equal(page.hasMore, page.nextCursor !== null);
    if (!page.nextCursor) break;
    position = page.nextCursor;
    assert.ok(pages < 50, "pagination must terminate");
  }
  return { ids, pages };
}

test("recently modified order spans every page, newest first, with ID tie-breaks", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const items = seed(service, author, 7);
    const times = [
      "2026-03-01T10:00:00.000Z",
      "2026-03-05T10:00:00.000Z",
      "2026-03-03T10:00:00.000Z",
      "2026-03-05T10:00:00.000Z", // equal to item 1
      "2026-03-05T10:00:00.000Z", // equal to items 1 and 3
      "2026-02-01T10:00:00.000Z",
      "2026-03-03T10:00:00.000Z", // equal to item 2
    ];
    for (const [index, item] of items.entries()) {
      stamp(database, item.id, times[index]);
    }
    const expected = items
      .map((item, index) => ({ id: item.id, time: times[index] }))
      .sort((a, b) =>
        a.time === b.time ? (a.id < b.id ? 1 : -1) : a.time < b.time ? 1 : -1,
      )
      .map((entry) => entry.id);

    for (const limit of [1, 2, 3, 7, 100]) {
      const { ids } = walk(service, author, { sort: "modified", limit });
      assert.deepEqual(ids, expected, `limit ${limit}`);
    }
    const { pages } = walk(service, author, { sort: "modified", limit: 3 });
    assert.equal(pages, 3);

    // Filters apply across the whole set before ordering and paging.
    const stories = items
      .filter((item) => item.contentType === "story")
      .map((item) => item.id);
    const storyOrder = expected.filter((id) => stories.includes(id));
    assert.deepEqual(
      walk(service, author, {
        sort: "modified",
        limit: 1,
        contentType: "story",
      }).ids,
      storyOrder,
    );

    const page = service.listDrafts(author, { sort: "modified", limit: 2 });
    assert.equal("body" in page.items[0], false);
    assert.match(page.nextCursor, /^m1~\d{4}-.*Z~/);
  });
});

test("ID order stays the default and keeps its plain ID cursor", async () => {
  await withContentFixture(async ({ principal, service }) => {
    const author = await principal("author");
    const items = seed(service, author, 5);
    const sorted = items.map((item) => item.id).sort();
    assert.deepEqual(
      service.listDrafts(author, { limit: 100 }).items.map((i) => i.id),
      sorted,
    );
    assert.deepEqual(
      walk(service, author, { limit: 2, sort: "id" }).ids,
      sorted,
    );
    const first = service.listDrafts(author, { limit: 2 });
    assert.equal(first.nextCursor, first.items[1].id);
  });
});

test("an edit between requests moves the item without duplicating or breaking the walk", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const items = seed(service, author, 6);
    for (const [index, item] of items.entries()) {
      stamp(database, item.id, `2026-04-0${index + 1}T00:00:00.000Z`);
    }
    const newestFirst = items.map((item) => item.id).reverse();
    const first = service.listDrafts(author, { sort: "modified", limit: 2 });
    assert.deepEqual(
      first.items.map((i) => i.id),
      newestFirst.slice(0, 2),
    );
    // Edit an already-seen item and an unseen item between requests.
    const seen = service.getDraft(author, newestFirst[0]);
    service.updateDraft(author, seen.id, seen.version, {
      title: "Edited seen",
    });
    const unseen = service.getDraft(author, newestFirst[4]);
    service.updateDraft(author, unseen.id, unseen.version, {
      title: "Edited unseen",
    });
    const rest = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = service.listDrafts(author, {
        sort: "modified",
        limit: 2,
        cursor,
      });
      rest.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }
    // No duplicates, no failure, and the seen item is never repeated.
    assert.equal(new Set(rest).size, rest.length);
    assert.equal(rest.includes(newestFirst[0]), false);
    assert.equal(rest.includes(newestFirst[1]), false);
    // An unseen item that moved newer than the cursor is a fresh first page.
    const fresh = service.listDrafts(author, { sort: "modified", limit: 2 });
    assert.deepEqual(
      fresh.items.map((i) => i.id).sort(),
      [newestFirst[0], newestFirst[4]].sort(),
    );
    // Archiving between requests keeps filtered counts consistent.
    const target = service.getDraft(author, newestFirst[2]);
    service.archiveDraft(author, target.id, target.version);
    const drafts = walk(service, author, {
      sort: "modified",
      limit: 2,
      status: "draft",
    }).ids;
    assert.equal(drafts.includes(newestFirst[2]), false);
    assert.equal(drafts.length, 5);
  });
});

test("search matches title and summary together with type and status filters", async () => {
  await withContentFixture(async ({ principal, service }) => {
    const author = await principal("author");
    const a = service.createDraft(author, {
      contentType: "post",
      title: "County Budget Review",
      summary: "Fictional spending",
    });
    const b = service.createDraft(author, {
      contentType: "story",
      title: "Road notes",
      summary: "A fictional BUDGET walk-through",
    });
    const c = service.createDraft(author, {
      contentType: "post",
      title: "Unrelated",
      summary: null,
    });
    service.archiveDraft(author, c.id, 1);
    const ids = (request) =>
      service
        .listDrafts(author, { limit: 100, ...request })
        .items.map((item) => item.id)
        .sort();
    assert.deepEqual(ids({ search: "budget" }), [a.id, b.id].sort());
    assert.deepEqual(ids({ search: "  BUDGET  " }), [a.id, b.id].sort());
    assert.deepEqual(ids({ search: "budget", contentType: "story" }), [b.id]);
    assert.deepEqual(ids({ search: "budget review" }), [a.id]);
    assert.deepEqual(ids({ search: "budget zzz" }), []);
    assert.deepEqual(ids({ search: "unrelated", status: "archived" }), [c.id]);
    assert.deepEqual(ids({ search: "unrelated", status: "draft" }), []);
    // Empty or blank search is no search at all.
    assert.equal(ids({ search: "" }).length, 3);
    assert.equal(ids({ search: "   " }).length, 3);
    assert.equal(ids({ search: null }).length, 3);
    // Searching never matches the body.
    service.updateDraft(author, a.id, 1, { body: "secretbodyword" });
    assert.deepEqual(ids({ search: "secretbodyword" }), []);
    // Search works with both orderings.
    assert.deepEqual(
      walk(service, author, {
        sort: "modified",
        limit: 1,
        search: "budget",
      }).ids.sort(),
      [a.id, b.id].sort(),
    );
    assert.deepEqual(
      walk(service, author, { sort: "id", limit: 1, search: "budget" }).ids,
      [a.id, b.id].sort(),
    );
  });
});

test("search input is data: wildcards, quotes and SQL text match literally", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const plain = service.createDraft(author, {
      contentType: "post",
      title: "Plain title",
    });
    const percent = service.createDraft(author, {
      contentType: "post",
      title: "Rate is 100% fictional",
    });
    const underscore = service.createDraft(author, {
      contentType: "post",
      title: "snake_case name",
    });
    const slash = service.createDraft(author, {
      contentType: "post",
      title: "path\\to thing",
    });
    const quote = service.createDraft(author, {
      contentType: "post",
      title: "O'Brien's \"quoted\" <b>bold</b>",
    });
    const find = (search) =>
      service
        .listDrafts(author, { search, limit: 100 })
        .items.map((item) => item.id);
    assert.deepEqual(find("%"), [percent.id]);
    assert.deepEqual(find("100%"), [percent.id]);
    assert.deepEqual(find("_"), [underscore.id]);
    assert.deepEqual(find("snake_case"), [underscore.id]);
    assert.deepEqual(find("snakeXcase"), []);
    assert.deepEqual(find("\\"), [slash.id]);
    assert.deepEqual(find("O'Brien's"), [quote.id]);
    assert.deepEqual(find("<b>bold</b>"), [quote.id]);
    assert.deepEqual(find("' OR 1=1 --"), []);
    assert.deepEqual(find("x'; DROP TABLE content_items; --"), []);
    assert.ok(
      database.prepare("SELECT COUNT(*) AS n FROM content_items").get().n >= 5,
    );
    assert.equal(find("%%").length, 0);
    assert.ok(plain.id);
  });
});

test("invalid search, sort and cursor input is rejected without side effects", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const items = seed(service, author, 3);
    const audits = auditCount(database);
    const revisions = revisionCount(database);
    const page = service.listDrafts(author, { sort: "modified", limit: 1 });
    const goodCursor = page.nextCursor;
    const rejected = [
      { search: 5 },
      { search: {} },
      { search: "x".repeat(101) },
      { search: "a\u0000b" },
      { search: "a\nb" },
      { search: "a b c d e f" },
      { sort: "created" },
      { sort: "" },
      { sort: null },
      { sort: "id", cursor: goodCursor },
      { sort: "modified", afterId: items[0].id },
      { sort: "modified", cursor: items[0].id },
      { sort: "modified", cursor: "" },
      { sort: "modified", cursor: 5 },
      { sort: "modified", cursor: "m1~" },
      { sort: "modified", cursor: "m1~2026-01-01T00:00:00.000Z" },
      { sort: "modified", cursor: `m1~not-a-time~${items[0].id}` },
      { sort: "modified", cursor: "m1~2026-13-45T99:00:00.000Z~abc" },
      { sort: "modified", cursor: `m1~2026-01-01T00:00:00Z~${items[0].id}` },
      { sort: "modified", cursor: "m1~2026-01-01T00:00:00.000Z~bad id" },
      { sort: "modified", cursor: "m1~2026-01-01T00:00:00.000Z~a~b" },
      { sort: "modified", cursor: "m2~2026-01-01T00:00:00.000Z~abc" },
      { sort: "modified", cursor: `${goodCursor}~extra` },
      {
        sort: "modified",
        cursor: `m1~${"2026-01-01T00:00:00.000Z"}~${"a".repeat(129)}`,
      },
      { sort: "modified", cursor: "x".repeat(201) },
      { sort: "id", afterId: goodCursor },
      { afterId: goodCursor },
      { afterId: "bad id" },
    ];
    for (const request of rejected) {
      assert.throws(
        () => service.listDrafts(author, request),
        ContentInputError,
        JSON.stringify(request),
      );
    }
    assert.equal(auditCount(database), audits);
    assert.equal(revisionCount(database), revisions);
    // The valid cursor still works afterwards.
    assert.equal(
      service.listDrafts(author, {
        sort: "modified",
        limit: 1,
        cursor: goodCursor,
      }).items.length,
      1,
    );
  });
});

test("listing authorization failures still deny sorted and searched requests", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    seed(service, author, 2);
    const outsider = await principal("outsider");
    const retired = await principal("retired");
    for (const who of [outsider, null, { forged: true }]) {
      assert.throws(
        () =>
          service.listDrafts(who, { sort: "modified", search: "fictional" }),
        AuthorizationError,
      );
    }
    // A disabled account is denied even though the policy lists it.
    database
      .prepare(
        "UPDATE accounts SET status = 'disabled', version = version + 1 WHERE id = 'acct-retired'",
      )
      .run();
    assert.ok(allowSynthetic({ accountId: "acct-retired" }));
    assert.throws(
      () => service.listDrafts(retired, { sort: "modified" }),
      AuthorizationError,
    );
  });
});

test("transport validates, forwards and bounds sort, search and cursor", async () => {
  await withContentFixture(async ({ database, principal, service }) => {
    const author = await principal("author");
    const items = seed(service, author, 5);
    for (const [index, item] of items.entries()) {
      stamp(database, item.id, `2026-05-0${index + 1}T00:00:00.000Z`);
    }
    const api = createContentApiTransport({
      resolvePrincipal: async (request) => {
        const who = request.headers.get("x-synthetic-user");
        return who ? principal(who) : null;
      },
      authorize: () => true,
      operations: createContentTransportOperations(service),
    });
    const send = async (value, who = "author") => {
      const response = await api.fetch(
        new Request(`https://watchdog.invalid${CONTENT_API_PATHS.listDrafts}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-synthetic-user": who,
          },
          body: JSON.stringify(value),
        }),
      );
      return { status: response.status, body: await response.json() };
    };
    const first = await send({ sort: "modified", limit: 2 });
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.body.items.map((i) => i.id),
      [items[4].id, items[3].id],
    );
    assert.match(first.body.nextCursor, /^m1~/);
    const second = await send({
      sort: "modified",
      limit: 2,
      cursor: first.body.nextCursor,
    });
    assert.deepEqual(
      second.body.items.map((i) => i.id),
      [items[2].id, items[1].id],
    );
    const searched = await send({ search: "listing 3", sort: "modified" });
    assert.deepEqual(
      searched.body.items.map((i) => i.id),
      [items[3].id],
    );
    assert.equal((await send({ search: "" })).status, 200);
    assert.equal((await send({ search: null, cursor: null })).status, 200);
    const empty = await send({ search: "no such words" });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, {
      items: [],
      hasMore: false,
      nextCursor: null,
    });

    const bad = [
      { sort: "created" },
      { sort: 1 },
      { search: 7 },
      { search: "x".repeat(601) },
      { search: "x".repeat(101) }, // reaches the service and is rejected there
      { search: "a b c d e f" },
      { cursor: 5 },
      { cursor: "x".repeat(201) },
      { cursor: first.body.nextCursor }, // id sort with a modified cursor
      { sort: "modified", cursor: "m1~garbage" },
      { sort: "modified", afterId: items[0].id },
      { sort: "modified", offset: 1 },
      { sort: "modified", extra: true },
    ];
    for (const value of bad) {
      const result = await send(value);
      assert.equal(result.status, 400, JSON.stringify(value));
      assert.deepEqual(result.body, { error: "invalid_request" });
    }
    // Authorization still applies before anything is read.
    assert.equal((await send({ sort: "modified" }, "outsider")).status, 403);
    const unauth = await api.fetch(
      new Request(`https://watchdog.invalid${CONTENT_API_PATHS.listDrafts}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sort: "modified", search: "x" }),
      }),
    );
    assert.equal(unauth.status, 401);
  });
});

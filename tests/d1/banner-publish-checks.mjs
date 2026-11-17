import { AsyncD1Database } from "../../src/database/d1.ts";
import {
  BannerSnapshotRequiredError,
  D1BannerAdministration,
} from "../../src/services/banner-admin-d1.ts";
import {
  BannerConflictError,
  BannerValidationError,
} from "../../src/services/banner-assets.ts";
import { D1BannerPublicService } from "../../src/services/banner-public.ts";
import { R2BannerObjectStorage } from "../../src/services/banner-storage.ts";
import {
  AuthorizationError,
  makeTrustedPrincipal,
} from "../../src/services/security.ts";
import {
  FaultStorage,
  MemoryR2,
  RevokingDatabase,
} from "./banner-admin-checks.mjs";

const b64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/**
 * BANNER-ADMIN-2: publish, replace, restore, withdraw, metadata and order,
 * against the isolated local D1 with synthetic images and an in-memory bucket.
 */
export async function runBannerPublishChecks(env, fixtures) {
  const checks = [];
  const check = (name, passed) => {
    if (!passed) throw new Error(`Banner publish check failed: ${name}`);
    checks.push(name);
  };
  const rejects = async (name, promise, type) => {
    let value;
    try {
      value = await promise;
    } catch (error) {
      if (!(error instanceof type))
        throw new Error(`Banner publish check failed: ${name}: ${error}`);
      checks.push(name);
      return error;
    }
    throw new Error(
      `Banner publish check failed: ${name}: did not reject ${JSON.stringify(value)}`,
    );
  };
  const files = Object.fromEntries(
    Object.entries(fixtures).map(([name, file]) => [
      name,
      { ...file, bytes: b64(file.base64) },
    ]),
  );
  const sql = async (query, ...values) =>
    env.DB.prepare(query)
      .bind(...values)
      .first();
  const rows = async (query, ...values) =>
    (
      await env.DB.prepare(query)
        .bind(...values)
        .all()
    ).results;
  const count = async (table, where = "1=1", ...values) =>
    (await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...values))
      .n;
  /** Everything a failed change must leave untouched. */
  const snapshot = async (bannerId) => ({
    banner: await sql("SELECT * FROM banner_assets WHERE id = ?", bannerId),
    publications: await count("banner_publications", "banner_id = ?", bannerId),
    ledger: await count("banner_admin_operations"),
    audit: await count("audit_events"),
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (const [id, role] of [
    ["bp-admin", "administrator"],
    ["bp-editor", "editor"],
    ["bp-temp", "administrator"],
    ["bp-temp2", "administrator"],
  ]) {
    await env.DB.prepare(
      "INSERT INTO accounts (id, kind, role, display_name) VALUES (?, 'human', ?, 'Synthetic banner publisher')",
    )
      .bind(id, role)
      .run();
    await env.DB.prepare(
      "INSERT INTO identities (id, account_id, provider, subject) VALUES (?, ?, 'synthetic', ?)",
    )
      .bind(`${id}-identity`, id, id)
      .run();
  }
  const principal = (id, role = "administrator") =>
    makeTrustedPrincipal(
      { id, identity_id: `${id}-identity`, kind: "human", role },
      "synthetic",
    );
  const admin = principal("bp-admin");

  const bucket = new MemoryR2();
  const storage = new FaultStorage(new R2BannerObjectStorage(bucket));
  const db = new AsyncD1Database(env.DB);
  const service = new D1BannerAdministration(db, storage);
  const publicReads = new D1BannerPublicService(db, bucket);

  const text = (caption, altText, displayMode = "cover", focal = 0.5) => ({
    caption,
    altText,
    displayMode,
    focalX: focal,
    focalY: focal,
  });
  const first = text(
    "First caption",
    "Alt text for the first image",
    "cover",
    0.2,
  );
  const second = text(
    "Second caption",
    "Alt text for the second image",
    "contain",
    0.8,
  );
  const third = text(
    "Third caption",
    "Alt text for the third image",
    "cover",
    0.4,
  );
  const draftMeta = (order, primary) => ({
    caption: "Draft caption",
    altText: "Draft alt text",
    displayOrder: order,
    isPrimary: primary,
    displayMode: "cover",
    focalX: 0.5,
    focalY: 0.5,
  });
  const stageNew = async (bannerId, county, file, order, primary, key) =>
    service.stage(admin, {
      bannerId,
      countyFips: county,
      sourceFilename: `${bannerId}.png`,
      bytes: file.bytes,
      idempotencyKey: key,
      target: { kind: "new", metadata: draftMeta(order, primary) },
    });
  const stageNext = async (bannerId, county, file, rowVersion, key) =>
    service.stage(admin, {
      bannerId,
      countyFips: county,
      sourceFilename: `${bannerId}-next.png`,
      bytes: file.bytes,
      idempotencyKey: key,
      target: { kind: "existing", expectedRowVersion: rowVersion },
    });
  const live = async (county) => publicReads.resolveCounty(county);

  // ---- Stage two images. Staging alone exposes nothing.
  const s1 = await stageNew(
    "bp-a",
    "08013",
    files.publishPng1,
    0,
    true,
    "bp-stage-1",
  );
  const v1 = s1.version.id;
  check(
    "a staged and verified image of a draft banner is not public",
    s1.verified && (await live("08013")).length === 0,
  );
  const s2 = await stageNext(
    "bp-a",
    "08013",
    files.publishPng2,
    1,
    "bp-stage-2",
  );
  const v2 = s2.version.id;
  check(
    "a second version stages without changing the banner row",
    s2.bannerRowVersion === 1 && s2.verified,
  );

  // ---- Authority
  const editor = principal("bp-editor", "editor");
  for (const [name, call] of [
    [
      "publish",
      () =>
        service.publish(editor, {
          bannerId: "bp-a",
          versionId: v1,
          expectedRowVersion: 1,
          idempotencyKey: "bp-denied-1",
        }),
    ],
    [
      "restore",
      () =>
        service.restore(editor, {
          bannerId: "bp-a",
          versionId: v1,
          expectedRowVersion: 1,
          idempotencyKey: "bp-denied-2",
        }),
    ],
    [
      "withdraw",
      () =>
        service.withdraw(editor, {
          bannerId: "bp-a",
          expectedRowVersion: 1,
          idempotencyKey: "bp-denied-3",
        }),
    ],
    [
      "update metadata",
      () =>
        service.updateMetadata(editor, {
          bannerId: "bp-a",
          expectedRowVersion: 1,
          idempotencyKey: "bp-denied-4",
          change: { caption: "x" },
        }),
    ],
    [
      "reorder",
      () =>
        service.reorderCounty(editor, {
          countyFips: "08013",
          orderedBannerIds: ["bp-a"],
          expectedRowVersions: { "bp-a": 1 },
          idempotencyKey: "bp-denied-5",
        }),
    ],
    ["list publications", () => service.listPublications(editor, "bp-a")],
  ])
    await rejects(`editor cannot ${name}`, call(), AuthorizationError);
  check(
    "denied attempts wrote nothing",
    (await count("banner_publications")) === 0 &&
      (await count("banner_admin_operations")) === 0 &&
      (await count(
        "audit_events",
        "action LIKE 'banner.publ%' OR action = 'banner.withdrawn' OR action = 'banner.restored'",
      )) === 0,
  );

  // ---- Publish
  const publish1 = await service.publish(admin, {
    bannerId: "bp-a",
    versionId: v1,
    expectedRowVersion: 1,
    idempotencyKey: "bp-publish-1",
    metadata: first,
  });
  check(
    "publish selects the version and activates the banner",
    publish1.status === "active" &&
      publish1.selectedVersionId === v1 &&
      publish1.rowVersion === 2 &&
      !publish1.replayed &&
      typeof publish1.publicationId === "string",
  );
  const exposed1 = await live("08013");
  check(
    "the public reader exposes the selected version with the published text",
    exposed1.length === 1 &&
      exposed1[0].versionId === v1 &&
      exposed1[0].caption === first.caption &&
      exposed1[0].altText === first.altText &&
      exposed1[0].displayMode === "cover" &&
      exposed1[0].focalX === 0.2,
  );
  const delivered1 = await publicReads.deliver(v1);
  check(
    "the public bytes are the verified image",
    delivered1 !== null &&
      delivered1.body.length === files.publishPng1.bytes.length &&
      delivered1.contentType === "image/png",
  );
  check(
    "an unselected verified version is not delivered",
    (await publicReads.deliver(v2)) === null,
  );
  const pub1 = (await service.listPublications(admin, "bp-a"))[0];
  check(
    "the publication record keeps the version and its text",
    pub1.id === publish1.publicationId &&
      pub1.versionId === v1 &&
      pub1.sequence === 1 &&
      pub1.origin === "publish" &&
      pub1.caption === first.caption &&
      pub1.altText === first.altText &&
      pub1.focalX === 0.2 &&
      pub1.bannerRowVersion === 2 &&
      pub1.publishedByAccountId === "bp-admin",
  );
  const auditPublish = await sql(
    "SELECT actor_account_id, details_json FROM audit_events WHERE action = 'banner.published' AND target_id = 'bp-a'",
  );
  check(
    "the publish audit event names the actor, version and publication",
    auditPublish.actor_account_id === "bp-admin" &&
      auditPublish.details_json.includes(v1) &&
      auditPublish.details_json.includes(publish1.publicationId) &&
      !auditPublish.details_json.includes(first.caption),
  );
  check(
    "publish marks the stage operation activated",
    (
      await sql(
        "SELECT state FROM banner_stage_operations WHERE version_id = ?",
        v1,
      )
    ).state === "activated",
  );

  // ---- Retries
  const before = await snapshot("bp-a");
  const replay = await service.publish(admin, {
    bannerId: "bp-a",
    versionId: v1,
    expectedRowVersion: 1,
    idempotencyKey: "bp-publish-1",
    metadata: first,
  });
  check(
    "a repeated publish returns the stored result and writes nothing",
    replay.replayed &&
      replay.publicationId === publish1.publicationId &&
      replay.rowVersion === 2 &&
      same(before, await snapshot("bp-a")),
  );
  await rejects(
    "the same key with a different request is a conflict",
    service.publish(admin, {
      bannerId: "bp-a",
      versionId: v2,
      expectedRowVersion: 1,
      idempotencyKey: "bp-publish-1",
      metadata: first,
    }),
    BannerConflictError,
  );
  await rejects(
    "the same key from another account is a conflict",
    service.publish(principal("bp-temp"), {
      bannerId: "bp-a",
      versionId: v1,
      expectedRowVersion: 1,
      idempotencyKey: "bp-publish-1",
      metadata: first,
    }),
    BannerConflictError,
  );
  check(
    "conflicting retries changed nothing",
    same(before, await snapshot("bp-a")),
  );

  // ---- Replace
  const publish2 = await service.publish(admin, {
    bannerId: "bp-a",
    versionId: v2,
    expectedRowVersion: 2,
    idempotencyKey: "bp-publish-2",
    metadata: second,
  });
  const exposed2 = await live("08013");
  check(
    "replacing publishes the new image with its own text",
    publish2.rowVersion === 3 &&
      exposed2.length === 1 &&
      exposed2[0].versionId === v2 &&
      exposed2[0].caption === second.caption &&
      exposed2[0].displayMode === "contain" &&
      (await publicReads.deliver(v1)) === null &&
      (await publicReads.deliver(v2)) !== null,
  );

  // ---- Stale writes
  const beforeStale = await snapshot("bp-a");
  for (const [name, call] of [
    [
      "publish",
      () =>
        service.publish(admin, {
          bannerId: "bp-a",
          versionId: v1,
          expectedRowVersion: 2,
          idempotencyKey: "bp-stale-1",
          metadata: first,
        }),
    ],
    [
      "restore",
      () =>
        service.restore(admin, {
          bannerId: "bp-a",
          versionId: v1,
          expectedRowVersion: 2,
          idempotencyKey: "bp-stale-2",
        }),
    ],
    [
      "withdraw",
      () =>
        service.withdraw(admin, {
          bannerId: "bp-a",
          expectedRowVersion: 2,
          idempotencyKey: "bp-stale-3",
        }),
    ],
    [
      "metadata update",
      () =>
        service.updateMetadata(admin, {
          bannerId: "bp-a",
          expectedRowVersion: 2,
          idempotencyKey: "bp-stale-4",
          change: { caption: "stale" },
        }),
    ],
  ])
    await rejects(`a stale ${name} is refused`, call(), BannerConflictError);
  check(
    "stale writes left the banner, history, ledger and audit untouched",
    same(beforeStale, await snapshot("bp-a")),
  );

  // ---- Restore the earlier image and its text
  const restore1 = await service.restore(admin, {
    bannerId: "bp-a",
    versionId: v1,
    expectedRowVersion: 3,
    idempotencyKey: "bp-restore-1",
  });
  const exposed3 = await live("08013");
  check(
    "restoring an earlier version brings back its image and its text",
    restore1.selectedVersionId === v1 &&
      restore1.rowVersion === 4 &&
      exposed3[0].versionId === v1 &&
      exposed3[0].caption === first.caption &&
      exposed3[0].altText === first.altText &&
      exposed3[0].displayMode === "cover" &&
      exposed3[0].focalX === 0.2,
  );
  const restored = (await service.listPublications(admin, "bp-a"))[0];
  check(
    "the restore is a new publication that points at the one it copied",
    restored.sequence === 3 &&
      restored.origin === "restore_recorded" &&
      restored.restoredFromPublicationId === publish1.publicationId,
  );

  // ---- A version published twice with different text
  const publish3 = await service.publish(admin, {
    bannerId: "bp-a",
    versionId: v2,
    expectedRowVersion: 4,
    idempotencyKey: "bp-publish-3",
    metadata: third,
  });
  const forV2 = (await service.listPublications(admin, "bp-a")).filter(
    (p) => p.versionId === v2,
  );
  check(
    "a version published twice keeps both texts",
    forV2.length === 2 &&
      forV2[0].caption === third.caption &&
      forV2[1].caption === second.caption,
  );
  const restoreLatest = await service.restore(admin, {
    bannerId: "bp-a",
    versionId: v1,
    expectedRowVersion: 5,
    idempotencyKey: "bp-restore-latest-v1",
  });
  const restoreChosen = await service.restore(admin, {
    bannerId: "bp-a",
    versionId: v2,
    expectedRowVersion: restoreLatest.rowVersion,
    idempotencyKey: "bp-restore-chosen",
    publicationId: forV2[1].id,
  });
  const exposed4 = await live("08013");
  check(
    "restore can choose which recorded publication of a version to bring back",
    exposed4[0].versionId === v2 &&
      exposed4[0].caption === second.caption &&
      exposed4[0].focalX === 0.8 &&
      restoreChosen.publicationId !== null,
  );
  const restoreDefault = await service.restore(admin, {
    bannerId: "bp-a",
    versionId: v2,
    expectedRowVersion: restoreChosen.rowVersion,
    idempotencyKey: "bp-restore-default",
  });
  const exposed5 = await live("08013");
  check(
    "restore without a choice uses the latest recorded publication of the version",
    exposed5[0].caption === second.caption &&
      restoreDefault.rowVersion === restoreChosen.rowVersion + 1,
  );
  await rejects(
    "a publication of another version cannot be used",
    service.restore(admin, {
      bannerId: "bp-a",
      versionId: v1,
      expectedRowVersion: restoreDefault.rowVersion,
      idempotencyKey: "bp-restore-wrong",
      publicationId: forV2[0].id,
    }),
    BannerConflictError,
  );
  await rejects(
    "a recorded publication and explicit text cannot be combined",
    service.restore(admin, {
      bannerId: "bp-a",
      versionId: v2,
      expectedRowVersion: restoreDefault.rowVersion,
      idempotencyKey: "bp-restore-both",
      publicationId: forV2[0].id,
      metadata: third,
    }),
    BannerValidationError,
  );

  // ---- Withdraw, then restore again
  const row = await sql("SELECT version FROM banner_assets WHERE id = 'bp-a'");
  const withdrawn = await service.withdraw(admin, {
    bannerId: "bp-a",
    expectedRowVersion: row.version,
    idempotencyKey: "bp-withdraw-1",
  });
  check(
    "withdraw removes the banner from public view and keeps its selection",
    withdrawn.status === "withdrawn" &&
      withdrawn.selectedVersionId === v2 &&
      (await live("08013")).length === 0 &&
      (await publicReads.deliver(v2)) === null,
  );
  check(
    "withdraw audit names the actor",
    (
      await sql(
        "SELECT actor_account_id FROM audit_events WHERE action = 'banner.withdrawn' AND target_id = 'bp-a'",
      )
    ).actor_account_id === "bp-admin",
  );
  await rejects(
    "an already withdrawn banner cannot be withdrawn again",
    service.withdraw(admin, {
      bannerId: "bp-a",
      expectedRowVersion: withdrawn.rowVersion,
      idempotencyKey: "bp-withdraw-2",
    }),
    BannerConflictError,
  );
  const again = await service.restore(admin, {
    bannerId: "bp-a",
    versionId: v2,
    expectedRowVersion: withdrawn.rowVersion,
    idempotencyKey: "bp-restore-again",
  });
  const exposed6 = await live("08013");
  check(
    "restoring after a withdrawal makes the banner public again with its text",
    again.status === "active" &&
      exposed6.length === 1 &&
      exposed6[0].versionId === v2 &&
      exposed6[0].caption === second.caption,
  );

  // ---- A retained version with no recorded publication needs explicit text
  const s3 = await stageNext(
    "bp-a",
    "08013",
    files.publishPng3,
    again.rowVersion,
    "bp-stage-3",
  );
  const v3 = s3.version.id;
  const beforeNoSnapshot = await snapshot("bp-a");
  const needs = await rejects(
    "a version never published needs explicit text to be restored",
    service.restore(admin, {
      bannerId: "bp-a",
      versionId: v3,
      expectedRowVersion: again.rowVersion,
      idempotencyKey: "bp-restore-v3",
    }),
    BannerSnapshotRequiredError,
  );
  check(
    "the refusal says explicit text is needed and changed nothing",
    needs instanceof BannerConflictError &&
      same(beforeNoSnapshot, await snapshot("bp-a")),
  );
  await rejects(
    "explicit restore text must include alt text",
    service.restore(admin, {
      bannerId: "bp-a",
      versionId: v3,
      expectedRowVersion: again.rowVersion,
      idempotencyKey: "bp-restore-blank",
      metadata: { ...third, altText: "   " },
    }),
    BannerValidationError,
  );
  const explicit = await service.restore(admin, {
    bannerId: "bp-a",
    versionId: v3,
    expectedRowVersion: again.rowVersion,
    idempotencyKey: "bp-restore-explicit",
    metadata: third,
  });
  const explicitRecord = (await service.listPublications(admin, "bp-a"))[0];
  check(
    "explicit text is recorded as explicit, apart from recorded history",
    explicitRecord.id === explicit.publicationId &&
      explicitRecord.origin === "restore_explicit" &&
      explicitRecord.restoredFromPublicationId === null &&
      (await live("08013"))[0].caption === third.caption,
  );

  // ---- Metadata updates
  const edit = await service.updateMetadata(admin, {
    bannerId: "bp-a",
    expectedRowVersion: explicit.rowVersion,
    idempotencyKey: "bp-edit-1",
    change: { caption: "Edited caption", focalX: 0.9 },
  });
  const edited = (await service.listPublications(admin, "bp-a"))[0];
  check(
    "a live text edit changes the public text and records a publication",
    edit.rowVersion === explicit.rowVersion + 1 &&
      edit.publicationId === edited.id &&
      edited.origin === "metadata_edit" &&
      edited.versionId === v3 &&
      edited.caption === "Edited caption" &&
      edited.altText === third.altText &&
      (await live("08013"))[0].caption === "Edited caption",
  );
  const publicationsBeforeOrder = await count(
    "banner_publications",
    "banner_id = 'bp-a'",
  );
  const orderOnly = await service.updateMetadata(admin, {
    bannerId: "bp-a",
    expectedRowVersion: edit.rowVersion,
    idempotencyKey: "bp-edit-2",
    change: { displayOrder: 3 },
  });
  check(
    "a change to order alone records no publication",
    orderOnly.publicationId === null &&
      (await count("banner_publications", "banner_id = 'bp-a'")) ===
        publicationsBeforeOrder,
  );
  await rejects(
    "an active banner cannot be given blank alt text",
    service.updateMetadata(admin, {
      bannerId: "bp-a",
      expectedRowVersion: orderOnly.rowVersion,
      idempotencyKey: "bp-edit-3",
      change: { altText: "  " },
    }),
    BannerValidationError,
  );
  await rejects(
    "unknown metadata fields are refused",
    service.updateMetadata(admin, {
      bannerId: "bp-a",
      expectedRowVersion: orderOnly.rowVersion,
      idempotencyKey: "bp-edit-4",
      change: { selectedVersionId: v1 },
    }),
    BannerValidationError,
  );
  await rejects(
    "an empty change is refused",
    service.updateMetadata(admin, {
      bannerId: "bp-a",
      expectedRowVersion: orderOnly.rowVersion,
      idempotencyKey: "bp-edit-5",
      change: {},
    }),
    BannerValidationError,
  );

  // ---- A second banner in the county: primary and order rules
  const sb = await stageNew(
    "bp-b",
    "08013",
    files.publishPng4,
    1,
    false,
    "bp-stage-b",
  );
  const rowB = (
    await sql("SELECT version FROM banner_assets WHERE id = 'bp-b'")
  ).version;
  await rejects(
    "a display order already used in the county is refused",
    service.updateMetadata(admin, {
      bannerId: "bp-b",
      expectedRowVersion: rowB,
      idempotencyKey: "bp-edit-order",
      change: { displayOrder: 3 },
    }),
    BannerConflictError,
  );
  const primary = await service.updateMetadata(admin, {
    bannerId: "bp-b",
    expectedRowVersion: rowB,
    idempotencyKey: "bp-edit-primary",
    change: { isPrimary: true },
  });
  const primaries = await rows(
    "SELECT id FROM banner_assets WHERE county_fips = '08013' AND is_primary = 1",
  );
  check(
    "making a banner primary clears the previous primary in one write",
    primary.rowVersion === rowB + 1 &&
      primaries.length === 1 &&
      primaries[0].id === "bp-b",
  );
  await service.publish(admin, {
    bannerId: "bp-b",
    versionId: sb.version.id,
    expectedRowVersion: primary.rowVersion,
    idempotencyKey: "bp-publish-b",
  });
  check(
    "publish without text uses the banner's current text",
    (
      await sql(
        "SELECT origin, caption FROM banner_publications WHERE banner_id = 'bp-b'",
      )
    ).caption === "Draft caption",
  );

  // ---- Reorder
  const versions = async () =>
    Object.fromEntries(
      (
        await rows(
          "SELECT id, version FROM banner_assets WHERE county_fips = '08013'",
        )
      ).map((r) => [r.id, r.version]),
    );
  const staleVersions = await versions();
  const reorder = await service.reorderCounty(admin, {
    countyFips: "08013",
    orderedBannerIds: ["bp-b", "bp-a"],
    expectedRowVersions: staleVersions,
    idempotencyKey: "bp-reorder-1",
  });
  const afterReorder = await rows(
    "SELECT id, display_order, version FROM banner_assets WHERE county_fips = '08013' ORDER BY display_order",
  );
  check(
    "reorder swaps the county order atomically and reports each new row version",
    afterReorder[0].id === "bp-b" &&
      afterReorder[0].display_order === 0 &&
      afterReorder[1].id === "bp-a" &&
      afterReorder[1].display_order === 1 &&
      reorder.banners.every(
        (b) =>
          b.rowVersion ===
          afterReorder.find((r) => r.id === b.bannerId).version,
      ),
  );
  check(
    "public county reads return the same banners, in a random order",
    (await live("08013"))
      .map((b) => b.bannerId)
      .sort()
      .join() === "bp-a,bp-b",
  );
  const replayedOrder = await service.reorderCounty(admin, {
    countyFips: "08013",
    orderedBannerIds: ["bp-b", "bp-a"],
    expectedRowVersions: staleVersions,
    idempotencyKey: "bp-reorder-1",
  });
  check("a repeated reorder is replayed", replayedOrder.replayed);
  const beforeOrderFail = await snapshot("bp-a");
  await rejects(
    "a reorder with stale row versions is refused",
    service.reorderCounty(admin, {
      countyFips: "08013",
      orderedBannerIds: ["bp-a", "bp-b"],
      expectedRowVersions: staleVersions,
      idempotencyKey: "bp-reorder-2",
    }),
    BannerConflictError,
  );
  const currentVersions = await versions();
  await rejects(
    "a reorder that leaves a banner out is refused",
    service.reorderCounty(admin, {
      countyFips: "08013",
      orderedBannerIds: ["bp-a"],
      expectedRowVersions: currentVersions,
      idempotencyKey: "bp-reorder-3",
    }),
    BannerConflictError,
  );
  await rejects(
    "an unchanged order is refused",
    service.reorderCounty(admin, {
      countyFips: "08013",
      orderedBannerIds: ["bp-b", "bp-a"],
      expectedRowVersions: currentVersions,
      idempotencyKey: "bp-reorder-4",
    }),
    BannerValidationError,
  );
  check(
    "failed reorders changed nothing",
    same(beforeOrderFail, await snapshot("bp-a")),
  );

  // ---- Missing, corrupt and unverified objects
  const sc = await stageNew(
    "bp-c",
    "08015",
    files.publishPng5,
    0,
    true,
    "bp-stage-c",
  );
  const rowC = 1;
  const objectKey = (
    await sql(
      "SELECT object_key FROM banner_asset_versions WHERE id = ?",
      sc.version.id,
    )
  ).object_key;
  const savedObject = bucket.objects.get(objectKey);
  const beforeC = await snapshot("bp-c");
  bucket.objects.delete(objectKey);
  await rejects(
    "publish refuses a version whose object is missing",
    service.publish(admin, {
      bannerId: "bp-c",
      versionId: sc.version.id,
      expectedRowVersion: rowC,
      idempotencyKey: "bp-missing",
      metadata: first,
    }),
    BannerConflictError,
  );
  bucket.objects.set(objectKey, savedObject);
  storage.corruptNextGet = true;
  await rejects(
    "publish refuses an object that fails the digest check",
    service.publish(admin, {
      bannerId: "bp-c",
      versionId: sc.version.id,
      expectedRowVersion: rowC,
      idempotencyKey: "bp-corrupt",
      metadata: first,
    }),
    BannerConflictError,
  );
  const wrongMeta = {
    ...savedObject,
    customMetadata: {
      ...savedObject.customMetadata,
      versionId: "another-version",
    },
  };
  bucket.objects.set(objectKey, wrongMeta);
  await rejects(
    "publish refuses an object whose stored version id does not match",
    service.publish(admin, {
      bannerId: "bp-c",
      versionId: sc.version.id,
      expectedRowVersion: rowC,
      idempotencyKey: "bp-wrongmeta",
      metadata: first,
    }),
    BannerConflictError,
  );
  bucket.objects.set(objectKey, savedObject);
  await env.DB.prepare(
    `INSERT INTO banner_asset_versions (id, banner_id, source_filename, sha256, width, height, aspect_ratio, byte_size, media_type, object_key, state)
     VALUES ('bp-pending-version', 'bp-c', 'p.png', ?, 10, 5, 2.0, 100, 'image/png', 'banner-assets/bp-pending-version', 'pending')`,
  )
    .bind("a".repeat(64))
    .run();
  await rejects(
    "publish refuses a version that is not verified",
    service.publish(admin, {
      bannerId: "bp-c",
      versionId: "bp-pending-version",
      expectedRowVersion: rowC,
      idempotencyKey: "bp-unverified",
      metadata: first,
    }),
    BannerConflictError,
  );
  await rejects(
    "publish refuses a version that belongs to another banner",
    service.publish(admin, {
      bannerId: "bp-c",
      versionId: v1,
      expectedRowVersion: rowC,
      idempotencyKey: "bp-foreign",
      metadata: first,
    }),
    BannerConflictError,
  );
  await rejects(
    "publish refuses blank alt text",
    service.publish(admin, {
      bannerId: "bp-c",
      versionId: sc.version.id,
      expectedRowVersion: rowC,
      idempotencyKey: "bp-blank",
      metadata: { ...first, altText: "" },
    }),
    BannerValidationError,
  );
  check(
    "refused publishes left the banner private with no history, ledger or audit",
    same(beforeC, await snapshot("bp-c")) && (await live("08015")).length === 0,
  );
  const goodC = await service.publish(admin, {
    bannerId: "bp-c",
    versionId: sc.version.id,
    expectedRowVersion: rowC,
    idempotencyKey: "bp-good-c",
    metadata: first,
  });
  check(
    "the same version publishes once its object is intact again",
    goodC.status === "active" && (await live("08015")).length === 1,
  );

  // ---- Concurrent identical requests
  const sd = await stageNew(
    "bp-d",
    "08017",
    files.publishPng6,
    0,
    true,
    "bp-stage-d",
  );
  const race = await Promise.allSettled(
    [0, 1].map(() =>
      service.publish(admin, {
        bannerId: "bp-d",
        versionId: sd.version.id,
        expectedRowVersion: 1,
        idempotencyKey: "bp-race",
        metadata: first,
      }),
    ),
  );
  check(
    "two simultaneous identical publishes produce one change",
    race.every((r) => r.status === "fulfilled") &&
      race.filter((r) => !r.value.replayed).length >= 1 &&
      race[0].value.publicationId === race[1].value.publicationId &&
      (await count("banner_publications", "banner_id = 'bp-d'")) === 1 &&
      (await count(
        "banner_admin_operations",
        "idempotency_key = 'bp-race'",
      )) === 1 &&
      (await count(
        "audit_events",
        "action = 'banner.published' AND target_id = 'bp-d'",
      )) === 1,
  );

  // ---- Authority lost while the change is in flight
  const se = await stageNew(
    "bp-e",
    "08019",
    files.publishJpeg,
    0,
    true,
    "bp-stage-e",
  );
  const revoking = new RevokingDatabase(env.DB);
  const guardedService = new D1BannerAdministration(revoking, storage);
  const beforeE = await snapshot("bp-e");
  revoking.hook = () =>
    env.DB.prepare(
      "UPDATE identities SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1 WHERE id = 'bp-temp-identity'",
    ).run();
  await rejects(
    "a principal revoked between the check and the batch cannot publish",
    guardedService.publish(principal("bp-temp"), {
      bannerId: "bp-e",
      versionId: se.version.id,
      expectedRowVersion: 1,
      idempotencyKey: "bp-revoked",
      metadata: first,
    }),
    AuthorizationError,
  );
  check(
    "the guarded batch itself rejected the write and nothing was recorded",
    revoking.guardedFailures >= 1 &&
      same(beforeE, await snapshot("bp-e")) &&
      (await count(
        "banner_admin_operations",
        "idempotency_key = 'bp-revoked'",
      )) === 0 &&
      (await live("08019")).length === 0,
  );
  const goodE = await service.publish(admin, {
    bannerId: "bp-e",
    versionId: se.version.id,
    expectedRowVersion: 1,
    idempotencyKey: "bp-revoked",
    metadata: first,
  });
  check(
    "the key of a failed attempt stays usable by an authorized caller",
    goodE.status === "active" && !goodE.replayed,
  );

  // ---- History cannot be rewritten
  for (const [name, statement] of [
    [
      "a publication record cannot be edited",
      "UPDATE banner_publications SET caption = 'x'",
    ],
    [
      "a publication record cannot be deleted",
      "DELETE FROM banner_publications",
    ],
    [
      "an administration ledger entry cannot be edited",
      "UPDATE banner_admin_operations SET result_json = '{}'",
    ],
    [
      "a verified image version cannot change its digest",
      "UPDATE banner_asset_versions SET sha256 = '" +
        "b".repeat(64) +
        "' WHERE state = 'verified'",
    ],
  ]) {
    let blocked = false;
    try {
      await env.DB.prepare(statement).run();
    } catch {
      blocked = true;
    }
    check(name, blocked);
  }
  let skipped = false;
  try {
    await env.DB.prepare(
      "INSERT INTO banner_publications (id, banner_id, version_id, sequence, origin, caption, alt_text, display_mode, focal_x, focal_y, banner_row_version, published_by_account_id) VALUES ('bp-hole', 'bp-a', ?, 99, 'publish', '', 'alt', 'cover', 0.5, 0.5, 1, 'bp-admin')",
    )
      .bind(v1)
      .run();
  } catch {
    skipped = true;
  }
  check("publication sequence numbers cannot skip", skipped);

  // ---- Audit consistency
  const published = await count("audit_events", "action = 'banner.published'");
  const restoredCount = await count(
    "audit_events",
    "action = 'banner.restored'",
  );
  const publications = await count("banner_publications");
  check(
    "every publication record has exactly one matching audit event",
    (await count(
      "banner_publications p",
      "p.origin IN ('publish','restore_recorded','restore_explicit') AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.target_id = p.banner_id AND a.details_json LIKE '%' || p.id || '%')",
    )) === 0 &&
      published + restoredCount >= 1 &&
      publications > 10,
  );
  check(
    "no audit event or result carries an object key or caption text",
    (await count("audit_events", "details_json LIKE '%banner-assets/%'")) ===
      0 &&
      !JSON.stringify(await service.listPublications(admin, "bp-a")).includes(
        "banner-assets/",
      ),
  );
  check(
    "every ledger entry has an acting account",
    (await count(
      "banner_admin_operations",
      "account_id IS NULL OR account_id = ''",
    )) === 0,
  );

  return { success: true, checks };
}

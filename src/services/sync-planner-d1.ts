import {
  ALTERNATE_NAME_TYPES,
  PROFILES_MAX_NAME_AFFIX_LENGTH,
  PROFILES_MAX_NAME_COMPONENT_LENGTH,
  PROFILES_MAX_NAME_LENGTH,
} from "../contracts/profiles.js";
import { IMPORT_ROLE_TEXT_LIMITS } from "../contracts/profiles-import.js";
import type {
  PlannedSyncItem,
  SyncEntity,
  SyncErrorCode,
  SyncPlan,
  SyncPlanError,
} from "../contracts/sync.js";
import {
  MAX_SYNC_DUPLICATE_FLAGS,
  MAX_SYNC_ITEM_BYTES,
  MAX_SYNC_REQUEST_BYTES,
} from "../contracts/sync.js";
import type { AsyncD1Database } from "../database/d1.js";
import { SyncPlanReads } from "./sync-plan-reads-d1.js";

const MAX_DEPTH = 64;
const MAX_DIAGNOSTICS = 200;
const CREATE = new Map<string, SyncEntity>([
  ["create_organization", "organizations"],
  ["add_county_affiliation", "organization_county_affiliations"],
  ["create_person", "people"],
  ["create_position", "positions"],
  ["register_source", "role_sources"],
  ["create_person_role", "person_roles"],
  ["create_profile_name", "profile_names"],
]);
const UPDATE_FIELDS: Record<string, readonly string[]> = {
  organizations: [
    "name",
    "organization_type",
    "county_fips",
    "parent_organization_id",
    "parent_relationship",
  ],
  people: [
    "display_name",
    "first_name",
    "middle_name",
    "last_name",
    "name_prefix",
    "name_suffix",
    "preferred_first_name",
  ],
  positions: ["title"],
  role_sources: ["title"],
  person_roles: ["start_date", "end_date", "source_checked_at", "source_id"],
  organization_county_affiliations: [],
  profile_names: [
    "name_type",
    "published_name",
    "first_name",
    "middle_name",
    "last_name",
    "name_prefix",
    "name_suffix",
    "applies_from",
    "applies_until",
  ],
};
const ROLE_TEXT_FIELDS = Object.entries(IMPORT_ROLE_TEXT_LIMITS);
const IMPORT_ROLE_UPDATE_FIELDS = [
  ...(UPDATE_FIELDS.person_roles ?? []),
  ...Object.keys(IMPORT_ROLE_TEXT_LIMITS),
];
/** Component fields and their length limits. Affixes are shorter. */
const NAME_COMPONENT_LIMITS: Readonly<Record<string, number>> = {
  first_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  middle_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  last_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  preferred_first_name: PROFILES_MAX_NAME_COMPONENT_LENGTH,
  name_prefix: PROFILES_MAX_NAME_AFFIX_LENGTH,
  name_suffix: PROFILES_MAX_NAME_AFFIX_LENGTH,
};
const ENUMS: Record<string, readonly string[]> = {
  organization_type: [
    "county_government",
    "office",
    "department",
    "division",
    "regional",
    "partner",
    "other",
  ],
  parent_relationship: ["reports_to", "grouped_under"],
  name_type: ALTERNATE_NAME_TYPES,
  relationship_type: ["serves", "partner_for", "shared_service"],
  source_type: ["official_page", "public_document", "other_public"],
  publisher_classification: ["official", "unofficial"],
};
const REF_KEYS: Record<
  string,
  { id: string; ref: string; entity: SyncEntity }[]
> = {
  organizations: [
    {
      id: "parent_organization_id",
      ref: "parent_organization_ref",
      entity: "organizations",
    },
  ],
  organization_county_affiliations: [
    { id: "organization_id", ref: "organization_ref", entity: "organizations" },
  ],
  positions: [
    { id: "organization_id", ref: "organization_ref", entity: "organizations" },
  ],
  person_roles: [
    { id: "person_id", ref: "person_ref", entity: "people" },
    { id: "position_id", ref: "position_ref", entity: "positions" },
    { id: "source_id", ref: "source_ref", entity: "role_sources" },
  ],
  profile_names: [{ id: "person_id", ref: "person_ref", entity: "people" }],
};
const TABLES: readonly SyncEntity[] = [
  "organizations",
  "organization_county_affiliations",
  "people",
  "positions",
  "role_sources",
  "person_roles",
  "profile_names",
];
const SAFE_MESSAGES: Record<SyncErrorCode, string> = {
  invalid_request: "The changeset structure is invalid.",
  request_too_large: "The request exceeds the 8 MiB limit.",
  no_changes: "A changeset must contain at least one change.",
  item_too_large: "A change exceeds the 32 KiB item limit.",
  unsupported_operation: "The requested operation is not supported.",
  unsupported_entity: "The entity is outside the M1 synchronization scope.",
  unsupported_field: "A field is not allowed for this operation.",
  missing_field: "A required field is missing.",
  invalid_field: "A field has an invalid value.",
  invalid_enum: "A field contains an unsupported value.",
  invalid_date: "Dates must be valid YYYY-MM-DD calendar dates.",
  invalid_timestamp: "The source check time must be an RFC 3339 UTC timestamp.",
  future_timestamp: "The source check time is too far in the future.",
  invalid_url: "The source URL is invalid.",
  unknown_county: "The county is not in the Website county registry.",
  missing_target: "The target record does not exist.",
  stale_version:
    "The target record changed; read its current version before retrying.",
  duplicate_target: "A target can be updated only once per changeset.",
  duplicate_client_ref: "Temporary client references must be unique.",
  invalid_reference: "A relationship reference is missing or unknown.",
  forward_reference: "Temporary references must target an earlier create item.",
  wrong_entity_reference:
    "The temporary reference points to an incompatible entity.",
  client_ref_in_id_field:
    "A temporary reference must use the matching ref field.",
  relationship_conflict:
    "Supply exactly one existing ID or temporary reference.",
  hierarchy_cycle: "The organization hierarchy would contain a cycle.",
  hierarchy_too_deep:
    "The organization hierarchy exceeds the planning depth limit.",
  hierarchy_county_mismatch:
    "Parent and child organizations must have the same county value.",
  county_change_splits_hierarchy:
    "The county change would split an existing hierarchy.",
  duplicate_affiliation:
    "That organization and county affiliation already exists.",
  duplicate_source_url:
    "The source URL already exists with different metadata.",
  source_metadata_conflict: "The source URL exists with incompatible metadata.",
  source_check_required:
    "Changing a role source requires a new source check time.",
  role_detail_required:
    "A role needs a position link, an office, a title or a job description.",
  date_order: "The end date must not precede the start date.",
  too_many_duplicate_flags: "A request may contain at most 20 duplicate flags.",
  duplicate_flag_invalid: "A duplicate flag is invalid or blocking.",
  commit_not_supported: "Commit intent is not available in the M2-B planner.",
  invalid_idempotency_key: "The idempotency key is invalid.",
  idempotency_mismatch:
    "This idempotency key is already associated with a different request.",
  commit_conflict: "The changeset conflicted with current Website data.",
};

/** Internal, unexposed read-only planner. It never opens a transaction or generates persistent IDs. */
/**
 * Plans a changeset against Website D1 without writing. Reads are set-based: one
 * bounded query per entity and chunk, not one per item. Pass `reads` to reuse the
 * lookups of an earlier plan, which is correct only under the caller's
 * dependency-generation guard (see SyncPlanReads).
 */
export async function planSyncChangesetD1(
  database: AsyncD1Database,
  input: unknown,
  now: () => Date = () => new Date(),
  reads?: SyncPlanReads,
  options: {
    maxRequestBytes?: number;
    allowRolesWithoutSource?: boolean;
    allowImporterRoleTextUpdates?: boolean;
  } = {},
): Promise<SyncPlan> {
  const maxRequestBytes = options.maxRequestBytes ?? MAX_SYNC_REQUEST_BYTES;
  const errors: SyncPlanError[] = [];
  const add = (
    code: SyncErrorCode,
    itemIndex?: number,
    clientRef?: string,
    currentVersion?: number,
  ) => {
    if (errors.length >= MAX_DIAGNOSTICS) return;
    errors.push({
      code,
      ...(itemIndex === undefined ? {} : { itemIndex }),
      ...(clientRef ? { clientRef } : {}),
      ...(currentVersion === undefined ? {} : { currentVersion }),
      message:
        code === "request_too_large" &&
        maxRequestBytes !== MAX_SYNC_REQUEST_BYTES
          ? `The request exceeds the ${maxRequestBytes / 1024 / 1024} MiB limit.`
          : SAFE_MESSAGES[code],
    });
  };
  const requestId =
    record(input) && typeof input.requestId === "string"
      ? safeRef(input.requestId)
      : null;
  if (
    !record(input) ||
    !closed(input, [
      "contractVersion",
      "requestId",
      "intent",
      "changes",
      "duplicateFlags",
    ]) ||
    input.contractVersion !== "m2-sync/v1" ||
    typeof input.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.requestId,
    ) ||
    !Array.isArray(input.changes)
  ) {
    add("invalid_request");
    return result(requestId, [], errors, []);
  }
  let totalBytes: number;
  try {
    totalBytes = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    add("invalid_request");
    return result(requestId, [], errors, []);
  }
  if (totalBytes > maxRequestBytes) {
    add("request_too_large");
    return result(requestId, [], errors, []);
  }
  if (input.changes.length < 1) {
    add("no_changes");
    return result(requestId, [], errors, []);
  }
  for (let i = 0; i < input.changes.length; i++) {
    const candidate = input.changes[i];
    if (!record(candidate)) {
      add("invalid_request", i);
      continue;
    }
    try {
      if (
        new TextEncoder().encode(JSON.stringify(candidate)).length >
        MAX_SYNC_ITEM_BYTES
      )
        add("item_too_large", i);
    } catch {
      add("invalid_request", i);
    }
  }
  if (errors.length) return result(requestId, [], errors, []);
  if (input.intent !== "dry_run" && input.intent !== "commit")
    add("invalid_field");
  if (input.intent === "commit") add("commit_not_supported");
  const flags = validateFlags(input.duplicateFlags, add);
  const lookups = reads ?? new SyncPlanReads(database);
  if (!reads) await lookups.prefetch(input);
  const items: PlannedSyncItem[] = [];
  const refs = new Map<
    string,
    { entity: SyncEntity; index: number; fields?: Record<string, unknown> }
  >();
  const futureRefs = new Map<string, { entity: SyncEntity; index: number }>();
  const plannedUrls = new Map<
    string,
    {
      title: unknown;
      source_type: unknown;
      publisher_classification: unknown;
      clientRef: string;
    }
  >();
  const plannedAffiliations = new Set<string>();
  const targets = new Set<string>();
  for (let i = 0; i < input.changes.length; i++) {
    const candidate = input.changes[i];
    if (
      record(candidate) &&
      typeof candidate.op === "string" &&
      CREATE.has(candidate.op) &&
      typeof candidate.clientRef === "string" &&
      !futureRefs.has(candidate.clientRef)
    )
      futureRefs.set(candidate.clientRef, {
        entity: CREATE.get(candidate.op) as SyncEntity,
        index: i,
      });
  }
  for (let i = 0; i < input.changes.length; i++) {
    const raw = input.changes[i];
    if (!record(raw)) {
      add("invalid_request", i);
      continue;
    }
    try {
      if (
        new TextEncoder().encode(JSON.stringify(raw)).length >
        MAX_SYNC_ITEM_BYTES
      ) {
        add("item_too_large", i);
        continue;
      }
    } catch {
      add("invalid_request", i);
      continue;
    }
    const op = typeof raw.op === "string" ? raw.op : "";
    if (op === "update_record") {
      await planUpdate(
        lookups,
        raw,
        i,
        items,
        targets,
        add,
        now,
        options.allowImporterRoleTextUpdates === true,
      );
      continue;
    }
    const entity = CREATE.get(op);
    if (!entity) {
      add("unsupported_operation", i);
      continue;
    }
    if (
      raw.entity !== entity ||
      !record(raw.fields) ||
      !closed(raw, ["op", "clientRef", "entity", "fields"])
    ) {
      add(raw.entity !== entity ? "unsupported_entity" : "invalid_request", i);
      items.push({
        itemIndex: i,
        entity,
        action: "invalid",
        ...(typeof raw.clientRef === "string" && safeRef(raw.clientRef)
          ? { clientRef: raw.clientRef }
          : {}),
        dependencies: [],
      });
      continue;
    }
    const clientRef = validString(raw.clientRef, 128) ? raw.clientRef : "";
    if (!clientRef) {
      add("invalid_field", i);
      items.push({ itemIndex: i, entity, action: "invalid", dependencies: [] });
      continue;
    }
    if (refs.has(clientRef)) {
      add("duplicate_client_ref", i, clientRef);
      items.push({
        itemIndex: i,
        entity,
        action: "invalid",
        clientRef,
        dependencies: [],
      });
      continue;
    }
    const fields = raw.fields;
    const fieldNames = Object.keys(fields);
    const supported = supportedCreateFields(entity);
    if (entity === "person_roles" && options.allowRolesWithoutSource)
      supported.push("inferred_title");
    if (fieldNames.some((field) => !supported.includes(field))) {
      add("unsupported_field", i, clientRef);
      items.push({
        itemIndex: i,
        entity,
        action: "invalid",
        clientRef,
        dependencies: [],
      });
      continue;
    }
    let valid = true;
    const deps: string[] = [];
    for (const relation of REF_KEYS[entity] ?? []) {
      const hasId = Object.hasOwn(fields, relation.id);
      const hasRef = Object.hasOwn(fields, relation.ref);
      if (
        hasId &&
        typeof fields[relation.id] === "string" &&
        refs.has(fields[relation.id] as string)
      ) {
        add("client_ref_in_id_field", i, clientRef);
        valid = false;
      }
      if (
        hasId &&
        typeof fields[relation.id] === "string" &&
        (fields[relation.id] as string).startsWith("ref:")
      ) {
        add("client_ref_in_id_field", i, clientRef);
        valid = false;
      }
      if (
        entity === "organizations" &&
        relation.id === "parent_organization_id" &&
        hasId &&
        fields[relation.id] === null &&
        !hasRef
      )
        continue;
      if (
        entity === "organizations" &&
        relation.id === "parent_organization_id" &&
        !hasId &&
        !hasRef
      )
        continue;
      if (
        entity === "person_roles" &&
        (relation.id === "position_id" ||
          (relation.id === "source_id" && options.allowRolesWithoutSource)) &&
        !hasId &&
        !hasRef
      )
        continue;
      if (hasId === hasRef) {
        add("relationship_conflict", i, clientRef);
        valid = false;
        continue;
      }
      if (hasId) {
        if (!validId(fields[relation.id])) {
          add("invalid_field", i, clientRef);
          valid = false;
        } else if (
          !(await lookups.exists(
            relation.entity,
            fields[relation.id] as string,
          ))
        ) {
          add("invalid_reference", i, clientRef);
          valid = false;
        }
      } else {
        const ref = fields[relation.ref];
        const found = typeof ref === "string" ? refs.get(ref) : undefined;
        if (!found) {
          const later =
            typeof ref === "string" ? futureRefs.get(ref) : undefined;
          add(
            later && later.index > i
              ? "forward_reference"
              : "invalid_reference",
            i,
            clientRef,
          );
          valid = false;
        } else if (found.entity !== relation.entity) {
          add("wrong_entity_reference", i, clientRef);
          valid = false;
        } else {
          deps.push(ref as string);
        }
      }
    }
    valid =
      (await validateCreateFields(
        lookups,
        entity,
        fields,
        i,
        clientRef,
        add,
        now,
      )) && valid;
    if (entity === "organizations" && valid)
      valid = await validateOrganizationPlan(
        lookups,
        fields,
        refs,
        i,
        clientRef,
        add,
      );
    if (entity === "organization_county_affiliations" && valid) {
      const organization = fields.organization_id ?? fields.organization_ref;
      const affiliationKey = JSON.stringify([
        organization,
        fields.county_fips,
        fields.relationship_type,
      ]);
      if (
        (await dbAffiliationExists(lookups, fields)) ||
        plannedAffiliations.has(affiliationKey)
      ) {
        add("duplicate_affiliation", i, clientRef);
        valid = false;
      } else plannedAffiliations.add(affiliationKey);
    }
    let action: PlannedSyncItem["action"] = "would_create";
    if (entity === "role_sources" && valid) {
      const existing = await lookups.sourceByUrl(fields.url as string);
      if (
        existing &&
        (existing.title !== fields.title ||
          existing.source_type !== fields.source_type ||
          existing.publisher_classification !== fields.publisher_classification)
      ) {
        add("source_metadata_conflict", i, clientRef);
        valid = false;
      } else if (existing) action = "would_reuse";
      const planned = plannedUrls.get(fields.url as string);
      if (
        planned &&
        (planned.title !== fields.title ||
          planned.source_type !== fields.source_type ||
          planned.publisher_classification !== fields.publisher_classification)
      ) {
        add("source_metadata_conflict", i, clientRef);
        valid = false;
      } else if (planned) {
        action = "would_reuse";
        deps.push(planned.clientRef);
      } else
        plannedUrls.set(fields.url as string, {
          title: fields.title,
          source_type: fields.source_type,
          publisher_classification: fields.publisher_classification,
          clientRef,
        });
    }
    if (action === "would_reuse") {
      const found = await lookups.sourceByUrl(fields.url as string);
      items.push({
        itemIndex: i,
        entity,
        action,
        clientRef,
        ...(typeof found?.id === "string" ? { websiteId: found.id } : {}),
        dependencies: deps,
      });
    } else
      items.push({
        itemIndex: i,
        entity,
        action: valid ? action : "invalid",
        clientRef,
        dependencies: deps,
      });
    refs.set(clientRef, { entity, index: i, fields });
  }
  for (const flag of flags) {
    const target = refs.get(flag.targetRef);
    if (target && target.entity !== "people") add("duplicate_flag_invalid");
    if (!target && !(await lookups.exists("people", flag.targetRef)))
      add("duplicate_flag_invalid");
    if (
      flag.possibleDuplicateOf === flag.targetRef ||
      !(await lookups.exists("people", flag.possibleDuplicateOf))
    )
      add("duplicate_flag_invalid");
    for (const sourceRef of flag.evidenceSourceRefs ?? []) {
      const source = refs.get(sourceRef);
      if (source && source.entity !== "role_sources")
        add("duplicate_flag_invalid");
      if (!source && !(await lookups.exists("role_sources", sourceRef)))
        add("duplicate_flag_invalid");
    }
  }
  return result(
    requestId,
    items,
    errors,
    flags.map(({ targetRef, possibleDuplicateOf, evidenceSourceRefs }) => ({
      targetRef,
      possibleDuplicateOf,
      ...(evidenceSourceRefs ? { evidenceSourceRefs } : {}),
    })),
  );
}

async function planUpdate(
  db: SyncPlanReads,
  raw: Record<string, unknown>,
  index: number,
  items: PlannedSyncItem[],
  targets: Set<string>,
  add: (
    code: SyncErrorCode,
    i?: number,
    ref?: string,
    version?: number,
  ) => void,
  now: () => Date,
  allowImporterRoleTextUpdates: boolean,
) {
  if (
    typeof raw.entity !== "string" ||
    !TABLES.includes(raw.entity as SyncEntity)
  ) {
    add("unsupported_entity", index);
    return;
  }
  const entity = raw.entity as SyncEntity;
  if (!closed(raw, ["op", "entity", "targetId", "expectedVersion", "fields"])) {
    add("invalid_request", index);
    items.push({
      itemIndex: index,
      entity,
      action: "invalid",
      dependencies: [],
    });
    return;
  }
  if (
    !validId(raw.targetId) ||
    !Number.isSafeInteger(raw.expectedVersion) ||
    (raw.expectedVersion as number) < 1 ||
    !record(raw.fields) ||
    Object.keys(raw.fields).length === 0
  ) {
    add("invalid_request", index);
    items.push({
      itemIndex: index,
      entity,
      action: "invalid",
      dependencies: [],
    });
    return;
  }
  const key = `${entity}:${raw.targetId}`;
  if (targets.has(key)) {
    add("duplicate_target", index);
    items.push({
      itemIndex: index,
      entity,
      action: "invalid",
      targetId: raw.targetId,
      dependencies: [],
    });
    return;
  }
  targets.add(key);
  const fields = raw.fields;
  const allowed =
    entity === "person_roles" && allowImporterRoleTextUpdates
      ? IMPORT_ROLE_UPDATE_FIELDS
      : (UPDATE_FIELDS[entity] ?? []);
  if (Object.keys(fields).some((f) => !allowed.includes(f))) {
    add("unsupported_field", index);
    items.push({
      itemIndex: index,
      entity,
      action: "invalid",
      targetId: raw.targetId as string,
      dependencies: [],
    });
    return;
  }
  const row = await db.row(entity, raw.targetId as string);
  if (!row) {
    add("missing_target", index);
    items.push({
      itemIndex: index,
      entity,
      action: "invalid",
      targetId: raw.targetId as string,
      dependencies: [],
    });
    return;
  }
  const version = typeof row.version === "number" ? row.version : undefined;
  if (version !== raw.expectedVersion) {
    add("stale_version", index, undefined, version);
    items.push({
      itemIndex: index,
      entity,
      action: "invalid",
      targetId: raw.targetId as string,
      websiteId: raw.targetId as string,
      expectedVersion: version,
      dependencies: [],
    });
    return;
  }
  let valid = true;
  if (entity === "organizations")
    valid = await validateOrgUpdate(db, row, fields, index, add);
  if (entity === "person_roles")
    valid = await validateRoleUpdate(db, row, fields, index, add, now);
  if (
    entity === "role_sources" &&
    "title" in fields &&
    !validNonempty(fields.title, 500)
  ) {
    add("invalid_field", index);
    valid = false;
  }
  if (
    entity === "people" &&
    "display_name" in fields &&
    !validNonempty(fields.display_name, 500)
  ) {
    add("invalid_field", index);
    valid = false;
  }
  if (entity === "people" || entity === "profile_names") {
    if (!validateNameFields(fields, index, undefined, add, true)) valid = false;
    if (
      entity === "profile_names" &&
      !validNameDateOrder(row, fields, index, add)
    )
      valid = false;
  }
  if (
    entity === "positions" &&
    "title" in fields &&
    !validNonempty(fields.title, 500)
  ) {
    add("invalid_field", index);
    valid = false;
  }
  items.push({
    itemIndex: index,
    entity,
    action: valid ? "would_update" : "invalid",
    targetId: raw.targetId as string,
    websiteId: raw.targetId as string,
    expectedVersion: version,
    ...(valid
      ? {
          fieldChanges: Object.keys(fields).map((field) => {
            const current = (row as Record<string, unknown>)[field];
            const proposed = fields[field];
            const plain = (value: unknown) =>
              typeof value === "string" || typeof value === "number"
                ? value
                : null;
            return {
              field,
              current: plain(current),
              proposed: plain(proposed),
            };
          }),
        }
      : {}),
    dependencies: [],
  });
}

async function validateCreateFields(
  db: SyncPlanReads,
  entity: SyncEntity,
  f: Record<string, unknown>,
  i: number,
  ref: string,
  add: (code: SyncErrorCode, i?: number, ref?: string) => void,
  now: () => Date,
): Promise<boolean> {
  let ok = true;
  const required: Record<SyncEntity, string[]> = {
    organizations: ["name", "organization_type"],
    organization_county_affiliations: ["county_fips", "relationship_type"],
    people: ["display_name"],
    positions: ["title"],
    role_sources: ["url", "title", "source_type", "publisher_classification"],
    person_roles: ["county_fips"],
    profile_names: ["name_type", "published_name"],
  };
  for (const field of required[entity])
    if (!Object.hasOwn(f, field)) {
      add("missing_field", i, ref);
      ok = false;
    }
  for (const [key, values] of Object.entries(ENUMS))
    if (
      Object.hasOwn(f, key) &&
      (typeof f[key] !== "string" || !values.includes(f[key] as string))
    ) {
      add("invalid_enum", i, ref);
      ok = false;
    }
  for (const key of ["name", "display_name", "title"])
    if (Object.hasOwn(f, key) && !validNonempty(f[key], 500)) {
      add("invalid_field", i, ref);
      ok = false;
    }
  if (entity === "people" || entity === "profile_names")
    ok = validateNameFields(f, i, ref, add, false) && ok;
  if (entity === "organizations") {
    if (
      f.organization_type === "county_government" &&
      !validCounty(f.county_fips)
    ) {
      add("invalid_field", i, ref);
      ok = false;
    }
    const hasParent =
      f.parent_organization_ref !== undefined
        ? f.parent_organization_ref != null
        : f.parent_organization_id != null;
    if (hasParent !== (f.parent_relationship != null)) {
      add("relationship_conflict", i, ref);
      ok = false;
    }
    if (f.county_fips != null && !(await db.countyExists(f.county_fips))) {
      add("unknown_county", i, ref);
      ok = false;
    }
  }
  if (
    ["organization_county_affiliations"].includes(entity) &&
    !(await db.countyExists(f.county_fips))
  ) {
    add("unknown_county", i, ref);
    ok = false;
  }
  if (entity === "role_sources" && !validUrl(f.url)) {
    add("invalid_url", i, ref);
    ok = false;
  }
  if (entity === "person_roles") {
    ok = validateRoleDates(f, i, ref, add, now) && ok;
    if (
      Object.hasOwn(f, "county_fips") &&
      !(
        typeof f.county_fips === "string" &&
        validCounty(f.county_fips) &&
        (await db.countyExists(f.county_fips))
      )
    ) {
      add("unknown_county", i, ref);
      ok = false;
    }
    let hasText = false;
    for (const [key, max] of ROLE_TEXT_FIELDS) {
      if (!Object.hasOwn(f, key)) continue;
      if (validNonempty(f[key], max)) {
        if (key !== "inferred_title") hasText = true;
      } else {
        add("invalid_field", i, ref);
        ok = false;
      }
    }
    if (
      !hasText &&
      !Object.hasOwn(f, "position_id") &&
      !Object.hasOwn(f, "position_ref")
    ) {
      add("role_detail_required", i, ref);
      ok = false;
    }
  }
  return ok;
}

async function validateOrgUpdate(
  db: SyncPlanReads,
  row: Record<string, unknown>,
  f: Record<string, unknown>,
  i: number,
  add: (code: SyncErrorCode, i?: number) => void,
): Promise<boolean> {
  let ok = true;
  const type = f.organization_type ?? row.organization_type;
  const county = Object.hasOwn(f, "county_fips")
    ? f.county_fips
    : row.county_fips;
  if (f.name !== undefined && !validNonempty(f.name, 500)) {
    add("invalid_field", i);
    ok = false;
  }
  if (!(ENUMS.organization_type ?? []).includes(type as string)) {
    add("invalid_enum", i);
    ok = false;
  }
  if (
    Object.hasOwn(f, "parent_relationship") &&
    f.parent_relationship !== null &&
    !(ENUMS.parent_relationship ?? []).includes(f.parent_relationship as string)
  ) {
    add("invalid_enum", i);
    ok = false;
  }
  if (type === "county_government" && !validCounty(county)) {
    add("invalid_field", i);
    ok = false;
  }
  if (county !== null && !(await db.countyExists(county))) {
    add("unknown_county", i);
    ok = false;
  }
  const parent = Object.hasOwn(f, "parent_organization_id")
    ? f.parent_organization_id
    : row.parent_organization_id;
  const relation = Object.hasOwn(f, "parent_relationship")
    ? f.parent_relationship
    : row.parent_relationship;
  if ((parent === null) !== (relation === null)) {
    add("relationship_conflict", i);
    ok = false;
  }
  if (parent !== null) {
    if (parent === row.id || !validId(parent)) {
      add("hierarchy_cycle", i);
      ok = false;
    } else {
      let current: unknown = parent;
      const seen = new Set([row.id]);
      let depth = 0;
      while (typeof current === "string") {
        if (seen.has(current)) {
          add("hierarchy_cycle", i);
          ok = false;
          break;
        }
        seen.add(current);
        if (++depth > MAX_DEPTH) {
          add("hierarchy_too_deep", i);
          ok = false;
          break;
        }
        const p = await db.row("organizations", current);
        if (!p) {
          add("invalid_reference", i);
          ok = false;
          break;
        }
        if (p.county_fips !== county) {
          add("hierarchy_county_mismatch", i);
          ok = false;
        }
        current = p.parent_organization_id;
      }
    }
  }
  if (Object.hasOwn(f, "county_fips")) {
    db.queries++;
    const children = await db.db.all<Record<string, unknown>>(
      "SELECT county_fips FROM organizations WHERE parent_organization_id = ? LIMIT 201",
      201,
      [row.id as string],
    );
    if (
      children.length > 200 ||
      children.some((child) => child.county_fips !== county)
    ) {
      add("county_change_splits_hierarchy", i);
      ok = false;
    }
  }
  return ok;
}

async function validateRoleUpdate(
  db: SyncPlanReads,
  row: Record<string, unknown>,
  f: Record<string, unknown>,
  i: number,
  add: (code: SyncErrorCode, i?: number) => void,
  now: () => Date,
): Promise<boolean> {
  if (
    Object.hasOwn(f, "source_id") &&
    !(await db.exists("role_sources", String(f.source_id)))
  ) {
    add("invalid_reference", i);
    return false;
  }
  const proposed = (field: string) =>
    Object.hasOwn(f, field) ? f[field] : row[field];
  if (ROLE_TEXT_FIELDS.some(([key]) => Object.hasOwn(f, key))) {
    for (const [key, max] of ROLE_TEXT_FIELDS) {
      if (
        Object.hasOwn(f, key) &&
        f[key] !== null &&
        !validNonempty(f[key], max)
      ) {
        add("invalid_field", i);
        return false;
      }
    }
    if (
      !row.position_id &&
      !ROLE_TEXT_FIELDS.some(
        ([key]) => key !== "inferred_title" && proposed(key),
      )
    ) {
      add("invalid_field", i);
      return false;
    }
  }
  return validateRoleDates(
    {
      start_date: proposed("start_date"),
      end_date: proposed("end_date"),
      source_checked_at: Object.hasOwn(f, "source_checked_at")
        ? f.source_checked_at
        : Object.hasOwn(f, "source_id")
          ? null
          : row.source_checked_at,
    },
    i,
    undefined,
    add,
    now,
  );
}

/**
 * Name fields on a Profile or an alternate name. A component is a trimmed,
 * non-empty string within its limit with no control characters. On update a
 * component may also be null, which clears it. Dates are calendar dates and
 * the end cannot precede the start within one create.
 */
function validateNameFields(
  f: Record<string, unknown>,
  i: number,
  ref: string | undefined,
  add: (code: SyncErrorCode, i?: number, ref?: string) => void,
  update: boolean,
): boolean {
  let ok = true;
  for (const [key, max] of Object.entries(NAME_COMPONENT_LIMITS)) {
    if (!Object.hasOwn(f, key)) continue;
    const value = f[key];
    if (value === null && update) continue;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim() ||
      value.length > max ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      add("invalid_field", i, ref);
      ok = false;
    }
  }
  if (Object.hasOwn(f, "published_name")) {
    const value = f.published_name;
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value !== value.trim() ||
      value.length > PROFILES_MAX_NAME_LENGTH ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      add("invalid_field", i, ref);
      ok = false;
    }
  }
  for (const key of ["applies_from", "applies_until"]) {
    if (!Object.hasOwn(f, key)) continue;
    if (f[key] === null && update) continue;
    if (!validDate(f[key])) {
      add("invalid_date", i, ref);
      ok = false;
    }
  }
  if (
    typeof f.applies_from === "string" &&
    typeof f.applies_until === "string" &&
    validDate(f.applies_from) &&
    validDate(f.applies_until) &&
    f.applies_until < f.applies_from
  ) {
    add("date_order", i, ref);
    ok = false;
  }
  if (Object.hasOwn(f, "name_type") && typeof f.name_type !== "string") {
    add("invalid_enum", i, ref);
    ok = false;
  }
  return ok;
}
/** An update's dates, merged with the stored ones, must stay in order. */
function validNameDateOrder(
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
  i: number,
  add: (code: SyncErrorCode, i?: number, ref?: string) => void,
): boolean {
  const pick = (key: string): unknown =>
    Object.hasOwn(fields, key) ? fields[key] : row[key];
  const from = pick("applies_from");
  const until = pick("applies_until");
  if (typeof from === "string" && typeof until === "string" && until < from) {
    add("date_order", i);
    return false;
  }
  return true;
}
function validateRoleDates(
  f: Record<string, unknown>,
  i: number,
  ref: string | undefined,
  add: (code: SyncErrorCode, i?: number, ref?: string) => void,
  now: () => Date,
): boolean {
  let ok = true;
  for (const key of ["start_date", "end_date"])
    if (f[key] != null && !validDate(f[key])) {
      add("invalid_date", i, ref);
      ok = false;
    }
  if (
    f.start_date &&
    f.end_date &&
    typeof f.start_date === "string" &&
    typeof f.end_date === "string" &&
    f.end_date < f.start_date
  ) {
    add("date_order", i, ref);
    ok = false;
  }
  if (
    f.source_checked_at != null &&
    !validDate(f.source_checked_at) &&
    !validUtc(f.source_checked_at)
  ) {
    add("invalid_timestamp", i, ref);
    ok = false;
  }
  if (
    typeof f.source_checked_at === "string" &&
    (validDate(f.source_checked_at) || validUtc(f.source_checked_at)) &&
    Date.parse(f.source_checked_at) > now().getTime() + 300_000
  ) {
    add("future_timestamp", i, ref);
    ok = false;
  }
  return ok;
}

async function validateOrganizationPlan(
  db: SyncPlanReads,
  f: Record<string, unknown>,
  refs: Map<
    string,
    { entity: SyncEntity; index: number; fields?: Record<string, unknown> }
  >,
  i: number,
  ref: string,
  add: (code: SyncErrorCode, i?: number, ref?: string) => void,
): Promise<boolean> {
  const parentRef = f.parent_organization_ref;
  if (typeof parentRef === "string") {
    const parentItem = refs.get(parentRef);
    if (parentItem?.entity !== "organizations") {
      add("wrong_entity_reference", i, ref);
      return false;
    }
    if (parentItem.fields?.county_fips !== (f.county_fips ?? null)) {
      add("hierarchy_county_mismatch", i, ref);
      return false;
    }
    return true;
  }
  const parentId = f.parent_organization_id;
  if (typeof parentId === "string") {
    const parent = await db.row("organizations", parentId);
    if (!parent) {
      add("invalid_reference", i, ref);
      return false;
    }
    if (parent.county_fips !== (f.county_fips ?? null)) {
      add("hierarchy_county_mismatch", i, ref);
      return false;
    }
    return true;
  }
  return true;
}

function validateFlags(
  value: unknown,
  add: (code: SyncErrorCode, i?: number) => void,
) {
  if (value === undefined)
    return [] as {
      targetRef: string;
      possibleDuplicateOf: string;
      evidenceSourceRefs?: readonly string[];
    }[];
  if (!Array.isArray(value) || value.length > MAX_SYNC_DUPLICATE_FLAGS) {
    add("too_many_duplicate_flags");
    return [];
  }
  const result: {
    targetRef: string;
    possibleDuplicateOf: string;
    evidenceSourceRefs?: readonly string[];
  }[] = [];
  for (const f of value) {
    if (
      !record(f) ||
      !closed(f, [
        "targetType",
        "targetRef",
        "possibleDuplicateOf",
        "category",
        "reason",
        "evidenceSourceRefs",
        "nonblocking",
      ]) ||
      f.targetType !== "person" ||
      f.category !== "possible_match" ||
      f.nonblocking !== true ||
      !validId(f.targetRef) ||
      !validId(f.possibleDuplicateOf) ||
      !validNonempty(f.reason, 500) ||
      (f.evidenceSourceRefs !== undefined &&
        (!Array.isArray(f.evidenceSourceRefs) ||
          f.evidenceSourceRefs.length > 25 ||
          f.evidenceSourceRefs.some((x) => !validId(x))))
    ) {
      add("duplicate_flag_invalid");
      continue;
    }
    result.push({
      targetRef: f.targetRef as string,
      possibleDuplicateOf: f.possibleDuplicateOf as string,
      ...(Array.isArray(f.evidenceSourceRefs)
        ? { evidenceSourceRefs: f.evidenceSourceRefs as string[] }
        : {}),
    });
  }
  return result;
}

async function dbAffiliationExists(
  db: SyncPlanReads,
  f: Record<string, unknown>,
): Promise<boolean> {
  return (
    typeof f.organization_id === "string" &&
    (await db.affiliationExists(
      f.organization_id,
      f.county_fips as string,
      f.relationship_type as string,
    ))
  );
}
function validCounty(value: unknown): boolean {
  return typeof value === "string" && /^08\d{3}$/.test(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
function validString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length <= max &&
    value.length > 0
  );
}
function validNonempty(value: unknown, max: number): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= max
  );
}
function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validUtc(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") ===
      value.replace(/\.\d+Z$/, "Z")
  );
}
function validUrl(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 2048
  )
    return false;
  try {
    const u = new URL(value);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      !!u.hostname &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
function supportedCreateFields(entity: SyncEntity): string[] {
  const base: Record<SyncEntity, string[]> = {
    organizations: [
      "name",
      "organization_type",
      "county_fips",
      "parent_organization_id",
      "parent_organization_ref",
      "parent_relationship",
    ],
    organization_county_affiliations: [
      "organization_id",
      "organization_ref",
      "county_fips",
      "relationship_type",
    ],
    people: [
      "display_name",
      "first_name",
      "middle_name",
      "last_name",
      "name_prefix",
      "name_suffix",
      "preferred_first_name",
    ],
    positions: ["organization_id", "organization_ref", "title"],
    role_sources: ["url", "title", "source_type", "publisher_classification"],
    person_roles: [
      "person_id",
      "person_ref",
      "position_id",
      "position_ref",
      "source_id",
      "source_ref",
      "start_date",
      "end_date",
      "source_checked_at",
      "county_fips",
      "published_office",
      "published_title",
      "job_description",
    ],
    profile_names: [
      "person_id",
      "person_ref",
      "name_type",
      "published_name",
      "first_name",
      "middle_name",
      "last_name",
      "name_prefix",
      "name_suffix",
      "applies_from",
      "applies_until",
    ],
  };
  return base[entity];
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function closed(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((key) => keys.includes(key));
}
function safeRef(v: string): string | null {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : null;
}
function result(
  requestId: string | null,
  items: PlannedSyncItem[],
  errors: SyncPlanError[],
  duplicateFlags: {
    targetRef: string;
    possibleDuplicateOf: string;
    evidenceSourceRefs?: readonly string[];
  }[],
): SyncPlan {
  return {
    contractVersion: "m2-sync/v1",
    requestId,
    eligible:
      errors.length === 0 &&
      items.length > 0 &&
      items.every((x) => x.action !== "invalid"),
    items,
    errors,
    duplicateFlags,
  };
}

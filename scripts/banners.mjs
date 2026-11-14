import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import pngjs from "pngjs";

const { PNG } = pngjs;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const DEFAULTS = {
  maxBytes: 25 * 1024 * 1024,
  maxPixels: 24_000_000,
  minWidth: 1200,
  minHeight: 400,
};
const EDITABLE_FIELDS = [
  "countyFips",
  "displayName",
  "caption",
  "altText",
  "displayMode",
  "focalX",
  "focalY",
  "displayOrder",
  "isPrimary",
  "lifecycleState",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function stableId(name) {
  return `banner-${sha256(Buffer.from(name.normalize("NFC"))).slice(0, 20)}`;
}
function safeRatio(width, height) {
  return Number((width / height).toFixed(6));
}
function issue(code, severity, message) {
  return { code, severity, message };
}

function jpegHeader(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    throw new Error("JPEG signature is missing");
  let offset = 2;
  let width;
  let height;
  let orientation = 1;
  while (offset + 4 <= buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length)
      throw new Error("Malformed JPEG segment");
    const start = offset + 2;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 7) throw new Error("Malformed JPEG frame header");
      height = buffer.readUInt16BE(start + 1);
      width = buffer.readUInt16BE(start + 3);
    }
    if (
      marker === 0xe1 &&
      length >= 16 &&
      buffer.toString("ascii", start, start + 6) === "Exif\0\0"
    ) {
      orientation = readExifOrientation(buffer, start + 6, offset + length);
    }
    offset += length;
    if (width && height) return { width, height, orientation };
  }
  throw new Error("JPEG dimensions were not found in a valid frame header");
}

function readExifOrientation(buffer, tiff, end) {
  try {
    const little = buffer.toString("ascii", tiff, tiff + 2) === "II";
    if (!little && buffer.toString("ascii", tiff, tiff + 2) !== "MM") return 1;
    const u16 = (p) =>
      little ? buffer.readUInt16LE(p) : buffer.readUInt16BE(p);
    const u32 = (p) =>
      little ? buffer.readUInt32LE(p) : buffer.readUInt32BE(p);
    if (u16(tiff + 2) !== 42) return 1;
    const ifd = tiff + u32(tiff + 4);
    if (ifd + 2 > end) return 1;
    const count = u16(ifd);
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) return 1;
      if (
        u16(entry) === 0x0112 &&
        u16(entry + 2) === 3 &&
        u32(entry + 4) === 1
      ) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch {
    /* malformed optional EXIF does not invalidate the JPEG decoder's result */
  }
  return 1;
}

function detectFormat(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return "jpeg";
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  return null;
}

async function readCountyRegistry() {
  const sql = await fs.readFile(
    path.join(PROJECT_DIR, "website", "migrations", "0001_counties.sql"),
    "utf8",
  );
  const entries = [...sql.matchAll(/\('((?:08)\d{3})',\s*'([^']+)'\)/g)].map(
    (m) => ({ fips: m[1], name: m[2] }),
  );
  if (entries.length !== 64)
    throw new Error(
      `Canonical county registry expected 64 entries; found ${entries.length}`,
    );
  return new Map(entries.map(({ fips, name }) => [fips, name]));
}

function filenameMetadata(name, counties) {
  const match = /^(08\d{3})-(.+?)(?:\.(?:jpg|jpeg|png))$/i.exec(name);
  const fips = match?.[1];
  const county = fips ? counties.get(fips) : undefined;
  const tail = match?.[2] ?? path.parse(name).name;
  const anomaly = [];
  if (!match)
    anomaly.push(
      issue(
        "filename_pattern",
        "warning",
        "Filename does not follow FIPS-landmark.ext convention",
      ),
    );
  if (match && !county)
    anomaly.push(
      issue(
        "invalid_county_fips",
        "error",
        `FIPS ${fips} is not in the Colorado county registry`,
      ),
    );
  if (/\(\d+\)/.test(name))
    anomaly.push(
      issue(
        "duplicate_style_suffix",
        "warning",
        "Filename contains a duplicate-style numeric suffix",
      ),
    );
  if (/(?:next|remove|edited|fix|teh|with[-_]its)(?:[-_ ]|\.|$)/i.test(name))
    anomaly.push(
      issue(
        "editing_note",
        "warning",
        "Filename appears to contain an editing note",
      ),
    );
  const normalizedTail = tail.replace(/[_-]+/g, " ").trim().toLowerCase();
  const countyTokens = county?.toLowerCase() ?? "";
  const looksCountyOnly =
    normalizedTail === countyTokens || normalizedTail === `san ${countyTokens}`;
  const clearLandmark = Boolean(
    match &&
      county &&
      tail &&
      !looksCountyOnly &&
      !/(?:^|[-_])(?:next|remove|edited|fix|teh)(?:[-_]|$)/i.test(tail),
  );
  const displayName = clearLandmark
    ? tail.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "";
  return {
    countyFips: county ? fips : null,
    countyName: county ?? null,
    displayName,
    caption: clearLandmark ? displayName : "",
    altText:
      clearLandmark && county
        ? `${displayName}, ${county} County, Colorado`
        : "",
    metadataNeedsReview: !clearLandmark,
    issues: anomaly,
  };
}

async function enumerateFiles(root, warnings) {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("Source path must be a real directory, not a symlink");
  const realRoot = await fs.realpath(root);
  const files = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push({
          file: path.relative(root, full).split(path.sep).join("/"),
          issue: issue(
            "symlink_skipped",
            "warning",
            "Symbolic link was not followed",
          ),
        });
      } else if (entry.isDirectory()) {
        const real = await fs.realpath(full);
        if (!real.startsWith(`${realRoot}${path.sep}`))
          warnings.push({
            file: path.relative(root, full),
            issue: issue(
              "outside_source_skipped",
              "error",
              "Directory resolves outside the approved source root",
            ),
          });
        else await visit(full);
      } else if (entry.isFile())
        files.push({
          full,
          relative: path.relative(root, full).split(path.sep).join("/"),
        });
    }
  }
  await visit(realRoot);
  return files;
}

async function inspectFile(file, counties, limits) {
  const issues = [];
  const stat = await fs.stat(file.full);
  const name = path.posix.basename(file.relative);
  const inferred = filenameMetadata(name, counties);
  issues.push(...inferred.issues);
  const record = {
    bannerId: stableId(file.relative),
    countyFips: inferred.countyFips,
    source: {
      filename: file.relative,
      width: null,
      height: null,
      aspectRatio: null,
      format: null,
      sizeBytes: stat.size,
      sha256: null,
      orientation: null,
      validation: "not_checked",
    },
    displayName: inferred.displayName,
    caption: inferred.caption,
    altText: inferred.altText,
    metadataSource: inferred.metadataNeedsReview
      ? "needs_review"
      : "filename_suggestion",
    displayMode: "cover",
    focalX: 0.5,
    focalY: 0.5,
    displayOrder: null,
    isPrimary: false,
    lifecycleState: "proposed",
    currentVersion: 1,
    versions: [],
    futureAssetRef: null,
    issues,
    metadataNeedsReview: inferred.metadataNeedsReview,
  };
  if (stat.size === 0)
    issues.push(issue("empty_file", "error", "File is empty"));
  if (stat.size > limits.maxBytes) {
    try {
      record.source.sha256 = await sha256File(file.full);
    } catch (error) {
      issues.push(
        issue(
          "unreadable",
          "error",
          `File could not be hashed: ${error.message}`,
        ),
      );
    }
    issues.push(
      issue(
        "file_too_large",
        "error",
        `File exceeds configured ${limits.maxBytes} byte limit; decoding skipped`,
      ),
    );
    return record;
  }
  let bytes;
  try {
    bytes = await fs.readFile(file.full);
  } catch (error) {
    issues.push(
      issue("unreadable", "error", `File could not be read: ${error.message}`),
    );
    return record;
  }
  record.source.sha256 = sha256(bytes);
  const format = detectFormat(bytes);
  record.source.format = format;
  const ext = path.extname(name).toLowerCase();
  const extensionFormat =
    ext === ".jpg" || ext === ".jpeg" ? "jpeg" : ext === ".png" ? "png" : null;
  if (!format) {
    issues.push(
      issue(
        "unknown_format",
        "error",
        "File bytes are not a supported JPEG or PNG",
      ),
    );
    return record;
  }
  if (format !== extensionFormat)
    issues.push(
      issue(
        "extension_mismatch",
        "warning",
        `Detected ${format.toUpperCase()} bytes with ${ext || "no"} extension`,
      ),
    );
  try {
    const header =
      format === "jpeg"
        ? jpegHeader(bytes)
        : (() => {
            if (bytes.length < 24) throw new Error("PNG header is truncated");
            return {
              width: bytes.readUInt32BE(16),
              height: bytes.readUInt32BE(20),
              orientation: 1,
            };
          })();
    record.source.width = header.width;
    record.source.height = header.height;
    record.source.aspectRatio = safeRatio(header.width, header.height);
    record.source.orientation = header.orientation;
    const pixels = header.width * header.height;
    if (
      !header.width ||
      !header.height ||
      header.width > 10000 ||
      header.height > 10000 ||
      pixels > limits.maxPixels
    ) {
      issues.push(
        issue(
          "dimensions_over_limit",
          "error",
          `Dimensions ${header.width}x${header.height} exceed configured decode safety limits; full decode skipped`,
        ),
      );
      return record;
    }
    if (format === "jpeg")
      jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false });
    else PNG.sync.read(bytes, { checkCRC: true });
    record.source.validation = "full_decode_passed";
    if (header.orientation >= 5)
      [record.source.displayWidth, record.source.displayHeight] = [
        header.height,
        header.width,
      ];
    else
      [record.source.displayWidth, record.source.displayHeight] = [
        header.width,
        header.height,
      ];
    const ratio = Math.max(
      header.width / header.height,
      header.height / header.width,
    );
    if (ratio < 2.25 || ratio > 3.2)
      issues.push(
        issue(
          "aspect_ratio_review",
          "warning",
          `Source ratio ${record.source.aspectRatio} is outside expected panoramic range 2.25–3.20`,
        ),
      );
    if (header.width < limits.minWidth || header.height < limits.minHeight)
      issues.push(
        issue(
          "small_image",
          "warning",
          `Image is below the suggested ${limits.minWidth}x${limits.minHeight} minimum`,
        ),
      );
    if (header.orientation !== 1)
      issues.push(
        issue(
          "orientation_metadata",
          "warning",
          `EXIF orientation ${header.orientation} affects display geometry`,
        ),
      );
  } catch (error) {
    record.source.validation = "decode_failed";
    issues.push(
      issue(
        "decode_failed",
        "error",
        `Image header or full decode failed: ${error.message}`,
      ),
    );
  }
  if (!record.countyFips)
    issues.push(
      issue(
        "county_assignment_missing",
        "error",
        "A valid Colorado county FIPS could not be derived from the filename",
      ),
    );
  if (record.metadataNeedsReview)
    issues.push(
      issue(
        "caption_review_required",
        "warning",
        "Caption and alt text need owner review",
      ),
    );
  return record;
}

function metadataValues(record) {
  return Object.fromEntries(EDITABLE_FIELDS.map((key) => [key, record[key]]));
}
function validMetadata(value, counties) {
  if (!value || typeof value !== "object") return false;
  return (
    (value.countyFips === null || counties.has(value.countyFips)) &&
    ["cover", "contain"].includes(value.displayMode) &&
    Number.isFinite(value.focalX) &&
    value.focalX >= 0 &&
    value.focalX <= 1 &&
    Number.isFinite(value.focalY) &&
    value.focalY >= 0 &&
    value.focalY <= 1 &&
    (value.displayOrder === null ||
      (Number.isInteger(value.displayOrder) && value.displayOrder >= 0)) &&
    typeof value.isPrimary === "boolean" &&
    ["draft", "proposed", "published", "unpublished", "archived"].includes(
      value.lifecycleState,
    ) &&
    ["displayName", "caption", "altText"].every(
      (key) => typeof value[key] === "string",
    )
  );
}

function reconcile(records, previous, metadataManifest, counties) {
  const priorRecords = previous?.banners ?? [];
  const priorByFile = new Map(
    priorRecords.map((item) => [item.source.filename, item]),
  );
  const metadataById = new Map(
    (metadataManifest?.banners ?? []).map((item) => [item.bannerId, item]),
  );
  const metadataIdCounts = new Map();
  for (const item of metadataManifest?.banners ?? [])
    metadataIdCounts.set(
      item.bannerId,
      (metadataIdCounts.get(item.bannerId) ?? 0) + 1,
    );
  const conflictingMetadataIds = new Set(
    [...metadataIdCounts].filter(([, count]) => count > 1).map(([id]) => id),
  );
  const currentFiles = new Set(records.map((item) => item.source.filename));
  const changes = [];
  for (const record of records) {
    const prev = priorByFile.get(record.source.filename);
    const edited = conflictingMetadataIds.has(record.bannerId)
      ? null
      : metadataById.get(record.bannerId);
    if (conflictingMetadataIds.has(record.bannerId))
      record.issues.push(
        issue(
          "conflicting_metadata_banner_id",
          "error",
          "Owner metadata assigns this stable banner ID to multiple records; baseline metadata retained",
        ),
      );
    const sameIdMetadata =
      edited && edited.bannerId === record.bannerId ? edited : null;
    if (sameIdMetadata) {
      if (validMetadata(sameIdMetadata, counties)) {
        for (const key of EDITABLE_FIELDS)
          if (key in sameIdMetadata) record[key] = sameIdMetadata[key];
        record.countyName = counties.get(record.countyFips) ?? null;
        record.metadataSource = "owner_edited";
        if (record.caption && record.altText) {
          record.metadataNeedsReview = false;
          record.issues = record.issues.filter(
            (item) => item.code !== "caption_review_required",
          );
        }
        if (record.countyFips)
          record.issues = record.issues.filter(
            (item) => item.code !== "county_assignment_missing",
          );
      } else
        record.issues.push(
          issue(
            "invalid_metadata",
            "error",
            "County, text, display mode, focal point, order, primary flag, or lifecycle metadata is invalid; defaults retained",
          ),
        );
    } else if (prev && validMetadata(prev, counties)) {
      for (const key of EDITABLE_FIELDS)
        if (key in prev) record[key] = prev[key];
      record.countyName = counties.get(record.countyFips) ?? null;
    }
    if (!prev) {
      const sameHash = priorRecords.filter(
        (item) =>
          item.source.sha256 && item.source.sha256 === record.source.sha256,
      );
      const kind = sameHash.length ? "ambiguous" : "added";
      changes.push({
        kind,
        bannerId: record.bannerId,
        filename: record.source.filename,
        note: sameHash.length
          ? "Content matches another prior filename; proposed association needs review"
          : "Proposed addition; not published",
      });
      if (sameHash.length)
        record.issues.push(
          issue(
            "possible_duplicate_or_rename",
            "warning",
            `Digest matches prior banner ${sameHash[0].bannerId}; association is not automatic`,
          ),
        );
      record.versions = [
        {
          version: 1,
          sha256: record.source.sha256,
          filename: record.source.filename,
          width: record.source.width,
          height: record.source.height,
          format: record.source.format,
          sizeBytes: record.source.sizeBytes,
          validation: record.source.validation,
        },
      ];
      continue;
    }
    record.bannerId = prev.bannerId;
    const sameContent = prev.source.sha256 === record.source.sha256;
    const previousMetadata = metadataValues(prev);
    const currentMetadata = metadataValues(record);
    const metadataChanged =
      JSON.stringify(previousMetadata) !== JSON.stringify(currentMetadata);
    if (!sameContent) {
      const versions = [...(prev.versions ?? [])];
      if (!versions.some((version) => version.sha256 === prev.source.sha256))
        versions.push({
          version: prev.currentVersion ?? versions.length + 1,
          sha256: prev.source.sha256,
          filename: prev.source.filename,
          width: prev.source.width,
          height: prev.source.height,
          format: prev.source.format,
          sizeBytes: prev.source.sizeBytes,
          validation: prev.source.validation,
        });
      const nextVersion = (prev.currentVersion ?? versions.length) + 1;
      record.currentVersion = nextVersion;
      versions.push({
        version: nextVersion,
        sha256: record.source.sha256,
        filename: record.source.filename,
        width: record.source.width,
        height: record.source.height,
        format: record.source.format,
        sizeBytes: record.source.sizeBytes,
        validation: record.source.validation,
        status: "proposed",
      });
      record.versions = versions;
      changes.push({
        kind: "content_changed",
        bannerId: record.bannerId,
        filename: record.source.filename,
        previousSha256: prev.source.sha256,
        proposedSha256: record.source.sha256,
        note: `Proposed version ${nextVersion}; prior versions retained`,
      });
    } else {
      record.currentVersion = prev.currentVersion ?? 1;
      record.versions = [
        ...(prev.versions ?? [
          {
            version: record.currentVersion,
            sha256: prev.source.sha256,
            filename: prev.source.filename,
            width: prev.source.width,
            height: prev.source.height,
            format: prev.source.format,
            sizeBytes: prev.source.sizeBytes,
            validation: prev.source.validation,
          },
        ]),
      ];
      changes.push({
        kind: metadataChanged ? "metadata_changed" : "unchanged",
        bannerId: record.bannerId,
        filename: record.source.filename,
        note: metadataChanged
          ? "Metadata-only change; image version retained"
          : "Source and metadata unchanged",
      });
    }
  }
  for (const prev of priorRecords)
    if (!currentFiles.has(prev.source.filename)) {
      changes.push({
        kind: "missing_from_source",
        bannerId: prev.bannerId,
        filename: prev.source.filename,
        note: "Review candidate only; retained in manifest and not unpublished",
      });
      records.push({ ...structuredClone(prev), sourceMissing: true });
    }
  const duplicateGroups = new Map();
  for (const record of records)
    if (record.source.sha256)
      duplicateGroups.set(record.source.sha256, [
        ...(duplicateGroups.get(record.source.sha256) ?? []),
        record,
      ]);
  for (const group of duplicateGroups.values())
    if (group.length > 1) {
      for (const record of group)
        record.issues.push(
          issue(
            "duplicate_content",
            "warning",
            `Identical SHA-256 shared by ${group.map((item) => item.source.filename).join(", ")}`,
          ),
        );
      changes.push({
        kind: "duplicate",
        filenames: group.map((item) => item.source.filename),
        sha256: group[0].source.sha256,
        note: "Duplicate bytes are flagged, not discarded",
      });
    }
  const orders = new Map();
  for (const record of records)
    if (
      !record.sourceMissing &&
      record.countyFips &&
      Number.isInteger(record.displayOrder)
    ) {
      const key = `${record.countyFips}:${record.displayOrder}`;
      orders.set(key, [...(orders.get(key) ?? []), record]);
    }
  for (const [key, group] of orders)
    if (group.length > 1) {
      for (const record of group)
        record.issues.push(
          issue(
            "conflicting_display_order",
            "error",
            `Display order ${key.split(":")[1]} is assigned to multiple banners in county ${record.countyFips}`,
          ),
        );
      changes.push({
        kind: "ambiguous",
        bannerIds: group.map((item) => item.bannerId),
        note: `Conflicting display order ${key}`,
      });
    }
  const primaries = new Map();
  for (const record of records)
    if (!record.sourceMissing && record.countyFips && record.isPrimary)
      primaries.set(record.countyFips, [
        ...(primaries.get(record.countyFips) ?? []),
        record,
      ]);
  for (const [fips, group] of primaries)
    if (group.length > 1) {
      for (const record of group)
        record.issues.push(
          issue(
            "conflicting_primary",
            "error",
            `More than one primary banner is selected for county ${fips}`,
          ),
        );
      changes.push({
        kind: "ambiguous",
        bannerIds: group.map((item) => item.bannerId),
        note: `Multiple primary banners selected for county ${fips}`,
      });
    }
  for (const id of conflictingMetadataIds) {
    const affected = records.filter((record) => record.bannerId === id);
    if (affected.length)
      changes.push({
        kind: "ambiguous",
        bannerIds: [id],
        note: "Duplicate IDs in edited metadata need review",
      });
  }
  const ids = new Map();
  for (const record of records)
    ids.set(record.bannerId, [...(ids.get(record.bannerId) ?? []), record]);
  for (const group of ids.values())
    if (group.length > 1) {
      for (const record of group)
        record.issues.push(
          issue(
            "conflicting_banner_id",
            "error",
            "Banner ID is assigned to multiple records",
          ),
        );
      changes.push({
        kind: "ambiguous",
        bannerIds: group.map((item) => item.bannerId),
        note: "Conflicting stable banner identities",
      });
    }
  for (const record of records)
    if (
      record.source.validation === "decode_failed" ||
      record.issues.some((x) => x.severity === "error")
    )
      changes.push({
        kind: "invalid",
        bannerId: record.bannerId,
        filename: record.source.filename,
        note: "See validation issues; excluded from any future upload until reviewed",
      });
  return changes.sort((a, b) =>
    `${a.kind}\0${a.filename ?? a.filenames?.[0] ?? ""}`.localeCompare(
      `${b.kind}\0${b.filename ?? b.filenames?.[0] ?? ""}`,
      "en",
    ),
  );
}

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, contents, { flag: "wx" });
    await fs.link(temp, file);
    await fs.rm(temp);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function nextRevision(
  dir,
  title,
  extension,
  day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
) {
  await fs.mkdir(dir, { recursive: true });
  const prefix = `${title} rev${day} v`;
  const entries = await fs.readdir(dir);
  const versions = entries
    .map((name) =>
      new RegExp(
        `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\.${extension}$`,
      ).exec(name),
    )
    .filter(Boolean)
    .map((m) => Number(m[1]));
  let version = Math.max(0, ...versions) + 1;
  let file;
  do {
    file = path.join(dir, `${prefix}${version}.${extension}`);
    version += 1;
  } while (
    await fs.access(file).then(
      () => true,
      () => false,
    )
  );
  return file;
}

function parseArgs(argv) {
  const opts = {
    maxBytes: DEFAULTS.maxBytes,
    maxPixels: DEFAULTS.maxPixels,
    minWidth: DEFAULTS.minWidth,
    minHeight: DEFAULTS.minHeight,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === "help") {
      opts.help = true;
      continue;
    }
    if (name === "previous" || name === "metadata") opts[name] = argv[++i];
    else if (
      [
        "source",
        "manifest-dir",
        "report-dir",
        "max-bytes",
        "max-pixels",
        "min-width",
        "min-height",
      ].includes(name)
    ) {
      const target = {
        source: "source",
        "manifest-dir": "manifestDir",
        "report-dir": "reportDir",
        "max-bytes": "maxBytes",
        "max-pixels": "maxPixels",
        "min-width": "minWidth",
        "min-height": "minHeight",
      }[name];
      opts[target] = argv[++i];
    } else throw new Error(`Unknown option ${key}`);
  }
  for (const key of ["maxBytes", "maxPixels", "minWidth", "minHeight"])
    if (opts[key] !== undefined) opts[key] = Number(opts[key]);
  return opts;
}

function usage() {
  return `Local banner inventory (read-only source scan)\n\nnode scripts/banners.mjs --source DIR --manifest-dir DIR --report-dir DIR\n  [--previous manifest.json] [--metadata edited.json] [--max-bytes N]\n  [--max-pixels N] [--min-width N] [--min-height N]\n\nWrites collision-safe, versioned files only to the manifest and report directories.\n`;
}

export async function inventory({
  source,
  previous = null,
  metadata = null,
  limits = DEFAULTS,
}) {
  const counties = await readCountyRegistry();
  const warnings = [];
  const files = await enumerateFiles(source, warnings);
  const records = [];
  for (const file of files)
    records.push(await inspectFile(file, counties, limits));
  const changes = reconcile(records, previous, metadata, counties);
  const presentRecords = records.filter((item) => !item.sourceMissing);
  const represented = new Set(
    presentRecords.map((item) => item.countyFips).filter(Boolean),
  );
  const missingCounties = [...counties.keys()].filter(
    (fips) => !represented.has(fips),
  );
  const missingRecords = records.filter((item) => item.sourceMissing);
  const manifest = {
    schemaVersion: 1,
    counties: [...counties].map(([fips, name]) => ({ fips, name })),
    summary: {
      fileCount: presentRecords.length,
      validCount: presentRecords.filter(
        (r) =>
          r.source.validation === "full_decode_passed" &&
          !r.issues.some((x) => x.severity === "error"),
      ).length,
      invalidCount: presentRecords.filter((r) =>
        r.issues.some((x) => x.severity === "error"),
      ).length,
      retainedMissingCount: missingRecords.length,
      countiesRepresented: represented.size,
      missingCounties,
    },
    banners: records,
  };
  const sortedRatios = presentRecords
    .map((item) => item.source.aspectRatio)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const sortedWidths = presentRecords
    .map((item) => item.source.width)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const sortedHeights = presentRecords
    .map((item) => item.source.height)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const summary = {
    fileCount: presentRecords.length,
    validCount: manifest.summary.validCount,
    invalidCount: manifest.summary.invalidCount,
    retainedMissingCount: missingRecords.length,
    countiesRepresented: represented.size,
    missingCounties,
    dimensions: {
      widthMin: sortedWidths[0] ?? null,
      widthMax: sortedWidths.at(-1) ?? null,
      heightMin: sortedHeights[0] ?? null,
      heightMax: sortedHeights.at(-1) ?? null,
    },
    aspectRatio: {
      min: sortedRatios[0] ?? null,
      median: sortedRatios.length
        ? sortedRatios[Math.floor(sortedRatios.length / 2)]
        : null,
      max: sortedRatios.at(-1) ?? null,
      near21To9: sortedRatios.filter((ratio) => ratio >= 2.25 && ratio <= 2.5)
        .length,
      panoramic: sortedRatios.filter((ratio) => ratio > 2.5 && ratio <= 3.2)
        .length,
      outsideReviewBand: sortedRatios.filter(
        (ratio) => ratio < 2.25 || ratio > 3.2,
      ).length,
    },
    formats: Object.fromEntries(
      ["jpeg", "png", "unknown"].map((format) => [
        format,
        presentRecords.filter((r) => (r.source.format ?? "unknown") === format)
          .length,
      ]),
    ),
    changes: Object.fromEntries(
      [...new Set(changes.map((x) => x.kind))].map((kind) => [
        kind,
        changes.filter((x) => x.kind === kind).length,
      ]),
    ),
    warnings: records.reduce(
      (n, r) => n + r.issues.filter((x) => x.severity === "warning").length,
      0,
    ),
    errors: records.reduce(
      (n, r) => n + r.issues.filter((x) => x.severity === "error").length,
      0,
    ),
    unsafeEntries: warnings,
  };
  return { manifest, changes, summary };
}

export async function run(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  for (const key of ["source", "manifestDir", "reportDir"])
    if (!opts[key])
      throw new Error(
        `--${{ source: "source", manifestDir: "manifest-dir", reportDir: "report-dir" }[key]} is required`,
      );
  const previous = opts.previous
    ? JSON.parse(await fs.readFile(opts.previous, "utf8"))
    : null;
  const metadata = opts.metadata
    ? JSON.parse(await fs.readFile(opts.metadata, "utf8"))
    : null;
  const result = await inventory({
    source: opts.source,
    previous,
    metadata,
    limits: opts,
  });
  const manifestPath = await nextRevision(
    opts.manifestDir,
    "Banner manifest",
    "json",
  );
  const inventoryPath = await nextRevision(
    opts.manifestDir,
    "Banner inventory",
    "json",
  );
  const changesPath = await nextRevision(
    opts.reportDir,
    "Banner change report",
    "json",
  );
  const validationPath = await nextRevision(
    opts.reportDir,
    "Banner validation report",
    "md",
  );
  const facts = {
    schemaVersion: 1,
    source: "approved image directory (read-only scan)",
    summary: result.summary,
    files: result.manifest.banners
      .filter((record) => !record.sourceMissing)
      .map((record) => ({
        filename: record.source.filename,
        width: record.source.width,
        height: record.source.height,
        aspectRatio: record.source.aspectRatio,
        format: record.source.format,
        sizeBytes: record.source.sizeBytes,
        sha256: record.source.sha256,
        orientation: record.source.orientation,
        validation: record.source.validation,
        issues: record.issues,
      })),
  };
  const changes = {
    schemaVersion: 1,
    summary: result.summary,
    changes: result.changes,
  };
  const md = [
    `# Banner validation report`,
    ``,
    `- Files: ${result.summary.fileCount}`,
    `- Valid: ${result.summary.validCount}`,
    `- Invalid: ${result.summary.invalidCount}`,
    `- Counties represented: ${result.summary.countiesRepresented}/64`,
    `- Missing counties: ${result.summary.missingCounties.map((fips) => `${fips} ${result.manifest.counties.find((c) => c.fips === fips).name}`).join(", ") || "none"}`,
    `- Warnings: ${result.summary.warnings}`,
    `- Errors: ${result.summary.errors}`,
    `- Formats: ${Object.entries(result.summary.formats)
      .map(([format, count]) => `${format} ${count}`)
      .join(", ")}`,
    `- Dimensions (width × height): ${result.summary.dimensions.widthMin}–${result.summary.dimensions.widthMax} × ${result.summary.dimensions.heightMin}–${result.summary.dimensions.heightMax} px`,
    `- Aspect ratios: ${result.summary.aspectRatio.min}–${result.summary.aspectRatio.max}; median ${result.summary.aspectRatio.median}; approximately 21:9 ${result.summary.aspectRatio.near21To9}, panoramic up to 3.2:1 ${result.summary.aspectRatio.panoramic}, outside review band ${result.summary.aspectRatio.outsideReviewBand}`,
    ``,
    `## File issues`,
    ...result.manifest.banners
      .filter((x) => x.issues.length)
      .map(
        (x) =>
          `- **${x.source.filename}**: ${x.issues.map((issue) => `${issue.severity} ${issue.code} — ${issue.message}`).join("; ")}`,
      ),
    ``,
  ].join("\n");
  await atomicWrite(
    manifestPath,
    `${JSON.stringify(result.manifest, null, 2)}\n`,
  );
  await atomicWrite(inventoryPath, `${JSON.stringify(facts, null, 2)}\n`);
  await atomicWrite(changesPath, `${JSON.stringify(changes, null, 2)}\n`);
  await atomicWrite(validationPath, md);
  process.stdout.write(
    `${JSON.stringify({ summary: result.summary, outputs: { manifest: manifestPath, inventory: inventoryPath, changes: changesPath, validation: validationPath } }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

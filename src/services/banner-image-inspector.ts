import jpeg from "jpeg-js";
import { sha256Hex } from "./banner-storage.js";

/**
 * Bounded banner image inspection for the Worker runtime. Everything here uses
 * only typed arrays, Web Crypto and the standard DecompressionStream, so it runs
 * unchanged in Node and in a Worker.
 *
 * The order is deliberate. Byte length, media signature and declared pixel
 * dimensions are checked against hard limits before any decompression starts.
 * Dimensions and the SHA-256 are always derived from the supplied bytes and
 * never taken from a caller. PNG and JPEG are then decoded completely. The PNG
 * decoder is in this file. The JPEG decoder is the pure JavaScript jpeg-js
 * package, run with typed arrays only (no Buffer), strict decoding and explicit
 * resolution and memory caps.
 */
export const BANNER_IMAGE_LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxPixels: 16_000_000,
  maxDimension: 12_000,
  maxDecodedBytes: 96 * 1024 * 1024,
});

export type BannerImageDecode = "full" | "not_performed";

export interface BannerImageInspection {
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly sha256: string;
  /** "full" only when every pixel row was decoded and validated here. */
  readonly decode: BannerImageDecode;
  /** Why a full decode was not performed. Present only when decode is not full. */
  readonly decodeNote?: string;
}

export class BannerImageError extends Error {
  constructor(
    readonly code:
      | "too_large"
      | "empty"
      | "unsupported_type"
      | "malformed"
      | "dimensions_exceeded"
      | "decode_failed",
    message: string,
  ) {
    super(message);
    this.name = "BannerImageError";
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export async function inspectBannerImage(
  bytes: Uint8Array,
  limits: typeof BANNER_IMAGE_LIMITS = BANNER_IMAGE_LIMITS,
): Promise<BannerImageInspection> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    throw new BannerImageError("empty", "Image has no bytes");
  if (bytes.byteLength > limits.maxBytes)
    throw new BannerImageError("too_large", "Image exceeds the byte limit");
  const isPng =
    bytes.byteLength >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg)
    throw new BannerImageError(
      "unsupported_type",
      "Only JPEG and PNG banner images are supported",
    );
  const facts = isPng ? readPngHeader(bytes) : readJpegHeader(bytes);
  if (
    facts.width < 1 ||
    facts.height < 1 ||
    facts.width > limits.maxDimension ||
    facts.height > limits.maxDimension ||
    facts.width * facts.height > limits.maxPixels
  )
    throw new BannerImageError(
      "dimensions_exceeded",
      "Image dimensions exceed the pixel limits",
    );
  // Limits are satisfied, so decoding may begin.
  if (isPng) await decodePng(bytes, facts as PngFacts, limits);
  else decodeJpeg(bytes, facts, limits);
  const sha256 = await sha256Hex(bytes);
  return {
    mediaType: isPng ? "image/png" : "image/jpeg",
    width: facts.width,
    height: facts.height,
    byteSize: bytes.byteLength,
    sha256,
    decode: "full",
  };
}

interface Facts {
  readonly width: number;
  readonly height: number;
}

interface PngFacts extends Facts {
  readonly bitDepth: number;
  readonly colorType: number;
}

const CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};
const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function readPngHeader(bytes: Uint8Array): PngFacts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 33 ||
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452
  )
    throw new BannerImageError("malformed", "PNG header is missing");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24] as number;
  const colorType = bytes[25] as number;
  if (
    !DEPTHS[colorType]?.includes(bitDepth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0
  )
    throw new BannerImageError("malformed", "Unsupported PNG header values");
  if (bytes[28] !== 0)
    throw new BannerImageError(
      "unsupported_type",
      "Interlaced PNG banners are not supported",
    );
  return { width, height, bitDepth, colorType };
}

function readJpegHeader(bytes: Uint8Array): Facts {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff)
      throw new BannerImageError("malformed", "JPEG marker is missing");
    let marker = bytes[offset + 1] as number;
    while (marker === 0xff && offset + 2 < bytes.byteLength) {
      offset += 1;
      marker = bytes[offset + 1] as number;
    }
    offset += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 1)
      continue;
    if (marker === 0xd9 || marker === 0xda)
      throw new BannerImageError("malformed", "JPEG has no frame header");
    if (offset + 2 > bytes.byteLength) break;
    const length =
      ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
    if (length < 2 || offset + length > bytes.byteLength)
      throw new BannerImageError("malformed", "JPEG segment is truncated");
    const baseline = marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (!baseline)
        throw new BannerImageError(
          "unsupported_type",
          "Only baseline and progressive Huffman JPEG banners are supported",
        );
      if (length < 8 || bytes[offset + 2] !== 8)
        throw new BannerImageError("malformed", "Unsupported JPEG precision");
      const height =
        ((bytes[offset + 3] as number) << 8) | (bytes[offset + 4] as number);
      const width =
        ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
      const components = bytes[offset + 7] as number;
      if (![1, 3].includes(components) || length !== 8 + components * 3)
        throw new BannerImageError("malformed", "Unsupported JPEG components");
      if (
        bytes[bytes.byteLength - 2] !== 0xff ||
        bytes[bytes.byteLength - 1] !== 0xd9
      )
        throw new BannerImageError(
          "malformed",
          "JPEG is missing its end marker",
        );
      return { width, height };
    }
    offset += length;
  }
  throw new BannerImageError("malformed", "JPEG has no frame header");
}

function crc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Complete, bounded, non-interlaced PNG decode: CRCs, zlib stream and every row filter. */
async function decodePng(
  bytes: Uint8Array,
  facts: PngFacts,
  limits: typeof BANNER_IMAGE_LIMITS,
): Promise<void> {
  const fail = (message: string): never => {
    throw new BannerImageError("decode_failed", message);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bitsPerPixel = (CHANNELS[facts.colorType] as number) * facts.bitDepth;
  const rowBytes = Math.ceil((facts.width * bitsPerPixel) / 8);
  const filterBytes = Math.max(1, bitsPerPixel >> 3);
  const expected = (rowBytes + 1) * facts.height;
  if (expected > limits.maxDecodedBytes)
    throw new BannerImageError(
      "dimensions_exceeded",
      "Decoded image would exceed the memory limit",
    );
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  let sawPalette = false;
  let sawEnd = false;
  let offset = 8;
  let first = true;
  let previousIdat = false;
  let idatEnded = false;
  while (offset < bytes.byteLength) {
    if (sawEnd) fail("PNG has data after IEND");
    if (offset + 12 > bytes.byteLength) fail("PNG chunk is truncated");
    const length = view.getUint32(offset);
    if (length > 0x7fffffff || offset + 12 + length > bytes.byteLength)
      fail("PNG chunk is truncated");
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    if (
      crc32(bytes, offset + 4, offset + 8 + length) !==
      view.getUint32(offset + 8 + length)
    )
      fail("PNG chunk checksum failed");
    if (first && type !== "IHDR") fail("PNG must start with IHDR");
    first = false;
    if (type === "IHDR" && offset !== 8) fail("PNG has a repeated IHDR");
    if (type === "PLTE") {
      if (
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        facts.colorType === 0 ||
        facts.colorType === 4 ||
        idat.length
      )
        fail("PNG palette is invalid");
      sawPalette = true;
    }
    if (type === "IDAT") {
      if (idatEnded) fail("PNG image data chunks are not contiguous");
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
      idatBytes += length;
      previousIdat = true;
    } else {
      if (previousIdat) idatEnded = true;
      previousIdat = false;
    }
    if (type === "IEND") {
      if (length !== 0) fail("PNG IEND is invalid");
      sawEnd = true;
    }
    offset += 12 + length;
  }
  if (!sawEnd || idatBytes === 0) fail("PNG is missing image data");
  if (facts.colorType === 3 && !sawPalette) fail("PNG palette is missing");

  const compressed = new Uint8Array(idatBytes);
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.byteLength;
  }
  const reader = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  let filled = -1;
  let rows = 0;
  let filter = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expected) fail("PNG data is longer than its header declares");
      for (let i = 0; i < value.byteLength; i += 1) {
        const byte = value[i] as number;
        if (filled === -1) {
          if (byte > 4) fail("PNG row filter is invalid");
          filter = byte;
          filled = 0;
          continue;
        }
        const left =
          filled >= filterBytes ? (current[filled - filterBytes] as number) : 0;
        const up = previous[filled] as number;
        const upLeft =
          filled >= filterBytes
            ? (previous[filled - filterBytes] as number)
            : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        current[filled] = (byte + predictor) & 0xff;
        filled += 1;
        if (filled === rowBytes) {
          rows += 1;
          const swap = previous;
          previous = current;
          current = swap;
          filled = -1;
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof BannerImageError) throw error;
    return fail("PNG compressed data is corrupt");
  }
  if (total !== expected || rows !== facts.height || filled !== -1)
    fail("PNG data is shorter than its header declares");
}

/** Complete JPEG decode with strict parsing and explicit resolution and memory caps. */
function decodeJpeg(
  bytes: Uint8Array,
  facts: Facts,
  limits: typeof BANNER_IMAGE_LIMITS,
): void {
  try {
    const image = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: limits.maxPixels / 1_000_000,
      maxMemoryUsageInMB: Math.floor(limits.maxDecodedBytes / (1024 * 1024)),
    });
    if (
      image.width !== facts.width ||
      image.height !== facts.height ||
      image.data.byteLength !== facts.width * facts.height * 3
    )
      throw new Error("Decoded size does not match the frame header");
  } catch {
    throw new BannerImageError("decode_failed", "JPEG data failed to decode");
  }
}

import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import pngjs from "pngjs";

const { PNG } = pngjs;

/** Generated bands and circles. No Beta-1 or approved banner file is read. */
function pixels(width, height, seed) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 4 + seed * 37) & 255;
      data[i + 1] = (y * 9 + seed * 71) & 255;
      data[i + 2] = ((x + y) * 3 + seed * 13) & 255;
      data[i + 3] = 255;
    }
  return data;
}

function png(width, height, seed, options = {}) {
  const image = new PNG({ width, height });
  pixels(width, height, seed).copy(image.data);
  return new Uint8Array(PNG.sync.write(image, { filterType: -1, ...options }));
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function ihdr(width, height, interlace = 0) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[12] = interlace;
  return chunk("IHDR", data);
}
const custom = (...chunks) =>
  new Uint8Array(Buffer.concat([SIGNATURE, ...chunks]));

function firstIdat(bytes) {
  let offset = 8;
  while (offset < bytes.length) {
    const length = Buffer.from(bytes).readUInt32BE(offset);
    const type = Buffer.from(bytes.slice(offset + 4, offset + 8)).toString(
      "latin1",
    );
    if (type === "IDAT") return { offset, length };
    offset += 12 + length;
  }
  throw new Error("fixture has no IDAT");
}

function describe(bytes, width, height) {
  return {
    base64: Buffer.from(bytes).toString("base64"),
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function bannerAdminFixtures() {
  const pngA = png(64, 24, 1);
  const pngB = png(96, 32, 2, { colorType: 2 });
  const pngC = png(48, 16, 3, {
    colorType: 0,
    inputColorType: 6,
    inputHasAlpha: true,
  });
  const pngD = png(32, 32, 4);
  const pngE = png(40, 20, 5);
  const pngF = png(24, 24, 6);
  // Separate images for the publication checks, which share the database.
  const publishPngs = [8, 9, 10, 11, 12, 13].map((seed, i) =>
    png(48 + i * 8, 20 + i * 2, seed),
  );
  const publishJpeg = new Uint8Array(
    jpeg.encode({ width: 72, height: 24, data: pixels(72, 24, 14) }, 80).data,
  );
  // Separate images for the API transport checks, which share the database.
  const apiPngs = [30, 31, 32, 33, 35].map((seed, i) =>
    png(56 + i * 8, 22 + i * 2, seed),
  );
  const apiJpeg = new Uint8Array(
    jpeg.encode({ width: 80, height: 26, data: pixels(80, 26, 34) }, 80).data,
  );
  const jpegA = new Uint8Array(
    jpeg.encode({ width: 64, height: 24, data: pixels(64, 24, 7) }, 80).data,
  );

  const truncatedPng = pngA.slice(0, 90);
  const badCrcPng = pngA.slice();
  const target = firstIdat(badCrcPng);
  badCrcPng[target.offset + 12] ^= 0xff;

  const corruptDataPng = pngA.slice();
  const middle = target.offset + 8 + (target.length >> 1);
  corruptDataPng[middle] ^= 0x55;
  const body = Buffer.from(
    corruptDataPng.slice(target.offset + 4, target.offset + 8 + target.length),
  );
  Buffer.from(corruptDataPng.buffer).writeUInt32BE(
    crc32(body),
    target.offset + 8 + target.length,
  );

  const bombPng = custom(
    ihdr(64, 24),
    chunk("IDAT", deflateSync(Buffer.alloc(8_000_000))),
    chunk("IEND", Buffer.alloc(0)),
  );
  const shortDataPng = custom(
    ihdr(64, 24),
    chunk("IDAT", deflateSync(Buffer.alloc((64 * 4 + 1) * 10))),
    chunk("IEND", Buffer.alloc(0)),
  );
  const interlacedPng = custom(
    ihdr(64, 24, 1),
    chunk("IDAT", deflateSync(Buffer.alloc((64 * 4 + 1) * 24))),
    chunk("IEND", Buffer.alloc(0)),
  );
  const oversizedClaimPng = custom(
    ihdr(50_000, 50_000),
    chunk("IEND", Buffer.alloc(0)),
  );
  const gif = new Uint8Array(
    Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"),
  );
  const truncatedJpeg = jpegA.slice(0, jpegA.length - 2);
  // Valid markers and end marker, but a large block of entropy data removed.
  const scan = jpegA.findIndex((v, i) => v === 0xff && jpegA[i + 1] === 0xda);
  const corruptJpeg = new Uint8Array([
    ...jpegA.slice(0, scan + 40),
    ...jpegA.slice(scan + 40 + Math.floor((jpegA.length - scan) / 2)),
  ]);
  // Frame header claiming 40000 x 40000. Limits must refuse it before decoding.
  const oversizedClaimJpeg = jpegA.slice();
  const sof = oversizedClaimJpeg.findIndex(
    (v, i) => v === 0xff && oversizedClaimJpeg[i + 1] === 0xc0,
  );
  oversizedClaimJpeg.set([0x9c, 0x40, 0x9c, 0x40], sof + 5);

  return {
    pngA: describe(pngA, 64, 24),
    pngB: describe(pngB, 96, 32),
    pngC: describe(pngC, 48, 16),
    pngD: describe(pngD, 32, 32),
    pngE: describe(pngE, 40, 20),
    pngF: describe(pngF, 24, 24),
    jpegA: describe(jpegA, 64, 24),
    ...Object.fromEntries(
      publishPngs.map((bytes, i) => [
        `publishPng${i + 1}`,
        describe(bytes, 48 + i * 8, 20 + i * 2),
      ]),
    ),
    publishJpeg: describe(publishJpeg, 72, 24),
    ...Object.fromEntries(
      apiPngs.map((bytes, i) => [
        `apiPng${i + 1}`,
        describe(bytes, 56 + i * 8, 22 + i * 2),
      ]),
    ),
    apiJpeg: describe(apiJpeg, 80, 26),
    truncatedPng: describe(truncatedPng, 0, 0),
    badCrcPng: describe(badCrcPng, 0, 0),
    corruptDataPng: describe(corruptDataPng, 0, 0),
    bombPng: describe(bombPng, 0, 0),
    shortDataPng: describe(shortDataPng, 0, 0),
    interlacedPng: describe(interlacedPng, 0, 0),
    oversizedClaimPng: describe(oversizedClaimPng, 0, 0),
    gif: describe(gif, 0, 0),
    truncatedJpeg: describe(truncatedJpeg, 0, 0),
    corruptJpeg: describe(corruptJpeg, 0, 0),
    oversizedClaimJpeg: describe(oversizedClaimJpeg, 0, 0),
  };
}
